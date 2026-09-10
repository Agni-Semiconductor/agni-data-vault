# Agni Data Vault — build contract (frozen 2026-09-09)

Every worker spec references this file. It defines the shapes that multiple parts depend on. Do not change it inside a
worker task; if something here is impossible, say so in your SUMMARY and stop.

## 1. What the app is

A labelled repository of ferroelectric-diode (FeD) measurement data for Agni Semi. Hierarchy:
`samples` (a fabricated chip/wafer piece) -> `measurements` (one probing session on that sample) -> `files` (Clarius
.xls/.xlsx exports, board-campaign .csv, .png plots). Metadata fields are data, not code: a `field_definitions` table
drives the form, table columns, filter bar, `GET /api/schema`, and CLI. Adding a field = inserting a row.

Stack: Vite 7 + React 19 + TypeScript (strict) + Tailwind v4 SPA; Vercel serverless API in plain JavaScript (ESM,
Node 20+) under `api/`; Supabase Postgres + Storage + Auth (magic link, invite-only). Repo root = Vercel root.

## 2. Repo layout (each part owns only its listed files)

```
package.json vite.config.ts tsconfig.json tsconfig.node.json eslint.config.js index.html vercel.json .env.example .gitignore
supabase/config.toml  supabase/migrations/0001_core.sql 0002_rls.sql 0003_seed_vocab.sql 0004_seed_field_defs.sql 0005_storage.sql
api/handler.js
api/_lib/{auth,router,respond,validate,fieldDefs,schemaDoc,supabaseAdmin,storage}.js
api/_lib/resources/{samples,measurements,files,fieldDefinitions,optionLists,stats}.js
src/main.tsx src/App.tsx src/router.tsx src/index.css src/vite-env.d.ts
src/lib/{supabase.ts,api.ts,types.ts}
src/auth/{AuthProvider.tsx,Login.tsx,RequireAuth.tsx}
src/components/ui/{Button,Input,Select,Combobox,Modal,Table,Badge,Spinner}.tsx
src/fields/{useFieldDefs.ts,FieldInput.tsx,EntityForm.tsx,columnsFromDefs.tsx,FilterBar.tsx,StackEditor.tsx,ProvenanceChip.tsx,fixtures.ts}
src/pages/{Dashboard,SamplesList,SampleDetail,MeasurementDetail,AdminFields,AdminVocabularies}.tsx
src/plot/{QuickPlot.tsx,plotProfiles.ts,parseFile.ts,parse.worker.ts,PreviewTable.tsx}
cli/vault.py cli/import_samples_yaml.py cli/README.md cli/requirements.txt
tests/*.test.ts   docs/API.md docs/CONTRACT.md README.md scripts/smoke.sh
```

## 3. Conventions

- **snake_case everywhere**: DB columns, API JSON keys, TS object keys, CLI flags (`--measured-on` maps to `measured_on`).
  No camelCase translation layer.
- ids are uuid strings. Dates are `YYYY-MM-DD`; timestamps ISO-8601 UTC. Numbers are JSON numbers, never strings.
- API responses: list -> `{ "items": [...], "total": <int>, "warnings": [..]? }`; single -> `{ "<entity>": {...}, "warnings"?: [] }`
  where `<entity>` is one of `sample|measurement|file|field_definition|option_list|option_value`; delete -> `{ "deleted": true, "id": "..." }`;
  error -> `{ "error": { "code": "<snake_case>", "message": "<human>", "details"?: any } }` with HTTP 400/401/404/405/409/422/500.
  Unknown body keys are ignored with a warning string `unknown key "x" ignored`, never an error.
- Error codes in use: `unauthorized`, `unknown_route`, `method_not_allowed`, `invalid_body`, `invalid_id`, `invalid_date`,
  `validation_failed` (details = `[{key, message}]`), `not_found`, `conflict` (expected_updated_at mismatch), `duplicate_file`,
  `empty_patch`, `db_error`, `internal`.
