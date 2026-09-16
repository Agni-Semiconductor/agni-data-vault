# Data Vault metadata fields (as of 2026-09-16)

Source of truth is the `field_definitions` table in the vault database (live copy: `GET /api/schema`). Adding or retiring a field is a row there, so this file is a snapshot for humans. Storage column: `column` = a real Postgres column on the entity table; `meta` = a key inside the entity's `meta` JSONB. Every field also has a provenance flag in `meta_status[key]` (`confirmed` | `assumed` | `unknown`) and, when written by the backfill tool, an `evidence[key] = {class, source}` entry.

## Sample (one fabricated chip / wafer piece)

| key | label | type | vocabulary | storage | notes |
|---|---|---|---|---|---|
| sample_id | Sample ID | text | | column | required, unique, human key (e.g. `HfN_20_0421`, `HY_20nm_highT_0827`) |
| label | Label | text | | column | |
| family | Family | text | | column | sample family / campaign name |
| owner | Owner | person | people | column | |
| stack | Device stack | layer_stack | materials (free text allowed) | column | ordered bottom-up array of `{role, material, t_nm, notes}`; roles: substrate, bottom_metal, il_bot, fe, il_top, top_metal, other |
| substrate | Substrate | select | substrates | column | |
| substrate_size | Substrate size | select | substrate_sizes | column | |
| fab_location | Fabricated at | select | locations | column | |
| fabricated_by | Fabricated by | person | people | column | |
| fabricated_on | Fabricated on | date | | column | YYYY-MM-DD |
| notes | Notes | longtext | | column | |
| batch_id | Batch | text | | meta | backfill batch that created the row (rollback handle) |
| source_folder | Source folder | text | | meta | original folder under Agni/data |
| review_needed | Review needed | bool | | meta | true when unproven fields were queued for a human |
| evidence | Evidence | json | | meta | `{field: {class: E1..E5, source}}` |

System columns on samples: `id` (uuid), `meta`, `meta_status`, `created_by`, `created_at`, `updated_at`.

## Measurement (one probing session / workbook on a sample)

| key | label | type | vocabulary | storage | notes |
|---|---|---|---|---|---|
| measured_on | Measured on | date | | column | required; backfill takes it from the instrument's `Last Executed` stamp |
| kind | Measurement kind | select | measurement_kinds | column | dciv, aciv, pund, pulse, cv, res2t, endurance, retention, other |
| measured_by | Measured by | person | people | column | |
| instrument | Instrument | select | instruments | column | |
| probe_station | Probe station | select | probe_stations | column | |
| temperature_c | Temperature | number, C | | column | chuck temperature |
| device_address | Device / address | text | | column | e.g. `D3`, `BE1 TE 1`, `WL7_15 x BL4_4` |
| run_numbers | Keithley run numbers | json (int array) | | column | e.g. `[9600, 9601, 9602]` |
| pad_shape | Pad shape | select | pad_shapes | column | circle, square |
| pad_dim_um | Pad diameter / edge | number, um | | column | diameter for circles, edge for squares |
| pad_area_override | Pad area override | number, um2 | | column | explicit area when shape/dim do not apply |
| pad_area_um2 | (generated) | number, um2 | | column | computed from shape + dim, or the override; read-only |
| sweep_v | Sweep amplitude | number, V | | meta | |
| frequency_khz | Frequency | number, kHz | | meta | |
| notes | Notes | longtext | | column | |
| replicate | Replicate | integer | | meta | replicate index from filenames like `20-DC-3` |
| thermal_history | Thermal history | text | | meta | e.g. `after 400C` for return-to-RT checks |
| test_name | Test name | text | | meta | Clarius Settings `Test Name` |
| module_name | Module name | text | | meta | Clarius Settings `Module Name` (AC/PUND user modules) |
| clarius_version | Clarius version | text | | meta | |
| executed_at | Executed at | json (ISO timestamps) | | meta | one per run sheet |
| columns | Columns | json (string array) | | meta | data-sheet header row, e.g. `["BI","AV"]` |
| source_path | Source path | text | | meta | path relative to the data root |
| batch_id | Batch | text | | meta | backfill batch id |
| review_needed | Review needed | bool | | meta | |
| evidence | Evidence | json | | meta | `{field: {class, source}}` |

System columns on measurements: `id` (uuid), `sample_id` (uuid FK), `meta`, `meta_status`, `created_by`, `created_at`, `updated_at`.

## File (one uploaded object attached to a measurement)

| key | type | notes |
|---|---|---|
| kind | select (file_kinds) | raw_xls, raw_csv, plot_png, other |
| original_name | text | as uploaded |
| storage_path | text | `samples/<sample_id>/<measurement uuid>/<name>` in the private `vault` bucket |
| size_bytes | integer | |
| sha256 | text | dedupe key per measurement |
| parsed | json | `{detected_kind, headers, n_rows, run_number, file_date, ...}` from filename regexes and client parsing |
| upload_state | text | pending, ready, failed |

System columns on files: `id`, `measurement_id`, `created_by`, `created_at`.

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

E1 instrument metadata inside the file; E2 deterministic filename tokens; E3 folder-path tokens; E4 owner declaration or the sample registry (`Model/samples.yaml`) with its own status flags; E5 deck/notes text that names the sample and states the value verbatim. Anything weaker is not written and goes to a review queue.
