import type { AdministrationCommandIdentity } from "@opensteer/database";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import {
  OpensteerError,
  browserSessionClosedReason,
  type AgentEvent,
  type BrowserSourceId,
  type Request,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
  type DeploymentId,
} from "@opensteer/core";
import {
  browserSiteDomain,
  validateBrowserSourceSnapshot,
} from "@opensteer/browser-profile/source-state";
import type { BrowserSessionId } from "@opensteer/protocol";
import {
  BrowserSignInRequestResponseSchema,
  BrowserSourceClientMessageSchema,
  BrowserSourcePairInputSchema,
  browserSourceWireCurrent,
  browserSourceWireFloor,
  maxBrowserSourceFrameBytes,
  negotiateWire,
  parseWireQuery,
  readClientMessage,
  type ChromeCookiesResult,
  type ChromeCookiesUnavailableReason,
  type BrowserSignInDecision,
  type BrowserSignInOutcome,
  type BrowserSignInProblem,
  type BrowserSignInRequestResponse,
  type BrowserSourceClientFrame,
  type BrowserSourceClientMessage,
  type BrowserSourceHostFrame,
  type BrowserSourceHostMessage,
  type BrowserSourceInspection,
  type BrowserSourceStatus,
  type BrowserSourcesState,
  type UnknownMessage,
  type WireNegotiation,
} from "@opensteer/protocol/browser-sources";
import type {
  BrowserSignInActor,
  BrowserSignInReceipt,
  BrowserSiteGrantRecord,
  BrowserSourceRecord,
  BrowserSourceStore,
  RequestStore,
} from "@opensteer/database";
import {
  BrowserSourcePairChallengeSchema,
  browserSourceChallengeBytes,
  browserSourcePairChallengeBytes,
  browserSourceRouteChangedBytes,
  type BrowserSourceChallenge,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import type { BrowserService, BrowserSignInTarget } from "./browser-service.js";
import {
  admitSignIn,
  admitWithin,
  parseSignInSessionId,
  parseSignInSite,
  signInSiteRefusal,
} from "./sign-in-admission.js";

const pairingLifetimeMs = 15 * 60_000;
const operationTimeoutMs = 25_000;
const helloTimeoutMs = 10_000;
const heartbeatMs = 15_000;
const maxPendingOperations = 8;
const maxPendingSourceConnections = 8;
const pairChallengeWindowMs = 60_000;
const maxPairChallengesPerAddress = 30;
const drainPageSize = 64;
/** The first wire whose peers read frames tolerantly; wire-4 peers keep today's strict schemas. */
const tolerantWire = 5;

type AgentCopyInput = {
  readonly ownerId: UserId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly deploymentId: DeploymentId;
  readonly callId: string;
  readonly tabId: import("@opensteer/protocol").BrowserSurfaceId;
  readonly site: string;
  readonly reason: string;
};

/** A wire-4 peer's frames parse strictly; a newer peer's tolerantly. */
type ClientMessage = BrowserSourceClientMessage | BrowserSourceClientFrame;
type SourceReply = Extract<ClientMessage, { operationId: string }>;
type SourceSocket = {
  readonly sourceId: BrowserSourceId;
  readonly ownerId: UserId;
  readonly generation: number;
  readonly socket: WebSocket;
  readonly origin: string;
  readonly routeGeneration: number | null;
  ready: boolean;
  lastPongAt: number;
  readonly pending: Map<
    string,
    {
      readonly resolve: (message: SourceReply) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >;
};
type Candidate = {
  readonly source: BrowserSourceRecord;
  readonly status: BrowserSourceStatus | "offline";
};
/**
 * A delivery that stopped at the last check before import: a standing sign-in
 * whose site was removed, or a Request that is no longer pending.
 */
type Delivery =
  | BrowserSignInOutcome
  | { readonly status: "grant-removed" }
  | { readonly status: "request-closed" };
type DeliveryInput = {
  readonly actor: BrowserSignInActor;
  readonly invocationId: string;
  readonly ownerId: UserId;
  /** Create the site's grant on success (an owner's own click), rather than only use it. */
  readonly rememberSite: boolean;
  readonly requestId: RequestId | null;
  readonly settlementSessionId?: string;
  /** A standing sign-in stops if the site stops being allowed before import. */
  readonly requireGrant: boolean;
  readonly site: string;
  readonly source: BrowserSourceRecord;
  readonly target: BrowserSignInTarget;
};
type RequestDelivery = BrowserSignInOutcome | { readonly status: "request-closed" };
type SourceChoice =
  | { readonly source: BrowserSourceRecord }
  | { readonly problem: BrowserSignInProblem; readonly sourceName: string | null };
type SignInRequests = Pick<
  RequestStore,
  | "create"
  | "declineBrowserSignInRequest"
  | "findByCallIdentity"
  | "findPendingBrowserSignIn"
  | "fulfilBrowserSignInRequest"
  | "get"
  | "listDeliverableBrowserSignIns"
  | "listUngrantedBrowserSignIns"
>;

/**
 * Chrome sign-ins: the connected Chrome profiles (sources), the sites each
 * person may use, and delivering one site's sign-in into a live Browser
 * Session. The Host is the only party that imports: it exports from Chrome,
 * checks the site scope, re-checks authority, and sends `state.import` itself.
 */
export class BrowserSourceService {
  readonly #deploymentId: DeploymentId;
  readonly #store: BrowserSourceStore;
  readonly #requests: SignInRequests;
  readonly #browser: Pick<BrowserService, "applySiteCookies" | "signInTarget">;
  /** Signs with the Host identity key the invitation's authority names. */
  readonly #sign: (bytes: Uint8Array) => string;
  readonly #canonicalOrigin: string;
  readonly #extensionDirectory: string | null;
  readonly #currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
  readonly #onDeploymentEvent: (event: AgentEvent) => void;
  readonly #onRequestResolved: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #connections = new Map<BrowserSourceId, SourceSocket>();
  readonly #sockets = new Set<WebSocket>();
  readonly #pendingHandshakes = new Set<WebSocket>();
  /** Authenticated sources not yet ready; they replace a live connection only once ready. */
  readonly #authenticating = new Set<SourceSocket>();
  readonly #pendingByAddress = new Map<string, number>();
  readonly #turns = new Map<string, Promise<unknown>>();
  readonly #pairChallenges = new Map<string, number[]>();
  readonly #drains = new Map<UserId, Promise<void>>();
  readonly #calls = new Map<string, number[]>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #refusesSite: (site: string) => Promise<boolean>;
  #closed = false;

  constructor(options: {
    readonly deploymentId: DeploymentId;
    readonly store: BrowserSourceStore;
    readonly requests: SignInRequests;
    readonly browser: Pick<BrowserService, "applySiteCookies" | "signInTarget">;
    readonly sign: (bytes: Uint8Array) => string;
    readonly canonicalOrigin: string;
    /** The unpacked extension folder the desktop app keeps current, when there is one. */
    readonly extensionDirectory?: string | null;
    readonly currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
    /** A sign-in Request was fulfilled or declined, so its continuation can be sent. */
    readonly onRequestResolved: () => void;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
  }) {
    this.#deploymentId = options.deploymentId;
    this.#store = options.store;
    this.#requests = options.requests;
    this.#browser = options.browser;
    this.#sign = options.sign;
    this.#canonicalOrigin = options.canonicalOrigin;
    this.#extensionDirectory = options.extensionDirectory ?? null;
    this.#currentRoute = options.currentRoute;
    this.#onDeploymentEvent = options.onDeploymentEvent;
    this.#onRequestResolved = options.onRequestResolved;
    this.#onError = options.onError ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#refusesSite = signInSiteRefusal({
      canonicalOrigin: options.canonicalOrigin,
      currentRoute: options.currentRoute,
    });
    this.#heartbeat = setInterval(() => {
      void this.#pulse().catch(() => {});
    }, heartbeatMs);
    this.#heartbeat.unref?.();
  }

  /** `route` is the remote destination the invitation lists, if any. */
  async createPairing(input: {
    readonly ownerId: UserId;
    readonly route: PersonalHostAccessRouteEnvelope | null;
  }): Promise<{ readonly code: string; readonly expiresAt: string }> {
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#now() + pairingLifetimeMs);
    await this.#store.createPairing({
      codeHash: digest(code),
      ownerId: input.ownerId,
      expiresAt,
      canonicalOrigin: this.#canonicalOrigin,
      remoteOrigin: input.route?.document.route.origin ?? null,
      remoteGeneration: input.route?.document.route.generation ?? null,
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async pair(
    input: unknown,
    ingressOrigin: string,
  ): Promise<{ readonly sourceId: BrowserSourceId; readonly token: string }> {
    const parsed = BrowserSourcePairInputSchema.parse(input);
    if (parsed.version < browserSourceWireFloor || parsed.version > browserSourceWireCurrent) {
      throw new OpensteerError({
        code: "bad_request",
        reason: "unsupported-version",
        message: "Update the Opensteer extension and Opensteer so their versions match.",
      });
    }
    await this.#admitDestination(parsed, ingressOrigin);
    const token = randomBytes(32).toString("base64url");
    const source = await this.#store.consumePairing({
      codeHash: digest(parsed.code),
      tokenHash: digest(token),
      name: parsed.name,
      origin: parsed.origin,
      routeGeneration: parsed.routeGeneration,
      replaces: parsed.replaces
        ? { sourceId: parsed.replaces.sourceId, tokenHash: digest(parsed.replaces.token) }
        : null,
    });
    if (parsed.replaces) this.#endConnections(parsed.replaces.sourceId, source.ownerId);
    return { sourceId: source.id, token };
  }

  /**
   * Proves this Host holds the invitation's key for a destination it serves,
   * before the extension sends the one-use code or a replaced connection's
   * token. Unauthenticated, so bounded per address like source handshakes.
   */
  async pairChallenge(
    input: unknown,
    ingressOrigin: string,
    address: string,
  ): Promise<{ readonly signature: string }> {
    const challenge = BrowserSourcePairChallengeSchema.parse(input);
    if (!this.#admitPairChallenge(address)) {
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Too many Chrome connection attempts. Wait a minute and try again.",
      });
    }
    await this.#admitDestination(challenge, ingressOrigin);
    return { signature: this.#sign(browserSourcePairChallengeBytes(challenge)) };
  }

  /**
   * Accepts an upgraded source socket; only its first bounded frame may
   * authenticate it. `query` is the upgrade URL's: a wire-4 extension states no
   * `wire`, a newer one states the highest it speaks.
   */
  acceptSocket(
    socket: WebSocket,
    ingressOrigin: string,
    address: string,
    query: URLSearchParams,
  ): void {
    if (this.#closed) {
      socket.close(1012, "Host stopping");
      return;
    }
    const stated = parseWireQuery(query);
    if (stated.kind === "invalid") {
      socket.close(1008, "Invalid wire version");
      return;
    }
    const wire = negotiateWire(stated.kind === "valid" ? stated.wire : null);
    const tolerant = wire.kind === "negotiated" && wire.wire >= tolerantWire;
    if ((this.#pendingByAddress.get(address) ?? 0) >= maxPendingSourceConnections) {
      socket.close(1013, "Source connection capacity reached");
      return;
    }
    this.#sockets.add(socket);
    this.#pendingHandshakes.add(socket);
    this.#pendingByAddress.set(address, (this.#pendingByAddress.get(address) ?? 0) + 1);
    const clearPending = () => {
      if (!this.#pendingHandshakes.delete(socket)) return;
      const count = (this.#pendingByAddress.get(address) ?? 1) - 1;
      if (count === 0) this.#pendingByAddress.delete(address);
      else this.#pendingByAddress.set(address, count);
    };
    let peer: SourceSocket | null = null;
    let authenticating = false;
    let challengedSourceId: BrowserSourceId | null = null;
    let destination: { origin: string; routeGeneration: number | null } | null = null;
    let challengeAdmitted = false;
    let challenge: BrowserSourceChallenge | null = null;
    const helloTimer = setTimeout(
      () => socket.close(1008, "Source authentication timed out"),
      helloTimeoutMs,
    );
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, "JSON frames only");
        return;
      }
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString());
      if (bytes.byteLength > (peer ? maxBrowserSourceFrameBytes : 4_096)) {
        socket.close(1009, "Frame too large");
        return;
      }
      const message = readSourceMessage(bytes.toString("utf8"), tolerant);
      if (!message) {
        socket.close(1007, "Invalid source frame");
        return;
      }
      if (message.type === "unknown") {
        if (!peer) socket.close(1008, "Verify Host before authentication");
        return;
      }
      if (!peer) {
        if (message.type === "source.challenge" && challengedSourceId === null && !authenticating) {
          challengedSourceId = message.sourceId;
          destination = { origin: message.origin, routeGeneration: message.routeGeneration };
          challenge = {
            origin: message.origin,
            routeGeneration: message.routeGeneration,
            sourceId: message.sourceId,
            nonce: message.nonce,
          };
          const challenged = challenge;
          void this.#admitDestination(destination, ingressOrigin)
            .then(() => {
              if (socket.readyState !== WebSocket.OPEN) return;
              const signature = this.#sign(browserSourceChallengeBytes(challenged));
              challengeAdmitted = true;
              socket.send(
                JSON.stringify(
                  tolerant && wire.kind === "negotiated"
                    ? ({
                        type: "source.proof",
                        nonce: message.nonce,
                        signature,
                        wire: wire.wire,
                      } satisfies BrowserSourceHostFrame)
                    : ({
                        type: "source.proof",
                        nonce: message.nonce,
                        signature,
                      } satisfies BrowserSourceHostMessage),
                ),
              );
            })
            .catch((error: unknown) => this.#rejectHandshake(socket, error, challenged));
          return;
        }
        if (
          message.type !== "source.hello" ||
          authenticating ||
          !challengeAdmitted ||
          challengedSourceId !== message.sourceId ||
          !destination
        ) {
          socket.close(1008, "Verify Host before authentication");
          return;
        }
        authenticating = true;
        void this.#authenticateSocket(socket, message, destination, ingressOrigin, wire)
          .then((connected) => {
            if (!connected) return;
            peer = connected;
            clearPending();
            clearTimeout(helloTimer);
            this.#sourceReady(connected);
          })
          .catch((error: unknown) => this.#rejectHandshake(socket, error, challenge));
        return;
      }
      if (message.type === "source.hello" || message.type === "source.challenge") {
        socket.close(1008, "Duplicate authentication");
        return;
      }
      if (message.type === "pong") {
        peer.lastPongAt = this.#now();
        return;
      }
      if (message.type === "source.disconnect") {
        const disconnecting = peer;
        void this.revokeSource({ ownerId: disconnecting.ownerId, sourceId: disconnecting.sourceId })
          .catch(this.#onError)
          .finally(() => socket.close(1000, "Disconnected in Chrome"));
        return;
      }
      const pending = peer.pending.get(message.operationId);
      // A source can finish after the caller's timeout. Its stale reply must
      // not disconnect unrelated concurrent operations.
      if (!pending) return;
      peer.pending.delete(message.operationId);
      clearTimeout(pending.timeout);
      pending.resolve(message);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.#sockets.delete(socket);
      clearPending();
      if (!peer) return;
      if (this.#connections.get(peer.sourceId) === peer) this.#connections.delete(peer.sourceId);
      rejectPending(peer, new Error("Browser source disconnected"));
      void this.#store.markSeen(peer.sourceId).catch(this.#onError);
    });
    socket.on("error", () => socket.close());
  }

  async listState(input: { readonly ownerId: UserId }): Promise<BrowserSourcesState> {
    const [sources, grants] = await Promise.all([
      this.#store.list(input.ownerId),
      this.#store.listGrants(input.ownerId),
    ]);
    const active = new Set(sources.map((source) => source.id));
    return {
      extensionDirectory: this.#extensionDirectory,
      sources: sources.map((source) => ({
        connected: this.#isConnected(source.id),
        createdAt: source.createdAt.toISOString(),
        id: source.id,
        lastSeenAt: source.lastSeenAt?.toISOString() ?? null,
        name: source.name,
      })),
      sites: grants.map((grant) => ({
        createdAt: grant.createdAt.toISOString(),
        lastSignedInAt: grant.lastSignedInAt?.toISOString() ?? null,
        preferredSourceId:
          grant.preferredSourceId && active.has(grant.preferredSourceId)
            ? grant.preferredSourceId
            : null,
        site: grant.site,
        deploymentId: grant.deploymentId,
      })),
    };
  }

  /** What each of the owner's Chrome profiles reports for the site of `url`. */
  async inspect(input: {
    readonly ownerId: UserId;
    readonly url: string;
  }): Promise<BrowserSourceInspection> {
    const site = parseSignInSite(input.url);
    const candidates = await this.#candidates(await this.#store.list(input.ownerId), site);
    return {
      site,
      candidates: candidates.map((candidate) => ({
        name: candidate.source.name,
        sourceId: candidate.source.id,
        status: candidate.status,
      })),
    };
  }

  async renameSource(input: {
    readonly ownerId: UserId;
    readonly sourceId: BrowserSourceId;
    readonly name: string;
  }): Promise<void> {
    if (!(await this.#store.rename(input))) {
      throw new OpensteerError({
        code: "not_found",
        message: "That Chrome is no longer connected.",
      });
    }
  }

  async revokeSource(input: {
    readonly ownerId: UserId;
    readonly sourceId: BrowserSourceId;
  }): Promise<boolean> {
    const revoked = await this.#store.revoke(input);
    if (revoked) this.#endConnections(input.sourceId, input.ownerId);
    return revoked;
  }

  /** Stops future sign-ins to the site; browsers already signed in stay signed in. */
  async removeSite(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly ownerId: UserId;
    readonly deploymentId: DeploymentId;
    readonly site: string;
  }): Promise<void> {
    await this.#store.removeGrant({ ...input, site: parseSignInSite(input.site) });
  }

  /**
   * The owner signs the site of `url` in, in a session they control, and the
   * site is remembered for the personal deployment. The click is the consent.
   */
  async sessionSignIn(input: {
    readonly ownerId: UserId;
    readonly surfaceId?: string;
    readonly sessionId: string;
    readonly url: string;
    readonly sourceId: BrowserSourceId | null;
    readonly idempotencyKey: string;
  }): Promise<BrowserSignInOutcome> {
    const site = parseSignInSite(input.url);
    if (await this.#refusesSite(site)) return problem("not-allowed", site, null);
    const target = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      sessionId: parseSignInSessionId(input.sessionId),
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    });
    if (!target) {
      throw new OpensteerError({ code: "not_found", message: "Browser Session not found." });
    }
    const invocationId = invocationUuid(`owner:${input.ownerId}:${input.idempotencyKey}`);
    const receipt = await this.#store.getSignIn({ ownerId: input.ownerId, invocationId });
    if (receipt) return appliedOutcome(assertReceiptScope(receipt, target.sessionId, site));
    if (!target.live) return problem("session-closed", site, null);
    if (!target.stateImport) return problem(stateImportRefusal(target), site, null);
    const choice = await this.#chooseForOwner(
      input.ownerId,
      target.deploymentId,
      site,
      input.sourceId,
    );
    if ("problem" in choice) return problem(choice.problem, site, choice.sourceName);
    const delivered = await this.#deliver({
      actor: "owner",
      invocationId,
      ownerId: input.ownerId,
      rememberSite: true,
      requestId: null,
      requireGrant: false,
      site,
      source: choice.source,
      target,
    });
    // Neither stop applies: an owner's own sign-in needs no grant or Request.
    if (delivered.status === "grant-removed" || delivered.status === "request-closed") {
      throw new Error("Owner sign-in stopped at a check it does not make");
    }
    return delivered;
  }

  /**
   * An agent copies one site's Chrome cookies into one live session. A
   * remembered site copies at once; anything else opens one Request, which
   * completes by itself once a connected Chrome can supply the cookies.
   */
  async agentCopyChromeCookies(input: AgentCopyInput): Promise<ChromeCookiesResult> {
    const site = parseSignInSite(input.site);
    if (await this.#refusesSite(site)) return unavailable(site, "not-allowed");
    const target = await this.#browser.signInTarget({
      agentBindingId: `run:${input.runId}`,
      ownerId: input.ownerId,
      tabId: input.tabId,
    });
    if (!target?.live) return unavailable(site, "session-closed");
    const sessionId = target.sessionId;
    const invocationId = invocationUuid(`agent:${input.runId}:${input.callId}`);
    const receipt = await this.#store.getSignIn({ ownerId: input.ownerId, invocationId });
    if (receipt) return copiedResult(assertReceiptScope(receipt, sessionId, site));
    const prior = await this.#requests.findByCallIdentity({
      callId: input.callId,
      originatingRunId: input.runId,
    });
    if (prior) {
      this.#assertRequestTab(prior, input.tabId);
      return this.#requestResult(prior, sessionId, site);
    }
    if (!target.stateImport) return unavailable(site, stateImportRefusal(target));
    const grant = await this.#store.getGrant({
      ownerId: input.ownerId,
      site,
      deploymentId: target.deploymentId,
    });
    const sources = await this.#store.list(input.ownerId);
    const candidates = grant ? [] : await this.#candidates(sources, site);
    if (!this.#admitCall(input.runId, sessionId, site)) return unavailable(site, "rate-limited");
    if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "no-state"))
      return unavailable(site, "chrome-signed-out");
    const pending = await this.#requests.findPendingBrowserSignIn({
      originatingRunId: input.runId,
      ownerId: input.ownerId,
      site,
    });
    if (pending) {
      this.#assertRequestTab(pending, input.tabId);
      return this.#completePending(pending, grant, sources, sessionId, site);
    }
    const ask = () => this.#openRequest({ ...input, site, target });
    if (grant) {
      const chosen = await this.#standingSource(grant, sources, site);
      if (chosen) {
        const delivered = await this.#deliver({
          actor: "agent",
          invocationId,
          ownerId: input.ownerId,
          rememberSite: false,
          requestId: null,
          requireGrant: true,
          site,
          source: chosen,
          target,
        });
        const result = agentResult(delivered, site);
        if (result) return result;
      }
      return ask();
    }
    const asked = await ask();
    // A Chrome that connected after `candidates` may have run its check before
    // this Request was stored; check again for it.
    const connectedSince = (await this.#store.list(input.ownerId)).some(
      (source) =>
        this.#isConnected(source.id) &&
        !candidates.some(
          (candidate) => candidate.source.id === source.id && candidate.status !== "offline",
        ),
    );
    if (asked.status === "pending" && !asked.replayed && connectedSince) {
      const request = await this.#requests.get(asked.requestId);
      if (request) await this.#endIfUnservable(input.ownerId, request, new Map());
    }
    return asked;
  }

  /**
   * The owner's answer to a sign-in Request. Allow remembers the site for the
   * personal deployment, then signs in; a problem leaves the Request pending
   * and is returned so the card can show how to fix it.
   */
  async respond(input: {
    readonly ownerId: UserId;
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly decision: BrowserSignInDecision;
  }): Promise<BrowserSignInOutcome | null> {
    const request = await this.#requests.get(input.requestId);
    if (
      !request ||
      request.requestedBy !== input.ownerId ||
      request.payload.kind !== "browser.sign-in"
    ) {
      throw new OpensteerError({ code: "not_found", message: "Sign-in Request not found." });
    }
    const { site } = request.payload;
    if (input.decision.decision === "decline") {
      // In the Request's turn, so a delivery already past its last check
      // finishes first and one that has not reached it sees the decline.
      const declined = await this.#inTurn(`request\0${request.id}`, () =>
        this.#requests.declineBrowserSignInRequest({
          requestId: input.requestId,
          resolvedBy: input.ownerId,
          ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
        }),
      );
      for (const event of declined.events) this.#onDeploymentEvent(event);
      this.#onRequestResolved();
      return null;
    }
    if (request.status !== "pending") {
      const settled = BrowserSignInRequestResponseSchema.safeParse(
        request.status === "fulfilled" && request.response.kind === "external"
          ? request.response.value
          : undefined,
      );
      if (settled.success) {
        switch (settled.data.outcome) {
          case "applied":
            return {
              profileName: settled.data.profileName,
              site,
              sourceName: settled.data.sourceName,
              status: "applied",
            };
          case "not-signed-in":
            return problem("no-state", site, null);
          case "session-closed":
            return problem("session-closed", site, null);
        }
      }
      throw new OpensteerError({ code: "conflict", message: "The sign-in Request is closed." });
    }
    if (await this.#refusesSite(site)) return problem("not-allowed", site, null);
    const source = await this.#store.get(input.decision.sourceId, input.ownerId);
    if (!source) {
      throw new OpensteerError({
        code: "not_found",
        message: "That Chrome is no longer connected.",
      });
    }
    await this.#store.upsertGrant({
      ownerId: input.ownerId,
      preferredSourceId: source.id,
      site,
      deploymentId: this.#deploymentId,
    });
    const delivered = await this.#deliverRequest(request, source, input.settlementSessionId);
    if (delivered.status === "request-closed") {
      throw new OpensteerError({ code: "conflict", message: "The sign-in Request is closed." });
    }
    return delivered;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    for (const socket of this.#sockets) socket.close(1001, "Host stopping");
    this.#connections.clear();
  }

  disconnectRouteAdmittedSources(): void {
    for (const peer of [...this.#connections.values(), ...this.#authenticating]) {
      if (peer.routeGeneration !== null) this.#routeChanged(peer.socket);
    }
  }

  /** Ends the source's live connection and any connection still authenticating for it. */
  #endConnections(sourceId: BrowserSourceId, ownerId: UserId): void {
    for (const peer of [this.#connections.get(sourceId), ...this.#authenticating]) {
      if (peer?.sourceId === sourceId && peer.ownerId === ownerId)
        this.#sourceUnauthorized(peer.socket);
    }
  }

  #sourceReady(peer: SourceSocket): void {
    void this.#store.markSeen(peer.sourceId).catch(this.#onError);
    const previous = this.#drains.get(peer.ownerId) ?? Promise.resolve();
    const drain = previous
      .then(() => this.#drain(peer.ownerId, peer.sourceId))
      .then(() => this.#endUnservable(peer.ownerId, peer.sourceId))
      .catch(this.#onError)
      .finally(() => {
        if (this.#drains.get(peer.ownerId) === drain) this.#drains.delete(peer.ownerId);
      });
    this.#drains.set(peer.ownerId, drain);
  }

  /**
   * Completes pending Requests this Chrome can now answer: those whose site
   * was allowed with this Chrome preferred, or allowed with no usable
   * preference when this is the only Chrome signed in. Others stay pending.
   */
  async #drain(ownerId: UserId, sourceId: BrowserSourceId): Promise<void> {
    let after: RequestId | null = null;
    for (;;) {
      if (this.#closed || !this.#isConnected(sourceId)) return;
      const page: readonly Request[] = await this.#requests.listDeliverableBrowserSignIns({
        after,
        limit: drainPageSize,
        ownerId,
        sourceId,
      });
      const sources = await this.#store.list(ownerId);
      const ready = sources.find((source) => source.id === sourceId);
      if (!ready) return;
      for (const request of page) {
        if (this.#closed || !this.#isConnected(sourceId)) return;
        if (request.payload.kind !== "browser.sign-in") continue;
        const grant = await this.#store.getGrant({
          ownerId,
          site: request.payload.site,
          deploymentId: this.#deploymentId,
        });
        if (!grant) continue;
        const chosen = await this.#standingSource(grant, sources, request.payload.site);
        if (chosen?.id !== sourceId) continue;
        try {
          await this.#deliverRequest(request, ready);
        } catch (error) {
          this.#onError(error);
        }
      }
      if (page.length < drainPageSize) return;
      after = page.at(-1)!.id;
    }
  }

  /**
   * Ends pending Requests nobody has allowed once every Chrome is connected
   * and none has a sign-in to the site, so the agent can try another way in
   * instead of waiting on a card with no Allow. The same rule
   * `agentCopyChromeCookies` applies before it opens one.
   */
  async #endUnservable(ownerId: UserId, sourceId: BrowserSourceId): Promise<void> {
    const unservable = new Map<string, Promise<BrowserSignInRequestResponse | null>>();
    let after: RequestId | null = null;
    for (;;) {
      if (this.#closed || !this.#isConnected(sourceId)) return;
      const page: readonly Request[] = await this.#requests.listUngrantedBrowserSignIns({
        after,
        limit: drainPageSize,
        ownerId,
      });
      if (page.length === 0) return;
      for (const request of page) {
        if (this.#closed || !this.#isConnected(sourceId)) return;
        try {
          await this.#endIfUnservable(ownerId, request, unservable);
        } catch (error) {
          this.#onError(error);
        }
      }
      if (page.length < drainPageSize) return;
      after = page.at(-1)!.id;
    }
  }

  /** `unservable` memoizes each site's check across one pass. */
  async #endIfUnservable(
    ownerId: UserId,
    request: Request,
    unservable: Map<string, Promise<BrowserSignInRequestResponse | null>>,
  ): Promise<void> {
    if (request.payload.kind !== "browser.sign-in") return;
    const { site } = request.payload;
    let check = unservable.get(site);
    if (!check) {
      check = this.#unservableResponse(ownerId, site);
      unservable.set(site, check);
    }
    const response = await check;
    if (!response) return;
    // In the Request's turn, after an Allow already delivering.
    await this.#inTurn(`request\0${request.id}`, async () => {
      const grant = await this.#store.getGrant({
        ownerId,
        site,
        deploymentId: this.#deploymentId,
      });
      if (grant) return;
      const settled = await this.#requests.fulfilBrowserSignInRequest({
        ownerId,
        requestId: request.id,
        response,
      });
      if (!settled) return;
      for (const event of settled.events) this.#onDeploymentEvent(event);
      this.#onRequestResolved();
    });
  }

  async #unservableResponse(
    ownerId: UserId,
    site: string,
  ): Promise<BrowserSignInRequestResponse | null> {
    const candidates = await this.#candidates(await this.#store.list(ownerId), site);
    if (
      candidates.length === 0 ||
      !candidates.every((candidate) => candidate.status === "no-state")
    ) {
      return null;
    }
    return { outcome: "not-signed-in" };
  }

  /**
   * The Chrome a standing grant signs in with right now: its preferred Chrome
   * when connected, else, with no usable preference, the only connected
   * Chrome signed in to the site. Null when the owner has to act.
   */
  async #standingSource(
    grant: BrowserSiteGrantRecord,
    sources: readonly BrowserSourceRecord[],
    site: string,
  ): Promise<BrowserSourceRecord | null> {
    const preferred = sources.find((source) => source.id === grant.preferredSourceId);
    if (preferred) return this.#isConnected(preferred.id) ? preferred : null;
    const available = (await this.#candidates(sources, site)).filter(
      (candidate) => candidate.status === "available",
    );
    return available.length === 1 ? available[0]!.source : null;
  }

  /**
   * An agent asked again while its Request is pending. If the site has been
   * allowed some other way since (the toolbar, another card) and a Chrome can
   * answer, the Request completes now instead of waiting for a reconnect.
   */
  async #completePending(
    request: Request,
    grant: BrowserSiteGrantRecord | null,
    sources: readonly BrowserSourceRecord[],
    sessionId: BrowserSessionId,
    site: string,
  ): Promise<ChromeCookiesResult> {
    const sameSession =
      request.payload.kind === "browser.sign-in" && request.payload.sessionId === sessionId;
    const chosen = grant && sameSession ? await this.#standingSource(grant, sources, site) : null;
    if (!chosen) return { status: "pending", site, requestId: request.id, replayed: true };
    const delivered = await this.#deliverRequest(request, chosen);
    if (delivered.status === "applied") return copiedResult(delivered);
    const current = (await this.#requests.get(request.id)) ?? request;
    return this.#requestResult(current, sessionId, site);
  }

  /** One Request delivers at a time, and never alongside its decline. */
  #deliverRequest(
    request: Request,
    source: BrowserSourceRecord,
    settlementSessionId?: string,
  ): Promise<RequestDelivery> {
    return this.#inTurn(`request\0${request.id}`, () =>
      this.#deliverRequestInTurn(request, source, settlementSessionId),
    );
  }

  async #deliverRequestInTurn(
    request: Request,
    source: BrowserSourceRecord,
    settlementSessionId?: string,
  ): Promise<RequestDelivery> {
    if (request.payload.kind !== "browser.sign-in") throw new Error("Not a sign-in Request");
    const { site } = request.payload;
    const sessionId = parseSignInSessionId(request.payload.sessionId);
    const target = await this.#browser.signInTarget({
      ownerId: request.requestedBy,
      sessionId,
      ...(request.payload.tabId ? { tabId: request.payload.tabId } : {}),
    });
    const closed = async (): Promise<RequestDelivery> => {
      const settled = await this.#requests.fulfilBrowserSignInRequest({
        ownerId: request.requestedBy,
        requestId: request.id,
        response: { outcome: "session-closed" },
      });
      if (!settled) return { status: "request-closed" };
      for (const event of settled.events) this.#onDeploymentEvent(event);
      this.#onRequestResolved();
      return problem("session-closed", site, null);
    };
    if (!target?.live || target.deploymentId !== this.#deploymentId) return closed();
    if (!target.stateImport) return problem(stateImportRefusal(target), site, null);
    if (!this.#isConnected(source.id)) return problem("chrome-offline", site, source.name);
    const delivered = await this.#deliver({
      actor: "request",
      ...(settlementSessionId ? { settlementSessionId } : {}),
      invocationId: invocationUuid(`request:${request.id}`),
      ownerId: request.requestedBy,
      rememberSite: false,
      requestId: request.id,
      requireGrant: true,
      site,
      source,
      target,
    });
    if (delivered.status === "grant-removed") return problem("site-removed", site, null);
    if (delivered.status === "problem" && delivered.problem === "session-closed") return closed();
    return delivered;
  }

  async #openRequest(input: {
    readonly ownerId: UserId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly deploymentId: DeploymentId;
    readonly callId: string;
    readonly reason: string;
    readonly site: string;
    readonly target: BrowserSignInTarget;
  }): Promise<ChromeCookiesResult> {
    const current = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      agentBindingId: `run:${input.runId}`,
      sessionId: input.target.sessionId,
      ...(input.target.tabId ? { tabId: input.target.tabId } : {}),
    });
    if (!current?.live) return unavailable(input.site, "session-closed");
    const created = await this.#requests
      .create({
        callId: input.callId,
        kind: "browser.sign-in",
        mode: "durable",
        originatingRunId: input.runId,
        originatingThreadId: input.threadId,
        payload: {
          kind: "browser.sign-in",
          ...(input.target.tabId ? { tabId: input.target.tabId } : {}),
          reason: input.reason,
          sessionId: input.target.sessionId,
          site: input.site,
        },
        presentation: {
          detail: input.reason,
          kind: "external",
          subject: { id: input.site, kind: "browser-site" },
          title: `Use your Chrome sign-in for ${browserSiteDomain(input.site)}`,
        },
        requestedBy: input.ownerId,
        requiredActor: "requester",
      })
      .catch((error: unknown) => {
        // Method selection used a snapshot; the session can end before the
        // Request is stored, which the database refuses as closed.
        if (error instanceof OpensteerError && error.reason === browserSessionClosedReason) {
          return null;
        }
        throw error;
      });
    if (!created) return unavailable(input.site, "session-closed");
    for (const event of created.events) this.#onDeploymentEvent(event);
    return this.#requestResult(
      created.request,
      input.target.sessionId,
      input.site,
      created.replayed,
    );
  }

  #assertRequestTab(request: Request, tabId?: import("@opensteer/protocol").BrowserSurfaceId) {
    if (tabId && request.payload.kind === "browser.sign-in" && request.payload.tabId !== tabId)
      throw new OpensteerError({
        code: "conflict",
        message: "This sign-in Request belongs to a different tab. Return to that tab to continue.",
      });
  }

  #requestResult(
    request: Request,
    sessionId: BrowserSessionId,
    site: string,
    replayed = true,
  ): ChromeCookiesResult {
    if (
      request.payload.kind !== "browser.sign-in" ||
      request.payload.site !== site ||
      request.payload.sessionId !== sessionId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "This call already asked for a different site or tab.",
      });
    }
    return chromeCookiesResult(request, replayed);
  }

  async #chooseForOwner(
    ownerId: UserId,
    deploymentId: DeploymentId,
    site: string,
    sourceId: BrowserSourceId | null,
  ): Promise<SourceChoice> {
    if (sourceId) {
      const source = await this.#store.get(sourceId, ownerId);
      if (!source) {
        throw new OpensteerError({
          code: "not_found",
          message: "That Chrome is no longer connected.",
        });
      }
      return this.#isConnected(source.id)
        ? { source }
        : { problem: "chrome-offline", sourceName: source.name };
    }
    const [grant, sources] = await Promise.all([
      this.#store.getGrant({ ownerId, site, deploymentId }),
      this.#store.list(ownerId),
    ]);
    const preferred = sources.find((source) => source.id === grant?.preferredSourceId);
    if (preferred && this.#isConnected(preferred.id)) return { source: preferred };
    if (sources.length === 0) return { problem: "no-chrome", sourceName: null };
    const candidates = await this.#candidates(sources, site);
    const available = candidates.filter((candidate) => candidate.status === "available");
    if (available.length === 1 && available[0]) return { source: available[0].source };
    if (available.length > 1) return { problem: "choose-source", sourceName: null };
    const offline = candidates.filter((candidate) => candidate.status === "offline");
    const online = candidates.filter((candidate) => candidate.status !== "offline");
    const only = (list: readonly Candidate[]) => (list.length === 1 ? list[0]!.source.name : null);
    if (offline.length > 0 && online.every((candidate) => candidate.status === "no-state")) {
      return { problem: "chrome-offline", sourceName: only(offline) };
    }
    const blocked = online.find((candidate) => candidate.status !== "no-state");
    if (blocked && blocked.status !== "available" && blocked.status !== "offline") {
      return { problem: blocked.status, sourceName: blocked.source.name };
    }
    return { problem: "no-state", sourceName: only(online) };
  }

  /**
   * One sign-in: export from Chrome, check the scope, re-check authority, apply
   * to the live context, then record it. Sign-ins into one browser context and
   * site run one at a time, and an invocation already recorded is returned
   * without exporting again.
   */
  #deliver(input: DeliveryInput): Promise<Delivery> {
    return this.#inTurn(
      `context\0${input.target.profileId ?? input.target.sessionId}\0${input.site}`,
      () => this.#performDelivery(input),
    );
  }

  /** Runs `operation` after every earlier operation with the same key settles. */
  #inTurn<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#turns.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#turns.set(key, settled);
    void settled.then(() => {
      if (this.#turns.get(key) === settled) this.#turns.delete(key);
    });
    return result;
  }

  async #performDelivery(input: DeliveryInput): Promise<Delivery> {
    const { site, source, target } = input;
    const receipt = await this.#store.getSignIn(input);
    if (receipt) return appliedOutcome(assertReceiptScope(receipt, target.sessionId, site));
    if (await this.#refusesSite(site)) return problem("not-allowed", site, null);
    const peer = this.#connections.get(source.id);
    if (!peer?.ready) return problem("chrome-offline", site, source.name);
    let reply: SourceReply;
    try {
      reply = await this.#request(peer, { type: "source.export", operationId: randomUUID(), site });
    } catch {
      return problem("chrome-offline", site, source.name);
    }
    if (reply.type !== "source.export.result") return problem("chrome-offline", site, source.name);
    if (reply.result.status !== "exported") return problem(reply.result.status, site, source.name);
    let cookies;
    try {
      cookies = validateBrowserSourceSnapshot(site, reply.result.snapshot).cookies;
    } catch {
      // One site Chrome and the Host scope differently fails alone; the connection stays.
      return problem("unsupported", site, source.name);
    }
    // Every check below runs after the last round trip before the import, so
    // nothing that changed while Chrome exported is missed.
    const current = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      sessionId: target.sessionId,
      ...(target.tabId ? { tabId: target.tabId } : {}),
      ...(target.agentBindingId ? { agentBindingId: target.agentBindingId } : {}),
    });
    if (!current?.live || current.deploymentId !== target.deploymentId) {
      return problem("session-closed", site, null);
    }
    const fence = await this.#store.fence({
      ownerId: input.ownerId,
      rememberSite: input.rememberSite,
      requestId: input.requestId,
      requireGrant: input.requireGrant,
      sessionId: target.sessionId,
      site,
      sourceGeneration: peer.generation,
      sourceId: source.id,
      deploymentId: target.deploymentId,
    });
    if (fence === "source-changed" || this.#connections.get(source.id) !== peer) {
      return problem("chrome-offline", site, source.name);
    }
    if (fence === "grant-removed") return { status: "grant-removed" };
    if (fence === "request-closed") return { status: "request-closed" };
    if (fence === "deployment-unavailable") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Personal deployment is unavailable",
      });
    }
    const admitted = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      sessionId: target.sessionId,
      ...(target.tabId ? { tabId: target.tabId } : {}),
      ...(target.agentBindingId ? { agentBindingId: target.agentBindingId } : {}),
    });
    if (!admitted?.live) return problem("session-closed", site, null);
    const applied = await this.#browser.applySiteCookies(target.sessionId, site, cookies);
    if (applied !== "applied") return problem(applied, site, null);
    const committed = await this.#store.commitSignIn({
      actor: input.actor,
      ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      invocationId: input.invocationId,
      ownerId: input.ownerId,
      profileName: current.profileName,
      rememberSite: input.rememberSite,
      requestId: input.requestId,
      sessionId: target.sessionId,
      site,
      sourceId: source.id,
      sourceName: source.name,
      deploymentId: target.deploymentId,
    });
    if (committed.events.length > 0) {
      for (const event of committed.events) this.#onDeploymentEvent(event);
      this.#onRequestResolved();
    }
    return appliedOutcome(committed.receipt);
  }

  /** Inspects every connected Chrome in parallel; a failed inspect reads as offline. */
  async #candidates(
    sources: readonly BrowserSourceRecord[],
    site: string,
  ): Promise<readonly Candidate[]> {
    return Promise.all(
      sources.map(async (source): Promise<Candidate> => {
        const peer = this.#connections.get(source.id);
        if (!peer?.ready) return { source, status: "offline" };
        try {
          const reply = await this.#request(peer, {
            type: "source.inspect",
            operationId: randomUUID(),
            site,
          });
          if (reply.type !== "source.inspect.result" || this.#connections.get(source.id) !== peer) {
            return { source, status: "offline" };
          }
          return { source, status: reply.status };
        } catch {
          return { source, status: "offline" };
        }
      }),
    );
  }

  /** In-memory, so a restart forgets it; the admission ledger still bounds each Run. */
  #admitCall(runId: RunId, sessionId: BrowserSessionId, site: string): boolean {
    return admitSignIn(this.#calls, this.#now(), { runId, target: sessionId, site });
  }

  #admitPairChallenge(address: string): boolean {
    return admitWithin(this.#pairChallenges, this.#now(), pairChallengeWindowMs, [
      [address, maxPairChallengesPerAddress],
    ]);
  }

  #isConnected(sourceId: BrowserSourceId): boolean {
    return this.#connections.get(sourceId)?.ready ?? false;
  }

  async #admitDestination(
    destination: { readonly origin: string; readonly routeGeneration: number | null },
    ingressOrigin: string,
  ): Promise<void> {
    if (destination.origin !== ingressOrigin)
      throw new OpensteerError({ code: "forbidden", message: "Browser source route changed" });
    if (destination.routeGeneration === null) {
      if (destination.origin === this.#canonicalOrigin) return;
    } else {
      const current = await this.#currentRoute();
      if (
        current?.document.route.origin === destination.origin &&
        current.document.route.generation === destination.routeGeneration
      )
        return;
    }
    throw new OpensteerError({ code: "forbidden", message: "Browser source route changed" });
  }

  /**
   * Before its connection proof the extension trusts this notice only when
   * signed over its own challenge, so a handshake refusal carries one.
   */
  #routeChanged(socket: WebSocket, challenge: BrowserSourceChallenge | null = null): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "source.error",
        code: "route-changed",
        ...(challenge ? { signature: this.#sign(browserSourceRouteChangedBytes(challenge)) } : {}),
      } satisfies BrowserSourceHostMessage),
    );
    socket.close(1008, "Source route changed");
  }

  #sourceUnauthorized(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "source.error",
        code: "source-unauthorized",
      } satisfies BrowserSourceHostMessage),
    );
    socket.close(1008, "Browser source authorization ended");
  }

  #rejectHandshake(
    socket: WebSocket,
    error: unknown,
    challenge: BrowserSourceChallenge | null,
  ): void {
    if (
      error instanceof OpensteerError &&
      error.code === "forbidden" &&
      error.message === "Browser source route changed"
    ) {
      this.#routeChanged(socket, challenge);
      return;
    }
    if (error instanceof OpensteerError && error.code === "forbidden") {
      if (error.message === "Invalid source credential") {
        this.#sourceUnauthorized(socket);
        return;
      }
      socket.close(1008, "Source authentication failed");
      return;
    }
    socket.close(1011, "Source temporarily unavailable");
  }

  /**
   * Authenticates the token, its owner and the destination it was paired on
   * before checking the version, so an unauthenticated hello learns nothing and
   * changes nothing; a live connection is replaced only once this one is ready.
   * Null when the version was refused.
   */
  async #authenticateSocket(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "source.hello" }>,
    destination: { readonly origin: string; readonly routeGeneration: number | null },
    ingressOrigin: string,
    wire: WireNegotiation,
  ): Promise<SourceSocket | null> {
    await this.#admitDestination(destination, ingressOrigin);
    const source = await this.#store.authenticate(digest(message.token));
    if (!source || source.id !== message.sourceId)
      throw new OpensteerError({ code: "forbidden", message: "Invalid source credential" });
    if (!(await this.#store.claimDestination({ sourceId: source.id, ...destination })))
      throw new OpensteerError({ code: "forbidden", message: "Browser source route changed" });
    if (wire.kind !== "negotiated" || message.version !== wire.wire) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "source.error",
            code: "unsupported-version",
            supportedVersion: wire.kind === "negotiated" ? wire.wire : wire.supportedVersion,
          } satisfies BrowserSourceHostMessage),
        );
      }
      socket.close(1008, "Browser extension update required");
      return null;
    }
    const peer: SourceSocket = {
      sourceId: source.id,
      ownerId: source.ownerId,
      generation: source.generation,
      socket,
      origin: destination.origin,
      routeGeneration: destination.routeGeneration,
      ready: false,
      lastPongAt: this.#now(),
      pending: new Map(),
    };
    // Registered before the re-check, so a revoke that lands meanwhile ends it.
    this.#authenticating.add(peer);
    try {
      const stillAuthorized = await this.#store.get(source.id, source.ownerId);
      if (!stillAuthorized || stillAuthorized.generation !== peer.generation)
        throw new OpensteerError({ code: "forbidden", message: "Invalid source credential" });
      if (!(await this.#destinationIsCurrent(destination)))
        throw new OpensteerError({ code: "forbidden", message: "Browser source route changed" });
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Browser source changed during authentication");
      }
      const previous = this.#connections.get(source.id);
      if (previous) {
        rejectPending(previous, new Error("Browser source superseded"));
        previous.socket.close(1008, "New connection");
      }
      this.#connections.set(source.id, peer);
      peer.ready = true;
      socket.send(
        JSON.stringify({
          type: "source.ready",
          sourceId: source.id,
        } satisfies BrowserSourceHostMessage),
      );
      return peer;
    } finally {
      this.#authenticating.delete(peer);
    }
  }

  async #request(
    peer: SourceSocket,
    message: Extract<BrowserSourceHostMessage, { operationId: string }>,
  ): Promise<SourceReply> {
    if (!(await this.#destinationIsCurrent(peer))) {
      this.#routeChanged(peer.socket);
      throw new OpensteerError({ code: "runner_offline", message: "Browser source route changed" });
    }
    if (
      this.#connections.get(peer.sourceId) !== peer ||
      !peer.ready ||
      peer.socket.readyState !== WebSocket.OPEN
    )
      throw new OpensteerError({ code: "runner_offline", message: "Browser source is offline" });
    if (peer.pending.size >= maxPendingOperations)
      throw new OpensteerError({ code: "resource_exhausted", message: "Browser source is busy" });
    return new Promise<SourceReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        peer.pending.delete(message.operationId);
        reject(new Error("Browser source operation timed out"));
      }, operationTimeoutMs);
      peer.pending.set(message.operationId, { resolve, reject, timeout });
      peer.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          clearTimeout(timeout);
          peer.pending.delete(message.operationId);
          reject(error);
        }
      });
    });
  }

  async #pulse(): Promise<void> {
    if (this.#closed) return;
    for (const peer of this.#connections.values()) {
      if (this.#now() - peer.lastPongAt > heartbeatMs * 3) {
        peer.socket.close(1008, "Source heartbeat lost");
        continue;
      }
      try {
        const current = await this.#store.get(peer.sourceId, peer.ownerId);
        if (!current || current.generation !== peer.generation) {
          this.#sourceUnauthorized(peer.socket);
          continue;
        }
        if (!(await this.#destinationIsCurrent(peer))) {
          this.#routeChanged(peer.socket);
          continue;
        }
        peer.socket.send(
          JSON.stringify({ type: "ping", nonce: randomUUID() } satisfies BrowserSourceHostMessage),
        );
      } catch {
        // A transient database failure must not throw from the interval callback.
      }
    }
  }

  async #destinationIsCurrent(destination: {
    readonly origin: string;
    readonly routeGeneration: number | null;
  }): Promise<boolean> {
    try {
      await this.#admitDestination(destination, destination.origin);
      return true;
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        error.code === "forbidden" &&
        error.message === "Browser source route changed"
      )
        return false;
      throw error;
    }
  }
}

