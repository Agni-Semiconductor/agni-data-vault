# Agni Data Vault

## What it is

Agni Semi's labelled repository for ferroelectric-diode measurement data.
Samples contain measurements; measurements contain raw files and plots.
Metadata fields are database rows, so the form, filters, API schema, and CLI share them.

## Stack

| Layer | Choice |
|---|---|
| Web | Vite, React, TypeScript, Tailwind — served by Vercel, holds **no** secret |
| API | Node on `edaserver`, loopback only, reached through Cloudflare Tunnel |
| Data | PostgreSQL 17 on `edaserver`, schemas `vault` + `public` (the bench), fronted by PostgREST |
| Objects | `fed_storage`, buckets `vault` and `bench` |
| Auth | Cloudflare Access with Google Workspace; the assertion is **cryptographically verified**, never trusted as a header |

The vault and the 128×128 test bench share one cluster: `public` is the bench's schema and is a
copied wire contract — not to be redesigned or renamed. `docs/UNIFIED_ENDPOINT.md` is the
operator's document and explains why each piece is shaped the way it is.

> **Migrating off hosted Supabase.** Those projects stay up and unpaused until their cold archives
> are restore-verified; `supabase/migrations/0001–0006` remain as the historical record of that
> deployment. The self-hosted track is `supabase/migrations/selfhost/0100–0118`.

**Data-plane status (2026-09-11).** The data plane is now **LIVE** on `edaserver`: PostgREST,
`fed_storage`, and the nginx shim are active on loopback, all 19 migrations are applied, and the
full path was verified end to end with a real token. It is loopback-only because Caddy, the
Tailscale certificate, and the Cloudflare tunnel are not done, so nothing is reachable from the
tailnet yet. No vault data has been migrated from hosted Supabase; the tables are empty by design,
so zero-row health is not evidence of a failed schema migration.

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

Cloudflare Access fronts the site with Google Workspace as the IdP. `api/_lib/accessJwt.js`
**verifies the signature** of `Cf-Access-Jwt-Assertion` against the team's keys and checks `aud` —
it does not trust a proxy-injected header, which is what makes this safe even if something else
ever reaches the origin.

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
the API moves to `edaserver` behind Cloudflare Tunnel, and **no inbound port is opened** —
`cloudflared` dials out.

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
