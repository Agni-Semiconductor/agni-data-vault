# Deploy checklist — edaserver

The ordered runbook for standing this platform up on `edaserver`, self-hosted.
`docs/UNIFIED_ENDPOINT.md` explains *why* the architecture is shaped this way and `docs/CONTRACT.md`
is the developer's document; this one is the order to do it in, and what each step fails as when it
is skipped.

The hosted Supabase deployment this replaces is **not deleted from this file**. Its steps are kept
at the bottom under "Historical", because it stays up and unpaused until its cold archive is
restore-verified — `ARCHIVE_RUNBOOK.md` E3: *"It remains the system of record until something else
has demonstrably replaced it."* A decommissioned step that is still live is worse than a stale one,
because nobody can tell afterwards which it was.

---

## Read off the box, 2026-09-11

Everything in this block was read from the running system rather than inferred, and most of the
steps below depend on one line of it. **Nothing outside this block is marked verified.**

- `edaserver`, RHEL 9.8, x86_64, 64 cores. SELinux **enforcing**.
- **PostgreSQL 17.10 (PGDG) is already running**, `PGDATA=/var/lib/pgsql/17/data`, listening on
  `127.0.0.1:5432` and nothing else. Peer auth works over the unix socket; a TCP connection to
  `127.0.0.1` wants a password.
- `psql` on `PATH` is `/home/shared/eda/siemens/calibre/current/bin/psql`, not the server's own
  client. That one gets a section to itself.
- `postgresql17-contrib` was missing and **has just been installed**. `pg_trgm` and `citext` live in
  it, and their absence has already stopped this migration chain once on this box.
- Nothing is listening on 3000, 3001, 8087, 8098, 8099, 443 or 80, and none of `postgrest`, `caddy`,
  `cloudflared`, `nginx`, `node` or `rclone` is installed. `restic` is. **This is a clean install
  rather than a negotiation with something already running.**
- Accounts: `fedbackup` runs the existing archive units out of
  `/srv/fedbackup/ferrodiode-pcb-testbench`, mode `0750` and unreadable to anyone else. `agnidata`
  is the new deployment account — login, **no sudo**. `vaultsvc` is the new nologin service account
  the API runs as.
- Every `fedbench-*` timer fires on schedule, and **`fedbench-verify` has never run once**:
  `systemctl show fedbench-verify.service -p ExecMainStartTimestamp` returns empty. It next fires
  2026-10-01.

Storage, and the four volumes differ in the way that matters:

| Mount | Size | Redundancy | What it means here |
|---|---|---|---|
| `/` | 888 G, 861 G free | RAID1, two NVMe mirrored | Postgres defaults to `/var/lib/pgsql`, which is here; the right home, and no decision needed |
| `/storage` | 3.8 T | RAID1, two NVMe mirrored | spare capacity, untouched by this stack |
| `/srv/nextcloud` | 7.3 T | **single disk, no redundancy** | the archive lives here, so the archive is one disk failure from being nothing |
| `/mnt/nasbackup` | 11 T, 6 T free | NFS to `10.10.10.50` | the second physical copy the cutover gate wants, now that it exists |

---

## 0. Prerequisites that gate everything

Do not start section 2 until all six are true. Each one can silently ruin a cutover rather than fail
one, which is why they are a gate and not a step.

Run `bash deploy/preflight.sh` first. It changes nothing — no installer, no file outside `/tmp`, no
service started or stopped — and it reads only the paths this project owns, named one at a time, so
it can be run on somebody else's EDA machine without an argument afterwards about what it touched.
The block above is what it prints.

1. **DNS delegation of `vault.agnisemi.ai` to Cloudflare.** The domain is not on Cloudflare today.
   Until it is there is no hostname for the tunnel to route and no zone to attach an Access
   application to, so the whole of section 7 waits on a change somebody has to make at the
   registrar. It is the longest-lead item here and the one most often started last.
2. **Google Workspace confirmed as an Access IdP for the org.** An Access application with no
   Workspace IdP configured falls back to one-time PIN by email, which satisfies the login screen
   and admits **any address that can receive mail** — the gate looks fitted and is not. The policy
   checks Google's `hd` claim as well as the email suffix (`api/_lib/identity.js`), and `hd` only
   exists on a Workspace assertion.
3. **Tailscale ACL `agnipi → edaserver:443`.** Today's ACL opens only the other direction. The bench
   watcher cannot reach the new endpoint without it, and it **backs off silently** rather than
   erroring, so the symptom is "no new data" for hours with nothing anywhere calling itself a
   failure.
4. **A second physical copy.** The NAS is mounted with 6 T free, so this gate is satisfiable today
   rather than awaiting hardware — but **nothing has been written to it yet**, and until something
   has, the archive sits on the one volume with no redundancy. A copy on the same spindle as the
   original is not a copy.
