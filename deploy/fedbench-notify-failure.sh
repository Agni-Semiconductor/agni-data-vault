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
# TWO CREDENTIALS ARE SUPPORTED, and they fail differently:
#
#   FEDBENCH_SLACK_TOKEN + FEDBENCH_SLACK_CHANNEL -> chat.postMessage (a bot token, xoxb-...)
#   FEDBENCH_SLACK_WEBHOOK                        -> an incoming webhook URL
#
# A bot token is preferred when both are present. Read the delivery section below before changing
# it: chat.postMessage answers HTTP 200 for its OWN failures, so the HTTP status is not the answer.
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

# Read the credentials early: the channel is part of the payload for chat.postMessage, so it has to
# be known before the payload is built. A missing file is not fatal here -- a dry run must work
# without credentials, and the real send below refuses loudly if they are absent.
if [ -r "$ENVFILE" ]; then
  # shellcheck disable=SC1090
  . "$ENVFILE"
fi
SLACK_TOKEN=${FEDBENCH_SLACK_TOKEN:-}
SLACK_CHANNEL=${FEDBENCH_SLACK_CHANNEL:-}
SLACK_WEBHOOK=${FEDBENCH_SLACK_WEBHOOK:-}

# The bench already has a Slack bot. Pointing at its credentials beats copying them: a token lives
# in ONE place, so rotating it does not leave a second stale copy quietly failing to deliver alerts
# nobody is watching for. FEDBENCH_SLACK_CREDENTIAL_FILE names the testbench's secrets.env.
CREDFILE=${FEDBENCH_SLACK_CREDENTIAL_FILE:-}
if [ -z "$SLACK_TOKEN" ] && [ -n "$CREDFILE" ]; then
  if [ -r "$CREDFILE" ]; then
    # PARSED, never sourced. That file belongs to another repository and exists for systemd's
    # EnvironmentFile=, which does not execute shell -- sourcing it here would run whatever it
    # happens to contain, as root, on a schedule.
    SLACK_TOKEN=$(sed -n 's/^[[:space:]]*FED_SLACK_BOT_TOKEN=//p' "$CREDFILE" | tail -1)
    SLACK_CHANNEL=$(sed -n 's/^[[:space:]]*FED_SLACK_CHANNEL=//p' "$CREDFILE" | tail -1)
    # EnvironmentFile values may be quoted; a token carrying literal quote characters authenticates
    # as nothing and Slack answers invalid_auth, which reads as a revoked token.
    SLACK_TOKEN=${SLACK_TOKEN%\"}; SLACK_TOKEN=${SLACK_TOKEN#\"}
    SLACK_TOKEN=${SLACK_TOKEN%\'}; SLACK_TOKEN=${SLACK_TOKEN#\'}
    SLACK_CHANNEL=${SLACK_CHANNEL%\"}; SLACK_CHANNEL=${SLACK_CHANNEL#\"}
    SLACK_CHANNEL=${SLACK_CHANNEL%\'}; SLACK_CHANNEL=${SLACK_CHANNEL#\'}
  else
    log "credential file $CREDFILE is not readable -- falling back to whatever $ENVFILE defines"
  fi
fi

MODE=none
if [ -n "$SLACK_TOKEN" ] && [ -n "$SLACK_CHANNEL" ]; then
  MODE=api
elif [ -n "$SLACK_WEBHOOK" ]; then
  MODE=webhook
fi

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
body=$(mktemp) || { rm -f "$payload" "$config"; mark_undelivered "mktemp failed"; exit 1; }
trap 'rm -f "$payload" "$config" "$body"' EXIT

FEDBENCH_HOST="$host" FEDBENCH_UNIT="$UNIT" FEDBENCH_RESULT="${result:-unknown}" \
FEDBENCH_STATUS="${status:-unknown}" FEDBENCH_JOURNAL="$journal" \
FEDBENCH_CHANNEL="$SLACK_CHANNEL" FEDBENCH_MODE="$MODE" \
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
message = {"text": text + "\n```\n" + tail + "\n```"}
# chat.postMessage needs the destination IN the body; an incoming webhook has it baked into the URL.
if os.environ["FEDBENCH_MODE"] == "api":
    message["channel"] = os.environ["FEDBENCH_CHANNEL"]
print(json.dumps(message))
' >"$payload" 2>/dev/null

if [ ! -s "$payload" ]; then
  mark_undelivered "could not build the JSON payload"
  exit 1
fi

if [ "$DRY" = "1" ]; then
  log "DRY RUN (mode=$MODE) -- would post this payload:"
  cat "$payload" >&2
  exit 0
fi

# ── Deliver ───────────────────────────────────────────────────────────────────────────────────
# Credentials go in a 0600 config file, NOT on the command line. `ps` is world-readable and this
# box has other human accounts on it (fedci, the shared EDA users); both a bot token and a webhook
# URL are bearer credentials, and whoever reads one can post as this alerter.
case "$MODE" in
  api)
    {
      printf 'url = "https://slack.com/api/chat.postMessage"\n'
      printf 'data-binary = "@%s"\n' "$payload"
      printf 'header = "Content-Type: application/json; charset=utf-8"\n'
      printf 'header = "Authorization: Bearer %s"\n' "$SLACK_TOKEN"
    } >"$config"
    ;;
  webhook)
    {
      printf 'url = "%s"\n' "$SLACK_WEBHOOK"
      printf 'data-binary = "@%s"\n' "$payload"
      printf 'header = "Content-Type: application/json"\n'
    } >"$config"
    ;;
  *)
    mark_undelivered "no credentials in $ENVFILE (need FEDBENCH_SLACK_TOKEN + FEDBENCH_SLACK_CHANNEL, or FEDBENCH_SLACK_WEBHOOK)"
    exit 1
    ;;
esac

# --fail turns an HTTP error into a non-zero status. Necessary, and for a bot token NOT sufficient:
# see the ok check below.
if ! curl_err=$(curl -sS --fail --max-time 20 --retry 2 --retry-delay 3 \
                     --output "$body" --config "$config" 2>&1); then
  mark_undelivered "curl failed: ${curl_err:-no output}"
  exit 1
fi

# THE TRAP, and it is the whole reason this block is not just a status check:
# chat.postMessage answers HTTP 200 for its OWN failures and puts the real verdict in the body --
#     {"ok": false, "error": "channel_not_found"}
#     {"ok": false, "error": "invalid_auth"}
#     {"ok": false, "error": "not_in_channel"}
# so an expired token, a renamed channel, or a bot that was never invited would all report
# successful delivery forever, silently, which is precisely the failure this alerter exists to
# prevent. An incoming webhook is the simpler case: it answers a literal "ok" body.
if [ "$MODE" = api ]; then
  verdict=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:
    print("unparseable response: %s" % exc); raise SystemExit(1)
if d.get("ok") is True:
    raise SystemExit(0)
# warning is advisory (e.g. "missing_charset"), error is fatal.
print(d.get("error") or "response had ok=false with no error field")
raise SystemExit(1)
' "$body" 2>&1)
  if [ -n "$verdict" ]; then
    mark_undelivered "Slack accepted the request but rejected the message: $verdict"
    exit 1
  fi
fi

log "reported $UNIT to Slack (mode=$MODE)"
rm -f "$MARKER" 2>/dev/null
exit 0
