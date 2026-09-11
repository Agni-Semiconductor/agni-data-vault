#!/usr/bin/env bash
# The tailnet door: Caddy on :443 with a Tailscale-issued certificate, in front of the nginx shim.
#
#   sudo bash caddy-install.sh --check     # assertions only. Changes NOTHING. Run this first.
#   sudo bash caddy-install.sh
#
# ─── WHAT THIS OPENS, AND WHAT IT DOES NOT ─────────────────────────────────────────────────
# After this, https://<this host>.<tailnet>.ts.net/rest/v1/... and /storage/v1/... are reachable
# from any device on the tailnet. NOTHING is reachable from the internet: Caddy binds the tailnet
# address, and no inbound port is opened at the edge.
#
# THE TAILNET IS NOT THE GATE. Every path behind this door independently validates a credential --
# /rest/v1 and /storage/v1 against the HS256 service JWT that PostgREST and fed_storage share.
# Tailnet membership grants nothing on its own, which matters because a tailnet has other people's
# devices on it. Treat "they can reach port 443" and "they can read data" as unrelated facts.
#
# ─── THE CERTIFICATE ───────────────────────────────────────────────────────────────────────
# `tailscale cert` gets a real Let's Encrypt certificate over DNS-01 for the MagicDNS name. Two
# consequences worth knowing before you go looking for them:
#   * the SHORT name (https://edaserver) can never have a valid certificate. MagicDNS resolves the
#     name; it does not make it a name any CA will sign. Use the full .ts.net name.
#   * .ts.net names are publicly resolvable and appear in Certificate Transparency logs. Not
#     routable, but the hostname is public knowledge. That is fine; it is not a secret, and nothing
#     here depends on it being one.
# It needs HTTPS Certificates enabled for the tailnet in the admin console. Without that the
# failure names the DOMAIN, not the disabled feature, so it reads as a DNS problem.
#
# ─── WHAT IT TOUCHES ───────────────────────────────────────────────────────────────────────
#   /etc/caddy/Caddyfile                      (placeholders substituted with real values)
#   /etc/caddy/certs/                         (the cert and key, root:caddy 0750)
#   /var/log/caddy/                           (access log)
#   /etc/vault/tailscale-cert.env             (the renewal's three parameters)
#   /usr/local/bin/tailscale-cert-renew.sh    (NOT /srv/vault/app -- see step 3)
#   /etc/systemd/system/tailscale-cert.{service,timer}
#   SELinux: one fcontext rule on /etc/caddy/certs
#
# It does not touch /home, /storage/home or /home/shared, and it does not modify the fedbackup
# checkout. This box is somebody's EDA machine first.
set -uo pipefail

UNITSRC=${UNITSRC:-/home/agnidata/work/deploy}
CERTDIR=/etc/caddy/certs
CERT=$CERTDIR/tailnet.crt
KEY=$CERTDIR/tailnet.key
ENVFILE=/etc/vault/tailscale-cert.env
RENEW=/usr/local/bin/tailscale-cert-renew.sh
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "0. Assertions"
# ══════════════════════════════════════════════════════════════════════════════════════════
command -v caddy >/dev/null && ok "caddy present ($(caddy version 2>/dev/null | head -1))" \
  || bad "caddy is not installed -- dnf copr enable @caddy/caddy && dnf install caddy"

command -v tailscale >/dev/null && ok "tailscale present" || bad "tailscale is not installed"

# The full MagicDNS name, read from the daemon rather than typed. A typo here produces a
# certificate for a name nothing resolves to, and the symptom is a TLS handshake failure that
# reads as a broken certificate rather than a wrong name.
DOMAIN=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')
if [ -n "$DOMAIN" ]; then
  ok "tailnet name: $DOMAIN"
else
  bad "could not read this node's MagicDNS name from tailscale status"
fi

# The shim must already be serving. Caddy in front of a dead upstream gives a 502 that reads as a
# Caddy problem, and the next hour goes on the Caddyfile.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8087/rest/v1/ 2>/dev/null)
[ "$code" = 200 ] && ok "nginx shim answering on 127.0.0.1:8087 (HTTP $code)" \
  || bad "nginx shim returned '${code:-nothing}' -- run root-install.sh first"

