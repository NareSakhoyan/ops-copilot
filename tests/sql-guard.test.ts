import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';
import { validateSql } from '../src/sql-guard/validate.js';

const malicious = [
  'SELECT * FROM v_deals; DELETE FROM deals',
  'SELECT * FROM v_deals; DROP TABLE deals; --',
  'SELECT 1; SELECT 2',
  'INSERT INTO deals (amount) VALUES (1)',
  'UPDATE deals SET amount = 0',
  'DELETE FROM deals',
  'TRUNCATE deals',
  'ALTER TABLE deals ADD COLUMN hacked text',
  'CREATE TABLE hacked (id int)',
  'COPY deals TO STDOUT',
  'SELECT * INTO hacked FROM v_deals',
  'SELECT * INTO TEMP TABLE hacked FROM v_deals',
  'WITH x AS (DELETE FROM deals RETURNING *) SELECT * FROM x',
  'WITH x AS (UPDATE deals SET amount=0 RETURNING *) SELECT * FROM x',
  "WITH x AS (INSERT INTO deals (amount) VALUES (0) RETURNING *) SELECT * FROM x",
  'WITH x AS (SELECT * FROM users) SELECT * FROM x',
  'WITH x AS (SELECT * FROM v_deals) DELETE FROM deals',
  'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT * FROM x',
  'SELECT * FROM deals',
  'SELECT id FROM public.deals',
  'SELECT * FROM "deals"',
  'SELECT * FROM "public"."users"',
  'SELECT * FROM v_deals UNION SELECT * FROM pg_shadow',
  'SELECT * FROM v_deals UNION ALL SELECT * FROM information_schema.columns',
  'SELECT * FROM pg_catalog.pg_authid',
  'SELECT * FROM "pg_catalog"."pg_shadow"',
  'SELECT * FROM information_schema.tables',
  'SELECT * FROM pg_class',
  'SELECT * FROM other_schema.v_deals',
  'SELECT * FROM pg_temp.v_deals',
  'SELECT (SELECT password_hash FROM users) FROM v_deals',
  'SELECT * FROM v_deals WHERE EXISTS (SELECT 1 FROM refresh_tokens)',
  "SELECT pg_sleep(10) FROM v_deals",
  'SELECT "pg_sleep"(10)',
  'SELECT pg_catalog.pg_sleep(10)',
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT dblink('connection', 'DELETE FROM deals')",
  "SELECT set_config('app.tenant_id', 'b0000000-0000-4000-8000-000000000001', true)",
  "SELECT set_config('role', 'app_user', true)",
  "SELECT set_config('statement_timeout', '0', true)",
  "SELECT /* harmless */ set_config /* hidden */ ('app.tenant_id', 'x', true)",
  "SELECT set_/**/config('app.tenant_id', 'x', true)",
  "SELECT current_setting('app.tenant_id')",
  "SET app.tenant_id = 'b0000000-0000-4000-8000-000000000001'",
  'SET ROLE app_user',
  'SET LOCAL ROLE migration_owner',
  'RESET ROLE',
  'SELECT * FROM v_deals; /* hidden */ RESET ROLE',
  'SELECT * FROM v_deals -- harmless\n; SET ROLE migration_owner',
  'SELECT * FROM v_deals FOR UPDATE',
  'SELECT * FROM v_deals FOR SHARE',
  "SELECT 'users'::regclass",
  "SELECT 'pg_sleep'::regproc",
  "SELECT 'x'::public.custom_type",
  'SELECT count(*) FROM generate_series(1, 1000000000)',
  'SELECT array_agg(id) FROM v_deals',
  'SELECT string_agg(id::text, chr(10)) FROM v_deals',
  'SELECT to_json(v_deals) FROM v_deals',
  'SELECT public.sum(amount) FROM v_deals',
  'SELECT tableoid, ctid, xmin FROM v_deals',
  'SELECT amount OPERATOR(public.+) 1 FROM v_deals',
  'SELECT $1 FROM v_deals',
  'EXPLAIN SELECT * FROM v_deals',
];

