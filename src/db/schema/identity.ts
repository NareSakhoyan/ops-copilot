import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';

export const users = pgTable('users', {
  ...tenantColumns(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
}, (table) => [
  tenantPolicy('users', table.tenantId),
  unique('users_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('users_tenant_email_unique').on(table.tenantId, table.email),
]).enableRLS();

export const roles = pgTable('roles', {
  ...tenantColumns(),
  name: text('name').notNull(),
}, (table) => [
  tenantPolicy('roles', table.tenantId),
  unique('roles_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('roles_tenant_name_unique').on(table.tenantId, table.name),
]).enableRLS();

export const permissions = pgTable('permissions', {
  ...tenantColumns(),
  code: text('code').notNull(),
  description: text('description').notNull(),
}, (table) => [
  tenantPolicy('permissions', table.tenantId),
  unique('permissions_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('permissions_tenant_code_unique').on(table.tenantId, table.code),
]).enableRLS();

export const rolePermissions = pgTable('role_permissions', {
  ...tenantColumns(),
  roleId: uuid('role_id').notNull(),
  permissionId: uuid('permission_id').notNull(),
}, (table) => [
  tenantPolicy('role_permissions', table.tenantId),
  unique('role_permissions_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('role_permissions_membership_unique').on(table.tenantId, table.roleId, table.permissionId),
  foreignKey({ columns: [table.tenantId, table.roleId], foreignColumns: [roles.tenantId, roles.id] }),
  foreignKey({ columns: [table.tenantId, table.permissionId], foreignColumns: [permissions.tenantId, permissions.id] }),
]).enableRLS();

export const userRoles = pgTable('user_roles', {
  ...tenantColumns(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
}, (table) => [
  tenantPolicy('user_roles', table.tenantId),
  unique('user_roles_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('user_roles_membership_unique').on(table.tenantId, table.userId, table.roleId),
  foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ columns: [table.tenantId, table.roleId], foreignColumns: [roles.tenantId, roles.id] }),
]).enableRLS();
