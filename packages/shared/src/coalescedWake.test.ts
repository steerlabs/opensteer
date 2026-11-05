import { describe, expect, it, vi } from "vitest";
import { CoalescedWake } from "./coalescedWake.js";

function passes() {
  const started: { finish: () => void; fail: (error: unknown) => void }[] = [];
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        started.push({ finish: resolve, fail: reject });
      }),
  );
  return { run, started };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("CoalescedWake", () => {
  it("runs one more pass for wakes that land during a pass, however many", async () => {
    const { run, started } = passes();
    const wake = new CoalescedWake({ run });

    wake.wake();
    wake.wake();
    wake.wake();
    expect(run).toHaveBeenCalledTimes(1);

    started[0]!.finish();
    await settle();
    expect(run).toHaveBeenCalledTimes(2);

    started[1]!.finish();
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never loses a wake that lands as a pass is finishing", async () => {
    const { run, started } = passes();
    const wake = new CoalescedWake({ run });

    wake.wake();
    started[0]!.finish();
    wake.wake();
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports only once nothing is running or requested", async () => {
    const { run, started } = passes();
    const onSettled = vi.fn();
    const wake = new CoalescedWake({ run, onSettled });

    wake.wake();
    wake.wake();
    started[0]!.finish();
    await settle();
    expect(onSettled).not.toHaveBeenCalled();

    started[1]!.finish();
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed pass, but honors a wake that arrived during it", async () => {
    const { run, started } = passes();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const wake = new CoalescedWake({ run, onError, onSettled });
    const failure = new Error("store unavailable");

    wake.wake();
    started[0]!.fail(failure);
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    wake.wake();
    wake.wake();
    started[1]!.fail(failure);
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("contains a pass that throws before its first await", async () => {
    const onError = vi.fn();
    const failure = new Error("synchronous");
    const run = vi.fn(() => {
      throw failure;
    });
    const wake = new CoalescedWake({ run, onError });

    wake.wake();
    await settle();
    wake.wake();
    await settle();

    expect(onError).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stop forgets requested passes and waits for the running one", async () => {
    const { run, started } = passes();
    const wake = new CoalescedWake({ run });

    wake.wake();
    wake.wake();
    let stopped = false;
    const stopping = wake.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    started[0]!.finish();
    await stopping;
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives a wake made during stop to whoever resumed, after the old pass ends", async () => {
    const { run, started } = passes();
    const wake = new CoalescedWake({ run });

    wake.wake();
    const stopping = wake.stop();
    wake.wake();
    expect(run).toHaveBeenCalledTimes(1);

    started[0]!.finish();
    await stopping;
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs again after a stop", async () => {
    const { run, started } = passes();
    const wake = new CoalescedWake({ run });

    wake.wake();
    started[0]!.finish();
    await wake.stop();
    wake.wake();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
