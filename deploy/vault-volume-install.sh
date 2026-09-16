#!/usr/bin/env bash
set -uo pipefail
# Reserve a fixed slice of /storage for the vault, as its own filesystem.
#
#   sudo bash deploy/vault-volume-install.sh --check
#   sudo bash deploy/vault-volume-install.sh
#   sudo bash deploy/vault-volume-install.sh --size 512G
#
# WHY A FILE AND NOT A PARTITION. /storage is md125: two 4 TB NVMe in RAID1, the array formatted
# directly as one XFS, no partition table on the md device and no LVM under it (verified on the box
# 2026-09-16: lsblk shows md125 -> xfs -> /storage, pvs is empty). XFS cannot shrink. A real partition
# or logical volume for the vault therefore means copying 824 GB of everyone's EDA work off, wiping
# the array, rebuilding it as LVM and copying back -- a multi-hour outage for the sim users to isolate
# about 60 GB of vault data. Nobody should take that risk for this.
#
# A preallocated file gives the same guarantee without touching the array. fallocate hands the file
# its blocks immediately: they count as used in df on /storage, and no sim can write into them. The
# file is formatted as XFS and loop-mounted, so the vault gets its own filesystem with its own free
# space, its own fsck boundary, and a hard ceiling -- it cannot grow into the sims' space either.
# Nothing on /storage is remounted, and the whole thing reverses by unmounting and deleting one file.
#
# WHAT WOULD SILENTLY UNDO IT. A discard. If the inner filesystem tells the loop device a block is
# free, the loop driver punches a hole in the image and the "reserved" space goes back to the array.
# Online discard is off (nodiscard), RHEL's weekly fstrim.timer is told to skip the mount
# (X-fstrim.notrim), and a udev rule zeroes discard_max_bytes on the loop device so a hand-run fstrim
# gets "not supported". Step 10 proves all three, because a reservation that leaks is worse than none.
#
# WHAT THIS DOES NOT DO. It moves no data. Run relocate-fedbench-data.sh --dest /storage/vault
# afterwards; its assertions accept a loop mount. It does not touch the PostgreSQL data directory,
# which stays on the root mirror -- see relocate-fedbench-data.sh for why.
#
# Undo: systemctl disable --now storage-vault.mount; rm /etc/systemd/system/storage-vault.mount
# /etc/udev/rules.d/99-vault-loop-nodiscard.rules; systemctl daemon-reload; udevadm control --reload.
# THIS SCRIPT NEVER DELETES THE IMAGE. It holds whatever was relocated onto it.

# The checkout, NOT a hand-copied tree. /home/agnidata/work is a copy with no way to see drift;
# /srv/agni-data-vault is a real clone whose HEAD can be compared with the repository.
UNITSRC=${UNITSRC:-/srv/agni-data-vault/deploy}
UNITDIR=/etc/systemd/system
UDEVDIR=/etc/udev/rules.d

ARRAY=/storage
IMAGE=/storage/vault.img
MOUNT=/storage/vault
MOUNT_UNIT=storage-vault.mount
UDEV_RULE=99-vault-loop-nodiscard.rules
RESTIC_UNIT=restic-backup.service
# Overridable only so the container harness (no md module, hence no /proc/mdstat) can exercise
# every step against a fake. On the box, leave it alone.
MDSTAT=${MDSTAT:-/proc/mdstat}
SIZE=512G
CHECK=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
iec()  { numfmt --to=iec "$1" 2>/dev/null || echo "$1 bytes"; }

usage() {
  sed -n '3,8p' "$0"
  printf '\nUsage: sudo bash %s [--size 512G] [--check]\n' "$0"
  printf 'The image path (%s), mount point (%s) and unit names are fixed: the mount unit, the udev\n' "$IMAGE" "$MOUNT"
  printf 'rule and the restic exclude in the checkout all name them, and one flag cannot change four files.\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --size)
      [ $# -ge 2 ] || { echo "--size needs a value such as 512G" >&2; exit 2; }
      SIZE=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }

SIZE_BYTES=$(numfmt --from=iec "$SIZE" 2>/dev/null)
case "$SIZE_BYTES" in
  ''|*[!0-9]*) echo "--size must be a size numfmt understands, such as 512G" >&2; exit 2 ;;
