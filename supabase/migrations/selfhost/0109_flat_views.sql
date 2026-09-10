-- E2: flattened views, so `meta` stops being an ergonomics tax on anything that queries
-- this database directly -- psql, pandas, a PostgREST filter, an agent.
--
-- THE PROBLEM. Metadata fields are data, not code: a `field_definitions` row drives the form,
-- the table, the filter bar and `GET /api/schema`, and a field without a `column_name` lives in
-- `meta` JSONB. That is the right design for the app and a poor one for a query, because
-- `meta->>'key'` is TEXT. Sorting a numeric field sorts lexically -- 9 > 10 -- and a range
-- filter compares strings. `api/_lib/query.js` already emits a warning saying exactly that, and
-- src/lib/api.ts used to fetch-then-filter in the browser to work around it, which silently
-- ignored the database's pagination limit and returned the wrong page.
--
-- THE FIX. Views that promote every active meta field to a real, CORRECTLY TYPED column. They
-- are GENERATED from field_definitions rather than written by hand, so "adding a field is
-- inserting a row" stays true: insert the row, call vault.rebuild_flat_views(), done. No
-- migration, no deploy.
--
-- These views are a READ convenience. Writes still go through the API, which is the only
-- validation path (contract v2.7).
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. Casts that cannot take the whole view down
-- ---------------------------------------------------------------------------
-- A plain `(meta->>'k')::numeric` fails the ENTIRE query if a single row holds a
-- non-numeric string there -- and `meta` is JSONB written by several clients over several
-- years, so that is not hypothetical. One bad row must cost that one cell, not the view.
--
-- immutable so the planner can inline them; strict so a null passes straight through.
create or replace function vault.try_numeric(p text) returns numeric
  language plpgsql immutable strict as $$
begin return p::numeric; exception when others then return null; end $$;

create or replace function vault.try_integer(p text) returns integer
  language plpgsql immutable strict as $$
begin return p::integer; exception when others then return null; end $$;

create or replace function vault.try_date(p text) returns date
  language plpgsql immutable strict as $$
begin return p::date; exception when others then return null; end $$;

create or replace function vault.try_boolean(p text) returns boolean
  language plpgsql immutable strict as $$
begin return p::boolean; exception when others then return null; end $$;

-- ---------------------------------------------------------------------------
-- 2. The generator
-- ---------------------------------------------------------------------------
-- Returns the SELECT list for one entity's promoted meta fields, or an empty string when the
-- entity has none.
create or replace function vault.flat_meta_select(p_entity text)
returns text language plpgsql stable as $$
declare
  def          record;
  parts        text[] := '{}';
  real_columns text[];
begin
  -- A meta key that collides with a real column would produce a duplicate output name and the
  -- view would fail to create. Skip those: the column already carries the value, so nothing is
  -- lost, and a silent skip beats a migration that will not apply.
  select array_agg(column_name) into real_columns
    from information_schema.columns
   where table_schema = 'vault'
     and table_name = case p_entity when 'sample' then 'samples'
                                    when 'measurement' then 'measurements'
                                    when 'file' then 'files' end;

  for def in
    select key, type
      from vault.field_definitions
     where entity = p_entity
       and active
       and column_name is null          -- fields WITH a column are already real columns
       and key <> all(coalesce(real_columns, '{}'))
     order by key
  loop
    parts := parts || format(
      case def.type
        when 'number'   then 'vault.try_numeric(meta->>%L) as %I'
        when 'integer'  then 'vault.try_integer(meta->>%L) as %I'
        when 'date'     then 'vault.try_date(meta->>%L) as %I'
        when 'bool'     then 'vault.try_boolean(meta->>%L) as %I'
        -- multiselect, layer_stack and json are containers: keep them as jsonb rather than
        -- flattening to a string, so `?|` and `@>` still work against them.
        when 'multiselect' then 'meta->%L as %I'
        when 'layer_stack' then 'meta->%L as %I'
        when 'json'        then 'meta->%L as %I'
        else 'meta->>%L as %I'          -- text, longtext, select, person
      end, def.key, def.key);
  end loop;

  if array_length(parts, 1) is null then return ''; end if;
  return ', ' || array_to_string(parts, ', ');
end $$;

-- Rebuilds both views from the CURRENT field definitions, and tells PostgREST to reload its
-- schema cache -- without that the new columns are invisible over REST until a restart.
create or replace function vault.rebuild_flat_views()
returns void language plpgsql as $$
begin
  -- DROP then CREATE, not `create or replace view`. Postgres only lets `create or replace`
  -- APPEND columns: it cannot insert one in the middle and it cannot rename one. Because the
  -- generator orders fields by key, adding a field whose key sorts before an existing one
  -- fails with
  --     cannot change name of view column "frequency_khz" to "anneal_temp_c"
  -- which would break the one promise this function exists to keep: that adding a metadata
  -- field is only inserting a row. Verified on a real PG 17.10 -- `create or replace` failed
  -- on exactly that case.
  --
  -- No CASCADE, deliberately. If something ever depends on these views, this should fail
  -- loudly rather than silently dropping the dependent. They are leaf read conveniences and
  -- nothing should. The grants below are re-applied because a drop takes them with it.
  execute 'drop view if exists vault.samples_flat';
  execute 'drop view if exists vault.measurements_flat';
  execute format(
    'create view vault.samples_flat as select s.*%s from vault.samples s',
    vault.flat_meta_select('sample'));
  execute format(
    'create view vault.measurements_flat as select m.*%s from vault.measurements m',
    vault.flat_meta_select('measurement'));

  -- security_invoker is load-bearing, exactly as it is for device_coverage and
  -- measurement_bench_run: the base tables have RLS enabled with no policies, and WITHOUT
  -- this a view runs as its owner and punches straight through that.
  execute 'alter view vault.samples_flat set (security_invoker = on)';
  execute 'alter view vault.measurements_flat set (security_invoker = on)';

  grant select on vault.samples_flat, vault.measurements_flat to vault_service, vault_read;

  notify pgrst, 'reload schema';
end $$;

comment on function vault.rebuild_flat_views() is
  'Regenerates samples_flat and measurements_flat from the active field_definitions. Call it '
  'after any field-definition write. Adding a metadata field stays "insert a row" -- this is '
  'what keeps that true without a migration.';

-- ---------------------------------------------------------------------------
-- 3. Build them now
-- ---------------------------------------------------------------------------
select vault.rebuild_flat_views();

-- Locked down like every other helper here: not callable over PostgREST RPC by a read role.
revoke execute on function vault.try_numeric(text), vault.try_integer(text),
  vault.try_date(text), vault.try_boolean(text), vault.flat_meta_select(text),
  vault.rebuild_flat_views() from public;
grant execute on function vault.rebuild_flat_views() to vault_service;

commit;
