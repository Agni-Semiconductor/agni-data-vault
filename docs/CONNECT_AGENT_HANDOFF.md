# agni-connect ↔ the vault endpoint: the operating handoff

**Audience:** the agent (or person) building and running agni-connect. This is the *how*, written
to be acted on. The *why* behind each rule is in `docs/CONNECT_INTERFACE.md` (the contract and its
reasoning) and `docs/PLATFORM_BLUEPRINT.md` (how to stand a second product up on this host). Read
those when a rule here seems arbitrary; do not read them to find permission to break one.

**As of 2026-09-16.** Everything marked *verified* was observed on `edaserver` or driven against a
real Postgres 17.10 + PostgREST + `fed_storage`. Everything else is design intent.

---

## 0. The five sentences

1. Measurement data lives in the `fedbench` database on `edaserver`. You read it through the
   **`connect` schema**: seven read-only views, and nothing else in that database is yours.
2. You read them over PostgREST at **`127.0.0.1:8087/rest/v1`** from your own API process on the
   box, with `Accept-Profile: connect` and a `connect_read` bearer token that Owen mints for you.
3. You never write to `fedbench`. agni-connect's own tables go in its **own database**
   (`agni_devops`) on the same cluster, reached over libpq, with its own migrations.
4. Nothing secret ever reaches a browser, no header is trusted without verifying its signature,
   and no path is protected by SSO alone.
5. An access mistake on this cluster returns **`[]`, not an error**. Every health check you write
   must read something that cannot legitimately be empty.

---

## 1. What is on the box, and where you fit

```
                    tailnet only, TLS                loopback only
  tailnet device ──► Caddy :443 ──┬── /rest/v1/*  ──► nginx :8087 ──► PostgREST :3000  (db fedbench: public, vault, connect)
                                  ├── /storage/v1/* ► nginx :8087 ──► fed_storage :3001 (buckets: bench, vault)
                                  ├── /healthz, /api/* ────────────► vault-api :8099   (the vault's own app API, incl. /api/mcp)
                                  └── anything else ► 404
                                                                    connect-api :8098  ◄── YOURS (not built yet)
                                                                    PostgreSQL  :5432  (cluster; databases fedbench, agni_devops[yours])
```

| Fact | Value | Status |
|---|---|---|
| Tailnet door | `https://edaserver.tailcb2a72.ts.net` | verified live 2026-09-11 |
| Bound to | `100.87.250.124`, `fd7a:115c:a1e0::2032:fa7d` only; no `:80` | verified |
| Public door (Cloudflare tunnel + Access) | **not built**, deliberately | — |
| PostgREST schemas, in order | `public,vault,connect` — `public` is the default profile | verified |
| Database | `fedbench` on PGDG PostgreSQL **17.10**, loopback `:5432` | verified |
| Your API port | **8098**, bind `127.0.0.1` | reserved in the port map; run `deploy/preflight.sh` before trusting it |
| Your database | `agni_devops` on the same cluster | not provisioned |
| Your hostnames (`devops.agnisemi.ai`, `devops.<tailnet>.ts.net`) | not allocated | — |

**Storage on the box is not your concern, and here is why you can ignore it.** As of 2026-09-16
the vault's object store, backups and cold archive are being relocated onto a reserved 512 GiB
volume at `/storage/vault` with the old paths bind-mounted back. Nothing you read changes:
`connect.files` gives you `bucket` + `storage_path`, which are **identifiers**, not filesystem
paths, and the object store resolves them. Do not ever open a path under `/srv` or `/storage`
directly; if you find yourself wanting to, you are about to build on an implementation detail that
just moved once and will move again.

The old agni-connect spec mentioned a 256 GiB encrypted LVM for measurement data. That is not
needed and does not exist. Your own database lives in the cluster's data directory on the root
mirror, like `fedbench`; you do not provision storage.

---

## 2. Which door to use, by caller

There are five ways to read measurement data. Pick by who is asking.

