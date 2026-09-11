# Deploy Operator Notes

## Placeholders

- `<tailnet>` in `deploy/Caddyfile`: the tailnet DNS name segment for `edaserver.<tailnet>.ts.net`.
- `<tailscale_cert_path>` in `deploy/Caddyfile`: absolute path to the certificate from `tailscale cert edaserver.<tailnet>.ts.net`.
- `<tailscale_key_path>` in `deploy/Caddyfile`: absolute path to the key from `tailscale cert edaserver.<tailnet>.ts.net`.
- `<cloudflare_tunnel_id>` in `deploy/cloudflared-config.yml`: named tunnel UUID or name.
- `<cloudflared_credentials_file>` in `deploy/cloudflared-config.yml`: absolute path to the named tunnel credentials JSON.

The two certificate paths appear TWICE — in `deploy/Caddyfile` and in
`/etc/vault/tailscale-cert.env` — and they must be identical. A mismatch writes a renewed
certificate somewhere Caddy is not looking, which reads as a renewal that worked right up until
the door stops serving TLS.

## Fresh-host path

Run these in order on a new host. The `--check` passes are assertions only; the other scripts do
not support that flag, so use the no-change mode they actually document where one exists.

1. **Accounts and directories**
   - Prerequisite: the SSH public key for the deployment account is available and quoted as one
     argument; otherwise `authorized_keys` gets a truncated line that sshd silently ignores.
   - Command: `sudo bash deploy/bootstrap-accounts.sh --dry-run --key 'ssh-ed25519 AAAA... comment'`,
     then `sudo bash deploy/bootstrap-accounts.sh --key 'ssh-ed25519 AAAA... comment'`.
   - Observable: `agnidata` and the `vaultsvc` nologin service account exist, with `/srv/vault`
     owned and created as the script reports.
2. **Migration chain**
   - Prerequisite: the `fedbench` database already exists; this script does not create it, so a
     missing database reads as a migration failure rather than an ordering problem.
   - Command: `bash deploy/apply-migrations.sh --db fedbench`.
   - Observable: the final `migrations.applied` report records the migration chain and the run says
     `schemas present: vault, connect`; an edited file is exposed instead of silently hidden.
3. **PostgREST, fed_storage, nginx, and SELinux**
   - Prerequisite: the bench self-host schema has supplied the `authenticator` and `bench_read`
     roles, and the staged units, nginx config, Python project, and PostgREST binary are at the
     paths checked by the script; migrations alone do not create those roles.
   - Command: `sudo bash deploy/root-install.sh --check`, then `sudo bash deploy/root-install.sh`.
   - Observable: the script reports `fed-postgrest`, `fed-storage`, and `nginx` active, and
     `connect.kinds` returns at least one seeded row through `127.0.0.1:8087`; an empty result
     would be an RLS or grant failure, not proof of an empty database.
4. **Tailnet door and certificate**
   - Prerequisite: HTTPS Certificates are **ENABLED for the tailnet in the Tailscale admin
     console**, before this command; otherwise `tailscale cert` names the DOMAIN and looks like a
     DNS problem.
   - Command: `sudo bash deploy/caddy-install.sh --check`, then `sudo bash deploy/caddy-install.sh`.
   - Observable: Caddy is active and `ss` shows 443 bound only to the Tailscale address(es), with
     the certificate and key issued; a 502 here means the nginx shim prerequisite was not met.
5. **Vault API endpoint**
   - Prerequisite: Node **22** is installed and selected, not RHEL 9's default `nodejs:16` stream;
     nodejs:16 fails with a syntax error pointing at valid code, which looks like corrupt source.
   - Command: `sudo dnf module switch-to -y nodejs:22`, then `sudo bash deploy/vault-api-install.sh --check`,
     then `sudo bash deploy/vault-api-install.sh`.
   - Observable: `vault-api` is active as `vaultsvc` on `127.0.0.1:8099` and the tailnet
     `/healthz` returns `{"ok":true,"checks":{"database":{"ok":true,"field_definitions":32}}}`;
     npm's `/home/vaultsvc/.npm/_logs` message means its required `HOME` and cache were not set.
6. **Nightly local dumps**
   - Prerequisite: the backup job runs as a user that can connect to `fedbench` and write its own
     `/srv/fedbench/backups` directory; this is local disk, not an off-host copy.
   - Command: `bash deploy/backup-fedbench.sh` (there is no `--check`; `--dry-run` only previews
     the output path and retention).
   - Observable: one dated `.dump` and one `.sql.gz` are published, both validated, and the summary
     reports their paths; this does not satisfy the cutover gate because the files share the database host.

## Vault data plane root install

`deploy/root-install.sh` stands up the vault data plane on `edaserver`. Run its assertion pass
first, every time:

