# Endpoint Runbook: Day-2 Operations

## What Is Running And Where

The vault data plane on `edaserver` is loopback-bound behind a tailnet-only door. The door went live on 2026-09-11 and was verified from a separate device on the tailnet, not from `edaserver` itself.

| Component | Version | Listener | Purpose |
|---|---:|---|---|
| Postgres | 17.10 | `127.0.0.1:5432` | Database for the data plane |
| PostgREST | 16.3 | `127.0.0.1:3000` | REST interface to Postgres |
| `fed_storage` | | `127.0.0.1:3001` | Object storage service |
| nginx shim | | `127.0.0.1:8087` | Routes `/rest/v1/` to PostgREST and `/storage/v1/` to `fed_storage` |
| `vault-api` | Node 22 | `127.0.0.1:8099` | API service running as `vaultsvc`; it uses a `vault_service` token with `BYPASSRLS` and is loopback-bound because it can write every table in the `vault` schema |
| Caddy | 2.11.4 | `100.87.250.124:443`, `[fd7a:115c:a1e0::2032:fa7d]:443` | Terminates tailnet TLS and proxies `/api/*` and `/healthz` to `vault-api` on `127.0.0.1:8099`, and `/rest/v1/*` and `/storage/v1/*` to nginx on `127.0.0.1:8087` |

The five data-plane listeners remain on loopback. `vault-api` reads `/etc/vault/vault-api.env`, which is `0640 root:vaultsvc`; a broader file mode would expose credentials to accounts that do not need them. Caddy binds only the two tailnet addresses above, and its start check asserts that against the kernel listening sockets; configuration alone is not enough, because an omitted bind directive makes Caddy listen on `0.0.0.0:443` and publishes the data plane on `192.168.51.1`, `10.10.10.2`, and `10.177.7.111` as well.

Use `https://edaserver.tailcb2a72.ts.net`. Caddy uses a real Let's Encrypt certificate issued through `tailscale cert` with DNS-01; its CN is `edaserver.tailcb2a72.ts.net`, it expires on 2026-12-10, and `tailscale-cert.timer` renews it daily at 04:40. The expiry is the scheduled failure with no warning, so confirm the timer is active after a reboot. `https://edaserver` cannot have a valid certificate: MagicDNS resolves the short name but does not make it a name a CA will sign.

Caddy does not bind `:80` because global `auto_https disable_redirects` is set; nothing behind this door is acceptable over plain HTTP. nginx's stock default server does hold `0.0.0.0:80`, but that is unrelated to the vault, whose nginx configuration is loopback-only on `8087`.

`/healthz` and `/api/*` proxy to `127.0.0.1:8099` for `vault-api`. `/healthz` returns 200 only after reading the seeded `field_definitions` relation; its expected count is 32, because a role without `BYPASSRLS` receives an empty result from every RLS-protected vault table without an error. `/api/*` returns 401 even for routes that do not exist because authentication runs before routing; a 404/401 probe therefore cannot show whether a route is deployed and does not leak which routes exist. Any path other than `/rest/v1/*`, `/storage/v1/*`, `/healthz`, and `/api/*` returns 404. The public Cloudflare tunnel and Access door are deliberately not built; the service is tailnet-only by decision on 2026-09-11. Tailnet membership is an outer factor, not the gate: every path validates the HS256 service JWT, so membership alone grants nothing.

## Is It Working?

Run:

```bash
sudo bash deploy/verify-endpoint.sh
```

It changes nothing. The script mints a short-lived read token, checks nginx to PostgREST to Postgres through a seeded relation, verifies unauthenticated requests fail closed, and checks `fed_storage` directly. It does not restart services, write database rows, or change configuration; its temporary token file is removed before exit.

The seeded read matters because a bare HTTP 200 can be green while a service role has lost `BYPASSRLS` and receives no rows. In that failure, the database looks empty rather than unauthorised.

When testing the tailnet URL directly, include the profile header:

```bash
curl https://edaserver.tailcb2a72.ts.net/rest/v1/kinds -H 'Accept-Profile: connect'
```

Without `Accept-Profile: connect`, the request uses the default `public` profile, where `kinds` does not exist, and correctly returns 404 with `error=PGRST205` (`not found in the schema cache`). That is not a missing view or a broken endpoint. With the header but no token, the request correctly reaches `connect` and returns 401 with `error=42501`; with a valid `connect_read` token and the header, `connect.kinds` returns seven rows.

