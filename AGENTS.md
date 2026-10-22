# Rules for all future work

- Strict TypeScript, no `any`. Validate all external input with Zod.
- tenant_id, user_id and role NEVER come from LLM output. They come from server-side request context only.
- Never concatenate user or LLM text into SQL. Use parameters.
- Every feature needs tests. Run `npm test` and `npm run lint` before finishing.
- If a requirement is ambiguous or involves an architectural choice not in docs/decisions.md, STOP and ask me instead of guessing.
- Append a short entry to docs/decisions.md for each non-trivial choice.
- After changes, remove dead code, unused imports and dependencies, and obsolete files or configuration. Keep the requested scaffold directories.
