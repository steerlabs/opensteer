import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync, watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir, homedir } from "node:os";
import { guestAllowed } from "../apps/desktop/scripts/journey-isolation.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { descendantPids } from "./smoke-desktop-release-processes.js";
import {
  assertEphemeralRunner,
  personalSelectionReady,
  personalSetupIntent,
} from "./smoke-desktop-release-profile.js";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    "artifacts-dir": { type: "string" },
    "install-in-applications": { type: "boolean" },
  },
});
if (!values.executable) throw Error("--executable must name the packaged executable");
const ciInstall = values["install-in-applications"] === true;
if (ciInstall && (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true"))
  throw Error("Installing the check copy in /Applications is allowed only in GitHub Actions");
const runnerHome = await realpath(homedir());
assertEphemeralRunner(process.env, guestAllowed(runnerHome));
const started = performance.now();
const scratch = await realpath(
  await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "opensteer-launch-")),
);
const data = path.join(scratch, "userdata");
const artifacts = path.resolve(values["artifacts-dir"] ?? path.join(scratch, "artifacts"));
await mkdir(artifacts, { recursive: true });
await mkdir(data, { mode: 0o700 });
await mkdir(path.join(scratch, "tmp"), { mode: 0o700 });
const roots = new Set<number>();
const children = new Set<number>();
let app: ChildProcess | undefined;
let quitting = false;
let passed = false;
let installed: string | undefined;
let ownedWorkspace: string | undefined;
let step = "preparing the isolated packaged app";
const failure = new AbortController();
function capture() {
  const table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 });
  for (const root of roots) for (const pid of descendantPids(table, root)) children.add(pid);
}
function killCaptured() {
  try {
    capture();
  } catch {
    /* Retain already captured identities if ps fails. */
  }
  for (const pid of [...children].reverse().concat([...roots])) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        appendFileSync(
          path.join(artifacts, "cleanup.log"),
          `Could not stop captured PID ${pid}: ${String(error)}\n`,
        );
    }
  }
}
const hardDeadline = setTimeout(() => {
  appendFileSync(path.join(artifacts, "failure.txt"), `180-second deadline: ${step}\n`);
  killCaptured();
  process.exit(1);
}, 180_000);
async function bounded<T>(
  name: string,
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  step = name;
  const timeout = AbortSignal.timeout(milliseconds);
  const signal = AbortSignal.any([timeout, failure.signal]);
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      work(signal),
      new Promise<never>((_, reject) => {
        stop = () => reject(Error(`${name}: ${String(signal.reason)}`));
        signal.addEventListener("abort", stop, { once: true });
      }),
    ]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}
