import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import { loadDatabaseConfig, parseDatabaseConfig } from './config.js';

const tenantContextSchema = z.object({ tenant_id: z.uuid(), user_id: z.uuid() });

export type TenantContext = z.infer<typeof tenantContextSchema>;
export type TenantTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export function createDbClient(databaseUrl: string, maxConnections = 10) {
  const config = parseDatabaseConfig({ DATABASE_URL: databaseUrl });
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: maxConnections });
  const db = drizzle(pool);

  async function transaction<T>(tenantId: string, userId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.tenant_id', ${tenantId}, true),
          set_config('app.user_id', ${userId}, true)
      `);
      return fn(tx);
    });
  }

  async function withTenant<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    const context = tenantContextSchema.parse(ctx);
    return transaction(context.tenant_id, context.user_id, fn);
  }

  // Credential lookup only: a tenant selector is not yet an authenticated identity.
  async function withAuthTenant<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return transaction(z.uuid().parse(tenantId), '', fn);
  }

  return { db, withTenant, withAuthTenant, close: () => pool.end() };
}

export type TenantDatabase = Pick<ReturnType<typeof createDbClient>, 'withTenant' | 'withAuthTenant'>;

let defaultClient: ReturnType<typeof createDbClient> | undefined;

function getClient() {
  defaultClient ??= createDbClient(loadDatabaseConfig().DATABASE_URL);
  return defaultClient;
}

export function withTenant<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return getClient().withTenant(ctx, fn);
}

export function withAuthTenant<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return getClient().withAuthTenant(tenantId, fn);
}

export const database: TenantDatabase = { withTenant, withAuthTenant };

export async function closeDatabase(): Promise<void> {
  const client = defaultClient;
  defaultClient = undefined;
  await client?.close();
}
