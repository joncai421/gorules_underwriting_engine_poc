# Headless Underwriting Engine PoC (PRD v3 — Two-Tier Pipeline, PostgreSQL, RBAC Maker-Checker & Audit Trail)

A working monorepo Proof of Concept demonstrating the modernization of an insurance
underwriting system from a **legacy hardcoded Spring Boot (Java 17)** service to a
**database-backed, enterprise-grade headless GoRules engine (TypeScript +
`@gorules/zen-engine` + PostgreSQL)**: a two-tier **Fundamental → Per-Product** rule
pipeline, immutable rule versioning with a formal **Maker-Checker approval workflow**,
**RBAC** (JWT), an append-only **governance audit trail**, full **decision persistence**,
Excel rule-table import, shadow-mode parity tooling and a pluggable **AI Copilot**.

> See [`docs/requirement_PRD_v3.md`](docs/requirement_PRD_v3.md) for the full specification
> (`docs/requirement_PRD_v2.md` / `docs/initial_requirements.md` for the earlier baselines).

## Two-tier underwriting pipeline

```text
[Applicant Payload + productCode (TERM_LIFE | CRITICAL_ILLNESS)]
        |
        v
STAGE A: FUNDAMENTAL RULE (rule_key FUNDAMENTAL_ELIGIBILITY, tier=FUNDAMENTAL, LIVE from DB)
   AML/Sanctions watchlist · global age bounds 18-70 · signed PROPOSAL_FORM · residency
        |
   +-- FAILED -> short-circuit: DECLINE (FUNDAMENTAL_KNOCKOUT)
   |             or REQUEST_ADDITIONAL_INFO (INCOMPLETE_FUNDAMENTAL_KYC); product rule SKIPPED
   +-- PASSED
        v
STAGE B: PER-PRODUCT RULE (LIVE product rule for req.productCode, 4-stage JDM graph)
   [0. Formulas] -> [1.1 Sufficient Info Check] -> [2. Risk Assessment (EM debits)]
                 -> [3. Risk Classification] -> [4. Underwriting Decision]
   ACCEPT_AS_PER_APPLICATION | ACCEPT_WITH_LOADING | ACCEPT_WITH_EXCLUSIONS
   | POSTPONE | DECLINE | REQUEST_ADDITIONAL_INFO   (isUncleanReferral -> AI Copilot brief)
        v
[Persist everything to underwriting_decisions (input, versions used, outcomes, trace, AI brief)]
```

## Repository layout

```text
.                                     # committed at repo root
├── docker-compose.yml                # Req 5: PostgreSQL 16 (healthcheck + pgdata volume)
├── package.json                      # db:up / db:migrate / db:seed / dev / verify-parity
├── shared/
│   ├── test-cases.json               # 12 parity baseline cases + 4 FUND-CASE* Fundamental knockouts
│   ├── sample-rules-upload.xlsx      # sample Excel stage-2 decision table for the import demo
│   ├── seed-rules/                   # Req 6: JSON templates loaded into PostgreSQL by db/seed.ts
│   │   ├── fundamental-eligibility.json
│   │   ├── product-term-life.json          # migrated v1 rule (4-stage pipeline)
│   │   └── product-critical-illness.json   # v2 rule (occupation/comorbidity/thyroid riders)
│   └── rules/                        # legacy file-based graphs (used by migrate/selftest tools)
├── legacy-java-service/              # Spring Boot 3.x, :8080 (parity baseline)
├── gorules-ts-engine/                # Headless TS engine :3001
│   ├── db/
│   │   ├── migrations/001_init_schema.sql        # users, rule_definitions, audit logs, decisions
│   │   ├── migrations/002_seed_initial_data.sql  # default RBAC users
│   │   ├── migrate.ts                            # schema_migrations-tracked runner
│   │   └── seed.ts                               # seed-rules/*.json -> rule_definitions v1 LIVE
│   └── src/
│       ├── server.ts                # Fastify: auth, governance, pipeline, decision & audit APIs
│       ├── db/{pool,ruleRepository,auditRepository,decisionRepository}.ts
│       ├── auth/authMiddleware.ts   # JWT verification + requireRole() RBAC guards
│       ├── engine/uwPipelineEngine.ts  # Req 1 orchestrator + compiled ZenEngine LIVE cache
│       ├── engine/uwEngine.ts       # legacy file engine (selftest/migrator tooling only)
│       └── ai/uncleanCaseCopilot.ts
└── gorules-admin-ui/                 # Vite + React + @gorules/jdm-editor, :5173
    └── src/
        ├── App.tsx                  # Auth bar + Quick-Switch + 3 governance tabs
        ├── context/AuthContext.tsx  # JWT state, Bearer injection, role helpers
        └── components/{RuleEditorWorkspace,DecisionHistoryTab,AuditLogTab}.tsx
```

