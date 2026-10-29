import { computerAppIdentityKey } from "@opensteer/integration-core";
import type { NativeViewerSource } from "../host/surfaces.js";
import {
  DisplayInputEventSchema,
  DisplayClientDiagnosticSchema,
  type DisplayClientDiagnostic,
  DisplayViewerClientMessageSchema,
  DisplayViewerServerMessageSchema,
  decodeDisplayViewerFrame,
  displayRefreshCoalescingMs,
  displayViewerCloseCodes,
  isRetryableDisplayViewerClose,
  type DisplayControlId,
  type DisplayControlReason,
  type DisplayInputEvent,
  type DisplayViewerClientMessage,
  type DisplayViewerFrameHeader,
  type DisplayViewerServerMessage,
  type DisplayViewerState,
} from "@opensteer/protocol";
import type { HostClient, HostSnapshot } from "../host/client.js";
import type { WebSocketClient } from "../host/host-session-client.js";
import { canStreamComputerDisplay } from "./computer-use.js";
import type { DisplayUnavailableReason } from "./computer-watch-status.js";

/** The contract's bound on one input batch (`DisplayInputEventsSchema`). */
const maxInputEvents = 64;
const maxInputBytes = 256 * 1_024;
/** Viewer JSON is a state or control line; anything near this is not one. */
const maxServerTextCharacters = 256 * 1_024;
const retryBaseMs = 300;
const retryMaxMs = 12_000;
/**
 * How many times a lost decoder asks for a keyframe, one coalescing interval
 * apart while the stream is live, before the view says it cannot recover.
 */
const keyframeRequests = 6;

/** One exact task or owner authority through which a reader watches a phone. */
export interface ComputerDisplayTarget {
  /** Deployment, reader and phone identity; any change creates a different pooled socket. */
  readonly scope: string;
  readonly editing?: 1;
  readonly source: NativeViewerSource;
}

export function computerDisplayTargetKey(target: ComputerDisplayTarget): string {
  const source = target.source;
  const key = JSON.stringify(
    source.kind === "task-session"
      ? [target.scope, source.kind, source.sessionId, source.appKey ?? null]
      : [target.scope, source.kind, source.viewId, source.generation],
  );
  return target.editing === 1 ? `${key}:editing=1` : key;
}

/** One H.264 access unit, held by a view until its decoder is done with it. */
export interface DisplayFrame {
  /**
   * The socket that delivered it. A new socket may join a new stream whose
   * generations and sequences start over, so a decoder starts over with it.
   */
  readonly connection: number;
  readonly header: DisplayViewerFrameHeader;
  readonly payload: Uint8Array;
  /**
   * A cached frame older than its replay's `replayThrough`: decode it so the
   * frames after it decode, but never show it, so catching up plays nothing stale.
   */
  readonly replayed: boolean;
  /**
   * The decoder output this frame, or the view dropped it unshown. The Host
   * gets the frame's credit back once every view is done; repeats are ignored.
   */
  done(): void;
}

/** The owner's hold on the phone's input, as this client last heard it. */
export type DisplayControl =
  | { readonly state: "released"; readonly reason: DisplayControlReason | null }
  | { readonly state: "acquiring" }
  | { readonly state: "held"; readonly controlId: DisplayControlId }
  | { readonly state: "releasing" }
  /** Another viewer, in another window or app, holds it. */
  | { readonly state: "busy" }
  | { readonly state: "refused"; readonly reason: DisplayControlReason | null };

export interface DisplaySnapshot {
  /**
   * `waiting` is the backoff after a transient close; `closed` follows a
   * terminal one, and nothing reconnects until every view has let go.
   */
  readonly connection: "connecting" | "open" | "waiting" | "closed";
  /**
   * The last socket's close code: terminal while `closed`, where with `display`
   * it says how the stream ended; otherwise why the next socket is coming.
   */
  readonly closeCode: number | null;
  /** The Host's latest word on the stream, kept across reconnects so it still says why. */
  readonly display: DisplayViewerState | null;
  /**
   * The session's control, shared by every view of it in this client: any of
   * them may use or give back control one of them took.
   */
  readonly control: DisplayControl;
  /** Repeated keyframe requests went unanswered while live; a keyframe clears it. */
  readonly keyframeFailed: boolean;
}