## Restart Order

Restart in dependency order:

```bash
sudo systemctl restart postgresql-17
sudo systemctl restart fed-postgrest fed-storage
sudo systemctl restart nginx
sudo systemctl restart vault-api
```

PostgREST and `fed_storage` both depend on Postgres, so starting either before Postgres is ready leaves an upstream unable to serve its data. nginx depends on neither; while an upstream is down it serves 502, which reads as an nginx fault even when nginx is working correctly. `vault-api` depends on the nginx shim being up because it reaches PostgREST through `127.0.0.1:8087`, not directly; starting it first makes its database path fail even though PostgREST itself is healthy.

nginx normally needs no action after restarting either upstream. Reloading nginx does not restart PostgREST or `fed_storage`, and restarting those upstreams does not require an nginx reload. Reload nginx only after changing nginx configuration:

```bash
sudo systemctl reload nginx
```

## Symptoms

| What you see | What it usually means | What to check |
|---|---|---|
| 502 from the nginx shim | An upstream is down, or SELinux is blocking nginx from connecting to loopback because `httpd_can_network_connect` is off. The denial reads as a dead upstream. | Check `sudo systemctl status fed-postgrest fed-storage nginx`, then `sudo getsebool httpd_can_network_connect`. If a unit will not start, run `sudo ausearch -m avc -ts recent` first, not last. |
| `Failed to load environment files: Permission denied` | `secrets.env` is labelled `user_home_t` and PID 1 (`init_t`) may not read it. This is not a mode or owner problem, even when root can read the file in a shell. | Run `sudo ausearch -m avc -ts recent` first. Check the file context with `ls -Z /srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env`; the config directory must be labelled `etc_t`. |
| `Failed to locate executable ...: Permission denied` | The interpreter is labelled `user_home_t`, so systemd cannot execute it. The message reads as a missing file. | Run `sudo ausearch -m avc -ts recent` first. Check the interpreter context with `ls -Z /srv/fedbench/venv/bin/python`; the service interpreter must be labelled `bin_t`. |
| Empty arrays with HTTP 200 | A service role lost `BYPASSRLS`. With RLS enabled and no policies, PostgREST returns no rows without an error, so the database looks empty rather than unauthorised. This is the loudest silent failure on the box. | Run `sudo bash deploy/verify-endpoint.sh`. Check `rolbypassrls` for the service roles with `/usr/pgsql-17/bin/psql -d fedbench -c "select rolname, rolbypassrls from pg_roles where rolname ~ '^(vault|bench|connect)'"`. |
| Object downloads return 401 while metadata reads still work | The JWT secret differs between PostgREST and `fed_storage`. The database path still works, so this reads as a corrupt archive rather than a mismatched key. | Do not regenerate the secret. Check that `PGRST_JWT_SECRET` and `FED_PGRST_JWT_SECRET` in the box's `secrets.env` are the same value and that their base64 setting, if used, agrees. |
| 404 with `error=PGRST205` on a path known to exist | The `Accept-Profile` header is missing, so PostgREST used the default `public` profile rather than `connect`. This reads as a missing view even though the request reached the wrong schema. | Retry with `-H 'Accept-Profile: connect'`. A request without a token should then return 401 with `error=42501`, not 404. |
| `/healthz` returns 503 with `Invalid path specified in request URL` | `VAULT_REST_URL` incorrectly carries a `/rest/v1` suffix. `supabase-js` appends that path itself, producing `/rest/v1/rest/v1/<table>`; nginx removes only one prefix and PostgREST returns PGRST125, which does not identify the variable or duplicated path. | Set `VAULT_REST_URL=http://127.0.0.1:8087`. Do not mirror `VAULT_STORAGE_URL`: storage consumes its URL directly and correctly requires `http://127.0.0.1:8087/storage/v1`. |
| `/healthz` returns 200 but `field_definitions` is 0 | A vault role lost `BYPASSRLS`. Every vault table has RLS enabled with no policies, so reads return empty arrays and no error; the database looks empty rather than unauthorised. The seeded `field_definitions` count exists to make this silent failure visible. | Check `rolbypassrls` for the vault role with `/usr/pgsql-17/bin/psql -d fedbench -c "select rolname, rolbypassrls from pg_roles where rolname ~ '^vault'"`. |
| `vault-api` is active but every request returns 500 about the environment | This shape should no longer occur: missing credentials now make `vault-api` exit 1 before listening. If it reappears, startup validation has regressed or the running process did not come from the expected unit. | Check `sudo systemctl status vault-api`, its journal, and `/etc/vault/vault-api.env`; the file must remain `0640 root:vaultsvc`. |
| `npm ci` fails with `Log files were not written ... /home/vaultsvc/.npm/_logs` | `vaultsvc` is a system account with no home directory by design. npm tries to use that missing home for its cache and log path, which reads as an npm installation failure rather than an account environment problem. | Set both `HOME` and `npm_config_cache` before running `npm ci`. |
| TLS failure on `https://edaserver` | MagicDNS resolves the short name, but no CA will sign a certificate for it. This reads as a broken tailnet door when the wrong hostname was used. | Use `https://edaserver.tailcb2a72.ts.net`. |
| Caddy will not start and reports `bind: address already in use` for `:80` | Caddy binds `:80` for HTTP-to-HTTPS redirects unless `auto_https disable_redirects` is set. This is not a conflict on `:443`; nginx's stock default server holds `0.0.0.0:80`. | Check that global `auto_https disable_redirects` remains set. Do not change the vault's loopback-only nginx listener on `8087`. |

