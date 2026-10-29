import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedPersonalLog,
  NodePersonalProcessPort,
  PersonalProcessTimeoutError,
  readPersonalProcessSupervisorRelease,
  type PersonalChildProcess,
} from "./personal-process-port.js";

const desktopDirectory = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const operatingSystem = platform() === "win32" ? "windows" : platform();
const architecture = arch() === "x64" ? "amd64" : arch();
const supervisorExecutable = path.join(
  desktopDirectory,
  "generated-native",
  `${operatingSystem}-${architecture}`,
  platform() === "win32" ? "opensteer-process-supervisor.exe" : "opensteer-process-supervisor",
);
const processSecretsModule = fileURLToPath(
  new URL("../../../../packages/shared/src/processSecrets.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("BoundedPersonalLog", () => {
  it("redacts credentials and retains only a bounded UTF-8 tail", () => {
    const log = new BoundedPersonalLog(90, ["raw-capability-value"]);
    log.append("authorization=Bearer abc password=hunter2 token=runner-token secret=host-secret\n");
    log.append("db=postgresql://opensteer:database-password@127.0.0.1/db raw-capability-value\n");
    log.append(`prefix ${"🌱".repeat(80)} suffix\n`);
    log.flush();
    expect(log.text).not.toContain("hunter2");
    expect(log.text).not.toContain("runner-token");
    expect(log.text).not.toContain("host-secret");
    expect(log.text).not.toContain("database-password");
    expect(log.text).not.toContain("raw-capability-value");
    expect(Buffer.byteLength(log.text, "utf8")).toBeLessThanOrEqual(90);
    expect(() =>
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.from(log.text)),
    ).not.toThrow();
  });
});

