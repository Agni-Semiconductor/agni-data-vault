# The unified endpoint on edaserver

One PostgreSQL cluster, two schemas, two front doors. This is the operator's document for the
migration off hosted Supabase; `docs/CONTRACT.md`'s "Contract v2" section is the developer's.

Every claim marked **verified** was driven against a real Postgres 17.10 + PostgREST +
`fed_storage` on 2026-09-10, not reasoned about. Claims not so marked are design intent that
nothing has exercised yet — treat the difference as load-bearing.

---

## 1. What talks to what

```
┌─ PUBLIC DOOR ─────────────────────────────────────────────────────┐
│ browser → vault.agnisemi.ai   (Cloudflare; Access = Workspace SSO)│
│   /        → origin: Vercel      (SPA, no secrets, no VITE_ vars) │
│   /api/*   → Cloudflare Tunnel ──┐  cloudflared dials OUT         │
└──────────────────────────────────┼────────────────────────────────┘
                                   │
┌─ TAILNET DOOR ────────────────┐  │      ┌─ edaserver (RHEL 9) ────────────┐
│ bench watcher (agnipi)  ─┐    │  │      │ Caddy :443 (tailscale cert)     │
│ cli/vault.py             ├──► Caddy ────┤ 127.0.0.1:8099  vault-api       │
│ cli/backfill.py          │    │  │      │ 127.0.0.1:8087  nginx-fedbench  │
│ MCP tools                ┘    │  │      │   ├ :3000 PostgREST            │
└───────────────────────────────┘  └──────┤   └ :3001 fed_storage          │
                                          │ 127.0.0.1:5432 Postgres 17.10  │
                                          │   db `fedbench`: public + vault│
                                          │ /srv/... 1 TB                  │
                                          └────────────────────────────────┘
```

**Inbound ports opened to the internet: none.** `cloudflared` dials out. On the tailnet, Caddy
is the only listener; PostgREST, the object store and Postgres stay loopback-bound.

| Door | Reaches | Identity |
|---|---|---|
| Public (Cloudflare) | `/api/*` **only** | A Workspace user, or an Access service token |
| Tailnet (Caddy) | `/api/*`, `/rest/v1/*`, `/storage/v1/object/*` | HS256 service JWT, or `VAULT_API_KEY` |

### The invariant that keeps this safe

> **No path on this host is protected by SSO alone.** Every path independently validates a
> credential. `/rest/v1` and `/storage/v1` validate the HS256 service JWT; `/api` validates
> `VAULT_API_KEY` **or** a signature-verified Access assertion; the SPA is static and holds no
> secret. SSO is an *additional* gate on human paths, never the only one.

`/rest/v1` and `/storage/v1` are **never** published through the tunnel. The token they carry
bypasses row-level security on every table, so there is no version of exposing them beyond the
tailnet that is safe. That sentence is copied from `nginx-fedbench.conf` and it is still true.

The Access assertion is **verified cryptographically** (`api/_lib/accessJwt.js`): RS256 pinned
from the team's JWKS, `alg: none` and HMAC rejected, `aud` and `exp` checked, JWKS cached with
a refetch on an unknown `kid`. Trusting the header instead would be a total bypass. Caddy also
strips any client-supplied `Cf-Access-*` header on ingress, so there are two independent
reasons it cannot be forged — but the signature check is the one that matters.

### Two subtleties that will cost you an afternoon

- **Caddy uses `handle`, not `handle_path`.** `handle_path` strips the matched prefix, and the
  nginx config behind it expects the full `/rest/v1/...` and does its own stripping via a
  trailing slash on `proxy_pass`. Strip it twice and PostgREST returns 404 for tables that
  exist. **Verified:** with the trailing slash → 401 (reached PostgREST); without → 404.
- **`supabase-js` appends `/rest/v1` to its base URL.** This is why `nginx-fedbench.conf` is
  kept rather than pointing clients straight at PostgREST, and why `VAULT_REST_URL` is the
  nginx origin. **Verified:** pointing the client directly at PostgREST 404s everything.

---

## 2. The database: one cluster, two schemas