function problem(
  reason: BrowserSignInProblem,
  site: string,
  sourceName: string | null,
): BrowserSignInOutcome {
  return { problem: reason, site, sourceName, status: "problem" };
}

function appliedOutcome(receipt: BrowserSignInReceipt): BrowserSignInOutcome {
  return {
    profileName: receipt.profileName,
    site: receipt.site,
    sourceName: receipt.sourceName,
    status: "applied",
  };
}

function assertReceiptScope(
  receipt: BrowserSignInReceipt,
  sessionId: string,
  site: string,
): BrowserSignInReceipt {
  if (receipt.sessionId !== sessionId || receipt.site !== site) {
    throw new OpensteerError({
      code: "conflict",
      message: "This call already signed in a different site or tab.",
    });
  }
  return receipt;
}

/**
 * What the agent learns from one delivery, or null when the owner has to be
 * asked instead: the chosen Chrome went away, or the site stopped being allowed.
 */
function agentResult(delivery: Delivery, site: string): ChromeCookiesResult | null {
  if (delivery.status === "grant-removed" || delivery.status === "request-closed") return null;
  if (delivery.status === "applied") return copiedResult(delivery);
  switch (delivery.problem) {
    case "no-state":
      return unavailable(site, "chrome-signed-out");
    case "chrome-offline":
    case "no-chrome":
    case "choose-source":
    case "site-removed":
      return null;
    case "stopped":
    case "chrome-blocked":
    case "limit":
    case "unsupported":
    case "too-large":
    case "session-closed":
    case "runtime-outdated":
    case "unsupported-operation":
    case "not-allowed":
      return unavailable(site, delivery.problem);
  }
}

