import { ComputerViewIdSchema, IsoDateTimeSchema } from "@opensteer/core";
import { z } from "zod";
import { ComputerUseSessionIdSchema } from "./computer-use-id.js";
import { RunnerAuxiliaryFrameFenceSchema } from "./runner-auxiliary.js";
import {
  EditingCommandSchema,
  EditingClipboardItemsSchema,
  EditingContextSchema,
  EditingKeystrokeSchema,
  EditingModifiersSchema,
  EditingTextEditSchema,
} from "./editing.js";

// Four outstanding live frames bound decoder work independently of compressed
// size. A joining viewer's cache replay is bounded by bytes alone, so catching
// up costs round trips per megabyte rather than per frame.
export const displayViewerCreditFrames = 4;
// A byte credit also bounds viewers receiving unusually large frames.
export const displayViewerCreditBytes = 1 * 1_024 * 1_024;
// The phone must drop rather than accumulate media behind its data socket.
export const displayPhoneUnackedBytes = 1 * 1_024 * 1_024;
// A time window bounds latency even when compressed frames are small.
export const displayPhoneUnackedMs = 500;
// Joining and recovering viewers share one encoder reset per interval.
export const displayRefreshCoalescingMs = 500;
// Brief viewer transitions keep the projection alive without permanent demand.
export const displayDemandGraceMs = 5_000;
// A viewer that cannot recover must not retain resources indefinitely.
export const displaySlowViewerCloseMs = 10_000;
// A single access unit has a separate bound from either socket's credits.
export const displayMaxFramePayloadBytes = 4 * 1_024 * 1_024;
// A bounded header prevents JSON metadata from exhausting a media receiver.
export const displayMaxHeaderBytes = 16 * 1_024;
// The socket can reject oversize messages before parsing their headers.
export const displayMaxEnvelopeBytes = 4 + displayMaxHeaderBytes + displayMaxFramePayloadBytes;
// Short-lived, one-use credentials admit only the requested data socket.
export const displayDataTicketTtlMs = 60_000;
// This picture size keeps text legible within the phone's encoder budget.
export const displayDefaultMaxLongSide = 1_280;
// Smaller pictures stop being useful for reading and targeting phone UI.
export const displayMinMaxLongSide = 320;
// Bound encoder and decoder cost even on high-resolution phones.
export const displayMaxMaxLongSide = 1_920;
// Thirty frames per second covers interactive use without a full-rate capture.
export const displayDefaultMaxFps = 30;
// A live stream must allow at least one frame per second.
export const displayMinMaxFps = 1;
// Cap requested frame rate independently of a device's display refresh rate.
export const displayMaxMaxFps = 60;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const DisplayStreamIdSchema = z
  .string()
  .regex(new RegExp(`^dsp_${uuid}$`, "i"))
  .brand<"DisplayStreamId">();
export type DisplayStreamId = z.infer<typeof DisplayStreamIdSchema>;
/** Read only from previous-release viewers, whose Take over named a control; never issued. */
export const LegacyDisplayControlIdSchema = z.string().regex(new RegExp(`^dcl_${uuid}$`, "i"));

