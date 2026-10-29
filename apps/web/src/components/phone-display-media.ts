import { computerDisplayTargetKey } from "@opensteer/client/integrations";
import { displayViewerCloseCodes, type DisplayViewerFrameHeader } from "@opensteer/protocol";
import type {
  DisplayFrame,
  DisplayLease,
  DisplaySnapshot,
  DisplayStreams,
  ComputerDisplayTarget,
} from "@opensteer/client/integrations";

/** Constrained Baseline at level 3.1, the phone's default 1280-pixel picture. */
const probeCodec = "avc1.42C01F";

let decoding: Promise<HardwareAcceleration | null> | null = null;
let decodingAnswer: HardwareAcceleration | null | undefined;

/**
 * Whether this browser decodes the phone's stream, asked once per page before
 * any socket opens: hardware first, for latency and power, else whatever
 * decoder it has. Null means it cannot show the phone at all.
 */
export function phoneDisplayDecoding(): Promise<HardwareAcceleration | null> {
  decoding ??= (async () => {
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined")
      return null;
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
      try {
        const { supported } = await VideoDecoder.isConfigSupported({
          codec: probeCodec,
          hardwareAcceleration,
          optimizeForLatency: true,
        });
        if (supported) return hardwareAcceleration;
      } catch {
        // An unanswerable configuration is an unsupported one.
      }
    }
    return null;
  })().then((answer) => (decodingAnswer = answer));
  return decoding;
}

/** The answer `phoneDisplayDecoding` already has; undefined until it has one. */
export function knownPhoneDisplayDecoding(): HardwareAcceleration | null | undefined {
  return decodingAnswer;
}

/**
 * The phone's H.264 through WebCodecs. Each generation is configured from its
 * keyframe's codec, Annex B in band with no description; deltas wait for
 * their generation's keyframe. Every frame pushed is marked done exactly
 * once and in order: when the decoder takes it off its queue, or when it is
 * dropped unshown. Credit never waits for output, which a decoder may hold
 * back for a reorder window however static the screen.
 *
 * There is no queue bound here. The Host's live credit bounds live frames,
 * and a replay is bounded by bytes; skipping part of a replay of a static
 * screen would wait for a keyframe that never comes.
 */
export class PhoneDisplayDecoder {
  readonly #onPicture: (picture: VideoFrame, frame: DisplayFrame) => void;
  readonly #onWaiting: () => void;
  readonly #onLost: () => void;
  /** Frames given to the decoder and not yet off its queue, oldest first. */
  #queued: DisplayFrame[] = [];
  /**
   * Frames awaiting output, by the chunk timestamp this decoder gave them:
   * a replay repeats sequences that may still be decoding, so they cannot name frames.
   */
  readonly #pending = new Map<number, DisplayFrame>();
  #chunks = 0;
  #acceleration: HardwareAcceleration;
  #decoder: VideoDecoder | null = null;
  #codec: string | null = null;
  #generation = 0;
  #connection: number | null = null;
  #waitingForKey = true;
  /** Counts for diagnostics; `configuration` is the newest codec and acceleration. */
  readonly stats = { decoded: 0, dropped: 0, errors: 0, configures: 0, configuration: "" };

  constructor(options: {
    readonly acceleration: HardwareAcceleration;
    /** Owns the picture from here: close it once it is superseded. */
    readonly onPicture: (picture: VideoFrame, frame: DisplayFrame) => void;
    readonly onWaiting?: () => void;
    /** The decoder failed or could not be configured: only a keyframe recovers it. */
    readonly onLost?: () => void;
  }) {
    this.#acceleration = options.acceleration;
    this.#onPicture = options.onPicture;
    this.#onWaiting = options.onWaiting ?? (() => undefined);
    this.#onLost = options.onLost ?? (() => undefined);
  }

  /** Frames are being dropped until the next keyframe. */
  get waitingForKey(): boolean {
    return this.#waitingForKey;
  }

