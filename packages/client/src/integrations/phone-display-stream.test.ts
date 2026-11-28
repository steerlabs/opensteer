import { DeviceIdSchema } from "@opensteer/core";
import { OwnerViewRecords } from "../host/owner-view-records.js";
import { TabViewers } from "../host/tab-viewers.js";
import { setPhoneUseAccess } from "./computer-use.js";
import { mockIphoneScreenDevice, mockIphoneScreenSource } from "../mock/mock-screen-devices.js";
import { scopedPersonalApiVersion } from "@opensteer/protocol/personal-sync";
import type { NativeViewerSource } from "../host/surfaces.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseSessionIdSchema,
  DisplayClientDiagnosticSchema,
  displayRefreshCoalescingMs,
  encodeDisplayViewerFrame,
  type DisplayInputEvent,
  type DisplayViewerFrameHeader,
} from "@opensteer/protocol";
import { HttpHostClient, type WebSocketClient } from "../host/host-session-client.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPhoneDisplaySocket } from "../mock/mock-phone-display.js";
import type { HostSnapshot } from "../host/client.js";
import {
  DisplayStreams,
  sharedDisplayStreams,
  computerDisplayScope,
  computerDisplayAuthorityKey,
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
 * - A view joining an open stream waits for the screen to change before it
 *   has a picture.
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

  it("records each change of the display's state and reason once, with no picture data", () => {
    const diagnostic = vi.fn();
    streams = new DisplayStreams({ connect, diagnostic });
    const lease = streams.retain(target);
    const socket = sockets.at(-1)!;
    socket.open();
    const state = (name: string, reason?: string) =>
      socket.json({
        type: "display.state",
        state: name,
        ...(reason ? { reason } : {}),
        generation: 1,
        width: 0,
        height: 0,
      });
    state("starting");
    state("protected", "target-unavailable");
    state("protected", "target-unavailable");
    state("live");
    socket.frame({ sequence: 1, key: true });
    state("protected", "target-unavailable");
    const lines = diagnostic.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => record.transition === "display-state");
    const line = (fields: Record<string, unknown>) => ({
      transition: "display-state",
      connection: expect.any(Number),
      kind: "task-session",
      sessionId,
      ...fields,
    });
    expect(lines).toEqual([
      line({ displayState: "starting", framed: false }),
      line({ displayState: "protected", displayReason: "target-unavailable", framed: false }),
      line({ displayState: "live", framed: false }),
      line({ displayState: "protected", displayReason: "target-unavailable", framed: true }),
    ]);
    // Each is a line the Desktop accepts as it is, and carries no picture or address.
    for (const entry of lines) expect(DisplayClientDiagnosticSchema.parse(entry)).toEqual(entry);
    expect(JSON.stringify(lines)).not.toContain("scope-a");
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
      `wss://host.example/v1/computer-use/sessions/${sessionId}/display?opensteer_api_version=${scopedPersonalApiVersion}&sharedInput=1&phoneOwnerControl=1&displayWindow=1`,
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

  it("asks for a keyframe when a view joins an open stream, which sends a still screen no frames", () => {
    const first = streams.retain(target);
    const socket = opened();
    socket.frame({ sequence: 1, key: true });
    expect(socket.messages("display.keyframe")).toEqual([]);
    const second = streams.retain(target);
    expect(socket.messages("display.keyframe")).toEqual([{ type: "display.keyframe" }]);
    second.release();
    first.release();
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
      power: "unavailable",
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
    const contextId = "00000000-0000-4000-8000-000000000001";
    const lease = streams.retain({ ...target, editing: 1 });
    const socket = opened();
    expect(lease.input(1, [{ kind: "copy", contextId }])).toBe(false);
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
      lease.input(1, [
        {
          kind: "paste",
          text: "\u0001".repeat(20000),
          contextId,
        },
        { kind: "copy", contextId },
      ]),
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
    expect(
      first.input(1, [{ kind: "copy", contextId: "00000000-0000-4000-8000-000000000001" }]),
    ).toBe(false);
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
    power: "unavailable",
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
    [state("protected", "target-unavailable"), "target-unavailable", false],
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
  let editingScope = 0;
  async function editingFixture() {
    const { DisplayEditingSession } = await import("./display-editing.js");
    const lease = streams.retain({ ...target, scope: `editing-${++editingScope}`, editing: 1 });
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
  const shift = (action: "down" | "up"): DisplayInputEvent => ({
    kind: "key",
    action,
    code: "ShiftLeft",
    key: "Shift",
    modifiers: action === "down" ? ["shift"] : [],
  });

  it("resets after timing out a balanced batch that holds no keys", async () => {
    const { socket, editing } = await editingFixture();
    const sent = editing.input(1, [shift("down"), shift("up")]);
    const stop = expect(sent).rejects.toMatchObject({ name: "DisplayEditingStopped" });
    expect(socket.messages("display.input")).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    await stop;
    expect(socket.messages("display.input-reset")).toHaveLength(1);
    editing.dispose();
  });

  it("resets a sent batch when a live socket loses input availability", async () => {
    const { socket, editing } = await editingFixture();
    const sent = editing.input(1, [shift("down"), shift("up")]);
    const stopped = expect(sent).rejects.toMatchObject({ name: "DisplayEditingStopped" });
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      editingVersion: 1,
    });
    await stopped;
    expect(socket.messages("display.input-reset")).toHaveLength(1);
    editing.dispose();
  });

  it("resets after a refused release even though the held set already dropped the key", async () => {
    const { socket, editing } = await editingFixture();
    const down = editing.input(1, [shift("down")]);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    await down;
    const up = editing.input(1, [shift("up")]);
    const refused = expect(up).rejects.toMatchObject({ name: "DisplayEditingRefusal" });
    socket.json({
      type: "display.input.result",
      sequence: 1,
      outcome: "refused",
      reason: "unavailable",
    });
    await refused;
    expect(socket.messages("display.input-reset")).toHaveLength(1);
    editing.dispose();
  });

  it.each(["atomic channel drop", "single unknown"] as const)(
    "stops with an unknown outcome after a sent %s",
    async (kind) => {
      const { socket, editing } = await editingFixture();
      const edit = {
        kind: "edit" as const,
        edit: {
          contextId: "00000000-0000-4000-8000-000000000001",
          before: "",
          after: "",
          text: "a",
        },
      };
      const sent =
        kind === "atomic channel drop" ? editing.sendBatch([edit, edit]) : editing.send(edit);
      const stopped = expect(sent).rejects.toMatchObject({
        name: "DisplayEditingStopped",
        message: "Typing stopped. Some of it may not have arrived: check the text.",
      });
      expect(socket.messages("display.input")).toHaveLength(1);
      if (kind === "atomic channel drop") socket.drop();
      else socket.json({ type: "display.input.result", sequence: 0, outcome: "unknown" });
      await stopped;
      expect(editing.getSnapshot().receipt).toBe(
        "Typing stopped. Some of it may not have arrived: check the text.",
      );
      editing.dispose();
    },
  );

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
  it("keeps held movement in order before a press and proxy copy while pacing by receipts", async () => {
    const { socket, editing } = await editingFixture();
    const calls = [editing.input(1, [pointer(0.1)]), editing.input(1, [pointer(0.7)])];
    expect(socket.messages("display.input")).toHaveLength(1);
    const press = { kind: "pointer", phase: "down", x: 0.7, y: 0.5, t: 2 } as const;
    calls.push(editing.input(1, [press]));
    calls.push(editing.input(1, [pointer(0.8)]));
    const contextId = "00000000-0000-4000-8000-000000000001";
    calls.push(editing.send({ kind: "copy", contextId }));
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([[pointer(0.1)]]);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
      [pointer(0.1)],
      [pointer(0.7), press, pointer(0.8)],
    ]);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
      [pointer(0.1)],
      [pointer(0.7), press, pointer(0.8)],
      [{ kind: "copy", contextId }],
    ]);
    socket.json({ type: "display.input.result", sequence: 2, outcome: "dispatched" });
    socket.json({ type: "display.clipboard", sequence: 2, outcome: "empty" });
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
  it("waits for the outstanding receipt before releasing queued nav and movement in order", async () => {
    const { socket, editing } = await editingFixture();
    const calls = [
      editing.input(1, [pointer(0.1)]),
      editing.input(1, [{ kind: "nav", to: "back" }]),
      editing.input(1, [pointer(0.8)]),
    ];
    expect(socket.messages("display.input")).toHaveLength(1);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input").map((batch) => batch.events)).toEqual([
      [pointer(0.1)],
      [{ kind: "nav", to: "back" }, pointer(0.8)],
    ]);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    await Promise.all(calls);
    editing.dispose();
  });
  it("correlates copy by actual batch sequence and never accepts unsolicited clipboard", async () => {
    const { socket, editing } = await editingFixture();
    const pending = editing.send({
      kind: "copy",
      contextId: "00000000-0000-4000-8000-000000000001",
    });
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
    const pending = editing.send({
      kind: "copy",
      contextId: "00000000-0000-4000-8000-000000000001",
    });
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
    const contextId = "00000000-0000-4000-8000-000000000001";
    const text = "x".repeat(29999) + "🦊" + "\u0001".repeat(30001);
    const pending = editing.send({
      kind: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode(text) }],
      contextId,
    });
    let acked = 0;
    while (acked < socket.messages("display.input").length) {
      const batch = socket.messages("display.input")[acked]!;
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
        128 * 1024,
      );
      socket.json({
        type: "display.input.result",
        sequence: batch.sequence,
        outcome: "dispatched",
      });
      acked += 1;
    }
    const batches = socket.messages("display.input");
    const pieces = batches.flatMap((message) =>
      (message.events as { text: string; contextId: string }[]).map((event) => {
        expect(event.contextId).toBe(contextId);
        return event.text;
      }),
    );
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((piece) => piece.length <= 30000 && !/[\uD800-\uDBFF]$/u.test(piece))).toBe(
      true,
    );
    expect(await pending).toBeUndefined();
    editing.dispose();
  });
  it("refuses command, copy and paste without a context", async () => {
    const { socket, editing } = await editingFixture();
    await expect(editing.send({ kind: "command", command: "selectAll" })).rejects.toThrow(
      "changed",
    );
    await expect(editing.send({ kind: "copy" })).rejects.toThrow("changed");
    await expect(
      editing.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: new TextEncoder().encode("hi") }],
      }),
    ).rejects.toThrow("changed");
    expect(socket.messages("display.input")).toEqual([]);
    editing.dispose();
  });
  it("refuses rich paste, cut and compose without inventing a native edit", async () => {
    const { socket, editing } = await editingFixture();
    await expect(editing.send({ kind: "cut" })).rejects.toThrow("Cut");
    await expect(
      editing.send({
        kind: "compose",
        composition: { contextId: "field", text: "preedit", selectionStart: 0, selectionEnd: 7 },
      }),
    ).rejects.toThrow("composition");
    await expect(
      editing.send({
        kind: "paste",
        items: [{ type: "text/html", bytes: new TextEncoder().encode("<b>x</b>") }],
      }),
    ).rejects.toThrow("support");
    expect(socket.messages("display.input")).toEqual([]);
    expect(editing.getSnapshot().receipt).toBe("This device doesn’t support this edit.");
    expect(JSON.stringify(editing.diagnostics)).not.toContain("<b>");
    editing.dispose();
  });
  it("times out unanswered copy and clears its timer when disposed", async () => {
    const { editing } = await editingFixture();
    const pending = editing.send({
      kind: "copy",
      contextId: "00000000-0000-4000-8000-000000000001",
    });
    const rejected = expect(pending).rejects.toThrow("respond");
    vi.advanceTimersByTime(10000);
    await rejected;
    editing.dispose();
  });
  it("sends dependent operations (removal, compensating moves, replacement paste/edit) in one atomic display.input batch and never splits them", async () => {
    const { socket, editing } = await editingFixture();
    const contextId = "00000000-0000-4000-8000-000000000001";
    const batch = editing.sendBatch([
      { kind: "edit", edit: { contextId, before: "world", after: "", text: "" } },
      { kind: "command", command: "moveBackward", contextId, follows: true },
      {
        kind: "paste",
        items: [{ type: "text/plain", bytes: new TextEncoder().encode("there") }],
        contextId,
        follows: true,
      },
    ]);
    const sent = socket.messages("display.input");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      events: [
        { kind: "edit", edit: { contextId, before: "world", after: "", text: "" } },
        { kind: "command", command: "moveBackward", contextId },
        { kind: "paste", text: "there", contextId },
      ],
    });
    socket.json({ type: "display.input.result", sequence: 0, outcome: "stale", reason: "stale" });
    await expect(batch).rejects.toThrow("changed");
    // O1: a dependent group whose trailing paste exceeds one frame sends the deletion atomically
    // first, never sends the paste if the deletion is refused, and chunks the paste once dispatched.
    const huge = "a".repeat(65 * 4096);
    const hugeOp = [
      { kind: "edit" as const, edit: { contextId, before: "world", after: "", text: "" } },
      {
        kind: "paste" as const,
        items: [{ type: "text/plain" as const, bytes: new TextEncoder().encode(huge) }],
        contextId,
        follows: true as const,
      },
    ];
    const staleHuge = editing.sendBatch(hugeOp);
    expect(socket.messages("display.input")).toHaveLength(2);
    expect(socket.messages("display.input")[1]).toMatchObject({
      events: [{ kind: "edit", edit: { contextId, before: "world", after: "", text: "" } }],
    });
    socket.json({ type: "display.input.result", sequence: 1, outcome: "stale", reason: "stale" });
    await expect(staleHuge).rejects.toThrow("changed");
    expect(socket.messages("display.input")).toHaveLength(2);

    const okHuge = editing.sendBatch(hugeOp);
    expect(socket.messages("display.input")).toHaveLength(3);
    socket.json({ type: "display.input.result", sequence: 2, outcome: "dispatched" });
    await Promise.resolve();
    let seq = 3;
    while (seq < socket.messages("display.input").length) {
      socket.json({ type: "display.input.result", sequence: seq, outcome: "dispatched" });
      seq += 1;
    }
    expect(seq).toBeGreaterThan(4);
    await expect(okHuge).resolves.toBeUndefined();

    // Any over-large non-paste dependent group (>64 events) is still refused whole, never split.
    const countBefore = socket.messages("display.input").length;
    await expect(
      editing.sendBatch([
        { kind: "edit", edit: { contextId, before: "world", after: "", text: "" } },
        ...Array.from({ length: 64 }, () => ({
          kind: "command" as const,
          command: "moveBackward" as const,
          contextId,
          follows: true as const,
        })),
      ]),
    ).rejects.toThrow("large");
    expect(socket.messages("display.input")).toHaveLength(countBefore);
    editing.dispose();
  });
  it("reports sent paste and cut as unknown (never Try again) on 10 s timeout and resize, while unsent ones and copies may still say Try again", async () => {
    const contextId = "00000000-0000-4000-8000-000000000001";
    const fieldContext = {
      type: "display.editing" as const,
      generation: 1,
      context: {
        contextId,
        field: { kind: "text" as const, multiline: false, sensitive: false },
        caret: null,
      },
    };
    let scopeIndex = 0;
    async function cutCapableFixture() {
      const { DisplayEditingSession } = await import("./display-editing.js");
      const lease = streams.retain({ ...target, scope: `q1-${++scopeIndex}`, editing: 1 });
      const socket = opened();
      socket.json({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 720,
        height: 1280,
        editingVersion: 1,
        displayCut: 1,
        sharedInput: 1,
      });
      const editing = new DisplayEditingSession(lease);
      editing.setGeometry(1);
      socket.json(fieldContext);
      return { lease, socket, editing };
    }

    // Q1(b): 10 s timeout — sent mutations stop with an unknown outcome.
    // Pure copy keeps its retry wording.
    for (const kind of ["paste", "batch-paste", "cut", "copy"] as const) {
      const { socket, editing } = await cutCapableFixture();
      const op =
        kind === "paste"
          ? editing.send({
              kind: "paste",
              items: [{ type: "text/plain", bytes: new TextEncoder().encode("slow") }],
              contextId,
            })
          : kind === "batch-paste"
            ? editing.sendBatch([
                { kind: "edit", edit: { contextId, before: "x", after: "", text: "" } },
                {
                  kind: "paste",
                  items: [{ type: "text/plain", bytes: new TextEncoder().encode("y") }],
                  contextId,
                  follows: true,
                },
              ])
            : editing.send({ kind, contextId });
      expect(socket.messages("display.input")).toHaveLength(1);
      if (kind === "copy") {
        const copyFailed = expect(op).rejects.toThrow("Try again.");
        vi.advanceTimersByTime(10_000);
        await copyFailed;
      } else {
        const stopped = expect(op).rejects.toMatchObject({
          name: "DisplayEditingStopped",
          message: "Typing stopped. Some of it may not have arrived: check the text.",
        });
        vi.advanceTimersByTime(10_000);
        await stopped;
        expect(editing.getSnapshot().receipt).toBe(
          "Typing stopped. Some of it may not have arrived: check the text.",
        );
      }
      editing.dispose();
    }
    {
      // Paste NOT yet sent when input is refused before leaving client: rejects, not unknown.
      const { socket, editing } = await cutCapableFixture();
      const beforeUnsent = socket.messages("display.input").length;
      socket.json({
        type: "display.state",
        state: "paused",
        generation: 1,
        width: 720,
        height: 1280,
        editingVersion: 1,
        displayCut: 1,
        sharedInput: 1,
      });
      await expect(
        editing.send({
          kind: "paste",
          items: [{ type: "text/plain", bytes: new TextEncoder().encode("unsent") }],
          contextId,
        }),
      ).rejects.toThrow("Try again.");
      expect(socket.messages("display.input")).toHaveLength(beforeUnsent);
      editing.dispose();
    }

    // Q1(c): resize and dispose preserve a sent mutation's unknown outcome.
    // Edits refused before sending after the resize keep their retry wording.
    for (const trigger of ["geometry", "generation", "dispose"] as const) {
      for (const kind of ["paste", "cut", "copy"] as const) {
        const { socket, editing } = await cutCapableFixture();
        const op =
          kind === "paste"
            ? editing.send({
                kind: "paste",
                items: [{ type: "text/plain", bytes: new TextEncoder().encode("in-flight") }],
                contextId,
              })
            : editing.send({ kind, contextId });
        const stopped =
          kind === "copy"
            ? expect(op).rejects.toThrow("The display changed. Try again.")
            : expect(op).rejects.toMatchObject({
                name: "DisplayEditingStopped",
                message: "Typing stopped. Some of it may not have arrived: check the text.",
              });
        expect(socket.messages("display.input")).toHaveLength(1);

        if (trigger === "geometry") editing.setGeometry(null);
        else if (trigger === "dispose") editing.dispose();
        else
          socket.json({
            type: "display.state",
            state: "live",
            generation: 2,
            width: 800,
            height: 1280,
            editingVersion: 1,
            displayCut: 1,
            sharedInput: 1,
          });

        await stopped;
        if (trigger !== "dispose" && kind !== "copy") {
          expect(editing.getSnapshot().receipt).toBe(
            "Typing stopped. Some of it may not have arrived: check the text.",
          );
          // Now attempt a paste NOT yet sent after the resize: must reject with "Try again." and send nothing.
          await expect(
            editing.send({
              kind: "paste",
              items: [{ type: "text/plain", bytes: new TextEncoder().encode("after-resize") }],
              contextId,
            }),
          ).rejects.toThrow("The display changed. Try again.");
          expect(socket.messages("display.input")).toHaveLength(1);
        }
        editing.dispose();
      }
    }
  });
  it("reports a socket error in a non-clipboard atomic group honestly instead of saying too large", async () => {
    const contextId = "00000000-0000-4000-8000-000000000001";
    const { DisplayEditingSession } = await import("./display-editing.js");
    const lease = streams.retain({ ...target, scope: "a4-socket-error", editing: 1 });
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
    const originalSend = socket.send.bind(socket);
    socket.send = (data) => {
      if (
        typeof data === "string" &&
        (JSON.parse(data) as { type: string }).type === "display.input"
      )
        throw new Error("The socket could not confirm the send");
      originalSend(data);
    };
    await expect(
      editing.sendBatch([
        { kind: "edit", edit: { contextId, before: "x", after: "", text: "" } },
        { kind: "command", command: "moveBackward", contextId, follows: true },
      ]),
    ).rejects.toMatchObject({
      name: "DisplayEditingStopped",
      message: "Typing stopped. Some of it may not have arrived: check the text.",
    });
    expect(editing.getSnapshot().receipt).toBe(
      "Typing stopped. Some of it may not have arrived: check the text.",
    );
    expect(socket.messages("display.input-reset")).toHaveLength(1);
    expect(editing.diagnostics.refusals["too-large"]).toBeUndefined();

    // A genuinely over-limit atomic group still reports "This edit is too large.".
    socket.send = originalSend;
    await expect(
      editing.sendBatch([
        { kind: "edit", edit: { contextId, before: "x", after: "", text: "a".repeat(10_000) } },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
        {
          kind: "edit",
          edit: { contextId, before: "", after: "", text: "\u0001".repeat(5_000) },
          follows: true,
        },
      ]),
    ).rejects.toThrow("This edit is too large.");
    expect(editing.diagnostics.refusals["too-large"]).toBe(1);
    editing.dispose();
  });
  it("delivers a 200-character burst whole and in order in few batches against a slow device", async () => {
    const { socket, editing } = await editingFixture();
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const delivered: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string) => {
      originalSend(data);
      const message = JSON.parse(data) as {
        type: string;
        sequence?: number;
        events?: { kind: string; action?: string; text?: string }[];
      };
      if (message.type !== "display.input") return;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      setTimeout(() => {
        for (const event of message.events ?? []) {
          if (event.kind === "key" && event.action === "down" && event.text)
            delivered.push(event.text);
        }
        inFlight -= 1;
        socket.json({
          type: "display.input.result",
          sequence: message.sequence!,
          outcome: "dispatched",
        });
      }, 50);
    };
    const calls: Promise<unknown>[] = [];
    for (const ch of text) {
      const code = `Key${ch.toUpperCase()}`;
      calls.push(
        editing.send({
          kind: "key",
          keystroke: {
            action: "down",
            key: ch,
            code,
            modifiers: [],
            location: 0,
            repeat: false,
            text: ch,
          },
        }),
      );
      calls.push(
        editing.send({
          kind: "key",
          keystroke: { action: "up", key: ch, code, modifiers: [], location: 0, repeat: false },
        }),
      );
    }
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(delivered.join("")).toBe(text);
    expect(peakInFlight).toBe(1);
    expect(socket.messages("display.input").length).toBeLessThanOrEqual(8);
    expect(editing.diagnostics.refusals).toEqual({});
    expect(editing.getSnapshot().receipt).toBeNull();
    editing.dispose();
  });
  it("packs queued edits and pastes in order without merging separate edits or pastes, and sends a 200-character paste in one batch", async () => {
    const { socket, editing } = await editingFixture();
    const contextId = "00000000-0000-4000-8000-000000000001";
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const editCalls = [...text].map((ch) =>
      editing.send({ kind: "edit", edit: { contextId, text: ch, before: "", after: "" } }),
    );
    expect(socket.messages("display.input")).toHaveLength(1);
    let acked = 0;
    while (acked < socket.messages("display.input").length) {
      socket.json({ type: "display.input.result", sequence: acked, outcome: "dispatched" });
      acked += 1;
    }
    await Promise.all(editCalls);
    // 200 separate edit events packed into 5 wire batches (1 + 64 + 64 + 64 + 7), never merged.
    const editBatches = socket.messages("display.input");
    expect(editBatches).toHaveLength(5);
    const editEvents = editBatches.flatMap(
      (b) => b.events as { kind: string; edit: { text: string } }[],
    );
    expect(editEvents).toHaveLength(200);
    expect(editEvents.map((e) => e.edit.text).join("")).toBe(text);

    // Two queued pastes stay distinct events (separate undo units); a 200-char paste is one batch.
    const paste1 = editing.send({
      kind: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode("first") }],
      contextId,
    });
    const paste2 = editing.send({
      kind: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode("second") }],
      contextId,
    });
    const paste3 = editing.send({
      kind: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode(text) }],
      contextId,
    });
    const beforePasteSeq = acked;
    while (acked < socket.messages("display.input").length) {
      socket.json({ type: "display.input.result", sequence: acked, outcome: "dispatched" });
      acked += 1;
    }
    await Promise.all([paste1, paste2, paste3]);
    const pasteBatches = socket.messages("display.input").slice(beforePasteSeq);
    expect(pasteBatches.map((b) => b.events)).toEqual([
      [{ kind: "paste", text: "first", contextId }],
      [
        { kind: "paste", text: "second", contextId },
        { kind: "paste", text, contextId },
      ],
    ]);
    editing.dispose();
  });
  it("stops on a lost answer mid-burst with a plain stop notice and sends nothing again", async () => {
    const { socket, editing } = await editingFixture();
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const calls: Promise<unknown>[] = [];
    for (const ch of text) {
      const code = `Key${ch.toUpperCase()}`;
      calls.push(
        editing.send({
          kind: "key",
          keystroke: {
            action: "down",
            key: ch,
            code,
            modifiers: [],
            location: 0,
            repeat: false,
            text: ch,
          },
        }),
      );
      calls.push(
        editing.send({
          kind: "key",
          keystroke: { action: "up", key: ch, code, modifiers: [], location: 0, repeat: false },
        }),
      );
    }
    const settled = Promise.allSettled(calls);
    // Answer batch 0 and batch 1, then drop batch 2's answer.
    expect(socket.messages("display.input")).toHaveLength(1);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(2);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(3);
    const batchCountAtLoss = socket.messages("display.input").length;
    vi.advanceTimersByTime(10_000);
    const results = await settled;
    // Nothing resent and nothing from the queued tail ever leaves.
    expect(socket.messages("display.input")).toHaveLength(batchCountAtLoss);
    // A late answer for the timed-out batch must not resume sending.
    socket.json({ type: "display.input.result", sequence: 2, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(batchCountAtLoss);
    const receipt = editing.getSnapshot().receipt;
    expect(receipt).toBe("Typing stopped. Some of it may not have arrived: check the text.");
    expect(receipt).not.toContain("Try again");
    const rejections = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0]!.reason).toMatchObject({
      name: "DisplayEditingStopped",
      message: "Typing stopped. Some of it may not have arrived: check the text.",
    });
    expect("delivered" in (rejections[0]!.reason as object)).toBe(false);
    editing.dispose();
  });
  it("stops on a device refusal mid-burst with a plain stop notice and sends nothing after it", async () => {
    const { socket, editing } = await editingFixture();
    const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const calls: Promise<unknown>[] = [];
    for (const ch of text) {
      const code = `Key${ch.toUpperCase()}`;
      calls.push(
        editing.send({
          kind: "key",
          keystroke: {
            action: "down",
            key: ch,
            code,
            modifiers: [],
            location: 0,
            repeat: false,
            text: ch,
          },
        }),
      );
      calls.push(
        editing.send({
          kind: "key",
          keystroke: { action: "up", key: ch, code, modifiers: [], location: 0, repeat: false },
        }),
      );
    }
    const settled = Promise.allSettled(calls);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    socket.json({ type: "display.input.result", sequence: 1, outcome: "stale", reason: "stale" });
    const results = await settled;
    expect(socket.messages("display.input")).toHaveLength(2);
    expect(editing.getSnapshot().receipt).toBe(
      "Typing stopped. Some of it may not have arrived: check the text.",
    );
    expect(editing.getSnapshot().receipt).not.toContain("Try again");
    const rejections = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejections[0]!.reason).toMatchObject({
      name: "DisplayEditingStopped",
      message: "Typing stopped. Some of it may not have arrived: check the text.",
    });
    editing.dispose();
  });
  it("keeps non-text keys (Tab, Enter, arrows, shortcuts) in exact order among typed text", async () => {
    const { socket, editing } = await editingFixture();
    const contextId = "00000000-0000-4000-8000-000000000001";
    const key = (
      action: "down" | "up",
      name: string,
      code: string,
      extra: { text?: string; modifiers?: ("primary" | "shift")[] } = {},
    ) =>
      editing.send({
        kind: "key",
        keystroke: {
          action,
          key: name,
          code,
          modifiers: extra.modifiers ?? [],
          location: 0,
          repeat: false,
          ...(extra.text !== undefined ? { text: extra.text } : {}),
        },
      });
    const calls: Promise<unknown>[] = [];
    for (const ch of "hi") {
      calls.push(key("down", ch, `Key${ch.toUpperCase()}`, { text: ch }));
      calls.push(key("up", ch, `Key${ch.toUpperCase()}`));
    }
    calls.push(key("down", "Tab", "Tab"), key("up", "Tab", "Tab"));
    for (const ch of "ok") {
      calls.push(key("down", ch, `Key${ch.toUpperCase()}`, { text: ch }));
      calls.push(key("up", ch, `Key${ch.toUpperCase()}`));
    }
    calls.push(key("down", "Enter", "Enter"), key("up", "Enter", "Enter"));
    calls.push(key("down", "ArrowLeft", "ArrowLeft"), key("up", "ArrowLeft", "ArrowLeft"));
    calls.push(editing.send({ kind: "command", command: "selectAll", contextId }));
    calls.push(key("down", "!", "Digit1", { text: "!", modifiers: ["shift"] }));
    calls.push(key("up", "!", "Digit1", { modifiers: ["shift"] }));

    expect(socket.messages("display.input")).toHaveLength(1);
    let acked = 0;
    while (acked < socket.messages("display.input").length) {
      socket.json({ type: "display.input.result", sequence: acked, outcome: "dispatched" });
      acked += 1;
    }
    await Promise.all(calls);
    const batches = socket.messages("display.input");
    expect(batches).toHaveLength(2);
    const summary = batches.flatMap((batch) =>
      (batch.events as { kind: string; action?: string; key?: string; command?: string }[]).map(
        (event) =>
          event.kind === "key" ? `${event.key}:${event.action}` : `${event.kind}:${event.command}`,
      ),
    );
    expect(summary).toEqual([
      "h:down",
      "h:up",
      "i:down",
      "i:up",
      "Tab:down",
      "Tab:up",
      "o:down",
      "o:up",
      "k:down",
      "k:up",
      "Enter:down",
      "Enter:up",
      "ArrowLeft:down",
      "ArrowLeft:up",
      "command:selectAll",
      "!:down",
      "!:up",
    ]);
    editing.dispose();
  });
  it("releases held Shift and mouse drag on timeout, layout change, and dispose even when releases sit behind queued edits", async () => {
    const contextId = "00000000-0000-4000-8000-000000000001";
    const shift = (action: "down" | "up") => ({
      kind: "key" as const,
      keystroke: {
        action,
        key: "Shift",
        code: "ShiftLeft",
        modifiers: action === "down" ? (["shift"] as "shift"[]) : [],
        location: 1 as const,
        repeat: false,
      },
    });
    const edit = (text: string) => ({
      kind: "edit" as const,
      edit: { contextId, text, before: "", after: "" },
    });

    // (1) Timeout: Shift-down acked, edit "a" receipt withheld, edit "b" + Shift-up queued.
    {
      const { socket, editing } = await editingFixture();
      const sDown = editing.send(shift("down"));
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      await sDown;
      const pendingEdit = editing.send(edit("a"));
      const queuedEdit = editing.send(edit("b"));
      const queuedUp = editing.send(shift("up"));
      const settled = Promise.allSettled([pendingEdit, queuedEdit, queuedUp]);
      vi.advanceTimersByTime(10_000);
      await settled;
      const sentEvents = socket.messages("display.input").flatMap((m) => m.events as unknown[]);
      expect(sentEvents).toContainEqual(
        expect.objectContaining({ kind: "key", action: "up", code: "ShiftLeft" }),
      );
      expect(sentEvents).not.toContainEqual(edit("b"));
      expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
      const countAfterStop = socket.messages("display.input").length;
      socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
      expect(socket.messages("display.input")).toHaveLength(countAfterStop);
      expect(editing.getSnapshot().receipt).toBe(
        "Typing stopped. Some of it may not have arrived: check the text.",
      );
      editing.dispose();
    }

    // (2) Timeout during mouse drag: mouse-down acked, move withheld, mouse-up queued -> no stuck drag.
    {
      const { socket, editing } = await editingFixture();
      const mDown = editing.input(1, [
        { kind: "mouse", phase: "down", button: "left", x: 0.2, y: 0.2, modifiers: [] },
      ]);
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      await mDown;
      const mMove = editing.input(1, [
        { kind: "mouse", phase: "move", button: "left", x: 0.5, y: 0.5, modifiers: [] },
      ]);
      const mUp = editing.input(1, [
        { kind: "mouse", phase: "up", button: "left", x: 0.5, y: 0.5, modifiers: [] },
      ]);
      const settled = Promise.allSettled([mMove, mUp]);
      vi.advanceTimersByTime(10_000);
      await settled;
      const sentEvents = socket.messages("display.input").flatMap((m) => m.events as unknown[]);
      expect(sentEvents).toContainEqual(
        expect.objectContaining({ kind: "mouse", phase: "up", button: "left" }),
      );
      expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
      editing.dispose();
    }

    // (3) Layout/geometry change with Shift held & pending/queued edits -> sends reset, drops queue.
    {
      const { socket, editing } = await editingFixture();
      const sDown = editing.send(shift("down"));
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      await sDown;
      const pendingEdit = editing.send(edit("a"));
      const queuedEdit = editing.send(edit("b"));
      const settled = Promise.allSettled([pendingEdit, queuedEdit]);
      editing.setGeometry(null);
      await settled;
      expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
      const countAfterStop = socket.messages("display.input").length;
      socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
      expect(socket.messages("display.input")).toHaveLength(countAfterStop);
      editing.dispose();
    }

    // (4) Dispose with Shift-up queued behind an ordinary edit -> still sends Shift-up + reset, drops edit.
    {
      const { socket, editing } = await editingFixture();
      const sDown = editing.send(shift("down"));
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      await sDown;
      const pendingEdit = editing.send(edit("a"));
      const queuedEdit = editing.send(edit("b"));
      const queuedUp = editing.send(shift("up"));
      const settled = Promise.allSettled([pendingEdit, queuedEdit, queuedUp]);
      editing.dispose();
      await settled;
      const sentEvents = socket.messages("display.input").flatMap((m) => m.events as unknown[]);
      expect(sentEvents).toContainEqual(
        expect.objectContaining({ kind: "key", action: "up", code: "ShiftLeft" }),
      );
      expect(sentEvents).not.toContainEqual(edit("b"));
      expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
    }
  });
  it("charges queue bounds before enqueueing, never retains superseded move callers, and stops on overflow", async () => {
    const contextId = "00000000-0000-4000-8000-000000000001";

    // (1) 9,000 coalesced moves retain only the latest caller; superseded callers settle immediately.
    {
      const { socket, editing } = await editingFixture();
      const first = editing.input(1, [pointer(0.1)]);
      const moves: Promise<unknown>[] = [];
      for (let i = 0; i < 9_000; i++) moves.push(editing.input(1, [pointer((i % 100) / 100)]));
      // Cancel batch 0: superseded moves already settled, so only the final move rejects.
      const settled = Promise.allSettled([first, ...moves]);
      editing.setGeometry(null);
      const results = await settled;
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(2); // `first` + the single latest coalesced move
      expect(socket.messages("display.input")).toHaveLength(1);
      editing.dispose();
    }

    // (2) 8,193rd queued keydown takes the stop path: backlog is dropped (never drains) and holds reset.
    {
      const { socket, editing } = await editingFixture();
      const sDown = editing.send({
        kind: "key",
        keystroke: {
          action: "down",
          key: "Shift",
          code: "ShiftLeft",
          modifiers: ["shift"],
          location: 1,
          repeat: false,
        },
      });
      socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
      await sDown;
      const calls: Promise<unknown>[] = [];
      // 1 in-flight + 8,192 queued + 1 overflow (8,193rd queued)
      for (let i = 0; i < 8_194; i++) {
        calls.push(
          editing.send({
            kind: "key",
            keystroke: {
              action: "down",
              key: "a",
              code: "KeyA",
              modifiers: [],
              location: 0,
              repeat: false,
              text: "a",
            },
          }),
        );
      }
      const results = await Promise.allSettled(calls);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect((results.at(-1) as PromiseRejectedResult).reason).toMatchObject({
        name: "DisplayEditingStopped",
        message: "Typing stopped. Some of it may not have arrived: check the text.",
      });
      expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
      const batchesAtStop = socket.messages("display.input").length;
      expect(batchesAtStop).toBe(2); // Shift-down + first keydown only; backlog never drained
      // A late receipt for batch 1 must NOT drain the dropped 8,192-event backlog.
      socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
      expect(socket.messages("display.input")).toHaveLength(batchesAtStop);
      editing.dispose();
    }

    // (3) First oversized paste (> 2 MiB) is charged before enqueueing and never leaves the client.
    {
      const { socket, editing } = await editingFixture();
      const huge = "a".repeat(2 * 1024 * 1024 + 1024);
      await expect(
        editing.send({
          kind: "paste",
          items: [{ type: "text/plain", bytes: new TextEncoder().encode(huge) }],
          contextId,
        }),
      ).rejects.toMatchObject({
        name: "DisplayEditingStopped",
        message: "Typing stopped. Some of it may not have arrived: check the text.",
      });
      expect(socket.messages("display.input")).toHaveLength(0);
      editing.dispose();
    }
  });
  it("packs batches to the Mac helper 128 KiB limit and splits escaped pastes by UTF-8 size", async () => {
    const { socket, editing } = await editingFixture();
    const contextId = "00000000-0000-4000-8000-000000000001";
    const plain200KiB = "p".repeat(200 * 1024);
    const escapedControl = "\u0001".repeat(30_000); // 30k chars but 180k JSON bytes!
    for (const payload of [plain200KiB, escapedControl]) {
      const start = socket.messages("display.input").length;
      const done = editing.send({
        kind: "paste",
        items: [{ type: "text/plain", bytes: new TextEncoder().encode(payload) }],
        contextId,
      });
      let acked = start;
      while (acked < socket.messages("display.input").length) {
        const batch = socket.messages("display.input")[acked]!;
        expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
          128 * 1024,
        );
        socket.json({
          type: "display.input.result",
          sequence: batch.sequence,
          outcome: "dispatched",
        });
        acked += 1;
      }
      await done;
      const sent = socket.messages("display.input").slice(start);
      expect(sent.length).toBeGreaterThan(1);
      const reassembled = sent
        .flatMap((batch) => (batch.events as { text: string }[]).map((e) => e.text))
        .join("");
      expect(reassembled).toBe(payload);
    }
    editing.dispose();
  });

  it("keeps mouse-up separate from queued keys even when a scroll sits between them", async () => {
    const { socket, editing } = await editingFixture();
    const down = editing.input(1, [
      {
        kind: "mouse",
        phase: "down",
        button: "left",
        clickCount: 1,
        modifiers: [],
        x: 0.2,
        y: 0.2,
      },
    ]);
    const up = editing.input(1, [
      { kind: "mouse", phase: "up", button: "left", clickCount: 1, modifiers: [], x: 0.2, y: 0.2 },
    ]);
    const scroll = editing.input(1, [{ kind: "scroll", x: 0.2, y: 0.2, dx: 0, dy: 0.1 }]);
    const keyDown = editing.send({
      kind: "key",
      keystroke: {
        action: "down",
        key: "a",
        code: "KeyA",
        modifiers: [],
        location: 0,
        repeat: false,
        text: "a",
      },
    });
    const keyUp = editing.send({
      kind: "key",
      keystroke: {
        action: "up",
        key: "a",
        code: "KeyA",
        modifiers: [],
        location: 0,
        repeat: false,
      },
    });

    expect(socket.messages("display.input")).toHaveLength(1);
    expect(socket.messages("display.input")[0]!.events).toEqual([
      expect.objectContaining({ kind: "mouse", phase: "down" }),
    ]);

    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(2);
    expect(socket.messages("display.input")[1]!.events).toEqual([
      expect.objectContaining({ kind: "mouse", phase: "up" }),
      expect.objectContaining({ kind: "scroll" }),
    ]);

    socket.json({ type: "display.input.result", sequence: 1, outcome: "dispatched" });
    expect(socket.messages("display.input")).toHaveLength(3);
    expect(socket.messages("display.input")[2]!.events).toEqual([
      expect.objectContaining({ kind: "key", action: "down", code: "KeyA" }),
      expect.objectContaining({ kind: "key", action: "up", code: "KeyA" }),
    ]);

    socket.json({ type: "display.input.result", sequence: 2, outcome: "dispatched" });
    await Promise.all([down, up, scroll, keyDown, keyUp]);
    editing.dispose();
  });

  it("preserves order across click, keys, click while isolating both clicks from keys", async () => {
    const { socket, editing } = await editingFixture();
    const click1Down = editing.input(1, [
      { kind: "mouse", phase: "move", button: "none", modifiers: [], x: 0.2, y: 0.2 },
      {
        kind: "mouse",
        phase: "down",
        button: "left",
        clickCount: 1,
        modifiers: [],
        x: 0.2,
        y: 0.2,
      },
    ]);
    const click1Up = editing.input(1, [
      { kind: "mouse", phase: "up", button: "left", clickCount: 1, modifiers: [], x: 0.2, y: 0.2 },
    ]);
    const keyCalls: Promise<unknown>[] = [];
    for (const ch of "abc") {
      const code = `Key${ch.toUpperCase()}`;
      keyCalls.push(
        editing.send({
          kind: "key",
          keystroke: {
            action: "down",
            key: ch,
            code,
            modifiers: [],
            location: 0,
            repeat: false,
            text: ch,
          },
        }),
        editing.send({
          kind: "key",
          keystroke: { action: "up", key: ch, code, modifiers: [], location: 0, repeat: false },
        }),
      );
    }
    const click2Move = editing.input(1, [
      { kind: "mouse", phase: "move", button: "none", modifiers: [], x: 0.7, y: 0.7 },
    ]);
    const click2Down = editing.input(1, [
      {
        kind: "mouse",
        phase: "down",
        button: "left",
        clickCount: 1,
        modifiers: [],
        x: 0.7,
        y: 0.7,
      },
    ]);
    const click2Up = editing.input(1, [
      { kind: "mouse", phase: "up", button: "left", clickCount: 1, modifiers: [], x: 0.7, y: 0.7 },
    ]);

    for (let seq = 0; seq < 4; seq++) {
      expect(socket.messages("display.input")).toHaveLength(seq + 1);
      socket.json({ type: "display.input.result", sequence: seq, outcome: "dispatched" });
    }
    await Promise.all([click1Down, click1Up, ...keyCalls, click2Move, click2Down, click2Up]);

    const batches = socket
      .messages("display.input")
      .map((message) =>
        (message.events as { kind: string; phase?: string; action?: string; text?: string }[]).map(
          (event) =>
            event.kind === "mouse"
              ? `mouse:${event.phase}`
              : event.kind === "key"
                ? `key:${event.action}${event.text ? `:${event.text}` : ""}`
                : event.kind,
        ),
      );
    expect(batches).toEqual([
      ["mouse:move", "mouse:down"],
      ["mouse:up"],
      ["key:down:a", "key:up", "key:down:b", "key:up", "key:down:c", "key:up"],
      ["mouse:move", "mouse:down", "mouse:up"],
    ]);
    editing.dispose();
  });

  it("sends mouse-up and display.input-reset when a mouse drag is interrupted by a refusal", async () => {
    const { socket, editing } = await editingFixture();
    const down = editing.input(1, [
      {
        kind: "mouse",
        phase: "down",
        button: "left",
        clickCount: 1,
        modifiers: [],
        x: 0.2,
        y: 0.2,
      },
    ]);
    socket.json({ type: "display.input.result", sequence: 0, outcome: "dispatched" });
    await down;

    const move = editing.input(1, [
      { kind: "mouse", phase: "move", button: "left", modifiers: [], x: 0.5, y: 0.5 },
    ]);
    const up = editing.input(1, [
      { kind: "mouse", phase: "up", button: "left", clickCount: 1, modifiers: [], x: 0.5, y: 0.5 },
    ]);
    const settled = Promise.allSettled([move, up]);
    socket.json({ type: "display.input.result", sequence: 1, outcome: "refused", reason: "stale" });
    await settled;

    const sentEvents = socket.messages("display.input").flatMap((m) => m.events as unknown[]);
    expect(sentEvents).toContainEqual(
      expect.objectContaining({ kind: "mouse", phase: "up", button: "left" }),
    );
    expect(socket.sent.at(-1)).toEqual({ type: "display.input-reset" });
    editing.dispose();
  });
});

