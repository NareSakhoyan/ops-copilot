/**
 * Demo MCP client: logs in against the REST API, connects to the Streamable HTTP MCP endpoint
 * with the resulting access token, lists the governed tools, and calls crm_search and task_draft.
 *
 * Usage: npm run mcp:demo
 * Env overrides: MCP_DEMO_BASE_URL, MCP_DEMO_TENANT_ID, MCP_DEMO_EMAIL, MCP_DEMO_PASSWORD
 * (defaults are the public Tenant A admin dev-seed fixture from docs/seed-scenarios.md).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = process.env.MCP_DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const TENANT_ID = process.env.MCP_DEMO_TENANT_ID ?? 'a0000000-0000-4000-8000-000000000001';
const EMAIL = process.env.MCP_DEMO_EMAIL ?? 'admin@example.invalid';
const PASSWORD = process.env.MCP_DEMO_PASSWORD ?? 'DevAdmin!2026';

interface LoginResponse { accessToken: string }
interface CrmSearchRow { id: string; title: string; responsibleEmployeeId?: string; responsibleEmployeeName?: string }

async function login(): Promise<string> {
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: TENANT_ID, email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Login failed: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as LoginResponse;
  return body.accessToken;
}

function parseToolText(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '';
  return JSON.parse(text.replace(/^UNTRUSTED_TOOL_DATA\n/, ''));
}

async function main(): Promise<void> {
  console.log(`Logging in as ${EMAIL} (tenant ${TENANT_ID}) against ${BASE_URL} ...`);
  const accessToken = await login();

  const client = new Client({ name: 'ops-copilot-mcp-demo', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\nConnected. Server exposes ${tools.length} tools:`);
  for (const tool of tools) console.log(`  - ${tool.name}: ${tool.description}`);

  console.log('\nCalling crm_search (entity: deals, limit: 1) ...');
  const search = await client.callTool({ name: 'crm_search', arguments: { entity: 'deals', limit: 1 } });
  const searchResult = parseToolText(search as { content?: { type: string; text?: string }[] }) as { rows: CrmSearchRow[] };
  console.log(JSON.stringify(searchResult, null, 2));
  const [sampleDeal] = searchResult.rows;
  if (!sampleDeal?.responsibleEmployeeId) {
    console.log('\nNo deal with a responsible employee was found; skipping the task_draft call.');
    await client.close();
    return;
  }

  console.log(`\nCalling task_draft, assigning ${sampleDeal.responsibleEmployeeName ?? sampleDeal.responsibleEmployeeId} ...`);
  const draft = await client.callTool({
    name: 'task_draft',
    arguments: {
      title: `Follow up on ${sampleDeal.title}`,
      description: 'Call the customer to confirm next steps.',
      assigneeEmployeeId: sampleDeal.responsibleEmployeeId,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const draftResult = parseToolText(draft as { content?: { type: string; text?: string }[] });
  console.log(JSON.stringify(draftResult, null, 2));
  console.log('\nThis created a pending_action only. Approve or reject it from the app, or via REST POST /approvals/{id}/approve — MCP has no approve or execute tool.');

  await client.close();
}

await main();
