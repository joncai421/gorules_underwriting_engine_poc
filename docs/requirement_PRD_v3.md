# PRD v3.0: Enterprise-Grade Headless Underwriting Engine PoC (Two-Tier Rule Pipeline, PostgreSQL Persistence, RBAC Maker-Checker Workflow & Audit Trail)

## 1. Executive Summary & Scope of Upgrades

This specification upgrades the existing GoRules Underwriting PoC from a static-file prototype into a database-backed, enterprise-ready underwriting platform. The coding agent MUST implement the following 7 architectural enhancements while preserving the existing 4-stage underwriting process (**1.1 Request Additional Info $\rightarrow$ 2. Risk Assessment $\rightarrow$ 3. Risk Classification $\rightarrow$ 4. Underwriting Decision**):

1. **Two-Tier Rule Execution Pipeline (`Fundamental Rule` $\rightarrow$ `Per-Product Rule`):** Every underwriting request first executes a global **Fundamental Rule** (eligibility, KYC/proposal signature, AML/sanctions, hard age bounds). Only if the Fundamental Rule passes does the engine execute the specific **Per-Product Rule** (`PRODUCT_TERM_LIFE` or `PRODUCT_CRITICAL_ILLNESS`).
2. **PostgreSQL Rule Storage, Versioning & Maker-Checker Workflow:** Replace static JSON file loading with PostgreSQL `JSONB` persistence. Support immutable rule versions (`v1, v2, v3...`), lifecycle statuses (`DRAFT`, `PENDING_APPROVAL`, `LIVE`, `REJECTED`, `ARCHIVED`), and a formal approval workflow.
3. **Immutable Audit Logging:** Record every rule mutation, status transition, approval, rejection, and login/entitlement action in a dedicated `rule_audit_logs` table.
4. **Underwriting Decision & Outcome Persistence:** Persist every underwriting evaluation—including input payload, matched Fundamental & Product rule versions, 4-stage assessment breakdown, execution trace, and AI Copilot output—into an `underwriting_decisions` table.


5. **Dockerized PostgreSQL Infrastructure:** Provide a `docker-compose.yml` running PostgreSQL 16 with healthchecks and volume persistence.
6. **Automated DB Migration & Seeding Scripts:** Provide numbered SQL migration scripts and a TypeScript CLI runner (`npm run db:migrate` and `npm run db:seed`) that initializes the schema and seeds the Fundamental Rule plus the 2 Product Rules from the initial JSON templates.
7. **Authentication & Role-Based Entitlement (RBAC):** Add JWT/token authentication and role-based access control (`VIEWER`, `RULE_AUTHOR`, `RULE_APPROVER`, `ADMIN`) across both backend REST endpoints and the React Admin UI.

---

## 2. Updated Monorepo Directory Structure