describe("phone power and explicit-open intent", () => {
  const owner = {
    kind: "owner-view" as const,
    viewId: "cvw_44444444-4444-4444-8444-444444444444",
    generation: 1,
  };
  const ownerTarget = { scope: "owner", source: owner };
  const state = {
    type: "display.state",
    state: "screen-off",
    generation: 0,
    width: 0,
    height: 0,
    sharedInput: 1,
    phoneOwnerControl: 1,
  };
  it("wakes once on the first attachment without geometry, never on timeout or reconnect", () => {
    streams.armAutoWake(owner);
    const lease = streams.retain(ownerTarget);
    const socket = sockets.at(-1)!;
    socket.open();
    socket.json(state);
    expect(lease.getSnapshot()).toMatchObject({ input: "unavailable", power: "available" });
    expect(socket.messages("display.power")).toEqual([
      { type: "display.power", action: "wake", sequence: 0 },
    ]);
    socket.json(state);
    expect(socket.messages("display.power")).toHaveLength(1);
    expect(lease.power("lock")).toBe(true);
    socket.json(state);
    expect(socket.messages("display.power")).toHaveLength(2);
    socket.drop();
    vi.advanceTimersByTime(100);
    const replacement = sockets.at(-1)!;
    replacement.open();
    replacement.json(state);
    expect(replacement.messages("display.power")).toEqual([]);
    lease.release();
  });
  it("requires an explicit Open to wake and reattach a terminal view", () => {
    const lease = streams.retain(ownerTarget);
    const socket = sockets.at(-1)!;
    socket.open();
    socket.json(state);
    socket.drop(1000);
    expect(lease.getSnapshot().connection).toBe("closed");
    streams.armAutoWake(owner);
    const replacement = sockets.at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.open();
    replacement.json(state);
    expect(replacement.messages("display.power")).toEqual([
      { type: "display.power", action: "wake", sequence: 0 },
    ]);
    lease.release();
  });

  it("does not undo a lock chosen as the first power confirmation arrives", () => {
    streams.armAutoWake(owner);
    const lease = streams.retain(ownerTarget);
    let locked = false;
    lease.subscribe(() => {
      if (!locked && lease.getSnapshot().power === "available") {
        locked = true;
        lease.power("lock");
      }
    });
    const socket = sockets.at(-1)!;
    socket.open();
    socket.json(state);
    expect(socket.messages("display.power")).toEqual([
      { type: "display.power", action: "lock", sequence: 0 },
    ]);
    lease.release();
  });

  it("keeps power and input unavailable until the current socket confirms authority", () => {
    const lease = streams.retain(ownerTarget);
    const socket = sockets.at(-1)!;
    socket.open();
    socket.json({ ...state, state: "live", generation: 1, width: 360, height: 780 });
    expect(lease.getSnapshot()).toMatchObject({ input: "available", power: "available" });
    streams.reconnect();
    const replacement = sockets.at(-1)!;
    replacement.open();
    expect(lease.getSnapshot()).toMatchObject({ input: "unavailable", power: "unavailable" });
    expect(lease.power("wake")).toBe(false);
    expect(lease.input(1, [{ kind: "nav", to: "home" }])).toBe(false);
    expect(replacement.sent).toEqual([]);
    replacement.json({ ...state, phoneOwnerControl: undefined, sharedInput: undefined });
    expect(lease.power("wake")).toBe(false);
    lease.release();
  });

  it("never wakes read-only or unconfirmed peers, even if authority later widens", () => {
    streams.armAutoWake(owner);
    const lease = streams.retain(ownerTarget);
    const socket = sockets.at(-1)!;
    socket.open();
    socket.json({ ...state, phoneOwnerControl: undefined, sharedInput: undefined });
    expect(lease.power("wake")).toBe(false);
    socket.json(state);
    expect(socket.messages("display.power")).toEqual([]);
    socket.json({ ...state, state: "live", generation: 1, width: 360, height: 780 });
    expect(lease.getSnapshot().input).toBe("available");
    lease.release();
  });
  it("cancels an unspent intent on leave or socket replacement", () => {
    streams.armAutoWake(owner);
    const lease = streams.retain(ownerTarget);
    const socket = sockets.at(-1)!;
    socket.open();
    streams.reconnect();
    const replacement = sockets.at(-1)!;
    replacement.open();
    replacement.json(state);
    expect(replacement.messages("display.power")).toEqual([]);
    lease.release();
    const restored = streams.retain(ownerTarget);
    const fresh = sockets.at(-1)!;
    fresh.open();
    fresh.json(state);
    expect(fresh.messages("display.power")).toEqual([]);
    restored.release();
  });
});

