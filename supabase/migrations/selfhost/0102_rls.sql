-- Every vault table has RLS enabled but no policies. This works only because vault_service has BYPASSRLS.
-- If that role is provisioned incorrectly, nothing raises an error: PostgREST returns empty arrays, the API reports success,
-- and the vault appears empty instead of unauthorized. The health check must read a row known to exist.
-- Enforcement now lives in the API, the only writer after this migration. RLS remains enabled so a mis-provisioned role
-- reads nothing rather than everything.
alter table vault.option_lists enable row level security;
alter table vault.option_values enable row level security;
alter table vault.field_definitions enable row level security;
alter table vault.samples enable row level security;
alter table vault.measurements enable row level security;
alter table vault.files enable row level security;
alter table vault.allowlist enable row level security;
alter table vault.audit_log enable row level security;

grant select, insert, update, delete on all tables in schema vault to vault_service;
grant select on all tables in schema vault to vault_read;
grant usage, select on all sequences in schema vault to vault_service;
alter default privileges in schema vault grant select, insert, update, delete on tables to vault_service;
alter default privileges in schema vault grant select on tables to vault_read;
alter default privileges in schema vault grant usage, select on sequences to vault_service;
