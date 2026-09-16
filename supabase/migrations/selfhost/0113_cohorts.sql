-- E5: cohorts. Grouping and correlation over the metrics 0111 defines.
--
-- WHAT MAKES THIS DIFFERENT FROM A GROUP BY. The interesting questions here -- "Ec- versus FE
-- thickness", "leakage versus pad area, to separate edge from bulk conduction" -- are one SQL
-- aggregate away. What is NOT one aggregate away is knowing whether the answer means anything,
-- and that is the whole content of this file:
--
--   1. n PER GROUP, always. A cohort of 3 and a cohort of 400 must never render alike.
--   2. THE EXCLUSION COUNT, always. A measurement in the cohort with no metric row, or one whose
--      extractor refused the sweep, is not a data point -- and silently omitting it shifts every
--      distribution after it. campaign_analysis.py keeps a dead cell as a blank WITH A REASON for
--      exactly this reason; the same rule applies to a cohort.
--   3. THE PROVENANCE OF THE GROUPING KEY. This is the one that actually bites. The metric can be
--      impeccable while the thing you grouped BY was assumed -- and then you have correlated
--      on/off ratio against somebody's guess about FE thickness and produced a confident wrong
--      answer. The bench already learned the general form of this: the rows were right and
--      everything describing them was wrong. So every group reports how many of its members had
--      a confirmed / assumed / unknown / unspecified value for the key that put them there.
--
-- ON `unspecified`, WHICH IS A FOURTH BUCKET ON PURPOSE. `meta_status` is
-- {key: confirmed|assumed|unknown}, and a key can be ABSENT while the value is present.
-- EntityForm defaults an absent status to 'confirmed' -- but that is a default for a FORM FIELD,
-- not a claim about the data, and folding absent into confirmed here would silently inflate
-- confidence for precisely the rows written by tooling that never set a status (cli/vault.py,
-- cli/backfill.py, any direct API write). Folding it into `unknown` would contradict the editor.
-- So it is counted separately and reported. Note the E1 upload path is already clean about this:
-- uploads.js writes a value ONLY for confirmed fields, and a queued field gets no value and no
-- status at all -- so an uncertain extraction is absent, never mislabelled.
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. What can be grouped by -- and why this table is NOT writable through the API
-- ---------------------------------------------------------------------------
-- `sql_expr` is INTERPOLATED INTO A QUERY by cohort_summary below. That makes this table a
-- trusted, migration-authored allow-list and nothing else: an endpoint that could insert here
-- would be an endpoint that could run arbitrary SQL as a BYPASSRLS role, which is the whole
-- database. Adding a group key is a migration, deliberately.
--
-- The privilege that enforces that is an explicit REVOKE in section 5, not a narrow grant --
-- 0102's `alter default privileges` hands the service role write access on every table created
-- in this schema, before any grant here runs. See the note there; it is easy to get wrong and it
-- fails silently in the permissive direction.
create table if not exists vault.cohort_group_keys (
  key         text primary key,
  label       text not null,
  entity      text not null check (entity in ('sample', 'measurement')),
  -- A trusted SQL fragment over `s` (samples) and `m` (measurements). Migration-authored ONLY.
  sql_expr    text not null,
  -- The field_definitions key whose meta_status describes this value's provenance. Null means
  -- the value is structural rather than asserted -- `kind` comes from the file, not from a
  -- person, so there is nothing for a human to be unsure about.
  status_key  text,
  value_kind  text not null check (value_kind in ('categorical', 'continuous')),
  unit        text references vault.units (unit),
  notes       text
);

