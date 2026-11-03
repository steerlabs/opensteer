import { validateBrowserH264 } from "@opensteer/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  DisplayStreamIdSchema,
  decodeBrowserVideoFrame,
  displayMaxEnvelopeBytes,
  BrowserVideoMediaClientMessageSchema,
  browserPresentationRef,
  sameBrowserPresentation,
  sameRunnerAuxiliaryFence,
  type BrowserVideoDataTicketClaims,
  type BrowserVideoBudget,
  type BrowserVideoState,
  type BrowserPresentationRef,
  type BrowserVideoTarget,
  type BrowserServerMessage,
  type RunnerAuxiliaryFrameFence,
  type DisplayStreamId,
} from "@opensteer/protocol";
import {
  sameBrowserCapability,
  type BrowserCapabilityReference,
  type BrowserChannelId,
  type BrowserVideoOperation,
} from "@opensteer/protocol/browser-relay";
import { DisplayLinkRate } from "@opensteer/shared/displayLinkRate";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import {
  DisplayMediaHub,
  type DisplayMediaStream,
  type DisplayMediaViewer,
} from "../media/display-media-hub.js";
import { installWebSocketLiveness } from "../server/websocket-liveness.js";

export interface BrowserVideoBinding {
  readonly channelId: BrowserChannelId;
  fence(): RunnerAuxiliaryFrameFence;
  capability(): BrowserCapabilityReference;
  current(): boolean;
  send(operation: BrowserVideoOperation): Promise<void>;
}
export interface BrowserVideoViewer {
  readonly id: string;
  readonly input: boolean;
  readonly target: BrowserVideoTarget;
  readonly budget: BrowserVideoBudget;
  /** The existing admitted outlet checks login and current browser/profile authority. */
  authorized(): Promise<boolean>;
  send(message: BrowserServerMessage): Promise<void>;
  release(slot: string): Promise<void>;
  recover(slot: string, streamId: DisplayStreamId, through: number): Promise<void>;
}
interface Viewer extends DisplayMediaViewer {
  readonly owner: BrowserVideoViewer;
  readonly slot: string;
  readonly token: string;
  readonly expiresAt: number;
  budget: BrowserVideoBudget;
  socket: WebSocket | null;
  checkedAt: number;
  checking: boolean;
  attached: boolean;
  paused: boolean;
  recoveries: number;
  presented: BrowserPresentationRef | null;
  gesture: { id: string; reference: BrowserPresentationRef; submitted: boolean } | null;
  readonly offered: Map<number, BrowserPresentationRef>;
}
interface Stream extends DisplayMediaStream<Viewer> {
  readonly binding: BrowserVideoBinding;
  readonly target: BrowserVideoTarget;
  readonly id: DisplayStreamId;
  readonly claims: BrowserVideoDataTicketClaims;
  readonly viewers: Set<Viewer>;
  sequence: number;
  ptsUs: number;
  generation: number;
  producer: string | null;
  document: string | null;
  authority: string | null;
  data: WebSocket | null;
  claimed: boolean;
  closed: boolean;
  refreshAt: number;
  refreshPending: boolean;
  leader: Viewer | null;
  budget: BrowserVideoBudget;
  revision: number;
  budgetAt: number;
  uplinkBitrate: number;
  videoState: BrowserVideoState;
}
/** BrowserService owns watch/input authority. This hub only spends that admitted demand. */
export class BrowserVideoHub {
  #closed = false;
  readonly #auth: Pick<
    RunnerAuthenticator,
    "issueBrowserVideoDataTicket" | "verifyBrowserVideoDataTicket"
  >;
  readonly #streams = new Map<DisplayStreamId, Stream>();
  readonly #tokens = new Map<string, { stream: Stream; viewer: Viewer }>();
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  readonly #media = new DisplayMediaHub<Viewer, Stream>({
    now: () => this.#now(),
    live: (s, v) =>
      !s.closed &&
      !v.paused &&
      v.attached &&
      s.viewers.has(v) &&
      v.socket?.readyState === WebSocket.OPEN,
    refresh: (s) => this.#refresh(s),
    state: (s, v, state) => {
      if (v.socket?.readyState === WebSocket.OPEN)
        v.socket.send(
          JSON.stringify({
            ...s.videoState,
            ...(state.replayThrough === undefined ? {} : { replayThrough: state.replayThrough }),
          }),
        );
      void v.owner
        .send({
          ...s.videoState,
          ...(state.replayThrough === undefined ? {} : { replayThrough: state.replayThrough }),
        })
        .catch(() => this.remove(v.owner.id));
    },
    binary: (socket, bytes) => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + bytes.byteLength > displayMaxEnvelopeBytes
      ) {
        socket.close(1013, "Browser media backlog exceeded");
        return;
      }
      socket.send(bytes, { binary: true }, (error) => {
        if (error) socket.close(1013, "Browser media write failed");
      });
    },
  });
  constructor(
    auth: Pick<RunnerAuthenticator, "issueBrowserVideoDataTicket" | "verifyBrowserVideoDataTicket">,
    now = Date.now,
  ) {
    this.#auth = auth;
    this.#now = now;
    this.#timer = setInterval(() => this.sweep(), 100);
    this.#timer.unref();
  }
  async add(binding: BrowserVideoBinding, owner: BrowserVideoViewer): Promise<void> {
    if (this.#closed) throw new Error("Browser media hub closed.");
    this.remove(owner.id);
    if (this.#closed || !binding.current() || !(await owner.authorized()))
      throw new Error("Browser video authority ended.");
    let stream = [...this.#streams.values()].find(
      (s) =>
        s.binding === binding &&
        s.target.sessionId === owner.target.sessionId &&
        s.target.surfaceId === owner.target.surfaceId &&
        !s.closed,
    );
    let fresh = false;
    if (!stream) {
      const siblings = [...this.#streams.values()].filter(
        (s) => s.binding.fence().runnerId === binding.fence().runnerId,
      );
      const capacity = Math.min(2, ...siblings.map((s) => s.videoState.capacity?.maxSessions ?? 2));
      if (siblings.length >= capacity) throw new Error("Browser video capacity is full.");
      const id = DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`);
      const { claims, ticket } = this.#auth.issueBrowserVideoDataTicket({
        fence: binding.fence(),
        capability: binding.capability(),
        channelId: binding.channelId,
        target: owner.target,
        streamId: id,
      });
      const videoState: BrowserVideoState = {
        type: "browser.video.state",
        surfaceId: owner.target.surfaceId,
        streamId: id,
        state: "starting",
      };
      stream = {
        binding,
        target: owner.target,
        id,
        claims,
        viewers: new Set(),
        sequence: -1,
        ptsUs: -1,
        generation: 0,
        producer: null,
        document: null,
        authority: null,
        data: null,
        claimed: false,
        closed: false,
        refreshAt: -Infinity,
        refreshPending: false,
        leader: null,
        budget: { ...owner.budget, maxBitrate: Math.min(owner.budget.maxBitrate, 1_000_000) },
        revision: 0,
        budgetAt: this.#now(),
        uplinkBitrate: 1_000_000,
        videoState,
        state: { type: "display.state", state: "starting", generation: 0, width: 0, height: 0 },
        cache: [],
        cacheBytes: 0,
      };
      this.#streams.set(id, stream);
      fresh = true;
      const current = stream;
      // The start owns its original deadline. A stalled media socket cannot block control.
      void binding
        .send({
          ...binding.fence(),
          module: "browser",
          capability: binding.capability(),
          channelId: binding.channelId,
          target: owner.target,
          streamId: id,
          type: "browser.video.start",
          dataTicket: ticket,
          budget: stream.budget,
          creditWindow: 2,
          timeoutMs: 4000,
        })
        .catch(() => this.#end(current, "transport"));
    }
    if (stream.viewers.size >= 8) throw new Error("Too many browser video viewers.");
    if (
      this.#closed ||
      !binding.current() ||
      !(await owner.authorized()) ||
      stream.closed ||
      stream.viewers.size >= 8
    ) {
      if (fresh) this.#end(stream, "revoked");
      throw new Error("Browser video authority ended.");
    }
    const slot = randomUUID();
    const token = randomBytes(32).toString("base64url");
    // No socket exists until the one-use token is spent. It never receives media in this state.
    const viewer: Viewer = {
      owner,
      slot,
      token,
      expiresAt: this.#now() + 60000,
      budget: owner.budget,
      socket: null,
      checkedAt: this.#now(),
      checking: false,
      attached: false,
      displayWindow: true,
      link: new DisplayLinkRate({
        initialBitrate: 1_000_000,
        minimumBitrate: 50_000,
        maximumBitrate: 20_000_000,
      }),
      outstanding: new Map(),
      discarded: [],
      ackDelays: [],
      bytes: 0,
      keyframePending: false,
      waiting: true,
      replayIndex: null,
      replayThrough: null,
      slowSince: null,
      recoverySample: null,
      deliveryEstimate: null,
      paused: false,
      recoveries: 0,
      presented: null,
      gesture: null,
      offered: new Map(),
    };
    stream.viewers.add(viewer);
    if (owner.input && !stream.leader) stream.leader = viewer;
    this.#tokens.set(token, { stream, viewer });
    await owner.send({
      type: "browser.video.attached",
      surfaceId: owner.target.surfaceId,
      streamId: stream.id,
      mediaToken: token,
    });
    await owner.send(stream.videoState);
    this.#budget(stream);
  }
  /** Called on the already authorized outlet; the media token never grants this ability. */
  async presented(
    id: string,
    streamId: DisplayStreamId,
    reference: BrowserPresentationRef,
  ): Promise<void> {
    const found = this.#viewer(id, streamId);
    if (!found) throw new Error("Browser video outlet ended.");
    const { stream, viewer } = found;
    if (
      !viewer.owner.input ||
      !sameBrowserPresentation(
        viewer.offered.get(reference.sequence) ?? { ...reference, sequence: -1 },
        reference,
      )
    )
      throw new Error("Browser picture was not offered to this viewer.");
    if (!(await viewer.owner.authorized()) || stream.closed || !stream.viewers.has(viewer))
      throw new Error("Browser video authority ended.");
    viewer.presented = reference;
    for (const seq of viewer.offered.keys())
      if (seq < reference.sequence) viewer.offered.delete(seq);
    // Producer identity comes from the outlet, never from a client-selected slot.
  }
  async gesture(
    id: string,
    streamId: DisplayStreamId,
    gestureId: string,
    reference: BrowserPresentationRef,
    phase: "begin" | "cancel",
  ): Promise<void> {
    const found = this.#viewer(id, streamId);
    if (!found) throw new Error("Browser viewer ended.");
    const v = found.viewer;
    if (phase === "cancel") {
      if (v.gesture?.id === gestureId && !v.gesture.submitted) v.gesture = null;
      return;
    }
    if (v.gesture || !(await this.allowsClick(id, streamId, reference)))
      throw new Error("Browser gesture pin is unavailable.");
    v.gesture = { id: gestureId, reference, submitted: false };
    found.stream.leader = v;
    this.#budget(found.stream);
  }
  async allowsClick(
    id: string,
    streamId: DisplayStreamId,
    ref: BrowserPresentationRef,
  ): Promise<boolean> {
    const found = this.#viewer(id, streamId);
    if (!found) return false;
    const { stream, viewer } = found;
    const held =
      viewer.gesture?.reference.sequence === ref.sequence
        ? viewer.gesture.reference
        : viewer.offered.get(ref.sequence);
    return (
      viewer.owner.input &&
      held !== undefined &&
      sameBrowserPresentation(held, ref) &&
      (await viewer.owner.authorized()) &&
      !stream.closed &&
      stream.binding.current() &&
      stream.viewers.has(viewer)
    );
  }
  consumeGesture(id: string, streamId: DisplayStreamId, gestureId: string): boolean {
    const found = this.#viewer(id, streamId);
    if (!found || found.viewer.gesture?.id !== gestureId || found.viewer.gesture.submitted)
      return false;
    found.viewer.gesture.submitted = true;
    return true;
  }
  cancelGesture(id: string, streamId: DisplayStreamId) {
    const found = this.#viewer(id, streamId);
    const gesture = found?.viewer.gesture;
    if (!found || !gesture || gesture.submitted) return null;
    found.viewer.gesture = null;
    return { gestureId: gesture.id, reference: gesture.reference };
  }
  completeGesture(streamId: DisplayStreamId, slot: string, gestureId: string): string | null {
    const stream = this.#streams.get(streamId);
    const viewer = stream && [...stream.viewers].find((v) => v.slot === slot);
    if (!stream || !viewer || viewer.gesture?.id !== gestureId) return null;
    viewer.gesture = null;
    this.#budget(stream);
    return viewer.owner.id;
  }
  slot(id: string, streamId: DisplayStreamId): string | undefined {
    return this.#viewer(id, streamId)?.viewer.slot;
  }
  update(id: string, streamId: DisplayStreamId, budget: BrowserVideoBudget, focus: boolean): void {
    const found = this.#viewer(id, streamId);
    if (!found) return;
    found.viewer.budget = budget;
    if (focus && found.viewer.owner.input) found.stream.leader = found.viewer;
    if (found.viewer.paused) {
      found.viewer.paused = false;
      found.viewer.recoveries = 0;
      this.#refresh(found.stream);
    }
    this.#budget(found.stream);
  }
  remove(id: string): void {
    for (const stream of this.#streams.values())
      for (const viewer of stream.viewers)
        if (viewer.owner.id === id) {
          stream.viewers.delete(viewer);
          this.#tokens.delete(viewer.token);
          void viewer.owner.release(viewer.slot).catch(() => this.#end(stream, "transport"));
          if (viewer.attached) viewer.socket?.close(1000, "Browser outlet ended");
          if (stream.leader === viewer)
            stream.leader = [...stream.viewers].find((v) => v.owner.input) ?? null;
          if (!stream.viewers.size) this.#end(stream, "source-ended");
          else this.#budget(stream);
        }
  }
  async claimViewer(token: string): Promise<{ stream: Stream; viewer: Viewer }> {
    const found = this.#tokens.get(token);
    this.#tokens.delete(token);
    if (
      !found ||
      this.#now() >= found.viewer.expiresAt ||
      found.stream.closed ||
      !found.stream.binding.current() ||
      !(await found.viewer.owner.authorized()) ||
      !found.stream.viewers.has(found.viewer)
    )
      throw new Error("Browser media admission ended.");
    return found;
  }
  attachViewer({ stream, viewer }: { stream: Stream; viewer: Viewer }, socket: WebSocket): void {
    if (stream.closed || !stream.viewers.has(viewer) || viewer.attached) {
      socket.close(4003, "Browser outlet ended");
      return;
    }
    viewer.socket = socket;
    viewer.attached = true;
    installWebSocketLiveness(socket);
    socket.send(JSON.stringify(stream.videoState));
    socket.on("message", (raw, binary) => {
      if (stream.closed || !stream.viewers.has(viewer)) return;
      try {
        if (binary) throw new Error("Media credit must be JSON.");
        const message = BrowserVideoMediaClientMessageSchema.parse(
          JSON.parse(rawDataBuffer(raw).toString("utf8")),
        );
        if (message.streamId !== stream.id) throw new Error("Stale media credit.");
        if (message.type === "video.keyframe") {
          this.#recover(stream, viewer);
          return;
        }
        const first = viewer.outstanding.keys().next().value;
        if (viewer.discarded.length) {
          if (viewer.discarded[0] !== message.sequence) throw new Error("Invalid reset credit.");
          viewer.discarded.shift();
          return;
        }
        if (first !== message.sequence) throw new Error("Out of order media credit.");
        const entry = viewer.outstanding.get(message.sequence)!;
        viewer.link!.ack(message.sequence, this.#now());
        viewer.outstanding.delete(message.sequence);
        viewer.bytes -= entry.bytes;
        viewer.slowSince = null;
        if (viewer.replayIndex !== null) this.#media.drainCache(stream, viewer);
        if (viewer.waiting && viewer.outstanding.size === 0 && !viewer.paused)
          this.#recover(stream, viewer);
        this.#budget(stream);
      } catch {
        socket.close(4002, "Invalid browser media credit");
      }
    });
    socket.once("close", () => {
      if (stream.viewers.has(viewer)) this.remove(viewer.owner.id);
    });
    socket.on("error", () => this.remove(viewer.owner.id));
    // Controllers require a fresh publication hold. Spectators may decode a complete cached chain.
    if (viewer.owner.input || !this.#media.replay(stream, viewer)) this.#refresh(stream);
  }
  claimSource(ticket: string): BrowserVideoDataTicketClaims {
    const claims = this.#auth.verifyBrowserVideoDataTicket(ticket);
    const stream = this.#streams.get(claims.streamId);
    if (
      !stream ||
      stream.closed ||
      stream.claimed ||
      !stream.binding.current() ||
      !sameRunnerAuxiliaryFence(stream.claims, claims) ||
      !sameBrowserCapability(stream.claims.capability, claims.capability) ||
      claims.channelId !== stream.binding.channelId ||
      claims.target.sessionId !== stream.target.sessionId ||
      claims.target.surfaceId !== stream.target.surfaceId ||
      claims.nonce !== stream.claims.nonce
    )
      throw new Error("Browser media ticket does not name a live stream.");
    stream.claimed = true;
    return claims;
  }
  failSource(claims: BrowserVideoDataTicketClaims): void {
    const s = this.#streams.get(claims.streamId);
    if (s && s.claims.nonce === claims.nonce) this.#end(s, "transport");
  }
  attachSource(claims: BrowserVideoDataTicketClaims, socket: WebSocket): void {
    const stream = this.#streams.get(claims.streamId);
    if (
      !stream ||
      stream.closed ||
      !stream.claimed ||
      stream.data ||
      claims.nonce !== stream.claims.nonce ||
      !stream.binding.current()
    ) {
      socket.close(4003, "Browser stream ended");
      return;
    }
    stream.data = socket;
    installWebSocketLiveness(socket);
    socket.on("message", (raw, binary) => {
      if (stream.closed || !stream.binding.current()) {
        this.#end(stream, "revoked");
        return;
      }
      try {
        if (!binary) throw new Error("Binary browser media required.");
        const bytes = rawDataBuffer(raw);
        const { header, payload } = decodeBrowserVideoFrame(bytes);
        const p = header.presentation;
        if (
          header.streamId !== stream.id ||
          header.ptsUs <= stream.ptsUs ||
          (stream.sequence >= 0 && header.sequence !== stream.sequence + 1) ||
          header.generation < stream.generation ||
          (header.generation !== stream.generation && !header.key) ||
          (stream.producer && stream.producer !== p.producerStreamId) ||
          (stream.document && stream.document !== p.documentGeneration) ||
          (stream.authority && stream.authority !== p.authorityEpoch)
        )
          throw new Error("Browser source binding or reference chain changed.");
        validateBrowserH264(payload, header);
        if (header.key && bytes.byteLength > Math.max(64 * 1024, stream.budget.maxBitrate / 4)) {
          this.#end(stream, "budget");
          return;
        }
        stream.ptsUs = header.ptsUs;
        stream.sequence = header.sequence;
        stream.producer = p.producerStreamId;
        stream.document = p.documentGeneration;
        stream.authority = p.authorityEpoch;
        if (header.key) {
          this.#media.clearCache(stream);
          stream.refreshPending = false;
        }
        stream.generation = header.generation;
        stream.state = {
          type: "display.state",
          state: "live",
          generation: header.generation,
          width: header.width,
          height: header.height,
        };
        stream.videoState = {
          ...stream.videoState,
          state: "live",
          producerStreamId: p.producerStreamId,
        };
        this.#media.cacheFrame(stream, { sequence: header.sequence, bytes }, header.key);
        const retainFor: string[] = [];
        for (const viewer of stream.viewers) {
          if (!viewer.attached || viewer.paused) continue;
          if (viewer.owner.input && viewer.offered.size >= 4) {
            this.#media.skip(stream, viewer);
            this.#pause(stream, viewer);
            continue;
          }
          const offered = this.#media.offer(
            stream,
            viewer,
            { sequence: header.sequence, bytes },
            header.key,
            () => {
              if (viewer.owner.input) {
                viewer.offered.set(header.sequence, browserPresentationRef(header));
                retainFor.push(viewer.slot);
              }
            },
          );
          if (offered === "stalled") {
            const oldest = viewer.outstanding.values().next().value;
            if (oldest) viewer.link!.stalled(this.#now(), oldest.sentAt);
            if (viewer !== stream.leader && ++viewer.recoveries >= 2) this.#pause(stream, viewer);
          }
        }
        // Admission and hold transfer are independent of every viewer's decode/presentation.
        socket.send(
          JSON.stringify({
            type: "video.ack",
            streamId: stream.id,
            sequence: header.sequence,
            retainFor,
          }),
        );
        this.#budget(stream);
      } catch {
        this.#end(stream, "protocol");
      }
    });
    socket.once("close", () => this.#end(stream, "transport"));
    socket.on("error", () => this.#end(stream, "transport"));
  }
  state(binding: BrowserVideoBinding, id: DisplayStreamId, state: BrowserVideoState): void {
    const s = this.#streams.get(id);
    if (
      !s ||
      s.binding !== binding ||
      s.closed ||
      state.streamId !== id ||
      state.surfaceId !== s.target.surfaceId ||
      !binding.current()
    )
      return;
    if (state.producerStreamId && s.producer && state.producerStreamId !== s.producer) {
      this.#end(s, "protocol");
      return;
    }
    if (state.state === "starting" && s.sequence >= 0) return;
    if (state.state === "stopped" || state.state === "failed") {
      this.#end(s, state.reason ?? "source-ended");
      return;
    }
    if (state.uplinkBitrate) s.uplinkBitrate = state.uplinkBitrate;
    s.videoState = state;
    for (const v of s.viewers) void v.owner.send(state).catch(() => this.remove(v.owner.id));
  }
  retire(binding: BrowserVideoBinding): void {
    for (const s of this.#streams.values()) if (s.binding === binding) this.#end(s, "revoked");
  }
  retireTarget(binding: BrowserVideoBinding, surfaceId: string): void {
    for (const s of this.#streams.values())
      if (s.binding === binding && s.target.surfaceId === surfaceId) this.#end(s, "source-ended");
  }
  sweep(): void {
    const now = this.#now();
    for (const s of this.#streams.values()) {
      if (!s.binding.current()) {
        this.#end(s, "revoked");
        continue;
      }
      if (s.sequence < 0 && now > Date.parse(s.claims.issuedAt) + 25000) {
        this.#end(s, "timeout");
        continue;
      }
      if (s.refreshPending && now - s.refreshAt >= 500) this.#refresh(s);
      for (const v of s.viewers) {
        if (!v.attached && now >= v.expiresAt) {
          this.remove(v.owner.id);
          continue;
        }
        if (!v.checking && now - v.checkedAt >= 5000) {
          v.checking = true;
          void v.owner
            .authorized()
            .then(
              (allowed) => {
                if (!allowed && s.viewers.has(v)) this.remove(v.owner.id);
              },
              () => {
                if (s.viewers.has(v)) this.remove(v.owner.id);
              },
            )
            .finally(() => {
              v.checkedAt = this.#now();
              v.checking = false;
            });
        }
        const oldest = v.outstanding.values().next().value;
        if (oldest && now - oldest.sentAt > v.link!.baseRtt(now) + 250) {
          v.link!.stalled(now, oldest.sentAt);
          this.#media.skip(s, v);
          if (v !== s.leader) this.#pause(s, v);
        }
      }
      this.#budget(s);
    }
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const s of this.#streams.values()) this.#end(s, "source-ended");
    this.#tokens.clear();
  }
  #viewer(id: string, streamId: DisplayStreamId) {
    const stream = this.#streams.get(streamId);
    const viewer = stream && [...stream.viewers].find((v) => v.owner.id === id);
    return stream && viewer ? { stream, viewer } : null;
  }
  #refresh(s: Stream): void {
    if (s.closed) return;
    if (this.#now() - s.refreshAt < 500) {
      s.refreshPending = true;
      return;
    }
    s.refreshPending = false;
    s.refreshAt = this.#now();
    void s.binding
      .send({
        ...s.binding.fence(),
        module: "browser",
        capability: s.binding.capability(),
        channelId: s.binding.channelId,
        target: s.target,
        streamId: s.id,
        type: "browser.video.keyframe",
      })
      .catch(() => this.#end(s, "transport"));
  }
  #recover(s: Stream, v: Viewer): void {
    if (v.paused) return;
    const through = Math.max(0, ...v.offered.keys());
    for (const [seq, reference] of v.offered)
      if (
        seq <= through &&
        !sameBrowserPresentation(reference, v.presented ?? { ...reference, sequence: -1 }) &&
        !sameBrowserPresentation(reference, v.gesture?.reference ?? { ...reference, sequence: -1 })
      )
        v.offered.delete(seq);
    void v.owner.recover(v.slot, s.id, through).catch(() => this.#end(s, "transport"));
    if (v.discarded.length + v.outstanding.size > 64) {
      this.#pause(s, v);
      return;
    }
    v.discarded.push(...v.outstanding.keys());
    v.outstanding.clear();
    v.link!.forget();
    v.bytes = 0;
    v.waiting = true;
    v.replayIndex = null;
    v.replayThrough = null;
    if (v !== s.leader && ++v.recoveries > 1) {
      this.#pause(s, v);
      return;
    }
    if (v.owner.input || !this.#media.replay(s, v)) this.#refresh(s);
  }
  #pause(s: Stream, v: Viewer): void {
    if (v.paused) return;
    v.paused = true;
    v.replayIndex = null;
    void v.owner
      .send({ ...s.videoState, state: "paused", reason: "budget" })
      .catch(() => this.remove(v.owner.id));
  }
  #budget(s: Stream): void {
    if (s.closed) return;
    const viewers = [...s.viewers].filter((v) => !v.paused);
    if (!viewers.length) {
      if (s.viewers.size && ![...s.viewers].some((v) => v.gesture?.submitted))
        this.#end(s, "budget");
      return;
    }
    const leaders = s.leader && viewers.includes(s.leader) ? [s.leader] : viewers;
    const raster = leaders[0]!.budget;
    const cap = Math.min(
      s.uplinkBitrate,
      ...leaders.map((v) => Math.min(v.budget.maxBitrate, v.link!.cap ?? 20_000_000)),
    );
    const budget = {
      maxWidth: Math.min(...leaders.map((v) => v.budget.maxWidth)),
      maxHeight: Math.min(...leaders.map((v) => v.budget.maxHeight)),
      // A controller has three pending-presentation slots besides its current picture.
      // Keep that return path affordable before reducing readable raster density.
      maxFps: Math.min(
        ...leaders.map((v) =>
          Math.min(
            v.budget.maxFps,
            v.owner.input
              ? Math.max(1, Math.floor(3000 / (v.link!.baseRtt(this.#now()) + 100)))
              : 60,
          ),
        ),
        s.videoState.capacity?.maxFps ?? 60,
      ),
      maxBitrate: Math.max(50000, cap),
    };
    void raster;
    const old = s.budget;
    if (JSON.stringify(old) === JSON.stringify(budget)) return;
    const reduction = budget.maxBitrate < old.maxBitrate || budget.maxFps < old.maxFps;
    if (!reduction && this.#now() - s.budgetAt < 1000) return;
    // Raster changes replace an incarnation; v1 keeps the admitted readable raster during rate probes.
    if (budget.maxWidth !== old.maxWidth || budget.maxHeight !== old.maxHeight) {
      if (this.#now() - s.budgetAt < 1000 || [...s.viewers].some((v) => v.gesture !== null)) return;
      const owners = [...s.viewers]
        .sort((a, b) => (a === s.leader ? -1 : b === s.leader ? 1 : 0))
        .map((v) => ({ ...v.owner, budget: v.budget }));
      this.#end(s, "replaced");
      void (async () => {
        for (const owner of owners) await this.add(s.binding, owner);
      })().catch(() => undefined);
      return;
    }
    s.budget = budget;
    s.budgetAt = this.#now();
    void s.binding
      .send({
        ...s.binding.fence(),
        module: "browser",
        capability: s.binding.capability(),
        channelId: s.binding.channelId,
        target: s.target,
        streamId: s.id,
        type: "browser.video.budget",
        revision: ++s.revision,
        budget,
      })
      .catch(() => this.#end(s, "transport"));
  }
  #end(s: Stream, reason: NonNullable<BrowserVideoState["reason"]>): void {
    if (s.closed) return;
    s.closed = true;
    this.#streams.delete(s.id);
    this.#media.clearCache(s);
    s.data?.close(1000, "Browser video ended");
    for (const v of s.viewers) {
      this.#tokens.delete(v.token);
      void v.owner.send({ ...s.videoState, state: "stopped", reason }).catch(() => undefined);
      if (v.attached) v.socket?.close(1000, "Browser video ended");
    }
    s.viewers.clear();
    if (s.binding.current())
      void s.binding
        .send({
          ...s.binding.fence(),
          module: "browser",
          capability: s.binding.capability(),
          channelId: s.binding.channelId,
          target: s.target,
          streamId: s.id,
          type: "browser.video.stop",
        })
        .catch(() => undefined);
  }
}
