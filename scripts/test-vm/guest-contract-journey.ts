/** Runs guest shell entry points against disposable files and platform transports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
// sudo, recorded and never run: what the step asks of root, with what it pipes in.
// Of the hosts file it runs the real tail, tee and sed, as root would, on the case's own copy
// ($HOME/etc-hosts for /etc/hosts), so the step's exact commands are run, never only read. Of the
// loopback interface it keeps the addresses added and taken away in $HOME/lo0-aliases, which the
// ifconfig stand-in prints as macOS's ifconfig prints them. The case
// may make one command fail (SUDO_FAIL), or have the step interrupted while one runs (SUDO_KILL:
// TERM to the step, as a dropped connection or a timeout would).
const sudoStandIn = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),a=process.argv.slice(2),home=process.env.HOME;
let input='';try{if(a.includes('tee'))input=fs.readFileSync(0,'utf8')}catch{}
fs.appendFileSync(home+'/sudo-calls.jsonl',JSON.stringify({args:a,input})+'\n');
if(process.env.SUDO_KILL&&a.includes(process.env.SUDO_KILL))process.kill(process.ppid,'SIGTERM');
if(process.env.SUDO_FAIL&&a.includes(process.env.SUDO_FAIL))process.exit(1);
const command=a.filter((word)=>word!=='-n');
if(command[0]==='ifconfig'&&command[1]==='lo0'&&(command[2]==='alias'||command[2]==='-alias')){
  const file=home+'/lo0-aliases',held=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean):[];
  if(command[2]==='-alias'&&!held.includes(command[3])){console.error('ifconfig: ioctl (SIOCDIFADDR): Can\'t assign requested address');process.exit(1)}
  const next=command[2]==='alias'?[...held.filter((x)=>x!==command[3]),command[3]]:held.filter((x)=>x!==command[3]);
  fs.writeFileSync(file,next.map((x)=>x+'\n').join(''));
  process.exit(0);
}
if(['tail','tee','sed'].includes(command[0])){
  const run=spawnSync('/usr/bin/'+command[0],command.slice(1).map((word)=>word==='/etc/hosts'?home+'/etc-hosts':word),{input,stdio:['pipe','pipe','inherit']});
  process.stdout.write(command[0]==='tee'?'':run.stdout);
  process.exit(run.status??1);
}
process.exit(0);
`;
/** A guest's hosts file as macOS writes it. */
const guestHosts =
  "##\n# Host Database\n##\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n";
const hostsOf = (root: string) => readFileSync(path.join(root, "etc-hosts"), "utf8");
// What the guest's resolver says of the name once the line is in.
const dscacheutilStandIn =
  "#!/bin/sh\necho 'name: account.first-run.opensteer.example'\necho 'ip_address: 192.88.99.10'\n";
/**
 * The guest's interfaces as macOS's ifconfig prints them: loopback, with what the sudo stand-in
 * added, and the guest's own network, with $GUEST_ADDRESS where a case gives it one more.
 */
