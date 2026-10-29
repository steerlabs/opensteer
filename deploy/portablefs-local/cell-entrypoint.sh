#!/usr/bin/env bash
set -euo pipefail

required=(PORTABLEFS_CELL_ID PORTABLEFS_CELL_IMAGE_SIZE)
for name in "${required[@]}"; do
  [[ -n ${!name:-} ]] || {
    echo "portablefs-local-cell: missing $name" >&2
    exit 64
  }
done
[[ $PORTABLEFS_CELL_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo "portablefs-local-cell: invalid cell identity" >&2
  exit 64
}

for path in \
  /portablefs-pki/cell/cell.cert \
  /portablefs-pki/cell/cell.key \
  /portablefs-pki/cell/manager-ca.pem \
  /portablefs-pki/cell/plan-public.pem; do
  [[ -f $path && ! -L $path ]] || {
    echo "portablefs-local-cell: missing or unsafe identity file $path" >&2
    exit 66
  }
done

install -d -o root -g root -m 0755 /etc/portablefs/{cells,trust,volumes}
install -o root -g root -m 0444 /portablefs-pki/cell/manager-ca.pem /etc/portablefs/trust/manager-ca.pem
install -o root -g root -m 0444 /portablefs-pki/cell/plan-public.pem /etc/portablefs/trust/plan-public.pem
install -o root -g root -m 0444 /portablefs-pki/cell/cell.cert "/etc/portablefs/cells/${PORTABLEFS_CELL_ID}.cert"
install -o portablefs-agent -g portablefs-agent -m 0400 /portablefs-pki/cell/cell.key "/etc/portablefs/cells/${PORTABLEFS_CELL_ID}.key"

cat >"/etc/portablefs/cells/${PORTABLEFS_CELL_ID}.env" <<EOF
PORTABLEFS_AGENT_UID=200100
PORTABLEFS_AGENT_GID=200100
PORTABLEFS_MANAGER_URL=https://manager.portablefs.internal:8443
PORTABLEFS_MANAGER_SERVER_NAME=manager.portablefs.internal
EOF
chmod 0600 "/etc/portablefs/cells/${PORTABLEFS_CELL_ID}.env"
printf 'PORTABLEFS_CELL_IMAGE_SIZE=%s\n' "$PORTABLEFS_CELL_IMAGE_SIZE" >/etc/portablefs/local-cell.env
chmod 0600 /etc/portablefs/local-cell.env

# /etc/systemd/system is durable so the helper's per-volume drop-ins survive a
# container recreation. Restore the immutable templates on every boot, then
# enable only this deployment's one cell identity.
install -m 0644 /opt/portablefs/systemd/* /etc/systemd/system/

# Containers do not persist /etc/passwd. The privileged helper deliberately
# persists the exact systemd-sysusers declarations for every allocated volume,
# so reconstruct those numeric service identities before systemd can activate
# any durable authority socket or service unit.
shopt -s nullglob
for definition in /var/lib/portablefs-cell-helper/sysusers.d/*.conf; do
  [[ -f $definition && ! -L $definition ]] || {
    echo "portablefs-local-cell: unsafe persisted sysusers definition $definition" >&2
    exit 66
  }
  [[ $(stat -c '%u:%g' "$definition") == 0:0 ]] || {
    echo "portablefs-local-cell: persisted sysusers definition is not root-owned" >&2
    exit 66
  }
  [[ $((8#$(stat -c '%a' "$definition") & 8#022)) -eq 0 ]] || {
    echo "portablefs-local-cell: persisted sysusers definition is writable by group or other" >&2
    exit 66
  }
  /usr/bin/systemd-sysusers "$definition"
done
shopt -u nullglob

install -d -m 0755 "/etc/systemd/system/portablefs-cell-helper@${PORTABLEFS_CELL_ID}.service.d"
cat >"/etc/systemd/system/portablefs-cell-helper@${PORTABLEFS_CELL_ID}.service.d/local-storage.conf" <<EOF
[Unit]
Requires=portablefs-local-cell-storage.service
After=portablefs-local-cell-storage.service
EOF
install -d -m 0755 "/etc/systemd/system/portablefs-cell-agent@${PORTABLEFS_CELL_ID}.service.d"
cat >"/etc/systemd/system/portablefs-cell-agent@${PORTABLEFS_CELL_ID}.service.d/local-storage.conf" <<EOF
[Unit]
Requires=portablefs-local-cell-storage.service
After=portablefs-local-cell-storage.service
EOF

systemctl enable portablefs-local-cell-storage.service >/dev/null
systemctl enable "portablefs-cell-helper@${PORTABLEFS_CELL_ID}.service" >/dev/null
systemctl enable "portablefs-cell-agent@${PORTABLEFS_CELL_ID}.service" >/dev/null

exec "$@"
