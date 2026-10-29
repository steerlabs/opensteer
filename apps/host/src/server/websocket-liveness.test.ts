import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installWebSocketLiveness, scheduleWebSocketExpiration } from "./websocket-liveness.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("installWebSocketLiveness", () => {
  it("pings an open peer and accepts the standard Pong response", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    installWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    socket.emit("pong");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates a peer that does not answer one Ping interval", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    installWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("pong")).toBe(0);
  });

  it("waits for an outbound connection to open before beginning liveness", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    socket.readyState = WebSocket.CONNECTING;
    installWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.listenerCount("pong")).toBe(1);

    socket.readyState = WebSocket.OPEN;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  it("cleans up immediately when the socket closes and validates configuration", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const cleanup = installWebSocketLiveness(socket as unknown as WebSocket, {
      intervalMs: 1_000,
    });
    socket.emit("close");
    cleanup();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(() =>
      installWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 0 }),
    ).toThrow(/positive safe integer/i);
  });
});

describe("scheduleWebSocketExpiration", () => {
  it("rearms deadlines longer than Node's maximum timer delay", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-15T00:00:00.000Z") });
    const expire = vi.fn();
    const beyondOneTimer = 2_147_483_647 + 60_000;
    scheduleWebSocketExpiration(Date.now() + beyondOneTimer, expire);

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expire).toHaveBeenCalledOnce();
  });
});

class FakeWebSocket extends EventEmitter {
  readonly ping = vi.fn();
  readyState: number = WebSocket.OPEN;
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
}
