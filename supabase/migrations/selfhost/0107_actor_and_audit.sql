-- WRAPPED IN A TRANSACTION, added 2026-09-11 after a real partial failure.
-- Applying this chain to edaserver stopped at `create extension pg_trgm` (contrib was not
-- installed). ON_ERROR_STOP aborted the file -- but without a transaction the statements BEFORE
-- the failure had already committed, so the database was left holding two schemas from a
-- migration the ledger correctly recorded as never applied. This file is idempotent, so that
-- particular case recovers on a re-run; the next file's failure might not. Postgres runs DDL
-- transactionally, so the fix costs nothing.
begin;

alter table vault.samples add column if not exists updated_by text;
alter table vault.measurements add column if not exists updated_by text;
alter table vault.files add column if not exists updated_by text;

create or replace function vault.audit_row() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into vault.audit_log (entity, entity_id, action, actor, diff)
  values (TG_TABLE_NAME, coalesce(new.id, old.id), TG_OP, coalesce(nullif(current_setting('vault.actor', true), ''), vault.current_email(), new.created_by, old.created_by, 'api'), jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)));
  return coalesce(new, old);
end;
$$;

alter table vault.allowlist rename to people;

-- After Cloudflare Access this table is a role map (member | admin), not an authentication gate (contract v2.3).
comment on table vault.people is 'After Cloudflare Access this table is a role map (member | admin), not an authentication gate (contract v2.3).';

create view vault.allowlist with (security_invoker = on) as
select email, role, added_at
from vault.people;

grant select, insert, update, delete on vault.allowlist to vault_service;

commit;
