import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { IntegrationAccess } from "@opensteer/integration-core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  DisplayAckSchema,
  computerUseBridgePasswordsParams,
  type LoginReceiverKey,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
  type PasswordSignInAuthorityResult,
  macDisplayMaxWindows,
  DisplayDemandSchema,
  macWindowVideoParams,
  type DisplaySource,
  ComputerViewHelperRequestSchema,
  type ComputerViewNativeRequest,
  type DesktopUseComputerViewInput,
  ComputerUseBridgeFrameSchema,
  ComputerUseDataAppIdSchema,
  ComputerUseDataInvokeParamsSchema,
  ComputerUseHelperRequestSchema,
  ComputerUseSessionIdSchema,
  computerUseBridgeApprovalParams,
  computerUseBridgeMaxFrameBytes,
  computerUseBridgeOwnerInputHeader,
  computerUseRequestMayHaveEffect,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalKeyProof,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcomeFrame,
  type ComputerUseDataAppId,
  type ComputerUseDataGrants,
  type ComputerUseErrorCode,
  type ComputerUseHelperEvent,
  type ComputerUseHelperMethod,
  type ComputerUsePermissions,
  type ComputerUseSessionId,
} from "@opensteer/protocol";
import {
  ComputerUseHelperDeadlineFailure,
  ComputerUseHelperFailure,
  computerUseHelperAnswerGraceMs,
  type ComputerUseHelperRequestOptions,
  type ComputerUseHelperResult,
  type ComputerUseMediaAttachment,
} from "./helper-client.js";

export const computerUseBridgePath = "/v1/computer-use";

/**
 * How much longer than a request's deadline this hop waits before it stops
 * waiting. It is longer than the helper client's own grace, so the helper's
 * answer — or the client's verdict that none is coming, or that the request
 * ran out of time installing or connecting before its frame was written —
 * normally arrives first.
 */
export const computerUseBridgeGraceMs = computerUseHelperAnswerGraceMs + 1_000;
/** The deadline of a request whose Runner named none. */
const defaultBridgeTimeoutMs = 30_000;
/** How long ending one session may take; closing bypasses the helper's work queue. */
const sessionCloseTimeoutMs = 10_000;
/**
 * When a close the helper did not confirm is sent again. After the last, the
 * helper's own idle lease ends the session.
 */
const closeRetryDelaysMs = [2_000, 10_000, 30_000] as const;

const lateSentence = "The Mac did not answer in time.";
const lateActSentence =
  "The Mac did not answer in time; the actions may already have taken effect.";
const lateWriteSentence = "The Mac did not answer in time; the change may already have been made.";

/** Minted per slot exactly as the browser bridge's token is. */
export function mintComputerUseBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface ComputerUseBridgeHelperPort {
  attachDisplay?(
    token: string,
    onFrame: (frame: Buffer) => void,
    onLost: () => void,
    options: ComputerUseHelperRequestOptions,
  ): Promise<ComputerUseMediaAttachment>;
  ownerViewVersion?(): number | undefined;
  ownerInputVersion?(): 2 | undefined;
  computerUseVersion?(): 2 | undefined;
  loginReceiver?(): LoginReceiverKey | null;
  onCapabilitiesChanged?(listener: () => void): () => void;
  onDisconnect(listener: () => void): () => void;
  onEvent(listener: (event: ComputerUseHelperEvent) => void): () => void;
  /**
   * The grants as a status probe may read them: without installing a helper
   * that was never set up, and from what it last said while it is asleep.
   */
  readinessPermissions(options: ComputerUseHelperRequestOptions): Promise<ComputerUsePermissions>;
  /** The data grants, read the same way as `readinessPermissions`. */
  readinessDataGrants(options: ComputerUseHelperRequestOptions): Promise<ComputerUseDataGrants>;
  request<Method extends ComputerUseHelperMethod>(
    method: Method,
    params: unknown,
    options?: ComputerUseHelperRequestOptions,
  ): Promise<ComputerUseHelperResult<Method>>;
}

/**
 * Which bridge connection opened which session, across every slot on this Mac.
 *
 * It is shared rather than per server because every slot's sessions reach the
 * helper over this desktop's one connection: a second Runner naming the first
 * Runner's session must be refused here rather than answered by the helper,
 * which only knows that this one desktop opened it.
 */
export class ComputerUseSessionOwnership {
  readonly #owners = new Map<ComputerUseSessionId, object>();
  readonly #viewOwners = new Map<string, object>();
  readonly #videoOwners = new Map<string, object>();

