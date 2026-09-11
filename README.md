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
> deployment. The self-hosted track is `supabase/migrations/selfhost/0100–0115`.

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
for f in supabase/migrations/selfhost/0*.sql; do psql -d fedbench -v ON_ERROR_STOP=1 -f "$f"; done
```

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

Open, and needing a decision rather than more code:

- **One real Clarius workbook** to point `VAULT_REAL_XLSX` at. The `.xlsx` adapter has only been
  exercised against workbooks the tests build themselves, so its sheet-selection and column rules
  are tested against a *model* of the export format rather than the format.
- **The correlation fit** for the continuous cohort view — OLS on raw values, on log10 of a
  log-scale metric, or weighted by n. A different right answer per metric, so it is unspecified
  rather than guessed.
- **Vector export** for figures: server-side matplotlib or a client-side SVG renderer.

Run the remote API check with `bash scripts/smoke.sh` after setting its environment.