| Caller | Use | Auth | Notes |
|---|---|---|---|
| **connect-api** (your server process on the box) | PostgREST over loopback: `http://127.0.0.1:8087/rest/v1/<view>` | `connect_read` JWT | The primary path. Loopback, so the token never leaves the host. |
| connect-api, if you would rather write SQL | libpq to `fedbench` as a **login role granted `connect_read`** | Postgres password, `0640` env file | No `Accept-Profile` footgun; same seven views; same read-only limits. Ask Owen to create the login role. |
| A dev on a tailnet laptop, debugging | `https://edaserver.tailcb2a72.ts.net/rest/v1/<view>` | `connect_read` JWT | Same views, same header. Use the **full** hostname; `https://edaserver` can never have a valid certificate. |
| agni-connect's own model / agent | **agni-connect's own MCP server**, in connect-api at `127.0.0.1:8098/api/mcp`, reading `connect.*` | `connect_read` JWT (server-side); your own MCP key for clients | Your instructions, your tools, your context. See §7b. |
| Your agent wanting the vault's own MCP tools | `POST https://edaserver.tailcb2a72.ts.net/api/mcp` | **`VAULT_MCP_READ_KEY`** (ask Owen) | Read-only by construction (seven tools). The reader key opens only this endpoint; `VAULT_API_KEY` also opens REST writes and is never yours. See §7b. |
| Anything wanting the vault's application API (`/api/samples`, `/api/bench/*`, …) | `https://edaserver.tailcb2a72.ts.net/api/*` | `VAULT_API_KEY` | That is the vault app's surface, not yours. Nothing in it is promised to you; use `connect` instead. |

**Rule: agni-connect holds exactly one credential for measurement data, a `connect_read` token.**
If a feature seems to need `VAULT_API_KEY` or a `vault_service` token, stop and raise it; that is
a scope conversation, not a config change.

---

## 3. Credentials: what you get, where it lives, what you never do

**What you get.** An HS256 JWT with claim `{"role": "connect_read"}`, minted by Owen on the box
with `deploy/mint-connect-token.sh`, signed with the shared `PGRST_JWT_SECRET`. That script mints
`connect_read` and nothing else, and its `--prove` mode reads `connect.kinds` (must be ≥ 7 rows)
and then confirms the same token is **refused** on `vault` and `public` before any token is handed
out. You do not get the secret. You do not ask for it. Whoever holds it can mint a
`vault_service` token, which holds `BYPASSRLS` and writes every table; "read access for
agni-connect" and "unrestricted write access to all measurement data" would be the same string.

**Where it lives.** `/etc/agni-connect/api.env`, mode `0640`, owned `root:<your service user>`,
read once at process start via `EnvironmentFile=` in your systemd unit. Never in a URL, a log
line, a client bundle, a repo, or a chat message.

**Never do these.** Each one has already been an incident somewhere in this project or would be:

- **Never prefix anything with `VITE_` except `VITE_API_BASE_URL`.** Vite inlines every `VITE_`
  variable into the browser bundle as a literal. Add the CI grep test that fails on any other
  `VITE_` name (`tests/envVarParity.test.ts` here is the model).
- **Never trust `Cf-Access-Jwt-Assertion` as a header.** Verify its RS256 signature against your
  team's JWKS and check `aud` and `exp`. Strip any client-supplied `Cf-Access-*` on ingress. A
  header you trust is a header anyone reaching the origin another way can forge.
- **Never let SSO be the only gate on a path.** Machine paths take a key; human paths take a
  verified assertion; nothing is open because "Access is in front of it".
- **Never regenerate or rotate `PGRST_JWT_SECRET`.** It is shared with `fed_storage`; a new value
  gives working metadata reads and `401` on every object download, which reads as a corrupt
  archive. If your token needs rotating, ask for a new token, not a new secret.
- **Never bind connect-api to anything but `127.0.0.1`.** Caddy is the only listener off-box.

---

## 4. Reading: the exact requests

Every read is a GET to `/rest/v1/<view>` with two headers. Set both **once, centrally**, in your
HTTP client.

```bash
BASE=http://127.0.0.1:8087/rest/v1          # from connect-api on the box
# BASE=https://edaserver.tailcb2a72.ts.net/rest/v1   # from a tailnet device

curl -s "$BASE/measurements?kind=eq.pund&order=measured_on.desc&limit=50" \
  -H 'Accept-Profile: connect' \
  -H "Authorization: Bearer $CONNECT_JWT"
```

