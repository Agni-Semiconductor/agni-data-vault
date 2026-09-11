#!/bin/sh
# Renew the tailnet door's TLS certificate, and make Caddy actually pick it up.
#
# `tailscale cert` obtains a real Let's Encrypt certificate for
# edaserver.<tailnet>.ts.net over DNS-01. Those are ~90-day certificates. Without this running
# on a timer the tailnet door stops serving TLS about three months after it goes up -- and the
# failure is delayed far enough from any deploy that nobody connects it to its cause.
#
# THE RELOAD IS THE HALF THAT IS EASY TO MISS. `deploy/Caddyfile` names the certificate with an
# explicit `tls <cert> <key>`, and Caddy loads those files when the config loads -- it does NOT
# watch them. A renewal that Caddy never re-reads is exactly as much of an outage as no renewal
# at all, and it looks worse, because the files on disk are valid and everything about the box
# says the renewal succeeded.
#
# It reloads ONLY when the bytes changed. `tailscale cert` is idempotent and returns the
# existing certificate when it is not yet near expiry, so an unconditional reload would drop
# Caddy's config every single day to install a file identical to the one already loaded.
#
# WHO IT RUNS AS. `tailscale cert` needs the tailscaled socket, so this runs as root. The files
# it writes have to be readable by Caddy; on RHEL 9 that means both the mode and the SELinux
# context, and a cert Caddy cannot read fails exactly like a cert that does not exist. After
# changing the destination directory:
#
#   semanage fcontext -a -t etc_t '/etc/caddy/certs(/.*)?'
#   restorecon -Rv /etc/caddy/certs
#
# FAILURE MUST BE LOUD. A failed renewal is silent for weeks and then total: the bench watcher
# treats a TLS error as unreachable and backs off, so the first symptom is sync lag nobody is
# looking at. `OnFailure=` in the unit is what turns that into a signal.
set -eu

DOMAIN="${TAILSCALE_CERT_DOMAIN:?set TAILSCALE_CERT_DOMAIN, e.g. edaserver.<tailnet>.ts.net}"
CERT="${TAILSCALE_CERT_PATH:?set TAILSCALE_CERT_PATH -- must match deploy/Caddyfile}"
KEY="${TAILSCALE_KEY_PATH:?set TAILSCALE_KEY_PATH -- must match deploy/Caddyfile}"
RELOAD_UNIT="${CADDY_UNIT:-caddy.service}"

digest() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || echo absent; }

before="$(digest "$CERT")"

# --cert-file / --key-file write atomically. Writing to the live paths directly is safe and is
# what keeps the Caddyfile's paths stable; a symlink dance would add a second thing to get wrong.
tailscale cert --cert-file "$CERT" --key-file "$KEY" "$DOMAIN"

after="$(digest "$CERT")"

if [ "$before" = "$after" ]; then
  echo "tailscale-cert: $DOMAIN unchanged ($after), not reloading $RELOAD_UNIT"
  exit 0
fi

echo "tailscale-cert: $DOMAIN renewed ($before -> $after), reloading $RELOAD_UNIT"
# Reload, not restart: a restart drops in-flight requests, and the bench watcher's uploads are
# the things most likely to be in flight.
systemctl reload "$RELOAD_UNIT"
