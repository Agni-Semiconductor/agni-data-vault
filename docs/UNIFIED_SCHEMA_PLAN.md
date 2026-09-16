# Unified schema and cutover plan

> **What this is.** The field-by-field union of every source of measurement data Agni has —
> the Clarius corpus and its sample registry, the hosted vault, the hosted `fedbench` project,
> and the bench Pi's own workspace — mapped onto one schema in the `fedbench` cluster on
> edaserver, and the ordered set of steps that moves every datapoint across with a count or a
> hash proving it arrived. Written 2026-09-16 from `docs/METADATA_FIELDS.md`, `docs/SCHEMA_UNION.md`,
> the bench DDL, and a read of the live Pi.
>
> **The one finding that reshapes the design.** The bench's `dut_id` is the socket, not the
> chip. `2kb-dut-01` has hosted five physical parts since August — `Sili_2kB_1`, `High_T_Sili_1`,
> `Agni_Sili_3`, `Silitronics_RT_CPGA_128x`, and `2kb_dut_01` itself — and the only places their
> identity is recorded are the manifest's `device.dut` string (23 of 40 manifests) and the
> `tested/<part>.txt` ledgers. No table on either side holds it. `vault.dut_sample_map`, keyed on
> `dut_id`, cannot express it and would attach five chips' measurements to one sample. Sample
> identity for bench data is therefore resolved **per run**, from evidence, with a human
> confirming each alias once. Everything else in this plan is additive; that one is a correction.

## 0. Sources, sizes, and what is already true

| Source | What it is | Size | Where it stands |
|---|---|---|---|
| S1 Clarius corpus | `Agni/data` workbooks + `Model/samples.yaml` registry | 4,289 MB | Backfill tool exists (`cli/backfill.py`, `cli/import_samples_yaml.py`); fields inventoried in `METADATA_FIELDS.md` |
| S2 Bench, Pi workspace | `/srv/fedbench/bench_data/2kb-dut-01` | 1.4 GB · 26,486 captures · 56 runs · 26,499 ledger lines · 117 sessions | One copy, never backed up; ~161 MB never uploaded |
| S3 Bench, hosted archive | frozen pull of the hosted `fedbench` project | 904 MB · 25,786 objects · 51,671 rows | On the vault volume; seeding tool proven in a container, never run |
| S4 Hosted vault | the old Supabase vault project's rows | unknown | No export tool exists; nothing migrated |
| Live cluster | `vault` + `public` + `connect` on edaserver | vocab seeds only | Schema proven a superset of S3 and S4 (`tests/schemaUnion.test.ts`) |

Two things are settled and are not re-argued here: the two halves stay in their own schemas
(`public` for the bench, `vault` for the vault) joined by the three links in migration `0108`;
and every write of an inferred value carries `meta_status` and `evidence`, or goes to the
review queue instead. This plan adds fields and tables; it does not move or rename existing ones.

## 1. The unified entity model

Seven entities. Each source field in §2 lands on exactly one of them.

| Entity | Table(s) | Grain | Identity |
|---|---|---|---|
| **Sample** | `vault.samples` (+ new `vault.sample_aliases`) | one fabricated chip or wafer piece | `sample_id`; aliases resolve bench part names and registry variants to it |
| **Device** | `vault.devices`, `vault.device_aliases` | one physical device or array cell on a sample | `(sample_id, address_scheme, device_address)`; bench cells carry `grid_row, grid_col, bench_dut_id` |
| **Measurement** | `vault.measurements` ↔ `public.campaign_runs` | one probing session, workbook, or campaign run | uuid; bench runs also `(bench_run_id, bench_dut_id)` |
| **Capture / File** | `vault.files` ↔ `public.captures`, `public.k4200_files`, `public.artifacts` | one object | `(bucket, storage_path)`; bench pointers are read-through |
| **Metric** | `vault.measurement_metrics` ⊇ view over `public.device_tests` + `public.cell_analysis` | one figure of merit per capture per extractor version | `(measurement_id, file_id, extractor_version)` |
| **Run analysis** | `public.run_analysis`, `vault.figures`, `vault.cohorts` | one versioned summary per run | `(dut_id, run_id, extractor_version)` |
| **Provenance** | new `public.bench_sessions`, `public.bench_events`, `public.bench_configs`; objects under `bench/sessions/…` | what the bench did, saw, and was configured as | session id; content sha256 for configs |