5. **A proven restore.** `fedbench-verify` has never started. What the archive certifies today is
   that the *bytes* are intact, not that they come back as a working database, and the archive is
   the seed for both halves of the new system. Require a real PASS from
   `tools/verify_archive.py --full --check-dumps --db` — not `SKIP` — for `sanity_floor` and
   `table_parity`. Every `pg_restore` on that path runs with **`--exit-on-error`**: it is not the
   default, and without it `pg_restore` prints `WARNING: errors ignored on restore: N` and **exits
   0**, so a scheduled check of the exit code certifies a half-restored database forever.
6. **An x86_64 PostgREST binary.** The box is x86_64; every install note in the testbench repo
   hardcodes aarch64, from when the Pi was the target. That one at least fails loudly, and it is on
   this list only because copying a URL out of a document that has been correct for two years is the
   easiest mistake here to make.

---

## 1. The `psql` on `PATH` is not the one you want

```
$ command -v psql
/home/shared/eda/siemens/calibre/current/bin/psql     <- Siemens Calibre ships its own client
/usr/pgsql-17/bin/psql                                <- the one matching the running 17.10 server
```

Both PostgreSQL 16 (the RHEL module) and 17.10 (PGDG) are installed, and Calibre's bundled client
wins on `PATH`. **Every command in this file names `/usr/pgsql-17/bin/psql` in full, and so must
every script anyone writes on this box.** A migration chain run through whatever client a layout
tool happens to bundle is not a thing to discover afterwards: the version skew arrives as a syntax
or protocol error that gets attributed to the migration rather than to the client.

`deploy/apply-migrations.sh` already defaults to the absolute path for exactly this reason, which
makes it the one command here you do not have to correct by hand.

**Do not fix this by editing a shared profile.** Putting `/usr/pgsql-17/bin` at the front of `PATH`
system-wide changes which client every EDA tool on this machine gets, to save one operator some
typing. Alias it in your own shell if you want the short form.

Prefer the unix socket. `psql` with no `-h` uses peer auth and works for an OS user with a matching
Postgres role; `-h 127.0.0.1` wants a password, and a password prompt in the middle of a scripted
run reads as a hang.

---

## 2. Accounts and permissions

`deploy/bootstrap-accounts.sh` creates them, runs as root **on the server**, and is idempotent.
`agnidata` and `vaultsvc` already exist, so this section is mostly a description of what is there
and why it is shaped that way.

- `agnidata` — login, SSH key, the account deployment work happens as. This is what replaces
  operating as a person's own account.
- `vaultsvc` — nologin, no shell, no key, no password. The API runs as this and nothing else does.
  A service account that can be logged into is a person's account with extra steps.
- `/srv/vault`, owned `agnidata:vaultsvc`, mode `0750`: the deploy account writes into it, the
  service account only reads it. **A service that can rewrite its own code is one bug away from
  persisting a change nobody deployed.**
- `/etc/vault`, owned `root:vaultsvc`, mode `0750`. The deploy account does not need to read the
  token it installs.

Two things about the script worth knowing before running it again:

- **Quote the public key in single quotes.** It contains spaces, and unquoted it arrives as three
  arguments. The script refuses anything that does not look like a public key rather than writing
  it, because sshd *silently ignores* a malformed `authorized_keys` line and the symptom is an
  ordinary `Permission denied (publickey)` with nothing in the log to say why. It refuses a private
  key outright, where the same slip would be both useless and a disclosure.
- It runs `restorecon` on `~/.ssh` for the same class of reason: sshd ignores an `authorized_keys`
  whose modes are loose or whose SELinux context is wrong, and the failure is again an ordinary
  permission denial rather than anything mentioning contexts.

**`agnidata` has no sudo on this box, and that is a decision rather than an omission.** A
sudo-capable account is a root-capable account, and root can read the EDA work whether or not
anything here touches it — the script's own header is explicit that a scoped command list buys
organisational separation and *not* a technical guarantee, because anything that can install a
systemd unit can install one that reads anything. The cost is a round trip per privileged step:
every `sudo`, `systemctl` and `semanage` line below is run by somebody who already has root.

Leave `fedbackup` and `/srv/fedbackup/ferrodiode-pcb-testbench` alone. Nothing in this checklist
needs them, and that tree being mode `0750` is why an unprivileged survey reports those paths as
empty rather than as denied — correct, not broken.

---

## 3. The database

One cluster, one database, two schemas plus the interface schema: `fedbench` holds the bench in
`public` and the vault in `vault`, and `connect` is the read-only interface `agni-connect` consumes.

