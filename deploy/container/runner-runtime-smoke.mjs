import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const helper = "/app/native-fs-helper/opensteer-native-fs";
// The image puts no codex on PATH: the Runner resolves the Codex package it
// declares, so the smoke test resolves the same executable the same way.
const codexExecutable = (() => {
  const codexRequire = createRequire(
    createRequire("/app/package.json").resolve("@openai/codex/package.json"),
  );
  const platformManifest = codexRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`);
  const triple =
    process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  return join(dirname(platformManifest), "vendor", triple, "bin", "codex");
})();

function request(input) {
  const result = spawnSync(helper, [], {
    encoding: "utf8",
    timeout: 10_000,
    input: JSON.stringify({ ...input, root: "/workspace", rootPolicy: "isolated-mount" }),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? "Native filesystem helper failed",
    );
  }
  const response = JSON.parse(result.stdout);
  if (!response.ok) throw new Error(response.error?.message ?? "Native filesystem request failed");
  return response.result;
}

const probe = request({ operation: "probe" });
if (probe.containment !== "linux-openat2" || probe.platform !== "linux") {
  throw new Error("Runner native filesystem containment is unavailable");
}
const write = request({ content: "hello", operation: "write", path: "hello.txt" });
const read = request({ operation: "read", path: "hello.txt" });
const list = request({ maxDepth: 1, maxEntries: 10, operation: "list", path: "." });
if (
  write.bytesWritten !== 5 ||
  read.contentBase64 !== "aGVsbG8=" ||
  list.entries?.length !== 1 ||
  list.entries[0]?.path !== "hello.txt"
) {
  throw new Error("Runner native filesystem operations returned unexpected results");
}
const child = spawnSync("/bin/true", [], { timeout: 10_000 });
if (child.error || child.status !== 0) throw new Error("Runner Node child process failed");
const pidfdSignal = spawnSync(helper, ["--runtime-pidfd-signal-probe"], {
  encoding: "utf8",
  timeout: 10_000,
});
if (pidfdSignal.error || pidfdSignal.status !== 0) {
  throw new Error(
    pidfdSignal.error?.message ?? pidfdSignal.stderr.trim() ?? "Runner pidfd signal probe failed",
  );
}

const codexHome = "/workspace/codex-home";
const codexSqliteHome = "/workspace/codex-sqlite";
mkdirSync(codexHome, { mode: 0o700, recursive: true });
mkdirSync(codexSqliteHome, { mode: 0o700, recursive: true });
writeFileSync(`${codexHome}/auth.json`, "{}\n", { mode: 0o600 });
writeFileSync(`${codexHome}/config.toml`, "# private smoke fixture\n", { mode: 0o600 });
const privateChecks = `test ! -r ${codexHome}/auth.json && test ! -r ${codexHome}/config.toml`;
const isolatedFilesystem = `"${codexHome}"="deny","${codexSqliteHome}"="deny"`;

function runCodexSandbox(profile, definition, command) {
  const result = spawnSync(
    codexExecutable,
    [
      "-c",
      `default_permissions=${JSON.stringify(profile)}`,
      "-c",
      definition,
      "sandbox",
      "--",
      "/bin/sh",
      "-c",
      command,
    ],
    {
      cwd: "/workspace",
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexSqliteHome },
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? `Codex ${profile} sandbox failed`,
    );
  }
}

for (const [profile, networkEnabled] of [
  ["smoke_workspace", false],
  ["smoke_full", true],
]) {
  const output = `/workspace/${profile}.txt`;
  runCodexSandbox(
    profile,
    `permissions.${profile}={extends=":workspace",filesystem={"/workspace"="write",${isolatedFilesystem}},network={enabled=${networkEnabled}}}`,
    `printf sandbox-ok > ${output} && ${privateChecks}`,
  );
  if (readFileSync(output, "utf8") !== "sandbox-ok") throw new Error(`${profile} did not write`);
}
runCodexSandbox(
  "smoke_read_only",
  `permissions.smoke_read_only={extends=":read-only",filesystem={${isolatedFilesystem}}}`,
  `test "$(cat /workspace/hello.txt)" = hello && ! touch /workspace/read-only.txt && ${privateChecks}`,
);
// The Runner-owned sandbox (apps/runner/src/sandbox/harness-sandbox.ts) around
// a Run's harness process tree, with Codex's own sandbox nested inside it. The
// verifier bundles the production module and mounts it here, so the boot proof
// and the per-Run plan under test are the ones that ship.
const { HarnessSandbox } = await import("/tmp/harness-sandbox.mjs");
const dataDirectory = "/workspace/runner-data";
const stateDirectory = `${dataDirectory}/private/harness-state`;
const workspaceRoot = "/workspace/workspaces";
const profileHome = `${stateDirectory}/harness-profiles/hi_smoke/provider-home`;
const store = `${stateDirectory}/harness-stores/codex/store`;
const threadState = `${stateDirectory}/threads/thr_smoke`;
const otherProfile = `${stateDirectory}/harness-profiles/hi_other/provider-home`;
const runWorkspace = `${workspaceRoot}/user_a/ws`;
const otherWorkspace = `${workspaceRoot}/user_b/ws`;
const launchDirectory = mkdtempSync("/tmp/opensteer-");
for (const directory of [
  profileHome,
  store,
  threadState,
  otherProfile,
  runWorkspace,
  otherWorkspace,
]) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
}
writeFileSync(`${dataDirectory}/identity.json`, "runner-identity\n", { mode: 0o600 });
writeFileSync(`${profileHome}/auth.json`, "{}\n", { mode: 0o600 });
writeFileSync(`${otherProfile}/auth.json`, "{}\n", { mode: 0o600 });
writeFileSync(`${otherWorkspace}/secret.txt`, "other-user\n", { mode: 0o600 });
const relaySocket = `${launchDirectory}/relay.sock`;
const relay = spawn("socat", [`UNIX-LISTEN:${relaySocket},fork`, "SYSTEM:echo relay-ok"], {
  stdio: "ignore",
});
try {
  await waitForSocket(relaySocket);
  const runnerEnvironment = Object.fromEntries(
    ["HOME", "PATH", "TMPDIR"].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [],
    ),
  );
  // Boot proof: the same self-test an isolated-service Runner performs.
  const sandbox = await HarnessSandbox.create({
    dataDirectory,
    environment: runnerEnvironment,
    stateDirectory,
    workspaceRoots: [workspaceRoot],
  });
  const freshProc = sandbox.layout.freshProc;
  const wrap = await sandbox.plan({
    environment: runnerEnvironment,
    integrationSkillsDirectory: undefined,
    launchDirectory,
    providerState: {
      continuationKey: "smoke",
      kind: "isolated",
      privateStateRoot: dataDirectory,
      providerHomeDirectory: profileHome,
      store: { directory: store, id: "smoke" },
    },
    threadStateDirectory: threadState,
    workspacePath: runWorkspace,
    writableRoots: [runWorkspace],
  });
  function runInRunnerSandbox(command, extraEnvironment = {}) {
    const launch = wrap({
      args: ["-c", command],
      cwd: runWorkspace,
      environment: { ...runnerEnvironment, ...extraEnvironment },
      executable: "/bin/sh",
    });
    const result = spawnSync(launch.executable, launch.args, {
      cwd: launch.cwd,
      encoding: "utf8",
      env: launch.environment,
      timeout: 30_000,
    });
    return {
      code: result.status,
      error: result.error,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  function expectInRunnerSandbox(label, command, extraEnvironment) {
    const result = runInRunnerSandbox(command, extraEnvironment);
    if (result.error || result.code !== 0) {
      throw new Error(`${label}: ${result.error?.message ?? result.stderr.trim() ?? "failed"}`);
    }
    return result.stdout;
  }
  expectInRunnerSandbox(
    "Runner sandbox must hide the Runner data directory and other Workspaces",
    [
      `test ! -e ${dataDirectory}/identity.json`,
      `test ! -e ${otherProfile}`,
      `test ! -e ${otherWorkspace}`,
      `test -z "$(ls -A ${workspaceRoot}/user_b 2>/dev/null)"`,
      `test "$(cat ${profileHome}/auth.json)" = "{}"`,
      `test -d ${threadState}`,
      `printf sandbox-ok > ${runWorkspace}/runner-sandbox.txt`,
      `test -z "$(ls -A /tmp | grep -v "^$(basename ${launchDirectory})$")"`,
      ...(freshProc ? [`test "$(cat /proc/1/comm)" = bwrap`] : []),
      `grep -Eq "^CapEff:[[:space:]]*0+$" /proc/self/status`,
    ].join(" && "),
  );
  if (readFileSync(`${runWorkspace}/runner-sandbox.txt`, "utf8") !== "sandbox-ok") {
    throw new Error("Runner sandbox did not write the Run's Workspace");
  }
  const relayReply = expectInRunnerSandbox(
    "Runner sandbox must reach the machine-access relay socket",
    `echo | socat - UNIX-CONNECT:${relaySocket}`,
  );
  if (relayReply.trim() !== "relay-ok") throw new Error("Relay socket answered unexpectedly");

  // A Trigger or Watch program runs a Workspace member's code under the same
  // confinement: its own Workspace, its private files read-only, and nothing
  // of the Runner or of other Runs.
  const programRoot = `${stateDirectory}/watches/executions/smoke/twa_smoke/1`;
  mkdirSync(programRoot, { mode: 0o700, recursive: true });
  writeFileSync(`${programRoot}/capabilities.json`, "program-capabilities\n", { mode: 0o600 });
  const wrapProgram = await sandbox.planProgram({
    environment: runnerEnvironment,
    privateDirectory: programRoot,
    workspacePath: runWorkspace,
  });
  const programLaunch = wrapProgram({
    args: [
      "-c",
      [
        `test "$(cat ${programRoot}/capabilities.json)" = program-capabilities`,
        `! touch ${programRoot}/write-attempt 2>/dev/null`,
        `test ! -e ${dataDirectory}/identity.json`,
        `test ! -e ${profileHome}`,
        `test ! -e ${threadState}`,
        `test ! -e ${otherWorkspace}`,
        `printf program-ok > ${runWorkspace}/program.txt`,
        ...(freshProc ? [`test "$(cat /proc/1/comm)" = bwrap`] : []),
        `grep -Eq "^CapEff:[[:space:]]*0+$" /proc/self/status`,
      ].join(" && "),
    ],
    cwd: runWorkspace,
    environment: runnerEnvironment,
    executable: "/bin/sh",
  });
  const program = spawnSync(programLaunch.executable, programLaunch.args, {
    cwd: programLaunch.cwd,
    encoding: "utf8",
    env: programLaunch.environment,
    timeout: 30_000,
  });
  if (program.error || program.status !== 0) {
    throw new Error(
      `Runner sandbox must confine a program to its Workspace and private files: ${
        program.error?.message ?? program.stderr.trim()
      }`,
    );
  }
  if (readFileSync(`${runWorkspace}/program.txt`, "utf8") !== "program-ok") {
    throw new Error("Runner sandbox did not let a program write its Workspace");
  }

  // Codex's own sandbox nested inside the Runner's, with the exact profile
  // shapes the Codex driver emits for an isolated profile at full access and at
  // workspace-write.
  const nestedDeny = `"${dataDirectory}"="deny"`;
  const nestedFull = `permissions.opensteer_full_access={extends=":workspace",filesystem={"${runWorkspace}"="write",${nestedDeny}},network={enabled=true}}`;
  const nestedWorkspace = `permissions.opensteer_workspace_write={extends=":workspace",filesystem={"${runWorkspace}"="write",${nestedDeny}}}`;
  const nestedEnvironment = { CODEX_HOME: profileHome, CODEX_SQLITE_HOME: `${profileHome}/sqlite` };
  const nested = (profile, definition, command) =>
    runInRunnerSandbox(
      `${codexExecutable} -c 'default_permissions="${profile}"' -c '${definition}' sandbox -- /bin/sh -c '${command}'`,
      nestedEnvironment,
    );
  const nestedRelay = nested(
    "opensteer_full_access",
    nestedFull,
    `echo | socat - UNIX-CONNECT:${relaySocket}`,
  );
  if (nestedRelay.code !== 0 || nestedRelay.stdout.trim() !== "relay-ok") {
    throw new Error(
      `Codex full access inside the Runner sandbox must reach the relay: ${nestedRelay.stderr.trim()}`,
    );
  }
  const nestedPrivate = nested(
    "opensteer_full_access",
    nestedFull,
    `test ! -r ${profileHome}/auth.json && test ! -e ${dataDirectory}/identity.json && printf nested-ok > ${runWorkspace}/nested.txt`,
  );
  if (
    nestedPrivate.code !== 0 ||
    readFileSync(`${runWorkspace}/nested.txt`, "utf8") !== "nested-ok"
  ) {
    throw new Error(
      `Codex full access inside the Runner sandbox must deny its own home and write the Workspace: ${nestedPrivate.stderr.trim()}`,
    );
  }
  const nestedBlocked = nested(
    "opensteer_workspace_write",
    nestedWorkspace,
    `echo | socat - UNIX-CONNECT:${relaySocket}`,
  );
  if (nestedBlocked.code === 0 && nestedBlocked.stdout.trim() === "relay-ok") {
    throw new Error("Codex workspace-write must not reach the relay socket");
  }

  // Terminating the process group the Runner spawned must take the whole tree.
  const treeLaunch = wrap({
    args: ["-c", "sleep 300 & wait"],
    cwd: runWorkspace,
    environment: runnerEnvironment,
    executable: "/bin/sh",
  });
  const tree = spawn(treeLaunch.executable, treeLaunch.args, {
    cwd: treeLaunch.cwd,
    detached: true,
    env: treeLaunch.environment,
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  process.kill(-tree.pid, "SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    tree.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) throw new Error("Runner sandbox process group survived SIGTERM");
  // Without a pid namespace the descendants are ordinary siblings that receive
  // the group signal on their own schedule; give them a moment to go. The
  // bracket keeps the scanner's own command line from matching itself.
  let survivors = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    survivors = spawnSync(
      "sh",
      ["-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' | grep -c 'sleep 30[0]' || true"],
      { encoding: "utf8" },
    ).stdout.trim();
    if (survivors === "0") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (survivors !== "0") throw new Error("A sandboxed descendant outlived its process group");
} finally {
  relay.kill("SIGTERM");
}

console.log("Runner container runtime smoke passed");

async function waitForSocket(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Relay stand-in did not listen on ${path}`);
}