describe("NodePersonalProcessPort", () => {
  it("forwards one-shot stdin and returns bounded command output", async () => {
    const port = new NodePersonalProcessPort({ supervisorExecutable });
    const result = await port.run(
      nodeSpec(`process.stdin.pipe(process.stdout)`, "personal input\n"),
      { signal: new AbortController().signal, timeoutMs: 2_000 },
    );
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "", stdout: "[redacted]" });
  });

  it.skipIf(platform() === "win32")(
    "hands a service its secrets on stdin, where its startup environment never shows them",
    async () => {
      const port = new NodePersonalProcessPort({ supervisorExecutable });
      const token = `bridge-${"t".repeat(40)}`;
      // The service reads its secrets the way the Runner does, then stays up
      // so its environment can be inspected from outside as an attacker would.
      const child = port.spawn({
        arguments: [
          "--input-type=module",
          "-e",
          `
            const { readProcessSecrets } = await import(${JSON.stringify(processSecretsModule)});
            const secrets = readProcessSecrets(process.env);
            process.stdout.write(JSON.stringify({ pid: process.pid, secrets }) + "\\n");
            setInterval(() => {}, 1000);
          `,
        ],
        component: "runner",
        cwd: desktopDirectory,
        environment: minimalEnvironment(),
        executable: process.execPath,
        secretInput: { OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token },
      });
      try {
        const report = (await firstJsonLine(child)) as unknown as {
          readonly pid: number;
          readonly secrets: Readonly<Record<string, string>>;
        };

        expect(report.secrets).toEqual({ OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: token });
        const startupEnvironment = await environmentOfProcess(report.pid);
        expect(startupEnvironment).toContain("OPENSTEER_SECRETS_FD=0");
        expect(startupEnvironment).not.toContain(token);
      } finally {
        await child.terminate("force");
      }
    },
  );

  it("starts a service whose disk log cannot be opened, and writes it again once it can", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-logs-"));
    temporaryDirectories.push(root);
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "not a directory");
    // Failure mode: an unusable logs path stops the app constructing its port.
    const unusable = new NodePersonalProcessPort({ logsDirectory: blocked, supervisorExecutable });
    await expect(
      unusable.run(nodeSpec(`process.stdout.write("served")`), {
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "served" });

    const logsDirectory = path.join(root, "logs");
    const port = new NodePersonalProcessPort({ logsDirectory, supervisorExecutable });
    await rm(logsDirectory, { force: true, recursive: true });
    // Failure mode: a logs directory removed while Opensteer runs makes every
    // later spawn throw ENOENT, so a crashed service never comes back.
    await expect(
      port.run(nodeSpec(`process.stdout.write("served again")`), {
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "served again" });
    await expect(
      readFile(path.join(logsDirectory, "personal-postgresql.log"), "utf8"),
    ).resolves.toContain("stdout served again");
  });

  it("interrupts a hung one-shot at its deadline and verifies the tree stopped", async () => {
    const port = new NodePersonalProcessPort({ supervisorExecutable });
    const startedAt = Date.now();
    await expect(
      port.run(nodeSpec(ignoreTerminationScript()), {
        forceTerminationMs: 2_000,
        gracefulTerminationMs: 50,
        signal: new AbortController().signal,
        timeoutMs: 75,
      }),
    ).rejects.toBeInstanceOf(PersonalProcessTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("lets shutdown abort a hung one-shot immediately", async () => {
    const port = new NodePersonalProcessPort({ supervisorExecutable });
    const abort = new AbortController();
    const reason = new Error("Desktop is quitting");
    const running = port.run(nodeSpec(ignoreTerminationScript()), {
      forceTerminationMs: 2_000,
      gracefulTerminationMs: 50,
      signal: abort.signal,
      timeoutMs: 30_000,
    });
    const startedAt = Date.now();
    setTimeout(() => abort.abort(reason), 25);
    await expect(running).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("force-stops a root and resistant descendant as one owned tree", async () => {
    const port = new NodePersonalProcessPort({ supervisorExecutable });
    const child = port.spawn(nodeSpec(processTreeScript()));
    const identities = await firstJsonLine(child);
    await child.terminate("graceful");
    await wait(75);
    expect(processExists(identities.root)).toBe(true);
    expect(processExists(identities.descendant)).toBe(true);
    const exited = waitForChild(child, 2_000);
    await child.terminate("force");
    await exited;
    await waitForProcessesToExit([identities.root, identities.descendant], 2_000);
    expect(processExists(identities.root)).toBe(false);
    expect(processExists(identities.descendant)).toBe(false);
  });
});

describe("Personal process-supervisor release", () => {
  it("verifies the exact packaged platform artifact and digest", async () => {
    const resources = await stagedSupervisorRelease();
    expect(
      readPersonalProcessSupervisorRelease(resources, {
        architecture: architecture === "amd64" ? "x64" : architecture,
        operatingSystem: platform(),
      }),
    ).toBe(
      path.join(
        await realpath(resources),
        "process-supervisor",
        platform() === "win32"
          ? "opensteer-process-supervisor.exe"
          : "opensteer-process-supervisor",
      ),
    );
    const manifestPath = path.join(resources, "process-supervisor", "release.json");
    await chmod(manifestPath, 0o644);
    await writeFile(
      manifestPath,
      JSON.stringify({
        architecture,
        binarySha256: "0".repeat(64),
        operatingSystem: platform(),
        schemaVersion: 1,
      }),
    );
    expect(() =>
      readPersonalProcessSupervisorRelease(resources, {
        architecture,
        operatingSystem: platform(),
      }),
    ).toThrow(/does not match its release manifest/u);
  });
});

function nodeSpec(script: string, stdin?: string) {
  return {
    arguments: ["-e", script],
    component: "postgresql" as const,
    cwd: desktopDirectory,
    environment: minimalEnvironment(),
    executable: process.execPath,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

function minimalEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR"].flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value] as const] : [];
    }),
  );
}

function ignoreTerminationScript(): string {
  return `
    process.on("SIGTERM", () => {});
    if (process.platform === "win32") process.on("SIGBREAK", () => {});
    setInterval(() => {}, 1000);
  `;
}

function processTreeScript(): string {
  return `
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {});
    if (process.platform === "win32") process.on("SIGBREAK", () => {});
    const source = ${JSON.stringify(`${ignoreTerminationScript()}\nprocess.send?.("ready");`)};
    const descendant = spawn(process.execPath, ["-e", source], {
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    descendant.once("message", () => {
      process.stdout.write(JSON.stringify({ root: process.pid, descendant: descendant.pid }) + "\\n");
    });
    setInterval(() => {}, 1000);
  `;
}

async function firstJsonLine(
  child: PersonalChildProcess,
): Promise<{ readonly descendant: number; readonly root: number }> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("Managed process has no stdout.");
  return new Promise((resolvePromise, rejectPromise) => {
    let pending = "";
    const onData = (chunk: Buffer | string) => {
      pending += chunk.toString();
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolvePromise(JSON.parse(pending.slice(0, newline)));
      } catch (error) {
        rejectPromise(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      stdout.off("data", onData);
    };
    stdout.on("data", onData);
    child.once("error", onError);
  });
}

/**
 * A process's startup environment as any other process of the same user can
 * read it: `ps -E` on macOS, `/proc/<pid>/environ` on Linux.
 */
async function environmentOfProcess(processId: number): Promise<string> {
  if (platform() === "linux") {
    return (await readFile(`/proc/${processId}/environ`, "utf8")).replaceAll("\0", "\n");
  }
  const { stdout } = await promisify(execFile)("/bin/ps", [
    "-E",
    "-ww",
    "-o",
    "command=",
    "-p",
    String(processId),
  ]);
  return stdout;
}

async function waitForChild(child: PersonalChildProcess, timeoutMs: number): Promise<void> {
  await Promise.race([
    new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("exit", () => resolvePromise());
      child.once("error", rejectPromise);
    }),
    wait(timeoutMs).then(() => {
      throw new Error("Managed process did not exit before its deadline.");
    }),
  ]);
}

async function waitForProcessesToExit(processes: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (processes.some(processExists) && Date.now() < deadline) await wait(10);
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stagedSupervisorRelease(): Promise<string> {
  const resources = await mkdtemp(path.join(tmpdir(), "opensteer-process-supervisor-release-"));
  temporaryDirectories.push(resources);
  const directory = path.join(resources, "process-supervisor");
  await mkdir(directory, { recursive: true });
  const target = path.join(
    directory,
    platform() === "win32" ? "opensteer-process-supervisor.exe" : "opensteer-process-supervisor",
  );
  await copyFile(supervisorExecutable, target);
  if (platform() !== "win32") await chmod(target, 0o555);
  await writeFile(
    path.join(directory, "release.json"),
    `${JSON.stringify({
      architecture,
      binarySha256: createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
      operatingSystem: platform(),
      schemaVersion: 1,
    })}\n`,
    { mode: 0o444 },
  );
  return resources;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
