import { createId, type Request } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCaller } from "./agent-caller.js";
import { RequestHold } from "./request-hold.js";

function fixture() {
  const request = {
    id: createId("request"),
    status: "pending",
    payload: { kind: "browser.access" },
  } as Request;
  const snapshot = {
    request,
    run: { status: "running", phase: "turn", voiceSessionId: null },
    steered: false,
    queued: false,
  } as NonNullable<
    Awaited<
      ReturnType<ConstructorParameters<typeof RequestHold>[0]["store"]["requests"]["holdSnapshot"]>
    >
  >;
  const controller = new AbortController();
  const outcome = vi.fn<ConstructorParameters<typeof RequestHold>[0]["continuations"]["outcome"]>(
    async (row: Request) =>
      row.status === "pending" ? null : { request: row, text: `Answered ${row.status}` },
  );
  const markToolDelivered = vi.fn(async () => "delivered" as const);
  const holdSnapshot = vi.fn(async () => snapshot);
  const stopHeldRun = vi.fn(async () => {
    controller.abort(new Error("stopped"));
    return { commandId: null, events: [], revokedGrants: [] };
  });
  const onStopped = vi.fn();
  const hold = new RequestHold({
    store: {
      requests: { holdSnapshot, markToolDelivered, personSteerCount: async () => 0 },
      stopHeldRun,
    },
    continuations: { outcome },
    onStopped,
  });
  const input = {
    caller: { claims: { runId: createId("run") } } as RunCaller,
    result: {
      requestId: request.id,
      status: "pending",
      selectedAuth: "oauth",
      authNote: "Keep this",
    },
    tool: "integration_propose",
    admittedAt: Date.now(),
    steersAtAdmission: 0,
    limitMs: 45_000,
    signal: controller.signal,
  };
  return {
    hold,
    input,
    snapshot,
    outcome,
    markToolDelivered,
    holdSnapshot,
    stopHeldRun,
    controller,
  };
}

afterEach(() => vi.useRealTimers());

describe("Request hold", () => {
  it("waits through a parallel live Request and preserves metadata on settlement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let returned = false;
    const result = f.hold.wait(f.input).then((value) => {
      returned = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(500);
    f.snapshot.run.status = "waiting";
    await vi.advanceTimersByTimeAsync(500);
    expect(returned).toBe(false);
    f.snapshot.request = { ...f.snapshot.request, status: "declined" } as Request;
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({
      record: { status: "declined", selectedAuth: "oauth", authNote: "Keep this" },
      text: "Answered declined",
    });
    expect(f.markToolDelivered).toHaveBeenCalledOnce();
  });

  it("returns an answer settled before the first read", async () => {
    const f = fixture();
    f.snapshot.request = { ...f.snapshot.request, status: "declined" } as Request;
    expect(await f.hold.wait(f.input)).toMatchObject({ record: { status: "declined" } });
  });

  it("uses the admission deadline after slow handler work", async () => {
    const f = fixture();
    f.input.admittedAt -= f.input.limitMs;
    await expect(f.hold.wait(f.input)).rejects.toThrow("stopped");
    expect(f.stopHeldRun).toHaveBeenCalledWith(f.input.caller.claims, "limit");
  });

  it("keeps a slow outcome renderer inside the admission deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const render = Promise.withResolvers<Awaited<ReturnType<typeof f.outcome>>>();
    f.outcome.mockImplementation(() => render.promise);
    const call = f.hold.wait(f.input);
    void call.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(f.input.limitMs);
      expect(f.stopHeldRun).toHaveBeenCalledWith(f.input.caller.claims, "limit");
      expect(f.markToolDelivered).not.toHaveBeenCalled();
    } finally {
      f.controller.abort(new Error("closed"));
      render.resolve(null);
      await call.catch(() => undefined);
    }
  });

  it("keeps a stopped call held while the Run winds down in the background", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.input.admittedAt -= f.input.limitMs;
    f.stopHeldRun.mockImplementation(async () => ({
      commandId: null,
      events: [],
      revokedGrants: [],
    }));
    let returned = false;
    const call = f.hold.wait(f.input).then((result) => {
      returned = true;
      return result;
    });
    void call.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.snapshot.run.phase = "background";
      await vi.advanceTimersByTimeAsync(500);
      expect(returned).toBe(false);
    } finally {
      f.controller.abort(new Error("stopped"));
      await call.catch(() => undefined);
    }
  });

  it("releases all current calls on a steer without marking delivery", async () => {
    const f = fixture();
    f.snapshot.steered = true;
    for (const result of await Promise.all([f.hold.wait(f.input), f.hold.wait(f.input)]))
      expect(result).toMatchObject({
        record: { status: "pending" },
      });
    expect(f.markToolDelivered).not.toHaveBeenCalled();
  });

  it("does not consume the continuation after abort during rendering", async () => {
    const f = fixture();
    f.outcome.mockImplementation(async (request) => {
      f.controller.abort(new Error("disconnected"));
      return { request, text: "answer" };
    });
    await expect(f.hold.wait(f.input)).rejects.toThrow("disconnected");
    expect(f.markToolDelivered).not.toHaveBeenCalled();
  });

  it("leaves delivery untouched when rendering fails", async () => {
    const f = fixture();
    f.outcome.mockRejectedValue(new Error("render failed"));
    await expect(f.hold.wait(f.input)).rejects.toThrow("render failed");
    expect(f.markToolDelivered).not.toHaveBeenCalled();
  });
});
