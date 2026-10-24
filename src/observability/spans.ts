import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { tracer } from './tracing.js';
import { redactValue } from './redact.js';
import { toolErrorCounter } from './metrics.js';

// Matches the tool output contract used across src/agent/tools.ts and sql.ts.
function isToolFailure(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const shape = result as { error?: unknown; refused?: unknown };
  return Boolean(shape.error) || shape.refused === true;
}

/** Wraps one tool execution in a span: name, redacted input, status, and duration. Records exceptions and increments the tool-error metric on failure. */
export async function withToolSpan<T>(toolName: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan('tool.call', { attributes: { 'tool.name': toolName, 'tool.input': JSON.stringify(redactValue(input)) } }, async (span) => {
    const started = performance.now();
    try {
      const result = await fn();
      const failed = isToolFailure(result);
      span.setAttributes({ 'tool.status': failed ? 'failed' : 'succeeded', 'tool.duration_ms': performance.now() - started });
      if (failed) toolErrorCounter.add(1, { tool: toolName });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttributes({ 'tool.status': 'failed', 'tool.duration_ms': performance.now() - started });
      toolErrorCounter.add(1, { tool: toolName });
      throw error;
    } finally { span.end(); }
  });
}

/** Wraps the whole agent turn; child spans (steps, tool calls, LLM calls) nest under this via active-span context. */
export async function withAgentRunSpan<T>(fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan('agent.run', async (span) => {
    try { return await fn(span); }
    catch (error) { span.recordException(error as Error); span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  });
}

/** Point-in-time span for one agent step; start/end are approximated as instantaneous since onStepEnd fires after the step already completed. */
export function recordAgentStep(attributes: Record<string, string | number | boolean>): void {
  tracer.startSpan('agent.step', { attributes }).end();
}

export function recordSqlGuardVerdict(attributes: { verdict: 'accepted' | 'rejected' | 'error'; rows: number; durationMs: number }): void {
  const span = tracer.startSpan('sql_guard.verdict', { attributes: {
    'sql_guard.verdict': attributes.verdict, 'sql_guard.rows': attributes.rows, 'sql_guard.duration_ms': attributes.durationMs,
  } });
  if (attributes.verdict !== 'accepted') span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
