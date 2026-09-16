#!/usr/bin/env bash
# Probe the vault health endpoint and alert only when a sustained outage begins.
#
#   bash deploy/fedbench-healthz.sh
#   bash deploy/fedbench-healthz.sh --check
#   bash deploy/fedbench-healthz.sh --status
#   FEDBENCH_HEALTHZ_URL=http://127.0.0.1:8099/healthz bash deploy/fedbench-healthz.sh
#
# Undo: removes only ${FEDBENCH_STATE_DIR:-/var/lib/fedbench}/healthz-state; delete that file to
# forget the current streak and transition. This script changes no endpoint, database, or service.
set -uo pipefail

URL=${FEDBENCH_HEALTHZ_URL:-http://127.0.0.1:8099/healthz}
STATEDIR=${FEDBENCH_STATE_DIR:-/var/lib/fedbench}
TIMEOUT=${FEDBENCH_HEALTHZ_TIMEOUT:-10}
THRESHOLD=${FEDBENCH_HEALTHZ_FAILURE_THRESHOLD:-3}
REALERT_SECONDS=${FEDBENCH_HEALTHZ_REALERT_SECONDS:-21600}
STATEFILE="$STATEDIR/healthz-state"
CHECK=0
STATUS=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  sed -n '2,11p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --status) STATUS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$CHECK" -eq 0 ] || [ "$STATUS" -eq 0 ] || { echo "--check and --status cannot be combined" >&2; exit 2; }
for setting in TIMEOUT THRESHOLD REALERT_SECONDS; do
  value=${!setting}
  case "$value" in
    ''|*[!0-9]*) echo "$setting must be a positive whole number, not: $value" >&2; exit 2 ;;
  esac
  [ "$value" -gt 0 ] || { echo "$setting must be at least 1" >&2; exit 2; }
done

read_state() {
  streak=0
  transition=never
  alert_at=0
  [ -r "$STATEFILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      streak) streak=$value ;;
      transition) transition=$value ;;
      alert_at) alert_at=$value ;;
    esac
  done <"$STATEFILE"
  case "$streak" in ''|*[!0-9]*) streak=0 ;; esac
  case "$alert_at" in ''|*[!0-9]*) alert_at=0 ;; esac
}

write_state() {
  # Write through a temporary file so a reboot cannot leave a half-written streak that suppresses
  # the next real alert while the endpoint is still down.
  tmp=$(mktemp "$STATEDIR/.healthz-state.XXXXXX") || return 1
  {
    printf 'streak=%s\n' "$streak"
    printf 'transition=%s\n' "$transition"
    printf 'alert_at=%s\n' "$alert_at"
  } >"$tmp" && mv -f "$tmp" "$STATEFILE" || { rm -f "$tmp"; return 1; }
}