insert into vault.cohort_group_keys (key, label, entity, sql_expr, status_key, value_kind, unit, notes) values
  ('pad_area_um2',      'Pad area',        'measurement', 'm.pad_area_um2::text',   'pad_dim_um',       'continuous', 'um2',
   'GENERATED from pad_shape and pad_dim_um, so its provenance is the provenance of pad_dim_um. Square pads are A = L^2, not pi*r^2.'),
  ('pad_dim_um',        'Pad dimension',   'measurement', 'm.pad_dim_um::text',     'pad_dim_um',       'continuous', 'um', null),
  ('pad_shape',         'Pad shape',       'measurement', 'm.pad_shape',            'pad_shape',        'categorical', null, null),
  ('temperature_c',     'Temperature',     'measurement', 'm.temperature_c::text',  'temperature_c',    'continuous', 'degC', null),
  ('device_address',    'Device address',  'measurement', 'm.device_address',       'device_address',   'categorical', null, null),
  ('kind',              'Measurement kind','measurement', 'm.kind',                 null,               'categorical', null,
   'Structural: the kind comes from the file, so there is no human assertion to be unsure about.'),
  ('measured_by',       'Measured by',     'measurement', 'm.measured_by',          'measured_by',      'categorical', null, null),
  ('instrument',        'Instrument',      'measurement', 'm.instrument',           'instrument',       'categorical', null, null),
  ('stack_fe_material', 'FE material',     'sample',      's.stack_fe_material',    'stack',            'categorical', null,
   'Promoted from the stack array in 0111. Its provenance is the provenance of `stack` as a whole.'),
  ('stack_fe_t_nm',     'FE thickness',    'sample',      's.stack_fe_t_nm::text',  'stack',            'continuous', 'nm',
   'The single most useful correlation this corpus can produce is Ec- against this column.'),
  ('family',            'Family',          'sample',      's.family',               'family',           'categorical', null, null),
  ('substrate',         'Substrate',       'sample',      's.substrate',            'substrate',        'categorical', null, null),
  ('fab_location',      'Fab location',    'sample',      's.fab_location',         'fab_location',     'categorical', null, null),
  ('fabricated_by',     'Fabricated by',   'sample',      's.fabricated_by',        'fabricated_by',    'categorical', null, null)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What can be measured
-- ---------------------------------------------------------------------------
-- The metric columns of measurement_metrics, with their units, so a cohort chart can label an
-- axis without a fourth copy of the units fact. `column_name` is checked against the real table
-- below, so a typo here fails the migration rather than the query.
create table if not exists vault.metric_definitions (
  metric      text primary key,
  label       text not null,
  column_name text not null,
  unit        text references vault.units (unit),
  log_scale   boolean not null default false,
  notes       text
);

insert into vault.metric_definitions (metric, label, column_name, unit, log_scale, notes) values
  ('onoff',          'On/off ratio',        'onoff',          '',       true,
   'Right-half quadrant ratio between the paired OFF (0->+Vmax) and ON (+Vmax->0) branches. Dimensionless. Refused outright when the sweep sat at current compliance.'),
  ('vread',          'Read voltage',        'vread',          'V',      false, null),
  ('ec_plus',        'Ec+',                 'ec_plus',        'V',      false,
   'The RETRACE voltage where the forward and reverse branches rejoin -- not a switching-current peak.'),
  ('ec_minus',       'Ec-',                 'ec_minus',       'V',      false,
   'MEDIAN across the drive cycles, not the first and not the mean.'),
  ('pr_uc_cm2',      'Remanent polarisation','pr_uc_cm2',     'uC/cm2', false,
   'Needs pad area. A measurement with no pad geometry yields no Pr -- never a guess.'),
  ('psw',            'Switched polarisation','psw',           'uC/cm2', false, null),
  ('qsw',            'Switched charge',     'qsw',            'uC',     false, null),
  ('i_max_a',        'Peak current',        'i_max_a',        'A',      true,  null),
  ('j_max_a_cm2',    'Peak current density','j_max_a_cm2',    'A/cm2',  true,
   'Needs pad area. 1 um^2 = 1e-8 cm^2; the wrong factor is eight orders of magnitude and still plausible on a log axis.'),
  ('r_low_bias_ohm', 'Low-bias resistance', 'r_low_bias_ohm', 'ohm',    true,  null),
  ('noise_floor_a',  'Noise floor',         'noise_floor_a',  'A',      true,  null)
on conflict (metric) do nothing;

-- A typo in `column_name` above would make cohort_summary raise at QUERY time, for one user, on
-- one chart. Fail here instead, where it is one migration and nobody is waiting.
do $guard$
declare missing text;
begin
  select string_agg(d.column_name, ', ') into missing
    from vault.metric_definitions d
   where not exists (select 1 from information_schema.columns c
                      where c.table_schema = 'vault' and c.table_name = 'measurement_metrics'
                        and c.column_name = d.column_name);
  if missing is not null then
    raise exception 'metric_definitions names columns that measurement_metrics does not have: %', missing;
  end if;
