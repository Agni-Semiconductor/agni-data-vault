-- E3, the keystone: computed metrics, a measurement-kind registry, and the two stack fields
-- that cohort analysis needs as real columns.
--
-- WHY THIS IS THE KEYSTONE. "Correlate by device size", "group by geometry", the figure builder
-- and the search agent all need per-measurement NUMBERS, and the vault has none. The bench's
-- cell_analysis covers board campaigns only; the vault's ~2,106 Clarius measurements have no
-- on/off ratio, no coercive voltage, no remanent polarisation -- nothing. Everything downstream
-- of here is cheap once this exists and impossible before it.
--
-- WHERE THE NUMBERS COME FROM, and why not from here. The metric DEFINITIONS already exist, in
-- ferrodiode-pcb-testbench/tools/campaign_analysis.py, and they are not naive:
--   * `onoff` is the right-half quadrant ratio between the OFF branch (0 -> +Vmax) and the ON
--     branch (+Vmax -> 0) -- a paired SWITCHING measurement, not two unrelated points.
--   * it REFUSES a sweep pinned at current compliance, because on a real array a cell that hit
--     compliance partway scored 827x where its neighbours sat near 4x.
--   * `ec_plus` is the RETRACE voltage where the forward and reverse branches rejoin, not a
--     switching-current peak.
--   * AC-IV takes the MEDIAN across the five drive cycles, not the first or the mean.
-- That is a thousand lines of physics with the reasoning attached. The extraction worker
-- therefore IMPORTS those functions rather than reimplementing them, so that `onoff` means the
-- same quantity on the bench side and the vault side. Two implementations of the same metric
-- name is exactly how a cohort comparison ends up correlating two different things.
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. The kind registry: axes and UNITS as data, not as code in three places
-- ---------------------------------------------------------------------------
-- Today the canonical axis columns and their units live in code, in three separate places:
-- src/plot/plotProfiles.ts (PROFILES), the bench's COLUMN_UNITS, and fed_viewer's own column
-- lists. Three copies of the same fact is how a unit mismatch happens -- and the bench emits
-- BOTH `i_a` (amperes) and `current_mA`, so overlaying them without conversion draws a 1000x
-- error that looks like real data. One table, and the code projects from it.
create table if not exists vault.measurement_kinds (
  kind          text primary key,
  label         text not null,
  x_col         text[] not null default '{}',   -- candidates, in fallback order
  y_col         text[] not null default '{}',
  y2_col        text[] not null default '{}',
  x_unit        text,
  y_unit        text,
  y2_unit       text,
  abs_y         boolean not null default false,
  log_y         boolean not null default false,
  -- Which metrics this kind can yield at all. A cohort over `ec_minus` must not silently
  -- include DC-IV measurements, which cannot produce one.
  derivable     text[] not null default '{}',
  notes         text
);

insert into vault.measurement_kinds
  (kind, label, x_col, y_col, y2_col, x_unit, y_unit, y2_unit, abs_y, log_y, derivable, notes)