it("mock phone views cancel a hidden Open intent and withdraw write access live", async () => {
  vi.useRealTimers();
  const client = new MockHostClient({ latencyMs: 0 });
  const pool = sharedDisplayStreams(client);
  try {
    const phone = (await client.listApprovedComputerApps()).find(
      (item) => item.target.kind === "phone",
    )!;
    const tab = await client.openTab({
      kind: "phone",
      computerId: DeviceIdSchema.parse(phone.machineId),
    });
    const viewer = await client.activateTab(tab.tabId);
    if (viewer.kind !== "phone") throw new Error("Expected a phone viewer");
    const { view } = viewer;
    const retained = client.retainComputerView(view.viewId, view.generation);
    retained.setVisible(false);
    const lease = pool.retain({
      scope: "mock-phone",
      source: { kind: "owner-view", viewId: view.viewId, generation: view.generation },
    });
    try {
      await vi.waitFor(() => expect(lease.getSnapshot().input).toBe("available"));
      expect(lease.getSnapshot().display?.generation).toBe(1);
      expect(lease.power("lock")).toBe(true);
      expect(lease.getSnapshot()).toMatchObject({ power: "available", input: "unavailable" });
      expect(lease.power("wake")).toBe(true);
      expect(lease.getSnapshot().input).toBe("available");
      await client.dispatch({
        type: "integration.computer.setup.set",
        idempotencyKey: "lower-phone",
        input: {
          kind: "app",
          runnerId: phone.machineId,
          definitionId: "android-phone",
          app: null,
          access: "read",
        },
      });
      await vi.waitFor(() =>
        expect(lease.getSnapshot()).toMatchObject({
          connection: "open",
          input: "unavailable",
          power: "unavailable",
        }),
      );
    } finally {
      lease.release();
      retained.release();
    }
  } finally {
    pool.dispose();
    client.dispose();
  }
});

