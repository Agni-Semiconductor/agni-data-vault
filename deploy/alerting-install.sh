#!/usr/bin/env bash
# Install failure alerting and the liveness check for the fedbench jobs.
#
#   sudo bash deploy/alerting-install.sh --check
#   sudo bash deploy/alerting-install.sh            # reuses the testbench's Slack bot, preferred
#   sudo bash deploy/alerting-install.sh --fedbench-secrets /path/to/secrets.env
#   sudo bash deploy/alerting-install.sh --token xoxb-... --channel C0123ABCD   # lands in `ps`
#   sudo bash deploy/alerting-install.sh --webhook 'https://hooks.slack.com/services/T.../B.../xxx'
#   sudo bash deploy/alerting-install.sh                       # keeps existing credentials
#   sudo bash deploy/alerting-install.sh --test-alert          # POSTS to the channel (see below)
#
# WHAT THIS FIXES: the nightly backup failed three consecutive nights and nothing said a word. Two
# mechanisms, because they catch different failures:
#
#   OnFailure=  -- a job that RAN and FAILED. Reports it to Slack with the journal tail.
#   deadman     -- a job that NEVER RAN. A disabled timer produces no failure to react to.
#
# Undo: systemctl disable --now fedbench-restore-drill.timer fedbench-deadman.timer, remove
# /etc/systemd/system/fedbench-{alert@,restore-drill,deadman}.* and the backup drop-in, then
# daemon-reload. Nothing here touches a database, a backup file, or the endpoint.
set -uo pipefail

# The checkout, NOT a hand-copied tree. /home/agnidata/work is a copy with no way to see drift;
# /srv/agni-data-vault is a real clone whose HEAD can be compared with the repository.
UNITSRC=${UNITSRC:-/srv/agni-data-vault/deploy}
BINDIR=/usr/local/bin
UNITDIR=/etc/systemd/system
CONFDIR=/etc/fedbench
ENVFILE="$CONFDIR/alert.env"
STATEDIR=/var/lib/fedbench
DRILL_USER=postgres

CHECK=0
TEST_ALERT=0
WEBHOOK=""
TOKEN=""
CHANNEL=""
# The testbench's own secrets.env, which already holds FED_SLACK_BOT_TOKEN and FED_SLACK_CHANNEL.
# Referencing it keeps the token in one place; --token copies it into a second.
CREDFILE=${CREDFILE:-/srv/fedbackup/ferrodiode-pcb-testbench/server/config/secrets.env}
USE_CREDFILE=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --test-alert) TEST_ALERT=1; shift ;;
    --webhook)
      [ $# -ge 2 ] || { echo "--webhook needs a URL" >&2; exit 2; }
      WEBHOOK=$2; shift 2 ;;
    --token)
      [ $# -ge 2 ] || { echo "--token needs a bot token (xoxb-...)" >&2; exit 2; }
      TOKEN=$2; shift 2 ;;
    --channel)
      [ $# -ge 2 ] || { echo "--channel needs a channel name or ID" >&2; exit 2; }
      CHANNEL=$2; shift 2 ;;
    --fedbench-secrets)
      [ $# -ge 2 ] || { echo "--fedbench-secrets needs a path to the testbench secrets.env" >&2; exit 2; }
      CREDFILE=$2; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }

SCRIPTS="fedbench-notify-failure.sh fedbench-deadman.sh restore-drill.sh"
UNITS="fedbench-alert@.service fedbench-restore-drill.service fedbench-restore-drill.timer fedbench-deadman.service fedbench-deadman.timer"

step "1. Assertions -- the sources, the tools, and the account this runs as"
for f in $SCRIPTS $UNITS; do
  if [ -r "$UNITSRC/$f" ]; then ok "found $UNITSRC/$f"; else bad "missing $UNITSRC/$f"; fi
done

for tool in python3 curl systemctl journalctl; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool is present" || bad "$tool is required and not on PATH"
done

# The drill unit runs as postgres and the drill switches to postgres itself when run as root.
id "$DRILL_USER" >/dev/null 2>&1 && ok "$DRILL_USER exists" || bad "$DRILL_USER does not exist"