**Create the database first.** `deploy/apply-migrations.sh` deliberately does not create it and
deliberately does not apply the bench schema — creating a database is a decision, and the bench
schema belongs to the other repo.

```bash
sudo -u postgres /usr/pgsql-17/bin/createdb fedbench
```

### 3a. The bench schema, into `public`

```bash
sudo -u postgres /usr/pgsql-17/bin/psql -d fedbench -v ON_ERROR_STOP=1 \
  -f <checkout>/ferrodiode-pcb-testbench/server/deploy/selfhost_schema.sql
```

Use a checkout the applying user can actually read. The copy at
`/srv/fedbackup/ferrodiode-pcb-testbench` is mode `0750` and owned by `fedbackup`, so it is not it,
and the failure is a bare "No such file or directory" that reads as a wrong path rather than as a
permission.

This creates `authenticator`, `bench_service`, `bench_read` and `bench_storage`. **`public` is the
bench schema and must stay so.** `fed_instruments/supabase.py` never sends `Accept-Profile`, so the
bench must be PostgREST's default profile; `cloud.py`'s `rpc("bench_storage_usage")` resolves in the
request's profile, so moving the schema 404s that call and kills the watcher's storage-watermark
alerting with no error at all — just no alerts, until the bucket fills; and four restore tools
hardcode `--schema=public`. `UNIFIED_ENDPOINT.md` §2 has the full argument.

### 3b. The vault chain, `0100`–`0118`

```bash
bash deploy/apply-migrations.sh --db fedbench --dry-run
bash deploy/apply-migrations.sh --db fedbench
```

Nineteen files, applied **in order**, each assuming the ones before it.

**The script keeps a ledger, and its point is not to stop double-applying.** Every file is written to
be re-runnable. What the ledger catches is a migration **edited after it was applied**, which is
otherwise invisible — and it has already happened in this repo's history: `0112` and `0113` were
corrected after they had run against a validation database, and nothing anywhere would have told the
next person that the file on disk no longer described what was in their database. A sha256 per file
turns that silent divergence into a stop. When you have decided an edit is safe against *this*
database, `--allow-edited` records the new digest; it does not re-apply anything you have not also
re-run.

On the connection, which is where this box differs from every other:

- `--psql-cmd` already defaults to `/usr/pgsql-17/bin/psql`. Pass it only for a containerised
  target.
- `--pg-user` is deliberately empty, so `psql` uses the connecting OS user over the socket. **Run
  the script as an OS user that has a matching Postgres role** rather than passing `-U postgres`
  from another account: peer auth matches the OS user to the role name, and `-U` from the wrong
  account fails as `Peer authentication failed`, which on a box where TCP genuinely does want a
  password reads as a credential problem rather than a choice-of-socket one.
- The script reads the migration files as whoever runs it, so the checkout must be readable by that
  user as well. `/srv/vault` is `0750 agnidata:vaultsvc` and `postgres` is in neither, which
  surfaces as `no migrations matched .../0*.sql` — the script refuses to report success over an
  empty set, which is the one way this could have gone wrong quietly and does not.

**Install `postgresql17-contrib` before building any further database on this box.** The chain has
already failed here once: it stopped at `create extension pg_trgm` because contrib was absent, and —
before `0100` was wrapped in a transaction — the statements ahead of the failure had already
committed, leaving two schemas behind from a migration the ledger correctly recorded as never
applied. The package is installed now and `0100` is transactional, but the failure presents as a
broken migration rather than as a missing package, so it is worth recognising on sight.

The script finishes by naming what should exist rather than counting what ran, and prints
`schemas present: vault, connect`. A count is not a verification: "19 applied" can otherwise mean
nineteen files ran and produced a database missing half its objects.

### 3c. The check that fails silently

```bash
/usr/pgsql-17/bin/psql -d fedbench -c \
  "select rolname, rolbypassrls from pg_roles where rolname ~ '^(vault|bench|connect)'"
```

**`vault_service`, `vault_read` and `bench_service` must all show `rolbypassrls = t`, and
`connect_read` must not.** Every table in both schemas has RLS enabled with **no policies**, which
works *only* because the service roles bypass it. Get it wrong and nothing errors: PostgREST returns
`[]` for every table, the API reports success, and the vault looks **unmeasured** rather than
**unauthorised**. `bench_read` deliberately holds neither grants nor the flag — it is
`PGRST_DB_ANON_ROLE`, and its job is to answer "permission denied" rather than to read anything.

`connect_read` is the inverse case, and the reason to check the flag in both directions: it is the
interface role handed to another product, it holds no grant on `vault` or `public` at all, and with
`BYPASSRLS` one wrong grant there would expose everything instead of nothing (contract v2.18).

This is also the entire reason `/healthz` reads a row it knows exists instead of answering a bare
200. See section 8.

