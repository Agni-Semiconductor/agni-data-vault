#!/usr/bin/env bash
# Read-only inventory of edaserver before anything is provisioned.
#
# This script CHANGES NOTHING. It runs no installer, writes no file outside /tmp, starts and stops
# no service. Run it, read it, and only then decide what to install -- the alternative is finding
# out during a provisioning run that the Postgres you were about to add a database to is already
# serving something, or that the 1 TB you planned around is three different mounts.
#
# It exists because of one specific open question: the measurement data is already on this box, but
# not necessarily on the volume the endpoint would use. Section 2 answers that, and it is the part
# worth reading first.
#
#   bash preflight.sh            # human-readable
#   bash preflight.sh > pre.txt  # and send it back
#
# Most of this works unprivileged. The few root-only checks say so instead of failing.
# IT DOES NOT LOOK AT EDA WORK. This box is somebody's EDA machine first. Nothing here reads,
# lists or walks a path outside the fixed list in section 2, and nothing recurses into a directory
# it was not told about by name. An earlier version ran `du -sh /srv`, which walks every
# subdirectory of /srv including whatever else lives there -- exactly the kind of incidental reach
# that is easy to write and hard to notice. It is gone.
set -u

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
try() { if command -v "$1" >/dev/null 2>&1; then "$@"; else echo "  (no $1 on this host)"; fi; }
note() { printf '  %s\n' "$*"; }

hr "0. Host"
note "$(hostnamectl --static 2>/dev/null || hostname)  |  $(uname -srm)"
note "$(cat /etc/redhat-release 2>/dev/null || cat /etc/os-release 2>/dev/null | grep PRETTY || echo unknown)"
note "uptime:$(uptime -p 2>/dev/null || true)"
note "SELinux: $(getenforce 2>/dev/null || echo 'not installed')"
# Enforcing is expected and is NOT a problem to solve by disabling it. It is a set of four
# fcontext/boolean steps whose failure modes look like unrelated 502s and bind errors.

hr "1. CPU, memory"
note "cores: $(nproc 2>/dev/null)   arch: $(uname -m)"
# The architecture matters: every PostgREST install note in these repos hardcodes aarch64, from
# when the target was the Pi. On x86_64 that binary simply will not run.
try free -h

hr "2. Storage -- WHERE THE DATA ACTUALLY IS"
# The open question. Four separate claims about storage on this host -- the 1 TB allocation, the
# Postgres data directory, the fed_storage object tree, and agni-connect's 256 GiB encrypted LVM --
# are frequently assumed to be one mount. A plan that assumes that discovers otherwise partway
# through a restore, with the restore holding the disk.
try df -hT -x tmpfs -x devtmpfs
echo
try lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINT
echo
note "mount options for anything holding data (noquota is noted in the archive runbook):"
mount | grep -E '/srv|/var/lib/pgsql|/data|/mnt' 2>/dev/null | sed 's/^/    /' || note "  (none of the usual paths are separate mounts)"
echo
# NAMED paths only, and du is scoped to each rather than to its parent -- /srv itself is
# deliberately NOT walked, because whatever else lives there is not this project's business.
# df and lsblk above read the filesystem table rather than the files, which is why they carry
# most of this section.
note "sizes of the paths this project owns (named explicitly, never a parent):"
for d in /srv/nextcloud/fedbench /srv/nextcloud/fedbench/objects /var/lib/pgsql /srv/vault /srv/agni-devops; do
  if [ -e "$d" ]; then
    printf '  %-38s %s\n' "$d" "$(du -sh --one-file-system "$d" 2>/dev/null | cut -f1 || echo '(unreadable)')"
  else
    printf '  %-38s %s\n' "$d" "absent"
  fi
done

hr "3. PostgreSQL"
try psql --version
note "server packages:"
rpm -qa 2>/dev/null | grep -i postgres | sed 's/^/    /' || note "  (rpm unavailable)"
note "units:"
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'postgres|pgsql' | sed 's/^/    /' || note "  (none)"
note "data directory and listeners:"
sudo -n test -r /var/lib/pgsql/17/data/postgresql.conf 2>/dev/null \
  && sudo -n grep -E '^(data_directory|listen_addresses|port|ssl|shared_buffers|max_connections)' /var/lib/pgsql/17/data/postgresql.conf 2>/dev/null | sed 's/^/    /' \
  || note "  (needs sudo, or the data directory is elsewhere -- check the unit's Environment=PGDATA)"
note "databases and their sizes (needs a superuser connection):"
sudo -n -u postgres psql -tAc \
  "select datname || '  ' || pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by pg_database_size(datname) desc" 2>/dev/null | sed 's/^/    /' \
  || note "  (could not connect as postgres without a password prompt -- run this section by hand)"
note "roles:"
sudo -n -u postgres psql -tAc \
  "select rolname || case when rolsuper then ' SUPER' else '' end || case when rolbypassrls then ' BYPASSRLS' else '' end || case when rolcanlogin then ' LOGIN' else '' end from pg_roles where rolname not like 'pg\\_%' order by 1" 2>/dev/null | sed 's/^/    /' \
  || note "  (as above)"

hr "4. What is already listening"
# Anything already on 3000, 3001, 8087, 8099 or 443 is a collision, and finding it now is cheaper
# than finding it when a unit fails to bind.
try ss -lntp 2>/dev/null | sed 's/^/  /'

hr "5. Tailscale"
try tailscale status --peers=false 2>/dev/null | sed 's/^/  /'
note "direct path check (a DERP relay adds ~21 ms to every hop the Pi and the CLI make):"
try tailscale ping --c 1 --timeout 5s filbert 2>&1 | sed 's/^/    /'
note "certificate: a tailnet cert is Let's Encrypt via DNS-01, ~90 days, and nothing renews it by default."
ls -l /etc/caddy/certs 2>/dev/null | sed 's/^/    /' || note "    (no /etc/caddy/certs yet)"

hr "6. What is already installed of the stack"
# `command -v` consults PATH; it does not search the disk. Nothing here goes looking for EDA
# tooling, and an absent tool is reported absent rather than hunted for.
for b in postgrest caddy cloudflared nginx node python3 restic rclone; do
  p="$(command -v "$b" 2>/dev/null || true)"
  printf '  %-12s %s\n' "$b" "${p:-absent}"
done
note "existing fed/vault units:"
systemctl list-unit-files 2>/dev/null | grep -iE 'fed|vault|caddy|cloudflared|postgrest' | sed 's/^/    /' || note "    (none)"

hr "7. The archive, and whether it has ever been proven restorable"
# The gate on everything. Archived bytes being intact is a different claim from the archive coming
# back as a working database, and only the second one lets a cutover happen.
for f in state/last_pull.json state/last_restore_verify.json; do
  for root in /srv/nextcloud/fedbench /srv/fedbackup/ferrodiode-pcb-testbench; do
    [ -f "$root/$f" ] && { printf '  %s/%s:\n' "$root" "$f"; sed 's/^/      /' "$root/$f" 2>/dev/null | head -12; }
  done
done
note "(no output above means neither file exists -- which is itself the finding)"

hr "8. Backup reach"
note "Anything here that is not on a second physical device does not count as a copy."
try findmnt -no SOURCE,TARGET,FSTYPE / 2>/dev/null | sed 's/^/    /'
note "off-host targets configured:"
ls -d ~/.config/rclone 2>/dev/null || note "    (no rclone config for this user)"

printf '\n\033[1mdone -- nothing was changed.\033[0m\n'