function copiedResult(
  applied: Pick<BrowserSignInReceipt, "profileName" | "site" | "sourceName">,
): ChromeCookiesResult {
  return {
    status: "copied",
    site: applied.site,
    sourceName: applied.sourceName,
    profileName: applied.profileName,
  };
}

function unavailable(site: string, reason: ChromeCookiesUnavailableReason): ChromeCookiesResult {
  return { status: "unavailable", site, reason };
}

/** What a `copy_chrome_cookies` call learns from its Chrome Request. */
export function chromeCookiesResult(request: Request, replayed = true): ChromeCookiesResult {
  if (request.payload.kind !== "browser.sign-in") throw new Error("Not a Chrome sign-in Request");
  const { site } = request.payload;
  switch (request.status) {
    case "pending":
      return { status: "pending", site, requestId: request.id, replayed };
    case "declined":
      return { status: "declined", site, requestId: request.id };
    case "fulfilled": {
      const response = BrowserSignInRequestResponseSchema.parse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      switch (response.outcome) {
        case "applied":
          return copiedResult({ ...response, site });
        case "not-signed-in":
          return unavailable(site, "chrome-signed-out");
        case "session-closed":
          return unavailable(site, "session-closed");
      }
    }
    case "cancelled":
    case "withdrawn":
      return unavailable(site, "needs-approval");
  }
}

/** Receipts are keyed by UUID; callers' identities are namespaced before hashing. */
function stateImportRefusal(
  target: BrowserSignInTarget,
): "unsupported-operation" | "runtime-outdated" {
  return target.engine === "wkwebview" || target.engine === "android-webview"
    ? "unsupported-operation"
    : "runtime-outdated";
}

function invocationUuid(identity: string): string {
  const bytes = createHash("sha256").update(`browser-sign-in:${identity}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readSourceMessage(raw: string, tolerant: boolean): ClientMessage | UnknownMessage | null {
  if (tolerant) return readClientMessage(raw);
  try {
    return BrowserSourceClientMessageSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function rejectPending(peer: SourceSocket, error: Error): void {
  for (const pending of peer.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  peer.pending.clear();
}