# A unit that names a script it may not execute reports 203/EXEC, which reads as a missing file.
# Assert the label rule rather than discovering it at 03:40 on a Sunday.
if [ -d "$BINDIR" ]; then
  ctx=$(ls -Zd "$BINDIR" 2>/dev/null | awk '{print $1}')
  case "$ctx" in
    *:bin_t:*|"") ok "$BINDIR is labelled for systemd to exec from (${ctx:-no SELinux})" ;;
    *)            warn "$BINDIR is labelled $ctx -- systemd may refuse to exec from it" ;;
  esac
fi

step "2. Assertions -- the units this hooks into must already exist"
# The whole point is to alarm on the backup. Wiring OnFailure= onto a unit that is not installed
# would report success while alerting nothing.
if systemctl list-unit-files fedbench-backup.service >/dev/null 2>&1 \
   && systemctl cat fedbench-backup.service >/dev/null 2>&1; then
  ok "fedbench-backup.service is installed"
else
  bad "fedbench-backup.service is not installed -- run backup-install.sh first"
fi

if [ "$CHECK" -eq 1 ]; then
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: alerting CHECK FAILED (%d failure(s), %d warn(s)); nothing was changed.\033[0m\n' "$fail" "$warns"
    exit 1
  fi
  printf '\n\033[32mVERDICT: alerting CHECK PASSED (%d warn(s)); nothing was changed.\033[0m\n' "$warns"
  exit 0
fi

[ "$fail" -eq 0 ] || {
  printf '\n\033[31mRefusing to install with %d failed assertion(s).\033[0m\n' "$fail"
  exit 1
}

step "3. Install the scripts"
for s in $SCRIPTS; do
  # cp, never mv: a moved file keeps its source SELinux context and systemd then refuses to load
  # or exec it. install(1) creates with the target directory's default context.
  if install -m 0755 -o root -g root "$UNITSRC/$s" "$BINDIR/$s"; then
    ok "installed $BINDIR/$s"
  else
    bad "could not install $BINDIR/$s"
  fi
done
restorecon -F "$BINDIR"/fedbench-*.sh "$BINDIR/restore-drill.sh" 2>/dev/null || true

step "4. State directory and the drill's success stamp"
install -d -m 0755 -o root -g root "$STATEDIR" && ok "$STATEDIR (root, 0755)"
# Pre-created and owned by postgres so the drill can rewrite it WITHOUT write permission on the
# directory: writing an existing file needs permission on the file, not on its parent. The alert
# marker beside it stays root-only, because it quotes journal output.
STAMP="$STATEDIR/last-drill-success"
if [ -e "$STAMP" ]; then
  ok "kept the existing drill stamp $STAMP"
else
  : >"$STAMP" && chown "$DRILL_USER:$DRILL_USER" "$STAMP" && chmod 0644 "$STAMP" \
    && ok "created $STAMP ($DRILL_USER, 0644)" || bad "could not create $STAMP"
fi

step "5. The Slack credential"
install -d -m 0750 -o root -g root "$CONFDIR"

# A bot token and an incoming webhook are both accepted; the token is preferred when both are
# given, because it can be scoped and revoked per app and the channel is not baked into the secret.
if [ -n "$TOKEN" ] || [ -n "$CHANNEL" ]; then
  case "$TOKEN" in
    xoxb-*|xoxp-*) : ;;
    "")  bad "--channel was given without --token" ;;
    *)   bad "that does not look like a Slack bot token (expected xoxb-... or xoxp-...)"; TOKEN="" ;;
  esac
  [ -n "$CHANNEL" ] || { bad "--token was given without --channel"; TOKEN=""; }
fi
if [ -n "$WEBHOOK" ]; then
  case "$WEBHOOK" in
    https://hooks.slack.com/*) : ;;
    *) bad "that does not look like a Slack webhook (expected https://hooks.slack.com/...)"; WEBHOOK="" ;;
  esac
fi

# Prefer the existing credential file over a pasted token. The testbench's own documentation is
# explicit about why: "never pass it as a CLI flag (it would land in shell history and `ps`)".
if [ -z "$TOKEN" ] && [ -z "$WEBHOOK" ] && [ -r "$CREDFILE" ]; then
  found_token=$(sed -n 's/^[[:space:]]*FED_SLACK_BOT_TOKEN=//p' "$CREDFILE" | tail -1)
  found_channel=$(sed -n 's/^[[:space:]]*FED_SLACK_CHANNEL=//p' "$CREDFILE" | tail -1)
  if [ -n "$found_token" ] && [ -n "$found_channel" ]; then
    USE_CREDFILE=1
    ok "found FED_SLACK_BOT_TOKEN and FED_SLACK_CHANNEL in $CREDFILE"
  else
    warn "$CREDFILE is readable but defines no FED_SLACK_BOT_TOKEN/FED_SLACK_CHANNEL"
  fi
