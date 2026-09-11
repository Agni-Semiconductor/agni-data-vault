#!/usr/bin/env bash
# Make two readable forms of the fedbench database backup on edaserver.
#
# THIS IS NOT AN OFF-HOST BACKUP. It writes to local disk on the same host as the database, so it
# is not a second physical copy and does NOT satisfy the cutover gate. The hosted Supabase projects
# are still the only off-host copy of this data, and they stop being that the moment anyone cuts
# over. This script prints that fact every run because a local backup that looks sufficient retires
# the question in somebody's head while the host remains a single point of failure.
#
#   bash deploy/backup-fedbench.sh
#   bash deploy/backup-fedbench.sh --out /srv/fedbench/backups --retain 30
#   bash deploy/backup-fedbench.sh --dry-run
#
# The custom archive needs a matching-or-newer pg_restore forever. The SQL twin stays readable by
# zgrep, a human, and future Postgres clients, so losing an old restore binary does not read as a
# backup that exists but cannot be opened.
set -uo pipefail

DB=fedbench
OUT=/srv/fedbench/backups
RETAIN=14
DRY=0
# Do not use the Siemens Calibre client that wins on PATH on edaserver: a dump made by the wrong
# client can fail or omit server features while the symptom reads as an ordinary archive problem.
PG_DUMP=/usr/pgsql-17/bin/pg_dump
PG_RESTORE=/usr/pgsql-17/bin/pg_restore

printf '%s\n' 'WARNING: this writes only to local disk on the database host. It is NOT an off-host backup,' \
  'NOT a second physical copy, and does NOT satisfy the cutover gate. Hosted Supabase is the only' \
  'off-host copy until cutover; after cutover it is not an off-host copy at all.'
printf '\n'

ok()  { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
usage() {
  cat <<'EOF'
Usage: bash deploy/backup-fedbench.sh [--out PATH] [--retain DAYS] [--dry-run]

Write a custom pg_dump archive and a gzip-compressed SQL twin of fedbench. --out defaults to
/srv/fedbench/backups and --retain defaults to 14 daily dump pairs.

This is local disk on the database host, NOT an off-host backup and NOT the cutover gate. The
hosted Supabase projects remain the only off-host copy until cutover, when they stop being one.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || { echo "--out needs a path" >&2; exit 2; }
      OUT=$2
      shift 2
      ;;
    --retain)
      [ $# -ge 2 ] || { echo "--retain needs a number of days" >&2; exit 2; }
      RETAIN=$2
      shift 2
      ;;
    --dry-run)
      DRY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$RETAIN" in
  ''|*[!0-9]*) echo "--retain must be a positive whole number, not: $RETAIN" >&2; exit 2 ;;
esac
[ "$RETAIN" -gt 0 ] || { echo "--retain must be at least 1" >&2; exit 2; }

if [ "$DRY" -eq 1 ]; then
  printf 'dry run: would create %s as 0700 if needed, write fedbench daily dump pairs, and retain %s day(s)\n' \
    "$OUT" "$RETAIN"
  printf 'summary: wrote nothing; size 0 bytes; duration 0s; retention not pruned (dry run)\n'
  exit 0
fi

fail=0
if [ ! -d "$OUT" ]; then
  # mkdir runs as the invoking service user. Creating it any other way leaves a root-owned backup
  # directory that later timer runs cannot write, which reads as a database dump failure.
  mkdir -m 700 "$OUT" && ok "created $OUT with mode 0700" \
    || bad "could not create $OUT with mode 0700"
fi
if [ -d "$OUT" ] && [ ! -O "$OUT" ]; then
  # Do not chown an existing directory: changing another service's ownership to make a backup work
  # hides a deployment mistake and later reads as a missing or overwritten backup.
  bad "$OUT is not owned by the invoking service user"
elif [ -d "$OUT" ]; then
  chmod 700 "$OUT" && ok "$OUT is owned by this service user and mode 0700" \
    || bad "could not set $OUT to mode 0700"
fi

