import { and, arrayOverlaps, cosineDistance, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadContext, type RequestContext } from '../auth/context.js';
import type { TenantDatabase } from '../db/client.js';
import { chunks, documents } from '../db/schema/knowledge.js';
import { validateEmbedding, type Embedder } from './embed.js';

export function createKbSearch(database: TenantDatabase, embedder: Embedder) {
  return async (ctx: RequestContext, embedding: number[], topK = 5) => {
    const vector = validateEmbedding(embedding);
    const limit = z.number().int().min(1).max(20).parse(topK);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await loadContext(tx, ctx.tenantId, ctx.userId, ctx.requestId);
      if (!current || !current.roles.length) return [];
      const distance = cosineDistance(chunks.embedding, vector);
      // ACL, tenant, and model restrictions are part of SQL before ORDER BY / LIMIT.
      // Exact ordering avoids HNSW post-filter candidate loss across tenants/ACLs in this small MVP.
      return tx.select({
        id: chunks.id, documentId: documents.id, tenantId: chunks.tenantId,
        title: documents.title, source: documents.source, ordinal: chunks.ordinal, content: chunks.content,
        similarity: sql<number>`1 - (${distance})`,
      }).from(chunks).innerJoin(documents, and(eq(documents.tenantId, chunks.tenantId), eq(documents.id, chunks.documentId)))
        .where(and(eq(chunks.tenantId, ctx.tenantId), eq(documents.tenantId, ctx.tenantId),
          eq(documents.embeddingModel, embedder.model), arrayOverlaps(documents.allowedRoles, current.roles)))
        .orderBy(sql`(${distance}) + 0`, chunks.id).limit(limit);
    });
  };
}
