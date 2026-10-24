import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadEnvironment } from '../src/config.js';
import { createDbClient } from '../src/db/client.js';
import { demoTenants, devPasswords } from '../src/db/seed/data.js';
import { deals, tasks } from '../src/db/schema/crm.js';

type Role = keyof typeof devPasswords;
interface Assertion { type: string; [key: string]: unknown }
interface EvalCase {
  id: string; category: string; user: string; role: Role; tenant: 'a' | 'b';
  input: string; allowTaskDraft?: boolean; followUp?: Array<{ action: 'approve' }>;
  expect: { tools?: string[]; must_not_call?: string[]; assertions: Assertion[] };
}
interface ToolCall { toolCallId: string; name: string; status: 'succeeded' | 'failed'; sql?: string; rowCount?: number }
interface ChatResponse { answer: string; toolCalls: ToolCall[]; pendingActionIds: string[] }

const BASE_URL = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3000';
const REPEATS = Number(process.env.EVAL_REPEATS ?? 2);
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 180000);
const environment = loadEnvironment();
const modelName = `${environment.LLM_PROVIDER ?? 'ollama'}:${environment.LLM_MODEL ?? '(default)'}`;
const db = createDbClient(String(environment.DATABASE_URL));

async function fetchJson(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Fastify's default JSON parser rejects a json content-type paired with an empty body,
    // so only set it when there is actually a body to send (e.g. not for the bodyless approve/reject POSTs).
    const response = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally { clearTimeout(timer); }
}

async function login(email: string, tenantId: string, role: Role): Promise<string> {
  const { status, body } = await fetchJson('/auth/login', {
    method: 'POST', body: JSON.stringify({ tenantId, email, password: devPasswords[role] }),
  });
  const token = (body as { accessToken?: string } | null)?.accessToken;
  if (status !== 200 || !token) throw new Error(`Login failed for ${email}: HTTP ${status} ${JSON.stringify(body)}`);
  return token;
}

// Reused across repeats of the same (email, tenant) instead of logging in before every call,
// which otherwise trips the 5-attempts-per-minute login limiter well before a full run finishes.
// Access tokens last 15 minutes; a 401 during a case (see runCase) forces exactly one re-login.
const tokenCache = new Map<string, string>();
async function getToken(email: string, tenantId: string, role: Role, forceRefresh = false): Promise<string> {
  const key = `${email}:${tenantId}`;
  if (!forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached) return cached;
  }
  const token = await login(email, tenantId, role);
  tokenCache.set(key, token);
  return token;
}

async function chat(token: string, message: string, allowTaskDraft: boolean): Promise<{ status: number; body: ChatResponse | { error: string } }> {
  const { status, body } = await fetchJson('/chat', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, allowTaskDraft }),
  }, TIMEOUT_MS);
  return { status, body: body as ChatResponse | { error: string } };
}