const ifconfigStandIn = String.raw`#!/bin/sh
aliases="$HOME/lo0-aliases"
# A guest whose first line already names the address, and a long listing after it: a reader that
# stops at the match leaves the rest unwritten.
if [ -n "$GUEST_ADDRESS_FIRST" ]; then
  printf 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet %s netmask 0xffffffff
' "$GUEST_ADDRESS_FIRST"
  i=0; while [ "$i" -lt 4000 ]; do printf 'utun%s: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
	inet6 fe80::%s%%utun%s prefixlen 64 scopeid 0x%s
' "$i" "$i" "$i" "$i"; i=$((i + 1)); done
  exit 0
fi
printf 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
'
[ -f "$aliases" ] && while read -r address; do printf '	inet %s netmask 0xffffffff
' "$address"; done <"$aliases"
[ "$1" = -a ] || exit 0
printf 'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 192.168.64.5 netmask 0xffffff00 broadcast 192.168.64.255
'
[ -z "$GUEST_ADDRESS" ] || printf '	inet %s netmask 0xffffff00
' "$GUEST_ADDRESS"
`;
const sysctlGuest = '#!/bin/sh\n[ "$2" = kern.hv_vmm_present ] && echo 1\n';
function keychainCase(
  name: string,
  setup: { readonly guest: boolean; readonly marker: string | null; readonly hosts?: string },
  run: (
    step: (action: string, extra?: NodeJS.ProcessEnv) => number | null,
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
    writeFileSync(path.join(tools, "sudo"), sudoStandIn, { mode: 0o700 });
    writeFileSync(path.join(tools, "dscacheutil"), dscacheutilStandIn, { mode: 0o700 });
    writeFileSync(path.join(tools, "ifconfig"), ifconfigStandIn, { mode: 0o700 });
    writeFileSync(path.join(root, "etc-hosts"), setup.hosts ?? guestHosts);
    if (setup.guest) writeFileSync(path.join(tools, "sysctl"), sysctlGuest, { mode: 0o700 });
    if (setup.marker !== null)
      writeFileSync(path.join(root, "opensteer-job/guest-job"), setup.marker);
    // As the runner leaves it in the job's folder before the step runs.
    copyFileSync(
      path.join(import.meta.dirname, "fixture-authority-files.sh"),
      path.join(root, "opensteer-job/fixture-authority-files.sh"),
    );
    // As the runner runs it: the step arrives over stdin (`bash -s`), so a command in it that read
    // stdin would take the rest of the step with it.
    const step = (action: string, extra: NodeJS.ProcessEnv = {}) => {
      const r = spawnSync("/bin/bash", ["-s", "--", action, "opensteer-gui-job-contract"], {
        input: readFileSync(path.join(import.meta.dirname, "fixture-keychain.sh"), "utf8"),
        env: {
          HOME: root,
          // The stand-ins first; Node for the security stand-in; the system's own tools after.
          PATH: `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          ...extra,
        },
        encoding: "utf8",
        timeout: 15_000,
      });
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
const sudoCalls = (root: string) =>
  existsSync(path.join(root, "sudo-calls.jsonl"))
    ? readFileSync(path.join(root, "sudo-calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; input: string })
    : [];
const accountHostsLine =
  "192.88.99.10 account.first-run.opensteer.example # opensteer-job-fixture-authority";
const exactHostsLine =
  "/^192\\.88\\.99\\.10 account\\.first-run\\.opensteer\\.example # opensteer-job-fixture-authority$/d";
/** The addresses the step added to the guest's loopback interface and has not taken away. */
const loopbackAliases = (root: string) =>
  existsSync(path.join(root, "lo0-aliases"))
    ? readFileSync(path.join(root, "lo0-aliases"), "utf8").split("\n").filter(Boolean)
    : [];
const authorityRecord = (root: string) =>
  readFileSync(path.join(root, "opensteer-job/fixture-authority.state"), "utf8").trim().split("\n");

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
      assert.deepEqual(sudoCalls(root), [], `${action} asked anything of root`);
      assert.equal(existsSync(path.join(root, "opensteer-job/fixture-keychain.state")), false);
      assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority")), false);
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
    // The fixture keychain unlocked in the GUI session too, where the journeys' apps run; the
    // fixture authority: its files, the address on loopback and the name on it; and of root
    // nothing else: the guest's trust, and the right to change it, are never touched.
    const authority = path.join(root, "opensteer-job/fixture-authority");
    for (const file of ["ca.pem", "account.pem", "account.key"])
      assert.ok(existsSync(path.join(authority, file)), `no ${file}`);
    const asked = sudoCalls(root).map(({ args, input }) => ({ line: args.join(" "), input }));
    assert.deepEqual(
      asked.map(({ line }) => line),
      [
        `-n launchctl asuser ${process.getuid!()} security unlock-keychain -p opensteer-journey-fixture ${fixture}`,
        "-n tail -c 1 /etc/hosts",
        "-n ifconfig lo0 alias 192.88.99.10 255.255.255.255",
        "-n tee -a /etc/hosts",
      ],
    );
    assert.equal(asked[3]?.input, `${accountHostsLine}\n`);
    assert.equal(hostsOf(root), `${guestHosts}${accountHostsLine}\n`);
    assert.deepEqual(loopbackAliases(root), ["192.88.99.10"]);
    // Each recorded before it was done.
    assert.deepEqual(authorityRecord(root), ["alias 192.88.99.10", `hosts ${accountHostsLine}`]);
    assert.match(
      readFileSync(path.join(root, "begin.log"), "utf8"),
      /account\.first-run\.opensteer\.example resolves to 192\.88\.99\.10\n/u,
    );
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
    const beforeEnd = sudoCalls(root).length;
    assert.equal(step("end"), 0);
    const ended = sudoCalls(root)
      .slice(beforeEnd)
      .map(({ args }) => args.join(" "));
    // Exactly what it added: the hosts line, matched as itself, and the file as it was; the
    // address, and loopback as it was.
    assert.deepEqual(ended, [
      `-n sed -i  ${exactHostsLine} /etc/hosts`,
      "-n ifconfig lo0 -alias 192.88.99.10",
    ]);
    assert.equal(hostsOf(root), guestHosts);
    assert.deepEqual(loopbackAliases(root), []);
    assert.equal(existsSync(authority), false);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
    assert.deepEqual(state(), { default: login, list: [login, other] });
    assert.ok(calls(root).some((c) => c.join(" ") === `delete-keychain ${fixture}`));
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-keychain.state")), false);
  },
);
// A hosts file that does not end in a newline would have the line join its last entry: the step
// refuses before it changes anything.
keychainCase(
  "authority-hosts-without-final-newline",
  { guest: true, marker: "opensteer-gui-job-contract", hosts: guestHosts.trimEnd() },
  (step, root) => {
    assert.equal(step("begin"), 77);
    assert.equal(hostsOf(root), guestHosts.trimEnd());
    // The keychain is made and unlocked, in the GUI session too, before the authority refuses.
    const unlockInGuiSession = `-n launchctl asuser ${process.getuid!()} security unlock-keychain -p opensteer-journey-fixture ${path.join(root, "Library/Keychains/opensteer-journey-fixture.keychain-db")}`;
    assert.deepEqual(
      sudoCalls(root).map(({ args }) => args.join(" ")),
      [unlockInGuiSession, "-n tail -c 1 /etc/hosts"],
    );
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
    // `end` still puts the keychain back, and asks nothing of root.
    assert.equal(step("end"), 0);
    assert.deepEqual(
      sudoCalls(root).map(({ args }) => args.join(" ")),
      [unlockInGuiSession, "-n tail -c 1 /etc/hosts"],
    );
  },
);

// Interrupted while it writes the hosts line (a dropped connection, a timeout): the line is on
// record from before it was written, and `end` removes exactly it, and the address before it.
keychainCase(
  "authority-interrupted-while-writing-hosts",
  { guest: true, marker: "opensteer-gui-job-contract" },
  (step, root) => {
    assert.notEqual(step("begin", { SUDO_KILL: "tee" }), 0);
    assert.deepEqual(authorityRecord(root), ["alias 192.88.99.10", `hosts ${accountHostsLine}`]);
    const before = sudoCalls(root).length;
    assert.equal(step("end"), 0);
    assert.deepEqual(
      sudoCalls(root)
        .slice(before)
        .map(({ args }) => args.join(" ")),
      [`-n sed -i  ${exactHostsLine} /etc/hosts`, "-n ifconfig lo0 -alias 192.88.99.10"],
    );
    assert.equal(hostsOf(root), guestHosts);
    assert.deepEqual(loopbackAliases(root), []);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority")), false);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
  },
);

// A removal that fails keeps the record and the files, so another `end` can finish.
for (const [name, failing] of [
  ["authority-removal-fails", "sed"],
  ["authority-alias-removal-fails", "-alias"],
] as const)
  keychainCase(name, { guest: true, marker: "opensteer-gui-job-contract" }, (step, root) => {
    assert.equal(step("begin"), 0);
    assert.equal(step("end", { SUDO_FAIL: failing }), 1);
    if (failing === "sed") assert.match(hostsOf(root), /opensteer-job-fixture-authority\n$/u);
    else assert.deepEqual(loopbackAliases(root), ["192.88.99.10"]);
    assert.ok(existsSync(path.join(root, "opensteer-job/fixture-authority.state")));
    assert.ok(existsSync(path.join(root, "opensteer-job/fixture-authority/ca.pem")));
    assert.equal(step("end"), 0);
    assert.equal(hostsOf(root), guestHosts);
    assert.deepEqual(loopbackAliases(root), []);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority")), false);
  });

// Interrupted while it adds the address: on record from before, and `end` takes it away; no hosts
// line was written, so none is removed.
keychainCase(
  "authority-interrupted-while-adding-the-address",
  { guest: true, marker: "opensteer-gui-job-contract" },
  (step, root) => {
    assert.notEqual(step("begin", { SUDO_KILL: "alias" }), 0);
    assert.deepEqual(authorityRecord(root), ["alias 192.88.99.10"]);
    assert.equal(hostsOf(root), guestHosts);
    const before = sudoCalls(root).length;
    assert.equal(step("end"), 0);
    assert.deepEqual(
      sudoCalls(root)
        .slice(before)
        .map(({ args }) => args.join(" ")),
      ["-n ifconfig lo0 -alias 192.88.99.10"],
    );
    assert.deepEqual(loopbackAliases(root), []);
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
  },
);

// The address is already one of the guest's: not the step's to add, nor to take away after. It
// refuses before it records or changes anything, and `end` leaves the address where it is. Also
// where ifconfig names it on its first line and writes on long after the match (the re-check of
// e7080ea31..963f808d0: a reader that stops early broke the pipe, and pipefail read it as absent).
for (const [name, listing] of [
  ["authority-address-already-held", { GUEST_ADDRESS: "192.88.99.10" }],
  ["authority-address-held-on-the-first-line", { GUEST_ADDRESS_FIRST: "192.88.99.10" }],
] as const)
  keychainCase(name, { guest: true, marker: "opensteer-gui-job-contract" }, (step, root) => {
    assert.equal(step("begin", listing), 77);
    // The keychain is made and unlocked, in the GUI session too, before the authority refuses.
    const unlockInGuiSession = `-n launchctl asuser ${process.getuid!()} security unlock-keychain -p opensteer-journey-fixture ${path.join(root, "Library/Keychains/opensteer-journey-fixture.keychain-db")}`;
    assert.deepEqual(
      sudoCalls(root).map(({ args }) => args.join(" ")),
      [unlockInGuiSession, "-n tail -c 1 /etc/hosts"],
    );
    assert.equal(existsSync(path.join(root, "opensteer-job/fixture-authority.state")), false);
    assert.match(
      readFileSync(path.join(root, "begin.log"), "utf8"),
      /refused: 192\.88\.99\.10 is already an address of this guest/u,
    );
    assert.equal(step("end", listing), 0);
    assert.deepEqual(
      sudoCalls(root).map(({ args }) => args.join(" ")),
      [unlockInGuiSession, "-n tail -c 1 /etc/hosts"],
    );
  });

writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(out, JSON.stringify(results, null, 2));
if (results.some((r) => !r.passed)) process.exitCode = 1;
