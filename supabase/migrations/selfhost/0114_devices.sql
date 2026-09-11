-- E4: the device dimension. A physical device gets an identity, and therefore a history.
--
-- WHAT IS MISSING TODAY. Nothing ties repeated measurements of one physical device together.
-- The vault has `measurements.device_address`, a free-text column; the bench has
-- `(dut_id, grid_row, grid_col)` in `public.device_tests`. So "how did THIS cell drift across
-- five runs", "did any cell that read normal later read short", and "retention on device D2" are
-- all unanswerable, not because the data is missing but because nothing joins it.
--
-- THE HARD PART IS IDENTITY, AND IT IS NOT A JOIN CONDITION. The two systems address devices
-- DIFFERENTLY, and neither is wrong:
--
--   * The bench labels a cell `D{row}_{col}` -- `D116_116` is row 116, column 116. Verified
--     against the committed reference run: summary.json's best_cell is
--     {"cell": "D116_116", "row": 116, "col": 116}.
--   * The vault extracts `device_address` with /^[A-Z]\d{1,3}$/ -- a letter and up to three
--     digits, so `D2`, `D116`. It CANNOT produce `D116_116`; run that string through the
--     extractor and you get `D116`.
--
-- So a vault measurement labelled `D116` and a bench cell labelled `D116_116` might be the same
-- physical device or might be two unrelated things, and no rule available here can tell. Merging
-- them on a prefix would fabricate device history -- silently attributing one device's
-- measurements to another, which is worse than having no history at all, because a history is
-- exactly the kind of evidence nobody re-derives.
--
-- THEREFORE, the sure-only rule applied to identity:
--   * A bench cell resolves EXACTLY. (dut_id, grid_row, grid_col) -> sample via dut_sample_map,
--     address `D{row}_{col}`, scheme 'bench_grid'. No inference, so this can be automatic.
--   * A vault measurement attaches by its LITERAL device_address, scheme 'vault_label'.
--   * Two addresses become one device only when a HUMAN says so, in device_aliases, with their
--     name attached. Never inferred, never on a prefix, never in a migration.
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. The device
-- ---------------------------------------------------------------------------
create table if not exists vault.devices (
  id             uuid primary key default gen_random_uuid(),
  sample_id      uuid not null references vault.samples (id) on delete cascade,
  -- Canonical within its scheme. `D116_116` for a bench cell, whatever a person wrote for a
  -- vault label. NOT normalised across schemes -- see the header.
  device_address text not null,
  address_scheme text not null check (address_scheme in ('bench_grid', 'vault_label')),
  -- Populated only for bench_grid. A vault label carries no geometry we can trust: `D2` says
  -- nothing about where on the die it sits, and inventing a row/col from it is the same
  -- fabrication the header refuses.
  grid_row       integer,
  grid_col       integer,
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text,

  constraint devices_sample_address_uniq unique (sample_id, device_address),
  -- A bench cell without its coordinates is not a bench cell; it is a vault label wearing the
  -- wrong scheme, and it would silently drop out of every grid query.
  constraint devices_bench_has_grid check (
    address_scheme <> 'bench_grid' or (grid_row is not null and grid_col is not null)),
  constraint devices_vault_has_no_grid check (
    address_scheme <> 'vault_label' or (grid_row is null and grid_col is null))
);

create index if not exists devices_sample_idx on vault.devices (sample_id);
create index if not exists devices_grid_idx on vault.devices (sample_id, grid_row, grid_col)
  where grid_row is not null;

comment on column vault.devices.address_scheme is
  'bench_grid: D{row}_{col}, resolved exactly from (dut_id, grid_row, grid_col). vault_label: a '
  'literal device_address a person or the filename extractor produced. The two are NEVER merged '
  'automatically -- see vault.device_aliases.';

-- ---------------------------------------------------------------------------
-- 2. Aliases: the only place two addresses become one device
-- ---------------------------------------------------------------------------
-- A human assertion, with a name on it, that some other address refers to this same physical
-- device. `confirmed_by` is NOT NULL and has no default for that reason: an alias with nobody
-- behind it is an inference, and an inference here rewrites history.
create table if not exists vault.device_aliases (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references vault.devices (id) on delete cascade,
  alias_address text not null,
  alias_scheme  text not null check (alias_scheme in ('bench_grid', 'vault_label')),
  reason        text not null,
  confirmed_by  text not null,
  confirmed_at  timestamptz not null default now(),
  constraint device_aliases_uniq unique (device_id, alias_address)
);
create index if not exists device_aliases_address_idx on vault.device_aliases (alias_address);

