# Platform blueprint: how to build a second product on edaserver

**Audience:** whoever is building agni-connect. This describes the architecture agni-data-vault
already runs on, so a second product can be the same shape without re-deriving it.

**The headline:** the two products share a *host*, a *proxy* and a *Postgres cluster*. They do
**not** share a database, an API process, a hostname, a service user, or a credential. Everything
below says which is which.

---

## 1. The shape

```
                    ┌─────────────────── PUBLIC ───────────────────┐
  browser ────────► vault.agnisemi.ai          devops.agnisemi.ai  │
                    │  (Cloudflare + Access = Google Workspace)    │
                    │   /      → Vercel  (SPA, static, no secrets) │
                    │   /api/* → Tunnel ─┐                         │
                    └────────────────────┼─────────────────────────┘
                                         │  cloudflared dials OUT
  ┌─── TAILNET ────┐                     │   (no inbound port opened)
  │ bench watcher  │                     │
  │ CLI, MCP       ├──► Caddy :443 ──────┼────────────────────────────────┐
  └────────────────┘   tailscale cert    │      edaserver (RHEL 9)        │
                                         ▼                                │
                        127.0.0.1:8099  vault-api      (product A)        │
                        127.0.0.1:8098  connect-api    (product B)        │
                                         │                                │
                        127.0.0.1:8087  nginx shim ──► :3000 PostgREST    │
                                         │            ──► :3001 fed_storage│
                                         ▼                                │
                        127.0.0.1:5432  PostgreSQL 17.10                  │
                            ├── database  fedbench     schemas: public,   │
                            │                          vault, connect     │
                            └── database  agni_devops  schemas: yours     │
                        ──────────────────────────────────────────────────┘

  Inbound ports opened to the internet: NONE.
  Exposed on the tailnet: Caddy :443 only. Everything else is loopback.
```

**Two doors, and the governing rule is the same for both:**

> **No path on this host is protected by SSO alone.** Every path independently validates a
> credential. SSO is an *additional* gate on human paths, never the only one.

---

## 2. Shared vs. per-product

| | Shared | Per-product |
|---|---|---|
| Host | edaserver | — |
| Postgres **cluster** | one, PGDG 17.10, loopback | — |
| Postgres **database** | — | `fedbench` / `agni_devops` |
| Roles | cluster-wide namespace, so prefix them | `vault_*` / `connect_*` |
| Proxy on `:443` | one root-owned Caddy, routes by hostname | — |
| `cloudflared` | one daemon, one tunnel, **two ingress rules** | — |
| Tailnet hostname + cert | — | `vault.<tailnet>.ts.net` / `devops.<tailnet>.ts.net` |
| Public hostname + Access app | — | `vault.agnisemi.ai` / `devops.agnisemi.ai` |
| Vercel project | — | one each |
| API process, systemd unit, service user, env file | — | one each |
| PostgREST + `fed_storage` | one each, serving `fedbench` | — |

**Why one Caddy and one cloudflared.** Both route by hostname, so a second product is a stanza,
not a second daemon. Two daemons on `:443` cannot both bind it anyway.

**Why separate databases.** A product that iterates fast should not run its migrations inside the
database holding irreplaceable measurement data, and a logical restore of one must never imply
restoring the other. (Point-in-time recovery is cluster-wide either way — the logical dump/restore
path is the realistic one, and it *is* per-database.)

**Note on roles:** Postgres roles are **cluster-wide, not per-database**. `connect_read` exists
once and means the same thing everywhere. Prefix yours so two products never collide on a name.

---

## 3. Repository layout

The vault's layout, which is worth copying because it is what lets one codebase run both on
Vercel and as a long-lived server:

