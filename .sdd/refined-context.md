<!-- Populated by the /refine skill; compiled verbatim into the `refined` managed block by `sdd apply`. -->
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