```
PGRST_DB_SCHEMAS="public,vault"        # public FIRST -- see below
PGRST_DB_ANON_ROLE="bench_read"        # zero grants => 403, never []
PGRST_DB_EXTRA_SEARCH_PATH="extensions"
```

Apply in this order:

1. `ferrodiode-pcb-testbench/server/deploy/selfhost_schema.sql` — the bench, into `public`.
   Creates `authenticator`, `bench_service`, `bench_read`, and `bench_storage`.
2. `supabase/migrations/selfhost/0100` … `0108` — the vault, into `vault`.

**Verified:** all nine vault migrations apply clean under `ON_ERROR_STOP` on top of the real
bench schema, and `0108` is re-runnable (three consecutive clean applications).

### `public` IS the bench schema, and must stay so

Not tidiness — three concrete reasons, each a silent failure:

- `fed_instruments/supabase.py` sends only `apikey` and `Authorization`, **never**
  `Accept-Profile`. The bench must therefore be PostgREST's *default* profile.
- `cloud.py` calls `rpc("bench_storage_usage")`, created as `public.bench_storage_usage`.
  PostgREST resolves RPC **in the request's profile**. Move the schema and that call 404s,
  which kills the watcher's storage-watermark alerting with no error — just no alerts, until
  the bucket fills.
- Four restore tools hardcode `--schema=public`.

The vault reads `public` with `supabaseAdmin().schema('public').from(...)`. **Verified** for
`device_coverage`, `cell_analysis`, `run_analysis`, `campaign_runs` and `device_tests`.

### The loudest silent failure on this box

Every table in both schemas has **RLS enabled with no policies**. That works *only* because
the service roles hold `BYPASSRLS`. Get it wrong and nothing errors: PostgREST returns `[]` for
every table, the API reports success, and the vault looks **empty** rather than
**unauthorised**.

**Verified:** a role with full grants but no `BYPASSRLS` returns an empty array and no error.

That is the entire reason `/healthz` reads a row it knows exists (`field_definitions`, seeded
with 26 by migration 0104) instead of answering a bare 200. **Verified:** `/healthz` returns
`{"ok":true,"checks":{"database":{"ok":true,"field_definitions":26}}}`.

### The vault never writes the bench

`vault_service` has `select` on the bench tables and nothing more. **Verified:** it can read
`device_tests` and is *denied* INSERT. Enforced by grants, not by convention.

---

## 3. Storage

`fed_storage` serves both buckets from one root, with roles **per bucket and per verb** — the
asymmetry is the point:

| | read (GET/HEAD) | write (POST) | delete |
|---|---|---|---|
| `bench` bucket | `bench_service`, `vault_service` | `bench_service` | **nobody: 405** |
| `vault` bucket | `vault_service` | `vault_service` | `vault_service` |

The vault **reads** bench objects because `vault.files.bucket='bench'` is a read-through
pointer rather than a copy — that is how 1,012 MB of campaign CSVs avoid being duplicated — and
never writes them, because the bench is their system of record. Exactly the shape the database
already has: `vault_service` holds SELECT on the bench tables and no INSERT. The bench does not
read vault objects; least privilege, not symmetry.

Collapsing these back into one role per bucket looks tidier, passes every other test in the
file, and breaks capture serving with a 401 that reads as a bad token. There are three tests
guarding it for that reason. An unknown bucket is 404, not a 500.

`DELETE` exists for the **`vault` bucket only**. The bench's no-delete rule stands and is now a
named invariant with a test rather than an absent endpoint, because "an unused delete on the
system of record turns a path-confinement bug from a disclosure into data loss".

**Verified against the running service (16/16):** a `bench_service` token is refused on the
vault bucket; DELETE succeeds on `vault`, 404s on a second call, and returns **405 on `bench`
even with a valid bench token**; the real content type is returned rather than
`application/octet-stream`; a re-PUT of the same path is 409, which is what the API maps to
`duplicate_file`.

