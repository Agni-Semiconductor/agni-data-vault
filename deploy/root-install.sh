#!/usr/bin/env bash
# The root half of standing up the vault data plane on edaserver.
#
# Run it once, as root, on edaserver. It is idempotent: re-running changes nothing that already
# matches. Everything it does is reversible with `systemctl disable --now` plus the removals
# listed at the end.
#
#   sudo bash root-install.sh --check        # assertions only. Changes NOTHING. Run this first.
#   sudo bash root-install.sh
#
# ─── WHY THIS IS A SCRIPT AND NOT A LIST OF COMMANDS ───────────────────────────────────────
# Half of these steps fail in ways that look like a different problem. Missing
# `httpd_can_network_connect` is a 502 that reads as a dead upstream. A unit installed with `mv`
# keeps its SELinux context and systemd refuses it with a message about the file, not the
# context. A JWT secret that differs between PostgREST and fed_storage produces "metadata reads
# succeed, downloads 401", which reads as a corrupt archive. Each step here verifies itself.
#
# ─── WHAT IT TOUCHES, AND NOTHING ELSE ─────────────────────────────────────────────────────
#   /usr/local/bin/postgrest
#   /srv/fedbench/objects                     (created, owned fedbackup)
#   /etc/systemd/system/fed-postgrest.service
#   /etc/systemd/system/fed-storage.service
#   /etc/nginx/conf.d/nginx-fedbench.conf
#   SELinux: one boolean, one port label
#   the fedbackup venv (pip install of the already-declared `storage` extra, as fedbackup)
#   secrets.env (appends the JWT secret and PGRST_DB_URI if absent; never rewrites an existing one)
#
# It does not read, list or modify anything under /home, /storage/home or /home/shared. This box
# is somebody's EDA machine first.
set -uo pipefail

REPO=/srv/fedbackup/ferrodiode-pcb-testbench
SECRETS=$REPO/server/config/secrets.env
VENV=$REPO/server/.venv/bin/python
PGRST_SRC=${PGRST_SRC:-/home/agnidata/work/bin/postgrest}
OBJROOT=/srv/fedbench/objects
PSQL=/usr/pgsql-17/bin/psql
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "0. Assertions — every one of these is something that breaks a later step invisibly"
# ══════════════════════════════════════════════════════════════════════════════════════════
[ "$(uname -m)" = x86_64 ] && ok "x86_64" || bad "not x86_64 — the PostgREST binary will not execute"
systemctl is-active --quiet postgresql-17 && ok "postgresql-17 running" || bad "postgresql-17 is not running"

# The chain must already be applied. Standing up an endpoint over a database that has not been
# migrated gives you a working HTTP service that 404s every table -- which reads as a broken
# endpoint rather than an empty database.
n=$(sudo -u postgres "$PSQL" -tAX -d fedbench -c "select count(*) from migrations.applied" 2>/dev/null)
[ "${n:-0}" -ge 19 ] && ok "fedbench has $n migrations applied" || bad "fedbench has ${n:-no} migrations applied — run deploy/apply-migrations.sh first"

# The repo checkout the units run from.
[ -d "$REPO" ] && ok "repo checkout at $REPO" || bad "no repo checkout at $REPO — the units' WorkingDirectory does not exist"

# THE SECRET IS SHARED AND MUST NOT BE REGENERATED. PostgREST verifies tokens with it and
# fed_storage verifies the SAME tokens with it; replace it once tokens are out and metadata reads
# keep working while every object download 401s -- which reads as a corrupt archive rather than a
# mismatched key. An EXISTING value is therefore never touched. An ABSENT one is minted, because
# on a box that has never issued a token there is nothing to break.
if [ -r "$SECRETS" ]; then
  ok "secrets.env readable"
  if grep -qE '^(FED_)?PGRST_JWT_SECRET=' "$SECRETS"; then
    ok "a JWT secret is already defined there (value not printed)"
    len=$(grep -E '^(FED_)?PGRST_JWT_SECRET=' "$SECRETS" | head -1 | cut -d= -f2- | tr -d '"' | wc -c)
    # PostgREST refuses to start below 32 characters. That is the one misconfiguration in this
    # stack that fails loudly, so it is worth catching here rather than in a restart loop.
    [ "$len" -gt 32 ] && ok "secret is longer than 32 characters" || bad "secret is $((len-1)) characters — PostgREST requires 32 and will refuse to start"
    MINT_SECRET=0
  else
    # ABSENT IS FINE ON A GREENFIELD BOX, and the first version of this check got that wrong.
    # The rule is not "never create a secret" -- it is "never create a SECOND one". Nothing here
    # has ever served a token: PostgREST and fed_storage are not installed and the bench still
    # talks to hosted Supabase. So one is minted below and written once.
    #
    # After that it is fixed forever. PostgREST verifies with it, fed_storage verifies the SAME
    # tokens with it, and every token handed to the Pi or to agni-connect is signed with it.
    # Regenerating gives you working metadata reads and 401 on every object download, which reads
    # as a corrupt archive rather than a mismatched key.
    warn "no JWT secret yet — one will be minted (nothing has been issued from this box, so this is the safe moment)"
    MINT_SECRET=1
  fi
  grep -qE '^PGRST_DB_URI=' "$SECRETS" && ok "PGRST_DB_URI defined" \
    || warn "no PGRST_DB_URI in secrets.env — add postgres://authenticator:<pw>@127.0.0.1:5432/fedbench (see step 3)"