## After A Reboot

Confirm all four data-plane units, Caddy, and the certificate renewal timer came back:

```bash
sudo systemctl is-active fed-postgrest fed-storage nginx vault-api caddy tailscale-cert.timer
sudo bash deploy/verify-endpoint.sh
```

A reboot that returns with nothing running is the same outage as a crash. `enabled` is not evidence that the units actually started, and an active nginx alone can still return 502 for both upstreams. An inactive `vault-api` removes `/api/*` and `/healthz`, while an inactive Caddy removes the tailnet door; an inactive `tailscale-cert.timer` leaves the 2026-12-10 certificate expiry to arrive without warning.

## The Shared JWT Secret

The shared JWT secret was minted once and lives only in `secrets.env` on the box. It is in no `pg_dump` and must never be regenerated.

Regenerating it invalidates tokens already issued to callers. If PostgREST and `fed_storage` no longer use the same value, metadata reads can still work while every object download returns 401. That reads as a corrupt archive rather than a mismatched key. Losing the secret bricks the data plane; regenerating it is not recovery.

## Backups And Restore

`fedbench-backup.timer` starts `fedbench-backup.service` nightly at 02:20, with up to a 15-minute randomized delay. `Persistent=true` causes a missed run to be started after the next boot. The service is a `Type=oneshot` job; enable the timer, not the service, because enabling the service would run a completed backup at every boot. It runs `/usr/local/bin/backup-fedbench.sh` as the OS and PostgreSQL role `postgres`.

The script uses `/usr/pgsql-17/bin/pg_dump` and `/usr/pgsql-17/bin/pg_restore`; do not use bare `psql` or `pg_dump` on `edaserver`, because bare `psql` resolves to Siemens Calibre's client. It writes temporary files, validates both results, then publishes this pair under `/srv/fedbench/backups`:

```text
fedbench-YYYY-MM-DD.dump       custom-format archive
fedbench-YYYY-MM-DD.sql.gz     gzip-compressed plain SQL twin
```

The backup directory is `postgres:postgres` mode `0700`. Its shared parent, `/srv/fedbench`, is `root:root` mode `0755`; `postgres` must be able to traverse the parent even though `fedbackup` owns the other service directories. The script keeps 14 daily pairs by default and does not prune retention when the current pair fails.

It runs as `postgres`, not `fedbackup`, for two database reasons. `fedbackup` has no privileges inside the database at all: no memberships, no table `SELECT`, and no `BYPASSRLS`, so its dump fails with `permission denied for schema vault`. Also, every `vault` table has RLS enabled with no policies, and `pg_dump` runs with `row_security=off`; the dump must therefore be made by a role that bypasses RLS. `postgres` is a superuser over peer authentication and bypasses RLS. Giving `fedbackup` those database privileges would widen the privilege of the account that owns the service data and is not the selected design.

