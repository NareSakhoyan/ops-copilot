import { randomUUID } from 'node:crypto';
import { hash } from 'argon2';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantDatabase } from '../client.js';
import { activities, companies, contacts, deals, leads, tasks } from '../schema/crm.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../schema/identity.js';
import { orderItems, orders, products } from '../schema/orders.js';
import { tenants } from '../schema/tenants.js';
import { departments, employees } from '../schema/workforce.js';
import { writeAudit } from '../../observability/audit.js';
import { buildTenantData, demoTenants, devPasswords } from './data.js';

export async function seedDatabase(database: TenantDatabase, referenceDate = new Date()) {
  const startedAt = z.date().parse(referenceDate);
  const requestId = randomUUID();
  const results = [];
  for (const tenant of demoTenants) {
    const result = await database.withTenant({ tenant_id: tenant.id, user_id: tenant.adminId }, async (tx) => {
      const [existing] = await tx.select().from(tenants).where(or(eq(tenants.id, tenant.id), eq(tenants.name, tenant.name)));
      if (existing) return { tenantId: existing.id, name: existing.name, status: 'skipped' as const };
      const [inserted] = await tx.insert(tenants).values({ id: tenant.id, name: tenant.name, createdAt: startedAt, updatedAt: startedAt })
        .onConflictDoNothing({ target: tenants.id }).returning();
      if (!inserted) return { tenantId: tenant.id, name: tenant.name, status: 'skipped' as const };

      const data = buildTenantData(tenant, startedAt);
      // Use normal randomly salted Argon2 hashes even though demo passwords are public.
      const passwords = {
        admin: await hash(devPasswords.admin), sales_manager: await hash(devPasswords.sales_manager),
        sales_rep: await hash(devPasswords.sales_rep), viewer: await hash(devPasswords.viewer),
      };
      await tx.insert(users).values(data.accounts.map(({ role, ...account }) => ({ ...account, passwordHash: passwords[role] })));
      await tx.insert(roles).values(data.roles);
      await tx.insert(permissions).values(data.permissions);
      await tx.insert(rolePermissions).values(data.rolePermissions);
      await tx.insert(userRoles).values(data.userRoles);
      await tx.insert(departments).values(data.departments);
      await tx.insert(employees).values(data.employees);
      await tx.insert(companies).values(data.companies);
      await tx.insert(contacts).values(data.contacts);
      await tx.insert(leads).values(data.leads);
      await tx.insert(deals).values(data.deals);
      await tx.insert(activities).values(data.activities);
      await tx.insert(tasks).values(data.tasks);
      await tx.insert(products).values(data.products);
      await tx.insert(orders).values(data.orders);
      await tx.insert(orderItems).values(data.orderItems);
      await writeAudit(tx, { tenantId: tenant.id, userId: tenant.adminId, requestId }, {
        action: 'seed.completed', entityType: 'tenant', entityId: tenant.id,
        metadata: { referenceDate: startedAt.toISOString(), fakerSeed: tenant.seed },
      });
      return { tenantId: tenant.id, name: tenant.name, status: 'seeded' as const };
    });
    results.push(result);
  }
  return results;
}
