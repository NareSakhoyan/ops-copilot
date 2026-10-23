import { getTableName, is, isSQLWrapper, SQL, sql } from 'drizzle-orm';
import { getTableConfig, getViewConfig, PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as analyticsLog from './schema/analytics-log.js';
import { analyticsViews } from './schema/analytics.js';
import * as approvals from './schema/approvals.js';
import * as crm from './schema/crm.js';
import * as identity from './schema/identity.js';
import * as orders from './schema/orders.js';
import * as security from './schema/security.js';
import * as tenants from './schema/tenants.js';
import * as workforce from './schema/workforce.js';

const tables = Object.values({ ...analyticsLog, ...approvals, ...crm, ...identity, ...orders, ...security, ...tenants, ...workforce });
const columns = new Map<string, Set<string>>();
const visited = new Set<unknown>();

function collect(value: unknown): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (is(value, PgColumn)) {
    const name = getTableName(value.table);
    const selected = columns.get(name) ?? new Set<string>();
    selected.add(value.name);
    columns.set(name, selected);
  } else if (is(value, PgTable)) {
    // FROM names do not imply a grant on every column.
    return;
  } else if (is(value, SQL)) {
    value.queryChunks.forEach(collect);
  } else if (Array.isArray(value)) {
    value.forEach(collect);
  } else if (isSQLWrapper(value)) {
    collect(value.getSQL());
  }
}

for (const view of Object.values(analyticsViews)) collect(getViewConfig(view).query);

const qualified = (name: string) => sql`public.${sql.identifier(name)}`;

// Remove stale table AND column grants before applying the current view dependencies.
export const grants = sql.join([
  sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM analytics_ro`,
  ...tables.map((table) => {
    const config = getTableConfig(table);
    return sql`REVOKE ALL PRIVILEGES (${sql.join(config.columns.map((column) => sql.identifier(column.name)), sql`, `)}) ON TABLE ${qualified(config.name)} FROM analytics_ro`;
  }),
  ...[...columns].map(([table, names]) => sql`GRANT SELECT (${sql.join([...names].sort().map((name) => sql.identifier(name)), sql`, `)}) ON TABLE ${qualified(table)} TO analytics_ro`),
  ...Object.keys(analyticsViews).map((name) => sql`GRANT SELECT ON TABLE ${qualified(name)} TO analytics_ro`),
], sql`;\n`);
