import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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

/** The PID of the child a holder reported starting, if it has reported one. */
const heldPid = (seen: readonly string[]) => {
  const line = seen.find((entry) => entry.startsWith("held "));
  return line === undefined ? undefined : Number(line.slice(5));
};

test("one process holds an engine directory until it ends, and its child never holds it", async (context) => {
  const work = await mkdtemp(join(tmpdir(), "opensteer-engine-ownership-"));
  context.onTestFinished(() => rm(work, { recursive: true, force: true }));
  const script = join(work, "holder.mjs");
  await writeFile(script, holder);
  const directory = join(work, "runtime");
  // Teardown stops each holder and waits until it has closed, then stops the detached child it
  // reported, by that PID.
  const start = () => {
    // Node runs the module's TypeScript as it is: it has only types to strip.
    const child = spawn(process.execPath, [script, directory], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const seen = lines(child);
    const closed = once(child, "close");
    context.onTestFinished(async () => {
      child.kill("SIGKILL");
      await closed;
      const pid = heldPid(seen);
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    });
    return { child, seen };
  };
  const { child: first, seen: firstLines } = start();
  const held = await vi.waitFor(
    () => {
      const pid = heldPid(firstLines);
      expect(pid).toBeDefined();
      return pid!;
    },
    { timeout: 4_000, interval: 20 },
  );
  // A second engine waits for the directory.
  const { seen: secondLines } = start();
  await vi.waitFor(() => expect(secondLines).toContain("waiting"), {
    timeout: 4_000,
    interval: 50,
  });
  // The first engine ends while its child lives on; the second takes the directory.
  first.kill("SIGKILL");
  await vi.waitFor(() => expect(heldPid(secondLines)).toBeDefined(), {
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
