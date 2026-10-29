import assert from "node:assert/strict";
import { readMacAppManifest, verifyMacAppTree, writeMacAppManifest } from "./mac-app-delivery.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  access,
  cp,
  readdir,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessCatalog, shipsHarnessRuntimeBytes } from "../packages/core/src/harness-catalog.js";
import { acquireReleaseLock, runBounded } from "./command-runner.js";
import { agentPhoneReleaseSignerSha256 } from "./release-agent-phone.cjs";
import { main as installLocalMain } from "./install-beta-mac-local.js";
import {
  installMac,
  installLocalMac,
  localMacConfigSchema,
  preflightMac,
  preflightLocalMac,
  verifyLocalMac,
  macConfigSchema,
  prepareMac,
  stageMac,
  verifyMac,
  type MacContext,
} from "./release-beta-mac.js";

// Provider processes simulate Apple's/SSH's external protocol, while the real
// adapter reads/writes receipts and resumes in separate CLI invocations.
//
// A target's simulated Opensteer Beta keeps running for `exitAfter` process
// observations after a quit request, or until the phase is cancelled when that
// is null, and can start again just before the bundle rename. A process from
// the bundle an earlier installation retained is always running and is never
// the one being replaced.
const provider = `
(() => {
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const [stateFile, executable, argsJson, optionsJson] = process.argv.slice(1);
const args = JSON.parse(argsJson);
const options = JSON.parse(optionsJson);
const env = options.env ?? {};
// Only the tiny provider-state transaction is serialized; build workers remain
// concurrent. Fake writes must not race on one receipt/temp file.
const stateLock = stateFile + '.provider-lock';
let ownsStateLock = false;
process.on('exit', () => { if (ownsStateLock) fs.rmdirSync(stateLock); });
const lockDeadline = Date.now() + 10000;
while (!ownsStateLock) {
  try { fs.mkdirSync(stateLock); ownsStateLock = true; }
  catch (error) { if (error.code !== 'EEXIST' || Date.now() > lockDeadline) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
}
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.observations ??= [];
state.quits ??= [];
state.renames ??= [];
const remote = executable === '/usr/bin/ssh';
const target = remote ? 'remote' : 'local';
const command = remote ? args.at(-1) : [executable, ...args].join(' ');
const invokes = name => remote ? command.startsWith("'" + name + "' ") : executable === name;
const at = Date.now();
const save = () => {
  fs.writeFileSync(stateFile + '.next-' + process.pid, JSON.stringify(state));
  fs.renameSync(stateFile + '.next-' + process.pid, stateFile);
};
state.calls.push({ at, executable, args, timeoutMs: options.timeoutMs, cwd: options.cwd, env: Object.fromEntries(Object.entries(env).filter(([key]) => /^(OPENSTEER_|APPLE_|CSC_|ANDROID_HOME)/.test(key) && !/PASSWORD/.test(key))) });
save();
fs.rmdirSync(stateLock); ownsStateLock = false;
if (state.mode.startsWith('local-') && (remote || executable === 'gh' || /notarytool|stapler|spctl|gcloud|github|infra|\\bscp\\b/.test(command))) throw Error('Forbidden distribution/provider call: ' + command);
const app = state.apps?.[target];
const realLocal = state.realLocal;
const runReal = (argv = args) => {
  const result = spawnSync(executable, argv, {encoding:'utf8'});
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw Error('Fixture command failed: ' + executable + ' ' + (result.error?.message ?? result.signal ?? result.status));
};
const write = (file, bytes, mode) => {fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, bytes, {mode});};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runtime = (directory) => {
  const entrypoints = Object.fromEntries(['browserHarness','channelRuntime','host','initdb','nativeFsHelper','node','pgIsReady','postgres','runner'].map(name => [name,'bin/'+name]));
  const harnessEntries = ${JSON.stringify(harnessCatalog.filter(shipsHarnessRuntimeBytes).map((entry) => ({ kind: entry.kind, path: entry.runtime.path, mode: entry.runtime.shape === "script" ? "code" : "executable" })))};
  const harnesses = Object.fromEntries(harnessEntries.map(entry => [entry.kind,entry.path]));
  const files = [];
  for (const entry of [...Object.values(entrypoints).map(path => ({path, mode:'executable'})), ...harnessEntries]) {
    const bytes = Buffer.alloc(64); bytes.writeUInt32BE(0xfeedfacf); bytes.writeUInt32BE(0x0100000c,4);
    write(path.join(directory,entry.path), bytes, entry.mode === 'executable' ? 0o755 : 0o644);
    files.push({path:entry.path,mode:entry.mode,sha256:hash(bytes)});
  }
  for (const [relative,bytes] of [['agent-skills/plugin.json','{}'],['agent-skills/skills/fixture/SKILL.md','# Fixture'],['web/index.html','<title>Fixture</title>'],['web/opensteer-web.json','{}']]) {
    write(path.join(directory,relative),bytes); files.push({path:relative,mode:'data',sha256:hash(bytes)});
  }
  const manifest = JSON.stringify({schemaVersion:7,architecture:'arm64',operatingSystem:'darwin',entrypoints,harnesses,files,hostVersion:'1.2.3',runnerVersion:'1.2.3',postgresMajor:17,postgresVersion:'17.4.0',assets:{agentSkills:'agent-skills',webDistribution:{directory:'web',hostVersion:'1.2.3',manifest:'web/opensteer-web.json'}}});
  write(path.join(directory,'release.json'),manifest);
  write(directory+'.provenance.json',JSON.stringify({schemaVersion:1,sourceRevision:state.revision,version:'1.2.3',runnerSourceRevision:env.OPENSTEER_RUNNER_SOURCE_REVISION ?? state.revision,releaseManifestSha256:hash(manifest)}));
};
if (path.basename(executable) === 'postgres' && executable.startsWith(path.dirname(stateFile)+'/') && JSON.stringify(args) === '["--version"]') {
  runReal(); process.exit(0);
}
if (realLocal && executable === 'python3' && args[2] === 'release-beta-cleanup') {
  if (!args[3].startsWith(path.dirname(stateFile)+'/') || !/^[a-f0-9]{40}$/.test(args[4])) throw Error('Cleanup escaped temporary directory');
  if (state.failPrune) { state.failPrune=false; save(); throw Error('Interrupted backup cleanup'); }
  runReal(); process.exit(0);
}
if (executable === 'python3' && args[2] === 'release-beta-cleanup') { process.stdout.write(JSON.stringify({removed:[],unowned:[],warnings:[]})); process.exit(0); }
if (realLocal && executable === 'python3' && args[0]?.endsWith('/mac-app-tree.py')) { runReal(); process.exit(0); }
if (realLocal && executable === '/bin/cp' && args[0] === '-cRpP') {
  if (state.mode === 'local-cli-clone-fallback') {process.stderr.write('clonefile: Operation not supported'); process.exit(1);}
  runReal();
  const next = args.at(-1);
  if (next.endsWith('.next')) {
    if (state.mode === 'local-cli-extra-file') write(path.join(next,'extra'),'unlisted');
    if (state.mode === 'local-cli-altered-link') {fs.unlinkSync(path.join(next,'Contents/Current')); fs.symlinkSync('Resources',path.join(next,'Contents/Current'));}
    if (state.mode === 'local-cli-modified-byte') fs.appendFileSync(path.join(next,'Contents/Info.plist'),' ');
    if (state.mode === 'local-cli-bad-signature') {} // Signature provider below rejects it.
    if (state.mode === 'local-cli-bad-digest') write(path.join(next,'Contents/Resources/personal-runtime/release.json'),'tampered copied manifest');
    if (state.mode === 'local-cli-interrupted-copy' && !state.interruptedCopy) {state.interruptedCopy=true;save();fs.unlinkSync(path.join(next,'Contents/Info.plist'));process.stderr.write('copy interrupted');process.exit(47);}
  }
  process.exit(0);
}
if (realLocal && ['/bin/test','/bin/mkdir','/bin/cp','/usr/bin/ditto','/usr/bin/shasum','/usr/libexec/PlistBuddy'].includes(executable)) {
  runReal(); process.exit(0);
}
if (realLocal && executable === '/bin/sh' && ['release-beta-prepare','release-beta-install','release-beta-rollback-identity','release-beta-restore'].includes(args[2])) {
  if (!args.slice(3).every(value => value.startsWith(path.dirname(stateFile)+'/'))) throw Error('Shell fixture escaped temporary directory');
  let shellArgs = args;
  if (args[2] === 'release-beta-install' && ['local-cli-interrupted-rename','local-retention-interrupted-rename'].includes(state.mode) && !state.interrupted) {
    state.interrupted = true; save();
    const boundary = '; /bin/mv "$next" "$app"';
    if (!args[1].endsWith(boundary)) throw Error('Rename interruption boundary changed');
    shellArgs = [...args]; shellArgs[1] = args[1].slice(0,-boundary.length) + '; kill -TERM $$' + boundary;
  }
  runReal(shellArgs);
  if (args[2] === 'release-beta-prepare' && state.mode === 'local-cli-bad-digest') write(path.join(args[4],'Contents/Resources/personal-runtime/release.json'),'tampered copied manifest');
  if (args[2] === 'release-beta-install') { state.localInstalled = true; state.renames.push({at,target,call:state.calls.length-1,renamed:true}); save(); }
  process.exit(0);
}
if (realLocal && executable === 'pnpm') {
  if (JSON.stringify(args) === JSON.stringify(['install','--frozen-lockfile','--prefer-offline'])) process.exit(0);
  if (args[2] === 'scripts/build-agent-phone.ts' && args[3] === '--release' && args[4] === '--output' && args.length === 6) {
    const apk = Buffer.from('fixture release APK');
    write(path.join(args[5],'opensteer-agent-phone.apk'),apk);
    write(path.join(args[5],'agent-phone.json'),JSON.stringify({apkSha256:hash(apk),apkSize:apk.length,buildType:'release',minSdk:30,packageName:'com.opensteer.agentphone',signingCertSha256:'${agentPhoneReleaseSignerSha256}',versionCode:123,versionName:'1.2.3'}));
    process.exit(0);
  }
  if (args[0] === '--filter' && args[1] === '@opensteer/desktop') {
    if (JSON.stringify(args.slice(2)) === JSON.stringify(['exec','tsx','scripts/build-personal-runtime.ts'])) {runtime(env.OPENSTEER_PERSONAL_RUNTIME_OUTPUT); process.exit(0);}
    if (args[2] === 'exec' && args[3] === 'tsx' && ['scripts/build-computer-use-helper.ts','scripts/build-passwords-broker.ts'].includes(args[4]) && args[5] === '--sign' && args[6] === state.signingIdentity && args.length === 7) process.exit(0);
    if (args.length === 3 && args[2] === 'package:mac') {
      const bundle = path.join(options.cwd,'apps/desktop/release/beta/mac-arm64/Opensteer Beta.app');
      fs.rmSync(bundle,{recursive:true,force:true});
      const resources = path.join(bundle,'Contents/Resources');
      write(path.join(bundle,'Contents/Info.plist'),'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'+Object.entries({CFBundleIdentifier:'com.steerlabs.opensteer.beta',CFBundleShortVersionString:'1.2.3',CFBundleVersion:'1.2.3',OpensteerSourceRevision:state.revision}).map(([key,value]) => '<key>'+key+'</key><string>'+value+'</string>').join('')+'</dict></plist>',0o640);
      fs.cpSync(env.OPENSTEER_PERSONAL_RUNTIME_SOURCE,path.join(resources,'personal-runtime'),{recursive:true});
      fs.cpSync(path.join(options.cwd,'apps/desktop/generated-resources/agent-phone'),path.join(resources,'agent-phone'),{recursive:true});
      for (const [input,output] of [[env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE,'process-supervisor/opensteer-process-supervisor'],[env.OPENSTEER_CLOUDFLARED_BINARY_SOURCE,'cloudflared/cloudflared']]) write(path.join(resources,output),fs.readFileSync(input));
      fs.mkdirSync(path.join(resources,'computer-use/Opensteer Computer Use.app'),{recursive:true});
      fs.symlinkSync('Info.plist',path.join(bundle,'Contents','Current'));
      const metadata = spawnSync('/usr/bin/xattr',['-w','com.opensteer.fixture','preserved',path.join(bundle,'Contents/Info.plist')]);
      if (metadata.status !== 0) throw Error('Fixture xattr creation failed');
      if (spawnSync('/bin/chmod',['+a','everyone allow read',path.join(bundle,'Contents/Info.plist')]).status !== 0) throw Error('Fixture ACL creation failed');
      if (spawnSync('/usr/bin/chflags',['hidden',path.join(bundle,'Contents/Info.plist')]).status !== 0) throw Error('Fixture flags creation failed');
      process.exit(0);
    }
  }
  throw Error('Unknown fixture pnpm command: '+JSON.stringify(args));
}
if (realLocal && ['java','javac'].includes(path.basename(executable)) && JSON.stringify(args) === '["--version"]') {process.stdout.write(path.basename(executable) === 'java' ? 'openjdk 17.0.1' : 'javac 17.0.1'); process.exit(0);}
if (realLocal && executable === 'keytool' && args.length === 8 && args[0] === '-exportcert' && args[1] === '-rfc' && args[2] === '-keystore' && args[4] === '-alias' && args[6] === '-storepass:env' && args[7] === 'OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD') {process.stdout.write(fs.readFileSync(state.certificate)); process.exit(0);}
const processList = remote ? command === "'/bin/ps' '-axo' 'pid=,command='" : executable === '/bin/ps' && JSON.stringify(args) === '["-axo","pid=,command="]';
if (app && processList) {
  if (app.running && app.quitRequests > 0 && app.exitAfter !== null && app.observedAfterQuit >= app.exitAfter) app.running = false;
  if (app.running && app.quitRequests > 0) app.observedAfterQuit += 1;
  state.observations.push({ at, target, running: app.running, call: state.calls.length - 1 });
  save();
  process.stdout.write((app.running ? '4242 '+(state.applicationPath ?? '/Applications/Opensteer Beta.app')+'/Contents/MacOS/Opensteer Beta\\n' : '') + '/Applications/Opensteer Beta.app.' + '0'.repeat(40) + '.previous/Contents/MacOS/Opensteer Beta\\n');
} else if (processList) {
  // Targets without an app simulation have no running process to quit.
} else if (app && executable === '/usr/bin/osascript' || app && remote && command.startsWith("'/usr/bin/osascript'")) {
  if (state.mode === 'local-cli-after-quit-tamper') write(path.join(state.applicationPath + '.' + state.revision + '.next','extra-after-quit'),'unlisted');
  app.quitRequests += 1;
  state.quits.push({ at, target, call: state.calls.length - 1 });
  save();
} else if (executable === '/usr/bin/security') {
  if (['local-missing-signing','local-cli-signing'].includes(state.mode)) process.exit(45);
  if (args[0] === 'find-identity') process.stdout.write('Developer ID Application: Example (ABCDE12345)'); else if (args[0] === 'find-generic-password' && realLocal) process.stdout.write('fixture-password'); else throw Error('Unknown security fixture command');
} else if (executable === '/usr/bin/uname' && args.length === 1 && ['-s','-m'].includes(args[0])) process.stdout.write(args[0] === '-s' ? 'Darwin' : 'arm64');
else if (executable === 'git') {
  if (args[0] === 'status') { if (state.mode === 'local-cli-dirty') process.stdout.write(' M dirty'); }
  else if (args[0] === 'worktree') {
    fs.mkdirSync(args[3] + '/apps/desktop/scripts', { recursive: true });
    fs.writeFileSync(args[3] + '/apps/desktop/scripts/package-macos.ts', 'OPENSTEER_DESKTOP_DEFER_NOTARIZATION OpensteerSourceRevision if (!deferNotarization) requireNotarizationAuthority');
    fs.writeFileSync(args[3] + '/package.json', JSON.stringify({version:'1.2.3'}));
  } else if (args[0] === 'rev-parse') process.stdout.write(state.revision); else throw Error('Unknown git fixture command');
}
else if (executable === '/bin/test' && ['-f','-e','-w'].includes(args[0]) && args.length === 2) {if (['local-missing-resource','local-cli-resource'].includes(state.mode)) process.exit(46);}
else if (executable === '/usr/bin/lipo' && args.length === 2 && args[0] === '-archs') process.stdout.write('arm64');
else if (executable === '/usr/bin/open' && state.mode.startsWith('local-')) { if (['local-launch-denied','local-retention-launch-denied'].includes(state.mode)) { process.stderr.write('Launch Services: macOS policy denied this application'); process.exit(48); } app.running = true; app.quitRequests = 0; save(); }
else if (executable === '/bin/ps' && state.mode.startsWith('local-') && state.localInstalled) {
  const base = state.applicationPath ?? '/Applications/Opensteer Beta.app';
  process.stdout.write([base+'/Contents/MacOS/Opensteer Beta',base+'/Contents/Resources/process-supervisor/opensteer-process-supervisor',...['host','runner'].map(service => base+'/Contents/Resources/personal-runtime/node/bin/node --disable-sigusr1 '+base+'/Contents/Resources/personal-runtime/services/'+service+'.mjs')].join('\\n'));
}
else if (executable === '/usr/bin/curl' && state.mode.startsWith('local-')) process.stdout.write(state.mode === 'local-retention-health-denied' ? '{"ok":false}' : '{"ok":true}');
else if (executable === '/usr/bin/xcrun' && args[0] === 'notarytool') {
  if (args[1] === 'history' && state.mode.startsWith('postgres-')) {process.stdout.write('{}'); return;}
  if (args[1] !== 'info') throw Error('Unknown notary fixture command');
  state.infoCalls = (state.infoCalls ?? 0) + 1; save();
  if (state.infoCalls % 2 === 0) {
    if (['notary-inflight-expiry','notary-cancelled'].includes(state.mode)) {setInterval(()=>{},1000); return;}
    if (state.mode === 'notary-provider-error') throw Error('Apple authentication failed; exceeded its deadline');
    if (state.mode === 'notary-invalid-at-deadline') {process.stdout.write(JSON.stringify({id:state.requestId,status:'Invalid'})); return;}
  }
  process.stdout.write(JSON.stringify({id:state.requestId,status:state.mode==='rejected'?'Invalid':'In Progress'}));
} else if (invokes('/bin/ps') && state.mode.startsWith('uninitialized-remote')) {
  process.stdout.write('/Applications/Opensteer Beta.app/Contents/MacOS/Opensteer Beta' + (remote ? '' : '\\n/Applications/Opensteer Beta.app/Contents/Resources/process-supervisor/opensteer-process-supervisor'));
} else if (invokes('/usr/bin/codesign') && remote && state.mode === 'uninitialized-remote-bad-signature') {
  process.exit(44);
} else if (invokes('/usr/bin/curl') && state.mode.startsWith('uninitialized-remote')) {
  process.stdout.write('{"ok":true}');
} else if (invokes('/usr/libexec/PlistBuddy') && (remote || args.length === 3 && args[0] === '-c' && /^Print :(CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion|OpensteerSourceRevision)$/.test(args[1]))) {
  const installed = remote ? state.remoteInstalled : state.localInstalled;
  process.stdout.write(command.includes('.next/') && ['corrupt-next', 'local-corrupt-next'].includes(state.mode) ? 'corrupt' : command.includes('/Applications/') && !command.includes('.next/') && !installed ? 'old' : command.includes('CFBundleIdentifier') ? 'com.steerlabs.opensteer.beta' : command.includes('OpensteerSourceRevision') ? state.revision : '1.2.3');
} else if (invokes('/usr/bin/shasum') && (remote || args.length === 3 && args[0] === '-a' && args[1] === '256')) process.stdout.write((state.mode === 'local-bad-digest' && command.includes('personal-runtime') ? '0'.repeat(64) : state.helperDigest ?? 'a'.repeat(64))+'  helper');
else if (invokes('/bin/sh') && command.includes('release-beta-rollback-identity')) process.stdout.write('present\\n1.2.2\\n'+'0'.repeat(40));
else if (invokes('/bin/sh') && command.includes('release-beta-prepare')) {if (state.mode === 'local-cancelled-copy') { process.stderr.write('copy interrupted'); process.exit(47); }}
else if (executable === '/usr/bin/log') process.stdout.write('syspolicyd: Opensteer launch was denied by macOS policy');
else if (invokes('/bin/sh') && command.includes('release-beta-install')) {
  if (app?.reappearBeforeRename) {
    app.reappearBeforeRename = false;
    app.running = true;
    app.quitRequests = 0;
    app.observedAfterQuit = 0;
    state.renames.push({ at, target, call: state.calls.length - 1, renamed: false });
    save();
    process.stderr.write('Quit Opensteer Beta before installation\\n');
    process.exit(1);
  }
  if (remote && state.mode === 'second-fail') process.exit(43);
  state[remote ? 'remoteInstalled' : 'localInstalled'] = true;
  state.renames.push({ at, target, call: state.calls.length - 1, renamed: true });
  save();
} else if (invokes('/usr/bin/codesign') && (remote || args[0] === '--verify' && args.includes('--strict') && args.some(arg => arg.startsWith('-R=anchor apple generic')))) {
  if (state.mode === 'local-retention-postswap-invalid' && state.localInstalled && args.at(-1) === state.applicationPath && !state.postSwapRejected) { state.postSwapRejected=true; save(); throw Error('Post-swap signature invalid'); }
  if (state.mode === 'local-bad-signature' || state.mode === 'local-cli-bad-signature' && args.at(-1).includes('.next')) throw Error('codesign signature rejected');
} else if (remote && ["'/usr/bin/xcrun' 'stapler' 'validate'", "'/usr/sbin/spctl' '--assess'", "'/usr/bin/open'"].some(prefix => command.startsWith(prefix))) {}
else if (executable === '/usr/bin/xcrun' && args[0] === 'stapler' && args[1] === 'validate') {}
else if (executable === '/usr/sbin/spctl' && args[0] === '--assess') {}
else if (executable === '/usr/bin/open' && args.length === 1) {}
else if (executable === 'pnpm' && JSON.stringify(args) === JSON.stringify(['install','--frozen-lockfile','--prefer-offline'])) {}
else throw Error('Unknown fixture command: '+command);
})();
`;