## 2. Field map: every source field and where it lands

Legend for **Action**: `have` already lands typed; `jsonb` lands but only inside a JSON blob;
`add` needs a column, table, field definition or vocabulary value; `fix` lands wrong today;
`lossy` is flattened into free text and must stop being.

### 2a. Sample registry `Model/samples.yaml` (S1) → `vault.samples`

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `id`, `label`, `family`, `owner`, `notes` | columns | same | have |
| `stack.<role>.material`, `t_nm` | `stack[]` layer | same | have |
| `stack.<role>.deposition.method`, `power_W`, `T_C` | concatenated into layer `notes` | layer fields `method`, `power_w`, `temp_c` | **lossy → add** |
| `stack.<role>.origin` | layer `notes` | layer field `origin` (vocab `locations`, free text allowed) | **lossy → add** |
| `stack.fe.sc_frac` | `meta.sc_frac` | layer field `composition` on the `fe` layer, promoted column `stack_fe_sc_frac` | add |
| `growth.institution`, `growth.date` | `fab_location` (3 hard-coded matches) else `meta.fab_location_raw`; `fabricated_on` | same, plus vocab values for the unmatched institutions | add vocab |
| `pad.diameter_um_default`, `pad.shape` | `meta.pad_diameter_um_default`, `meta.pad_shape_default` | declared sample fields (same keys) so they can pre-fill a measurement's `pad_*` | add field defs |
| `T_meas_C_default` | `meta.t_meas_c_default` | declared field | add field def |
| `folders` | `meta.folders` | declared field, `json` | add field def |
| `paper`, `doi` | `meta.paper`, `meta.doi` | declared fields | add field defs |
| `status.*` (ASSUMED/UNKNOWN) | `meta_status` | same | have |

### 2b. Clarius corpus (S1) → `vault.measurements`, `vault.files`

Fully inventoried in `METADATA_FIELDS.md`; every key there has a declared field. Gaps found:

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `columns`, `executed_at`, `run_numbers` | declared | same | have |
| Clarius `Settings` sheet beyond the eight keys the backfill reads | dropped | `files.parsed.settings` (whole sheet as JSON) | add to backfill |
| raw `.h5` from the 4200A share | not in the vault at all; bench keeps sha only | `files.kind` gains `raw_h5`, `raw_xlsx`; bench `k4200_files` becomes a `bucket='bench'` pointer target | add vocab + pointer |

### 2c. Bench campaign manifest (S2, S3) → `public.campaign_runs` and the vault

The manifest is the operator's spec verbatim plus system keys, and the whole thing is stored in
`campaign_runs.manifest`. Nothing is lost; much is untyped.

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `run_id`, `dut_id`, `name`, `kind`, `status`, `started_at`, `completed_at`, `settle_ms`, `plan.*`, `quarantine.scope`, `instrument.{source,identity,module,module_sha256,parameters}`, `verdict_policy`, `result.*` | typed columns | same | have |
| **`device.dut`** (part name, e.g. `Sili_2kB_1`) | `manifest` jsonb only | **`vault.sample_aliases` → `samples.sample_id`**; sets `measurements.sample_id` for the registered run | **add table + resolver** |
| `device.alscn_thickness_nm`, `interlayer_material`, `interlayer_thickness_nm`, `back_electrode_material` | jsonb | sample `stack[]` layers (`fe`, `il_bot`, `bottom_metal`); written once per sample with evidence `E1 manifest`, conflicts to review queue | add to resolver |
| `device.alscn_site`, `interlayer_site`, `back_electrode_site` | jsonb | layer field `origin` (vocab: add `penn`) | add |
| `device.beol` | jsonb | sample field `beol` (bool) | add field def |
| `device.device_area_um2` | jsonb | `measurements.pad_area_override` on the registered run | add to register |
| `measurements[]` (steps: `label`, `kind`, `module`, `primary`, `parameters`, `settle_s`) | jsonb | `measurements.kind` = primary step's kind; declared field `bench_steps` (json) listing the steps | add field def |
| `column_units` | jsonb | `vault.column_units` (registry already exists; `current_mA` is non-SI and must be tagged as such) | add rows |
| `breakers.*`, `notify.*` | jsonb | stay in `manifest`; exposed through `measurement_bench_run` | have |
| `operator` | column, free text | `measured_by` via a `people` alias map | add alias rows |
| `board_config`, `config_sha256`, `safety_sha256`, `module_sha256` | path + hash only; content not stored | **`public.bench_configs(sha256, kind, path, content, first_seen)`** filled from the repo's `rpi/configs/*` and `safety_*.yaml` by hash | **add table** |
| `_*_note` keys (operator prose) | jsonb | `notebook_entries` rows tagged `spec_note`, one per run, so they are searchable | add ingest |
| `schema` | jsonb | `campaign_runs.manifest_schema` (int) so a future writer change is visible | add column |

