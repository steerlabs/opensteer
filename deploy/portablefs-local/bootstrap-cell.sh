#!/usr/bin/env bash
set -euo pipefail

required=(
  PORTABLEFS_CELL_ID
  PORTABLEFS_AUTHORITY_HOST
  PORTABLEFS_AUTHORITY_DNS_ZONE
  PORTABLEFS_CELL_CAPACITY_BYTES
  PORTABLEFS_CELL_CAPACITY_INODES
  PORTABLEFS_CELL_FIRST_PORT
)
for name in "${required[@]}"; do
  [[ -n ${!name:-} ]] || {
    echo "portablefs-local-bootstrap: missing $name" >&2
    exit 64
  }
done

body=$(printf \
  '{"id":"%s","availability_zone":"local-1","authority_host":"%s","authority_dns_zone":"%s","capacity_bytes":%s,"capacity_inodes":%s,"first_project_id":10000,"first_service_uid":210000,"first_port":%s}' \
  "$PORTABLEFS_CELL_ID" "$PORTABLEFS_AUTHORITY_HOST" "$PORTABLEFS_AUTHORITY_DNS_ZONE" \
  "$PORTABLEFS_CELL_CAPACITY_BYTES" "$PORTABLEFS_CELL_CAPACITY_INODES" "$PORTABLEFS_CELL_FIRST_PORT")

attempt=0
while [[ $attempt -lt 60 ]]; do
  attempt=$((attempt + 1))
  if response=$(curl --silent --show-error --fail-with-body \
    --cacert /portablefs-pki/operator/manager-ca.pem \
    --cert /portablefs-pki/operator/operator.cert \
    --key /portablefs-pki/operator/operator.key \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: opensteer-local-cell-${PORTABLEFS_CELL_ID}" \
    --request POST --data "$body" \
    https://manager.portablefs.internal:8443/v1/cells 2>/tmp/portablefs-bootstrap-error); then
    printf '%s\n' "$response"
    exit 0
  fi
  sleep 1
done

echo "portablefs-local-bootstrap: manager did not admit the local cell" >&2
tail -c 4096 /tmp/portablefs-bootstrap-error >&2 || true
exit 1