`vault.files.bucket` (`'vault' | 'bench'`) lets a vault row point at an object the bench owns,
served read-through. This replaces the "pointer-only" compromise in `docs/BACKFILL_PLAN.md`
without copying: the 16,821 campaign CSVs already exist in the bench bucket, and duplicating
1,012 MB to satisfy a foreign key would make a third copy of bytes already on the disk. Rows
with `bucket='bench'` are read-only here — the API returns 403 and the object store refuses it
independently.

---

## 4. Bench ↔ vault linkage

`vault.measurements.bench_run_id` + `bench_dut_id`, a composite foreign key to
`public.campaign_runs (run_id, dut_id)` — that table's unique key is the pair, in that order.
`ON DELETE RESTRICT`: nothing in the bench deletes `campaign_runs` today, and `SET NULL` would
lose the linkage silently. A measurement that has quietly forgotten which campaign produced it
is indistinguishable from one that never had a campaign.

`vault.measurement_bench_run` resolves the join. PostgREST will not auto-embed across profiles,
which is the concrete reason this is a view rather than a query parameter.

**Never read `campaign_runs.n_measured` for progress.** Those roll-ups are written at the *end*
of a run, so a live campaign reads 0 while holding tens of thousands of child rows.
**Verified:** with 4 `device_tests` rows and `n_measured` still 0, the view correctly reports 4
cells, 3 measured, `{normal:2, short:1, (skipped):1}`.

`vault.dut_sample_map` is a table, not a derivation. Bench DUT ids (`2kb-dut-01`) and vault
sample ids (`HfN_20_0421`) have no relationship, and a wrong automatic mapping attaches real
measurements to the wrong physical sample — worse than having no mapping.

---

## 5. Analysis data

`tools/campaign_analysis.py` renders figures and posts them to Slack, but until 2026-09-10 the
**numbers** were never persisted: they lived only on one Pi's disk and in the viewer's cache.
`public.cell_analysis` and `public.run_analysis` now hold them, published by
`tools/ingest_analysis.py` on the `fedbench-vault-analysis` timer.

**Verified** against the committed reference run: 2,400 cell rows and one summary matching
`summary.json` to the last digit (`onoff` median 5.589845492699058), `counts` tiling the array
at exactly 16,384, re-running changes nothing, and a new `--extractor-version` adds a row
rather than overwriting — so a published figure cannot silently change under a paper.

**1,718 of those 2,400 rows have an empty `onoff`, and they are NULL, not 0.** An unmeasured
ratio and a ratio of zero are different findings; conflating them corrupts every downstream
histogram. Same rule for `ec_minus` (1,200 empty).

### The vault's own metrics, and why they import the bench's physics

The bench half above covers campaign runs. The vault's ~2,106 Clarius workbooks had no
computed metrics at all — no on/off, no coercive voltage, no Pr — which is what blocked
"correlate by device size" and everything else in Part 2. `vault.measurement_metrics` (0111)
holds them, filled by `tools/vault_metrics.py` on the `fedbench-vault-metrics` timer, hourly.

**That worker IMPORTS `campaign_analysis.analyse_dc`/`analyse_ac` rather than reimplementing
them.** This is the load-bearing decision in E3 and it is not about saving effort. Those
functions are not naive: `onoff` is the paired right-half ratio between the OFF branch
(0 → +Vmax) and the ON branch (+Vmax → 0), they *refuse* a sweep pinned at current compliance
(on a real array a cell that hit compliance partway scored 827× where its neighbours sat near
4×), `ec_plus` is the retrace voltage where the branches rejoin rather than a current peak, and
AC-IV takes the **median** across drive cycles. Two implementations of one metric name is
exactly how a cohort comparison ends up correlating two different quantities and returning a
confident wrong answer. **Verified**: `campaign_analysis` imports with only `tools/` on
`sys.path`, which is what the systemd unit provides — so the unit deliberately sets no
`PYTHONPATH`, because a second way for that import to resolve is a second thing to get wrong.

`tools/vault_metrics.py` is the **first** script in `tools/` that is not stdlib-only: reading a
Clarius `.xlsx` needs `openpyxl`, and the unit runs `/usr/bin/python3`. `dnf install
python3-openpyxl` on edaserver, or the timer fails as a `ModuleNotFoundError` in the journal
that reads like a broken script rather than an unfinished install.