export type DisplayEditingMessage = Exclude<
  DisplayViewerServerMessage,
  { type: "display.state" | "display.control" }
>;

/** One view's hold on a pooled phone display socket. */
export interface DisplayLease {
  getSnapshot(): DisplaySnapshot;
  subscribe(listener: () => void): () => void;
  /** Frames arrive in stream order; each must be marked done exactly when its decoder is. */
  onFrame(listener: (frame: DisplayFrame) => void): () => void;
  /** Private editing context, batch receipts and copy results; never replayed. */
  onEditingMessage(listener: (message: DisplayEditingMessage) => void): () => void;
  takeOver(): void;
  giveBack(): void;
  /**
   * Sends owner input in picture `geometry` while the session's control is
   * held, in batches the contract allows. False otherwise; the events are
   * dropped, never queued for later.
   */
  input(
    geometry: number,
    events: readonly DisplayInputEvent[],
    onSequence?: (sequence: number) => void,
  ): boolean;
  /**
   * The decoder lost its state: asks the Host for a decodable start, and
   * again each coalescing interval while live until a keyframe arrives, a
   * bounded number of times. A socket that is not open carries no request;
   * the next one's join replay starts at a keyframe anyway.
   */
  viewport(maxLongSide: number): void;
  requestKeyframe(): void;
  /** Gives back control this view took; the last view closes the socket. */
  release(): void;
}

const emptySnapshot: DisplaySnapshot = {
  connection: "connecting",
  closeCode: null,
  display: null,
  control: { state: "released", reason: null },
  keyframeFailed: false,
};

interface LeaseState {
  readonly editingMessages: Set<(message: DisplayEditingMessage) => void>;
  maxLongSide: number | null;
  readonly frames: Set<(frame: DisplayFrame) => void>;
  readonly listeners: Set<() => void>;
}

/** A delivered frame's credit, returned once no view still holds the frame. */
interface Credit {
  readonly sequence: number;
  readonly holders: Set<LeaseState>;
}

interface Connection {
  readonly id: number;
  readonly socket: WebSocketClient;
  /** Unreturned credits in stream order; the Host returns credit cumulatively. */
  readonly credits: Credit[];
  sequence: number;
  generation: number;
  /** The end of the replay announced on this socket, until a frame reaches it. */
  replayThrough: number | null;
  /**
   * A replay was announced: cached frames keep their original sequences, so
   * the next frame may restart at or below what this socket already carried.
   */
  replayRestarts: boolean;
  /** A keyframe request awaiting its keyframe: how often it was asked, and the next ask. */
  keyframe: { attempts: number; timer: ReturnType<typeof setTimeout> | null } | null;
}

interface Entry {
  readonly key: string;
  readonly target: ComputerDisplayTarget;
  readonly leases: Set<LeaseState>;
  connection: Connection | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  snapshot: DisplaySnapshot;
  /** The view that took control; its departure gives control back. */
  holder: LeaseState | null;
  /** Increases for every batch this client sends the session, across controls and sockets. */
  inputSequence: number;
  disposed: boolean;
}

type Received =
  | { readonly kind: "message"; readonly message: DisplayViewerServerMessage }
  | {
      readonly kind: "frame";
      readonly header: DisplayViewerFrameHeader;
      readonly payload: Uint8Array;
      readonly replayed: boolean;
    };

/**
 * One viewer socket per exact authority, shared by every view of it in this
 * client. A tile beside the open phone costs one Host viewer; task and owner
 * authorities keep separate sockets while the Host shares their producer.
 * Only a task authority can acquire control.
 *
 * Credit is the flow control: a frame is acknowledged only once each view
 * that received it has decoded or dropped it, in stream order. A transient
 * close is retried with backoff while any view remains, and starts with
 * control released: input is never replayed and control is never taken back
 * on the owner's behalf. A terminal close ends the stream for these views.
 */