it("retains picture authority through absent bindings but rejects explicit capture permission loss", () => {
  const machine = {
    id: "rnr_1",
    status: "online",
    computerUse: {
      displayStreamSupported: true,
      sessions: [{ sessionId, display: true, apps: [] }],
    },
  };
  const snapshot = {
    session: "authenticated",
    user: { id: "usr_1" },
    deploymentId: "dep_1",
    machines: [machine],
  } as unknown as HostSnapshot;
  const authority = computerDisplayAuthorityKey(snapshot, source, machine.id);
  expect(authority).not.toBeNull();
  for (const changed of [
    machine,
    { ...machine, computerUse: { ...machine.computerUse, sessions: [] } },
    { ...machine, status: "offline" },
  ])
    expect(
      computerDisplayAuthorityKey(
        { ...snapshot, machines: [changed] } as unknown as HostSnapshot,
        source,
        machine.id,
      ),
    ).toBe(authority);
  for (const computerUse of [
    {
      ...machine.computerUse,
      permissions: { screenRecording: "denied", accessibility: "granted" },
    },
    { ...machine.computerUse, state: "permission-required" },
  ]) {
    const refused = {
      ...snapshot,
      machines: [{ ...machine, computerUse }],
    } as unknown as HostSnapshot;
    expect(computerDisplayAuthorityKey(refused, source, machine.id)).toBeNull();
    expect(computerDisplayScope(refused, source)).toBeNull();
  }
});