else
  bad "cannot read $SECRETS"
fi

# fed_storage is a Starlette app served by uvicorn, and the system python 3.9.25 has neither.
# The dependencies ARE declared -- `storage` is an optional-dependency group in server/pyproject
# -- the venv simply was not installed with it. So this is one pip command, not a hunt.
if [ -x "$VENV" ]; then
  missing=""
  for m in starlette uvicorn psycopg; do
    "$VENV" -c "import $m" 2>/dev/null || missing="$missing $m"
  done
  if [ -z "$missing" ]; then
    ok "venv python has starlette, uvicorn and psycopg"
    INSTALL_EXTRA=0
  else
    # psycopg alone is not fatal -- fed_storage serves objects without it and reports zero usage
    # -- but the vault's `files` rows reference bench_storage.objects, so zero metadata is wrong
    # here in a way it is not on the bench.
    warn "venv is missing:$missing — will install the 'storage' extra"
    INSTALL_EXTRA=1
  fi
else
  bad "no venv at $VENV, and the system python 3.9 lacks starlette/uvicorn"
fi

[ -x "$PGRST_SRC" ] && ok "PostgREST binary staged at $PGRST_SRC ($("$PGRST_SRC" --version 2>/dev/null))" \
  || bad "no PostgREST binary at $PGRST_SRC"

for p in 3000 3001 8087; do
  ss -lnt 2>/dev/null | grep -q ":$p " && bad "port $p already in use" || ok "port $p free"
done

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31m%d assertion(s) failed. Nothing was changed.\033[0m\n' "$fail"
  echo "Fix them and re-run. Each one above breaks a later step in a way that looks like something else."
  exit 1
fi
[ "$CHECK_ONLY" = 1 ] && { printf '\n\033[32mAll assertions pass. Re-run without --check to install.\033[0m\n'; exit 0; }

# ══════════════════════════════════════════════════════════════════════════════════════════
step "1. The PostgREST binary"
# ══════════════════════════════════════════════════════════════════════════════════════════
install -m 0755 -o root -g root "$PGRST_SRC" /usr/local/bin/postgrest && ok "installed /usr/local/bin/postgrest"
restorecon /usr/local/bin/postgrest 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════════════════════════
step "2. The live object root — which is NOT the archive"
# ══════════════════════════════════════════════════════════════════════════════════════════
# /srv/nextcloud/fedbench/objects is the nightly COLD ARCHIVE, on a single 7.3 T disk with no
# redundancy. Serving it live would make the archive and the primary the same directory, and then
# a bug in the writer damages the only copy. The live store goes on `/`, which is RAID1.
install -d -m 0750 -o fedbackup -g fedbackup /srv/fedbench "$OBJROOT" && ok "created $OBJROOT (fedbackup, 0750)"
restorecon -R /srv/fedbench 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════════════════════════
step "2b. The fed_storage dependencies"
# ══════════════════════════════════════════════════════════════════════════════════════════
if [ "${INSTALL_EXTRA:-0}" = 1 ]; then
  # As fedbackup, into fedbackup's venv. Running pip as root into somebody else's virtualenv
  # leaves root-owned files in it that the service user then cannot update.
  sudo -u fedbackup "$VENV" -m pip install --quiet --upgrade "$REPO/server[storage]"     && ok "installed the storage extra into the venv"     || bad "pip install failed — see above"
  for m in starlette uvicorn psycopg; do
    "$VENV" -c "import $m" 2>/dev/null && ok "  import $m" || bad "  $m still missing"
  done
else
  ok "venv already has what fed_storage needs"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "3. The shared JWT secret, and the authenticator role"
# ══════════════════════════════════════════════════════════════════════════════════════════
# PostgREST connects as `authenticator` and SET ROLEs to whatever a token names. The role exists
# but is NOLOGIN until it has a password. This does NOT print or store the password anywhere
# except secrets.env, which is already the file holding the JWT secret.
if [ "${MINT_SECRET:-0}" = 1 ]; then
  SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)
  umask 077
  {
    printf '
# The data plane JWT secret. PostgREST verifies tokens with it and fed_storage
'
    printf '# verifies the SAME tokens with it. Minted %s on a box that had never issued one.
' "$(date -I)"
    printf '# NEVER REGENERATE: metadata reads keep working and every object download 401s,
'
    printf '# which reads as a corrupt archive rather than a mismatched key.
'
    printf 'PGRST_JWT_SECRET=%s
' "$SECRET"
    printf 'FED_PGRST_JWT_SECRET=%s
' "$SECRET"
  } >> "$SECRETS"
  chown fedbackup:fedbackup "$SECRETS"; chmod 0600 "$SECRETS"
  ok "minted the shared JWT secret and wrote it to secrets.env (value not printed)"
  unset SECRET
