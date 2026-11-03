---
description: Draft or update a structured feature specification in .specs/changes/ with strict scope boundaries, schemas, and invariants.
---

# Skill: `/spec-propose` — Specification Authoring

1. Switch SDD phase to `spec` by running: `npx sdd phase spec`
2. Interview the user to clarify any ambiguous business rules, edge cases, or non-goals before writing any spec.
3. Read `.specs/constitution.md` and generate `.specs/changes/<feature-slug>.spec.md` containing all 5 required Benchmark 1.2 sections:
   - `## 1. Scope & Boundaries` (`Read/Write`, `Read-Only`, and `Forbidden` file globs)
   - `## 2. Type & Schema Contracts` (Exact TypeScript interfaces, Zod schemas, or OpenAPI definitions)
   - `## 3. Invariants & Edge Cases` (State machine rules, idempotency, concurrency, error codes)
   - `## 4. Non-Goals & Constraints` (What must NOT be changed or introduced)
   - `## 5. Deterministic Verification` (Exact test and typecheck commands)
4. Ask the user to review and approve the spec before moving to `/spec-plan`.
