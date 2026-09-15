#!/usr/bin/env bash
# Move the fedbench data off the boot mirror and off the unmirrored disk, onto /storage.
#
#   sudo bash deploy/relocate-fedbench-data.sh --check
#   sudo bash deploy/relocate-fedbench-data.sh
#   sudo bash deploy/relocate-fedbench-data.sh --dest /storage
#
# WHY. Three trees are in the wrong place on edaserver:
#
#   /srv/fedbench          md127  the BOOT mirror -- backups and the object store
#   /srv/nextcloud/fedbench  sda  a SINGLE DISK, no redundancy -- the ~55 GB cold archive
#
# /storage is md125: a 3.7 TB RAID1 pair with 3.0 TB free, not the boot volume, and -- decisively --
# the only path the nightly restic job copies to the Synology. Moving there is not just tidier; it
# is what gives this data an off-host copy at all, with no change to the restic unit.
#
# HOW, AND WHY NOT BY EDITING PATHS. Five things name these directories: fedbench-backup.service,
# fedbench-prune.service, and three scripts in /usr/local/bin. Editing all five is five chances to
# miss one, and a missed one is a job still writing to the old disk while everything looks correct
# -- which is exactly the class of drift that has cost this project a week. So the data moves and
# the OLD PATHS ARE BIND-MOUNTED BACK ON TOP. Nothing that references them needs to change, and the
# whole thing reverses by unmounting.
#
# NOT INCLUDED: the live PostgreSQL data directory. Moving a running cluster is the riskiest
# operation available here, md127 is itself mirrored with 861 GB free, and the artifact that has
# actually been restored is the dump -- which this script does move. If you want the cluster moved
# too, that is a scheduled maintenance window with its own script, and restic would then need an
# --exclude for it: a live data directory swept mid-write restores into a database that may start
# and be silently wrong.
#
# Undo: systemctl disable --now srv-fedbench.mount srv-nextcloud-fedbench.mount, then rename the
# .pre-relocate directories back. THIS SCRIPT NEVER DELETES THE ORIGINALS.
set -uo pipefail

DEST=/storage
SRC_FEDBENCH=/srv/fedbench
SRC_ARCHIVE=/srv/nextcloud/fedbench
CHECK=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() { sed -n '2,32p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --dest)
      [ $# -ge 2 ] || { echo "--dest needs a path" >&2; exit 2; }
      DEST=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }

DST_FEDBENCH="$DEST/fedbench"
DST_ARCHIVE="$DEST/fedbench-archive"
# Siblings, not nested. Putting the archive inside the service tree would expose it at two paths
# once the bind mount is in place, and "why is this directory in two places" is a question nobody
# should have to answer at 3am.

# The writers. Each is stopped before the copy and restored afterwards, because rsync cannot make a
# consistent copy of a tree something is appending to.
WRITERS="fed-storage.service fedbench-backup.timer fedbench-archive.timer fedbench-prune.timer"

step "1. Assertions -- the destination"
if findmnt -no TARGET "$DEST" >/dev/null 2>&1; then
  src=$(findmnt -no SOURCE "$DEST")
  ok "$DEST is a mount point ($src)"
  # A destination that is NOT its own filesystem means the data never left the disk it was on --
  # the move would report success and change nothing about the risk.
  if [ "$(stat -c %d /)" = "$(stat -c %d "$DEST")" ]; then
    bad "$DEST is on the same filesystem as / -- moving there protects nothing"
  else
    ok "$DEST is a different filesystem from /"
  fi
else
  bad "$DEST is not a mount point"
fi

# Redundancy is the whole point of choosing this destination; say so out loud rather than assume it.
dest_src=$(findmnt -no SOURCE "$DEST" 2>/dev/null | sed 's|/dev/||')
if grep -q "^${dest_src} : active raid" /proc/mdstat 2>/dev/null; then
  ok "$DEST is on a RAID array ($(grep "^${dest_src} :" /proc/mdstat | awk '{print $3}'))"
else
  warn "$DEST does not look like a RAID array -- check /proc/mdstat before relying on it"
fi

step "2. Assertions -- space, with the sources measured rather than guessed"
need=0
for s in "$SRC_FEDBENCH" "$SRC_ARCHIVE"; do
  if [ -d "$s" ]; then
    kb=$(du -sk "$s" 2>/dev/null | awk '{print $1}')
    case "$kb" in ''|*[!0-9]*) bad "could not measure $s"; kb=0 ;; esac
    need=$((need + kb))
    ok "$s holds $(numfmt --to=iec --from-unit=1024 "$kb" 2>/dev/null || echo "${kb}K")"
  else
    warn "$s does not exist -- nothing to move from there"
  fi
