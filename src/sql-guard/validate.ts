import { parse, toSql } from 'pgsql-ast-parser';
import type { DataTypeDef, Expr, SelectFromStatement, SelectStatement, Statement } from 'pgsql-ast-parser';
import { z } from 'zod';
import { analyticsViews } from '../db/schema/analytics.js';
import type { AnalyticsViewName } from '../db/schema/analytics.js';
import { HttpError } from '../routes/errors.js';

const functions = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'date_trunc', 'now', 'round', 'abs', 'ceil', 'floor']);
const aggregates = new Set(['count', 'sum', 'avg', 'min', 'max']);
const types = new Set(['text', 'uuid', 'boolean', 'bool', 'integer', 'int', 'int4', 'bigint', 'int8', 'numeric', 'decimal', 'real', 'float', 'float4', 'float8', 'double precision', 'date', 'timestamp', 'timestamptz', 'timestamp with time zone', 'timestamp without time zone', 'interval']);
const operators = new Set(['AND', 'OR', '=', '!=', '<>', '<', '<=', '>', '>=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', '+', '-', '*', '/', '%', '||', 'AT TIME ZONE']);
const systemColumns = new Set(['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']);
const dimensions = new Set(['status', 'currency', 'department_id']);
const viewerColumns = new Set([...dimensions, 'amount', 'won_amount', 'deal_count', 'won_count', 'lost_count', 'open_count', 'created_at', 'closed_at', 'due_at', 'last_activity_at']);

function reject(message = 'SQL is outside the read-only analytics allowlist'): never {
  throw new HttpError(400, message);
}

function identifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name) || name.startsWith('pg_') || name === 'information_schema') reject();
}

function dataType(type: DataTypeDef): void {
  if (type.kind === 'array' || type.schema !== undefined || !types.has(type.name)) reject();
}

function viewerQuery(query: SelectStatement): void {
  // Deliberately small: one direct view, no subquery/window/CTE identities to track.
  if (query.type !== 'select' || query.from?.length !== 1 || query.from[0]?.type !== 'table' || query.from[0].join) reject('Viewers may run aggregate queries only');
  const aliases = new Map(query.columns?.flatMap((column) => column.alias ? [[column.alias.name, column.expr] as const] : []));
  const groupDimension = (expr: Expr): boolean => {
    if (expr.type === 'integer') {
      const projected = query.columns?.[expr.value - 1]?.expr;
      return projected !== undefined && projected.type !== 'integer' && groupDimension(projected);
    }
    if (expr.type === 'ref') {
      if (dimensions.has(expr.name)) return true;
      const aliased = aliases.get(expr.name);
      return aliased !== undefined && aliased.type !== 'ref' && groupDimension(aliased);
    }
    return expr.type === 'call' && expr.function.name === 'date_trunc' && expr.args[0]?.type === 'string'
      && expr.args[1]?.type === 'ref' && ['created_at', 'closed_at', 'due_at', 'last_activity_at'].includes(expr.args[1].name);
  };
  if (query.groupBy?.some((expr) => !groupDimension(expr))) reject('Viewer grouping cannot expose record identities');
  let hasAggregate = false;
  function check(expr: Expr, counted = false): void {
    switch (expr.type) {
      case 'ref':
        if (counted && (expr.name === '*' || expr.name === 'id')) return;
        if (!viewerColumns.has(expr.name)) reject('Viewers cannot read record identities');
        return;
      case 'call':
        if (expr.over || expr.withinGroup || expr.orderBy) reject('Viewers may run aggregate queries only');
        if (aggregates.has(expr.function.name)) hasAggregate = true;
        expr.args.forEach((arg) => check(arg, expr.function.name === 'count'));
        if (expr.filter) check(expr.filter);
        return;
      case 'binary': check(expr.left); check(expr.right); return;
      case 'unary': check(expr.operand); return;
      case 'cast': check(expr.operand); return;
      case 'case':
        if (expr.value) check(expr.value);
        expr.whens.forEach((branch) => { check(branch.when); check(branch.value); });
        if (expr.else) check(expr.else);
        return;
      case 'ternary': check(expr.value); check(expr.lo); check(expr.hi); return;
      case 'list': expr.expressions.forEach((value) => check(value)); return;
      case 'extract': check(expr.from); return;
      case 'string': case 'integer': case 'numeric': case 'boolean': case 'null': case 'keyword': return;
      default: reject('Viewers may run aggregate queries only');
    }
  }
  query.columns?.forEach((column) => check(column.expr));
  // An aggregate in a filter/order clause cannot make a detail projection safe.
  if (!hasAggregate) reject('Viewers may run aggregate queries only');
  if (query.where) check(query.where);
  if (query.having) check(query.having);
  query.orderBy?.forEach((order) => {
    const expr = order.by.type === 'ref' ? aliases.get(order.by.name) ?? order.by : order.by;
    check(expr);
  });
}

