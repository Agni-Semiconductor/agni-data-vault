# Endpoint Runbook: Day-2 Operations

## What Is Running And Where

The live vault data plane on `edaserver` is entirely loopback-bound:

| Component | Version | Listener | Purpose |
|---|---:|---|---|
| Postgres | 17.10 | `127.0.0.1:5432` | Database for the data plane |
| PostgREST | 16.3 | `127.0.0.1:3000` | REST interface to Postgres |
| `fed_storage` | | `127.0.0.1:3001` | Object storage service |
| nginx shim | | `127.0.0.1:8087` | Routes `/rest/v1/` to PostgREST and `/storage/v1/` to `fed_storage` |

All four listeners are on loopback. Caddy, the Tailscale certificate, and the Cloudflare tunnel are not installed, so nothing is reachable off the box. Do not diagnose this as a network outage or open a port to compensate: there is no tailnet or public door yet.

## Is It Working?

Run:

```bash
sudo bash deploy/verify-endpoint.sh
```

It changes nothing. The script mints a short-lived read token, checks nginx to PostgREST to Postgres through a seeded relation, verifies unauthenticated requests fail closed, and checks `fed_storage` directly. It does not restart services, write database rows, or change configuration; its temporary token file is removed before exit.

The seeded read matters because a bare HTTP 200 can be green while a service role has lost `BYPASSRLS` and receives no rows. In that failure, the database looks empty rather than unauthorised.

## Restart Order

Restart in dependency order:

```bash
sudo systemctl restart postgresql-17
sudo systemctl restart fed-postgrest fed-storage
```

PostgREST and `fed_storage` both depend on Postgres, so starting either before Postgres is ready leaves an upstream unable to serve its data. nginx depends on neither; while an upstream is down it serves 502, which reads as an nginx fault even when nginx is working correctly.

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

## After A Reboot

Confirm all three data-plane units came back:

```bash
sudo systemctl is-active fed-postgrest fed-storage nginx
sudo bash deploy/verify-endpoint.sh
```

A reboot that returns with nothing running is the same outage as a crash. `enabled` is not evidence that the units actually started, and an active nginx alone can still return 502 for both upstreams.

## The Shared JWT Secret

The shared JWT secret was minted once and lives only in `secrets.env` on the box. It is in no `pg_dump` and must never be regenerated.

Regenerating it invalidates tokens already issued to callers. If PostgREST and `fed_storage` no longer use the same value, metadata reads can still work while every object download returns 401. That reads as a corrupt archive rather than a mismatched key. Losing the secret bricks the data plane; regenerating it is not recovery.

## Not Covered Yet

Do not improvise these operations:

- Backups of the new database.
- The tailnet door.
- The public door.

They are not part of the current live endpoint. Ad hoc changes to any of them can expose loopback-only data-plane paths or create an unproven recovery process.

Changed only `docs/ENDPOINT_RUNBOOK.md` to add this day-2 operations runbook. Deliberately did not modify deployment scripts, service configuration, endpoint code, or any other documentation because this task adds operating guidance and the existing deployment contracts remain the source of installation behavior.
