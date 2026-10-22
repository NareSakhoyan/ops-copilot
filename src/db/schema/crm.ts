import { sql } from 'drizzle-orm';
import { check, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';
import { employees } from './workforce.js';

export const companies = pgTable('companies', {
  ...tenantColumns(),
  name: text('name').notNull(),
}, (table) => [
  tenantPolicy('companies', table.tenantId),
  unique('companies_tenant_id_id_unique').on(table.tenantId, table.id),
]).enableRLS();

export const contacts = pgTable('contacts', {
  ...tenantColumns(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  companyId: uuid('company_id'),
}, (table) => [
  tenantPolicy('contacts', table.tenantId),
  unique('contacts_tenant_id_id_unique').on(table.tenantId, table.id),
  foreignKey({ columns: [table.tenantId, table.companyId], foreignColumns: [companies.tenantId, companies.id] }),
]).enableRLS();

export const leads = pgTable('leads', {
  ...tenantColumns(),
  title: text('title').notNull(),
  companyId: uuid('company_id'),
  contactId: uuid('contact_id'),
  responsibleEmployeeId: uuid('responsible_employee_id'),
}, (table) => [
  tenantPolicy('leads', table.tenantId),
  unique('leads_tenant_id_id_unique').on(table.tenantId, table.id),
  foreignKey({ columns: [table.tenantId, table.companyId], foreignColumns: [companies.tenantId, companies.id] }),
  foreignKey({ columns: [table.tenantId, table.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
  foreignKey({ columns: [table.tenantId, table.responsibleEmployeeId], foreignColumns: [employees.tenantId, employees.id] }),
]).enableRLS();

export const deals = pgTable('deals', {
  ...tenantColumns(),
  title: text('title').notNull(),
  status: text('status', { enum: ['open', 'won', 'lost'] }).notNull().default('open'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  lostReason: text('lost_reason'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  companyId: uuid('company_id'),
  contactId: uuid('contact_id'),
  leadId: uuid('lead_id'),
  responsibleEmployeeId: uuid('responsible_employee_id'),
}, (table) => [
  tenantPolicy('deals', table.tenantId),
  unique('deals_tenant_id_id_unique').on(table.tenantId, table.id),
  check('deals_status_check', sql`${table.status} IN ('open', 'won', 'lost')`),
  check('deals_amount_check', sql`${table.amount} >= 0`),
  check('deals_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  foreignKey({ columns: [table.tenantId, table.companyId], foreignColumns: [companies.tenantId, companies.id] }),
  foreignKey({ columns: [table.tenantId, table.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
  foreignKey({ columns: [table.tenantId, table.leadId], foreignColumns: [leads.tenantId, leads.id] }),
  foreignKey({ columns: [table.tenantId, table.responsibleEmployeeId], foreignColumns: [employees.tenantId, employees.id] }),
  index('deals_tenant_status_created_at_idx').on(table.tenantId, table.status, table.createdAt),
]).enableRLS();

export const activities = pgTable('activities', {
  ...tenantColumns(),
  type: text('type', { enum: ['call', 'email', 'meeting'] }).notNull(),
  contactId: uuid('contact_id').notNull(),
  dealId: uuid('deal_id'),
  employeeId: uuid('employee_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  note: text('note').notNull(),
}, (table) => [
  tenantPolicy('activities', table.tenantId),
  unique('activities_tenant_id_id_unique').on(table.tenantId, table.id),
  check('activities_type_check', sql`${table.type} IN ('call', 'email', 'meeting')`),
  foreignKey({ columns: [table.tenantId, table.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
  foreignKey({ columns: [table.tenantId, table.dealId], foreignColumns: [deals.tenantId, deals.id] }),
  foreignKey({ columns: [table.tenantId, table.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
  index('activities_tenant_contact_occurred_at_idx').on(table.tenantId, table.contactId, table.occurredAt.desc()),
]).enableRLS();

export const tasks = pgTable('tasks', {
  ...tenantColumns(),
  description: text('description').notNull(),
  assigneeEmployeeId: uuid('assignee_employee_id').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['todo', 'in_progress', 'done', 'cancelled'] }).notNull().default('todo'),
  contactId: uuid('contact_id'),
  dealId: uuid('deal_id'),
}, (table) => [
  tenantPolicy('tasks', table.tenantId),
  unique('tasks_tenant_id_id_unique').on(table.tenantId, table.id),
  check('tasks_status_check', sql`${table.status} IN ('todo', 'in_progress', 'done', 'cancelled')`),
  foreignKey({ columns: [table.tenantId, table.assigneeEmployeeId], foreignColumns: [employees.tenantId, employees.id] }),
  foreignKey({ columns: [table.tenantId, table.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
  foreignKey({ columns: [table.tenantId, table.dealId], foreignColumns: [deals.tenantId, deals.id] }),
  index('tasks_tenant_status_created_at_idx').on(table.tenantId, table.status, table.createdAt),
  index('tasks_tenant_due_at_idx').on(table.tenantId, table.dueAt),
]).enableRLS();
