import {
  createId,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  type AgentEvent,
  type EventData,
  type RunId,
} from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { describe, expect, it, vi } from "vitest";
import { RunPlaceRecorder } from "./run-place-recorder.js";

const runId = createId("run");
const browser: EventData<"place.entered"> = {
  place: {
    kind: "browser",
    sessionId: BrowserSessionIdSchema.parse("bsn_11111111-1111-4111-8111-111111111111"),
    surfaceId: BrowserSurfaceIdSchema.parse("A"),
  },
  title: "A",
  site: null,
};
const app: EventData<"place.entered"> = {
  place: { kind: "app", machineId: createId("runner"), appKey: "com.apple.Notes" },
  title: "Notes",
  site: null,
};
const phone: EventData<"place.entered"> = {
  place: { kind: "phone", machineId: createId("runner"), display: "main" },
  title: "Phone",
  site: null,
};
function fixture() {
  const write = vi.fn(
    async (_input: {
      runId: RunId;
      bindingGeneration: number;
      data: EventData<"place.entered">;
    }): Promise<AgentEvent | undefined> => undefined,
  );
  const publish = vi.fn();
  const onError = vi.fn();
  const recorder = new RunPlaceRecorder({ write, publish, onError });
  return {
    recorder,
    write,
    publish,
    onError,
    drain: () =>
      withTimeout(recorder.drain(runId), 1000, {
        timeoutError: () => new Error("Run place writes did not drain"),
      }),
  };
}

describe("per-Run place recording", () => {
  it("serializes browser A → app B → browser A and phone transitions in admission order", async () => {
    const f = fixture();
    const first = Promise.withResolvers<AgentEvent | undefined>();
    f.write.mockReturnValueOnce(first.promise);
    try {
      f.recorder.enter(runId, 1, browser);
      await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1), { timeout: 1000 });
      f.recorder.begin(runId, 1)(app);
      f.recorder.enter(runId, 1, browser);
      f.recorder.begin(runId, 1)(phone);
      f.recorder.enter(runId, 1, phone);
      expect(f.write).toHaveBeenCalledTimes(1);
      first.resolve(undefined);
      await f.drain();
      expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([
        browser,
        app,
        browser,
        phone,
      ]);
    } finally {
      first.resolve(undefined);
      await f.drain();
    }
  });

  it("does not let a native call's late success reclaim a newer browser place", async () => {
    const f = fixture();
    const complete = f.recorder.begin(runId, 1);
    f.recorder.enter(runId, 1, browser);
    complete(app);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([browser]);
  });

  it("records an earlier native success when the newer native operation fails", async () => {
    const f = fixture();
    const complete = f.recorder.begin(runId, 1);
    f.recorder.begin(runId, 1); // The newer operation fails without entering a place.
    complete(app);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([app]);
  });

  it("keeps the newest successful admission when native operations finish out of order", async () => {
    const f = fixture();
    const earlier = f.recorder.begin(runId, 1);
    const newer = f.recorder.begin(runId, 1);
    newer(phone);
    earlier(app);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([phone]);
  });

  it("keeps browser/native ordering when an intervening native operation fails", async () => {
    const f = fixture();
    f.recorder.enter(runId, 1, browser);
    const complete = f.recorder.begin(runId, 1);
    f.recorder.begin(runId, 1);
    complete(app);
    f.recorder.enter(runId, 1, browser);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([browser, app, browser]);
  });

  it("fences an old generation even when the new generation's operation fails", async () => {
    const f = fixture();
    const complete = f.recorder.begin(runId, 1);
    f.recorder.begin(runId, 2);
    complete(app);
    await f.drain();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("does not reuse the place cache across binding generations or after release", async () => {
    const f = fixture();
    f.recorder.enter(runId, 1, browser);
    f.recorder.enter(runId, 2, browser);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.bindingGeneration)).toEqual([1, 2]);
    const late = f.recorder.begin(runId, 2);
    f.recorder.forget(runId);
    late(phone);
    f.recorder.enter(runId, 2, browser);
    await f.drain();
    expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([browser, browser, browser]);
  });

  it("drains accepted writes on shutdown and refuses later native completions", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<AgentEvent | undefined>();
    f.write.mockReturnValueOnce(pending.promise);
    f.recorder.enter(runId, 1, browser);
    const late = f.recorder.begin(runId, 1);
    const closed = withTimeout(f.recorder.close(), 1000, {
      timeoutError: () => new Error("Run place recorder did not close"),
    });
    try {
      late(app);
      f.recorder.enter(runId, 1, phone);
      pending.resolve(undefined);
      await closed;
      expect(f.write.mock.calls.map(([input]) => input.data)).toEqual([browser]);
    } finally {
      pending.resolve(undefined);
      await closed;
    }
  });

  it("publishes only writes accepted by the database's Run fence", async () => {
    const f = fixture();
    const accepted = { type: "place.entered", runId, data: app } as AgentEvent;
    let active = true;
    f.write.mockImplementation(async (input) =>
      active && input.bindingGeneration === 2 ? accepted : undefined,
    );
    f.recorder.enter(runId, 1, app);
    await f.drain();
    expect(f.publish).not.toHaveBeenCalled();
    f.recorder.enter(runId, 2, app);
    await f.drain();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(accepted);
    active = false;
    f.recorder.enter(runId, 2, phone);
    await f.drain();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(3);
  });

  it("retries a failed transition without invalidating a newer queued place", async () => {
    const f = fixture();
    const failed = Promise.withResolvers<AgentEvent | undefined>();
    const error = new Error("place write failed");
    f.write.mockReturnValueOnce(failed.promise);
    f.recorder.enter(runId, 1, browser);
    f.recorder.enter(runId, 1, app);
    failed.reject(error);
    await f.drain();
    f.recorder.enter(runId, 1, app);
    await f.drain();
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalledWith(error);
    f.write.mockRejectedValueOnce(error);
    f.recorder.enter(runId, 1, browser);
    await f.drain();
    f.recorder.enter(runId, 1, browser);
    await f.drain();
    expect(f.write).toHaveBeenCalledTimes(4);
  });
});
