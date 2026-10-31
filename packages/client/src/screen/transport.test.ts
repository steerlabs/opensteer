import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketClient } from "../host/host-session-client.js";
import { SocketScreenPresentationTransport } from "./transport.js";

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
    expect(transport.getEndpoint()?.serverTimeUpperBound()).toBe(2_500);
    now = 650;
    expect(transport.getEndpoint()?.serverTimeUpperBound()).toBe(2_550);
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
});
