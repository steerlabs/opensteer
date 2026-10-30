import {
  displayViewerCreditBytes,
  displayViewerCreditFrames,
  encodeDisplayViewerFrame,
  type DisplayViewerFrameHeader,
  type DisplayViewerServerMessage,
} from "@opensteer/protocol";
import type { WebSocketClient } from "../../../packages/client/src/host/host-session-client.js";
import {
  DisplayStreams,
  type ComputerDisplayTarget,
} from "../../../packages/client/src/integrations/phone-display-stream.js";
import {
  MockPhoneDisplaySocket,
  mockPhoneDisplayPicture,
} from "../../../packages/client/src/mock/mock-phone-display.js";
import {
  phoneDisplayDecoding,
  retainPhoneDisplayPicture,
  type PhoneDisplayPicture,
} from "../../web/src/components/phone-display-media.js";

/**
 * The page half of the live display smoke. Each scenario runs the shipping
 * pipeline — the client's viewer transport, the web view's WebCodecs decoder
 * and its canvas renderer — against a socket playing the Host: live frames
 * under its four-frame credit window, its cache replayed under byte credit
 * with the frames' original sequences on join or keyframe request, and
 * acknowledgements consumed in delivery order. It reports what reached the
 * canvas.
 */

type Rgb = readonly [number, number, number];
export interface DisplaySmokeScenario {
  /**
   * Decoder and client events in order: `taken N` once the decoders have taken
   * N frames off their queues in all, `output`, then each message sent.
   */
  readonly timeline: string[];
  /** The most frames the Host had outstanding at once. */
  readonly maxOutstanding: number;
  readonly checks: Record<string, unknown>;
  readonly samples: Record<string, Rgb>;
  readonly stats: PhoneDisplayPicture["stats"];
  readonly elapsedMs: number;
}
export interface DisplaySmokeResult {
  readonly acceleration: HardwareAcceleration | null;
  readonly visibility: DocumentVisibilityState;
  readonly scenarios: Record<string, DisplaySmokeScenario | { readonly error: string }>;
}
export interface DisplaySmokeInput {
  readonly vectors: readonly string[];
  /** Viewer envelopes, base64, from a recording file (see `electron-display-smoke.ts`). */
  readonly recording: readonly string[];
  readonly recordingSource: string;
}

declare global {
  interface Window {
    displaySmoke: {
      readonly run: (input: DisplaySmokeInput) => Promise<DisplaySmokeResult>;
    };
  }
}

const sessionId = "cus_11111111-1111-4111-8111-111111111111";
const timeline: string[] = [];