values
  ('dciv',  'DC-IV',     '{AV,BV}',        '{AI,BI}',    '{}',            'V', 'A', null, true,  true,
   '{onoff,vread,ec_plus,noise_floor_a,i_max_a,j_max_a_cm2}',
   'Right-half on/off from the paired OFF (0->+Vmax) and ON (+Vmax->0) branches. Refuses a sweep pinned at compliance.'),
  ('aciv',  'AC-IV',     '{Vforce}',       '{Imeas}',    '{Charge}',      'V', 'A', 'C',  false, false,
   '{ec_minus,ec_plus,n_cycles}',
   'Coercive voltage as the MEDIAN across the drive cycles, not the first or the mean.'),
  ('pund',  'PUND',      '{Time,t}',       '{V}',        '{I,Psw,Qsw}',   's', 'V', 'A',  false, false,
   '{pr_uc_cm2,psw,qsw}',
   'Pr from Psw/Qsw. Needs pad area, so a measurement with no pad geometry yields no Pr.'),
  ('pulse', 'Pulse',     '{t,Time}',       '{V}',        '{I}',           's', 'V', 'A',  false, false,
   '{i_max_a}', null),
  ('cv',    'C-V',       '{V}',            '{C}',        '{}',            'V', 'F', null, false, false,
   '{}', null),
  ('res2t', '2-terminal resistance', '{V}', '{I}',       '{}',            'V', 'A', null, false, false,
   '{r_low_bias_ohm}', null),
  ('board_csv', 'Board campaign capture', '{v_applied}', '{i_a,current_mA}', '{v_meas}', 'V', 'A', 'V', true, true,
   '{onoff,vread,ec_plus,ec_minus,i_max_a}',
   'y_col is amperes-first: i_a is SI, current_mA is the legacy column. Reading current_mA as amperes is a 1000x error that looks like data.')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Derived metrics
-- ---------------------------------------------------------------------------
-- DERIVED, NEVER AUTHORITATIVE. Every row carries the extractor_version that produced it, and a
-- version bump inserts a NEW row rather than overwriting -- so a figure published from version
-- N cannot silently change when N+1 lands. Same rule as the bench's run_analysis.
create table if not exists vault.measurement_metrics (
  id                uuid primary key default gen_random_uuid(),
  measurement_id    uuid not null references vault.measurements (id) on delete cascade,
  -- One measurement can hold several runs in several files, and each file gets its own row.
  file_id           uuid references vault.files (id) on delete cascade,
  kind              text references vault.measurement_kinds (kind),
  extractor_version text not null,

  -- SI THROUGHOUT: amperes, volts, seconds. Never mA. The bench schema says so in capitals
  -- and this table shares its cluster.
  onoff             double precision,
  vread             double precision,
  ec_plus           double precision,
  ec_minus          double precision,
  pr_uc_cm2         double precision,
  psw               double precision,
  qsw               double precision,
  i_max_a           double precision,
  j_max_a_cm2       double precision,
  r_low_bias_ohm    double precision,
  noise_floor_a     double precision,
  n_points          integer,
  n_cycles          integer,

  -- Unknown keys are RETAINED rather than dropped: the extractor and this schema are deployed
  -- separately, so a newer extractor emitting an extra figure must not lose it just because
  -- this side has not been updated. Same forward-compatibility rule as device_tests.metrics.
  extra             jsonb not null default '{}',

  -- Why a metric is ABSENT, in words. campaign_analysis.py keeps a cell as a blank with a
  -- reason rather than dropping it, because silently omitting a dead measurement shifts
  -- everything after it. A null with no explanation is indistinguishable from "not computed
  -- yet".
  skipped           text,

  computed_at       timestamptz not null default now()
  -- NO plain unique constraint here, deliberately. See the two partial indexes below:
  -- `unique (measurement_id, file_id, extractor_version)` LOOKS right and enforces NOTHING
  -- when file_id is null, because Postgres treats nulls as DISTINCT in a unique constraint.
  -- A measurement-level rollup has no file, so that is the COMMON case, and the same
  -- (measurement, version) inserted twice both succeeded -- verified on PG 17.10, clarius_v1
  -- landed twice. This is the identical trap selfhost_schema.sql documents in capitals for
  -- device_tests.measurement. There is no sensible sentinel uuid for file_id (the FK needs a
  -- real row), so: two partial indexes.
);

-- Correct uniqueness in BOTH cases, which one constraint cannot express:
create unique index if not exists measurement_metrics_file_version_uniq
  on vault.measurement_metrics (measurement_id, file_id, extractor_version)
  where file_id is not null;
create unique index if not exists measurement_metrics_rollup_version_uniq
  on vault.measurement_metrics (measurement_id, extractor_version)
  where file_id is null;

create index if not exists measurement_metrics_measurement_idx
  on vault.measurement_metrics (measurement_id);