export class DisplayStreams {
  readonly #connect: (
    source: NativeViewerSource,
    options?: { readonly editing?: 1 },
  ) => WebSocketClient;
  readonly #retryDelay: (attempt: number) => number;
  readonly #entries = new Map<string, Entry>();
  readonly #terminal = new Map<string, DisplaySnapshot>();
  #connections = 0;
  #suspended = false;
  #diagnostic: ((record: DisplayClientDiagnostic) => void) | undefined;

  constructor(options: {
    readonly connect: (
      source: NativeViewerSource,
      options?: { readonly editing?: 1 },
    ) => WebSocketClient;
    readonly retryDelay?: (attempt: number) => number;
    readonly diagnostic?: (record: DisplayClientDiagnostic) => void;
  }) {
    this.#connect = options.connect;
    this.#diagnostic = options.diagnostic;
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  setDiagnostic(diagnostic: (record: DisplayClientDiagnostic) => void): void {
    this.#diagnostic = diagnostic;
  }

  #log(entry: Entry, record: DisplayClientDiagnostic): void {
    if (!this.#diagnostic) return;
    const source = entry.target.source;
    try {
      this.#diagnostic({
        ...(entry.connection ? { connection: entry.connection.id } : {}),
        ...record,
        ...(source.kind === "task-session"
          ? { kind: source.kind, sessionId: source.sessionId }
          : { kind: source.kind, viewId: source.viewId, generation: source.generation }),
      });
    } catch {
      /* Diagnostic sinks cannot change transport behavior. */
    }
  }

  retain(target: ComputerDisplayTarget): DisplayLease {
    const key = computerDisplayTargetKey(target);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {
        key,
        target,
        leases: new Set(),
        connection: null,
        timer: null,
        attempt: 0,
        snapshot: this.#terminal.get(key) ?? emptySnapshot,
        holder: null,
        inputSequence: 0,
        disposed: false,
      };
      this.#entries.set(key, entry);
    }
    const current = entry;
    const lease: LeaseState = {
      editingMessages: new Set(),
      frames: new Set(),
      listeners: new Set(),
      maxLongSide: null,
    };
    current.leases.add(lease);
    if (!current.connection && !current.timer && current.snapshot.connection !== "closed")
      this.#open(current);
    let released = false;
    return {
      getSnapshot: () => current.snapshot,
      subscribe: (listener) => {
        if (!released) lease.listeners.add(listener);
        return () => lease.listeners.delete(listener);
      },
      onFrame: (listener) => {
        if (!released) lease.frames.add(listener);
        return () => lease.frames.delete(listener);
      },
      onEditingMessage: (listener) => {
        if (!released) lease.editingMessages.add(listener);
        return () => lease.editingMessages.delete(listener);
      },
      takeOver: () => {
        if (!released) this.#takeOver(current, lease);
      },
      giveBack: () => {
        if (!released) this.#giveBack(current);
      },
      input: (geometry, events, onSequence) =>
        !released && this.#input(current, geometry, events, onSequence),
      viewport: (maxLongSide) => {
        if (released || !Number.isFinite(maxLongSide)) return;
        lease.maxLongSide = Math.min(1920, Math.max(320, Math.round(maxLongSide)));
        this.#viewport(current);
      },
      requestKeyframe: () => {
        if (!released) this.#requestKeyframe(current);
      },
      release: () => {
        if (released) return;
        released = true;
        if (current.holder === lease) this.#giveBack(current);
        current.leases.delete(lease);
        lease.frames.clear();
        lease.editingMessages.clear();
        lease.listeners.clear();
        const connection = current.connection;
        if (connection) {
          for (const credit of connection.credits) credit.holders.delete(lease);
          this.#acknowledge(current, connection);
        }
        if (current.leases.size > 0 || current.disposed) return;
        this.#close(current);
        if (this.#entries.get(key) === current) this.#entries.delete(key);
      },
    };
  }

  #viewport(entry: Entry): void {
    const connection = entry.connection;
    if (!connection || connection.socket.readyState !== 1) return;
    const requested = [...entry.leases].flatMap((lease) =>
      lease.maxLongSide === null ? [] : [lease.maxLongSide],
    );
    if (!requested.length) return;
    connection.socket.send(
      JSON.stringify({
        type: "display.viewport",
        maxLongSide: Math.max(320, ...requested),
      }),
    );
  }

  /** Only an explicit user action restarts a terminal source. */
  reopen(target: ComputerDisplayTarget): void {
    const key = computerDisplayTargetKey(target);
    this.#terminal.delete(key);
    const entry = this.#entries.get(key);
    if (!entry || entry.snapshot.connection !== "closed") return;
    this.#close(entry);
    entry.snapshot = emptySnapshot;
    this.#open(entry);
  }

  /**
   * Closes every stream whose reader, Deployment or phone no longer matches.
   * Its views read it as access ended, so their pictures leave the screen.
   */
  invalidate(allowed: (target: ComputerDisplayTarget) => boolean): void {
    for (const [key, entry] of this.#entries) {
      if (allowed(entry.target)) continue;
      this.#entries.delete(key);
      entry.disposed = true;
      entry.holder = null;
      this.#close(entry, "source-invalidated");
      this.#set(entry, {
        ...emptySnapshot,
        connection: "closed",
        closeCode: displayViewerCloseCodes.accessEnded,
      });
    }
  }

  /**
   * While the app is hidden nobody reads a picture, so no stream holds a
   * socket: each lets its socket go and keeps its views and their last
   * picture, and showing the app opens them all again.
   */
  suspend(suspended: boolean): void {
    if (this.#suspended === suspended) return;
    this.#suspended = suspended;
    for (const entry of this.#live()) {
      if (suspended) this.#pause(entry, "page-hidden");
      else {
        this.#log(entry, { transition: "retain", reason: "visible" });
        this.#open(entry);
      }
    }
  }

  /**
   * A network change leaves every socket suspect, and a dead one may never
   * report its close: each stream replaces its own at once, keeping its views.
   */
  reconnect(): void {
    for (const entry of this.#live()) {
      this.#pause(entry, "socket");
      this.#open(entry);
    }
  }

  #live(): Entry[] {
    return [...this.#entries.values()].filter(
      (entry) => !entry.disposed && entry.leases.size > 0 && entry.snapshot.connection !== "closed",
    );
  }

  /** The socket goes, control and credit with it as any transient close; the views stay. */
  #pause(entry: Entry, reason: DisplayClientDiagnostic["reason"]): void {
    this.#log(entry, { transition: "release", reason });
    this.#close(entry, reason);
    entry.holder = null;
    entry.attempt = 0;
    this.#set(entry, { connection: "connecting", control: { state: "released", reason: null } });
  }

  dispose(): void {
    this.invalidate(() => false);
  }

  #open(entry: Entry): void {
    entry.timer = null;
    if (this.#suspended) return;
    let socket: WebSocketClient;
    try {
      socket =
        entry.target.editing === 1
          ? this.#connect(entry.target.source, { editing: 1 })
          : this.#connect(entry.target.source);
    } catch {
      this.#retry(entry);
      return;
    }
    socket.binaryType = "arraybuffer";
    const connection: Connection = {
      id: this.#connections++,
      socket,
      credits: [],
      sequence: -1,
      generation: 0,
      replayThrough: null,
      replayRestarts: false,
      keyframe: null,
    };
    entry.connection = connection;
    this.#set(entry, { connection: "connecting", closeCode: null, keyframeFailed: false });
    socket.addEventListener("open", () => {
      if (entry.connection === connection) {
        this.#log(entry, { transition: "socket-open" });
        this.#set(entry, { connection: "open" });
        this.#viewport(entry);
      }
    });
    socket.addEventListener("message", ({ data }) => {
      if (entry.connection !== connection) return;
      let received: Received;
      try {
        received = read(connection, data);
      } catch (error) {
        this.#log(entry, {
          transition: "protocol-violation",
          reason: error instanceof DisplayOrderingError ? "out-of-order" : "invalid-message",
          ...(error instanceof DisplayOrderingError ? error.details : {}),
        });
        this.#drop(entry, connection, displayViewerCloseCodes.protocolViolation);
        connection.socket.close(
          displayViewerCloseCodes.protocolViolation,
          "Invalid display message",
        );
        return;
      }
      if (received.kind === "frame") {
        if (received.header.key) this.#keyframeArrived(entry, connection);
        this.#deliver(entry, connection, received);
      } else if (received.message.type === "display.state") {
        if (received.message.state === "live") entry.attempt = 0;
        if (received.message.replayThrough !== undefined) {
          connection.replayThrough = received.message.replayThrough;
          connection.replayRestarts = true;
        }
        this.#set(entry, { display: received.message });
      } else if (received.message.type === "display.control")
        this.#control(entry, received.message);
      else if (
        entry.target.editing === 1 &&
        entry.snapshot.display?.editingVersion === 1 &&
        entry.snapshot.control.state === "held"
      )
        for (const lease of entry.leases)
          for (const listener of lease.editingMessages) listener(received.message);
    });
    socket.addEventListener("close", ({ code, reason }) => {
      const parsed = DisplayClientDiagnosticSchema.shape.socketReason.safeParse(reason);
      this.#log(entry, {
        transition: "socket-close",
        connection: connection.id,
        code,
        socketReason: parsed.success ? parsed.data : "unrecognized",
      });
      if (entry.connection === connection) this.#drop(entry, connection, code);
    });
  }

  /**
   * The socket is gone, and control and every credit it carried with it. Only
   * a transient close is retried; a terminal one is kept to say how it ended.
   */
  #drop(entry: Entry, connection: Connection, code: number): void {
    if (entry.connection === connection) entry.connection = null;
    stopKeyframeRequests(connection);
    entry.holder = null;
    const control = { state: "released", reason: null } as const;
    if (isRetryableDisplayViewerClose(code)) {
      this.#set(entry, { closeCode: code, control });
      this.#retry(entry);
    } else this.#set(entry, { connection: "closed", closeCode: code, control });
  }

  #retry(entry: Entry): void {
    if (entry.disposed || entry.leases.size === 0 || this.#suspended) return;
    const delayMs = this.#retryDelay(entry.attempt++);
    this.#log(entry, {
      transition: "retry-scheduled",
      reason: "socket",
      delayMs,
      attempt: entry.attempt,
    });
    entry.timer = setTimeout(() => this.#open(entry), delayMs);
    this.#set(entry, { connection: "waiting" });
  }

  #close(entry: Entry, reason: DisplayClientDiagnostic["reason"] = "last-viewer"): void {
    if (entry.timer) {
      this.#log(entry, { transition: "retry-cancelled", reason });
      clearTimeout(entry.timer);
    }
    entry.timer = null;
    const connection = entry.connection;
    entry.connection = null;
    if (!connection) return;
    stopKeyframeRequests(connection);
    connection.socket.close(1000, "Display viewer closed");
  }

  #requestKeyframe(entry: Entry): void {
    const connection = entry.connection;
    if (!connection || connection.socket.readyState !== 1 || connection.keyframe) return;
    connection.keyframe = { attempts: 1, timer: null };
    send(connection, { type: "display.keyframe" });
    this.#scheduleKeyframeRequest(entry, connection);
  }

  /**
   * The Host coalesces keyframe requests and rate-limits them after a replay,
   * so one may go unanswered: it is asked again each interval while the stream
   * is live, and only time spent live counts toward giving up.
   */
  #scheduleKeyframeRequest(entry: Entry, connection: Connection): void {
    const request = connection.keyframe;
    if (!request) return;
    request.timer = setTimeout(() => {
      request.timer = null;
      if (entry.connection !== connection || connection.keyframe !== request) return;
      if (entry.snapshot.display?.state === "live") {
        if (request.attempts >= keyframeRequests) {
          this.#set(entry, { keyframeFailed: true });
          return;
        }
        request.attempts += 1;
        send(connection, { type: "display.keyframe" });
      }
      this.#scheduleKeyframeRequest(entry, connection);
    }, displayRefreshCoalescingMs);
  }

  #keyframeArrived(entry: Entry, connection: Connection): void {
    stopKeyframeRequests(connection);
    if (entry.snapshot.keyframeFailed) this.#set(entry, { keyframeFailed: false });
  }

  #deliver(
    entry: Entry,
    connection: Connection,
    { header, payload, replayed }: Extract<Received, { kind: "frame" }>,
  ): void {
    const credit: Credit = { sequence: header.sequence, holders: new Set() };
    connection.credits.push(credit);
    for (const lease of entry.leases) if (lease.frames.size > 0) credit.holders.add(lease);
    for (const lease of credit.holders) {
      const frame: DisplayFrame = {
        connection: connection.id,
        header,
        payload,
        replayed,
        done: () => {
          if (credit.holders.delete(lease)) this.#acknowledge(entry, connection);
        },
      };
      for (const listener of lease.frames) listener(frame);
    }
    this.#acknowledge(entry, connection);
  }

  #acknowledge(entry: Entry, connection: Connection): void {
    while (connection.credits[0]?.holders.size === 0) {
      const credit = connection.credits.shift()!;
      if (entry.connection === connection && connection.socket.readyState === 1)
        send(connection, { type: "display.ack", sequence: credit.sequence });
    }
  }

  #control(
    entry: Entry,
    message: Extract<DisplayViewerServerMessage, { type: "display.control" }>,
  ) {
    const current = entry.snapshot.control.state;
    switch (message.state) {
      case "held":
        if (current === "held" || current === "releasing") return;
        if (current === "acquiring" && entry.holder && message.controlId) {
          this.#set(entry, { control: { state: "held", controlId: message.controlId } });
          return;
        }
        // Control nobody here is waiting for is handed straight back.
        entry.holder = null;
        if (entry.connection)
          send(entry.connection, { type: "display.control", action: "release" });
        this.#set(entry, { control: { state: "releasing" } });
        return;
      case "busy":
      case "refused":
        // An answer to giving back means the control is gone either way.
        if (current === "releasing") {
          entry.holder = null;
          this.#set(entry, { control: { state: "released", reason: null } });
          return;
        }
        if (message.state === "busy" && current !== "acquiring") return;
        entry.holder = null;
        this.#set(entry, {
          control:
            message.state === "busy"
              ? { state: "busy" }
              : { state: "refused", reason: message.reason ?? null },
        });
        return;
      case "released":
        entry.holder = null;
        this.#set(entry, { control: { state: "released", reason: message.reason ?? null } });
        return;
    }
  }

  #takeOver(entry: Entry, lease: LeaseState): void {
    if (
      entry.target.source.kind === "owner-view" &&
      (entry.target.editing !== 1 || entry.snapshot.display?.editingVersion !== 1)
    )
      return;
    const { connection, control } = entry.snapshot;
    if (!entry.connection || connection !== "open") return;
    if (control.state !== "released" && control.state !== "refused" && control.state !== "busy")
      return;
    entry.holder = lease;
    send(entry.connection, { type: "display.control", action: "acquire" });
    this.#set(entry, { control: { state: "acquiring" } });
  }

  #giveBack(entry: Entry): void {
    entry.holder = null;
    const state = entry.snapshot.control.state;
    if (state !== "acquiring" && state !== "held") return;
    if (entry.connection?.socket.readyState === 1)
      send(entry.connection, { type: "display.control", action: "release" });
    this.#set(entry, { control: { state: "releasing" } });
  }

  #input(
    entry: Entry,
    geometry: number,
    events: readonly DisplayInputEvent[],
    onSequence?: (sequence: number) => void,
  ): boolean {
    const control = entry.snapshot.control;
    const connection = entry.connection;
    if (control.state !== "held" || connection?.socket.readyState !== 1 || events.length === 0)
      return false;
    const parsed = events.map((event) => DisplayInputEventSchema.parse(event));
    if (
      parsed.some((event) => !["text", "pointer", "scroll", "nav"].includes(event.kind)) &&
      (entry.target.editing !== 1 || entry.snapshot.display?.editingVersion !== 1)
    )
      return false;
    const batches: string[] = [];
    let batch: DisplayInputEvent[] = [];
    const serialize = (items: DisplayInputEvent[]) =>
      JSON.stringify(
        DisplayViewerClientMessageSchema.parse({
          type: "display.input",
          controlId: control.controlId,
          geometry,
          sequence: entry.inputSequence + batches.length,
          events: items,
        }),
      );
    for (const event of parsed) {
      const candidate = [...batch, event];
      if (
        candidate.length > maxInputEvents ||
        new TextEncoder().encode(serialize(candidate)).byteLength > maxInputBytes
      ) {
        if (batch.length === 0) throw new Error("Display input event exceeds its byte limit.");
        batches.push(serialize(batch));
        batch = [event];
      } else batch = candidate;
    }
    const last = serialize(batch);
    if (new TextEncoder().encode(last).byteLength > maxInputBytes)
      throw new Error("Display input event exceeds its byte limit.");
    batches.push(last);
    const first = entry.inputSequence;
    entry.inputSequence += batches.length;
    // Register all receipts before a socket can synchronously deliver an answer.
    for (let index = 0; index < batches.length; index++) onSequence?.(first + index);
    for (const batch of batches) connection.socket.send(batch);
    return true;
  }

  #set(entry: Entry, patch: Partial<DisplaySnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    const listeners = [...entry.leases].flatMap((lease) => [...lease.listeners]);
    if (entry.snapshot.connection === "closed") {
      this.#terminal.set(entry.key, entry.snapshot);
      if (this.#terminal.size > 256) this.#terminal.delete(this.#terminal.keys().next().value!);
    }
    for (const listener of listeners) listener();
  }
}