**Verified about the adapter** (26 tests, `server/tests/test_vault_metrics.py`):

- **`|value| >= 1e22` is Clarius's unmeasured sentinel and never reaches the physics.** The
  test asserts on the arguments *captured from the analyse_dc call*, not merely that nothing
  crashed — a 7e22 surviving as a float is accepted by the noise-floor calculation and poisons
  every metric derived from that sweep without failing.
- **Which of the two current channels was chosen is recorded in `extra`.** A DC-IV export
  carries AI and BI; the quieter over the first 5% of rows wins. A metric computed from the
  wrong channel is not reproducible unless you know which one it came from.
- **`1 um^2 = 1e-8 cm^2`, pinned exactly.** Getting this factor wrong is an eight-orders-of-
  magnitude error that still looks plausible on a log axis. No pad area yields **no**
  area-normalised metric and a recorded reason — never a guess.
- **`skipped` is NULL, never `''`.** Two spellings of "nothing was skipped" is one more than
  the schema can answer for, and `where skipped is null` is the query everyone writes.
- **A refused batch retries one row at a time.** A batch POST is a single statement, so one
  row tripping either partial unique index would take the other ninety-nine with it. Note
  `on_conflict` is *not* available as a shortcut: it names a constraint, and uniqueness here is
  carried by two **partial** indexes, which PostgREST cannot target. Hence read-then-insert.
- **The checkpoint is written after each accepted batch, and after the POST rather than
  before.** Saving once at the end means a run killed after eight batches records none of
  them; the state file then exists and buys nothing, which is worse than having none because
  it reads as resumability. Writing after the POST keeps the failure direction safe — a crash
  in between costs a repeat, which the anti-join absorbs, rather than marking unwritten rows
  done. The file lives at `state/vault_metrics.json`, not in `tools/`, so it never shows up as
  a dirty worktree for whoever next runs `git pull` on the box.

**NOT yet verified, and it needs a real file.** The Clarius-workbook → V/I adapter has only
ever been exercised against workbooks the tests build with `openpyxl`. No real Clarius
`.xls`/`.xlsx` is checked into either repo, so the sheet-selection and column-name rules are
tested against my *model* of the export format, not the format. The vault already has the hook
for closing this: `tests/realfile.test.ts` is gated on `VAULT_REAL_XLSX` and skipped when
absent — which is the "1 skipped" in every vault test run. **Point that env var at one real
`20-DC-1.xlsx` and this stops being an assumption.** Until then, treat the first production
run as a dry run and read the per-measurement log lines.

### Units are data now, and conversion refuses rather than coerces

`vault.units` and `vault.column_units` (0112) replace what used to be a literal in three
separate places (`plotProfiles.PROFILES`, the bench's `COLUMN_UNITS`, `fed_viewer`'s own
lists). Units are recorded **per column**, because the bench emits both `i_a` (amperes) and
`current_mA` (milliamperes) for the same quantity and `campaign_log.py` calls the latter "the
cautionary tale of a unit that lives only inside a column name".

`vault.unit_factor('A','V')` **raises**, and that is the design: a null would propagate into a
plot as a gap and into an average as a silently smaller n, both indistinguishable from missing
data. A caller that must degrade gracefully asks `units_compatible()` first.

This also **corrected a defect in 0111**, which declared one `y_unit` per kind while `y_col` is
a fallback *list* — so `board_csv`'s `{i_a, current_mA}` sat under a single label of `'A'`. A
capture carrying only the legacy column would have been labelled amperes: 1000× high, on a log
axis, looking like data. The axis unit is now a panel **default**, valid only when every column
on that axis agrees, and a trigger enforces that. **Verified**: re-declaring `board_csv`'s
`y_unit` and inserting a new mixed-unit kind are both refused, naming `{A,mA}`.

`PROFILES` is **still a literal** in `src/plot/plotProfiles.ts`, and after building E7 I think
that is the right answer rather than a deferral. `resolveSeries` is a pure synchronous function a
chart calls during render; making it await `/api/kinds` would push async through `QuickPlot`,
`MeasurementCard` and every test above them, to remove a duplication that a test can catch just
as well. So `tests/kindRegistryParity.test.ts` pins the literal to the migration instead, and
`GET /api/kinds` serves the registry for the things that genuinely need it at runtime — the
figure builder's unit resolution and column pickers.

