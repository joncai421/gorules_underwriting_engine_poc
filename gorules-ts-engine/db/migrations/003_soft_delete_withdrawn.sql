-- 003_soft_delete_withdrawn.sql : Records are never hard-deleted; a soft delete marks a
-- rule version as 'WITHDRAWN' so the version number stays consumed and the audit trail
-- (which references it) never points at a vanished record.
ALTER TABLE rule_definitions
    DROP CONSTRAINT IF EXISTS rule_definitions_status_check;

ALTER TABLE rule_definitions
    ADD CONSTRAINT rule_definitions_status_check
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'LIVE', 'REJECTED', 'ARCHIVED', 'WITHDRAWN'));