  push(frame: DisplayFrame): void {
    const { header } = frame;
    // A new socket may be a new stream: its numbering owes nothing to the last.
    if (frame.connection !== this.#connection) {
      this.reset();
      this.#connection = frame.connection;
    }
    if (header.key) {
      if (
        header.generation !== this.#generation ||
        header.codec !== this.#codec ||
        this.#decoder?.state !== "configured"
      ) {
        if (!header.codec || !this.#configure(header.codec)) {
          this.#drop(frame);
          return;
        }
        this.#generation = header.generation;
      }
      this.#setWaiting(false);
    } else if (this.#waitingForKey || header.generation !== this.#generation) {
      this.#drop(frame);
      return;
    }
    const decoder = this.#decoder;
    if (!decoder) {
      this.#drop(frame);
      return;
    }
    const chunk = this.#chunks++;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          timestamp: chunk,
          type: header.key ? "key" : "delta",
          data: frame.payload,
        }),
      );
      this.#pending.set(chunk, frame);
      this.#queued.push(frame);
    } catch {
      this.#drop(frame);
      this.#failed(decoder);
    }
  }

  /** Drops everything in flight; the next picture starts at a keyframe. */
  reset(): void {
    if (this.#decoder?.state === "configured") this.#decoder.reset();
    this.#codec = null;
    this.#release();
  }

  close(): void {
    const decoder = this.#decoder;
    this.#decoder = null;
    this.#codec = null;
    if (decoder && decoder.state !== "closed") decoder.close();
    this.#release();
  }

  #configure(codec: string): boolean {
    let decoder = this.#decoder;
    if (!decoder || decoder.state === "closed") {
      const created: VideoDecoder = new VideoDecoder({
        output: (picture) => this.#output(created, picture),
        error: () => this.#failed(created),
      });
      created.addEventListener("dequeue", () => this.#taken(created));
      decoder = created;
      this.#decoder = created;
    }
    try {
      decoder.configure({
        codec,
        hardwareAcceleration: this.#acceleration,
        optimizeForLatency: true,
      });
    } catch {
      this.#failed(decoder);
      return false;
    }
    this.#codec = codec;
    this.stats.configures += 1;
    this.stats.configuration = `${codec} ${this.#acceleration}`;
    return true;
  }

  /** The decoder took frames off its queue: their credit goes back, oldest first. */
  #taken(decoder: VideoDecoder): void {
    if (decoder !== this.#decoder) return;
    while (this.#queued.length > decoder.decodeQueueSize) this.#queued.shift()!.done();
  }

  #output(decoder: VideoDecoder, picture: VideoFrame): void {
    const chunk = picture.timestamp;
    const frame = decoder === this.#decoder ? this.#pending.get(chunk) : undefined;
    if (!frame) {
      picture.close();
      return;
    }
    // Output proves the decoder took this chunk, whenever `dequeue` fires.
    this.#taken(decoder);
    // Output is in decode order: anything earlier that never came out was skipped.
    for (const earlier of this.#pending.keys()) {
      if (earlier >= chunk) break;
      this.#pending.delete(earlier);
    }
    this.#pending.delete(chunk);
    this.stats.decoded += 1;
    this.#onPicture(picture, frame);
  }

  /** The decoder closed itself: what it held is lost, and the next keyframe starts over. */
  #failed(decoder: VideoDecoder): void {
    if (decoder !== this.#decoder) return;
    this.stats.errors += 1;
    this.#decoder = null;
    this.#codec = null;
    if (decoder.state !== "closed") decoder.close();
    // A hardware decoder that fails may fail again; software decodes the same stream.
    if (this.#acceleration === "prefer-hardware") this.#acceleration = "no-preference";
    this.#release();
    this.#onLost();
  }

  #release(): void {
    const queued = this.#queued;
    this.#queued = [];
    this.#pending.clear();
    for (const frame of queued) this.#drop(frame);
    this.#setWaiting(true);
  }

  #drop(frame: DisplayFrame): void {
    this.stats.dropped += 1;
    frame.done();
  }

  #setWaiting(waiting: boolean): void {
    if (this.#waitingForKey === waiting) return;
    this.#waitingForKey = waiting;
    this.#onWaiting();
  }
}

