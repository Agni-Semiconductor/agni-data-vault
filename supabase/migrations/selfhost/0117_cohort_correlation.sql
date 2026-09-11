-- E5's continuous view: metric vs a continuous grouping key, with a fit.
--
-- THE FIT SPACE IS A DECISION, TAKEN 2026-09-11, NOT A DEFAULT.
-- The fit runs on log10(y) when the metric declares `log_scale`, and on raw y otherwise.
-- `onoff`, `j_max_a_cm2` and leakage span DECADES, and an ordinary least squares line over raw
-- values there is dominated by the largest few points: it reports a slope that describes three
-- devices and draws it across four hundred. `metric_definitions.log_scale` already records which
-- metrics are which, so this is a LOOKUP, not a heuristic, and the choice travels in the
-- response as `fit_space` so a reader never has to guess which space a slope is in.
--
-- X IS ALWAYS RAW, deliberately and as a stated limitation. The decision named the metric, and
-- widening it to the x axis silently would change what a published slope means. A log-x variant
-- belongs in cohort_group_keys as an attribute, not inferred here from how the numbers spread.
--
-- WHY THE REGRESSION SUMS TRAVEL. Returning only slope and intercept would force the confidence
-- band to be recomputed from the SCATTER -- and the scatter is capped (see below), so the band
-- would describe a different population than the line drawn through it. Returning `sxx`, `syy`,
-- `sxy`, `avg_x` and `n` lets a client draw the exact band for the FULL fit from a partial
-- scatter. The alternative, fitting twice in two languages, is two definitions of one number.
--
-- WHY THERE IS NO p-VALUE. A cohort here is whatever matched a predicate -- a convenience
-- sample, not a random one -- and a p-value over it invites exactly the over-reading this view
-- exists to prevent. `n`, the slope's standard error and R^2 are returned instead; they say the
-- same thing without the false licence.
begin;
set local search_path = vault, extensions;

create or replace function vault.cohort_correlation(
  p_measurement_ids   uuid[],
  p_metric            text,
  p_group_by          text,
  p_extractor_version text default null,
  p_max_points        integer default 2000
) returns jsonb language plpgsql stable as $fn$
declare
  g record; md record; sql text; result jsonb;