PostgREST query syntax applies: `column=eq.value`, `column=in.(a,b)`, `column=gte.2026-01-01`,
`select=col1,col2`, `order=col.desc`, `limit`/`offset`, and `Range:` headers for paging. Use
`Prefer: count=exact` when you need a total.

**Diagnosis table.** These are the responses you will actually see and what each one means.

| You see | It means | Fix |
|---|---|---|
| `404` `PGRST205` "not found in the schema cache" | You forgot `Accept-Profile: connect`; PostgREST looked in `public` | Add the header. This is not a missing view. |
| `401` `42501` with the header | Reached `connect`; no or bad token | Check the bearer. This is the *good* failure. |
| `403` "permission denied for schema …" | Your role tried to leave `connect` | You are reading something not promised to you. Stop. |
| `200 []` on a view that should have rows | Grant or RLS problem upstream, or genuinely empty | See §6. Never treat this as "no data yet" without checking `kinds`. |
| `502` on `/rest/v1` | nginx or PostgREST down | Ours; alert us. |
| `502` on `/healthz` or `/api/*` | `vault-api` down | Ours; the data plane may still be fine. |
| `PGRST125` "Invalid path" | You built `/rest/v1/rest/v1/...` | Your client already appends `/rest/v1`; give it the bare origin. |

**Verified 2026-09-11 through the full path:** without the header, `/rest/v1/kinds` returns `404`;
with it and no token, `401`; with a valid `connect_read` token, seven rows.

---

## 5. The seven views: columns and the traps in them

Columns may be **added** without notice. They are never removed or retyped without telling you
first. Select the columns you need by name so an addition cannot surprise you.

### `connect.samples`
`id` (uuid), `sample_id` (text, the human key), `label`, `family`, `substrate`, `substrate_size`,
`fab_location`, `fabricated_by`, `fabricated_on`, `stack` (jsonb, bottom-up layer array),
`stack_fe_material`, `stack_fe_t_nm`, `meta_status` (jsonb), `created_at`, `updated_at`.

**Trap:** two keys. `id` is what every foreign key uses; `sample_id` is what humans and other
systems use. Join on the wrong one and you get an empty result, not an error. Carry both.

### `connect.measurements`
`id`, `sample_id` (uuid → `samples.id`), `sample_key` (text = `samples.sample_id`, so you can
report without a join), `measured_on`, `kind`, `instrument`, `probe_station`, `measured_by`,
`temperature_c`, `device_address`, `device_id`, `pad_shape`, `pad_dim_um`, `pad_area_um2`,
`run_numbers`, `bench_dut_id`, `bench_run_id`, `meta_status`, `created_at`, `updated_at`.

**Trap:** `meta_status` is `{key: confirmed | assumed | unknown}` per row, and travels whole. A
present value is not a verified value. For anything that gets acted on, filter to `confirmed`.
An **absent** key is a fourth state (nobody recorded a confidence) and is not the same as
`unknown`; folding them together inflates how much of the corpus is trustworthy.

### `connect.files`  ← the one your MEAS records actually describe
`id`, `measurement_id`, `original_name`, `kind`, `bucket`, `storage_path`, `sha256`, `size_bytes`,
`upload_state`, `parsed`, `created_at`.

**Trap:** `upload_state` is not decoration. Rows exist in `pending` or `failed` from abandoned
uploads. Only `ready` rows have bytes. `bucket` + `storage_path` + `sha256` are stable identifiers;
store those, never a URL.

### `connect.metrics`
`id`, `measurement_id`, `file_id`, `kind`, `extractor_version`, `onoff`, `vread`, `ec_plus`,
`ec_minus`, `pr_uc_cm2`, `psw`, `qsw`, `i_max_a`, `j_max_a_cm2`, `r_low_bias_ohm`,
`noise_floor_a`, `n_points`, `n_cycles`, `skipped`, `computed_at`.

