#!/usr/bin/env bash
# vault-api: the application endpoint behind /api and /healthz on the tailnet door.
#
#   sudo bash vault-api-install.sh --check     # assertions only. Changes NOTHING. Run this first.
#   sudo bash vault-api-install.sh
#
# ─── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────
# Caddy already routes /api/* and /healthz to 127.0.0.1:8099 and gets a 502, because nothing is
# listening there. This puts vault-api on that port. The DATA plane (/rest/v1, /storage/v1) does
# not depend on it and is unaffected either way.
#
# ─── THE CREDENTIAL IT HOLDS ───────────────────────────────────────────────────────────────
# vault-api talks to PostgREST as `vault_service`, which holds BYPASSRLS and can write every table
# in the vault schema. That token is the reason this service binds LOOPBACK and sits behind two
# proxies: anything that can reach it directly can act as vault_service. The env file is 0640
# root:vaultsvc and the token is never printed.
#
# ─── WHAT IT TOUCHES ───────────────────────────────────────────────────────────────────────
#   /srv/vault/app/node_modules               (npm ci, as vaultsvc)
#   /etc/vault/vault-api.env                  (created if absent; an existing one is never rewritten)
#   /etc/systemd/system/vault-api.service
#
# It does not touch /home, /storage/home or /home/shared, does not modify the fedbackup checkout,
# and does not touch the vault database. This box is somebody's EDA machine first.
set -uo pipefail

APP=/srv/vault/app
ENVFILE=/etc/vault/vault-api.env
SECRETS=/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env
SVCUSER=vaultsvc
UNITSRC=${UNITSRC:-/home/agnidata/work/deploy}
PORT=8099
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
if command -v node >/dev/null; then
  NODE=$(command -v node)
  NODEV=$(node -v 2>/dev/null)
  ok "node present: $NODE $NODEV"
  # The repo is ESM with top-level await in places and targets a current runtime. An old node
  # fails at PARSE time with a syntax error pointing at valid code, which reads as a corrupt file.
  major=$(printf '%s' "$NODEV" | sed 's/^v//; s/\..*//')
  [ "${major:-0}" -ge 18 ] && ok "node $NODEV is new enough" \
    || bad "node $NODEV is too old -- this is ESM and expects 18 or newer"
else
  bad "node is not installed -- sudo dnf install -y nodejs (RHEL 9 AppStream has 18/20/22)"
  NODE=/usr/bin/node
fi

command -v npm >/dev/null && ok "npm present" || bad "npm is not installed"

id "$SVCUSER" >/dev/null 2>&1 && ok "service user $SVCUSER exists" \
  || bad "no $SVCUSER user -- run deploy/bootstrap-accounts.sh first"

[ -f "$APP/server/vault-api.mjs" ] && ok "app staged at $APP" \
  || bad "no $APP/server/vault-api.mjs -- stage the app tree there first"
[ -f "$APP/package-lock.json" ] && ok "package-lock.json present (npm ci needs it)" \
  || bad "no $APP/package-lock.json -- npm ci refuses without a lockfile, and npm install would resolve fresh"

# The shim must be up: vault-api talks to PostgREST THROUGH it, not directly.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8087/rest/v1/ 2>/dev/null)
[ "$code" = 200 ] && ok "nginx shim answering on 127.0.0.1:8087" \
  || bad "nginx shim returned '${code:-nothing}' -- run root-install.sh first"

# WHO holds the port, not merely whether it is held -- otherwise this script fails on its own
# success the moment it has run once.
owner=$(ss -lntpH 2>/dev/null | awk -v p="$PORT" '{n=split($4,a,":"); if (a[n]==p) print}' | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1)
case "${owner:-}" in
  "")     ok "port $PORT free" ;;
  node)   ok "port $PORT held by node -- this script manages it" ;;
  *)      bad "port $PORT is held by '$owner', which this script does not manage" ;;
esac

[ -r "$UNITSRC/vault-api.service" ] && ok "staged vault-api.service" \
  || bad "missing $UNITSRC/vault-api.service"

# The shared secret, needed to mint the service token. Never printed, here or anywhere.
if [ -r "$SECRETS" ] && grep -q '^PGRST_JWT_SECRET=' "$SECRETS"; then
  ok "shared JWT secret readable (value not printed)"