/** Viewer authority is independent of the shared phone producer. */
export const DisplaySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("task-session"),
    sessionId: ComputerUseSessionIdSchema,
    appKey: z.string().min(1).max(255).optional(),
  }),
  z.strictObject({
    kind: z.literal("owner-view"),
    viewId: ComputerViewIdSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export type DisplaySource = z.infer<typeof DisplaySourceSchema>;
export const DisplayDemandSchema = z.array(DisplaySourceSchema).max(8);
export function displaySourceKey(source: DisplaySource): string {
  return source.kind === "task-session"
    ? `task:${source.sessionId}:${source.appKey ?? "phone"}`
    : `owner:${source.viewId}:${source.generation}`;
}

/** The helper mints this token for one verified process and exact window lifetime. */
export const MacWindowTargetSchema = z.strictObject({
  kind: z.literal("mac-window"),
  bindingId: z.uuid(),
  /** Only returned to a Host that offered Mac owner input on resolution. */
  editingVersion: z.literal(1).optional(),
});
export type MacWindowTarget = z.infer<typeof MacWindowTargetSchema>;
export const displayFirstFrameTimeoutMs = 30_000;
export const macDisplayMaxWindows = 2;
export const macDisplayMaxWarmWindows = 1;
export const macDisplayWarmMs = 30_000;
export const macDisplayProfileHysteresisMs = 1_000;
export const MacDisplayWarmSchema = z.strictObject({
  sources: DisplayDemandSchema.min(1),
  durationMs: z.number().int().positive().max(macDisplayWarmMs),
});

/** The complete integrations fence binds a one-use data ticket to one stream. */
export const DisplayDataTicketClaimsSchema = z.strictObject({
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  audience: z.literal("opensteer-display-data"),
  expiresAt: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  module: z.literal("integrations"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  display: z.literal("main"),
  target: MacWindowTargetSchema.optional(),
  streamId: DisplayStreamIdSchema,
  type: z.literal("opensteer.display.data-ticket"),
});
export type DisplayDataTicketClaims = z.infer<typeof DisplayDataTicketClaimsSchema>;

export const DisplayMaxLongSideSchema = z
  .number()
  .int()
  .min(displayMinMaxLongSide)
  .max(displayMaxMaxLongSide);
export const DisplayMaxFpsSchema = z.number().int().min(displayMinMaxFps).max(displayMaxMaxFps);
export const DisplayGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DisplaySequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pictureDimension = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stateDimension = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const codec = z.string().regex(/^avc1\.[0-9A-Fa-f]{6}$/);
const frameHeaderBase = {
  generation: DisplayGenerationSchema,
  sequence: DisplaySequenceSchema,
  ptsUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  key: z.boolean(),
  codec: codec.optional(),
  width: pictureDimension,
  height: pictureDimension,
};
function keyHasCodec(header: {
  readonly key: boolean;
  readonly codec?: string | undefined;
}): boolean {
  return header.key === (header.codec !== undefined);
}

/** Sequence increases for the entire stream, including across generation resets. */
export const DisplayMediaFrameHeaderSchema = z
  .strictObject({
    streamId: DisplayStreamIdSchema,
    ...frameHeaderBase,
  })
  .refine(keyHasCodec, "Only keyframes carry a required avc1 codec");
export type DisplayMediaFrameHeader = z.infer<typeof DisplayMediaFrameHeaderSchema>;
export const DisplayViewerFrameHeaderSchema = z
  .strictObject(frameHeaderBase)
  .refine(keyHasCodec, "Only keyframes carry a required avc1 codec");
export type DisplayViewerFrameHeader = z.infer<typeof DisplayViewerFrameHeaderSchema>;

/**
 * A viewer acknowledges every frame it received exactly once and in order,
 * once its decoder has taken the frame off its queue or the viewer chose to
 * drop it. Credit then bounds queued decoder work without depending on how many
 * frames a decoder holds before output, and a skipped delta never leaks it.
 */
export const DisplayAckSchema = z.strictObject({
  type: z.literal("display.ack"),
  sequence: DisplaySequenceSchema,
});
export type DisplayAck = z.infer<typeof DisplayAckSchema>;
export const DisplayDataServerMessageSchema = DisplayAckSchema;
export type DisplayDataServerMessage = z.infer<typeof DisplayDataServerMessageSchema>;

export const DisplayStreamStateSchema = z.enum([
  "starting",
  "warming",
  "live",
  "protected",
  "screen-off",
  "stopped",
  "failed",
]);
export type DisplayStreamState = z.infer<typeof DisplayStreamStateSchema>;
export const DisplayStreamReasonSchema = z.enum([
  "permission-required",
  "encoder-failed",
  "capacity",
  "capture-timeout",
  "capture-failed",
  "window-closed",
  "minimized",
  "target-unavailable",
  "sharing-stopped",
  "projection-ended",
  "paused",
  "opensteer-app",
  "session-ended",
  "owner-ended",
  "owner-expired",
  "owner-revoked",
  "locked-screen",
  "data-socket-failed",
]);
export type DisplayStreamReason = z.infer<typeof DisplayStreamReasonSchema>;

const normalizedPoint = z.number().min(0).max(1);
/** One paste fits the Host's display frame bound even with escaped characters. */
export const displayPasteTextMaxLength = 30_000;
export const DisplayInputEventSchema = z.union([
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("pointer"),
      phase: z.enum(["down", "move", "up", "cancel"]),
      x: normalizedPoint,
      y: normalizedPoint,
      t: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      kind: z.literal("scroll"),
      x: normalizedPoint,
      y: normalizedPoint,
      // Deltas are fractions of the picture, capped at one picture per event,
      // with a mouse wheel's sense: dy > 0 reveals content below, which the
      // phone performs as an upward swipe through (x, y).
      dx: z.number().min(-1).max(1),
      dy: z.number().min(-1).max(1),
    }),
    z.strictObject({
      kind: z.literal("nav"),
      to: z.enum(["back", "home", "recents", "notifications"]),
    }),
  ]),
  z.strictObject({ kind: z.literal("text"), insert: z.string().min(1).max(1_000) }),
  z.strictObject({ kind: z.literal("text"), deleteBackward: z.number().int().min(1).max(100) }),
  z.strictObject({ kind: z.literal("text"), submit: z.literal(true) }),
  // The kinds below exist only for a producer and viewer that negotiated
  // editing (`editingVersion` in `display.state`); see editing.ts.
  z.strictObject({ kind: z.literal("key"), ...EditingKeystrokeSchema.shape }),
  z.strictObject({ kind: z.literal("command"), command: EditingCommandSchema }),
  z.strictObject({ kind: z.literal("edit"), edit: EditingTextEditSchema }),
  z.strictObject({ kind: z.literal("copy") }),
  z.strictObject({ kind: z.literal("cut"), contextId: EditingContextSchema.shape.contextId }),
  z.strictObject({
    kind: z.literal("paste"),
    text: z.string().min(1).max(displayPasteTextMaxLength),
  }),
  // Metadata alone lets a text-only display refuse rich clipboard input before uploading bytes.
  z.strictObject({ kind: z.literal("paste"), items: EditingClipboardItemsSchema }),
  // A mouse on a Mac app: buttons, hover and modifiers, unlike a phone's touch.
  z.strictObject({
    kind: z.literal("mouse"),
    phase: z.enum(["down", "move", "up", "cancel"]),
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: EditingModifiersSchema,
    x: normalizedPoint,
    y: normalizedPoint,
  }),
]);
export type DisplayInputEvent = z.infer<typeof DisplayInputEventSchema>;
export const DisplayInputEventsSchema = z.array(DisplayInputEventSchema).min(1).max(64);
export type DisplayInputEvents = z.infer<typeof DisplayInputEventsSchema>;
/**
 * Updates what a viewer still holds on a display (a touch, mouse buttons,
 * keys) after one of its events. The Host's person lane and a client sharing
 * one socket among several views keep the same account of it.
 */