/** What the canvases of one phone display show. */
export interface PhoneDisplayPictureState {
  /**
   * The shown picture is from a socket before the current one: it stays on
   * screen but takes no input until the current socket draws one.
   */
  readonly stale: boolean;
  /** The picture drawn; null before the first and after protection or an end. */
  readonly shown: {
    readonly generation: number;
    readonly width: number;
    readonly height: number;
  } | null;
  /** The newest geometry generation the current socket has sent frames of. */
  readonly generation: number;
  /** Frames are dropped until a keyframe; the shown picture may lag the phone. */
  readonly waitingForKey: boolean;
}

/**
 * When the picture must leave the screen at once: the phone hid it, the
 * stream stopped, failed or cannot start, the socket closed for good, or the
 * login that admitted it ended. A new generation, a dark screen, a lost decoder
 * or a transient reconnect keeps the last picture, which stays true until
 * something newer decodes.
 */
function hidesPicture({ connection, closeCode, display }: DisplaySnapshot): boolean {
  return (
    connection === "closed" ||
    closeCode === displayViewerCloseCodes.loginEnded ||
    display?.state === "protected" ||
    display?.state === "screen-off" ||
    display?.state === "stopped" ||
    display?.state === "failed" ||
    display?.state === "unsupported"
  );
}

/**
 * One decoder per phone session, however many views draw it: the newest
 * decoded picture is drawn into every attached canvas on the next animation
 * frame and kept for canvases that attach later. A picture superseded before
 * it was drawn is closed unseen, and a replayed one is never drawn, so a
 * joiner's first picture is the screen as it is now.
 */