create index if not exists measurement_metrics_version_idx
  on vault.measurement_metrics (extractor_version, kind);
-- The cohort queries: "every on/off we have", "every Ec- we have".
create index if not exists measurement_metrics_onoff_idx
  on vault.measurement_metrics (onoff) where onoff is not null;
create index if not exists measurement_metrics_ec_minus_idx
  on vault.measurement_metrics (ec_minus) where ec_minus is not null;

-- ---------------------------------------------------------------------------
-- 3. Promote the two stack fields cohort analysis actually groups by
-- ---------------------------------------------------------------------------
-- `stack` is a bottom-up JSONB array of {role, material, t_nm}. The ferroelectric layer is the
-- one with role='fe', and "Ec- versus FE thickness" is the single most useful correlation this
-- corpus can produce -- so those two values need to be real, typed, indexable columns rather
-- than a JSONB walk. This is the promotion path CONTRACT section 5 describes, used as intended.
alter table vault.samples
  add column if not exists stack_fe_material text,
  add column if not exists stack_fe_t_nm numeric;

-- Backfill from the array. `limit 1` on the FIRST fe layer: a stack with two ferroelectric
-- layers is a real thing but not something a single column can describe, so it takes the
-- bottom-most and the array remains authoritative for the full picture.
update vault.samples s set
  stack_fe_material = (select layer->>'material' from jsonb_array_elements(s.stack) layer
                        where layer->>'role' = 'fe' and layer->>'material' is not null limit 1),
  stack_fe_t_nm     = (select vault.try_numeric(layer->>'t_nm') from jsonb_array_elements(s.stack) layer
                        where layer->>'role' = 'fe' and layer->>'t_nm' is not null limit 1)
where jsonb_typeof(s.stack) = 'array'
  and (stack_fe_material is null or stack_fe_t_nm is null);

create index if not exists samples_stack_fe_idx
  on vault.samples (stack_fe_material, stack_fe_t_nm)
  where stack_fe_material is not null;

comment on column vault.samples.stack_fe_material is
  'Material of the first role=''fe'' layer in `stack`, promoted for cohort queries. `stack` '
  'remains authoritative: a two-ferroelectric stack cannot be described by one column.';

-- Field definitions so both appear in the form, the table, the filter bar and /api/schema with
-- no further migration -- column_name set, so the value-location rule reads the column.
insert into vault.field_definitions
  (entity, key, label, help, type, options_list_key, unit, required, sort_order, group_name,
   active, column_name, show_in_table, filterable)
values
  ('sample', 'stack_fe_material', 'FE material',
   'Material of the ferroelectric layer, promoted from the stack for grouping.',
   'text', null, null, false, 210, 'Stack', true, 'stack_fe_material', true, true),
  ('sample', 'stack_fe_t_nm', 'FE thickness',
   'Thickness of the ferroelectric layer, promoted from the stack for grouping.',
   'number', null, 'nm', false, 211, 'Stack', true, 'stack_fe_t_nm', true, true)
on conflict (entity, key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Grants and the flat-view rebuild
-- ---------------------------------------------------------------------------
alter table vault.measurement_kinds   enable row level security;
alter table vault.measurement_metrics enable row level security;
-- RLS enabled with NO POLICIES on both, matching every other table here. That works only
-- because the service roles hold BYPASSRLS. Get it wrong and NOTHING ERRORS: PostgREST returns
-- [] for every table, the API reports success, and the vault looks empty rather than
-- unauthorised.
grant select, insert, update, delete on vault.measurement_metrics to vault_service;
grant select on vault.measurement_metrics, vault.measurement_kinds to vault_read;
grant select, insert, update on vault.measurement_kinds to vault_service;

-- The two new sample columns are real columns now, so the generator must stop promoting them
-- from meta and start selecting them directly. Rebuilding also NOTIFYs PostgREST.
select vault.rebuild_flat_views();

commit;