if [ "$fail" -gt 0 ]; then
  printf '\033[31mbackup not attempted; output directory is unsafe. Retention was not pruned.\033[0m\n'
  exit 1
fi

day=$(date +%F)
archive="$OUT/fedbench-$day.dump"
sql="$OUT/fedbench-$day.sql.gz"
archive_tmp=$(mktemp "$OUT/.fedbench-$day.dump.XXXXXX") || { bad "could not create a temporary custom archive"; archive_tmp=""; }
sql_tmp=$(mktemp "$OUT/.fedbench-$day.sql.gz.XXXXXX") || { bad "could not create a temporary SQL archive"; sql_tmp=""; }
cleanup() {
  # Remove only unpublished temporaries. Leaving a truncated temporary file reads as an extra backup
  # to an operator who lists the directory, while it was never validated or retained.
  [ -n "${archive_tmp:-}" ] && rm -f "$archive_tmp"
  [ -n "${sql_tmp:-}" ] && rm -f "$sql_tmp"
}
trap cleanup EXIT

started=$(date +%s)
archive_ok=0
sql_ok=0
if [ -n "$archive_tmp" ]; then
  if "$PG_DUMP" -Fc -d "$DB" -f "$archive_tmp" && [ -s "$archive_tmp" ]; then
    # pg_restore --list opens the archive now; a non-empty truncated file otherwise reads as a good
    # backup until the first restore attempt, when the source database may already be gone.
    if "$PG_RESTORE" --list "$archive_tmp" >/dev/null 2>&1; then
      archive_ok=1
      ok "custom archive is non-empty and pg_restore can read it"
    else
      bad "pg_restore cannot read the custom archive"
    fi
  else
    bad "pg_dump custom archive failed or produced an empty file"
  fi
fi
if [ -n "$sql_tmp" ]; then
  if "$PG_DUMP" -d "$DB" | gzip -c >"$sql_tmp" && [ -s "$sql_tmp" ] && gzip -t "$sql_tmp"; then
    sql_ok=1
    ok "SQL gzip twin is non-empty and gzip can read it"
  else
    bad "pg_dump SQL twin failed, was empty, or gzip cannot read it"
  fi
fi

published=0
if [ "$archive_ok" -eq 1 ] && [ "$sql_ok" -eq 1 ]; then
  if mv -f "$archive_tmp" "$archive" && mv -f "$sql_tmp" "$sql"; then
    archive_tmp=""
    sql_tmp=""
    published=1
    ok "published $archive and $sql"
  else
    bad "could not publish both verified dump files"
  fi
fi

removed=0
if [ "$published" -eq 1 ] && [ "$fail" -eq 0 ]; then
  shopt -s nullglob
  dumps=("$OUT"/fedbench-????-??-??.dump)
  shopt -u nullglob
  mapfile -t dumps < <(printf '%s\n' "${dumps[@]}" | sort -r)
  for ((i = RETAIN; i < ${#dumps[@]}; i++)); do
    old_archive=${dumps[$i]}
    old_sql=${old_archive%.dump}.sql.gz
    # Delete a pair by its dated custom archive. Removing only one format makes retention look met
    # while silently taking away the human-readable escape hatch the twin exists to preserve.
    if rm -f "$old_archive" "$old_sql"; then
      printf '  removed %s and %s\n' "$old_archive" "$old_sql"
      removed=$((removed + 1))
    else
      bad "could not remove expired backup pair $old_archive and $old_sql"
    fi
  done
else
  printf 'retention not pruned because the current backup did not succeed\n'
fi

ended=$(date +%s)
duration=$((ended - started))
if [ "$fail" -gt 0 ] || [ "$published" -eq 0 ]; then
  printf '\033[31msummary: backup failed; wrote no verified new pair; duration %ss; retention removed %s pair(s)\033[0m\n' \
    "$duration" "$removed"
  exit 1
fi
size=$(du -ch "$archive" "$sql" | awk 'END { print $1 }')
printf '\033[32msummary: wrote %s and %s; total size %s; duration %ss; retention removed %s pair(s)\033[0m\n' \
  "$archive" "$sql" "$size" "$duration" "$removed"