it("fences picture authority by phone Device and driver generation", () => {
  const phone = mockIphoneScreenDevice();
  const held = { sessionId, display: true, apps: [] };
  const withHold = { ...phone, computerUse: { ...phone.computerUse!, sessions: [held] } };
  const snapshot = {
    session: "authenticated",
    user: { id: "usr_1" },
    deploymentId: "dep_1",
    machines: [withHold],
  } as unknown as HostSnapshot;
  const first = computerDisplayAuthorityKey(snapshot, source, phone.id);
  const scope = computerDisplayScope(snapshot, source);
  const replacement = {
    ...withHold,
    phoneDisplay: {
      ...phone.phoneDisplay!,
      driver: { ...phone.phoneDisplay!.driver!, generation: 2 },
    },
  };
  expect(
    computerDisplayAuthorityKey(
      { ...snapshot, machines: [replacement] } as unknown as HostSnapshot,
      source,
      phone.id,
    ),
  ).not.toBe(first);
  expect(
    computerDisplayScope(
      { ...snapshot, machines: [replacement] } as unknown as HostSnapshot,
      source,
    ),
  ).not.toBe(scope);
  expect(
    computerDisplayAuthorityKey(
      { ...snapshot, machines: [mockIphoneScreenDevice("locked")] },
      source,
      phone.id,
    ),
  ).toBeNull();
});

