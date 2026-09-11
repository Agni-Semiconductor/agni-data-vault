-- WRAPPED IN A TRANSACTION, added 2026-09-11 after a real partial failure.
-- Applying this chain to edaserver stopped at `create extension pg_trgm` (contrib was not
-- installed). ON_ERROR_STOP aborted the file -- but without a transaction the statements BEFORE
-- the failure had already committed, so the database was left holding two schemas from a
-- migration the ledger correctly recorded as never applied. This file is idempotent, so that
-- particular case recovers on a re-run; the next file's failure might not. Postgres runs DDL
-- transactionally, so the fix costs nothing.
begin;

grant usage on schema bench_storage to vault_service;
grant select, insert, update, delete on bench_storage.objects to vault_service;

-- PostgREST resolves RPC in the request's profile schema, so a public-schema function is unreachable from the vault profile.
create or replace function vault.storage_usage(p_bucket text default 'vault')
returns table (objects bigint, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  select count(*)::bigint, coalesce(sum((bench_storage.objects.metadata ->> 'size')::bigint), 0)::bigint
  from bench_storage.objects
  where bench_storage.objects.bucket_id = p_bucket;
$$;

revoke execute on function vault.storage_usage(text) from public;
grant execute on function vault.storage_usage(text) to vault_service;

-- The old bucket row's 50 MB per-object limit is now enforced by the API, not the database.

commit;
