import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';
import { users } from './identity.js';

export const departments = pgTable('departments', {
  ...tenantColumns(),
  name: text('name').notNull(),
}, (table) => [
  tenantPolicy('departments', table.tenantId),
  unique('departments_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('departments_tenant_name_unique').on(table.tenantId, table.name),
]).enableRLS();

export const employees = pgTable('employees', {
  ...tenantColumns(),
  name: text('name').notNull(),
  userId: uuid('user_id'),
  departmentId: uuid('department_id'),
}, (table) => [
  tenantPolicy('employees', table.tenantId),
  unique('employees_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('employees_tenant_user_unique').on(table.tenantId, table.userId),
  foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ columns: [table.tenantId, table.departmentId], foreignColumns: [departments.tenantId, departments.id] }),
]).enableRLS();
