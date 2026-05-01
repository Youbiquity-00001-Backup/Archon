-- Patch 3 / Phase A.1: track which Slack user registered each codebase.
-- Self-fallback rule (see PHASE-A1-DESIGN.md "Flow 5"): the registering user's
-- own GitHub creds become an implicit fallback for THEIR future actions on
-- that codebase — never for cross-user borrowing.
--
-- Idempotent: safe to re-apply on PostgreSQL deployments at task boot.
-- The combined SQLite schema (createSchema in packages/core/src/db/adapters/
-- sqlite.ts) and its migrateColumns() loop carry the same column for
-- non-PostgreSQL installations.
--
-- Note about file numbering: the design draft used `001_codebase_registration.sql`,
-- but `001` is already taken by `001_initial_schema.sql`. Renumbered to 022 to
-- avoid collision; the column shape is unchanged.

ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS registered_by_slack_user_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_codebases_registered_by
  ON remote_agent_codebases(registered_by_slack_user_id);
