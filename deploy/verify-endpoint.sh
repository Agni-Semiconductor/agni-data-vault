#!/usr/bin/env bash
# Verify the live vault data plane on edaserver without changing anything.
#
#   bash deploy/verify-endpoint.sh
#   PGRST_JWT_SECRET=... bash deploy/verify-endpoint.sh
#   bash deploy/verify-endpoint.sh --secrets-file /path/to/secrets.env
#
# This mints a short-lived read token, then checks the nginx -> PostgREST -> Postgres path and
# fed_storage directly. It does not restart services, write database rows, or change any files
# except a 0600 temporary token file that is removed before it exits.
set -uo pipefail

SECRETS=/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env
fail=0
TOKFILE=""

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
usage() {
  cat <<'EOF'
Usage: bash deploy/verify-endpoint.sh [--secrets-file PATH]

Verify the live vault data plane with a short-lived read token. This script is read-only: it
changes no service, database, configuration, or data.

The JWT secret comes from PGRST_JWT_SECRET when set, otherwise from --secrets-file (default:
/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env).
EOF
}
cleanup() { [ -n "$TOKFILE" ] && rm -f "$TOKFILE"; }
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets-file)
      [ $# -ge 2 ] || { echo "--secrets-file needs a path" >&2; exit 2; }
      SECRETS=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Step 8 of root-install.sh uses this SAME secret for PostgREST and fed_storage. Never regenerate
# it to make a probe work: metadata reads would still work while every object download 401s, which
# reads as a corrupt archive rather than a mismatched key.
SECRET=${PGRST_JWT_SECRET:-}
if [ -n "$SECRET" ]; then
  ok "using PGRST_JWT_SECRET from the environment (value not printed)"
elif [ -r "$SECRETS" ]; then
  SECRET=$(grep -m1 '^PGRST_JWT_SECRET=' "$SECRETS" 2>/dev/null | cut -d= -f2- | tr -d '"')
  if [ -n "$SECRET" ]; then
    ok "read PGRST_JWT_SECRET from $SECRETS (value not printed)"
  else
    bad "no PGRST_JWT_SECRET in $SECRETS -- cannot mint a probe token"
  fi
else
  bad "cannot read $SECRETS -- it is 0600 and only root or fedbackup can read it; set PGRST_JWT_SECRET or run as one of them"
fi

if [ -n "$SECRET" ]; then
  TOKFILE=$(mktemp) || { bad "could not create a temporary token file"; TOKFILE=""; }
  if [ -n "$TOKFILE" ]; then
    chmod 600 "$TOKFILE" || bad "could not set the temporary token file to 0600"
    # HS256 is an HMAC over two base64url segments. Use only python3's stdlib rather than PyJWT,
    # and write the Authorization header to a 0600 file so the token never appears in `ps`.
    if python3 -c '
import base64, hashlib, hmac, json, os, sys, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
secret = os.fdopen(3).read().rstrip("\n")
hdr = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
pay = json.dumps({"role": "connect_read", "exp": int(time.time()) + 300}, separators=(",", ":")).encode()
msg = b(hdr) + b"." + b(pay)
sig = b(hmac.new(secret.encode(), msg, hashlib.sha256).digest())
with open(sys.argv[1], "w") as f:
    f.write("Authorization: Bearer " + (msg + b"." + sig).decode())
' "$TOKFILE" 3<<<"$SECRET" 2>/dev/null && [ -s "$TOKFILE" ]; then
      ok "minted a 5-minute connect_read token (not printed)"
    else
      bad "could not mint a probe token"
      rm -f "$TOKFILE"
      TOKFILE=""
    fi
  fi
fi
unset SECRET

step "1. connect.kinds — a 200 is not a verification"
# `connect.kinds` is seeded by the migration chain, so it is never legitimately empty. Do not use
# `connect.health` for this: every count is correctly zero until vault data is migrated, and a
# probe that cannot fail is not a probe.
if [ -n "$TOKFILE" ]; then
  body=$(curl -sS --max-time 5 -H "@$TOKFILE" -H 'Accept-Profile: connect' \
    'http://127.0.0.1:8087/rest/v1/kinds?select=kind' 2>/dev/null)
  n=$(printf '%s' "$body" | grep -o '"kind"' | wc -l)
  if [ "${n:-0}" -ge 1 ]; then
    ok "connect.kinds returned $n row(s) through nginx -> PostgREST -> Postgres"
  else
    bad "connect.kinds returned no rows -- this is the grant/BYPASSRLS failure, not an empty database"
  fi
else
  bad "connect.kinds was not checked -- no probe token is available"
fi

step "2. connect.health — report counts, do not assert on them"
if [ -n "$TOKFILE" ]; then
  health=$(curl -sS --max-time 5 -w '\n%{http_code}' -H "@$TOKFILE" -H 'Accept-Profile: connect' \
    'http://127.0.0.1:8087/rest/v1/health' 2>/dev/null)
  code=${health##*$'\n'}
  body=${health%$'\n'*}
  if [ "$code" = 200 ] && [ -n "$body" ]; then
    ok "connect.health answered: $body"
    echo "          zero samples is expected until data is migrated."
  else
    bad "connect.health returned ${code:-no response}"
  fi
else
  bad "connect.health was not checked -- no probe token is available"
fi

step "3. Unauthenticated requests fail closed"
code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -H 'Accept-Profile: connect' \
  'http://127.0.0.1:8087/rest/v1/kinds' 2>/dev/null)
[ "$code" = 401 ] && ok "no token -> 401 (fails closed)" \
  || bad "no token -> ${code:-no response}, expected 401 -- an unauthenticated reader can reach the data"

step "4. fed_storage — direct health, not through nginx"
# nginx maps /storage/v1/ WITHOUT stripping the prefix, so fed_storage's /health is not reachable
# through the shim. Ask its loopback port directly or a bad nginx path reads as a dead service.
storage=$(curl -sS --max-time 5 'http://127.0.0.1:3001/health' 2>/dev/null)
case "$storage" in
  *'"ok":true'*|*'"ok": true')
    case "$storage" in
      *'"writable":true'*|*'"writable": true') ok "fed_storage health: $storage" ;;
      *) bad "fed_storage health is ok but not writable: $storage" ;;
    esac
    ;;
  "") bad "fed_storage did not answer on 127.0.0.1:3001" ;;
  *)  bad "fed_storage health: $storage" ;;
esac

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31m%d check(s) failed. Nothing was changed.\033[0m\n' "$fail"
  exit 1
fi
printf '\n\033[32mAll checks passed. Nothing was changed.\033[0m\n'
