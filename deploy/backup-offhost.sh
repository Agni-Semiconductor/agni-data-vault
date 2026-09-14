#!/usr/bin/env bash
# Copy the newest verified fedbench backup pair to storage outside the database host.
#
#   bash deploy/backup-offhost.sh --dest /mnt/nasbackup
#   bash deploy/backup-offhost.sh --dest /mnt/nasbackup --keep 30
#   bash deploy/backup-offhost.sh --dest /mnt/nasbackup --source /srv/fedbench/backups --check
#
# Undo: removes only the copied fedbench-*.dump and fedbench-*.sql.gz files from the destination;
# this script never changes the source backup directory.
set -uo pipefail

SOURCE=/srv/fedbench/backups
DEST=""
# sha256 of zero bytes. dd with iflag=direct on a filesystem that refuses O_DIRECT produces no
# output and a zero exit status, which would otherwise hash to this and look like a mismatch.
EMPTY_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
KEEP=14
CHECK=0
fail=0
warns=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: bash deploy/backup-offhost.sh --dest PATH [--source PATH] [--keep N] [--check]

Copy the newest source .dump by modification time and its .sql.gz twin to PATH. Each destination
file is hashed and sized after copying, then atomically published only when it matches the source.
--source defaults to /srv/fedbench/backups and --keep defaults to 14 destination backup pairs.
--check performs only assertions plus a create/remove writability probe; it copies and prunes nothing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)
      [ "$#" -ge 2 ] || { echo "--dest needs a path" >&2; exit 2; }
      DEST=$2; shift 2 ;;
    --source)
      [ "$#" -ge 2 ] || { echo "--source needs a path" >&2; exit 2; }
      SOURCE=$2; shift 2 ;;
    --keep)
      [ "$#" -ge 2 ] || { echo "--keep needs a number" >&2; exit 2; }
      KEEP=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$DEST" ] || { echo "--dest is required" >&2; exit 2; }
case "$KEEP" in
  ''|*[!0-9]*) echo "--keep must be a positive whole number, not: $KEEP" >&2; exit 2 ;;
esac
[ "$KEEP" -gt 0 ] || { echo "--keep must be at least 1" >&2; exit 2; }

step "Assertions -- source and destination"
if [ -d "$SOURCE" ]; then ok "source directory exists: $SOURCE"; else bad "source directory is missing: $SOURCE"; fi
if [ -d "$DEST" ]; then ok "destination directory exists: $DEST"; else bad "destination directory is missing: $DEST"; fi

for tool in stat sha256sum cp mv mktemp rm; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool is present" || bad "$tool is required and not on PATH"
done

if [ -d "$SOURCE" ] && [ -d "$DEST" ]; then
  source_device=$(stat -c %d "$SOURCE" 2>/dev/null) || source_device=""
  dest_device=$(stat -c %d "$DEST" 2>/dev/null) || dest_device=""
  if [ -n "$source_device" ] && [ "$source_device" = "$dest_device" ]; then
    # A local destination survives neither host loss nor the disk failure this copy is meant to cover.
    warn "OFF-HOST WARNING: $DEST is on the same filesystem as $SOURCE (device $source_device)"
  elif [ -n "$source_device" ] && [ -n "$dest_device" ]; then
    ok "destination is on a different filesystem from the source"
  else
    bad "could not read filesystem device numbers for source and destination"
  fi

  if command -v mountpoint >/dev/null 2>&1; then
    if mountpoint -q "$DEST"; then
      ok "$DEST is a mountpoint"
    else
      # An unmounted NFS path accepts writes on rootfs, which looks successful until the host fails.
      warn "$DEST is not a mountpoint; an unmounted NFS share may silently fill the local root disk"
    fi
  else
    warn "mountpoint is unavailable; cannot detect an unmounted destination share"
  fi

  # Permission bits alone lie for ACLs, NFS root-squash, and a full share, so exercise the real write.
  probe=$(mktemp "$DEST/.offhost-check.XXXXXX" 2>/dev/null) || probe=""
  if [ -n "$probe" ]; then
    if rm -f "$probe"; then
      ok "destination accepted and removed a writability probe"
    else
      bad "destination accepted a probe but could not remove it"
    fi
  else
    bad "destination cannot create a writability probe"
  fi