```text
uw-gorules-poc/
├── docker-compose.yml               # Req 5: PostgreSQL 16 container
├── package.json                     # Root scripts: db:up, db:migrate, db:seed, dev, verify-parity
├── README.md                        # Updated setup, RBAC credentials, and workflow guide
├── shared/
│   ├── test-cases.json              # Canonical test payloads (including Fundamental knockouts & Product cases)
│   └── seed-rules/                  # Initial JSON seed templates loaded into DB by 002_seed_rules
│       ├── fundamental-eligibility.json
│       ├── product-term-life.json       # Migrated v1 rule
│       └── product-critical-illness.json # Migrated v2 rule with occupation/comorbidity rules
├── legacy-java-service/             # Existing Java service (:8080)
├── gorules-ts-engine/               # Upgraded Headless TS Engine (:3001)
│   ├── package.json                 # Adds: pg, @types/pg, jsonwebtoken (or fastify-jwt)
│   ├── db/
│   │   ├── migrations/
│   │   │   ├── 001_init_schema.sql      # Req 6: DDL for users, rules, audit_logs, uw_decisions
│   │   │   └── 002_seed_initial_data.sql # Req 6: Default RBAC users
│   │   ├── migrate.ts               # Migration runner tracking applied scripts in schema_migrations
│   │   └── seed.ts                  # Seeds JSON files from shared/seed-rules/ into PostgreSQL
│   └── src/
│       ├── server.ts                # Fastify server with Auth middleware & all REST routes
│       ├── db/
│       │   ├── pool.ts              # PostgreSQL connection pool
│       │   ├── ruleRepository.ts    # CRUD, versioning, Maker-Checker state transitions
│       │   ├── auditRepository.ts   # Req 3: Audit log writer & query service
│       │   └── decisionRepository.ts # Req 4: Persist & query UW decisions/outcomes
│       ├── auth/
│       │   └── authMiddleware.ts    # Req 7: Token verification & RBAC role guard
│       ├── engine/
│       │   └── uwPipelineEngine.ts  # Req 1: Two-tier orchestrator (Fundamental -> Product) + DB cache
│       └── ai/
│           └── uncleanCaseCopilot.ts
└── gorules-admin-ui/                # Upgraded React Admin UI (:5173)
    └── src/
        ├── App.tsx                  # Main layout with Auth Header, Navigation Tabs & Role Guards
        ├── context/
        │   └── AuthContext.tsx      # Req 7: Login state, JWT header injection, Role helper hooks
        └── components/
            ├── RuleEditorWorkspace.tsx  # Req 2: JDM Editor + Version Selector + Draft/Submit/Approve bar
            ├── DecisionHistoryTab.tsx   # Req 4: Table & drawer inspecting persisted UW Decisions
            └── AuditLogTab.tsx          # Req 3: Chronological audit trail viewer with JSON diff modal

```

---

## 3. Infrastructure & Database Schema (Requirements 5 & 6)

### 3.1 Docker Compose (`docker-compose.yml`)

Create at the monorepo root:

```yaml
version: '3.9'
services:
  postgres:
    image: postgres:16-alpine
    container_name: uw_gorules_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: uw_user
      POSTGRES_PASSWORD: uw_password
      POSTGRES_DB: uw_engine_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U uw_user -d uw_engine_db"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:

```

### 3.2 Database Migration Script (`gorules-ts-engine/db/migrations/001_init_schema.sql`)

The migration runner (`db/migrate.ts`) MUST maintain a `schema_migrations` table and execute numbered `.sql` files idempotently inside a transaction.

