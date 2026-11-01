import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDisplayViewerFrame } from "@opensteer/protocol";
import { DisplayStreams } from "@opensteer/client/integrations";
import type { WebSocketClient } from "@opensteer/client/host";
import { benchmarkPhoneDecoder } from "./phone-display-decoder.test-support.js";
import { retainPhoneDisplayPicture, type PhoneDisplayPicture } from "./phone-display-media.js";

/*
 * Ways the shared picture can show the wrong thing or stall, each answered
 * below (the real decoder and canvas run in `test:electron-display`):
 *
 * - A cached frame older than `replayThrough` reaches the canvas, so a joiner
 *   watches the cache fast-forward instead of seeing the current screen.
 * - The first picture painted after a replay is not the `replayThrough` frame.
 * - A replay of more than the live credit window is cut short by a viewer
 *   queue bound, waiting for a keyframe that a static screen never sends.
 * - Credit waits for decoder output, so a decoder that holds frames before
 *   output (a reorder window, a slow start) stalls the stream for good.
 * - A replay's repeated sequences are confused with frames of the same
 *   sequence still decoding, so the wrong picture is shown or none at all.
 * - A decoder error or a configuration the decoder rejects, synchronously or
 *   later through its error callback, leaves the viewer waiting without
 *   asking for a keyframe, asks more than once, or takes the last picture
 *   off the screen while it waits.
 * - A frame of the broken decoder is never acknowledged.
 * - A stream that ended for good, or a login that changed, leaves its last
 *   picture on the canvas.
 */

interface FakeChunk {
  readonly timestamp: number;
  readonly data: Uint8Array;
}

interface FakeFrame {
  readonly timestamp: number;
  /** The phone sequence the test wrote into the payload's last byte. */
  readonly sequence: number;
  readonly close: ReturnType<typeof vi.fn>;
}

const decoders: FakeVideoDecoder[] = [];
let configureFails = false;

/**
 * A decoder whose codec takes chunks off its queue separately from outputting
 * them, as a hardware decoder with a reorder window does, and which rejects an
 * unsupported configuration later through its error callback, as WebCodecs does.
 */
class FakeVideoDecoder extends EventTarget {
  state: CodecState = "unconfigured";
  readonly queue: FakeChunk[] = [];
  readonly taken: FakeChunk[] = [];
  readonly configs: VideoDecoderConfig[] = [];
  readonly #init: VideoDecoderInit;
  constructor(init: VideoDecoderInit) {
    super();
    this.#init = init;
    decoders.push(this);
  }
  get decodeQueueSize() {
    return this.queue.length;
  }
  configure(config: VideoDecoderConfig) {
    this.configs.push(config);
    this.state = "configured";
    if (configureFails) queueMicrotask(() => this.fail("NotSupportedError"));
  }
  decode(chunk: FakeChunk) {
    this.queue.push(chunk);
  }
  /** The codec takes queued chunks, firing `dequeue` as WebCodecs does. */
  take(count = this.queue.length) {
    this.taken.push(...this.queue.splice(0, count));
    this.dispatchEvent(new Event("dequeue"));
  }
  /** Outputs the oldest frame the codec took, taking one first if it has none. */
  output(): FakeFrame {
    if (this.taken.length === 0) this.take(1);
    const chunk = this.taken.shift();
    if (!chunk) throw new Error("Nothing to output");
    const frame = { timestamp: chunk.timestamp, sequence: chunk.data.at(-1)!, close: vi.fn() };
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }
  fail(name = "EncodingError") {
    this.state = "closed";
    this.queue.length = 0;
    this.taken.length = 0;
    this.#init.error(new DOMException("Decoder failed", name));
  }
  reset() {
    this.queue.length = 0;
    this.taken.length = 0;
    this.state = "unconfigured";
  }
  close() {
    this.state = "closed";
  }
}

class FakeSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly #listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  close(): void {
    this.readyState = 3;
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }
  state(extra: Record<string, unknown> = {}): void {
    this.#emit("message", {
      data: JSON.stringify({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 360,
        height: 780,
        ...extra,
      }),
    });
  }
  frame(sequence: number, key = false, generation = 1): void {
    const bytes = encodeDisplayViewerFrame(
      {
        generation,
        sequence,
        ptsUs: sequence * 33_333,
        key,
        ...(key ? { codec: "avc1.42C01E" } : {}),
        width: 360,
        height: 780,
      },
      new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41, sequence]),
    );
    this.#emit("message", { data: bytes.slice().buffer });
  }
  drop(code: number): void {
    this.readyState = 3;
    this.#emit("close", { code, reason: "" });
  }
  acks(): unknown[] {
    return this.sent.filter(({ type }) => type === "display.ack").map(({ sequence }) => sequence);
  }
  keyframeRequests(): number {
    return this.sent.filter(({ type }) => type === "display.keyframe").length;
  }
  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (value: unknown) => void)(event);
  }
}