fi

if [ "$CHECK" -eq 1 ]; then
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: off-host backup CHECK FAILED (%d failure(s), %d warn(s)); no backup was copied or pruned.\033[0m\n' "$fail" "$warns"
    exit 1
  fi
  printf '\n\033[32mVERDICT: off-host backup CHECK PASSED (%d warn(s)); no backup was copied or pruned.\033[0m\n' "$warns"
  exit 0
fi

[ "$fail" -eq 0 ] || {
  printf '\n\033[31mVERDICT: off-host backup FAILED (%d failure(s), %d warn(s)); no backup was copied or pruned.\033[0m\n' "$fail" "$warns"
  exit 1
}

newest=""
newest_mtime=-1
shopt -s nullglob
source_dumps=("$SOURCE"/*.dump)
shopt -u nullglob
for dump in "${source_dumps[@]}"; do
  [ -f "$dump" ] || continue
  mtime=$(stat -c %Y "$dump" 2>/dev/null) || continue
  case "$mtime" in ''|*[!0-9]*) continue ;; esac
  if [ "$mtime" -gt "$newest_mtime" ]; then
    newest=$dump
    newest_mtime=$mtime
  fi
done

if [ -z "$newest" ]; then
  bad "no .dump files exist under $SOURCE"
else
  stem=${newest%.dump}
  source_sql="${stem}.sql.gz"
  [ -f "$source_sql" ] || bad "newest dump $newest has no same-day SQL gzip twin $source_sql"
fi

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: off-host backup FAILED (%d failure(s), %d warn(s)); no retention was pruned.\033[0m\n' "$fail" "$warns"
  exit 1
fi

started=$(date +%s)
published=()
# REDIRECTED, not passed as an argument. GNU sha256sum ESCAPES its output line with a leading
# backslash when the filename contains a backslash or a newline, so `awk '{print $1}'` returns
# `\<hash>` rather than the hash. Both sides were equally mangled and compared equal until the
# destination side started reading from a pipe -- at which point a path containing a backslash
# produced a verification MISMATCH on a byte-identical copy, deleted it, and failed the backup.
# Reading from stdin means there is no filename in the output to escape.
copy_one() {
  local source_file=$1 destination_file=$2 temporary_file source_hash dest_hash source_size dest_size
  source_hash=$(sha256sum < "$source_file" | awk '{print $1}') || { bad "could not hash source $source_file"; return; }
  source_size=$(stat -c %s "$source_file") || { bad "could not read source size $source_file"; return; }
  temporary_file=$(mktemp "$DEST/.${destination_file##*/}.XXXXXX") || { bad "could not create a destination temporary file for $destination_file"; return; }
  # Keep incomplete NFS writes hidden: a final name must mean its bytes were verified after landing.
  if ! cp -- "$source_file" "$temporary_file"; then
    bad "could not copy $source_file to $temporary_file"
    rm -f "$temporary_file"
    return
  fi
  # O_DIRECT, so the read-back cannot be answered from the local page cache. This is the whole
  # claim of this script: that the bytes are ON THE DESTINATION. A plain sha256sum of a file just
  # written over NFS is very likely served from the client's own cache -- it would return the
  # bytes we just sent regardless of what the server stored, which verifies nothing and would
  # report a truncated write as verified. `sync` first so anything still buffered is flushed and
  # a deferred write error surfaces here rather than at the next reboot.
  sync "$temporary_file" 2>/dev/null || sync
  dest_hash=$(dd if="$temporary_file" iflag=direct bs=1M status=none 2>/dev/null | sha256sum | awk '{print $1}')
  if [ -z "$dest_hash" ] || [ "$dest_hash" = "$EMPTY_SHA256" ]; then
    # Not every filesystem supports O_DIRECT (tmpfs does not, and some NFS mounts refuse it). Fall
    # back rather than failing a good copy, but say so: the guarantee is weaker on that path.
    warn "could not read $destination_file with O_DIRECT; verifying through the page cache instead"
    dest_hash=$(sha256sum < "$temporary_file" | awk '{print $1}') || dest_hash=""
  fi
  dest_size=$(stat -c %s "$temporary_file" 2>/dev/null) || dest_size="unknown"
  if [ "$source_hash" != "$dest_hash" ] || [ "$source_size" != "$dest_size" ]; then
    bad "verification failed for $destination_file: sha256 source=$source_hash destination=$dest_hash; bytes source=$source_size destination=$dest_size"
    # A short NFS write can exit cp(1) successfully; remove it so it cannot be mistaken for a backup.
    rm -f "$temporary_file"
    return
  fi
  if mv -f "$temporary_file" "$destination_file"; then
    published+=("$destination_file")
    ok "verified and published $destination_file"
  else
    bad "could not atomically publish $destination_file"
    rm -f "$temporary_file"
  fi
}

