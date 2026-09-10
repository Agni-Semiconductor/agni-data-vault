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
