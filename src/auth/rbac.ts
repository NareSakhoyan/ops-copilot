import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { employees } from '../db/schema/workforce.js';
import { getEvalWeaken } from '../testing/weaken.js';
import type { RequestContext } from './context.js';

type ScopeMode = 'rows' | 'aggregates';
type RecordScope = { kind: 'none' } | { kind: 'tenant' }
  | { kind: 'department'; departmentId: string } | { kind: 'employee'; employeeId: string };

export function recordScope(ctx: RequestContext, mode: ScopeMode): RecordScope {
  if (ctx.roles.includes('admin') || (mode === 'aggregates' && ctx.roles.includes('viewer'))) return { kind: 'tenant' };
  // EVAL_WEAKEN=rls (non-production only): simulate a regressed row-scope control by granting
  // tenant-wide visibility to roles that should be restricted to their own department/records.
  // The tenant boundary itself is untouched; this only demonstrates a within-tenant over-exposure.
  if (getEvalWeaken() === 'rls' && (ctx.roles.includes('sales_manager') || ctx.roles.includes('sales_rep'))) return { kind: 'tenant' };
  if (ctx.roles.includes('sales_manager') && ctx.departmentId !== null) return { kind: 'department', departmentId: ctx.departmentId };
  if (ctx.roles.includes('sales_rep') && ctx.employeeId !== null) return { kind: 'employee', employeeId: ctx.employeeId };
  return { kind: 'none' };
}

export function can(ctx: RequestContext, permission: string): boolean {
  if (!/^[a-z_]+:[a-z_]+$/.test(permission) || !ctx.permissions.includes(permission)) return false;
  return recordScope(ctx, permission.endsWith(':aggregate') ? 'aggregates' : 'rows').kind !== 'none';
}

// Call can() first. Only aggregate queries may request aggregate scope.
export function scopeFilter(
  ctx: RequestContext,
  mode: ScopeMode,
  columns: { tenantId: PgColumn; employeeId?: PgColumn },
): SQL {
  const scope = recordScope(ctx, mode);
  const tenant = eq(columns.tenantId, ctx.tenantId);
  if (scope.kind === 'tenant') return tenant;
  if (scope.kind === 'none' || columns.employeeId === undefined) return sql`false`;
  const owner = scope.kind === 'employee'
    ? eq(columns.employeeId, scope.employeeId)
    : sql`${columns.employeeId} IN (
      SELECT ${employees.id} FROM ${employees}
      WHERE ${employees.tenantId} = ${ctx.tenantId} AND ${employees.departmentId} = ${scope.departmentId}
    )`;
  return and(tenant, owner) ?? sql`false`;
}
