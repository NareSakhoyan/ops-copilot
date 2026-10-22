import { foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';
import { users } from './identity.js';

export const auditLogs = pgTable('audit_logs', {
  ...tenantColumns(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  requestId: uuid('request_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  tenantPolicy('audit_logs', table.tenantId),
  unique('audit_logs_tenant_id_id_unique').on(table.tenantId, table.id),
  foreignKey({ columns: [table.tenantId, table.actorUserId], foreignColumns: [users.tenantId, users.id] }),
]).enableRLS();

export const refreshTokens = pgTable('refresh_tokens', {
  ...tenantColumns(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  familyId: uuid('family_id').notNull().defaultRandom(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  tenantPolicy('refresh_tokens', table.tenantId),
  unique('refresh_tokens_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('refresh_tokens_tenant_hash_unique').on(table.tenantId, table.tokenHash),
  index('refresh_tokens_tenant_family_idx').on(table.tenantId, table.familyId),
  foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] }),
]).enableRLS();
