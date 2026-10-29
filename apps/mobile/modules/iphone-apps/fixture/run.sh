#!/usr/bin/env bash
set -euo pipefail

# Invoke only inside an owned mobile test VM. The fixture is a separate app and
# reads the simulator's Apple stores through public APIs.
if [[ $# -ne 3 ]]; then
  echo 'usage: run.sh <simulator-udid> <seed|snapshot> <iphone-apps-fixture-unique-marker>' >&2
  exit 2
fi
simulator="$1"
action="$2"
marker="$3"
if [[ "$action" != seed && "$action" != snapshot ]] || [[ "$marker" != iphone-apps-fixture-* ]]; then
  echo 'invalid fixture action or marker' >&2
  exit 2
fi
evidence="${OPENSTEER_IPHONE_APPS_EVIDENCE_DIR:?set an evidence directory outside the checkout}"
mkdir -p "$evidence"
here="$(cd "$(dirname "$0")" && pwd)"
xcodebuild -project "$here/IphoneAppsFixture.xcodeproj" -scheme IphoneAppsFixture \
  -configuration Release -sdk iphonesimulator -destination "id=$simulator" \
  -derivedDataPath "$evidence/fixture-derived" CODE_SIGNING_ALLOWED=NO build \
  >"$evidence/fixture-build.log" 2>&1
app="$evidence/fixture-derived/Build/Products/Release-iphonesimulator/IphoneAppsFixture.app"
xcrun simctl install "$simulator" "$app"
container="$(xcrun simctl get_app_container "$simulator" com.opensteer.iphoneapps.fixture data)"
result="$container/Documents/fixture-result.json"
python3 - "$result" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
cleanup() { xcrun simctl terminate "$simulator" com.opensteer.iphoneapps.fixture >/dev/null 2>&1 || true; }
trap cleanup EXIT
xcrun simctl launch "$simulator" com.opensteer.iphoneapps.fixture "$action" "$marker" \
  >"$evidence/fixture-launch.log" 2>&1
for _ in {1..30}; do
  if [[ -s "$result" ]]; then
    cp "$result" "$evidence/fixture-$action.json"
    cat "$evidence/fixture-$action.json"
    exit 0
  fi
  sleep 1
done
echo 'fixture app did not write a result within 30 seconds' >&2
exit 1
