#!/usr/bin/env bash
set -uo pipefail
# Create agni-connect's OWN database and roles on the shared cluster. Nothing in fedbench changes.
#
#   sudo bash deploy/connect-db-bootstrap.sh --check
#   sudo bash deploy/connect-db-bootstrap.sh
#   sudo bash deploy/connect-db-bootstrap.sh --api-login connect_api    # also a LOGIN role, password printed ONCE
#
# WHY A SEPARATE DATABASE. docs/CONNECT_AGENT_HANDOFF.md §8 and docs/PLATFORM_BLUEPRINT.md §8: a
# fast-iterating product must not run migrations inside the database holding measurement data, and
# a logical restore of one must never imply restoring the other. Roles are CLUSTER-WIDE, so theirs
# are prefixed connect_ and can never collide with vault_* or the bench's.
#
# WHAT IT CREATES, idempotently:
#   connect_owner   NOLOGIN   owns agni_devops and everything agni-connect's migrations create
#   connect_app     NOLOGIN   what their API runs as, by SET ROLE or membership
#   agni_devops               owned by connect_owner; CONNECT revoked from PUBLIC, granted to connect_app
#   [--api-login N] LOGIN     member of connect_app, generated password printed once, for their libpq
#
# It does not touch fedbench, does not grant anything on connect/vault/public to these roles, and
# does not install PostgREST for this database (PostgREST serves exactly one database; theirs talks
# libpq -- see the handoff).
#
# THE psql PATH IS ABSOLUTE. Siemens Calibre ships its own psql ahead of the real one on PATH on this
# host; a bare `psql` here would run whatever the EDA toolchain bundles against the wrong server.
#
# Undo: DROP DATABASE agni_devops; DROP ROLE connect_app, connect_owner (and the login role). That
# deletes agni-connect's data; it is theirs to decide.

DB=agni_devops
OWNER=connect_owner
APP=connect_app
LOGIN=""
CHECK=0
fail=0
warns=0
# Overridable only for a container harness. On the box this runs psql as the postgres OS user.
PSQL=${PSQL:-"runuser -u postgres -- /usr/pgsql-17/bin/psql"}

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
usage() { sed -n '3,7p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --api-login)
      [ $# -ge 2 ] || { echo "--api-login needs a role name" >&2; exit 2; }
      LOGIN=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }
case "$LOGIN" in
  "") ;;
  connect_[a-z_]*) ;;
  *) echo "--api-login must start with connect_ (roles are cluster-wide; the prefix is the namespace)" >&2; exit 2 ;;
esac

# One statement, no output decoration, so results can be compared as strings.
q() { $PSQL -X -q -A -t -v ON_ERROR_STOP=1 -d postgres -c "$1" 2>/dev/null; }
run() { $PSQL -X -q -v ON_ERROR_STOP=1 -d postgres -c "$1" >/dev/null 2>&1; }

step "1. Assertions -- the cluster"
v=$(q "select current_setting('server_version')")
case "$v" in
  17.*) ok "PostgreSQL $v, reached as $(q 'select current_user')" ;;
  "")   bad "could not reach the cluster with: $PSQL" ;;
  *)    bad "PostgreSQL $v is not the 17.x cluster this was written against" ;;
esac
[ "$(q "select 1 from pg_database where datname='fedbench'")" = "1" ] && ok "fedbench exists on this cluster (so this is the right one)" || bad "no fedbench database here -- wrong cluster?"
[ "$(q "select 1 from pg_roles where rolname='connect_read'")" = "1" ] && ok "connect_read exists (migration 0118 has been applied)" || warn "connect_read is absent: 0118 not applied; this script does not need it, agni-connect does"

step "2. Current state"
have_owner=$(q "select 1 from pg_roles where rolname='$OWNER'")
have_app=$(q "select 1 from pg_roles where rolname='$APP'")
have_db=$(q "select 1 from pg_database where datname='$DB'")
[ "$have_owner" = "1" ] && ok "$OWNER exists" || ok "$OWNER absent (will be created)"
[ "$have_app" = "1" ]   && ok "$APP exists"   || ok "$APP absent (will be created)"
if [ "$have_db" = "1" ]; then
  o=$(q "select pg_get_userbyid(datdba) from pg_database where datname='$DB'")
  [ "$o" = "$OWNER" ] && ok "$DB exists, owned by $OWNER" || bad "$DB exists but is owned by $o, not $OWNER -- resolve by hand"
else
  ok "$DB absent (will be created)"
fi
if [ -n "$LOGIN" ]; then
  [ "$(q "select 1 from pg_roles where rolname='$LOGIN'")" = "1" ] && bad "$LOGIN already exists; this script will not reset a password it did not just make" || ok "$LOGIN absent (will be created)"
fi

if [ "$CHECK" -eq 1 ]; then
  [ "$fail" -eq 0 ] && { printf '\n\033[32mVERDICT: CHECK PASSED (%d warn(s)); nothing was changed.\033[0m\n' "$warns"; exit 0; }
  printf '\n\033[31mVERDICT: CHECK FAILED (%d failure(s)); nothing was changed.\033[0m\n' "$fail"; exit 1
