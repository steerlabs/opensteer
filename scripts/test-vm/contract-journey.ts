/** Executes the real runner with disposable command transports; never starts a VM. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tryKernelLock } from "@opensteer/shared/kernelLock";

const out = realpathSync(mkdtempSync(path.join(tmpdir(), "opensteer-vm-contract-")));
const runner = path.resolve("scripts/test-vm.ts");
const sha = "c57dd74a1c6fbd35cd1a07bf5a3f22c89b26f014";
const results: { name: string; passed: boolean; error?: string }[] = [];
const mock = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const home=process.env.HOME, file=path.join(home,'transport.json');
const name=path.basename(process.argv[1]), args=process.argv.slice(2);
const lock=file+'.lock';let locked=false;
for(let i=0;i<500;i++){try{fs.mkdirSync(lock);locked=true;break}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}
if(!locked)throw new Error('transport lock timeout');
const state=JSON.parse(fs.readFileSync(file));
state.calls.push([name,...args]);
function save(){if(!locked)return;fs.writeFileSync(file,JSON.stringify(state));fs.rmdirSync(lock);locked=false}
function fail(){save();process.exit(7)}
if(name==='git'&&state.scenario==='dirty'&&args.includes('status')){console.log(' M dirty');save();process.exit(0)}
if(name==='git'){console.log(args.includes('rev-parse')?(args.includes('--git-common-dir')?home:process.env.CONTRACT_SHA):'');save();process.exit(0)}
if(name==='tart'){
 const [op,...a]=args;
 if(op==='list'){console.log(JSON.stringify(state.vms));save();process.exit(0)}
 if(op==='clone'){state.vms.push({Name:a[1],State:'stopped'});save();if(state.scenario==='partial')process.exit(7)}
 if(op==='run'){state.bootPid=process.pid;state.vms.find(v=>v.Name===a[0]).State='running';save();setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));return}
 if(op==='ip')console.log('192.0.2.1');
 if(op==='stop'){const v=state.vms.find(v=>v.Name===a[0]);if(v)v.State='stopped'}
 if(op==='delete'){state.vms=state.vms.filter(v=>v.Name!==a[0]);fs.rmSync(path.join(home,'.tart/vms',a[0]),{recursive:true,force:true})}
 save();process.exit(0)
}
if(name==='ssh'){
 const cmd=args.at(-1);
 if(cmd.includes('shutdown')){state.vms.forEach(v=>v.State='stopped');save();process.kill(state.bootPid,'SIGTERM');process.exit(0)}
 if(cmd.includes('provision-mobile')){
  if(state.scenario==='provision')fail();
  if(state.scenario==='floor'){state.floor=true;save();setInterval(()=>{},1000);return}
  if(state.scenario==='cancel'){save();process.kill(Number(process.env.CONTRACT_PARENT),'SIGTERM');setInterval(()=>{},1000);return}
 }
 if(cmd.includes('verify-mobile')&&state.scenario==='verify')fail();
 if(cmd.includes('rsync'))state.exported=true;
 save();process.stdin.resume();process.stdin.on('end',()=>process.exit(0));return
}
save();
`;
// Bootstrap transport records the detached VM PID without adding a production hook.
const preload = String.raw`import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=fs.statfsSync;fs.statfsSync=(...args)=>{const s=JSON.parse(fs.readFileSync(process.env.HOME+'/transport.json'));return {...original(...args),bavail:(s.floor?29:100)*1024**3,bsize:1}};
const spawn=cp.spawn;cp.spawn=(cmd,args,opts)=>{if(cmd==='ssh')opts.env.CONTRACT_PARENT=String(process.pid);return spawn(cmd,args,opts)};syncBuiltinESMExports();`;

async function journey(name: string, args: string[], scenario = "normal") {
  const home = path.join(out, name);
  const bin = path.join(home, "bin");
  const inputs = path.join(home, "inputs");
  mkdirSync(bin, { recursive: true });
  mkdirSync(inputs);
  const state = path.join(home, ".local/state/opensteer");
  mkdirSync(path.join(state, "vm-golden"), { recursive: true });
  writeFileSync(path.join(state, "vm-golden/id_ed25519"), "existing-key");
  const payload = path.join(home, ".cache/opensteer/vm", sha);
  mkdirSync(payload, { recursive: true });
  writeFileSync(path.join(payload, "payload.tar"), "payload");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  writeFileSync(
    path.join(payload, "payload.json"),
    JSON.stringify({
      sourceSha: sha,
      sha256: hash("payload"),
      bytes: 7,
      nativeDistributionSource: "seed",
      builtAt: 1,
    }),
  );
  writeFileSync(path.join(payload, "last-used"), "");
  writeFileSync(path.join(inputs, "xcode.tar"), "xcode");
  writeFileSync(path.join(inputs, "runtime.tar"), "runtime");
  const manifest = {
    xcode: {
      version: "27.1",
      build: scenario === "wrong" ? "wrong" : "27A9275",
      bytes: 5,
      sha256: hash("xcode"),
    },
    runtime: { version: "27.1", build: "24A94425", bytes: 7, sha256: hash("runtime") },
  };
  writeFileSync(path.join(inputs, "manifest.json"), JSON.stringify(manifest));
  if (scenario === "symlink") {
    symlinkSync(inputs, path.join(home, "link"));
  }
  const vms = [{ Name: "opensteer-gui-golden", State: "stopped" }];
  if (["exists", "job", "retention"].includes(scenario))
    vms.push({ Name: "opensteer-mobile-golden", State: "stopped" });
  if (["job", "retention"].includes(scenario))
    writeFileSync(path.join(state, "vm-mobile-golden.json"), JSON.stringify(manifest));
  const retention = scenario === "retention" ? await oldOutputs(home, vms) : undefined;
  writeFileSync(path.join(home, "transport.json"), JSON.stringify({ calls: [], vms, scenario }));
  for (const cmd of ["tart", "ssh", "git"])
    writeFileSync(path.join(bin, cmd), mock, { mode: 0o700 });
  writeFileSync(path.join(home, "preload.mjs"), preload);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      runner,
      ...args.map((a) =>
        a === "INPUT" ? (scenario === "symlink" ? path.join(home, "link") : inputs) : a,
      ),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_OPTIONS: `--import=${path.join(home, "preload.mjs")}`,
        CONTRACT_SHA: sha,
        CONTRACT_SCENARIO: scenario,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (b) => {
    log += String(b);
  });
  child.stderr.on("data", (b) => {
    log += String(b);
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  retention?.release();
  clearTimeout(timeout);
  writeFileSync(path.join(home, "runner.log"), log);
  const observed = JSON.parse(readFileSync(path.join(home, "transport.json"), "utf8")) as {
    calls: string[][];
    vms: { Name: string; State: string }[];
    exported?: boolean;
  };
  assert.deepEqual(
    observed.vms.find((v) => v.Name === "opensteer-gui-golden"),
    { Name: "opensteer-gui-golden", State: "stopped" },
  );
  assert.equal(readFileSync(path.join(state, "vm-golden/id_ed25519"), "utf8"), "existing-key");
  return { code, observed, log, home };
}

const runIds = {
  unreferenced: "20261001T000000Z-0000000a",
  receipt: "20261001T000000Z-0000000b",
  release: "20261001T000000Z-0000000c",
  handoff: "20261001T000000Z-0000000d",
  unknown: "20261001T000000Z-0000000e",
  recent: "20261026T000000Z-0000000f",
  live: "20261027T000000Z-00000011",
  tartRunning: "20261027T000000Z-00000012",
  dead: "20261027T000000Z-00000013",
  deadOld: "20261001T000000Z-00000014",
  stalled: "20261001T000000Z-00000015",
  noted: "20261001T000000Z-00000016",
  linked: "20261001T000000Z-00000017",
  linkTarget: "20261001T000000Z-00000018",
  unrecorded: "20261001T000000Z-000000ff",
};
const deletedRuns = [runIds.unreferenced, runIds.deadOld];
const caches = {
  unused: "1".repeat(40),
  inUse: "2".repeat(40),
  recent: "3".repeat(40),
  bareLock: "4".repeat(40),
  namedByLive: "5".repeat(40),
  badLock: "6".repeat(40),
};
const clone = (runId: string) => `opensteer-gui-job-${runId}`;

/** Old VM outputs beside live ones; only the unused, unreferenced and finished may go. */
async function oldOutputs(home: string, vms: { Name: string; State: string }[]) {
  const state = path.join(home, ".local/state/opensteer");
  const cache = path.join(home, ".cache/opensteer/vm");
  const day = 86_400;
  const now = Date.now() / 1000;
  const dead = spawn(process.execPath, ["-e", ""]);
  const deadPid = dead.pid!;
  await new Promise((resolve) => dead.on("close", resolve));
  const jobs: Record<string, Record<string, number | string> | undefined> = {
    [runIds.unreferenced]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.receipt]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.release]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.handoff]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.unknown]: undefined,
    [runIds.recent]: { startedAt: now - 23 * 3600, endedAt: now - 23 * 3600 },
    [runIds.live]: { startedAt: now - 600, pid: process.pid, sha: caches.namedByLive },
    [runIds.tartRunning]: { startedAt: now - 600, endedAt: now - 60 },
    [runIds.dead]: { startedAt: now - 600, pid: deadPid },
    // Old by its start, but only a recorded end or a dead runner proves it finished.
    [runIds.deadOld]: { startedAt: now - 20 * day, pid: deadPid },
    [runIds.stalled]: { startedAt: now - 20 * day, pid: process.pid },
    [runIds.noted]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.linked]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
    [runIds.linkTarget]: { startedAt: now - 20 * day, endedAt: now - 20 * day },
  };
  for (const [runId, job] of Object.entries(jobs)) {
    mkdirSync(path.join(state, "vm-runs", runId, "guest"), { recursive: true });
    writeFileSync(path.join(state, "vm-runs", runId, "guest/evidence.bin"), Buffer.alloc(1 << 20));
    if (job)
      writeFileSync(
        path.join(state, "vm-runs", runId, "job.json"),
        JSON.stringify({ runId, ...job }),
      );
  }
  writeFileSync(path.join(state, "vm-runs/notes.md"), "not a run\n");
  mkdirSync(path.join(state, "check-evidence", sha), { recursive: true });
  writeFileSync(
    path.join(state, "check-evidence", sha, "receipt.json"),
    JSON.stringify({ evidence: path.join(state, "vm-runs", runIds.receipt) }),
  );
  mkdirSync(path.join(state, "release-0.1.300-local", sha), { recursive: true });
  writeFileSync(
    path.join(state, "release-0.1.300-local", sha, "release.json"),
    JSON.stringify({ identity: { version: "0.1.300", sourceRevision: sha }, gui: runIds.release }),
  );
  mkdirSync(path.join(state, "work/certification"), { recursive: true });
  writeFileSync(
    path.join(state, "work/certification/handoff.md"),
    `Native proof: ~/.local/state/opensteer/vm-runs/${runIds.handoff}\n`,
  );
  // Any file naming a run keeps it, including through a symlink or in the link itself.
  writeFileSync(
    path.join(state, "work/certification/findings.json"),
    JSON.stringify([runIds.noted]),
  );
  writeFileSync(path.join(home, "outside-note.txt"), `${runIds.linked}\n`);
  symlinkSync(path.join(home, "outside-note.txt"), path.join(state, "work/linked-handoff.md"));
  symlinkSync(path.join(state, "vm-runs", runIds.linkTarget), path.join(state, "work/latest"));
  for (const runId of [runIds.live, runIds.tartRunning, runIds.dead, runIds.unrecorded]) {
    vms.push({ Name: clone(runId), State: "stopped" });
    mkdirSync(path.join(home, ".tart/vms", clone(runId)), { recursive: true });
    writeFileSync(path.join(home, ".tart/vms", clone(runId), "disk.img"), Buffer.alloc(1 << 20));
  }
  for (const golden of ["opensteer-gui-golden", "opensteer-mobile-golden"]) {
    mkdirSync(path.join(home, ".tart/vms", golden), { recursive: true });
    writeFileSync(path.join(home, ".tart/vms", golden, "disk.img"), "golden");
  }
  const tart = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
    "tart",
    "run",
    clone(runIds.tartRunning),
  ]);
  const old = now - 5 * day;
  for (const entry of [
    caches.unused,
    caches.inUse,
    caches.recent,
    caches.namedByLive,
    caches.badLock,
  ]) {
    mkdirSync(path.join(cache, entry), { recursive: true });
    writeFileSync(path.join(cache, entry, "payload.tar"), Buffer.alloc(1 << 20));
    writeFileSync(
      path.join(cache, entry, "payload.json"),
      JSON.stringify({ builtAt: entry === caches.badLock ? old - 1 : old }),
    );
    if (entry !== caches.badLock) writeFileSync(path.join(cache, `${entry}.lock`), "");
  }
  writeFileSync(path.join(cache, caches.inUse, "last-used"), "");
  utimesSync(path.join(cache, caches.inUse, "last-used"), old, old);
  writeFileSync(path.join(cache, caches.recent, "last-used"), "");
  writeFileSync(path.join(cache, `${caches.bareLock}.lock`), "");
  // A lock retention cannot open is a problem to log and skip, not a reason to fail the job.
  symlinkSync(path.join(home, "outside-note.txt"), path.join(cache, `${caches.badLock}.lock`));
  mkdirSync(path.join(cache, "native-resources/personal-runtime"), { recursive: true });
  writeFileSync(path.join(cache, "native-resources/personal-runtime/release.json"), "{}");
  utimesSync(path.join(cache, "native-resources"), old, old);
  const inUse = tryKernelLock(path.join(cache, `${caches.inUse}.lock`));
  assert.ok(inUse !== undefined);
  return {
    release() {
      closeSync(inUse);
      tart.kill("SIGKILL");
    },
  };
}
const cases: [string, string[], string, boolean][] = [
  ["invalid", ["--mobile-golden", "--revision", sha], "normal", false],
  [
    "missing",
    ["--mobile-golden", "--tooling-inputs", "/nonexistent/opensteer-input"],
    "normal",
    false,
  ],
  ["symlink", ["--mobile-golden", "--tooling-inputs", "INPUT"], "symlink", false],
  ["wrong", ["--mobile-golden", "--tooling-inputs", "INPUT"], "wrong", false],
  ["exists", ["--mobile-golden", "--tooling-inputs", "INPUT"], "exists", false],
  ...["partial", "provision", "verify", "floor", "cancel"].map(
    (s) =>
      [s, ["--mobile-golden", "--tooling-inputs", "INPUT"], s, false] as [
        string,
        string[],
        string,
        boolean,
      ],
  ),
  ["bootstrap", ["--mobile-golden", "--tooling-inputs", "INPUT"], "normal", true],
  ["job", ["--mobile", "--revision", sha, "true"], "job", true],
  ["inputs", ["--mobile", "--inputs", "INPUT", "--revision", sha, "true"], "job", true],
  ["dirty-job", ["--mobile", "--revision", sha, "true"], "dirty", false],
  ["retention", ["--mobile", "--revision", sha, "true"], "retention", true],
];
const selected = process.argv.slice(2);
if (selected.some((name) => !cases.some(([candidate]) => candidate === name)))
  throw new Error("Unknown contract case");
