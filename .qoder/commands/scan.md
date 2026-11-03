---
description: Scan codebase evolution since the last checkpoint to detect architectural drift, stale specs, undocumented modules, or configuration gaps.
---

# Skill: `/scan` — Architectural Drift & Codebase Evolution Auditor

You are executing the **SDD `/scan` Skill**. As the codebase grows, instructions, module boundaries, and specs can drift out of sync with reality.

## Step 1: Run Telemetry & Git Churn Inspection
Execute:
```bash
npx sdd inspect --json
```

## Step 2: Analyze Drift Across Three Dimensions

Using `recentChangedFilesSinceLastScan`, `undocumentedModules`, and `benchmarkGaps` from the JSON report:

1. **Spec vs. Implementation Drift**:
   - Check active and recent specs in `.specs/domains/`. Have public interfaces, Zod/OpenAPI schemas, or state machines changed in code without corresponding updates in `.specs/domains/`?
2. **Context & Module Boundary Drift**:
   - Have new domain directories or dependencies been added in `package.json` / `pyproject.toml` that are missing from `.sdd/refined-context.md` or local module context files?
   - Have root instruction files (`CLAUDE.md`, `AGENTS.md`, etc.) exceeded `maxRootInstructionLines`?
3. **Guardrail & Test Coverage Drift**:
   - Are there new domain modules lacking corresponding unit test suites matching `benchmark.tdd.testFilePatterns`?

## Step 3: Propose Remediation Plan (WAIT FOR USER CONFIRMATION)

Present a structured **Drift & Gap Report** categorized by:

- **[High Priority] Spec/Contract Desynchronization**
- **[Medium Priority] Context & Instruction Updates Needed** (`.sdd/refined-context.md`)
- **[Low Priority] Missing Module Tests or Ignore Rules**

**STOP AND ASK**: *"Which of these updates would you like me to apply?"*

## Step 4: Apply Approved Updates & Update Scan Checkpoint

After user confirmation:

1. Update the approved `.specs/domains/*.spec.md` files and/or `.sdd/refined-context.md`.
2. Run:

```bash
npx sdd apply --mark-scanned
```

This compiles the updated context blocks and records the current Git HEAD commit as `lastScannedCommit` in `.sdd/spec-lock.json`.