fi
[ "$fail" -eq 0 ] || { printf '\n\033[31mRefusing to proceed with %d failed assertion(s).\033[0m\n' "$fail"; exit 1; }

step "3. Roles"
[ "$have_owner" = "1" ] || { run "create role $OWNER nologin" && ok "created $OWNER" || bad "could not create $OWNER"; }
[ "$have_app" = "1" ]   || { run "create role $APP nologin"   && ok "created $APP"   || bad "could not create $APP"; }
run "comment on role $OWNER is 'agni-connect: owns agni_devops and its schema. NOLOGIN.'"
run "comment on role $APP is 'agni-connect: what its API acts as. NOLOGIN; a LOGIN role is granted membership.'"

step "4. Database"
if [ "$have_db" != "1" ]; then
  # CREATE DATABASE cannot run inside a transaction block; -c is one statement, which is fine.
  run "create database $DB owner $OWNER" && ok "created $DB owned by $OWNER" || bad "could not create $DB"
fi
# PUBLIC gets CONNECT on every new database by default. Take it back: the bench's and the vault's
# roles have no business connecting here, and a role that cannot connect fails loudly.
run "revoke all on database $DB from public" && ok "revoked PUBLIC on $DB" || bad "could not revoke PUBLIC on $DB"
run "grant connect, temporary on database $DB to $APP" && ok "granted CONNECT to $APP" || bad "could not grant CONNECT to $APP"
run "grant $APP to $OWNER" >/dev/null 2>&1 || true
# Inside the new database: the public schema is theirs to shape, so only the owner may create in it.
$PSQL -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "revoke create on schema public from public" -c "grant usage on schema public to $APP" >/dev/null 2>&1 \
  && ok "public schema in $DB: CREATE revoked from PUBLIC, USAGE granted to $APP" \
  || bad "could not set schema privileges inside $DB"

if [ -n "$LOGIN" ]; then
  step "5. The LOGIN role for their API"
  PW=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  if run "create role $LOGIN login password '$PW' in role $APP"; then
    ok "created $LOGIN (LOGIN, member of $APP)"
    printf '\n\033[33mPassword for %s, printed ONCE and stored nowhere by this script:\033[0m\n%s\n\n' "$LOGIN" "$PW"
    printf 'libpq: postgresql://%s@127.0.0.1:5432/%s   (loopback only; the cluster does not listen elsewhere)\n' "$LOGIN" "$DB"
  else
    bad "could not create $LOGIN"
  fi
  unset PW
fi

step "6. Assertions -- prove it"
[ "$(q "select pg_get_userbyid(datdba) from pg_database where datname='$DB'")" = "$OWNER" ] && ok "$DB is owned by $OWNER" || bad "$DB owner is wrong"
[ "$(q "select has_database_privilege('$APP','$DB','CONNECT')")" = "t" ] && ok "$APP can CONNECT to $DB" || bad "$APP cannot CONNECT to $DB"
# The isolation that matters: these roles hold nothing on the measurement database's schemas.
for s in vault connect public; do
  # A schema that does not exist makes has_schema_privilege() error, which read as a FAIL in the
  # harness (a fresh fedbench has no vault schema yet). Absent is a fact, not a privilege.
  r=$($PSQL -X -q -A -t -v ON_ERROR_STOP=1 -d fedbench -c "select case when exists (select 1 from pg_namespace where nspname='$s') then has_schema_privilege('$APP','$s','USAGE')::text else 'absent' end" 2>/dev/null)
  case "$s:$r" in
    public:true) ok "$APP has USAGE on fedbench.public via PUBLIC (default; it holds no table privilege there -- same as connect_read)" ;;
    *:false) ok "$APP has no USAGE on fedbench.$s" ;;
    *:absent) warn "fedbench has no schema $s on this cluster (fine in a harness; on edaserver it means the migrations are not applied)" ;;
    *) bad "$APP privilege on fedbench.$s reads '$r'" ;;
  esac
done
# PUBLIC holds CONNECT on fedbench by default, so these roles CAN open a session there and then read
# nothing: no table privilege, and RLS with no policies. Revoking PUBLIC's CONNECT on fedbench would be
# a cluster-wide change to the bench's database and is not this script's to make. Said out loud.
[ "$($PSQL -X -q -A -t -d postgres -c "select has_database_privilege('$APP','fedbench','CONNECT')" 2>/dev/null)" = "t" ] \
  && warn "$APP can CONNECT to fedbench (PUBLIC default) but holds no privilege inside it; left as is deliberately" \
  || ok "$APP cannot CONNECT to fedbench"
[ "$(q "select rolcanlogin from pg_roles where rolname='$OWNER'")" = "f" ] && ok "$OWNER cannot log in" || bad "$OWNER can log in"
[ "$(q "select rolcanlogin from pg_roles where rolname='$APP'")" = "f" ] && ok "$APP cannot log in" || bad "$APP can log in"

if [ "$fail" -gt 0 ]; then printf '\n\033[31mVERDICT: bootstrap FAILED (%d failure(s), %d warn(s)).\033[0m\n' "$fail" "$warns"; exit 1; fi
printf '\n\033[32mVERDICT: %s ready for agni-connect (%d warn(s)).\033[0m\n' "$DB" "$warns"
