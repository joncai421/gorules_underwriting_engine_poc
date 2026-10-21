-- 002_seed_initial_data.sql : Default RBAC demo users (PRD v3 section 6.1).
-- Passwords are PoC-grade SHA-256 hex digests (pgcrypto) of the literal demo password.
-- Idempotent: ON CONFLICT DO NOTHING keeps re-runs safe.

INSERT INTO users (id, username, password_hash, display_name, role) VALUES
    ('u_alice_viewer',    'alice_viewer',    encode(digest('pass123', 'sha256'), 'hex'), 'Alice Viewer',    'VIEWER'),
    ('u_bob_author',      'bob_author',      encode(digest('pass123', 'sha256'), 'hex'), 'Bob Author',      'RULE_AUTHOR'),
    ('u_carol_approver',  'carol_approver',  encode(digest('pass123', 'sha256'), 'hex'), 'Carol Approver',  'RULE_APPROVER'),
    ('u_dave_admin',      'dave_admin',      encode(digest('pass123', 'sha256'), 'hex'), 'Dave Admin',      'ADMIN')
ON CONFLICT (id) DO NOTHING;
