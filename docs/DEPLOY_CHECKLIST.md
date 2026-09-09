# Deploy checklist — steps that need Spencer's logins

Everything below needs a browser login or a secret that the build agents cannot read. Each step is one-time.
Supabase project: `agni-data-vault`, ref `phniloxolwrbrrkbccvb`, https://phniloxolwrbrrkbccvb.supabase.co (us-east-1, free tier).

## 1. Secrets into `.env.local` (local) and Vercel (hosted)

| var | where to get it | client or server |
|---|---|---|
| `VITE_SUPABASE_URL` | already in `.env.local` | client (public) |
| `VITE_SUPABASE_ANON_KEY` | already in `.env.local` | client (public) |
| `SUPABASE_URL` | same as above | server |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard > Project Settings > API > `service_role` (secret) | server only, never `VITE_` |
| `VAULT_API_KEY` | generate once: `python -c "import secrets;print(secrets.token_urlsafe(32))"` | server; also give it to agents/CLI |

Local API smoke after pasting the two secrets into `.env.local`:

```bash
node --env-file=.env.local scripts/api-dev.mjs
```
```bash
VAULT_API_URL=http://localhost:3001 VAULT_API_KEY=<key> bash scripts/smoke.sh
```

## 2. Supabase Auth settings (dashboard > Authentication)

- URL configuration: Site URL `http://localhost:5173`; Redirect URLs add `http://localhost:5173/**` and `https://*.vercel.app/**` (add the production domain later).
- Providers > Email: keep **Disable new user signups = ON** (invite-only). Magic link and OTP are both used by the Login page.
- Allowlist is a table, not a dashboard setting. Add a teammate:
  ```sql
  insert into public.allowlist (email, role) values ('name@agnisemi.ai', 'member');
  ```
  Your own email is already seeded as `admin`. A magic link for an email not in the allowlist is rejected by a trigger on `auth.users`.

## 3. Git remote and Vercel

```bash
gh repo create spencerware-cell/agni-data-vault --private --source . --push
```
(or create the repo in the GitHub UI and `git remote add origin ... && git push -u origin main`).

Vercel: New Project > import `agni-data-vault` > Framework Vite, Root Directory `.` (repo root) > add the five env vars from section 1 (the two `VITE_` ones plus the three server ones) > Deploy. `vercel.json` already routes `/api/*` to the single function and everything else to the SPA.

## 4. First login and end-to-end check

1. Open the Vercel URL, enter `spencer.ware@agnisemi.ai`, click the magic link (or paste the 6-digit code).
2. Admin > Fields: add a `number` field `anneal_temp_c` on measurements; open a measurement form and confirm it appears; `curl -H "Authorization: Bearer <key>" https://<app>/api/schema` lists it.
3. Import the registry: `VAULT_API_URL=https://<app> VAULT_API_KEY=<key> python cli/import_samples_yaml.py ../Model/samples.yaml`.
4. Upload one Clarius file to a measurement from the browser (drag-and-drop) and confirm the quick plot renders.

## 5. Housekeeping

- Delete the empty placeholder Supabase project `usxpqxdxtgidptlnkraz` if you want headroom on the two-active-projects limit.
- Free tier pauses the project after 7 idle days; restore from the dashboard.
- Plan the Pro upgrade before bulk-backfilling `Agni/data` (about 5 GB vs 1 GB free storage).
