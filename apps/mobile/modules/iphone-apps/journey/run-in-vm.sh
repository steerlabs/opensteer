#!/usr/bin/env bash
set -euo pipefail

# Run from the checked-out repository inside pnpm test:vm. The guest payload
# supplies PostgreSQL; this journey owns the cluster and stops it on every exit.
root="$(git rev-parse --show-toplevel)"
resources="${OPENSTEER_PERSONAL_E2E_RESOURCES:?VM payload resources are required}"
runtime="$resources/personal-runtime"
initdb="$runtime/postgres/bin/initdb"
postgres="$runtime/postgres/bin/postgres"
pg_isready="$runtime/postgres/bin/pg_isready"
for executable in "$initdb" "$postgres" "$pg_isready"; do
  [[ -x "$executable" ]] || { echo "Missing PostgreSQL payload binary: $executable" >&2; exit 1; }
done

evidence="${OPENSTEER_IPHONE_APPS_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/native/iphone-apps}"
mkdir -p "$evidence"
export OPENSTEER_IPHONE_APPS_EVIDENCE_DIR="$evidence"
data="$(mktemp -d "$evidence/postgres.XXXXXX")"
socket_dir="$(mktemp -d "$evidence/socket.XXXXXX")"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$data" "$socket_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$initdb" -D "$data" -U opensteer -A trust --no-instructions >"$evidence/postgres-init.log" 2>&1
port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
"$postgres" -D "$data" -h 127.0.0.1 -p "$port" -k "$socket_dir" \
  >"$evidence/postgres-server.log" 2>&1 &
server_pid="$!"
ready=false
for _ in {1..100}; do
  if "$pg_isready" -h 127.0.0.1 -p "$port" -U opensteer -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo "PostgreSQL did not become ready; inspect $evidence/postgres-server.log" >&2
  exit 1
fi
OPENSTEER_IPHONE_APPS_PG_PORT="$port" pnpm --filter @opensteer/database exec node -e '
const { Client } = require("pg");
(async () => {
  const client = new Client({ host: "127.0.0.1", port: Number(process.env.OPENSTEER_IPHONE_APPS_PG_PORT), user: "opensteer", database: "postgres" });
  await client.connect();
  try {
    await client.query("CREATE DATABASE opensteer");
    await client.query("CREATE DATABASE opensteer_control_plane");
  } finally {
    await client.end();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
' >"$evidence/postgres-databases.log" 2>&1
export OPENSTEER_TEST_DATABASE_URL="postgres://opensteer@127.0.0.1:$port/opensteer"
export OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL="postgres://opensteer@127.0.0.1:$port/opensteer_control_plane"
cd "$root"
pnpm exec tsx scripts/generate-apple-data-contracts.ts
pnpm test:integration -- --config apps/mobile/modules/iphone-apps/journey/vitest.config.ts