it("invalidates only the replaced phone and refuses unadvertised navigation and power", () => {
  const phone = mockIphoneScreenDevice();
  const secondSource = {
    kind: "task-session" as const,
    sessionId: "cus_22222222-2222-4222-8222-222222222222",
  };
  const held = (device: typeof phone, id: string) => ({
    ...device,
    computerUse: { ...device.computerUse!, sessions: [{ sessionId: id, apps: [], display: true }] },
  });
  const first = held(phone, sessionId);
  const second = held(
    { ...phone, id: "dev_ffffffff-ffff-4fff-8fff-ffffffffffff" } as typeof phone,
    secondSource.sessionId,
  );
  const snapshot = {
    session: "authenticated",
    user: { id: "usr_1" },
    deploymentId: "dep_1",
    machines: [first, second],
  } as unknown as HostSnapshot;
  streams.syncDevices(snapshot);
  const firstLease = streams.retain({ scope: computerDisplayScope(snapshot, source)!, source });
  const firstSocket = sockets.at(-1)!;
  firstSocket.open();
  firstSocket.json({
    type: "display.state",
    state: "live",
    generation: 1,
    width: 720,
    height: 1280,
    sharedInput: 1,
    phoneOwnerControl: 1,
  });
  expect(firstLease.input(1, [{ kind: "nav", to: "back" }])).toBe(false);
  expect(firstLease.input(1, [{ kind: "nav", to: "home" }])).toBe(true);
  expect(firstLease.power("wake")).toBe(false);
  expect(firstLease.power("lock")).toBe(false);
  const secondLease = streams.retain({
    scope: computerDisplayScope(snapshot, secondSource)!,
    source: secondSource,
  });
  const secondSocket = opened();
  streams.syncDevices({
    ...snapshot,
    machines: [
      {
        ...phone,
        phoneDisplay: {
          ...phone.phoneDisplay!,
          driver: { ...phone.phoneDisplay!.driver!, generation: 2 },
        },
      },
      second,
    ],
  } as unknown as HostSnapshot);
  expect(firstSocket.closedWith).not.toBeNull();
  expect(firstLease.getSnapshot()).toMatchObject({
    connection: "closed",
    display: null,
    input: "unavailable",
  });
  expect(secondSocket.closedWith).toBeNull();
  secondLease.release();
  firstLease.release();
});

