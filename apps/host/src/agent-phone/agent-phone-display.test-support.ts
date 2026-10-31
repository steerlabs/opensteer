import type { NativeViewerSource } from "@opensteer/client/host";
import {
  decodeDisplayViewerFrame,
  DisplayViewerClientMessageSchema,
  DisplayViewerServerMessageSchema,
  type DisplayViewerClientMessage,
  type DisplayViewerFrameHeader,
  type DisplayViewerServerMessage,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import WebSocket from "ws";
import { z } from "zod";

/** NAL boundaries only: emulation-prevention bytes inside the RBSP stay intact. */
export function annexBNals(bytes: Uint8Array): { type: number; bytes: Uint8Array }[] {
  const starts: { offset: number; length: number }[] = [];
  for (let offset = 0; offset + 2 < bytes.length; offset += 1) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    const length =
      bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
    if (length) {
      starts.push({ offset, length });
      offset += length - 1;
    }
  }
  if (!starts.length || bytes.subarray(0, starts[0]!.offset).some((byte) => byte !== 0))
    throw new Error("Missing Annex B start code or nonzero leading bytes.");
  return starts.map((start, index) => {
    let end = starts[index + 1]?.offset ?? bytes.length;
    while (end > start.offset + start.length && bytes[end - 1] === 0) end -= 1;
    const nal = bytes.subarray(start.offset + start.length, end);
    const first = nal[0];
    if (first === undefined || (first & 0x80) !== 0 || (first & 0x1f) === 0 || (first & 0x1f) > 23)
      throw new Error("Empty or invalid Annex B NAL unit.");
    return { bytes: nal, type: first & 0x1f };
  });
}

export function assertSelfContainedKeyframe(
  header: DisplayViewerFrameHeader,
  payload: Uint8Array,
): number[] {
  if (!header.key || !header.codec) throw new Error("Expected a keyframe and codec.");
  const nals = annexBNals(payload);
  const sps = nals.findIndex((nal) => nal.type === 7);
  const pps = nals.findIndex((nal) => nal.type === 8);
  const idr = nals.findIndex((nal) => nal.type === 5);
  if (sps < 0 || pps <= sps || idr <= pps)
    throw new Error("Keyframe must contain SPS, PPS then IDR.");
  const parameters = nals[sps]!.bytes;
  if (parameters.length < 5) throw new Error("Truncated SPS profile/constraints/level.");
  const codec = `avc1.${Buffer.from(parameters.subarray(1, 4)).toString("hex")}`;
  if (header.codec.toLowerCase() !== codec)
    throw new Error(`SPS codec ${codec} != ${header.codec}.`);
  return nals.map((nal) => nal.type);
}

export interface ReceivedFrame {
  readonly header: DisplayViewerFrameHeader;
  readonly receivedMs: number;
  readonly bytes: number;
  readonly wireBytes: number;
  readonly nalTypes: readonly number[];
  readonly payload: Uint8Array;
}
export type DisplayEvent =
  | { readonly kind: "frame"; readonly frame: ReceivedFrame }
  | {
      readonly kind: "message";
      readonly message: DisplayViewerServerMessage;
      readonly receivedMs: number;
    }
  | {
      readonly kind: "close";
      readonly code: number;
      readonly reason: string;
      readonly receivedMs: number;
    };

/** Audits every received frame, including ones between a phase's awaited events. */
export class DisplayTrace {
  readonly frames: ReceivedFrame[] = [];
  readonly events: DisplayEvent[] = [];
  #state: string = "starting";
  #protectedGeneration: number | null = null;
  #sequence = -1;
  #replaying = false;