end $guard$;

-- The same guard for the group keys' status_key: a status_key that is not a real field definition
-- would silently report every member as `unspecified`, which reads as "nobody filled this in"
-- rather than "this migration has a typo".
do $guard$
declare missing text;
begin
  select string_agg(distinct k.status_key, ', ') into missing
    from vault.cohort_group_keys k
   where k.status_key is not null
     and not exists (select 1 from vault.field_definitions f
                      where f.key = k.status_key and f.entity = k.entity);
  if missing is not null then
    raise warning 'cohort_group_keys.status_key values with no matching field_definition: % -- provenance for those keys will report as unspecified', missing;
  end if;
end $guard$;

-- ---------------------------------------------------------------------------
-- 3. Saved cohorts
-- ---------------------------------------------------------------------------
-- A cohort is a saved PREDICATE plus a metric and a grouping key. The predicate is stored as
-- jsonb in the same shape the API's existing filter parameters take, and it is resolved by the
-- API's already-tested filter code -- NOT by this database. That split is deliberate: evaluating
-- an arbitrary user predicate in SQL means building a query engine out of jsonb, and the
-- interesting failure of a query engine you wrote yourself is that it runs as a BYPASSRLS role.
create table if not exists vault.cohorts (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique,
  name        text not null,
  description text,
  -- Filter parameters, as the API's own query layer accepts them. Never interpolated into SQL.
  predicate   jsonb not null default '{}',
  metric      text references vault.metric_definitions (metric),
  group_by    text references vault.cohort_group_keys (key),
  extractor_version text,
  created_by  text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint cohorts_predicate_object check (jsonb_typeof(predicate) = 'object')
);
create index if not exists cohorts_updated_at_idx on vault.cohorts (updated_at desc);

create or replace function vault.touch_cohort() returns trigger language plpgsql as $fn$
begin
  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('vault.actor', true), ''),
                             vault.current_email(), new.updated_by, old.updated_by, 'api');
  return new;
end $fn$;
drop trigger if exists cohorts_touch on vault.cohorts;
create trigger cohorts_touch before update on vault.cohorts
  for each row execute function vault.touch_cohort();

-- ---------------------------------------------------------------------------
-- 4. The aggregate
-- ---------------------------------------------------------------------------
-- Takes an EXPLICIT list of measurement ids -- resolved by the API using its existing, tested and
-- injection-hardened filter path -- plus a metric and a group key from the two registries above.
-- Nothing here comes from a user as SQL.
--
-- Returns one row per group. Read the count columns as a ledger that must balance:
--   n_members = n_with_metric + n_no_metric_row + n_refused
-- so a caller can always say where every member went. That is the difference between "the median
-- on/off for 20 nm is 12.5" and "the median on/off for 20 nm is 12.5 over 31 of 44 devices, 9 of
-- which had no metric computed and 4 of which sat at current compliance".
create or replace function vault.cohort_summary(
  p_measurement_ids uuid[],
  p_metric text,
  p_group_by text,
  p_extractor_version text default null
) returns table (
  group_value        text,
  n_members          bigint,
  n_with_metric      bigint,
  n_no_metric_row    bigint,
  n_refused          bigint,
  status_confirmed   bigint,
  status_assumed     bigint,
  status_unknown     bigint,
  status_unspecified bigint,
  min_value          double precision,
  q1                 double precision,
  median             double precision,
  q3                 double precision,
  max_value          double precision,
  mean               double precision,
  stddev             double precision
) language plpgsql stable as $fn$
declare
  g record; md record; sql text;