export class PhoneDisplayPicture {
  readonly #lease: DisplayLease;
  readonly #decoder: PhoneDisplayDecoder;
  readonly #canvases = new Set<HTMLCanvasElement>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #latest: {
    readonly picture: VideoFrame;
    readonly header: DisplayViewerFrameHeader;
    readonly connection: number;
  } | null = null;
  /** The socket whose pictures are current again after a reconnect. */
  #current: number | null = null;
  #drawRequest: number | null = null;
  #connection: number | null = null;
  #state: PhoneDisplayPictureState = {
    shown: null,
    stale: false,
    generation: 0,
    waitingForKey: true,
  };
  #disposed = false;

  constructor(lease: DisplayLease, acceleration: HardwareAcceleration) {
    this.#lease = lease;
    this.#decoder = new PhoneDisplayDecoder({
      acceleration,
      onPicture: (picture, frame) => this.#accept(picture, frame),
      onWaiting: () => this.#update({ waitingForKey: this.#decoder.waitingForKey }),
      // The last picture stays while the Host replays from a keyframe.
      onLost: () => lease.requestKeyframe(),
    });
    const unframe = lease.onFrame((frame) => this.#push(frame));
    const unlisten = lease.subscribe(() => {
      const snapshot = lease.getSnapshot();
      if (hidesPicture(snapshot)) this.clear();
      else if (snapshot.connection !== "open" && this.#state.shown) {
        this.#current = null;
        this.#update({ stale: true });
      }
    });
    this.#unsubscribe = () => {
      unframe();
      unlisten();
    };
  }

  get stats(): PhoneDisplayDecoder["stats"] {
    return this.#decoder.stats;
  }

  getSnapshot = (): PhoneDisplayPictureState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Draws into this canvas from now on, starting with the current picture. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.#canvases.add(canvas);
    if (this.#latest) this.#requestDraw();
    return () => this.#canvases.delete(canvas);
  }

  /** Nothing of the phone stays on screen, and nothing in flight is drawn later. */
  clear(): void {
    this.#decoder.reset();
    this.#latest?.picture.close();
    this.#latest = null;
    if (this.#drawRequest !== null) cancelAnimationFrame(this.#drawRequest);
    this.#drawRequest = null;
    for (const canvas of this.#canvases)
      canvas.getContext("2d", { alpha: false })?.clearRect(0, 0, canvas.width, canvas.height);
    this.#update({ shown: null, stale: false });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.clear();
    this.#decoder.close();
    this.#canvases.clear();
    this.#listeners.clear();
    this.#lease.release();
  }

  #push(frame: DisplayFrame): void {
    // Defence in depth: the Host forwards nothing while the phone is hidden.
    if (this.#disposed || hidesPicture(this.#lease.getSnapshot())) {
      frame.done();
      return;
    }
    const { generation } = frame.header;
    if (frame.connection !== this.#connection) {
      // The decoder starts over at the new socket's keyframe and drops what the
      // last socket left in flight; the last picture stays until one decodes.
      this.#connection = frame.connection;
      this.#current = frame.connection;
      this.#update({ generation });
    } else if (generation > this.#state.generation) this.#update({ generation });
    this.#decoder.push(frame);
  }

  #accept(picture: VideoFrame, { connection, header, replayed }: DisplayFrame): void {
    // A replayed frame only builds decoder state for the one the replay ends at.
    if (this.#disposed || replayed) {
      picture.close();
      return;
    }
    this.#latest?.picture.close();
    this.#latest = { picture, header, connection };
    this.#requestDraw();
  }

  #requestDraw(): void {
    this.#drawRequest ??= requestAnimationFrame(() => {
      this.#drawRequest = null;
      this.#draw();
    });
  }

  #draw(): void {
    const latest = this.#latest;
    if (!latest) return;
    const { width, height, generation } = latest.header;
    for (const canvas of this.#canvases) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // The header's size is the picture input is normalised to; draw to exactly it.
      canvas.getContext("2d", { alpha: false })?.drawImage(latest.picture, 0, 0, width, height);
    }
    const shown = this.#state.shown;
    const stale = this.#state.stale && latest.connection !== this.#current;
    if (
      shown?.generation !== generation ||
      shown.width !== width ||
      shown.height !== height ||
      stale !== this.#state.stale
    )
      this.#update({ shown: { generation, width, height }, stale });
  }

  #update(patch: Partial<PhoneDisplayPictureState>): void {
    const next = { ...this.#state, ...patch };
    if (
      next.shown === this.#state.shown &&
      next.stale === this.#state.stale &&
      next.generation === this.#state.generation &&
      next.waitingForKey === this.#state.waitingForKey
    )
      return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

const pictures = new WeakMap<
  DisplayStreams,
  Map<string, { readonly picture: PhoneDisplayPicture; holds: number }>
>();

/**
 * The one picture of a phone session in this client, shared by every view of
 * it; the last view to let go disposes it and its socket hold.
 */
export function retainPhoneDisplayPicture(
  streams: DisplayStreams,
  target: ComputerDisplayTarget,
  acceleration: HardwareAcceleration,
): { readonly picture: PhoneDisplayPicture; readonly release: () => void } {
  let pool = pictures.get(streams);
  if (!pool) {
    pool = new Map();
    pictures.set(streams, pool);
  }
  const key = computerDisplayTargetKey(target);
  let held = pool.get(key);
  if (!held) {
    held = { picture: new PhoneDisplayPicture(streams.retain(target), acceleration), holds: 0 };
    pool.set(key, held);
  }
  const entry = held;
  const shared = pool;
  entry.holds += 1;
  let released = false;
  return {
    picture: entry.picture,
    release: () => {
      if (released) return;
      released = true;
      entry.holds -= 1;
      if (entry.holds > 0) return;
      if (shared.get(key) === entry) shared.delete(key);
      entry.picture.dispose();
    },
  };
}
