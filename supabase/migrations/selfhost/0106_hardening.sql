-- Hardening for the self-hosted PostgREST roles.
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