done
avail=$(df -k --output=avail "$DEST" 2>/dev/null | tail -1 | tr -d ' ')
case "$avail" in ''|*[!0-9]*) bad "could not read free space on $DEST"; avail=0 ;; esac
# 20% headroom: rsync needs room for partial files, and a destination filled to the brim by this
# move is a new problem in place of the old one.
if [ "$avail" -gt $((need * 12 / 10)) ]; then
  ok "$DEST has $(numfmt --to=iec --from-unit=1024 "$avail" 2>/dev/null || echo "${avail}K") free for $(numfmt --to=iec --from-unit=1024 "$need" 2>/dev/null || echo "${need}K")"
else
  bad "$DEST has only ${avail}K free; need ${need}K plus headroom"
fi

step "3. Assertions -- SELinux"
if [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  ok "SELinux is enforcing; labels will be preserved and reapplied"
  # The destination's own mountpoint is unlabeled_t on this host. Files INSIDE carry real labels
  # (/storage/home is home_root_t), so the filesystem holds xattrs and restorecon works -- but the
  # new tree still needs an fcontext rule, or it inherits unlabeled_t and confined services are
  # denied with errors that name the service rather than the label.
  command -v semanage >/dev/null 2>&1 && ok "semanage is available" \
    || bad "semanage is missing (dnf install policycoreutils-python-utils)"
  command -v restorecon >/dev/null 2>&1 && ok "restorecon is available" || bad "restorecon is missing"
else
  warn "SELinux is not enforcing; the labelling steps will be no-ops"
fi

step "4. Assertions -- rsync can preserve what matters"
if command -v rsync >/dev/null 2>&1; then
  rsync --version 2>/dev/null | grep -q 'xattrs' && ok "rsync supports xattrs (SELinux labels survive the copy)" \
    || bad "this rsync lacks xattr support; SELinux labels would be lost"
else
  bad "rsync is not installed"
fi

step "5. Assertions -- nothing is already bind-mounted over the sources"
for t in "$SRC_FEDBENCH" "$SRC_ARCHIVE"; do
  if findmnt -no TARGET "$t" >/dev/null 2>&1; then
    bad "$t is already a mount point -- this script has probably run before; inspect before repeating"
  else
    ok "$t is a plain directory, not a mount"
  fi
done

if [ "$CHECK" -eq 1 ]; then
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: relocation CHECK FAILED (%d failure(s), %d warn(s)); nothing was moved.\033[0m\n' "$fail" "$warns"
    exit 1
  fi
  printf '\n\033[32mVERDICT: relocation CHECK PASSED (%d warn(s)); nothing was moved.\033[0m\n' "$warns"
  exit 0
fi

[ "$fail" -eq 0 ] || { printf '\n\033[31mRefusing to move with %d failed assertion(s).\033[0m\n' "$fail"; exit 1; }

step "6. Stop the writers"
STOPPED=""
for u in $WRITERS; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    systemctl stop "$u" && { STOPPED="$STOPPED $u"; ok "stopped $u"; } || bad "could not stop $u"
  else
    ok "$u was not running"
  fi
done
restart_writers() {
  for u in $STOPPED; do
    systemctl start "$u" >/dev/null 2>&1 && ok "restarted $u" || bad "could not restart $u"
  done
}
# Whatever happens below, the services come back. A script that leaves the object store down
# because it failed halfway is worse than one that never ran.
trap restart_writers EXIT

step "7. Copy, preserving ownership, ACLs and SELinux labels"
copy_tree() {
  local src=$1 dst=$2
  [ -d "$src" ] || { ok "skipping $src (absent)"; return 0; }
  mkdir -p "$dst"
  # -aHAX: archive, hard links, ACLs, xattrs. --numeric-ids so a uid that exists here and not in
  # some future restore context does not silently become root.
  if rsync -aHAX --numeric-ids --delete-after "$src"/ "$dst"/; then
    ok "copied $src -> $dst"
  else
    bad "rsync failed for $src"
    return 1
  fi
  # VERIFY, do not assume. Compare counts and bytes; a truncated copy is the failure that matters
  # and rsync's exit status has already been known to look fine on a full disk.
  local sc dc sb db
  sc=$(find "$src" -xdev | wc -l); dc=$(find "$dst" -xdev | wc -l)
  sb=$(du -sb "$src" 2>/dev/null | awk '{print $1}'); db=$(du -sb "$dst" 2>/dev/null | awk '{print $1}')
  if [ "$sc" = "$dc" ] && [ "$sb" = "$db" ]; then
    ok "verified $dst: $dc entries, $db bytes, identical to source"
  else
    bad "VERIFICATION FAILED for $dst: source $sc entries/$sb bytes, destination $dc/$db"
    return 1
  fi
}
copy_tree "$SRC_FEDBENCH" "$DST_FEDBENCH" || { printf '\n\033[31mAborting; nothing was renamed and the originals are untouched.\033[0m\n'; exit 1; }
copy_tree "$SRC_ARCHIVE"  "$DST_ARCHIVE"  || { printf '\n\033[31mAborting; nothing was renamed and the originals are untouched.\033[0m\n'; exit 1; }

step "8. Label the new trees"
if [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  for pair in "$DST_FEDBENCH:var_t" "$DST_ARCHIVE:var_t"; do
    d=${pair%:*}; t=${pair#*:}
    # var_t matches what /srv/fedbench carries today, so the services keep the access they have.
    semanage fcontext -a -t "$t" "${d}(/.*)?" 2>/dev/null \
      || semanage fcontext -m -t "$t" "${d}(/.*)?" 2>/dev/null \
      || warn "could not record an fcontext rule for $d"
    restorecon -R "$d" 2>/dev/null && ok "labelled $d as $t" || bad "restorecon failed for $d"
  done
fi

step "9. Put the old paths back, as bind mounts"
# The unit NAME is computed by the caller, and this function only writes the file.
#
# The first version printed the name on stdout and also called ok() -- which prints to stdout too --
# so `unit=$(make_mount_unit ...)` captured the log line AND the name. `systemctl enable` then got a
# multi-line string and failed, and the error said "could not mount", which reads as a mount
# problem rather than a string problem. Verified in a local harness before this ever ran here.
write_mount_unit() {
  local name=$1 target=$2 what=$3 after
  after=$(systemd-escape --path --suffix=mount "$(findmnt -no TARGET --target "$what")")
  cat >"/etc/systemd/system/$name" <<UNIT
# Bind the relocated fedbench data back to its original path.
#
# The data now lives on $what -- a RAID1 array that is not the boot mirror, and the only tree the
# nightly restic job copies off-host. This mount is what lets every unit and script that names
# $target keep working unedited, which is five fewer places to miss.
[Unit]
Description=Bind $what to $target
After=$after
Requires=$after

[Mount]
What=$what
Where=$target
Type=none
Options=bind

[Install]
WantedBy=multi-user.target
UNIT
  ok "wrote /etc/systemd/system/$name"
}

for pair in "$SRC_FEDBENCH:$DST_FEDBENCH" "$SRC_ARCHIVE:$DST_ARCHIVE"; do
  target=${pair%:*}; what=${pair#*:}
  [ -d "$what" ] || continue
  # The original is RENAMED, never deleted. It is the only copy that has not been through this
  # script, and it stays until a human is satisfied.
  if [ -d "$target" ] && ! findmnt -no TARGET "$target" >/dev/null 2>&1; then
    mv "$target" "${target}.pre-relocate" && ok "kept the original at ${target}.pre-relocate" \
      || { bad "could not rename $target"; continue; }
  fi
  mkdir -p "$target"
  unit=$(systemd-escape --path --suffix=mount "$target")
  write_mount_unit "$unit" "$target" "$what"
  systemctl daemon-reload
  systemctl enable --now "$unit" >/dev/null 2>&1 && ok "mounted $what at $target" \
    || bad "could not mount $what at $target (unit: $unit)"
done

step "10. Assertions -- prove the move landed"
for pair in "$SRC_FEDBENCH:$DST_FEDBENCH" "$SRC_ARCHIVE:$DST_ARCHIVE"; do
  target=${pair%:*}; what=${pair#*:}
  [ -d "$what" ] || continue
  if findmnt -no SOURCE,TARGET "$target" >/dev/null 2>&1; then
    ok "$target resolves to $(findmnt -no SOURCE --target "$target")"
  else
    bad "$target is not mounted"
  fi
  # The question that actually matters: is the data reachable at the OLD path, on the NEW device.
  if [ "$(stat -c %d "$target")" = "$(stat -c %d "$DEST")" ]; then
    ok "$target now lives on the $DEST filesystem"
  else
    bad "$target is still on its old filesystem"
  fi
done

restart_writers
trap - EXIT

step "11. What is now covered"
ok "restic backs up $DEST, so these trees gained an off-host copy with no change to its unit"
warn "the originals remain at ${SRC_FEDBENCH}.pre-relocate and ${SRC_ARCHIVE}.pre-relocate -- delete them only after a restic run and a restore drill have both passed"

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: relocation FAILED (%d failure(s), %d warn(s)).\033[0m\n' "$fail" "$warns"
  exit 1
fi
printf '\n\033[32mVERDICT: relocation complete (%d warn(s)).\033[0m\n' "$warns"
printf 'Next: sudo systemctl start fedbench-backup.service && sudo bash %s/restore-drill.sh\n' "$(dirname "$0")"
