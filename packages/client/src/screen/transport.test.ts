import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocketClient } from "../host/host-session-client.js";
import { SocketScreenPresentationTransport } from "./transport.js";

afterEach(() => vi.useRealTimers());

function socket() {
  return {
    binaryType: "arraybuffer" as const,
    readyState: 1,
    addEventListener: vi.fn<WebSocketClient["addEventListener"]>(),
    close: vi.fn(),
    send: vi.fn<WebSocketClient["send"]>(),
  } satisfies WebSocketClient;
}

describe("screen presentation socket binding", () => {
  it("keeps setup latency in the clock estimate and never confuses two workspace sockets", () => {
    let now = 100;
    const transport = new SocketScreenPresentationTransport(() => now);
    const main = socket();
    const other = socket();
    const listener = vi.fn();
    transport.subscribe(listener);
    transport.begin(main);
    now = 600;
    const ready = { type: "host.screen.ready", endpointRef: "a".repeat(64), serverTime: 2_000 };
    expect(transport.receive(other, ready)).toBe(false);
    expect(transport.getEndpoint()).toBeNull();
    expect(transport.receive(main, ready)).toBe(true);
    expect(transport.getEndpoint()?.serverTimeUpperBound()).toBe(2_000 + 500 * 1.001 + 5);
    now = 650;
    expect(transport.getEndpoint()?.serverTimeUpperBound()).toBe(2_000 + 550 * 1.001 + 5);
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const show = {
      type: "host.screen.show",
      operationId,
      endpointRef: ready.endpointRef,
      messageId: createId("message"),
      voiceSessionId: operationId,
      utteranceSequence: 1,
      interactionRevision: 0,
      deadlineAt: 3_000,
      target: { conversationId: createId("thread") },
    };
    transport.receive(other, show);
    expect(listener).not.toHaveBeenCalledWith(show);
    transport.receive(main, show);
    expect(listener).toHaveBeenLastCalledWith(show);
    transport.acknowledge(operationId, { outcome: "applied" });
    expect(main.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        type: "client.screen.done",
        operationId,
        receipt: { outcome: "applied" },
      }),
    );
    expect(other.send).not.toHaveBeenCalled();
    transport.clear(other);
    expect(transport.getEndpoint()).not.toBeNull();
    transport.clear(main);
    expect(transport.getEndpoint()).toBeNull();
    transport.acknowledge(operationId, { outcome: "applied" });
    expect(main.send).toHaveBeenCalledOnce();
  });

  it("does not renew an endpoint from duplicated readiness or an abandoned socket", () => {
    const transport = new SocketScreenPresentationTransport(() => 100);
    const first = socket();
    const second = socket();
    transport.begin(first);
    const ready = { type: "host.screen.ready", endpointRef: "a".repeat(64), serverTime: 500 };
    transport.receive(first, ready);
    transport.receive(first, { ...ready, endpointRef: "b".repeat(64), serverTime: 1_000 });
    expect(transport.getEndpoint()?.endpointRef).toBe(ready.endpointRef);
    transport.begin(second);
    expect(transport.receive(first, ready)).toBe(false);
    expect(transport.getEndpoint()).toBeNull();
    transport.receive(second, { ...ready, endpointRef: "b".repeat(64) });
    expect(transport.getEndpoint()?.endpointRef).toBe("b".repeat(64));
  });

  it("retires a clock discontinuity and accepts a fresh endpoint without reviving old frames", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let now = 100;
    const renew = vi.fn();
    const transport = new SocketScreenPresentationTransport(() => now, renew);
    const first = socket();
    const second = socket();
    const unsubscribe = transport.subscribe(vi.fn());
    transport.begin(first);
    transport.receive(first, {
      type: "host.screen.ready",
      endpointRef: "a".repeat(64),
      serverTime: 500,
    });
    expect(transport.getEndpoint()).not.toBeNull();
    vi.setSystemTime(160_000);
    expect(transport.getEndpoint()).toBeNull();
    expect(renew).toHaveBeenCalledExactlyOnceWith(first);
    now = 200;
    transport.begin(second);
    transport.receive(second, {
      type: "host.screen.ready",
      endpointRef: "b".repeat(64),
      serverTime: 700,
    });
    expect(transport.getEndpoint()?.endpointRef).toBe("b".repeat(64));
    transport.receive(first, {
      type: "host.screen.ready",
      endpointRef: "a".repeat(64),
      serverTime: 800,
    });
    expect(transport.getEndpoint()?.endpointRef).toBe("b".repeat(64));
    unsubscribe();
    transport.clear();
  });

  it("bounds supported clock-rate error and refreshes an aged sample only while voice observes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let now = 0;
    const renew = vi.fn();
    const transport = new SocketScreenPresentationTransport(() => now, renew);
    const main = socket();
    transport.begin(main);
    transport.receive(main, {
      type: "host.screen.ready",
      endpointRef: "a".repeat(64),
      serverTime: 1_000,
    });
    const unsubscribe = transport.subscribe(vi.fn());
    now = 299_000;
    vi.setSystemTime(399_000);
    expect(transport.getEndpoint()?.serverTimeUpperBound()).toBeGreaterThanOrEqual(
      1_000 + now * 1.001,
    );
    now = 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport.getEndpoint()).toBeNull();
    expect(renew).toHaveBeenCalledExactlyOnceWith(main);
    unsubscribe();
    transport.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews an unusably slow handshake instead of poisoning all later requests", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let now = 0;
    const renew = vi.fn();
    const transport = new SocketScreenPresentationTransport(() => now, renew);
    const first = socket();
    const second = socket();
    const unsubscribe = transport.subscribe(vi.fn());
    transport.begin(first);
    now = 6_000;
    vi.setSystemTime(106_000);
    transport.receive(first, {
      type: "host.screen.ready",
      endpointRef: "a".repeat(64),
      serverTime: 5_000,
    });
    expect(transport.getEndpoint()).toBeNull();
    expect(renew).toHaveBeenCalledExactlyOnceWith(first);
    transport.begin(second);
    now += 50;
    vi.setSystemTime(106_050);
    transport.receive(second, {
      type: "host.screen.ready",
      endpointRef: "b".repeat(64),
      serverTime: 6_000,
    });
    expect(transport.getEndpoint()?.endpointRef).toBe("b".repeat(64));
    unsubscribe();
    transport.clear();
  });
});