### 2d. Capture CSV header (S2, S3) → `public.captures.meta`

The lib-format header is a full JSON object and lands whole in `captures.meta`. Retained; the
receiver-format header does not.

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `source, op, kind, x_col, y_col, units, run_id, seq, row, col, cell, relays, verdict, cause, instrument, module, module_sha256, parameters, thresholds, metrics, elapsed_s, started_at, ended_at, scalars` | `meta` jsonb | same; `kind`, `grid_row`, `grid_col`, `campaign_run_id` already promoted | have |
| `dut` (part name) | `meta` | resolved through `sample_aliases` at run level; not duplicated per capture | have via 2c |
| `device.*` | `meta` | as 2c | have via 2c |
| `scalars.*` (`v1_rise`, `i1_rise`, … per segment) | `meta` | `metric_definitions` rows so they are queryable through the metrics view | add catalogue |
| receiver-format captures (`# key: value` multi-line) | **`meta={}`, wrong `columns`, `n_rows` off by one** | parse multi-line headers; re-sync affected rows (upsert is idempotent) | **fix** |

### 2e. Cell ledger `cells.jsonl` (S2, S3) → `public.device_tests`

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `run_id, seq, row, col, relays, status, verdict, cause, quarantined_by, suspect, capture_id, elapsed_s, error, started_at, ended_at, measurement` | columns | same | have |
| `metrics.{i_max_a, i_at_vread_a, r_low_bias_ohm, v_first_limit, frac_limit, compliance_hit, n_points}` | columns | same | have |
| `metrics.{i_at_vread_rev_a, rectification, compliance_checked, pts}` | `metrics` jsonb | `metric_definitions` rows; surfaced by the metrics view | add catalogue |

### 2f. Campaign analysis (S2 only; never uploaded) → `public.cell_analysis`, `public.run_analysis`, `public.artifacts`

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `campaign_analysis.csv` columns | tables exist, ingest exists, **nothing schedules it** | same, via a timer that walks `campaigns/*/analysis/` | **add timer** |
| `analysis_cache.jsonl.{ec_plus_prom, method}` | dropped (ingest reads the CSV) | `cell_analysis.ec_plus_prom`, `cell_analysis.method` | add columns |
| `analysis.json.{histograms, grid, lines, pins, pads, classes, reclassified, thresholds, ledger_bytes, n_captures, method_version}` | not stored | `run_analysis.summary` already keeps `summary.json`; add `run_analysis.detail` jsonb for `analysis.json` minus per-cell arrays | add column |
| `analysis/*.png`, `wl_*_sparse/` | not stored | `artifacts` rows, `kind='image'`, `storage_path artifacts/<dut>/<run_id>/analysis/<file>` | add watcher pass |
| `plots/<run_id>/cell_r###c###.png` (141 MB) | not stored | `artifacts` rows, `storage_path artifacts/<dut>/<run_id>/plots/<file>` | add watcher pass |

