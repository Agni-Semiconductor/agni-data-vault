# Agni Data Vault API

## Start here

Base URL: `https://vault.agnisemi.ai/api` publicly or the edaserver tailnet API origin. Send `Authorization: Bearer <VAULT_API_KEY>` for machine clients, or authenticate through Cloudflare Access in a browser. Fetch `GET /api/schema` first: it lists routes and the CURRENT field definitions because fields are data.

## Conventions

- JSON keys and query names are `snake_case`; IDs are UUID strings. Dates are `YYYY-MM-DD`, timestamps are ISO-8601 UTC, and numbers are JSON numbers.
- Lists return `{ "items": [], "total": 0, "warnings": []? }`; single records return `{ "sample|measurement|file|field_definition|option_list|option_value": {}, "warnings": []? }`; deletes return `{ "deleted": true, "id": "..." }`.
- Unknown body keys are ignored and reported in `warnings[]`. A PATCH `expected_updated_at` mismatch returns 409.

## Environment

Server: `VAULT_REST_URL`, `VAULT_STORAGE_URL`, `VAULT_SERVICE_JWT`, `VAULT_API_KEY`, `VAULT_IDENTITY_*`, `VAULT_ADMIN_BOOTSTRAP`, `VAULT_READONLY`.
Client: `VITE_API_BASE_URL` only, and it is not secret. Removed: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

| HTTP | Error code | Meaning |
|---|---|---|
| 400 | `invalid_body`, `invalid_id`, `invalid_date`, `empty_patch` | Request cannot be read |
| 401 | `unauthorized` | Missing or invalid Bearer key |
| 404/405 | `not_found`, `unknown_route`, `method_not_allowed` | Missing record or route/method |
| 409 | `conflict`, `duplicate_file` | Concurrent update or duplicate SHA-256 |
| 422 | `validation_failed` | Field validation; inspect `error.details` |
| 500 | `db_error`, `internal` | Server failure |

## Data model

1. A sample is a fabricated chip or wafer piece.
2. A measurement belongs to one sample.
3. A file belongs to one measurement.
4. Field definitions determine where and how values are stored.
5. A definition with `column_name` stores in that row column.
6. One without it stores at `meta.<key>`.
7. `meta_status` records `confirmed`, `assumed`, or `unknown` provenance by key.
8. `sample_id` is a human key; resource `:id` also accepts it where documented.
9. `stack` is a bottom-up array of layers.
10. Each layer is `{role, material, t_nm, notes}`.
11. `role` is `substrate|bottom_metal|il_bot|fe|il_top|top_metal|other`.
12. Read active definitions and option lists from `/schema` before writing dynamic fields.

