-- Bench <-> vault linkage, and the `bucket` column that makes read-through possible.
--
-- ORDERING DEPENDENCY: this file references public.campaign_runs and public.device_tests,
-- which belong to the bench half of this cluster (ferrodiode-pcb-testbench,
-- server/deploy/selfhost_schema.sql). That file runs FIRST. Against a database without it,
-- every statement below fails with 'relation "public.campaign_runs" does not exist'.
--
-- Wrapped in a transaction for the same two reasons as 0101: `set local` is scoped to a
-- transaction and is a silent no-op under psql's autocommit, and a half-applied linkage is
-- worse than none.
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. files.bucket -- read-through to objects the bench owns
-- ---------------------------------------------------------------------------
-- The campaign CSVs already exist as objects in the `bench` bucket: 16,821 files, about
-- 1,012 MB. Copying them into `vault/` to satisfy a foreign key would make a THIRD copy of
-- bytes already on the disk (workspace, objects/bench/, objects/vault/). So a vault `files`
-- row may instead POINT at the bench's object and be served read-through.
--
-- This is what replaces the "pointer-only" compromise in docs/BACKFILL_PLAN.md. That
-- compromise existed because the vault was on a 1 GB free tier; on edaserver's 1 TB the
-- constraint is gone, but copying is still the wrong answer -- referencing is.
alter table vault.files
  add column if not exists bucket text not null default 'vault'
  check (bucket in ('vault', 'bench'));

-- storage_path was unique on its own. It must now be unique PER BUCKET, or the same relative
-- path in two buckets collides.
alter table vault.files drop constraint if exists files_storage_path_key;
-- Drop the NEW name too before adding it. Guarding only the old name made this file
-- fail on a second run with 'relation "files_bucket_storage_path_key" already exists',
-- and a migration that cannot be re-run is a migration you cannot safely resume.
alter table vault.files drop constraint if exists files_bucket_storage_path_key;
alter table vault.files
  add constraint files_bucket_storage_path_key unique (bucket, storage_path);

comment on column vault.files.bucket is
  'Which object store bucket holds the bytes. Rows with bucket=''bench'' are READ-ONLY here: '
  'the bench owns those bytes and is their system of record. DELETE /api/files/:id returns 403 '
  'for them, and fed_storage independently refuses a delete outside the vault bucket, so the '
  'guard exists on both sides rather than only in application code.';

-- ---------------------------------------------------------------------------
-- 2. measurements -> campaign_runs, as a real foreign key
-- ---------------------------------------------------------------------------
-- docs/BACKFILL_PLAN.md documents `meta.external = {project, table, campaign_run_id}` as the
-- way a vault measurement points at a board campaign. It was never implemented: no field
-- definition, no resolver, no UI -- one line of prose. With both halves in ONE database it can
-- be a foreign key instead of a cross-project reference nobody can follow.
alter table vault.measurements
  add column if not exists bench_dut_id text,
  add column if not exists bench_run_id text;

-- campaign_runs' unique key is the PAIR (run_id, dut_id), in that order, so the FK must name
-- both columns in that order.
--
-- ON DELETE RESTRICT is deliberate. It makes the vault a referential brake on bench deletes,
-- which costs nothing today: nothing in the bench deletes campaign_runs (there is no delete
-- path, and the seven zombie status='running' rows are explicitly kept in place by the
-- 2026-08-11 decision). The alternative, ON DELETE SET NULL, never blocks bench maintenance
-- but loses the linkage SILENTLY -- and a measurement that has quietly forgotten which
-- campaign produced it is indistinguishable from one that never had a campaign.
alter table vault.measurements
  drop constraint if exists measurements_bench_run_fk;
alter table vault.measurements
  add constraint measurements_bench_run_fk
  foreign key (bench_run_id, bench_dut_id)
  references public.campaign_runs (run_id, dut_id)
  on delete restrict;

-- Registration is idempotent: one vault measurement per campaign run, upserted on this key.
-- Without it, a timer that re-registers a completed run creates a duplicate measurement every
-- 15 minutes.
create unique index if not exists measurements_bench_run_uniq
  on vault.measurements (bench_run_id, bench_dut_id)
  where bench_run_id is not null;

create index if not exists measurements_bench_run_idx
  on vault.measurements (bench_run_id, bench_dut_id)
  where bench_run_id is not null;

-- Backfill from the documented-but-unwritten pointer. `meta.external` is NOT deleted: it is
-- documented in BACKFILL_PLAN, cli/backfill.py may have written it, and the bench's own
-- forward-compatibility rule is that you do not prune JSON you did not author. Stop WRITING
-- it; keep reading it as a fallback; let the columns be authoritative.
update vault.measurements set
  bench_run_id = meta -> 'external' ->> 'campaign_run_id',
  bench_dut_id = coalesce(meta -> 'external' ->> 'dut_id', device_address)
where meta ? 'external'
  and meta -> 'external' ->> 'campaign_run_id' is not null
  and bench_run_id is null;