```sql
-- 1. Schema Migrations Tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users & Entitlement Table (Req 7)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(128) NOT NULL, -- Simple plain/hashed check for PoC
    display_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('VIEWER', 'RULE_AUTHOR', 'RULE_APPROVER', 'ADMIN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Versioned Rule Definitions Table (Req 1 & Req 2)
CREATE TABLE IF NOT EXISTS rule_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key VARCHAR(64) NOT NULL,           -- e.g., 'FUNDAMENTAL_ELIGIBILITY', 'PRODUCT_TERM_LIFE', 'PRODUCT_CRITICAL_ILLNESS'
    rule_tier VARCHAR(32) NOT NULL CHECK (rule_tier IN ('FUNDAMENTAL', 'PRODUCT')),
    product_code VARCHAR(64),                -- NULL for FUNDAMENTAL; 'TERM_LIFE' or 'CRITICAL_ILLNESS' for PRODUCT
    name VARCHAR(128) NOT NULL,
    version INT NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'LIVE', 'REJECTED', 'ARCHIVED')),
    jdm_content JSONB NOT NULL,              -- Complete GoRules JDM JSON graph
    change_Notes TEXT,
    created_by VARCHAR(64) NOT NULL REFERENCES users(id),
    submitted_by VARCHAR(64) REFERENCES users(id),
    submitted_at TIMESTAMPTZ,
    reviewed_by VARCHAR(64) REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rule_key, version)
);

-- Ensure at most ONE 'LIVE' version exists per rule_key at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_live_rule_per_key 
ON rule_definitions (rule_key) WHERE status = 'LIVE';

-- 4. Rule Governance Audit Logs Table (Req 3)
CREATE TABLE IF NOT EXISTS rule_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key VARCHAR(64) NOT NULL,
    rule_version INT NOT NULL,
    action VARCHAR(64) NOT NULL,             -- 'CREATED_DRAFT', 'UPDATED_DRAFT', 'SUBMITTED_FOR_APPROVAL', 'APPROVED_TO_LIVE', 'REJECTED', 'ARCHIVED', 'EXCEL_IMPORTED'
    actor_id VARCHAR(64) NOT NULL,
    actor_role VARCHAR(32) NOT NULL,
    previous_status VARCHAR(32),
    new_status VARCHAR(32),
    comment TEXT,
    metadata JSONB,                          -- Stores summary diffs or snapshot metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Persisted Underwriting Decisions & Outcomes Table (Req 4)
CREATE TABLE IF NOT EXISTS underwriting_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant_id VARCHAR(64) NOT NULL,
    product_code VARCHAR(64) NOT NULL,       -- 'TERM_LIFE' | 'CRITICAL_ILLNESS'
    execution_mode VARCHAR(32) NOT NULL DEFAULT 'PRODUCTION', -- 'PRODUCTION' | 'SIMULATION'
    
    -- Exact rule versions used for regulatory reproducibility
    fundamental_rule_key VARCHAR(64) NOT NULL,
    fundamental_rule_version INT NOT NULL,
    fundamental_passed BOOLEAN NOT NULL,
    product_rule_key VARCHAR(64),            -- NULL if halted at Fundamental stage
    product_rule_version INT,                -- NULL if halted at Fundamental stage
    
    -- Core Underwriting Outcomes
    final_decision VARCHAR(64) NOT NULL,     -- 'ACCEPT_AS_PER_APPLICATION', 'ACCEPT_WITH_LOADING', 'ACCEPT_WITH_EXCLUSIONS', 'POSTPONE', 'DECLINE', 'REQUEST_ADDITIONAL_INFO'
    risk_class VARCHAR(64) NOT NULL,
    total_em_debits INT NOT NULL DEFAULT 0,
    loading_pct INT NOT NULL DEFAULT 0,
    exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_unclean_referral BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Full Snapshots
    request_payload JSONB NOT NULL,
    fundamental_outcome JSONB NOT NULL,
    product_outcome JSONB,
    execution_trace JSONB NOT NULL,
    ai_copilot_brief JSONB,
    execution_time_ms NUMERIC(10, 2) NOT NULL,
    triggered_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uw_decisions_applicant ON underwriting_decisions(applicant_id);
CREATE INDEX IF NOT EXISTS idx_uw_decisions_created_at ON underwriting_decisions(created_at DESC);

```

---

## 4. Requirement 1: Two-Tier Underwriting Pipeline (`Fundamental Rule` $\rightarrow$ `Per-Product Rule`)

### 4.1 Execution Topology

Every call to `POST /api/underwrite` must specify a `productCode` (`"TERM_LIFE"` or `"CRITICAL_ILLNESS"`). The `uwPipelineEngine.ts` orchestrator executes in two strict sequential stages:

```text
[Incoming Applicant Payload + productCode]
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│ STAGE A: FUNDAMENTAL RULE (rule_key: FUNDAMENTAL_RULE)   │
│ Loaded from DB where rule_tier = 'FUNDAMENTAL' & 'LIVE'  │
│ Checks:                                                  │
│  1. AML / Sanctions / Blacklist flag                     │
│  2. Global Age Bounds (18 <= age <= 70)                  │
│  3. Proposal Form Signed & Basic KYC Document Present    │
│  4. Permitted Residency Country                          │
└─────────────────┬────────────────────────────────────────┘
                  │
       ┌──────────┴──────────┐
       ▼ (FAILED)            ▼ (PASSED: fundamentalPassed = true)
┌────────────────────┐ ┌────────────────────────────────────────────────────────┐
│ Short-Circuit!     │ │ STAGE B: PER-PRODUCT RULE                              │
│ Skip Product Rule. │ │ Loaded from DB where product_code = req.productCode    │
│ Return DECLINE or  │ │ & status = 'LIVE'                                      │
│ REQUEST_INFO       │ │  • PRODUCT_TERM_LIFE (Standard 4-Stage Pipeline)       │
│ Persist to DB.     │ │  • PRODUCT_CRITICAL_ILLNESS (Stricter CI Rules)        │
└────────────────────┘ └───────────────────────────┬────────────────────────────┘
                                                   │
                                                   ▼
                                   [Trigger AI Copilot if Unclean]
                                                   │
                                                   ▼
                                [Persist to underwriting_decisions DB]

```

