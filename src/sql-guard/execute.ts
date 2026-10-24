import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadContext } from '../auth/context.js';
import type { RequestContext } from '../auth/context.js';
import { can, recordScope } from '../auth/rbac.js';
import { database } from '../db/client.js';
import type { TenantDatabase } from '../db/client.js';
import { sqlExecutionLog } from '../db/schema/analytics-log.js';
import type { AnalyticsViewName } from '../db/schema/analytics.js';
import { HttpError } from '../routes/errors.js';
import { validateSql } from './validate.js';
import { recordSqlGuardVerdict } from '../observability/spans.js';

const rowPermissions: Record<AnalyticsViewName, string> = {
  v_deals: 'deals:read', v_tasks: 'tasks:read',
  v_contacts_activity: 'contacts:read', v_employee_performance: 'deals:read',
};
const identitySchema = z.object({ tenantId: z.uuid(), userId: z.uuid(), requestId: z.uuid() });

function boundQuery(validated: ReturnType<typeof validateSql>) {
  // All identifiers/operators come from the checked AST. Original literals are parameters.
  return sql.join(validated.sql.split(/(\$\d+)/u).map((part) => {
    if (!/^\$\d+$/u.test(part)) return sql.raw(part);
    const value = validated.parameters[Number(part.slice(1)) - 1];
    if (value === undefined) throw new Error('Missing analytics SQL parameter');
    return sql`${value}`;
  }), sql``);
}

export function createAnalyticsRunner(db: TenantDatabase) {
  return async function run(ctx: RequestContext, input: unknown, question?: string): Promise<Record<string, unknown>[]> {
    const identity = identitySchema.parse(ctx);
    const started = performance.now();
    let validated: ReturnType<typeof validateSql> | undefined;
    let validationError: HttpError | undefined;
    let checkedQuestion: string | null = null;
    try {
      checkedQuestion = z.string().max(4000).optional().parse(question) ?? null;
      validated = validateSql(input);
    } catch (error: unknown) {
      validationError = error instanceof HttpError ? error : new HttpError(400, 'Invalid analytics input');
    }

    const outcome = await db.withTenant({ tenant_id: identity.tenantId, user_id: identity.userId }, async (tx) => {
      const current = await loadContext(tx, identity.tenantId, identity.userId, identity.requestId);
      if (!current) throw new HttpError(403, 'Analytics user is unavailable');
      let failure = validationError;
      if (!can(current, 'deals:aggregate')) failure = new HttpError(403, 'Analytics access is not permitted');
      if (!failure && validated) {
        if (!validated.isAggregate && recordScope(current, 'rows').kind === 'none') {
          failure = new HttpError(400, 'Viewers may run aggregate queries only');
        } else if (!validated.isAggregate && validated.views.some((view) => !can(current, rowPermissions[view]))) {
          failure = new HttpError(403, 'Analytics resource access is not permitted');
        }
      }
      let verdict: 'accepted' | 'rejected' | 'error' = 'rejected';
      let rows: Record<string, unknown>[] = [];
      if (!failure && validated) {
        const query = validated;
        try {
          rows = await tx.transaction(async (execution) => {
            const scope = recordScope(current, query.isAggregate ? 'aggregates' : 'rows');
            await execution.execute(sql`SELECT
              set_config('app.analytics_scope', ${scope.kind}, true),
              set_config('app.analytics_department_id', ${current.departmentId ?? ''}, true),
              set_config('app.analytics_employee_id', ${current.employeeId ?? ''}, true)
            `);
            await execution.execute(sql`SET LOCAL search_path = pg_catalog, pg_temp`);
            await execution.execute(sql`SET LOCAL ROLE analytics_ro`);
            await execution.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const result = await execution.execute(boundQuery(query));
            const data = z.array(z.record(z.string(), z.unknown())).parse(result.rows);
            await execution.execute(sql`SET LOCAL ROLE app_user`);
            await execution.execute(sql`SET LOCAL statement_timeout = DEFAULT`);
            await execution.execute(sql`SET LOCAL search_path = DEFAULT`);
            return data;
          });
          verdict = 'accepted';
        } catch (error: unknown) {
          const code = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error);
          failure = code.success && code.data.cause.code === '57014'
            ? new HttpError(504, 'Analytics query timed out') : new HttpError(422, 'Analytics query failed');
          verdict = 'error';
        }
      }
      const durationMs = Math.ceil(performance.now() - started);
      await tx.insert(sqlExecutionLog).values({
        tenantId: identity.tenantId, userId: identity.userId, requestId: identity.requestId,
        question: checkedQuestion, sql: typeof input === 'string' ? input.slice(0, 20000) : '[invalid input]',
        verdict, rows: rows.length, durationMs, error: failure?.message ?? null,
      });
      recordSqlGuardVerdict({ verdict, rows: rows.length, durationMs });
      return { rows, error: failure };
    });
    // Throw only after the rejected/error execution record has committed.
    if (outcome.error) throw outcome.error;
    return outcome.rows;
  };
}

export const runAnalyticsQuery = createAnalyticsRunner(database);