export function trackHeldDisplayInput(held: Set<string>, event: DisplayInputEvent): void {
  if (event.kind === "pointer" || event.kind === "mouse") {
    const key = event.kind === "pointer" ? "pointer" : `mouse:${event.button}`;
    if (event.phase === "down") held.add(key);
    else if (event.phase === "up") held.delete(key);
    else if (event.phase === "cancel")
      for (const item of held)
        if (event.kind === "pointer" ? item === "pointer" : item.startsWith("mouse:"))
          held.delete(item);
  } else if (event.kind === "key") {
    if (event.action === "down") held.add(`key:${event.code}`);
    else held.delete(`key:${event.code}`);
  }
}
/**
 * One batch of a person's input. A viewer numbers its own batches; the Host
 * renumbers them into the display's single person lane for the producer.
 */
export const DisplayInputSchema = z.strictObject({
  geometry: DisplayGenerationSchema,
  sequence: DisplaySequenceSchema,
  events: DisplayInputEventsSchema,
});
export type DisplayInput = z.infer<typeof DisplayInputSchema>;

/** Zero geometry represents a stream that has not produced a picture yet. */
export const DisplayViewerStateSchema = z.strictObject({
  type: z.literal("display.state"),
  state: z.enum([...DisplayStreamStateSchema.options, "unsupported"]),
  reason: DisplayStreamReasonSchema.optional(),
  generation: stateDimension,
  width: stateDimension,
  height: stateDimension,
  /**
   * The last sequence of the cached frames that follow this state: the viewer
   * decodes them but shows nothing older than this frame, so catching up never
   * plays stale pictures.
   */
  replayThrough: DisplaySequenceSchema.optional(),
  /** The producer applies editing input; projected only to viewers that connected with `editing=1`. */
  editingVersion: z.literal(1).optional(),
  /** Requires the producer capability and viewer editing=1&displayCut=1. */
  displayCut: z.literal(1).optional(),
  /**
   * This viewer may send `display.input` alongside the agent. Projected only to
   * viewers that connected with sharedInput=1, while the producer negotiated
   * shared input and this viewer is allowed to use it.
   */
  sharedInput: z.literal(1).optional(),
  phoneOwnerControl: z.literal(1).optional(),
});
export type DisplayViewerState = z.infer<typeof DisplayViewerStateSchema>;
/**
 * The only answer a previous-release viewer's Take over request receives.
 * Nothing takes control of a display, so it is never held; that release shows
 * no words for this reason and simply keeps its picture.
 */
