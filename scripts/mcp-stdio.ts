/**
 * Local-development-only stdio MCP entry point. Logs in once with real credentials (reusing the
 * same password-verification and RequestContext-loading path as the HTTP API), then serves the
 * same five governed tools over stdio for one process lifetime — there is no per-message
 * re-authentication the way the Streamable HTTP endpoint provides. Do not run this against a
 * production database or expose it to anyone other than the local operator.
 *
 * Usage: npm run mcp:stdio
 * Env overrides: MCP_STDIO_TENANT_ID, MCP_STDIO_EMAIL, MCP_STDIO_PASSWORD
 * (defaults are the public Tenant A admin dev-seed fixture from docs/seed-scenarios.md).
 */
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAuthConfig } from '../src/auth/config.js';
import { authenticateContext } from '../src/auth/routes.js';
import { createAuthService } from '../src/auth/service.js';
import { createApprovalsService } from '../src/approvals/service.js';
import { database } from '../src/db/client.js';
import { createMockBitrix } from '../src/mock-bitrix/service.js';
import { buildMcpServer } from '../src/mcp/server.js';

const TENANT_ID = process.env.MCP_STDIO_TENANT_ID ?? 'a0000000-0000-4000-8000-000000000001';
const EMAIL = process.env.MCP_STDIO_EMAIL ?? 'admin@example.invalid';
const PASSWORD = process.env.MCP_STDIO_PASSWORD ?? 'DevAdmin!2026';

async function main(): Promise<void> {
  const authConfig = loadAuthConfig();
  const auth = createAuthService(database, authConfig);
  const requestId = randomUUID();
  const { accessToken } = await auth.login({ tenantId: TENANT_ID, email: EMAIL, password: PASSWORD }, requestId);
  const ctx = await authenticateContext(database, authConfig, { headers: { authorization: `Bearer ${accessToken}` }, id: requestId });
  if (!ctx) throw new Error('Failed to build a RequestContext from the fresh login token.');

  const mock = createMockBitrix(database);
  const proposals = createApprovalsService(database, mock);
  const server = buildMcpServer(ctx, database, proposals);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP stdio server ready for ${EMAIL} (tenant ${TENANT_ID}). Roles: ${ctx.roles.join(', ')}.`);
}

await main();
