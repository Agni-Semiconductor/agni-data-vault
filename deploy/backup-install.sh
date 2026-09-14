#!/usr/bin/env bash
# Install the nightly local fedbench dump timer.
#
#   sudo bash backup-install.sh --check     # assertions only. Changes NOTHING. Run this first.
#   sudo bash backup-install.sh
#
# This installs only systemd's copies of the backup units. The dump script stays in the fedbackup
# checkout named by the service unit; copying it elsewhere would make a later edit look deployed
# while the timer still runs the old script.
set -uo pipefail

UNITSRC=${UNITSRC:-/home/agnidata/work/deploy}
BACKUP_SCRIPT=$UNITSRC/backup-fedbench.sh
SERVICE=$UNITSRC/fedbench-backup.service
TIMER=$UNITSRC/fedbench-backup.timer
CERT_TIMER=$UNITSRC/tailscale-cert.timer
BACKUPDIR=/srv/fedbench/backups
DB=fedbench
PSQL=/usr/pgsql-17/bin/psql
PG_DUMP=/usr/pgsql-17/bin/pg_dump
SPACE_MULTIPLE=3
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "0. Assertions"
# ══════════════════════════════════════════════════════════════════════════════════════════
# A missing staged file is otherwise discovered only after daemon-reload has accepted no useful
# unit, which reads as a systemd problem rather than an incomplete checkout.
for f in "$BACKUP_SCRIPT" "$SERVICE" "$TIMER"; do
  [ -r "$f" ] && ok "staged and readable: $f" || bad "missing or unreadable: $f -- stage it before installing"
done

# Do not use PATH: on this host bare pg_dump can select Siemens Calibre's client, producing an
# archive failure that looks like a PostgreSQL compatibility problem rather than the wrong binary.
[ -x "$PG_DUMP" ] && ok "pg_dump present: $PG_DUMP" \
  || bad "pg_dump is not executable at $PG_DUMP -- refusing to use PATH"

SERVICE_USER=$(awk -F= '$1 == "User" { print $2; exit }' "$SERVICE" 2>/dev/null)
if [ -n "$SERVICE_USER" ] && getent passwd "$SERVICE_USER" >/dev/null; then
  ok "service user exists: $SERVICE_USER"
else
  bad "service User='${SERVICE_USER:-missing}' does not exist -- timer runs would fail as systemd user setup, not as a dump error"
fi

# CAN THAT USER ACTUALLY READ THE DATABASE? The check above -- that the OS account exists -- was
# necessary and nowhere near sufficient, and the gap cost three nights of failed backups plus a
# manual run that also failed.
#
# fedbackup owns the archive tree and every bench service, so it LOOKED like the backup user. Inside
# Postgres it has nothing: no memberships, no SELECT on any table, no BYPASSRLS. `pg_dump` as that
# role fails with "permission denied for schema vault".
#
# This reproduces what pg_dump does rather than approximating it: `row_security = off`, then read a
# seeded table. Two failures are covered at once. A role without SELECT is denied outright; a role
# WITH select but without BYPASSRLS gets "query would be affected by row-level security policy",
# because every vault table has RLS enabled with no policies. Either way the dump fails -- loudly,
# which is the one mercy, but a failed backup all the same.
if [ -n "$SERVICE_USER" ] && [ -x "$PSQL" ]; then
  probe=$(runuser -u "$SERVICE_USER" -- "$PSQL" -tAX -d "$DB" \
    -c 'set row_security = off; select count(*) from vault.field_definitions;' 2>&1 | tail -1)
  case "$probe" in
    ''|*[!0-9]*)
      bad "$SERVICE_USER cannot read $DB the way pg_dump will: $probe"
      bad "  a backup that cannot read the database is not a backup, and the timer reports 203/EXEC or an exit code, never an empty file" ;;
    0)
      bad "$SERVICE_USER reads vault.field_definitions as 0 rows -- it is seeded and never legitimately empty, so this is a privilege failure wearing an empty-database costume" ;;
    *)
      ok "$SERVICE_USER can read $DB with row_security off ($probe rows in vault.field_definitions)" ;;
  esac
fi