  claimVideo(id: string, owner: object): boolean {
    const current = this.#videoOwners.get(id);
    if (current && current !== owner) return false;
    this.#videoOwners.set(id, owner);
    return true;
  }
  ownsVideo(id: string, owner: object): boolean {
    return this.#videoOwners.get(id) === owner;
  }
  releaseVideo(id: string, owner: object): void {
    if (this.#videoOwners.get(id) === owner) this.#videoOwners.delete(id);
  }

  claimView(id: string, owner: object): boolean {
    const current = this.#viewOwners.get(id);
    if (current && current !== owner) return false;
    this.#viewOwners.set(id, owner);
    return true;
  }

  releaseView(id: string, owner: object): void {
    if (this.#viewOwners.get(id) === owner) this.#viewOwners.delete(id);
  }

  /** Live authority and video claims keep the shared helper connection in use. */
  get size(): number {
    return this.#owners.size + this.#viewOwners.size + this.#videoOwners.size;
  }

  claim(sessionId: ComputerUseSessionId, owner: object): void {
    this.#owners.set(sessionId, owner);
  }

  /** True when nobody holds it, or this owner does. */
  mayUse(sessionId: ComputerUseSessionId, owner: object): boolean {
    const holder = this.#owners.get(sessionId);
    return holder === undefined || holder === owner;
  }

  /** Gives the session back, but only on behalf of the owner that holds it. */
  release(sessionId: ComputerUseSessionId, owner: object): void {
    if (this.#owners.get(sessionId) === owner) this.#owners.delete(sessionId);
  }

  /** Gives the session back whoever holds it: the helper said it ended. */
  ended(sessionId: ComputerUseSessionId): void {
    this.#owners.delete(sessionId);
  }

  releaseAll(owner: object): readonly ComputerUseSessionId[] {
    const released: ComputerUseSessionId[] = [];
    for (const [sessionId, holder] of this.#owners) {
      if (holder !== owner) continue;
      released.push(sessionId);
      this.#owners.delete(sessionId);
    }
    return released;
  }

  owns(sessionId: ComputerUseSessionId, owner: object): boolean {
    return this.#owners.get(sessionId) === owner;
  }
}

export interface PasswordsAuthorityPort {
  control(
    command: PasswordSignInAuthorityCommand,
    emit: (event: PasswordSignInAuthorityEvent) => void,
  ): Promise<PasswordSignInAuthorityResult>;
  end(operationId: string): Promise<void>;
}

export interface ComputerUseBridgeServerOptions {
  readonly passwords?: PasswordsAuthorityPort;
  /** How long past a deadline to wait; `computerUseBridgeGraceMs` unless a test shortens it. */
  readonly graceMs?: number;
  readonly helper: ComputerUseBridgeHelperPort;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  /**
   * A Runner's call to an app the helper serves found a macOS grant missing.
   * The Host forwards an agent's call whatever the Mac's readiness says, so
   * this is the one place on this Mac that learns an agent needs the grant
   * now; desktop main offers the person setup. The Runner still gets the
   * refusal, and nothing here asks macOS anything.
   */
  readonly onDataPermissionRequired?: (input: {
    readonly access: IntegrationAccess;
    readonly definitionId: ComputerUseDataAppId;
  }) => void;
  readonly ownership: ComputerUseSessionOwnership;
  /**
   * Where this slot's Runner hands the Host's approval frames. Each is taken
   * at once and acknowledged: the panels wait on a person, and the Runner is
   * owed only the acknowledgement; the answer comes back as an event.
   */
  readonly approvals: {
    disconnected(): void;
    list(list: ComputerAppApprovalList): void;
    outcome(frame: ComputerAppApprovalOutcomeFrame): void;
    proveKeyChallenge(
      challenge: ComputerAppApprovalKeyChallenge,
    ): Promise<ComputerAppApprovalKeyProof>;
  };
  readonly token?: string;
}

interface BridgeConnection {
  readonly detachEvents: () => void;
  readonly socket: WebSocket;
}

/** One connection's ownership identity, liveness fence, and in-flight opens. */
interface BridgeOwner {
  alive: boolean;
  readonly ownerInputVersion: 2 | undefined;
  readonly opening: Set<ComputerUseSessionId>;
  readonly passwords: Set<string>;
}

/** The slot's one authenticated connection, held from the upgrade on. */
interface ConnectionClaim {
  accepted: boolean;
}

type Outcome<Value> =
  | { readonly kind: "answer"; readonly value: Value }
  | { readonly error: unknown; readonly kind: "refused" }
  | { readonly kind: "late" };

/**
 * One Runner slot's loopback bridge.
 *
 * The trust model: the Runner is trusted to pass through the app and access
 * the Host resolved for each call, and the helper enforces that target on
 * every observe and act. What keeps anything else on this Mac from speaking
 * for the Runner is the token, which lives only in the Runner's memory — the
 * Runner removes it from its environment once parsed, and its Node cannot be
 * given an inspector by signal — and this bridge taking one authenticated
 * connection per slot at a time. The one thing no Runner may ask for is
 * `permissions.request`: asking macOS for a grant puts a system prompt on the
 * person's screen, and that belongs to somebody at this keyboard.
 *
 * One request running late never ends another's work: a hop that outlives its
 * deadline ends the one session that request belonged to, and neither this
 * socket nor the Mac-wide helper connection is dropped for it.
 */
export class ComputerUseBridgeServer {
  readonly #connections = new Set<BridgeConnection>();
  readonly #passwords: PasswordsAuthorityPort | undefined;
  readonly #graceMs: number;
  readonly #helper: ComputerUseBridgeHelperPort;
  readonly #httpServer: HttpServer;
  readonly #log: NonNullable<ComputerUseBridgeServerOptions["log"]>;
  readonly #onDataPermissionRequired: ComputerUseBridgeServerOptions["onDataPermissionRequired"];
  readonly #closeRetries = new Set<ReturnType<typeof setTimeout>>();
  /** Shut down: the closes already sent still go, but none is sent again. */
  #closed = false;
  #closing: Promise<void> | null = null;
  #listening: Promise<unknown> | null = null;
  readonly #now: () => number;
  readonly #leaseNow: () => number;
  readonly #ownership: ComputerUseSessionOwnership;
  readonly #approvals: ComputerUseBridgeServerOptions["approvals"];
  readonly #token: string;
  readonly #websocketServer: WebSocketServer;
  #claim: ConnectionClaim | null = null;
  #url: URL | null = null;
  readonly #views = new Map<
    string,
    {
      owner: BridgeOwner;
      request: Extract<ComputerViewNativeRequest, { method: "view.open" }>;
      expiresAt: number;
    }
  >();

  readonly #videos = new Map<
    string,
    {
      owner: BridgeOwner;
      attachmentToken?: string;
      mediaTaken?: boolean;
      endLogged?: boolean;
      media?: ComputerUseMediaAttachment;
      socket?: WebSocket;
    }
  >();

  #ownsVideoSource(source: DisplaySource, owner: BridgeOwner): boolean {
    if (source.kind === "task-session")
      return source.appKey !== undefined && this.#ownership.owns(source.sessionId, owner);
    const entry = this.#views.get(source.viewId);
    return (
      entry?.owner === owner &&
      entry.request.generation === source.generation &&
      entry.expiresAt > this.#leaseNow()
    );
  }

  #videoEnded(streamId: string, reason: string): void {
    const entry = this.#videos.get(streamId);
    if (!entry || entry.endLogged) return;
    entry.endLogged = true;
    try {
      this.#log("desktop.computer-use.media-ended", { streamId, reason });
    } catch {
      /* Diagnostics cannot interrupt teardown. */
    }
  }

  #stopVideos(owner: BridgeOwner, closeNative: boolean): void {
    for (const [streamId, entry] of this.#videos) {
      if (entry.owner !== owner) continue;
      this.#videoEnded(streamId, "owner-gone");
      this.#ownership.releaseVideo(streamId, owner);
      this.#videos.delete(streamId);
      entry.media?.close();
      entry.socket?.terminate();
      if (closeNative)
        void this.#helper
          .request("display.stop", { streamId }, { deadline: this.#now() + 5_000 })
          .catch(() => undefined);
    }
  }

  async #acceptMedia(token: string, socket: WebSocket): Promise<void> {
    const found = [...this.#videos.entries()].find(
      ([, entry]) => entry.attachmentToken === token && !entry.mediaTaken,
    );
    const streamId = found?.[0];
    const entry = found?.[1];
    if (!streamId || !entry || !entry.owner.alive || !this.#helper.attachDisplay) {
      socket.close(4003, "Video attachment ended");
      return;
    }
    entry.mediaTaken = true;
    entry.socket = socket;
    const close = (reason: string) => {
      this.#videoEnded(streamId, reason);
      entry.media?.close();
    };
    socket.once("close", () => close("socket-close"));
    socket.once("error", () => close("socket-error"));
    socket.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error("Video credit must be JSON");
        const ack = DisplayAckSchema.parse(JSON.parse(rawDataBuffer(raw).toString()));
        entry.media?.ack(ack.sequence);
      } catch {
        this.#videoEnded(streamId, "invalid-credit");
        socket.close(4002, "Invalid video credit");
      }
    });
    try {
      const media = await this.#helper.attachDisplay(
        token,
        (bytes) => {
          if (
            !entry.owner.alive ||
            socket.readyState !== socket.OPEN ||
            socket.bufferedAmount + bytes.byteLength > 1_048_576
          ) {
            this.#videoEnded(
              streamId,
              !entry.owner.alive
                ? "owner-gone"
                : socket.readyState !== socket.OPEN
                  ? "socket-not-open"
                  : "buffer-limit",
            );
            socket.terminate();
            return;
          }
          socket.send(bytes, { binary: true }, (error) => {
            if (error) {
              this.#videoEnded(streamId, "socket-send-error");
              socket.terminate();
            }
          });
        },
        () => {
          this.#videoEnded(streamId, "helper-media-ended");
          socket.terminate();
        },
        { deadline: this.#now() + 30_000 },
      );
      entry.media = media;
      if (!entry.owner.alive || socket.readyState !== socket.OPEN) media.close();
    } catch {
      this.#videoEnded(streamId, "helper-attach-failed");
      socket.terminate();
    }
  }

  #pruneViews(): void {
    for (const [id, entry] of this.#views)
      if (entry.expiresAt <= this.#leaseNow()) {
        this.#views.delete(id);
        this.#ownership.releaseView(id, entry.owner);
      }
  }

  async activateView(input: DesktopUseComputerViewInput): Promise<void> {
    this.#pruneViews();
    const entry = this.#views.get(input.viewId);
    if (
      !entry ||
      !entry.owner.alive ||
      entry.request.generation !== input.generation ||
      entry.expiresAt <= this.#leaseNow() ||
      entry.request.target.kind !== "app" ||
      entry.request.target.app.bundleId !== input.app.bundleId ||
      entry.request.target.app.teamId !== input.app.teamId ||
      entry.request.target.app.displayName !== input.app.displayName
    ) {
      throw new ComputerUseHelperFailure(
        "no-session",
        "That exact local app view is no longer open.",
      );
    }
    await this.#helper.request(
      "view.activate",
      {
        viewId: input.viewId,
        generation: input.generation,
        leaseDurationMs: Math.max(1, Math.ceil(entry.expiresAt - this.#leaseNow())),
        app: entry.request.target.app,
      },
      { deadline: this.#now() + 10_000 },
    );
    if (this.#views.get(input.viewId) !== entry || !entry.owner.alive)
      throw new ComputerUseHelperFailure("no-session", "That owner view ended during activation.");
  }

  #releaseViews(owner: BridgeOwner, closeNative = true): void {
    this.#stopVideos(owner, closeNative);
    for (const [id, entry] of this.#views) {
      if (entry.owner !== owner) continue;
      this.#views.delete(id);
      this.#ownership.releaseView(id, owner);
      const { viewId, generation } = entry.request;
      const leaseDurationMs = 1;
      if (closeNative && this.#helper.ownerViewVersion?.() === 3)
        void this.#helper
          .request(
            "view.close",
            { viewId, generation, leaseDurationMs },
            { deadline: this.#now() + 10_000 },
          )
          .catch(() => undefined);
    }
  }

  constructor(options: ComputerUseBridgeServerOptions) {
    this.#passwords = options.passwords;
    this.#graceMs = options.graceMs ?? computerUseBridgeGraceMs;
    this.#helper = options.helper;
    this.#log = options.log ?? (() => undefined);
    this.#onDataPermissionRequired = options.onDataPermissionRequired;
    this.#now = options.now ?? Date.now;
    this.#leaseNow = options.now ?? (() => performance.now());
    this.#ownership = options.ownership;
    this.#approvals = options.approvals;
    this.#token = options.token ?? mintComputerUseBridgeToken();
    this.#httpServer = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":"not_found"}');
    });
    this.#websocketServer = new WebSocketServer({
      maxPayload: computerUseBridgeMaxFrameBytes,
      noServer: true,
      perMessageDeflate: false,
    });
    this.#httpServer.on("upgrade", (request, socket, head) => {
      const mediaPath = new RegExp(`^${computerUseBridgePath}/display/([0-9a-f-]{36})$`, "i").exec(
        pathnameOf(request) ?? "",
      );
      if (pathnameOf(request) !== computerUseBridgePath && !mediaPath) {
        refuseConnection(socket, 404, "Not Found");
        return;
      }
      const token = bearerToken(request);
      if (!token || !safeTokenEqual(token, this.#token)) {
        refuseConnection(socket, 401, "Unauthorized");
        return;
      }
      if (mediaPath) {
        this.#websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          void this.#acceptMedia(mediaPath[1]!, websocket);
        });
        return;
      }
      // A slot has one Runner, and a live Runner holds one socket. A second
      // holder of the token while the first is connected is somebody else
      // with it, and is refused rather than given the slot's sessions.
      if (this.#claim !== null) {
        refuseConnection(socket, 409, "Conflict");
        return;
      }
      const claim: ConnectionClaim = { accepted: false };
      this.#claim = claim;
      const release = (): void => {
        if (this.#claim === claim) this.#claim = null;
      };
      socket.once("close", () => {
        if (!claim.accepted) release();
      });
      this.#websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        claim.accepted = true;
        this.#accept(
          websocket,
          release,
          request.headers[computerUseBridgeOwnerInputHeader] === "2" ? 2 : undefined,
        );
      });
    });
  }

  get token(): string {
    return this.#token;
  }

  get url(): URL {
    if (!this.#url) throw new Error("The computer use bridge is not listening.");
    return this.#url;
  }

  async start(): Promise<URL> {
    this.#httpServer.listen(0, "127.0.0.1");
    this.#listening = once(this.#httpServer, "listening");
    await this.#listening;
    const address = this.#httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("The computer use bridge address is unavailable.");
    }
    this.#url = new URL(`ws://127.0.0.1:${address.port}${computerUseBridgePath}`);
    return this.#url;
  }

  /**
   * The person's answer to one approval, to this slot's Runner, which carries
   * it to its Host. False when no Runner is connected: the answer is then
   * lost, and the request is asked again from the Runner's next list.
   */
  sendApprovalAnswer(
    frame: ComputerAppApprovalAnswerFrame,
    server: { readonly launchDigest: string; readonly serverId: string } | null,
  ): boolean {
    const connection = [...this.#connections].find(
      ({ socket }) => socket.readyState === socket.OPEN,
    );
    if (!connection) return false;
    send(connection.socket, { event: "approval.answer", kind: "event", params: frame, server });
    return true;
  }

  /** Tells this slot's Runner to read every app's readiness again. */
  announceGrantsChanged(): void {
    for (const { socket } of this.#connections) {
      if (socket.readyState === socket.OPEN)
        send(socket, { event: "grants.changed", kind: "event" });
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#dispose();
    return this.#closing;
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#closeRetries) clearTimeout(timer);
    this.#closeRetries.clear();
    await this.#listening?.catch(() => undefined);
    const closed = [
      new Promise<void>((resolvePromise) => this.#websocketServer.close(() => resolvePromise())),
    ];
    if (this.#httpServer.listening) closed.push(closeHttpServerNow(this.#httpServer));
    // Each socket's own close handler still ends the sessions it held on the
    // helper. The reason goes first as best effort; no answer is waited for.
    for (const { socket } of this.#connections) {
      if (socket.readyState === socket.OPEN) socket.close(1001, "stopping");
      socket.terminate();
    }
    await Promise.all(closed);
    this.#url = null;
  }

  #accept(socket: WebSocket, releaseClaim: () => void, ownerInputVersion: 2 | undefined): void {
    // The owner is the connection's identity for ownership and its liveness
    // fence in one object: `alive` is what tells an answer that arrived after
    // the socket died that it has nobody to go to. `opening` holds the
    // sessions whose `session.open` is still in flight, so the close handler
    // does not try to close a session the helper has not opened yet.
    const owner: BridgeOwner = {
      alive: true,
      ownerInputVersion,
      opening: new Set(),
      passwords: new Set(),
    };
    const detachEvents = this.#helper.onEvent((event) => {
      if (event.event !== "session.stopped") {
        if (
          this.#videos.get(event.params.streamId)?.owner === owner &&
          this.#ownership.ownsVideo(event.params.streamId, owner)
        ) {
          if (
            event.event === "display.owner-input" &&
            (owner.ownerInputVersion !== 2 || !this.#ownsVideoSource(event.params.source, owner))
          )
            return;
          send(socket, { ...event, kind: "event" });
          if (
            event.event === "display.state" &&
            ["stopped", "failed"].includes(event.params.state)
          ) {
            this.#videoEnded(event.params.streamId, event.params.reason ?? event.params.state);
            this.#ownership.releaseVideo(event.params.streamId, owner);
            this.#videos.delete(event.params.streamId);
          }
        }
        return;
      }
      if (!this.#ownership.owns(event.params.sessionId, owner)) return;
      send(socket, { ...event, kind: "event" });
      if (event.event === "session.stopped") this.#ownership.ended(event.params.sessionId);
    });
    const changed = () => {
      if (owner.alive) send(socket, { event: "grants.changed", kind: "event" });
    };
    const detachCapabilities = this.#helper.onCapabilitiesChanged?.(changed);
    const detachDisconnect = this.#helper.onDisconnect(() => {
      changed();
      this.#releaseViews(owner, false);
      // The helper is gone and so are its sessions; tell the Runner at once so
      // its local session cache and the Host's live-session projection do not
      // outlive native ownership. The connection is shared across slots, so
      // this reaches every bridge server on this Mac.
      for (const sessionId of this.#ownership.releaseAll(owner)) {
        owner.opening.delete(sessionId);
        if (!owner.alive) continue;
        send(socket, {
          event: "session.stopped",
          kind: "event",
          params: { reason: "app-quit", sessionId },
        });
      }
    });
    const connection: BridgeConnection = {
      detachEvents: () => {
        detachEvents();
        detachDisconnect();
        detachCapabilities?.();
      },
      socket,
    };
    this.#connections.add(connection);
    socket.on("message", (data: RawData) => {
      void this.#handle(socket, owner, data);
    });
    socket.once("close", () => {
      owner.alive = false;
      for (const id of owner.passwords) void this.#passwords?.end(id).catch(() => undefined);
      owner.passwords.clear();
      this.#releaseViews(owner);
      this.#approvals.disconnected();
      connection.detachEvents();
      this.#connections.delete(connection);
      releaseClaim();
      // A Runner's socket dropping ends its sessions on this Mac: the helper
      // is told, rather than left holding a session no live Run can reach. A
      // session whose open has not answered yet is closed by that answer
      // instead — closing one the helper has not opened would be a no-session
      // refusal now and a session nobody owns a moment later.
      for (const sessionId of this.#ownership.releaseAll(owner)) {
        if (owner.opening.has(sessionId)) continue;
        this.#endSession(sessionId, "runner-left");
      }
    });
    socket.once("error", () => socket.close());
  }

  async #handle(socket: WebSocket, owner: BridgeOwner, data: RawData): Promise<void> {
    const receivedAt = this.#now();
    this.#pruneViews();
    let frame: unknown;
    try {
      frame = JSON.parse(rawText(data));
    } catch {
      socket.close(1008, "invalid frame");
      return;
    }
    const parsed = ComputerUseBridgeFrameSchema.safeParse(frame);
    if (!parsed.success || parsed.data.kind !== "request") {
      socket.close(1008, "invalid frame");
      return;
    }
    const { id, method, params } = parsed.data;
    // One instant, fixed as the frame arrives: installing, connecting and the
    // helper frame all spend from it, and the helper frame carries what is left.
    const deadline = receivedAt + (parsed.data.timeoutMs ?? defaultBridgeTimeoutMs);
    const answer = (result: unknown): void => {
      if (owner.alive) send(socket, { id, kind: "response", result });
    };
    const refuse = (code: ComputerUseErrorCode, message: string): void => {
      if (owner.alive) send(socket, { error: { code, message }, id, kind: "response" });
    };
    if (method === "passwords.capabilities") {
      if (!computerUseBridgePasswordsParams[method].safeParse(params).success) {
        answer({ authority: null, receiver: null });
        return;
      }
      answer({
        authority: this.#passwords ? 1 : null,
        receiver: this.#helper.loginReceiver?.() ?? null,
      });
      return;
    }
    if (method === "passwords.control") {
      const command = computerUseBridgePasswordsParams[method].safeParse(params);
      if (!command.success || !this.#passwords) {
        answer({ type: "unavailable" });
        return;
      }
      if (
        (command.data.type === "login.seal" || command.data.type === "login.cancel") &&
        !owner.passwords.has(command.data.operationId)
      ) {
        answer({ type: "unavailable" });
        return;
      }
      if (command.data.type === "login.authorize") owner.passwords.add(command.data.operationId);
      try {
        answer(
          await this.#passwords.control(command.data, (event) => {
            if (
              event.type === "login.ended" ||
              (event.type === "login.result" && event.outcome.kind !== "authorized")
            )
              owner.passwords.delete(event.operationId);
            if (owner.alive)
              send(socket, { kind: "event", event: "passwords.event", params: event });
          }),
        );
        if (command.data.type === "login.cancel") owner.passwords.delete(command.data.operationId);
      } catch {
        answer({ type: "unavailable" });
      }
      return;
    }
    if (method === "permissions.request" || method === "data.request") {
      refuse(
        "unsupported",
        "Asking for a macOS grant happens on the Mac itself, as the person there chooses to.",
      );
      return;
    }
    if (method === "approvals.key-challenge") {
      const challenge =
        computerUseBridgeApprovalParams["approvals.key-challenge"].safeParse(params);
      if (!challenge.success) {
        refuse("failed", "Opensteer could not read that approval key challenge.");
        return;
      }
      try {
        answer(await this.#approvals.proveKeyChallenge(challenge.data));
      } catch (error) {
        refuse(
          "failed",
          error instanceof Error ? error.message : "This Mac could not prove its approval key.",
        );
      }
      return;
    }
    if (method === "approvals.list" || method === "approvals.outcome") {
      // Main's own business, never the helper's: taken now, acknowledged now.
      if (method === "approvals.list") {
        const list = computerUseBridgeApprovalParams["approvals.list"].safeParse(params);
        if (!list.success) {
          refuse("failed", "Opensteer could not read that approval list.");
          return;
        }
        this.#approvals.list(list.data);
      } else {
        const outcome = computerUseBridgeApprovalParams["approvals.outcome"].safeParse(params);
        if (!outcome.success) {
          refuse("failed", "Opensteer could not read that approval outcome.");
          return;
        }
        this.#approvals.outcome(outcome.data);
      }
      answer({});
      return;
    }
    if (method.startsWith("display.")) {
      if (
        (method === "display.input-reset" || method === "display.input") &&
        owner.ownerInputVersion !== 2
      ) {
        refuse("unsupported", "Negotiate Mac owner input before controlling this view.");
        return;
      }
      if (method === "display.attach") {
        refuse("unsupported", "Binary media attaches separately.");
        return;
      }
      if (
        method !== "display.input-reset" &&
        method !== "display.input" &&
        method !== "display.resolve" &&
        method !== "display.start" &&
        method !== "display.demand" &&
        method !== "display.refresh" &&
        method !== "display.stop"
      ) {
        refuse("unsupported", "Unsupported window video operation.");
        return;
      }
      const parsed = macWindowVideoParams[method].safeParse(params);
      if (!parsed.success) {
        refuse("failed", "Invalid window video request.");
        return;
      }
      const sources =
        method === "display.demand"
          ? (() => {
              const demand = macWindowVideoParams["display.demand"].parse(parsed.data);
              return [...demand.sources, ...(demand.warm?.sources ?? [])];
            })()
          : DisplayDemandSchema.parse(
              "source" in parsed.data
                ? [parsed.data.source]
                : "sources" in parsed.data
                  ? parsed.data.sources
                  : [],
            );
      if (!sources.every((source) => this.#ownsVideoSource(source, owner))) {
        refuse("no-session", "That window source belongs to another connection.");
        return;
      }
      const streamId = "streamId" in parsed.data ? parsed.data.streamId : null;
      if (streamId && method !== "display.start" && this.#videos.get(streamId)?.owner !== owner) {
        refuse("no-session", "That window video has ended.");
        return;
      }
      if (method === "display.start" && streamId) {
        if (
          this.#videos.has(streamId) ||
          this.#videos.size >= macDisplayMaxWindows ||
          !this.#ownership.claimVideo(streamId, owner)
        ) {
          refuse("busy", "Too many window videos.");
          return;
        }
        this.#videos.set(streamId, { owner });
      }
      const startingVideo =
        method === "display.start" && streamId ? this.#videos.get(streamId) : undefined;
      // Retire logical bookkeeping before awaiting native teardown. The helper
      // alone accounts for unresolved physical lifetimes.
      if (streamId && method === "display.stop") {
        const entry = this.#videos.get(streamId);
        this.#videoEnded(streamId, "display-stop");
        this.#ownership.releaseVideo(streamId, owner);
        this.#videos.delete(streamId);
        entry?.media?.close();
        entry?.socket?.terminate();
      }
      try {
        const forwarded =
          method === "display.resolve"
            ? (() => {
                const resolved = macWindowVideoParams["display.resolve"].parse(parsed.data);
                return {
                  source: resolved.source,
                  ...(owner.ownerInputVersion === 2 &&
                  this.#helper.ownerInputVersion?.() === 2 &&
                  resolved.ownerInputVersion === 2
                    ? { ownerInputVersion: 2 }
                    : {}),
                };
              })()
            : parsed.data;
        const result = await this.#helper.request(method, forwarded, { deadline });
        if (streamId && method === "display.start" && "attachmentToken" in result) {
          const entry = this.#videos.get(streamId);
          if (!entry || entry !== startingVideo || !owner.alive || this.#now() >= deadline) {
            if (entry === startingVideo) {
              this.#videoEnded(streamId, !owner.alive ? "owner-gone" : "startup-timeout");
              this.#ownership.releaseVideo(streamId, owner);
              this.#videos.delete(streamId);
              void this.#helper.request("display.stop", { streamId }).catch(() => undefined);
            }
            refuse("failed", "Window sharing startup timed out or ended.");
            return;
          }
          entry.attachmentToken = result.attachmentToken;
        }
        answer(result);
      } catch (error) {
        if (
          streamId &&
          method === "display.start" &&
          this.#videos.get(streamId) === startingVideo
        ) {
          this.#videoEnded(streamId, "startup-failed");
          this.#ownership.releaseVideo(streamId, owner);
          this.#videos.delete(streamId);
          void this.#helper.request("display.stop", { streamId }).catch(() => undefined);
        }
        const failure = asFailure(error);
        refuse(failure.code, failure.message);
      }
      return;
    }
    if (method === "view.windows") {
      const request = ComputerUseHelperRequestSchema.safeParse({ id: 0, method, params });
      if (!request.success || request.data.method !== "view.windows") {
        refuse("failed", "This Mac could not read that owner window request.");
        return;
      }
      const outcome = await this.#within(
        this.#helper.request("view.windows", request.data.params, { deadline }),
        deadline,
      );
      if (outcome.kind === "answer") answer(outcome.value);
      else this.#refuseWith(refuse, method, params, outcome);
      return;
    }
    if (method.startsWith("view.")) {
      if (method === "view.activate") {
        refuse("unsupported", "Activating an app is available only from this Mac's Desktop app.");
        return;
      }
      if (method !== "view.open" && this.#helper.ownerViewVersion?.() !== 3) {
        refuse("unsupported", "This Mac's helper does not support owner views.");
        return;
      }
      const parsedView = ComputerViewHelperRequestSchema.safeParse({ id: 0, method, params });
      if (!parsedView.success) {
        refuse("failed", "This Mac could not read that owner view request.");
        return;
      }
      const request = parsedView.data;
      const { viewId, generation, leaseDurationMs } = request.params;
      const expiresAt = this.#leaseNow() + leaseDurationMs;
      const old = this.#views.get(viewId);
      if (old && (old.owner !== owner || generation < old.request.generation)) {
        refuse("no-session", "That owner view belongs to another connection or generation.");
        return;
      }
      if (request.method !== "view.open" && (!old || old.request.generation !== generation)) {
        refuse("no-session", "That owner view has ended.");
        return;
      }
      if (request.method === "view.open") {
        if ((this.#views.size >= 64 && !old) || !this.#ownership.claimView(viewId, owner)) {
          refuse("no-session", "That owner view is expired or unavailable.");
          return;
        }
        this.#views.set(viewId, {
          owner,
          request: { method: "view.open", ...request.params },
          expiresAt,
        });
      }
      const entry = this.#views.get(viewId);
      if (request.method === "view.close") {
        this.#views.delete(viewId);
        this.#ownership.releaseView(viewId, owner);
      }
      const outcome = await this.#within(
        this.#helper.request(request.method, request.params, { deadline }),
        deadline,
      );
      if (outcome.kind === "answer") {
        if (request.method === "view.renew" && entry && this.#views.get(viewId) === entry)
          entry.expiresAt = Math.max(expiresAt, entry.expiresAt);
        if (!owner.alive && request.method === "view.open") {
          void this.#helper
            .request(
              "view.close",
              { viewId, generation, leaseDurationMs },
              { deadline: this.#now() + 10_000 },
            )
            .catch(() => undefined);
          return;
        }
        answer(outcome.value);
      } else {
        if (request.method === "view.open" && entry && this.#views.get(viewId) === entry) {
          this.#views.delete(viewId);
          this.#ownership.releaseView(viewId, owner);
          void this.#helper
            .request(
              "view.close",
              { viewId, generation, leaseDurationMs },
              { deadline: this.#now() + 10_000 },
            )
            .catch(() => undefined);
        }
        this.#refuseWith(refuse, request.method, params, outcome);
      }
      return;
    }
    const request = ComputerUseHelperRequestSchema.safeParse({ id: 0, method, params });
    if (!request.success) {
      refuse("failed", "Opensteer could not read that computer use request.");
      return;
    }
    if (method === "permissions.get") {
      const outcome = await this.#within(this.#helper.readinessPermissions({ deadline }), deadline);
      if (outcome.kind === "answer") {
        const ownerViewVersion = this.#helper.ownerViewVersion?.();
        const ownerInputVersion =
          owner.ownerInputVersion === 2 ? this.#helper.ownerInputVersion?.() : undefined;
        const computerUseVersion = this.#helper.computerUseVersion?.();
        answer({
          permissions: outcome.value,
          ...(computerUseVersion === undefined ? {} : { computerUseVersion }),
          ...(ownerViewVersion === undefined ? {} : { ownerViewVersion }),
          ...(ownerInputVersion === undefined ? {} : { ownerInputVersion }),
        });
      } else this.#refuseWith(refuse, method, params, outcome);
      return;
    }
    if (method === "data.status") {
      const outcome = await this.#within(this.#helper.readinessDataGrants({ deadline }), deadline);
      if (outcome.kind === "answer") answer({ grants: outcome.value });
      else this.#refuseWith(refuse, method, params, outcome);
      return;
    }
    if (
      request.data.method === "session.act" &&
      request.data.params.actions.some(
        (action) => action.type === "type" && typeof action.text !== "string",
      )
    ) {
      const receiver = this.#helper.loginReceiver?.();
      if (!receiver) {
        refuse("unsupported", "Update Opensteer to type saved logins.");
        return;
      }
      if (
        request.data.params.actions.some(
          (action) =>
            action.type === "type" &&
            typeof action.text !== "string" &&
            (action.text.sealed.binding.connectionId !== receiver.connectionId ||
              action.text.sealed.binding.connectionGeneration !== receiver.connectionGeneration),
        )
      ) {
        // The helper reconnected after sealing; the Host seals the next act anew.
        refuse(
          "failed",
          "The saved login was sealed for an earlier connection, so nothing was typed. Act again.",
        );
        return;
      }
    }
    const sessionId = sessionIdOf(request.data.params);
    if (sessionId && !this.#ownership.mayUse(sessionId, owner)) {
      refuse("no-session", "That computer use session belongs to another Run on this Mac.");
      return;
    }
    // Reserved before the await, not after it: an open that only claimed on
    // the way back would let a second Runner pass `mayUse` while the first
    // one's open was still in flight, and both would think they held the Mac.
    const opening = method === "session.open" && sessionId !== null;
    // Only an open that created the reservation may give it back on failure:
    // a repeated open of a session this connection already holds must not
    // hand a live session to whoever asks next.
    const created = opening && sessionId !== null && !this.#ownership.owns(sessionId, owner);
    if (opening && sessionId) {
      this.#ownership.claim(sessionId, owner);
      owner.opening.add(sessionId);
    }
    const outcome = await this.#within(
      this.#helper.request(method, request.data.params, { deadline }),
      deadline,
    );
    if (opening && sessionId) owner.opening.delete(sessionId);

    if (outcome.kind === "answer") {
      if (method === "session.close" && sessionId) this.#ownership.release(sessionId, owner);
      // The Runner that asked is gone, so this session has no owner that can
      // ever use it. Give it back to the Mac rather than leaving the helper
      // busy for a Run nobody can reach.
      if (!owner.alive && opening && sessionId) {
        this.#ownership.release(sessionId, owner);
        this.#endSession(sessionId, "runner-left");
        return;
      }
      answer(outcome.value);
      return;
    }

    const late =
      outcome.kind === "late" || outcome.error instanceof ComputerUseHelperDeadlineFailure;
    // A passive frame read can finish after its viewer leaves. Dropping that
    // answer must never close the agent's session or its shared bridge.
    const endedLate = sessionId !== null && late && method !== "session.close";
    if (endedLate && sessionId) {
      // The helper may still be working on it, and whatever it does next is
      // for a request nobody is waiting for. That one session ends; every
      // other session on the helper connection carries on.
      this.#ownership.release(sessionId, owner);
      this.#endSession(sessionId, "late");
    } else if (sessionId && method === "session.close") {
      // A close the helper refused or never confirmed still ends this
      // Runner's claim, so an idle helper connection can go and take the
      // session with it. One it did not confirm is also sent again from here,
      // whoever asked for it; the helper's idle lease ends it at the latest.
      this.#ownership.release(sessionId, owner);
      if (!(outcome.kind === "refused" && asFailure(outcome.error).code === "no-session")) {
        this.#retryClose(sessionId, "unconfirmed", 0);
      }
    } else if (created && sessionId) {
      this.#ownership.release(sessionId, owner);
    }
    const code = late ? "late" : asFailure(outcome.kind === "refused" ? outcome.error : null).code;
    this.#log("desktop.computer-use.bridge-request-failed", { code, method });
    if (method === "data.invoke" && code === "permission-required") {
      const invoked = ComputerUseDataInvokeParamsSchema.safeParse(params);
      const app = ComputerUseDataAppIdSchema.safeParse(invoked.data?.definitionId);
      if (invoked.success && app.success) {
        this.#onDataPermissionRequired?.({ access: invoked.data.access, definitionId: app.data });
      }
    }
    this.#refuseWith(refuse, method, params, outcome);
    // After the answer, so the Runner reads the refusal first: the session it
    // named is gone, and its Host must start another rather than reuse it.
    if (endedLate && sessionId && owner.alive) {
      send(socket, {
        event: "session.stopped",
        kind: "event",
        params: { reason: "app-quit", sessionId },
      });
    }
  }

  #refuseWith(
    refuse: (code: ComputerUseErrorCode, message: string) => void,
    method: ComputerUseHelperMethod,
    params: unknown,
    outcome: Exclude<Outcome<unknown>, { readonly kind: "answer" }>,
  ): void {
    if (outcome.kind === "late") {
      if (!computerUseRequestMayHaveEffect(method, params)) {
        refuse("failed", lateSentence);
        return;
      }
      refuse("outcome-unknown", method === "session.act" ? lateActSentence : lateWriteSentence);
      return;
    }
    const failure = asFailure(outcome.error);
    refuse(failure.code, failure.message);
  }

  /**
   * One helper call, waited for no longer than its deadline and this hop's
   * grace. A call still running then is abandoned here, never cancelled: its
   * answer is dropped when it comes.
   */
  async #within<Value>(call: Promise<Value>, deadline: number): Promise<Outcome<Value>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Outcome<Value>>((resolvePromise) => {
      timer = setTimeout(
        () => resolvePromise({ kind: "late" }),
        Math.max(0, deadline - this.#now()) + this.#graceMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([
        call.then(
          (value): Outcome<Value> => ({ kind: "answer", value }),
          (error: unknown): Outcome<Value> => ({ error, kind: "refused" }),
        ),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends one session on the helper; the answer is logged, never waited on by a Runner. */
  #endSession(sessionId: ComputerUseSessionId, reason: CloseReason, attempt = 0): void {
    void this.#helper
      .request("session.close", { sessionId }, { deadline: this.#now() + sessionCloseTimeoutMs })
      .catch((error: unknown) => {
        const failure = asFailure(error);
        if (failure.code === "no-session") return;
        this.#log("desktop.computer-use.session-close-failed", { code: failure.code, reason });
        this.#retryClose(sessionId, reason, attempt);
      });
  }

  #retryClose(sessionId: ComputerUseSessionId, reason: CloseReason, attempt: number): void {
    const delay = closeRetryDelaysMs[attempt];
    if (delay === undefined || this.#closed) return;
    const timer = setTimeout(() => {
      this.#closeRetries.delete(timer);
      if (!this.#closed) this.#endSession(sessionId, reason, attempt + 1);
    }, delay);
    timer.unref();
    this.#closeRetries.add(timer);
  }
}

type CloseReason = "late" | "runner-left" | "unconfirmed";

function sessionIdOf(params: unknown): ComputerUseSessionId | null {
  if (typeof params !== "object" || params === null) return null;
  const value = (params as { readonly sessionId?: unknown }).sessionId;
  const parsed = ComputerUseSessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asFailure(error: unknown): {
  readonly code: ComputerUseErrorCode;
  readonly message: string;
} {
  if (error instanceof ComputerUseHelperFailure) {
    return { code: error.code, message: error.message };
  }
  return { code: "failed", message: "Computer use failed on this Mac." };
}

function send(socket: WebSocket, frame: unknown): void {
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > computerUseBridgeMaxFrameBytes) {
    // Refusing here is the honest answer: a frame this side cannot send is not
    // one the Runner can be told to read a truncated version of.
    socket.send(
      JSON.stringify({
        error: {
          code: "failed",
          message: "This Mac's answer was too large to send over the computer use bridge.",
        },
        id: (frame as { readonly id?: number }).id ?? 0,
        kind: "response",
      }),
    );
    return;
  }
  socket.send(encoded);
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 && token.length <= 4_096 ? token : null;
}

function safeTokenEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

function pathnameOf(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "", "http://computer-use.invalid").pathname;
  } catch {
    return null;
  }
}
