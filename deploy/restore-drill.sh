#!/usr/bin/env bash
# Restore the newest fedbench archive into an isolated scratch database, compare seeded rows, and
# remove it again. A dump that has never restored is only a hypothesis.
#
#   bash deploy/restore-drill.sh
#   bash deploy/restore-drill.sh --dump /srv/fedbench/backups/fedbench-2026-09-14.dump
#   bash deploy/restore-drill.sh --check
#
# Undo: the scratch database is dropped on every normal or failed run by the EXIT trap. --check
# creates no database and changes no backup, service, configuration, or live database row.
set -uo pipefail

DB=fedbench
BACKUPS=/srv/fedbench/backups
CHECK=0
DUMP=""
PSQL=/usr/pgsql-17/bin/psql
PG_RESTORE=/usr/pgsql-17/bin/pg_restore
CREATEDB=/usr/pgsql-17/bin/createdb
DROPDB=/usr/pgsql-17/bin/dropdb
fail=0
SCRATCH=""

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
usage() {
  cat <<'EOF'
Usage: bash deploy/restore-drill.sh [--dump PATH] [--backups PATH] [--check]

Restore the newest fedbench custom archive into a generated scratch database, compare seeded vault
table counts with the live fedbench database, and drop the scratch database. --dump selects a
specific custom archive; otherwise the newest *.dump under --backups (default:
/srv/fedbench/backups) is used. Its same-day .sql.gz twin is checked too.

--check performs only capability and archive checks. It creates no scratch database and changes no
database, backup, service, or configuration.
EOF
}

cleanup() {
  local status=$?
  if [ -n "$SCRATCH" ]; then
    # --force disconnects only scratch clients. Without it a failed diagnostic session leaves the
    # drill debris behind, which eventually reads as a real database someone is afraid to remove.
    if "$DROPDB" --maintenance-db=postgres --force "$SCRATCH" >/dev/null 2>&1; then
      ok "dropped scratch database $SCRATCH"
    else
      bad "could not drop scratch database $SCRATCH"
      status=1
    fi
    SCRATCH=""
  fi
  return "$status"
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --dump)
      [ $# -ge 2 ] || { echo "--dump needs a path" >&2; exit 2; }
      DUMP=$2
      shift 2
      ;;
    --backups)
      [ $# -ge 2 ] || { echo "--backups needs a path" >&2; exit 2; }
      BACKUPS=$2
      shift 2
      ;;
    --check)
      CHECK=1
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