// A parameter set no decoder accepts, then an IDR it cannot start from.
const nal = (type: number, body: readonly number[]) => [0, 0, 0, 1, type, ...body];
const corruptKeyframe = Uint8Array.from([
  ...nal(0x67, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  ...nal(0x68, [0xff, 0xff, 0xff]),
  ...nal(
    0x65,
    Array.from({ length: 512 }, (_, index) => (index * 37) & 0xff),
  ),
]);

/**
 * How the smoke bends the real decoder: hold back its last outputs, as a
 * decoder with a reorder window does, or break it on its next chunk.
 */
const decoderControl = {
  holdOutputs: 0,
  held: [] as (() => void)[],
  breakNext: false,
  takenTotal: 0,
  release(): void {
    this.holdOutputs = 0;
    for (const forward of this.held.splice(0)) forward();
  },
};

// Decoder events enter the same timeline as the client's messages, so the
// order the Host would see is recorded rather than inferred.
const NativeVideoDecoder = VideoDecoder;
globalThis.VideoDecoder = class extends NativeVideoDecoder {
  #submitted = 0;
  #reported = 0;
  constructor(init: VideoDecoderInit) {
    super({
      ...init,
      output: (frame) => {
        // Output also proves the decoder took the chunk, which Chromium may
        // report before its coalesced `dequeue` event.
        this.#logTaken();
        timeline.push("output");
        decoderControl.held.push(() => init.output(frame));
        while (decoderControl.held.length > decoderControl.holdOutputs)
          decoderControl.held.shift()!();
      },
    });
    // Registered before the viewer's own listener, so it is logged before the
    // acknowledgements it releases.
    this.addEventListener("dequeue", () => this.#logTaken());
  }
  #logTaken(): void {
    const taken = this.#submitted - this.decodeQueueSize;
    decoderControl.takenTotal += taken - this.#reported;
    this.#reported = taken;
    timeline.push(`taken ${decoderControl.takenTotal}`);
  }
  override decode(chunk: EncodedVideoChunk): void {
    this.#submitted += 1;
    if (!decoderControl.breakNext) {
      super.decode(chunk);
      return;
    }
    decoderControl.breakNext = false;
    super.decode(
      new EncodedVideoChunk({ type: "key", timestamp: chunk.timestamp, data: corruptKeyframe }),
    );
  }
};

/**
 * Every picture that reaches a canvas, with the marker pixel it left there:
 * the canvas changes only by these draws, so this is everything a person
 * could have seen. Marker bands name frames; the decoder names chunks itself.
 */
const draws: { readonly marker: number }[] = [];
let markerPixel: readonly [number, number] | null = null;
const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage as (
  this: CanvasRenderingContext2D,
  ...args: unknown[]
) => void;
CanvasRenderingContext2D.prototype.drawImage = function (
  this: CanvasRenderingContext2D,
  ...args: unknown[]
) {
  nativeDrawImage.apply(this, args);
  if (args[0] instanceof VideoFrame)
    draws.push({ marker: markerPixel ? this.getImageData(...markerPixel, 1, 1).data[0]! : -1 });
} as CanvasRenderingContext2D["drawImage"];

interface Queued {
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly key: boolean;
  readonly replay: boolean;
}

/**
 * Plays the Host's viewer socket: state, then frames. Live frames wait for
 * the four-frame credit window; the cache, from the latest keyframe on, is
 * replayed under byte credit alone with the frames' original sequences when
 * the viewer asks for a keyframe, as the Host does.
 */
class HostSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  maxOutstanding = 0;
  /** Answer keyframe requests at once; a scenario can hold them to answer later. */
  answerKeyframes = true;
  #requested = false;
  #state: DisplayViewerServerMessage | null = null;
  #cache: Queued[] = [];
  readonly #listeners = new Map<string, Set<(event: never) => void>>();
  readonly #queue: Queued[] = [];
  #outstanding: Queued[] = [];

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.#emit("open", {});
    }, 0);
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.#emit("close", { code, reason }), 0);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const message = JSON.parse(String(data)) as { type: string; sequence?: number };
    timeline.push(
      message.sequence === undefined ? message.type : `${message.type} ${message.sequence}`,
    );
    if (message.type === "display.keyframe") {
      this.#requested = true;
      if (this.answerKeyframes) setTimeout(() => this.answerKeyframe(), 0);
      return;
    }
    if (message.type !== "display.ack") return;
    // Acknowledgements arrive in delivery order and return credit up to the
    // first outstanding delivery of that sequence, repeated sequences included.
    const index = this.#outstanding.findIndex(({ sequence }) => sequence === message.sequence);
    if (index >= 0) this.#outstanding.splice(0, index + 1);
    setTimeout(() => this.#pump(), 0);
  }
  state(message: DisplayViewerServerMessage): void {
    if (message.type === "display.state") this.#state = message;
    this.#emit("message", { data: JSON.stringify(message) });
  }
  frames(frames: readonly Envelope[]): void {
    for (const frame of frames) {
      this.#cache = frame.key ? [] : this.#cache;
      this.#cache.push({ ...frame, replay: false });
      this.#queue.push({ ...frame, replay: false });
    }
    this.#pump();
  }
  replay(frames: readonly Envelope[]): void {
    this.#cache = frames.map((frame) => ({ ...frame, replay: false }));
    this.#queue.push(...frames.map((frame) => ({ ...frame, replay: true })));
    this.#pump();
  }
  /** Replays the cache under its original sequences, named by a state before it. */
  answerKeyframe(): void {
    if (!this.#requested || !this.#state || this.#state.type !== "display.state") return;
    this.#requested = false;
    const cache = this.#cache;
    this.state({ ...this.#state, replayThrough: cache.at(-1)!.sequence });
    this.#queue.push(...cache.map((frame) => ({ ...frame, replay: true })));
    this.#pump();
  }
  get idle(): boolean {
    return this.#queue.length === 0 && this.#outstanding.length === 0;
  }
  #pump(): void {
    for (let next = this.#queue[0]; next && this.readyState === 1; next = this.#queue[0]) {
      const bytes = this.#outstanding.reduce((total, frame) => total + frame.bytes.byteLength, 0);
      const fits =
        this.#outstanding.length === 0 || bytes + next.bytes.byteLength <= displayViewerCreditBytes;
      if (!fits || (!next.replay && this.#outstanding.length >= displayViewerCreditFrames)) return;
      this.#queue.shift();
      this.#outstanding.push(next);
      this.maxOutstanding = Math.max(this.maxOutstanding, this.#outstanding.length);
      this.#emit("message", { data: next.bytes.slice().buffer });
    }
  }
  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (event: unknown) => void)(event);
  }
}

window.displaySmoke = {
  run: async (input) => {
    const acceleration = await phoneDisplayDecoding();
    const scenarios: DisplaySmokeResult["scenarios"] = {};
    if (acceleration) {
      for (const [name, scenario] of [
        ["phone-vectors", () => phoneVectors(acceleration, input.vectors)],
        ["mock-preview", () => mockPreview(acceleration)],
        ["owner-authority", () => ownerAuthority(acceleration)],
        ["encoder-generations", () => encoderGenerations(acceleration)],
        ["replay-join", () => replayJoin(acceleration)],
        ["decoder-error", () => decoderError(acceleration)],
        ["reorder-window", () => reorderWindow(acceleration)],
        ["recording", () => recording(acceleration, input)],
      ] as const) {
        try {
          scenarios[name] = await scenario();
        } catch (error) {
          scenarios[name] = {
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          };
        } finally {
          decoderControl.release();
          decoderControl.breakNext = false;
        }
      }
    }
    return { acceleration, visibility: document.visibilityState, scenarios };
  },
};

/**
 * The phone's recorded vectors (libx264 black, with SPS and PPS before the
 * IDR) behind a delta that arrives before its keyframe: that delta is
 * acknowledged unshown, the rest once the decoder takes them, and the decoded
 * black covers the canvas's magenta fill entirely.
 */
async function phoneVectors(
  acceleration: HardwareAcceleration,
  vectors: readonly string[],
): Promise<DisplaySmokeScenario> {
  const [key, delta] = vectors.map(fromBase64);
  if (!key || !delta) throw new Error("The phone vectors need a keyframe and a delta.");
  const run = start(acceleration);
  const canvas = run.canvas(180, 320, [255, 0, 255]);
  const early = { ...viewerHeader(delta), sequence: 0 };
  const frames = [
    envelope(early, payloadOf(delta)),
    envelope({ ...viewerHeader(key), sequence: 1 }, payloadOf(key)),
    envelope({ ...viewerHeader(delta), sequence: 2 }, payloadOf(delta)),
  ];
  const socket = await run.socket();
  socket.state(live(1, 180, 320));
  socket.frames(frames);
  await until(() => socket.idle && run.picture.getSnapshot().shown !== null);
  await frame();
  const grid = gridSamples(canvas, 180, 320);
  return run.finish(socket, {
    samples: grid,
    checks: {
      shown: run.picture.getSnapshot().shown,
      canvas: [canvas.width, canvas.height],
      decodedEverywhere: Object.values(grid).every((rgb) => rgb.every((value) => value <= 8)),
      sentinelLeft: Object.values(grid).some((rgb) => rgb[0] > 200 && rgb[2] > 200),
    },
  });
}

/**
 * The preview Host's phone: its libx264 home screen decodes to the layout's
 * colours, and shared input goes directly over the same socket.
 */
async function mockPreview(acceleration: HardwareAcceleration): Promise<DisplaySmokeScenario> {
  let socket: MockPhoneDisplaySocket | null = null;
  const run = start(acceleration, () => {
    socket = new MockPhoneDisplaySocket("live");
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      const message = JSON.parse(String(data)) as { type: string; sequence?: number };
      timeline.push(
        message.sequence === undefined ? message.type : `${message.type} ${message.sequence}`,
      );
      send(data);
    };
    return socket;
  });
  const { width, height } = mockPhoneDisplayPicture;
  const canvas = run.canvas(width, height, [255, 0, 255]);
  await until(() => run.picture.getSnapshot().shown !== null && timeline.includes("display.ack 0"));
  await frame();
  const samples = {
    background: sample(canvas, 10, 270),
    card: sample(canvas, 300, 230),
    accent: sample(canvas, 150, 331),
    button: sample(canvas, 100, 538),
    line: sample(canvas, 150, 371),
  };
  const view = run.streams.retain(run.target);
  await until(() => view.getSnapshot().input === "available");
  const sent = view.input(1, [{ kind: "nav", to: "home" }]);
  view.release();
  return run.finish(null, {
    samples,
    checks: {
      shown: run.picture.getSnapshot().shown,
      canvas: [canvas.width, canvas.height],
      colours: {
        background: near(samples.background, [0x15, 0x1d, 0x1f]),
        card: near(samples.card, [0x30, 0x60, 0x76]),
        accent: near(samples.accent, [0xe4, 0xaf, 0x77]),
        button: near(samples.button, [0xe4, 0xaf, 0x77]),
        line: near(samples.line, [0xb6, 0xbe, 0xc8]),
      },
      sharedInputSent: sent,
    },
  });
}

/** An owner source is read-only, and its removal fences queued decoder output. */
async function ownerAuthority(acceleration: HardwareAcceleration): Promise<DisplaySmokeScenario> {
  const encoded = await encode(240, 432, 2, drawMarker);
  const frames = wrapChunks(1, encoded.chunks, 240, 432, 0);
  const run = start(acceleration, undefined, {
    kind: "owner-view",
    viewId: "cvw_11111111-1111-4111-8111-111111111111",
    generation: 1,
  });
  const canvas = run.canvas(240, 432, [255, 0, 255]);
  const socket = await run.socket();
  socket.state(live(1, 240, 432));
  socket.frames(frames.slice(0, 1));
  await until(() => socket.idle && run.picture.getSnapshot().shown !== null);
  await frame();
  const decoded = near(sample(canvas, 30, 300), [0xe0, 0x20, 0x20]);
  const siblingTarget: ComputerDisplayTarget = {
    scope: run.target.scope,
    source: {
      kind: "owner-view",
      viewId: "cvw_22222222-2222-4222-8222-222222222222",
      generation: 1,
    },
  };
  const sibling = retainPhoneDisplayPicture(run.streams, siblingTarget, acceleration);
  const siblingView = run.streams.retain(siblingTarget);
  const siblingSocket = await run.socket(socket);
  siblingSocket.state(live(1, 240, 432));
  siblingSocket.frames(frames.slice(0, 1));
  await until(() => siblingSocket.idle && sibling.picture.getSnapshot().shown !== null);
  const view = run.streams.retain(run.target);
  const inputSent = view.input(1, [{ kind: "nav", to: "home" }]);
  view.release();
  decoderControl.holdOutputs = 1;
  socket.frames(frames.slice(1));
  await until(() => socket.idle && decoderControl.held.length === 1);
  const paintedBeforeRemoval = draws.length;
  socket.state({ ...live(1, 240, 432), state: "stopped", reason: "owner-ended" });
  await frame();
  decoderControl.release();
  await frame();
  await frame();
  const independentSibling =
    sibling.picture.getSnapshot().shown !== null &&
    siblingView.getSnapshot().display?.state === "live";
  siblingView.release();
  sibling.release();
  return run.finish(socket, {
    samples: {},
    checks: {
      decoded,
      independentSibling,
      inputSent,
      inputFrameSent: timeline.some((entry) => entry.startsWith("display.input")),
      cleared:
        run.picture.getSnapshot().shown === null &&
        sample(canvas, 30, 300).every((value) => value <= 8),
      queuedOutputDiscarded: draws.length === paintedBeforeRemoval,
    },
  });
}

/**
 * Frames this Chromium encodes itself, Annex B: a 30-frame portrait GOP under
 * the live credit window, then the stream announces a landscape generation.
 * The portrait picture stays until the landscape keyframe decodes on a
 * reconfigured decoder; protection then takes the picture off the canvas.
 */
async function encoderGenerations(
  acceleration: HardwareAcceleration,
): Promise<DisplaySmokeScenario> {
  const portrait = await encode(240, 432, 30, (context, index) => {
    context.fillStyle = "#e02020";
    context.fillRect(0, 0, 120, 432);
    context.fillStyle = "#2040e0";
    context.fillRect(120, 0, 120, 432);
    context.fillStyle = "#ffffff";
    context.fillRect(40 + index * 2, 40, 64, 64);
  });
  const landscape = await encode(432, 240, 10, (context) => {
    context.fillStyle = "#20c040";
    context.fillRect(0, 0, 432, 120);
    context.fillStyle = "#f0d020";
    context.fillRect(0, 120, 432, 120);
  });
  const run = start(acceleration);
  const canvas = run.canvas(1, 1, [0, 0, 0]);
  const socket = await run.socket();
  let sequence = 0;
  const wrap = (
    generation: number,
    chunks: readonly EncodedChunk[],
    width: number,
    height: number,
  ) =>
    chunks.map((chunk) =>
      envelope(
        {
          generation,
          sequence: sequence++,
          ptsUs: chunk.timestamp,
          key: chunk.key,
          ...(chunk.key ? { codec: chunk.codec } : {}),
          width,
          height,
        },
        chunk.bytes,
      ),
    );
  socket.state(live(1, 240, 432));
  socket.frames(wrap(1, portrait.chunks, 240, 432));
  await until(() => socket.idle && run.picture.getSnapshot().shown !== null);
  await frame();
  await frame();
  const portraitSamples = {
    red: sample(canvas, 30, 300),
    blue: sample(canvas, 210, 300),
    square: sample(canvas, 40 + 29 * 2 + 32, 72),
  };
  socket.state(live(2, 432, 240));
  await frame();
  await frame();
  const kept = {
    shown: run.picture.getSnapshot().shown,
    canvas: [canvas.width, canvas.height],
    red: sample(canvas, 30, 300),
  };
  socket.frames(wrap(2, landscape.chunks, 432, 240));
  await until(() => socket.idle && run.picture.getSnapshot().shown?.generation === 2);
  await frame();
  const landscapeSamples = { green: sample(canvas, 200, 60), yellow: sample(canvas, 200, 180) };
  const landscapeCanvas = [canvas.width, canvas.height];
  socket.state({ ...live(2, 432, 240), state: "protected", reason: "paused" });
  await frame();
  const cleared = { shown: run.picture.getSnapshot().shown, green: sample(canvas, 200, 60) };
  return run.finish(socket, {
    samples: { ...portraitSamples, ...landscapeSamples },
    checks: {
      encoder: { portrait: portrait.config, landscape: landscape.config },
      keyframeUnits: { portrait: portrait.keyUnits, landscape: landscape.keyUnits },
      frames: { portrait: portrait.chunks.length, landscape: landscape.chunks.length },
      portrait: {
        red: near(portraitSamples.red, [0xe0, 0x20, 0x20]),
        blue: near(portraitSamples.blue, [0x20, 0x40, 0xe0]),
        square: near(portraitSamples.square, [0xff, 0xff, 0xff]),
      },
      keptThroughGenerationChange: {
        ...kept,
        stillPortrait: kept.shown?.generation === 1 && near(kept.red, [0xe0, 0x20, 0x20]),
      },
      landscape: {
        canvas: landscapeCanvas,
        green: near(landscapeSamples.green, [0x20, 0xc0, 0x40]),
        yellow: near(landscapeSamples.yellow, [0xf0, 0xd0, 0x20]),
      },
      clearedOnProtection: { ...cleared, black: cleared.green.every((value) => value <= 8) },
    },
  });
}

/**
 * A joiner's replay larger than the live credit window, as the Host sends it
 * under its byte credit alone. Every replayed frame is decoded and
 * acknowledged, none is skipped, and the first picture any canvas shows is
 * the `replayThrough` frame: each frame's marker band names it, and every
 * draw is recorded with the marker it left.
 */
async function replayJoin(acceleration: HardwareAcceleration): Promise<DisplaySmokeScenario> {
  const encoded = await encode(240, 432, 30, drawMarker);
  const run = start(acceleration);
  run.canvas(240, 432, [255, 0, 255]);
  markerPixel = [120, 48];
  const socket = await run.socket();
  const through = 24;
  const frames = wrapChunks(1, encoded.chunks, 240, 432, 0);
  socket.state({ ...live(1, 240, 432), replayThrough: through });
  socket.replay(frames.slice(0, through + 1));
  await until(() => draws.length > 0 && socket.idle);
  const replayOutstanding = socket.maxOutstanding;
  socket.frames(frames.slice(through + 1));
  await until(() => socket.idle && painted().at(-1) === frames.length - 1);
  await frame();
  return run.finish(socket, {
    samples: {},
    checks: {
      replayThrough: through,
      frames: frames.length,
      replayOutstanding,
      firstPaint: painted()[0],
      nothingStale: painted().every((shows) => shows >= through),
      painted: painted(),
    },
  });
}

/**
 * The decoder breaks on a frame the Host delivered intact. The viewer keeps
 * the last picture and asks for a keyframe once while later deltas are
 * dropped and acknowledged; the Host replays its cache from the keyframe under
 * the frames' original sequences, and the viewer recovers on a new decoder,
 * showing nothing before `replayThrough`.
 */
async function decoderError(acceleration: HardwareAcceleration): Promise<DisplaySmokeScenario> {
  const encoded = await encode(240, 432, 9, drawMarker);
  const frames = wrapChunks(1, encoded.chunks, 240, 432, 0);
  const run = start(acceleration);
  const canvas = run.canvas(240, 432, [255, 0, 255]);
  markerPixel = [120, 48];
  const socket = await run.socket();
  socket.answerKeyframes = false;
  socket.state(live(1, 240, 432));
  socket.frames(frames.slice(0, 6));
  await until(() => socket.idle && painted().at(-1) === 5);
  await frame();
  const before = sample(canvas, 120, 48);
  decoderControl.breakNext = true;
  socket.frames(frames.slice(6, 7));
  await until(() => timeline.includes("display.keyframe") && socket.idle);
  socket.frames(frames.slice(7));
  await until(() => socket.idle);
  await frame();
  await frame();
  const kept = sample(canvas, 120, 48);
  const shownBeforeReplay = draws.length;
  socket.answerKeyframe();
  await until(() => socket.idle && draws.length > shownBeforeReplay);
  await frame();
  return run.finish(socket, {
    samples: { before, kept },
    checks: {
      errors: run.picture.stats.errors,
      keyframeRequests: timeline.filter((entry) => entry === "display.keyframe").length,
      keptPicture: markerIndex(kept[0]) === 5 && near(kept, before),
      recovered: painted().slice(shownBeforeReplay),
      connection: run.lease().connection,
    },
  });
}

/**
 * A decoder that holds its last six outputs, as one with a reorder window
 * does. Credit returns as the decoder takes each frame, so all twenty live
 * frames flow through the four-frame window while six pictures are still held.
 */
async function reorderWindow(acceleration: HardwareAcceleration): Promise<DisplaySmokeScenario> {
  const encoded = await encode(240, 432, 20, drawMarker);
  const frames = wrapChunks(1, encoded.chunks, 240, 432, 0);
  const run = start(acceleration);
  run.canvas(240, 432, [255, 0, 255]);
  markerPixel = [120, 48];
  const socket = await run.socket();
  decoderControl.holdOutputs = 6;
  socket.state(live(1, 240, 432));
  socket.frames(frames);
  await until(() => socket.idle);
  const acknowledgedWhileHeld = timeline.filter((entry) => entry.startsWith("display.ack")).length;
  const heldOutputs = decoderControl.held.length;
  decoderControl.release();
  await until(() => painted().at(-1) === frames.length - 1);
  return run.finish(socket, {
    samples: {},
    checks: { frames: frames.length, acknowledgedWhileHeld, heldOutputs, painted: painted() },
  });
}

/**
 * A recorded stream, as a viewer received it, fed live under the credit
 * window: every frame from the first keyframe decodes on this Chromium with
 * no decoder error, and the last picture reaches the canvas at its size.
 */
async function recording(
  acceleration: HardwareAcceleration,
  input: DisplaySmokeInput,
): Promise<DisplaySmokeScenario> {
  const envelopes = input.recording.map(fromBase64);
  const headers = envelopes.map(viewerHeader);
  const firstKey = headers.findIndex((header) => header.key);
  const last = headers.at(-1);
  if (firstKey < 0 || !last) throw new Error("The recording has no keyframe.");
  const run = start(acceleration);
  const canvas = run.canvas(1, 1, [255, 0, 255]);
  const socket = await run.socket();
  socket.state(live(headers[0]!.generation, headers[0]!.width, headers[0]!.height));
  socket.frames(
    envelopes.map((bytes, index) => ({
      sequence: headers[index]!.sequence,
      key: headers[index]!.key,
      bytes,
    })),
  );
  await until(() => socket.idle && run.picture.stats.decoded >= envelopes.length - firstKey);
  await frame();
  const grid = gridSamples(canvas, canvas.width, canvas.height);
  const levels = Object.values(grid).flatMap((rgb) => rgb);
  return run.finish(socket, {
    samples: grid,
    checks: {
      source: input.recordingSource,
      frames: envelopes.length,
      decodable: envelopes.length - firstKey,
      lastHeader: last,
      canvas: [canvas.width, canvas.height],
      contrast: Math.max(...levels) - Math.min(...levels),
    },
  });
}

/** The marker index each draw left on the canvas, in order. */
function painted(): number[] {
  return draws.map(({ marker }) => markerIndex(marker));
}

/** Red and blue halves under a grey band whose level names the frame. */
function drawMarker(context: OffscreenCanvasRenderingContext2D, index: number): void {
  context.fillStyle = "#e02020";
  context.fillRect(0, 0, 120, 432);
  context.fillStyle = "#2040e0";
  context.fillRect(120, 0, 120, 432);
  const level = 20 + index * 7;
  context.fillStyle = `rgb(${level} ${level} ${level})`;
  context.fillRect(0, 0, 240, 96);
}

function markerIndex(value: number): number {
  return Math.round((value - 20) / 7);
}

function wrapChunks(
  generation: number,
  chunks: readonly EncodedChunk[],
  width: number,
  height: number,
  firstSequence: number,
): Envelope[] {
  return chunks.map((chunk, index) =>
    envelope(
      {
        generation,
        sequence: firstSequence + index,
        ptsUs: chunk.timestamp,
        key: chunk.key,
        ...(chunk.key ? { codec: chunk.codec } : {}),
        width,
        height,
      },
      chunk.bytes,
    ),
  );
}

interface EncodedChunk {
  readonly bytes: Uint8Array;
  readonly codec: string;
  readonly key: boolean;
  readonly timestamp: number;
}

/** Encodes a drawn sequence as the phone would: Constrained Baseline, Annex B, one keyframe. */
async function encode(
  width: number,
  height: number,
  count: number,
  draw: (context: OffscreenCanvasRenderingContext2D, index: number) => void,
): Promise<{ chunks: EncodedChunk[]; config: string; keyUnits: number[] }> {
  const config: VideoEncoderConfig = {
    codec: "avc1.42E01F",
    width,
    height,
    bitrate: 2_000_000,
    framerate: 30,
    latencyMode: "realtime",
    avc: { format: "annexb" },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This Chromium cannot encode ${JSON.stringify(config)}.`);
  const chunks: EncodedChunk[] = [];
  let codec = config.codec;
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.codec) codec = metadata.decoderConfig.codec;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      chunks.push({ bytes, codec, key: chunk.type === "key", timestamp: chunk.timestamp });
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(config);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  for (let index = 0; index < count; index += 1) {
    draw(context, index);
    const picture = new VideoFrame(canvas, { timestamp: index * 33_333 });
    encoder.encode(picture, { keyFrame: index === 0 });
    picture.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!chunks[0]?.key || chunks.slice(1).some((chunk) => chunk.key))
    throw new Error("The encoder must produce exactly one leading keyframe.");
  return {
    chunks,
    config: `${codec} (${support.config?.hardwareAcceleration ?? "no-preference"})`,
    keyUnits: nalTypes(chunks[0].bytes),
  };
}

/** One viewer pipeline: the client transport, a shared picture and its canvas. */
function start(
  acceleration: HardwareAcceleration,
  connect?: () => WebSocketClient,
  source: ComputerDisplayTarget["source"] = { kind: "task-session", sessionId },
) {
  timeline.length = 0;
  draws.length = 0;
  markerPixel = null;
  decoderControl.takenTotal = 0;
  const started = performance.now();
  let host: HostSocket | null = null;
  const streams = new DisplayStreams({
    connect: connect ?? (() => (host = new HostSocket())),
    retryDelay: () => 60_000,
  });
  const target: ComputerDisplayTarget = { scope: "smoke", source };
  const { picture, release } = retainPhoneDisplayPicture(streams, target, acceleration);
  const view = streams.retain(target);
  let canvas: HTMLCanvasElement | null = null;
  return {
    picture,
    streams,
    target,
    lease: () => view.getSnapshot(),
    canvas(width: number, height: number, fill: Rgb) {
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      document.body.append(canvas);
      const context = canvas.getContext("2d", { alpha: false })!;
      context.fillStyle = `rgb(${fill.join(" ")})`;
      context.fillRect(0, 0, width, height);
      picture.attach(canvas);
      return canvas;
    },
    async socket(previous?: HostSocket): Promise<HostSocket> {
      await until(() => host?.readyState === 1 && host !== previous);
      return host!;
    },
    finish(
      socket: HostSocket | null,
      result: Pick<DisplaySmokeScenario, "checks" | "samples">,
    ): DisplaySmokeScenario {
      const stats = { ...picture.stats };
      view.release();
      release();
      canvas?.remove();
      return {
        ...result,
        timeline: [...timeline],
        maxOutstanding: socket?.maxOutstanding ?? 0,
        stats,
        elapsedMs: Math.round(performance.now() - started),
      };
    },
  };
}

function live(generation: number, width: number, height: number) {
  return { type: "display.state", state: "live", generation, width, height } as const;
}

interface Envelope {
  readonly sequence: number;
  readonly key: boolean;
  readonly bytes: Uint8Array;
}

function envelope(header: DisplayViewerFrameHeader, payload: Uint8Array): Envelope {
  return {
    sequence: header.sequence,
    key: header.key,
    bytes: encodeDisplayViewerFrame(header, payload),
  };
}

/** A recorded viewer envelope's header, read the way the transport reads it. */
function viewerHeader(bytes: Uint8Array): DisplayViewerFrameHeader {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  return JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + length)),
  ) as DisplayViewerFrameHeader;
}

function payloadOf(bytes: Uint8Array): Uint8Array {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  return bytes.subarray(4 + length);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** NAL unit types in an Annex B access unit: a phone keyframe is 7 (SPS), 8 (PPS), 5 (IDR). */
function nalTypes(bytes: Uint8Array): number[] {
  const types: number[] = [];
  for (let index = 0; index + 3 < bytes.length; index += 1)
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      types.push(bytes[index + 3]! & 0x1f);
      index += 2;
    }
  return types;
}

function sample(canvas: HTMLCanvasElement, x: number, y: number): Rgb {
  const [red = 0, green = 0, blue = 0] = canvas
    .getContext("2d", { alpha: false })!
    .getImageData(x, y, 1, 1).data;
  return [red, green, blue];
}

function gridSamples(canvas: HTMLCanvasElement, width: number, height: number) {
  const samples: Record<string, Rgb> = {};
  for (const x of [1, width / 2, width - 2])
    for (const y of [1, height / 2, height - 2])
      samples[`${Math.round(x)},${Math.round(y)}`] = sample(canvas, Math.round(x), Math.round(y));
  return samples;
}

/** Within lossy H.264 and 4:2:0 colour of the colour drawn. */
function near(actual: Rgb, expected: Rgb): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= 24);
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function until(reached: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!reached()) {
    if (performance.now() > deadline) throw new Error(`Timed out at: ${timeline.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