class DisplayOrderingError extends Error {
  readonly details: Pick<
    DisplayClientDiagnostic,
    "previousSequence" | "incomingSequence" | "previousGeneration" | "incomingGeneration"
  >;
  constructor(details: DisplayOrderingError["details"]) {
    super("Display frames arrived out of order.");
    this.details = details;
  }
}

/** Parses one server message; anything unreadable or out of order ends the socket. */
function read(connection: Connection, data: unknown): Received {
  if (typeof data === "string") {
    if (data.length > maxServerTextCharacters)
      throw new Error("A display message exceeds its limit.");
    const message = DisplayViewerServerMessageSchema.parse(JSON.parse(data));
    if (message.type === "display.control" && message.state === "held" && !message.controlId)
      throw new Error("Held control names no control.");
    return { kind: "message", message };
  }
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!bytes) throw new Error("Unexpected display message.");
  const { header, payload } = decodeDisplayViewerFrame(bytes);
  // A replay resends cached frames under their own sequences: its first frame
  // may restart the count, and the count increases strictly from there.
  if (
    (header.sequence <= connection.sequence && !connection.replayRestarts) ||
    header.generation < connection.generation
  )
    throw new DisplayOrderingError({
      previousSequence: connection.sequence,
      incomingSequence: header.sequence,
      previousGeneration: connection.generation,
      incomingGeneration: header.generation,
    });
  connection.replayRestarts = false;
  connection.sequence = header.sequence;
  connection.generation = header.generation;
  const replayed = connection.replayThrough !== null && header.sequence < connection.replayThrough;
  if (!replayed) connection.replayThrough = null;
  return { kind: "frame", header, payload, replayed };
}

