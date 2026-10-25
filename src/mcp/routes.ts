import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import { authenticateContext } from '../auth/routes.js';
import type { createApprovalsService } from '../approvals/service.js';
import type { TenantDatabase } from '../db/client.js';
import { buildMcpServer } from './server.js';
import type { McpToolDependencies } from './tools.js';

export interface McpRateLimitOptions {
  max: number;
  timeWindow: number;
  /** Only ever true outside NODE_ENV=production; see src/app.ts. */
  skip?: boolean;
}

const methodNotAllowed = { jsonrpc: '2.0' as const, error: { code: -32000, message: 'Method not allowed.' }, id: null };

/**
 * Mounts the Streamable HTTP MCP endpoint at /mcp, stateless (a fresh McpServer + transport per
 * request). Governance mirrors the REST API: Origin allowlist (DNS-rebinding protection), the same
 * Bearer-JWT authentication and RequestContext construction as /chat (via authenticateContext),
 * and a per-user rate limit. Tool-level RBAC, the SQL guard, ACL-filtered KB search, auditing, and
 * OTel spans are applied inside the reused tool factories (see src/mcp/tools.ts).
 *
 * Full MCP OAuth (dynamic client registration, authorization-code flow) is NOT implemented: the
 * only supported credential is a Bearer access JWT obtained from POST /auth/login, exactly as REST
 * clients already authenticate. See docs/mcp.md.
 */
export function registerMcp(
  app: FastifyInstance, database: TenantDatabase, authConfig: AuthConfig,
  proposals: Pick<ReturnType<typeof createApprovalsService>, 'createProposal'>,
  rateLimitOptions: McpRateLimitOptions,
  mcpOptions: { allowedOrigins: string[] },
  dependencies: McpToolDependencies = {},
): void {
  app.register(async (routes) => {
    // DNS-rebinding protection: runs at onRequest, before auth/rate-limit/body parsing. A missing
    // Origin header (every non-browser client: curl, the demo script, MCP Inspector's CLI mode) is
    // allowed through; an Origin header present but not on the allowlist is rejected outright.
    routes.addHook('onRequest', (request, reply, done) => {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && !mcpOptions.allowedOrigins.includes(origin)) {
        reply.code(403).send({ error: 'Origin not allowed' });
        return;
      }
      done();
    });

    if (!rateLimitOptions.skip) {
      // Same ordering trick as src/agent/routes.ts registerChat: registering this plugin before the
      // addHook('preHandler', ...) call below means its own internal preHandler hook actually
      // attaches after authentication during Fastify's deferred plugin boot, letting keyGenerator
      // key on the authenticated user ID instead of falling back to the shared IP.
      await routes.register(rateLimit, {
        global: false, hook: 'preHandler', max: rateLimitOptions.max, timeWindow: rateLimitOptions.timeWindow,
        keyGenerator: (request) => request.context?.userId ?? request.ip,
      });
    }

    routes.addHook('preHandler', async (request, reply) => {
      const ctx = await authenticateContext(database, authConfig, request);
      if (!ctx) {
        reply.header('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"');
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      request.context = ctx;
    });

    routes.post('/mcp', rateLimitOptions.skip ? {} : {
      config: { rateLimit: { max: rateLimitOptions.max, timeWindow: rateLimitOptions.timeWindow } },
    }, async (request, reply) => {
      const ctx = request.context;
      reply.hijack();
      const server = buildMcpServer(ctx, database, proposals, dependencies);
      // Stateless mode: sessionIdGenerator is left unset, so no session ID is issued or validated.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      request.raw.once('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });

    // Stateless mode has no session to resume (GET's standalone SSE stream) or terminate (DELETE).
    routes.get('/mcp', (_request, reply) => { reply.code(405).send(methodNotAllowed); });
    routes.delete('/mcp', (_request, reply) => { reply.code(405).send(methodNotAllowed); });
  });
}
