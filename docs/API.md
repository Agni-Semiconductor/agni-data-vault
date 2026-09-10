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
