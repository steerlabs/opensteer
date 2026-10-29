import { describe, expect, it, vi } from "vitest";
import { pumpShellBytes, type ShellByteSocket } from "./shell-byte-pump.js";

/**
 * A socket whose writes complete only when the test says so, which is what
 * "the far end stopped reading" looks like from here.
 */
function fakeSocket() {
  const pending: ((error?: Error) => void)[] = [];
  let listener: ((data: Buffer, isBinary: boolean) => void) | undefined;
  const state = { paused: false, resumes: 0, sent: 0, terminated: false };
  const socket: ShellByteSocket = {
    close: vi.fn(),
    on: (_event, next) => {
      listener = next as (data: Buffer, isBinary: boolean) => void;
      return socket;
    },
    once: () => socket,
    pause: () => {
      state.paused = true;
    },
    readyState: 1,
    removeAllListeners: () => {
      listener = undefined;
      return socket;
    },
    resume: () => {
      state.paused = false;
      state.resumes += 1;
    },
    send: (data, _options, callback) => {
      state.sent += data.byteLength;
      pending.push(callback);
    },
    terminate: () => {
      state.terminated = true;
    },
  };
  return {
    deliver: (bytes: number, isBinary = true) =>
      listener?.(Buffer.alloc(bytes, 1), isBinary) ?? undefined,
    flush: () => {
      for (const callback of pending.splice(0)) callback();
    },
    hasListener: () => listener !== undefined,
    pending,
    socket,
    state,
  };
}

describe("shell byte pump", () => {
  it("pauses a source whose destination has stopped reading and never exceeds the queue", () => {
    const source = fakeSocket();
    const destination = fakeSocket();
    const onFailure = vi.fn();
    const pump = pumpShellBytes({
      destination: destination.socket,
      maxMessageBytes: 64 * 1_024,
      maxQueuedBytes: 256 * 1_024,
      onBytes: () => undefined,
      onFailure,
      source: source.socket,
    });

    // Four 64 KiB messages fill the 256 KiB budget exactly; the source is
    // paused on the one that fills it, so nothing beyond it is ever read.
    for (let index = 0; index < 4; index += 1) source.deliver(64 * 1_024);

    expect(source.state.paused).toBe(true);
    expect(pump.queuedBytes).toBe(256 * 1_024);
    expect(onFailure).not.toHaveBeenCalled();

    destination.flush();

    expect(source.state.paused).toBe(false);
    expect(source.state.resumes).toBe(1);
    expect(pump.queuedBytes).toBe(0);
    expect(pump.bytes).toBe(256 * 1_024);
  });

  it("leaves another session's pump untouched while one is stalled", () => {
    const stalledSource = fakeSocket();
    const stalledDestination = fakeSocket();
    pumpShellBytes({
      destination: stalledDestination.socket,
      maxMessageBytes: 32,
      maxQueuedBytes: 128,
      onBytes: () => undefined,
      onFailure: vi.fn(),
      source: stalledSource.socket,
    });
    const source = fakeSocket();
    const destination = fakeSocket();
    const moved: number[] = [];
    pumpShellBytes({
      destination: destination.socket,
      maxMessageBytes: 32,
      maxQueuedBytes: 128,
      onBytes: (bytes) => moved.push(bytes),
      onFailure: vi.fn(),
      source: source.socket,
    });

    for (let index = 0; index < 4; index += 1) stalledSource.deliver(32);
    source.deliver(16);
    destination.flush();
    source.deliver(16);
    destination.flush();

    expect(stalledSource.state.paused).toBe(true);
    expect(source.state.paused).toBe(false);
    expect(moved).toEqual([16, 16]);
  });

  it("refuses a text message and an oversized one, and stops forwarding after either", () => {
    for (const [label, deliver] of [
      ["text", (socket: ReturnType<typeof fakeSocket>) => socket.deliver(8, false)],
      ["oversized", (socket: ReturnType<typeof fakeSocket>) => socket.deliver(2_048)],
    ] as const) {
      const source = fakeSocket();
      const destination = fakeSocket();
      const onFailure = vi.fn();
      pumpShellBytes({
        destination: destination.socket,
        maxMessageBytes: 1_024,
        onBytes: () => undefined,
        onFailure,
        source: source.socket,
      });

      deliver(source);

      expect(onFailure, label).toHaveBeenCalledOnce();
      expect(destination.state.sent, label).toBe(0);
      expect(source.hasListener(), label).toBe(false);
    }
  });

  it("refuses a frame that would take the queue past its ceiling", () => {
    const source = fakeSocket();
    const destination = fakeSocket();
    const onFailure = vi.fn();
    const pump = pumpShellBytes({
      destination: destination.socket,
      maxMessageBytes: 64,
      maxQueuedBytes: 128,
      onBytes: () => undefined,
      onFailure,
      source: source.socket,
    });

    source.deliver(64);
    source.deliver(64);
    expect(source.state.paused).toBe(true);
    expect(pump.queuedBytes).toBe(128);
    // A peer that keeps sending through the pause — messages `ws` had already
    // parsed, or one that simply ignores it — must not push the queue past the
    // ceiling regardless of what pausing did.
    source.deliver(64);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      message: "A shell session queued more than its buffer allows",
    });
    expect(destination.state.sent).toBe(128);
  });

  it("counts what arrives before the other end exists, then releases it in order", () => {
    const source = fakeSocket();
    const destination = fakeSocket();
    const onFailure = vi.fn();
    const counted: number[] = [];
    const pump = pumpShellBytes({
      maxMessageBytes: 64,
      maxQueuedBytes: 128,
      onBytes: (bytes) => counted.push(bytes),
      onFailure,
      source: source.socket,
    });

    // Pre-activation traffic is held rather than forwarded, but it is read,
    // counted and bounded by the same queue as everything after it.
    source.deliver(64);
    source.deliver(64);
    expect(destination.state.sent).toBe(0);
    expect(pump.queuedBytes).toBe(128);
    expect(counted).toEqual([64, 64]);
    source.deliver(64);
    expect(onFailure).toHaveBeenCalledOnce();

    const second = fakeSocket();
    const released = pumpShellBytes({
      maxMessageBytes: 64,
      maxQueuedBytes: 128,
      onBytes: () => undefined,
      onFailure: vi.fn(),
      source: second.socket,
    });
    second.deliver(16);
    second.deliver(8);
    released.start(destination.socket);

    expect(destination.state.sent).toBe(24);
    expect(released.queuedBytes).toBe(24);
    destination.flush();
    expect(released.queuedBytes).toBe(0);
  });

  it("stops reading and resumes a paused source when the session ends", () => {
    const source = fakeSocket();
    const destination = fakeSocket();
    const pump = pumpShellBytes({
      destination: destination.socket,
      maxQueuedBytes: 64,
      onBytes: () => undefined,
      onFailure: vi.fn(),
      source: source.socket,
    });
    source.deliver(64);
    expect(source.state.paused).toBe(true);

    pump.stop();

    expect(source.state.paused).toBe(false);
    expect(source.hasListener()).toBe(false);
    source.deliver(16);
    expect(destination.state.sent).toBe(64);
  });
});
