import { describe, expect, it } from "vitest";
import { KeyedAdmissionQueue } from "./index.js";

/*
 * Ways keyed admission can fail the people sending commands:
 * - two commands for one Thread apply out of the order they were sent;
 * - a slow command on one Thread holds up an unrelated Thread;
 * - a command waits behind an earlier one for its Thread even while that one
 *   is itself still waiting, or jumps ahead of it;
 * - a command touching two Threads is ordered against only one of them;
 * - unbounded concurrency or queueing exhausts the database or memory;
 * - a failed command keeps its Thread blocked;
 * - a command that lost a deadlock fails although trying again would succeed,
 *   or a command that failed for a real reason is run twice;
 * - closing loses track of commands still running.
 */
describe("keyed command admission", () => {
  it("applies one Thread's commands in order while other Threads proceed", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 4,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    const order: string[] = [];
    const slow = gate();
    const first = queue.execute(["thread:a"], 1, async () => {
      order.push("a1 start");
      await slow.promise;
      order.push("a1 end");
    });
    const second = queue.execute(["thread:a"], 1, async () => {
      order.push("a2");
    });
    const other = queue.execute(["thread:b"], 1, async () => {
      order.push("b1");
    });
    await other;
    expect(order).toEqual(["a1 start", "b1"]);
    slow.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1 start", "b1", "a1 end", "a2"]);
    await queue.close();
  });

  it("keeps a command behind an earlier one for its Thread that is still waiting", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 1,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    const order: string[] = [];
    const busy = gate();
    const blocker = queue.execute(["thread:x"], 1, async () => {
      await busy.promise;
      order.push("x");
    });
    // `a1` cannot start while the only slot is taken, so `a2` must not pass it
    // when the slot frees, and neither may `b` reorder against them by key.
    const a1 = queue.execute(["thread:a"], 1, async () => {
      order.push("a1");
    });
    const a2 = queue.execute(["thread:a"], 1, async () => {
      order.push("a2");
    });
    busy.open();
    await Promise.all([blocker, a1, a2]);
    expect(order).toEqual(["x", "a1", "a2"]);
    await queue.close();
  });

  it("orders a command that touches two Threads against both", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 4,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    const order: string[] = [];
    const parent = gate();
    const onParent = queue.execute(["thread:parent"], 1, async () => {
      await parent.promise;
      order.push("parent");
    });
    const delegation = queue.execute(["thread:parent", "thread:child"], 1, async () => {
      order.push("delegation");
    });
    const onChild = queue.execute(["thread:child"], 1, async () => {
      order.push("child");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    parent.open();
    await Promise.all([onParent, delegation, onChild]);
    expect(order).toEqual(["parent", "delegation", "child"]);
    await queue.close();
  });

  it("bounds what runs at once and what waits, and rejects overload before running it", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 2,
      maxQueuedBytes: 10,
      maxQueuedCommands: 1,
    });
    let running = 0;
    let peak = 0;
    const hold = gate();
    const task = () => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await hold.promise;
      running -= 1;
    };
    const admitted = [
      queue.execute(["thread:a"], 1, task()),
      queue.execute(["thread:b"], 1, task()),
      queue.execute(["thread:c"], 1, task()),
    ];
    let ranOverload = false;
    await expect(
      queue.execute(["thread:d"], 1, async () => {
        ranOverload = true;
      }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(queue.execute(["thread:e"], 11, async () => undefined)).rejects.toMatchObject({
      retryable: true,
    });
    hold.open();
    await Promise.all(admitted);
    expect(peak).toBe(2);
    expect(ranOverload).toBe(false);
    await queue.close();
  });

  it("frees a Thread when its command fails", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 4,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    const failed = queue.execute(["thread:a"], 1, async () => {
      throw new Error("refused");
    });
    const next = queue.execute(["thread:a"], 1, async () => "applied");
    await expect(failed).rejects.toThrow("refused");
    await expect(next).resolves.toBe("applied");
    await queue.close();
  });

  it("tries a command again after a transaction conflict, and only then", async () => {
    const conflict = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const queue = new KeyedAdmissionQueue({
      isTransactionConflict: (error) =>
        error instanceof Error && "code" in error && error.code === "40P01",
      maxInFlight: 4,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    let attempts = 0;
    await expect(
      queue.execute(["thread:a"], 1, async () => {
        attempts += 1;
        if (attempts < 3) throw conflict;
        return "applied";
      }),
    ).resolves.toBe("applied");
    expect(attempts).toBe(3);

    let refusals = 0;
    await expect(
      queue.execute(["thread:a"], 1, async () => {
        refusals += 1;
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(refusals).toBe(1);

    let conflicts = 0;
    await expect(
      queue.execute(["thread:a"], 1, async () => {
        conflicts += 1;
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    expect(conflicts).toBeLessThanOrEqual(5);
    await queue.close();
  });

  it("refuses new work when closed and waits for work already running", async () => {
    const queue = new KeyedAdmissionQueue({
      maxInFlight: 1,
      maxQueuedBytes: 1_000,
      maxQueuedCommands: 10,
    });
    const running = gate();
    let finished = false;
    const inFlight = queue.execute(["thread:a"], 1, async () => {
      await running.promise;
      finished = true;
    });
    const waiting = queue.execute(["thread:b"], 1, async () => "never");
    const closing = queue.close();
    await expect(waiting).rejects.toMatchObject({ retryable: true });
    await expect(queue.execute(["thread:c"], 1, async () => undefined)).rejects.toMatchObject({
      code: "conflict",
    });
    running.open();
    await closing;
    await inFlight;
    expect(finished).toBe(true);
  });
});

function gate(): { readonly open: () => void; readonly promise: Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}
