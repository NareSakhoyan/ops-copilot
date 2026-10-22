import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';

export const appUser = pgRole('app_user').existing();
export const analyticsReadOnly = pgRole('analytics_ro').existing();

export function tenantPolicy(tableName: string, tenantId: PgColumn) {
  const tenantMatch = sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  return pgPolicy(`${tableName}_tenant_isolation`, {
    for: 'all',
    to: [appUser, analyticsReadOnly],
    using: tenantMatch,
    withCheck: tenantMatch,
  });
}