---

## 4. Secrets and the environment file

All of these live in `/etc/vault/vault-api.env`, mode `0640`, owned `root:vaultsvc` — the unit reads
it as `EnvironmentFile` and the deploy account never needs to see it. **Nothing here is ever a
`VITE_` variable**: that is a greppable CI invariant rather than a convention, because anything
`VITE_`-prefixed is inlined into the browser bundle at build time.

| var | where it comes from | notes |
|---|---|---|
| `VAULT_REST_URL` | `http://127.0.0.1:8087` | the nginx shim, kept verbatim; see §5 |
| `VAULT_STORAGE_URL` | `http://127.0.0.1:8087` | same origin — `fed_storage` behind the same shim |
| `VAULT_SERVICE_JWT` | `tools/mint_service_jwt.py --role vault_service` | **must** name `vault_service`; a weaker role returns `[]` from every table and the vault looks empty rather than unauthorised |
| `VAULT_API_KEY` | `python -c "import secrets;print(secrets.token_urlsafe(32))"` | the break-glass machine path — the CLI and the bench keep working with Google down. This is why there is no second password anywhere. |
| `VAULT_ACCESS_TEAM_URL` | Cloudflare Zero Trust → Settings → Custom Pages | `https://<team>.cloudflareaccess.com`; the JWKS is fetched from it |
| `VAULT_ACCESS_AUD` | the Access application's Audience tag | checked on every assertion |
| `VAULT_EMAIL_DOMAIN` | `agnisemi.ai` | checked against the **`hd` claim** as well as the suffix — `hd` is asserted by Google about the account's domain and cannot be satisfied by a personal account with a lookalike address |
| `VAULT_READONLY` | `1` for the shakedown deploy, empty after | rejects POST/PATCH/DELETE before the router is reached, so no resource can opt itself out |
| `ANTHROPIC_API_KEY` | console.anthropic.com | **optional.** Without it `/api/search/ask` returns 503 `agent_unavailable` and everything else works — an unconfigured optional feature is a deployment state, not a fault. |
| `PORT` | `8099` | loopback only. **Not 3001**, which the object store owns on this host. |

actually reads are the ones in the table above, and `.env.example` is the copy to trust.

**`PGRST_JWT_SECRET` is in no dump.** It is minted once and lives only in
`<checkout>/server/config/secrets.env`, mode `0600`, owned by `fedbackup`; losing it bricks the
entire data plane, and regenerating it is not recovery. Store it out of band (SOPS + `age`). The
directory must be labelled `etc_t`, or systemd cannot read the environment file even though its mode
and ownership are correct. It must be ≥32 characters or PostgREST refuses to start — the one
misconfiguration in this file that fails loudly. It must be the **same value** as
`FED_PGRST_JWT_SECRET`, and if you generate it as base64 you must also set
`PGRST_JWT_SECRET_IS_BASE64=true`, or the HMAC input differs between PostgREST and
`fed_storage/auth.py` and the symptom is *"metadata reads succeed and capture downloads 401"* —
which reads as **the archive is corrupt** rather than **the secret is wrong**.

---

## 5. The data plane: PostgREST, `fed_storage`, the nginx shim

PostgREST 16.3 listens on `127.0.0.1:3000`, `fed_storage` on `127.0.0.1:3001`, and the nginx shim
on `127.0.0.1:8087`; `ss -lnt` verifies that all three are loopback only. Caddy, the Tailscale
certificate and the Cloudflare tunnel are not configured yet, so nothing is reachable from the
tailnet.

**Take the x86_64 PostgREST build.** Every install note in the testbench repo hardcodes aarch64.

```
PGRST_DB_SCHEMAS="public,vault,connect"     # public FIRST
PGRST_DB_ANON_ROLE="bench_read"
PGRST_DB_EXTRA_SEARCH_PATH="extensions"
PGRST_JWT_SECRET=<the out-of-band secret>
```

`public` first because it is the default profile and the bench's client never sends `Accept-Profile`
on any of its seven verbs. `bench_read` as the anon role because it holds zero grants, so an
unauthenticated request gets Postgres `42501` `permission denied` as HTTP 401 and never an empty
array. This is verified on `public/captures`, `vault/samples`, and `connect/kinds`. `extensions` on
the extra search path because `citext` and `pg_trgm` were installed into that schema rather than
into `public`, and without it a query touching a `citext` column fails with `type "citext" does not
exist` — which reads as a missing extension rather than as a missing search path.