That test earned its place immediately: it found two real drifts on its first run, both mine.
`res2t` was declared in the registry with no frontend profile at all, so the database offered a
kind the UI could not plot; and `0111` seeded `aciv.y2_col = '{Charge}'` while
`tests/plotProfiles.test.ts` already pinned the opposite with *"does not select Charge as the
default AC-IV secondary series"*. That test encoded a deliberate decision predating the
migration, so the **migration** was wrong and was corrected.

### What E7 shipped, and what it refuses

`GET /api/kinds` returns `measurement_kinds`, `units` and `column_units` in ONE response,
fetched concurrently — three requests would let a client render with two of the three loaded,
resolving a unit against a half-empty registry. It is read-only, guarded twice (the router
refuses every non-GET and the resource exports no mutation handler): an endpoint that can edit a
unit is one that can mint a 1000x error at runtime.

`src/plot/units.ts` is the client-side twin of 0112's SQL functions, and `resolvePanel` in
`src/plot/resolveTraces.ts` merges N traces onto shared axes. **A refused trace goes into
`refusals` with its reason and contributes nothing to the axis ranges** — never a silent drop,
because a panel that quietly renders 3 of 4 traces looks like a plotting bug and gets debugged
for an hour, while one that says "current_mA is mA, panel axis is A" gets fixed in a minute.

Three failure modes stay distinct in the UI, because they have different fixes and the same
symptom (an absent curve): a source that would not **load**, a trace **refused** on units, and a
saved reference whose file or capture **no longer exists**. The third comes from
`vault.figure_sources` — **verified as `vault_service`, the role PostgREST SET ROLEs to**: the
view resolves cross-schema under `security_invoker` and reports "1 of 2 resolved" for a figure
naming one real `public.captures` row and one absent capture. The negative case alone would have
been indistinguishable from a broken subquery, so a real capture was seeded to prove the
positive.

**Not built, deliberately:** vector export (SVG/PDF) remains an open decision — server-side
matplotlib versus a client-side renderer — so `exportPng.ts` is still the only export path. And a
browse-and-pick source selector: a trace's source is entered as a file id today, which is honest
but tedious. Its right home is the measurement page ("add this file to a figure", where the user
is already looking at the file), and a picker that only searched samples would miss bench
captures, which the spec supports.

---

## 6. Dual-write is transitional

`SELFHOST_MIGRATION.md` Phase 2 dual-writes to hosted Supabase via `FED_SUPABASE_MIRROR_*`.
That is a **bounded migration mechanism with a defined end**, not an architecture. The end
state is one PostgreSQL as sole primary with no application-level sync — which is exactly what
`agni-connect`'s spec requires when it forbids "dual-write database sync designs". The two
documents do not disagree; this paragraph exists so a future reader does not think they do.

---

## 7. Deploying it: what bites

**RHEL 9 SELinux is enforcing, and every one of these fails as something else:**

- `setsebool -P httpd_can_network_connect 1` — without it nginx proxying to loopback is denied
  and you see a 502.
- `semanage port -a -t http_port_t -p tcp 8087` — without it nginx cannot bind that port.
- `semanage fcontext` + `restorecon -Rv` for any new directory.
- **Install units with `cp`, never `mv`.** A moved file keeps its source SELinux context and
  systemd then refuses to load it.
- Debug ritual: `sudo ausearch -m avc -ts recent`. Suspect SELinux first.

**The JWT secret:** `PGRST_JWT_SECRET` must be ≥32 characters or PostgREST refuses to start —
the one misconfiguration here that fails loudly. It must be the **same value** as
`FED_PGRST_JWT_SECRET`, or metadata reads succeed while object downloads 401, which reads as
"the archive is corrupt" rather than "the secret is wrong". Mint tokens with
`tools/mint_service_jwt.py --role {bench_service|vault_service}`. **The secret is in no dump** —
losing that string bricks the whole data plane.

