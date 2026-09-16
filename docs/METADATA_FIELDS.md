# Data Vault metadata fields (snapshot 2026-09-16)

Source of truth is the `vault.field_definitions` table in the `fedbench` cluster on edaserver (the self-hosted vault; live copy via `GET /api/schema`). The hosted Supabase project carries the same base set. Adding or retiring a field is a row there, so this file is a snapshot for humans. Storage column below: `column` = a real Postgres column on the entity table; `meta` = a key inside the entity's `meta` JSONB. Every field also has a provenance flag in `meta_status[key]` (`confirmed` | `assumed` | `unknown`) and, when written by the backfill tool, an `evidence[key] = {class, source}` entry. Full column-level union of the two former Supabase projects: `docs/SCHEMA_UNION.md`.

## Sample (one fabricated chip / wafer piece) — `vault.samples`

| key | label | type | vocabulary | storage | notes |
|---|---|---|---|---|---|
| sample_id | Sample ID | text | | column | required, unique, human key (e.g. `HfN_20_0421`, `HY_20nm_highT_0827`) |
| label | Label | text | | column | |
| family | Family | text | | column | sample family / campaign name |
| owner | Owner | person | people | column | |
| stack | Device stack | layer_stack | materials (free text allowed) | column | ordered bottom-up array of `{role, material, t_nm, notes}`; roles: substrate, bottom_metal, il_bot, fe, il_top, top_metal, other |
| stack_fe_material | FE material | text | | column (promoted, self-host 0111) | derived from the `fe` layer for filtering |
| stack_fe_t_nm | FE thickness | number, nm | | column (promoted, self-host 0111) | derived from the `fe` layer |
| substrate | Substrate | select | substrates | column | |
| substrate_size | Substrate size | select | substrate_sizes | column | |
| fab_location | Fabricated at | select | locations | column | |
| fabricated_by | Fabricated by | person | people | column | |
| fabricated_on | Fabricated on | date | | column | YYYY-MM-DD |
| notes | Notes | longtext | | column | |
| review_needed | Review needed | bool | | meta (self-host 0110 / backfill) | true when unproven fields were queued for a human |
| batch_id | Batch | text | | meta (backfill) | backfill batch that created the row (rollback handle) |
| source_folder | Source folder | text | | meta (backfill) | original folder under Agni/data |
| evidence | Evidence | json | | meta (backfill) | `{field: {class: E1..E5, source}}` |

System columns: `id` (uuid), `meta`, `meta_status`, `created_by`, `created_at`, `updated_by`, `updated_at`.

## Measurement (one probing session / workbook on a sample) — `vault.measurements`

| key | label | type | vocabulary | storage | notes |
|---|---|---|---|---|---|
| measured_on | Measured on | date | | column | required; backfill takes it from the instrument's `Last Executed` stamp |
| kind | Measurement kind | select | measurement_kinds | column | dciv, aciv, pund, pulse, cv, res2t, endurance, retention, other (self-host also has table `vault.measurement_kinds` with axis/unit metadata per kind) |
| measured_by | Measured by | person | people | column | |
| instrument | Instrument | select | instruments | column | |
| probe_station | Probe station | select | probe_stations | column | |
| temperature_c | Temperature | number, C | | column | chuck temperature |
| device_address | Device / address | text | | column | e.g. `D3`, `BE1 TE 1`, `WL7_15 x BL4_4` |
| device_id | Device | uuid | | column (self-host 0114) | FK to `vault.devices`; the resolved device behind `device_address` |
| run_numbers | Keithley run numbers | json (int array) | | column | e.g. `[9600, 9601, 9602]` |
| pad_shape | Pad shape | select | pad_shapes | column | circle, square |
| pad_dim_um | Pad diameter / edge | number, um | | column | diameter for circles, edge for squares |
| pad_area_override | Pad area override | number, um2 | | column | explicit area when shape/dim do not apply |
| pad_area_um2 | (generated) | number, um2 | | column | computed from shape + dim, or the override; read-only |
| bench_run_id | Bench run | text | | column (self-host 0108) | with bench_dut_id, FK to `public.campaign_runs (run_id, dut_id)`; resolved by view `vault.measurement_bench_run` |
| bench_dut_id | Bench DUT | text | | column (self-host 0108) | bench namespace (`2kb-dut-01`); mapped to a sample only through `vault.dut_sample_map` |
| sweep_v | Sweep amplitude | number, V | | meta | |
| frequency_khz | Frequency | number, kHz | | meta | |
| notes | Notes | longtext | | column | |
| replicate | Replicate | integer | | meta (backfill) | replicate index from filenames like `20-DC-3` |
| thermal_history | Thermal history | text | | meta (backfill) | e.g. `after 400C` for return-to-RT checks |
| test_name | Test name | text | | meta (backfill) | Clarius Settings `Test Name` |
| module_name | Module name | text | | meta (backfill) | Clarius Settings `Module Name` (AC/PUND user modules) |
| clarius_version | Clarius version | text | | meta (backfill) | |
| executed_at | Executed at | json (ISO timestamps) | | meta (backfill) | one per run sheet |
| columns | Columns | json (string array) | | meta (backfill) | data-sheet header row, e.g. `["BI","AV"]` |
| source_path | Source path | text | | meta (backfill) | path relative to the data root |
| batch_id | Batch | text | | meta (backfill) | backfill batch id |
| review_needed | Review needed | bool | | meta | |
| evidence | Evidence | json | | meta (backfill) | `{field: {class, source}}` |