describe('SQL allowlist', () => {
  it.each(malicious)('rejects unsafe SQL: %s', (query) => {
    expect(() => validateSql(query)).toThrow();
  });

  it.each([
    'SELECT * FROM v_deals',
    'SELECT id, status, amount, currency FROM public.v_deals ORDER BY created_at DESC',
    'SELECT count(*), sum(amount), avg(amount), min(amount), max(amount) FROM v_deals',
    "SELECT date_trunc('month', closed_at) AS month, currency, sum(amount) FROM v_deals WHERE status = 'won' GROUP BY month, currency",
    "SELECT * FROM v_tasks WHERE status IN ('todo','in_progress') AND due_at < now()",
    "SELECT * FROM v_contacts_activity WHERE last_activity_at < now() - interval '14 days'",
    'SELECT department_id, currency, sum(won_amount) FROM v_employee_performance GROUP BY department_id, currency',
    'SELECT coalesce(sum(amount), 0), round(avg(amount), 2) FROM v_deals',
    'SELECT d.id FROM v_deals d JOIN v_tasks t ON t.deal_id = d.id',
    'WITH recent AS (SELECT id FROM v_deals) SELECT count(*) FROM recent',
    'SELECT id FROM v_deals UNION ALL SELECT deal_id FROM v_tasks',
    'SELECT * FROM (SELECT id FROM v_deals LIMIT 1000) d',
    'SELECT * FROM "public"."v_deals";',
    'SELECT /* safe comment */ count(*) FROM v_deals -- trailing comment',
    "SELECT '; DROP TABLE deals' AS message FROM v_deals",
    "SELECT 'O''Reilly' AS label, amount + 5 FROM v_deals LIMIT 10",
    'SELECT 1',
    'SELECT status, count(*) FROM v_deals GROUP BY 1 ORDER BY 1',
  ])('accepts safe SQL and caps its outer result: %s', (query) => {
    const result = validateSql(query);
    const statements = parse(result.sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ type: 'select', limit: { limit: { type: 'integer', value: 200 } }, from: [{ type: 'statement' }] });
  });

  it('binds literals and strips comments instead of executing the original SQL string', () => {
    const result = validateSql("SELECT 'O''Reilly; -- DROP' AS label FROM v_deals WHERE amount > 10 /* marker */");
    expect(result.parameters).toEqual(["O'Reilly; -- DROP", '10']);
    expect(result.sql).not.toContain('DROP');
    expect(result.sql).not.toContain('marker');
    expect(result.views).toEqual(['v_deals']);
  });

  it.each(['', '   ', 'SELECT (', 'x'.repeat(20001), null, { sql: 'SELECT 1' }])('fails closed on malformed or oversized input', (query) => {
    expect(() => validateSql(query)).toThrow();
  });
});

describe('viewer aggregate-only subset', () => {
  it.each([
    'SELECT count(*) FROM v_deals',
    'SELECT status, currency, count(*), sum(amount) FROM v_deals GROUP BY status, currency',
    "SELECT date_trunc('month', created_at) AS month, count(*) FROM v_deals GROUP BY month",
    'SELECT department_id, currency, sum(won_amount) FROM v_employee_performance GROUP BY department_id, currency',
    'SELECT count(DISTINCT id) FROM v_contacts_activity',
    'SELECT max(last_activity_at) FROM v_contacts_activity',
    'SELECT status, count(*) FROM v_deals GROUP BY 1 ORDER BY 1',
  ])('accepts aggregates without row identities: %s', (query) => {
    expect(() => validateSql(query, { aggregateOnly: true })).not.toThrow();
  });

  it.each([
    'SELECT * FROM v_deals',
    'SELECT id, count(*) FROM v_deals GROUP BY id',
    'SELECT name, count(*) FROM v_contacts_activity GROUP BY name',
    'SELECT max(id) FROM v_deals',
    'SELECT min(name) FROM v_contacts_activity',
    'SELECT id, count(*) OVER () FROM v_deals',
    'SELECT employee_id, sum(won_amount) FROM v_employee_performance GROUP BY employee_id',
    'WITH x AS (SELECT * FROM v_deals) SELECT * FROM x',
    'SELECT * FROM (SELECT * FROM v_deals) x',
    'SELECT amount, count(*) FROM v_deals GROUP BY amount',
    'SELECT count(*) FROM v_deals UNION ALL SELECT count(*) FROM v_tasks',
    'SELECT id, count(*) FROM v_deals GROUP BY 1',
  ])('rejects detail extraction disguised as aggregation: %s', (query) => {
    expect(() => validateSql(query, { aggregateOnly: true })).toThrow();
  });
});
