#!/usr/bin/env bash
set -uo pipefail
# Install the scheduled off-host copy of the fedbench backup.
#
#   sudo bash deploy/offhost-install.sh --dest /mnt/offhost/fedbench
#   sudo bash deploy/offhost-install.sh --dest /mnt/offhost/fedbench --keep 30
#   sudo bash deploy/offhost-install.sh --check
#   sudo bash deploy/offhost-install.sh --check --dest /mnt/offhost/fedbench
#
# Undo: systemctl disable --now fedbench-offhost.timer, remove
# /etc/systemd/system/fedbench-offhost.{service,timer}, /usr/local/bin/backup-offhost.sh, and
# /etc/fedbench/offhost.env, then run systemctl daemon-reload. This leaves copied recovery points
# at the off-host destination deliberately: deleting them would discard the backup this installed.

# The checkout, NOT a hand-copied tree. A copied source hides drift while the installed system keeps
# running an older script, which reads as a successful deployment with a stale recovery procedure.
UNITSRC=${UNITSRC:-/srv/agni-data-vault/deploy}
BINDIR=/usr/local/bin
UNITDIR=/etc/systemd/system
CONFDIR=/etc/fedbench
ENVFILE="$CONFDIR/offhost.env"
SERVICE_USER=postgres

CHECK=0
DEST=""
DEST_GIVEN=0
KEEP=""
KEEP_GIVEN=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  sed -n '3,12p' "$0"
  printf '\nUsage: sudo bash %s [--dest PATH] [--keep N] [--check]\n' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)
      [ $# -ge 2 ] || { echo "--dest needs a path" >&2; exit 2; }
      DEST=$2; DEST_GIVEN=1; shift 2 ;;
    --keep)
      [ $# -ge 2 ] || { echo "--keep needs a number" >&2; exit 2; }
      KEEP=$2; KEEP_GIVEN=1; shift 2 ;;
    --check) CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) [ "$KEEP_GIVEN" -eq 0 ] || { echo "--keep must be a positive whole number" >&2; exit 2; } ;;
  *) [ "$KEEP" -gt 0 ] || { echo "--keep must be at least 1" >&2; exit 2; } ;;
esac

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }

# Read values rather than sourcing an environment file during installation. It is configuration, not
# executable code; executing a malformed pathname setting as root would turn a backup setup into a
# privilege incident. The existing destination is preserved byte-for-byte unless --dest replaces it.
configured_dest=""
configured_keep=""
if [ -r "$ENVFILE" ]; then
  configured_dest=$(sed -n 's/^FEDBENCH_OFFHOST_DEST=//p' "$ENVFILE" | tail -1)
  configured_keep=$(sed -n 's/^FEDBENCH_OFFHOST_KEEP=//p' "$ENVFILE" | tail -1)
fi
if [ "$DEST_GIVEN" -eq 0 ]; then
  DEST=$configured_dest
fi
if [ "$KEEP_GIVEN" -eq 0 ]; then
  KEEP=$configured_keep
fi

case "$DEST" in
  '') echo "--dest is required unless $ENVFILE already defines FEDBENCH_OFFHOST_DEST" >&2; exit 2 ;;
esac
case "$KEEP" in
  ''|*[!0-9]*) [ -z "$KEEP" ] || { echo "$ENVFILE has an invalid FEDBENCH_OFFHOST_KEEP" >&2; exit 2; } ;;
  *) [ "$KEEP" -gt 0 ] || { echo "$ENVFILE has an invalid FEDBENCH_OFFHOST_KEEP" >&2; exit 2; } ;;
esac

SCRIPT=backup-offhost.sh
SERVICE=fedbench-offhost.service
TIMER=fedbench-offhost.timer

step "1. Assertions -- the sources, tools, and account this runs as"
for f in "$SCRIPT" "$SERVICE" "$TIMER"; do
  if [ -r "$UNITSRC/$f" ]; then ok "found $UNITSRC/$f"; else bad "missing $UNITSRC/$f"; fi
done
for tool in install runuser systemctl; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool is present" || bad "$tool is required and not on PATH"
done
id "$SERVICE_USER" >/dev/null 2>&1 && ok "$SERVICE_USER exists" || bad "$SERVICE_USER does not exist"

