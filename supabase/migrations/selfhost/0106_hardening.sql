-- Hardening for the self-hosted PostgREST roles.

-- WRAPPED IN A TRANSACTION, added 2026-09-11 after a real partial failure.
-- Applying this chain to edaserver stopped at `create extension pg_trgm` (contrib was not
-- installed). ON_ERROR_STOP aborted the file -- but without a transaction the statements BEFORE
-- the failure had already committed, so the database was left holding two schemas from a
-- migration the ledger correctly recorded as never applied. This file is idempotent, so that
-- particular case recovers on a re-run; the next file's failure might not. Postgres runs DDL
-- transactionally, so the fix costs nothing.
begin;

alter function vault.set_updated_at() set search_path = '';
alter function vault.audit_row() set search_path = '';
alter function vault.enforce_allowlist() set search_path = '';
alter function vault.current_email() set search_path = '';
alter function vault.is_allowlisted() set search_path = '';
alter function vault.is_admin() set search_path = '';

revoke execute on all functions in schema vault from public;
revoke execute on all functions in schema vault from vault_read;

-- audit_row, enforce_allowlist and current_email are trigger-only or internal helpers and must not be callable over PostgREST RPC by any client role.
grant execute on function vault.is_allowlisted(), vault.is_admin() to vault_service;

commit;
