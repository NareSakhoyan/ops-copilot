import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { users } from './identity.js';
import { tenantPolicy } from './rls.js';

export const pendingActions = pgTable('pending_actions', {
  ...tenantColumns(),
  userId: uuid('user_id').notNull(),
  type: text('type', { enum: ['task.create'] }).notNull().default('task.create'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status', { enum: ['pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
}, (table) => [
  tenantPolicy('pending_actions', table.tenantId),
  unique('pending_actions_tenant_id_id_unique').on(table.tenantId, table.id),
  foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] }),
  check('pending_actions_type_check', sql`${table.type} = 'task.create'`),
  check('pending_actions_status_check', sql`${table.status} IN ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired')`),
  check('pending_actions_attempts_check', sql`${table.attempts} BETWEEN 0 AND 3`),
  check('pending_actions_payload_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
]).enableRLS();