# The systemd service must execute the installed bin_t copy. A repo checkout can be user_home_t on
# SELinux, making systemd return 203/EXEC and name the script as though it were missing.
if [ -d "$BINDIR" ]; then
  ctx=$(ls -Zd "$BINDIR" 2>/dev/null | awk '{print $1}')
  case "$ctx" in
    *:bin_t:*|"") ok "$BINDIR is labelled for systemd to exec from (${ctx:-no SELinux})" ;;
    *)            warn "$BINDIR is labelled $ctx -- systemd may refuse to exec from it" ;;
  esac
fi

step "2. Assertions -- the off-host destination is usable by postgres"
# Root can write through permissions that the timer user cannot. The previous root rehearsal passed
# while postgres could not traverse a parent directory, so the live timer failed in 5ms at 02:00.
# Rehearse the script we are ABOUT TO INSTALL, from the checkout. The first version ran
# $BINDIR/$SCRIPT here -- before step 3 installs it -- so on a clean host the assertion failed,
# the installer refused with "Refusing to install with 1 failed assertion(s)", and it could never
# complete its own first run. The post-install rehearsal at the end covers the installed copy.
if [ -r "$UNITSRC/$SCRIPT" ]; then
  if runuser -u "$SERVICE_USER" -- bash "$UNITSRC/$SCRIPT" --check --dest "$DEST"; then
    ok "$SCRIPT --check can write and remove a probe at $DEST as $SERVICE_USER"
  else
    bad "$SCRIPT --check failed as $SERVICE_USER -- the timer cannot make an off-host copy"
  fi
else
  bad "$UNITSRC/$SCRIPT is not readable; cannot rehearse the copy before installing it"
fi