export const LegacyDisplayViewerControlSchema = z.strictObject({
  type: z.literal("display.control"),
  state: z.literal("refused"),
  reason: z.literal("released-by-owner"),
});
export const DisplayInputRefusalSchema = z.enum([
  "no-field",
  "sensitive",
  "stale",
  "unsupported",
  "too-large",
  /** Shared input is not available to this viewer, or the producer cannot take input now. */
  "unavailable",
  /** Another viewer is still holding a touch, button or key on this display. */
  "contended",
]);
export type DisplayInputRefusal = z.infer<typeof DisplayInputRefusalSchema>;
/**
 * What became of one `display.input` batch, for the viewer that sent it.
 * `dispatched` means the producer handed it to the target, never that the
 * target applied it.
 */
export const DisplayInputResultSchema = z.strictObject({
  type: z.literal("display.input.result"),
  sequence: DisplaySequenceSchema,
  outcome: z.enum(["dispatched", "refused", "stale"]),
  reason: DisplayInputRefusalSchema.optional(),
});
export type DisplayInputResult = z.infer<typeof DisplayInputResultSchema>;
export const DisplayPowerSchema = z.strictObject({
  type: z.literal("display.power"),
  sequence: DisplaySequenceSchema,
  action: z.enum(["wake", "lock"]),
});
export const DisplayPowerResultSchema = z.strictObject({
  type: z.literal("display.power.result"),
  sequence: DisplaySequenceSchema,
  outcome: z.enum(["dispatched", "refused"]),
  reason: DisplayInputRefusalSchema.optional(),
});
/** The focused field on the target, caret in normalized picture coordinates. */
export const DisplayEditingSchema = z.strictObject({
  type: z.literal("display.editing"),
  generation: DisplayGenerationSchema,
  context: EditingContextSchema,
});
export type DisplayEditing = z.infer<typeof DisplayEditingSchema>;
/** The selected text a viewer's `copy` or `cut` read; nothing for a secret field. */
export const DisplayClipboardSchema = z.strictObject({
  type: z.literal("display.clipboard"),
  sequence: DisplaySequenceSchema,
  outcome: z.enum(["copied", "cut", "empty", "refused", "too-large"]),
  text: z.string().min(1).max(displayPasteTextMaxLength).optional(),
});
export type DisplayClipboard = z.infer<typeof DisplayClipboardSchema>;
export const DisplayViewerServerMessageSchema = z.discriminatedUnion("type", [
  DisplayViewerStateSchema,
  DisplayInputResultSchema,
  DisplayPowerResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
]);
export type DisplayViewerServerMessage = z.infer<typeof DisplayViewerServerMessageSchema>;
export const DisplayViewerClientMessageSchema = z.discriminatedUnion("type", [
  DisplayAckSchema,
  DisplayPowerSchema,
  z.strictObject({ type: z.literal("display.viewport"), maxLongSide: DisplayMaxLongSideSchema }),
  // The viewer lost its decoder state and needs a fresh decodable start.
  z.strictObject({ type: z.literal("display.keyframe") }),
  z.strictObject({
    type: z.literal("display.input"),
    ...DisplayInputSchema.shape,
    /** Sent only by a previous-release viewer; such a batch is never applied. */
    controlId: LegacyDisplayControlIdSchema.optional(),
  }),
  /**
   * Release everything this viewer holds on the display (touch, buttons, keys)
   * and drop its unapplied batches: it blurred, hid or is leaving. Sent only
   * after the Host projected sharedInput; the Host acts on it only from the
   * viewer currently holding the person lane.
   */
  z.strictObject({ type: z.literal("display.input-reset") }),
  /** A previous-release viewer's Take over or Give back; answered or ignored, never applied. */
  z.strictObject({ type: z.literal("display.control"), action: z.enum(["acquire", "release"]) }),
]);
export type DisplayViewerClientMessage = z.infer<typeof DisplayViewerClientMessageSchema>;

