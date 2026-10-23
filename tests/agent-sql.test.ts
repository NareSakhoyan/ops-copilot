import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, modelText as text } from './helpers/model.js';
import type { RequestContext } from '../src/auth/context.js';
import { createSqlAnalyticsTool } from '../src/agent/sql.js';
import { HttpError } from '../src/routes/errors.js';

const ctx: RequestContext = { tenantId: randomUUID(), userId: randomUUID(), employeeId: randomUUID(), departmentId: null, roles: ['admin'], permissions: ['deals:aggregate'], requestId: randomUUID() };
const invocation = { toolCallId: 'test-sql', messages: [], context: {} };

describe('SQL generation and the single correction boundary', () => {
  it('shares the parent deadline and never executes SQL produced after cancellation', async () => {
    const controller = new AbortController();
    let release = () => {};
    let started = () => {};
    const generating = new Promise<void>((resolve) => { started = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: () => {
      started();
      return new Promise<ReturnType<typeof text>>((resolve) => { release = () => resolve(text('SELECT count(*) FROM v_deals')); });
    } });
    const runQuery = vi.fn().mockResolvedValue([]);
    const tool = createSqlAnalyticsTool(ctx, { model: () => model, runQuery });
    if (!tool.execute) throw new Error('Missing SQL tool');
    const result = tool.execute({ question: 'Count deals' }, { ...invocation, abortSignal: controller.signal });
    await generating;
    controller.abort(new DOMException('Deadline reached', 'TimeoutError'));
    try {
      await expect(result).resolves.toMatchObject({ refused: true });
    } finally { release(); }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runQuery).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  it('returns SQL and rows after exactly one correction without exposing rejected SQL errors', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text('DELETE FROM deals'), text('SELECT count(*) AS total FROM v_deals')] });
    const runQuery = vi.fn().mockRejectedValueOnce(new HttpError(400, 'private database diagnostic')).mockResolvedValueOnce([{ total: '600' }]);
    const tool = createSqlAnalyticsTool(ctx, { model: () => model, runQuery });
    if (!tool.execute) throw new Error('SQL tool must execute');
    const result = await tool.execute({ question: 'How many deals?' }, invocation);
    expect(result).toMatchObject({ sql: 'SELECT count(*) AS total FROM v_deals', rows: [{ total: '600' }], refused: false });
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery).toHaveBeenCalledWith(ctx, 'DELETE FROM deals', 'How many deals?');
    expect(model.doGenerateCalls).toHaveLength(2);
    const repair = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(repair).toContain('rejected');
    expect(repair).not.toContain('private database diagnostic');
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('v_employee_performance');
    expect(prompt).not.toContain('password_hash');
    expect(prompt).not.toContain('refresh_tokens');
  });

  it('refuses after the second rejection and does not reset the budget when called again', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text('SELECT * FROM users'), text('SELECT pg_sleep(10)')] });
    const runQuery = vi.fn().mockRejectedValue(new HttpError(400, 'private details'));
    const tool = createSqlAnalyticsTool(ctx, { model: () => model, runQuery });
    if (!tool.execute) throw new Error('SQL tool must execute');
    const result = await tool.execute({ question: 'Show data' }, invocation);
    expect(result).toMatchObject({ refused: true, rows: [] });
    expect(await tool.execute({ question: 'Try another query' }, invocation)).toMatchObject({ refused: true });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private details');
  });

  it('does not retry database execution failures as SQL validation rejections', async () => {
    const model = new MockLanguageModelV4({ doGenerate: text('SELECT count(*) FROM v_deals') });
    const runQuery = vi.fn().mockRejectedValue(new HttpError(504, 'Analytics query timed out'));
    const tool = createSqlAnalyticsTool(ctx, { model: () => model, runQuery });
    if (!tool.execute) throw new Error('SQL tool must execute');
    expect(await tool.execute({ question: 'Count deals' }, invocation)).toMatchObject({ refused: true });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