### 2g. Sessions, events, history (S2 only) → new provenance tables

| Field | Today | Unified destination | Action |
|---|---|---|---|
| `sessions/<id>/session.jsonl` (`ts, kind, op, ok, approval, request_id, requested, executed, clamped, rejection, failsafe, error, capture_ref, duration_s, board_status, safety_sha256, warnings, data`) | Pi only | **`public.bench_events(session_id, dut_id, ts, kind, op, grid_row, grid_col, ok, rejection, failsafe, clamped, error, request_id, capture_ref, payload)`**; raw file also stored as object `bench/sessions/<dut>/<id>/session.jsonl` | **add table + ingest** |
| `sessions/<id>/events.jsonl` (`ts, kind, online, reason, status.*, relays_open_sent, stim_off_sent, event`) | Pi only | same table, `kind` prefixed `event:` | add |
| session summary | none | **`public.bench_sessions(session_id, dut_id, started_at, ended_at, board_id, fw, proto, safety_sha256, n_ops, n_rejections, n_failsafes)`** derived on ingest | add table |
| `history.sqlite.ops` (36,117 rows: `id, ts, session_id, op, row, col, verdict, capture_ref, params, summary`) | Pi only; **`ts` is mixed epoch-float and ISO** | `bench_events` with `source='history'`; normalise `ts` on ingest; campaign ops de-duplicate against `device_tests` by `capture_ref` | add ingest + **fix ts** |
| `history.sqlite.cell_history` | **0 rows; the GUI heatmap reads this table** | GUI reads `ops` (or the two writers converge) | **fix in bench repo** |
| `tested/<part>.txt` | Pi only | object `bench/tested/<dut>/<part>.txt`; its **filename is evidence for `sample_aliases`** | add + use |
| `console.log`, `progress.json`, `inflight.json`, `slack.json`, `cells.csv` | Pi only | `console.log` → object per run; the rest derivable, not stored | add (console only) |
| `slack_outbox.jsonl` | Pi only, never replayed | object per run, plus an alert when non-empty | add |
| `dut.json` (`dut_id, created`) | `dut_metadata` only on manual MCP call | automatic watcher pass | add pass |
| `notebook.jsonl` | `notebook_entries` | same | have |
| `calibration/cal_*.json` (`v_read, col_offset_mA, g_min_uS, g_max_uS, linearity, board_id, timestamp, device_model`) | absent on this Pi; code writes it | **`public.bench_calibrations(dut_id, board_id, ts, v_read, g_min_us, g_max_us, linearity, col_offset_ma, device_model)`** when present | add table |
| suite runs | **synchronous write, no spool; lost on outage** | local `suites.jsonl` spool + watcher pass, same as every other kind | **fix** |

### 2h. Hosted vault rows (S4) → `vault.*`

Every column exists (proven). What is missing is any tool to move them. §3 Phase 4.

### 2i. Hosted bench rows and objects (S3) → `public.*`

Every column exists (proven). `tools/seed_primary.py` moves them. §3 Phase 3.

## 3. Vocabularies and units

| List | Add | Why |
|---|---|---|
| `instruments` | `k4200a_kxci`, `relay_board_2kb` | bench runs KXCI modules, not Clarius; identity strings like `KI4200A V1.9` go to declared field `instrument_identity` |
| `materials` | `hfox` | `HfOx` in the registry and the manifests is not `hfo2`; mapping it would assert stoichiometry nobody measured |
| `locations` | `penn` | manifests say `Penn` without distinguishing QNF from the lab; a parent value beats a guess |
| `people` | alias map `operator` string → value | bench `operator` is free text |
| `file_kinds` | `raw_h5`, `raw_xlsx`, `config_json`, `safety_yaml`, `session_log` | new object classes |
| `measurement_kinds` | none; `dciv_wake` is a step *label* with kind `dciv` | keep `kind` clean; the label lives in `bench_steps` |
| `layer_roles` | none | `il_bot` covers the interlayer; `bottom_metal` the back electrode |
| `column_units` | `current_mA → mA (non-SI, display only)`, `i_a → A`, `v_applied → V`, `v_meas → V`, `charge_c → C`, `time_s → s` | the bench's own `column_units` block |
| `metric_definitions` | `i_at_vread_rev_a, rectification, compliance_checked, pts, ec_plus_prom, ec_minus_strength, ec_minus_lo, ec_minus_hi, n_cycles_resolved, v{1,2}_{rise,fall}, i{1,2}_{rise,fall}, t{1,2}_{rise,fall}` | every metric name any writer emits, so the metrics view has no untyped residue |