## Routes

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/` , `/schema` | — | section 8 |
| GET | `/samples` | `q, family, substrate, fab_location, meta.<key>=<v>, sort=<key>, order=asc|desc, limit<=200 (default 50), offset` | `{items,total}` |
| POST | `/samples` | sample fields (section 6) minus id/timestamps | 201 `{sample, warnings?}` |
| GET/PATCH/DELETE | `/samples/:id` | `:id` = uuid **or** `sample_id`; PATCH partial + `expected_updated_at?` | `{sample}` / `{deleted}` |
| GET/POST | `/samples/:id/measurements` | GET: `kind, measured_by, from, to, sort, order, limit, offset`; POST: measurement fields | `{items,total}` / 201 `{measurement}` |
| GET/PATCH/DELETE | `/measurements/:id` | GET `?include=files` adds `files: []` | `{measurement}` |
| GET | `/measurements/:id/files` | — | `{items,total}` |
| POST | `/files/upload-url` | `{measurement_id, filename, size_bytes, sha256}` | 201 `{file_id, storage_path, upload_url:"/api/files/<id>/content", method:"PUT"}`; 409 `duplicate_file` if sha256 exists for that measurement |
| PUT | `/files/:id/content` | raw bytes, streamed | `{file}` with `upload_state: "ready"`; filename parsing applies |
| GET | `/files/:id/content` | — | raw bytes with stored `Content-Type` and `Content-Disposition` |
| GET | `/files/:id/download` | — | `{url:"/api/files/<id>/content", expires_at:null}` |
| POST | `/files` | `{measurement_id, filename, content_base64}` <= 50 MB | 201 `{file}` (ready) |
| DELETE | `/files/:id` | — | `{deleted}` (object + row) |
| GET/POST | `/field-definitions` | GET `?entity=&include_inactive=1`; POST row (section 5) minus id/timestamps | `{items,total}` / 201 `{field_definition}` |
| GET/PATCH/DELETE | `/field-definitions/:id` | DELETE = set `active=false` (never hard delete) | |
| GET | `/option-lists` | — | `{items:[{key,label,description,values:[...]}],total}` |
| GET/POST | `/option-lists/:key/values` | GET `?include_inactive=1`; POST `{value,label,sort_order?,meta?}` | |
| PATCH/DELETE | `/option-values/:id` | DELETE = `active=false` | |
| GET | `/stats` | — | `{samples, measurements, files, bytes, by_kind:{dciv:n,...}, recent:[{measurement_id,sample_id,measured_on,kind}]}` |

| GET | `/me` | — | `{principal:{kind,actor}}` |

### Bench (read-only)

The vault holds `SELECT` on the bench's tables and nothing more, and the object store refuses a
bench write independently. The router also refuses every non-GET here — three guards saying the
same thing, deliberately.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/bench/duts` | — | `{items}` |
| GET | `/bench/runs` , `/bench/runs/:runId` | `dut_id, limit, offset` | `{items,total}` / `{run}` |
| GET | `/bench/coverage` | `dut_id, run_id` | cells plus `legend`, `colors`, `verdict_codes` — **the palette is served with the data so the client cannot invent either**. Five classes, not six: `no_signal` and `indeterminate` both map to code 2. |
| GET | `/bench/cells` | `dut_id, run_id, limit, offset` | `{items,total}` |
| GET | `/bench/analysis/cells` | | `{items,total}` |
| GET | `/bench/lines` | `dut_id, run_id?` | `{rows, cols, ramp}`. Each line is `{line, measured, bad, rate, net?, pin?}` — `net`/`pin` come from `vault.board_pin_map` when the board has one. **`rate` is `null`, never `0`, for a line with no measured cells**: "we did not look" and "we looked and it was fine" are different statements, and the crossbar renders the first as grid. |
| GET | `/bench/captures/:captureId/content` | — | raw bytes |

### Upload and review (E1)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/uploads/analyze` | `{paths:[...]}` | per-path evidence classes and proposed groups. **Extracts, never writes.** |
| POST | `/uploads/commit` | `{sample_id, groups:[...]}` | writes only `confirmed` values; everything uncertain goes to the review queue |
| GET | `/review-queue` | `status, entity, field, limit, offset` | `{items,total}` |
| POST | `/review-queue/:id/accept` , `/review-queue/:id/reject` | | `{item}` |

### Plotting and figures (E7)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/kinds` | — | `{items, units, column_units}` in **one** response. **Units are per COLUMN, not per axis** — the bench emits both `i_a` (amperes) and `current_mA`, and reading one as the other is a 1000× error that looks like data on a log axis. Read-only. |
| GET/POST | `/figures` | GET `q, sort, order, limit, offset`; POST `{title, spec, description?, slug?, pinned_extractor_version?}` | `{items,total}` / 201 `{figure}` |
| GET/PATCH/DELETE | `/figures/:id` | `:id` = uuid **or** slug | `{figure, sources}` / `{deleted}` |

`GET /figures/:id` returns `sources`, so a trace pointing at a deleted file is **visible** rather
than drawn as a blank panel. A jsonb trace cannot carry a foreign key; this is how you tell a
missing source from a plotting bug.

### Cohorts (E5)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/cohort-keys` | — | `{group_keys, metrics}` — migration-authored allow-lists. Read-only, and `sql_expr` is never returned. |
| GET/POST | `/cohorts` | GET `q, sort, order, limit, offset`; POST `{name, predicate, metric?, group_by?, ...}` | `{items,total}` / 201 `{cohort}` |
| GET/PATCH/DELETE | `/cohorts/:id` | `:id` = uuid **or** slug | `{cohort}` / `{deleted}` |
| POST | `/cohorts/summary` | `{predicate, metric, group_by, extractor_version?}` or `{cohort_id}` | `{groups, total_members, excluded}` |
| POST | `/cohorts/correlation` | same, plus `max_points?` (≤ 2000) | `{fit_space, ledger, fit, points, points_sampled}`. **Continuous grouping keys only** — a categorical key is a 422 naming `group_by`, not a cast to zero. `fit_space` is `log10_y` when the metric declares `log_scale` and `raw` otherwise; a `log10_y` slope is **decades per x unit**. Two ledgers balance: `n_members = n_with_metric + n_no_metric_row + n_refused` and `n_with_metric = n_fit + n_no_x + n_nonpositive_y`. The scatter may be thinned; **the fit never is**, so `sxx`/`syy`/`sxy`/`avg_x` travel with it and a client draws the full fit's band from a partial scatter. |