-- ---------------------------------------------------------------------------
-- 3. dut_id -> sample_id, as a table rather than a guess
-- ---------------------------------------------------------------------------
-- Bench DUT ids look like `2kb-dut-01`; vault sample ids are registry keys like
-- `HfN_20_0421`. There is no derivation between them, so do not invent one -- a wrong
-- automatic mapping attaches real measurements to the wrong physical sample, which is worse
-- than having no mapping at all. Fill this in once, by hand.
create table if not exists vault.dut_sample_map (
  dut_id text primary key,
  sample_id text not null references vault.samples (sample_id) on delete restrict,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. The resolver view
-- ---------------------------------------------------------------------------
-- PostgREST will NOT auto-embed vault.measurements -> public.campaign_runs: its relationship
-- detection works within the exposed schema, so `select=*,campaign_runs(*)` does not work
-- across profiles. That is the concrete reason this join is a view living inside `vault`
-- rather than a query parameter.
create or replace view vault.measurement_bench_run as
select
  m.id                          as measurement_id,
  m.bench_run_id,
  m.bench_dut_id,
  r.name                        as bench_run_name,
  r.kind                        as bench_run_kind,
  r.status                      as bench_run_status,
  r.operator                    as bench_operator,
  r.instrument                  as bench_instrument,
  r.module,
  r.module_sha256,
  r.config_sha256,
  r.safety_sha256,
  r.visit_order,
  r.seed,
  r.n_planned,
  r.settle_ms,
  r.quarantine,
  r.params,
  r.thresholds,
  r.manifest,
  r.started_at                  as bench_started_at,
  r.completed_at                as bench_completed_at,
  -- COUNTED, not read from campaign_runs.n_measured. That schema's own comment says those
  -- roll-ups are written at the END of a run, so a live campaign reports n_measured = 0 while
  -- holding tens of thousands of child rows. tools/bench_source.py learned this the hard way;
  -- do not repeat it here.
  (select count(*) from public.device_tests d
    where d.run_id = m.bench_run_id and d.dut_id = m.bench_dut_id)              as bench_cells,
  (select count(*) from public.device_tests d
    where d.run_id = m.bench_run_id and d.dut_id = m.bench_dut_id
      and d.status = 'measured')                                               as bench_cells_measured,
  (select jsonb_object_agg(v, n) from (
      select coalesce(d.verdict, '(skipped)') as v, count(*) as n
        from public.device_tests d
       where d.run_id = m.bench_run_id and d.dut_id = m.bench_dut_id
       group by 1) t)                                                          as bench_verdicts
from vault.measurements m
join public.campaign_runs r
  on r.run_id = m.bench_run_id and r.dut_id = m.bench_dut_id;

-- security_invoker is load-bearing, exactly as it is for public.device_coverage: every base
-- table has RLS enabled with no policies, and WITHOUT this the view runs as its owner and
-- punches straight through that.
alter view vault.measurement_bench_run set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 5. Grants -- the vault reads the bench, and never writes it
-- ---------------------------------------------------------------------------
grant usage on schema public to vault_service, vault_read;
grant select on public.campaign_runs, public.device_tests to vault_service, vault_read;
-- device_coverage is `revoke all ... from bench_read` in selfhost_schema.sql, so it needs an
-- explicit grant here or the vault gets 'permission denied for view device_coverage'. It is
-- THE query for the 128x128 map -- one REST call for a whole array, because PostgREST cannot
-- express the window function that collapses device_tests to the latest attempt per cell.
-- Its security_invoker = on means it still respects device_tests' RLS.
grant select on public.device_coverage to vault_service, vault_read;
-- The analysis tables (ferrodiode-pcb-testbench/server/deploy/migrations/2026-09-10_cell_analysis.sql)
-- back the histograms and the outcome map. Guarded: this file must still apply against a
-- cluster where that migration has not run yet.
do $$ begin
  if to_regclass('public.cell_analysis') is not null then
    grant select on public.cell_analysis to vault_service, vault_read;
  end if;
  if to_regclass('public.run_analysis') is not null then
    grant select on public.run_analysis to vault_service, vault_read;
  end if;
end $$;
grant select on vault.measurement_bench_run to vault_service;
grant select, insert, update, delete on vault.dut_sample_map to vault_service;

alter table vault.dut_sample_map enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Make the new columns visible to the app with no further migration
-- ---------------------------------------------------------------------------
-- field_definitions rows with column_name set: they appear in the form, the table, the filter
-- bar and GET /api/schema immediately. This is the promotion path CONTRACT section 5 describes,
-- used as intended.
insert into vault.field_definitions
  (entity, key, label, help, type, required, sort_order, group_name, active, column_name,
   show_in_table, filterable)
values
  ('measurement', 'bench_run_id', 'Bench campaign run',
   'The board campaign that produced this measurement. Joins to the bench''s campaign_runs.',
   'text', false, 900, 'Bench', true, 'bench_run_id', false, true),
  ('measurement', 'bench_dut_id', 'Bench DUT',
   'The board DUT id, the second half of the campaign key.',
   'text', false, 901, 'Bench', true, 'bench_dut_id', false, true)
on conflict (entity, key) do nothing;

commit;
