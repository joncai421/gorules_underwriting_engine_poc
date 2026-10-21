-- 001_init_schema.sql : PRD v3 base DDL (users, versioned rules, audit logs, UW decisions).
-- Applied idempotently inside a transaction by db/migrate.ts.

-- pgcrypto powers the PoC-grade SHA-256 password hashing in 002_seed_initial_data.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
    change_notes TEXT,
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