/**
 * How a display viewer socket ends. Terminal codes say the viewer must not
 * reconnect as it is; the others are transient and are retried with backoff.
 */
export const displayViewerCloseCodes = {
  /** The stream or its session ended, or the phone cannot stream. Terminal. */
  ended: 1000,
  /** The Host is shutting down. Transient. */
  hostShutdown: 1001,
  /** The login that opened the socket ended; reconnect with the current one. */
  loginEnded: 1008,
  /** A message exceeded its bound. Terminal. */
  tooLarge: 1009,
  /** The viewer fell behind or the phone's stream is restarting. Transient. */
  tryAgain: 1013,
  /** The viewer broke the protocol. Terminal. */
  protocolViolation: 4002,
  /** The viewer is no longer allowed to watch this session. Terminal. */
  accessEnded: 4003,
} as const;

/** Whether a viewer should reconnect after its socket closed with `code`. */
export function isRetryableDisplayViewerClose(code: number): boolean {
  return (
    code === displayViewerCloseCodes.hostShutdown ||
    code === displayViewerCloseCodes.loginEnded ||
    code === displayViewerCloseCodes.tryAgain ||
    // No status, an abnormal close, a server error or a service restart come
    // from the transport or a proxy between viewer and Host, not from the Host
    // deciding this viewer may not watch.
    code === 1005 ||
    code === 1006 ||
    code === 1011 ||
    code === 1012
  );
}

/**
 * Payload is one Annex B access unit; producers prepend SPS/PPS before every
 * keyframe's IDR. The envelope bounds bytes without interpreting H.264 slices.
 */
export function encodeDisplayMediaFrame(
  header: DisplayMediaFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  return encodeEnvelope(DisplayMediaFrameHeaderSchema.parse(header), payload);
}
export function decodeDisplayMediaFrame(value: Uint8Array): {
  readonly header: DisplayMediaFrameHeader;
  readonly payload: Uint8Array;
} {
  const { header, payload } = decodeEnvelope(value);
  return { header: DisplayMediaFrameHeaderSchema.parse(header), payload };
}
export function encodeDisplayViewerFrame(
  header: DisplayViewerFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  return encodeEnvelope(DisplayViewerFrameHeaderSchema.parse(header), payload);
}
export function decodeDisplayViewerFrame(value: Uint8Array): {
  readonly header: DisplayViewerFrameHeader;
  readonly payload: Uint8Array;
} {
  const { header, payload } = decodeEnvelope(value);
  return { header: DisplayViewerFrameHeaderSchema.parse(header), payload };
}
function validatePayload(payload: Uint8Array): void {
  if (payload.byteLength < 1 || payload.byteLength > displayMaxFramePayloadBytes)
    throw new Error("Invalid display frame payload size.");
}
function encodeEnvelope(
  header: DisplayViewerFrameHeader | DisplayMediaFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  validatePayload(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  if (bytes.byteLength > displayMaxHeaderBytes)
    throw new Error("Invalid display frame header size.");
  const result = new Uint8Array(4 + bytes.byteLength + payload.byteLength);
  new DataView(result.buffer).setUint32(0, bytes.byteLength, false);
  result.set(bytes, 4);
  result.set(payload, 4 + bytes.byteLength);
  return result;
}
function decodeEnvelope(value: Uint8Array): {
  readonly header: unknown;
  readonly payload: Uint8Array;
} {
  if (value.byteLength < 7 || value.byteLength > displayMaxEnvelopeBytes)
    throw new Error("Invalid display frame size.");
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(
    0,
    false,
  );
  if (
    headerLength < 2 ||
    headerLength > displayMaxHeaderBytes ||
    4 + headerLength >= value.byteLength
  )
    throw new Error("Invalid display frame header size.");
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(4, 4 + headerLength)),
    );
  } catch (cause) {
    throw new Error("Invalid display frame JSON header.", { cause });
  }
  const payload = value.subarray(4 + headerLength);
  validatePayload(payload);
  return { header, payload };
}