fi

if [ "$USE_CREDFILE" = 1 ]; then
  # Store the REFERENCE, not the secret. One place to rotate; no second copy to go stale and fail
  # to deliver alerts nobody is watching for.
  umask 077
  printf '# Written by alerting-install.sh. Points at the testbench credentials rather than\n' >"$ENVFILE"
  printf '# copying them, so rotating the bot token is a one-file change.\n' >>"$ENVFILE"
  printf 'FEDBENCH_SLACK_CREDENTIAL_FILE=%s\n' "$CREDFILE" >>"$ENVFILE"
  printf 'FEDBENCH_REPO=%s\n' "$(dirname "$UNITSRC")" >>"$ENVFILE"
  umask 022
  chmod 0600 "$ENVFILE"; chown root:root "$ENVFILE"
  ok "wrote $ENVFILE (0600 root): references $CREDFILE"
  case "$found_channel" in
    C*|G*) ok "channel $found_channel is an ID, which survives a channel rename" ;;
    *)     warn "channel '$found_channel' is a name, not an ID -- renaming the channel breaks it" ;;
  esac
elif [ -n "$TOKEN" ] && [ -n "$CHANNEL" ]; then
  # A bearer credential: anyone holding it can post as this bot. 0600 root, and never echoed back
  # to the terminal or written to the journal.
  umask 077
  printf '# Written by alerting-install.sh. These are bearer credentials: keep this file 0600.\n' >"$ENVFILE"
  printf 'FEDBENCH_SLACK_TOKEN=%s\n' "$TOKEN" >>"$ENVFILE"
  printf 'FEDBENCH_SLACK_CHANNEL=%s\n' "$CHANNEL" >>"$ENVFILE"
  printf 'FEDBENCH_REPO=%s\n' "$(dirname "$UNITSRC")" >>"$ENVFILE"
  umask 022
  chmod 0600 "$ENVFILE"; chown root:root "$ENVFILE"
  # The token itself is never printed. Its shape is, so a paste that lost characters is visible.
  ok "wrote $ENVFILE (0600 root): bot token ${#TOKEN} chars, channel $CHANNEL"
elif [ -n "$WEBHOOK" ]; then
  umask 077
  printf '# Written by alerting-install.sh. A Slack webhook is a bearer credential: keep this 0600.\n' >"$ENVFILE"
  printf 'FEDBENCH_SLACK_WEBHOOK=%s\n' "$WEBHOOK" >>"$ENVFILE"
  printf 'FEDBENCH_REPO=%s\n' "$(dirname "$UNITSRC")" >>"$ENVFILE"
  umask 022
  chmod 0600 "$ENVFILE"; chown root:root "$ENVFILE"
  ok "wrote $ENVFILE (0600 root): incoming webhook"
elif [ -r "$ENVFILE" ] && grep -qE '^FEDBENCH_SLACK_(TOKEN|WEBHOOK|CREDENTIAL_FILE)=.+' "$ENVFILE"; then
  # NEVER rewrite a credential this run did not receive. An installer that silently replaced a
  # working token with a placeholder would disable alerting while reporting success.
  ok "kept the existing Slack credential in $ENVFILE"
else
  warn "no Slack credential configured -- alerts will be marked undelivered until you pass --token/--channel or --webhook"
fi

step "6. Install the units and wire OnFailure= onto the backup"
for u in $UNITS; do
  install -m 0644 -o root -g root "$UNITSRC/$u" "$UNITDIR/$u" && ok "installed $UNITDIR/$u" \
    || bad "could not install $UNITDIR/$u"
