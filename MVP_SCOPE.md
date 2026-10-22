# Enterprise AI Operations Copilot — MVP Scope

## Goal
Build a functional, secure AI assistant for CRM analytics, knowledge retrieval, and human-approved task execution.

**Priorities:** Correctness > Security > Simplicity > Extensibility.

## 1. Core Requirements

### Database
- PostgreSQL with required CRM entities and relationships.
- At least 5,000 realistic synthetic records across 2 tenants.
- JWT authentication, RBAC, and enforced tenant isolation.
- Appropriate constraints, indexes, and migrations.

### AI Agent
- Single agent with tool calling.
- Five tools: CRM Search, SQL Analytics, Task Management, Knowledge Search, Audit/Activity.
- Support Armenian and English queries.
- Return grounded, understandable responses.

### Text-to-SQL
- Read-only queries against approved database schema.
- Deterministic SQL validation and tenant isolation.
- Query timeouts, result limits, and execution logging.
- Reject SQL injection, prompt injection, and unauthorized access.

### RAG
- Ingest a small set of synthetic company documents.
- Chunking, embeddings, and vector retrieval using pgvector.
- Enforce tenant and document-level permissions.
- Source citations and refusal when evidence is insufficient.

### Task Approval
- Generate task proposals without immediate execution.
- Explicit approval before execution.
- Validate permissions before execution.
- Prevent duplicate execution and handle failures.
- Record actions in audit logs.

### API
- Fastify REST API with authentication.
- Chat, knowledge search, approvals, execution, and audit endpoints.
- Mock Bitrix24-compatible operations where needed.
- Swagger documentation.

### Observability & Evaluation
- Request IDs, structured logs, tool traces, errors, latency, and token/cost tracking.
- At least 10 evaluation scenarios, including 4 security tests.
- Automated unit/integration tests for critical workflows.

## 2. Deliverables
- Working GitHub repository.
- README with setup and demonstration instructions.
- Architecture and database diagrams.
- Synthetic data generator.
- API documentation.
- Automated tests and evaluation results.
- At least 5 example queries with outputs.
- Documented security limitations and implementation trade-offs.
- Disclosure of AI tools used.

## 3. Explicitly Out of Scope
- Microservices or distributed architecture.
- Multi-agent orchestration.
- MCP integration.
- Messenger integrations.
- Complex frontend/dashboard.
- Real Bitrix24 integration.
- Advanced analytics dashboards.
- Generic workflow engines.
- Production-scale infrastructure.
- Unnecessary abstractions and speculative features.

## 4. Engineering Constraints
- Prefer a modular monolith and existing dependencies.
- Use one AI agent with narrowly scoped tools.
- Prefer deterministic logic for validation, authorization, and execution.
- Avoid unnecessary layers, dependencies, and configuration.
- Keep implementations simple, testable, and maintainable.
- Make small, focused changes without unrelated refactoring.
- Do not implement bonus features until mandatory requirements work.

## 5. Definition of Done
The MVP is complete when:

1. All mandatory requirements are implemented.
2. Five representative user queries work end-to-end.
3. Cross-tenant and unauthorized access attempts are rejected.
4. Task execution requires approval and is idempotent.
5. RAG provides authorized, cited answers.
6. At least 10 evaluation scenarios are documented and executed.
7. Relevant automated tests pass.
8. The application runs from documented setup instructions.
9. Known limitations are explicitly documented.

**Rule:** Implement the simplest solution that demonstrably satisfies each mandatory requirement. Do not expand scope without clear justification.