interface ProviderState {
  calls: {
    at: number;
    executable: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
  }[];
  observations: { at: number; target: string; running: boolean; call: number }[];
  quits: { at: number; target: string; call: number }[];
  renames: { at: number; target: string; call: number; renamed: boolean }[];
  infoCalls?: number;
  apps: Record<string, AppSimulation>;
}

interface AppSimulation {
  running: boolean;
  exitAfter: number | null;
  quitRequests: number;
  observedAfterQuit: number;
  reappearBeforeRename?: boolean;
}

function runningApp(exitAfter: number | null): AppSimulation {
  return { running: true, exitAfter, quitRequests: 0, observedAfterQuit: 0 };
}

function waitingMessage(target: string) {
  return `Waiting for Opensteer Beta to finish quitting on ${target}. The original installation is retained; waiting is bounded to two minutes.`;
}

/** No force-kill, and every AppleScript call is the plain quit request. */
function assertQuitOnlyAsked(state: ProviderState) {
  for (const call of state.calls) {
    const command = call.executable === "/usr/bin/ssh" ? (call.args.at(-1) ?? "") : call.executable;
    assert.doesNotMatch(command, /(^|\/|')(kill|pkill|killall)\b/u);
    if (call.executable === "/usr/bin/osascript" || command.startsWith("'/usr/bin/osascript'")) {
      const script = call.executable === "/usr/bin/osascript" ? call.args.join(" ") : command;
      assert.match(script, /to quit/u);
      assert.doesNotMatch(script, /kill|force/iu);
    }
  }
}

/** The evidence a quit scenario leaves: what was observed and asked, and when. */
function quitEvidence(state: ProviderState, stdout: string[]) {
  const start = state.calls[0]?.at ?? 0;
  return {
    observations: state.observations.map(({ at, ...rest }) => ({ afterMs: at - start, ...rest })),
    quits: state.quits.map(({ at, ...rest }) => ({ afterMs: at - start, ...rest })),
    renames: state.renames.map(({ at, ...rest }) => ({ afterMs: at - start, ...rest })),
    calls: state.calls.map((call, index) => ({
      index,
      afterMs: call.at - start,
      command:
        call.executable === "/usr/bin/ssh"
          ? `ssh ${(call.args.at(-1) ?? "").split(" ")[0]}`
          : call.executable === "/bin/sh"
            ? `/bin/sh ${call.args[2] ?? ""}`
            : call.executable,
    })),
    stdout,
  };
}

async function child(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) {
  return new Promise<string>((resolve, reject) => {
    const process_ = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
      ...(env ? { env } : {}),
      ...(signal ? { signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    process_.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process_.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process_.once("error", reject);
    process_.once("exit", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`Child failed (${code}): ${stderr}`)),
    );
  });
}

async function configureFixtureSigning(directory: string) {
  const file = path.join(directory, "signing-input.json");
  await writeFile(
    file,
    JSON.stringify({
      teamId: "ABCDE12345",
      identity: "Developer ID Application: Example (ABCDE12345)",
    }),
  );
  process.env.OPENSTEER_DESKTOP_SIGNING_FILE = file;
  delete process.env.OPENSTEER_DESKTOP_DEVELOPMENT_TRUST;
}
const [mode, directory] = process.argv.slice(2);
if (mode === "phase" && directory) {
  await configureFixtureSigning(directory);
  const fixture = JSON.parse(await readFile(path.join(directory, "fixture.json"), "utf8")) as {
    config: unknown;
    identity?: MacContext["identity"];
    runtimeInputs?: MacContext["runtimeInputs"];
    expectedPostgresVersion?: string;
    phase:
      | "preflight"
      | "prepare"
      | "install"
      | "verify"
      | "local-preflight"
      | "local-install"
      | "local-verify"
      | "local-cli";
  };
  // As in a release run, a terminating signal cancels the phase.
  const cancel = new AbortController();
  process.once("SIGTERM", () => cancel.abort(new Error("Release cancelled")));
  let elapsed = 0;
  const providerState = JSON.parse(await readFile(path.join(directory, "provider.json"), "utf8"));
  const boundaryObservation = providerState.mode.startsWith("notary-");
  let infoCalls = 0;
  const context: MacContext = {
    ...(fixture.runtimeInputs ? { runtimeInputs: fixture.runtimeInputs } : {}),
    now: () => (boundaryObservation ? elapsed : Date.now() + elapsed),
    resumeCommand: "pnpm desktop:install-local --config /fixture/release.json",
    sourceDirectory: directory,
    stateDirectory: directory,
    identity: fixture.identity ?? { sourceRevision: "1".repeat(40), version: "1.2.3" },
    signal: cancel.signal,
    run: async (executable, args, options) => {
      const info = args.includes("info");
      if (info) infoCalls += 1;
      try {
        return await runBounded(
          process.execPath,
          [
            "-e",
            provider,
            path.join(directory, "provider.json"),
            executable,
            JSON.stringify(args),
            JSON.stringify({ ...options, signal: undefined }),
          ],
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          },
        );
      } finally {
        if (fixture.phase === "prepare" && info) {
          if (boundaryObservation) elapsed = infoCalls === 1 ? 299_500 : 300_000;
          else elapsed += 310_000;
        }
        if (fixture.phase === "local-install" && executable === "/bin/ps") elapsed += 65_000;
      }
    },
  };
  if (fixture.phase === "local-cli") {
    await installLocalMain(
      ["--source-sha", "1".repeat(40), "--config", path.join(directory, "config.json")],
      (executable, args, options = {}) => context.run(executable, args, options),
    );
    const input = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    if (providerState.mode === "local-cli-success") {
      const stateDirectory = path.join(input.stateDirectory, "1".repeat(40));
      const saved = JSON.parse(
        await readFile(path.join(stateDirectory, "local-install.json"), "utf8"),
      );
      const coordinatorContext: MacContext = {
        ...context,
        sourceDirectory: path.join(stateDirectory, "source"),
        stateDirectory,
        runtimeInputs: input.runtimeInputs,
        agentPhoneSigning: input.agentPhone,
        agentPhoneArtifactDirectory: path.join(stateDirectory, "agent-phone"),
        agentPhoneReceiptSha256: saved.phoneReceiptSha256,
      };
      const mac = macConfigSchema.parse(input.mac);
      assert.throws(
        () =>
          macConfigSchema.parse({
            ...mac,
            targets: [mac.targets[0], { ...mac.targets[0], id: "remote", sshHost: "fixture" }],
          }),
        /keychainProfile/u,
      );
      await prepareMac(mac, coordinatorContext);
      await stageMac(mac, coordinatorContext);
      await installMac(mac, coordinatorContext);
      await verifyMac(mac, coordinatorContext);
      const retainedDirectory = await mkdtemp(path.join(stateDirectory, "retained-runner-"));
      const retainedProvider = path.join(retainedDirectory, "provider.json");
      await writeFile(
        retainedProvider,
        JSON.stringify({ ...providerState, calls: [], observations: [], quits: [], renames: [] }),
      );
      // The provider's real-file operations remain beneath the original fixture root.
      const retainedState = path.join(directory, path.basename(retainedDirectory) + ".json");
      await writeFile(retainedState, await readFile(retainedProvider));
      const retainedContext: MacContext = {
        ...coordinatorContext,
        stateDirectory: retainedDirectory,
        runnerSourceRevision: "2".repeat(40),
        run: (executable, args, options) =>
          runBounded(
            process.execPath,
            [
              "-e",
              provider,
              retainedState,
              executable,
              JSON.stringify(args),
              JSON.stringify({ ...options, signal: undefined }),
            ],
            {
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            },
          ),
      };
      const androidLog = path.join(directory, "android-calls.jsonl");
      const originalAndroidCalls = await readFile(androidLog);
      await prepareMac(mac, retainedContext);
      await writeFile(
        path.join(retainedDirectory, "android-calls.jsonl"),
        await readFile(androidLog),
      );
      await writeFile(androidLog, originalAndroidCalls);
      const provenance = JSON.parse(
        await readFile(path.join(retainedDirectory, "personal-runtime.provenance.json"), "utf8"),
      );
      const retainedReceipt = JSON.parse(
        await readFile(path.join(retainedDirectory, "mac-local.json"), "utf8"),
      );
      assert.equal(provenance.runnerSourceRevision, "2".repeat(40));
      assert.equal(retainedReceipt.runnerSourceRevision, "2".repeat(40));
      const calls = JSON.parse(await readFile(retainedState, "utf8")).calls;
      assert.ok(
        calls.some(
          (call: { executable: string; env: Record<string, string> }) =>
            call.executable === "pnpm" &&
            call.env.OPENSTEER_RUNNER_SOURCE_REVISION === "2".repeat(40),
        ),
      );
      await assert.rejects(
        prepareMac(mac, { ...retainedContext, runnerSourceRevision: "3".repeat(40) }),
        /different Runner selection/u,
      );
      assert.equal(JSON.parse(await readFile(retainedState, "utf8")).calls.length, calls.length);
      await writeFile(
        path.join(stateDirectory, "retained-runner-check.json"),
        JSON.stringify({ passed: true, retainedDirectory, retainedState }),
      );
    }
    process.exit(0);
  }
  if (fixture.phase.startsWith("local-")) {
    const local = localMacConfigSchema.parse(fixture.config);
    if (fixture.phase === "local-preflight") {
      const result = await preflightLocalMac(local, context);
      if (fixture.expectedPostgresVersion)
        assert.equal(result.postgresVersion, fixture.expectedPostgresVersion);
    } else if (fixture.phase === "local-install") await installLocalMac(local, context);
    else await verifyLocalMac(local, context);
    process.exit(0);
  }
  const config = macConfigSchema.parse(fixture.config);
  if (fixture.phase === "preflight") {
    const result = await preflightMac(config, context);
    assert.equal(result.postgresVersion, fixture.expectedPostgresVersion);
    process.exit(0);
  }
  await (fixture.phase === "prepare"
    ? prepareMac(config, context)
    : fixture.phase === "install"
      ? installMac(config, context)
      : verifyMac(config, context));
} else {
  const root = await mkdtemp(
    path.join(process.env.OPENSTEER_MAC_EVIDENCE_DIRECTORY ?? os.tmpdir(), "opensteer-mac-e2e-"),
  );
  await configureFixtureSigning(root);
  const results: { scenario: string; passed: boolean }[] = [];
  const config = macConfigSchema.parse({
    architecture: "arm64",
    signingIdentity: "Developer ID Application: Example (ABCDE12345)",
    keychainProfile: "test",
    passwordsProvisioningProfile: "/fixture/passwords.provisionprofile",
    personalRuntimeSource: "/fixture/runtime",
    supervisor: { path: "/fixture/supervisor", sha256: "a".repeat(64), version: "1.0.0" },
    cloudflared: { path: "/fixture/cloudflared", sha256: "a".repeat(64), version: "2026.1.0" },
    targets: [
      {
        id: "local",
        stagingDirectory: "/fixture/stage",
        applicationPath: "/Applications/Opensteer Beta.app",
        runtimeStatusUrl: "http://127.0.0.1:1/healthz",
      },
      {
        id: "remote",
        sshHost: "fixture",
        stagingDirectory: "/fixture/stage",
        applicationPath: "/Applications/Opensteer Beta.app",
        runtimeStatusUrl: "http://127.0.0.1:1/healthz",
      },
    ],
  });
  const script = fileURLToPath(import.meta.url);
  const runPhase = (directory_: string) =>
    child(process.execPath, ["--import", "tsx", script, "phase", directory_]);
  /** A phase the harness can cancel, as an operator interrupts the release. */
  const spawnPhase = (directory_: string) => {
    const phase = spawn(process.execPath, ["--import", "tsx", script, "phase", directory_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    phase.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    phase.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      phase.once("close", (code) => resolve({ code, stdout, stderr })),
    );
    return { phase, done };
  };
  const readState = async (file: string) =>
    JSON.parse(await readFile(file, "utf8")) as ProviderState;
  const waitForState = async (file: string, ready: (state: ProviderState) => boolean) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (ready(await readState(file))) return;
      await sleep(100);
    }
    throw new Error("The simulated provider never reached the expected state");
  };
  const lines = (output: string) => output.split("\n").filter(Boolean);
  const scenarios = [
    "ambiguous",
    "rejected",
    "pending",
    "notary-inflight-expiry",
    "notary-provider-error",
    "notary-invalid-at-deadline",
    "notary-cancelled",
    "second-fail",
    "graceful-quit",
    "corrupt-next",
    "delayed-quit",
    "cancelled-quit",
    "reappears-before-rename",
  ];
  const installScenarios = [
    "second-fail",
    "graceful-quit",
    "corrupt-next",
    "delayed-quit",
    "cancelled-quit",
    "reappears-before-rename",
  ];
  const apps: Record<string, Record<string, AppSimulation>> = {
    "graceful-quit": { local: runningApp(0) },
    // Both apps outlast the ten observations the installer used to allow.
    "delayed-quit": { local: runningApp(10), remote: runningApp(10) },
    // The remote app never finishes quitting until the release is cancelled.
    "cancelled-quit": { local: runningApp(2), remote: runningApp(null) },
    "reappears-before-rename": { local: { ...runningApp(1), reappearBeforeRename: true } },
  };
  const evidence: Record<string, unknown> = {};
  if (mode && !["install-only", "verify-only", "local-cli-only", "cleanup-only"].includes(mode))
    throw new Error("Expected no arguments, install-only or verify-only");
  const postgresScenarios = [
    { name: "without-pg-config", output: "postgres (PostgreSQL) 17.11", version: "17.11.0" },
    { name: "three-components", output: "postgres (PostgreSQL) 17.11.2", version: "17.11.2" },
    { name: "missing", output: undefined },
    { name: "exits", output: "postgres (PostgreSQL) 17.11", exitCode: 23 },
    { name: "empty", output: "" },
    { name: "unparseable", output: "PostgreSQL 17.11" },
    { name: "prerelease", output: "postgres (PostgreSQL) 18beta1" },
    { name: "extra-components", output: "postgres (PostgreSQL) 17.11.0.1" },
    { name: "trailing-text", output: "postgres (PostgreSQL) 17.11 unexpected" },
  ];
  for (const scenario of ["local-cli-only", "cleanup-only"].includes(mode ?? "")
    ? []
    : postgresScenarios) {
    const directory_ = path.join(root, `postgres-${scenario.name}`);
    await mkdir(path.join(directory_, "apps/desktop/scripts"), { recursive: true });
    await writeFile(
      path.join(directory_, "apps/desktop/scripts/package-macos.ts"),
      "OPENSTEER_DESKTOP_DEFER_NOTARIZATION OpensteerSourceRevision if (!deferNotarization) requireNotarizationAuthority",
    );
    const postgres = path.join(directory_, "postgres");
    await mkdir(path.join(postgres, "bin"), { recursive: true });
    const executable = path.join(postgres, "bin/postgres");
    const versionCalls = path.join(directory_, "postgres-calls.jsonl");
    if (scenario.output !== undefined)
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(versionCalls)},JSON.stringify(process.argv.slice(2))+'\\n');
if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') process.exit(97);
console.log(${JSON.stringify(scenario.output)});
process.exit(${scenario.exitCode ?? 0});
`,
        { mode: 0o755 },
      );
    await assert.rejects(access(path.join(postgres, "bin/pg_config")));
    const helper = path.join(directory_, "helper");
    await writeFile(helper, "helper");
    const full = macConfigSchema.parse({
      ...config,
      personalRuntimeSource: undefined,
      supervisor: {
        ...config.supervisor,
        path: helper,
        sha256: createHash("sha256").update("helper").digest("hex"),
      },
      cloudflared: {
        ...config.cloudflared,
        path: helper,
        sha256: createHash("sha256").update("helper").digest("hex"),
      },
      targets: [
        {
          ...config.targets[0],
          applicationPath: path.join(directory_, "Opensteer Beta.app"),
          stagingDirectory: path.join(directory_, "stage"),
        },
      ],
    });
    const local = localMacConfigSchema.parse(
      Object.fromEntries(
        Object.entries(full).filter(
          ([key]) => !["keychainProfile", "personalRuntimeSource"].includes(key),
        ),
      ),
    );
    const observations: unknown[] = [];
    for (const phase of ["preflight", "local-preflight"]) {
      const providerFile = path.join(directory_, "provider.json");
      await writeFile(
        providerFile,
        JSON.stringify({
          mode: `postgres-${scenario.name}`,
          revision: "1".repeat(40),
          calls: [],
          observations: [],
          quits: [],
          renames: [],
        }),
      );
      await writeFile(
        path.join(directory_, "fixture.json"),
        JSON.stringify({
          phase,
          config: phase === "preflight" ? full : local,
          ...(phase === "local-preflight" ? { runtimeInputs: { postgres, node: directory_ } } : {}),
          expectedPostgresVersion: scenario.version,
        }),
      );
      const run = () =>
        child(process.execPath, ["--import", "tsx", script, "phase", directory_], undefined, {
          ...process.env,
          OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: postgres,
          OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: directory_,
          OPENSTEER_PERSONAL_RUNTIME_POSTGRES_VERSION: "99.99.99",
        });
      let rejection = "";
      if (scenario.version) await run();
      else
        await assert.rejects(run(), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Could not determine.*PostgreSQL.*version/u);
          assert.ok(error.message.includes(executable));
          rejection = error.message;
          return true;
        });
      const state = await readState(providerFile);
      const calls = state.calls.filter((call) => call.executable === executable);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.args, ["--version"]);
      assert.equal(calls[0]?.timeoutMs, 15_000);
      assert.equal(
        state.calls.some(
          (call) =>
            call.executable === "pnpm" ||
            call.executable.endsWith("pg_config") ||
            call.executable === "/usr/bin/open",
        ),
        false,
      );
      observations.push({
        phase,
        expectedPostgresVersion: scenario.version,
        rejection,
        calls: state.calls,
      });
    }
    if (scenario.output !== undefined)
      assert.deepEqual(
        (await readFile(versionCalls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [["--version"], ["--version"]],
      );
    evidence[`postgres-${scenario.name}`] = observations;
    results.push({ scenario: `postgres-${scenario.name}`, passed: true });
    if (["missing", "unparseable"].includes(scenario.name)) {
      const output = path.join(directory_, "runtime-output");
      await assert.rejects(
        child(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(
              new URL("../apps/desktop/scripts/build-personal-runtime.ts", import.meta.url),
            ),
          ],
          undefined,
          {
            ...process.env,
            OPENSTEER_SOURCE_REVISION: undefined,
            OPENSTEER_PERSONAL_RUNTIME_OUTPUT: output,
            OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: postgres,
            OPENSTEER_PERSONAL_RUNTIME_POSTGRES_VERSION: "99.99.99",
            OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: undefined,
            OPENSTEER_PERSONAL_RUNTIME_SIGNING_IDENTITY: undefined,
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Could not determine.*PostgreSQL.*version/u);
          assert.ok(error.message.includes(executable));
          observations.push({ phase: "runtime-builder", rejection: error.message });
          return true;
        },
      );
      await assert.rejects(access(output));
      results.push({ scenario: `postgres-builder-${scenario.name}-before-build`, passed: true });
    }
  }
  // Failure scenarios are specified before the shared local implementation:
  // forbidden providers, absent signing/resources, receipt drift, a stuck quit,
  // modified prepared bytes, and a process relaunch at the final rename fence.
  for (const scenario of ["local-cli-only", "cleanup-only"].includes(mode ?? "")
    ? []
    : [
        "local-success",
        "local-bad-signature",
        "local-bad-digest",
        "local-missing-signing",
        "local-missing-resource",
        "local-mismatched-receipt",
        "local-never-quits",
        "local-corrupt-next",
        "local-relaunch",
        "local-launch-denied",
        "local-cancelled-copy",
      ]) {
    const local = localMacConfigSchema.parse({
      ...Object.fromEntries(
        Object.entries(config).filter(
          ([key]) => !["keychainProfile", "personalRuntimeSource", "targets"].includes(key),
        ),
      ),
      targets: [config.targets[0]],
    });
    for (const forbidden of [
      { ...local, keychainProfile: "notary" },
      { ...local, personalRuntimeSource: "/old/runtime" },
      { ...local, targets: [{ ...local.targets[0], sshHost: "other-mac" }] },
      { ...local, targets: [...local.targets, config.targets[1]] },
      { ...local, targets: [{ ...local.targets[0], runtimeStatusUrl: null }] },
    ])
      assert.equal(localMacConfigSchema.safeParse(forbidden).success, false);
    const directory_ = path.join(root, scenario);
    await mkdir(path.join(directory_, "apps/desktop/scripts"), { recursive: true });
    await writeFile(
      path.join(directory_, "apps/desktop/scripts/package-macos.ts"),
      "OPENSTEER_DESKTOP_DEFER_NOTARIZATION OpensteerSourceRevision if (!deferNotarization) requireNotarizationAuthority",
    );
    const helper = path.join(directory_, "helper");
    await writeFile(helper, "helper");
    for (const binary of [local.supervisor, local.cloudflared]) {
      binary.path = helper;
      binary.sha256 = createHash("sha256").update("helper").digest("hex");
    }
    const providerFile = path.join(directory_, "provider.json");
    await writeFile(
      providerFile,
      JSON.stringify({
        mode: scenario,
        localInstalled: scenario === "local-launch-denied",
        calls: [],
        observations: [],
        quits: [],
        renames: [],
        revision: "1".repeat(40),
        helperDigest: local.supervisor.sha256,
        apps: {
          local: {
            ...runningApp(scenario === "local-never-quits" ? null : 0),
            reappearBeforeRename: scenario === "local-relaunch",
          },
        },
      }),
    );
    await writeFile(
      path.join(directory_, "fixture.json"),
      JSON.stringify({
        config: local,
        phase:
          scenario === "local-launch-denied"
            ? "local-verify"
            : scenario.includes("missing")
              ? "local-preflight"
              : "local-install",
      }),
    );
    await writeFile(
      path.join(directory_, "mac-local.json"),
      JSON.stringify({
        sourceRevision: scenario === "local-mismatched-receipt" ? "2".repeat(40) : "1".repeat(40),
        version: "1.2.3",
        configDigest: createHash("sha256").update(JSON.stringify(local)).digest("hex"),
        signedBuild: {
          runtimeManifestSha256: local.supervisor.sha256,
          phoneReceiptSha256: local.supervisor.sha256,
          phoneApkSha256: local.supervisor.sha256,
          phoneManifestSha256: local.supervisor.sha256,
          passwordsProvisioningProfileSha256: local.supervisor.sha256,
          signingIdentity: local.signingIdentity,
          elapsedMs: 1,
        },
        staged: ["local"],
        installed: scenario === "local-launch-denied" ? ["local"] : [],
        verified: [],
      }),
    );
    const failure =
      scenario === "local-success"
        ? null
        : scenario === "local-never-quits"
          ? /4242.*original|original.*4242/isu
          : scenario === "local-bad-signature"
            ? /signature rejected/u
            : scenario === "local-bad-digest"
              ? /runtime\/phone digest differs/u
              : scenario === "local-mismatched-receipt"
                ? /different release or configuration/u
                : scenario === "local-corrupt-next"
                  ? /bundle.*differs/u
                  : scenario === "local-relaunch"
                    ? /Quit Opensteer Beta/u
                    : scenario === "local-launch-denied"
                      ? /macOS policy.*diagnostics/isu
                      : /unavailable|failed/u;
    if (failure) await assert.rejects(runPhase(directory_), failure);
    else {
      await runPhase(directory_);
      await writeFile(
        path.join(directory_, "fixture.json"),
        JSON.stringify({ config: local, phase: "local-verify" }),
      );
      await runPhase(directory_);
    }
    const state = await readState(providerFile);
    assertQuitOnlyAsked(state);
    assert.equal(
      state.calls.some((call) =>
        /gh|gcloud|ssh|scp|notary|stapler|spctl/.test(call.executable + " " + call.args.join(" ")),
      ),
      false,
    );
    assert.equal(
      state.renames.some((rename) => rename.renamed),
      scenario === "local-success",
    );
    if (scenario === "local-mismatched-receipt") assert.equal(state.calls.length, 0);
    if (scenario === "local-missing-signing") {
      assert.ok(state.calls.some((call) => call.executable === "/usr/bin/security"));
      assert.equal(
        state.calls.some((call) => call.executable === "/bin/test"),
        false,
      );
    }
    if (scenario === "local-missing-resource")
      assert.ok(
        state.calls.some(
          (call) =>
            call.executable === "/bin/test" &&
            call.args.includes(local.passwordsProvisioningProfile),
        ),
      );
    if (
      [
        "local-corrupt-next",
        "local-cancelled-copy",
        "local-bad-signature",
        "local-bad-digest",
      ].includes(scenario)
    )
      assert.equal(state.quits.length, 0);
    if (scenario === "local-never-quits") {
      assert.equal(state.quits.length, 1);
      assert.equal(state.renames.length, 0);
      assert.match(await readFile(path.join(directory_, "quit-local.json"), "utf8"), /4242/u);
    }
    if (scenario === "local-success")
      assert.deepEqual(
        JSON.parse(await readFile(path.join(directory_, "mac-local.json"), "utf8")).verified,
        ["local"],
      );
    if (scenario === "local-launch-denied")
      assert.match(
        await readFile(path.join(directory_, "local-launch-diagnostics.json"), "utf8"),
        /syspolicyd/u,
      );
    evidence[scenario] = quitEvidence(state, []);
    results.push({ scenario, passed: true });
  }
  for (const scenario of mode === "cleanup-only"
    ? ["local-cli-success"]
    : [
        "local-cli-extra-file",
        "local-cli-altered-link",
        "local-cli-modified-byte",
        "local-cli-interrupted-copy",
        "local-cli-clone-fallback",
        "local-cli-after-quit-tamper",
        "local-cli-dirty",
        "local-cli-signing",
        "local-cli-resource",
        "local-cli-postgres-missing",
        "local-cli-postgres-unparseable",
        "local-cli-success",
        "local-cli-bad-signature",
        "local-cli-bad-digest",
        "local-cli-interrupted-rename",
        "local-cli-existing-backup",
        "local-cli-changed-archive",
        "local-cli-changed-stage",
      ]) {
    const directory_ = path.join(root, scenario);
    await mkdir(directory_);
    const local = localMacConfigSchema.parse({
      ...Object.fromEntries(
        Object.entries(config).filter(
          ([key]) => !["keychainProfile", "personalRuntimeSource", "targets"].includes(key),
        ),
      ),
      targets: [
        {
          ...config.targets[0],
          stagingDirectory: path.join(directory_, "stage"),
          applicationPath: path.join(directory_, "Opensteer Beta.app"),
        },
      ],
    });
    // A fresh invocation has no phone, signed-build, staging or install receipts.
    const fresh = !["local-cli-dirty", "local-cli-signing", "local-cli-resource"].includes(
      scenario,
    );
    const inputs = path.join(directory_, "inputs");
    await mkdir(inputs);
    const helper = path.join(inputs, "helper");
    await writeFile(helper, "helper");
    for (const binary of [local.supervisor, local.cloudflared]) {
      binary.path = helper;
      binary.sha256 = createHash("sha256").update("helper").digest("hex");
    }
    local.passwordsProvisioningProfile = path.join(inputs, "passwords.provisionprofile");
    await writeFile(local.passwordsProvisioningProfile, "fixture profile");
    for (const name of ["postgres", "node"]) await mkdir(path.join(inputs, name));
    await mkdir(path.join(inputs, "postgres/bin"));
    if (scenario !== "local-cli-postgres-missing")
      await writeFile(
        path.join(inputs, "postgres/bin/postgres"),
        `#!${process.execPath}\nconsole.log(${JSON.stringify(scenario === "local-cli-postgres-unparseable" ? "invalid version" : "postgres (PostgreSQL) 17.11")});\n`,
        { mode: 0o755 },
      );
    const sdk = path.join(inputs, "android");
    const tools = path.join(sdk, "build-tools/36.0.0");
    await mkdir(tools, { recursive: true });
    await mkdir(path.join(sdk, "platforms/android-36"), { recursive: true });
    await writeFile(path.join(sdk, "platforms/android-36/android.jar"), "fixture");
    await writeFile(path.join(inputs, "phone.p12"), "fixture keystore");
    for (const name of ["aapt2", "apksigner"]) {
      await writeFile(
        path.join(tools, name),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(directory_, "android-calls.jsonl"))}, JSON.stringify({tool:${JSON.stringify(name)},args})+'\\n');