fi

if grep -qE '^PGRST_DB_URI=' "$SECRETS"; then
  ok "PGRST_DB_URI already present — leaving the authenticator password alone"
else
  PW=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
  sudo -u postgres "$PSQL" -q -d fedbench -c "alter role authenticator with login password '$PW'" \
    && ok "authenticator given a password"
  umask 077
  printf 'PGRST_DB_URI=postgres://authenticator:%s@127.0.0.1:5432/fedbench\n' "$PW" >> "$SECRETS"
  chown fedbackup:fedbackup "$SECRETS"; chmod 0600 "$SECRETS"
  ok "PGRST_DB_URI appended to secrets.env (0600, fedbackup)"
  unset PW
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "4. Unit files and the nginx shim"
# ══════════════════════════════════════════════════════════════════════════════════════════
# `cp`, NEVER `mv`. A moved file keeps its source SELinux context and systemd then refuses to load
# it, reporting a problem with the unit rather than with the label.
for u in fed-postgrest.service fed-storage.service; do
  cp -f "$REPO/server/deploy/$u" /etc/systemd/system/ && ok "installed $u"
done
# Kept byte-identical. Its two trailing-slash rules -- slash on the PostgREST target, none on
# storage -- are the entire reason existing clients need no change. Re-encoding them elsewhere
# moves documented, tested behaviour into an untested file.
cp -f "$REPO/server/deploy/nginx-fedbench.conf" /etc/nginx/conf.d/ && ok "installed nginx-fedbench.conf verbatim"
restorecon /etc/systemd/system/fed-*.service /etc/nginx/conf.d/nginx-fedbench.conf 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════════════════════════
step "5. SELinux — both of these fail as something else entirely"
# ══════════════════════════════════════════════════════════════════════════════════════════
# Without the boolean, nginx proxying to a loopback port is DENIED and you get a 502 that looks
# like a dead upstream. Without the port label, nginx cannot bind 8087 at all.
setsebool -P httpd_can_network_connect 1 && ok "httpd_can_network_connect on"
if semanage port -l 2>/dev/null | grep -qE '^http_port_t.*\b8087\b'; then
  ok "8087 already labelled http_port_t"
else
  semanage port -a -t http_port_t -p tcp 8087 2>/dev/null && ok "labelled 8087 http_port_t" \
    || warn "could not label 8087 — install policycoreutils-python-utils"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════
step "6. Start them"
# ══════════════════════════════════════════════════════════════════════════════════════════
systemctl daemon-reload
nginx -t 2>&1 | tail -2 | sed 's/^/      /'
for s in fed-postgrest fed-storage nginx; do
  systemctl enable --now "$s" >/dev/null 2>&1
  systemctl is-active --quiet "$s" && ok "$s active" || { bad "$s failed"; journalctl -u "$s" -n 8 --no-pager | sed 's/^/      /'; }
done

# ══════════════════════════════════════════════════════════════════════════════════════════
step "7. Verify — and a 200 is not a verification"
# ══════════════════════════════════════════════════════════════════════════════════════════
# Every vault table has RLS enabled with NO POLICIES, so a role provisioned without BYPASSRLS
# returns an empty array from everything while the service reports success. The check below reads
# a table that is SEEDED and therefore never legitimately empty.
code=$(curl -sS -o /tmp/rootcheck.$$ -w '%{http_code}' "http://127.0.0.1:8087/rest/v1/" 2>/dev/null)
[ "$code" = 200 ] && ok "nginx -> PostgREST reachable (HTTP $code)" || bad "nginx -> PostgREST returned $code"
rm -f /tmp/rootcheck.$$
echo
echo "Next, as agnidata, with a minted token:"
echo "  curl -s localhost:8087/rest/v1/health -H 'Accept-Profile: connect' -H \"Authorization: Bearer \$JWT\""
echo "  -> n_samples must be a REAL NUMBER. Zero here means a role lost BYPASSRLS and the"
echo "     database looks empty rather than unauthorised."

printf '\n\033[1mTo undo everything:\033[0m\n'
cat <<'UNDO'
  systemctl disable --now fed-postgrest fed-storage nginx
  rm -f /etc/systemd/system/fed-{postgrest,storage}.service /etc/nginx/conf.d/nginx-fedbench.conf
  rm -f /usr/local/bin/postgrest
  systemctl daemon-reload
  # /srv/fedbench and the secrets.env line are left deliberately -- removing them loses the
  # object root and the authenticator password, neither of which is recreated by a re-run.
UNDO
[ "$fail" -gt 0 ] && exit 1 || exit 0
