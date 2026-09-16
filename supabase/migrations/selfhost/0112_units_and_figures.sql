-- E7 foundations: units as data, and figures as a saved spec.
--
-- WHY UNITS COME FIRST. A figure builder's whole job is putting two traces on one axis, and the
-- bench emits BOTH `i_a` (amperes) and `current_mA` (milliamperes) for the same physical
-- quantity. Overlaying them without conversion draws a 1000x error that looks like real data on
-- a log axis -- no gap, no warning, just a curve three decades too high. campaign_log.py records
-- COLUMN_UNITS explicitly and calls `current_mA` "the cautionary tale of a unit that lives only
-- inside a column name". This file is that lesson as a schema.
--
-- AND IT FIXES A DEFECT IN 0111. That migration gave measurement_kinds ONE `y_unit` per kind
-- while `y_col` is a FALLBACK LIST -- and for board_csv the list is {i_a,current_mA}: two
-- different units under a single label of 'A'. A capture carrying only the legacy column would
-- resolve through the fallback and be labelled amperes. The axis-level unit is demoted here to a
-- panel DEFAULT, the per-column unit becomes authoritative, and a trigger makes the mistake
-- unrepeatable rather than merely fixed.
begin;
set local search_path = vault, extensions;

-- ---------------------------------------------------------------------------
-- 1. Units, and what they measure
-- ---------------------------------------------------------------------------
-- `quantity` is what makes refusal possible. Two units convert if and only if they measure the
-- same quantity; amperes to volts has no factor, and the correct answer there is an error, not a
-- number. `si_factor` multiplies a value to reach the SI base unit for its quantity.
create table if not exists vault.units (
  unit       text primary key,
  quantity   text not null,
  si_factor  double precision not null check (si_factor > 0),
  label      text
);

insert into vault.units (unit, quantity, si_factor, label) values
  ('A',      'current',         1,     'ampere'),
  ('mA',     'current',         1e-3,  'milliampere'),
  ('uA',     'current',         1e-6,  'microampere'),
  ('nA',     'current',         1e-9,  'nanoampere'),
  ('pA',     'current',         1e-12, 'picoampere'),
  ('V',      'voltage',         1,     'volt'),
  ('mV',     'voltage',         1e-3,  'millivolt'),
  ('s',      'time',            1,     'second'),
  ('ms',     'time',            1e-3,  'millisecond'),
  ('us',     'time',            1e-6,  'microsecond'),
  ('ns',     'time',            1e-9,  'nanosecond'),
  ('C',      'charge',          1,     'coulomb'),
  ('uC',     'charge',          1e-6,  'microcoulomb'),
  ('nC',     'charge',          1e-9,  'nanocoulomb'),
  ('F',      'capacitance',     1,     'farad'),
  ('nF',     'capacitance',     1e-9,  'nanofarad'),
  ('pF',     'capacitance',     1e-12, 'picofarad'),
  ('ohm',    'resistance',      1,     'ohm'),
  ('A/cm2',  'current_density', 1,     'ampere per square centimetre'),
  ('uC/cm2', 'polarisation',    1,     'microcoulomb per square centimetre'),
  ('m',      'length',          1,     'metre'),
  ('um',     'length',          1e-6,  'micrometre'),
  ('nm',     'length',          1e-9,  'nanometre'),
  -- Area is its own quantity, and um2 is NOT convertible to um. 0113 originally labelled the
  -- `pad_area_um2` grouping key 'um' -- harmless while nothing read it, wrong the moment 0117
  -- put that label on an axis: a pad-area axis reading "um" invites a reader to compare it with
  -- a pad-dimension axis, and the numbers differ by a squaring.
  ('um2',    'area',            1e-12, 'square micrometre'),
  ('cm2',    'area',            1e-4,  'square centimetre'),
  ('m2',     'area',            1,     'square metre'),
  ('degC',   'temperature',     1,     'degree Celsius'),
  ('',       'dimensionless',   1,     'dimensionless')
on conflict (unit) do nothing;

-- Per-column units. Seeded from the bench's COLUMN_UNITS verbatim plus the Clarius export
-- columns, so both instruments answer the same question the same way.
create table if not exists vault.column_units (
  column_name text primary key,
  unit        text not null references vault.units (unit),
  notes       text
);

insert into vault.column_units (column_name, unit, notes) values
  -- The bench's normalised capture columns, from campaign_log.COLUMN_UNITS.
  ('index',      '',       null),
  ('v_applied',  'V',      null),
  ('v_meas',     'V',      null),
  ('i_a',        'A',      'SI. Prefer this over current_mA.'),
  ('current_mA', 'mA',     'LEGACY, and milliamperes. Reading it as amperes is a 1000x error that looks like data.'),
  -- Clarius (Keithley 4200A) exports. The instrument sends amperes and volts.
  ('AV',         'V',      null),
  ('BV',         'V',      null),
  ('AI',         'A',      null),
  ('BI',         'A',      null),
  ('Vforce',     'V',      null),
  ('Imeas',      'A',      null),
  ('Time',       's',      null),
  ('t',          's',      null),
  ('V',          'V',      null),
  ('I',          'A',      null),
  ('C',          'F',      null),
  ('Psw',        'uC/cm2', 'PUND switched polarisation as Clarius reports it.'),
  ('Qsw',        'uC',     'PUND switched charge.'),
  ('Charge',     'C',      null)
