# Deploy checklist — edaserver

Steps that need a login, a secret, or a decision no build agent can make. `docs/UNIFIED_ENDPOINT.md`
explains *why* the architecture is shaped this way; this is the order to do it in.

> **The hosted Supabase projects stay up and unpaused until their cold archives are
> restore-verified.** `ARCHIVE_RUNBOOK.md` E3: *"It remains the system of record until something
> else has demonstrably replaced it."* The historical checklist for that deployment is at the
> bottom, kept because it is still live.

---

## 0. Prerequisites that gate everything

Do not start section 1 until all five are true. Each is a §2 item in the plan and each can
silently ruin a cutover rather than fail one.

1. **A proven restore.** `tools/verify_archive.py --full --check-dumps --db` returns a real PASS —
   not `SKIP` — for `sanity_floor` and `table_parity`, and `state/last_restore_verify.json` is
   current. What the archive certifies today is that the *bytes* are intact, not that they come
   back as a working database, and the archive is the seed for both halves of the new system.
   Every `pg_restore` run with **`--exit-on-error`**: it is not the default, and without it
   `pg_restore` prints `WARNING: errors ignored on restore: N` and **exits 0**, so a scheduled
   check of the exit code certifies a half-restored database forever.
2. **A second physical copy.** Before cutover the hosted projects *are* the second copy; after, they
   are not. `/srv/nextcloud/fedbench` is one allocation on one shared spindle mounted `noquota` —
   "a single disk failure away from being nothing". If the NAS has not arrived, the interim answer
   is encrypted nightly `pg_dump` plus `restic`/`rclone` of `objects/` to Backblaze B2.
3. **x86_64 PostgREST.** Every install note in the testbench hardcodes aarch64.
4. **Tailscale ACL `agnipi → edaserver:443`.** Today's ACL only opens the other direction. The
   bench watcher cannot reach the new endpoint without it, and it **backs off silently** rather
   than erroring — the failure looks like "no new data" for hours.
5. **DNS delegation** of `vault.agnisemi.ai` to Cloudflare, and Google Workspace confirmed as an
   Access IdP for the org.

---

## 1. Secrets on edaserver

All of these live in `/etc/vault/vault-api.env` (mode `0600`, owned by the service account).
**Nothing here is ever a `VITE_` variable** — that is a CI invariant, not a convention.

| var | where it comes from | notes |
|---|---|---|
| `VAULT_REST_URL` | `http://127.0.0.1:8087` | the nginx shim, kept verbatim; see UNIFIED_ENDPOINT §1 |
| `VAULT_STORAGE_URL` | `http://127.0.0.1:8087` | same origin — `fed_storage` behind the same shim |
| `VAULT_SERVICE_JWT` | `tools/mint_service_jwt.py --role vault_service` | **must** name `vault_service`; a weaker role returns `[]` from every table and the vault looks empty rather than unauthorised |
| `VAULT_API_KEY` | `python -c "import secrets;print(secrets.token_urlsafe(32))"` | the break-glass machine path — the CLI keeps working with Google down. This is why there is no second password anywhere. |
| `VAULT_ACCESS_TEAM_URL` | Cloudflare Zero Trust → Settings → Custom Pages | `https://<team>.cloudflareaccess.com` |
| `VAULT_ACCESS_AUD` | the Access application's Audience tag | checked on every assertion |
| `VAULT_EMAIL_DOMAIN` | `agnisemi.ai` | checked against the **`hd` claim**, not the email suffix — `hd` is asserted by Google about the account's domain and cannot be satisfied by a personal account with a lookalike address |
| `VAULT_ADMIN_BOOTSTRAP` | your own address | seeds the first admin; everyone else auto-provisions as `member` |
| `ANTHROPIC_API_KEY` | console.anthropic.com | **optional.** Without it `/api/search/ask` returns 503 `agent_unavailable` and everything else works. |
| `PORT` | `8099` | loopback only |

**`PGRST_JWT_SECRET` is in no dump.** Losing that 32-character string bricks the entire data
plane. Store it out of band (SOPS + `age`). It must be ≥32 characters or PostgREST refuses to
start — the one misconfiguration that fails loudly. If you generate it as base64, set
`PGRST_JWT_SECRET_IS_BASE64=true` or the HMAC input differs between PostgREST and
`fed_storage/auth.py`, and the symptom is *"metadata reads succeed and capture downloads 401"*,
which reads as **the archive is corrupt** rather than **the secret is wrong**.

---

## 2. Database

```bash
psql -d fedbench -v ON_ERROR_STOP=1 -f server/deploy/selfhost_schema.sql   # the bench, in `public`
for f in supabase/migrations/selfhost/0*.sql; do psql -d fedbench -v ON_ERROR_STOP=1 -f "$f"; done
```

Sixteen migrations, `0100`–`0115`, applied **in order**. Verified to apply clean to a fresh
database on top of the bench schema.

Then check the thing that fails silently:

```bash
psql -d fedbench -c "select rolname, rolbypassrls from pg_roles where rolname like 'vault%' or rolname like 'bench%'"
```

**`vault_service`, `vault_read` and `bench_service` must all show `rolbypassrls = t`.** Every table
has RLS enabled with **no policies**; that works *only* because these roles bypass it. Get it
wrong and nothing errors — PostgREST returns `[]` for every table, the API reports success, and
the vault looks unmeasured rather than unauthorised. `/healthz` reads one row it knows exists for
exactly this reason.