**Trap:** `skipped` is a refusal, not an absence. No metric row = never processed. A row with null
values and a `skipped` reason = processed, and the extractor declined. Averaging "rows with a
number" silently drops both and reports a mean over an unstated subset. Always carry
`extractor_version`; a number without its version is not reproducible.

### `connect.bench_runs`
`run_id`, `dut_id`, `name`, `kind`, `status`, `operator`, `instrument`, `module_sha256`,
`config_sha256`, `board_config`, `n_planned`, `n_cells_recorded`, `started_at`, `completed_at`,
`created_at`.

**Trap:** `n_cells_recorded` is counted from child rows in the view. The run's own `n_measured`
is written at the *end* of a run, so a live 86-hour campaign reports 0 with tens of thousands of
rows beneath it. The view protects you; do not go around it.

### `connect.kinds`
`kind`, `label`, `x_col`, `y_col`, `x_unit`, `y_unit`, `description`.

**Trap:** units come from here, never from your code. The bench emits both `i_a` (amperes) and
`current_mA` for the same quantity; overlaying them unconverted is a 1000× error that looks like
data on a log axis. Seeded by migration: **7 rows today**, which is why it is the liveness probe.

### `connect.health`
`n_samples`, `n_measurements`, `n_files`, `n_metrics`, `n_bench_runs`, `observed_at`. Counts taken
*through the same views you read*, so a grant fault shows as zeros rather than as a green status.

**Not reachable by any path, deliberately:** `vault.people`, `vault.allowlist`, `vault.audit_log`,
`vault.agent_queries`, every `notes` column, `created_by`/`updated_by`. `measured_by` *is* exposed;
it is a declared field with an option list.

---

## 6. Health checks that cannot lie

The loudest silent failure on this cluster: every table has RLS enabled with **no policies**, so a
role without the right grant reads **zero rows with status 200**. A check that returns
`{"ok": true}` on a 200 reports perfect health with the database unreadable.

Your dependency check on the shared data plane, in order of strength:

1. **`GET /rest/v1/kinds`** with your header and token, assert **≥ 7 rows**. This is the liveness
   probe. It cannot pass vacuously: the rows are seeded by migration and are never legitimately
   absent.
2. **`GET /rest/v1/health`** with your header and token: log the five counts as metrics and
   **alert on the numbers**, not the status. Today they are all zero because vault data has not
   been migrated from hosted Supabase yet; that is correct and is exactly why (1), not (2), is the
   probe.
3. **`GET https://edaserver.tailcb2a72.ts.net/healthz`** (no auth): the vault-api's own check,
   which reads a seeded `field_definitions` row and returns
   `{"ok":true,"checks":{"database":{"ok":true,"field_definitions":N}}}`. Useful as "is their app
   up", not as "can I read".

Do the same in your own product: your health endpoint reads a row that cannot be empty.

---

## 7. Getting bytes

`connect.files` gives `bucket`, `storage_path`, `sha256`. To fetch the object:

```
GET /storage/v1/object/<bucket>/<storage_path>
Authorization: Bearer <token with storage rights>
```

at the same origin (`127.0.0.1:8087` from the box, the tailnet hostname otherwise). Verify the
body's SHA-256 against the row; that is the point of carrying it.

**You do not have storage rights today.** `connect_read` is a PostgREST role, and `fed_storage`
authorizes per bucket and per verb with its own role set. If agni-connect needs bytes, ask; it is
a separate, explicit grant. Two buckets exist: `bench` (the testbench's captures, **read-only to
everyone outside the bench**, delete returns `405` by construction) and `vault`.

Two behaviours of `fed_storage` worth knowing, both deliberate and tested in
`ferrodiode-pcb-testbench` (a sweep on 2026-09-16 corrected an earlier claim here that they were
defects): DELETE exists but is bucket-gated, so a delete on `bench` is a `405` before any auth
check and only `vault` is deletable; and a download's `Content-Type` is derived from the file
extension (`.csv`, `.xlsx`, else guessed), not from stored metadata.

---

## 7b. MCP: agni-connect's agent gets its own server

Owen's requirement (2026-09-16): the agni-connect agent connects over MCP, and it must have
**different instructions and context** from the vault's agent.

