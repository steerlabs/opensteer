#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f "$HOME/.opensteer-test-guest" && "$PWD" != */opensteer-job/src/apps/desktop ]]; then
  echo 'Run this smoke through pnpm test:vm.' >&2
  exit 1
fi
# --all runs every viewer suite once: viewer clipboard, baseline, editing v2 and PC-viewer Cut.
case "${1:---all}" in
  --all) taskViewerSuite=all ;;
  --baseline) taskViewerSuite=baseline ;;
  --editing-v2) taskViewerSuite=editing-v2 ;;
  --editing-v2-probe) taskViewerSuite=editing-v2-probe ;;
  *) echo 'Expected --all, --baseline, --editing-v2 or --editing-v2-probe.' >&2; exit 2 ;;
esac
taskBundleDir=$(mktemp -d "${TMPDIR:-/tmp/}"opensteer-viewer-smoke.XXXXXX)
trap 'rm -rf "$taskBundleDir"' EXIT
cd ../..
pnpm exec esbuild apps/web/scripts/fixtures/remote-editing-viewer.tsx --bundle --format=esm --jsx=automatic --target=es2024 --define:process.env.NODE_ENV='"production"' --outfile="$taskBundleDir/viewer.js"
if [[ "$taskViewerSuite" == all ]]; then
  pnpm exec esbuild apps/desktop/scripts/viewer-clipboard-smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile="$taskBundleDir/main.cjs"
  cd apps/desktop
  OPENSTEER_VIEWER_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/main.cjs"
  cd ../..
fi
if [[ "$taskViewerSuite" == all || "$taskViewerSuite" == editing-v2* ]]; then
  xcrun swiftc -module-cache-path "$taskBundleDir/swift-cache" apps/web/src/components/remote-editing/native-keys.swift -o "$taskBundleDir/native-keys"
fi
pnpm exec esbuild apps/desktop/scripts/baseline-viewer-smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile="$taskBundleDir/baseline.cjs"
cd apps/desktop
taskViewerStatus=0
if [[ "$taskViewerSuite" == editing-v2-probe ]]; then
  OPENSTEER_VIEWER_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/baseline.cjs" --raw-baseline || taskViewerStatus=1
fi
OPENSTEER_VIEWER_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/baseline.cjs" || taskViewerStatus=1
if [[ "$taskViewerSuite" == all || "$taskViewerSuite" == editing-v2* ]]; then
  OPENSTEER_NATIVE_KEYS="$taskBundleDir/native-keys" OPENSTEER_VIEWER_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/baseline.cjs" --editing-v2 || taskViewerStatus=1
  OPENSTEER_VIEWER_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/baseline.cjs" --pc-viewer || taskViewerStatus=1
fi
OPENSTEER_VIEWER_SUITE="$taskViewerSuite" node --input-type=module -e '
import { readFileSync } from "node:fs";
import path from "node:path";
const result = JSON.parse(readFileSync(path.join(process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME, "opensteer-job/artifacts"), "baseline-viewer/result.json"), "utf8"));
if (result.passed !== true) throw new Error(result.failure ?? "The baseline viewer check did not pass.");
if (process.env.OPENSTEER_VIEWER_SUITE === "all" || process.env.OPENSTEER_VIEWER_SUITE.startsWith("editing-v2")) {
  const editing = JSON.parse(readFileSync(path.join(process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME, "opensteer-job/artifacts"), "editing-v2-viewer/result.json"), "utf8"));
  if (editing.passed !== true) throw new Error(editing.failure ?? "The v2 viewer did not pass.");
  const pc = JSON.parse(readFileSync(path.join(process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME, "opensteer-job/artifacts"), "editing-v2-pc-viewer/result.json"), "utf8"));
  if (pc.passed !== true) throw new Error(pc.failure ?? "The PC v2 viewer did not pass.");
}
' || taskViewerStatus=1
exit "$taskViewerStatus"
