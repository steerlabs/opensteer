import type { NativeViewerSource } from "../host/surfaces.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseSessionIdSchema,
  displayRefreshCoalescingMs,
  encodeDisplayViewerFrame,
  type DisplayInputEvent,
  type DisplayViewerFrameHeader,
} from "@opensteer/protocol";
import { HttpHostClient, type WebSocketClient } from "../host/host-session-client.js";
import { MockPhoneDisplaySocket } from "../mock/mock-phone-display.js";
import type { HostSnapshot } from "../host/client.js";
import {
  DisplayStreams,
  sharedDisplayStreams,
  computerDisplayScope,
  computerDisplayStatus,
  type DisplayFrame,
  type DisplaySnapshot,
} from "./phone-display-stream.js";

/*
 * Ways the viewer transport can fail, each answered below:
 *
 * - It opens its socket somewhere other than the owner's display route, or
 *   around the injected factory that carries the login.
 * - Two views of one phone open two sockets, or the socket outlives the last
 *   view, or closes while a view remains.
 * - An acknowledgement goes out before the decoder has output the frame, out
 *   of stream order (the Host returns credit cumulatively), twice, for a frame
 *   that never arrived, or on a later socket than the one that delivered it.
 * - A dropped frame, or one no view is decoding, is never acknowledged, so
 *   credit leaks until the Host closes the viewer as stalled.
 * - Reconnecting replays input; it retries without
 *   backoff, never resets its backoff, or retries after the last view left.
 * - A transient close (1001, 1006, 1008, 1013) is not retried, or a terminal
 *   one (1000, 1009, 4002, 4003) is, looping against a Host that said stop;
 *   a terminal close forgets why the stream ended.
 * - A keyframe request goes out while one is already pending, is lost with a
 *   socket that could not carry it, is never sent again once answered, or is
 *   asked once and then waited on forever though the Host rate-limits it.
 * - A replay that restarts at the cache's original sequences, as the Host
 *   sends it, is taken for out-of-order frames and kills the socket.
 * - Cached frames older than `replayThrough` are offered for display, or the
 *   mark outlives its replay or its socket.
 * - Input goes out without negotiated shared input, replays after reconnect,
 *   exceeds 64 events per batch, or repeats a sequence.
 * - A departing last sender fails to reset held input before socket close.
 * - A changed login leaves the old picture's stream looking live.
 * - An unreadable, oversized or out-of-order server message crashes the
 *   client or is believed, or is retried as if the Host could fix it.
 * - A late event from a replaced socket changes the current state.
 * - A changed login or Deployment keeps the old socket open.
 */

const sessionId = ComputerUseSessionIdSchema.parse("cus_11111111-1111-4111-8111-111111111111");
const source = { kind: "task-session" as const, sessionId };
const target = { scope: "scope-a", source };
const pointer = (x: number): DisplayInputEvent => ({
  kind: "pointer",
  phase: "move",
  x,
  y: 0.5,
  t: 1,
});

class FakeSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    // A real socket reports its own close later; the transport must ignore it either way.
    this.#emit("close", { code: code ?? 1005, reason: reason ?? "" });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("not open");
    if (typeof data !== "string") throw new Error("viewer commands are JSON");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }
  json(message: unknown): void {
    this.#emit("message", { data: JSON.stringify(message) });
  }
  text(data: string): void {
    this.#emit("message", { data });
  }
  frame(header: Partial<DisplayViewerFrameHeader> & { sequence: number }): void {
    const bytes = encodeDisplayViewerFrame(
      {
        generation: 1,
        ptsUs: header.sequence * 33_333,
        width: 720,
        height: 1280,
        ...(header.key ? { codec: "avc1.42C01F" } : {}),
        key: false,
        ...header,
      },
      new Uint8Array([0, 0, 0, 1, 0x65, header.sequence]),
    );
    this.#emit("message", { data: bytes.slice().buffer });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.#emit("close", { code, reason: "" });
  }
  messages(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === type);
  }
  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (e: unknown) => void)(event);
  }
}

let sockets: FakeSocket[];
let connect: ReturnType<typeof vi.fn<(source: NativeViewerSource) => WebSocketClient>>;
let streams: DisplayStreams;
const delays: number[] = [];