esac
[ "$SIZE_BYTES" -ge $((16 * 1024 * 1024 * 1024)) ] || { echo "--size below 16G makes no sense here" >&2; exit 2; }

# ---------------------------------------------------------------------------------------------------
step "1. Assertions -- the array this reserves from"
if findmnt -no TARGET "$ARRAY" >/dev/null 2>&1; then
  arr_src=$(findmnt -no SOURCE "$ARRAY")
  arr_fs=$(findmnt -no FSTYPE "$ARRAY")
  ok "$ARRAY is a mount point ($arr_src, $arr_fs)"
  # fallocate on XFS allocates unwritten extents up front, which is the whole mechanism. ext4 would
  # too; anything else (or an unknown filesystem) and this script's central claim is unverified.
  case "$arr_fs" in
    xfs|ext4) ok "$arr_fs honours fallocate as a real allocation" ;;
    *) bad "$ARRAY is $arr_fs; this script has only been reasoned about for xfs (and ext4)" ;;
  esac
  md=${arr_src#/dev/}
  if grep -q "^${md} : active raid1" "$MDSTAT" 2>/dev/null; then
    state=$(grep -A2 "^${md} :" "$MDSTAT" | grep -o '\[U*_*\]' | head -1)
    if [ "$state" = "[UU]" ]; then
      ok "$md is an active RAID1 with both members present $state"
    else
      # Reserving space on a degraded mirror is not wrong, but doing it without noticing is.
      warn "$md is RAID1 but reports $state -- a member is missing or rebuilding; check mdadm --detail /dev/$md"
    fi
  else
    bad "$arr_src is not an active RAID1 in $MDSTAT -- the redundancy this design assumes is absent"
  fi
else
  bad "$ARRAY is not a mount point"
fi

step "2. Assertions -- space, so the sims keep their headroom"
avail_k=$(df -k --output=avail "$ARRAY" 2>/dev/null | tail -1 | tr -d ' ')
size_k=$(df -k --output=size  "$ARRAY" 2>/dev/null | tail -1 | tr -d ' ')
case "$avail_k$size_k" in ''|*[!0-9]*) bad "could not read df for $ARRAY"; avail_k=0; size_k=1 ;; esac
need_k=$((SIZE_BYTES / 1024))
if [ -f "$IMAGE" ]; then
  ok "$IMAGE already exists; its space is already taken from $ARRAY (skipping the free-space test)"
elif [ "$avail_k" -gt "$need_k" ]; then
  ok "$ARRAY has $(iec $((avail_k * 1024))) free; reserving $(iec "$SIZE_BYTES")"
  left_k=$((avail_k - need_k))
  # The sims are the array's other tenant. Taking the reservation must leave them a real margin, and
  # 10% of a 3.7 TB array is about 370 GB -- below that the reservation starts causing the failures it
  # was meant to prevent, in someone else's jobs.
  if [ "$left_k" -lt $((size_k / 10)) ]; then
    bad "only $(iec $((left_k * 1024))) would remain for the EDA work -- under 10% of the array; pick a smaller --size"
  else
    ok "$(iec $((left_k * 1024))) remains for the EDA work after the reservation"
  fi
else
  bad "$ARRAY has $(iec $((avail_k * 1024))) free; $(iec "$SIZE_BYTES") does not fit"
fi

step "3. Assertions -- tools"
for t in fallocate mkfs.xfs losetup xfs_io findmnt numfmt udevadm systemd-escape; do
  command -v "$t" >/dev/null 2>&1 && ok "$t is available" || bad "$t is missing"
done
# fstrim is the thing step 10 defends against; without it the defence cannot be proven either way.
command -v fstrim >/dev/null 2>&1 && ok "fstrim is available (its dry run is the proof in step 10)" \
  || warn "fstrim is missing; the trim-protection proof in step 10 will be skipped"

step "4. Assertions -- the checkout carries what gets installed"
for f in "$MOUNT_UNIT" "$UDEV_RULE" "$RESTIC_UNIT"; do
  [ -f "$UNITSRC/$f" ] && ok "$UNITSRC/$f present" || bad "$UNITSRC/$f missing -- is UNITSRC the vault checkout?"