```
sudo bash deploy/root-install.sh --check
```

`--check` runs assertions only and changes nothing. It catches missing migrations, roles, staged
files, dependencies and port collisions before an install can leave a service failing for a
different-looking reason. Only after it passes should the install be run:

```
sudo bash deploy/root-install.sh
```

This box is somebody's EDA machine first. The script changes only the vault data-plane locations:
`/usr/local/bin/postgrest`, `/srv/fedbench/objects`, `/srv/fedbench/venv`, the two systemd units
under `/etc/systemd/system`, the nginx shim under `/etc/nginx/conf.d`, and the existing
`/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env` (appending missing values,
never rewriting an existing JWT secret). It does not touch anything under `/home`,
`/storage/home` or `/home/shared`; the staging directory under `/home/agnidata/work/deploy` is
read as an input, not modified.

The unit files and nginx conf come from the staging directory `/home/agnidata/work/deploy`, or
from `$UNITSRC` when overridden. They do **not** come from the fedbackup checkout. That checkout
is what the nightly archive timers run out of, so moving its branch merely to pick up two unit
files would change the code a live backup job executes. The script leaves that checkout alone and
reports when an installed staged file differs from the corresponding repo copy instead of
tolerating the divergence silently. Files are copied rather than moved because a moved file keeps
its source SELinux context and systemd then refuses it, which reads as a bad unit rather than a
label problem.

The checkout is `/srv/fedbackup/ferrodiode-pcb-testbench`, and fedbackup's HOME is `/srv/fedbackup`.
SELinux therefore labels its files `user_home_dir_t` or `user_home_t`. systemd reads
`EnvironmentFile` from PID 1 (`init_t`), which cannot read `user_home_t`; the resulting
`Failed to load environment files: Permission denied` is not a mode or ownership problem, even
though root can read the file from a shell. The service also cannot execute a bench
`.venv/bin/python`: the symlink itself is denied and the symptom is `Failed to locate executable
...: Permission denied`, which reads as a missing file. PostgREST does not have this problem
because `/usr/local/bin/postgrest` is `bin_t`, allowing the exec and service transition.

The install consequently uses its own venv at `/srv/fedbench/venv`, built from `/usr/bin/python3`
(3.9.25), rather than the bench's uv-managed `.venv`. That environment has pip through
`ensurepip`; the bench venv deliberately has no pip, so `python -m pip` there says `No module
named pip`, and `uv sync` can prune the editable `keithley-control` install used by a running
campaign. Python 3.9 is sufficient for this service: it imports `psycopg`, `starlette`, and
`uvicorn` plus the standard library, uses postponed annotations, and all seven files parse under
the 3.9 grammar.

Three SELinux labels are applied for three different operations. `server/config` is `etc_t` so
systemd can read `secrets.env`; `/srv/fedbench/venv/bin` is `bin_t` so systemd can execute the
interpreter; and `server/src` is `usr_t` so the service can import its code. `semanage fcontext`
only records a rule; `restorecon -R` applies it. A rule without `restorecon` looks like a fix and
is not. The other persistent SELinux changes are `httpd_can_network_connect` for nginx's
loopback proxy and `8087` labelled `http_port_t`; without them the symptoms are a 502 or nginx
being unable to bind the port. When a unit fails, run `sudo ausearch -m avc -ts recent` and suspect
SELinux first.

The live object root is `/srv/fedbench/objects`, mode `0750`, owned by `fedbackup`, on the RAID1
root filesystem. It is deliberately not `/srv/nextcloud/fedbench/objects`, which is the nightly
cold archive on a single non-redundant 7.3T disk. Serving that archive live would make the backup
and primary the same directory, so a writer bug could damage the only copy.

The shared JWT secret is minted once during a greenfield install and lives only in
`/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env` (0600, `fedbackup`, `etc_t`);
it is not in a pg_dump and must never be regenerated. PostgREST and fed_storage verify the same
tokens. Regenerating it leaves metadata reads working while every object download returns 401,
which reads as a corrupt archive rather than a mismatched key.

The installed data-plane services are loopback-only: PostgREST 16.3 at `127.0.0.1:3000`,
fed_storage at `127.0.0.1:3001`, and the nginx shim at `127.0.0.1:8087`. All three are enabled and
active. Caddy, the Tailscale certificate, and the Cloudflare tunnel are not part of the root
install script. nginx strips `/rest/v1/` before proxying to
PostgREST, does not strip `/storage/v1/` for fed_storage, and returns 404 for everything else.
PostgREST uses `PGRST_DB_SCHEMAS=public,vault,connect` and `PGRST_DB_ANON_ROLE=bench_read`.
Unauthenticated requests return HTTP 401 with Postgres error 42501, never an empty array; an
empty array would read as missing data when it is actually an authorization failure. The seeded
`connect.kinds` endpoint returns seven rows through the full path. `connect.health` currently
reports all zeros because the schema migrations are applied but no vault data has been migrated
from hosted Supabase; that zero is correct. fed_storage health is
`{"ok":true,"root":"/srv/fedbench/objects","writable":true}`.

