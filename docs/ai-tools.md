# AI tools used

This repository was built with AI coding assistance throughout. Disclosed per the assignment's requirement to document which AI tools were used and in what role.

| Tool | Role | Scope |
| --- | --- | --- |
| **OpenAI Codex** | Code generation / pair-programming | Early implementation phase: project scaffolding through the initial RAG (knowledge-base ingestion/retrieval) work. |
| **Anthropic Claude Code** | Code generation / pair-programming | From the RAG stage onward: SQL guard, approvals workflow, mock Bitrix integration, observability (OpenTelemetry/metrics), MCP server, Vertex/Ollama provider wiring, Docker/production-readiness work, and this documentation pass. |
| **ChatGPT / GPT** | Planning and research only | Spec clarification, design-option research, and background reading throughout the project. Not used to generate committed code directly. |

## How the AI tools were used

Both coding assistants (Codex, then Claude Code) worked in an interactive, decision-by-decision mode rather than generating large unreviewed blocks: each non-trivial design choice (schema shape, RBAC model, SQL validation strategy, retry/idempotency behavior, provider selection, etc.) was proposed, discussed, and explicitly approved by the developer before being implemented, then recorded in [decisions.md](decisions.md). That file is itself a byproduct of this workflow — it is the running log the sessions kept of what was decided and why, not written after the fact.

Verification (tests, lint, typecheck, and the live evaluation runs in [eval-results.md](eval-results.md)) was run and reviewed by the developer at each step; passing checks were a condition for proceeding, not something assumed from the assistant's own report.

## What this means for review

- Architectural decisions, scope boundaries (see [MVP_SCOPE.md](../MVP_SCOPE.md)), and acceptance of each implementation were made by the developer; the assistants proposed and implemented, they did not decide unsupervised.
- Code style, security posture (RLS, AST-validated SQL, approval workflow, redaction), and documentation conventions are consistent across both tool-assisted phases because each followed the same recorded decision log rather than two independent styles.
- No AI tool had access to real customer data, production credentials, or external systems; all data in this repository is synthetic (see [seed-scenarios.md](seed-scenarios.md)).
