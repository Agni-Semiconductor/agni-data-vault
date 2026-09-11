# Agni Data Vault

## What it is

Agni Semi's labelled repository for ferroelectric-diode measurement data.
Samples contain measurements; measurements contain raw files and plots.
Metadata fields are database rows, so the form, filters, API schema, and CLI share them.

## Stack

| Layer | Choice |
|---|---|
| Web | Vite, React, TypeScript, Tailwind — served by Vercel, holds **no** secret |
| API | Node on `edaserver`, reached through the tailnet door; the public door is not built |
| Data | PostgreSQL 17 on `edaserver`, schemas `vault` + `public` (the bench), fronted by PostgREST |
| Objects | `fed_storage`, buckets `vault` and `bench` |
| Auth | Service JWTs on every path; Cloudflare Access with Google Workspace is reserved for the unbuilt public door |

The vault and the 128×128 test bench share one cluster: `public` is the bench's schema and is a
copied wire contract — not to be redesigned or renamed. `docs/UNIFIED_ENDPOINT.md` is the
operator's document and explains why each piece is shaped the way it is.

> **Migrating off hosted Supabase.** Those projects stay up and unpaused until their cold archives
> are restore-verified; `supabase/migrations/0001–0006` remain as the historical record of that
> deployment. The self-hosted track is `supabase/migrations/selfhost/0100–0118`.

**Data-plane status (2026-09-11).** The data plane is now **LIVE** at
`https://edaserver.tailcb2a72.ts.net`, reachable from devices on the tailnet and nowhere else.
Caddy 2.11.4 terminates the Let's Encrypt certificate issued through `tailscale cert` (DNS-01;
CN `edaserver.tailcb2a72.ts.net`, expiring 2026-12-10; `tailscale-cert.timer` renews it daily at
04:40) on `:443` and proxies the data routes to the loopback-only nginx shim at `127.0.0.1:8087`.
It binds only `100.87.250.124` and `fd7a:115c:a1e0::2032:fa7d`, as asserted from kernel listening
sockets after start, so the host's other interfaces do not publish the vault. The short name
`https://edaserver` resolves through MagicDNS but cannot have a valid CA certificate. Caddy does
not bind `:80`, so this door cannot serve plain HTTP; nginx's unrelated stock `0.0.0.0:80` server
does not serve the vault.

`/rest/v1/*` and `/storage/v1/*` go to `:8087`; `/healthz` and `/api/*` go to the uninstalled
`vault-api` at `:8099` and therefore return 502. Anything else returns 404. Test `connect.kinds`
with `Accept-Profile: connect`: without it, `kinds` is looked up in the default `public` bench
schema and returns 404, which falsely looks like a missing view; with it, no token returns 401.
With a valid `connect_read` token and the header, it returns 7 rows. `connect.health` returns all
zeros because no vault data has been migrated from hosted Supabase; the tables are empty by design,
not evidence of a failed schema migration. Use seeded `connect.kinds` as the liveness probe because
a probe that cannot fail proves nothing. The public Cloudflare tunnel and Access door are
deliberately not built; tailnet membership grants no service authorization.

## Local development

```bash
npm install
# copy .env.example to .env.local and fill its keys
npm run dev
node --env-file=.env.local scripts/api-dev.mjs
npm run typecheck && npm run lint && npm test && npm run build
```

The Vite app runs on its configured development port; the API development command runs on `:3001`. Copy `.env.example` to `.env.local` and fill it — the server keys are `VAULT_REST_URL`, `VAULT_STORAGE_URL`, `VAULT_SERVICE_JWT` and `VAULT_API_KEY`. **Nothing starts with `VITE_` except `VITE_API_BASE_URL`**, which is a path rather than a secret; that is a CI invariant, not a convention.

## Database

The self-hosted track is `supabase/migrations/selfhost/`, applied **in order** on top of the
bench's own schema:

```bash
psql -d fedbench -v ON_ERROR_STOP=1 -f server/deploy/selfhost_schema.sql   # the bench, in `public`
bash deploy/apply-migrations.sh --db fedbench
```

Use the script rather than a shell loop: it keeps a sha256 ledger, so a migration edited after it
was applied is detected rather than silently diverging.

Two invariants that fail **silently** if you get them wrong:

- **Every table has RLS enabled with no policies.** That works only because `vault_service`,
  `vault_read` and `bench_service` hold `BYPASSRLS`. Without it nothing errors — PostgREST returns
  `[]` for every table and the vault looks unmeasured rather than unauthorised.
