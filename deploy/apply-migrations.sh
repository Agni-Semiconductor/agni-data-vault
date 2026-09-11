#!/usr/bin/env bash
# Apply the self-host migration chain, and keep a record of what was applied.
#
# WHY A LEDGER, WHEN THE CHAIN IS IDEMPOTENT.
# Every file in supabase/migrations/selfhost is written to be re-runnable -- `create table if not
# exists`, `on conflict do nothing`, `create or replace`. So the argument for a ledger is not "stop
# double-applying". It is this:
#
#   * A migration EDITED AFTER IT WAS APPLIED is invisible. It happened in this repo's own history:
#     0112 and 0113 were corrected after they had already run against a validation database, and
#     nothing anywhere would have told the next person that the file on disk no longer described
#     what was in their database. This script records a sha256 per file and REFUSES when one
#     changes, which turns a silent divergence into a stop.
#   * A half-applied chain leaves no trace. `ON_ERROR_STOP` aborts the failing file, and the next
#     person sees a database that is mostly right.
#   * "Which migrations does this box have" should be answerable from the box, not from a
#     changelog somebody maintained by hand.
#
# THE ERROR CHECK IS DELIBERATELY LOOSE, and that is the second lesson baked in here. psql prefixes
# its diagnostics with `psql:<file>:<line>: ERROR:`, so a check anchored with `^ERROR` matches
# NOTHING and a failed migration reports as clean. That exact bug hid a real failure in this repo
# for the length of one session. Grep for the word anywhere in the line.
#
#   bash deploy/apply-migrations.sh --db fedbench
#   bash deploy/apply-migrations.sh --db fedbench --dry-run
#   bash deploy/apply-migrations.sh --db val --psql-cmd "docker exec -i vaultval-pg psql"
#
# It does NOT create the database and it does NOT apply the bench's selfhost_schema.sql. Both are
# deliberate: creating a database is a decision, and the bench schema belongs to the other repo.
set -euo pipefail

DB=""
PSQL_CMD="psql"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations/selfhost"
DRY=0
ALLOW_EDITED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --db)           DB="$2"; shift 2 ;;
    --psql-cmd)     PSQL_CMD="$2"; shift 2 ;;
    --dir)          DIR="$2"; shift 2 ;;
    --dry-run)      DRY=1; shift ;;
    # Only after you have decided the edit is safe against THIS database. It records the new
    # digest; it does not re-apply anything you have not also re-run.
    --allow-edited) ALLOW_EDITED=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DB" ] || { echo "--db is required" >&2; exit 2; }
[ -d "$DIR" ] || { echo "migration directory not found: $DIR" >&2; exit 2; }

psql_q() { $PSQL_CMD -v ON_ERROR_STOP=1 -tAX -U postgres -d "$DB" -c "$1"; }
digest()  { sha256sum "$1" | cut -d' ' -f1; }

# The ledger lives in its own schema, not in `vault` (which the chain creates, so it cannot hold
# the record of the chain creating it) and not in `public` (the bench's copied wire contract, which
# this repo does not add to).
psql_q "
  create schema if not exists migrations;
  create table if not exists migrations.applied (
    filename    text primary key,
    sha256      text not null,
    applied_at  timestamptz not null default now(),
    applied_by  text not null default current_user,
    duration_ms integer
  );
  comment on table migrations.applied is
    'One row per self-host migration applied to this database. sha256 is of the FILE, so an edit '
    'after the fact is detectable -- which is the whole reason this table exists.';
" >/dev/null

mapfile -t FILES < <(ls "$DIR"/0*.sql | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "no migrations matched $DIR/0*.sql -- refusing to report success over an empty set" >&2; exit 2; }
printf 'database %s: %d migration files\n\n' "$DB" "${#FILES[@]}"

applied=0; skipped=0; failed=0; edited=0

for f in "${FILES[@]}"; do
  name="$(basename "$f")"
  sha="$(digest "$f")"
  prev="$(psql_q "select sha256 from migrations.applied where filename = '$name'" || true)"

  if [ -n "$prev" ] && [ "$prev" = "$sha" ]; then
    printf '  %-38s %s\n' "$name" "already applied"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -n "$prev" ] && [ "$prev" != "$sha" ]; then
    edited=$((edited + 1))
    if [ "$ALLOW_EDITED" -eq 0 ]; then
      printf '  %-38s \033[31mEDITED SINCE IT WAS APPLIED\033[0m\n' "$name"
      printf '      recorded %s\n      on disk  %s\n' "$prev" "$sha"
      echo
      echo "  This database was built from a different version of this file. Re-applying blindly"
      echo "  would leave it in a state neither version describes. Read the diff, decide whether"
      echo "  the change is safe to re-run here, then pass --allow-edited."
      failed=$((failed + 1))
      break
    fi
    printf '  %-38s %s\n' "$name" "edited; re-applying (--allow-edited)"
  fi

  if [ "$DRY" -eq 1 ]; then
    printf '  %-38s %s\n' "$name" "would apply"
    applied=$((applied + 1))
    continue
  fi

  start="$(date +%s%3N 2>/dev/null || echo 0)"
  # Capture stdout AND stderr: psql writes diagnostics to stderr, and a check that only reads
  # stdout sees a clean run for a file that failed.
  out="$($PSQL_CMD -v ON_ERROR_STOP=1 -q -U postgres -d "$DB" -f "$f" 2>&1 || true)"
  # Loose on purpose -- see the header. `^ERROR` matches nothing against psql's prefixed output.
  if printf '%s' "$out" | grep -qi 'error\|fatal'; then
    printf '  %-38s \033[31mFAILED\033[0m\n' "$name"
    printf '%s\n' "$out" | grep -i 'error\|fatal' | head -5 | sed 's/^/      /'
    failed=$((failed + 1))
    break
  fi
  end="$(date +%s%3N 2>/dev/null || echo 0)"
  ms=$(( end > start ? end - start : 0 ))

  psql_q "
    insert into migrations.applied (filename, sha256, duration_ms)
    values ('$name', '$sha', $ms)
    on conflict (filename) do update
      set sha256 = excluded.sha256, applied_at = now(), applied_by = current_user,
          duration_ms = excluded.duration_ms
  " >/dev/null
  printf '  %-38s applied in %s ms\n' "$name" "$ms"
  applied=$((applied + 1))
done

echo
printf '%d applied, %d already present, %d failed' "$applied" "$skipped" "$failed"
[ "$edited" -gt 0 ] && printf ', %d edited since application' "$edited"
echo

if [ "$failed" -gt 0 ]; then
  echo
  echo "STOPPED. The chain is ordered and later files assume earlier ones, so nothing after the"
  echo "failure was attempted -- fix it and run again rather than skipping past."
  exit 1
fi

# A count is not a verification. Name what should exist and check it does, so "19 applied" cannot
# mean "19 files ran and produced a database missing half its objects".
missing="$(psql_q "
  select string_agg(want, ', ')
    from (values ('vault'), ('connect')) as s(want)
   where not exists (select 1 from information_schema.schemata where schema_name = want)
" || true)"
if [ -n "$missing" ]; then
  echo "schemas missing after a clean run: $missing" >&2
  exit 1
fi
echo "schemas present: vault, connect"
psql_q "select '  ' || count(*) || ' migrations recorded, newest: ' || max(filename) from migrations.applied"
