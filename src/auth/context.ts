import { and, eq } from 'drizzle-orm';
import type { TenantTransaction } from '../db/client.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../db/schema/identity.js';
import { employees } from '../db/schema/workforce.js';

export interface RequestContext {
  tenantId: string;
  userId: string;
  employeeId: string | null;
  departmentId: string | null;
  roles: string[];
  permissions: string[];
  requestId: string;
}

export async function loadContext(
  tx: TenantTransaction,
  tenantId: string,
  userId: string,
  requestId: string,
): Promise<RequestContext | null> {
  const [user] = await tx.select({
    userId: users.id, employeeId: employees.id, departmentId: employees.departmentId,
  }).from(users).leftJoin(employees, and(eq(employees.tenantId, users.tenantId), eq(employees.userId, users.id)))
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  if (!user) return null;
  const memberships = await tx.select({ role: roles.name, permission: permissions.code }).from(userRoles)
    .innerJoin(roles, and(eq(roles.tenantId, userRoles.tenantId), eq(roles.id, userRoles.roleId)))
    .leftJoin(rolePermissions, and(eq(rolePermissions.tenantId, roles.tenantId), eq(rolePermissions.roleId, roles.id)))
    .leftJoin(permissions, and(eq(permissions.tenantId, rolePermissions.tenantId), eq(permissions.id, rolePermissions.permissionId)))
    .where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)));
  return {
    tenantId, ...user, requestId,
    roles: [...new Set(memberships.map((row) => row.role))].sort(),
    permissions: [...new Set(memberships.flatMap((row) => row.permission === null ? [] : [row.permission]))].sort(),
  };
}