let frames: Map<number, () => void>;
let nextFrame: number;
let socket: FakeSocket;
let connections: FakeSocket[];
let streams: DisplayStreams;
let picture: PhoneDisplayPicture;
let release: () => void;
let draws: number[];
let clears: number;
let painted: number | null;

/** Runs the animation frame the picture asked for, if any. */
function animate() {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback();
}

beforeEach(() => {
  decoders.length = 0;
  configureFails = false;
  frames = new Map();
  nextFrame = 1;
  draws = [];
  clears = 0;
  painted = null;
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      readonly timestamp: number;
      readonly data: Uint8Array;
      constructor(init: { timestamp: number; data: Uint8Array }) {
        this.timestamp = init.timestamp;
        this.data = init.data.slice();
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  socket = new FakeSocket();
  connections = [];
  streams = new DisplayStreams({
    connect: () => {
      const next = connections.length ? new FakeSocket() : socket;
      connections.push(next);
      return next;
    },
  });
  ({ picture, release } = retainPhoneDisplayPicture(
    streams,
    {
      scope: "scope",
      source: { kind: "task-session", sessionId: "cus_11111111-1111-4111-8111-111111111111" },
    },
    "prefer-hardware",
  ));
  const context = {
    drawImage: (image: FakeFrame) => {
      draws.push(image.sequence);
      painted = image.sequence;
    },
    clearRect: () => {
      clears += 1;
      painted = null;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  picture.attach(canvas as unknown as HTMLCanvasElement);
  socket.open();
});

afterEach(() => {
  release();
  vi.unstubAllGlobals();
});

describe("replay hold", () => {
  it("decodes a replay beyond the live credit window and paints first at replayThrough", () => {
    socket.state({ replayThrough: 9 });
    for (let sequence = 0; sequence <= 9; sequence += 1) socket.frame(sequence, sequence === 0);
    const decoder = decoders[0]!;
    expect(decoder.decodeQueueSize).toBe(10);
    expect(socket.acks()).toEqual([]);
    const outputs: FakeFrame[] = [];
    for (let sequence = 0; sequence <= 9; sequence += 1) {
      outputs.push(decoder.output());
      animate();
      // Between any two frames, nothing older than replayThrough is on the canvas.
      expect(draws.every((drawn) => drawn >= 9)).toBe(true);
    }
    expect(draws).toEqual([9]);
    expect(outputs.slice(0, 9).every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
    expect(socket.acks()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(picture.getSnapshot().shown).toEqual({ generation: 1, width: 360, height: 780 });
    expect(picture.stats.dropped).toBe(0);
    socket.frame(10);
    decoder.output();
    animate();
    expect(draws).toEqual([9, 10]);
  });
});

describe("credit", () => {
  it("the benchmark bridge holds credit until ordered decoder dequeue", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => ({ drawImage: vi.fn() }) }),
      body: { append: vi.fn() },
    });
    const dequeued = vi.fn();
    const bridge = benchmarkPhoneDecoder({ painted: vi.fn(), dequeued, failed: vi.fn() });
    for (let sequence = 0; sequence < 3; sequence++)
      bridge.accept({
        id: sequence,
        connection: 1,
        replayed: false,
        data: "AA==",
        header: {
          generation: 1,
          sequence,
          ptsUs: sequence,
          key: sequence === 0,
          ...(sequence === 0 ? { codec: "avc1.42C01F" } : {}),
          width: 360,
          height: 640,
        },
      });
    expect(dequeued).not.toHaveBeenCalled();
    const decoder = decoders[0]!;
    decoder.take(2);
    expect(dequeued.mock.calls).toEqual([[0], [1]]);
    decoder.output();
    expect(dequeued.mock.calls).toEqual([[0], [1]]);
    decoder.take();
    bridge.close();
    expect(dequeued.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("acknowledges a frame once the decoder takes it, however long it holds the output", () => {
    socket.state();
    for (let sequence = 0; sequence <= 5; sequence += 1) socket.frame(sequence, sequence === 0);
    const decoder = decoders[0]!;
    decoder.take(3);
    expect(socket.acks()).toEqual([0, 1, 2]);
    decoder.take();
    expect(socket.acks()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(draws).toEqual([]);
    for (let index = 0; index <= 5; index += 1) decoder.output();
    animate();
    expect(draws).toEqual([5]);
    expect(socket.acks()).toHaveLength(6);
  });

  it("keeps a repeated replay's frames apart from the same sequences still decoding", () => {
    socket.state();
    for (let sequence = 1; sequence <= 3; sequence += 1) socket.frame(sequence, sequence === 1);
    const decoder = decoders[0]!;
    decoder.take();
    socket.state({ replayThrough: 3 });
    for (let sequence = 1; sequence <= 3; sequence += 1) socket.frame(sequence, sequence === 1);
    decoder.take();
    expect(socket.acks()).toEqual([1, 2, 3, 1, 2, 3]);
    for (let index = 0; index < 6; index += 1) {
      decoder.output();
      animate();
    }
    expect(draws).toEqual([1, 2, 3, 3]);
  });
});

describe("keyframe requests", () => {
  function showFirstPicture() {
    socket.state();
    socket.frame(0, true);
    socket.frame(1);
    decoders[0]!.output();
    decoders[0]!.output();
    animate();
    expect(draws).toEqual([1]);
  }

  it("asks once when the decoder fails, keeps the picture, and recovers from the replay", () => {
    showFirstPicture();
    socket.frame(2);
    decoders[0]!.fail();
    expect(socket.keyframeRequests()).toBe(1);
    expect(socket.acks()).toEqual([0, 1, 2]);
    socket.frame(3);
    socket.frame(4);
    expect(socket.keyframeRequests()).toBe(1);
    expect(socket.acks()).toEqual([0, 1, 2, 3, 4]);
    expect(clears).toBe(0);
    expect(picture.getSnapshot()).toMatchObject({ shown: { generation: 1 }, waitingForKey: true });
    socket.state({ replayThrough: 6 });
    socket.frame(5, true);
    socket.frame(6);
    const replacement = decoders[1]!;
    expect(replacement.configs).toEqual([
      { codec: "avc1.42C01E", hardwareAcceleration: "no-preference", optimizeForLatency: true },
    ]);
    replacement.output();
    animate();
    replacement.output();
    animate();
    expect(draws).toEqual([1, 6]);
    expect(picture.getSnapshot().waitingForKey).toBe(false);
  });

  it("asks when the decoder later rejects a generation's configuration", async () => {
    showFirstPicture();
    configureFails = true;
    socket.state({ generation: 2 });
    socket.frame(2, true, 2);
    expect(socket.keyframeRequests()).toBe(0);
    await Promise.resolve();
    expect(socket.keyframeRequests()).toBe(1);
    expect(socket.acks()).toEqual([0, 1, 2]);
    expect(picture.getSnapshot().shown).toEqual({ generation: 1, width: 360, height: 780 });
  });
});

describe("retained pictures", () => {
  function drawn() {
    socket.state();
    socket.frame(0, true);
    const first = decoders[0]!.output();
    animate();
    expect(draws).toEqual([0]);
    return first;
  }

  it("keeps the drawn pixels through reconnect until the replacement decodes", () => {
    const first = drawn();
    streams.reconnect();
    expect(clears).toBe(0);
    expect(picture.getSnapshot().shown).toEqual({ generation: 1, width: 360, height: 780 });
    const next = connections[1]!;
    next.open();
    next.state();
    next.frame(1, true);
    expect(clears).toBe(0);
    expect(first.close).not.toHaveBeenCalled();
    decoders.at(-1)!.output();
    animate();
    expect(draws).toEqual([0, 1]);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("keeps a resumed picture stale until the new socket actually paints", () => {
    drawn();
    streams.suspend(true);
    expect(picture.getSnapshot()).toMatchObject({ shown: { generation: 1 }, stale: true });
    expect(clears).toBe(0);
    streams.suspend(false);
    const next = connections[1]!;
    next.open();
    next.state();
    next.frame(1, true);
    expect(picture.getSnapshot().stale).toBe(true);
    decoders.at(-1)!.output();
    expect(picture.getSnapshot().stale).toBe(true);
    animate();
    expect(picture.getSnapshot().stale).toBe(false);
    expect(draws).toEqual([0, 1]);
  });

  it("clears the retained pixels immediately when the login ends with 1008", () => {
    drawn();
    expect(painted).toBe(0);
    socket.drop(1008);
    expect(painted).toBeNull();
    expect(picture.getSnapshot().shown).toBeNull();
    animate();
    expect(painted).toBeNull();
  });
});

describe("terminal close", () => {
  it("takes the picture off the canvas when the login it was opened for changes", () => {
    socket.state();
    socket.frame(0, true);
    decoders[0]!.output();
    animate();
    streams.invalidate(() => false);
    expect(clears).toBe(1);
    expect(picture.getSnapshot().shown).toBeNull();
  });

  it("takes the picture off the canvas when the stream ends for good", () => {
    socket.state();
    socket.frame(0, true);
    decoders[0]!.output();
    animate();
    socket.drop(1000);
    expect(clears).toBe(1);
    expect(picture.getSnapshot().shown).toBeNull();
  });
});