- **`alter default privileges` in `0102` grants the service role full write on every table created
  in this schema afterwards.** A later migration writing a narrow `GRANT SELECT` achieves nothing;
  a read-only or append-only table needs an explicit `REVOKE`. This has bitten three migrations so
  far. Write the revoke before the grant.

To promote a hot meta field, add a migration that adds the typed column, backfills it from
`meta->>'key'` with the right cast, and sets that field definition's `column_name` — see
`docs/CONTRACT.md` §5. `vault.samples_flat` and `vault.measurements_flat` do the same thing
without a migration, for anyone querying directly.

## Auth

The unbuilt public door would use Cloudflare Access with Google Workspace as the IdP.
`api/_lib/accessJwt.js` **verifies the signature** of `Cf-Access-Jwt-Assertion` against the team's
keys and checks `aud` — it does not trust a proxy-injected header, which prevents a forged assertion
from becoming access if that door is later built.

The policy checks the Google **`hd` claim**, not the email suffix: `hd` is asserted by Google about
the account's domain and cannot be satisfied by a personal account with a lookalike address.

Every path validates a credential independently. **No path is protected by SSO alone** — `/rest/v1`
and `/storage/v1` take an HS256 service JWT, `/api` takes `VAULT_API_KEY` **or** a verified Access
assertion. SSO is an additional gate on human paths, never the only one.

`VAULT_API_KEY` is the break-glass machine path: the CLI and the bench keep working with Google
down. That is why there is no second password anywhere.

`allowlist` survives as the **role map**, not the gate — `is_admin()` is still a real distinction
the app makes for deletes and audit reads. Humans auto-provision as `member` on first request;
`VAULT_ADMIN_BOOTSTRAP` seeds the first admin.

## Deployment

`docs/DEPLOY_CHECKLIST.md` is the ordered runbook, including the prerequisites that gate a
cutover. In short: the SPA stays on Vercel (static, no secrets, **nothing** starts with `VITE_`),
the data plane is reached through the tailnet door, and the public Cloudflare door remains
deliberately unbuilt.

Server environment lives in `/etc/vault/vault-api.env`; see `.env.example` for the full list.
`ANTHROPIC_API_KEY` is optional — without it the search agent returns 503 and everything else
works.

## Metadata fields

Add or change a field through Admin > Fields, the API, or SQL. Field definitions drive validation and schema; fetch `/api/schema` after a change. Retiring a field never deletes it; it sets `active=false`.

## CLI and importing

See `cli/README.md` for the Python client. Import the registry with:

```bash
python cli/import_samples_yaml.py Model/samples.yaml
```

## Project layout

```text
api/
  _lib/              Vercel resource and shared modules
cli/
  vault.py           Python API client; import_samples_yaml.py importer
docs/
  CONTRACT.md        frozen shapes and routes; API.md agent guide
scripts/
  smoke.sh           remote API check
src/
  pages/             React screens
supabase/
  migrations/        database schema and seeds
tests/               unit tests
```

## Status

Part 2 is built: folder upload with evidence-gated extraction and a review queue; computed metrics
for the Clarius corpus; a figure builder; cohorts; a device dimension with cross-run verdict
changes; and a schema-grounded search agent. `docs/UNIFIED_ENDPOINT.md` marks each claim as
**verified** or as design intent.

The three open decisions were taken on 2026-09-11 and are built: the continuous cohort view fits
on log10 of a log-scale metric and on raw values otherwise (contract v2.17), and figure export is
a client-side SVG renderer that draws from the same resolved panels as the screen.

Known limitation, stated rather than left to be inferred from a skipped test:

- **The `.xlsx` adapter is not verified against the real Clarius format.** No real workbook is
  available to check in, so its sheet-selection and column rules are tested against a *model* of
  the export format. `tests/realfile.test.ts` is gated on `VAULT_REAL_XLSX`, points at nothing,
  and is the "1 skipped" in every run. Treat the first production ingest of a Clarius workbook as
  a dry run; pointing that variable at one real file retires this and nothing else does.

Still open, and a determination rather than a decision: whether the 128×128 mega run is a pointer
or an upload — settle it on a sha256 comparison against `public.captures.content_sha256`.

Run the remote API check with `bash scripts/smoke.sh` after setting its environment.