### 4.2 Fundamental Rule JDM Specification (`shared/seed-rules/fundamental-eligibility.json`)

Seed this rule into `rule_definitions` with `rule_key = 'FUNDAMENTAL_ELIGIBILITY'`, `rule_tier = 'FUNDAMENTAL'`, `version = 1`, `status = 'LIVE'`:

* **Inputs evaluated:**
* `amlWatchlistHit == true` $\rightarrow$ `fundamentalDecision: "DECLINE"`, `ruleId: "FUND_AML_SANCTION"`, `reason: "Applicant flagged on AML/Sanctions watchlist"`
* `age < 18 or age > 70` $\rightarrow$ `fundamentalDecision: "DECLINE"`, `ruleId: "FUND_GLOBAL_AGE_LIMIT"`, `reason: "Applicant outside global statutory insurable age (18-70)"`
* `not(contains(submittedDocuments, "PROPOSAL_FORM"))` $\rightarrow$ `fundamentalDecision: "REQUEST_ADDITIONAL_INFO"`, `ruleId: "FUND_MISSING_PROPOSAL"`, `missingDoc: "PROPOSAL_FORM"`, `reason: "Signed Proposal Form is mandatory before product underwriting"`
* `residencyCountry == "RESTRICTED"` $\rightarrow$ `fundamentalDecision: "DECLINE"`, `ruleId: "FUND_JURISDICTION"`, `reason: "Unsupported residency jurisdiction"`


* **Aggregator Output:**
* If any row outputs `"DECLINE"` $\rightarrow$ `{ fundamentalPassed: false, finalDecision: "DECLINE", riskClass: "FUNDAMENTAL_KNOCKOUT", violations: [...] }`
* Else if any row outputs `"REQUEST_ADDITIONAL_INFO"` $\rightarrow$ `{ fundamentalPassed: false, finalDecision: "REQUEST_ADDITIONAL_INFO", riskClass: "INCOMPLETE_FUNDAMENTAL_KYC", violations: [...] }`
* Else $\rightarrow$ `{ fundamentalPassed: true, violations: [] }`



### 4.3 Per-Product Rules (`PRODUCT_TERM_LIFE` & `PRODUCT_CRITICAL_ILLNESS`)

Seed the two existing product rules into `rule_definitions` (`rule_tier = 'PRODUCT'`, `version = 1`, `status = 'LIVE'`):

1. **`PRODUCT_TERM_LIFE` (`product_code = 'TERM_LIFE'`):** Uses the 4-stage pipeline (**1.1 Info Check $\rightarrow$ 2. Risk Assessment $\rightarrow$ 3. Risk Classification $\rightarrow$ 4. Underwriting Decision**) from `v1-migrated-rules.json`.


2. **`PRODUCT_CRITICAL_ILLNESS` (`product_code = 'CRITICAL_ILLNESS'`):** Uses the enhanced 4-stage pipeline from `v2-onboarded-rules.json` (which includes stricter comorbidity rules, Occupation Class 4 handling, and thyroid exclusion riders).



---

## 5. Requirement 2: Versioning, Lifecycle Status & Maker-Checker Workflow

### 5.1 Rule Lifecycle State Machine

