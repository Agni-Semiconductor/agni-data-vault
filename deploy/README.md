# Deploy Operator Notes

## Placeholders

- `<tailnet>` in `deploy/Caddyfile`: the tailnet DNS name segment for `edaserver.<tailnet>.ts.net`.
- `<tailscale_cert_path>` in `deploy/Caddyfile`: absolute path to the certificate from `tailscale cert edaserver.<tailnet>.ts.net`.
- `<tailscale_key_path>` in `deploy/Caddyfile`: absolute path to the key from `tailscale cert edaserver.<tailnet>.ts.net`.
- `<cloudflare_tunnel_id>` in `deploy/cloudflared-config.yml`: named tunnel UUID or name.
- `<cloudflared_credentials_file>` in `deploy/cloudflared-config.yml`: absolute path to the named tunnel credentials JSON.

## Contract v2.4 Env Vars

- `VAULT_REST_URL`: server, e.g. `http://127.0.0.1:8087`.
- `VAULT_STORAGE_URL`: server, same origin as above.
- `VAULT_SERVICE_JWT`: server, HS256, `role: vault_service`, minted by `tools/mint_service_jwt.py --role`.
- `VAULT_API_KEY`: server, unchanged from v1.
- `VAULT_IDENTITY_*`: server, Access team domain and application `aud` for JWT verification.
- `VAULT_ADMIN_BOOTSTRAP`: server, seeds the first `admin` row in `people`.
- `VAULT_READONLY`: server, when `1`, rejects POST/PATCH/DELETE during phase-2 shakedown deploy.
- `VITE_API_BASE_URL`: client, not secret; the API origin. This is the only permitted `VITE_` var.

## RHEL 9 SELinux

These steps are not optional. Their failure modes look like unrelated bugs.

- `setsebool -P httpd_can_network_connect 1`: without it, nginx proxying to loopback ports is denied and you see a 502.
- `semanage port -a -t http_port_t -p tcp 8087`: without it, nginx cannot bind that port.
- Set an fcontext for `/srv/vault/www` with type `httpd_sys_content_t`, then run `restorecon -Rv /srv/vault/www`.
- Install units with `cp`, never `mv`: a moved file keeps its source context and systemd refuses to load it.
- Debug ritual: `sudo ausearch -m avc -ts recent`. Suspect SELinux first.