begin
  select * into g from vault.cohort_group_keys where key = p_group_by;
  if not found then
    raise exception 'unknown group key %', p_group_by using errcode = '22023',
      hint = 'group keys are a migration-authored allow-list; see vault.cohort_group_keys';
  end if;
  select * into md from vault.metric_definitions where metric = p_metric;
  if not found then
    raise exception 'unknown metric %', p_metric using errcode = '22023',
      hint = 'see vault.metric_definitions';
  end if;

  -- One row per MEMBER first, then aggregate. Doing it in one pass would count a measurement
  -- with two metric rows (two files, one measurement) twice in n_members, inflating the cohort.
  -- `distinct on (m.id)` picks one metric row per measurement, newest first.
  sql := format($q$
    with member as (
      select distinct on (m.id)
             m.id,
             %s as group_value,
             coalesce(nullif(m.meta_status->>%L, ''), s.meta_status->>%L, 'unspecified') as status,
             mm.id is not null as has_row,
             mm.%I as value,
             mm.skipped
        from vault.measurements m
        join vault.samples s on s.id = m.sample_id
        left join vault.measurement_metrics mm
               on mm.measurement_id = m.id
              and (%L is null or mm.extractor_version = %L)
       where m.id = any($1)
       order by m.id, mm.computed_at desc nulls last
    )
    select group_value,
           count(*)                                                          as n_members,
           count(value)                                                      as n_with_metric,
           count(*) filter (where not has_row)                               as n_no_metric_row,
           count(*) filter (where has_row and value is null)                 as n_refused,
           count(*) filter (where status = 'confirmed')                      as status_confirmed,
           count(*) filter (where status = 'assumed')                        as status_assumed,
           count(*) filter (where status = 'unknown')                        as status_unknown,
           count(*) filter (where status = 'unspecified')                    as status_unspecified,
           min(value), percentile_cont(0.25) within group (order by value),
           percentile_cont(0.5) within group (order by value),
           percentile_cont(0.75) within group (order by value),
           max(value), avg(value), stddev_samp(value)
      from member
     group by group_value
     order by group_value nulls last
  $q$, g.sql_expr,
       coalesce(g.status_key, '__none__'), coalesce(g.status_key, '__none__'),
       md.column_name,
       p_extractor_version, p_extractor_version);

  return query execute sql using p_measurement_ids;
end $fn$;

comment on function vault.cohort_summary(uuid[], text, text, text) is
  'Per-group stats for a cohort. n_members = n_with_metric + n_no_metric_row + n_refused, so a '
  'caller can always account for every member rather than quietly reporting a median over an '
  'unstated subset. Group keys and metrics come from migration-authored allow-lists; the '
  'membership list is resolved by the API, never by SQL built from user input.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
alter table vault.cohort_group_keys  enable row level security;
alter table vault.metric_definitions enable row level security;
alter table vault.cohorts            enable row level security;
-- RLS enabled with NO POLICIES, as on every other table here. It works only because the service
-- roles hold BYPASSRLS -- get that wrong and nothing errors: PostgREST returns [] for every
-- table and the vault looks empty rather than unauthorised.

-- SELECT ONLY on cohort_group_keys, for EVERY role including the service role. `sql_expr` is
-- interpolated into a query by cohort_summary, so a row here is executable code: an API that
-- could insert one could run arbitrary SQL as a BYPASSRLS role, which is the whole database.
-- Adding a group key is a migration, deliberately.
--
-- THE REVOKE IS THE LOAD-BEARING HALF, and granting SELECT alone does NOT achieve this. 0102
-- runs `alter default privileges in schema vault grant select, insert, update, delete on tables
-- to vault_service`, so EVERY table created in this schema afterwards is writable by the service
-- role the moment it exists -- before any grant in this file runs. Verified: with the grants
-- below but no revoke, has_table_privilege('vault_service','vault.cohort_group_keys','insert')
-- was already true. A "grant select only" here is decorative; the privilege has to be taken
-- away. Anyone adding another read-only table to this schema needs to do the same.
revoke insert, update, delete, truncate on vault.cohort_group_keys from vault_service, vault_read, public;
revoke insert, update, delete, truncate on vault.metric_definitions from vault_service, vault_read, public;
grant select on vault.cohort_group_keys to vault_read, vault_service;
grant select on vault.metric_definitions to vault_read, vault_service;
grant select on vault.cohorts to vault_read, vault_service;
grant insert, update, delete on vault.cohorts to vault_service;
grant execute on function vault.cohort_summary(uuid[], text, text, text) to vault_read, vault_service;

select vault.rebuild_flat_views();

commit;