## Prerequisites

- **Node.js 18+** and npm, **Docker Desktop** (PostgreSQL 16 container).
- **Java 17** on `PATH` — only needed for the legacy service / parity check.

## Quickstart

```bash
npm install                     # 1) all workspace deps (repo root)
npm run db:up                   # 2) start PostgreSQL 16 (docker compose, healthchecked)
npm run db:migrate              # 3) apply db/migrations/*.sql (tracked in schema_migrations)
npm run db:seed                 # 4) load shared/seed-rules/*.json as v1 LIVE rules
cd legacy-java-service && ./mvnw spring-boot:run    # 5) legacy baseline :8080 (parity only)
npm run engine                  # 6) two-tier TS engine :3001 (another terminal)
npm run ui                      # 7) Admin UI :5173 (another terminal; proxies /api)
```

`npm run dev` starts engine + UI together. To reset the demo state:
`npm run db:migrate && npm run db:seed` (idempotent; migrations are tracked, seed skips
existing `(rule_key, version)` rows).

## RBAC demo accounts (seeded by `002_seed_initial_data.sql`)

| Username | Password | Role | Permitted actions |
|---|---|---|---|
| `alice_viewer` | `pass123` | `VIEWER` | Read-only JDM canvas, Simulator, Decision History, Audit Logs |
| `bob_author` | `pass123` | `RULE_AUTHOR` | + Edit JDM, Upload Excel, Save DRAFT, Submit for approval (**cannot approve**) |
| `carol_approver` | `pass123` | `RULE_APPROVER` | + Approve / Reject `PENDING_APPROVAL` (**cannot edit rules**) |
| `dave_admin` | `pass123` | `ADMIN` | Full access, incl. overriding the maker-checker self-approval guard |

The Admin UI's **Quick-Switch** dropdown logs in as any of the four in one click.
`POST /api/underwrite` itself is the token-free headless data plane (external callers);
all governance read/mutation endpoints require a `Authorization: Bearer <JWT>` token.

## Rule lifecycle / Maker-Checker workflow (Req 2 & 3)

```text
[Clone from LIVE] -> DRAFT --submit--> PENDING_APPROVAL --approve--> LIVE --superseded--> ARCHIVED
                       ^                       |                        (self-approval blocked
                       +------edit-------------+--reject--> REJECTED     for non-ADMIN)
```

Every transition appends an immutable row to `rule_audit_logs`
(`CREATED_DRAFT`, `UPDATED_DRAFT`, `SUBMITTED_FOR_APPROVAL`, `APPROVED_TO_LIVE`, `REJECTED`,
`ARCHIVED`, `EXCEL_IMPORTED`). Approval runs in a single PostgreSQL transaction (demote old
LIVE → ARCHIVED, promote the submitted version → LIVE) and then invalidates the engine's
compiled `ZenEngine` decision cache, so the next underwriting call uses the new LIVE version.

## API surface (GoRules TS engine, :3001)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| POST | `/api/auth/login` | public | `{username,password}` -> `{token, user}` |
| GET | `/api/auth/me` | any | Current user from Bearer token |
| GET | `/api/health` | public | DB up + currently LIVE rules |
| POST | `/api/underwrite` | public* | Two-tier pipeline; **persists** every run to `underwriting_decisions` and returns `decisionId` |
| GET | `/api/rules` | any | All rule_keys with all versions + statuses |
| GET | `/api/rules/:ruleKey/versions/:version` | any | Full metadata + `jdmContent` from PostgreSQL |
| POST | `/api/rules/:ruleKey/draft` | AUTHOR/ADMIN | Create DRAFT (`max+1`) cloned from LIVE, or re-open the open DRAFT |
| PUT | `/api/rules/:ruleKey/versions/:version/draft` | AUTHOR/ADMIN | Save edited JDM onto DRAFT/REJECTED (compile-validated) |
| POST | `/api/rules/:ruleKey/versions/:version/submit` | AUTHOR/ADMIN | DRAFT -> PENDING_APPROVAL |
| POST | `/api/rules/:ruleKey/versions/:version/approve` | APPROVER/ADMIN | PENDING_APPROVAL -> LIVE (maker-checker guard, transaction, cache invalidation) |
| POST | `/api/rules/:ruleKey/versions/:version/reject` | APPROVER/ADMIN | PENDING_APPROVAL -> REJECTED (mandatory `reviewComment`) |
| POST | `/api/rules/:ruleKey/upload-excel` | AUTHOR/ADMIN | `.xlsx` -> stage-2 rows of a DRAFT (`EXCEL_IMPORTED` audit) |
| GET | `/api/decisions?productCode=&finalDecision=&limit=50` | any | Paginated persisted decisions |
| GET | `/api/decisions/:id` | any | Full record incl. payloads, outcomes, traces, AI brief |
| GET | `/api/audit-logs?ruleKey=&action=&limit=100` | any | Chronological governance trail |

