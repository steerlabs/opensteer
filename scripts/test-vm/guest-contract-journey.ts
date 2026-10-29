/** Runs guest shell entry points against disposable files and platform transports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = realpathSync(mkdtempSync(path.join(tmpdir(), "opensteer-mobile-guest-contract-")));
const results: { name: string; passed: boolean; error?: string }[] = [];
const transport = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const name=path.basename(process.argv[1]),a=process.argv.slice(2),scenario=process.env.GUEST_CASE;
fs.appendFileSync(process.env.HOME+'/calls.jsonl',JSON.stringify([name,...a])+'\n');
if(name==='sudo'){const p=cp.spawnSync(a[0],a.slice(1),{stdio:'inherit'});process.exit(p.status??1)}
if(name==='plutil'){console.log('disk3');process.stdin.resume();return}
if(name==='diskutil'||name==='xcode-select'||name==='sips')process.exit(0);
if(name==='xcodebuild'){console.log('Xcode 27.1\nBuild version 27A9275');process.exit(0)}
if(name==='xcrun'){
 if(a[1]==='list'&&a[2]==='runtimes')console.log(JSON.stringify({runtimes:[{isAvailable:true,version:'27.1',buildversion:'24A94425',identifier:'com.apple.CoreSimulator.SimRuntime.iOS-27-1',supportedDeviceTypes:[{identifier:scenario==='runtime-duo-only'?'duo':'mini'}]}]}));
 if(a[1]==='list'&&a[2]==='devicetypes')console.log(JSON.stringify({devicetypes:[{name:'iPad mini',identifier:'mini'},{name:'iPhone Duo',identifier:'duo'}]}));
 if(a[1]==='list'&&a[2]==='devices'){
  if(scenario==='inventory-error')process.exit(72);
  if(scenario==='inventory-malformed'){console.log('{');process.exit(0)}
  console.log(JSON.stringify({devices:{runtime:scenario==='device-remains'?[{udid:'OWNED-UDID'}]:[]}}));
 }
 if(a[1]==='create'){if(scenario==='runtime-duo-only'&&a[3]!=='duo'){console.error('Incompatible device');process.exit(403%256)}console.log('OWNED-UDID')}
 if(a[1]==='io')fs.writeFileSync(a.at(-1),'fixture screenshot');
 process.exit(0);
}
`;
function fixture(name: string) {
  const root = path.join(out, name);
  for (const p of [
    "opensteer-tools",
    "share/tooling",
    "share/provision",
    "share/artifacts",
    "Applications",
    "source/Xcode.app/Contents/Developer",
    "runtime/runtime.exportedBundle/Restore",
  ])
    mkdirSync(path.join(root, p), { recursive: true });
  symlinkSync(process.execPath, path.join(root, "opensteer-tools/node"));
  for (const cmd of ["sudo", "diskutil", "plutil", "xcode-select", "xcodebuild", "xcrun", "sips"])
    writeFileSync(path.join(root, "opensteer-tools", cmd), transport, { mode: 0o700 });
  const adapt = (s: string) =>
    s
      .replaceAll("/Volumes/My Shared Files", path.join(root, "share"))
      .replaceAll("/Applications", path.join(root, "Applications"));
  writeFileSync(
    path.join(root, "share/provision/verify-mobile.sh"),
    adapt(readFileSync("scripts/test-vm/verify-mobile.sh", "utf8")),
  );
  return { root, adapt };
}
function plist(filename: string, values: string) {
  writeFileSync(
    filename,
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${values}</dict></plist>`,
  );
}
const version =
  "<key>CFBundleShortVersionString</key><string>27.1</string><key>ProductBuildVersion</key><string>27A9275</string>";
function execute(name: string, script: string, root: string) {
  const r = spawnSync("/bin/bash", ["-s"], {
    input: script,
    env: { ...process.env, HOME: root, GUEST_CASE: name },
    encoding: "utf8",
    timeout: 15_000,
  });
  writeFileSync(path.join(root, "process.log"), r.stdout + r.stderr);
  assert.equal(r.error, undefined);
  return r.status;
}
for (const name of [
  "mutated-shared-manifest",
  "inventory-error",
  "inventory-malformed",
  "device-remains",
  "clean-success",
  "runtime-duo-only",
]) {
  try {
    const { root, adapt } = fixture(name);
    if (name === "mutated-shared-manifest") {
      const inputs = path.join(root, "share/tooling");
      plist(path.join(root, "source/Xcode.app/Contents/version.plist"), version);
      const packXcode = () =>
        assert.equal(
          spawnSync("/usr/bin/tar", [
            "-cf",
            path.join(inputs, "xcode.tar"),
            "-C",
            path.join(root, "source"),
            "Xcode.app",
          ]).status,
          0,
        );
      packXcode();
      plist(
        path.join(root, "runtime/runtime.exportedBundle/ExportedMetadata.plist"),
        "<key>MobileAssetProperties</key><dict><key>Build</key><string>24A94425</string><key>SimulatorVersion</key><string>27.1</string><key>Architectures</key><array><string>arm64</string></array></dict>",
      );
      plist(
        path.join(root, "runtime/runtime.exportedBundle/Restore/Restore.plist"),
        "<key>ProductBuildVersion</key><string>24A94425</string>",
      );
      assert.equal(
        spawnSync("/usr/bin/tar", [
          "-cf",
          path.join(inputs, "runtime.tar"),
          "-C",
          path.join(root, "runtime"),
          "runtime.exportedBundle",
        ]).status,
        0,
      );
      const manifest = () =>
        Object.fromEntries(
          ["xcode", "runtime"].map((n) => {
            const bytes = readFileSync(path.join(inputs, `${n}.tar`));
            return [
              n,
              {
                version: "27.1",
                build: n === "xcode" ? "27A9275" : "24A94425",
                bytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              },
            ];
          }),
        );
      writeFileSync(
        path.join(root, "share/provision/mobile-input-manifest.json"),
        JSON.stringify(manifest()),
      );
      writeFileSync(
        path.join(root, "source/Xcode.app/changed-after-host-validation"),
        "different bytes",
      );
      packXcode();
      writeFileSync(path.join(inputs, "manifest.json"), JSON.stringify(manifest()));
      const code = execute(
        name,
        adapt(readFileSync("scripts/test-vm/provision-mobile.sh", "utf8")),
        root,
      );
      assert.notEqual(
        code,
        0,
        "guest must reject archives changed together with shared manifest after host validation",
      );
      const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8");
      assert.equal(
        calls.includes('"-runFirstLaunch"'),
        false,
        "changed archive must fail before installation",
      );
    } else {
      mkdirSync(path.join(root, "Applications/Xcode.app/Contents"), { recursive: true });
      plist(path.join(root, "Applications/Xcode.app/Contents/version.plist"), version);
      const code = execute(
        name,
        adapt(readFileSync("scripts/test-vm/verify-mobile.sh", "utf8")),
        root,
      );
      assert.equal(
        code === 0,
        ["clean-success", "runtime-duo-only"].includes(name),
        "cleanup must fail closed on inventory errors, malformed JSON or remaining owned device",
      );
      const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8");
      assert.ok(calls.includes('"shutdown","OWNED-UDID"'));
      assert.ok(calls.includes('"delete","OWNED-UDID"'));
    }
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
  }
}
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(out, JSON.stringify(results, null, 2));
if (results.some((r) => !r.passed)) process.exitCode = 1;