**Keep `nginx-fedbench.conf` verbatim.** It exists because `supabase-js` appends `/rest/v1` to its
base URL: the shim is what lets the bench's seven verbs and the vault's own client work unchanged,
and pointing a client straight at PostgREST 404s everything. It fronts PostgREST on 3000 and
`fed_storage` on 3001, and it strips the prefix exactly once via a trailing slash on `proxy_pass` —
which is why Caddy above it uses `handle` rather than `handle_path` (§6).

The live nginx routes are `/rest/v1/` to `127.0.0.1:3000/`, which strips that prefix, and
`/storage/v1/` to `127.0.0.1:3001`, which does not. Everything else is 404. With a `connect_read`
token, `connect.kinds` returns seven rows through that full path. `connect.health` correctly returns
all zeros today: the 19 selfhost migrations, `0100` through `0118` (not `0115`), created the schema,
but no vault data has been migrated from hosted Supabase yet. All three services are enabled and
active.

`fed_storage` serves both buckets from one root with roles **per bucket and per verb**: the `bench`
bucket is readable by `bench_service` and `vault_service`, writable only by `bench_service`, and
deletable by nobody — 405, even with a valid bench token. Collapsing these into one role per bucket
looks tidier, passes every other test in the file, and breaks capture serving with a 401 that reads
as a bad token. Three tests guard it for that reason.

`fed_storage` serves the live object root from `/srv/fedbench/objects`, mode `0750`, owned by
`fedbackup`, on the RAID1 root. Its health response is
`{"ok":true,"root":"/srv/fedbench/objects","writable":true}`. Do not serve
`/srv/nextcloud/fedbench/objects`: that is the nightly cold archive on a single non-redundant 7.3T
disk, so using it live would make backup and primary the same directory.

### SELinux is enforcing, and each of these fails as something else

```bash
sudo setsebool -P httpd_can_network_connect 1      # else nginx→loopback is denied and you see a 502
sudo semanage port -a -t http_port_t -p tcp 8087   # else nginx cannot bind and the unit fails at start
sudo semanage fcontext -a -t etc_t '/srv/fedbackup/ferrodiode-pcb-testbench/server/config(/.*)?'
sudo semanage fcontext -a -t bin_t '/srv/fedbench/venv/bin(/.*)?'
sudo semanage fcontext -a -t usr_t '/srv/fedbackup/ferrodiode-pcb-testbench/server/src(/.*)?'
sudo restorecon -Rv /srv/fedbackup/ferrodiode-pcb-testbench/server/config /srv/fedbench/venv/bin /srv/fedbackup/ferrodiode-pcb-testbench/server/src
sudo ausearch -m avc -ts recent                    # the debug ritual: suspect SELinux first
```

`semanage fcontext` records the rule; `restorecon -R` applies it. Running the former without the
latter looks like a fix and is not. These three labels cover different accesses: `etc_t` lets
systemd read `secrets.env`, `bin_t` lets systemd execute the interpreter, and `usr_t` lets the
service import its code.

`fedbackup` has `HOME=/srv/fedbackup`, so its testbench checkout at
`/srv/fedbackup/ferrodiode-pcb-testbench` is labelled `user_home_dir_t` / `user_home_t`. This makes
two ordinary unit settings fail for different reasons. PID 1 reads `EnvironmentFile` as `init_t`,
and policy forbids `init_t` reading `user_home_t`; the unit says `Failed to load environment files:
Permission denied` even when mode and owner are correct and root can read the file from a shell.
PID 1 also cannot execute a binary labelled `user_home_t`: when `ExecStart` named the bench
`.venv/bin/python`, the unit said `Failed to locate executable ...: Permission denied`, which reads
as a missing file. The denial was the symlink, `tcontext=user_home_t tclass=lnk_file`, not a missing
interpreter or label mentioned by the error. On this host, suspect SELinux first and use
`sudo ausearch -m avc -ts recent`.

`fed-postgrest` started in that same run because `/usr/local/bin/postgrest` is `bin_t`: `bin_t`
permits execution and the service transitions out of `init_t`. That contrast is the diagnosis, not
evidence that the other units have correct ownership or paths.

**Install every unit with `cp`, never `mv`.** A moved file keeps its source SELinux context and
systemd then refuses to load it, with an error that reads as a malformed unit — so the next hour
goes on the unit file, which is fine.

```bash
sudo cp deploy/vault-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vault-api
```

`fed-storage` has its own virtualenv at `/srv/fedbench/venv`, created from `/usr/bin/python3`
(`3.9.25`). Do not use the bench `.venv` for it: uv deliberately builds that virtualenv without pip,
so `python -m pip` says `No module named pip`, and `ensurepip` did not repair it. A system-Python
venv has pip and keeps the vault data path out of uv management, because `uv sync` prunes the
editable `keithley-control` install a running campaign depends on.