# The timer offsets prevent two disk-heavy jobs sharing a boundary. Read both committed schedules:
# changing one timer without this assertion otherwise looks like an intermittent database failure.
BACKUP_CALENDAR=$(awk -F= '$1 == "OnCalendar" { print $2; exit }' "$TIMER" 2>/dev/null)
CERT_CALENDAR=$(awk -F= '$1 == "OnCalendar" { print $2; exit }' "$CERT_TIMER" 2>/dev/null)
if [ -n "$BACKUP_CALENDAR" ] && [ "$CERT_CALENDAR" = "*-*-* 04:40:00" ] && [ "$BACKUP_CALENDAR" != "$CERT_CALENDAR" ]; then
  ok "backup OnCalendar '$BACKUP_CALENDAR' does not collide with tailscale-cert.timer at 04:40"
else
  bad "backup OnCalendar '${BACKUP_CALENDAR:-missing}' collides with, or cannot be distinguished from, tailscale-cert.timer at 04:40"
fi

# The dump produces two formats and temporary files before publishing. Requiring three times the
# current database size free leaves room for that work instead of filling the filesystem shared
# with PostgreSQL, whose misleading symptom is the live database going down rather than a backup.
if [ -x "$PSQL" ]; then
  db_bytes=$(runuser -u postgres -- "$PSQL" -Atqc "SELECT pg_database_size('$DB')" 2>/dev/null)
else
  db_bytes=""