Both formats are deliberately kept. A `-Fc` archive is efficient and is the format to inspect or restore with `pg_restore`, but it needs a matching-or-newer `pg_restore` forever. The `.sql.gz` twin is readable with `zgrep`, readable by a human, and loadable by any future PostgreSQL, so losing an old restore binary does not turn an otherwise present archive into an unreadable recovery point.

These are local dumps on the database's own host. They are not an off-host copy, not a second physical copy, and they do not clear the cutover gate. The hosted Supabase projects are the only off-host copy until cutover; after cutover they are not an off-host copy either. This remains the open risk: the backup failed three nights running before anyone noticed, and nothing currently alerts on it.

### Check A Run

Use the timer and service state, then inspect the journal and the dated pair. A successful run must publish both files, not merely start the service:

```bash
sudo systemctl list-timers --all fedbench-backup.timer
sudo systemctl status fedbench-backup.timer fedbench-backup.service --no-pager
sudo journalctl -u fedbench-backup.service -n 80 --no-pager
sudo ls -l /srv/fedbench/backups
sudo /usr/pgsql-17/bin/pg_restore --list /srv/fedbench/backups/fedbench-YYYY-MM-DD.dump
sudo gzip -t /srv/fedbench/backups/fedbench-YYYY-MM-DD.sql.gz
```

The journal summary must say that both verified files were published. The `pg_restore --list` and `gzip -t` checks test that the files are readable, not just that they exist. A fixed unit does not clear a previous failed state: the next successful run clears it, or use `sudo systemctl reset-failed fedbench-backup.service` after investigating the failure.

### Restore

Restore only into the intended `fedbench` database after deciding whether the operation should replace existing objects. The custom archive requires a matching-or-newer PostgreSQL `pg_restore`; the SQL twin uses the explicit PostgreSQL 17 client:

```bash
# Custom archive: inspect first, then restore according to the recovery plan.
sudo -u postgres /usr/pgsql-17/bin/pg_restore --list /srv/fedbench/backups/fedbench-YYYY-MM-DD.dump
sudo -u postgres /usr/pgsql-17/bin/pg_restore -d fedbench /srv/fedbench/backups/fedbench-YYYY-MM-DD.dump

# Plain SQL twin: stream the readable form into PostgreSQL.
sudo -u postgres bash -o pipefail -c 'gzip -dc /srv/fedbench/backups/fedbench-YYYY-MM-DD.sql.gz | /usr/pgsql-17/bin/psql -d fedbench'
```

Do not run both restore commands for one recovery attempt: they are two representations of the same dump. Confirm the restored schema and seeded counts with the health check and the explicit PostgreSQL client; a successful client exit alone does not prove that the data-plane role can read RLS-protected tables.

### Backup Symptoms

| What you see | What it means | Fastest check |
|---|---|---|
| `status=203/EXEC` | systemd could not `EXEC` the script; the script did not run and did not error. The unit pointed into a service account's home, labelled `user_home_t`, which cannot be executed. | Check `ExecStart` with `sudo systemctl cat fedbench-backup.service`; it must point to `/usr/local/bin/backup-fedbench.sh`, then check recent AVCs with `sudo ausearch -m avc -ts recent`. |
| Service exits `1` in about 5 ms with no output | The service user could not traverse the parent of the backup directory. The failure occurs before the dump and can look like a database failure because `mktemp` names a path inside the unreachable directory. | Run `namei -l /srv/fedbench/backups`; it shows every path component's modes and is the fastest diagnosis. |
| `permission denied for schema vault` | The dump is being made by a role with no database privileges. An existing OS account is not evidence that its PostgreSQL role can dump. | Run the probe as the configured service user: `sudo -u postgres /usr/pgsql-17/bin/psql -d fedbench -c 'set row_security = off; select count(*) from vault.field_definitions;'`; verify the unit says `User=postgres`. |

## Not Covered Yet

Do not improvise the public door. It is not part of the current live endpoint. Ad hoc changes can expose the tailnet-only data plane.

Changed only `docs/ENDPOINT_RUNBOOK.md` to add the live backup schedule, execution identity, local-dump limits, format rationale, checks, restore paths, open alerting risk, and the three observed backup failure shapes. Deliberately did not change deployment scripts, service configuration, endpoint code, or other documentation because this task is limited to this runbook and the deployment sources already contain the intended configuration.