for (const [name, args, scenario, success] of cases.filter(
  ([name]) => !selected.length || selected.includes(name),
)) {
  try {
    const r = await journey(name, args, scenario);
    assert.equal(r.code === 0, success, r.log);
    if (name === "inputs") {
      const boot = r.observed.calls.find((c) => c[0] === "tart" && c[1] === "run");
      assert.ok(
        boot?.some((arg) => arg.startsWith("--dir=inputs:") && arg.endsWith(":ro")),
        "input share must be read only",
      );
    }
    const cloned = r.observed.calls.find((c) => c[0] === "tart" && c[1] === "clone");
    if (["partial", "provision", "verify", "floor", "cancel"].includes(name)) {
      assert.ok(cloned, "failure must reach lifecycle");
      assert.ok(
        r.observed.calls.some((c) => c[0] === "tart" && c[1] === "delete" && c[2] === cloned[3]),
      );
      assert.equal(
        r.observed.vms.some((v) => v.Name === "opensteer-mobile-golden"),
        false,
      );
    }
    if (name === "bootstrap") {
      assert.equal(cloned?.[2], "opensteer-gui-golden");
      assert.ok(r.observed.calls.some((c) => c[0] === "tart" && c.includes("--disk-size")));
      assert.ok(
        r.observed.calls.some(
          (c) =>
            c[0] === "tart" &&
            c[1] === "run" &&
            c.some((a) => a.startsWith("--dir=tooling:") && a.endsWith(":ro")),
        ),
      );
      assert.deepEqual(
        r.observed.vms.find((v) => v.Name === "opensteer-mobile-golden"),
        { Name: "opensteer-mobile-golden", State: "stopped" },
      );
    }
    if (name === "job") {
      assert.equal(cloned?.[2], "opensteer-mobile-golden");
      assert.equal(r.observed.exported, true);
      assert.equal(r.observed.vms.length, 2);
    }
    if (["invalid", "missing", "symlink", "wrong", "exists"].includes(name))
      assert.equal(cloned, undefined);
    // A checkout that cannot run fails at once, before it builds or clones anything.
    if (name === "dirty-job") {
      assert.match(r.log, /Source must be clean/u);
      assert.equal(cloned, undefined);
    }
    if (name === "retention") {
      const state = path.join(r.home, ".local/state/opensteer");
      const cache = path.join(r.home, ".cache/opensteer/vm");
      const runs = readdirSync(path.join(state, "vm-runs"));
      const own = runs.find((run) => !Object.values(runIds).includes(run) && run !== "notes.md");
      assert.ok(own, "the job records its own run");
      const job = JSON.parse(readFileSync(path.join(state, "vm-runs", own, "job.json"), "utf8"));
      assert.equal(job.checkout, realpathSync("."));
      assert.equal(job.checkoutHead, sha);
      assert.equal(job.pid > 0, true);
      // Only old, finished, unreferenced runs go; references, unknowns, live owners and
      // recent runs stay.
      assert.deepEqual(
        runs.filter((run) => run !== own).sort(),
        [
          ...Object.values(runIds).filter(
            (run) => ![...deletedRuns, runIds.unrecorded].includes(run),
          ),
          "notes.md",
        ].sort(),
      );
      // Only the dead job's clone goes: never a golden, a live job's or one a tart process runs.
      assert.deepEqual(
        r.observed.vms.map((vm) => vm.Name).sort(),
        [
          "opensteer-gui-golden",
          "opensteer-mobile-golden",
          clone(runIds.live),
          clone(runIds.tartRunning),
          clone(runIds.unrecorded),
        ].sort(),
      );
      // Only the unused, unheld cache unnamed by a live job goes, and never a lock file.
      assert.deepEqual(
        readdirSync(cache)
          .filter((entry) => entry !== sha && entry !== `${sha}.lock`)
          .sort(),
        [
          `${caches.unused}.lock`,
          caches.inUse,
          `${caches.inUse}.lock`,
          caches.recent,
          `${caches.recent}.lock`,
          `${caches.bareLock}.lock`,
          caches.namedByLive,
          `${caches.namedByLive}.lock`,
          caches.badLock,
          `${caches.badLock}.lock`,
          "native-resources",
        ].sort(),
      );
      assert.ok(existsSync(path.join(cache, sha, "payload.tar")));
      const log = readFileSync(path.join(state, "vm-runs", own, "retention.log"), "utf8");
      for (const deleted of [
        ...deletedRuns.map((run) => `run ${path.join(state, "vm-runs", run)}`),
        `clone ${clone(runIds.dead)}`,
        `cache ${path.join(cache, caches.unused)}`,
      ])
        assert.match(
          log,
          new RegExp(`deleted ${deleted.replaceAll(".", "\\.")} \\(1\\.\\d MiB\\)`, "u"),
        );
      assert.match(log, new RegExp(`kept cache .*${caches.badLock}: .*ELOOP`, "u"));
    }
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
  }
}
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(out, JSON.stringify(results, null, 2));
if (results.some((r) => !r.passed)) process.exitCode = 1;