---

## 3. Services

`cp` the units, **never `mv`** — on RHEL 9 a moved file keeps its source SELinux context and
systemd then refuses to load it, with an error that looks like a malformed unit.

SELinux, enforcing, and each of these fails as something else:

```bash
sudo setsebool -P httpd_can_network_connect 1      # or nginx→loopback is denied and you get a 502
sudo semanage port -a -t http_port_t -p tcp 8087   # or the bind is denied
sudo ausearch -m avc -ts recent                    # the debug ritual: suspect SELinux first
```

Timers to enable (all are `.timer`, not `.service`):

| timer | cadence | what it does |
|---|---|---|
| `fedbench-vault-analysis` | as configured | publishes campaign analysis |
| `fedbench-vault-metrics` | hourly | Clarius workbooks → `vault.measurement_metrics`. **Needs `dnf install python3-openpyxl`** — the only tool in `tools/` that is not stdlib-only, and it fails as a `ModuleNotFoundError` that reads like a broken script. |
| `fedbench-vault-register-devices` | 30 min | registers bench cells as vault devices |

---

## 4. Cutover, in order

Vault first. Counterintuitive, since the bench is the one at 83.5% of its cap — but the bench is
**riskier** to move (live, continuously writing, a mistake corrupts ~86-hour campaigns that cannot
be re-run) while the vault is merely **harder** (its cutover is a rewrite, because Supabase Auth
has no equivalent). The vault is the shakedown cruise for the endpoint, against data whose worst
case is a day of relabelling. The bench's capacity pressure has its own stopgap: its write path is
local-first, so hitting the cap costs sync lag, not data.

1. Deploy with **`VAULT_READONLY=1`** and compare pages side by side against the live site.
   `POST /api/cohorts/summary` and `POST /api/search/ask` still work under the flag — they compute
   and write nothing — so the analysis features are actually exercised. `POST /api/cohorts` and
   `POST /api/search/:id/accepted` are refused, which is the point of an exact-path allow-list.
2. Freeze hosted writes by **revoking the anon key's grants**. Do not pause the project.
3. Final delta sync, clear `VAULT_READONLY`, rotate `VAULT_API_KEY`.
4. Bench dual-write (`FED_SUPABASE_MIRROR_*`), one full campaign, then parity: row counts, object
   counts, a sha256 sample.
5. Bench cutover: flip `FED_SUPABASE_URL`/`KEY`, drop the mirror vars.

**Blobs first, never dump first**, throughout. Blobs-first can only leave a row with no blob —
classifiable, and fixed by re-running. Dump-first leaves a blob with no row: an orphan nobody can
interpret later. Use `tools/archive_supabase.py` (keyset paging, sha256-verified), **never
`tools/fetch_run.py`** — its offset paging silently *skips* rows against a table receiving
inserts, and it skips re-download on matching **size**, not sha.

---

## 5. Verify

```bash
VAULT_API_URL=https://vault.agnisemi.ai VAULT_API_KEY=<key> bash scripts/smoke.sh
```

Then the checks that matter, all of which must **fail closed**:

- `curl https://vault.agnisemi.ai/rest/v1/captures` → must **not** reach PostgREST. Only `/api` is
  published through the tunnel; the data plane is never public.
- The tunnel origin with a forged `Cf-Access-Jwt-Assertion` → 401. The assertion is
  cryptographically verified, not trusted as a header.
- From off-tailnet: `100.87.250.124:3000`, `:3001`, `:5432` → unreachable.
- `nmap` the public IP → no new inbound port versus the phase-0 baseline. `cloudflared` dials out.
- Revoke `bypassrls` from `vault_service` in a **scratch** database → `/healthz` goes red, not
  green-with-empty-results.

And the human path: a login through Access with a Workspace account; a **rejection** with a
non-Workspace account and with one whose `hd` does not match; `created_by` on a browser-created row
is the real user's email rather than `'api'`; `audit_log.actor` is populated.

Bench regression gate, **unmodified**: `test_supabase.py`, `test_campaign_cloud.py`,
`test_campaign_watcher.py`, `test_watcher_storage_alerts.py`. *If they need changing, the wire
protocol drifted and the premise of this migration is gone.* Then a short real campaign, verified
by counting `device_tests` rows for that `run_id` — **not** `campaign_runs.n_measured`, which is
only written at the end of a run.

---

## 6. Decommission (only after 4 and 5)

- Remove all five Supabase env vars from Vercel; deploy a branch with an **empty** `api/` and a
  static "this moved" page — no JS, no bundle, no key.
- **Rotate the hosted service-role key and `VAULT_API_KEY` regardless.** A key that lived in a
  public serverless function's environment for months should be assumed exposed.
- Magic links stop existing. Pending ones die; the new page explains why.

---

## Historical — the hosted Supabase deployment

Kept because it is still live until section 6. Project `agni-data-vault`, ref
`phniloxolwrbrrkbccvb`, us-east-1, free tier.

Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `VAULT_API_KEY`.

Auth was Supabase magic link plus a trigger on `auth.users` checking a `public.allowlist` table;
signups had to stay enabled because the trigger was the gate. Under Cloudflare Access none of that
applies — identity comes from a verified assertion, `allowlist` survives only as the **role map**
(`is_admin()` is still a real distinction the app makes), and members auto-provision on first
request.

Free tier pauses after 7 idle days; restore from the dashboard.