`*` `POST /api/underwrite` stays token-free as the headless data plane (parity tooling, external
callers); when a Bearer token IS sent, the executing user is recorded as the decision's `triggered_by`.

### Example: two-tier underwriting

```bash
curl -s -X POST http://localhost:3001/api/underwrite \
  -H "content-type: application/json" \
  -d @- <<'JSON'
{"productCode":"TERM_LIFE","executionMode":"PRODUCTION","aiAssist":true,
 "applicant":{"applicantId":"APP-3001","age":46,"heightCm":172,"weightKg":88,"smoker":true,
  "systolicBp":148,"annualIncome":80000,"sumAssured":1200000,"occupationClass":2,
  "recentSurgeryMonthsAgo":0,"residencyCountry":"DOMESTIC","amlWatchlistHit":false,
  "medicalConditions":["FATTY_LIVER"],"submittedDocuments":["PROPOSAL_FORM","BLOOD_PROFILE"]}}
JSON
```

Returns `decisionId`, the Stage A `fundamental` block (pass/fail + violations), the Stage B
`product` block, the flat four-stage envelope (`step1SufficientInfo` … `step4UnderwritingDecision`)
for legacy compatibility, `trace`, and — for unclean referrals with `aiAssist` — `aiCopilotBrief`.
Send `"amlWatchlistHit": true` (or `age: 16`, missing `PROPOSAL_FORM`, `residencyCountry:
"RESTRICTED"`) to see the Fundamental short-circuit (`haltedAtFundamental: true`, product null).

## Verification checklist (PRD v3 section 9)

```bash
npm run db:migrate && npm run db:seed   # 4 users + 3 LIVE rules in PostgreSQL
npm run engine &                        # two-tier pipeline
#   Test A: amlWatchlistHit=true  -> fundamental_passed=false, product_rule_key=null, persisted
#   Test B: 46yo TERM_LIFE        -> fundamental_passed=true, 4-stage outcome persisted
#   RBAC:   alice_viewer->403, bob draft/submit, bob approve->403, carol approve -> LIVE+ARCHIVED trail
npm run verify-parity                   # shadow mode: Java :8080 vs DB-backed PRODUCT_TERM_LIFE v1
npm run selftest                        # legacy file-based engine selftest (24/24)
npm run build                           # Admin UI type-check + production bundle
```

## Admin UI walkthrough (:5173)

1. **Tab 1 — Rule Studio & Simulator**: pick `[Fundamental] Global Eligibility Rule` or a
   product rule + version (`v1 (LIVE)`, `v2 (DRAFT)`…); role-gated buttons drive the workflow:
   *Create New Draft from Live* → edit/Excel-upload → *Save Draft* → *Submit for Approval* →
   switch to `carol_approver` → *Approve & Publish to LIVE* / *Reject*. The Two-Tier Live
   Simulator shows the `Fundamental Rule (vN): PASSED ✅ / FAILED ❌` banner plus the product
   outcome badges and AI Copilot card.
2. **Tab 2 — Persisted UW Decisions (DB)**: real-time table of `underwriting_decisions`;
   row drawer shows the input JSON, 4-stage breakdown, AI brief and **Replay Trace in Visual Canvas**.
3. **Tab 3 — Governance Audit Logs**: `rule_audit_logs` filtered by rule/action with a JSON
   snapshot modal.

## Notes

- **Zen expression constraints** (encoded in the graphs): this `@gorules/zen-engine` build has no
  `pow`/`**` (use explicit multiplication), no 2-arg `round` (use `round(x * 10) / 10`);
  decision-table result namespacing uses `outputPath` + `passThrough`; `functionNode.content`
  is `{ "source": "<js>" }`.
- Passwords are PoC-grade SHA-256 digests (pgcrypto); the JWT secret defaults to
  `uw-gorules-poc-dev-secret-change-me` — set `JWT_SECRET` (and `DATABASE_URL`) for anything real.
- `residencyCountry` and `amlWatchlistHit` are optional applicant fields
  (defaults `DOMESTIC` / `false`); the legacy Java service ignores them, so parity holds.
- The file-based `shared/rules/` graphs remain for the deterministic migrator/self-test tooling;
  runtime rules are loaded exclusively from PostgreSQL `rule_definitions`.