if (!fs.existsSync(args.at(-1))) throw Error('Missing fixture APK');
if (${JSON.stringify(name)} === 'apksigner' && args.length === 4 && JSON.stringify(args.slice(0,3)) === JSON.stringify(['verify','--verbose','--print-certs'])) console.log('Verified using v2 scheme (APK Signature Scheme v2): true\\nSigner #1 certificate SHA-256 digest: ${agentPhoneReleaseSignerSha256}');
else if (${JSON.stringify(name)} === 'aapt2' && args.length === 3 && args[0] === 'dump' && args[1] === 'badging') console.log("package: name='com.opensteer.agentphone' versionCode='123' versionName='1.2.3'\\nsdkVersion:'30'");
else throw Error('Unknown fixture Android command: '+JSON.stringify(args));
`,
        { mode: 0o755 },
      );
    }
    const original = local.targets[0].applicationPath;
    const next = original + "." + "1".repeat(40) + ".next";
    const backup = original + "." + "1".repeat(40) + ".previous";
    await mkdir(original);
    await writeFile(path.join(original, "original-marker"), "original application");
    const originalExecutable = path.join(original, "Contents/MacOS/Opensteer Beta");
    if (scenario === "local-cli-interrupted-copy") {
      await mkdir(path.dirname(originalExecutable), { recursive: true });
      await writeFile(originalExecutable, '#!/bin/sh\nprintf "original application\\n"\n', {
        mode: 0o755,
      });
    }
    if (scenario === "local-cli-existing-backup") {
      await mkdir(backup);
      await writeFile(path.join(backup, "backup-marker"), "retained backup");
    }
    await writeFile(
      path.join(directory_, "config.json"),
      JSON.stringify({
        stateDirectory: path.join(directory_, "states"),
        mac: local,
        runtimeInputs: { postgres: path.join(inputs, "postgres"), node: path.join(inputs, "node") },
        agentPhone: {
          keystorePath: path.join(inputs, "phone.p12"),
          keyAlias: "fixture",
          keychainService: "fixture",
          sdkDirectory: sdk,
        },
      }),
    );
    await writeFile(path.join(directory_, "fixture.json"), JSON.stringify({ phase: "local-cli" }));
    const providerFile = path.join(directory_, "provider.json");
    await writeFile(
      providerFile,
      JSON.stringify({
        mode: scenario,
        realLocal: fresh,
        applicationPath: original,
        signingIdentity: local.signingIdentity,
        certificate: fileURLToPath(
          new URL("./fixtures/agent-phone-release-certificate.pem", import.meta.url),
        ),
        apps: { local: { ...runningApp(0), running: scenario === "local-cli-after-quit-tamper" } },
        revision: "1".repeat(40),
        calls: [],
        observations: [],
        quits: [],
        renames: [],
      }),
    );
    const stateDirectory = path.join(directory_, "states", "1".repeat(40));
    const macReceipt = path.join(stateDirectory, "mac-local.json");
    const readReceipt = async () => JSON.parse(await readFile(macReceipt, "utf8"));
    const stdout: string[] = [];
    const rejections: string[] = [];
    const observedPhase = async () => {
      try {
        return await runPhase(directory_);
      } catch (error) {
        rejections.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    if (scenario.startsWith("local-cli-postgres-")) {
      await assert.rejects(observedPhase(), /Could not determine.*PostgreSQL.*version/u);
      await assert.rejects(access(macReceipt));
      assert.equal(
        await readFile(path.join(original, "original-marker"), "utf8"),
        "original application",
      );
    } else if (!fresh) {
      await assert.rejects(
        observedPhase(),
        scenario === "local-cli-dirty" ? /checkout must be clean/u : /failed|unavailable/u,
      );
    } else {
      await assert.rejects(access(macReceipt));
      if (
        [
          "local-cli-extra-file",
          "local-cli-altered-link",
          "local-cli-modified-byte",
          "local-cli-interrupted-copy",
          "local-cli-after-quit-tamper",
        ].includes(scenario)
      ) {
        await assert.rejects(
          observedPhase(),
          scenario === "local-cli-interrupted-copy" ? /copy interrupted/u : /tree manifest/u,
        );
        assert.equal(
          await readFile(path.join(original, "original-marker"), "utf8"),
          "original application",
        );
        await assert.rejects(access(backup));
        assert.deepEqual((await readReceipt()).installed, []);
        assert.equal((await readState(providerFile)).renames.length, 0);
        assert.equal(
          (await readState(providerFile)).quits.length,
          scenario === "local-cli-after-quit-tamper" ? 1 : 0,
        );
        if (scenario === "local-cli-interrupted-copy") {
          await assert.rejects(observedPhase(), /tree manifest/u);
          assert.equal(
            await readFile(path.join(original, "original-marker"), "utf8"),
            "original application",
          );
          // A failed retry must leave a runnable original, before any quit,
          // rename or cleanup. This probe is a temporary shell fixture, not GUI.
          assert.equal((await child(originalExecutable, [])).trim(), "original application");
          const failedRetry = await readState(providerFile);
          assert.deepEqual(failedRetry.renames, []);
          assert.deepEqual(failedRetry.quits, []);
          assert.equal(
            failedRetry.calls.some((call) => call.args.includes("release-beta-cleanup")),
            false,
          );
          assert.deepEqual((await readReceipt()).installed, []);
          assert.deepEqual((await readReceipt()).verified, []);
          await assert.rejects(access(backup));
          // Reconcile only the failed temporary copy, then the same receipt resumes.
          await rm(next, { recursive: true });
          stdout.push(await observedPhase());
          const completed = await readReceipt();
          assert.deepEqual(completed.installed, ["local"]);
          assert.deepEqual(completed.verified, ["local"]);
          assert.deepEqual(completed.rollback, {});
          const context: MacContext = {
            sourceDirectory: directory_,
            stateDirectory,
            identity: { sourceRevision: "1".repeat(40), version: "1.2.3" },
            run: runBounded,
          };
          const manifest = await readMacAppManifest(
            path.join(stateDirectory, "app-tree.json"),
            completed.appTreeSha256,
            context,
          );
          await verifyMacAppTree(original, manifest, context);
          assert.equal(
            (
              await child("/usr/libexec/PlistBuddy", [
                "-c",
                "Print :OpensteerSourceRevision",
                path.join(original, "Contents/Info.plist"),
              ])
            ).trim(),
            "1".repeat(40),
          );
          const journey = JSON.parse(
            await readFile(path.join(stateDirectory, "journey.json"), "utf8"),
          );
          assert.equal(journey.sourceRevision, "1".repeat(40));
          assert.equal(journey.application, original);
          assert.equal(journey.signedBundle, true);
          assert.equal(journey.launched, true);
          assert.equal(journey.supervisorAndHostHealthy, true);
          assert.equal((await readState(providerFile)).apps.local?.running, true);
          await assert.rejects(access(path.join(original, "original-marker")));
          await assert.rejects(access(backup));
          await assert.rejects(access(next));
        }
      } else if (["local-cli-bad-signature", "local-cli-bad-digest"].includes(scenario)) {
        await assert.rejects(
          observedPhase(),
          scenario === "local-cli-bad-signature"
            ? /codesign signature rejected/u
            : /Signed local runtime\/phone digest differs|tree manifest/u,
        );
        assert.deepEqual((await readReceipt()).installed, []);
        assert.deepEqual((await readReceipt()).staged, ["local"]);
        assert.equal(
          await readFile(path.join(original, "original-marker"), "utf8"),
          "original application",
        );
        await access(path.join(next, "Contents/Info.plist"));
        await assert.rejects(access(backup));
        assert.equal((await readState(providerFile)).quits.length, 0);
      } else if (scenario === "local-cli-existing-backup") {
        await assert.rejects(observedPhase(), /Retained backup and installed bundle both exist/u);
        assert.deepEqual((await readReceipt()).installed, []);
        assert.equal(
          await readFile(path.join(original, "original-marker"), "utf8"),
          "original application",
        );
        assert.equal(await readFile(path.join(backup, "backup-marker"), "utf8"), "retained backup");
        await access(path.join(next, "Contents/Info.plist"));
      } else {
        if (scenario === "local-cli-interrupted-rename") {
          await assert.rejects(observedPhase(), /Fixture command failed: \/bin\/sh SIGTERM/u);
          await assert.rejects(access(original));
          await access(path.join(next, "Contents/Info.plist"));
          assert.equal(
            await readFile(path.join(backup, "original-marker"), "utf8"),
            "original application",
          );
          assert.deepEqual((await readReceipt()).installed, []);
        }
        stdout.push(await observedPhase());
        const first = await readReceipt();
        assert.deepEqual(first.staged, ["local"]);
        assert.deepEqual(first.installed, ["local"]);
        assert.deepEqual(first.verified, ["local"]);
        assert.equal(first.sourceRevision, "1".repeat(40));
        assert.equal(first.version, "1.2.3");
        const phoneReceipt = await readFile(
          path.join(stateDirectory, "agent-phone/agent-phone-release.json"),
        );
        const phoneHash = createHash("sha256").update(phoneReceipt).digest("hex");
        assert.equal(first.signedBuild.phoneReceiptSha256, phoneHash);
        const localReceipt = JSON.parse(
          await readFile(path.join(stateDirectory, "local-install.json"), "utf8"),
        );
        assert.equal(localReceipt.phoneReceiptSha256, phoneHash);
        assert.equal(localReceipt.verified, true);
        await assert.rejects(access(backup));
        assert.deepEqual(first.rollback, {});
        await assert.rejects(access(next));
        const tampered =
          scenario === "local-cli-changed-archive"
            ? path.join(stateDirectory, "app-tree.json")
            : scenario === "local-cli-changed-stage"
              ? path.join(
                  local.targets[0].stagingDirectory,
                  "1".repeat(40),
                  "Opensteer Beta.app/Contents/Resources/personal-runtime/release.json",
                )
              : undefined;
        if (tampered) {
          await writeFile(tampered, "tampered bytes");
          await assert.rejects(
            observedPhase(),
            scenario === "local-cli-changed-archive"
              ? /tree manifest digest changed/u
              : /Signed local runtime\/phone digest differs|tree manifest/u,
          );
        } else {
          stdout.push(await observedPhase());
          assert.deepEqual(await readReceipt(), first);
          const journey = JSON.parse(
            await readFile(path.join(stateDirectory, "journey.json"), "utf8"),
          );
          assert.equal(journey.launched, true);
          assert.match(
            journey.authenticatedUiAndAgentTurn,
            /Requires a real installed-app journey/u,
          );
        }
      }
    }
    const state = await readState(providerFile);
    const installs = state.calls.filter(
      (call) => call.executable === "pnpm" && call.args.includes("install"),
    );
    assert.equal(
      installs.length,
      ["local-cli-dirty", "local-cli-signing", "local-cli-resource"].includes(scenario) ||
        scenario.startsWith("local-cli-postgres-")
        ? 0
        : [
              "local-cli-extra-file",
              "local-cli-altered-link",
              "local-cli-modified-byte",
              "local-cli-after-quit-tamper",
            ].includes(scenario)
          ? 1
          : scenario === "local-cli-interrupted-copy"
            ? 3
            : fresh &&
                !scenario.startsWith("local-cli-postgres-") &&
                ![
                  "local-cli-existing-backup",
                  "local-cli-bad-signature",
                  "local-cli-bad-digest",
                ].includes(scenario)
              ? scenario === "local-cli-interrupted-rename"
                ? 3
                : 2
              : 1,
    );
    if (installs[0])
      assert.deepEqual(installs[0].args, ["install", "--frozen-lockfile", "--prefer-offline"]);
    assert.equal(
      state.calls.some(
        (call) =>
          call.executable === "gh" ||
          /gcloud|ssh|scp|notary|stapler|spctl|github/.test(
            call.executable + " " + call.args.join(" "),
          ),
      ),
      false,
    );
    if (scenario.startsWith("local-cli-postgres-")) {
      assert.equal(
        state.calls.some((call) => call.executable === "pnpm"),
        false,
      );
      assert.equal(state.quits.length, 0);
      assert.equal(state.renames.length, 0);
    } else if (fresh) {
      const builds = state.calls.filter(
        (call) => call.executable === "pnpm" && !call.args.includes("install"),
      );
      assert.equal(builds.length, 4);
      assert.equal(
        builds.some((call) => call.args.includes("scripts/build-computer-use-helper.ts")),
        false,
      );
      assert.equal(
        state.calls.filter((call) => call.executable === "git" && call.args[0] === "worktree")
          .length,
        1,
      );
      for (const call of builds.filter((call) => call.args[0] === "--filter")) {
        assert.equal(call.env?.OPENSTEER_SOURCE_REVISION, "1".repeat(40));
        assert.equal(call.env?.OPENSTEER_RELEASE_VERSION, "1.2.3");
        assert.equal(call.env?.OPENSTEER_DESKTOP_DEFER_NOTARIZATION, "1");
        assert.equal(call.env?.CSC_NAME, "Example (ABCDE12345)");
        assert.equal(
          call.env?.OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE,
          path.join(inputs, "postgres"),
        );
        assert.equal(call.env?.OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE, path.join(inputs, "node"));
        assert.equal(call.cwd, path.join(stateDirectory, "source"));
        for (const name of [
          "APPLE_KEYCHAIN_PROFILE",
          "APPLE_API_KEY",
          "APPLE_API_KEY_ID",
          "APPLE_API_ISSUER",
          "APPLE_ID",
          "APPLE_APP_SPECIFIC_PASSWORD",
          "APPLE_TEAM_ID",
        ])
          assert.equal(call.env?.[name], undefined);
        if (call.args.includes("package:mac"))
          assert.equal(
            call.env?.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256,
            (await readReceipt()).signedBuild.phoneReceiptSha256,
          );
      }
      assert.equal(
        state.calls.filter(
          (call) => call.executable === "/usr/bin/ditto" && call.args.includes("-c"),
        ).length,
        0,
      );
      assert.equal(
        state.calls.filter(
          (call) => call.executable === "/usr/bin/ditto" && call.args.includes("-x"),
        ).length,
        0,
      );
      assert.equal(typeof (await readReceipt()).appTreeSha256, "string");
      await assert.rejects(access(path.join(stateDirectory, "Opensteer Beta.zip")));
      if (scenario === "local-cli-clone-fallback")
        assert.ok(
          state.calls.some(
            (call) => call.executable === "/usr/bin/ditto" && call.args.includes("--extattr"),
          ),
        );
      const androidCalls = (await readFile(path.join(directory_, "android-calls.jsonl"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(androidCalls.length, 8);
      const commands = (await readFile(path.join(stateDirectory, "commands.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(commands.some((command) => command.event === "complete"));
      assertQuitOnlyAsked(state);
    }
    if (scenario === "local-cli-success") {
      assert.equal(
        JSON.parse(await readFile(path.join(stateDirectory, "retained-runner-check.json"), "utf8"))
          .passed,
        true,
      );
      results.push({ scenario: "local-cli-retained-runner", passed: true });
    }
    await writeFile(path.join(directory_, "rejections.json"), JSON.stringify(rejections, null, 2));
    evidence[scenario] = { ...quitEvidence(state, stdout), stateDirectory, rejections };
    results.push({ scenario, passed: true });
  }
  const manifestFor = (scenario: string) =>
    readFile(path.join(root, scenario, "states", "1".repeat(40), "app-tree.json"), "utf8");
  if (mode !== "cleanup-only") {
    assert.equal(
      await manifestFor("local-cli-clone-fallback"),
      await manifestFor("local-cli-success"),
    );
    evidence["local-cli-clone-fallback"] = {
      ...(evidence["local-cli-clone-fallback"] as object),
      identicalToCloneManifest: createHash("sha256")
        .update(await manifestFor("local-cli-success"))
        .digest("hex"),
    };
  }
  if (mode === "local-cli-only") {
    await writeFile(
      path.join(root, "report.json"),
      JSON.stringify({ providerSimulation: true, results, evidence }, null, 2),
    );
    process.stdout.write(
      `${JSON.stringify({ artifact: path.join(root, "report.json"), results })}\n`,
    );
    process.exit(0);
  }
  // Real bundle renames/pruning, simulated signing and launch; never /Applications.
  const retention = path.join(root, "local-cli-success");
  const retentionConfig = JSON.parse(
    await readFile(path.join(retention, "config.json"), "utf8"),
  ).mac;
  const application = retentionConfig.targets[0].applicationPath;
  const retentionProvider = path.join(retention, "provider.json");
  const initialReceipt = JSON.parse(
    await readFile(path.join(retention, "states", "1".repeat(40), "mac-local.json"), "utf8"),
  );
  const backups = async () =>
    (await readdir(retention))
      .filter((name) => /^Opensteer Beta\.app\.[a-f0-9]{40}\.previous$/u.test(name))
      .sort();
  const legacy = `${application}.${"a".repeat(40)}.previous`;
  const unrelated = `${application}.other.previous`;
  const link = `${application}.${"b".repeat(40)}.previous`;
  await mkdir(legacy);
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep"), "unrelated");
  await symlink(unrelated, link);
  const runRetention = async (
    revision: string,
    phase: "local-install" | "local-verify",
    mode = "local-retention",
  ) => {
    const providerState = JSON.parse(await readFile(retentionProvider, "utf8"));
    providerState.mode = mode;
    providerState.revision = revision;
    await writeFile(retentionProvider, JSON.stringify(providerState));
    await writeFile(
      path.join(retention, "fixture.json"),
      JSON.stringify({
        config: retentionConfig,
        phase,
        identity: { sourceRevision: revision, version: "1.2.3" },
      }),
    );
    return runPhase(retention);
  };
  const seedRetention = async (revision: string) => {
    const stage = path.join(
      retentionConfig.targets[0].stagingDirectory,
      revision,
      "Opensteer Beta.app",
    );
    await cp(application, stage, { recursive: true, verbatimSymlinks: true });
    await child("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :OpensteerSourceRevision ${revision}`,
      path.join(stage, "Contents/Info.plist"),
    ]);
    const appTreeSha256 = await writeMacAppManifest(stage, path.join(retention, "app-tree.json"), {
      sourceDirectory: retention,
      stateDirectory: retention,
      identity: { sourceRevision: revision, version: "1.2.3" },
      run: runBounded,
    });
    await writeFile(
      path.join(retention, "mac-local.json"),
      JSON.stringify({
        ...initialReceipt,
        appTreeSha256,
        sourceRevision: revision,
        installed: [],
        verified: [],
        rollback: {},
      }),
    );
  };
  const retentionReceipt = async () =>
    JSON.parse(await readFile(path.join(retention, "mac-local.json"), "utf8"));
  // Stale advisory lock files survive owner exit and must not be unlinked.
  const lockPath = `${application}.install.lock`;
  const staleLock = await readFile(lockPath, "utf8");
  const releaseLock = await acquireReleaseLock(lockPath);
  try {
    await assert.rejects(acquireReleaseLock(lockPath), /Another coordinator/u);
  } finally {
    await releaseLock();
  }
  assert.ok(staleLock.trim());
  const rollbackSnapshots: unknown[] = [];
  for (const revision of ["2".repeat(40), "3".repeat(40)]) {
    const previousRevision = revision.startsWith("2") ? "1".repeat(40) : "2".repeat(40);
    await seedRetention(revision);
    if (revision.startsWith("2")) {
      const beforeInvalid = JSON.parse(await readFile(retentionProvider, "utf8"));
      const opensBefore = beforeInvalid.calls.filter(
        (call: { executable: string }) => call.executable === "/usr/bin/open",
      ).length;
      await assert.rejects(
        runRetention(revision, "local-install", "local-retention-postswap-invalid"),
        /Post-swap verification failed; original app restored/u,
      );
      const afterInvalid = JSON.parse(await readFile(retentionProvider, "utf8"));
      assert.equal(
        afterInvalid.calls.filter(
          (call: { executable: string }) => call.executable === "/usr/bin/open",
        ).length,
        opensBefore,
      );
      assert.equal(
        await child("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :OpensteerSourceRevision",
          path.join(application, "Contents/Info.plist"),
        ]).then((value) => value.trim()),
        previousRevision,
      );
      await assert.rejects(access(`${application}.${revision}.previous`));
      await access(`${application}.${revision}.next`);
      await rm(`${application}.${revision}.next`, { recursive: true });
    }
    await runRetention(revision, "local-install");
    if (revision.startsWith("3")) {
      // Crash after the second rename but before installed was persisted.
      const lostReceiptSave = await retentionReceipt();
      lostReceiptSave.installed = [];
      await writeFile(path.join(retention, "mac-local.json"), JSON.stringify(lostReceiptSave));
      await runRetention(revision, "local-install");
      assert.deepEqual((await retentionReceipt()).installed, ["local"]);
    }
    await access(legacy);
    await runRetention(revision, "local-verify", "local-retention-launch-denied").then(
      () => assert.fail("Launch failure was accepted"),
      (error: unknown) => {
        assert.match(String(error), /macOS policy denied/u);
        assert.ok(String(error).includes(`${application}.${revision}.previous`));
      },
    );
    await access(legacy);
    if (revision.startsWith("2")) {
      await assert.rejects(
        runRetention(revision, "local-verify", "local-retention-health-denied"),
        /Invalid input/u,
      );
      await access(legacy);
    }
    const backup = `${application}.${revision}.previous`;
    assert.equal((await retentionReceipt()).rollback.local.sourceRevision, previousRevision);
    assert.equal((await retentionReceipt()).rollback.local.version, "1.2.3");
    assert.equal((await retentionReceipt()).rollback.local.path, backup);
    // The exact prior application remains restorable with the existing rename protocol.
    await rename(application, application + ".failed");
    await cp(backup, application, { recursive: true });
    assert.equal(
      await child("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :OpensteerSourceRevision",
        path.join(application, "Contents/Info.plist"),
      ]).then((value) => value.trim()),
      previousRevision,
    );
    await rename(application, application + `.${revision}.restored`);
    await rename(application + ".failed", application);
    await runRetention(revision, "local-verify");
    assert.deepEqual(await backups(), [path.basename(link)]);
    assert.deepEqual((await retentionReceipt()).rollback, {});
    await access(path.join(unrelated, "keep"));
    rollbackSnapshots.push(await retentionReceipt());
    // Re-verification retries cleanup without recreating a backup.
    await runRetention(revision, "local-install");
    await runRetention(revision, "local-verify");
    assert.deepEqual(await backups(), [path.basename(link)]);
    assert.deepEqual((await retentionReceipt()).rollback, {});
    if (revision.startsWith("2")) await mkdir(legacy);
  }
  const interruptedRevision = "4".repeat(40);
  await seedRetention(interruptedRevision);
  await assert.rejects(
    runRetention(interruptedRevision, "local-install", "local-retention-interrupted-rename"),
    /Fixture command failed/u,
  );
  await assert.rejects(access(application));
  await access(`${application}.${interruptedRevision}.previous`);
  await runRetention(interruptedRevision, "local-install");
  const pruneState = JSON.parse(await readFile(retentionProvider, "utf8"));
  pruneState.failPrune = true;
  await writeFile(retentionProvider, JSON.stringify(pruneState));
  await runRetention(interruptedRevision, "local-verify");
  assert.deepEqual((await retentionReceipt()).verified, ["local"]);
  await access(`${application}.${interruptedRevision}.previous`);
  await runRetention(interruptedRevision, "local-verify");
  assert.deepEqual(await backups(), [path.basename(link)]);
  rollbackSnapshots.push(await retentionReceipt());
  evidence["install-retention"] = {
    directory: retention,
    rollbackSnapshots,
    state: await readState(retentionProvider),
  };
  for (const scenario of [
    "retention-repeated-installs",
    "retention-failed-verification-rollback",
    "retention-interrupted-resume",
    "retention-cleanup-resume",
    "retention-leftover-lock",
  ])
    results.push({ scenario, passed: true });
  if (mode === "cleanup-only") {
    await writeFile(
      path.join(root, "report.json"),
      JSON.stringify({ providerSimulation: true, results, evidence }, null, 2),
    );
    process.stdout.write(
      `${JSON.stringify({ artifact: path.join(root, "report.json"), results })}\n`,
    );
    process.exit(0);
  }
  const unknownDirectory = path.join(root, "unknown-command");
  await mkdir(unknownDirectory);
  const unknownState = path.join(unknownDirectory, "provider.json");
  await writeFile(unknownState, JSON.stringify({ mode: "local-unknown", calls: [] }));
  for (const [executable, args] of [
    ["unexpected-provider", []],
    ["git", ["archive"]],
    ["pnpm", ["exec", "unexpected"]],
    ["/usr/bin/xcrun", ["unexpected"]],
    ["/usr/bin/uname", ["unexpected"]],
    ["/usr/bin/lipo", ["unexpected"]],
    ["/usr/bin/codesign", ["unexpected"]],
  ] as const) {
    await assert.rejects(
      runBounded(process.execPath, [
        "-e",
        provider,
        unknownState,
        executable,
        JSON.stringify(args),
        "{}",
      ]),
      /Unknown.*fixture command|Unknown git fixture command/u,
    );
  }
  results.push({ scenario: "unknown-command", passed: true });
  // Exercise packaging's credential boundary without starting a compiler or signer.
  const packageFixture = path.join(root, "packaging-authority");
  await mkdir(packageFixture);
  const gitStub = path.join(packageFixture, "git");
  await writeFile(
    gitStub,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '-C') throw Error('Unknown packaging git fixture command');
