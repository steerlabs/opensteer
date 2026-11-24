import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
});
