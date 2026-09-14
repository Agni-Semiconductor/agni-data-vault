#!/usr/bin/env bash
# Check that the things which are supposed to happen actually happened. Run daily by
# fedbench-deadman.timer.
#
#   bash deploy/fedbench-deadman.sh
#   bash deploy/fedbench-deadman.sh --quiet      # print only findings
#
# WHY A SECOND MECHANISM: OnFailure= reports a job that RAN and FAILED. It cannot report a job that
# never ran -- a disabled timer, a masked unit, a box that came back from a reboot with nothing
# enabled. Both have happened here. This script alarms on ABSENCE, which is the failure mode that
# hid the three silent nights.
#
# It prints findings and exits non-zero. fedbench-deadman.service names the alerter in its
# OnFailure=, so the findings printed here become the body of the Slack message -- no second copy
# of the webhook logic, and nothing to keep in step.
#
# Undo: reads only. Writes nothing, changes no database, backup, service, or configuration.
set -uo pipefail

BACKUPS=${FEDBENCH_BACKUPS:-/srv/fedbench/backups}
STATEDIR=${FEDBENCH_STATE_DIR:-/var/lib/fedbench}
ENVFILE=${FEDBENCH_ALERT_ENV:-/etc/fedbench/alert.env}
REPO=${FEDBENCH_REPO:-/srv/agni-data-vault}
# Thresholds. Each is the cadence plus a full grace period, so ordinary jitter and one missed run
# do not cry wolf -- an alarm that fires on healthy systems gets muted, and a muted alarm is worse
# than none because it looks like coverage.
DUMP_MAX_HOURS=${FEDBENCH_DUMP_MAX_HOURS:-36}
DRILL_MAX_DAYS=${FEDBENCH_DRILL_MAX_DAYS:-10}
# An absolute floor only catches a dump that is empty-empty. It CANNOT judge whether a dump is
# "big enough": this database is 10 MB of seeded vocabulary today and will be several GB once the
# bench data lands, so any constant is wrong on one side of that transition. This one shipped at
# 200000 and alarmed on the first healthy run, at 189723 bytes.
DUMP_MIN_BYTES=${FEDBENCH_DUMP_MIN_BYTES:-20000}
# The real signal is RELATIVE: a dump that collapses against its own predecessor. That is what an
# RLS regression, a dropped schema, or a stray --schema-only actually looks like, and it
# self-calibrates as the database grows.
DUMP_SHRINK_PCT=${FEDBENCH_DUMP_SHRINK_PCT:-50}

[ -r "$ENVFILE" ] && . "$ENVFILE"

findings=0
note() { printf 'FINDING: %s\n' "$*"; findings=$((findings + 1)); }
okline() { [ "${QUIET:-0}" = "1" ] || printf 'ok: %s\n' "$*"; }

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

now=$(date +%s)

# ── 1. Is there a recent dump at all? ─────────────────────────────────────────────────────────
# This is the question the three silent nights failed. The unit's exit status was wrong then; what
# was actually missing was a file.
newest=""
if [ -d "$BACKUPS" ]; then
  # mtime, not filename: a job that wrote yesterday's NAME today is still a stale recovery point,
  # and a filename sort would call it current.
  newest=$(find "$BACKUPS" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
           | sort -nr | awk 'NR == 1 { print $2 }')
fi
if [ -z "$newest" ]; then
  note "no *.dump exists under $BACKUPS -- there is no local backup at all"
else
  mtime=$(stat -c %Y "$newest" 2>/dev/null)
  case "$mtime" in
    ''|*[!0-9]*) note "cannot read the modification time of $newest" ;;
    *)
      age_h=$(( (now - mtime) / 3600 ))
      if [ "$age_h" -gt "$DUMP_MAX_HOURS" ]; then
        note "newest dump $newest is ${age_h}h old (limit ${DUMP_MAX_HOURS}h) -- the nightly backup has stopped"
      else
        okline "newest dump is ${age_h}h old"
      fi
      # A dump that exists but is tiny is the RLS failure mode: schema with no rows restores
      # cleanly and proves nothing. Two checks, because they answer different questions.
      size=$(stat -c %s "$newest" 2>/dev/null || echo 0)
      if [ "$size" -lt "$DUMP_MIN_BYTES" ]; then
        note "newest dump $newest is only ${size} bytes -- at or below empty"
      else
        okline "newest dump is ${size} bytes"
      fi
      # The one that actually catches a regression: compare against the PREVIOUS dump. A backup
      # that was fine yesterday and is a fraction of the size today is the shape of every silent
      # data-loss failure here -- and unlike a constant, this keeps working when the database
      # grows by three orders of magnitude.
      previous=$(find "$BACKUPS" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
                 | sort -nr | awk 'NR == 2 { print $2 }')
      if [ -z "$previous" ]; then
        okline "only one dump present; no predecessor to compare against yet"
      else
        psize=$(stat -c %s "$previous" 2>/dev/null || echo 0)
        if [ "$psize" -le 0 ]; then
          note "previous dump $previous has no readable size"
        else
          pct=$((size * 100 / psize))
          if [ "$pct" -lt "$DUMP_SHRINK_PCT" ]; then
            note "newest dump is ${pct}% of the previous one (${size} vs ${psize} bytes) -- a collapse this large is data loss until proven otherwise"
          else
            okline "newest dump is ${pct}% of the previous one"
          fi
        fi
      fi
      ;;
  esac
