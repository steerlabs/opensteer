import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { holdQueuedSlot } from "../scripts/test-vm/slot-queue.js";

/*
 * Ways the VM guest queue could fail, since macOS runs at most two guests:
 * - a freed slot goes to whichever waiter retries first, not the one that has
 *   waited longest, or a waiter stops a running job;
 * - a waiter does not say who holds each slot and who is queued ahead of it;
 * - a waiter that was killed keeps those behind it waiting.
 */

const repository = path.resolve(import.meta.dirname, "..");
const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(50);
  }
}

async function queue() {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-vm-slot-queue-"));
  directories.push(root);
  const directory = path.join(root, "vm");
  const admitted: string[] = [];
  const lines = new Map<string, string[]>();
  const slots = new Map<string, number>();
  const hold = (name: string) => {
    lines.set(name, []);
    return holdQueuedSlot(directory, {
      label: "VM slot",
      count: 2,
      purpose: `job ${name}`,
      log: (line) => void lines.get(name)!.push(line),
    }).then((held) => {
      admitted.push(name);
      slots.set(name, held.slot);
      return held;
    });
  };
  const queued = async (name: string) => {
    const held = hold(name);
    await until(() => lines.get(name)!.some((line) => /waiting/u.test(line)), name);
    return { release: async () => (await held).release() };
  };
  return { root, directory, admitted, lines, slots, hold, queued };
}

describe.runIf(process.platform === "darwin")("the VM guest queue", { timeout: 120_000 }, () => {
  it("gives each freed slot to the longest waiter, naming the holders, never stopping one", async () => {
    const q = await queue();
    const h1 = await q.hold("h1");
    const h2 = await q.hold("h2");
    expect(new Set([q.slots.get("h1"), q.slots.get("h2")])).toEqual(new Set([0, 1]));
    q.admitted.length = 0;
    const w1 = await q.queued("W1");
    const w2 = await q.queued("W2");
    const w3 = await q.queued("W3");
    await delay(1_000);
    expect(q.admitted, "running jobs keep their slots").toEqual([]);
    const waiting = q.lines.get("W3")!.at(-1)!;
    for (const name of ["h1", "h2"])
      expect(waiting).toContain(
        `slot-${q.slots.get(name)}: pid ${process.pid} (job ${name}; ${process.cwd()})`,
      );
    expect(waiting).toMatch(
      /^VM slot waiting for pid \d+ \(job W1; .*\), pid \d+ \(job W2; .*\), then for one of 2 slots, held by /u,
    );

    const step = async (release: () => void | Promise<void>, expected: readonly string[]) => {
      await release();
      await until(() => q.admitted.length >= expected.length, `${expected}`);
      expect(q.admitted).toEqual(expected);
    };
    await step(() => h2.release(), ["W1"]);
    expect(q.slots.get("W1")).toBe(q.slots.get("h2"));
    await step(() => h1.release(), ["W1", "W2"]);
    await step(() => w1.release(), ["W1", "W2", "W3"]);
    await w2.release();
    await w3.release();
  });

  it("skips a waiter that was killed", async () => {
    const q = await queue();
    const holders = [await q.hold("h1"), await q.hold("h2")];
    const script = path.join(q.root, "wait.mts");
    await writeFile(
      script,
      `import { holdQueuedSlot } from ${JSON.stringify(path.join(repository, "scripts/test-vm/slot-queue.ts"))};
await holdQueuedSlot(${JSON.stringify(q.directory)}, { label: "VM slot", count: 2, purpose: "killed" });
`,
    );
    const killed = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: repository,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(killed);
    let output = "";
    killed.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await until(() => /waiting/u.test(output), "the first waiter to queue");
    const next = await q.queued("next");
    await until(
      () => q.lines.get("next")!.some((line) => line.includes(`pid ${killed.pid}`)),
      "the next waiter to queue behind the first",
    );
    killed.kill("SIGKILL");
    holders[0]!.release();
    await until(() => q.admitted.includes("next"), "the next waiter, past the dead one");
    await next.release();
    holders[1]!.release();
  });
});
