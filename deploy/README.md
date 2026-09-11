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