**Why that rules out sharing the vault's endpoint.** In MCP, `instructions` and the tool list
belong to the *server*, sent once at initialize. The vault's server hardcodes its instructions
("this is the Agni measurement vault, read-only; call `vault_schema` before filtering…") and its
seven tools. A server *could* vary both by which key authenticated, but then agni-connect's agent
persona lives in the vault's codebase, changes to it are vault deploys, and its tools can only ever
be the vault's readers, which run as `vault_service` and see `vault.*`. That is the coupling the
`connect` schema exists to prevent.

**So: connect-api runs its own MCP server.** Same pattern as the vault's (`server/mcp/*.mjs` is a
reference implementation worth copying wholesale), different content:

| | vault MCP (`vault-api :8099/api/mcp`) | agni-connect MCP (`connect-api :8098/api/mcp`) |
|---|---|---|
| Owner, repo, deploy cadence | vault | agni-connect |
| `instructions` | the vault's | yours: what agni-connect is, its issue/artefact vocabulary, how it relates issues to measurements |
| Tools | `vault_schema`, `vault_stats`, `list_samples`, `get_sample`, `list_measurements`, `get_measurement`, `list_files` | yours over your own DB (issues, links, status) **plus** measurement reads implemented as PostgREST calls to `connect.*` |
| Data access | `vault_service` token, `vault.*` | `connect_read` JWT, `connect.*` only, and libpq to `agni_devops` |
| Client credential | `VAULT_API_KEY` | your own `CONNECT_MCP_KEY`, `timingSafeEqual`, 500 if unset |
| Can it write measurement data? | no (by construction) | no (by grant: `connect_read` cannot) |

**Rules carried over from the vault's server, because each fixed a real problem:**

- **Read-only by construction where you can.** Import only reader functions into the MCP module;
  a write the module has no reference to cannot be enabled by editing a check.
- **Free text is data.** Prefix every payload that carries stored records with a line saying
  notes, labels and filenames are content to report on, never instructions to follow. Issue
  bodies are exactly this kind of text.
- **Refuse unknown filter keys.** A query layer that ignores unrecognised keys is fine for HTTP and
  fatal for a model: a misremembered key silently drops the filter and the whole table comes back
  as "the matching rows". Validate keys and return the usable list in the error.
- **Stateless.** One server and transport per request, `sessionIdGenerator: undefined`,
  `enableJsonResponse: true`; close both on `res 'close'`.
- **Put a URL a human can open in every answer** so a person can check the model's claim against
  the page.
- **Mount under your `/api/*`** so the existing Caddy stanza reaches it with no new route.

**Measurement tools to offer your agent, at minimum.** `connect_kinds` (units), `find_measurements`
(filters on `sample_key`, `kind`, `measured_on` range, `device_id`, `bench_run_id`),
`get_measurement` (row + its `files` + its `metrics`), `find_samples`, `bench_run` (with
`n_cells_recorded`). Every one is a `GET` to a `connect` view; none needs anything the vault has
not already granted. Surface `meta_status`, `skipped`, `extractor_version` and `upload_state` in
the payloads rather than hiding them, for the reasons in §5.

**The vault's own MCP tools are also available to your agent, with a reader key.** They know the
live field definitions and the vault's page URLs, which `connect` does not carry. As of 2026-09-16
the vault's MCP endpoint accepts a second credential, `VAULT_MCP_READ_KEY`, which **only**
`/api/mcp` honours; the REST write path has no reference to it (asserted by test). Ask Owen for
that key, never for `VAULT_API_KEY`. Configure it as a second MCP server in your agent:

```
url:    https://edaserver.tailcb2a72.ts.net/api/mcp     (or http://127.0.0.1:8099/api/mcp from the box)
header: Authorization: Bearer <VAULT_MCP_READ_KEY>
```

Its seven tools are `vault_schema`, `vault_stats`, `list_samples`, `get_sample`,
`list_measurements`, `get_measurement`, `list_files`. Its instructions are the vault's, and they
will tell your agent to call `vault_schema` before filtering; that is correct for that server. Your
own server (above) carries your instructions. Two servers, two personas, one agent.

