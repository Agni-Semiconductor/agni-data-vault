#!/usr/bin/env bash
# Report a failed fedbench unit to Slack. Invoked by fedbench-alert@.service, which every fedbench
# job names in its OnFailure=. Installed to /usr/local/bin by alerting-install.sh.
#
#   fedbench-notify-failure.sh fedbench-backup.service
#   FEDBENCH_ALERT_DRY_RUN=1 fedbench-notify-failure.sh fedbench-backup.service   # print, send nothing
#
# WHY THIS EXISTS: the nightly backup failed three consecutive nights and nothing said a word. The
# unit reported status=203/EXEC each time, correctly, to a journal nobody reads at 02:20.
#
# Undo: this script sends one Slack message and touches a marker file under /var/lib/fedbench. It
# changes no database, backup, service, or configuration.
set -uo pipefail

UNIT=${1:-}
ENVFILE=${FEDBENCH_ALERT_ENV:-/etc/fedbench/alert.env}
STATEDIR=${FEDBENCH_STATE_DIR:-/var/lib/fedbench}
MARKER="$STATEDIR/alert-delivery-failed"
DRY=${FEDBENCH_ALERT_DRY_RUN:-0}

# Anything this script writes is readable only by root: the payload embeds journal output, which for
# a failed database job can quote connection strings and table contents.
umask 077

if [ -z "$UNIT" ]; then
  echo "usage: $0 <unit-name>" >&2
  exit 2
fi

log() { printf 'fedbench-alert: %s\n' "$*" >&2; }

# A marker, not an exit status. systemd discards an OnFailure handler's exit code -- nothing
# reacts to it -- so a failure to DELIVER the alert would itself be silent, which is the exact
# shape of the bug this whole script exists to fix. fedbench-deadman.sh reads this file.
mark_undelivered() {
  mkdir -p "$STATEDIR" 2>/dev/null
  { printf 'unit=%s\n' "$UNIT"; printf 'at=%s\n' "$(date -Is)"; printf 'reason=%s\n' "$1"; } \
    >"$MARKER" 2>/dev/null
  log "ALERT NOT DELIVERED ($1) -- marker written to $MARKER"
}

# ── Gather what makes the alert actionable ────────────────────────────────────────────────────
# A message that says only "a unit failed" sends someone to the box to run the command this script
# could have run for them.
host=$(hostname -s 2>/dev/null || echo unknown)
result=$(systemctl show -p Result --value "$UNIT" 2>/dev/null)
status=$(systemctl show -p ExecMainStatus --value "$UNIT" 2>/dev/null)
# -o cat drops the syslog prefix; the unit name is already in the message heading.
journal=$(journalctl -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null)
[ -n "$journal" ] || journal="(no journal output for $UNIT)"

# ── Build the payload with a JSON encoder, never with string concatenation ─────────────────────
# Journal text contains quotes, backslashes and newlines as a matter of course. Hand-built JSON
# breaks on the first one, and the failure mode is a 400 from Slack that looks like a network
# problem rather than a quoting problem.
payload=$(mktemp) || { mark_undelivered "mktemp failed"; exit 1; }
config=$(mktemp) || { rm -f "$payload"; mark_undelivered "mktemp failed"; exit 1; }
trap 'rm -f "$payload" "$config"' EXIT

FEDBENCH_HOST="$host" FEDBENCH_UNIT="$UNIT" FEDBENCH_RESULT="${result:-unknown}" \
FEDBENCH_STATUS="${status:-unknown}" FEDBENCH_JOURNAL="$journal" \
python3 -c '
import json, os
text = "*fedbench job failed on {host}*\n`{unit}`  result=`{result}`  exit=`{status}`".format(
    host=os.environ["FEDBENCH_HOST"],
    unit=os.environ["FEDBENCH_UNIT"],
    result=os.environ["FEDBENCH_RESULT"],
    status=os.environ["FEDBENCH_STATUS"],
)
tail = os.environ["FEDBENCH_JOURNAL"]
# Slack rejects messages over 40000 characters outright. Truncating from the FRONT keeps the last
# lines, which is where a failing job says why.
limit = 2800
if len(tail) > limit:
    tail = "...(truncated)...\n" + tail[-limit:]
print(json.dumps({"text": text + "\n```\n" + tail + "\n```"}))
' >"$payload" 2>/dev/null

if [ ! -s "$payload" ]; then
  mark_undelivered "could not build the JSON payload"
  exit 1
fi

if [ "$DRY" = "1" ]; then
  log "DRY RUN -- would post this payload:"
  cat "$payload" >&2
  exit 0
fi

# ── Read the webhook, and treat its absence as a failure rather than as "alerting off" ─────────
if [ ! -r "$ENVFILE" ]; then
  mark_undelivered "no readable $ENVFILE -- alerting is not configured"
  exit 1
fi
# shellcheck disable=SC1090
. "$ENVFILE"
if [ -z "${FEDBENCH_SLACK_WEBHOOK:-}" ]; then
  mark_undelivered "$ENVFILE defines no FEDBENCH_SLACK_WEBHOOK"
  exit 1
fi

# The URL goes in a 0600 config file, NOT on the command line. `ps` is world-readable and this box
# has other human accounts on it (fedci, the shared EDA users); a webhook URL is a bearer
# credential, and anyone who reads it can post to the channel as this alerter.
{
  printf 'url = "%s"\n' "$FEDBENCH_SLACK_WEBHOOK"
  printf 'data-binary = "@%s"\n' "$payload"
  printf 'header = "Content-Type: application/json"\n'
} >"$config"

# --fail turns Slack's 4xx into a non-zero status. Without it curl exits 0 on an HTTP error and
# prints the body, so a revoked webhook would report success forever.
if response=$(curl -sS --fail --max-time 20 --retry 2 --retry-delay 3 --config "$config" 2>&1); then
  log "reported $UNIT to Slack (${response:-no body})"
  rm -f "$MARKER" 2>/dev/null
  exit 0
fi

mark_undelivered "curl failed: ${response:-no output}"
exit 1