```
src/                 the SPA (Vite + React + TypeScript). No secrets. Ever.
api/
  handler.js         ONE entry point: (req, res) => void. Vercel-function shaped.
  _lib/
    auth.js          returns a PRINCIPAL, not a boolean
    accessJwt.js     verifies Cf-Access-Jwt-Assertion cryptographically
    router.js        path → resource dispatch
    respond.js       sendJson / sendError / ApiError — one error envelope
    validate.js      shared input validation
    resources/*.js   one module per entity; no HTTP knowledge
server/
  vault-api.mjs      ~90 lines: http.createServer → the SAME handler
deploy/              Caddyfile, cloudflared-config.yml, *.service, *.timer
docs/                CONTRACT.md is frozen; changes are amendments with numbers
tests/               vitest; the API tests mock the DB client, not the routes
```

**The load-bearing idea:** `api/handler.js` is a plain `(req, res)` function. Vercel calls it as a
serverless function; `server/vault-api.mjs` wraps it in `http.createServer` and runs it as a daemon
on edaserver. **One implementation, two hosts, no branching.** Build the API that way from day one —
retrofitting it later means untangling Vercel's request object from your own.

Two things `vault-api.mjs` does that a naive wrapper gets wrong:

- **It binds `127.0.0.1` explicitly.** Not `0.0.0.0`. The tunnel and Caddy reach it on loopback;
  anything else reaching it is a bug you want to fail rather than serve.
- **Streaming routes bypass body-buffering.** Our dev server accumulated the request body as a
  *string* (`raw += chunk`), which silently corrupts binary. If you accept file uploads, the upload
  route must stream, not buffer — and a 50 MB workbook read into a JS string is the failure you
  discover in production.

---

## 4. Vercel side