To undo the install, run the block printed at the end of the script: disable and stop
`fed-postgrest`, `fed-storage` and nginx, remove the installed units, nginx conf, PostgREST binary
and service venv, then daemon-reload. The SELinux changes are persistent (`-P` and the policy-store
port label), so they outlive everything else in that block and survive a reboot. Remove those
rules only after checking that no other service needs them; in particular,
`httpd_can_network_connect` is box-wide. The object root and `secrets.env` are deliberately left
in place because removing them loses data and the authenticator password, neither of which a
rerun recreates.

## Vault API install

`deploy/vault-api-install.sh` installs the application endpoint behind `/api` and `/healthz`.
Run its assertion pass first, because it changes nothing and catches missing staged files,
dependencies, the nginx shim, the service account, the shared JWT secret, and port collisions:

```
sudo bash deploy/vault-api-install.sh --check
```

Only after that passes should the install be run:

```
sudo bash deploy/vault-api-install.sh
```

Node 22 is required. RHEL 9 defaults to the `nodejs:16` module stream, which is too old for this
repository's ESM and can fail at parse time with a syntax error that looks like corrupt source.
Upgrade the stream before running the installer:

```
sudo dnf module switch-to -y nodejs:22
```

The application tree must be staged at `/srv/vault/app`; the installer recursively makes it owned
by `vaultsvc` before running `npm ci`. The service must update its own `node_modules`, so installing
dependencies as root leaves root-owned files the service cannot touch and the failure appears later
as a service import or update problem.

`vaultsvc` is deliberately a system account with no home directory. The installer therefore sets
`HOME=/srv/vault/app` and `npm_config_cache=/srv/vault/app/.npm` explicitly for npm. Without those
values npm tries to create `~/.npm` and reports a `LOGGING` error about being unable to write
`/home/vaultsvc/.npm/_logs`, which looks like a failed install even though the misleading message is
about log placement.

An existing `/etc/vault/vault-api.env` is never rewritten. It contains a minted service token and a
generated `VAULT_API_KEY` that a rerun cannot recreate; replacing either would look like a successful
install while revoking the credential in use. The one exception is a `VAULT_REST_URL` ending in
`/rest/v1` (with or without a trailing slash): the installer keeps a timestamped backup and corrects
that value in place. `supabase-js` receives this URL and appends `/rest/v1` itself, so the suffix
duplicates the path as `/rest/v1/rest/v1/<table>`. nginx strips one prefix and PostgREST returns
`PGRST125`, `Invalid path specified in request URL`, a symptom that names neither the bad variable
nor the duplicated path. `VAULT_STORAGE_URL` is different: `api/_lib/storage.js` consumes it
directly, so it must include `/storage/v1`. `tests/vaultUrlShape.test.ts` pins this asymmetry.

The service unit is installed from the staging directory, enabled, restarted, and checked locally.
Its process runs as the `vaultsvc` system account on `127.0.0.1:8099`; the loopback bind is asserted
against the kernel because the process holds a `vault_service` token with `BYPASSRLS` and write access
to every vault table. Exposing that listener would expose that credential, so it sits behind the two
proxies. The env file is `/etc/vault/vault-api.env`, mode `0640`, owned by `root:vaultsvc`.

The full stack is live on `edaserver` as of 2026-09-11. This was verified from a separate tailnet
device, not from the server itself. Caddy routes `/api/*` and `/healthz` to port 8099, and routes
`/rest/v1/*` and `/storage/v1/*` to the nginx shim on port 8087. Port 443 is bound only to the
tailnet addresses. `/api/*` returns 401 even for nonexistent routes because authentication runs
before routing; that deliberate behavior avoids leaking route existence, but means a 401 or 404
probe cannot establish whether an API route is deployed.

The external health probe is:

```
https://edaserver.tailcb2a72.ts.net/healthz -> 200
{"ok":true,"checks":{"database":{"ok":true,"field_definitions":32},"duration_ms":4}}
```

The `field_definitions: 32` value matters: `/healthz` reads a row it knows exists rather than
returning bare `{"ok":true}`. Every vault table has RLS enabled with no policies, so a role without
`BYPASSRLS` gets empty results while status codes remain 200. An empty database and an unauthorised
role are therefore indistinguishable from outside; a zero `field_definitions` count is the positive
failure signal.

