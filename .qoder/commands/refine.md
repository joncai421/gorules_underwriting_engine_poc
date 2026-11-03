---
description: Inspect existing codebase and agent configurations, audit gaps against the SDD Benchmark, and refine tech-stack bindings after user confirmation.
---

# Skill: `/refine` — Codebase Inspection & Benchmark Gap Remediation

You are executing the **SDD `/refine` Governance Skill**. Your goal is to audit the current repository and agent setup against the SDD Benchmark standard, detect the project's technical stack, present a clear remediation plan, and apply it **only after explicit user confirmation**.

## Step 1: Run Deterministic Static Inspection (Mandatory First Action)
Do NOT blindly read random source files. First, execute the CLI inspector:
```bash
npx sdd inspect --json
```

## Step 2: Targeted Codebase Sampling

Based on the JSON output from `npx sdd inspect --json`:

1. Inspect `detectedStack` and `candidateScripts` (e.g., `package.json`, `pyproject.toml`, `tsconfig.json`).
2. Read at most **3 to 5 representative files** (e.g., 1 domain service, 1 schema/interface file, 1 existing unit test) to understand architectural conventions, naming patterns, ORM/database patterns, and error-handling idioms.
3. Inspect `existingAgentSetups` and `benchmarkGaps` to identify problems in existing agent instructions (e.g., bloated root files >120 lines, conflicting rules, missing TDD or anti-hallucination hooks).

## Step 3: Present the Gap & Refinement Proposal (WAIT FOR USER CONFIRMATION)

Present a structured Markdown report to the user containing:

1. **Detected Tech Stack & High-SNR Verification Commands**:
   - Language & Framework
   - Proposed `typecheck`, `testUnit` (silent/dot reporter), `testSingleFile`, and `lint` commands.
2. **Existing Agent Setup Issues**:
   - Highlight any issues found in existing `CLAUDE.md`, `.github/copilot-instructions.md`, etc. (e.g., unmanaged rules that should be migrated into `customRules`, or excessive token noise).
3. **Benchmark Gap Table**:

| Benchmark ID | Category | Current State | Target Remediation |
| --- | --- | --- | --- |

4. **Proposed Domain Module Boundaries**:
   - List detected domain modules and their architectural layer rules.

**STOP AND ASK**: *"Do you approve applying this refinement plan to `sdd.config.yaml` and compiling the updated agent configurations?"*
Wait for the user's explicit confirmation (or adjustments) before proceeding to Step 4.

## Step 4: Apply Refinements Deterministically

Once the user confirms:

1. Update `sdd.config.yaml` (`techStack` section and any migrated `customRules`).
2. Write the concise, high-signal project architecture summary (<60 lines) to `.sdd/refined-context.md` (covering module boundaries, error handling conventions, and test patterns).
3. Execute the deterministic compiler:
```bash
npx sdd apply --stage refined
npx sdd doctor
```
4. Report the updated files and confirm that Guardrail Hooks have transitioned from `scaffolded` (Probe Mode) to `refined` (Strict Mode).