on conflict (column_name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Conversion, and refusal
-- ---------------------------------------------------------------------------
-- RAISES on incompatible quantities rather than returning null. A null would propagate into a
-- plot as a gap and into an average as a silently smaller n -- indistinguishable from missing
-- data. Asking for amperes in volts is a bug in the caller, not variance in the data, so it
-- should be loud. A caller that must degrade gracefully checks units_compatible() first.
create or replace function vault.unit_factor(p_from text, p_to text)
returns double precision language plpgsql immutable as $fn$
declare f record; t record;
begin
  if p_from is null or p_to is null then return null; end if;
  if p_from = p_to then return 1; end if;
  select unit, quantity, si_factor into f from vault.units where unit = p_from;
  if not found then raise exception 'unknown unit %', p_from using errcode = '22023'; end if;
  select unit, quantity, si_factor into t from vault.units where unit = p_to;
  if not found then raise exception 'unknown unit %', p_to using errcode = '22023'; end if;
  if f.quantity <> t.quantity then
    raise exception 'cannot convert % (%) to % (%)', p_from, f.quantity, p_to, t.quantity
      using errcode = '22023',
            hint = 'these units measure different quantities; a trace must be refused, not coerced';
  end if;
  return f.si_factor / t.si_factor;
end $fn$;

create or replace function vault.units_compatible(p_from text, p_to text)
returns boolean language sql stable as $fn$
  select case
    when p_from is null or p_to is null then false
    when p_from = p_to then true
    else exists (select 1 from vault.units a join vault.units b on a.quantity = b.quantity
                  where a.unit = p_from and b.unit = p_to)
  end
$fn$;

-- The unit a given column actually carries. NULL means "not registered", which a caller must
-- treat as unknown-and-therefore-refused, never as "probably the axis default".
create or replace function vault.column_unit(p_column text)
returns text language sql stable as $fn$
  select unit from vault.column_units where lower(column_name) = lower(p_column)
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Make 0111's mistake unrepeatable
-- ---------------------------------------------------------------------------
-- An axis unit is a PANEL DEFAULT, legitimate only when every candidate column on that axis
-- agrees. board_csv's y_col spans {i_a, current_mA} -- amperes and milliamperes -- so it has no
-- single axis unit and must be null, forcing the per-column lookup. This trigger asserts the
-- rule for every kind, so the next person adding a kind with a mixed-unit fallback list gets an
-- error rather than a plausible-looking 1000x.
create or replace function vault.check_axis_units() returns trigger
language plpgsql as $fn$
declare
  axis text; cols text[]; declared text; seen text[];
begin
  foreach axis in array array['x', 'y', 'y2'] loop
    cols     := case axis when 'x' then new.x_col  when 'y' then new.y_col  else new.y2_col  end;
    declared := case axis when 'x' then new.x_unit when 'y' then new.y_unit else new.y2_unit end;
    if declared is null or cols is null or cardinality(cols) < 2 then continue; end if;
    select array_agg(distinct u) into seen
      from (select vault.column_unit(c) as u from unnest(cols) c) s
     where u is not null;
    if seen is not null and cardinality(seen) > 1 then
      raise exception 'kind %: % axis declares unit % but its columns span %',
        new.kind, axis, declared, seen
        using errcode = '22023',
              hint = 'a fallback list spanning several units has no single axis unit; leave it null so the per-column unit is consulted';
    end if;
  end loop;
  return new;
end $fn$;

drop trigger if exists measurement_kinds_axis_units on vault.measurement_kinds;
create trigger measurement_kinds_axis_units
  before insert or update on vault.measurement_kinds
  for each row execute function vault.check_axis_units();

-- Apply the rule to the row that provoked it. Note this UPDATE must run AFTER the trigger
-- exists and must SET y_unit to null in the same statement -- an update that left y_unit = 'A'
-- would now be refused by the trigger it just installed, which is the point.
update vault.measurement_kinds
   set y_unit = null,
       notes  = 'y_col is amperes-first: i_a is SI, current_mA is the legacy column. They are '
             || 'DIFFERENT UNITS, so this kind has no axis-level y_unit -- resolve per column '
             || 'through vault.column_units. Reading current_mA as amperes is a 1000x error '
             || 'that looks like real data on a log axis.'
 where kind = 'board_csv';

comment on column vault.measurement_kinds.y_unit is
  'Panel DEFAULT only, and valid only when every column in y_col carries this unit -- enforced '
  'by the measurement_kinds_axis_units trigger. vault.column_units is authoritative per column.';

-- ---------------------------------------------------------------------------
-- 4. Figures
-- ---------------------------------------------------------------------------
-- A figure is a SPEC, never a copy of the data: panels, and traces that name their source. It
-- re-renders from the source rows on every view, so a relabelled sample or a corrected value
-- shows up instead of going stale inside a saved PNG.
--
-- That freshness cuts both ways, which is why `pinned_extractor_version` exists. A figure whose
-- traces are raw file columns should follow the data. A figure plotting DERIVED metrics must pin
-- the extractor version, or the figure in a paper silently changes the day someone bumps the
-- extractor -- the same rule 0111 applies to measurement_metrics rows.
create table if not exists vault.figures (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique,
  title         text not null,
  description   text,
  spec          jsonb not null,

  -- Null means "always the current extractor". Set it for anything published.
  pinned_extractor_version text,

  created_by    text,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Shape guards. Deliberately NOT a full schema check -- the spec must stay forward-compatible
  -- for panel and trace options this migration has not imagined, the same rule that keeps
  -- device_tests.metrics accepting unknown keys. But the two things every reader assumes are
  -- structural: panels is an array, and it is not empty.
  --
  -- The coalesce is NOT decoration. `jsonb_typeof(spec -> 'panels')` is SQL NULL when the key is
  -- ABSENT, and a CHECK constraint PASSES on null -- so the bare comparison accepted
  -- '{"layout":"1x1"}', a figure with no panels at all, and only the empty-array case was ever
  -- caught. Verified on PG 17: the row inserted. This is the same nulls-are-not-false trap that
  -- makes `unique (measurement_id, file_id, extractor_version)` enforce nothing in 0111 and
  -- keeps device_tests.measurement at '' instead of null.
  constraint figures_spec_panels_array
    check (coalesce(jsonb_typeof(spec -> 'panels'), 'missing') = 'array'),
  constraint figures_spec_panels_nonempty
    check (jsonb_array_length(spec -> 'panels') > 0)
);

create index if not exists figures_created_by_idx on vault.figures (created_by);
create index if not exists figures_updated_at_idx on vault.figures (updated_at desc);

-- Which sources a figure depends on, expanded out of the spec. A jsonb trace cannot carry a
-- foreign key, so a deleted file leaves a reference that renders as an empty panel and reads as
-- a plotting bug. This view makes the dangling reference a QUERY -- so the figure page can say
-- "3 of 4 traces resolved" instead of quietly drawing three.
create or replace view vault.figure_sources as
select f.id as figure_id,
       f.title,
       (panel.ordinality - 1)::int as panel_index,
       (trace.ordinality - 1)::int as trace_index,
       trace.value -> 'src' ->> 'file_id'    as file_id,
       trace.value -> 'src' ->> 'capture_id' as capture_id,
       trace.value ->> 'label'               as label,
       case
         when trace.value -> 'src' ->> 'file_id' is not null
           then exists (select 1 from vault.files vf
                         where vf.id = (trace.value -> 'src' ->> 'file_id')::uuid)
         when trace.value -> 'src' ->> 'capture_id' is not null
           then exists (select 1 from public.captures c
                         where c.capture_id = trace.value -> 'src' ->> 'capture_id')
         else false
       end as source_exists
  from vault.figures f
  cross join lateral jsonb_array_elements(f.spec -> 'panels') with ordinality panel
  cross join lateral jsonb_array_elements(coalesce(panel.value -> 'traces', '[]'::jsonb))
       with ordinality trace;

-- security_invoker is load-bearing on every view here: without it the view runs as owner and
-- punches straight through the RLS-enabled-no-policies invariant, which is the only thing
-- standing between a non-bypassing role and the whole table.
alter view vault.figure_sources set (security_invoker = on);

create or replace function vault.touch_figure() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('vault.actor', true), ''),
                             vault.current_email(), new.updated_by, old.updated_by, 'api');
  return new;
end $fn$;

drop trigger if exists figures_touch on vault.figures;
create trigger figures_touch before update on vault.figures
  for each row execute function vault.touch_figure();

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
alter table vault.units        enable row level security;
alter table vault.column_units enable row level security;
alter table vault.figures      enable row level security;
-- RLS enabled with NO POLICIES, as on every other table here. That works ONLY because the
-- service roles hold BYPASSRLS. Get it wrong and nothing errors: PostgREST returns [] for every
-- table, the API reports success, and the vault looks empty rather than unauthorised.
grant select on vault.units, vault.column_units to vault_read, vault_service;
grant insert, update, delete on vault.units, vault.column_units to vault_service;
grant select on vault.figures, vault.figure_sources to vault_read, vault_service;
grant insert, update, delete on vault.figures to vault_service;

select vault.rebuild_flat_views();

commit;
