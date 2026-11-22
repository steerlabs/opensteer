/** Runs guest shell entry points against disposable files and platform transports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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

/*
 * The fixture keychain step changes a user's default keychain, so it must refuse anywhere but
 * the job's own guest, and there change only what it puts back. Its `security` is a recording
 * stand-in here, so the contract can never touch a real keychain; off the guest, `sysctl` is the
 * real one, which on this Mac says there is no hypervisor.
 */
const securityStandIn = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),home=process.env.HOME;
fs.appendFileSync(home+'/security-calls.jsonl',JSON.stringify(a)+'\n');
const st=home+'/security-state.json';
const s=fs.existsSync(st)?JSON.parse(fs.readFileSync(st,'utf8')):{default:home+'/Library/Keychains/login.keychain-db',list:[home+'/Library/Keychains/login.keychain-db',home+'/Library/Keychains/other.keychain-db']};
const save=()=>fs.writeFileSync(st,JSON.stringify(s));
if(a[0]==='list-keychains'){if(a.includes('-s')){s.list=a.slice(a.indexOf('-s')+1);save()}else s.list.forEach(k=>console.log('    "'+k+'"'));process.exit(0)}
if(a[0]==='default-keychain'){if(a.includes('-s')){s.default=a[a.indexOf('-s')+1];save()}else console.log('    "'+s.default+'"');process.exit(0)}
if(a[0]==='find-generic-password'&&a.includes('-w')){console.log('probe');process.exit(0)}
process.exit(0);
`;
const sysctlGuest = '#!/bin/sh\n[ "$2" = kern.hv_vmm_present ] && echo 1\n';
function keychainCase(
  name: string,
  setup: { readonly guest: boolean; readonly marker: string | null },
  run: (
    step: (action: string) => number | null,
    root: string,
    diagnose: (job: string | null) => { status: number | null; output: string },
  ) => void,
) {
  try {
    const root = path.join(out, name);
    const tools = path.join(root, "tools");
    mkdirSync(path.join(root, "opensteer-job"), { recursive: true });
    mkdirSync(path.join(root, "Library/Keychains"), { recursive: true });
    mkdirSync(tools, { recursive: true });
    writeFileSync(path.join(tools, "security"), securityStandIn, { mode: 0o700 });
    if (setup.guest) writeFileSync(path.join(tools, "sysctl"), sysctlGuest, { mode: 0o700 });
    if (setup.marker !== null)
      writeFileSync(path.join(root, "opensteer-job/guest-job"), setup.marker);
    const step = (action: string) => {
      const r = spawnSync(
        "/bin/bash",
        ["scripts/test-vm/fixture-keychain.sh", action, "opensteer-gui-job-contract"],
        {
          env: {
            HOME: root,
            // The stand-ins first; Node for the security stand-in; the system's own tools after.
            PATH: `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      writeFileSync(path.join(root, `${action}.log`), r.stdout + r.stderr);
      assert.equal(r.error, undefined);
      return r.status;
    };
    const diagnose = (job: string | null) => {
      const r = spawnSync("/bin/bash", ["scripts/test-vm/keychain-diagnostic.sh"], {
        env: {
          HOME: root,
          PATH: `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          ...(job === null ? {} : { OPENSTEER_TEST_GUEST_JOB: job }),
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(r.error, undefined);
      return { output: r.stdout + r.stderr, status: r.status };
    };
    run(step, root, diagnose);
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
  }
}
const calls = (root: string) =>
  existsSync(path.join(root, "security-calls.jsonl"))
    ? readFileSync(path.join(root, "security-calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];
for (const [name, setup] of [
  // This Mac, as it is: the real sysctl, even with the marker in place.
  ["keychain-refuses-off-guest", { guest: false, marker: "opensteer-gui-job-contract" }],
  ["keychain-refuses-without-marker", { guest: true, marker: null }],
  ["keychain-refuses-another-job", { guest: true, marker: "opensteer-gui-job-other" }],
] as const)
  keychainCase(name, setup, (step, root, diagnose) => {
    for (const action of ["begin", "unlock", "probe", "lock", "guard", "end"]) {
      assert.equal(step(action), 77, `${action} must refuse`);
      assert.deepEqual(calls(root), [], `${action} touched a keychain`);
      assert.equal(existsSync(path.join(root, "opensteer-job/fixture-keychain.state")), false);
    }
    // The diagnostic refuses by the same guard, before it runs anything.
    const diagnosed = diagnose("opensteer-gui-job-contract");
    assert.equal(diagnosed.status, 77, `the diagnostic must refuse: ${diagnosed.output}`);
    assert.match(diagnosed.output, /^fixture keychain: refused: /u);
    assert.doesNotMatch(diagnosed.output, /session manager|electron/u);
    assert.deepEqual(calls(root), [], "the diagnostic touched a keychain");
    assert.equal(existsSync(path.join(root, "opensteer-job/keychain-diagnostic")), false);
  });
// In the guest, but the suite was not handed the job's VM: the diagnostic refuses.
keychainCase(
  "keychain-diagnostic-refuses-without-job",
  { guest: true, marker: "opensteer-gui-job-contract" },
  (_step, root, diagnose) => {
    const diagnosed = diagnose(null);
    assert.equal(diagnosed.status, 77, diagnosed.output);
    assert.deepEqual(calls(root), []);
    assert.equal(existsSync(path.join(root, "opensteer-job/keychain-diagnostic")), false);
  },
);
keychainCase(
  "keychain-in-the-guest-and-back",
  { guest: true, marker: "opensteer-gui-job-contract" },
  (step, root) => {
    const fixture = path.join(root, "Library/Keychains/opensteer-journey-fixture.keychain-db");
    const login = path.join(root, "Library/Keychains/login.keychain-db");
    const other = path.join(root, "Library/Keychains/other.keychain-db");
    // Nothing to unlock before `begin`: refused, and no keychain touched.
    assert.equal(step("unlock"), 77);
    assert.deepEqual(calls(root), []);
    assert.equal(step("begin"), 0);
    const state = () =>
      JSON.parse(readFileSync(path.join(root, "security-state.json"), "utf8")) as {
        default: string;
        list: string[];
      };
    assert.deepEqual(state(), { default: fixture, list: [fixture, login, other] });
    const begun = calls(root);
    // Its own keychain, its own password; the login keychain is never unlocked or changed.
    assert.ok(
      begun.some((c) => c.join(" ") === `create-keychain -p opensteer-journey-fixture ${fixture}`),
    );
    assert.ok(
      begun.some((c) => c.join(" ") === `unlock-keychain -p opensteer-journey-fixture ${fixture}`),
    );
    assert.ok(begun.some((c) => c.join(" ") === `set-keychain-settings ${fixture}`));
    for (const call of begun)
      assert.ok(
        !call.includes(login) || call[0] === "list-keychains",
        `touched the login keychain: ${call.join(" ")}`,
      );
    assert.notEqual(step("begin"), 0, "a second begin must refuse");
    // The suite's own session: it says whether the keychain was usable there, then unlocks it.
    const before = calls(root).length;
    assert.equal(step("unlock"), 0);
    const unlocked = calls(root).slice(before);
    assert.match(
      readFileSync(path.join(root, "unlock.log"), "utf8"),
      /in this session before unlock: write and read ok\n.*in this session after unlock: write and read ok/su,
    );
    assert.ok(
      unlocked.some(
        (c) => c.join(" ") === `unlock-keychain -p opensteer-journey-fixture ${fixture}`,
      ),
    );
    assert.equal(step("lock"), 0);
    assert.ok(calls(root).some((c) => c.join(" ") === `lock-keychain ${fixture}`));
    for (const call of calls(root)) {
      assert.ok(
        !call.includes(login) || call[0] === "list-keychains",
        `touched the login keychain: ${call.join(" ")}`,
      );
      // Every item it writes, reads or deletes is in the fixture keychain, named.
      if (call[0]?.endsWith("generic-password")) assert.equal(call.at(-1), fixture);
    }
    assert.equal(step("end"), 0);
    assert.deepEqual(state(), { default: login, list: [login, other] });
    assert.ok(calls(root).some((c) => c.join(" ") === `delete-keychain ${fixture}`));
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-keychain.state")), false);
  },
);
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(out, JSON.stringify(results, null, 2));
if (results.some((r) => !r.passed)) process.exitCode = 1;