SI is the rule on both sides already. `current_mA` and the `ops.summary.current_mA` derivative
are display values and never become metric rows.

## 4. Schema changes, all additive

Vault migrations `0120`–`0123`, bench migration `2026-09-17_provenance.sql`. Each guarded
`if not exists`, each wrapped in a transaction, each covered by `tests/migrationChain.test.ts`
and `tests/schemaUnion.test.ts` (which must keep passing: nothing here removes anything).

| Migration | Contents |
|---|---|
| `0120_sample_identity.sql` | `vault.sample_aliases(alias text pk, sample_id fk, scheme check in ('bench_part','registry','folder'), basis text, confirmed_by, confirmed_at)`; `vault.bench_run_sample(run_id, dut_id, sample_id, basis, evidence jsonb, confirmed_by, pk(run_id,dut_id), fk → campaign_runs)`; `dut_sample_map` gains a comment declaring it a *default* consulted last |
| `0121_stack_and_fields.sql` | layer shape extended to `{role, material, t_nm, composition, method, power_w, temp_c, origin, notes}` (CONTRACT §4 bump); promoted `samples.stack_fe_sc_frac`; field definitions for `beol`, `paper`, `doi`, `folders`, `pad_diameter_um_default`, `pad_shape_default`, `t_meas_c_default`, `bench_steps`, `instrument_identity`; vocab rows from §3 |
| `0122_metrics_catalogue.sql` | `metric_definitions` rows; `column_units` rows; view `vault.cell_metrics` = `measurement_metrics` ∪ (`device_tests` as `extractor_version='bench_verdict_v1'`) ∪ (`cell_analysis` as `'campaign_analysis_v1'`), joined to `vault.devices` through `bench_run_sample`; `security_invoker = on` |
| `0123_connect_additions.sql` | `connect.devices`, `connect.events` summary view; `connect.samples` gains the promoted stack columns |
| bench `2026-09-17_provenance.sql` | `bench_sessions`, `bench_events`, `bench_configs`, `bench_calibrations`; `cell_analysis.ec_plus_prom`, `.method`; `run_analysis.detail`; `campaign_runs.manifest_schema`; RLS on, no policies, grants to `bench_service`, select to `vault_service` |

## 5. Cutover: ordered, gated, counted

Every phase ends with a number that must match a number recorded before it started. The
numbers for S2 are already in §0; the others are taken in Phase 0.

**Phase 0 — Freeze the figures.** Hosted vault: row counts per table through its REST API and
a `pg_dump -Fc --schema=public` via the pooler, the exact pattern `ARCHIVE_RUNBOOK.md` Phase C
uses for the bench. Corpus: `backfill/scan.json`. Pi: the §0 counts, re-taken the day of.
*Gate:* every source has a written count. Nothing moves before this.

**Phase 1 — Second copy of the Pi.** `rsync -a --link-dest` of `/srv/fedbench/bench_data` to
`/storage/vault/fedbench/pi-mirror/<date>` on edaserver, on a timer, before any other phase.
1.4 GB; minutes. The `loadtest.bin` on the Pi's data partition is 8.1 GB of test writes and
is Owen's to delete.
*Gate:* `rsync --checksum --dry-run` reports zero differences.

**Phase 2 — Schema.** Apply §4. Run the vault test suite and the bench offline tests.
*Gate:* `schemaUnion`, `migrationChain`, `envVarParity` green; migration ledger shows 24.

