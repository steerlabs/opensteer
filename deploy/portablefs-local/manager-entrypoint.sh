#!/usr/bin/env bash
set -euo pipefail

required=(
  PORTABLEFS_MANAGER_LISTEN
  PORTABLEFS_PRODUCT_ISSUER
)
for name in "${required[@]}"; do
  [[ -n ${!name:-} ]] || {
    echo "portablefs-local-manager: missing $name" >&2
    exit 64
  }
done

install -d -o portablefs-manager -g portablefs-manager -m 0700 /var/lib/portablefs-manager
install -d -o portablefs-manager -g portablefs-manager -m 0700 /run/portablefs-manager
for path in \
  /portablefs-pki/manager/tls/manager.cert \
  /portablefs-pki/manager/tls/manager.key \
  /portablefs-pki/manager/trust/control-client-ca.pem \
  /portablefs-pki/manager/trust/authority-ca.pem \
  /portablefs-pki/manager/trust/mount-client-ca.pem \
  /portablefs-pki/manager/trust/mount-enrollment-ca.pem \
  /portablefs-pki/manager/trust/product-public.pem \
  /portablefs-pki/manager/keys/plan-signing.key \
  /portablefs-pki/manager/keys/capability-signing.key \
  /portablefs-pki/manager/keys/authority-ca.key \
  /portablefs-pki/manager/keys/mount-client-ca.key \
  /portablefs-pki/manager/keys/mount-enrollment-ca.key; do
  [[ -f $path && ! -L $path ]] || {
    echo "portablefs-local-manager: missing or unsafe identity file $path" >&2
    exit 66
  }
done

cp -R /portablefs-pki/manager/. /run/portablefs-manager/
chown -R portablefs-manager:portablefs-manager /run/portablefs-manager
find /run/portablefs-manager -type d -exec chmod 0700 {} +
find /run/portablefs-manager -type f -exec chmod 0400 {} +

# Archive-store credentials are optional deployment capability: when the
# overlay provides them, seal verification and purge are enabled; absent, the
# manager refuses archive operations rather than pretending.
archive_flags=()
if [[ -n "${PORTABLEFS_MANAGER_ARCHIVE_CREDENTIALS:-}" ]]; then
  [[ -f ${PORTABLEFS_MANAGER_ARCHIVE_CREDENTIALS} && ! -L ${PORTABLEFS_MANAGER_ARCHIVE_CREDENTIALS} ]] || {
    echo "archive credentials file is missing or unsafe: ${PORTABLEFS_MANAGER_ARCHIVE_CREDENTIALS}" >&2
    exit 66
  }
  install -m 0400 -o portablefs-manager -g portablefs-manager \
    "${PORTABLEFS_MANAGER_ARCHIVE_CREDENTIALS}" /run/portablefs-manager/archive-credentials.env
  archive_flags=(-archive-credentials=/run/portablefs-manager/archive-credentials.env)
fi

exec setpriv \
  --reuid=portablefs-manager --regid=portablefs-manager --clear-groups \
  --no-new-privs \
  /usr/local/bin/portablefs-manager \
  "${archive_flags[@]}" \
  -listen="${PORTABLEFS_MANAGER_LISTEN}" \
  -state-file=/var/lib/portablefs-manager/manager.state \
  -tls-cert=/run/portablefs-manager/tls/manager.cert \
  -tls-key=/run/portablefs-manager/tls/manager.key \
  -control-client-ca=/run/portablefs-manager/trust/control-client-ca.pem \
  -plan-signing-key=/run/portablefs-manager/keys/plan-signing.key \
  -capability-signing-key=/run/portablefs-manager/keys/capability-signing.key \
  -authority-ca-cert=/run/portablefs-manager/trust/authority-ca.pem \
  -authority-ca-key=/run/portablefs-manager/keys/authority-ca.key \
  -mount-client-ca-cert=/run/portablefs-manager/trust/mount-client-ca.pem \
  -mount-client-ca-key=/run/portablefs-manager/keys/mount-client-ca.key \
  -mount-enrollment-ca-cert=/run/portablefs-manager/trust/mount-enrollment-ca.pem \
  -mount-enrollment-ca-key=/run/portablefs-manager/keys/mount-enrollment-ca.key \
  -grant-lifetime=10m \
  -mount-enrollment-lease=30m \
  -product-issuer-key="${PORTABLEFS_PRODUCT_ISSUER}=/run/portablefs-manager/trust/product-public.pem"