else
  bad "cannot read PGRST_JWT_SECRET from $SECRETS -- the service token is signed with it"
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31m%d assertion(s) failed. Nothing was changed.\033[0m\n' "$fail"
  exit 1
fi
[ "$CHECK_ONLY" = 1 ] && { printf '\n\033[32mAll assertions pass. Re-run without --check to install.\033[0m\n'; exit 0; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "1. Ownership"
# ══════════════════════════════════════════════════════════════════════════════════════════
# The service must be able to update its own node_modules. Installing as root leaves root-owned
# files inside a tree the service user then cannot touch -- the same failure that made pip into
# somebody else's virtualenv a bad idea.
chown -R "$SVCUSER:$SVCUSER" "$APP" && ok "$APP owned by $SVCUSER"
chmod 0750 "$APP"

# ══════════════════════════════════════════════════════════════════════════════════════════
step "2. Dependencies"
# ══════════════════════════════════════════════════════════════════════════════════════════
# `npm ci`, not `npm install`: ci installs exactly the lockfile and fails if package.json and the
# lock disagree, which is the difference between deploying what was tested and deploying whatever
# resolved today.
#
# --omit=dev because nothing here builds or tests. Note this still installs the FRONTEND
# dependencies, which the server never imports -- react, uplot, xlsx and the rest are in the same
# `dependencies` block. That is wasteful rather than wrong, with one real hazard: `xlsx` resolves
# to a tarball on cdn.sheetjs.com rather than the npm registry, so a box that cannot reach that CDN
# fails the whole install over a package the server never loads. If that happens, the error names
# xlsx and the fix is not to debug the server.
if [ -d "$APP/node_modules" ] && sudo -u "$SVCUSER" "$NODE" -e "require.resolve('@supabase/supabase-js')" 2>/dev/null; then
  ok "dependencies already installed"
else
  # HOME AND THE CACHE, SET EXPLICITLY. vaultsvc is a system account whose home is
  # /home/vaultsvc, and that directory does not exist -- deliberately, because a service account
  # that cannot write a home directory is one fewer place for a compromise to leave things.
  # npm does not care about the reason: it fails to create ~/.npm and reports
  #     Log files were not written due to an error writing to the directory: /home/vaultsvc/.npm/_logs
  # which reads as a logging problem rather than a failed install. Point both at the app tree,
  # which this service user owns.
  npm_out=$(mktemp)
  ( cd "$APP" && sudo -u "$SVCUSER" env HOME="$APP" npm_config_cache="$APP/.npm" \
      npm ci --omit=dev --no-audit --no-fund ) >"$npm_out" 2>&1
  # THE REAL EXIT STATUS. The first version piped npm into `tail`, so the status belonged to tail
  # and npm's failure was invisible; the check that followed asked only whether node_modules
  # EXISTED, and npm had already created it with one entry before dying. A partial install then
  # read as a successful one, and the first sign of trouble was the service failing to import.
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "npm ci completed"
  else
    bad "npm ci failed (exit $rc)"
    tail -12 "$npm_out" | sed 's/^/      /'
  fi
  rm -f "$npm_out"
fi

# WHAT THE SERVER ACTUALLY IMPORTS, checked directly. `npm ci` exiting 0 is not the same as the two
# modules this process needs being resolvable, and the difference shows up as a crash at first
# request rather than at install.
for m in '@supabase/supabase-js' '@anthropic-ai/sdk'; do
  ( cd "$APP" && sudo -u "$SVCUSER" "$NODE" --input-type=module -e "import('$m').then(()=>process.exit(0),()=>process.exit(1))" ) 2>/dev/null \
    && ok "  imports $m" || bad "  cannot import $m"
done

# ══════════════════════════════════════════════════════════════════════════════════════════
step "3. The environment file"
# ══════════════════════════════════════════════════════════════════════════════════════════
# An EXISTING file is never rewritten. It may hold a rotated VAULT_API_KEY or an ANTHROPIC_API_KEY
# that nothing here can regenerate, and silently replacing either would look like a working install
# and behave like a revoked credential.
if [ -s "$ENVFILE" ]; then
  ok "$ENVFILE exists -- leaving it alone"
else
  SEC=$(grep -m1 '^PGRST_JWT_SECRET=' "$SECRETS" | cut -d= -f2- | tr -d '"')
  # A long-lived service token. Minted here rather than by tools/mint_service_jwt.py, which lives in
  # the other repo and needs PyJWT; HS256 is an HMAC over two base64url segments.
  TOKEN=$(SECRET="$SEC" python3 - <<'PYEOF' 2>/dev/null
import base64, hashlib, hmac, json, os, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
hdr = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
# No exp: this is a service credential read from a file at process start, and an expiring one turns
# into an outage on a date nobody wrote down. Rotation is replacing the file, deliberately.
pay = json.dumps({"role": "vault_service"}, separators=(",", ":")).encode()
msg = b(hdr) + b"." + b(pay)
print((msg + b"." + b(hmac.new(os.environ["SECRET"].encode(), msg, hashlib.sha256).digest())).decode())
PYEOF
)
  unset SEC
  if [ -z "$TOKEN" ]; then
    bad "could not mint the vault_service token -- NOT writing $ENVFILE"
  else
    APIKEY=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
    (
      umask 077
      {
        printf '# Written by vault-api-install.sh. Values here are credentials; none are printed.\n'
        printf '# VAULT_SERVICE_JWT holds role vault_service, which has BYPASSRLS and writes every\n'
        printf '# vault table. It is signed with the shared secret in the bench secrets.env -- the\n'
        printf '# SAME secret PostgREST and fed_storage verify with. Never regenerate that secret.\n'
        printf 'VAULT_REST_URL=http://127.0.0.1:8087/rest/v1\n'
        printf 'VAULT_STORAGE_URL=http://127.0.0.1:8087/storage/v1\n'
        printf 'VAULT_SERVICE_JWT=%s\n' "$TOKEN"
        printf 'VAULT_API_KEY=%s\n' "$APIKEY"
        printf 'PORT=%s\n' "$PORT"
      } > "$ENVFILE"
    )
    chown root:"$SVCUSER" "$ENVFILE"; chmod 0640 "$ENVFILE"
    unset TOKEN APIKEY
    ok "wrote $ENVFILE (0640 root:$SVCUSER, values not printed)"
    warn "VAULT_API_KEY was generated. Read it with: sudo grep VAULT_API_KEY $ENVFILE"
    warn "Cloudflare Access variables are absent -- /api human auth is not configured, by decision (tailnet only)"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "4. The unit"
# ══════════════════════════════════════════════════════════════════════════════════════════
# `cp`, never `mv`: a moved file keeps its source SELinux context and systemd refuses it, reporting
# a problem with the unit rather than with the label.
cp -f "$UNITSRC/vault-api.service" /etc/systemd/system/ && ok "installed vault-api.service"
restorecon /etc/systemd/system/vault-api.service /etc/vault/vault-api.env 2>/dev/null || true
# ExecStart must be a bin_t path. /usr/bin/node is one; an interpreter under a service account's
# home is not, and systemd reports that as "Failed to locate executable", which reads as a missing
# file. That cost an afternoon on fed-storage.
exe=$(grep -vE '^[[:space:]]*(#|;|$)' /etc/systemd/system/vault-api.service | grep -m1 '^ExecStart=' | cut -d= -f2- | awk '{print $1}')
case "$exe" in
  /usr/bin/*|/usr/local/bin/*|/bin/*) ok "ExecStart runs $exe (a bin_t path)" ;;
  *) bad "ExecStart runs $exe -- systemd may not be able to exec that" ;;
esac
systemctl daemon-reload

# ══════════════════════════════════════════════════════════════════════════════════════════
step "5. Start it"
# ══════════════════════════════════════════════════════════════════════════════════════════
systemctl enable vault-api >/dev/null 2>&1
systemctl restart vault-api
sleep 3
if systemctl is-active --quiet vault-api; then
  ok "vault-api active"
else
  bad "vault-api failed to start"
  journalctl -u vault-api -n 15 --no-pager | sed 's/^/      /'
  denials=$(ausearch -m avc -ts recent 2>/dev/null | grep -c denied)
  [ "${denials:-0}" -gt 0 ] && { printf '      \033[33m%s SELinux denial(s):\033[0m\n' "$denials"; ausearch -m avc -ts recent 2>/dev/null | grep denied | tail -3 | sed 's/^/        /'; }
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "6. Verify"
# ══════════════════════════════════════════════════════════════════════════════════════════
# LOOPBACK ONLY, checked against the kernel. This process holds a BYPASSRLS credential; a routable
# listener would put that on the network behind nothing.
listens=$(ss -lntH 2>/dev/null | awk -v p="$PORT" '{n=split($4,a,":"); if (a[n]==p) print $4}' | sort -u)
if [ -n "$listens" ]; then
  printf '%s\n' "$listens" | sed 's/^/      /'
  printf '%s\n' "$listens" | grep -qE '^(0\.0\.0\.0|\*|\[::\]):' \
    && bad "$PORT is bound on ALL interfaces -- it holds a BYPASSRLS token and must be loopback" \
    || ok "$PORT is loopback only"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/healthz" 2>/dev/null)
[ "$code" = 200 ] && ok "/healthz -> 200 locally" || bad "/healthz -> ${code:-nothing} locally"

# A REAL check. /healthz must read a row it knows exists: every vault table has RLS enabled with no
# policies, so a role provisioned without BYPASSRLS returns [] from everything while the API keeps
# answering 200. A health endpoint that just says {"ok":true} reports perfect health in exactly
# that state.
body=$(curl -sS --max-time 10 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | head -c 400)
printf '  \033[36mhealthz\033[0m %s\n' "$body"
case "$body" in
  *'"ok":true'*|*'"ok": true'*) ok "healthz reports ok" ;;
  *)                            warn "healthz did not report ok -- read the body above" ;;
esac

DOMAIN=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')
if [ -n "$DOMAIN" ]; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" 2>/dev/null)
  [ "$code" = 200 ] && ok "/healthz -> 200 through Caddy on the tailnet" \
    || bad "/healthz through Caddy -> ${code:-nothing} (it was 502 before this install)"
fi

printf '\n\033[1mTo undo:\033[0m\n'
cat <<UNDO
  systemctl disable --now vault-api
  rm -f /etc/systemd/system/vault-api.service
  systemctl daemon-reload
  # $ENVFILE is left deliberately: it holds a minted service token and a generated VAULT_API_KEY,
  # neither of which is recreated by a re-run. $APP is left for the same reason.
UNDO
[ "$fail" -gt 0 ] && exit 1 || exit 0