comment on table vault.device_aliases is
  'Human-confirmed statements that two addresses are one physical device. Never written by a '
  'migration, a backfill or an extractor: merging D116 onto D116_116 on a prefix would '
  'attribute one device''s measurements to another, and a fabricated history is not something '
  'anybody re-derives.';

-- ---------------------------------------------------------------------------
-- 3. Attaching measurements
-- ---------------------------------------------------------------------------
alter table vault.measurements add column if not exists device_id uuid references vault.devices (id) on delete set null;
create index if not exists measurements_device_idx on vault.measurements (device_id) where device_id is not null;

comment on column vault.measurements.device_id is
  'Set when this measurement''s device_address resolves to a known device on its sample. NULL is '
  'the normal state for a measurement with no address, and is not a defect. ON DELETE SET NULL '
  'rather than CASCADE: deleting a device record must never delete measurement data.';

-- Resolve by literal address within the sample, or through a confirmed alias. Deliberately does
-- NOT create devices: a device row is a claim that a physical thing exists, and a typo'd address
-- would mint one silently. Registration is explicit.
create or replace function vault.resolve_device(p_sample_id uuid, p_address text)
returns uuid language sql stable as $fn$
  select d.id from vault.devices d
   where d.sample_id = p_sample_id and d.device_address = p_address
   union all
  select a.device_id from vault.device_aliases a
    join vault.devices d on d.id = a.device_id
   where d.sample_id = p_sample_id and a.alias_address = p_address
   limit 1
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Registering bench cells, which is the half that CAN be automatic
-- ---------------------------------------------------------------------------
-- Returns the number of devices created. Idempotent: re-running after another campaign adds only
-- the cells that are new. Takes an explicit dut_id so a caller registers one board at a time and
-- can see what each one did.
create or replace function vault.register_bench_devices(p_dut_id text, p_actor text default 'api')
returns integer language plpgsql as $fn$
declare mapped uuid; created integer;
begin
  select s.id into mapped
    from vault.dut_sample_map m join vault.samples s on s.sample_id = m.sample_id
   where m.dut_id = p_dut_id;
  if mapped is null then
    -- Refusing is the point. dut_sample_map is a TABLE precisely because bench DUT ids
    -- (`2kb-dut-01`) and vault sample ids (registry keys) have no derivation between them --
    -- inventing a sample here would hang a whole board's history off a fictional sample.
    raise exception 'dut % is not mapped to a sample', p_dut_id using errcode = '22023',
      hint = 'add a row to vault.dut_sample_map first; there is no rule that derives one from the other';
  end if;

  with cells as (
    select distinct grid_row, grid_col
      from public.device_tests
     where dut_id = p_dut_id and grid_row is not null and grid_col is not null
  ), inserted as (
    insert into vault.devices (sample_id, device_address, address_scheme, grid_row, grid_col, created_by)
    select mapped, 'D' || c.grid_row || '_' || c.grid_col, 'bench_grid', c.grid_row, c.grid_col, p_actor
      from cells c
    on conflict (sample_id, device_address) do nothing
    returning 1
  )
  select count(*) into created from inserted;
  return created;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. The history, which is what the dimension is FOR
-- ---------------------------------------------------------------------------
-- Every event that ever touched a device, in time order: vault measurements on one side, bench
-- cell results on the other. A union rather than a join, because they are different kinds of
-- event and forcing them into one row shape would lose what each carries.
create or replace view vault.device_history as
select d.id                                   as device_id,
       d.sample_id,
       d.device_address,
       'measurement'::text                    as event_kind,
       m.id::text                             as event_id,
       m.measured_on::timestamptz             as occurred_at,
       m.kind                                 as detail,
       null::text                             as verdict,
       m.instrument                           as source,
       null::text                             as run_id
  from vault.devices d
  join vault.measurements m on m.device_id = d.id
union all
select d.id, d.sample_id, d.device_address,
       'bench_cell',
       t.id::text,
       t.started_at,
       t.status,
       t.verdict,
       t.dut_id,
       t.run_id
  from vault.devices d
  join vault.dut_sample_map map on true
  join vault.samples s on s.sample_id = map.sample_id and s.id = d.sample_id
  join public.device_tests t
    on t.dut_id = map.dut_id and t.grid_row = d.grid_row and t.grid_col = d.grid_col
 where d.address_scheme = 'bench_grid';

