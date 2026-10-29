#!/bin/bash
set -euo pipefail
export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
share='/Volumes/My Shared Files'
inputs="$share/tooling"
out="$share/artifacts"
exec > >(tee "$out/mobile-provision.txt") 2>&1
# Expand only this bootstrap clone's APFS container after Tart enlarged its disk.
container=$(diskutil info -plist /System/Volumes/Data | plutil -extract APFSContainerReference raw -o - -)
sudo diskutil apfs resizeContainer "$container" 0
df -k "$HOME"
node - "$inputs" "$share/provision/mobile-input-manifest.json" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.argv[2];
const m = JSON.parse(fs.readFileSync(process.argv[3]));
assert.equal(m.xcode.version, '27.1'); assert.equal(m.xcode.build, '27A9275');
assert.equal(m.runtime.version, '27.1'); assert.equal(m.runtime.build, '24A94425');
(async () => {
  for (const [name, entry] of [['xcode.tar', m.xcode], ['runtime.tar', m.runtime]]) {
    assert.equal(fs.statSync(`${root}/${name}`).size, entry.bytes);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(`${root}/${name}`)) hash.update(chunk);
    assert.equal(hash.digest('hex'), entry.sha256);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
# Reject unexpected archive roots before extracting a licensed, checksummed input.
tar -tf "$inputs/xcode.tar" > "$out/xcode-archive-files.txt"
node - "$out/xcode-archive-files.txt" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const entries = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
assert(entries.length > 1);
assert(entries.every(p => (p === 'Xcode.app' || p.startsWith('Xcode.app/')) && !p.split('/').includes('..')));
JS
test ! -e /Applications/Xcode.app
sudo tar -xf "$inputs/xcode.tar" -C /Applications
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Xcode.app/Contents/version.plist)" = '27.1'
test "$(/usr/libexec/PlistBuddy -c 'Print :ProductBuildVersion' /Applications/Xcode.app/Contents/version.plist)" = '27A9275'
sudo env DEVELOPER_DIR="$DEVELOPER_DIR" xcodebuild -license accept
sudo env DEVELOPER_DIR="$DEVELOPER_DIR" xcodebuild -runFirstLaunch
sudo xcode-select -s "$DEVELOPER_DIR"
xcodebuild -version
# Preserve Apple's exported bundle, including signed restore metadata; its inner
# cryptex image alone is not the importable exported runtime.
staging=$(mktemp -d "$HOME/opensteer-runtime-input.XXXXXX")
trap 'rm -rf "$staging"' EXIT
tar -tf "$inputs/runtime.tar" > "$out/runtime-archive-files.txt"
node - "$out/runtime-archive-files.txt" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const entries = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
assert(entries.length > 1);
assert(entries.every(p => (p === 'runtime.exportedBundle' || p.startsWith('runtime.exportedBundle/')) && !p.split('/').includes('..')));
JS
tar -xf "$inputs/runtime.tar" -C "$staging"
bundle="$staging/runtime.exportedBundle"
metadata="$bundle/ExportedMetadata.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :MobileAssetProperties:Build' "$metadata")" = '24A94425'
test "$(/usr/libexec/PlistBuddy -c 'Print :MobileAssetProperties:SimulatorVersion' "$metadata")" = '27.1'
test "$(/usr/libexec/PlistBuddy -c 'Print :MobileAssetProperties:Architectures:0' "$metadata")" = 'arm64'
test "$(/usr/libexec/PlistBuddy -c 'Print :ProductBuildVersion' "$bundle/Restore/Restore.plist")" = '24A94425'
cp "$metadata" "$out/runtime-export-metadata.plist"
xcodebuild -importPlatform "$bundle"
# Import success alone is not a certificate: assert the final runtime build.
bash "$share/provision/verify-mobile.sh" --inventory
cp "$share/provision/mobile-input-manifest.json" "$out/mobile-tooling-manifest.json"
df -k "$HOME"