  message(message: DisplayViewerServerMessage, receivedMs: number): void {
    this.events.push({ kind: "message", message, receivedMs });
    if (message.type !== "display.state") return;
    this.#state = message.state;
    if (message.replayThrough !== undefined) {
      this.#sequence = -1;
      this.#replaying = true;
    }
    if (["protected", "stopped", "screen-off"].includes(message.state))
      this.#protectedGeneration = Math.max(
        this.#protectedGeneration ?? 0,
        message.generation,
        this.frames.at(-1)?.header.generation ?? 0,
      );
  }

  frame(
    header: DisplayViewerFrameHeader,
    payload: Uint8Array,
    receivedMs: number,
    wireBytes = 4 + Buffer.byteLength(JSON.stringify(header)) + payload.byteLength,
  ): ReceivedFrame {
    if (!["live", "starting"].includes(this.#state))
      throw new Error(`Frame published while ${this.#state}.`);
    const previous = this.frames.at(-1)?.header;
    if (header.sequence <= this.#sequence) throw new Error("Frame sequence did not increase.");
    if (previous && header.generation < previous.generation)
      throw new Error("Frame generation regressed.");
    if (this.#protectedGeneration !== null && header.generation <= this.#protectedGeneration)
      throw new Error("Protection lifted without a new generation.");
    if (
      (!previous ||
        this.#replaying ||
        header.generation !== previous.generation ||
        this.#protectedGeneration !== null) &&
      !header.key
    )
      throw new Error("Generation did not start with a keyframe.");
    const nalTypes = header.key
      ? assertSelfContainedKeyframe(header, payload)
      : annexBNals(payload).map((nal) => nal.type);
    const frame = { header, payload, receivedMs, bytes: payload.byteLength, wireBytes, nalTypes };
    this.frames.push(frame);
    this.events.push({ kind: "frame", frame });
    this.#protectedGeneration = null;
    this.#sequence = header.sequence;
    this.#replaying = false;
    return frame;
  }
}

export function displayRates(frames: readonly ReceivedFrame[], startMs: number, endMs: number) {
  if (endMs <= startMs) throw new Error("Measurement window must be positive.");
  const sample = frames.filter((frame) => frame.receivedMs >= startMs && frame.receivedMs < endMs);
  const seconds = (endMs - startMs) / 1000;
  return {
    startMs,
    endMs,
    frames: sample.length,
    fps: sample.length / seconds,
    bytesPerSecond: sample.reduce((sum, frame) => sum + frame.wireBytes, 0) / seconds,
    payloadBytesPerSecond: sample.reduce((sum, frame) => sum + frame.bytes, 0) / seconds,
    receiveCadenceMs: sample
      .slice(1)
      .map((frame, index) => frame.receivedMs - sample[index]!.receivedMs),
  };
}

const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  t: z.number().nonnegative(),
});
/** Expected fixture `drag_path` detail: JSON [{x,y,t}], screen px and Android monotonic ms. */
export function parseDragPath(
  detail: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const points = z.array(PointSchema).min(3).parse(JSON.parse(detail));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) throw new Error("Drag endpoints must differ.");
  const progress = (point: { x: number; y: number }) =>
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
  for (let index = 1; index < points.length; index += 1) {
    if (
      points[index]!.t < points[index - 1]!.t ||
      progress(points[index]!) < progress(points[index - 1]!) - 0.02
    )
      throw new Error("Device drag path is not monotonic.");
  }
  if (progress(points[0]!) > 0.1 || progress(points.at(-1)!) < 0.9)
    throw new Error("Device drag path did not reach its endpoints.");
  // The hold before moving is however long the sender waited for Android's
  // long press. The moves themselves are streamed over 500 ms, so the moving
  // part must take that long on the device too, not jump to the target.
  const firstMoved = points.find((point) => progress(point) > 0.02);
  const moving = firstMoved ? points.at(-1)!.t - firstMoved.t : 0;
  if (moving < 300 || moving > 2000)
    throw new Error("Device drag path's moves are outside the gesture budget.");
  return points;
}

/** A headless owner viewer: consume and validate each access unit before returning credit. */
export class ComputerDisplayViewer {
  readonly trace = new DisplayTrace();
  readonly openedMs = performance.now();
  readonly socket: WebSocket;
  failure: Error | null = null;
  closed = false;
  readonly sent: { message: DisplayViewerClientMessage; sentMs: number }[] = [];

  constructor(
    host: { origin: string; publicOrigin: string; ownerHeaders: Readonly<Record<string, string>> },
    source: NativeViewerSource,
    options: {
      readonly acknowledge?: boolean;
      readonly editing?: boolean;
      readonly phoneOwnerControl?: boolean;
    } = {},
  ) {
    const route =
      source.kind === "task-session"
        ? `/v1/computer-use/sessions/${source.sessionId}/display`
        : `/v1/computer-use/views/${source.viewId}/${source.generation}/display`;
    const url = new URL(route, host.origin);
    url.protocol = "ws:";
    url.searchParams.set("sharedInput", "1");
    if (options.phoneOwnerControl) url.searchParams.set("phoneOwnerControl", "1");
    if (options.editing) {
      url.searchParams.set("editing", "1");
      url.searchParams.set("displayCut", "1");
    }
    // Dial loopback exactly like owner RPCs; carry the real login cookie and
    // canonical Origin (and Host) through the browser-socket authentication path.
    this.socket = new WebSocket(url, {
      headers: { ...host.ownerHeaders, host: new URL(host.publicOrigin).host },
      maxPayload: 5 * 1024 * 1024,
    });
    this.socket.on("error", (error) => {
      this.failure ??= error;
    });
    this.socket.on("message", (data, binary) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        const receivedMs = performance.now();
        if (binary) {
          const frame = decodeDisplayViewerFrame(bytes);
          this.trace.frame(frame.header, frame.payload, receivedMs, bytes.byteLength);
          // This sink checks transport/NAL consumption, not pixel decoding.
          // WebCodecs output/nonblank pixels belong to the pinned Electron smoke.
          if (options.acknowledge !== false)
            this.send({ type: "display.ack", sequence: frame.header.sequence });
        } else
          this.trace.message(
            DisplayViewerServerMessageSchema.parse(JSON.parse(bytes.toString())),
            receivedMs,
          );
      } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      }
    });
    this.socket.on("close", (code, reason) => {
      this.closed = true;
      this.trace.events.push({
        kind: "close",
        code,
        reason: reason.toString(),
        receivedMs: performance.now(),
      });
    });
  }

  send(message: DisplayViewerClientMessage): void {
    this.check();
    this.socket.send(JSON.stringify(DisplayViewerClientMessageSchema.parse(message)));
    this.sent.push({ message, sentMs: performance.now() });
  }

  check(): void {
    if (this.failure) throw this.failure;
  }

  async wait<Value>(
    label: string,
    read: () => Value | undefined,
    timeoutMs = 15_000,
  ): Promise<Value> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      this.check();
      const value = read();
      if (value !== undefined) return value;
      if (this.closed) throw new Error(`Viewer closed before ${label}.`);
      if (performance.now() >= deadline) throw new Error(`Viewer timed out waiting for ${label}.`);
      await delay(10);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.socket.close();
    const deadline = performance.now() + 3000;
    while (!this.closed && performance.now() < deadline) await delay(10);
    if (!this.closed) {
      this.socket.terminate();
      throw new Error("Viewer did not close cleanly.");
    }
  }
}
