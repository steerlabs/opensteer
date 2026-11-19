import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { holdEngineDirectory } from "./engine-ownership.js";

const module = fileURLToPath(new URL("./engine-ownership.ts", import.meta.url));

/** An engine-like process: it takes the directory, says so, and starts a child that outlives it. */
const holder = `
import { spawn } from "node:child_process";
import { holdEngineDirectory } from ${JSON.stringify(module)};
await holdEngineDirectory(process.argv[2], () => process.stdout.write("waiting\\n"));
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
child.unref();
process.stdout.write("held " + child.pid + "\\n");
setInterval(() => {}, 1000);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const lines = (child: ChildProcess) => {
  const seen: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => seen.push(...chunk.split("\n").filter(Boolean)));
  return seen;
};

test("one process holds an engine directory until it ends, and its child never holds it", async (context) => {
  const work = await mkdtemp(join(tmpdir(), "opensteer-engine-ownership-"));
  context.onTestFinished(() => rm(work, { recursive: true, force: true }));
  const script = join(work, "holder.mjs");
  await writeFile(script, holder);
  const directory = join(work, "runtime");
  const start = () =>
    // Node runs the module's TypeScript as it is: it has only types to strip.
    spawn(process.execPath, [script, directory], {
      stdio: ["ignore", "pipe", "inherit"],
    });
  const first = start();
  const firstLines = lines(first);
  context.onTestFinished(() => {
    first.kill("SIGKILL");
  });
  const held = await vi.waitFor(
    () => {
      const line = firstLines.find((entry) => entry.startsWith("held "));
      expect(line).toBeDefined();
      return Number(line!.slice(5));
    },
    { timeout: 4_000, interval: 20 },
  );
  context.onTestFinished(() => {
    if (alive(held)) process.kill(held, "SIGKILL");
  });
  // A second engine waits for the directory.
  const second = start();
  const secondLines = lines(second);
  context.onTestFinished(() => {
    second.kill("SIGKILL");
  });
  await vi.waitFor(() => expect(secondLines).toContain("waiting"), {
    timeout: 4_000,
    interval: 50,
  });
  // The first engine ends while its child lives on; the second takes the directory.
  first.kill("SIGKILL");
  await vi.waitFor(() => expect(secondLines.some((line) => line.startsWith("held "))).toBe(true), {
    timeout: 4_000,
    interval: 50,
  });
  expect(alive(held)).toBe(true);
  // Within one process, holding again is a no-op.
  await holdEngineDirectory(join(work, "own"), () => {
    throw new Error("waited on itself");
  });
  await holdEngineDirectory(join(work, "own"), () => {
    throw new Error("waited on itself");
  });
});