**Phase 3 — Bench rows and objects from the archive.** `tools/seed_primary.py --full-hash`
(WP3 in the testbench plan), then top up the ~700 captures and ledger lines newer than the
archive from the Pi mirror.
*Gate:* `captures` = 26,486; `device_tests` = 26,499 ledger lines; `campaign_runs` = 56;
every capture's sha256 matches the Pi file.

**Phase 4 — Vault rows from hosted.** Restore the Phase 0 dump data-only into `vault.*` with the
same dependency-ordered `-L` list and `--single-transaction` `seed_primary.py` uses. Vault objects
(`samples/<id>/<uuid>/<name>`) pulled with the same archiver into `objects/vault/`.
*Gate:* per-table counts equal the Phase 0 counts; `files.sha256` matches every object.

**Phase 5 — The Pi-only classes.** From the mirror, in this order: `bench_configs` from the repo
by hash; `bench_events`/`bench_sessions` from 117 sessions and 36,117 ops; `artifacts` from
`plots/` and `analysis/*.png`; `cell_analysis`/`run_analysis` via `ingest_analysis.py` for all
24 analysed runs; `tested/`, `console.log`, `slack_outbox.jsonl` as objects; `dut_metadata`.
*Gate:* `bench_events` = 10,577 session lines + 36,117 ops − campaign duplicates (count the
duplicates first and write the expected total); artifacts = files on disk; 24 `run_analysis` rows.

**Phase 6 — Identity.** Build `sample_aliases` from the five `tested/` part names and the
`device.dut` strings, each row confirmed by Owen with a note. Populate `bench_run_sample` for all
56 runs: manifest `device.dut` (E1) → `tested_file` name (E2) → `dut_sample_map` default (E4) →
review queue. Then `register_bench_runs.py`, extended to set `sample_id`, `pad_area_override`,
`bench_steps`, `instrument_identity`, and to write the sample's stack layers once from the
`device` block. Then materialise `vault.devices` for every distinct `(sample, row, col)`.
*Gate:* zero runs with an unresolved sample that are not in the review queue; device count equals
distinct cells per resolved sample.

**Phase 7 — Corpus backfill.** `BACKFILL_PLAN.md`, unchanged, now against a schema that can hold
the registry without flattening it. `import_samples_yaml.py` rewritten to write the extended
layer fields instead of concatenating them into notes.
*Gate:* every registry key in §2a lands in a typed field; `review_queue` holds the rest.

**Phase 8 — The bench flip and the new passes.** WP6 in the testbench plan (Pi env → edaserver)
plus the watcher gains passes for `plots/`, `analysis/`, `sessions/`, `dut.json`, and a suites
spool; the receiver-format header parser is fixed and affected captures re-synced.
*Gate:* one full campaign on the new endpoint produces rows in every table §2 names.

**Phase 9 — Retire.** The hosted archive's final pull and the five timers (WP4). Hosted vault
project frozen the same way, with its final dump id recorded.

## 6. Verification that outlives the cutover

- **`tests/fieldInventoryParity.test.ts`** (new): parses the tables in `METADATA_FIELDS.md` and
  asserts every `key` is either a column named in `CONTRACT.md` §5 or a `field_definitions` row
  seeded by a migration. The doc and the database can no longer drift apart silently.
- **`tests/schemaUnion.test.ts`**: unchanged, keeps failing if a source column is ever dropped.
- **`tools/field_coverage.py`** (new, testbench repo): for every destination field in §2, the
  percentage of rows non-null per source, printed as one table. Run after Phases 3–7 and kept
  with the cutover record. A field at 0 % that §2 says should be populated is a bug, not a gap.
- **Restore drill** re-run after Phase 5, since the volume now holds classes it did not before.

## 7. Decisions taken, and the ones left open

Taken here: sample identity is per run, not per socket; `HfOx` is its own material; provenance
becomes rows *and* objects because 4.5 MB of logs is cheap to type and expensive to lose;
everything is additive.

Open, and Owen's to call: whether `penn` as a location is acceptable or every `Penn` should go to
the review queue; whether `bench_events` keeps `history.sqlite` ops that duplicate a ledger line
or drops them after the counts reconcile; and the five alias rows themselves, which need a
human's name on them.