function live(socket: FakeSocket, generation = 1) {
  socket.json({ type: "display.state", state: "live", generation, width: 720, height: 1280 });
}
function opened(): FakeSocket {
  const socket = sockets.at(-1)!;
  socket.open();
  live(socket);
  return socket;
}
function acks(socket: FakeSocket): unknown[] {
  return socket.messages("display.ack").map((message) => message.sequence);
}
function hold(socket: FakeSocket) {
  socket.json({
    type: "display.state",
    state: "live",
    sharedInput: 1,
    editingVersion: 1,
    generation: 1,
    width: 360,
    height: 780,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  delays.length = 0;
  connect = vi.fn((_source: NativeViewerSource) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  streams = new DisplayStreams({
    connect,
    retryDelay: (attempt) => {
      const delay = 100 * 2 ** attempt;
      delays.push(delay);
      return delay;
    },
  });
});
afterEach(() => {
  streams.dispose();
  vi.useRealTimers();
});

// Diagnostic failures: lost ordering evidence, frame-rate logging, thrown sinks,
// and retries that are scheduled/cancelled without explaining why.
describe("display lifecycle diagnostics", () => {
  it("records ordering evidence without logging frames or changing terminal behavior", () => {
    const diagnostic = vi.fn();
    streams = new DisplayStreams({ connect, diagnostic });
    const lease = streams.retain(target);
    const socket = opened();
    socket.frame({ sequence: 3, generation: 2, key: true });
    const count = diagnostic.mock.calls.length;
    socket.frame({ sequence: 4, generation: 2 });
    expect(diagnostic).toHaveBeenCalledTimes(count);
    socket.frame({ sequence: 5, generation: 1 });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        transition: "protocol-violation",
        reason: "out-of-order",
        previousSequence: 4,
        incomingSequence: 5,
        previousGeneration: 2,
        incomingGeneration: 1,
        kind: "task-session",
        sessionId,
      }),
    );
    expect(lease.getSnapshot().closeCode).toBe(4002);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("scope-a");
    lease.release();
  });

  it("records retry cancellation and isolates a broken diagnostic sink", () => {
    const diagnostic = vi.fn();
    streams = new DisplayStreams({ connect, diagnostic });
    const lease = streams.retain(target);
    opened().drop();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ transition: "retry-scheduled" }),
    );
    lease.release();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ transition: "retry-cancelled" }),
    );
    streams = new DisplayStreams({
      connect,
      diagnostic: () => {
        throw Error("sink failed");
      },
    });
    const next = streams.retain({ ...target, scope: "next" });
    opened().drop(4002);
    expect(next.getSnapshot().closeCode).toBe(4002);
    next.release();
  });
});