**People, as opposed to your server process, should not use the reader key.** The vault's MCP
endpoint is also an OAuth 2.1 authorization server (`docs/CONTRACT.md` v2.21): a person adds it to
their own Claude client with no key, the client discovers the flow from the 401, a browser opens to
a Google Workspace sign-in, and the client receives a token bound to that person. That gives the
vault a name for every tool call and lets Owen revoke one person without rotating anything. Your
own MCP server should offer the same; the vault's `server/oauth/` is a complete, tested reference
you can lift (Google as IdP, PKCE-only public clients, hashed rotating tokens), and both products
can share one Google OAuth client per redirect URI or register their own.

**Where models run, and one decision that is Owen's.** Neither MCP server runs a model. The model
is whatever Claude client the person or your service uses, and it runs at Anthropic. If agni-connect
ever wants its API process on edaserver to call a model provider directly, that would be the first
outbound model call from the box, and it is a deliberate choice Owen makes rather than a default you
adopt.

## 8. agni-connect's own data

**Own database on the shared cluster, reached over libpq. Not a schema in `fedbench`.**

```sql
CREATE DATABASE agni_devops;
CREATE ROLE connect_owner NOLOGIN;      -- roles are CLUSTER-WIDE; prefix yours
CREATE ROLE connect_app   NOLOGIN;
```

Why (short form; long form in `CONNECT_INTERFACE.md` §8b): a fast-iterating product must not run
migrations inside the database holding irreplaceable measurement data; logical dump/restore is
per-database and an issue-tracker rollback must never imply a measurement rollback; and PostgREST
gives one statement per request with no cross-request transactions, which is the wrong write path
for an issue tracker anyway. Your API server is already on the box; use your ORM, your
migrations, your transactions.

**Consequence:** no foreign key from an issue to a measurement. `measurement_id` is a plain uuid
you validate on write by reading `connect.measurements`. A dangling link in an issue tracker is a
broken link, not corrupted science. `postgres_fdw` exists if you need cross-database joins later.

**PostgREST serves exactly one database.** The instance you read `connect` from cannot also serve
`agni_devops`. If you want a read-only dashboard of your own data over the same URL, a `devops`
schema in `fedbench` served under `Accept-Profile: devops` was **verified to work and to be
role-isolated (403, not `[]`)** on 2026-09-11. It is available; it is not recommended for your
system of record.

Two conventions to steal from ours, each born of a real incident: enable RLS with no policies and
give your service role `BYPASSRLS` (fail-closed; then your health check must read a known row);
and never put a nullable column in a unique constraint (nulls are distinct, so the same logical row
inserts twice).

---

## 9. Standing connect-api up on the box: the order

Follow `docs/PLATFORM_BLUEPRINT.md` §5 and §9 for the mechanics. The order that avoids the traps:

1. **Read before you touch.** `sudo bash /srv/agni-data-vault/deploy/preflight.sh` shows ports,
   mounts, and which `psql` is first on `PATH`. **Siemens Calibre ships its own `psql`** ahead of
   the real one; every script must call `/usr/pgsql-17/bin/psql` by absolute path.
2. **Accounts.** A nologin service user for connect-api. Its checkout goes under `/srv/<name>`,
   **not** under any `/home`: on RHEL 9 a tree under a home directory is `user_home_t` and systemd
   will not exec from it (`203/EXEC`). See `deploy/README.md` "RHEL 9 SELinux" for the fcontext
   rules that fix a service checkout.
3. **Database.** Owen runs `deploy/connect-db-bootstrap.sh` on the box. It creates `connect_owner`
   and `connect_app` (both `NOLOGIN`), `agni_devops` owned by `connect_owner` with `CONNECT`
   revoked from `PUBLIC` and granted to `connect_app`, and with `--api-login connect_api` a
   `LOGIN` role in `connect_app` whose password is printed once. It then proves those roles hold
   nothing in `fedbench`. Your libpq URL is `postgresql://connect_api@127.0.0.1:5432/agni_devops`.
   Run your migrations against it with the absolute-path `psql`.
4. **Credential.** Receive the `connect_read` token; write `/etc/agni-connect/api.env` (`0640`,
   `root:<svc>`); reference it from your unit with `EnvironmentFile=`.
