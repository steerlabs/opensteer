import { createId, type ScreenPresentationReceipt } from "@opensteer/core";
import { ScreenShowMessageSchema, type ScreenShowMessage } from "@opensteer/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenPresentationController } from "./controller.js";
import type {
  PreparedPresentation,
  ScreenPresentationEndpoint,
  ScreenPresentationPort,
} from "./contract.js";

const voiceSessionId = "12345678-1234-4123-8123-123456789abc";
const endpointRef = "a".repeat(64);
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(options: { preparing?: boolean; confirming?: boolean; ready?: boolean } = {}) {
  let revision = 0;
  let blocked: ScreenPresentationReceipt | null = null;
  let endpoint: ScreenPresentationEndpoint | null =
    options.ready === false
      ? null
      : {
          endpointRef,
          serverTimeUpperBound: () => Date.now(),
        };
  const listeners = new Set<(message: ScreenShowMessage | null) => void>();
  const acknowledge = vi.fn();
  const confirmation = Promise.withResolvers<ScreenPresentationReceipt>();
  const preparing = Promise.withResolvers<PreparedPresentation>();
  const navigated = vi.fn();
  const prepared: PreparedPresentation = {
    commitIfCurrent(guard) {
      const refusal = guard.check();
      if (refusal) return refusal;
      navigated();
      return "committed";
    },
    confirmation: confirmation.promise,
    dispose: vi.fn(),
  };
  if (!options.confirming) confirmation.resolve({ outcome: "applied" });
  const port: ScreenPresentationPort = {
    capture: () => ({ interactionRevision: revision, places: async () => [] }),
    blocked: () => blocked,
    prepare: vi.fn(async () => (options.preparing ? preparing.promise : prepared)),
  };
  const controller = new ScreenPresentationController({
    port,
    transport: {
      getEndpoint: () => endpoint,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      acknowledge,
    },
  });
  disposers.push(() => controller.dispose());
  controller.start(voiceSessionId);
  const capture = controller.captureUtterance();
  const message = ScreenShowMessageSchema.parse({
    type: "host.screen.show",
    endpointRef,
    operationId: "12345678-1234-4123-8123-123456789ab1",
    messageId: createId("message"),
    voiceSessionId,
    utteranceSequence: 1,
    interactionRevision: 0,
    deadlineAt: 6_000,
    target: { conversationId: createId("thread") },
  });
  return {
    controller,
    port,
    capture,
    message,
    prepared,
    navigated,
    acknowledge,
    confirmation,
    emit: (value: ScreenShowMessage) => {
      for (const listener of listeners) listener(value);
    },
    resolve: () => preparing.resolve(prepared),
    move: () => {
      revision += 1;
    },
    block: () => {
      blocked = { outcome: "superseded", reason: "busy" };
    },
    replace: () => {
      endpoint = { endpointRef: "b".repeat(64), serverTimeUpperBound: () => Date.now() };
      for (const listener of listeners) listener(null);
    },
    ready: () => {
      endpoint = { endpointRef, serverTimeUpperBound: () => Date.now() };
      for (const listener of listeners) listener(null);
    },
  };
}

describe("message-scoped screen presentation", () => {
  it("acknowledges an exact route only after the platform confirms its commit", async () => {
    const f = setup({ confirming: true });
    f.emit(f.message);
    await vi.waitFor(
      () => expect(f.navigated, "route was never committed").toHaveBeenCalledOnce(),
      { timeout: 100 },
    );
    expect(f.acknowledge).not.toHaveBeenCalled();
    f.confirmation.resolve({ outcome: "applied" });
    await vi.waitFor(
      () =>
        expect(f.acknowledge, "route confirmation was not acknowledged").toHaveBeenCalledWith(
          f.message.operationId,
          { outcome: "applied" },
        ),
      { timeout: 100 },
    );
  });

  it.each(["view", "editing", "utterance", "voice", "endpoint", "deadline"])(
    "rejects a late preparation after %s changes without leaking its prepared resource",
    async (change) => {
      const f = setup({ preparing: true });
      f.emit(f.message);
      await vi.waitFor(
        () => expect(f.port.prepare, "preparation never started").toHaveBeenCalledOnce(),
        { timeout: 100 },
      );
      if (change === "view") f.move();
      if (change === "editing") f.block();
      if (change === "utterance") f.controller.captureUtterance();
      if (change === "voice") f.controller.stop();
      if (change === "endpoint") f.replace();
      if (change === "deadline") await vi.advanceTimersByTimeAsync(5_000);
      f.resolve();
      await vi.waitFor(
        () =>
          expect(
            f.prepared.dispose,
            "cancelled preparation was not disposed",
          ).toHaveBeenCalledOnce(),
        { timeout: 100 },
      );
      expect(f.navigated).not.toHaveBeenCalled();
      expect(f.acknowledge.mock.calls.every(([, receipt]) => receipt.outcome !== "applied")).toBe(
        true,
      );
    },
  );

  it("returns a duplicate receipt after Back without performing navigation again", async () => {
    const f = setup();
    f.emit(f.message);
    f.emit(f.message);
    await vi.waitFor(
      () => expect(f.acknowledge, "presentation did not settle").toHaveBeenCalledOnce(),
      { timeout: 100 },
    );
    f.move();
    f.emit(f.message);
    expect(f.acknowledge).toHaveBeenCalledTimes(2);
    expect(f.navigated).toHaveBeenCalledOnce();
    f.emit({ ...f.message, operationId: "12345678-1234-4123-8123-123456789ab2" });
    expect(f.acknowledge).toHaveBeenLastCalledWith("12345678-1234-4123-8123-123456789ab2", {
      outcome: "unavailable",
      reason: "already-requested",
    });
    expect(f.navigated).toHaveBeenCalledOnce();
  });

  it("does not retroactively authorize speech that preceded endpoint readiness", async () => {
    const f = setup({ ready: false });
    expect(f.capture.context).toBeUndefined();
    f.ready();
    f.emit(f.message);
    expect(f.port.prepare).not.toHaveBeenCalled();
    const next = f.controller.captureUtterance();
    expect(next.context?.utteranceSequence).toBe(2);
    f.emit({ ...f.message, utteranceSequence: 2 });
    await vi.waitFor(
      () => expect(f.navigated, "fresh utterance did not present").toHaveBeenCalledOnce(),
      { timeout: 100 },
    );
  });

  it("rejects an expired arrival and treats lost confirmation as uncertain", async () => {
    const f = setup({ confirming: true });
    f.emit(f.message);
    await vi.waitFor(() => expect(f.navigated, "route did not commit").toHaveBeenCalledOnce(), {
      timeout: 100,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.acknowledge).toHaveBeenLastCalledWith(f.message.operationId, {
      outcome: "unconfirmed",
      reason: "expired",
    });
    f.confirmation.resolve({ outcome: "applied" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.acknowledge).toHaveBeenCalledOnce();
    const g = setup();
    g.emit({ ...g.message, deadlineAt: Date.now() });
    expect(g.port.prepare).not.toHaveBeenCalled();
    expect(g.acknowledge).toHaveBeenLastCalledWith(g.message.operationId, {
      outcome: "superseded",
      reason: "expired",
    });
  });
});
