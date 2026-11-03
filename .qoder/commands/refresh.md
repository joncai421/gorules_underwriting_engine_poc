---
description: Detect user modifications in sdd.config.yaml, preview impact across target agents and hooks, and synchronize configurations upon confirmation.
---

# Skill: `/refresh` — Configuration Sync & Custom Rule Compiler

You are executing the **SDD `/refresh` Skill**. Use this whenever `sdd.config.yaml` has been modified by the user or when custom engineering rules need to be synchronized across configured agents.

## Step 1: Compute Configuration Delta
Run the deterministic diff command:
```bash
npx sdd diff --json
```

## Step 2: Validate & Present Impact Plan (WAIT FOR USER CONFIRMATION)

1. If `npx sdd diff` reports schema validation errors in `sdd.config.yaml`, explain the exact field error and offer to fix the YAML syntax.
2. Review any new or modified entries in `customRules`, `benchmark`, or `agents`:
   - If a user added a natural-language `customRule` that can be deterministically enforced via regex (e.g., forbidding a specific import or API), suggest adding `enforcement: regex-hook` and `forbiddenRegex` to strengthen it from a soft instruction into a hard hook.
3. Present a concise summary table of:
   - **Config Changes Detected** (`customRules`, `benchmark` toggles, `agents` targets)
   - **Target Files to be Updated** (noting that `refined` blocks from `/refine` will be preserved via 3-way merge)

**STOP AND ASK**: *"Confirm executing `npx sdd apply` to synchronize these changes across all target agent files and hooks?"*

## Step 3: Execute Deterministic Compilation

Upon user confirmation, run:

```bash
npx sdd apply
npx sdd doctor
```

Report the synchronized files and exit cleanly.