function stopKeyframeRequests(connection: Connection): void {
  if (connection.keyframe?.timer) clearTimeout(connection.keyframe.timer);
  connection.keyframe = null;
}

function send(connection: Connection, message: DisplayViewerClientMessage): void {
  connection.socket.send(JSON.stringify(DisplayViewerClientMessageSchema.parse(message)));
}

function defaultRetryDelay(attempt: number): number {
  const ceiling = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt, 8));
  return Math.round(ceiling * (0.8 + Math.random() * 0.2));
}

const pools = new WeakMap<object, DisplayStreams>();
export function sharedDisplayStreams(
  hostClient: Pick<HostClient, "connectComputerDisplay" | "subscribeLifecycle">,
  diagnostic?: (record: DisplayClientDiagnostic) => void,
): DisplayStreams {
  let pool = pools.get(hostClient);
  if (!pool) {
    const created = new DisplayStreams({
      connect: (source, options) => hostClient.connectComputerDisplay(source, options),
    });
    // The pool lives as long as its client, so the subscription does too.
    hostClient.subscribeLifecycle?.((event) => {
      if (event === "network") created.reconnect();
      else created.suspend(event === "background");
    });
    pools.set(hostClient, created);
    pool = created;
  }
  if (diagnostic) pool.setDiagnostic(diagnostic);
  return pool;
}

