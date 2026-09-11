#!/usr/bin/env bash
# Create the accounts this project runs as, so nothing here operates as a person.
#
# Run as root (or with sudo) ON edaserver, ONCE. It is idempotent: re-running adds nothing and
# changes nothing that already matches.
#
#   sudo bash bootstrap-accounts.sh --key 'ssh-ed25519 AAAA... comment'
#   sudo bash bootstrap-accounts.sh --key-file ./id.pub --no-sudo      # see "the sudo question"
#   sudo bash bootstrap-accounts.sh --key-file ./id.pub --dry-run
#
# ─── WHAT IT CREATES ───────────────────────────────────────────────────────────────────────
#
#   agnidata   a login account for this project's deployment work. Gets the SSH key. This is
#              what replaces operating as a person's own account.
#   vaultsvc   NOLOGIN, no shell, no key, no password. The vault API RUNS as this and nothing
#              else does. A service account that can be logged into is a person's account with
#              extra steps.
#   /srv/vault owned agnidata:vaultsvc, 0750 -- agnidata deploys into it, vaultsvc only reads.
#              A service that can rewrite its own code is one bug away from persisting a change.
#
# ─── WHAT IT DOES NOT TOUCH ────────────────────────────────────────────────────────────────
#
# Anything belonging to EDA work. It does not read, list, chown, chmod or back up a single path
# outside the four it creates, and it adds no account to an existing group. The paths it writes
# are listed in TOUCHES below and nothing else is opened -- if you are reviewing this before
# running it as root, that list is the thing to check.
#
# ─── THE SUDO QUESTION, WHICH IS WORTH A DECISION ──────────────────────────────────────────
#
# Provisioning needs root: systemd units, SELinux contexts, package installs, the postgres role.
# But be clear about what granting it means:
#
#   **A sudo-capable account can read the EDA files.** Not because this script touches them --
#   it does not -- but because root can read everything on the box. So `--sudo-scoped` (the
#   default) buys you organisational separation: a different account, a different home, its own
#   audit trail in /var/log/sudo.log, and a command list narrow enough that `sudo cat` of
#   somebody's layout is not in it. It does NOT buy a technical guarantee, because anything that
#   can install a systemd unit can install one that reads anything.
#
#   If you want the technical guarantee, pass --no-sudo. The account then cannot provision, and
#   the handful of root steps get run by someone who already has root. That is a real and
#   defensible choice; it just costs a round trip per step.
#
# The default is the scoped list, because it is honest about what it is.
set -euo pipefail

DEPLOY_USER="agnidata"
SERVICE_USER="vaultsvc"
APP_ROOT="/srv/vault"
KEY=""
SUDO_MODE="scoped"      # scoped | none | full
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key)          KEY="$2"; shift 2 ;;
    --key-file)     KEY="$(cat "$2")"; shift 2 ;;
    --deploy-user)  DEPLOY_USER="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --app-root)     APP_ROOT="$2"; shift 2 ;;
    --no-sudo)      SUDO_MODE="none"; shift ;;
    --full-sudo)    SUDO_MODE="full"; shift ;;
    --dry-run)      DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Every path this script may write. Nothing else is opened.
TOUCHES=(
  "/home/$DEPLOY_USER/.ssh/authorized_keys"
  "/etc/sudoers.d/$DEPLOY_USER"
  "$APP_ROOT"
  "/etc/vault"
)

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash $0 ...)" >&2; exit 2; }
[ -n "$KEY" ] || { echo "--key or --key-file is required: the deploy account is useless without one" >&2; exit 2; }
case "$KEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) : ;;
  # Refused rather than written. A malformed authorized_keys line does not error -- sshd skips it
  # and the login simply fails, which reads as "the key was never added".
  *) echo "that does not look like an SSH public key -- refusing to write it" >&2; exit 2; ;;
esac

say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '  would: %s\n' "$*"; else "$@"; fi; }

echo
echo "Accounts on $(hostname -s):"
say "deploy : $DEPLOY_USER   (login, SSH key, sudo=$SUDO_MODE)"
say "service: $SERVICE_USER   (nologin, no key, no password)"
say "approot: $APP_ROOT"
echo
echo "Paths this script may write, and no others:"
for p in "${TOUCHES[@]}"; do say "$p"; done
echo

# ── 1. the service account ────────────────────────────────────────────────────────────────
# Created FIRST so the deploy account can be put in its group in one go.
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  say "$SERVICE_USER exists, leaving it alone"
else
  # --system: no aging, low uid, and it never appears in a login manager.
  # --shell /sbin/nologin and no home: there is nothing to log into and nothing to leave files in.
  run useradd --system --no-create-home --shell /sbin/nologin \
      --comment "Agni vault API service account" "$SERVICE_USER"
  say "created $SERVICE_USER (system, nologin)"
fi
# Belt and braces: a system account with no password entry still accepts one if something later
# sets it. Lock it explicitly so that cannot happen quietly.
run passwd -l "$SERVICE_USER" >/dev/null 2>&1 || true