function command(program: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (child.pid) roots.delete(child.pid);
        if (error) reject(Error(`${program}: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
    if (child.pid) roots.add(child.pid);
  });
}
async function ports(): Promise<[number, number]> {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
      ),
    );
    return servers.map((server) => (server.address() as net.AddressInfo).port) as [number, number];
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}
async function waitForSelection(deploymentId: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let dirty = false,
      checking = false;
    const observer = watch(data, { recursive: false }, () => {
      dirty = true;
      void check();
    });
    const finish = (error?: unknown) => {
      observer.close();
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    observer.on("error", finish);
    async function check() {
      if (checking) return;
      checking = true;
      try {
        // Drain file events, rather than polling the profile or sleeping.
        do {
          dirty = false;
          capture();
          try {
            const catalog = await readFile(
              path.join(data, "deployment-connections.v1.json"),
              "utf8",
            );
            if (personalSelectionReady(catalog, deploymentId)) {
              finish();
              return;
            }
          } catch (error) {
            if (!(
              error instanceof SyntaxError ||
              (error instanceof Error && "code" in error && error.code === "ENOENT")
            ))
              throw error;
          }
        } while (dirty && !signal.aborted);
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
      }
    }
    dirty = true;
    void check();
  });
}
let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
try {
  const sourceExecutable = path.resolve(values.executable);
  const bundle = path.resolve(path.dirname(sourceExecutable), "../..");
  if (!bundle.endsWith(".app")) throw Error("Executable must be inside App.app/Contents/MacOS");
  let copy: string;
  if (ciInstall) {
    installed = `/Applications/opensteer-launch-${crypto.randomUUID()}`;
    await command("sudo", ["-n", "mkdir", installed]);
    copy = path.join(installed, path.basename(bundle));
    await command("sudo", ["-n", "/usr/bin/ditto", bundle, copy], 20_000);
  } else {
    copy = path.join(scratch, path.basename(bundle));
    await command("/usr/bin/ditto", [bundle, copy], 20_000);
  }
  const observer = path.join(import.meta.dirname, "smoke-desktop-release-observer.py");
  const [hostPort, postgresPort] = await bounded(
    "loopback ports could not be reserved",
    5_000,
    ports,
  );
  const releaseBytes = await readFile(
    path.join(copy, "Contents/Resources/personal-runtime/release.json"),
    "utf8",
  );
  // Packaged builds reject Workspace overrides and symlinks. Its default is
  // temporary only because this machine is disposable; never reuse a Workspace.
  // The app keeps its durable folder's legacy spelling (config.ts durableDesktopPathName).
  const workspaceParent = path.join(runnerHome, `Open${"S"}teer`);
  await mkdir(workspaceParent, { recursive: true });
  const workspace = path.join(workspaceParent, "Workspaces");
  await mkdir(workspace);
  ownedWorkspace = workspace;
  const intent = personalSetupIntent(releaseBytes, workspaceParent, hostPort, postgresPort);
  await writeFile(path.join(data, "personal-deployment.v1.json"), JSON.stringify(intent), {
    mode: 0o600,
  });
  step = "packaged main process did not start";
  const stdout = openSync(path.join(artifacts, "stdout.log"), "a", 0o600);
  const stderr = openSync(path.join(artifacts, "stderr.log"), "a", 0o600);
  try {
    app = spawn(path.join(copy, "Contents/MacOS", path.basename(sourceExecutable)), [], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: runnerHome,
        TMPDIR: path.join(scratch, "tmp"),
        OPENSTEER_DESKTOP_DATA_DIR: data,
      },
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const child = app;
  if (child.pid) roots.add(child.pid);
  exit = new Promise((resolve) => {
    child.once("error", (error) => failure.abort(error));
    child.once("exit", (code, signal) => {
      if (!quitting) failure.abort(Error(`Desktop exited before readiness: ${code ?? signal}`));
      resolve({ code, signal });
    });
  });
  await bounded(
    "packaged main process did not start",
    5_000,
    () =>
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
  );
  await bounded("Personal supervisor never published a ready selection", 95_000, (signal) =>
    waitForSelection(intent.deploymentId, signal),
  );
  await bounded("Personal Host health did not respond", 5_000, async (signal) => {
    const response = await fetch(`http://127.0.0.1:${hostPort}/healthz`, { signal });
    if (!response.ok || ((await response.json()) as { ok?: boolean }).ok !== true)
      throw Error("Host health was not OK");
  });
  await bounded("renderer never presented its loaded window", 10_000, () =>
    command("/usr/bin/python3", [observer, "window", String(child.pid)], 8_000),
  );
  const output = (
    await Promise.all(
      ["stdout.log", "stderr.log"].map((name) => readFile(path.join(artifacts, name), "utf8")),
    )
  ).join("\n");
  if (/"event":"desktop\.(?:failed|preload\.error)"/u.test(output))
    throw Error("Desktop reported a fatal or preload error");
  capture();
  quitting = true;
  child.kill("SIGTERM");
  const result = await bounded("desktop did not quit through SIGTERM", 35_000, () => exit!);
  if (result.code !== 0 || result.signal !== null)
    throw Error(`Desktop quit unexpectedly: ${JSON.stringify(result)}`);
  await bounded("captured desktop children did not exit", 12_000, () =>
    command("/usr/bin/python3", [observer, "exit", ...[...children].map(String)], 11_000),
  );
  passed = true;
} catch (error) {
  const message = `${step}: ${String(error)}`;
  console.error(message);
  await writeFile(path.join(artifacts, "failure.txt"), message + "\n");
  if (ciInstall)
    await command(
      "/usr/sbin/screencapture",
      ["-x", path.join(artifacts, "screen.png")],
      5_000,
    ).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    capture();
    quitting = true;
    app.kill("SIGTERM");
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 35_000).unref())]);
  }
  await cp(path.join(data, "logs"), path.join(artifacts, "logs"), { recursive: true }).catch(
    () => {},
  );
  killCaptured();
  if (installed) await command("sudo", ["-n", "rm", "-rf", installed], 10_000);
  // Preserve evidence when the caller did not provide an external artifacts directory.
  if (ownedWorkspace) await rm(ownedWorkspace, { recursive: true, force: true });
  if (values["artifacts-dir"]) await rm(scratch, { recursive: true, force: true });
  clearTimeout(hardDeadline);
}

if (passed)
  console.log(
    `Desktop external launch check passed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
