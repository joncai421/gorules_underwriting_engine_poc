# SDD Constitution

> The supreme, non-negotiable engineering authority for this repository. Every specification in `.specs/` and every agent instruction compiled by `sdd-cli` must comply with it.

## Article I — Spec-Driven Source of Truth (SSoT)
No implementation code is written without an approved specification capturing scope, contracts, and verification. The spec is the single source of truth.

## Article II — Deterministic Verification
Correctness is proven by executable evidence: typecheck and the full unit test suite must exit 0 before any task is marked complete. Reported green status is never trusted without execution.

## Article III — Anti-Reward-Hacking TDD
Tests and schemas act as the judge and are read-only during implementation. Assertions must verify real business invariants; weakening, skipping, or deleting tests to pass is forbidden.

## Article IV — Context Discipline & Noise Suppression
Root instruction files stay lean; module-level context lives in hierarchical documentation. Cross-module imports target public interfaces only.

## Article V — Anti-Hallucination Guardrails
Type escapes (`any`, `@ts-ignore`, `# type: ignore`), silent empty `catch` blocks, and hardcoded secrets are blocked by deterministic guardrail hooks.

## Article VI — Orchestrated Sub-Agent Isolation
Sub-agents communicate via file state, retry within bounded limits, and roll back on circuit-break.

## Mandated Specification Sections
Every spec must contain the following sections:
- Scope & Boundaries
- Type & Schema Contracts
- Invariants & Edge Cases
- Non-Goals & Constraints
- Deterministic Verification
