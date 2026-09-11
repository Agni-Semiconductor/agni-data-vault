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

The installed services are currently loopback-only: PostgREST 16.3 at `127.0.0.1:3000`,
fed_storage at `127.0.0.1:3001`, and the nginx shim at `127.0.0.1:8087`. All three are enabled and
active; nothing is published on the tailnet yet, and Caddy, the Tailscale certificate, and the
Cloudflare tunnel are not part of this script. nginx strips `/rest/v1/` before proxying to
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

- `VAULT_REST_URL`: server, e.g. `http://127.0.0.1:8087`.
- `VAULT_STORAGE_URL`: server, same origin as above.
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