fi
# The directory is created in step 1, so ask df about the nearest existing parent. That is the
# filesystem the target will occupy; asking df about a missing target falsely reads as no space.
space_path=$BACKUPDIR
while [ ! -e "$space_path" ]; do
  case "$space_path" in
    /) break ;;
    */*)
      space_path=${space_path%/*}
      [ -n "$space_path" ] || space_path=/
      ;;
    *) break ;;
  esac
done
avail_kib=$(df -Pk "$space_path" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$db_bytes:$avail_kib" in
  *[!0-9:]*|:*)
    bad "could not measure current $DB size or free space on $BACKUPDIR -- refusing a backup that could fill its filesystem"
    ;;
  *)
    required_kib=$(( (db_bytes + 1023) / 1024 * SPACE_MULTIPLE ))
    printf '  free  %s KiB on %s (for %s); current %s database is %s bytes; require %sx = %s KiB\n' \
      "$avail_kib" "$space_path" "$BACKUPDIR" "$DB" "$db_bytes" "$SPACE_MULTIPLE" "$required_kib"
    if [ "$avail_kib" -ge "$required_kib" ]; then
      ok "filesystem has at least ${SPACE_MULTIPLE}x the current database size free"
    else
      bad "filesystem has less than ${SPACE_MULTIPLE}x the current database size free -- a full disk takes PostgreSQL down"
    fi
    ;;
esac

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31m%d assertion(s) failed. Nothing was changed.\033[0m\n' "$fail"
  exit 1
fi
[ "$CHECK_ONLY" = 1 ] && { printf '\n\033[32mAll assertions pass. Re-run without --check to install.\033[0m\n'; exit 0; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "1. Backup directory"
# ══════════════════════════════════════════════════════════════════════════════════════════
# Root creates this once for the timer account. Leaving it root-owned makes nightly runs fail in
# pg_dump's output phase, which reads as a database permission problem rather than a directory bug.
if install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUPDIR"; then
  ok "created $BACKUPDIR ($SERVICE_USER:$SERVICE_USER 0700)"
else
  bad "could not create $BACKUPDIR for $SERVICE_USER"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "2. Systemd units"
# ══════════════════════════════════════════════════════════════════════════════════════════
# `cp`, never `mv`: a moved file keeps its source SELinux context and systemd refuses it, reporting
# a problem with the unit rather than with the label.
cp -f "$SERVICE" "$TIMER" /etc/systemd/system/ && ok "installed fedbench-backup.service and fedbench-backup.timer" \
  || bad "could not copy fedbench backup units into /etc/systemd/system"
restorecon /etc/systemd/system/fedbench-backup.service /etc/systemd/system/fedbench-backup.timer 2>/dev/null || true
systemctl daemon-reload && ok "systemd daemon reloaded" || bad "systemctl daemon-reload failed"

# Enable ONLY THE TIMER. The service is Type=oneshot with no [Install] deliberately; enabling it
# would run a backup on every boot, which looks like a harmless restart until it fills the disk.
systemctl enable --now fedbench-backup.timer >/dev/null 2>&1
systemctl is-enabled --quiet fedbench-backup.timer && ok "fedbench-backup.timer enabled" \
  || bad "fedbench-backup.timer is not enabled -- nightly dumps will never run"

# ══════════════════════════════════════════════════════════════════════════════════════════
step "3. Verify the timer can actually make a backup"
# ══════════════════════════════════════════════════════════════════════════════════════════
# WHAT HAPPENED ON THE PREVIOUS RUNS, surfaced rather than left in the journal.
#
# This unit failed three nights running with status=203/EXEC -- systemd could not exec the script,
# because the shipped unit pointed into a service account's home. Nothing noticed. A timer is a
# promise that something happens while nobody is watching, so the one moment anybody IS watching is
# a re-run of this installer, and that is where a history of failure belongs.
#
# 203/EXEC specifically means "could not execute", not "the script returned an error". It is worth
# naming because the two have completely different causes and the journal line looks similar.
if systemctl is-failed --quiet fedbench-backup.service; then
  warn "fedbench-backup.service is in a FAILED state from a previous run:"
  systemctl status fedbench-backup.service --no-pager 2>/dev/null | sed -n '3,5p' | sed 's/^/      /'
  warn "  a fixed unit does not clear this; the next successful run does, or: systemctl reset-failed fedbench-backup.service"
else
  last=$(systemctl show fedbench-backup.service -p ExecMainStatus --value 2>/dev/null)
  [ "${last:-0}" = 0 ] && ok "no failed state recorded for fedbench-backup.service"     || warn "last run exited $last"
fi

# INSTALL THE SCRIPT WHERE THE UNIT CAN EXEC IT, and exercise THAT copy.
#
# The staging directory lives under /home/agnidata, which is 0700, so the service user cannot even
# traverse it -- runuser fails with "Permission denied" naming the script, which reads as a mode
# problem on the file rather than on a directory three levels up. And the unit must not point into
# the checkout either: that is inside fedbackup's HOME, so SELinux labels it user_home_t and
# systemd may not exec it at all. /usr/local/bin is already bin_t and world-traversable.
#
# Verifying the STAGED copy rather than the INSTALLED one would also be a lie: it proves a file the
# timer will never run is executable.
install -m 0755 -o root -g root "$BACKUP_SCRIPT" /usr/local/bin/backup-fedbench.sh   && ok "installed /usr/local/bin/backup-fedbench.sh (bin_t, executable by the service user)"
restorecon /usr/local/bin/backup-fedbench.sh 2>/dev/null || true

unit_exec=$(grep -vE '^[[:space:]]*(#|;|$)' /etc/systemd/system/fedbench-backup.service | grep -m1 '^ExecStart=' | cut -d= -f2- | awk '{print $1}')
case "$unit_exec" in
  /usr/local/bin/*|/usr/bin/*|/bin/*) ok "unit execs $unit_exec (a bin_t path)" ;;
  *) bad "unit execs $unit_exec -- not a path systemd can be relied on to exec; see the comment above" ;;
esac

# An enabled timer whose script fails is the exact shape of a backup everyone believes in and
# nobody has. Exercise the INSTALLED script as the unit's user; --dry-run writes nothing.
if runuser -u "$SERVICE_USER" -- /usr/local/bin/backup-fedbench.sh --dry-run; then
  ok "backup script --dry-run succeeded as $SERVICE_USER"
else
  bad "backup script --dry-run failed as $SERVICE_USER -- an enabled timer would produce no backup"
fi

# The next elapse is kernel-visible evidence that systemd accepted the schedule, not merely that
# the unit file was copied. Without it, a syntax or enablement error reads as a quiet missed night.
systemctl list-timers --all fedbench-backup.timer --no-pager

printf '\nAn enabled timer whose script fails is the exact shape of a backup everyone believes in and nobody has.\n'
printf 'Local dumps on the database host are NOT a second physical copy and do not clear the cutover gate.\n'
printf 'Changed: installed fedbench-backup.service and fedbench-backup.timer, and enabled only the timer.\n'
printf 'Deliberately did not change backup-fedbench.sh or enable fedbench-backup.service: the script is its own contract, and enabling the oneshot service runs it at every boot.\n'

printf '\n\033[1mTo undo:\033[0m\n'
cat <<UNDO
  systemctl disable --now fedbench-backup.timer
  rm -f /etc/systemd/system/fedbench-backup.{service,timer}
  rm -f /usr/local/bin/backup-fedbench.sh
  systemctl daemon-reload
  # $BACKUPDIR is left deliberately: deleting it discards local recovery points.
UNDO
[ "$fail" -gt 0 ] && exit 1 || exit 0