/**
 * The signed-in reader, Deployment, phone and exact live authority for this
 * view. Task replacement never changes an owner view into a task viewer. A
 * realtime reconnect keeps the scope: the display socket is admitted on its own.
 */
export function computerDisplayScope(
  snapshot: HostSnapshot,
  source: NativeViewerSource | null,
): string | null {
  if (!source || snapshot.session !== "authenticated" || !snapshot.user) return null;
  const machine = snapshot.machines.find(
    (candidate) =>
      canStreamComputerDisplay(candidate) &&
      (source.kind === "task-session"
        ? candidate.computerUse?.sessions.some(
            (session) =>
              session.sessionId === source.sessionId &&
              (source.appKey === undefined
                ? session.display
                : !session.display &&
                  session.apps.some((app) => computerAppIdentityKey(app) === source.appKey)),
          )
        : candidate.computerUse?.ownerViews?.some(
            (view) =>
              view.viewId === source.viewId &&
              view.generation === source.generation &&
              view.state === "ready" &&
              Date.parse(view.expiresAt) > Date.now(),
          )),
  );
  return machine
    ? JSON.stringify([
        snapshot.deploymentId,
        snapshot.user.id,
        machine.id,
        source.kind === "task-session" ? (source.appKey ?? "main") : "owner",
        source.kind,
        source.kind === "task-session" ? source.sessionId : source.viewId,
        source.kind === "owner-view" ? source.generation : null,
      ])
    : null;
}