begin
  select * into g from vault.cohort_group_keys where key = p_group_by;
  if not found then
    raise exception 'unknown group key %', p_group_by using errcode = '22023',
      hint = 'group keys are a migration-authored allow-list; see vault.cohort_group_keys';
  end if;
  -- A correlation needs a NUMBER on the x axis. Refusing here, rather than casting whatever a
  -- categorical key happens to produce, is what stops `fab_location` being plotted as zero.
  if g.value_kind <> 'continuous' then
    raise exception 'group key % is categorical; a correlation needs a continuous x axis', p_group_by
      using errcode = '22023', hint = 'use cohort_summary for a categorical grouping key';
  end if;
  select * into md from vault.metric_definitions where metric = p_metric;
  if not found then
    raise exception 'unknown metric %', p_metric using errcode = '22023',
      hint = 'see vault.metric_definitions';
  end if;
  if p_max_points is null or p_max_points < 1 then
    raise exception 'p_max_points must be a positive integer' using errcode = '22023';
  end if;

  -- One row per MEMBER first, exactly as cohort_summary does: a measurement with two metric rows
  -- (two files, one measurement) would otherwise be counted twice and weight the fit twice.
  --
  -- The x cast is guarded by a regex on the TEXT form rather than attempted and caught.
  -- `sql_expr` is an arbitrary migration-authored expression and nothing guarantees a continuous
  -- key yields a parseable number for every row; an unguarded cast turns one bad row into a
  -- failed request for the whole cohort, and Postgres has no try_cast.
  sql := format($q$
    with member as (
      select distinct on (m.id)
             m.id,
             (%s)::text as x_text,
             coalesce(nullif(m.meta_status->>%L, ''), s.meta_status->>%L, 'unspecified') as status,
             mm.id is not null as has_row,
             mm.%I as value
        from vault.measurements m
        join vault.samples s on s.id = m.sample_id
        left join vault.measurement_metrics mm
               on mm.measurement_id = m.id
              and (%L is null or mm.extractor_version = %L)
       where m.id = any($1)
       order by m.id, mm.computed_at desc nulls last
    ), typed as (
      select id, status, has_row, value,
             case when nullif(trim(x_text), '') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
                  then trim(x_text)::double precision end as x
        from member
    ), classed as (
      select typed.*,
             value is not null                   as has_value,
             value is not null and x is not null as has_x,
             -- A log fit cannot take y <= 0, and a dead device legitimately reads 0 for onoff.
             -- That is real data this axis cannot show, NOT an absent measurement, so it gets
             -- its own bucket instead of being folded into "no metric".
             value is not null and x is not null
               and (not %L::boolean or value > 0) as fittable
        from typed
    ), ledger as (
      select count(*)                                          as n_members,
             count(value)                                      as n_with_metric,
             count(*) filter (where not has_row)               as n_no_metric_row,
             count(*) filter (where has_row and value is null) as n_refused,
             count(*) filter (where has_value and not has_x)   as n_no_x,
             count(*) filter (where has_x and not fittable)    as n_nonpositive_y,
             count(*) filter (where fittable)                  as n_fit
        from classed
    ), fitted as (
      select regr_slope(yv, x)     as slope,
             regr_intercept(yv, x) as intercept,
             regr_r2(yv, x)        as r2,
             regr_count(yv, x)     as n,
             regr_avgx(yv, x)      as avg_x,
             regr_avgy(yv, x)      as avg_y,
             regr_sxx(yv, x)       as sxx,
             regr_syy(yv, x)       as syy,
             regr_sxy(yv, x)       as sxy
        from (select x, case when %L::boolean then log(10, value::numeric)::double precision
                             else value end as yv
                from classed where fittable) t
    ), ranked as (
      -- Ordered by X, not by id, before thinning. Keeping the first N rows by id hands back a
      -- scatter covering part of the x range while the line was fitted across all of it -- a
      -- picture that disagrees with its own caption and looks entirely fine.
      select id, x, value, status,
             row_number() over (order by x, id) as rn,
             count(*) over ()                   as total
        from classed where fittable
    ), sampled as (
      -- `rn = total` is not tidiness. Every k-th rank starting at 1 never reaches the LAST one
      -- unless the count divides exactly -- 40 points thinned by 10 gives ranks 1, 11, 21, 31 and
      -- silently drops the largest x. The scatter would then stop short of where the fitted line
      -- keeps going, which is the precise failure the ordering above exists to prevent.
      select id, x, value, status from ranked
       where total <= %s or (rn - 1) %% greatest(1, ceil(total::numeric / %s)::bigint) = 0 or rn = total
       order by x, id
    )
    select jsonb_build_object(
      'metric',    %L,
      'group_by',  %L,
      'fit_space', case when %L::boolean then 'log10_y' else 'raw' end,
      'x_unit',    %L,
      'y_unit',    %L,
      'ledger',    to_jsonb(ledger),
      -- Two points define a line and say nothing about anything. The band needs n - 2 degrees of
      -- freedom and a non-zero spread in x. Null here means "not enough to fit", which the UI
      -- states rather than drawing a line through three points as though it meant something.
      'fit',       case when fitted.n >= 3 and fitted.sxx > 0 then to_jsonb(fitted) end,
      'points',    coalesce((select jsonb_agg(jsonb_build_object(
                               'measurement_id', id, 'x', x, 'y', value, 'status', status))
                             from sampled), '[]'::jsonb),
      'points_returned', (select count(*) from sampled),
      'points_sampled',  (select count(*) from sampled) < ledger.n_fit
    ) from ledger, fitted
  $q$, g.sql_expr,
       coalesce(g.status_key, '__none__'), coalesce(g.status_key, '__none__'),
       md.column_name,
       p_extractor_version, p_extractor_version,
       md.log_scale, md.log_scale,
       p_max_points, p_max_points,
       p_metric, p_group_by, md.log_scale, g.unit, md.unit);

  execute sql into result using p_measurement_ids;
  return result;
end $fn$;

comment on function vault.cohort_correlation(uuid[], text, text, text, integer) is
  'Metric vs a continuous grouping key, with an OLS fit on log10(y) for log-scale metrics and on '
  'raw y otherwise -- the choice is returned as fit_space, never left implicit. Two ledgers '
  'balance: n_members = n_with_metric + n_no_metric_row + n_refused, and n_with_metric = n_fit + '
  'n_no_x + n_nonpositive_y, so no point leaves the fit uncounted. The regression sums travel so '
  'a client can draw the full fit''s confidence band from a thinned scatter.';

grant execute on function vault.cohort_correlation(uuid[], text, text, text, integer) to vault_read, vault_service;

select vault.rebuild_flat_views();

commit;
