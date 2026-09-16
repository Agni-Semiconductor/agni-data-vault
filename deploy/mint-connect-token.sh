#!/usr/bin/env bash
set -uo pipefail
# Mint a connect_read token for agni-connect, and prove it reads exactly what it should.
#
#   sudo bash deploy/mint-connect-token.sh --prove     # mint, test the read path, print NO token
#   sudo bash deploy/mint-connect-token.sh             # mint and print the token, once, for SOPS
#
# THE ONLY ROLE THIS SCRIPT WILL MINT IS connect_read. The data plane uses HS256, so the signing
# secret is also the verification secret, and whoever can mint connect_read can mint vault_service --
# BYPASSRLS, writes every measurement table. This script exists so that the person holding the
# secret can hand out the narrow token WITHOUT reasoning about the wide one each time: the role is
# a constant here, not an argument, and a request for any other role is refused by design.
#
# The token has no expiry, like the vault's own service token: it is a credential read from a file
# at process start, and an expiring one becomes an outage on a date nobody wrote down. Rotation is
# minting a new one and replacing the file, deliberately.
#
# What the recipient does with it: `CONNECT_VAULT_TOKEN` in SOPS, then `Authorization: Bearer` on
# every request to /rest/v1 with `Accept-Profile: connect`. See docs/CONNECT_AGENT_HANDOFF.md.
#
# This script changes nothing on the host. --prove reads two views over loopback and exits.

SECRETS=/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env
ORIGIN=${CONNECT_PROVE_ORIGIN:-http://127.0.0.1:8087}
ROLE=connect_read
PROVE=0
fail=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*" >&2; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*" >&2; }

usage() { sed -n '3,6p' "$0" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prove) PROVE=1; shift ;;
    --role)
      # Refused on purpose. See the header.
      echo "this script mints connect_read only; it does not take --role" >&2; exit 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...): the secret is 0600 fedbackup" >&2; exit 2; }

step "1. The secret, read and never printed"
[ -r "$SECRETS" ] || { bad "$SECRETS is not readable"; exit 1; }
SEC=$(grep -m1 '^PGRST_JWT_SECRET=' "$SECRETS" | cut -d= -f2- | tr -d '"')
if [ "${#SEC}" -ge 32 ]; then
  ok "PGRST_JWT_SECRET present (${#SEC} chars; PostgREST itself requires >= 32)"
else
  bad "PGRST_JWT_SECRET missing or shorter than 32 chars in $SECRETS"; exit 1
fi

# HS256 by hand, stdlib only, the same construction vault-api-install.sh uses for vault_service.
TOKEN=$(SECRET="$SEC" ROLE="$ROLE" python3 - <<'PYEOF' 2>/dev/null
import base64, hashlib, hmac, json, os
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
hdr = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
pay = json.dumps({"role": os.environ["ROLE"]}, separators=(",", ":")).encode()
msg = b(hdr) + b"." + b(pay)
print((msg + b"." + b(hmac.new(os.environ["SECRET"].encode(), msg, hashlib.sha256).digest())).decode())
PYEOF
)
unset SEC
if [ -n "$TOKEN" ] && [ "$(printf '%s' "$TOKEN" | tr -cd '.' | wc -c)" = "2" ]; then
  ok "minted a $ROLE token (three segments)"
else
  bad "could not mint the token"; exit 1
fi
# Prove the claim is what this script promises, by decoding what it just made rather than trusting
# the code above.
claim=$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | awk '{ l=length($0)%4; if (l) $0=$0 substr("===",1,4-l); print }' | base64 -d 2>/dev/null)
[ "$claim" = "{\"role\":\"$ROLE\"}" ] && ok "payload is exactly $claim" || { bad "payload is $claim, not {\"role\":\"$ROLE\"}"; exit 1; }

if [ "$PROVE" -eq 1 ]; then
  step "2. The read path, through nginx on loopback, as the token's role"
  # kinds is seeded by migration and never legitimately empty: 7 rows is the liveness floor. A grant
  # fault on this cluster returns [] with 200, so the COUNT is the test, not the status.
  body=$(curl -sS --max-time 10 -H 'Accept-Profile: connect' -H "Authorization: Bearer $TOKEN" "$ORIGIN/rest/v1/kinds" 2>/dev/null)
  n=$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    v=json.load(sys.stdin); print(len(v) if isinstance(v,list) else -1)
except Exception: print(-2)')
  case "$n" in
    -2) bad "connect.kinds did not return JSON: $(printf '%s' "$body" | head -c 160)" ;;
    -1) bad "connect.kinds returned an object, not rows: $(printf '%s' "$body" | head -c 160)" ;;
    0)  bad "connect.kinds returned 0 rows -- a GRANT problem, not an empty database (kinds is seeded)" ;;
    *)  if [ "$n" -ge 7 ]; then ok "connect.kinds returns $n rows (>= 7)"; else bad "connect.kinds returns $n rows, fewer than the 7 seeded"; fi ;;
  esac
  h=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Accept-Profile: connect' -H "Authorization: Bearer $TOKEN" "$ORIGIN/rest/v1/health" 2>/dev/null)
  [ "$h" = "200" ] && ok "connect.health answers 200" || bad "connect.health answered $h"

  step "3. The token is narrow: it must be REFUSED outside connect"
  # 403 is the right answer. 200 with [] would mean the role can see a schema it must not; 401 would
  # mean the token is not being recognised at all and the 200s above were something else.
  for probe in "vault:samples" "public:campaign_runs"; do
    schema=${probe%%:*}; table=${probe#*:}
    code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "Accept-Profile: $schema" -H "Authorization: Bearer $TOKEN" "$ORIGIN/rest/v1/$table" 2>/dev/null)
    case "$code" in
      403|404) ok "$schema.$table -> $code (refused)" ;;
      200) bad "$schema.$table -> 200: connect_read can read outside connect; STOP and check grants" ;;
      *)   bad "$schema.$table -> $code (expected 403)" ;;
    esac
  done
  unset TOKEN
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: connect_read read path FAILED (%d failure(s)). Do not hand out a token yet.\033[0m\n' "$fail" >&2; exit 1
  fi
  printf '\n\033[32mVERDICT: connect_read read path proven. Re-run without --prove to print a token for SOPS.\033[0m\n' >&2
  exit 0
fi

# Plain run: the token, alone, on stdout, so it can be piped straight into a secrets tool without a
# log line beside it. Everything else this script says goes to stderr.
printf '%s\n' "$TOKEN"
unset TOKEN
printf '\n\033[33mThat is a live connect_read credential. Put it in SOPS as CONNECT_VAULT_TOKEN; do not paste it into chat, a ticket, or a register.\033[0m\n' >&2