/** The stream's state in the terms of the shared Watch words (`computerWatchStatus`). */
export function computerDisplayStatus(
  snapshot: DisplaySnapshot,
  phone = true,
): {
  readonly reason:
    | "screen-off"
    | "paused"
    | "ended"
    | "busy"
    | "locked"
    | DisplayUnavailableReason
    | "unsupported"
    | "capture-timeout"
    | "capture-failed"
    | "window-closed"
    | "minimized"
    | "permission-required"
    | "target-unavailable"
    | "sharing-stopped"
    | null;
  readonly retrying: boolean;
} {
  const display = snapshot.display;
  const say = (reason: ReturnType<typeof computerDisplayStatus>["reason"]) => ({
    reason,
    retrying: false,
  });
  if (snapshot.connection === "closed") {
    // The Host ends the stream with 1000 once it has said why, or because the session ended.
    if (snapshot.closeCode === displayViewerCloseCodes.ended)
      switch (display?.state) {
        case "stopped":
        case "failed":
        case "unsupported":
          break;
        default:
          return say("ended");
      }
    else if (snapshot.closeCode === displayViewerCloseCodes.accessEnded) return say("ended");
    else return say("display-failed");
  }
  switch (display?.state) {
    case undefined:
    case "starting":
    case "warming":
    case "live":
      if (snapshot.keyframeFailed) return say("display-failed");
      return { reason: null, retrying: snapshot.connection === "waiting" };
    case "protected":
      switch (display.reason) {
        case "paused":
        case "opensteer-app":
          return say(display.reason);
        case "locked-screen":
          return say("locked");
        case "session-ended":
        case "owner-ended":
        case "owner-expired":
        case "owner-revoked":
          return say("ended");
        default:
          return say("protected");
      }
    case "screen-off":
    case "unsupported":
      return say(display.state);
    case "stopped":
      return say(display.reason === "projection-ended" ? "projection-ended" : "ended");
    case "failed":
      if (display.reason === "locked-screen") return say("locked");
      if (!phone && display.reason === "encoder-failed") return say("encoder-failed");
      if (
        display.reason === "capacity" ||
        display.reason === "capture-timeout" ||
        display.reason === "capture-failed" ||
        display.reason === "window-closed" ||
        display.reason === "minimized" ||
        display.reason === "target-unavailable" ||
        display.reason === "sharing-stopped"
      )
        return say(display.reason);
      return say(
        display.reason === "permission-required"
          ? phone
            ? "projection-permission"
            : "permission-required"
          : "display-failed",
      );
  }
}

const controlReasonWords: Readonly<Record<DisplayControlReason, string | null>> = {
  busy: "Another window is controlling the phone",
  paused: "Paused on the phone",
  "secure-lock": "Unlock the phone to take over",
  // The Watch itself says the agent finished.
  "session-ended": null,
  "stream-lost": "The phone lost its connection",
  "timed-out": "The phone didn’t respond in time",
  // The owner gave it back, here or by leaving.
  "released-by-owner": null,
  "viewer-gone": null,
};

/** Who has the phone's input, or why the owner does not, in the same words everywhere. */
export function phoneControlNote(control: DisplayControl, app = false): string | null {
  const words = app
    ? {
        ...controlReasonWords,
        busy: "Another window is controlling the app",
        paused: "Paused on this Mac",
        "secure-lock": "Unlock this Mac to take over",
        "stream-lost": "The app lost its connection",
        "timed-out": "The app didn’t respond in time",
      }
    : controlReasonWords;
  switch (control.state) {
    case "held":
      return app ? "You’re controlling the app" : "You’re controlling the phone";
    case "busy":
      return words.busy;
    case "refused":
    case "released":
      return control.reason ? words[control.reason] : null;
    case "acquiring":
    case "releasing":
      return null;
  }
}
