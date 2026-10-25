import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '../auth/context.js';
import type { createApprovalsService } from '../approvals/service.js';
import type { TenantDatabase } from '../db/client.js';
import { registerMcpTools, type McpToolDependencies } from './tools.js';

/**
 * Builds one fresh McpServer per request (stateless mode): every tool call is authenticated and
 * scoped to the caller's own RequestContext, with no session state shared across requests or callers.
 */
export function buildMcpServer(
  ctx: RequestContext, database: TenantDatabase,
  proposals: Pick<ReturnType<typeof createApprovalsService>, 'createProposal'>,
  dependencies: McpToolDependencies = {},
): McpServer {
  const server = new McpServer({ name: 'ops-copilot-mcp', version: '0.1.0' });
  registerMcpTools(server, ctx, database, proposals, dependencies);
  return server;
}
