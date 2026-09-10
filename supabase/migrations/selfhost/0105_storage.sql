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
