---
description: Decompose an approved Spec into atomic, verifiable TDD implementation tasks.
---

# Skill: `/spec-plan` — Atomic Task Decomposition

1. Read the target `.specs/changes/<feature-slug>.spec.md`.
2. Verify all referenced read-only interfaces exist in the codebase.
3. Generate `.specs/changes/<feature-slug>.tasks.md` breaking the work into ordered, atomic tasks. Each task must specify:
   - Target `Test File` and `Implementation File`
   - Specific test assertions to write in the Red phase
   - Specific functions/classes to implement in the Green phase
   - Verification command for that single task