```text
                  ┌──────────────────────────────────────┐
                  ▼                                      │ (Save edits)
[Clone from LIVE] ──► [ DRAFT ] ─────────────────────────┘
                          │
                          │ (Submit for Approval - RULE_AUTHOR / ADMIN)
                          ▼
               [ PENDING_APPROVAL ]
                  │              │
     (Approve)    │              │ (Reject with reason)
  RULE_APPROVER   ▼              ▼
              [ LIVE ]      [ REJECTED ] ──► (Can be edited back to DRAFT)
                  │
                  ▼ (Automatically triggered when a newer version becomes LIVE)
            [ ARCHIVED ]

```

### 5.2 Backend Rule Governance API Endpoints

1. `GET /api/rules` — Returns all rule keys grouped by `rule_key`, showing all versions, their `status`, `version`, `updated_at`, and `created_by`.
2. `GET /api/rules/:ruleKey/versions/:version` — Loads the specific version's JDM JSON and metadata from PostgreSQL.
3. `POST /api/rules/:ruleKey/draft` — (**Roles: `RULE_AUTHOR`, `ADMIN**`)
* Creates a new `DRAFT` version (`max(version) + 1`) cloned from the currently `LIVE` version (or updates an existing `DRAFT` if one is already open for that `rule_key`).
* Writes `'CREATED_DRAFT'` or `'UPDATED_DRAFT'` to `rule_audit_logs`.


4. `POST /api/rules/:ruleKey/versions/:version/submit` — (**Roles: `RULE_AUTHOR`, `ADMIN**`)
* Transitions status from `DRAFT` $\rightarrow$ `PENDING_APPROVAL`.
* Records `submitted_by`, `submitted_at`, and writes `'SUBMITTED_FOR_APPROVAL'` to `rule_audit_logs`.


5. `POST /api/rules/:ruleKey/versions/:version/approve` — (**Roles: `RULE_APPROVER`, `ADMIN**`)
* **Maker-Checker Guard:** For `RULE_APPROVER`, verify `submitted_by !== currentUser.id` (an author cannot approve their own submission unless their role is `ADMIN`).
* Inside a single PostgreSQL transaction:
1. Demote the currently `LIVE` version of `:ruleKey` to `ARCHIVED` (and log `'ARCHIVED'` in `rule_audit_logs`).
2. Promote `:version` from `PENDING_APPROVAL` to `LIVE`, setting `reviewed_by`, `reviewed_at`, `review_comment`.
3. Log `'APPROVED_TO_LIVE'` in `rule_audit_logs`.


* Invalidate the in-memory `ZenEngine` compiled decision cache so subsequent underwriting calls immediately execute the newly `LIVE` version.


6. `POST /api/rules/:ruleKey/versions/:version/reject` — (**Roles: `RULE_APPROVER`, `ADMIN**`)
* Transitions status from `PENDING_APPROVAL` $\rightarrow$ `REJECTED` with a mandatory `reviewComment`.
* Logs `'REJECTED'` in `rule_audit_logs`.



---

## 6. Requirement 7: Authentication & Entitlement (RBAC)

### 6.1 Seeded Demo Users (`002_seed_initial_data.sql`)

Seed 4 demo accounts into the `users` table so the evaluator can test entitlements immediately from the Admin UI:

| Username | Password | Role | Permitted Actions |
| --- | --- | --- | --- |
| `alice_viewer` | `pass123` | `VIEWER` | View rules (read-only JDM canvas), run Simulator, inspect UW Decision History & Audit Logs. |
| `bob_author` | `pass123` | `RULE_AUTHOR` | All `VIEWER` permissions + Edit JDM graphs, Upload Excel, Save `DRAFT`, Submit `DRAFT` for approval. **Cannot Approve/Publish to `LIVE`.** |
| `carol_approver` | `pass123` | `RULE_APPROVER` | All `VIEWER` permissions + Approve or Reject `PENDING_APPROVAL` rules to `LIVE`. **Cannot edit rules directly.** |
| `dave_admin` | `pass123` | `ADMIN` | Full access (Author + Approver + Override self-approval check). |

### 6.2 Authentication Endpoints & Middleware