describe("phone display socket", () => {
  it("opens the owner's display route through the injected factory", () => {
    const urls: string[] = [];
    const client = new HttpHostClient({
      baseUrl: "https://host.example/",
      fetch: vi.fn(),
      webSocketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
    });
    client.connectComputerDisplay(source);
    expect(urls).toEqual([
      `wss://host.example/v1/computer-use/sessions/${sessionId}/display?sharedInput=1&displayWindow=1`,
    ]);
    client.dispose();
  });

  it("shares one socket among views and closes it with the last", () => {
    const a = streams.retain(target);
    const b = streams.retain(target);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(source);
    const socket = opened();
    expect(socket.binaryType).toBe("arraybuffer");
    expect(a.getSnapshot()).toBe(b.getSnapshot());
    a.release();
    a.release();
    expect(socket.closedWith).toBeNull();
    b.release();
    expect(socket.closedWith).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("separates scopes so another login never shares a socket", () => {
    streams.retain(target);
    streams.retain({ ...target, scope: "scope-b" });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("frame credit", () => {
  it("acknowledges only after every receiving view is done, in stream order, once", () => {
    const a = streams.retain(target);
    const b = streams.retain(target);
    const framesA: DisplayFrame[] = [];
    const framesB: DisplayFrame[] = [];
    a.onFrame((frame) => framesA.push(frame));
    b.onFrame((frame) => framesB.push(frame));
    const socket = opened();
    socket.frame({ sequence: 4, key: true });
    socket.frame({ sequence: 5 });
    expect(framesA.map((frame) => frame.header.sequence)).toEqual([4, 5]);
    expect(framesA[0]?.payload).toEqual(new Uint8Array([0, 0, 0, 1, 0x65, 4]));
    expect(acks(socket)).toEqual([]);
    framesA[1]!.done();
    framesB[1]!.done();
    expect(acks(socket)).toEqual([]);
    framesA[0]!.done();
    framesA[0]!.done();
    expect(acks(socket)).toEqual([]);
    framesB[0]!.done();
    expect(acks(socket)).toEqual([4, 5]);
    framesB[0]!.done();
    framesB[1]!.done();
    expect(acks(socket)).toEqual([4, 5]);
  });

  it("acknowledges at once a frame no view is decoding", () => {
    streams.retain(target);
    const socket = opened();
    socket.frame({ sequence: 0, key: true });
    expect(acks(socket)).toEqual([0]);
  });

  it("never acknowledges on a new socket what an earlier socket delivered", () => {
    const lease = streams.retain(target);
    const frames: DisplayFrame[] = [];
    lease.onFrame((frame) => frames.push(frame));
    const first = opened();
    first.frame({ sequence: 7, key: true });
    first.drop();
    vi.advanceTimersByTime(delays.at(-1)!);
    const second = opened();
    frames[0]!.done();
    expect(acks(first)).toEqual([]);
    expect(acks(second)).toEqual([]);
    expect(frames[0]!.connection).not.toBe(-1);
    second.frame({ sequence: 2, key: true });
    expect(frames[1]!.connection).not.toBe(frames[0]!.connection);
    frames[1]!.done();
    expect(acks(second)).toEqual([2]);
  });
});

describe("recovery", () => {
  it("accepts a replay of the cache's original sequences, as the Host sends it", () => {
    const lease = streams.retain(target);
    const frames: DisplayFrame[] = [];
    lease.onFrame((frame) => {
      frames.push(frame);
      frame.done();
    });
    const socket = opened();
    for (let sequence = 1; sequence <= 3; sequence += 1)
      socket.frame({ sequence, key: sequence === 1 });
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      replayThrough: 3,
    });
    for (let sequence = 1; sequence <= 3; sequence += 1)
      socket.frame({ sequence, key: sequence === 1 });
    socket.frame({ sequence: 4 });
    expect(socket.closedWith).toBeNull();
    expect(frames.map((frame) => [frame.header.sequence, frame.replayed])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(acks(socket)).toEqual([1, 2, 3, 1, 2, 3, 4]);
  });

  it("accepts a replay restarted mid-replay, then closes on a real regression", () => {
    streams.retain(target);
    const socket = sockets[0]!;
    socket.open();
    const replay = {
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      replayThrough: 3,
    };
    socket.json(replay);
    socket.frame({ sequence: 1, key: true });
    socket.json(replay);
    for (let sequence = 1; sequence <= 4; sequence += 1)
      socket.frame({ sequence, key: sequence === 1 });
    expect(acks(socket)).toEqual([1, 1, 2, 3, 4]);
    expect(socket.closedWith).toBeNull();
    socket.frame({ sequence: 4 });
    expect(socket.closedWith?.code).toBe(4002);
  });

  it("survives the preview Host's replay of its cache after a keyframe request", async () => {
    const preview = new DisplayStreams({
      connect: () => new MockPhoneDisplaySocket("live"),
    });
    const lease = preview.retain(target);
    const frames: DisplayFrame[] = [];
    lease.onFrame((frame) => {
      frames.push(frame);
      frame.done();
    });
    await vi.advanceTimersByTimeAsync(10);
    lease.requestKeyframe();
    await vi.advanceTimersByTimeAsync(10);
    expect(lease.getSnapshot().connection).toBe("open");
    expect(frames.map((frame) => [frame.header.sequence, frame.header.key])).toEqual([
      [0, true],
      [0, true],
    ]);
    preview.dispose();
  });

  it("re-asks for a keyframe each coalescing interval while live, then says it failed", () => {
    const lease = streams.retain(target);
    const socket = opened();
    const asked = () => socket.messages("display.keyframe").length;
    lease.requestKeyframe();
    expect(asked()).toBe(1);
    vi.advanceTimersByTime(displayRefreshCoalescingMs - 1);
    expect(asked()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(asked()).toBe(2);
    // The Host defers keyframes while nothing is live, so waiting then is not failing.
    socket.json({
      type: "display.state",
      state: "screen-off",
      generation: 1,
      width: 720,
      height: 1280,
    });
    vi.advanceTimersByTime(10_000);
    expect(asked()).toBe(2);
    live(socket);
    vi.advanceTimersByTime(displayRefreshCoalescingMs * 4);
    expect(asked()).toBe(6);
    expect(lease.getSnapshot().keyframeFailed).toBe(false);
    vi.advanceTimersByTime(displayRefreshCoalescingMs * 4);
    expect(asked()).toBe(6);
    expect(lease.getSnapshot().keyframeFailed).toBe(true);
    socket.frame({ sequence: 1, key: true });
    expect(lease.getSnapshot().keyframeFailed).toBe(false);
    lease.requestKeyframe();
    expect(asked()).toBe(7);
    socket.frame({ sequence: 2, key: true });
    vi.advanceTimersByTime(displayRefreshCoalescingMs * 10);
    expect(asked()).toBe(7);
  });

  it("asks for a keyframe once per loss, again only after one arrives", () => {
    const lease = streams.retain(target);
    lease.requestKeyframe();
    const socket = opened();
    expect(socket.sent).toEqual([]);
    lease.requestKeyframe();
    lease.requestKeyframe();
    expect(socket.messages("display.keyframe")).toEqual([{ type: "display.keyframe" }]);
    socket.frame({ sequence: 1 });
    lease.requestKeyframe();
    expect(socket.messages("display.keyframe")).toHaveLength(1);
    socket.frame({ sequence: 2, key: true });
    lease.requestKeyframe();
    expect(socket.messages("display.keyframe")).toHaveLength(2);
    socket.drop();
    vi.advanceTimersByTime(100);
    const next = opened();
    lease.requestKeyframe();
    expect(next.messages("display.keyframe")).toHaveLength(1);
  });

  it("marks cached frames before replayThrough to be decoded but never shown", () => {
    const lease = streams.retain(target);
    const frames: DisplayFrame[] = [];
    lease.onFrame((frame) => {
      frames.push(frame);
      frame.done();
    });
    const socket = sockets[0]!;
    socket.open();
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      replayThrough: 13,
    });
    for (let sequence = 7; sequence <= 15; sequence += 1)
      socket.frame({ sequence, key: sequence === 7 });
    socket.json({ type: "display.state", state: "live", generation: 1, width: 720, height: 1280 });
    socket.frame({ sequence: 16 });
    expect(frames.map((frame) => [frame.header.sequence, frame.replayed])).toEqual([
      [7, true],
      [8, true],
      [9, true],
      [10, true],
      [11, true],
      [12, true],
      [13, false],
      [14, false],
      [15, false],
      [16, false],
    ]);
    expect(acks(socket)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      replayThrough: 30,
    });
    socket.drop();
    vi.advanceTimersByTime(100);
    const next = opened();
    next.frame({ sequence: 17, key: true });
    expect(frames.at(-1)).toMatchObject({ replayed: false });
  });
});

describe("platform display lifecycle", () => {
  it("replaces every live display socket on network change while keeping its views", () => {
    const network = new Set<() => void>();
    const host = {
      connectComputerDisplay: connect,
      subscribeLifecycle: (listener: (event: "background" | "foreground" | "network") => void) => {
        const changed = () => listener("network");
        network.add(changed);
        return () => network.delete(changed);
      },
    };
    streams = sharedDisplayStreams(host);
    const first = streams.retain(target);
    const second = streams.retain({ ...target, scope: "another-reader" });
    sockets.forEach((socket) => {
      socket.open();
      live(socket);
    });
    hold(sockets[0]!);
    const retired = [...sockets];
    network.forEach((listener) => listener());
    expect(sockets).toHaveLength(4);
    expect(retired.every((socket) => socket.closedWith !== null)).toBe(true);
    expect(first.getSnapshot().input).toBe("unavailable");
    const received = vi.fn();
    first.onFrame((frame) => {
      received(frame.header.sequence);
      frame.done();
    });
    sockets.slice(2).forEach((socket) => {
      socket.open();
      live(socket);
    });
    sockets[2]!.frame({ sequence: 1, key: true });
    expect(received).toHaveBeenCalledWith(1);
    expect(sockets[2]!.messages("display.control")).toEqual([]);
    first.release();
    second.release();
    expect(sockets.slice(2).every((socket) => socket.closedWith !== null)).toBe(true);
  });

  it("pauses sockets while hidden without releasing views or reopening on a hidden network change", () => {
    const held = streams.retain(target);
    const before = opened();
    streams.suspend(true);
    expect(before.closedWith).not.toBeNull();
    streams.reconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    streams.suspend(false);
    expect(connect).toHaveBeenCalledTimes(2);
    opened();
    expect(held.getSnapshot().connection).toBe("open");
    held.release();
    expect(sockets[1]!.closedWith).not.toBeNull();
  });
});

describe("reconnection", () => {
  it("backs off, resets after a live stream, and never replays input", () => {
    const lease = streams.retain(target);
    const first = opened();
    hold(first);
    expect(lease.input(1, [pointer(0.1)])).toBe(true);
    first.drop();
    expect(lease.getSnapshot()).toMatchObject({
      connection: "waiting",
      input: "unavailable",
    });
    expect(lease.input(1, [pointer(0.2)])).toBe(false);
    vi.advanceTimersByTime(99);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    sockets.at(-1)!.drop();
    vi.advanceTimersByTime(200);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
    const third = opened();
    expect(third.sent).toEqual([]);
    expect(lease.getSnapshot().input).toBe("unavailable");
    third.drop();
    expect(delays).toEqual([100, 200, 100]);
  });

  it("keeps the phone's last state across a drop so its words stay true", () => {
    const lease = streams.retain(target);
    const socket = sockets[0]!;
    socket.open();
    socket.json({
      type: "display.state",
      state: "protected",
      reason: "paused",
      generation: 2,
      width: 720,
      height: 1280,
    });
    socket.drop();
    expect(lease.getSnapshot().display).toMatchObject({ state: "protected", reason: "paused" });
  });

  it("stops retrying once the last view lets go", () => {
    const lease = streams.retain(target);
    opened().drop();
    lease.release();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retries a socket the platform could not open", () => {
    connect.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    const lease = streams.retain(target);
    expect(lease.getSnapshot().connection).toBe("waiting");
    vi.advanceTimersByTime(100);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("ignores events from a socket it already replaced", () => {
    const lease = streams.retain(target);
    const first = opened();
    first.drop();
    vi.advanceTimersByTime(100);
    const second = sockets.at(-1)!;
    second.open();
    first.json({ type: "display.state", state: "screen-off", generation: 1, width: 0, height: 0 });
    first.frame({ sequence: 9, key: true });
    expect(lease.getSnapshot().display?.state).toBe("live");
    expect(acks(second)).toEqual([]);
  });

  it("ends the stream on an unreadable or out-of-order server message", () => {
    const cases: ((socket: FakeSocket) => void)[] = [
      (socket) => socket.text("{"),
      (socket) => socket.json({ type: "display.unknown" }),
      (socket) => socket.text(" ".repeat(70 * 1024)),
      (socket) => {
        socket.frame({ sequence: 3, key: true });
        socket.frame({ sequence: 3 });
      },
      (socket) => {
        socket.frame({ sequence: 3, key: true, generation: 2 });
        socket.frame({ sequence: 4, generation: 1 });
      },
    ];
    for (const breakIt of cases) {
      const lease = streams.retain(target);
      const socket = opened();
      breakIt(socket);
      expect(socket.closedWith?.code).toBe(4002);
      expect(lease.getSnapshot()).toMatchObject({ connection: "closed", closeCode: 4002 });
      vi.advanceTimersByTime(60_000);
      expect(sockets.at(-1)).toBe(socket);
      lease.release();
    }
  });

  it.each([1001, 1005, 1006, 1008, 1011, 1012, 1013])(
    "reconnects with backoff after a transient %i",
    (code) => {
      const lease = streams.retain(target);
      opened().drop(code);
      expect(lease.getSnapshot()).toMatchObject({ connection: "waiting", closeCode: code });
      vi.advanceTimersByTime(100);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(lease.getSnapshot()).toMatchObject({ connection: "connecting", closeCode: null });
    },
  );

  it.each([1000, 1009, 4002, 4003])("stops for good after a terminal %i, keeping why", (code) => {
    const lease = streams.retain(target);
    const socket = opened();
    hold(socket);
    socket.json({
      type: "display.state",
      state: "unsupported",
      generation: 0,
      width: 0,
      height: 0,
    });
    socket.drop(code);
    expect(lease.getSnapshot()).toMatchObject({
      connection: "closed",
      closeCode: code,
      display: { state: "unsupported" },
      input: "unavailable",
    });
    expect(lease.input(1, [pointer(0.5)])).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    lease.release();
    streams.retain(target);
    expect(connect).toHaveBeenCalledTimes(1);
    streams.reopen(target);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("closes at once when the login or Deployment it was opened for changes", () => {
    const lease = streams.retain(target);
    const socket = opened();
    streams.invalidate(() => false);
    expect(socket.closedWith).not.toBeNull();
    // Closed for good, so a picture following this stream leaves the screen too.
    expect(lease.getSnapshot()).toEqual({
      connection: "closed",
      closeCode: 4003,
      display: null,
      input: "unavailable",
      keyframeFailed: false,
    } satisfies DisplaySnapshot);
    lease.release();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("shared input", () => {
  it("batches escaped text by UTF-8 bytes below the Host frame bound", () => {
    const lease = streams.retain(target);
    const socket = opened();
    hold(socket);
    const events: DisplayInputEvent[] = Array.from({ length: 64 }, () => ({
      kind: "text",
      insert: "\u0001".repeat(1000),
    }));
    expect(lease.input(1, events)).toBe(true);
    const batches = socket.messages("display.input");
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches)
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
        256 * 1024,
      );
    expect(batches.flatMap((batch) => batch.events)).toEqual(events);
  });

  it("requires both viewer opt-in and producer editing support and delivers private results", () => {
    const lease = streams.retain({ ...target, editing: 1 });
    const socket = opened();
    expect(lease.input(1, [{ kind: "copy" }])).toBe(false);
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      editingVersion: 1,
      sharedInput: 1,
    });
    const results: unknown[] = [];
    lease.onEditingMessage((message) => results.push(message));
    expect(
      lease.input(1, [{ kind: "paste", text: "\u0001".repeat(30000) }, { kind: "copy" }]),
    ).toBe(true);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    socket.json({ type: "display.clipboard", sequence: 0, outcome: "copied", text: "selected" });
    expect(results).toHaveLength(2);
    expect(connect).toHaveBeenCalledWith(source, { editing: 1 });
  });

  it("reports each exact input sequence before send so synchronous receipts cannot race", () => {
    const lease = streams.retain(target);
    const socket = opened();
    hold(socket);
    const sequences: number[] = [];
    expect(
      lease.input(
        1,
        Array.from({ length: 65 }, () => pointer(0.5)),
        (sequence) => {
          expect(socket.messages("display.input")).toHaveLength(0);
          sequences.push(sequence);
        },
      ),
    ).toBe(true);
    expect(sequences).toEqual([0, 1]);
    expect(socket.messages("display.input").map((message) => message.sequence)).toEqual(sequences);
  });

  it("refuses input that breaks the contract instead of letting the Host close the viewer", () => {
    const lease = streams.retain(target);
    const socket = opened();
    hold(socket);
    expect(() => lease.input(1, [pointer(1.5)])).toThrow();
    expect(lease.input(1, [])).toBe(false);
    expect(socket.messages("display.input")).toEqual([]);
  });

  it("accepts both pooled views and renumbers their batches into one viewer's sequence", () => {
    const first = streams.retain(target);
    const second = streams.retain(target);
    const socket = opened();
    expect(first.input(1, [{ kind: "copy" }])).toBe(false);
    hold(socket);
    expect(first.input(1, [{ kind: "text", insert: "one" }])).toBe(true);
    expect(second.input(1, [{ kind: "text", insert: "two" }])).toBe(true);
    expect(socket.messages("display.input").map((m) => m.sequence)).toEqual([0, 1]);
    expect(socket.messages("display.input").every((m) => !("controlId" in m))).toBe(true);
    // Nothing is held, so neither view has anything to release.
    first.release();
    second.release();
    expect(socket.messages("display.input-reset")).toHaveLength(0);
  });

  it("lets only the view holding a press add to it or release it", () => {
    const first = streams.retain(target);
    const second = streams.retain(target);
    const socket = opened();
    hold(socket);
    const press = (phase: "down" | "up", x: number): DisplayInputEvent => ({
      kind: "pointer",
      phase,
      x,
      y: 0.5,
      t: 1,
    });
    const down = press("down", 0.2);
    const up = press("up", 0.4);
    expect(first.input(1, [down])).toBe(true);
    // The other view shares this viewer at the Host: it must not move, end or
    // reset the first view's finger. Its blur is a no-op, not a reset.
    expect(second.input(1, [{ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 0.1 }])).toBe(false);
    second.resetInput();
    second.release();
    expect(socket.messages("display.input-reset")).toHaveLength(0);
    const third = streams.retain(target);
    expect(first.input(1, [pointer(0.3), up])).toBe(true);
    expect(third.input(1, [down])).toBe(true);
    // The holder leaving mid-press releases it for the Host and the phone.
    third.release();
    expect(socket.messages("display.input-reset")).toHaveLength(1);
    expect(first.input(1, [down])).toBe(true);
    first.resetInput();
    expect(socket.messages("display.input-reset")).toHaveLength(2);
    expect(socket.messages("display.input").map((m) => m.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("forgets a press only when the holder's latest batch is refused", () => {
    const first = streams.retain(target);
    const second = streams.retain(target);
    const socket = opened();
    hold(socket);
    const at = (phase: "down" | "move", x: number): DisplayInputEvent => ({
      kind: "pointer",
      phase,
      x,
      y: 0.5,
      t: 1,
    });
    const refuse = (sequence: number) =>
      socket.json({
        type: "display.input.result",
        sequence,
        outcome: "refused",
        reason: "unavailable",
      });
    expect(first.input(1, [at("down", 0.2)])).toBe(true);
    expect(first.input(1, [at("move", 0.3)])).toBe(true);
    refuse(0);
    expect(second.input(1, [at("down", 0.4)])).toBe(false);
    refuse(1);
    expect(second.input(1, [at("down", 0.4)])).toBe(true);
  });

  it("forgets a press the Host already ended with a new picture", () => {
    const first = streams.retain(target);
    const second = streams.retain(target);
    const socket = opened();
    hold(socket);
    const down: DisplayInputEvent = { kind: "pointer", phase: "down", x: 0.2, y: 0.5, t: 1 };
    expect(first.input(1, [down])).toBe(true);
    socket.json({
      type: "display.state",
      state: "live",
      sharedInput: 1,
      editingVersion: 1,
      generation: 2,
      width: 780,
      height: 360,
    });
    expect(second.input(2, [down])).toBe(true);
    first.resetInput();
    expect(socket.messages("display.input-reset")).toHaveLength(0);
  });
});

describe("phone display words", () => {
  const base: DisplaySnapshot = {
    connection: "open",
    closeCode: null,
    display: null,
    input: "unavailable",
    keyframeFailed: false,
  };
  const state = (
    value: NonNullable<DisplaySnapshot["display"]>["state"],
    reason?: NonNullable<DisplaySnapshot["display"]>["reason"],
  ): DisplaySnapshot => ({
    ...base,
    display: {
      type: "display.state",
      state: value,
      generation: 1,
      width: 720,
      height: 1280,
      ...(reason ? { reason } : {}),
    },
  });

  it.each([
    [base, null, false],
    [{ ...base, connection: "waiting" as const }, null, true],
    [state("starting"), null, false],
    [state("live"), null, false],
    [state("protected", "paused"), "paused", false],
    [state("protected", "opensteer-app"), "opensteer-app", false],
    [state("protected", "session-ended"), "ended", false],
    [state("protected"), "protected", false],
    [state("screen-off"), "screen-off", false],
    [state("unsupported"), "unsupported", false],
    [state("stopped", "session-ended"), "ended", false],
    [state("stopped", "projection-ended"), "projection-ended", false],
    [state("failed", "permission-required"), "projection-permission", false],
    [state("failed", "encoder-failed"), "display-failed", false],
    [{ ...state("live"), connection: "closed" as const, closeCode: 1000 }, "ended", false],
    [{ ...state("starting"), connection: "closed" as const, closeCode: 1000 }, "ended", false],
    [
      { ...state("unsupported"), connection: "closed" as const, closeCode: 1000 },
      "unsupported",
      false,
    ],
    [{ ...state("live"), connection: "closed" as const, closeCode: 4003 }, "ended", false],
    [{ ...state("live"), connection: "closed" as const, closeCode: 4002 }, "display-failed", false],
    [{ ...state("live"), connection: "closed" as const, closeCode: 1009 }, "display-failed", false],
    [{ ...state("live"), keyframeFailed: true }, "display-failed", false],
  ] as const)("maps %j to the shared Watch reason", (snapshot, reason, retrying) => {
    expect(computerDisplayStatus(snapshot)).toEqual({ reason, retrying });
  });

  it("scopes a stream to the reader, Deployment and a phone that streams", () => {
    const machine = {
      id: "rnr_1",
      status: "online",
      computerUse: {
        displayStreamSupported: true,
        sessions: [{ sessionId, display: true, apps: [] }],
      },
    };
    const snapshot = {
      connection: "connected",
      deploymentId: "dep_1",
      machines: [machine],
      session: "authenticated",
      user: { id: "usr_1" },
    } as unknown as HostSnapshot;
    expect(computerDisplayScope(snapshot, source)).toBe(
      JSON.stringify(["dep_1", "usr_1", "rnr_1", "main", "task-session", sessionId, null]),
    );
    const without = (patch: object) =>
      computerDisplayScope({ ...snapshot, ...patch } as HostSnapshot, source);
    // A realtime reconnect keeps the display socket it does not own.
    expect(without({ connection: "connecting" })).toBe(computerDisplayScope(snapshot, source));
    expect(without({ session: "authentication-required" })).toBeNull();
    expect(without({ machines: [{ ...machine, status: "offline" }] })).toBeNull();
    expect(
      without({
        machines: [
          { ...machine, computerUse: { ...machine.computerUse, displayStreamSupported: false } },
        ],
      }),
    ).toBeNull();
    expect(
      computerDisplayScope(snapshot, {
        kind: "task-session",
        sessionId: "cus_99999999-9999-4999-8999-999999999999",
      }),
    ).toBeNull();
  });
});

// Editing adapter failures: sequence races, stale scope, late clipboard, bounded paste,
// unsupported cut/composition, producer refusals and pending work left by disconnect.
describe("display editing receipt adapter", () => {
  async function editingFixture() {
    const { DisplayEditingSession } = await import("./display-editing.js");
    const lease = streams.retain({ ...target, editing: 1 });
    const socket = opened();
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      editingVersion: 1,
      sharedInput: 1,
    });
    const editing = new DisplayEditingSession(lease);
    editing.setGeometry(1);
    hold(socket);
    return { lease, socket, editing };
  }
  it("paces continuous batches by receipts and settles merged callers together", async () => {
    const { socket, editing } = await editingFixture();
    const first = editing.input(1, [pointer(0.1)]);
    const second = editing.input(1, [pointer(0.2)]);
    const third = editing.input(1, [pointer(0.9)]);
    expect(socket.messages("display.input")).toHaveLength(1);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    await first;
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
      [pointer(0.1)],
      [pointer(0.9)],
    ]);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    await Promise.all([second, third]);
    editing.dispose();
  });
  it("flushes held movement before an immediate press and proxy edit", async () => {
    const { socket, editing } = await editingFixture();
    const calls = [editing.input(1, [pointer(0.1)]), editing.input(1, [pointer(0.7)])];
    expect(socket.messages("display.input")).toHaveLength(1);
    const press = { kind: "pointer", phase: "down", x: 0.7, y: 0.5, t: 2 } as const;
    calls.push(editing.input(1, [press]));
    calls.push(editing.input(1, [pointer(0.8)]));
    calls.push(editing.send({ kind: "copy" }));
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
      [pointer(0.1)],
      [pointer(0.7)],
      [press],
      [pointer(0.8)],
      [{ kind: "copy" }],
    ]);
    for (let sequence = 0; sequence < 5; sequence++)
      socket.json({ type: "display.input.result", sequence, outcome: "dispatched" });
    socket.json({ type: "display.clipboard", sequence: 4, outcome: "empty" });
    await Promise.all(calls);
    editing.dispose();
  });
  it.each(["scope", "geometry", "dispose"] as const)(
    "drops held movement on %s cancellation without a receipt",
    async (cancel) => {
      const { socket, editing } = await editingFixture();
      const first = editing.input(1, [pointer(0.1)]);
      const held = editing.input(1, [pointer(0.8)]);
      const rejected = [
        expect(first).rejects.toThrow("changed"),
        expect(held).rejects.toThrow("changed"),
      ];
      expect(socket.messages("display.input")).toHaveLength(1);
      if (cancel === "dispose") editing.dispose();
      else if (cancel === "geometry") editing.setGeometry(null);
      else
        socket.json({
          type: "display.state",
          state: "live",
          generation: 2,
          width: 720,
          height: 1280,
          editingVersion: 1,
          sharedInput: 1,
        });
      await Promise.all(rejected);
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      expect(socket.messages("display.input")).toHaveLength(1);
      expect(editing.getSnapshot().receipt).toBeNull();
      editing.dispose();
    },
  );
  it.each(["refused", "stale", "timeout"] as const)(
    "releases held movement after an outstanding batch is %s",
    async (outcome) => {
      const { socket, editing } = await editingFixture();
      const first = editing.input(1, [pointer(0.1)]);
      const rejected = expect(first).rejects.toThrow();
      const held = editing.input(1, [pointer(0.8)]);
      expect(socket.messages("display.input")).toHaveLength(1);
      if (outcome === "timeout") vi.advanceTimersByTime(10000);
      else
        socket.json({ type: "display.input.result", sequence: 0, outcome, reason: "unavailable" });
      await rejected;
      expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
        [pointer(0.1)],
        [pointer(0.8)],
      ]);
      socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
      await held;
      editing.dispose();
    },
  );
  it("keeps the whole held wheel turn and drains a long held run one batch per receipt", async () => {
    const { socket, editing } = await editingFixture();
    const scroll = (dy: number) => ({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy }) as const;
    const calls = [editing.input(1, [pointer(0.1)])];
    for (let turn = 0; turn < 3; turn++) calls.push(editing.input(1, [scroll(0.5)]));
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input")[1]?.events).toEqual([scroll(1), scroll(0.5)]);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    await Promise.all(calls);
    // Movement and wheel turns that alternate cannot merge; a run of them still goes
    // one wire batch per answer, not all at once into the producer's short lane.
    const run = [editing.input(1, [pointer(0.1)])];
    for (let index = 0; index < 50; index++)
      run.push(editing.input(1, [pointer(index / 100)]), editing.input(1, [scroll(0.01)]));
    const sizes = () =>
      socket
        .messages("display.input")
        .slice(2)
        .map((batch) => (batch.events as unknown[]).length);
    expect(sizes()).toEqual([1]);
    for (const [sequence, expected] of [
      [2, [1, 64]],
      [3, [1, 64, 36]],
    ] as const) {
      socket.json({ type: "display.input.result", sequence, outcome: "dispatched" });
      expect(sizes()).toEqual(expected);
    }
    socket.json({ type: "display.input.result", sequence: 4, outcome: "dispatched" });
    await Promise.all(run);
    editing.dispose();
  });
  it("waits for the last outstanding receipt before releasing held movement", async () => {
    const { socket, editing } = await editingFixture();
    const calls = [
      editing.input(1, [pointer(0.1)]),
      editing.input(1, [{ kind: "nav", to: "back" }]),
      editing.input(1, [pointer(0.8)]),
    ];
    expect(socket.messages("display.input")).toHaveLength(2);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(2);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(3);
    socket.json({ type: "display.input.result", sequence: 2, outcome: "dispatched" });
    await Promise.all(calls);
    editing.dispose();
  });
  it("correlates copy by actual batch sequence and never accepts unsolicited clipboard", async () => {
    const { socket, editing } = await editingFixture();
    const pending = editing.send({ kind: "copy" });
    socket.json({ type: "display.clipboard", sequence: 900, outcome: "copied", text: "wrong" });
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    socket.json({ type: "display.clipboard", sequence: 0, outcome: "copied", text: "right" });
    expect(await pending).toEqual({
      outcome: "copied",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode("right") }],
    });
    expect(editing.diagnostics.clipboard).toEqual({ copied: 1 });
    editing.dispose();
  });
  it("rejects pending work on geometry/connection loss and discards old context", async () => {
    const { socket, editing } = await editingFixture();
    socket.json({
      type: "display.editing",
      generation: 1,
      context: { contextId: "00000000-0000-4000-8000-000000000001", field: null, caret: null },
    });
    expect(editing.getSnapshot().context?.contextId).toBe("00000000-0000-4000-8000-000000000001");
    const pending = editing.send({ kind: "copy" });
    const rejected = expect(pending).rejects.toThrow("changed");
    socket.json({
      type: "display.state",
      state: "live",
      generation: 2,
      width: 720,
      height: 1280,
      editingVersion: 1,
      sharedInput: 1,
    });
    await rejected;
    expect(editing.getSnapshot().context).toBeNull();
    socket.json({
      type: "display.editing",
      generation: 1,
      context: { contextId: "00000000-0000-4000-8000-000000000002", field: null, caret: null },
    });
    expect(editing.getSnapshot().context).toBeNull();
    editing.dispose();
  });
  it("chunks long plain paste without splitting a surrogate and waits for every receipt", async () => {
    const { socket, editing } = await editingFixture();
    const text = "x".repeat(29999) + "🦊" + "\u0001".repeat(30001);
    const pending = editing.send({
      kind: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    const batches = socket.messages("display.input");
    const pieces = batches.flatMap((message) =>
      (message.events as { text: string }[]).map((event) => event.text),
    );
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((piece) => piece.length <= 30000 && !/[\uD800-\uDBFF]$/u.test(piece))).toBe(
      true,
    );
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
        256 * 1024,
      );
      socket.json({
        type: "display.input.result",
        sequence: batch.sequence,
        outcome: "dispatched",
      });
    }
    expect(await pending).toBeUndefined();
    editing.dispose();
  });
  it("forwards rich metadata but refuses cut/compose without inventing a native edit", async () => {
    const { socket, editing } = await editingFixture();
    await expect(editing.send({ kind: "cut" })).rejects.toThrow("Cut");
    await expect(
      editing.send({
        kind: "compose",
        composition: { contextId: "field", text: "preedit", selectionStart: 0, selectionEnd: 7 },
      }),
    ).rejects.toThrow("composition");
    const pending = editing.send({
      kind: "paste",
      items: [{ type: "text/html", bytes: new TextEncoder().encode("<b>x</b>") }],
    });
    expect(socket.messages("display.input").flatMap((message) => message.events)).toEqual([
      { kind: "paste", items: [{ type: "text/html", size: 8 }] },
    ]);
    const rejected = expect(pending).rejects.toThrow("support");
    socket.json({
      type: "display.input.result",
      sequence: 0,
      outcome: "refused",
      reason: "unsupported",
    });
    await rejected;
    expect(editing.getSnapshot().receipt).toBe("This device doesn’t support this edit.");
    expect(JSON.stringify(editing.diagnostics)).not.toContain("<b>");
    editing.dispose();
  });
  it("times out unanswered copy and clears its timer when disposed", async () => {
    const { editing } = await editingFixture();
    const pending = editing.send({ kind: "copy" });
    const rejected = expect(pending).rejects.toThrow("respond");
    vi.advanceTimersByTime(10000);
    await rejected;
    editing.dispose();
  });
});