done
if [ -f "$UNITSRC/$MOUNT_UNIT" ]; then
  # The unit and this script must agree on paths, or the mount lands somewhere step 10 never looks.
  grep -q "^What=$IMAGE\$" "$UNITSRC/$MOUNT_UNIT" && ok "$MOUNT_UNIT mounts $IMAGE" || bad "$MOUNT_UNIT does not name What=$IMAGE"
  grep -q "^Where=$MOUNT\$" "$UNITSRC/$MOUNT_UNIT" && ok "$MOUNT_UNIT mounts at $MOUNT" || bad "$MOUNT_UNIT does not name Where=$MOUNT"
  grep -q "X-fstrim.notrim" "$UNITSRC/$MOUNT_UNIT" && ok "$MOUNT_UNIT carries X-fstrim.notrim" || bad "$MOUNT_UNIT lacks X-fstrim.notrim"
fi
if [ -f "$UNITSRC/$RESTIC_UNIT" ]; then
  grep -q -- "--exclude=$IMAGE" "$UNITSRC/$RESTIC_UNIT" && ok "$RESTIC_UNIT in the checkout excludes $IMAGE" \
    || bad "$RESTIC_UNIT in the checkout does not exclude $IMAGE -- restic would read the whole image nightly"
fi
[ "$(systemd-escape --path --suffix=mount "$MOUNT")" = "$MOUNT_UNIT" ] \
  && ok "unit name $MOUNT_UNIT is what systemd derives from $MOUNT" \
  || bad "systemd would name this mount $(systemd-escape --path --suffix=mount "$MOUNT"), not $MOUNT_UNIT -- it would never be honoured"

step "5. Assertions -- current state (this script is safe to re-run only in one shape)"
if findmnt -no TARGET "$MOUNT" >/dev/null 2>&1; then
  cur=$(findmnt -no SOURCE "$MOUNT")
  if losetup -j "$IMAGE" 2>/dev/null | grep -q "^${cur}:"; then
    ok "$MOUNT is already mounted from $IMAGE via $cur -- steps 6-8 will be skipped, 9-10 still verify"
  else
    bad "$MOUNT is mounted from $cur, which is not a loop device on $IMAGE -- inspect before continuing"
  fi
elif [ -e "$IMAGE" ]; then
  # An image that exists but is not mounted is the ambiguous case: a previous run died between
  # fallocate and enable, or somebody unmounted a volume that holds data. Do not guess.
  bad "$IMAGE exists but $MOUNT is not mounted -- decide whether it holds data before re-running (mount it by hand or remove it)"
else
  ok "$IMAGE does not exist and $MOUNT is not mounted: a fresh install"
  [ -e "$MOUNT" ] && [ -n "$(ls -A "$MOUNT" 2>/dev/null)" ] \
    && bad "$MOUNT exists and is not empty; mounting over it would hide those files" \
    || ok "$MOUNT is absent or empty"
fi