Every group carries **three numbers, and a result that omits any of them is incomplete**: `n`; an
exclusion ledger that balances (`n_members = n_with_metric + n_no_metric_row + n_refused`); and
the **provenance of the grouping key** (`status_confirmed` / `assumed` / `unknown` /
`unspecified`). The metric can be impeccable while the thing you grouped *by* was assumed.

Membership is resolved **in full**, not one page — a median over an arbitrary 50 measurements
looks entirely correct. Above 50,000 it refuses rather than truncating.

### Devices (E4)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET/POST | `/devices` | GET `sample_id, address_scheme, q, sort, order, limit, offset`; POST `{sample_id, device_address, notes?}` | `{items,total}` / 201 `{device}` |
| GET | `/devices/:id` | — | `{device, aliases, counts}` |
| GET | `/devices/:id/history` | `from, to, event_kind, limit<=500 (default 200), offset` | `{items,total}`, oldest first |
| POST | `/devices/:id/aliases` | `{alias_address, alias_scheme, reason}` | 201 `{alias}`; **422 unless the principal is human** |
| DELETE | `/devices/:id/aliases/:aliasId` | — | `{deleted}` |
| POST | `/devices/register-bench` | `{dut_id}` | `{created}`; 422 naming `dut_id` when it is unmapped |
| GET | `/verdict-changes` | `dut_id, direction, from, to, sort, order, limit, offset` | `{items,total}` |

`POST /devices` creates a **`vault_label`** device only — `address_scheme`, `grid_row`,
`grid_col` and `bench_dut_id` in the body are all a 422. Grid coordinates are a claim about die
geometry and must come from `device_tests`.

**An alias is the only thing that merges two device histories**, so it must carry a person: a
machine principal is refused. The bench labels a cell `D116_116` and the vault extracts `D116`;
merging those on a prefix would fabricate history.

### Search (E6)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/search/ask` | `{question}` (<= 500 chars) | `{url, entity, filters, explanation, unknown_terms, query_id}` **or** `{refusal, unknown_terms, query_id}` |
| POST | `/search/:id/accepted` | — | `{ok}` |
| GET | `/search/history` | `q, refused, limit, offset` | `{items,total}` |

**The agent reads the schema and emits a filter. It never sees a measurement row** — so a note
reading "ignore previous instructions" has nowhere to land. **The URL is the answer**: the reply
is a real filter you can open, edit and re-run, and the agent is never the only path to a result.
A refusal is a correct outcome, not an error. 503 `agent_unavailable` means no API key is
configured on that server.


## Worked examples

Set `API=https://vault.agnisemi.ai/api` and `AUTH="Authorization: Bearer <VAULT_API_KEY>"`. Replace IDs printed by the calls.

Create a sample with a four-layer stack and provenance.
```bash
curl -sS -X POST "$API/samples" -H "$AUTH" -H 'content-type: application/json' -d '{"sample_id":"HfN_20_0421","label":"HfN / 20 nm AlScN / Al","stack":[{"role":"substrate","material":"Sapphire","t_nm":null,"notes":""},{"role":"bottom_metal","material":"HfN","t_nm":100,"notes":""},{"role":"fe","material":"AlScN","t_nm":20,"notes":""},{"role":"top_metal","material":"Al","t_nm":null,"notes":""}],"meta_status":{"stack":"assumed"}}'
python cli/vault.py add-sample --sample-id HfN_20_0421 --label 'HfN / 20 nm AlScN / Al' --stack '[{"role":"substrate","material":"Sapphire","t_nm":null,"notes":""},{"role":"bottom_metal","material":"HfN","t_nm":100,"notes":""},{"role":"fe","material":"AlScN","t_nm":20,"notes":""},{"role":"top_metal","material":"Al","t_nm":null,"notes":""}]' --assumed stack
```