- Optimistic concurrency: PATCH bodies may include `expected_updated_at`; mismatch -> 409 `conflict`.
- Auth for the API: header `Authorization: Bearer <VAULT_API_KEY>`, timing-safe compare (copy FabFlow `auth.js`).
- Env vars — server (Vercel): `VAULT_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Client (Vite): `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`. Nothing secret may start with `VITE_`.
- Test commands: `npm run typecheck` (= `tsc --noEmit -p tsconfig.json`), `npm test` (= `vitest run`), `npm run lint`, `npm run build`.
  API syntax gate: `node --check api/handler.js api/_lib/*.js api/_lib/resources/*.js`.
- Pinned deps (do not add others): react 19, react-dom 19, react-router-dom 7, @supabase/supabase-js 2, @tanstack/react-query 5,
  @tanstack/react-table 8, uplot 1.6, papaparse 5, xlsx (SheetJS 0.20.x from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`),
  lucide-react, clsx. Dev: vite 7, @vitejs/plugin-react 5, typescript 5, tailwindcss 4, @tailwindcss/vite 4, vitest 3, jsdom,
  eslint 9, typescript-eslint, @types/react, @types/react-dom, @types/papaparse. Python CLI: requests, pyyaml only.

## 4. Database (summary; full DDL is part `schema`)

`option_lists(key pk, label, description)`; `option_values(id, list_key, value, label, sort_order, active, meta)`;
`field_definitions` (see section 5); `samples`; `measurements`; `files`; `allowlist(email, role)`; `audit_log`.

Real columns that field definitions may point at via `column_name`:
- samples: `sample_id` (unique human key), `label`, `family`, `owner`, `substrate`, `substrate_size`, `fab_location`,
  `fabricated_by`, `fabricated_on`, `stack` (jsonb array), `notes`
- measurements: `measured_on`, `kind`, `instrument`, `probe_station`, `measured_by`, `temperature_c`, `device_address`,
  `run_numbers` (int[]), `pad_shape`, `pad_dim_um`, `pad_area_override`, `notes`; read-only generated `pad_area_um2`
- both: `meta` jsonb (all other fields, keyed by `field_definitions.key`), `meta_status` jsonb (`{key: "confirmed"|"assumed"|"unknown"}`),
  `created_by`, `created_at`, `updated_at`

Stack layer shape (bottom-up array): `{ "role": "substrate|bottom_metal|il_bot|fe|il_top|top_metal|other", "material": "AlScN",
"t_nm": 20, "notes": "" }`.

## 5. field_definitions row (as stored and as returned by the API, identical)

```json
{ "id": "uuid", "entity": "sample|measurement|file", "key": "temperature_c", "label": "Temperature",
  "help": "Chuck temperature during measurement", "type": "number", "options_list_key": null, "unit": "C",
  "required": false, "sort_order": 40, "group_name": "Conditions", "active": true,
  "column_name": "temperature_c", "show_in_table": true, "filterable": true,
  "min": -200, "max": 1000, "regex": null, "default_value": null,
  "created_at": "...", "updated_at": "..." }
```
`type` is one of `text|longtext|number|integer|date|bool|select|multiselect|person|layer_stack|json`. `select`, `multiselect`, `person`
require `options_list_key` (`person` is a select over list `people`). Value location rule: `column_name ? row[column_name] : row.meta[key]`.
Stored value types: text/longtext -> string, number/integer -> number, date -> "YYYY-MM-DD", bool -> boolean, select/person -> string
(the option `value`), multiselect -> string[], layer_stack -> array of layers (section 4), json -> any.

## 6. Entity JSON (API and Supabase rows are the same shape)

```json
{ "id": "uuid", "sample_id": "HfN_20_0421", "label": "HfN / 20 nm AlScN / Al", "family": "HfN_20", "owner": "dhiren_pradhan",
  "substrate": "sapphire", "substrate_size": "1x1cm", "fab_location": "penn_qnf", "fabricated_by": "harsh_yellai",
  "fabricated_on": "2026-04-15", "stack": [ {"role":"substrate","material":"Sapphire","t_nm":null},
  {"role":"bottom_metal","material":"HfN","t_nm":100}, {"role":"fe","material":"AlScN","t_nm":20}, {"role":"top_metal","material":"Al","t_nm":null} ],
  "meta": {}, "meta_status": {"stack": "assumed"}, "notes": "", "created_by": "spencer.ware@agnisemi.ai",
  "created_at": "...", "updated_at": "..." }
```
```json
{ "id": "uuid", "sample_id": "<sample uuid>", "measured_on": "2026-04-21", "kind": "dciv", "instrument": "k4200a_clarius",
  "probe_station": "jariwala_station", "measured_by": "dhiren_pradhan", "temperature_c": 25, "device_address": "D3",
  "run_numbers": [4482], "pad_shape": "circle", "pad_dim_um": 25, "pad_area_override": null, "pad_area_um2": 490.87,
  "meta": {"sweep_v": 18}, "meta_status": {}, "notes": "", "created_by": "...", "created_at": "...", "updated_at": "..." }
```
```json
{ "id": "uuid", "measurement_id": "uuid", "storage_path": "samples/HfN_20_0421/<measurement uuid>/Dhiren Site@1 ... Run4482 04-21-2026.xlsx",
  "original_name": "Dhiren Site@1 Subsite capacitor DC-IV#1 Run4482 04-21-2026.xlsx", "kind": "raw_xls", "size_bytes": 81234,
  "sha256": "hex", "parsed": {"detected_kind":"dciv","headers":["BI","BV","AI","AV"],"n_rows":273,"run_number":4482,"file_date":"2026-04-21"},
  "upload_state": "ready", "created_by": "...", "created_at": "..." }
```
Option values use machine `value` (snake_case slug) + human `label`; entity rows store the `value`.

## 7. API routes (Bearer key; base `/api`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/` , `/schema` | — | section 8 |
| GET | `/samples` | `q, family, substrate, fab_location, meta.<key>=<v>, sort=<key>, order=asc|desc, limit<=200 (default 50), offset` | `{items,total}` |
| POST | `/samples` | sample fields (section 6) minus id/timestamps | 201 `{sample, warnings?}` |
| GET/PATCH/DELETE | `/samples/:id` | `:id` = uuid **or** `sample_id`; PATCH partial + `expected_updated_at?` | `{sample}` / `{deleted}` |
| GET/POST | `/samples/:id/measurements` | GET: `kind, measured_by, from, to, sort, order, limit, offset`; POST: measurement fields | `{items,total}` / 201 `{measurement}` |
| GET/PATCH/DELETE | `/measurements/:id` | GET `?include=files` adds `files: []` | `{measurement}` |
| GET | `/measurements/:id/files` | — | `{items,total}` |
| POST | `/files/upload-url` | `{measurement_id, filename, size_bytes, sha256}` | 201 `{file_id, storage_path, signed_url, token, expires_at}`; 409 `duplicate_file` if sha256 exists for that measurement |
| POST | `/files/:id/register` | `{size_bytes?, sha256?, parsed?}` | `{file}` with `upload_state: "ready"`; server fills `parsed.run_number` (`/Run(\d+)/`), `parsed.file_date` (`/(\d{2})-(\d{2})-(\d{4})/` -> YYYY-MM-DD), `parsed.detected_kind` from filename tokens (`dc-iv|dciv|dc iv` -> dciv, `ac iv|ac-iv|aciv|hysteresis` -> aciv, `pund` -> pund, `cv` -> cv, else null) |
| POST | `/files` | `{measurement_id, filename, content_base64}` <= 4 MB | 201 `{file}` (ready) |
| GET | `/files/:id/download` | — | `{signed_url, expires_at}` (300 s) |
| DELETE | `/files/:id` | — | `{deleted}` (object + row) |
| GET/POST | `/field-definitions` | GET `?entity=&include_inactive=1`; POST row (section 5) minus id/timestamps | `{items,total}` / 201 `{field_definition}` |
| GET/PATCH/DELETE | `/field-definitions/:id` | DELETE = set `active=false` (never hard delete) | |
| GET | `/option-lists` | — | `{items:[{key,label,description,values:[...]}],total}` |
| GET/POST | `/option-lists/:key/values` | GET `?include_inactive=1`; POST `{value,label,sort_order?,meta?}` | |
| PATCH/DELETE | `/option-values/:id` | DELETE = `active=false` | |
| GET | `/stats` | — | `{samples, measurements, files, bytes, by_kind:{dciv:n,...}, recent:[{measurement_id,sample_id,measured_on,kind}]}` |

Validation (server, `api/_lib/fieldDefs.js`): `validateEntity(entity, body, {partial}) -> { columns:{}, meta:{}, meta_status:{}, warnings:[] }`
throws `ApiError(422,'validation_failed',details)` on type/required/min/max/regex/option failures. Defs cached 60 s; cache busted by
field-definition and option-value writes in the same lambda instance.

## 8. `GET /api/schema` response

```json
{ "name": "agni-data-vault", "version": "1", "conventions": { "case": "snake_case", "dates": "YYYY-MM-DD", "auth": "Bearer VAULT_API_KEY" },
  "routes": [ {"method":"GET","path":"/api/samples","query":["q","family","..."]}, "..." ],
  "entities": {
    "sample":      { "fields": [ "<field_definitions rows, active only, sorted by sort_order>" ] },
    "measurement": { "fields": [ "..." ] },
    "file":        { "fields": [ "..." ] } },
  "option_lists": { "people": [ {"value":"spencer_ware","label":"Spencer Ware"} ], "...": [] },
  "upload_flow": ["POST /api/files/upload-url", "PUT bytes to signed_url", "POST /api/files/:id/register"] }
```

## 9. Frontend contracts

- `src/lib/supabase.ts` exports `supabase` (browser client from `VITE_*` env). Browser reads/writes go **directly to Supabase**
  (RLS, user session), not through `/api`. `src/lib/api.ts` wraps Supabase calls with the same shapes as sections 6/7:
  `listSamples(params)`, `getSample(idOrSampleId)`, `createSample`, `updateSample`, `listMeasurements(sampleId, params)`,
  `getMeasurement(id)`, `createMeasurement`, `updateMeasurement`, `listFiles(measurementId)`, `uploadFile(measurementId, File)`
  (Storage upload + files row insert, sha256 via `crypto.subtle`), `getFileUrl(file)` (signed URL), `deleteFile(id)`,
  `getFieldDefs(entity, includeInactive?)`, `upsertFieldDef`, `getOptionLists()`, `upsertOptionValue`, `getStats()`.
- `src/lib/types.ts`: `FieldDef`, `FieldType`, `Entity`, `Sample`, `Measurement`, `VaultFile`, `OptionList`, `OptionValue`,
  `StackLayer`, `MetaStatus = 'confirmed'|'assumed'|'unknown'`.
- `useFieldDefs(entity) -> { defs: FieldDef[], lists: Record<string, OptionValue[]>, isLoading, error }` (TanStack Query, staleTime 60 s).
- `<FieldInput def value onChange status onStatusChange />` renders one control by `def.type`; `<EntityForm entity row onSubmit />`
  groups by `group_name`, resolves value location per section 5, calls `onSubmit({columns, meta, meta_status})`.
- `columnsFromDefs(defs, lists) -> ColumnDef<Row>[]` for defs with `show_in_table`; `<FilterBar defs lists value onChange />` where
  value is `Record<string, string|number|string[]|{min?,max?}|{from?,to?}>` mirrored into the URL query string.
- `<StackEditor value onChange materials />` edits the section-4 layer array. `<ProvenanceChip status onChange />` cycles confirmed -> assumed -> unknown.
- Routes: `/login`, `/` (Dashboard), `/samples`, `/samples/:sampleId`, `/measurements/:id`, `/admin/fields`, `/admin/vocab`.
  All but `/login` wrapped in `<RequireAuth/>`.
- UI primitives in `src/components/ui/` are the only shared components; pages compose them with Tailwind utilities.

## 10. Parsing and plotting contracts

`parseFile(file: File | ArrayBuffer, name: string) -> Promise<ParsedFile>` run inside `parse.worker.ts`:
```ts
type ParsedFile = { headers: string[]; rows: (number|string|null)[][]; n_rows: number;
  sheet?: string; sheets?: string[]; campaign_meta?: Record<string, unknown>; detected_kind: PlotKind | null; source: 'xlsx'|'xls_biff'|'xls_html'|'tsv'|'csv' }
type PlotKind = 'dciv'|'aciv'|'pund'|'pulse'|'cv'|'board_csv'|'other'
```
Sniff first bytes: `D0 CF 11 E0` -> SheetJS binary; starts with `<` -> SheetJS HTML table; `.csv` -> papaparse (if line 1 starts with
`# ` parse the remainder as JSON into `campaign_meta`, header is line 2); else TSV via papaparse with `\t`. Multi-sheet workbooks:
skip sheets named `Calc|Settings|Summary|Setup|Notes`, default to `Data` else the first remaining sheet, expose `sheets`.
`plotProfiles.ts` exports `PROFILES: Record<PlotKind, {x: string[]; y: string[]; y2?: string[]; abs_y?: boolean; log_y?: boolean}>`
with the fallbacks in order, `detectKind(headers, filename) -> PlotKind`, and `resolveSeries(parsed, kind) -> {x:number[], y:number[], y2?:number[], labels}`.

| kind | x | y | y2 | scale |
|---|---|---|---|---|
| dciv | AV, BV | AI, BI (abs) | — | log |
| aciv | Vforce | Imeas | Charge | linear |
| pund | Time, t | V | I, Psw, Qsw | linear, dual |
| pulse | t, Time | V | I | linear |
| cv | V | C | — | linear |
| board_csv | v_applied | i_a, current_mA (abs) | v_meas | log |
| other | col 0 | col 1 | — | auto |

`<QuickPlot parsed kind? />` (uPlot) with a log/linear toggle and X/Y column pickers; `<PreviewTable parsed limit=200 />`.

## 11. CLI (`cli/vault.py`, Python 3.11, requests + pyyaml)

Env: `VAULT_API_URL` (e.g. `https://agni-data-vault.vercel.app`), `VAULT_API_KEY`. Commands:
`schema`, `fields [--entity sample|measurement]`, `list samples [--q ..] [--json]`, `list measurements --sample <sample_id>`,
`add-sample --sample-id X [--<any field key> value]... [--stack '<json>'] [--assumed key,key]`,
`add-measurement --sample <sample_id> --measured-on YYYY-MM-DD [--kind ..] [--pad circle 25 | --pad square 0.22 | --area-um2 N] [--<field key> value]...`,
`upload <measurement_id> <glob>...` (sha256, upload-url -> PUT -> register; prints file ids; skips 409 duplicates with a note),
`get sample <id>`, `get measurement <id> [--files]`. Unknown `--<key>` flags are accepted if `key` is an active field for that entity
(fetched from `/schema`), else the CLI errors before calling the API. `cli/import_samples_yaml.py <path/to/samples.yaml>` maps the
registry: `id -> sample_id`, `label`, `family`, `owner`, `stack.* -> stack[]` (order substrate, bottom_metal, il_bot, fe, il_top, top_metal),
`stack.substrate -> substrate`, `growth.institution -> fab_location` (best-effort slug match, else meta.fab_location_raw), `growth.date -> fabricated_on`
(YYYY-MM -> YYYY-MM-01, mark assumed), `notes`; every key under `status:` -> `meta_status` (ASSUMED -> assumed, UNKNOWN -> unknown);
existing `sample_id` -> print `SKIP <id> exists`, never overwrite.

---

# Contract v2 — self-hosted on edaserver (amended 2026-09-10)

Sections 1–11 above describe **v1**, the hosted-Supabase build, and remain the historical record. Where v2 contradicts
v1, **v2 wins**. Everything not restated here is unchanged — in particular sections 4, 5, 6 (entity JSON), and the
`field_definitions` value-location rule are untouched, because none of them were Supabase-specific.

Workers: this file is still frozen against edits *inside a task*. If something in v2 is impossible, say so in your
SUMMARY and stop.

## v2.1 What changed and why

Both hosted Supabase projects move to one PostgreSQL 17.10 cluster on `edaserver` (RHEL 9, tailnet-only), fronted by
PostgREST and a filesystem object store. The vault's data layer is already PostgREST-shaped, so the repoint is a URL
and a key; the parts with no self-hosted equivalent are Supabase **Auth** and Supabase **Storage's signed URLs**.

Two schemas in one database:
- **`public`** — the bench tables (`captures`, `device_tests`, `campaign_runs`, `duts`, …), ported verbatim from
  `ferrodiode-pcb-testbench/server/deploy/selfhost_schema.sql`. See v2.8.
- **`vault`** — everything in section 4 above.

## v2.2 Stack (replaces the stack line in section 1)

Vite 7 + React 19 + TypeScript (strict) + Tailwind v4 SPA, **hosted on Vercel as static files only**; the API is plain
JavaScript (ESM, Node 20+) under `api/`, **served by a systemd unit on edaserver**, not a Vercel function.
PostgreSQL 17.10 + PostgREST + the `fed_storage` object store. Two front doors:

- **Public** — `vault.agnisemi.ai` via Cloudflare, Google Workspace SSO enforced by Cloudflare Access. Routes `/` to
  Vercel and `/api/*` down a Cloudflare Tunnel. Reaches **`/api/*` only**.
- **Tailnet** — Caddy on edaserver `:443`. Reaches `/api/*`, `/rest/v1/*` and `/storage/v1/object/*` for machine
  clients (the bench watcher, the CLI, MCP tools).

**PostgREST, the object store and PostgreSQL stay loopback-bound and are never published through the tunnel.**

## v2.3 Auth (replaces the auth line in section 3 and all of section 9's session model)

`requireAuth` returns a **principal**, not a boolean:

| Credential | Principal | Notes |
|---|---|---|
| `Authorization: Bearer <VAULT_API_KEY>` | `{ kind: 'machine', actor: body.created_by ?? 'api' }` | timing-safe compare, unchanged from v1. Also the break-glass path when the IdP is down. |
| A signature-verified `Cf-Access-Jwt-Assertion` | `{ kind: 'human', actor: <email> }` | verified against the Access team's public keys **and** the application `aud`. Never a trusted header. |
| neither | 401 `unauthorized` | |

- `created_by` remains client-settable for **machine** principals only (`cli/backfill.py` legitimately writes
  `created_by: 'backfill'`). A client-supplied `created_by` from a human principal is **ignored** and replaced with the
  verified email.
- Supabase Auth is gone: no magic link, no OTP, no `auth.users`, no browser session. `GET /api/me` returns the current
  principal.
- The `allowlist` table is no longer an authentication gate — Access plus the Workspace domain and `hd` claim is. It is
  renamed `people` and retained as the **role map** (`member` | `admin`), because `is_admin()` is a real distinction
  (deletes, role mutations, `audit_log` reads). A `security_invoker` view keeps the old name working.
- `audit_log.actor` and `created_by`/`updated_by` now carry a real verified identity instead of the literal `'api'`.

## v2.4 Env vars (replaces the env line in section 3)

**Nothing at all starts with `VITE_`** — stronger than v1's "nothing secret". It is a greppable CI invariant that no
credential ships in the browser bundle.

| var | where | notes |
|---|---|---|
| `VAULT_REST_URL` | server | e.g. `http://127.0.0.1:8087` |
| `VAULT_STORAGE_URL` | server | same origin as above |
| `VAULT_SERVICE_JWT` | server | HS256, `role: vault_service`, minted by `tools/mint_service_jwt.py --role` |
| `VAULT_API_KEY` | server | unchanged from v1 |
| `VAULT_IDENTITY_*` | server | Access team domain + application `aud` for JWT verification |
| `VAULT_ADMIN_BOOTSTRAP` | server | seeds the first `admin` row in `people` |
| `VAULT_READONLY` | server | when `1`, rejects POST/PATCH/DELETE — used for the phase-2 shakedown deploy |
| `VITE_API_BASE_URL` | client | **not secret**; the API origin. The only permitted `VITE_` var, and it holds no credential. |

Removed: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## v2.5 Pinned deps (amends section 3)

- `@supabase/supabase-js` stays, but becomes a **server-only** dependency. It is retained deliberately: it speaks
  PostgREST natively, so `api/_lib/resources/*` needs no changes.
- **Added:** `@tanstack/react-virtual` — 16,384 cells × 2 measurements = 32,768 rows per bench run, and the UI
  guidelines require virtualizing lists of ≥ 1,000 rows.
- Python CLI: `requests`, `pyyaml`, **and `openpyxl`** — the latter is imported by `cli/backfill.py` and was missing
  from `cli/requirements.txt`.
- Otherwise unchanged: do not add others.

## v2.6 File upload and download (replaces those rows in section 7 and `upload_flow` in section 8)

Signed URLs are gone. They exist so an untrusted browser can reach storage without a credential; behind Access and a
loopback API that premise no longer holds, and the object store has no signing primitive.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/files/upload-url` | `{measurement_id, filename, size_bytes, sha256}` | 201 `{file_id, storage_path, upload_url: "/api/files/<id>/content", method: "PUT"}`; 409 `duplicate_file` if that sha256 exists for the measurement |
| PUT | `/files/:id/content` | raw bytes, **streamed** | `{file}` with `upload_state: "ready"` |
| GET | `/files/:id/content` | — | the bytes, with the stored `Content-Type` and a `Content-Disposition` |
| GET | `/files/:id/download` | — | `{url: "/api/files/<id>/content", expires_at: null}` — kept for CLI compatibility |
| POST | `/files` | `{measurement_id, filename, content_base64}` | 201 `{file}` (ready). The 4 MB cap is lifted; the limit is now 50 MB/object. |

The three-step flow (`upload-url` → `PUT` → `register`) still works, so `cli/vault.py` keeps its shape. `register`
becomes optional, since `PUT /content` flips `upload_state` itself. `upload_flow` in the `/api/schema` response becomes
`["POST /api/files/upload-url", "PUT bytes to upload_url", "GET /api/files/:id/content to verify"]`.

In the browser, `getFileUrl(file)` is now a **pure string function** with no round trip: the session cookie rides along,
so `<img src="/api/files/x/content">` and `<a href>` work directly.

`files` gains a **`bucket`** column (`'vault' | 'bench'`, default `'vault'`), and `unique (storage_path)` becomes
`unique (bucket, storage_path)`. A row with `bucket='bench'` references an object the bench owns: it is served
read-through and is **read-only in the vault** — `DELETE /api/files/:id` returns 403 for it, and the object store
refuses deletes outside the `vault` bucket independently.

## v2.7 Frontend contracts (replaces section 9)

**`src/lib/supabase.ts` is deleted. The browser has no database client.** Section 9's clause that "browser reads/writes
go directly to Supabase (RLS, user session), not through `/api`" is **revoked**.

`src/lib/api.ts` keeps **exactly the same exported function names and shapes** as section 9 — every one becomes a
`fetch` to `/api/...`. The v1 API and browser response shapes were already identical (sections 6 and 7), so pages,
`useFieldDefs`, `columnsFromDefs`, `FilterBar` and the react-query wrappers above it are unchanged.

Consequences that are the point of the change, not side effects:
- `validateEntity` in `api/_lib/fieldDefs.js` becomes the **single** validation path. The browser previously bypassed
  it entirely.
- `parseFilenameClient`, `cleanName` and `kindFromName` are **deleted**. They had drifted from their server twins:
  `cleanName` was Unicode-aware (`/[^\p{L}\p{N} ._\-@#()]/gu`) while the server's `clean` was ASCII-only, so the same
  filename produced a different storage path depending on which client uploaded it. The server's `parseFilename` and
  `clean` are now the only copies.
- RLS is no longer the enforcement point. **The API is.** `vault_service` credentials never leave the server's
  environment file, PostgREST is loopback-only, and `vault` tables keep RLS enabled with no policies so a
  mis-provisioned role reads nothing rather than everything.

New routes to fill gaps the browser used to cover client-side:
- `GET /api/samples/:id/files` — replaces `listFilesForSample`, collapsing `1 + ceil(N/100)` browser queries into one
  server-side join.
- Numeric `meta` range filtering moves **server-side** into `api/_lib/query.js`. The v1 client-side `metaRange` branch
  silently ignored DB pagination.

Routes add `/bench` (see v2.8) and `/figures/:id` is reserved for Part 2.

## v2.8 The bench schema (new section)

The bench tables live in **`public`**, and this is load-bearing rather than incidental:

- `fed_instruments/supabase.py` sends only `apikey` and `Authorization` — **never** `Accept-Profile` — so the bench
  must be PostgREST's default profile. `PGRST_DB_SCHEMAS="public,vault"`, `public` first.
- `cloud.py` calls `rpc("bench_storage_usage")`, which is created as `public.bench_storage_usage`. PostgREST resolves
  RPC in the request's profile, so moving the bench would 404 that call and silently kill the watcher's storage
  alerting.
- Four restore tools hardcode `--schema=public`.

**This DDL is a copied wire contract. Do not redesign it, do not rename its schema, and do not "tidy" it.** Three
invariants must be preserved verbatim, each of which fails silently if broken:

1. Every table has **RLS enabled with no policies**; the service role's `BYPASSRLS` is what makes reads work. Without
   it PostgREST returns `[]` for every table, the watcher logs a clean tick, and the bench looks unmeasured rather than
   unauthorized.
2. `device_tests.measurement` is `not null default ''` — **empty string, not null** — because Postgres treats nulls as
   distinct in a unique constraint, so a nullable column lets the same cell insert twice instead of upserting.
3. `alter view … set (security_invoker = on)` on `device_coverage`; without it the view runs as owner and punches
   straight through (1).

`campaign_runs.n_measured` and its sibling counts are written at the **end** of a run. A live campaign reads 0 with
tens of thousands of child rows, so anything asking "how far has it got" must `count(*)` on `device_tests`.

The vault's access to `public` is **SELECT only**. The vault never writes bench tables.

`vault.measurements` gains `bench_dut_id` + `bench_run_id` with a composite FK to `public.campaign_runs (run_id,
dut_id)`, plus `unique (bench_run_id, bench_dut_id)` so registration is idempotent. `meta.external` is retained and
read as a fallback but no longer written.

## v2.9 Bench plotting and the coverage map (extends section 10)

`PlotKind` is unchanged; `board_csv` already targets the bench's real column names.

The coverage map is a **canvas whose backing store is literally `cols × rows`**, one device per pixel
(`fillRect(col, row, 1, 1)`), scaled up by CSS. Not a DOM grid and not a charting library — 16,384 marks make both
wrong. Hover is a `getBoundingClientRect` reverse-projection against a `Map` built once, never a per-event scan.

Two correctness invariants, not style choices:

1. **Untested cells are never painted.** Absence of fill is the signal. A neutral grey for "not visited" makes an
   untested array read as uniformly healthy.
2. **The palette is served by the API, never chosen in the frontend.** `/api/bench/coverage` returns `legend`,
   `colors` and `verdict_codes` alongside the data, mirroring what `/api/coverage` already does on the bench side. The
   values are computed colour-vision-deficiency results (OKLab ΔE ≥ 8 under Machado protan/deutan simulation) pinned by
   `tests/test_coverage_palette.py`. Picking them by eye ships a chart a deuteranope cannot read.

The codebook has **five** classes, not six: `no_signal` and `indeterminate` both map to code `2` ("suspect").

Rate charts are **bars, not lines**. Adjacent indices are independent physical wires, so a zero between two spikes is a
fact about a wire, not a dip in a signal. Empty-state panels render unconditionally **with the reason**, because a
missing panel is indistinguishable from a crash.

## v2.10 Test commands (amends section 3)

Unchanged: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and the API syntax gate
`node --check api/handler.js api/_lib/*.js api/_lib/resources/*.js` (now also `server/vault-api.mjs`).

**New gate: `npm run check:api`.** It loads the API's module graph, because neither existing gate
can. `node --check` is syntax-only and never resolves an import, and `npm test` cannot help either:
`tests/api-files.test.ts` `vi.mock`s `api/_lib/storage.js` wholesale, so the real module's exports are
never resolved by any test. On 2026-09-10 all 195 tests passed, typecheck passed and every file passed
`node --check` while the server could not boot, because three resource modules still imported exports
that had been deleted. Run this gate before believing the suite.

`scripts/smoke.sh` still walks schema → sample → measurement → upload → register → `include=files` → download →
delete → verify 404, updated for v2.6's upload flow. **That update is the test of the new flow.**

On the bench side, four test files are the regression gate for the wire contract:
`test_supabase.py`, `test_campaign_cloud.py`, `test_campaign_watcher.py`, `test_watcher_storage_alerts.py`.
**They must pass unmodified.** If they need changing, the wire protocol drifted and the premise of this migration is
gone — stop and escalate rather than editing them.
