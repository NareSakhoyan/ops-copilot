import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { RequestContext } from '../auth/context.js';
import type { createApprovalsService } from '../approvals/service.js';
import type { TenantDatabase } from '../db/client.js';
import { createAuditActivityTool, createCrmSearchTool, createKbSearchTool, createTaskDraftTool } from '../agent/tools.js';
import { createSqlAnalyticsTool } from '../agent/sql.js';
import { createChatModel } from '../agent/model.js';
import { toMcpToolResult } from '../agent/output.js';
import { createAnalyticsRunner } from '../sql-guard/execute.js';
import { answerFromKb } from '../rag/answer.js';
import { writeAudit } from '../observability/audit.js';
import { isToolFailure, withMcpCallSpan } from '../observability/spans.js';

interface ReusableTool {
  description?: string | ((options: { context: unknown }) => string);
  inputSchema: z.ZodType;
  execute?: (input: unknown, options: { toolCallId: string; messages: never[]; context: Record<string, never>; abortSignal?: AbortSignal }) => unknown;
}

// Every factory in agent/tools.ts and agent/sql.ts sets a literal description string (never the
// function-of-context variant), so this is always defined in practice for the five reused tools.
function describe(tool: ReusableTool): string {
  return typeof tool.description === 'string' ? tool.description : '';
}

// Every MCP tool call is audited as its own small transaction (channel 'mcp'), independent of any
// transaction the tool's own execute() opened and already committed for the underlying read/write.
async function recordMcpAudit(database: TenantDatabase, ctx: RequestContext, toolName: string, outcome: 'succeeded' | 'failed' | 'error'): Promise<void> {
  await database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, (tx) =>
    writeAudit(tx, ctx, { action: 'mcp.tool_call', entityType: 'mcp_tool', metadata: { tool: toolName, outcome, channel: 'mcp' } }));
}

// Wraps a reused agent tool's execute() for MCP: same span/audit/error-shape handling for every
// tool, so each registration below only supplies the tool-specific factory call and annotations.
function invokeReusedTool(database: TenantDatabase, ctx: RequestContext, toolName: string, reused: ReusableTool) {
  return async (args: unknown, extra: { signal: AbortSignal }): Promise<CallToolResult> => withMcpCallSpan(toolName, ctx.requestId, async () => {
    try {
      if (!reused.execute) throw new Error('Tool is not executable');
      const output = await reused.execute(args, { toolCallId: randomUUID(), messages: [], context: {}, abortSignal: extra.signal });
      const failed = isToolFailure(output);
      await recordMcpAudit(database, ctx, toolName, failed ? 'failed' : 'succeeded');
      return toMcpToolResult(output, failed);
    } catch {
      // Never leak error diagnostics (SQL/driver detail, stack traces) into the MCP error result.
      await recordMcpAudit(database, ctx, toolName, 'error').catch(() => {});
      return toMcpToolResult({ error: 'Tool request denied or unavailable. Do not infer missing data.', refused: true }, true);
    }
  });
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export interface McpToolDependencies {
  model?: () => LanguageModel;
  kbAnswer?: typeof answerFromKb;
}

/** Registers the five governed tools on a fresh per-request McpServer, reusing the same factories, Zod schemas, RBAC/SQL-guard/ACL enforcement, and audit writer as the REST chat agent. */
export function registerMcpTools(
  server: McpServer, ctx: RequestContext, database: TenantDatabase,
  proposals: Pick<ReturnType<typeof createApprovalsService>, 'createProposal'>,
  dependencies: McpToolDependencies = {},
): void {
  const crm = createCrmSearchTool(ctx, database) as unknown as ReusableTool;
  server.registerTool('crm_search', {
    description: describe(crm), inputSchema: crm.inputSchema, annotations: readOnlyAnnotations,
  }, invokeReusedTool(database, ctx, 'crm_search', crm));

  const sql = createSqlAnalyticsTool(ctx, { model: dependencies.model ?? createChatModel, runQuery: createAnalyticsRunner(database) }) as unknown as ReusableTool;
  server.registerTool('sql_analytics', {
    description: describe(sql), inputSchema: sql.inputSchema, annotations: readOnlyAnnotations,
  }, invokeReusedTool(database, ctx, 'sql_analytics', sql));

  const kb = createKbSearchTool(ctx, dependencies.kbAnswer
    ?? ((context, question) => answerFromKb(context, question, database))) as unknown as ReusableTool;
  server.registerTool('kb_search', {
    description: describe(kb), inputSchema: kb.inputSchema, annotations: readOnlyAnnotations,
  }, invokeReusedTool(database, ctx, 'kb_search', kb));

  const audit = createAuditActivityTool(ctx, database) as unknown as ReusableTool;
  server.registerTool('audit_activity', {
    description: describe(audit), inputSchema: audit.inputSchema, annotations: readOnlyAnnotations,
  }, invokeReusedTool(database, ctx, 'audit_activity', audit));

  // onDraft's preview isn't surfaced separately here: the tool's own CallToolResult (via
  // toMcpToolResult) already returns the full DraftPreview, including the pendingActionId.
  const draft = createTaskDraftTool(ctx, database, proposals.createProposal, () => {}) as unknown as ReusableTool;
  server.registerTool('task_draft', {
    description: `${describe(draft) ?? ''} Creates a pending_action only, with no execution. Approval happens separately in the app or through the REST /approvals API; MCP exposes no approve or execute tool.`,
    inputSchema: draft.inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, invokeReusedTool(database, ctx, 'task_draft', draft));
}
