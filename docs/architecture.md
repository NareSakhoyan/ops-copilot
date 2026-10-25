# Architecture

This is a modular monolith: one Fastify process, one PostgreSQL database, no separate services or queues. See [decisions.md](decisions.md) for why (explicitly scoped out in [MVP_SCOPE.md](../MVP_SCOPE.md)).

## System overview

```mermaid
flowchart TB
    client["Client\n(curl / MCP client)"]

    subgraph app["Fastify app (src/app.ts)"]
        direction TB
        authHook["Bearer auth preHandler\n(src/auth/routes.ts)\nreloads roles/permissions per request"]

        subgraph routes["Routes"]
            direction LR
            chatRoute["POST /chat\n(src/agent/routes.ts)"]
            mcpRoute["POST /mcp\n(src/mcp/routes.ts)"]
            approvalsRoute["/approvals*\n(src/approvals/routes.ts)"]
            restRoute["/rest/* mock Bitrix\n(src/mock-bitrix/routes.ts)"]
            auditRoute["GET /audit-logs"]
            docsRoute["GET /docs, /docs/json\n(Swagger UI, static)"]
        end

        subgraph agentCore["Agent core (shared by /chat and /mcp)"]
            direction TB
            toolRouter["5 tools: crm_search, sql_analytics,\ntask_draft, kb_search, audit_activity\n(src/agent/tools.ts)"]
        end
    end

    subgraph guards["Deterministic guards (not LLM-controlled)"]
        direction TB
        rbac["RBAC + row scope\n(src/auth/rbac.ts)"]
        sqlGuard["AST SQL validator\n+ analytics_ro role, 5s timeout, 200-row cap\n(src/sql-guard/)"]
        kbAcl["KB tenant + role ACL\n(src/rag/search.ts)"]
        approvalFsm["pending->approved->executing->executed\natomic claim, 3 retries\n(src/approvals/)"]
    end

    llm["LLM provider\n(Ollama / Google / Vertex / Gateway)\nswappable via LLM_PROVIDER"]

    subgraph pg["PostgreSQL (RLS-enforced)"]
        direction TB
        crmTables["CRM tables\ncompanies, contacts, leads, deals,\nactivities, tasks, employees, products, orders"]
        kbTables["documents, chunks\n(pgvector)"]
        auditTable["audit_logs"]
        analyticsViews["v_deals, v_tasks,\nv_contacts_activity, v_employee_performance\n(redacted invoker views)"]
    end

    otel["OpenTelemetry\nrequest/agent/tool/LLM-call/SQL-guard spans\n-> Jaeger (OTLP)"]

    client -->|"Authorization: Bearer JWT"| authHook
    authHook --> routes
    chatRoute --> agentCore
    mcpRoute --> agentCore
    toolRouter --> rbac
    toolRouter -->|"question / SQL draft"| llm
    toolRouter --> sqlGuard
    toolRouter --> kbAcl
    sqlGuard --> analyticsViews
    kbAcl --> kbTables
    rbac --> crmTables
    approvalsRoute --> approvalFsm
    approvalFsm --> crmTables
    restRoute --> crmTables
    auditRoute --> auditTable
    approvalFsm -.->|audit event, same tx| auditTable
    rbac -.->|audit event| auditTable
    app -.->|spans| otel
```

## Request flow for a typical chat query

```mermaid
sequenceDiagram
    participant U as Client
    participant A as Fastify /chat
    participant G as Agent (generateText, stopWhen 6 steps)
    participant T as Tool (e.g. sql_analytics)
    participant V as SQL AST guard
    participant DB as PostgreSQL (analytics_ro, RLS)
    participant L as LLM provider

    U->>A: POST /chat {message, allowTaskDraft}
    A->>A: verify JWT, reload roles/permissions/scope
    A->>G: run agent with fresh RequestContext-bound tools
    G->>L: plan next step
    L-->>G: tool call: sql_analytics(question)
    G->>T: execute(question)
    T->>L: generate SQL from allowed view columns only
    L-->>T: candidate SQL
    T->>V: validate AST (read-only, allow-listed relations/functions)
    V->>DB: SET LOCAL ROLE analytics_ro; run with 5s timeout, LIMIT 200
    DB-->>V: rows
    V-->>T: rows + accepted SQL
    T-->>G: bounded result (<=8000 UTF-8 bytes, marked untrusted)
    G->>L: continue with tool result
    L-->>G: final answer
    G-->>A: answer, toolCalls summary, pendingActionIds
    A-->>U: 200 JSON
```

## Human-in-the-loop task approval

```mermaid
stateDiagram-v2
    [*] --> pending: task_draft tool (allowTaskDraft:true only)
    pending --> approved: POST /approvals/:id/approve
    approved --> executing: guarded UPDATE claims the row (prevents double execution)
    executing --> executed: mock Bitrix tasks.task.add
    executing --> failed: 3 attempts exhausted
    pending --> rejected: POST /approvals/:id/reject
    pending --> expired: 24h elapsed
    approved --> expired: 24h elapsed
```

Every arrow above that changes state also writes an `audit_logs` row in the same transaction — see [decisions.md](decisions.md#approval-execution-and-idempotency).

## Entity relationships (core CRM tables)

Full column-level detail, constraints, and the knowledge-base/security/identity tables are in [database.md](database.md). This covers only the primary CRM relationships referenced above.

```mermaid
erDiagram
    TENANTS ||--o{ USERS : scopes
    TENANTS ||--o{ COMPANIES : scopes
    USERS ||--o| EMPLOYEES : "optional login"
    EMPLOYEES }o--o| DEPARTMENTS : "belongs to"
    COMPANIES ||--o{ CONTACTS : has
    COMPANIES ||--o{ LEADS : has
    COMPANIES ||--o{ DEALS : has
    CONTACTS ||--o{ DEALS : "linked to"
    LEADS ||--o{ DEALS : "converts to"
    EMPLOYEES ||--o{ DEALS : "responsible for"
    CONTACTS ||--o{ ACTIVITIES : has
    DEALS ||--o{ ACTIVITIES : has
    DEALS ||--o{ ORDERS : produces
    ORDERS ||--o{ ORDER_ITEMS : contains
    PRODUCTS ||--o{ ORDER_ITEMS : "sold as"
    EMPLOYEES ||--o{ TASKS : assigned
    USERS ||--o{ PENDING_ACTIONS : requests
    TENANTS ||--o{ DOCUMENTS : scopes
    DOCUMENTS ||--o{ CHUNKS : "chunked into"
```

Every table here except `TENANTS` carries a `tenant_id` enforced by PostgreSQL row-level security (`drizzle/0001_tenant_rls.sql`), not just an application-level filter — see [decisions.md](decisions.md#tenant-row-level-security).

## Why this shape

- **One agent, five tools, no multi-agent orchestration** — [MVP_SCOPE.md](../MVP_SCOPE.md) explicitly scopes out multi-agent architecture for the core deliverable (see the assignment's bonus section for the optional Planner/Executor/Validator variant, not implemented here).
- **SQL guard and KB ACL sit outside the LLM's control** — the model drafts SQL/questions, but a deterministic AST validator and tenant/role-scoped SQL predicates decide what actually runs or returns, so a prompt-injected or hallucinated request cannot widen access on its own.
- **`/chat` and `/mcp` share one tool implementation** (`src/agent/tools.ts` factories), not two parallel code paths — see [mcp.md](mcp.md) and [decisions.md](decisions.md#mcp-server).