System columns: `id` (uuid), `sample_id` (uuid FK), `meta`, `meta_status`, `created_by`, `created_at`, `updated_by`, `updated_at`.

## File (one object attached to a measurement) — `vault.files`

| key | type | notes |
|---|---|---|
| kind | select (file_kinds) | raw_xls, raw_csv, plot_png, other |
| original_name | text | as uploaded |
| bucket | text | `vault` (uploaded here) or `bench` (self-host 0108: read-through pointer to the bench's own object; read-only in the vault) |
| storage_path | text | `samples/<sample_id>/<measurement uuid>/<name>` for vault objects; `captures/...` for bench pointers |
| size_bytes | integer | |
| sha256 | text | dedupe key per measurement |
| parsed | json | `{detected_kind, headers, n_rows, run_number, file_date, ...}` |
| upload_state | text | pending, ready, failed |

System columns: `id`, `measurement_id`, `created_by`, `created_at`, `updated_by`.

## Derived and linking tables (self-host only)

| table | columns | purpose |
|---|---|---|
| `vault.devices` | id, sample_id, device_address, address_scheme, grid_row, grid_col, bench_dut_id, notes | one row per physical device; measurements point at it via `device_id` |
| `vault.device_aliases` | device_id, alias_address, alias_scheme, reason, confirmed_by, confirmed_at | other names the same device goes by |
| `vault.dut_sample_map` | dut_id, sample_id, note | hand-filled bridge between bench DUT ids and vault sample ids (currently empty) |
| `vault.measurement_metrics` | measurement_id, file_id, kind, extractor_version, onoff, vread, ec_plus, ec_minus, pr_uc_cm2, psw, qsw, i_max_a, j_max_a_cm2, r_low_bias_ohm, noise_floor_a, n_points, n_cycles, extra, skipped, computed_at | figures of merit per measurement/file |
| `vault.metric_definitions` | metric, label, column_name, unit, log_scale, notes | catalogue of the metric columns above |
| `vault.measurement_kinds` | kind, label, x_col[], y_col[], y2_col[], x_unit, y_unit, y2_unit, abs_y, log_y, derivable[], notes | per-kind plotting/axis metadata |
| `vault.units`, `vault.column_units` | unit, quantity, si_factor, label / column_name, unit, notes | unit registry and which column carries which unit |
| `vault.cohorts` | slug, name, description, predicate (json), metric, group_by, extractor_version | saved groupings for comparisons |
| `vault.review_queue` | entity, entity_id, field, candidate_value, reason, evidence_seen, status, resolved_by, resolved_at | the sure-only backfill's "not proven" items |
| `vault.board_pin_map` | dut_id, family, line, net, pin, source, confirmed_by, confirmed_at, notes | package pin to array line mapping |
| `vault.figures` | (see 0112) | stored figure records with their sources (`vault.figure_sources` view) |

Read-only cross-product views for agni-connect: `connect.samples`, `connect.measurements`, `connect.files`, `connect.metrics`, `connect.kinds`, `connect.bench_runs`, `connect.health` (`docs/CONNECT_INTERFACE.md`).

## Vocabularies (option lists; machine value shown, labels live in the database)

| list | values |
|---|---|
| people | spencer_ware, dhiren_pradhan, harsh_yellai, owen_ledger, zachary_anderson, deep_jariwala, troy_olsson, yunfei, saroj |
| instruments | k4200a_clarius, k4200a_pmu, relay_board_8x8, other |
| probe_stations | jariwala_station, olsson_station, hot_chuck_station, other |
| locations | penn_qnf, penn_jariwala_olsson_lab, ge_aerospace, ozark, nhanced, neu, afrl, other |
| substrates | sapphire, sic, si, soi, ltcc, other |
| substrate_sizes | wafer_4in, wafer_6in, piece_1x1cm, piece_2x2cm, die, other |
| materials | alscn, albscn, aln, al, hfn, hf, pt, ni, ti, au, cr, tiw, tin, alox, hfo2, sio2, sapphire, sic |
| measurement_kinds | dciv, aciv, pund, pulse, cv, res2t, endurance, retention, other |
| pad_shapes | circle, square |
| layer_roles | substrate, bottom_metal, il_bot, fe, il_top, top_metal, other |
| file_kinds | raw_xls, raw_csv, plot_png, other |

## Evidence classes used by the backfill tool

E1 instrument metadata inside the file; E2 deterministic filename tokens; E3 folder-path tokens; E4 owner declaration or the sample registry (`Model/samples.yaml`) with its own status flags; E5 deck/notes text that names the sample and states the value verbatim. Anything weaker is not written and goes to the review queue.
