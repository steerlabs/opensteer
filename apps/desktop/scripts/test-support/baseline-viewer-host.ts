import { randomUUID } from "node:crypto";
import { KeyedStreamReceiver } from "@opensteer/protocol/keyed-stream";
import type {
  BrowserTabRecord,
  BrowserTabStreamMeta,
  BrowserRuntimeServerMessage,
} from "@opensteer/protocol/browser";
import {
  BrowserClientMessageSchema,
  BrowserSurfaceIdSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import { encodeBrowserFrame, type BrowserFrame } from "@opensteer/browser-runtime-core";
import {
  browserViewerEditingVersion,
  browserViewerMessage,
} from "../../../host/src/browser/browser-viewer-protocol.js";

export interface BaselineViewerPeer {
  readonly readyState: number;
  send(data: string | Buffer): void;
}

const open = 1;

/**
 * The Host's part between one viewer socket and a runtime attachment, as much
 * of it as the baseline viewer journey needs, with no Electron: it projects the
 * runtime's messages for the viewer, holds the viewer's one subscription and
 * relays its pictures, and forwards the rest as that viewer's producer.
 *
 * Every viewer is targeted since 87ec45567 (#531): it takes only a picture of
 * its own tab that carries a `watchToken`, and answers each with `stream.ack`
 * before the next. The Host stamps that token (`watchFrameEnvelope`) and holds
 * later pictures until the ack, one at a time; so does this.
 */
export class BaselineViewerHost {
  viewerVersion: 1 | 2 | undefined;
  requestedVersion: 1 | 2 | undefined;
  runtimeSnapshot: Extract<BrowserRuntimeServerMessage, { type: "browser.snapshot" }> | undefined;
  readonly tabStream = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
  readonly consumerToken = randomUUID();
  #peer: BaselineViewerPeer | undefined;
  #heldSurfaceId: string | null = null;
  /** The token of the picture the viewer has not answered yet. */
  #awaiting: string | null = null;
  /** The newest picture held back meanwhile. */
  #pending: BrowserFrame | null = null;
  readonly #icons = new Map<string, string>();
  readonly #forward: (message: string) => Promise<unknown>;
  readonly #onFailure: (error: unknown) => void;

  constructor(forward: (message: string) => Promise<unknown>, onFailure: (error: unknown) => void) {
    this.#forward = forward;
    this.#onFailure = onFailure;
  }

  /** A message from the runtime, for the viewer if it reads it. */
  runtimeMessage(message: BrowserRuntimeServerMessage): void {
    const projected = this.#project(message);
    if (projected && this.#peer?.readyState === open) this.#peer.send(JSON.stringify(projected));
  }

  /** A picture from the runtime, for the viewer if it shows that tab. */
  runtimeFrame(frame: BrowserFrame): void {
    if (this.#peer?.readyState !== open || frame.header.surfaceId !== this.#heldSurfaceId) return;
    if (this.#awaiting) this.#pending = frame;
    else this.#sendFrame(this.#peer, frame);
  }

  #sendFrame(peer: BaselineViewerPeer, frame: BrowserFrame): void {
    const watchToken = randomUUID();
    this.#awaiting = watchToken;
    peer.send(encodeBrowserFrame({ ...frame, header: { ...frame.header, watchToken } }));
  }

  #subscribe(surfaceId: string | null): void {
    if (surfaceId === this.#heldSurfaceId) return;
    this.#heldSurfaceId = surfaceId;
    this.#awaiting = null;
    this.#pending = null;
  }

  /** A viewer socket opened at `requestUrl`; returns what handles its messages. */
  connect(peer: BaselineViewerPeer, requestUrl: string): (data: string) => void {
    const snapshot = this.runtimeSnapshot;
    if (!snapshot) throw new Error("The runtime has not sent its snapshot.");
    this.#peer = peer;
    this.requestedVersion =
      new URL(requestUrl, "http://fixture").searchParams.get("editing") === "2" ? 2 : 1;
    this.viewerVersion = browserViewerEditingVersion(snapshot, this.requestedVersion);
    peer.send(JSON.stringify(this.#project(snapshot)!));
    return (data) => {
      const message = BrowserClientMessageSchema.parse(JSON.parse(data));
      if (message.type === "stream.ack") {
        // The Host's own credit; the runtime never sees it.
        if (message.token !== this.#awaiting) return;
        this.#awaiting = null;
        const next = this.#pending;
        this.#pending = null;
        if (next && peer.readyState === open) this.#sendFrame(peer, next);
        return;
      }
      if (message.type === "stream.subscribe") {
        if (!message.surfaceId) throw new Error("The viewer must subscribe to one surface.");
        this.#subscribe(message.surfaceId);
        const surface = this.#heldSurface();
        if (surface) peer.send(JSON.stringify(surface));
      } else if (message.type === "stream.unsubscribe") this.#subscribe(null);
      const input = [
        "input.key",
        "input.pointer",
        "input.command",
        "clipboard.copy",
        "clipboard.cut",
        "clipboard.paste-data",
      ].includes(message.type)
        ? { ...message, consumerToken: this.consumerToken, producerId: this.consumerToken }
        : { ...message, producerId: this.consumerToken };
      void this.#forward(JSON.stringify(input)).catch(this.#onFailure);
    };
  }

  #heldSurface(): BrowserServerMessage | undefined {
    if (!this.#heldSurfaceId) return;
    const row = this.tabStream.rows.get(this.#heldSurfaceId);
    if (!row)
      return {
        type: "browser.surface",
        surfaceId: BrowserSurfaceIdSchema.parse(this.#heldSurfaceId),
        surface: null,
      };
    const { icon, order: _order, openerId: _opener, ...surface } = row;
    return {
      type: "browser.surface",
      surfaceId: row.id,
      surface: { ...surface, favicon: icon ? (this.#icons.get(icon) ?? null) : null },
    };
  }

  #project(
    message: BrowserServerMessage | BrowserRuntimeServerMessage,
  ): BrowserServerMessage | undefined {
    if (message.type === "browser.tab.icon") {
      this.#icons.set(message.key, message.favicon);
      return;
    }
    if (message.type === "browser.snapshot" && !("surfaces" in message)) {
      this.runtimeSnapshot = message;
      const {
        cdpReplyBudget: _cdpReplyBudget,
        scriptAttachments: _scriptAttachments,
        scriptCancellation: _scriptCancellation,
        ...viewerSnapshot
      } = message;
      return browserViewerMessage({ ...viewerSnapshot, surfaces: [] }, this.viewerVersion);
    }
    if (message.type === "browser.tabs") {
      if (this.tabStream.apply(message.stream) !== "applied") return;
      return this.#heldSurface();
    }
    if (
      !this.viewerVersion &&
      [
        "browser.editing",
        "browser.contextmenu",
        "clipboard.result",
        "clipboard.part",
        "clipboard.written",
      ].includes(message.type)
    )
      return;
    return browserViewerMessage(message, this.viewerVersion);
  }
}