`node` is not installed on this box; install it before enabling the unit. The unit runs as
`vaultsvc` out of `/srv/vault/app` under `ProtectSystem=strict` and `NoNewPrivileges=true`.

Timers to enable — all are `.timer`, never `.service`, and enabling the service instead runs it once
and never again, which looks like it worked:

| timer | cadence | what it does |
|---|---|---|
| `fedbench-vault-analysis` | as configured | publishes campaign analysis into `public.cell_analysis` and `run_analysis` |
| `fedbench-vault-metrics` | hourly | Clarius workbooks → `vault.measurement_metrics`. **Needs `dnf install python3-openpyxl`** — the only tool in `tools/` that is not stdlib-only, and it fails as a `ModuleNotFoundError` in the journal that reads like a broken script rather than an unfinished install. |
| `fedbench-vault-register-devices` | 30 min | registers bench cells as vault devices |

---

## 6. The tailnet door: Caddy, and a certificate that expires in 90 days

Caddy is not installed. On the tailnet it is the only listener; PostgREST, the object store and
Postgres all stay loopback-bound.

Fill the placeholders in `deploy/Caddyfile` — `<tailnet>`, `<tailscale_cert_path>`,
`<tailscale_key_path>` — then:

```bash
tailscale cert --cert-file /etc/caddy/certs/edaserver.crt \
               --key-file  /etc/caddy/certs/edaserver.key  edaserver.<tailnet>.ts.net
sudo semanage fcontext -a -t etc_t '/etc/caddy/certs(/.*)?'
sudo restorecon -Rv /etc/caddy/certs
```

The context step is not optional: **a certificate Caddy cannot read fails exactly like a certificate
that does not exist**, while everything on disk says the file is there.

### The renewal is two halves, and people ship one

`tailscale cert` issues a real Let's Encrypt certificate over DNS-01, valid **~90 days**, and nothing
renews it on its own. `deploy/Caddyfile` pins the files with an explicit `tls <cert> <key>`, which
**Caddy reads at config load and does not watch**. So the renewal *and* the reload are both required,
and either one missing produces the same outage three months after go-live — far enough from any
deploy that nobody connects it to its cause.

```bash
sudo cp deploy/tailscale-cert.service deploy/tailscale-cert.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start tailscale-cert.service      # prove it works BEFORE trusting the timer
sudo systemctl enable --now tailscale-cert.timer
```

Enable the **timer**, not the service, and run the service once by hand first: a timer whose unit has
never succeeded is a renewal you have assumed rather than observed. `fedbench-verify` in the block at
the top of this file is precisely that mistake, sitting enabled and never once started.

`/etc/vault/tailscale-cert.env` (root:root, `0640`) carries `TAILSCALE_CERT_DOMAIN`,
`TAILSCALE_CERT_PATH` and `TAILSCALE_KEY_PATH`. **Those paths appear twice — here and in the
Caddyfile — and must be identical.** A mismatch writes the renewed certificate somewhere Caddy is not
looking, which reads as a renewal that worked right up until the door stops serving TLS.

The renewal script reloads Caddy **only when the certificate bytes change**, because `tailscale cert`
is idempotent and returns the existing certificate until it is near expiry; an unconditional reload
would drop Caddy's config every day to install a file identical to the one already loaded. It reloads
rather than restarts, because the bench watcher's uploads are the requests most likely to be in
flight.

Set `OnFailure=` in `tailscale-cert.service` to something that reaches a human. **A failed renewal is
silent for weeks and then total:** the bench watcher reads a TLS error as unreachable and backs off
quietly, so the first symptom is sync lag nobody is watching.

**The short name `https://edaserver` can never have a valid certificate.** MagicDNS resolves the
name; nothing issues a certificate for it. Use the full `.ts.net` name everywhere. Those names are
publicly resolvable and appear in Certificate Transparency logs — not routable from outside the
tailnet, but the hostname is public knowledge, which is why every path behind this door
authenticates rather than relying on the name being unguessable.

Two things in the Caddyfile not to tidy:

- **`handle`, not `handle_path`.** `handle_path` strips the matched prefix, and the nginx config
  behind it expects the full `/rest/v1/...` and strips once itself. Strip it twice and PostgREST
  returns 404 for tables that exist.
- **The trailing bare `handle { respond 404 }`.** Without it a request matching no handler falls
  through the route with no handler at all and Caddy answers an empty 200, which is the most
  misleading response available.

Caddy also strips any client-supplied `Cf-Access-*` header on ingress. That is the second of two
independent reasons the assertion cannot be forged; the signature check in §7 is the one that
matters.

---

## 7. The public door: Cloudflare Tunnel and Access

`cloudflared` is not installed. **No inbound port is opened on this host** — `cloudflared` dials out,
which is why the `nmap` check in section 8 expects no change against the phase-0 baseline.