/** Fixed lifecycle vocabulary; never accepts application or document content. */
export const DisplayClientDiagnosticSchema = z.strictObject({
  transition: z.enum([
    "visibility",
    "retain",
    "release",
    "socket-open",
    "socket-close",
    "retry-scheduled",
    "retry-cancelled",
    "protocol-violation",
  ]),
  reason: z
    .enum([
      "visible",
      "page-hidden",
      "not-in-view",
      "conversation-hidden",
      "destination-changed",
      "unmount",
      "disabled",
      "unavailable",
      "stopping",
      "source-invalidated",
      "out-of-order",
      "invalid-message",
      "last-viewer",
      "socket",
      "unrecognized",
    ])
    .optional(),
  kind: z.enum(["owner-view", "task-session"]).optional(),
  sessionId: ComputerUseSessionIdSchema.optional(),
  viewId: ComputerViewIdSchema.optional(),
  generation: z.number().int().nonnegative().optional(),
  documentVisibility: z.enum(["visible", "hidden", "prerender", "unavailable"]).optional(),
  nativeVisible: z.boolean().optional(),
  visible: z.boolean().optional(),
  code: z.number().int().nonnegative().optional(),
  socketReason: z
    .enum([
      ...DisplayStreamReasonSchema.options,
      "Display authorization ended",
      "Display login expired",
      "Display authorization unavailable",
      "Invalid display command",
      "Display input too large",
      "Display input queue exceeded",
      "Display stream unavailable",
      "Display unsupported",
      "Window fence ended",
      "Display authority ended",
      "Too many display viewers",
      "Display socket buffer exceeded",
      "Display send failed",
      "Display stopped",
      "Display data socket ended",
      "Display data socket failed",
      "Display fence ended",
      "Display session ended",
      "Display start timed out",
      "Warm capacity eviction",
      "Phone disconnected",
      "Host stopping",
      "Display viewer closed",
      "Invalid display message",
      "Window target changed",
      "Display viewer stalled",
      "Display demand ended",
      "Window capture failed",
      "",
      "unrecognized",
    ])
    .optional(),
  connection: z.number().int().nonnegative().optional(),
  previousSequence: z.number().int().min(-1).optional(),
  incomingSequence: z.number().int().nonnegative().optional(),
  previousGeneration: z.number().int().nonnegative().optional(),
  incomingGeneration: z.number().int().nonnegative().optional(),
  delayMs: z.number().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
  suppressed: z.number().int().nonnegative().optional(),
});
export type DisplayClientDiagnostic = z.input<typeof DisplayClientDiagnosticSchema>;

/** An additive helper event consumed only by Desktop, never relayed to the Host. */
export const MacVideoDiagnosticEnvelopeSchema = z.strictObject({
  event: z.literal("display.diagnostic"),
  params: z.strictObject({
    streamId: DisplayStreamIdSchema,
    event: z.enum(["native-start-error", "producer-stalled", "producer-resumed"]),
    generation: z.number().int().nonnegative(),
    operation: z.enum(["plan", "encoder", "start", "filter", "configuration"]).optional(),
    domain: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,160}$/)
      .optional(),
    code: z.number().int().optional(),
    helperCode: z
      .string()
      .regex(/^[a-z-]{1,64}$/)
      .optional(),
    inFlight: z.number().int().nonnegative().optional(),
    outstanding: z.number().int().nonnegative().optional(),
    outstandingBytes: z.number().int().nonnegative().optional(),
    oldestAckAgeMs: z.number().nonnegative().optional(),
    noSubmissionMs: z.number().nonnegative().optional(),
  }),
});
