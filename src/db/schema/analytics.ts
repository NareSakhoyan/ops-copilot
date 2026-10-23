import { and, eq, exists, sql } from 'drizzle-orm';
import { pgView, QueryBuilder } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { activities, contacts, deals, tasks } from './crm.js';
import { employees } from './workforce.js';

// These values are bound by trusted server code, after reloading the user's RBAC.
function employeeScope(employeeId: PgColumn, departmentId: PgColumn) {
  return sql`(
    current_setting('app.analytics_scope', true) = 'tenant'
    OR (current_setting('app.analytics_scope', true) = 'department'
      AND ${departmentId} = nullif(current_setting('app.analytics_department_id', true), '')::uuid)
    OR (current_setting('app.analytics_scope', true) = 'employee'
      AND ${employeeId} = nullif(current_setting('app.analytics_employee_id', true), '')::uuid)
  )`;
}

const viewOptions = { securityInvoker: true, securityBarrier: true };

export const vDeals = pgView('v_deals').with(viewOptions).as((qb) => qb.select({
  id: deals.id, tenantId: deals.tenantId, title: deals.title, status: deals.status,
  amount: deals.amount, currency: deals.currency, createdAt: deals.createdAt, closedAt: deals.closedAt,
  companyId: deals.companyId, contactId: deals.contactId, responsibleEmployeeId: deals.responsibleEmployeeId,
  departmentId: employees.departmentId,
}).from(deals).leftJoin(employees, and(eq(employees.tenantId, deals.tenantId), eq(employees.id, deals.responsibleEmployeeId)))
  .where(employeeScope(deals.responsibleEmployeeId, employees.departmentId)));

export const vTasks = pgView('v_tasks').with(viewOptions).as((qb) => qb.select({
  id: tasks.id, tenantId: tasks.tenantId, title: tasks.title, status: tasks.status,
  assigneeEmployeeId: tasks.assigneeEmployeeId, departmentId: employees.departmentId,
  dueAt: tasks.dueAt, createdAt: tasks.createdAt, contactId: tasks.contactId, dealId: tasks.dealId,
}).from(tasks).innerJoin(employees, and(eq(employees.tenantId, tasks.tenantId), eq(employees.id, tasks.assigneeEmployeeId)))
  .where(employeeScope(tasks.assigneeEmployeeId, employees.departmentId)));

const visibleContactDeal = new QueryBuilder().select({ id: deals.id }).from(deals)
  .leftJoin(employees, and(eq(employees.tenantId, deals.tenantId), eq(employees.id, deals.responsibleEmployeeId)))
  .where(and(eq(deals.tenantId, contacts.tenantId), eq(deals.contactId, contacts.id), employeeScope(deals.responsibleEmployeeId, employees.departmentId)));

export const vContactsActivity = pgView('v_contacts_activity').with(viewOptions).as((qb) => qb.select({
  id: contacts.id, tenantId: contacts.tenantId, name: contacts.name, companyId: contacts.companyId,
  lastActivityAt: sql<Date | null>`max(${activities.occurredAt})`.as('last_activity_at'),
}).from(contacts).leftJoin(activities, and(eq(activities.tenantId, contacts.tenantId), eq(activities.contactId, contacts.id)))
  .where(sql`current_setting('app.analytics_scope', true) = 'tenant' OR ${exists(visibleContactDeal)}`)
  .groupBy(contacts.id, contacts.tenantId, contacts.name, contacts.companyId));

export const vEmployeePerformance = pgView('v_employee_performance').with(viewOptions).as((qb) => qb.select({
  employeeId: sql<string>`${employees.id}`.as('employee_id'), tenantId: employees.tenantId, employeeName: sql`${employees.name}`.as('employee_name'),
  departmentId: employees.departmentId, currency: deals.currency,
  dealCount: sql<number>`count(${deals.id})`.as('deal_count'),
  wonCount: sql<number>`count(${deals.id}) FILTER (WHERE ${deals.status} = 'won')`.as('won_count'),
  lostCount: sql<number>`count(${deals.id}) FILTER (WHERE ${deals.status} = 'lost')`.as('lost_count'),
  openCount: sql<number>`count(${deals.id}) FILTER (WHERE ${deals.status} = 'open')`.as('open_count'),
  wonAmount: sql<string>`coalesce(sum(${deals.amount}) FILTER (WHERE ${deals.status} = 'won'), 0)`.as('won_amount'),
}).from(employees).leftJoin(deals, and(eq(deals.tenantId, employees.tenantId), eq(deals.responsibleEmployeeId, employees.id)))
  .where(employeeScope(employees.id, employees.departmentId))
  .groupBy(employees.id, employees.tenantId, employees.name, employees.departmentId, deals.currency));

export const analyticsViews = {
  v_deals: vDeals, v_tasks: vTasks, v_contacts_activity: vContactsActivity, v_employee_performance: vEmployeePerformance,
};

export type AnalyticsViewName = keyof typeof analyticsViews;