export function validateSql(input: unknown, options: { aggregateOnly?: boolean } = {}) {
  const checked = z.string().trim().min(1).max(20000).safeParse(input);
  if (!checked.success) reject('SQL must be a nonempty string of at most 20000 characters');
  const text = checked.data;
  let statements: Statement[];
  try { statements = parse(text, { locationTracking: true }); }
  catch { reject('SQL syntax is not supported'); }
  if (statements.length !== 1 || !statements[0]) reject('Exactly one SELECT is required');
  const views = new Set<AnalyticsViewName>();
  const ordinals = new Set<Expr>();
  let nodes = 0;
  function step(depth: number): void {
    if (++nodes > 2000 || depth > 40) reject('SQL exceeds the supported complexity');
  }
  function expression(expr: Expr, ctes: Set<string>, depth: number): void {
    step(depth);
    switch (expr.type) {
      case 'ref':
        if (expr.name !== '*') identifier(expr.name);
        if (systemColumns.has(expr.name)) reject();
        if (expr.table) {
          if (expr.table.schema !== undefined && expr.table.schema !== 'public') reject();
          identifier(expr.table.name);
        }
        return;
      case 'call':
        if (expr.function.schema !== undefined || !functions.has(expr.function.name)) reject('SQL function is not allowed');
        // Prevent a same-named public overload from expanding the function allowlist.
        if (!['coalesce', 'nullif'].includes(expr.function.name)) expr.function.schema = 'pg_catalog';
        expr.args.forEach((arg) => expression(arg, ctes, depth + 1));
        if (expr.filter) expression(expr.filter, ctes, depth + 1);
        expr.orderBy?.forEach((order) => expression(order.by, ctes, depth + 1));
        if (expr.withinGroup) expression(expr.withinGroup.by, ctes, depth + 1);
        expr.over?.partitionBy?.forEach((arg) => expression(arg, ctes, depth + 1));
        expr.over?.orderBy?.forEach((order) => expression(order.by, ctes, depth + 1));
        return;
      case 'binary':
        if (expr.opSchema !== undefined || !operators.has(expr.op)) reject();
        if (['=', '!=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '||'].includes(expr.op)) expr.opSchema = 'pg_catalog';
        expression(expr.left, ctes, depth + 1); expression(expr.right, ctes, depth + 1); return;
      case 'unary':
        if (expr.opSchema !== undefined) reject();
        if (expr.op === '+' || expr.op === '-') expr.opSchema = 'pg_catalog';
        expression(expr.operand, ctes, depth + 1); return;
      case 'cast': dataType(expr.to); expression(expr.operand, ctes, depth + 1); return;
      case 'case':
        if (expr.value) expression(expr.value, ctes, depth + 1);
        expr.whens.forEach((branch) => { expression(branch.when, ctes, depth + 1); expression(branch.value, ctes, depth + 1); });
        if (expr.else) expression(expr.else, ctes, depth + 1);
        return;
      case 'ternary':
        expression(expr.value, ctes, depth + 1); expression(expr.lo, ctes, depth + 1); expression(expr.hi, ctes, depth + 1); return;
      case 'list': expr.expressions.forEach((value) => expression(value, ctes, depth + 1)); return;
      case 'extract':
        if (!['year', 'month', 'day', 'hour', 'minute', 'second', 'epoch', 'dow', 'week'].includes(expr.field.name.toLowerCase())) reject();
        expression(expr.from, ctes, depth + 1); return;
      case 'keyword':
        if (!['current_date', 'current_timestamp'].includes(expr.keyword)) reject();
        return;
      case 'string': case 'integer': case 'numeric': case 'boolean': case 'null': return;
      case 'select': case 'union': case 'union all': case 'with': select(expr, ctes, depth + 1); return;
      default: reject();
    }
  }
  function selection(query: SelectFromStatement, ctes: Set<string>, depth: number): void {
    if (query.for || query.skip || !query.columns?.length) reject();
    query.columns.forEach((column) => {
      if (column.alias) identifier(column.alias.name);
      expression(column.expr, ctes, depth + 1);
    });
    query.from?.forEach((from) => {
      if (from.type === 'table') {
        identifier(from.name.name);
        if (from.name.alias) identifier(from.name.alias);
        if (from.name.columnNames) reject();
        if (from.name.schema === undefined && ctes.has(from.name.name)) {
          // Already validated when its binding was encountered.
        } else {
          if (from.name.schema !== undefined && from.name.schema !== 'public') reject();
          if (!Object.hasOwn(analyticsViews, from.name.name)) reject('SQL relation is not an approved analytics view');
          views.add(from.name.name as AnalyticsViewName);
          from.name.schema = 'public'; // Pin real views; pg_temp must not shadow them.
        }
      } else if (from.type === 'statement') {
        identifier(from.alias);
        if (from.columnNames) reject();
        select(from.statement, ctes, depth + 1);
      } else reject('Functions in FROM are not allowed');
      if (from.join?.on) expression(from.join.on, ctes, depth + 1);
      from.join?.using?.forEach((column) => identifier(column.name));
    });
    if (query.where) expression(query.where, ctes, depth + 1);
    if (query.having) expression(query.having, ctes, depth + 1);
    query.groupBy?.forEach((expr) => {
      if (expr.type === 'integer') {
        if (!Number.isSafeInteger(expr.value)) reject();
        ordinals.add(expr);
      }
      expression(expr, ctes, depth + 1);
    });
    query.orderBy?.forEach((order) => {
      if (order.by.type === 'integer') {
        if (!Number.isSafeInteger(order.by.value)) reject();
        ordinals.add(order.by);
      }
      expression(order.by, ctes, depth + 1);
    });
    if (Array.isArray(query.distinct)) query.distinct.forEach((expr) => expression(expr, ctes, depth + 1));
    if (query.limit?.limit) expression(query.limit.limit, ctes, depth + 1);
    if (query.limit?.offset) expression(query.limit.offset, ctes, depth + 1);
  }
  function select(query: Statement, inherited: Set<string>, depth: number): asserts query is SelectStatement {
    step(depth);
    if (query.type === 'select') selection(query, inherited, depth);
    else if (query.type === 'union' || query.type === 'union all') {
      select(query.left, inherited, depth + 1); select(query.right, inherited, depth + 1);
    } else if (query.type === 'with') {
      const ctes = new Set(inherited);
      for (const binding of query.bind) {
        identifier(binding.alias.name);
        if (ctes.has(binding.alias.name) || Object.hasOwn(analyticsViews, binding.alias.name)) reject();
        select(binding.statement, ctes, depth + 1);
        ctes.add(binding.alias.name);
      }
      select(query.in, ctes, depth + 1);
    } else reject('Only read-only SELECT statements are allowed');
  }
  const statement = statements[0];
  select(statement, new Set(), 0);
  let isAggregate = false;
  try { viewerQuery(statement); isAggregate = true; }
  catch (error: unknown) {
    if (!(error instanceof HttpError) || options.aggregateOnly) throw error;
  }

  const parameters: (string | boolean)[] = [];
  function bind(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (ordinals.has(value as Expr)) return;
    if (Array.isArray(value)) { value.forEach(bind); return; }
    const node = value as Record<string, unknown>;
    if (['string', 'integer', 'numeric', 'boolean'].includes(String(node['type']))) {
      const type = node['type'];
      let literal: string | boolean;
      let cast = 'numeric';
      if (type === 'integer' || type === 'numeric') {
        const location = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).parse(node['_location']);
        literal = text.slice(location.start, location.end).replace(/\s+/gu, '');
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(literal)) reject('Unsupported numeric literal');
        // Read numeric token text, not the parser's rounded JavaScript number.
        if (type === 'integer') {
          const integer = BigInt(literal);
          cast = integer >= -2147483648n && integer <= 2147483647n ? 'int4'
            : integer >= -9223372036854775808n && integer <= 9223372036854775807n ? 'int8' : 'numeric';
        }
      } else literal = z.union([z.string(), z.boolean()]).parse(node['value']);
      parameters.push(literal);
      delete node['value'];
      const parameter = { type: 'parameter', name: `$${parameters.length}` };
      if (type === 'string') {
        node['type'] = parameter.type; node['name'] = parameter.name;
      } else {
        node['type'] = 'cast'; node['operand'] = parameter;
        node['to'] = { name: type === 'boolean' ? 'bool' : cast };
      }
    } else Object.values(node).forEach(bind);
  }
  bind(statement);
  const wrapped: SelectFromStatement = {
    type: 'select', columns: [{ expr: { type: 'ref', name: '*' } }],
    from: [{ type: 'statement', statement, alias: 'analytics_result' }],
    limit: { limit: { type: 'integer', value: 200 } },
  };
  return { sql: toSql.statement(wrapped), parameters, views: [...views], isAggregate };
}