async function approve(token: string, pendingActionId: string): Promise<{ status: number; body: unknown }> {
  return fetchJson(`/approvals/${pendingActionId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, TIMEOUT_MS);
}

async function countRows(table: typeof deals | typeof tasks, tenant: 'a' | 'b'): Promise<number> {
  const demo = demoTenants.find((candidate) => candidate.slug === (tenant === 'a' ? 'ararat' : 'sevan'));
  if (!demo) throw new Error(`Unknown tenant ${tenant}`);
  return db.withTenant({ tenant_id: demo.id, user_id: demo.adminId }, async (tx) => {
    const rows = await tx.select().from(table).where(eq(table.tenantId, demo.id));
    return rows.length;
  });
}

async function taskExists(pendingActionId: string, tenant: 'a' | 'b'): Promise<boolean> {
  const demo = demoTenants.find((candidate) => candidate.slug === (tenant === 'a' ? 'ararat' : 'sevan'));
  if (!demo) throw new Error(`Unknown tenant ${tenant}`);
  return db.withTenant({ tenant_id: demo.id, user_id: demo.adminId }, async (tx) => {
    const rows = await tx.select().from(tasks).where(eq(tasks.id, pendingActionId));
    return rows.length > 0;
  });
}

interface RunState { chatResponse?: ChatResponse | { error: string }; approveResults: Array<{ status: number; body: unknown }>; dealsBefore?: number; dealsAfter?: number }

async function evaluate(assertion: Assertion, evalCase: EvalCase, state: RunState): Promise<string | null> {
  const chatResponse = state.chatResponse && 'answer' in state.chatResponse ? state.chatResponse : undefined;
  switch (assertion.type) {
    case 'tool_called_any': {
      const names = new Set((chatResponse?.toolCalls ?? []).map((call) => call.name));
      const wanted = assertion.tools as string[];
      return wanted.some((name) => names.has(name)) ? null : `expected one of [${wanted.join(', ')}] to be called, got [${[...names].join(', ')}]`;
    }
    case 'answer_matches': {
      const pattern = String(assertion.pattern);
      const flags = typeof assertion.flags === 'string' ? assertion.flags : '';
      const regex = new RegExp(pattern, flags);
      return chatResponse && regex.test(chatResponse.answer) ? null : `answer did not match /${pattern}/${flags}: ${JSON.stringify(chatResponse?.answer)}`;
    }
    case 'answer_contains': {
      const text = String(assertion.text);
      return chatResponse && chatResponse.answer.includes(text) ? null : `answer did not contain "${text}": ${JSON.stringify(chatResponse?.answer)}`;
    }
    case 'tool_rowcount': {
      const toolName = String(assertion.tool);
      const expected = Number(assertion.equals);
      const call = chatResponse?.toolCalls.find((candidate) => candidate.name === toolName);
      return call?.rowCount === expected ? null : `expected ${toolName} rowCount ${expected}, got ${call?.rowCount ?? 'not called'}`;
    }
    case 'db_count_unchanged':
      return state.dealsBefore === state.dealsAfter ? null : `${String(assertion.table)} row count changed: ${state.dealsBefore} -> ${state.dealsAfter}`;
    case 'has_pending_action':
      return (chatResponse?.pendingActionIds.length ?? 0) > 0 ? null : 'expected a pendingActionId in the chat response';
    case 'db_task_not_created': {
      const id = chatResponse?.pendingActionIds[0];
      if (!id) return 'no pendingActionId to check';
      return (await taskExists(id, evalCase.tenant)) ? `tasks row already exists for ${id} before approval` : null;
    }
    case 'db_task_created_once': {
      const id = chatResponse?.pendingActionIds[0];
      if (!id) return 'no pendingActionId to check';
      const demo = demoTenants.find((candidate) => candidate.slug === (evalCase.tenant === 'a' ? 'ararat' : 'sevan'));
      if (!demo) return 'unknown tenant';
      const count = await db.withTenant({ tenant_id: demo.id, user_id: demo.adminId },
        (tx) => tx.select().from(tasks).where(eq(tasks.id, id)));
      return count.length === 1 ? null : `expected exactly 1 task row for ${id}, found ${count.length}`;
    }
    case 'approvals_both_succeed_idempotently': {
      const statuses = state.approveResults.map((result) => result.status);
      const bodies = state.approveResults.map((result) => (result.body as { status?: string } | null)?.status);
      const ok = statuses.every((status) => status === 200) && bodies.every((status) => status === 'executed');
      return ok ? null : `approve responses were not both 200/executed: statuses=${JSON.stringify(statuses)} bodyStatuses=${JSON.stringify(bodies)}`;
    }
    default:
      return `unknown assertion type ${assertion.type}`;
  }
}

async function runCase(evalCase: EvalCase): Promise<string[]> {
  const demo = demoTenants.find((candidate) => candidate.slug === (evalCase.tenant === 'a' ? 'ararat' : 'sevan'));
  if (!demo) throw new Error(`Unknown tenant ${evalCase.tenant}`);
  let token = await getToken(evalCase.user, demo.id, evalCase.role);
  // A 401 mid-run means the 15-minute-old cached token expired; refresh once and retry that one call.
  const withAuthRetry = async <T extends { status: number }>(call: (authToken: string) => Promise<T>): Promise<T> => {
    const result = await call(token);
    if (result.status !== 401) return result;
    token = await getToken(evalCase.user, demo.id, evalCase.role, true);
    return call(token);
  };
  const state: RunState = { approveResults: [] };

  state.dealsBefore = await countRows(deals, evalCase.tenant);
  const { status, body } = await withAuthRetry((authToken) => chat(authToken, evalCase.input, evalCase.allowTaskDraft ?? false));
  state.chatResponse = body;
  state.dealsAfter = await countRows(deals, evalCase.tenant);

  const failures: string[] = [];
  if (status !== 200) failures.push(`chat returned HTTP ${status}: ${JSON.stringify(body)}`);
  const chatResponse = body && 'toolCalls' in body ? body : undefined;
  const calledNames = new Set((chatResponse?.toolCalls ?? []).map((call) => call.name));
  for (const required of evalCase.expect.tools ?? []) if (!calledNames.has(required)) failures.push(
    `expected tool "${required}" to be called, got [${[...calledNames].join(', ') || 'none'}]; answer: ${JSON.stringify(chatResponse?.answer)}`);
  for (const forbidden of evalCase.expect.must_not_call ?? []) if (calledNames.has(forbidden)) failures.push(`tool "${forbidden}" must not be called`);

  for (const followUp of evalCase.followUp ?? []) {
    if (followUp.action !== 'approve') continue;
    const pendingId = chatResponse?.pendingActionIds[0];
    if (!pendingId) { failures.push('followUp approve requested but no pendingActionId was returned'); continue; }
    state.approveResults.push(await withAuthRetry((authToken) => approve(authToken, pendingId)));
  }

  for (const assertion of evalCase.expect.assertions) {
    const failure = await evaluate(assertion, evalCase, state);
    if (failure) failures.push(`[${assertion.type}] ${failure}`);
  }
  return failures;
}

interface CaseResult { id: string; category: string; passes: number; total: number; failures: string[][] }

async function main(): Promise<void> {
  const datasetPath = fileURLToPath(new URL('./dataset.json', import.meta.url));
  const cases = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvalCase[];
  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    const result: CaseResult = { id: evalCase.id, category: evalCase.category, passes: 0, total: REPEATS, failures: [] };
    for (let attempt = 0; attempt < REPEATS; attempt++) {
      process.stdout.write(`Running ${evalCase.id} (attempt ${attempt + 1}/${REPEATS})...\n`);
      try {
        const failures = await runCase(evalCase);
        if (failures.length === 0) result.passes++;
        result.failures.push(failures);
        process.stdout.write(failures.length === 0 ? `  PASS\n` : `  FAIL: ${failures.join('; ')}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push([`threw: ${message}`]);
        process.stdout.write(`  ERROR: ${message}\n`);
      }
    }
    results.push(result);
  }

  const totalPasses = results.reduce((sum, result) => sum + result.passes, 0);
  const totalRuns = results.reduce((sum, result) => sum + result.total, 0);

  process.stdout.write('\n| Case | Category | Pass rate |\n| --- | --- | --- |\n');
  for (const result of results) process.stdout.write(`| ${result.id} | ${result.category} | ${result.passes}/${result.total} |\n`);
  process.stdout.write(`\nOverall: ${totalPasses}/${totalRuns} (${((totalPasses / totalRuns) * 100).toFixed(1)}%)\n`);

  const report = { model: modelName, date: new Date().toISOString(), repeats: REPEATS, totalPasses, totalRuns, results };
  const reportPath = fileURLToPath(new URL('./report.json', import.meta.url));
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`\nJSON report written to ${reportPath}\n`);

  await db.close();
  process.exitCode = totalPasses === totalRuns ? 0 : 1;
}

await main();