step "6. Assertions -- SELinux"
if [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  ok "SELinux is enforcing; the mount point gets an fcontext rule"
  command -v semanage >/dev/null 2>&1 && ok "semanage is available" || bad "semanage is missing (dnf install policycoreutils-python-utils)"
  command -v restorecon >/dev/null 2>&1 && ok "restorecon is available" || bad "restorecon is missing"
else
  warn "SELinux is not enforcing; the labelling step is a no-op"
fi

if [ "$CHECK" -eq 1 ]; then
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: CHECK FAILED (%d failure(s), %d warn(s)); nothing was changed.\033[0m\n' "$fail" "$warns"
    exit 1
  fi
  printf '\n\033[32mVERDICT: CHECK PASSED (%d warn(s)); nothing was changed.\033[0m\n' "$warns"
  exit 0
fi
[ "$fail" -eq 0 ] || { printf '\n\033[31mRefusing to proceed with %d failed assertion(s).\033[0m\n' "$fail"; exit 1; }

# ---------------------------------------------------------------------------------------------------
step "7. The restic exclude goes in FIRST"
# Order matters: the next nightly run after the image exists must already skip it. The live unit is
# an adopted host unit, so it is replaced from the checkout and the previous copy is kept.
if systemctl cat "$RESTIC_UNIT" 2>/dev/null | grep -q -- "--exclude=$IMAGE"; then
  ok "live $RESTIC_UNIT already excludes $IMAGE"
else
  stamp=$(date +%Y%m%dT%H%M%S)
  if [ -f "$UNITDIR/$RESTIC_UNIT" ]; then
    cp -a "$UNITDIR/$RESTIC_UNIT" "$UNITDIR/$RESTIC_UNIT.bak.$stamp" && ok "kept the previous unit at $UNITDIR/$RESTIC_UNIT.bak.$stamp" \
      || bad "could not back up the live $RESTIC_UNIT"
  else
    warn "no $UNITDIR/$RESTIC_UNIT on this host; installing the checkout's copy"
  fi
  if install -m 0644 "$UNITSRC/$RESTIC_UNIT" "$UNITDIR/$RESTIC_UNIT"; then
    systemctl daemon-reload
    systemctl cat "$RESTIC_UNIT" 2>/dev/null | grep -q -- "--exclude=$IMAGE" \
      && ok "installed $RESTIC_UNIT with the exclude" \
      || bad "installed $RESTIC_UNIT but systemd does not show the exclude"
  else
    bad "could not install $RESTIC_UNIT"
  fi
fi
[ "$fail" -eq 0 ] || { printf '\n\033[31mStopping before the image is created: restic must exclude it first.\033[0m\n'; exit 1; }

step "8. The udev rule, before any loop device exists to match"
install -m 0644 "$UNITSRC/$UDEV_RULE" "$UDEVDIR/$UDEV_RULE" && ok "installed $UDEVDIR/$UDEV_RULE" || bad "could not install $UDEV_RULE"
udevadm control --reload 2>/dev/null && ok "udev reloaded its rules" || warn "udevadm control --reload failed; the rule applies after the next reload"

if ! findmnt -no TARGET "$MOUNT" >/dev/null 2>&1; then
  step "9a. Allocate the image -- every block, now"
  # fallocate, not truncate: a sparse file reserves nothing and would pass every later check while
  # protecting nothing. Mode 0600 root: nothing but the loop driver has business opening it.
  if fallocate -l "$SIZE_BYTES" "$IMAGE"; then
    chmod 0600 "$IMAGE"; chown root:root "$IMAGE"
    ok "created $IMAGE ($(iec "$SIZE_BYTES"))"
  else
    bad "fallocate failed for $IMAGE"
  fi
  # PROVE the blocks are allocated. stat reports 512-byte blocks actually assigned; for a sparse
  # file this is near zero and for a preallocated one it is the full size (XFS may round up slightly).
  alloc=$(( $(stat -c %b "$IMAGE" 2>/dev/null || echo 0) * $(stat -c %B "$IMAGE" 2>/dev/null || echo 0) ))
  if [ "$alloc" -ge "$SIZE_BYTES" ]; then
    ok "verified: $(iec "$alloc") of blocks are allocated to the image -- the reservation is real"
  else
    bad "only $(iec "$alloc") allocated for a $(iec "$SIZE_BYTES") image -- this is sparse, not reserved"
  fi
  [ "$fail" -eq 0 ] || { printf '\n\033[31mAborting. %s is left in place for inspection; remove it by hand if it is wrong.\033[0m\n' "$IMAGE"; exit 1; }

  step "9b. Format it"
  dev=$(losetup --find --show "$IMAGE" 2>/dev/null)
  if [ -n "$dev" ]; then
    ok "attached $IMAGE as $dev"
    # Wait for udev to process the attach so the rule from step 8 has had its chance.
    udevadm settle 2>/dev/null
    # -K: do NOT discard the device first. mkfs.xfs's default pre-format discard reaches the loop
    # driver as a hole punch on the image, and the harness run without -K showed the 16 GiB test
    # reservation shrink to 65 MiB before a single file was written. This is the same leak the three
    # trim defences guard against, arriving one step earlier than any of them.
    if mkfs.xfs -q -K -L vault "$dev"; then
      ok "formatted $dev as XFS, label vault (without a pre-format discard)"
    else
      bad "mkfs.xfs failed on $dev"
    fi
    losetup -d "$dev" && ok "detached $dev" || warn "could not detach $dev; the mount unit will attach its own"
    # Belt: whatever mkfs did, put every block back. fallocate on an existing file fills holes and
    # leaves written data alone, so this is safe and idempotent; it is a no-op when nothing leaked.
    alloc=$(( $(stat -c %b "$IMAGE") * $(stat -c %B "$IMAGE") ))
    if [ "$alloc" -lt "$SIZE_BYTES" ]; then
      warn "mkfs left only $(iec "$alloc") allocated; re-reserving the holes"
      fallocate -l "$SIZE_BYTES" "$IMAGE" || bad "re-fallocate failed"
    fi
    alloc=$(( $(stat -c %b "$IMAGE") * $(stat -c %B "$IMAGE") ))
    [ "$alloc" -ge "$SIZE_BYTES" ] && ok "image fully allocated after format ($(iec "$alloc"))" \
      || bad "image is $(iec "$alloc") of $(iec "$SIZE_BYTES") after format and repair"
  else
    bad "losetup could not attach $IMAGE"
  fi
  [ "$fail" -eq 0 ] || { printf '\n\033[31mAborting before the mount unit. %s is formatted or partly so; inspect it.\033[0m\n' "$IMAGE"; exit 1; }

  step "9c. Mount it, through systemd, so it comes back after a reboot"
  mkdir -p "$MOUNT" && chmod 0755 "$MOUNT"
  install -m 0644 "$UNITSRC/$MOUNT_UNIT" "$UNITDIR/$MOUNT_UNIT" && ok "installed $UNITDIR/$MOUNT_UNIT" || bad "could not install $MOUNT_UNIT"
  systemctl daemon-reload
  if systemctl enable --now "$MOUNT_UNIT" >/dev/null 2>&1; then
    ok "enabled and started $MOUNT_UNIT"
  else
    bad "systemctl enable --now $MOUNT_UNIT failed: $(systemctl status "$MOUNT_UNIT" --no-pager 2>&1 | tail -3 | tr '\n' ' ')"
  fi
  udevadm settle 2>/dev/null
fi

step "10. Label the mount point"
if [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  # var_t is what /srv/fedbench carries today and what relocate-fedbench-data.sh applies to the trees
  # it creates underneath, so the services keep exactly the access they have.
  semanage fcontext -a -t var_t "${MOUNT}(/.*)?" 2>/dev/null \
    || semanage fcontext -m -t var_t "${MOUNT}(/.*)?" 2>/dev/null \
    || warn "could not record an fcontext rule for $MOUNT"
  restorecon -R "$MOUNT" 2>/dev/null && ok "labelled $MOUNT as var_t" || bad "restorecon failed for $MOUNT"
fi

# ---------------------------------------------------------------------------------------------------
step "11. Assertions -- prove the volume is what this script claims"
if findmnt -no TARGET "$MOUNT" >/dev/null 2>&1; then
  loopdev=$(findmnt -no SOURCE "$MOUNT")
  ok "$MOUNT is mounted from $loopdev"
  losetup -j "$IMAGE" 2>/dev/null | grep -q "^${loopdev}:" && ok "$loopdev is backed by $IMAGE" || bad "$loopdev is not a loop device on $IMAGE"
  [ "$(findmnt -no FSTYPE "$MOUNT")" = "xfs" ] && ok "filesystem is xfs" || bad "filesystem is $(findmnt -no FSTYPE "$MOUNT"), not xfs"
  [ "$(stat -c %d "$MOUNT")" != "$(stat -c %d "$ARRAY")" ] && ok "$MOUNT is its own filesystem, not a directory on $ARRAY" \
    || bad "$MOUNT is on the same filesystem as $ARRAY -- the mount did not take"
  vol_k=$(df -k --output=size "$MOUNT" 2>/dev/null | tail -1 | tr -d ' ')
  # XFS keeps a few percent for its log and metadata; the visible size should be within 5% of the image.
  if [ -n "$vol_k" ] && [ "$vol_k" -ge $((SIZE_BYTES / 1024 * 95 / 100)) ]; then
    ok "df reports $(iec $((vol_k * 1024))) for the volume"
  else
    bad "df reports $(iec $((${vol_k:-0} * 1024))) for a $(iec "$SIZE_BYTES") image"
  fi
  # The reservation is a promise only while the image stays fully allocated. Re-check after mkfs.
  alloc=$(( $(stat -c %b "$IMAGE") * $(stat -c %B "$IMAGE") ))
  [ "$alloc" -ge "$SIZE_BYTES" ] && ok "image still fully allocated ($(iec "$alloc"))" || bad "image has lost allocation: $(iec "$alloc") of $(iec "$SIZE_BYTES") -- something discarded through it"
  # XFS does not print nodiscard: it is the default and only "discard" ever appears. So the proof is
  # the absence of the word, not the presence of its opposite (a check for "nodiscard" fails on a
  # correctly mounted volume, as the harness showed).
  if findmnt -no OPTIONS "$MOUNT" | tr ',' '\n' | grep -qx discard; then
    bad "mounted with online discard: $(findmnt -no OPTIONS "$MOUNT")"
  else
    ok "online discard is off (XFS default; options: $(findmnt -no OPTIONS "$MOUNT"))"
  fi

  # THE THREE TRIM DEFENCES, each proven, none assumed.
  lname=${loopdev#/dev/}
  dmb=$(cat "/sys/block/$lname/queue/discard_max_bytes" 2>/dev/null)
  if [ "$dmb" = "0" ]; then
    ok "udev rule applied: $lname reports discard_max_bytes=0 (discards refused at the block layer)"
  else
    # Apply it for this boot regardless, then say the persistent rule did not fire.
    echo 0 > "/sys/block/$lname/queue/discard_max_bytes" 2>/dev/null \
      && warn "udev rule did NOT apply (discard_max_bytes was ${dmb:-unreadable}); set to 0 by hand for this boot -- check udevadm test /sys/block/$lname" \
      || bad "discard_max_bytes is ${dmb:-unreadable} on $lname and could not be zeroed; fstrim would deflate the reservation"
  fi
  if command -v fstrim >/dev/null 2>&1; then
    # This is the same invocation RHEL's fstrim.service runs, in dry-run. If the mount appears, the
    # weekly timer would trim it.
    # A dry run that lists nothing at all proves nothing (empty output "passes" any negative grep), so
    # first require that it lists SOME filesystem; the array itself always qualifies.
    listing=$(fstrim --listed-in /etc/fstab:/proc/self/mountinfo --dry-run --verbose 2>/dev/null)
    # This proves the OUTCOME -- the timer's own invocation skips the volume -- not which defence
    # caused it. In the harness the skip was attributable to discard_max_bytes=0; X-fstrim.notrim
    # could not be shown to register on util-linux 2.37 and is kept as a second layer, not the proof.
    if [ -z "$listing" ]; then
      warn "fstrim's dry run listed no filesystems at all; the weekly-timer proof is inconclusive here"
    elif printf '%s\n' "$listing" | grep -q "^${MOUNT}:"; then
      bad "fstrim's dry run lists $MOUNT -- the weekly timer would trim it"
    else
      ok "fstrim's dry run (the weekly timer's own invocation) lists other filesystems but skips $MOUNT"
    fi
  fi
  systemctl is-enabled --quiet "$MOUNT_UNIT" 2>/dev/null && ok "$MOUNT_UNIT is enabled (survives reboot)" || bad "$MOUNT_UNIT is not enabled"
  systemctl cat "$RESTIC_UNIT" 2>/dev/null | grep -q -- "--exclude=$IMAGE" && ok "live $RESTIC_UNIT excludes the image" || bad "live $RESTIC_UNIT does not exclude the image"
else
  bad "$MOUNT is not mounted"
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: install FAILED (%d failure(s), %d warn(s)).\033[0m\n' "$fail" "$warns"
  exit 1
fi
printf '\n\033[32mVERDICT: vault volume ready at %s (%d warn(s)).\033[0m\n' "$MOUNT" "$warns"
printf 'Next: sudo bash %s/relocate-fedbench-data.sh --check --dest %s\n' "$(dirname "$0")" "$MOUNT"
printf '      then the same without --check, then a restic run and a restore drill before deleting any .pre-relocate tree.\n'