`vercel.json`, all of it:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/handler?route=:path*" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "git": { "deploymentEnabled": { "feat/edaserver-unify": false } }
}
```

The second rewrite is the SPA fallback. The `git.deploymentEnabled` block **turns off previews for
a working branch** — worth having, because a preview deployment of a branch mid-migration is a live
URL running half-finished code against real data.

### The one rule that matters here

> **Nothing at all starts with `VITE_`**, except one non-secret base URL.

Vite inlines every `VITE_`-prefixed variable into the bundle **as a literal string**, in a file
served to anyone who can load the page. The weaker version — "nothing *secret* starts with
`VITE_`" — requires every future author to correctly classify their own variable, and cannot be
checked. The strong version can be, and ours is, by a test that walks the source tree:

```ts
const ALLOWED = new Set(['VITE_API_BASE_URL'])
// ...then fail on any other VITE_ identifier found in src/
```

Write that test before you need it. Ours found stale declarations the day it was added.

### Same-origin is not optional

The SPA and the API **must** be the same origin, or Cloudflare Access's session cookie is a
third-party cookie — which Safari blocks today. That is the whole reason the API leaves Vercel:
Cloudflare fronts one hostname with two origins (`/` → Vercel, `/api/*` → tunnel), so the browser
sees one origin while Vercel still serves the SPA.

---

## 5. The API server on edaserver

`deploy/connect-api.service`, modelled on ours:

```ini
[Unit]
Description=Agni Connect API
After=network-online.target postgresql-17.service
Wants=network-online.target

[Service]
Type=simple
User=connectsvc
Group=connectsvc
WorkingDirectory=/srv/connect/app
EnvironmentFile=/etc/connect/connect-api.env     # mode 0640, root:connectsvc
ExecStart=/usr/bin/node /srv/connect/app/server/connect-api.mjs
Restart=on-failure
RestartSec=2
MemoryHigh=512M
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

**RHEL 9 traps, all of which look like unrelated bugs:**

- Install units with **`cp`, never `mv`** — a moved file keeps its source SELinux context and
  systemd refuses to load it.
- `setsebool -P httpd_can_network_connect 1` — without it nginx proxying to a loopback port is
  denied and you see a **502**.
- `semanage port -a -t http_port_t -p tcp <port>` — binding a non-standard port is denied by
  default.
- `semanage fcontext` + `restorecon -Rv` for every new directory.
- Debug ritual: `sudo ausearch -m avc -ts recent`. **Suspect SELinux first.**
- `systemctl enable` everything. A reboot that comes back with nothing running is the same outage
  as a crash, and nobody notices for hours.

### Port map — pick from this, don't guess

| Port | Bound to | What |
|---|---|---|
| 443 | tailnet iface | Caddy — the only thing reachable off-box |
| 8099 | 127.0.0.1 | `vault-api` |
| **8098** | 127.0.0.1 | **`connect-api` — yours** |
| 8087 | 127.0.0.1 | nginx shim → PostgREST / storage |
| 3000 | 127.0.0.1 | PostgREST (`fedbench`) |
| 3001 | 127.0.0.1 | `fed_storage` |
| 5432 | 127.0.0.1 | PostgreSQL |

Run `deploy/preflight.sh` before assuming any of these are free.

---

## 6. Auth: return a principal, not a boolean

The single most reusable piece. `requireAuth` resolves **who** is asking, not merely whether they
may:

```js
Bearer <API_KEY>            → { kind: 'machine', actor: 'api' }     // timing-safe compare
verified Access assertion   → { kind: 'human',   actor: email }
neither                     → 401
```

Everything downstream takes the principal, and that is what makes attribution real:

- `created_by` stays **client-settable for machine principals only** — a CLI legitimately writes
  `created_by: 'backfill'` — and is **ignored for humans**, whose row is attributed to their actual
  email. Our audit log got a true actor for the first time from this one change.
- Admin checks read a role from a `people` table keyed by that email, not from the token.

### Verify the Access assertion. Do not trust the header.

Cloudflare sets `Cf-Access-Jwt-Assertion`. Ours (`api/_lib/accessJwt.js`) does all of:

1. Fetches the team's signing keys from `<team>/cdn-cgi/access/certs`, cached with a TTL.
2. Requires `alg: RS256` and a `kid` that resolves — never accepts `alg: none` or a caller-chosen
   algorithm.
3. Verifies the signature with `crypto.verify('RSA-SHA256', ...)`.
4. Checks `aud` against the configured application audience.
5. Checks `exp` and `iat` with 60 s of clock skew.

A proxy-injected header you merely read is a header anyone who reaches the origin by another route
can forge. Belt and braces: **Caddy strips client-supplied `Cf-Access-*` on ingress**, and the API
binds loopback.

**Policy on the `hd` claim, not the email suffix.** `hd` is asserted by Google about the account's
domain and cannot be spoofed by an alias; a suffix check can be satisfied by a personal account
whose primary address you do not control.

**Keep the API-key path as break-glass.** It means the CLI still works with Google down, and that
is worth writing in the runbook so nobody invents a second password later.

---

## 7. Environment variables

Prefix yours (`CONNECT_*`) so nothing collides in a shell or a shared env file.

| Ours | Yours | What |
|---|---|---|
| `VAULT_API_KEY` | `CONNECT_API_KEY` | machine principal, break-glass |
| `VAULT_ACCESS_TEAM_URL` | `CONNECT_ACCESS_TEAM_URL` | `https://<team>.cloudflareaccess.com` |
| `VAULT_ACCESS_AUD` | `CONNECT_ACCESS_AUD` | the Access application's audience tag |
| `VAULT_EMAIL_DOMAIN` | `CONNECT_EMAIL_DOMAIN` | checked against the `hd` claim |
| `VAULT_READONLY` | `CONNECT_READONLY` | `1` rejects every write — see below |
| `VAULT_REST_URL` | *(n/a — use libpq)* | PostgREST base for measurement reads |
| `VITE_API_BASE_URL` | same name, and the **only** `VITE_` var | non-secret; the API origin |

**`*_READONLY=1` is worth copying.** It lets you deploy the whole application against migrated
data with every write refused, and compare it page-by-page against the old system before cutover.
One caveat we hit: a POST that *computes* something and writes nothing (an analysis call taking a
predicate in its body) must be allow-listed by **exact path**, never by prefix — `startsWith('x')`
would also admit the POST that creates a row.

---

## 8. Your database

```sql
CREATE DATABASE agni_devops;                    -- your own, on the shared cluster
CREATE ROLE connect_app  NOLOGIN;               -- cluster-wide: prefix it
CREATE ROLE connect_owner NOLOGIN;
```

Your API talks to it over **libpq** — not PostgREST. For an issue tracker that is the right call:
PostgREST gives one statement per request and no transaction spanning requests, so a state
transition that also reorders a backlog and writes a notification would have to become a trigger or
an RPC. Use your normal ORM, your normal migrations, your normal transactions.

**Two conventions from our schema worth stealing**, both of which exist because of a real incident:

- **Enable RLS with no policies, and give the service role `BYPASSRLS`.** It is a fail-closed
  guard: a role provisioned wrongly reads *nothing* rather than *everything*. Know the failure
  mode it creates — a missing `BYPASSRLS` returns `[]` from every table, so the app looks empty
  rather than unauthorised, and **your health check must read a row it knows exists** or it will
  report green in exactly that state.
- **A nullable column in a unique constraint does not do what you want.** Postgres treats nulls as
  distinct, so the same logical row inserts twice instead of upserting. Our bench uses
  `NOT NULL DEFAULT ''` for exactly this reason. It will bite you on an issue key or a slug.

### Reading measurement data

Separate databases means no foreign key from your issues to a measurement — `measurement_id` is a
plain uuid you validate on write. Two ways to read:

1. **PostgREST over loopback** — `http://127.0.0.1:8087/rest/v1/...` with
   `Accept-Profile: connect` and a `connect_read` JWT. Documented in `docs/CONNECT_INTERFACE.md`.
2. **libpq straight to `fedbench`** as a login role granted `connect_read`. Simpler if you are
   already writing SQL; no `Accept-Profile` footgun.

Either way you read the **`connect` schema**, never `vault.*`. That schema is the promised surface;
everything else is our implementation and moves.

If you later need SQL joins across the two databases, `postgres_fdw` exists. Not a one-way door.

---

## 9. Standing a second product up — the order

1. **`deploy/preflight.sh`** — inventory before installing. Nothing is assumed free.
2. Allocate the hostname pair (`devops.agnisemi.ai`, `devops.<tailnet>.ts.net`) and delegate DNS.
3. Create the Cloudflare Access application; policy on the **`hd`** claim.
4. Add the ingress rule to the existing `cloudflared` config; add the Caddy stanza.
5. `tailscale cert devops.<tailnet>.ts.net` — **and the renewal timer.** These are ~90-day
   certificates and nothing renews them by default; Caddy reads `tls <cert> <key>` at config load
   and does **not** watch the files, so the renewal *and* the reload are both required. See
   `deploy/tailscale-cert.{service,timer}`.
6. `CREATE DATABASE`, roles, grants. Run your migrations.
7. Deploy the API unit with `CONNECT_READONLY=1`; compare against whatever it replaces.
8. Clear the flag. Rotate the API key.

**Before any of that, one gate applies to you too:** a second physical copy of anything this box
becomes the only home for. Right now the hosted systems are that copy. After cutover they are not.

---

## 10. Things we got wrong, so you don't have to

- **`create or replace view` cannot rename a column.** It fails with *"cannot change name of view
  column"* — and if your migration runner greps for `^ERROR` while psql prefixes errors with
  `psql:file:line:`, a failed migration reads as clean. Grep for the word anywhere in the line.
- **A narrow `GRANT` is decorative if `ALTER DEFAULT PRIVILEGES` already covered the schema.**
  Ours grants the service role write on every *future* table, so read-only tables need an explicit
  `REVOKE`. We hit this three times before writing it down.
- **`ON CONFLICT ON CONSTRAINT <name>` does not work against a partial unique index.** Infer from
  columns plus the predicate instead.
- **A `CHECK` constraint passes on NULL.** `jsonb_typeof(spec -> 'panels') = 'array'` accepted a
  document with no `panels` key at all, because the comparison was NULL rather than false. Wrap it:
  `coalesce(jsonb_typeof(...), 'missing')`.
- **Mocked tests cannot see the seam.** Every unit test passed while a query used a client scoped
  to the wrong schema; only a check against real PostgREST caught it. Write one integration script
  that exercises the real wire, and **seed it** — against an empty database every assertion passes
  over an empty array.
