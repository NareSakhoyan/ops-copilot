import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { loadContext, type RequestContext } from '../auth/context.js';
import { createDbClient, type TenantDatabase, type TenantTransaction } from '../db/client.js';
import { loadDatabaseConfig } from '../db/config.js';
import { chunks, documents } from '../db/schema/knowledge.js';
import { writeAudit } from '../observability/audit.js';
import { EMBED_DIM } from './config.js';
import { chunkDocument } from './chunk.js';
import { createGoogleEmbedder, validateEmbedding, type Embedder } from './embed.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const frontMatter = z.object({
  title: z.string().trim().min(1).max(150).regex(/^[^[\]§\r\n]+$/u),
  allowed_roles: z.array(z.enum(['admin', 'sales_manager', 'sales_rep', 'viewer'])).min(1),
}).strict();

function parseSource(input: string) {
  const text = z.string().max(5_000_000).parse(input).replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(text);
  if (!match) throw new Error('KB document requires YAML front matter and nonempty Markdown content.');
  const yaml = parseDocument(match[1] ?? '', { uniqueKeys: true });
  if (yaml.errors.length) throw new Error('Invalid KB front matter.');
  const metadata = frontMatter.parse(yaml.toJS({ maxAliasCount: 0 }));
  const content = z.string().trim().min(1).parse(match[2]);
  return { title: metadata.title, allowedRoles: [...new Set(metadata.allowed_roles)].sort(), content };
}

async function requireAdmin(tx: TenantTransaction, ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'requestId'>) {
  const current = await loadContext(tx, ctx.tenantId, ctx.userId, ctx.requestId);
  if (!current?.roles.includes('admin')) throw Object.assign(new Error('Tenant administrator required for KB ingestion.'), { statusCode: 403 });
  return current;
}

export function createIngestor(database: TenantDatabase, embedder: Embedder) {
  return async (ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'requestId'>, directory: string) => {
    const tenant = { tenant_id: z.uuid().parse(ctx.tenantId), user_id: z.uuid().parse(ctx.userId) };
    await database.withTenant(tenant, async (tx) => {
      await requireAdmin(tx, ctx);
      const result = await tx.execute(sql`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid='public.chunks'::regclass AND attname='embedding'`);
      if (z.object({ type: z.string() }).parse(result.rows[0]).type !== `vector(${EMBED_DIM})`) throw new Error('Database embedding dimension differs from EMBED_DIM; migrate before ingestion.');
    });
    const files = (await readdir(resolve(directory), { withFileTypes: true })).filter((file) => file.isFile() && file.name.endsWith('.md')).map((file) => file.name).sort();
    const totals = { documents: 0, skipped: 0, embedded: 0 };
    for (const source of files) {
      const document = parseSource(await readFile(join(resolve(directory), source), 'utf8'));
      const contentHash = hash(JSON.stringify(document));
      const result = await database.withTenant(tenant, async (tx) => {
        const current = await requireAdmin(tx, ctx);
        // Serialize the same tenant/source; each document and its chunks commit atomically.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:${source}`}, 0))`);
        const [existing] = await tx.select().from(documents).where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.source, source)));
        if (existing?.contentHash === contentHash && existing.embeddingModel === embedder.model) return { skipped: true, embedded: 0 };
        const documentId = existing?.id ?? randomUUID();
        const oldChunks = existing ? await tx.select().from(chunks).where(and(eq(chunks.tenantId, ctx.tenantId), eq(chunks.documentId, documentId))).orderBy(chunks.ordinal) : [];
        const sameModel = existing?.embeddingModel === embedder.model;
        const reusable = new Map(sameModel ? oldChunks.map((chunk) => [chunk.contentHash, chunk.embedding] as const) : []);
        const contentChunks = chunkDocument(document.content).map((content, index) => ({ content, contentHash: hash(content), ordinal: index + 1 }));
        const missing = [...new Map(contentChunks.filter((chunk) => !reusable.has(chunk.contentHash)).map((chunk) => [chunk.contentHash, chunk])).values()];
        const vectors = missing.length ? await embedder.embedPassages(missing.map((chunk) => chunk.content)) : [];
        if (vectors.length !== missing.length) throw new Error('Embedding response count mismatch.');
        missing.forEach((chunk, index) => reusable.set(chunk.contentHash, validateEmbedding(vectors[index])));
        const values = { title: document.title, source, allowedRoles: document.allowedRoles, contentHash, embeddingModel: embedder.model };
        if (existing) await tx.update(documents).set(values).where(eq(documents.id, documentId));
        else await tx.insert(documents).values({ id: documentId, tenantId: ctx.tenantId, ...values });
        for (const next of contentChunks) {
          const previous = oldChunks.find((chunk) => chunk.ordinal === next.ordinal);
          if (sameModel && previous?.contentHash === next.contentHash) continue;
          const embedding = reusable.get(next.contentHash);
          if (!embedding) throw new Error('Embedding missing for chunk.');
          if (previous) await tx.update(chunks).set({ ...next, embedding }).where(eq(chunks.id, previous.id));
          else await tx.insert(chunks).values({ tenantId: ctx.tenantId, documentId, ...next, embedding });
        }
        await tx.delete(chunks).where(and(eq(chunks.tenantId, ctx.tenantId), eq(chunks.documentId, documentId), sql`${chunks.ordinal} > ${contentChunks.length}`));
        await writeAudit(tx, current, { action: 'kb.ingest', entityType: 'document', entityId: documentId, metadata: { source, chunks: contentChunks.length, embedded: missing.length } });
        return { skipped: false, embedded: missing.length };
      });
      totals.documents++; totals.embedded += result.embedded;
      if (result.skipped) totals.skipped++;
    }
    return totals;
  };
}

async function main() {
  const { values, positionals } = parseArgs({ options: { 'tenant-id': { type: 'string' }, 'user-id': { type: 'string' } }, allowPositionals: true, strict: true });
  const directory = z.tuple([z.string().min(1)]).parse(positionals)[0];
  const ctx = { tenantId: z.uuid().parse(values['tenant-id']), userId: z.uuid().parse(values['user-id']), requestId: randomUUID() };
  const client = createDbClient(loadDatabaseConfig().DATABASE_URL);
  try { console.log(await createIngestor(client, createGoogleEmbedder())(ctx, directory)); }
  finally { await client.close(); }
}
if (import.meta.main) {
  try { await main(); }
  catch { console.error('KB ingestion failed. Check tenant-admin flags, front matter, migrations/dimension, explicit embedding quotas and credentials. Provider details are suppressed.'); process.exitCode = 1; }
}
