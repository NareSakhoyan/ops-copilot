import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from './columns.js';
import { tenantPolicy } from './rls.js';
import { companies, contacts, deals } from './crm.js';

export const products = pgTable('products', {
  ...tenantColumns(),
  name: text('name').notNull(),
  sku: text('sku').notNull(),
  price: numeric('price', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
}, (table) => [
  tenantPolicy('products', table.tenantId),
  unique('products_tenant_id_id_unique').on(table.tenantId, table.id),
  unique('products_tenant_sku_unique').on(table.tenantId, table.sku),
  check('products_price_check', sql`${table.price} >= 0`),
  check('products_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
]).enableRLS();

export const orders = pgTable('orders', {
  ...tenantColumns(),
  companyId: uuid('company_id'),
  contactId: uuid('contact_id'),
  dealId: uuid('deal_id'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
}, (table) => [
  tenantPolicy('orders', table.tenantId),
  unique('orders_tenant_id_id_unique').on(table.tenantId, table.id),
  check('orders_amount_check', sql`${table.amount} >= 0`),
  check('orders_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  foreignKey({ columns: [table.tenantId, table.companyId], foreignColumns: [companies.tenantId, companies.id] }),
  foreignKey({ columns: [table.tenantId, table.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
  foreignKey({ columns: [table.tenantId, table.dealId], foreignColumns: [deals.tenantId, deals.id] }),
]).enableRLS();

export const orderItems = pgTable('order_items', {
  ...tenantColumns(),
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
}, (table) => [
  tenantPolicy('order_items', table.tenantId),
  unique('order_items_tenant_id_id_unique').on(table.tenantId, table.id),
  check('order_items_quantity_check', sql`${table.quantity} > 0`),
  check('order_items_unit_price_check', sql`${table.unitPrice} >= 0`),
  check('order_items_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id] }),
  foreignKey({ columns: [table.tenantId, table.productId], foreignColumns: [products.tenantId, products.id] }),
]).enableRLS();