# 443, and WHO holds it. "In use" and "in use by the thing this script manages" are different
# facts, and conflating them makes a re-run fail on its own success.
owner=$(ss -lntpH 2>/dev/null | awk '{n=split($4,a,":"); if (a[n]=="443") print}' | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1)
case "${owner:-}" in
  "")      ok "port 443 free" ;;
  caddy)   ok "port 443 held by caddy -- this script manages it" ;;
  *)       bad "port 443 is held by '$owner', which this script does not manage" ;;
esac

for f in Caddyfile tailscale-cert.service tailscale-cert.timer tailscale-cert-renew.sh; do
  [ -r "$UNITSRC/$f" ] && ok "staged $f" || bad "missing $UNITSRC/$f -- stage it there first"
done

# THE RENEWAL SCRIPT'S INSTALLED HOME, asserted rather than assumed. The unit as committed points
# at /srv/vault/app/deploy/, which does not exist on this box -- and putting an executable under a
# service account's home is what made fed-storage fail with "Failed to locate executable:
# Permission denied", because systemd may not exec a user_home_t binary. /usr/local/bin is already
# bin_t, so exec is permitted and no relabelling is needed.
if [ -r "$UNITSRC/tailscale-cert.service" ]; then
  exe=$(grep -vE '^[[:space:]]*(#|;|$)' "$UNITSRC/tailscale-cert.service" | grep -m1 '^ExecStart=' | cut -d= -f2- | awk '{print $1}')
  case "$exe" in
    /usr/local/bin/*|/usr/bin/*|/bin/*) ok "cert unit execs $exe (a bin_t path)" ;;
    *) warn "cert unit execs $exe -- will be rewritten to $RENEW (see step 3)" ;;
  esac
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31m%d assertion(s) failed. Nothing was changed.\033[0m\n' "$fail"
  exit 1
fi
[ "$CHECK_ONLY" = 1 ] && { printf '\n\033[32mAll assertions pass. Re-run without --check to install.\033[0m\n'; exit 0; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "1. Directories"
# ══════════════════════════════════════════════════════════════════════════════════════════
# 0750 root:caddy. The KEY must be readable by the caddy user and by nobody else; a world-readable
# private key on a multi-user box is the kind of thing that is discovered much later.
getent group caddy >/dev/null || warn "no caddy group -- falling back to root:root on $CERTDIR"
grp=$(getent group caddy >/dev/null && echo caddy || echo root)
install -d -m 0750 -o root -g "$grp" /etc/caddy "$CERTDIR" && ok "created $CERTDIR (root:$grp 0750)"
install -d -m 0755 -o "$grp" -g "$grp" /var/log/caddy && ok "created /var/log/caddy"
install -d -m 0750 -o root -g root /etc/vault && ok "created /etc/vault"

# ══════════════════════════════════════════════════════════════════════════════════════════
step "2. The renewal parameters"
# ══════════════════════════════════════════════════════════════════════════════════════════
# These three values also appear in the Caddyfile. That duplication is the documented hazard in
# deploy/README.md: change one and not the other and the renewal writes a certificate somewhere
# Caddy is not looking -- which works right up until the current one expires, 90 days later, with
# nothing in between to suggest a problem. tests/deployCertPaths.test.ts pins the repo copies
# agreeing; this step is what makes the INSTALLED copies agree, by deriving both from here.
umask 077
{
  printf '# Written by caddy-install.sh. These MUST match the tls line in /etc/caddy/Caddyfile.\n'
  printf 'TAILSCALE_CERT_DOMAIN=%s\n' "$DOMAIN"
  printf 'TAILSCALE_CERT_PATH=%s\n' "$CERT"
  printf 'TAILSCALE_KEY_PATH=%s\n' "$KEY"
  printf 'CADDY_UNIT=caddy.service\n'
} > "$ENVFILE"
chmod 0640 "$ENVFILE"; chown root:root "$ENVFILE"
ok "wrote $ENVFILE"

# ══════════════════════════════════════════════════════════════════════════════════════════
step "3. The renewal script, at a path systemd can actually exec"
# ══════════════════════════════════════════════════════════════════════════════════════════
install -m 0755 -o root -g root "$UNITSRC/tailscale-cert-renew.sh" "$RENEW" && ok "installed $RENEW"
restorecon "$RENEW" 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════════════════════════
step "4. The first certificate"
# ══════════════════════════════════════════════════════════════════════════════════════════
# This is where a tailnet without HTTPS Certificates enabled fails, and the message talks about the
# domain rather than the feature -- so it reads as DNS. If this step fails, check the admin console
# before anything else.
if [ -s "$CERT" ] && [ -s "$KEY" ]; then
  ok "certificate already present, not reissuing"
else
  if tailscale cert --cert-file "$CERT" --key-file "$KEY" "$DOMAIN" 2>&1 | sed 's/^/      /'; then
    ok "issued a certificate for $DOMAIN"
  else
    bad "tailscale cert failed -- if it names the domain, check HTTPS Certificates is ENABLED for this tailnet in the admin console"
  fi
fi
if [ -s "$KEY" ]; then
  chown "root:$grp" "$CERT" "$KEY" 2>/dev/null
  chmod 0640 "$CERT" "$KEY" 2>/dev/null
  ok "cert and key are root:$grp 0640"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "5. The Caddyfile, with the placeholders resolved"
# ══════════════════════════════════════════════════════════════════════════════════════════
# The committed Caddyfile carries placeholders on purpose: the hostname and the certificate paths
# are per-host facts, and a repo that hardcodes one box's names is a repo that silently deploys the
# wrong thing on the next one.
sed -e "s|edaserver\.<tailnet>\.ts\.net|$DOMAIN|" \
    -e "s|<tailscale_cert_path>|$CERT|" \
    -e "s|<tailscale_key_path>|$KEY|" \
    "$UNITSRC/Caddyfile" > /etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
if grep -q '<tailscale_\|<tailnet>' /etc/caddy/Caddyfile; then
  bad "a placeholder survived substitution in /etc/caddy/Caddyfile"
  grep -n '<tailscale_\|<tailnet>' /etc/caddy/Caddyfile | sed 's/^/      /'
else
  ok "substituted hostname and certificate paths"
fi
restorecon /etc/caddy/Caddyfile 2>/dev/null || true

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  && ok "caddy validate passes" \
  || { bad "caddy validate failed"; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5 | sed 's/^/      /'; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "6. The renewal timer"
# ══════════════════════════════════════════════════════════════════════════════════════════
# `cp`, never `mv`: a moved file keeps its source SELinux context and systemd refuses it, reporting
# a problem with the unit rather than with the label.
cp -f "$UNITSRC/tailscale-cert.timer" /etc/systemd/system/ && ok "installed tailscale-cert.timer"
# Rewrite ExecStart to the installed path. See the assertion in step 0 for why not /srv/vault/app.
sed "s|^ExecStart=.*|ExecStart=$RENEW|" "$UNITSRC/tailscale-cert.service" > /etc/systemd/system/tailscale-cert.service
ok "installed tailscale-cert.service (ExecStart -> $RENEW)"
restorecon /etc/systemd/system/tailscale-cert.* 2>/dev/null || true

semanage fcontext -l 2>/dev/null | grep -q "^$CERTDIR" \
  || semanage fcontext -a -t cert_t "$CERTDIR(/.*)?" 2>/dev/null \
  && ok "fcontext rule for $CERTDIR" || warn "could not add an fcontext rule for $CERTDIR"
restorecon -R "$CERTDIR" 2>/dev/null || true

systemctl daemon-reload
# ENABLE THE TIMER, NOT THE SERVICE. The service is Type=oneshot and carries no [Install] section
# deliberately: enabling it would run a certificate renewal on every boot. The timer is the thing
# with WantedBy=timers.target, and it is what makes the renewal happen at all.
systemctl enable --now tailscale-cert.timer >/dev/null 2>&1
systemctl is-enabled --quiet tailscale-cert.timer && ok "tailscale-cert.timer enabled" \
  || bad "tailscale-cert.timer is not enabled -- the certificate will expire in 90 days with no warning"

# ══════════════════════════════════════════════════════════════════════════════════════════
step "7. Start Caddy"
# ══════════════════════════════════════════════════════════════════════════════════════════
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 2
if systemctl is-active --quiet caddy; then
  ok "caddy active"
else
  bad "caddy failed to start"
  journalctl -u caddy -n 12 --no-pager | sed 's/^/      /'
  denials=$(ausearch -m avc -ts recent 2>/dev/null | grep -c denied)
  [ "${denials:-0}" -gt 0 ] && { printf '      \033[33m%s SELinux denial(s):\033[0m\n' "$denials"; ausearch -m avc -ts recent 2>/dev/null | grep denied | tail -3 | sed 's/^/        /'; }
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "8. Verify over the tailnet name, with a real token"
# ══════════════════════════════════════════════════════════════════════════════════════════
# A 200 is not a verification. Every vault table has RLS enabled with no policies, so a grant or
# ownership mistake returns [] from everything while every status code stays 200 -- an empty
# database and an unauthorised one look identical from outside. This reads connect.kinds, which the
# migration chain SEEDS and which is therefore never legitimately empty. connect.health is not used
# for this: it is all zeros today because no vault data has been migrated, so a check against it
# could not fail, and a check that cannot fail is not a check.
SECRETS=/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env
SEC=$(grep -m1 '^PGRST_JWT_SECRET=' "$SECRETS" 2>/dev/null | cut -d= -f2- | tr -d '"')
if [ -z "$SEC" ]; then
  warn "could not read the JWT secret from $SECRETS -- skipping the authenticated check"
else
  TOK=$(mktemp); chmod 600 "$TOK"
  SECRET="$SEC" python3 - "$TOK" <<'PYEOF' 2>/dev/null
import base64, hashlib, hmac, json, os, sys, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
hdr = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
pay = json.dumps({"role": "connect_read", "exp": int(time.time()) + 300}, separators=(",", ":")).encode()
msg = b(hdr) + b"." + b(pay)
sig = b(hmac.new(os.environ["SECRET"].encode(), msg, hashlib.sha256).digest())
open(sys.argv[1], "w").write("Authorization: Bearer " + (msg + b"." + sig).decode())
PYEOF
  unset SEC
  body=$(curl -sS --max-time 10 -H "@$TOK" -H 'Accept-Profile: connect' "https://$DOMAIN/rest/v1/kinds?select=kind" 2>&1)
  n=$(printf '%s' "$body" | grep -o '"kind"' | wc -l)
  [ "${n:-0}" -ge 1 ] && ok "connect.kinds returned $n row(s) over TLS through Caddy" \
    || { bad "no rows through the tailnet door"; printf '      %s\n' "$(printf '%s' "$body" | head -c 200)"; }
  rm -f "$TOK"

  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H 'Accept-Profile: connect' "https://$DOMAIN/rest/v1/kinds" 2>/dev/null)
  [ "$code" = 401 ] && ok "no token -> 401 (fails closed, over TLS)" \
    || bad "no token -> $code, expected 401"
fi

# The catch-all must refuse. Anything not explicitly routed is not part of the promised surface,
# and a door that serves something unplanned is a door nobody has reasoned about.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" 2>/dev/null)
[ "$code" = 404 ] && ok "unrouted path -> 404" || warn "unrouted path -> $code, expected 404"

# /api and /healthz go to 127.0.0.1:8099, which is vault-api. That is NOT installed on this box
# (node is not installed either), so a 502 here is expected and is not a Caddy fault. Reported as a
# warn rather than a failure so it does not read as a broken door.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" 2>/dev/null)
case "$code" in
  200) ok "/healthz answered (vault-api is up)" ;;
  502) warn "/healthz -> 502: vault-api is not installed yet. Expected. The DATA plane (/rest/v1, /storage/v1) does not depend on it." ;;
  *)   warn "/healthz -> $code" ;;
esac

printf '\n\033[1mReachable now, from any device on the tailnet:\033[0m\n'
printf '  https://%s/rest/v1/...      (Accept-Profile: public|vault|connect, Bearer token)\n' "$DOMAIN"
printf '  https://%s/storage/v1/...   (same token)\n' "$DOMAIN"
printf '\n\033[1mTo undo:\033[0m\n'
cat <<UNDO
  systemctl disable --now caddy tailscale-cert.timer
  rm -f /etc/caddy/Caddyfile $RENEW $ENVFILE
  rm -f /etc/systemd/system/tailscale-cert.{service,timer}
  systemctl daemon-reload
  # $CERTDIR is left deliberately: deleting it discards a valid certificate, and reissuing is rate
  # limited by Let's Encrypt. semanage fcontext -d '$CERTDIR(/.*)?' if you want the label gone too.
UNDO
[ "$fail" -gt 0 ] && exit 1 || exit 0
