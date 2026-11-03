---
description: Execute an approved Spec and Task plan using the Red-Green-Lock TDD loop with circuit-breaker rollback.
---

# Skill: `/spec-exec` — Controlled Red-Green-Lock Execution

For each pending task in `.specs/changes/<feature-slug>.tasks.md`:

1. **PHASE 1: RED (Write Contract & Failing Tests)**
   - Run: `npx sdd phase test-red --spec .specs/changes/<feature-slug>.spec.md`
   - Create or update the schema/interface files and unit test files specified in the task.
   - Run the single-file test command from `sdd.config.yaml` and confirm the test FAILS for the expected reason (missing implementation).

2. **PHASE 2: LOCK & GREEN (Implement Under Judge Lock)**
   - Run: `npx sdd phase impl-green --spec .specs/changes/<feature-slug>.spec.md`
   - Note: Test and schema files are now physically LOCKED by `.sdd/hooks/pre-tool-guard.mjs`. Do NOT attempt to modify tests or weaken assertions.
   - Write the minimal production code in the allowed `Read/Write` paths to make the tests pass.

3. **PHASE 3: DETERMINISTIC VERIFICATION & CIRCUIT BREAKER**
   - Run `typecheck` and `testUnit` commands from `sdd.config.yaml`.
   - If verification fails, analyze the error and retry up to `maxTaskRetries` (default: 3) times.
   - If still failing after 3 attempts, STOP immediately, run `git checkout -- <impl-files>`, and ask the user for clarification.
   - Once green, mark the task `[x]` in `.tasks.md` and proceed to the next task.
