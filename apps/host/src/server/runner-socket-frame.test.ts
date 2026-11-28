import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runnerRestartingCloseCode } from "@opensteer/protocol";
import { attachRunnerSocket } from "../server.js";

describe("Host inbound Runner WebSocket frame limit (AB7)", () => {
  it("rejects inbound Runner frames larger than 1 MiB instead of raising Host inbound to 4 MiB", () => {
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      close: vi.fn(),
      pause: vi.fn(),
      readyState: 1,
      resume: vi.fn(),
      send: vi.fn(),
    });
    attachRunnerSocket(
      socket as never,
      {
        issueChallenge: () => ({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          nonce: "nonce",
          type: "host.challenge",
        }),
      } as never,
      { disconnect: vi.fn() } as never,
      vi.fn(),
      { error: vi.fn() } as never,
      vi.fn(),
    );

    const overOneMiB = Buffer.alloc(1 * 1_024 * 1_024 + 1, 0x61);
    socket.emit("message", overOneMiB, false);

    expect(socket.close).toHaveBeenCalledWith(1009, "runner input queue exceeded");
    // Clean up challenge timer via close event.
    socket.emit("close", 1009);
  });

  it("takes a Runner's restart from its close when a send fails on its closing socket first", async () => {
    // A Runner restarting just after it connected (Resume, then Stop at once): its socket is
    // already closing when the Host sends, and its restart close comes right after.
    const socket = Object.assign(new EventEmitter(), {
      CLOSING: 2,
      OPEN: 1,
      bufferedAmount: 0,
      close: vi.fn(),
      pause: vi.fn(),
      readyState: 2,
      resume: vi.fn(),
      send: vi.fn(),
    });
    const disconnect = vi.fn();
    attachRunnerSocket(
      socket as never,
      {
        issueChallenge: () => ({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          nonce: "nonce",
          type: "host.challenge",
        }),
      } as never,
      { disconnect } as never,
      vi.fn(),
      { error: vi.fn() } as never,
      vi.fn(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit("close", runnerRestartingCloseCode);
    expect(
      disconnect.mock.calls.map(([, restarting]) => restarting === true),
      "the failed send ended the Runner as lost before its restart close said it was restarting",
    ).toEqual([true]);
  });
});