5. **Unit.** `Type=simple`, `User=<svc>`, bind `127.0.0.1:8098`, `Restart=on-failure`,
   `ProtectSystem=strict` with explicit `ReadWritePaths=`. Reuse `deploy/vault-api.service` as the
   template; it has already fought SELinux and won.
6. **Prove the read path before wiring a UI.** From the box, as your service user:
   ```bash
   curl -s http://127.0.0.1:8087/rest/v1/kinds -H 'Accept-Profile: connect' -H "Authorization: Bearer $CONNECT_JWT" | jq length
   ```
   Must print `7` (or more). Anything else, stop and read §4's table.
7. **Caddy.** A stanza for `devops.<tailnet>.ts.net` routing `/api/*` to `127.0.0.1:8098`, in the
   **same** root-owned Caddy. Two daemons cannot both bind `:443`. Coordinate; do not edit the
   vault's stanza. Use `handle`, not `handle_path`, unless your API expects the prefix stripped.
8. **Certificate.** `tailscale cert devops.<tailnet>.ts.net`, and a renewal timer. `tailscale
   cert` does not renew itself and Caddy does not watch the files; the vault's
   `tailscale-cert.timer` is the model. Without both, you get a clean outage ~90 days after
   go-live, far from any deploy.
9. **Public door, if and when.** One `cloudflared`, one tunnel, an ingress rule per hostname;
   Access with Google Workspace; verify the assertion (§3). The vault's public door is
   deliberately unbuilt; yours can be first, but every rule in §3 applies on day one.

---

## 10. Things you must not do, as a list

- Read `vault.*` or `public.*`. They are implementation and moved eighteen migrations in a month.
- Ask for `PGRST_JWT_SECRET`, `VAULT_SERVICE_JWT`, or `VAULT_API_KEY`.
- Put agni-connect's tables in `fedbench`.
- Write to `fedbench` by any path.
- Open files under `/srv/fedbench`, `/storage/vault`, or `/srv/nextcloud` on the filesystem.
- Treat a `files` row as bytes without checking `upload_state = 'ready'`.
- Average a metric column without partitioning by `skipped` and `extractor_version`.
- Type a unit into code that `connect.kinds` already carries.
- Use a `200` with `[]` as evidence of "no data yet".
- Bind anything to a non-loopback interface, or run a second Caddy or `cloudflared`.
- Use `psql` without its absolute path.
- Use `https://edaserver` (the short name) for anything that checks certificates.

---

## 11. Changing the contract

Columns are added to `connect` views freely; ask and it is usually one migration. Removing or
retyping a column requires telling you first, and we will. If you need a view that does not exist,
a column that is missing, storage rights, a login role, or a second schema, say so **before**
building around the gap. The expensive version of this conversation is discovering six months in
that agni-connect reads `vault.measurements`.

Contract pins: `tests/connectSurface.test.ts` fails the vault's own CI if a `connect` view exposes a
forbidden name or a view disappears. `docs/CONTRACT.md` §v2.18 is the normative statement.

---

## 12. Quick reference

```
Origin (on box):   http://127.0.0.1:8087
Origin (tailnet):  https://edaserver.tailcb2a72.ts.net
Reads:             GET {origin}/rest/v1/{samples|measurements|files|metrics|bench_runs|kinds|health}
Headers:           Accept-Profile: connect
                   Authorization: Bearer <connect_read HS256 JWT>
Liveness:          /rest/v1/kinds  →  ≥ 7 rows
Bytes:             GET {origin}/storage/v1/object/<bucket>/<storage_path>   (separate grant)
Your API port:     127.0.0.1:8098
Your database:     agni_devops (libpq), roles prefixed connect_*
Vault app API:     {origin}/api/*   (VAULT_API_KEY; not yours)
Your MCP:          POST 127.0.0.1:8098/api/mcp  (your key, your instructions, reads connect.* + agni_devops)
Vault MCP:         POST {origin}/api/mcp   (VAULT_MCP_READ_KEY; read-only tools; the vault's instructions)
Real psql:         /usr/pgsql-17/bin/psql
```