* `POST /api/auth/login` — Accepts `{ username, password }`, verifies against `users` table, returns a signed token (JWT or HMAC token) and user profile `{ id, username, displayName, role }`.
* `GET /api/auth/me` — Returns current user from `Authorization: Bearer <token>`.
* **RBAC Middleware (`requireRole(['RULE_AUTHOR', 'ADMIN'])`):** Protects all mutation endpoints and returns HTTP `403 Forbidden` with a clear error message if an unauthorized role attempts an action.

---

## 7. Requirements 3 & 4: Audit Log & Persisted UW Decisions APIs

### 7.1 Underwriting Execution & Persistence (`POST /api/underwrite`)

* **Request Body:**
```json
{
  "productCode": "TERM_LIFE",
  "executionMode": "PRODUCTION",
  "aiAssist": true,
  "applicant": {
    "applicantId": "APP-3001",
    "age": 46,
    "heightCm": 172,
    "weightKg": 88,
    "smoker": true,
    "systolicBp": 148,
    "annualIncome": 80000,
    "sumAssured": 1200000,
    "occupationClass": 2,
    "recentSurgeryMonthsAgo": 0,
    "residencyCountry": "DOMESTIC",
    "amlWatchlistHit": false,
    "medicalConditions": ["FATTY_LIVER"],
    "submittedDocuments": ["PROPOSAL_FORM", "BLOOD_PROFILE"]
  }
}

```


