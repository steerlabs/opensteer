import { expect, it } from "vitest";
import { MacPreparationPool, runMacPreparations } from "../scripts/mac-preparation.js";

it("shares the two compiler workers with the phone and joins all preparations before packaging", async () => {
  const pool = new MacPreparationPool();
  const finish = [0, 1, 2].map(() => Promise.withResolvers<void>());
  const started = [0, 1, 2].map(() => Promise.withResolvers<void>());
  const events: string[] = [];
  let active = 0;
  let maximum = 0;
  const task = (index: number) => async () => {
    maximum = Math.max(maximum, ++active);
    events.push(`start:${index}`);
    started[index]!.resolve();
    await finish[index]!.promise;
    events.push(`done:${index}`);
    active--;
  };
  const phone = pool.run(task(0));
  const mac = runMacPreparations([task(1), task(2)], undefined, pool);
  try {
    await started[1]!.promise;
    expect(events).toEqual(["start:0", "start:1"]);
    finish[0]!.resolve();
    await started[2]!.promise;
    expect(active).toBe(2);
  } finally {
    for (const value of finish) value.resolve();
    await Promise.all([phone, mac]);
  }
  events.push("package");
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(events.slice(-3)).toContain("done:1");
  expect(events.at(-1)).toBe("package");
});

it("reports a shared phone failure only after sibling cleanup joins, without starting queued compilers", async () => {
  const pool = new MacPreparationPool();
  const fail = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let settled = false;
  let queuedRan = false;
  const phone = pool.run(async () => {
    await fail.promise;
    throw Error("phone failed");
  });
  const mac = runMacPreparations(
    [
      async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        aborted.resolve();
        await cleanup.promise;
      },
      async () => {
        queuedRan = true;
      },
    ],
    undefined,
    pool,
  );
  const result = Promise.allSettled([phone, mac]).then((value) => {
    settled = true;
    return value;
  });
  fail.resolve();
  await aborted.promise;
  expect(settled).toBe(false);
  cleanup.resolve();
  const outcomes = await result;
  expect(outcomes.every((value) => value.status === "rejected")).toBe(true);
  expect(queuedRan).toBe(false);
});