probe() {
  response=$(mktemp) || { result='could not create a temporary response file'; return 1; }
  # --fail catches HTTP errors; body validation below catches HTTP 200 with ok:false, the Slack-like
  # response shape that made curl report success while the requested operation had failed.
  if ! curl --silent --show-error --fail --max-time "$TIMEOUT" --output "$response" "$URL"; then
    rm -f "$response"
    result="curl could not fetch $URL within ${TIMEOUT}s or received an HTTP error"
    return 1
  fi
  result=$(python3 -c '
import json
import sys
try:
    body = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    print("response body is not JSON")
    raise SystemExit(10)
if not isinstance(body, dict) or body.get("ok") is not True:
    print("response JSON reports ok:false")
    raise SystemExit(11)
checks = body.get("checks")
if not isinstance(checks, dict) or "database" not in checks:
    print("response JSON is missing the database check")
    raise SystemExit(12)
database = checks["database"]
if not isinstance(database, dict) or database.get("ok") is not True:
    print("response JSON reports the database check failed")
    raise SystemExit(13)
rows = database.get("field_definitions")
if not isinstance(rows, int) or isinstance(rows, bool):
    print("response JSON is missing the database row count")
    raise SystemExit(14)
if rows <= 0:
    print("response JSON reports zero database rows")
    raise SystemExit(15)
print(f"endpoint and database are healthy ({rows} field definitions)")
' <"$response")
  parse_status=$?
  rm -f "$response"
  [ "$parse_status" -eq 0 ]
}

if [ "$STATUS" -eq 1 ]; then
  read_state
  printf 'healthz status: streak=%s last-transition=%s\n' "$streak" "$transition"
  printf '\033[32mVERDICT: healthz STATUS REPORTED.\033[0m\n'
  exit 0
fi

if [ "$CHECK" -eq 1 ]; then
  step "Health endpoint rehearsal"
  # A check that only stats the state directory passes while the timer user cannot record a failure,
  # so actually create and remove a file without retaining state.
  if [ -d "$STATEDIR" ]; then
    writable=$(mktemp "$STATEDIR/.healthz-check.XXXXXX" 2>/dev/null) || writable=""
    if [ -n "$writable" ]; then rm -f "$writable"; ok "$STATEDIR can record health state"; else bad "$STATEDIR is not writable"; fi
  else
    parent=$(dirname "$STATEDIR")
    if [ -d "$parent" ] && [ -w "$parent" ] && [ -x "$parent" ]; then ok "$parent can create $STATEDIR"; else bad "$parent cannot create $STATEDIR"; fi
  fi
  if probe; then ok "$result"; else bad "$result"; fi
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: healthz CHECK FAILED (%d failure(s)); state was not changed.\033[0m\n' "$fail"
    exit 1
  fi
  printf '\n\033[32mVERDICT: healthz CHECK PASSED; state was not changed.\033[0m\n'
  exit 0
fi

if [ ! -d "$STATEDIR" ]; then
  # Create state as the timer user, not root at install time, so later runs do not fail to remember
  # the streak and turn every dropped packet into an alert.
  mkdir -p "$STATEDIR" || { bad "could not create state directory $STATEDIR"; printf '\033[31mVERDICT: healthz FAILED (%d failure(s)).\033[0m\n' "$fail"; exit 1; }
fi
read_state
now=$(date +%s)
if probe; then
  if [ "$streak" -gt 0 ]; then
    # Recovery is printed once so the original alert is closed, rather than leaving an operator to
    # infer a healthy endpoint from later routine output.
    printf 'RECOVERY: health endpoint succeeded after %s consecutive failure(s): %s\n' "$streak" "$result"
    transition="recovery:$now"
    alert_at=0
    streak=0
    write_state || { bad "could not reset health state in $STATEDIR"; }
  else
    ok "$result"
  fi
  if [ "$fail" -gt 0 ]; then printf '\033[31mVERDICT: healthz FAILED (%d failure(s)).\033[0m\n' "$fail"; exit 1; fi
  printf '\033[32mVERDICT: healthz PASSED.\033[0m\n'
  exit 0
fi

streak=$((streak + 1))
if [ "$streak" -lt "$THRESHOLD" ]; then
  # Require consecutive failures so a single dropped packet does not page people into muting a
  # healthy check before the five-hour network loss this probe exists to expose.
  warn "$result (failure ${streak}/${THRESHOLD}; alert suppressed)"
  transition="failing:$now"
  write_state || { bad "could not record health state in $STATEDIR"; }
  printf '\033[32mVERDICT: healthz PASSED (failure below alert threshold).\033[0m\n'
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi
if [ "$alert_at" -eq 0 ] || [ $((now - alert_at)) -ge "$REALERT_SECONDS" ]; then
  # Page at the transition, then wait six hours by default: a multi-day outage posting every few
  # minutes gets muted and turns the alert channel into another silent failure.
  bad "$result (failure streak ${streak}; alerting now)"
  transition="failure:$now"
  alert_at=$now
  write_state || bad "could not record health state in $STATEDIR"
  printf '\033[31mVERDICT: healthz FAILED (%d failure(s)).\033[0m\n' "$fail"
  exit 1
fi
warn "$result (failure streak ${streak}; re-alert suppressed until ${REALERT_SECONDS}s have elapsed)"
write_state || { bad "could not record health state in $STATEDIR"; printf '\033[31mVERDICT: healthz FAILED (%d failure(s)).\033[0m\n' "$fail"; exit 1; }
printf '\033[32mVERDICT: healthz PASSED (outage already alerted).\033[0m\n'
exit 0