it("requires fresh owner authority and a new tab activation after a driver replacement", () => {
  const phone = mockIphoneScreenDevice();
  const records = new OwnerViewRecords();
  const view = {
    machineId: phone.id,
    viewId: "cvw_11111111-1111-4111-8111-111111111111",
    generation: 1,
    driverGeneration: 1,
    state: "ready",
    target: { kind: "phone", display: "main" },
  } as unknown as import("@opensteer/protocol").ComputerView;
  const accepted = records.accept([phone], view)[0]!;
  expect(accepted.computerUse?.ownerViews).toContain(view);
  const tabs = new TabViewers();
  tabs.set("phone-tab", { kind: "phone", view }, [accepted]);
  const changed = {
    ...phone,
    phoneDisplay: {
      ...phone.phoneDisplay!,
      driver: { ...phone.phoneDisplay!.driver!, generation: 2 },
    },
  };
  const reread = records.reread(changed, accepted, records.revision);
  expect(reread.computerUse?.ownerViews).toEqual([]);
  expect(records.accept([reread], view)[0]?.computerUse?.ownerViews).toEqual([]);
  const fresh = { ...view, generation: 2, driverGeneration: 2 };
  const reopened = records.accept([reread], fresh)[0]!;
  expect(reopened.computerUse?.ownerViews).toContain(fresh);
  expect(tabs.get("phone-tab", [reopened])).toBeNull();
  tabs.set("phone-tab", { kind: "phone", view: fresh }, [reopened]);
  expect(tabs.get("phone-tab", [reopened])).toMatchObject({ view: { generation: 2 } });
});