fi

# ── 2. Has the restore drill proved anything lately? ──────────────────────────────────────────
stamp="$STATEDIR/last-drill-success"
if [ ! -r "$stamp" ]; then
  note "no successful restore drill has ever been recorded ($stamp is missing)"
else
  last=$(cat "$stamp" 2>/dev/null)
  case "$last" in
    ''|*[!0-9]*) note "$stamp does not contain a timestamp" ;;
    *)
      age_d=$(( (now - last) / 86400 ))
      if [ "$age_d" -gt "$DRILL_MAX_DAYS" ]; then
        note "last successful restore drill was ${age_d}d ago (limit ${DRILL_MAX_DAYS}d) -- the backup is unproven again"
      else
        okline "last successful restore drill was ${age_d}d ago"
      fi
      ;;
  esac
fi

# ── 3. Did an alert fail to send? ─────────────────────────────────────────────────────────────
# Who watches the watcher. systemd discards an OnFailure handler's exit status, so a broken webhook
# would leave every future failure silent while every unit still looked wired up.
marker="$STATEDIR/alert-delivery-failed"
if [ -e "$marker" ]; then
  note "an earlier alert could not be delivered: $(tr '\n' ' ' <"$marker" 2>/dev/null)"
else
  okline "no undelivered alerts"
fi

# ── 4. Are the timers still armed? ────────────────────────────────────────────────────────────
# The check OnFailure= structurally cannot do. A disabled timer produces no failure, no journal
# line, and no output of any kind -- it simply stops, and everything downstream keeps looking fine.
# Two lists, because "not installed" means different things. A missing backup timer is a
# catastrophe; a missing off-host timer just means the destination has not been configured yet,
# and reporting that daily would be a false alarm on a healthy box -- which gets the alert muted,
# and a muted alert is worse than none because it still looks like coverage.
#
# The rule that applies to BOTH: a timer that IS installed must be armed. An installed-but-disabled
# timer is the silent failure this check exists for, whichever list it is in.
REQUIRED_TIMERS="fedbench-backup.timer fedbench-restore-drill.timer"
OPTIONAL_TIMERS="fedbench-healthz.timer fedbench-offhost.timer"
for timer in $REQUIRED_TIMERS $OPTIONAL_TIMERS; do
  if ! systemctl list-unit-files "$timer" >/dev/null 2>&1; then
    case " $REQUIRED_TIMERS " in
      *" $timer "*) note "$timer is not installed on this host" ;;
      *)            okline "$timer is not installed (optional; nothing is scheduled for it)" ;;
    esac
    continue
  fi
  enabled=$(systemctl is-enabled "$timer" 2>/dev/null)
  active=$(systemctl is-active "$timer" 2>/dev/null)
  if [ "$enabled" != "enabled" ] || [ "$active" != "active" ]; then
    note "$timer is enabled=$enabled active=$active -- it will not fire"
  else
    okline "$timer is enabled and active"
  fi
done

# ── 5. Does the box still run what the repository says? ───────────────────────────────────────
# The installed scripts are COPIES of the checkout, because systemd may not exec out of an
# arbitrarily labelled tree. Copies drift, and drift is invisible: for three nights the unit named
# a script that was not the script anyone was editing.
if [ -d "$REPO/deploy" ]; then
  for pair in "backup-fedbench.sh" "restore-drill.sh" "fedbench-notify-failure.sh" \
              "fedbench-deadman.sh" "fedbench-healthz.sh" "backup-offhost.sh"; do
    installed="/usr/local/bin/$pair"
    source_file="$REPO/deploy/$pair"
    if [ ! -e "$installed" ]; then
      # Not installed is only a problem if something actually tries to run it. Reporting every
      # uninstalled script would alarm daily about the off-host copier until the NAS destination
      # is configured -- a false alarm on a healthy box, which is how alerting gets muted.
      if grep -rlq "ExecStart=[^\n]*$pair" /etc/systemd/system 2>/dev/null; then
        note "$installed is missing but a unit's ExecStart names it -- that unit will fail 203/EXEC"
      else
        okline "$installed is not installed and no unit references it"
      fi
      continue
    fi
    [ -e "$source_file" ] || continue
    if ! cmp -s "$installed" "$source_file"; then
      note "$installed differs from $source_file -- the box is running something other than the checkout"
    else
      okline "$installed matches the checkout"
    fi
  done
else
  okline "no checkout at $REPO to compare against (set FEDBENCH_REPO to enable drift detection)"
fi

# ── Verdict ───────────────────────────────────────────────────────────────────────────────────
if [ "$findings" -gt 0 ]; then
  printf '\nfedbench-deadman: %d finding(s) on %s\n' "$findings" "$(hostname -s 2>/dev/null)"
  exit 1
fi
printf 'fedbench-deadman: all checks passed\n'
exit 0
