#!/bin/bash
set -euo pipefail
export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
share='/Volumes/My Shared Files'
out="$share/artifacts"
xcrun swiftc -module-cache-path /tmp/opensteer-swift-cache "$share/provision/native-input.swift" -o /tmp/vm-native-input
node -e 'const {execFileSync}=require("node:child_process");process.stdout.write(execFileSync("/tmp/vm-native-input",["status"]))' > "$out/permissions.json"
xcrun swiftc -module-cache-path /tmp/opensteer-swift-cache "$share/provision/permission-postevent.swift" -o /tmp/vm-postevent
node -e 'require("node:child_process").execFileSync("/tmp/vm-postevent",[process.argv[1]],{stdio:"inherit"})' "$out/postevent.json"
/usr/sbin/screencapture -x "$out/guest-desktop.png"
sips -g pixelWidth -g pixelHeight "$out/guest-desktop.png"
ioreg -n Root -d1 -a > "$out/console-session.plist"
stat -f '%Su %u' /dev/console
pgrep -lf 'loginwindow|WindowServer|ScreenSaverEngine'
cat "$out/permissions.json" "$out/postevent.json"

node - "$out" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const out = process.argv[2];
const permissions = JSON.parse(fs.readFileSync(`${out}/permissions.json`, 'utf8'));
const post = JSON.parse(fs.readFileSync(`${out}/postevent.json`, 'utf8'));
assert.equal(permissions.accessibilityTrusted, true);
assert.equal(permissions.screenCaptureAllowed, true);
assert.equal(post.postEventAllowed, true);
assert.equal(post.text, 'VM-POSTEVENT-OK');
JS
