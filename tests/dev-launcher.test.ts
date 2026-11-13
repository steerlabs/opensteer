import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnDevelopmentProcess } from "../scripts/dev-supervisor.js";
import { builtProcessSupervisor } from "../scripts/process-supervisor-path.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const supervisor = builtProcessSupervisor(repositoryRoot);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = join(tmpdir(), `opensteer-dev-launcher-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  return directory;
}

// Starts a never-ending descendant, records both identities, then runs `then`.
const target = (then: string) => `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [ids, marker] = process.argv.slice(1);
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const stop = () => { writeFileSync(marker, "graceful"); process.exit(0); };
process.on("SIGTERM", stop);
if (process.platform === "win32") process.on("SIGBREAK", stop);
writeFileSync(ids, JSON.stringify([process.pid, descendant.pid]));
${then}
`;

async function startedIdentities(file: string): Promise<readonly number[]> {
  return vi.waitFor(async () => JSON.parse(await readFile(file, "utf8")) as number[], {
    interval: 25,
    timeout: 3_000,
  });
}

const within = <T>(operation: Promise<T>, what: string) =>
  withTimeout(operation, 3_000, { timeoutError: () => new Error(`${what} never happened`) });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("development launcher", () => {
  it("stops the whole tree gracefully on request", async () => {
    const directory = await scratch();
    const [ids, marker] = [join(directory, "ids"), join(directory, "marker")];
    const child = spawnDevelopmentProcess(
      supervisor,
      [process.execPath, "-e", target("setInterval(() => {}, 1000);"), ids, marker],
      { cwd: directory, env: process.env },
    );
    const started = await startedIdentities(ids);
    child.stop("graceful");
    expect(await within(child.exited, "the graceful stop")).toEqual({ code: 0, signal: null });
    expect(await readFile(marker, "utf8")).toBe("graceful");
    expect(started.filter(alive), "the supervisor exited before its tree").toEqual([]);
  });

  it("ends descendants a crashed service leaves behind", async () => {
    const directory = await scratch();
    const ids = join(directory, "ids");
    const child = spawnDevelopmentProcess(
      supervisor,
      [process.execPath, "-e", target("process.exit(3);"), ids, join(directory, "marker")],
      { cwd: directory, env: process.env },
    );
    expect(await within(child.exited, "the supervisor's exit")).toEqual({
      code: 3,
      signal: null,
    });
    expect((await startedIdentities(ids)).filter(alive)).toEqual([]);
  });

  it("ends the tree when the development process dies", async () => {
    const directory = await scratch();
    const ids = join(directory, "ids");
    const launcher = pathToFileURL(join(repositoryRoot, "scripts/dev-supervisor.ts")).href;
    const parent = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { spawnDevelopmentProcess } from ${JSON.stringify(launcher)};
spawnDevelopmentProcess(${JSON.stringify(supervisor)}, [process.execPath, "-e", ${JSON.stringify(
          target("setInterval(() => {}, 1000);"),
        )}, ${JSON.stringify(ids)}, ${JSON.stringify(join(directory, "marker"))}], { cwd: ${JSON.stringify(directory)}, env: process.env });
setInterval(() => {}, 1000);`,
      ],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
    const parentExited = new Promise((resolvePromise) => parent.once("exit", resolvePromise));
    try {
      const started = await startedIdentities(ids);
      parent.kill("SIGKILL");
      await within(parentExited, "the parent's death");
      await vi.waitFor(
        () => expect(started.filter(alive), "the tree outlived its owner").toEqual([]),
        { interval: 25, timeout: 3_000 },
      );
    } finally {
      parent.kill("SIGKILL");
    }
  });
});