* **Persistence Guarantee:** Every execution (whether halted at Stage A Fundamental Rule or completed through Stage B Product Rule's 4 stages) MUST be inserted into `underwriting_decisions` and return the generated `decisionId` (UUID) in the response.


* **Query Endpoints:**
* `GET /api/decisions?productCode=&finalDecision=&limit=50` — Returns paginated list of persisted underwriting decisions from PostgreSQL.
* `GET /api/decisions/:id` — Returns the full record including `request_payload`, `fundamental_outcome`, `product_outcome`, `execution_trace`, and `ai_copilot_brief`.



### 7.2 Audit Log Query Endpoint

* `GET /api/audit-logs?ruleKey=&limit=100` — Returns chronological governance events from `rule_audit_logs` joined with user display names.

---

## 8. Admin UI Upgrades (`gorules-admin-ui`)

The React Admin UI MUST include the following 4 views and controls:

1. **Top Navigation & Quick Auth Bar:**
* Displays current logged-in user badge (`Name + Role Pill`).
* Includes a **Login / Quick Switch User Dropdown** (`alice_viewer`, `bob_author`, `carol_approver`, `dave_admin`) so reviewers can test RBAC permissions with 1 click without retyping passwords.
* Navigation tabs: **`1. Rule Studio & Simulator`**, **`2. Persisted UW Decisions (DB)`**, **`3. Governance Audit Logs`**.


2. **Tab 1: Rule Studio & Simulator (`RuleEditorWorkspace.tsx`):**
* **Rule & Version Selector Bar:**
* Dropdown 1 — Select Rule: `[Fundamental] Global Eligibility Rule`, `[Product] Term Life Underwriting`, `[Product] Critical Illness Underwriting`.
* Dropdown 2 — Select Version: Lists all versions from DB (e.g., `v1 (LIVE)`, `v2 (DRAFT)`, `v3 (PENDING_APPROVAL)`).


* **Role-Gated Action Buttons:**
* If viewing `LIVE` and user is `RULE_AUTHOR`/`ADMIN`: Show **"Create New Draft from Live"** button.
* If viewing `DRAFT` and user is `RULE_AUTHOR`/`ADMIN`: Enable JDM Editor modifications, Excel upload, **"Save Draft"**, and **"Submit for Approval"** buttons.
* If viewing `PENDING_APPROVAL` and user is `RULE_APPROVER`/`ADMIN`: Show **"Approve & Publish to LIVE"** (green) and **"Reject"** (red, with comment prompt) buttons.
* If user is `VIEWER` (or viewing a `LIVE`/`ARCHIVED` version): Lock the editor in read-only mode.


* **Two-Tier Live Simulator Drawer:**
* Allows selecting a target `productCode` (`TERM_LIFE` or `CRITICAL_ILLNESS`) and a preset test applicant (including cases that fail the Fundamental Rule vs. cases that pass Fundamental and hit the 5 Product decisions).


* Displays a **2-Stage Execution Banner**:
* Badge 1: `Fundamental Rule (v1): PASSED ✅` (or `FAILED ❌ - Halted`)
* Badge 2: `Product Rule (TERM_LIFE v1): ACCEPT_WITH_LOADING (+50%)`







3. **Tab 2: Persisted UW Decisions Explorer (`DecisionHistoryTab.tsx`):**
* Displays a real-time table of all underwriting evaluations stored in PostgreSQL (`underwriting_decisions`), showing Timestamp, Applicant ID, Product, Fundamental Version, Product Version, Final Decision badge, Risk Class, EM Debits, and AI Copilot indicator.


* Clicking any row opens a detail drawer showing the full input JSON, 4-stage underwriting breakdown, AI Copilot brief, and a button **"Replay Trace in Visual Canvas"**.




4. **Tab 3: Governance Audit Log Viewer (`AuditLogTab.tsx`):**
* Displays all records from `rule_audit_logs` with filters by `rule_key` and `action` (`CREATED_DRAFT`, `SUBMITTED_FOR_APPROVAL`, `APPROVED_TO_LIVE`, `REJECTED`).



---

## 9. End-to-End Verification Checklist for the Coding Agent

Before marking the implementation complete, the coding agent MUST execute and verify the following automated checks:

1. **Database & Migration Verification:**
* Run `docker compose up -d` and wait for PostgreSQL healthcheck.
* Run `npm run db:migrate && npm run db:seed` and verify that `users` (4 rows) and `rule_definitions` (3 `LIVE` rules: `FUNDAMENTAL_ELIGIBILITY`, `PRODUCT_TERM_LIFE`, `PRODUCT_CRITICAL_ILLNESS`) exist in PostgreSQL.


2. **Two-Tier Pipeline Verification:**
* **Test A (Fundamental Failure):** Send an applicant with `amlWatchlistHit: true` or `age: 16`. Verify `fundamental_passed = false`, `product_rule_key = null`, `final_decision = 'DECLINE'`, and confirm the row is persisted in `underwriting_decisions`.
* **Test B (Fundamental Pass $\rightarrow$ Product Evaluation):** Send a valid 46-year-old applicant for `TERM_LIFE`. Verify `fundamental_passed = true`, `product_rule_key = 'PRODUCT_TERM_LIFE'`, and confirm the 4-stage product outcome is persisted in `underwriting_decisions`.




3. **RBAC & Maker-Checker Workflow Verification:**
* Authenticate as `alice_viewer` $\rightarrow$ Attempt `POST /api/rules/PRODUCT_TERM_LIFE/draft` $\rightarrow$ Verify HTTP `403 Forbidden`.
* Authenticate as `bob_author` $\rightarrow$ Create `DRAFT` (`v2`) on `PRODUCT_TERM_LIFE`, modify a threshold, and call `/submit` $\rightarrow$ Verify status becomes `PENDING_APPROVAL`.
* Authenticate as `bob_author` $\rightarrow$ Attempt to `/approve` `v2` $\rightarrow$ Verify HTTP `403 Forbidden`.
* Authenticate as `carol_approver` $\rightarrow$ Call `/approve` on `v2` $\rightarrow$ Verify `v2` becomes `LIVE`, `v1` becomes `ARCHIVED`, and `rule_audit_logs` contains the full trail (`CREATED_DRAFT` $\rightarrow$ `SUBMITTED_FOR_APPROVAL` $\rightarrow$ `APPROVED_TO_LIVE`).


4. **Shadow Parity Check:**
* Ensure `npm run verify-parity` passes against the DB-backed `PRODUCT_TERM_LIFE` `v1` rule.