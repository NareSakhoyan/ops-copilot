import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, unique, uuid, vector } from 'drizzle-orm/pg-core';
import { EMBED_DIM } from '../../rag/config.js';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';

export const documents = pgTable('documents', {
  ...tenantColumns(),
  title: text('title').notNull(),
  source: text('source').notNull(),
  allowedRoles: text('allowed_roles').array().notNull(),
  contentHash: text('content_hash').notNull(),
  embeddingModel: text('embedding_model').notNull(),
}, (table) => [
  tenantPolicy('documents', table.tenantId),
  unique('documents_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('documents_tenant_source_unique').on(table.tenantId, table.source),
  check('documents_roles_check', sql`cardinality(${table.allowedRoles}) > 0 AND ${table.allowedRoles} <@ ARRAY['admin','sales_manager','sales_rep','viewer']::text[] AND array_position(${table.allowedRoles}, NULL) IS NULL`),
]).enableRLS();

export const chunks = pgTable('chunks', {
  ...tenantColumns(),
  documentId: uuid('document_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  embedding: vector('embedding', { dimensions: EMBED_DIM }).notNull(),
}, (table) => [
  tenantPolicy('chunks', table.tenantId),
  unique('chunks_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('chunks_document_ordinal_unique').on(table.tenantId, table.documentId, table.ordinal),
  foreignKey({ columns: [table.tenantId, table.documentId], foreignColumns: [documents.tenantId, documents.id] }).onDelete('cascade'),
  check('chunks_ordinal_check', sql`${table.ordinal} > 0`),
  index('chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
]).enableRLS();