step "1. Assertions -- select a current backup and prove the tools can use it"
if [ -z "$DUMP" ]; then
  shopt -s nullglob
  dumps=("$BACKUPS"/*.dump)
  shopt -u nullglob
  if [ "${#dumps[@]}" -gt 0 ]; then
    # mtime, rather than a filename sort, detects a nightly job that wrote yesterday's name today.
    DUMP=$(printf '%s\n' "${dumps[@]}" | xargs -r -n1 stat -c '%Y %n' | sort -nr | cut -d' ' -f2- | awk 'NR == 1')
  else
    bad "no *.dump archive is readable under $BACKUPS"
  fi
fi

SQL_GZ=""
if [ -n "$DUMP" ]; then
  case "$DUMP" in
    *.dump) SQL_GZ=${DUMP%.dump}.sql.gz ;;
    *) bad "custom archive must end in .dump: $DUMP" ;;
  esac
  if [ -r "$DUMP" ]; then
    now=$(date +%s)
    modified=$(stat -c %Y "$DUMP" 2>/dev/null)
    case "$modified" in
      ''|*[!0-9]*) bad "cannot read modification time for $DUMP" ;;
      *)
        age=$((now - modified))
        ok "selected $DUMP; age ${age}s"
        ;;
    esac
    "$PG_RESTORE" --list "$DUMP" >/dev/null 2>&1 \
      && ok "pg_restore can read the selected custom archive" \
      || bad "pg_restore cannot read the selected custom archive"
  else
    bad "cannot read selected custom archive $DUMP"
  fi
fi

if [ -n "$SQL_GZ" ] && [ -r "$SQL_GZ" ]; then
  gzip -t "$SQL_GZ" && ok "gzip can read same-day SQL twin $SQL_GZ" \
    || bad "gzip cannot read same-day SQL twin $SQL_GZ"
  # gzip -t alone accepts a schema-only dump. Require COPY or INSERT data so DDL-only output does
  # not look like a usable backup after RLS or a dump option silently excluded all rows.
  gzip -cd "$SQL_GZ" 2>/dev/null | grep -Eq '^(COPY|INSERT[[:space:]]+INTO)[[:space:]]'
  payload_status=("${PIPESTATUS[@]}")
  if [ "${payload_status[0]}" -eq 0 ] && [ "${payload_status[1]}" -eq 0 ]; then
    ok "same-day SQL twin contains COPY or INSERT data"
  else
    bad "same-day SQL twin has no readable COPY or INSERT data"
  fi
else
  bad "cannot read same-day SQL twin $SQL_GZ"
fi

for tool in "$PSQL" "$PG_RESTORE" "$CREATEDB" "$DROPDB"; do
  # Running --version asserts this account can execute the intended PostgreSQL 17 client; testing
  # only that a pathname exists lets the Siemens Calibre client win later and mislabels it a restore failure.
  "$tool" --version >/dev/null 2>&1 && ok "can execute $tool" || bad "cannot execute $tool"
done

step "2. Assertions -- read non-empty seeded source tables"
tables=(field_definitions option_values measurement_kinds metric_definitions)
declare -A live_counts=()
for table in "${tables[@]}"; do
  count=$("$PSQL" -X -At -v ON_ERROR_STOP=1 -d "$DB" -c "select count(*) from vault.$table" 2>/dev/null)
  case "$count" in
    ''|*[!0-9]*) bad "could not count live vault.$table" ;;
    0) bad "live vault.$table has zero rows; a zero source cannot prove a restore" ;;
    *) live_counts[$table]=$count; ok "live vault.$table has $count row(s)" ;;
  esac
done

if [ "$CHECK" -eq 1 ]; then
  if [ "$fail" -gt 0 ]; then
    printf '\n\033[31mVERDICT: restore drill CHECK FAILED (%d failure(s)); nothing was changed.\033[0m\n' "$fail"
    exit 1
  fi
  printf '\n\033[32mVERDICT: restore drill CHECK PASSED; nothing was changed.\033[0m\n'
  exit 0
fi

step "3. Create an isolated scratch database"
# This name is constructed here, never accepted from an argument. The fixed restore-drill prefix
# makes it visibly disposable, and the equality check prevents a future edit from targeting fedbench.
SCRATCH="fedbench_restore_drill_$(date +%s)_$$_${RANDOM}"
# `case`, NOT `[ "$x" != prefix_* ]`. `[` compares STRINGS: the `*` is a literal character, so that
# test is true for every possible name and the guard fired on every run -- the drill would refuse to
# create a scratch database, restore nothing, and report a refusal that reads as caution rather than
# as a drill that never ran. (Unquoted, the `*` is also a pathname glob against the working
# directory, so the comparison could change meaning depending on where the script was invoked.)
# `case` is the construct that actually pattern-matches in POSIX shell.
scratch_ok=0
case "$SCRATCH" in
  "$DB") : ;;                          # identical to the live database: refuse
  fedbench_restore_drill_*) scratch_ok=1 ;;
esac
if [ "$scratch_ok" -ne 1 ]; then
  bad "refusing to create scratch database name $SCRATCH because it could be $DB"
  SCRATCH=""
elif "$CREATEDB" --maintenance-db=postgres "$SCRATCH" >/dev/null 2>&1; then
  ok "created isolated scratch database $SCRATCH"
else
  bad "could not create scratch database $SCRATCH"
  SCRATCH=""
fi

step "4. Restore and compare seeded table counts"
if [ -n "$SCRATCH" ] && [ -r "$DUMP" ]; then
  # KEEP --exit-on-error: without it pg_restore prints "WARNING: errors ignored on restore: N" and
  # exits 0, so a scheduled exit-status check certifies a half-restored database forever.
  if "$PG_RESTORE" --exit-on-error --no-owner --no-privileges -d "$SCRATCH" "$DUMP" >/dev/null 2>&1; then
    ok "pg_restore completed with --exit-on-error"
  else
    bad "pg_restore failed; scratch database was not fully restored"
  fi
  for table in "${tables[@]}"; do
    count=$("$PSQL" -X -At -v ON_ERROR_STOP=1 -d "$SCRATCH" -c "select count(*) from vault.$table" 2>/dev/null)
    case "$count" in
      ''|*[!0-9]*) bad "could not count restored vault.$table" ;;
      0) bad "restored vault.$table has zero rows; schema without rows is not a backup" ;;
      "${live_counts[$table]:-missing}") ok "restored vault.$table matches live count $count" ;;
      *) bad "restored vault.$table has $count row(s), live has ${live_counts[$table]:-unknown}" ;;
    esac
  done
else
  bad "restore was not attempted because no scratch database or readable archive is available"
fi

# Drop before the verdict so a cleanup failure cannot be reported as a passing drill. The EXIT trap
# remains armed for signals and unexpected exits between create and this explicit cleanup.
cleanup
if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mVERDICT: restore drill FAILED (%d failure(s)); scratch database removed.\033[0m\n' "$fail"
  exit 1
fi
printf '\n\033[32mVERDICT: restore drill PASSED; scratch database removed.\033[0m\n'