alter view vault.device_history set (security_invoker = on);

comment on view vault.device_history is
  'Every event that touched a device, newest-last by occurred_at. Query it PER DEVICE: a full '
  '128x128 campaign is 16,384 cells per run, so an unfiltered scan is the whole bench.';

-- ---------------------------------------------------------------------------
-- 6. Cross-run verdict changes -- a finding nothing currently surfaces
-- ---------------------------------------------------------------------------
-- A cell that read `normal` in one run and `short` in a later one is a real result about a real
-- device, and today it is visible only to somebody who happens to diff two runs by hand.
--
-- `lag(...) over (partition by cell order by started_at)` rather than comparing against a
-- run-level roll-up: campaign_runs.n_measured and its counts are written at the END of a run, so
-- a live campaign reads 0 with tens of thousands of child rows. Ordering by the CELL's own
-- timestamp avoids depending on any run-level field at all.
create or replace view vault.device_verdict_changes as
with ordered as (
  select t.dut_id, t.grid_row, t.grid_col, t.run_id, t.verdict, t.started_at, t.cause,
         lag(t.verdict)    over w as prev_verdict,
         lag(t.run_id)     over w as prev_run_id,
         lag(t.started_at) over w as prev_started_at
    from public.device_tests t
   where t.verdict is not null and t.grid_row is not null and t.grid_col is not null
  window w as (partition by t.dut_id, t.grid_row, t.grid_col order by t.started_at)
)
select o.dut_id, o.grid_row, o.grid_col,
       'D' || o.grid_row || '_' || o.grid_col as device_address,
       o.prev_verdict, o.verdict as new_verdict,
       o.prev_run_id, o.run_id, o.prev_started_at, o.started_at, o.cause,
       -- Which direction the device moved. A cell going normal -> short is a failure; short ->
       -- normal is usually a measurement problem rather than a device healing, and both are
       -- worth seeing, so the view reports rather than filters.
       case when o.prev_verdict = 'normal' and o.verdict <> 'normal' then 'degraded'
            when o.prev_verdict <> 'normal' and o.verdict = 'normal' then 'recovered'
            else 'changed' end as direction
  from ordered o
 where o.prev_verdict is not null and o.prev_verdict <> o.verdict;

alter view vault.device_verdict_changes set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 7. Actor tracking and grants
-- ---------------------------------------------------------------------------
create or replace function vault.touch_device() returns trigger language plpgsql as $fn$
begin
  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('vault.actor', true), ''),
                             vault.current_email(), new.updated_by, old.updated_by, 'api');
  return new;
end $fn$;
drop trigger if exists devices_touch on vault.devices;
create trigger devices_touch before update on vault.devices
  for each row execute function vault.touch_device();

alter table vault.devices        enable row level security;
alter table vault.device_aliases enable row level security;
-- RLS enabled with NO POLICIES, as everywhere here: it works only because the service roles hold
-- BYPASSRLS. Get it wrong and nothing errors -- PostgREST returns [] for every table and the
-- vault looks empty rather than unauthorised.
grant select, insert, update, delete on vault.devices to vault_service;
grant select, insert, delete on vault.device_aliases to vault_service;
grant select on vault.devices, vault.device_aliases, vault.device_history, vault.device_verdict_changes to vault_read;
grant select on vault.device_history, vault.device_verdict_changes to vault_service;
grant execute on function vault.resolve_device(uuid, text) to vault_read, vault_service;
grant execute on function vault.register_bench_devices(text, text) to vault_service;

-- An alias is a SIGNED STATEMENT. Editing one in place would leave `confirmed_by` attached to a
-- claim that person never made, so the way to withdraw an alias is to delete it and write a new
-- one. Append-and-delete, never update.
--
-- AND THE REVOKE IS WHAT ACHIEVES THAT -- omitting UPDATE from the grant above does nothing.
-- 0102 runs `alter default privileges in schema vault grant select, insert, update, delete on
-- tables to vault_service`, so every table created here is fully writable by the service role
-- before any grant in this file runs. 0113 documents the same trap for cohort_group_keys, I
-- wrote this comment claiming UPDATE was absent, and verified it was present anyway. It is the
-- single easiest mistake to make in this schema and it always fails permissive.
revoke update on vault.device_aliases from vault_service, vault_read, public;

select vault.rebuild_flat_views();

commit;