const query = JSON.stringify(args.slice(2));
if (query === JSON.stringify(['status','--porcelain=v1','--untracked-files=all'])) console.log('');
else if (query === JSON.stringify(['rev-parse','--verify','HEAD^{commit}'])) console.log('1'.repeat(40));
else throw Error('Unknown packaging git fixture command: '+query);
`,
    { mode: 0o755 },
  );
  const packageStub = path.join(packageFixture, "pnpm.cjs");
  await writeFile(
    packageStub,
    "process.stderr.write('PACKAGE_PREPARATION_REACHED'); process.exit(97);\n",
  );
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  await assert.rejects(
    child(gitStub, ["-C", repository, "archive"]),
    /Unknown packaging git fixture command/u,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: packageFixture + path.delimiter + process.env.PATH,
    npm_execpath: packageStub,
    OPENSTEER_DESKTOP_TARGET_ARCH: "arm64",
    OPENSTEER_DESKTOP_RELEASE_CHANNEL: "beta",
    OPENSTEER_APPLE_TEAM_ID: "ABCDE12345",
    OPENSTEER_SOURCE_REVISION: "1".repeat(40),
    OPENSTEER_RELEASE_VERSION: JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    ).version,
  };
  for (const key of [
    "APPLE_KEYCHAIN_PROFILE",
    "APPLE_KEYCHAIN",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ])
    delete environment[key];
  // Release packaging takes its Team ID only from the validated signing input, so the
  // signing-authority case withholds that input rather than passing a mismatched team.
  const scenarioEnvironment = (scenario: string): NodeJS.ProcessEnv => {
    const scenarioEnv: NodeJS.ProcessEnv = {
      ...environment,
      OPENSTEER_DESKTOP_DEFER_NOTARIZATION: scenario.startsWith("deferred") ? "1" : "0",
    };
    if (scenario === "deferred-needs-signing-authority")
      delete scenarioEnv.OPENSTEER_DESKTOP_SIGNING_FILE;
    return scenarioEnv;
  };
  for (const scenario of [
    "deferred-no-notary-credentials",
    "distribution-needs-notary-credentials",
    "deferred-needs-signing-authority",
  ]) {
    const output: string[] = [];
    await assert.rejects(
      child(
        process.execPath,
        ["--import", "tsx", path.join(repository, "apps/desktop/scripts/package-macos.ts")],
        undefined,
        scenarioEnvironment(scenario),
      ),
      (error) => {
        output.push(String(error));
        assert.match(
          String(error),
          scenario === "deferred-no-notary-credentials"
            ? /PACKAGE_PREPARATION_REACHED/u
            : scenario === "deferred-needs-signing-authority"
              ? /A valid signing input is required for a release build/u
              : /Exactly one complete Apple notarization/u,
        );
        if (scenario !== "deferred-no-notary-credentials")
          assert.doesNotMatch(String(error), /PACKAGE_PREPARATION_REACHED/u);
        return true;
      },
    );
    evidence[scenario] = { output };
    results.push({ scenario, passed: true });
  }
  for (const scenario of scenarios.filter(
    (scenario) =>
      mode !== "verify-only" && (mode !== "install-only" || installScenarios.includes(scenario)),
  )) {
    const directory_ = path.join(root, scenario);
    await mkdir(directory_);
    await writeFile(
      path.join(directory_, "fixture.json"),
      JSON.stringify({ config, phase: "prepare" }),
    );
    const providerFile = path.join(directory_, "provider.json");
    await writeFile(
      providerFile,
      JSON.stringify({
        mode: scenario,
        apps: apps[scenario] ?? {},
        calls: [],
        observations: [],
        quits: [],
        renames: [],
        requestId: "11111111-1111-4111-8111-111111111111",
        revision: "1".repeat(40),
      }),
    );
    const archive = "simulated submitted archive";
    await writeFile(path.join(directory_, "Opensteer Beta.submit.zip"), archive);
    await writeFile(
      path.join(directory_, "mac.json"),
      JSON.stringify({
        sourceRevision: "1".repeat(40),
        version: "1.2.3",
        configDigest: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
        submissionIntent: true,
        submissionZipSha256: createHash("sha256").update(archive).digest("hex"),
        ...(scenario === "ambiguous" ? {} : { requestId: "11111111-1111-4111-8111-111111111111" }),
        accepted: false,
        staged: [],
        installed: [],
        verified: [],
      }),
    );
    if (installScenarios.includes(scenario)) {
      const receipt = JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8"));
      receipt.staged = ["local", "remote"];
      receipt.accepted = true;
      await writeFile(path.join(directory_, "mac.json"), JSON.stringify(receipt));
      await writeFile(
        path.join(directory_, "fixture.json"),
        JSON.stringify({ config, phase: "install" }),
      );
      if (scenario === "corrupt-next") {
        await assert.rejects(runPhase(directory_), /bundle CFBundleIdentifier differs/u);
        const failed = JSON.parse(await readFile(providerFile, "utf8"));
        assert.equal(
          failed.calls.some((call: { args: string[] }) =>
            call.args.join(" ").includes("release-beta-install"),
          ),
          false,
        );
        assert.deepEqual(
          JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8")).installed,
          [],
        );
        results.push({ scenario, passed: true });
        continue;
      }
      const installed = async () =>
        JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8")).installed;
      if (scenario === "delayed-quit") {
        const stdout = lines(await runPhase(directory_));
        const state = await readState(providerFile);
        for (const target of ["local", "remote"]) {
          const quits = state.quits.filter((quit) => quit.target === target);
          assert.equal(quits.length, 1);
          const asked = quits[0]!;
          const afterQuit = state.observations.filter(
            (observation) => observation.target === target && observation.call > asked.call,
          );
          const exited = afterQuit.find((observation) => !observation.running);
          assert.ok(exited, `Opensteer Beta never finished quitting on ${target}`);
          // Longer than the old window of ten observations nine seconds apart.
          assert.ok(afterQuit.filter((observation) => observation.running).length >= 10);
          assert.ok(exited.at - asked.at >= 9_000);
          const renames = state.renames.filter((rename) => rename.target === target);
          assert.deepEqual(
            renames.map((rename) => rename.renamed),
            [true],
          );
          assert.ok(renames[0]!.call > exited.call);
          assert.equal(stdout.filter((line) => line === waitingMessage(target)).length, 1);
        }
        assertQuitOnlyAsked(state);
        assert.deepEqual(await installed(), ["local", "remote"]);
        evidence[scenario] = quitEvidence(state, stdout);
        results.push({ scenario, passed: true });
        continue;
      }
      if (scenario === "cancelled-quit") {
        const { phase, done } = spawnPhase(directory_);
        await waitForState(
          providerFile,
          (state) =>
            state.apps.remote!.quitRequests === 1 && state.apps.remote!.observedAfterQuit >= 3,
        );
        phase.kill("SIGTERM");
        const cancelled = await done;
        const atExit = await readState(providerFile);
        // Nothing the cancelled phase started keeps polling the Mac.
        await sleep(2_500);
        const settled = await readState(providerFile);
        assert.notEqual(cancelled.code, 0);
        assert.match(cancelled.stderr, /Release cancelled/u);
        assert.equal(settled.calls.length, atExit.calls.length);
        assert.equal(
          lines(cancelled.stdout).filter((line) => line === waitingMessage("remote")).length,
          1,
        );
        assert.equal(settled.quits.filter((quit) => quit.target === "remote").length, 1);
        assert.equal(
          settled.renames.some((rename) => rename.target === "remote"),
          false,
        );
        assert.deepEqual(await installed(), ["local"]);
        assertQuitOnlyAsked(settled);
        const cancelledEvidence = quitEvidence(settled, lines(cancelled.stdout));
        // Its shutdown finishes once it is asked again; resuming installs it.
        settled.apps.remote = runningApp(1);
        await writeFile(providerFile, JSON.stringify(settled));
        const resumedStdout = lines(await runPhase(directory_));
        const resumed = await readState(providerFile);
        assert.equal(resumed.quits.filter((quit) => quit.target === "remote").length, 2);
        assert.equal(resumed.quits.filter((quit) => quit.target === "local").length, 1);
        assert.deepEqual(
          resumed.renames.map((rename) => [rename.target, rename.renamed]),
          [
            ["local", true],
            ["remote", true],
          ],
        );
        assertQuitOnlyAsked(resumed);
        assert.deepEqual(await installed(), ["local", "remote"]);
        evidence[scenario] = {
          cancelled: {
            exitCode: cancelled.code,
            stderr: cancelled.stderr.slice(-2_000),
            ...cancelledEvidence,
          },
          resumed: quitEvidence(resumed, resumedStdout),
        };
        results.push({ scenario, passed: true });
        continue;
      }
      if (scenario === "reappears-before-rename") {
        await assert.rejects(runPhase(directory_), /Quit Opensteer Beta before installation/u);
        const refused = await readState(providerFile);
        assert.deepEqual(
          refused.renames.map((rename) => [rename.target, rename.renamed]),
          [["local", false]],
        );
        assert.deepEqual(await installed(), []);
        const resumedStdout = lines(await runPhase(directory_));
        const resumed = await readState(providerFile);
        assert.equal(resumed.quits.filter((quit) => quit.target === "local").length, 2);
        assert.deepEqual(
          resumed.renames.map((rename) => [rename.target, rename.renamed]),
          [
            ["local", false],
            ["local", true],
            ["remote", true],
          ],
        );
        assertQuitOnlyAsked(resumed);
        assert.deepEqual(await installed(), ["local", "remote"]);
        evidence[scenario] = quitEvidence(resumed, resumedStdout);
        results.push({ scenario, passed: true });
        continue;
      }
      if (scenario === "graceful-quit") {
        await runPhase(directory_);
        const completed = await readState(providerFile);
        assert.equal(completed.quits.length, 1);
        assertQuitOnlyAsked(completed);
        const signatureChecks = completed.calls.filter(
          (call: { executable: string; args: string[] }) =>
            call.executable === "/usr/bin/codesign" && call.args.includes("--verify"),
        );
        assert.ok(signatureChecks.length >= 2);
        for (const call of signatureChecks) {
          assert.equal(call.args.includes("-R"), false);
          assert.equal(
            call.args.some((argument: string) => argument.startsWith("-R=")),
            true,
          );
        }
        results.push({ scenario, passed: true });
        continue;
      }
      await assert.rejects(runPhase(directory_));
      const partial = JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8"));
      assert.deepEqual(partial.installed, ["local"]);
      const state = JSON.parse(await readFile(providerFile, "utf8"));
      state.mode = "resume";
      await writeFile(providerFile, JSON.stringify(state));
      await runPhase(directory_);
      const complete = JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8"));
      assert.deepEqual(complete.installed, ["local", "remote"]);
      const resumed = JSON.parse(await readFile(providerFile, "utf8"));
      assert.equal(
        resumed.calls.filter(
          (call: { executable: string; args: string[] }) =>
            call.executable === "/bin/sh" && call.args.includes("release-beta-install"),
        ).length,
        1,
      );
    } else {
      const expected =
        scenario === "ambiguous"
          ? /submission outcome is unknown/u
          : scenario === "rejected"
            ? /Invalid/u
            : scenario === "notary-provider-error"
              ? /Apple authentication failed/u
              : scenario === "notary-invalid-at-deadline"
                ? /Invalid/u
                : /is pending/u;
      if (scenario === "notary-cancelled") {
        const { phase, done } = spawnPhase(directory_);
        await waitForState(providerFile, (state) => state.infoCalls === 2);
        phase.kill("SIGTERM");
        const cancelled = await done;
        assert.notEqual(cancelled.code, 0);
        assert.match(cancelled.stderr, /Release cancelled/u);
        assert.doesNotMatch(cancelled.stderr, /ReleasePendingError/u);
        evidence[scenario] = { stderr: cancelled.stderr };
        results.push({ scenario, passed: true });
        continue;
      }
      await assert.rejects(runPhase(directory_), (error) => {
        assert.match(String(error), expected);
        if (["pending", "notary-inflight-expiry"].includes(scenario)) {
          assert.match(String(error), /ReleasePendingError/u);
          assert.match(String(error), /11111111-1111-4111-8111-111111111111/u);
          assert.match(
            String(error),
            /pnpm desktop:install-local --config \/fixture\/release.json/u,
          );
        }
        if (["notary-provider-error", "notary-invalid-at-deadline"].includes(scenario))
          assert.doesNotMatch(String(error), /ReleasePendingError/u);
        evidence[scenario] = { error: String(error) };
        return true;
      });
      const before = JSON.parse(await readFile(providerFile, "utf8"));
      await assert.rejects(runPhase(directory_), expected);
      const after = JSON.parse(await readFile(providerFile, "utf8"));
      const submits = (value: { calls: { executable: string; args: string[] }[] }) =>
        value.calls.filter(
          (call) => call.executable === "/usr/bin/xcrun" && call.args[1] === "submit",
        ).length;
      assert.equal(submits(before), 0);
      assert.equal(submits(after), 0);
      if (scenario === "pending") {
        const observations = (value: ProviderState) =>
          value.calls.filter(
            (call) => call.executable === "/usr/bin/xcrun" && call.args[1] === "info",
          ).length;
        assert.equal(observations(before), 1);
        assert.equal(observations(after), 2);
      }
      if (scenario.startsWith("notary-")) {
        const calls = after.calls.filter((call: { args: string[] }) => call.args.includes("info"));
        assert.deepEqual(
          calls.map((call: { timeoutMs: number }) => call.timeoutMs),
          [60_000, 500, 60_000, 500],
        );
      }
      const receipt = JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8"));
      assert.equal(receipt.submissionIntent, true);
      assert.equal(Boolean(receipt.requestId), scenario !== "ambiguous");
    }
    results.push({ scenario, passed: true });
  }
  if (mode !== "install-only") {
    const remoteWithoutHost = {
      ...config,
      targets: [config.targets[0], { ...config.targets[1], runtimeStatusUrl: null }],
    };
    assert.equal(
      macConfigSchema.safeParse({
        ...remoteWithoutHost,
        targets: [{ ...config.targets[0], runtimeStatusUrl: null }, config.targets[1]],
      }).success,
      false,
    );
    assert.equal(
      macConfigSchema.safeParse({
        ...remoteWithoutHost,
        targets: [
          config.targets[0],
          { ...config.targets[1], runtimeStatusUrl: "https://example.com/healthz" },
        ],
      }).success,
      false,
    );
    const directory_ = path.join(root, "uninitialized-remote");
    await mkdir(directory_);
    await writeFile(
      path.join(directory_, "fixture.json"),
      JSON.stringify({ config: remoteWithoutHost, phase: "verify" }),
    );
    const providerFile = path.join(directory_, "provider.json");
    await writeFile(
      providerFile,
      JSON.stringify({
        mode: "uninitialized-remote",
        calls: [],
        localInstalled: true,
        remoteInstalled: true,
        revision: "1".repeat(40),
      }),
    );
    await writeFile(
      path.join(directory_, "mac.json"),
      JSON.stringify({
        sourceRevision: "1".repeat(40),
        version: "1.2.3",
        configDigest: createHash("sha256").update(JSON.stringify(remoteWithoutHost)).digest("hex"),
        staged: ["local", "remote"],
        installed: ["local", "remote"],
        verified: [],
      }),
    );
    await runPhase(directory_);
    const completed = JSON.parse(await readFile(providerFile, "utf8"));
    const remoteCalls = completed.calls.filter(
      (call: { executable: string }) => call.executable === "/usr/bin/ssh",
    ) as { args: string[] }[];
    assert.equal(
      remoteCalls.some((call) => call.args.at(-1)?.includes("/bin/ps")),
      true,
    );
    assert.equal(
      remoteCalls.some((call) => call.args.at(-1)?.includes("codesign")),
      true,
    );
    assert.equal(
      remoteCalls.some((call) => call.args.at(-1)?.includes("shasum")),
      true,
    );
    assert.equal(
      remoteCalls.some((call) => call.args.at(-1)?.includes("curl")),
      false,
    );
    assert.equal(
      completed.calls.some((call: { executable: string }) => call.executable === "/usr/bin/curl"),
      true,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory_, "mac.json"), "utf8")).verified,
      ["local", "remote"],
    );
    completed.mode = "uninitialized-remote-bad-signature";
    completed.calls = [];
    await writeFile(providerFile, JSON.stringify(completed));
    await assert.rejects(runPhase(directory_));
    const rejected = JSON.parse(await readFile(providerFile, "utf8"));
    assert.equal(
      rejected.calls.some(
        (call: { executable: string; args: string[] }) =>
          call.executable === "/usr/bin/ssh" && call.args.at(-1)?.includes("codesign"),
      ),
      true,
    );
    results.push({ scenario: "uninitialized-remote", passed: true });
  }
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify({ providerSimulation: true, results, evidence }, null, 2),
  );
  process.stdout.write(
    `${JSON.stringify({ artifact: path.join(root, "report.json"), results })}\n`,
  );
}
