# The schema union — what the unified cluster preserves, and what it does not

> **Question this answers:** the endpoint replaces two Supabase projects — the vault and `fedbench`.
> Does every table and column those two had still exist, so that no metadata is dropped when their
> rows are finally imported? **Yes, on both halves, verified 2026-09-16.** The union is a strict
> superset: 39 tables, nothing removed, nothing retyped.
>
> **What that does *not* mean:** no rows have been imported yet, on either half, and a large class
> of data the Pi produces has never reached Postgres at all. Those are §4 and §5, and they are the
> parts worth reading.

## 1. The shape of the union

One PostgreSQL cluster, `fedbench`, holds both halves in separate schemas. `PGRST_DB_SCHEMAS` is
`public,vault,connect` with `public` first, so an unqualified request still reaches the bench
exactly as it did on hosted Supabase.

| Schema | Origin | Tables | Owner of the rows |
|---|---|---|---|
| `public` | the hosted `fedbench` project | 14 | the bench — `duts`, `captures`, `campaign_runs`, `device_tests`, `suite_runs`, `notebook_entries`, `artifacts`, … |
| `vault` | the hosted vault project | 25 | the vault — `samples`, `measurements`, `files`, `field_definitions`, `devices`, `cohorts`, … |
| `connect` | new | 7 views | nothing; a read interface for other products |
| `bench_storage` | new | 1 | the object store's metadata half |

Neither half was rewritten to accommodate the other. The vault's tables moved from `public` to
`vault` and are otherwise byte-identical in definition; the bench's stayed in `public`.

## 2. The proof that nothing was lost

`tests/schemaUnion.test.ts` parses the hosted vault DDL (`supabase/migrations/000*.sql`) and the
unified DDL (`supabase/migrations/selfhost/01*.sql`) and asserts that every hosted table and every
hosted column still exists. It runs in CI on every pull request. The equivalent check for the bench
half belongs in `ferrodiode-pcb-testbench`, where that DDL lives; the result below was produced by
the same comparison run by hand on 2026-09-16.

| Comparison | Before | After | Tables lost | Columns lost |
|---|---|---|---|---|
| hosted vault → `vault` | 8 tables, 90 columns | 25 tables, 260 columns | 0 | 0 |
| hosted `fedbench` → `public` | 11 tables, 153 columns | 14 tables, 195 columns | 0 | 0 |

Everything added is additive: `updated_by` audit columns, the promoted `stack_fe_material` and
`stack_fe_t_nm`, the three join columns in §3, and fifteen new vault tables (kinds, metrics, units,
figures, cohorts, devices, the review queue, OAuth). On the bench side, `cell_analysis`,
`run_analysis` and `bench_storage.objects`.

A note on how that was established, because it nearly went wrong. The first parser matched
`alter table … add column` and reported both halves clean — while silently missing every column
after the first in a multi-column `ALTER`. That hid `vault.measurements.bench_run_id`, half of the
bench join key. The test now pins the multi-column case, counts `CREATE TABLE` statements against
tables parsed, and asserts that no definition went unclassified, because a parser blind spot and an
absent column look identical in a green test.

## 3. Where the two halves actually join

A union of schemas is not a union of data. Three things connect them, all in migration `0108`:

1. **`vault.measurements.bench_run_id` + `bench_dut_id`** — a real foreign key to
   `public.campaign_runs (run_id, dut_id)`, `ON DELETE RESTRICT`. `vault.measurement_bench_run`
   resolves the join, because PostgREST will not auto-embed across schemas.
2. **`vault.files.bucket`** — a vault file row may point at `bucket='bench'` and be served
   read-through from the bench's own objects. 16,821 campaign CSVs are referenced, not copied.
   Those rows are read-only in the vault, refused twice.
3. **`vault.dut_sample_map`** — bench `2kb-dut-01` and vault `HfN_20_0421` are unrelated
   namespaces with no derivation between them. **This table is filled in by hand**, via
   `cli/import_dut_map.py` from a YAML file with a stated basis per row. It is currently empty.
   Until it has rows, bench measurements and the physical samples they came from are not linked,
   and no schema change fixes that.

## 4. No rows have moved yet — on either half

The schema is ready. The data is not. As of 2026-09-16:

- **The bench half has a seeding tool and has never been run.** `tools/seed_primary.py` in the
  testbench repo restores the archive dump into the live database, syncs the blobs and proves the
  result. It is container-tested against PostgreSQL 17.10 with the real schema, positive and
  negative. There is no `state/last_seed.json` on the box, and the tool refuses a target that
  already holds rows — consistent with a database that is still empty.
- **The vault half has no seeding tool at all.** `seed_primary.py` restores `--schema=public`
  only. Nothing in either repo exports the hosted vault's rows or imports them into `vault.*`. The
  vault tables hold vocabulary seeds from the migrations — 32 field definitions, 28 units, 14
  cohort group keys, 11 metric definitions — and no measurement data.
- **The archive is 2.75 GB, not 50 GB.** 26,787 files under `/storage/vault/fedbench-archive`,
  of which the object tree is 904.0 MB in 25,786 files, manifest `supabase_20260911T060720Z`.
  The only 50 GB on edaserver is `/storage/home/shared/PDKs`, which is EDA tooling and unrelated.
- **The live object store holds 1,693 files** under `/srv/fedbench/objects` — service scaffolding,
  not the archive's 25,786 objects. Loading them is step 2 of the seeding tool.