**PostgREST must be the x86_64 build.** Every install note in the testbench repo hardcodes
aarch64, from when the Pi was the target.

**Tailscale:** the ACL needs `agnipi → edaserver:443`, or the bench watcher cannot reach the
new endpoint — and it fails by backing off silently, not by erroring.

---

## 8. What the Pi keeps doing

Unchanged, and this is the payoff of preserving the PostgREST wire protocol: `supabase.py`'s
seven verbs, `cloud.py`'s 1,564 lines, the 39 MCP tools and `fed_gui`'s `/database` page are all
untouched. Repointing the bench is `FED_SUPABASE_URL` + `FED_SUPABASE_KEY`, nothing more.

**Verified:** the four wire-protocol gate files (`test_supabase.py`, `test_campaign_cloud.py`,
`test_campaign_watcher.py`, `test_watcher_storage_alerts.py`) pass **unmodified**. Those tests
are the premise of the migration: if they need changing, the wire protocol drifted and the
premise is gone.

The Pi stays the campaign runner with its local-first write path intact — `cells.jsonl`
append-only and fsynced, then an asynchronous idempotent watcher. **An outage costs sync lag,
not measurements.** Nobody should later "optimise" that local-first write away.

The Pi's data plane does become a network hop across a DERP-relayed ~21 ms link instead of
loopback. Acceptable only because of the property above — which is why getting a direct
tailnet path (`tailscale ping edaserver`; usually UDP 41641 blocked outbound) is worth more
than any other performance work here.

---

## 9. Still open

### Decided 2026-09-10 (Owen)

- **One shared Postgres cluster**, a database per product: `fedbench` holds the bench (`public`)
  and the vault (`vault`); `agni-connect` gets its own database on the same PGDG 17.10 cluster.
  Two clusters on one box would double the backup, WAL-archiving, restore-drill and monitoring
  surface for a one-operator platform, and `agni-connect`'s own MEAS records — "raw-data path,
  checksum, result rows" — *are* `vault.measurements` and `vault.files`, so one cluster makes
  that link a foreign key where two make it an HTTP call. The 256 GiB encrypted LVM from that
  spec still makes sense as the cluster's data directory. **This supersedes `agni-connect`'s
  containerised-Postgres decision and its infrastructure chapter needs updating to match.**

- **Separate hostnames per product**, not a path split: `vault.<tailnet>.ts.net` and
  `devops.<tailnet>.ts.net`, each with its own `tailscale cert` and its own Cloudflare Access
  application. No path-prefix bookkeeping, no route addition that has to be negotiated between
  two products, and either can move hosts later without breaking the other's URLs. Costs a
  second cert-renewal timer. The shared data plane (`/rest/v1`, `/storage/v1`) hangs off the
  vault name, and `agni-connect` reads it as a PostgREST profile. The public door is unchanged:
  `vault.agnisemi.ai` → Cloudflare → tunnel.

- **The pin map belongs to the board, not to a run.** The crossbar and package-pad views need
  to know which S1 pin drives which WL net. That is board topology, static across every
  campaign on a given board revision, so it goes in a `public.board_pin_map` table sourced from
  versioned board config and keyed by `campaign_runs.board_config` — not extracted from a
  per-run `analysis.json`, where it would be duplicated across every campaign and absent for
  any run whose analysis was never generated. **Not built yet**; the views wait on it.

### Still open

1. **The 128×128 mega run** — pointer or upload. Decide on a sha256 comparison against
   `public.captures.content_sha256`, not on the storage budget.
3. **The 128×128 mega run** — pointer or upload. Decide on a sha256 comparison against
   `public.captures.content_sha256`, not on the storage budget.

Prerequisites nobody has done yet: DNS delegation for `vault.agnisemi.ai` (the domain is not on
Cloudflare), Google Workspace as an Access IdP, the Tailscale ACL entry, the x86_64 PostgREST
binary, re-pulling the archive and **proving it restorable** (`state/last_restore_verify.json`
is missing and the last pull is dated 2026-08-14), and a **second physical copy** before either
cutover — after which the hosted projects stop being one.
