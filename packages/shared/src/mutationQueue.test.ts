import { withTimeout } from "./withTimeout.js";
import { describe, expect, it } from "vitest";
import { MutationQueue } from "./mutationQueue.js";

describe("MutationQueue", () => {
  it("runs interleaved operations one at a time in enqueue order", async () => {
    const queue = new MutationQueue();
    const events: string[] = [];
    const operation = (name: string, steps: number) => async () => {
      events.push(`${name}:start`);
      for (let step = 0; step < steps; step += 1) await Promise.resolve();
      events.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([
      queue.run(operation("a", 3)),
      queue.run(operation("b", 1)),
      queue.run(operation("c", 2)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("keeps running after a rejected operation", async () => {
    const queue = new MutationQueue();
    const order: string[] = [];

    const failed = queue.run(async () => {
      order.push("first");
      throw new Error("mutation failed");
    });
    const succeeded = queue.run(async () => {
      order.push("second");
      return "ok";
    });

    await expect(failed).rejects.toThrow("mutation failed");
    await expect(succeeded).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("runs an operation enqueued from inside another once the outer one finishes", async () => {
    const queue = new MutationQueue();
    const order: string[] = [];
    const enqueued: Promise<string>[] = [];

    const outer = queue.run(async () => {
      order.push("outer:start");
      enqueued.push(
        queue.run(async () => {
          order.push("inner");
          return "inner";
        }),
      );
      order.push("outer:end");
      return "outer";
    });

    await expect(outer).resolves.toBe("outer");
    await expect(Promise.all(enqueued)).resolves.toEqual(["inner"]);
    expect(order).toEqual(["outer:start", "outer:end", "inner"]);
  });
});

it("keeps a key serialized across failures while other keys proceed and drops drained keys", async () => {
  const { KeyedMutationQueue } = await import("./mutationQueue.js");
  const queue = new KeyedMutationQueue();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = queue.run("app", async () => {
    started.resolve();
    await gate.promise;
    order.push("first");
    throw new Error("Failed publication");
  });
  const outcome = first.catch(() => undefined);
  const second = queue.run("app", async () => {
    order.push("second");
  });
  const third = queue.run("app", async () => {
    order.push("third");
  });
  await withTimeout(started.promise, 1_000, {
    timeoutError: () => new Error("First keyed mutation never started"),
  });
  await queue.run("other", async () => {
    order.push("other");
  });
  expect(order).toEqual(["other"]);
  gate.resolve();
  await Promise.all([outcome, second, third]);
  expect(order).toEqual(["other", "first", "second", "third"]);
  expect(queue.keys()).toEqual([]);
});
