import type { OpenAPIV3 } from 'openapi-types';

/**
 * Hand-written, static OpenAPI document served read-only via @fastify/swagger's
 * `mode: 'static'`. Deliberately not derived from each route's existing inline Zod
 * validation (src/auth/routes.ts, src/approvals/routes.ts, etc.): adding per-route
 * `schema` options would make Fastify's own ajv validate requests a second time
 * alongside that Zod validation, risking behavior drift between the two. This file
 * only documents the already-implemented contract; it has no effect on request
 * handling or validation.
 */

const errorResponse: OpenAPIV3.ResponseObject = {
  description: 'Error',
  content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] } } },
};

const bearerAuth = [{ bearerAuth: [] }];

const tokenResponseSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    accessToken: { type: 'string', description: 'HS256 JWT, 15-minute lifetime.' },
    refreshToken: { type: 'string', description: 'Opaque base64url token; rotates on every use.' },
    expiresIn: { type: 'integer', example: 900 },
  },
  required: ['accessToken', 'refreshToken', 'expiresIn'],
};

const pendingActionSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['task.create'] },
    payload: { type: 'object' },
    status: { type: 'string', enum: ['pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired'] },
    attempts: { type: 'integer', minimum: 0, maximum: 3 },
    error: { type: 'string', nullable: true },
    decidedAt: { type: 'string', format: 'date-time', nullable: true },
    executedAt: { type: 'string', format: 'date-time', nullable: true },
    expiresAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'tenantId', 'userId', 'type', 'payload', 'status', 'attempts', 'expiresAt', 'createdAt', 'updatedAt'],
};

const taskViewSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    result: {
      type: 'object',
      properties: {
        task: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string' },
            responsibleId: { type: 'string', format: 'uuid' },
            deadline: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
          },
          required: ['id', 'title', 'description', 'responsibleId', 'deadline', 'status'],
        },
      },
      required: ['task'],
    },
  },
  required: ['result'],
};

const dealListResponseSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: { result: { type: 'array', items: { type: 'object' } } },
  required: ['result'],
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Enterprise AI Operations Copilot API',
    version: '0.1.0',
    description: 'Fastify REST API for the ops-copilot CRM/analytics/RAG assistant. '
      + 'All authenticated routes require a Bearer access token from POST /auth/login or /auth/refresh. '
      + 'The five agent tools (CRM search, SQL analytics, task drafting, knowledge search, audit activity) are '
      + 'reachable through POST /chat (natural language) or POST /mcp (structured MCP tool calls, see docs/mcp.md) '
      + 'rather than as separate REST endpoints — this document covers the HTTP surface, not those internal tool contracts.',
  },
  servers: [{ url: 'http://127.0.0.1:3000', description: 'Local development' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      TokenResponse: tokenResponseSchema,
      PendingAction: pendingActionSchema,
    },
  },
  tags: [
    { name: 'Health', description: 'Liveness/readiness probes, unauthenticated.' },
    { name: 'Auth', description: 'Login, refresh-token rotation, logout.' },
    { name: 'Chat', description: 'The single AI agent endpoint.' },
    { name: 'Approvals', description: 'Human-in-the-loop task-proposal workflow.' },
    { name: 'Mock Bitrix', description: 'Minimal Bitrix24-compatible REST subset backed by the same CRM tables.' },
    { name: 'Audit', description: 'Tenant audit log reads.' },
    { name: 'Observability', description: 'Metrics scraping endpoint.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'], summary: 'Basic liveness check', operationId: 'getHealth',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } } } } } },
      },
    },
    '/health/live': {
      get: {
        tags: ['Health'], summary: 'Process liveness, no dependency checks', operationId: 'getHealthLive',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } } } } } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'], summary: 'Readiness: DB reachable, migrations applied, LLM provider configured', operationId: 'getHealthReady',
        responses: {
          '200': { description: 'Ready', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] }, checks: { type: 'object', properties: { database: { type: 'boolean' }, migrations: { type: 'boolean' }, llmProvider: { type: 'boolean' } } } } } } } },
          '503': { description: 'Not ready', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['error'] }, checks: { type: 'object' } } } } } },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Observability'], summary: 'Prometheus-format text metrics (unauthenticated, like /health)', operationId: 'getMetrics',
        responses: { '200': { description: 'OK', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Exchange tenant-scoped credentials for an access/refresh token pair', operationId: 'login',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { tenantId: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, password: { type: 'string' } }, required: ['tenantId', 'email', 'password'] } } },
        },
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } } } },
          '400': errorResponse,
          '401': { description: 'Invalid credentials', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string', example: 'Invalid credentials' } } } } } },
          '429': { description: 'Too many login attempts (5/min per IP)', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string', example: 'Too many requests' } } } } } },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'], summary: 'Rotate a refresh token; reuse of a consumed token revokes its whole family', operationId: 'refresh',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { tenantId: { type: 'string', format: 'uuid' }, refreshToken: { type: 'string' } }, required: ['tenantId', 'refreshToken'] } } },
        },
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } } } },
          '400': errorResponse,
          '401': { description: 'Invalid, expired, or reused token', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string', example: 'Invalid token' } } } } } },
          '429': { description: 'Too many refresh attempts (5/min per IP)' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'], summary: 'Revoke a refresh token family (idempotent)', operationId: 'logout',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { tenantId: { type: 'string', format: 'uuid' }, refreshToken: { type: 'string' } }, required: ['tenantId', 'refreshToken'] } } },
        },
        responses: { '204': { description: 'No content' }, '400': errorResponse },
      },
    },
    '/chat': {
      post: {
        tags: ['Chat'], summary: 'Ask the AI agent a question in Armenian or English', operationId: 'chat', security: bearerAuth,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', maxLength: 8000 }, allowTaskDraft: { type: 'boolean', default: false } }, required: ['message'] } } },
        },
        responses: {
          '200': {
            description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
              answer: { type: 'string' },
              toolCalls: { type: 'array', items: { type: 'object', properties: { toolCallId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['succeeded', 'failed'] } } } },
              pendingActionIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
            }, required: ['answer', 'toolCalls', 'pendingActionIds'] } } },
          },
          '400': errorResponse, '401': errorResponse,
          '429': { description: 'Too many chat requests for this user' },
          '503': { description: 'LLM provider failure or misconfiguration' },
          '504': { description: 'Agent deadline (300s) or provider timeout exceeded' },
        },
      },
    },
    '/approvals': {
      get: {
        tags: ['Approvals'], summary: 'List task proposals visible to the caller', operationId: 'listApprovals', security: bearerAuth,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PendingAction' } } } } }, '401': errorResponse, '403': errorResponse },
      },
    },
    '/approvals/{id}/approve': {
      post: {
        tags: ['Approvals'], summary: 'Approve a pending proposal; executes synchronously if not already claimed', operationId: 'approveProposal', security: bearerAuth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Current proposal state (status may be executed/failed/executing)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PendingAction' } } } },
          '401': errorResponse, '403': { description: 'Not the requester, department manager, or tenant admin' },
          '404': { description: 'Unknown or other-tenant proposal' }, '409': { description: 'Invalid state transition' }, '410': { description: 'Proposal expired' },
        },
      },
    },
    '/approvals/{id}/reject': {
      post: {
        tags: ['Approvals'], summary: 'Reject a pending proposal (idempotent)', operationId: 'rejectProposal', security: bearerAuth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Current proposal state', content: { 'application/json': { schema: { $ref: '#/components/schemas/PendingAction' } } } },
          '401': errorResponse, '403': errorResponse, '404': errorResponse, '409': errorResponse, '410': errorResponse,
        },
      },
    },
    '/audit-logs': {
      get: {
        tags: ['Audit'], summary: "List the current tenant's audit records (admin-only scope)", operationId: 'listAuditLogs', security: bearerAuth,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, tenantId: { type: 'string', format: 'uuid' }, actorUserId: { type: 'string', format: 'uuid', nullable: true }, action: { type: 'string' }, entityType: { type: 'string' }, entityId: { type: 'string', nullable: true }, requestId: { type: 'string', nullable: true }, details: { type: 'object' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } } } } } },
          '401': errorResponse, '403': { description: 'Missing audit_logs:read or not tenant-wide scope' },
        },
      },
    },
    '/rest/crm.deal.list': {
      post: {
        tags: ['Mock Bitrix'], summary: 'List deals visible to the caller (tenant/department/assigned scope)', operationId: 'crmDealList', security: bearerAuth,
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, start: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } } } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: dealListResponseSchema } } }, '401': errorResponse, '403': errorResponse },
      },
    },
    '/rest/crm.contact.list': {
      post: {
        tags: ['Mock Bitrix'], summary: 'List contacts visible to the caller', operationId: 'crmContactList', security: bearerAuth,
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, start: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } } } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: dealListResponseSchema } } }, '401': errorResponse, '403': errorResponse },
      },
    },
    '/rest/tasks.task.get': {
      post: {
        tags: ['Mock Bitrix'], summary: "Fetch a single task within the caller's scope", operationId: 'tasksTaskGet', security: bearerAuth,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { taskId: { type: 'string', format: 'uuid' } }, required: ['taskId'] } } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: taskViewSchema } } }, '401': errorResponse, '403': errorResponse, '404': errorResponse },
      },
    },
    '/rest/tasks.task.add': {
      post: {
        tags: ['Mock Bitrix'], summary: 'Create a task from an approved/executing proposal (idempotent on the proposal UUID)', operationId: 'tasksTaskAdd', security: bearerAuth,
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, description: 'The approved/executing proposal UUID.', schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { fields: { type: 'object', properties: { TITLE: { type: 'string' }, DESCRIPTION: { type: 'string' }, RESPONSIBLE_ID: { type: 'string', format: 'uuid' }, DEADLINE: { type: 'string', format: 'date-time' } }, required: ['TITLE', 'DESCRIPTION', 'RESPONSIBLE_ID', 'DEADLINE'] } }, required: ['fields'] } } },
        },
        responses: {
          '200': { description: 'OK (existing-key repeats return the existing task without re-inserting)', content: { 'application/json': { schema: taskViewSchema } } },
          '401': errorResponse, '403': { description: 'Not an eligible approver, or proposal not executing/executed' }, '400': errorResponse,
        },
      },
    },
  },
};