if [ "$CHECK" -eq 1 ]; then
  step "3. Assertions -- prove the installed systemd wiring is live"
  # `systemctl show` reads the MERGED configuration. Checking a unit file on disk passed before
  # while systemd ignored its OnFailure= and failures again landed only in an unread journal.
  merged=$(systemctl show -p OnFailure --value "$SERVICE" 2>/dev/null)
  case "$merged" in
    *fedbench-alert@*) ok "$SERVICE OnFailure -> $merged" ;;
    *) bad "$SERVICE has OnFailure='$merged' -- the alerter is not in effect" ;;
  esac
  enabled=$(systemctl is-enabled "$TIMER" 2>/dev/null)
  active=$(systemctl is-active "$TIMER" 2>/dev/null)
  if [ "$enabled" = enabled ] && [ "$active" = active ]; then
    ok "$TIMER is enabled and active; next run $(systemctl show -p NextElapseUSecRealtime --value "$TIMER" 2>/dev/null)"
  else
    bad "$TIMER is enabled=$enabled active=$active"
  fi
  service_enabled=$(systemctl is-enabled "$SERVICE" 2>/dev/null)
  case "$service_enabled" in
    enabled) bad "$SERVICE is enabled -- a completed oneshot must be triggered only by its timer" ;;
    *)       ok "$SERVICE is not enabled ($service_enabled)" ;;
  esac
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: off-host CHECK FAILED (%d failure(s), %d warn(s)); nothing was changed.\033[0m\n' "$fail" "$warns"
    exit 1
  fi
  printf '\n\033[32mVERDICT: off-host CHECK PASSED (%d warn(s)); nothing was changed.\033[0m\n' "$warns"
  exit 0
fi

[ "$fail" -eq 0 ] || { printf '\n\033[31mRefusing to install with %d failed assertion(s).\033[0m\n' "$fail"; exit 1; }

step "3. Install the script and configuration"
# install(1), never mv: a moved checkout file retains user_home_t and systemd refuses it as 203/EXEC.
install -m 0755 -o root -g root "$UNITSRC/$SCRIPT" "$BINDIR/$SCRIPT" \
  && ok "installed $BINDIR/$SCRIPT (root, 0755)" || bad "could not install $BINDIR/$SCRIPT"
restorecon -F "$BINDIR/$SCRIPT" 2>/dev/null || true
install -d -m 0755 -o root -g root "$CONFDIR" && ok "created $CONFDIR (root, 0755)" \
  || bad "could not create $CONFDIR"
if [ "$DEST_GIVEN" -eq 1 ] || [ ! -r "$ENVFILE" ] || [ "$KEEP_GIVEN" -eq 1 ]; then
  # Unlike alert.env, this contains no bearer credential: a destination pathname is safe at 0644.
  # Preserve an existing destination when only --keep was supplied; replacing it silently once
  # shipped a working setting with a new path while the installer reported success.
  {
    printf '# Written by offhost-install.sh. A destination path is not a secret, so this is 0644.\n'
    printf '# Unlike /etc/fedbench/alert.env, it contains no bearer credentials and is not 0600.\n'
    printf 'FEDBENCH_OFFHOST_DEST=%s\n' "$DEST"
    [ -n "$KEEP" ] && printf 'FEDBENCH_OFFHOST_KEEP=%s\n' "$KEEP"
  } >"$ENVFILE" && chmod 0644 "$ENVFILE" && chown root:root "$ENVFILE" \
    && ok "wrote $ENVFILE (0644 root): destination $DEST" || bad "could not write $ENVFILE"
else
  ok "kept existing destination in $ENVFILE"
fi

step "4. Install the units and enable the TIMER only"
for u in "$SERVICE" "$TIMER"; do
  # install, never mv: a moved unit can retain the checkout SELinux label and systemd then ignores it.
  install -m 0644 -o root -g root "$UNITSRC/$u" "$UNITDIR/$u" && ok "installed $UNITDIR/$u" \
    || bad "could not install $UNITDIR/$u"
done
restorecon -F "$UNITDIR/$SERVICE" "$UNITDIR/$TIMER" 2>/dev/null || true
systemctl daemon-reload && ok "daemon-reload" || bad "daemon-reload failed"
# Enabling a completed oneshot runs it at every boot. The timer has [Install]; the service must not.
systemctl enable --now "$TIMER" >/dev/null 2>&1 && ok "enabled and started $TIMER" \
  || bad "could not enable $TIMER"

step "5. Assertions -- prove the installed system works, not merely that files exist"
merged=$(systemctl show -p OnFailure --value "$SERVICE" 2>/dev/null)
# The RESOLVED name, not the specifier. `systemctl show` reports merged configuration with %n
# already expanded -- on this host the backup unit reads back as
# `fedbench-alert@fedbench-backup.service.service` -- so matching the literal `%n` can never
# succeed and this assertion failed against correct wiring.
case "$merged" in
  *fedbench-alert@*) ok "$SERVICE OnFailure -> $merged" ;;
  *) bad "$SERVICE has OnFailure='$merged' -- the alerter is not in effect" ;;
esac
enabled=$(systemctl is-enabled "$TIMER" 2>/dev/null)
active=$(systemctl is-active "$TIMER" 2>/dev/null)
if [ "$enabled" = enabled ] && [ "$active" = active ]; then
  ok "$TIMER is enabled and active; next run $(systemctl show -p NextElapseUSecRealtime --value "$TIMER" 2>/dev/null)"
else
  bad "$TIMER is enabled=$enabled active=$active"
fi
service_enabled=$(systemctl is-enabled "$SERVICE" 2>/dev/null)
case "$service_enabled" in
  enabled) bad "$SERVICE is enabled -- it must be triggered, not enabled" ;;
  *)       ok "$SERVICE is not enabled ($service_enabled)" ;;
esac
if runuser -u "$SERVICE_USER" -- "$BINDIR/$SCRIPT" --check --dest "$DEST"; then
  ok "$SCRIPT --check can write and remove a probe at $DEST as $SERVICE_USER"
else
  bad "$SCRIPT --check failed as $SERVICE_USER -- an enabled timer would not make an off-host copy"
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: off-host install FAILED (%d failure(s), %d warn(s)).\033[0m\n' "$fail" "$warns"
  exit 1
fi
printf '\n\033[32mVERDICT: off-host installed (%d warn(s)).\033[0m\n' "$warns"
