import { describe, expect, it, vi } from "vitest";
import { MediaForwarder } from "./mediaForwarder.js";
describe("bounded media forwarding", () => {
  it("returns source credit only after Host admission, carrying the exact hold transfer", () => {
    const admit = vi.fn();
    const failed = vi.fn();
    const send = vi.fn();
    const relay = new MediaForwarder<{ sequence: number }>({
      maxFrames: 2,
      maxBytes: 20,
      writable: () => true,
      send,
      admit,
      failed,
    });
    relay.forward(1, new Uint8Array(5));
    expect(send).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
    relay.ack({ sequence: 1 });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ sequence: 1 });
    relay.close();
    relay.ack({ sequence: 1 });
    expect(admit).toHaveBeenCalledOnce();
  });
  it("fences late frames after a byte/credit overflow or stale ACK", () => {
    const failed = vi.fn();
    const send = vi.fn();
    const relay = new MediaForwarder({
      maxFrames: 1,
      maxBytes: 5,
      writable: () => true,
      send,
      admit: vi.fn(),
      failed,
    });
    expect(relay.forward(1, new Uint8Array(5))).toBe(true);
    expect(relay.forward(2, new Uint8Array(1))).toBe(false);
    expect(relay.forward(3, new Uint8Array(1))).toBe(false);
    expect(failed).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});
