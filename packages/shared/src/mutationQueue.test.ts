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