Add a DC-IV measurement; `sweep_v` is a meta field.
```bash
curl -sS -X POST "$API/samples/HfN_20_0421/measurements" -H "$AUTH" -H 'content-type: application/json' -d '{"measured_on":"2026-09-09","kind":"dciv","run_numbers":[4482],"pad_shape":"circle","pad_dim_um":25,"meta":{"sweep_v":18}}'
python cli/vault.py add-measurement --sample HfN_20_0421 --measured-on 2026-09-09 --kind dciv --pad circle 25 --run-numbers 4482 --sweep-v 18
```

Upload a Clarius `.xlsx`: request an upload-url, then PUT bytes to the returned relative URL with the same authorization header. `register` is optional because the PUT marks the file ready.
```bash
SHA=$(sha256sum clarius.xlsx | awk '{print $1}'); R=$(curl -sS -X POST "$API/files/upload-url" -H "$AUTH" -H 'content-type: application/json' -d "{\"measurement_id\":\"<MEASUREMENT_UUID>\",\"filename\":\"clarius.xlsx\",\"size_bytes\":$(wc -c < clarius.xlsx),\"sha256\":\"$SHA\"}"); URL=$(python -c 'import json,sys; print(json.load(sys.stdin)["upload_url"])' <<<"$R"); curl -sS -X PUT -H "$AUTH" -H 'content-type: application/octet-stream' --upload-file clarius.xlsx "${API%/api}$URL"
python cli/vault.py upload <MEASUREMENT_UUID> clarius.xlsx
```

Download a file through the authenticated content endpoint.
```bash
curl -sS -H "$AUTH" "$API/files/<FILE_UUID>/content" -o clarius.xlsx
```

Inline-upload a small file.
```bash
curl -sS -X POST "$API/files" -H "$AUTH" -H 'content-type: application/json' -d "{\"measurement_id\":\"<MEASUREMENT_UUID>\",\"filename\":\"small.csv\",\"content_base64\":\"$(base64 -w 0 small.csv)\"}"
python cli/vault.py upload <MEASUREMENT_UUID> small.csv
```

Filter measurements by metadata, then sort samples by a meta field.
```bash
curl -sS -H "$AUTH" "$API/samples/HfN_20_0421/measurements?kind=dciv&meta.sweep_v=18"; curl -sS -H "$AUTH" "$API/samples?sort=anneal_temp_c&order=desc"
python cli/vault.py list measurements --sample HfN_20_0421
```

Add a number meta field; it appears in `/schema` immediately.
```bash
curl -sS -X POST "$API/field-definitions" -H "$AUTH" -H 'content-type: application/json' -d '{"entity":"sample","key":"anneal_temp_c","label":"Anneal temperature","type":"number","unit":"C","required":false,"sort_order":90,"group_name":"Process","active":true,"column_name":null,"show_in_table":true,"filterable":true}'
python cli/vault.py fields --entity sample
```

Add an option value, then retire a field definition (soft delete).
```bash
curl -sS -X POST "$API/option-lists/materials/values" -H "$AUTH" -H 'content-type: application/json' -d '{"value":"hfn","label":"HfN","sort_order":100}'; curl -sS -X DELETE "$API/field-definitions/<FIELD_DEFINITION_UUID>" -H "$AUTH"
python cli/vault.py fields --entity sample
```

## Gotchas

- Inline and streamed files have a 50 MB object limit.
- Upload URLs are relative authenticated API paths, not signed storage URLs.
- SHA-256 deduplication is per measurement.
- JSONB numeric sorting is text until the field is promoted to a column.
- `sample_id` is accepted in place of a UUID for sample resource IDs.
- Server storage and PostgREST credentials stay on edaserver; guard the API key.

## Where things live

`server/vault-api.mjs` is the production API server.  
`api/_lib/fieldDefs.js` validates data-driven fields.  
`api/_lib/resources/*` implements each API resource.  
`supabase/migrations/` contains schema, RLS, seeds, storage, and hardening migrations.  
`cli/` contains the Python client and its usage guide.