done
# A drop-in, not an edit: backup-install.sh owns fedbench-backup.service and would overwrite an
# in-place change on its next run, silently removing the alerting again.
DROPIN="$UNITDIR/fedbench-backup.service.d"
install -d -m 0755 "$DROPIN"
{
  printf '# Added by alerting-install.sh. Without this the backup fails exactly as it did for three\n'
  printf '# nights: correctly, in a journal nobody reads at 02:20.\n'
  printf '[Unit]\n'
  printf 'OnFailure=fedbench-alert@%%n.service\n'
} >"$DROPIN/onfailure.conf"
chmod 0644 "$DROPIN/onfailure.conf"
ok "wrote $DROPIN/onfailure.conf"

systemctl daemon-reload && ok "daemon-reload" || bad "daemon-reload failed"

step "7. Enable the TIMERS -- never the services"
# Enabling a completed oneshot runs it at every boot. The timers carry [Install]; the services
# deliberately do not.
for t in fedbench-restore-drill.timer fedbench-deadman.timer; do
  systemctl enable --now "$t" >/dev/null 2>&1 && ok "enabled and started $t" || bad "could not enable $t"
done

step "8. Assertions -- prove the wiring landed, do not assume it"
# `systemctl show` reads the MERGED configuration, so this proves the drop-in is in effect rather
# than proving a file exists on disk. A check that only stats the file passes while the unit
# ignores it.
merged=$(systemctl show -p OnFailure --value fedbench-backup.service 2>/dev/null)
case "$merged" in
  *fedbench-alert@*) ok "fedbench-backup.service OnFailure -> $merged" ;;
  *)                 bad "fedbench-backup.service has OnFailure='$merged' -- the drop-in is not in effect" ;;
esac

for t in fedbench-restore-drill.timer fedbench-deadman.timer; do
  e=$(systemctl is-enabled "$t" 2>/dev/null); a=$(systemctl is-active "$t" 2>/dev/null)
  if [ "$e" = enabled ] && [ "$a" = active ]; then
    ok "$t is enabled and active; next run $(systemctl show -p NextElapseUSecRealtime --value "$t" 2>/dev/null)"
  else
    bad "$t is enabled=$e active=$a"
  fi
done

# The services must NOT be enabled, or a reboot runs a restore drill and a liveness check on the
# way up, before the database is necessarily ready.
for s in fedbench-restore-drill.service fedbench-deadman.service fedbench-alert@.service; do
  e=$(systemctl is-enabled "$s" 2>/dev/null)
  case "$e" in
    enabled) bad "$s is enabled -- it must be triggered, not enabled" ;;
    *)       ok "$s is not enabled ($e)" ;;
  esac
done

# Exercise the notifier without posting: proves python3 builds the payload and the script runs as
# installed. The one thing it cannot prove is that the webhook is accepted -- use --test-alert.
if FEDBENCH_ALERT_DRY_RUN=1 "$BINDIR/fedbench-notify-failure.sh" fedbench-backup.service >/dev/null 2>&1; then
  ok "notifier builds a payload and runs (dry run, nothing sent)"
else
  bad "the notifier failed its dry run -- alerts would not be delivered"
fi

# The liveness check should run clean or report real findings; either is a working script. Only a
# crash is a failure of the check itself.
"$BINDIR/fedbench-deadman.sh" >/dev/null 2>&1
dm=$?
case "$dm" in
  0) ok "liveness check runs and reports no findings" ;;
  1) warn "liveness check runs and REPORTS FINDINGS -- run $BINDIR/fedbench-deadman.sh to read them" ;;
  *) bad "liveness check exited $dm -- it is broken, not merely reporting" ;;
esac

if [ "$TEST_ALERT" -eq 1 ]; then
  step "9. Test alert -- this POSTS to the Slack channel"
  if FEDBENCH_ALERT_TEST=1 "$BINDIR/fedbench-notify-failure.sh" fedbench-backup.service; then
    ok "test alert delivered -- confirm it is visible in the channel"
  else
    bad "test alert was NOT delivered; see the message above and $STATEDIR/alert-delivery-failed"
  fi
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: alerting install FAILED (%d failure(s), %d warn(s)).\033[0m\n' "$fail" "$warns"
  exit 1
fi
printf '\n\033[32mVERDICT: alerting installed (%d warn(s)).\033[0m\n' "$warns"
printf 'Verify the path end to end with: sudo bash %s --test-alert\n' "$0"
printf 'A bot token must also be INVITED to the channel: /invite @your-bot in %s\n' "${CHANNEL:-the target channel}"