Fill `<cloudflare_tunnel_id>` and `<cloudflared_credentials_file>` in
`deploy/cloudflared-config.yml`. It publishes exactly one thing:

```yaml
  - hostname: vault.agnisemi.ai
    path: /api/*
    service: http://127.0.0.1:8099
  - service: http_status:404
```

**`/rest/v1` and `/storage/v1` are never published through the tunnel.** The token they carry
bypasses row-level security on every table, so there is no version of exposing them beyond the
tailnet that is safe. Everything that is not `/api/*` is served by Vercel as the other origin,
configured on the Cloudflare side rather than in this file: the SPA is static, holds no secret, and
nothing in it starts with `VITE_` except `VITE_API_BASE_URL`, which is an origin rather than a
credential.

Then the Access application on `vault.agnisemi.ai/api`, with the Workspace IdP from §0 and a policy
on the `agnisemi.ai` domain. Take its Audience tag into `VAULT_ACCESS_AUD`. Machine callers that must
come through the public door get an Access **service token**; machine callers on the tailnet use
`VAULT_API_KEY` and never touch Access at all.

**The assertion is verified cryptographically** (`api/_lib/accessJwt.js`): RS256 pinned from the
team's JWKS, `alg: none` and HMAC rejected, `aud` and `exp` checked, JWKS cached with a refetch on an
unknown `kid`. Trusting the header because it arrived through the tunnel would be a total bypass, and
it is exactly the shortcut that looks safe.

The invariant this door lives under: **no path on this host is protected by SSO alone.** `/rest/v1`
and `/storage/v1` validate the HS256 service JWT; `/api` validates `VAULT_API_KEY` **or** a
signature-verified Access assertion. SSO is an additional gate on human paths, never the only one.

---

## 8. Verify, and why a 200 is not a verification

**The health check must read a row it knows exists.** RLS is enabled on every table with no policies,
so a role without `BYPASSRLS` returns `[]` from every table while the API cheerfully reports success
— a bare 200 from `/healthz` would be green against a database that answers nothing. `/healthz`
therefore reads `field_definitions`, which migration `0104` seeds with 26 rows:

```
{"ok":true,"checks":{"database":{"ok":true,"field_definitions":26}}}
```

A count of 0 there is the failure this whole file is arranged around. **Treat `"ok":true` with a zero
count as red.**

Then the write walk and the read checks behind it:

```bash
VAULT_API_URL=https://vault.agnisemi.ai VAULT_API_KEY=<key> bash scripts/smoke.sh
```

It creates a sample, a measurement and a file, uploads, downloads and byte-compares, deletes, then
asserts the deleted file 404s — so a silently empty database cannot pass it. Its Part 2 block is
read-only and catches the deployment failures the write walk cannot: `GET /kinds` asserts that
`measurement_kinds` and `column_units` are non-empty (empty means `0111`/`0112` never applied, or the
role lacks `BYPASSRLS`), that `i_a` is amperes while `current_mA` is milliamperes, and that
`sql_expr` never leaves the server.

Then the checks that must **fail closed**:

- `curl https://vault.agnisemi.ai/rest/v1/captures` → must **not** reach PostgREST. Only `/api` is
  published through the tunnel; the data plane is never public.
- The tunnel origin with a forged `Cf-Access-Jwt-Assertion` → 401. The assertion is cryptographically
  verified, not trusted as a header.
- From off-tailnet: `edaserver:3000`, `:3001`, `:5432` → unreachable.
- `nmap` the public IP → no new inbound port versus the phase-0 baseline.
- Revoke `bypassrls` from `vault_service` in a **scratch** database → `/healthz` goes red, not
  green-with-empty-results. This is the one check that tests the check.

And the human path, which nothing automated covers: a login through Access with a Workspace account;
a **rejection** with a non-Workspace account and with one whose `hd` does not match; `created_by` on
a browser-created row is the real user's email rather than `'api'`; `audit_log.actor` is populated.

Bench regression gate, run **unmodified**: `test_supabase.py`, `test_campaign_cloud.py`,
`test_campaign_watcher.py`, `test_watcher_storage_alerts.py`. *If they need changing, the wire
protocol drifted and the premise of this migration is gone.* Then a short real campaign, verified by
counting `device_tests` rows for that `run_id` — **never `campaign_runs.n_measured`**, which is
written only at the end of a run, so a live campaign reads 0 while holding tens of thousands of child
rows.

Finally `npm run check:integration` against real PostgREST before believing a green unit run. Mocked
tests answer by table name without caring which schema was asked for, which is how `/api/bench/lines`
shipped a `db()` call scoped to `public` for a table that lives in `vault`: every mocked test passed,
and only the integration check saw PostgREST answer *"relation public.board_pin_map does not exist"*.

