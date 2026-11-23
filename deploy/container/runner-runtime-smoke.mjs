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

// Codex's own sandbox, exactly as the Codex driver selects it for a Run: its
// bundled bubblewrap in the Runner container, under Codex's own sandbox modes.
const codexHome = "/workspace/codex-home";
const runWorkspace = "/workspace/run";
const otherDirectory = "/workspace/other";
for (const directory of [codexHome, runWorkspace, otherDirectory]) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
}
writeFileSync(`${codexHome}/auth.json`, "{}\n", { mode: 0o600 });

function runCodexSandbox(mode, command) {
  return spawnSync(
    codexExecutable,
    ["-c", `sandbox_mode=${JSON.stringify(mode)}`, "sandbox", "--", "/bin/sh", "-c", command],
    {
      cwd: runWorkspace,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 15_000,
    },
  );
}

function expectCodexSandbox(mode, label, command) {
  const result = runCodexSandbox(mode, command);
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${result.error?.message ?? result.stderr.trim() ?? "failed"}`);
  }
  return result.stdout;
}

expectCodexSandbox(
  "workspace-write",
  "Codex workspace-write must write its workspace and nothing outside it",
  `printf sandbox-ok > ${runWorkspace}/workspace-write.txt && ! touch ${otherDirectory}/escape.txt 2>/dev/null`,
);
if (readFileSync(`${runWorkspace}/workspace-write.txt`, "utf8") !== "sandbox-ok") {
  throw new Error("Codex workspace-write did not write its workspace");
}
if (existsSync(`${otherDirectory}/escape.txt`)) {
  throw new Error("Codex workspace-write wrote outside its workspace");
}
expectCodexSandbox(
  "read-only",
  "Codex read-only must read files and write nothing",
  `test "$(cat /workspace/hello.txt)" = hello && ! touch ${runWorkspace}/read-only.txt 2>/dev/null`,
);

// Machine access reaches another computer through a Unix socket; outside Full
// access Codex's sandbox denies it, which is why a Codex Run outside Full
// access is told it has no computers.
const launchDirectory = mkdtempSync("/tmp/opensteer-");
const relaySocket = `${launchDirectory}/relay.sock`;
const relay = spawn("socat", [`UNIX-LISTEN:${relaySocket},fork`, "SYSTEM:echo relay-ok"], {
  stdio: "ignore",
});
try {
  await waitForSocket(relaySocket);
  const blocked = runCodexSandbox("workspace-write", `echo | socat - UNIX-CONNECT:${relaySocket}`);
  if (blocked.status === 0 && blocked.stdout.trim() === "relay-ok") {
    throw new Error("Codex workspace-write must not reach the relay socket");
  }
} finally {
  relay.kill("SIGTERM");
}

// Stop reaps a Run's descendants with the Runner's own containment, the module
// that ships: one that left the process group, and one in a session of its own.
const { ExecutionContainment } = await import("/tmp/execution-containment.mjs");
mkdirSync("/workspace/runner-data", { mode: 0o700, recursive: true });
const containment = new ExecutionContainment({
  bootId: "rbt_smoke",
  dataDirectory: "/workspace/runner-data",
});
const launch = containment.wrap(
  "smoke-run",
  (input) => input,
)({
  args: ["-c", "sleep 300 & setsid sleep 301 & wait"],
  cwd: "/workspace",
  environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  executable: "/bin/sh",
});
const run = spawn(launch.executable, launch.args, {
  cwd: launch.cwd,
  env: launch.environment,
  stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 500));
if ((await containment.liveRoots("smoke-run")) < 1) {
  throw new Error("The smoke Run's processes did not carry its scope");
}
const termination = await containment.terminate("smoke-run", async () => {
  run.kill("SIGTERM");
});
if (termination !== "proven") {
  throw new Error(`Stop did not prove a Run's descendants gone: ${termination}`);
}
const survivors = spawnSync("/bin/sh", ["-c", "ps -eo args | grep -c '^sleep 30[01]$' || true"], {
  encoding: "utf8",
});
if (survivors.stdout.trim() !== "0") throw new Error("A Run's descendant outlived its Stop");

console.log("Runner container runtime smoke passed");

async function waitForSocket(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Relay stand-in did not listen on ${path}`);
}