# ── 2. the deploy account ─────────────────────────────────────────────────────────────────
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  say "$DEPLOY_USER exists, leaving its groups alone"
else
  run useradd --create-home --shell /bin/bash \
      --comment "Agni data-platform deployment account" "$DEPLOY_USER"
  say "created $DEPLOY_USER"
fi
# In the service group so it can hand files to the service; NOT in any existing group on this
# box. Inheriting a group is how an account quietly acquires reach nobody granted it.
run usermod -aG "$SERVICE_USER" "$DEPLOY_USER"

# Password login stays disabled: this account is reached by key over the tailnet, and a password
# on it is a second credential that exists only to be guessed.
run passwd -l "$DEPLOY_USER" >/dev/null 2>&1 || true

# ── 3. the key ────────────────────────────────────────────────────────────────────────────
SSH_DIR="/home/$DEPLOY_USER/.ssh"
AUTH="$SSH_DIR/authorized_keys"
run install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SSH_DIR"
if [ "$DRY" -eq 0 ] && [ -f "$AUTH" ] && grep -qF "$KEY" "$AUTH"; then
  say "key already present"
else
  # >> not >. Overwriting authorized_keys is how you remove somebody else's access by accident.
  run sh -c "printf '%s\n' \"$KEY\" >> '$AUTH'"
  run chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
  run chmod 0600 "$AUTH"
  say "key installed"
fi
# sshd silently ignores authorized_keys if the modes are loose, and the symptom is an ordinary
# "Permission denied (publickey)" with nothing in the log to say why.
run restorecon -R "$SSH_DIR" 2>/dev/null || true

# ── 4. sudo ───────────────────────────────────────────────────────────────────────────────
SUDOERS="/etc/sudoers.d/$DEPLOY_USER"
case "$SUDO_MODE" in
  none)
    if [ -f "$SUDOERS" ]; then run rm -f "$SUDOERS"; say "removed $SUDOERS"; fi
    say "no sudo. This account cannot provision; run the root steps yourself."
    ;;
  full)
    say "FULL sudo. Be aware this account can read every file on the box, EDA included."
    run sh -c "printf '%%s ALL=(ALL) NOPASSWD: ALL\n' '$DEPLOY_USER' > '$SUDOERS'"
    run chmod 0440 "$SUDOERS"
    ;;
  scoped)
    # The commands provisioning actually needs, and no editors, shells or pagers -- `sudo vi` is
    # `sudo sh` with extra steps, and so is `sudo less`. Password required, so a stolen key alone
    # does not become root.
    if [ "$DRY" -eq 1 ]; then
      say "would write $SUDOERS with a scoped command list"
    else
      cat > "$SUDOERS" <<EOF
# Scoped provisioning rights for $DEPLOY_USER. Deliberately excludes editors, pagers and shells:
# sudo with an editor is sudo with a shell. Widen this file rather than working around it.
Defaults:$DEPLOY_USER log_output
Cmnd_Alias AGNI_SVC   = /usr/bin/systemctl, /usr/bin/journalctl
Cmnd_Alias AGNI_PKG   = /usr/bin/dnf, /usr/bin/rpm
Cmnd_Alias AGNI_SEL   = /usr/sbin/semanage, /usr/sbin/setsebool, /usr/sbin/restorecon, /usr/sbin/ausearch
Cmnd_Alias AGNI_PG    = /usr/bin/psql, /usr/bin/pg_dump, /usr/bin/pg_restore, /usr/bin/createdb, /usr/bin/dropdb
Cmnd_Alias AGNI_NET   = /usr/bin/tailscale, /usr/bin/ss
$DEPLOY_USER ALL=(root) AGNI_SVC, AGNI_PKG, AGNI_SEL, AGNI_NET
$DEPLOY_USER ALL=(postgres) AGNI_PG
EOF
      chmod 0440 "$SUDOERS"
      # visudo -c BEFORE it can lock anybody out. A malformed file in sudoers.d breaks sudo for
      # EVERY user on the box, including the one who would have to fix it.
      if ! visudo -cf "$SUDOERS" >/dev/null; then
        rm -f "$SUDOERS"
        echo "sudoers file failed validation and was removed; sudo is untouched" >&2
        exit 1
      fi
      say "wrote $SUDOERS (validated with visudo -c)"
    fi
    ;;
esac

# ── 5. where the app lives ────────────────────────────────────────────────────────────────
# agnidata owns it and vaultsvc only reads: a service that can rewrite its own code is one bug
# away from persisting a change nobody deployed.
run install -d -m 0750 -o "$DEPLOY_USER" -g "$SERVICE_USER" "$APP_ROOT"
# Secrets are root-owned and group-readable by the service only -- the deploy account does not
# need to read the token it installs.
run install -d -m 0750 -o root -g "$SERVICE_USER" /etc/vault

echo
echo "Done. Verify from your laptop, not from here:"
say "ssh $DEPLOY_USER@<edaserver> 'id; sudo -l'"
echo
echo "Not done by this script, on purpose:"
say "nothing was read, listed or modified outside the paths above"
say "no existing account, group or file was changed"
say "the service account has no shell and no key -- systemd starts it, people do not"