---

## 9. Cutover, in order

Vault first. Counterintuitive, since the bench is the one at 83.5% of its cap — but the bench is
**riskier** to move (live, continuously writing, and a mistake corrupts ~86-hour campaigns that
cannot be re-run) while the vault is merely **harder** (its cutover is a rewrite, because Supabase
Auth has no equivalent here). The vault is the shakedown cruise for the endpoint, against data whose
worst case is a day of relabelling. The bench's capacity pressure has its own stopgap: its write path
is local-first, so hitting the cap costs sync lag, not data.

1. Deploy with **`VAULT_READONLY=1`** and compare pages side by side against the live site.
   `POST /api/cohorts/summary` and `POST /api/search/ask` still work under the flag — they compute
   and write nothing — so the analysis features are actually exercised. `POST /api/cohorts` and
   `POST /api/search/:id/accepted` are refused. The allow-list matches **exact** normalised paths,
   because a prefix match on `cohorts` would also admit `POST /api/cohorts`, and a fail-closed flag
   with a prefix hole reads as protection while admitting the one verb it was added to stop.
2. Freeze hosted writes by **revoking the anon key's grants**. Do not pause the project.
3. Final delta sync, clear `VAULT_READONLY`, rotate `VAULT_API_KEY`.
4. Bench dual-write (`FED_SUPABASE_MIRROR_*`), one full campaign, then parity: row counts, object
   counts, a sha256 sample. Dual-write is a bounded migration mechanism with a defined end, not an
   architecture.
5. Bench cutover: flip `FED_SUPABASE_URL`/`KEY`, drop the mirror vars. That is the whole repointing,
   and it is the payoff of having preserved the PostgREST wire protocol.

**Blobs first, never dump first**, throughout. Blobs-first can only leave a row with no blob, which is
classifiable and fixed by re-running. Dump-first leaves a blob with no row: an orphan nobody can
interpret later. Use `tools/archive_supabase.py` (keyset paging, sha256-verified), **never
`tools/fetch_run.py`** — its offset paging silently *skips* rows against a table receiving inserts,
and it skips re-download on matching **size**, not sha.

---

## 10. Decommission (only after 8 and 9)

- Remove all five Supabase env vars from Vercel; deploy a branch with an **empty** `api/` and a
  static "this moved" page — no JS, no bundle, no key.
- **Rotate the hosted service-role key and `VAULT_API_KEY` regardless.** A key that lived in a public
  serverless function's environment for months should be assumed exposed.
- Magic links stop existing. Pending ones die; the new page explains why.

---

## Historical — the hosted Supabase deployment

**Not a live checklist.** Kept because the project stays up until section 10, and because deleting
the steps would leave nobody able to say what the old deployment actually did. Project
`agni-data-vault`, ref `phniloxolwrbrrkbccvb`, us-east-1, free tier — which pauses after 7 idle days
and is restored from the dashboard.

**The five environment variables, all now removed from the self-hosted deployment:**
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`VAULT_API_KEY` — the last of which survives under the same name, with a rotated value, as the
break-glass machine path in §4. The first two were `VITE_`-prefixed and therefore shipped in the
browser bundle; the self-hosted deployment permits exactly one `VITE_` variable,
`VITE_API_BASE_URL`, and it is an origin rather than a credential.

**The dashboard steps are gone rather than migrated.** Auth providers, redirect URLs, the SMTP
sender, RLS policy editing and storage bucket creation were all clicks in a web console with no
record in this repository — which is why nobody could answer "what is configured" without logging in.
Their equivalents here are `deploy/apply-migrations.sh` and the files under `deploy/`: reviewable,
diffable, and applied by a script that refuses when a file changed after it ran.

**Magic-link auth is gone, and so is the allowlist trigger.** Authentication was a Supabase magic link
plus a trigger on `auth.users` checking a `public.allowlist` table, which meant signups had to stay
*enabled*, because the trigger — not the signup setting — was the gate. That is a configuration that
reads as wide open and was not, and it only worked while the trigger did. Under Cloudflare Access none
of it applies: identity arrives as a cryptographically verified assertion carrying a Workspace `hd`
claim, and there is no `auth.users`, no OTP and no browser session. `allowlist` survives only as the
**role map**, renamed `people`, because `is_admin()` is still a real distinction the app makes for
deletes, role mutations and `audit_log` reads; a `security_invoker` view keeps the old name working.

Anything above that reads like a Supabase instruction and is *not* in this section has survived
deliberately. `supabase-js` is still the server-side client because it speaks PostgREST natively, and
`supabase/migrations/selfhost/` keeps its directory name because renaming it would break every path
in every tool that references it for no gain at all.
