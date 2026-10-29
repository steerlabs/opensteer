import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionContainment } from "./execution-containment.js";

/**
 * Real process trees, each shaped like a way an engine's processes outlive the
 * engine: a leader that exits and leaves a child, a descendant that detaches
 * into its own session, and a process that ignores SIGTERM.
 */
const platformVerifies = process.platform === "darwin" || process.platform === "linux";
const directories: string[] = [];
const spawned: number[] = [];

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opensteer-containment-"));
  directories.push(path);
  return path;
}

/**
 * Starts `script` in Node through the containment wrapper and returns the pids
 * it reports on stdout, one per line, once it has reported `expected` of them.
 */
async function launch(
  containment: ExecutionContainment,
  executionId: string,
  script: string,
  expected: number,
): Promise<number[]> {
  const wrapped = containment.wrap(
    executionId,
    (input) => input,
  )({
    args: ["-e", script],
    cwd: tmpdir(),
    environment: { PATH: process.env.PATH ?? "" },
    executable: process.execPath,
  });
  const child = spawn(wrapped.executable, [...wrapped.args], {
    cwd: wrapped.cwd,
    detached: true,
    env: { ...wrapped.environment },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pids: number[] = [];
  let buffered = "";
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) pids.push(Number(line));
      if (pids.length >= expected) resolve();
    });
  });
  spawned.push(...pids);
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleeper = `setInterval(() => {}, 1000)`;
/** Prints its own pid and that of a child it starts in `options`, then optionally exits. */
const parentOf = (childOptions: string, exitAfter: boolean) => `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(sleeper)}], { stdio: "ignore", ${childOptions} });
  child.unref();
  process.stdout.write(process.pid + "\\n" + child.pid + "\\n", () => { ${exitAfter ? "process.exit(0)" : ""} });
  setInterval(() => {}, 1000);
`;

describe.runIf(platformVerifies)("ExecutionContainment", () => {
  it("ends a child its leader left behind in the same process group", async () => {
    const containment = new ExecutionContainment({
      bootId: "rbt_a",
      dataDirectory: await dataDirectory(),
    });
    const [leader, child] = await launch(containment, "run_1", parentOf("", true), 2);
    await expect.poll(() => alive(leader!), { timeout: 5_000 }).toBe(false);
    expect(alive(child!)).toBe(true);

    await expect(containment.terminate("run_1")).resolves.toBe("proven");
    expect(alive(child!)).toBe(false);
  });

  it("ends a descendant that detached into a session of its own", async () => {
    const containment = new ExecutionContainment({
      bootId: "rbt_a",
      dataDirectory: await dataDirectory(),
    });
    const [leader, escaped] = await launch(
      containment,
      "run_1",
      parentOf("detached: true", false),
      2,
    );

    await expect(containment.terminate("run_1")).resolves.toBe("proven");
    expect(alive(leader!)).toBe(false);
    expect(alive(escaped!)).toBe(false);
  });

  it("kills a process that ignores SIGTERM", async () => {
    const containment = new ExecutionContainment({
      bootId: "rbt_a",
      dataDirectory: await dataDirectory(),
    });
    const [stubborn] = await launch(
      containment,
      "run_1",
      `process.on("SIGTERM", () => {}); process.stdout.write(process.pid + "\\n"); ${sleeper}`,
      1,
    );

    await expect(containment.terminate("run_1")).resolves.toBe("proven");
    expect(alive(stubborn!)).toBe(false);
  });

  it("leaves other executions, boots and installations alone", async () => {
    const directory = await dataDirectory();
    const earlier = new ExecutionContainment({ bootId: "rbt_earlier", dataDirectory: directory });
    const current = new ExecutionContainment({ bootId: "rbt_current", dataDirectory: directory });
    const elsewhere = new ExecutionContainment({
      bootId: "rbt_earlier",
      dataDirectory: await dataDirectory(),
    });
    const [orphan] = await launch(earlier, "run_1", parentOf("", false), 2);
    const [sibling] = await launch(current, "run_2", parentOf("", false), 2);
    const [foreign] = await launch(elsewhere, "run_1", parentOf("", false), 2);

    await expect(current.terminate("run_1")).resolves.toBe("proven");
    expect(alive(orphan!)).toBe(true);
    expect(alive(sibling!)).toBe(true);

    await expect(current.reapEarlierBoots()).resolves.toBe("proven");
    expect(alive(orphan!)).toBe(false);
    expect(alive(sibling!)).toBe(true);
    expect(alive(foreign!)).toBe(true);
  });
});

describe("ExecutionContainment without process environments", () => {
  it("says it cannot verify rather than claiming proof", async () => {
    const containment = new ExecutionContainment({
      bootId: "rbt_a",
      dataDirectory: await dataDirectory(),
      platform: "win32",
    });
    await expect(containment.terminate("run_1")).resolves.toBe("unverifiable");
    await expect(containment.reapEarlierBoots()).resolves.toBe("unverifiable");
    await expect(containment.reapBoot()).resolves.toBe("unverifiable");
  });
});