it("streams the iPhone mock with its access ceiling and hides its picture when locked", async () => {
  vi.useRealTimers();
  const client = new MockHostClient({
    latencyMs: 0,
    iphoneScreen: "read-only",
    iphoneScreenHolding: true,
  });
  const pool = sharedDisplayStreams(client);
  const source = mockIphoneScreenSource;
  const scope = computerDisplayScope(client.getSnapshot(), source);
  expect(scope).not.toBeNull();
  const lease = pool.retain({ scope: scope!, source });
  try {
    await vi.waitFor(() => expect(lease.getSnapshot().display?.state).toBe("live"));
    expect(lease.getSnapshot().input).toBe("unavailable");
    const phone = client
      .getSnapshot()
      .machines.find((machine) => machine.phoneDisplay?.definitionId === "iphone-screen")!;
    await setPhoneUseAccess(client, phone, "read-write");
    await vi.waitFor(() => expect(lease.getSnapshot().input).toBe("available"));
    client.setIphoneScreenState("locked");
    expect(lease.getSnapshot()).toMatchObject({
      connection: "closed",
      display: null,
      input: "unavailable",
    });
  } finally {
    lease.release();
    pool.dispose();
    client.dispose();
  }
});

it("keeps a self Mac stream open when only its Device metadata changes", () => {
  const phone = mockIphoneScreenDevice();
  const driver = phone.phoneDisplay!.driver!;
  const machine = {
    ...phone,
    id: driver.runnerId,
    kind: "computer",
    selfRunnerId: driver.runnerId,
    phoneDisplay: null,
    drivers: [{ ...driver, role: "self" }],
    computerUse: { ...phone.computerUse!, sessions: [{ sessionId, apps: [], display: true }] },
  };
  const snapshot = {
    session: "authenticated",
    user: { id: "usr_1" },
    deploymentId: "dep_1",
    machines: [machine],
  } as unknown as HostSnapshot;
  streams.syncDevices(snapshot);
  const lease = streams.retain({ scope: "mac", source });
  const socket = opened();
  streams.syncDevices({
    ...snapshot,
    machines: [{ ...machine, name: "Renamed Mac" }],
  } as unknown as HostSnapshot);
  expect(socket.closedWith).toBeNull();
  lease.release();
});
