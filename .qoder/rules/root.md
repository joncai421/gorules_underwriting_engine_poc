<!-- @sdd:managed-file:do-not-remove-markers -->

# SDD Governance — qoder

This file is compiled by `sdd-cli` from `sdd.config.yaml` via the 3-way block merger. Agent-specific overrides in unmanaged sections are preserved.

<!-- @sdd:block:benchmark:start -->
- **SSoT**: Never write implementation code without an active spec in `.specs/changes/`.
- **Constitution**: `.specs/constitution.md` is the supreme engineering authority; all specs must declare compliance with it.
- **Spec Sections**: Every spec must contain the following sections: `Scope & Boundaries`, `Type & Schema Contracts`, `Invariants & Edge Cases`, `Non-Goals & Constraints`, `Deterministic Verification`.
- **TDD Judge Lock**: Test files (`**/*.spec.ts`, `**/*.test.ts`, `**/test_*.py`) and schema files (`**/*.schema.ts`, `**/*.interface.ts`, `**/openapi.yaml`) are READ-ONLY during the `impl-green` phase.
- **No Reward Hacking**: Never weaken, skip, or delete existing tests to make them pass. Assertions must verify real business invariants; `toBeDefined()` / `toBeTruthy()` alone are insufficient.
- **Type Escapes Forbidden**: `any`, `@ts-ignore`, `@ts-expect-error`, and `# type: ignore` are blocked by the guardrail hooks in strict mode.
- **Empty Catch Forbidden**: Empty `catch {}` blocks are rejected; handle errors explicitly or rethrow.
- **No Hardcoded Secrets**: Credentials, tokens, and keys must never appear in tracked source files.
- **Scope Discipline**: Only modify files inside the active spec's `Read/Write` scope; verify with `git status -s` before every commit.
- **Sub-Agent Isolation**: Sub-agents communicate via file state (`.sdd/state/handoff.json`, protocol `file-state`); stop after `maxTaskRetries = 3` failed attempts and roll back (`git checkout -- <impl-files>`).
- **Deterministic Verification**: `typecheck` and the full unit test suite must exit 0 before marking any task complete.
- **Context Hygiene**: Keep root instruction files lean (<= 120 lines); module-level context belongs in `.specs/domains/<module>/` documentation.
- **Interface-Only Imports**: Cross-module imports must target public interfaces or barrel files, never internal implementations.
- **Bootstrap Stage**: `refined`.
- **Guardrail Mechanism**: Native PreToolUse/PostToolUse hooks with Git `pre-commit` fallback.
<!-- @sdd:block:benchmark:end -->

<!-- @sdd:block:refined:start -->
- **Stack**: TypeScript 5.7 npm-workspaces monorepo — `gorules-ts-engine` (Fastify 5 + `@gorules/zen-engine` 2 + `pg` + `zod`, CJS via `tsx`) and `gorules-admin-ui` (React 18 + Vite 5 + `@gorules/jdm-editor`, ESM). PostgreSQL via docker-compose.
- **`legacy-java-service` is a frozen parity oracle** (Spring Boot). Never extend it; verify equivalence with `npm run verify-parity` only while that service runs on :8080.
- **Verification**: `typecheck` = `npx tsc --noEmit -p gorules-ts-engine/tsconfig.json && npx tsc --noEmit -p gorules-admin-ui/tsconfig.json`; `testUnit` = `npm run selftest --silent` (DB-free, reads `shared/rules/*.json`). Both verified exit 0. No linter is installed — `tsc --strict` plus guardrail hooks are the static gate.

- **Module boundaries — `gorules-ts-engine/src`**:
  - `types.ts` — contract SSoT (`UnderwritingEnvelope`, 6 `FinalDecision`, 8 `RiskClass`). The only sanctioned cross-module import surface.
  - `engine/` — data plane. `uwEngine` = file-based v1/v2 four-stage parity baseline; `uwPipelineEngine` = DB-backed two-tier LIVE orchestrator (FUNDAMENTAL short-circuit → PER-PRODUCT) with a Zen decision cache keyed `ruleKey@version`; `invalidate(ruleKey)` forces recompile after an approval publishes. May import `db/` + `types`; must not import `server`/`auth`.
  - `db/` — persistence only (`pool`, `ruleRepository`, `auditRepository`, `decisionRepository`). Must never import `engine/`.
  - `auth/` — JWT + RBAC maker-checker middleware; consumed by the composition root only.
  - `ai/` — `uncleanCaseCopilot`: envelope → brief, one-way dependency on `types`.
  - `server.ts` — composition root / HTTP surface; wires auth + engine + db + ai and holds no business logic.
  - `tools/` — offline CLIs (AST→JDM migrator, xlsx generator, parity verifier). Never imported by runtime modules.
- **Other roots**: `shared/` = data SSoT (`rules/*.json`, `seed-rules/`, `test-cases.json`) for engine and UI. `gorules-admin-ui/src` = governance console, `apiTypes.ts` mirrors engine contracts. `db/migrations` is out of agent edit scope.

- **Error handling**: domain failures throw `RuleGovernanceError(message, status)` (defined in `db/ruleRepository.ts`); a single Fastify `setErrorHandler` funnel maps it to `reply.code(err.status).send({ error })`, defaulting to 500. Do not add per-route try/catch or swallow errors — propagate `RuleGovernanceError` from the repository. Request validation happens at the `server.ts` boundary via zod only. Transactions use explicit `BEGIN`/`ROLLBACK` then rethrow.
- **Test pattern**: no jest/vitest. Suite = `tsx` harness `src/tests/engineSelfTest.ts` driven by data in `shared/test-cases.json`; each case asserts the whole four-stage envelope and is checked against **both** rule versions (`expected` for v1, optional `expectedV2` overrides for v2). Harness exits non-zero on any mismatch. Add coverage by appending cases to the JSON, not by adding assertions in code. PRD v3 `FUND-CASE*` entries have no `expected` envelope (fundamental-gate knockouts, verified over HTTP) and are filtered out by design.
- **Legacy debt (grandfathered)**: 75 pre-existing type escapes and 4 empty catch blocks. The post-edit guard inspects **added lines only**, so existing code is not blocked — but any edit that re-emits `any`/`@ts-ignore` must convert to a concrete type instead of copying the old line.
<!-- @sdd:block:refined:end -->

<!-- @sdd:block:custom:start -->
- No custom rules configured. Add entries under `customRules` in `sdd.config.yaml` and run `/refresh` or `sdd apply`.
<!-- @sdd:block:custom:end -->
