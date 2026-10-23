import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { users } from './identity.js';
import { tenantPolicy } from './rls.js';

export const sqlExecutionLog = pgTable('sql_execution_log', {
  ...tenantColumns(),
  userId: uuid('user_id').notNull(), requestId: uuid('request_id').notNull(),
  question: text('question'), sql: text('sql').notNull(),
  verdict: text('verdict', { enum: ['accepted', 'rejected', 'error'] }).notNull(),
  rows: integer('rows').notNull(), durationMs: integer('duration_ms').notNull(), error: text('error'),
}, (table) => [
  tenantPolicy('sql_execution_log', table.tenantId),
  unique('sql_execution_log_tenant_id_id_unique').on(table.tenantId, table.id),
  foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] }),
  check('sql_execution_log_verdict_check', sql`${table.verdict} IN ('accepted', 'rejected', 'error')`),
  check('sql_execution_log_rows_check', sql`${table.rows} BETWEEN 0 AND 200`),
  check('sql_execution_log_duration_check', sql`${table.durationMs} >= 0`),
]).enableRLS();