dest_dump="$DEST/${newest##*/}"
dest_sql="$DEST/${source_sql##*/}"
copy_one "$newest" "$dest_dump"
copy_one "$source_sql" "$dest_sql"

if [ "$fail" -gt 0 ]; then
  # Do not leave half a pair from this run: an operator could otherwise count one final-looking file.
  for file in "${published[@]}"; do rm -f "$file"; done
  ended=$(date +%s)
  duration=$((ended - started))
  printf '\n\033[31msummary: copy failed; no verified new pair remains; duration %ss; retention removed 0 pair(s)\033[0m\n' "$duration"
  printf '\033[31mVERDICT: off-host backup FAILED (%d failure(s), %d warn(s)); retention was not pruned.\033[0m\n' "$fail" "$warns"
  exit 1
fi

removed=0
shopt -s nullglob
dest_dumps=("$DEST"/*.dump)
shopt -u nullglob
pair_lines=()
for dump in "${dest_dumps[@]}"; do
  mtime=$(stat -c %Y "$dump" 2>/dev/null) || continue
  # A dump whose twin is absent still counts, and is still eligible for pruning. Skipping it --
  # as the first version did -- meant a half-copied pair from an interrupted run accumulated at
  # the destination forever, never pruned, while looking like a retained backup.
  [ -f "${dump%.dump}.sql.gz" ] || warn "destination $dump has no .sql.gz twin; treating it as an incomplete pair"
  pair_lines+=("$mtime"$'\t'"$dump")
done
mapfile -t ordered_pairs < <(printf '%s\n' "${pair_lines[@]}" | sort -nr)
kept=1
for line in "${ordered_pairs[@]}"; do
  old_dump=${line#*$'\t'}
  old_sql="${old_dump%.dump}.sql.gz"
  # Count this pair first even if timestamp skew makes older destination files sort ahead of it.
  if [ "$old_dump" = "$dest_dump" ]; then
    continue
  fi
  if [ "$kept" -lt "$KEEP" ]; then
    kept=$((kept + 1))
    continue
  fi
  # Prune destination pairs only after both current files landed and verified, never source files.
  if rm -f "$old_dump" "$old_sql"; then
    removed=$((removed + 1))
    printf '  removed %s and %s\n' "$old_dump" "$old_sql"
  else
    bad "could not remove old destination pair $old_dump and $old_sql"
  fi
done

ended=$(date +%s)
duration=$((ended - started))
total_bytes=$(( $(stat -c %s "$dest_dump") + $(stat -c %s "$dest_sql") ))
dump_hash=$(sha256sum < "$dest_dump" | awk '{print $1}')
sql_hash=$(sha256sum < "$dest_sql" | awk '{print $1}')
if [ "$fail" -gt 0 ]; then
  printf '\033[31mVERDICT: off-host backup FAILED (%d failure(s), %d warn(s)); retention removed %s pair(s).\033[0m\n' "$fail" "$warns" "$removed"
  exit 1
fi
printf '\033[32msummary: copied %s and %s; sha256 source=destination %s, %s; total bytes %s; duration %ss; retention removed %s pair(s)\033[0m\n' \
  "$dest_dump" "$dest_sql" "$dump_hash" "$sql_hash" "$total_bytes" "$duration" "$removed"
printf '\033[32mVERDICT: off-host backup PASSED (%d warn(s)); retention removed %s pair(s).\033[0m\n' "$warns" "$removed"
