# Agni Data Vault

## What it is

Agni Semi's labelled repository for ferroelectric-diode measurement data.
Samples contain measurements; measurements contain raw files and plots.
Metadata fields are database rows, so the form, filters, API schema, and CLI share them.

## Stack

| Layer | Choice |
|---|---|
| Web | Vite, React, TypeScript, Tailwind |
| API | One Vercel serverless function |
| Data | Supabase Postgres, Storage, Auth |
| Supabase project | `phniloxolwrbrrkbccvb` |

## Local development

```bash
npm install
# copy .env.example to .env.local and fill its keys
npm run dev
node --env-file=.env.local scripts/api-dev.mjs
npm run typecheck && npm run lint && npm test && npm run build
```

The Vite app runs on its configured development port; the API development command runs on `:3001`. `.env.local` uses the keys in `.env.example`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `VAULT_API_KEY`.

## Database

Migrations live in `supabase/migrations/`. Apply them to the hosted project through Supabase MCP `apply_migration`, or run:

```bash
npx supabase link --project-ref phniloxolwrbrrkbccvb
npx supabase db push
```

Seed migrations are idempotent. To promote a hot meta field, add one migration that adds the typed column, backfills it from `meta->>'key'` with an appropriate cast, and updates that field definition's `column_name`; see `docs/CONTRACT.md section 5`.

## Auth

Authentication is magic-link and invite-only: `allowlist` determines access. Add an email with:

```sql
insert into public.allowlist (email, role) values ('person@example.com', 'member') on conflict (email) do update set role = excluded.role;
```

Allow `http://localhost:5173/**` and `https://*.vercel.app/**` as redirect URLs in Supabase Auth settings.

## Deployment

Vercel project root is the repository root. Configure these environment variables:

| Client (Vite) | Server (Vercel only) |
|---|---|
| `VITE_SUPABASE_URL` | `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |
|  | `VAULT_API_KEY` |

`vercel.json` rewrites `/api/:path*` to `api/handler` and all other SPA paths to `index.html`.

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

## Known limits / phase 2

- Bulk backfill of roughly 24k files needs Pro storage.
- Derived metrics need a dedicated table.
- FabFlow linkage is future work.

Run the remote API check with `bash scripts/smoke.sh` after setting its required environment.