`connect.health` still returns all zeros. The schema is built, but no vault data has been migrated
from hosted Supabase, so that result is expected rather than a failed deployment. Use seeded
`connect.kinds` (7 rows) as the liveness probe. The Cloudflare tunnel and Access public door are
deliberately not built; access remains tailnet-only. Backups are local only: `deploy/backup-fedbench.sh`
says on every run that a dump on the database's own host is not a second physical copy and does not
clear the cutover gate.

To undo the Vault API install, run the block printed by the script:

```
systemctl disable --now vault-api
rm -f /etc/systemd/system/vault-api.service
systemctl daemon-reload
```

The script deliberately leaves `/etc/vault/vault-api.env` and `/srv/vault/app` in place. The env
file holds the minted service token and generated `VAULT_API_KEY`, neither of which a rerun recreates;
the application tree is likewise not removed by the undo block.

## The tailnet certificate renews on a timer

`tailscale cert` issues a real Let's Encrypt certificate over DNS-01, valid **~90 days**. Nothing
renews it on its own, and `deploy/Caddyfile` pins the files with an explicit `tls <cert> <key>` —
which Caddy reads at config load and **does not watch**. So the renewal and the reload are both
required, and either one missing produces the same outage three months after go-live, far enough
from any deploy that nobody connects it to its cause.

```
# /etc/vault/tailscale-cert.env — root:root, mode 0640
TAILSCALE_CERT_DOMAIN=edaserver.<tailnet>.ts.net
TAILSCALE_CERT_PATH=/etc/caddy/certs/edaserver.crt
TAILSCALE_KEY_PATH=/etc/caddy/certs/edaserver.key
```

```
sudo semanage fcontext -a -t etc_t '/etc/caddy/certs(/.*)?'
sudo restorecon -Rv /etc/caddy/certs
sudo cp deploy/tailscale-cert.service deploy/tailscale-cert.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start tailscale-cert.service     # prove it works BEFORE trusting the timer
sudo systemctl enable --now tailscale-cert.timer
```

Enable the **timer**, not the service. Run the service once by hand first: a timer whose unit has
never succeeded is a renewal you have assumed rather than observed.

The script reloads Caddy **only when the certificate bytes change**, because `tailscale cert` is
idempotent and returns the existing certificate until it is near expiry — an unconditional reload
would drop Caddy's config daily to install a file identical to the one already loaded.

Set `OnFailure=` in `tailscale-cert.service` to something that reaches a human. A failed renewal
is silent for weeks and then total: the bench watcher reads a TLS error as unreachable and backs
off quietly, so the first symptom is sync lag nobody is watching.

**The short name `https://edaserver` can never have a valid certificate.** MagicDNS resolves the
name; nothing issues a certificate for it. Use the full `.ts.net` name everywhere. Those names are
also publicly resolvable and appear in Certificate Transparency logs — not routable from outside
the tailnet, but the hostname is public knowledge, which is why every path behind the door
authenticates rather than relying on the name being unguessable.

## Contract v2.4 Env Vars

- `VAULT_REST_URL`: server base URL, e.g. `http://127.0.0.1:8087`; do not add `/rest/v1`, because
  `supabase-js` appends that prefix.
- `VAULT_STORAGE_URL`: server URL including `/storage/v1`, e.g.
  `http://127.0.0.1:8087/storage/v1`; `storage.js` appends object paths directly.
- `VAULT_SERVICE_JWT`: server, HS256, `role: vault_service`, minted by `tools/mint_service_jwt.py --role`.
- `VAULT_API_KEY`: server, unchanged from v1.
- `VAULT_ACCESS_TEAM_URL`: server, `https://<team>.cloudflareaccess.com`.
- `VAULT_ACCESS_AUD`: server, the Access application's audience tag.
- `VAULT_EMAIL_DOMAIN`: server, checked against the `hd` claim rather than the email suffix.
- `VAULT_CORS_ORIGIN`: server, allowed browser origin. Same-origin through Cloudflare makes it
  moot in production; it is what keeps local development working.
- `VAULT_READONLY`: server, when `1`, rejects POST/PATCH/DELETE during phase-2 shakedown deploy.
- `VITE_API_BASE_URL`: client, not secret; the API origin. This is the only permitted `VITE_` var.

## RHEL 9 SELinux

These steps are not optional. Their failure modes look like unrelated bugs.

- `setsebool -P httpd_can_network_connect 1`: without it, nginx proxying to loopback ports is denied and you see a 502.
- `semanage port -a -t http_port_t -p tcp 8087`: without it, nginx cannot bind that port.
- Set an fcontext for `/srv/vault/www` with type `httpd_sys_content_t`, then run `restorecon -Rv /srv/vault/www`.
- Install units with `cp`, never `mv`: a moved file keeps its source context and systemd refuses to load it.
- Debug ritual: `sudo ausearch -m avc -ts recent`. Suspect SELinux first.