- **The archive has never been proven restorable.** `fedbench-verify` has never started;
  `state/last_restore_verify.json` does not exist. Separately, `verify_archive.py`'s table-parity
  check passes vacuously without a live REST source — it reports "11 tables agree" having compared
  nothing. The seeding tool compares against the manifest itself for that reason.

## 5. What the Pi produces that no schema here will ever hold

This is the larger gap, and it is not a schema problem. Everything that reaches Postgres is put
there by one process — `CloudSyncWatcher` in `server/src/fed_instruments/watcher.py` on the Pi —
which makes six passes: captures, campaigns, K4200 exports, notebooks, presets, artifacts. Anything
outside those six passes stays on the Pi's disk in exactly one copy.

**Reaching Postgres:** campaign measurement CSVs (blob + `captures` row), the campaign manifest in
full (`campaign_runs.manifest`), the per-cell ledger (`device_tests`, resumed by byte offset),
notebook entries, skill-run outputs, converted K4200 workbooks, and preset library. Uploads are
deferred on a 30-second poll with a two-tick stability guard, exponential backoff to 600 seconds,
and idempotent upserts; the workspace itself is the spool.

**Never reaching Postgres,** in rough order of how much unique information is lost:

1. **Campaign analysis output** — figures, `analysis.json`, `summary.json`, `analysis_cache.jsonl`.
   The `cell_analysis` and `run_analysis` tables exist and `tools/ingest_analysis.py` can fill
   them, but nothing schedules it: the service unit is a `oneshot` hardcoded to a single run id
   with no timer.
2. **Per-cell figures** from `--plot-cells` — written to `/tmp`, posted to Slack, then left for the
   OS to clear. Roughly 1,200 figures and 150 MB a night.
3. **Session op and event logs** — the only record of rejections, clamps, timeouts, link-downs,
   board faults and failsafe attempts.
4. **`history.sqlite`** — per-cell op history, in two schemas written by two different stacks.
5. **Board-side captures on the Pico's flash** — read-through on demand, never written to the
   workspace. A `capture_ref` in a session log can point at data that exists only on the
   microcontroller.
6. **AI calibration data** — sense-chain offsets, conductance rails, the fitted device model. This
   is the instrument-characterisation basis for every matvec result.
7. **HWA characterisation bundles, fitted device parameters, trained weight artifacts** — written
   to an operator-chosen path, by default the working directory.
8. **Agent panel transcripts** — only the summary survives, as a notebook entry.
9. **`dut.json`** — reaches `dut_metadata` only on an explicit MCP call, never from the watcher.
   At archive time there were 2 `dut_metadata` rows against 3 `duts`.
10. **Raw Clarius `.h5` bytes** — excluded by design; only the sha256, size and mtime are kept,
    plus the lossy `.xlsx` conversion.
11. **Board config and safety policy content** — only the path and two sha256 values are recorded.
    Tamper-evident, but not reconstructable.
12. Saved-but-never-run campaign specs, agent scripts, skill-run *inputs*, the tested-cell ledger,
    `console.log`, and the Slack outbox of messages Slack refused and nothing replays.

Two of these are worth separating from the rest, because they are not merely unsynced:

- **Suite runs are the only synchronous write path**, and failures are swallowed with no retry and
  no local file. A suite run executed while the endpoint is down is simply lost.
- **Captures written through the receiver path upload with corrupt metadata** — empty `meta`, a
  nonsense `columns` array, `n_rows` off by one, and null `kind`/`grid_row`/`grid_col` — while the
  blob itself is byte-correct. The two capture writers disagree about how many `#` header lines a
  file has.

Nothing on the Pi is ever deleted after upload, and no rsync of the Pi's workspace to edaserver
exists in either repo. So for everything in this list, the Pi's own disk is the only copy.

## 6. Free-form metadata: the parts no DDL constrains

The union above is a union of *columns*. A significant amount of metadata lives in `jsonb`, where
no schema check applies and where a key can be dropped without any test noticing:

| Half | Table | Columns |
|---|---|---|
| vault | `samples` | `stack`, `meta`, `meta_status` |
| vault | `measurements` | `meta`, `meta_status` |
| vault | `files` | `parsed` |
| vault | `review_queue` | `candidate_value`, `evidence_seen` |
| vault | `field_definitions`, `option_values`, `cohorts`, `figures`, `agent_queries`, `audit_log`, `measurement_metrics` | `default_value`, `meta`, `predicate`, `spec`, `filters`, `diff`, `extra` |
| bench | `campaign_runs` | `params`, `thresholds`, `manifest`, `counts` |
| bench | `captures`, `dut_metadata`, `notebook_entries` | `meta` |
| bench | `device_tests` | `metrics` |
| bench | `suite_runs`, `suite_run_steps`, `preset_library` | `params`, `result` |
| bench | `run_analysis` | `summary`, `counts`, `best_cell`, `onoff`, `vread`, … |
| bench | `k4200_files` | `sheets` |

The vault's own answer to this is `field_definitions`: a key promoted to a declared field gets a
label, a type, a unit and an option list, and appears in the form, the table and the filter bar.
`meta.external` is the cautionary case — documented as the bench pointer, never implemented, and
superseded by the real foreign key in §3. The rule the bench states for itself is the right one
here too: stop writing a superseded key, keep reading it, and let the column be authoritative.

## 7. Re-running this check

```bash
npx vitest run tests/schemaUnion.test.ts
```

It fails if a migration ever removes a table or column that the hosted vault had. If one must go,
the honest move is to migrate the rows somewhere first and then change the assertion in the same
commit, so the deletion is a decision in the history rather than a silence.
