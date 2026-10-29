import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import {
  OpensteerError,
  browserSessionClosedReason,
  isLoopbackHostname,
  type AgentEvent,
  type BrowserSourceId,
  type Request,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  browserSiteDomain,
  browserSiteFromUrl,
  validateBrowserSourceSnapshot,
} from "@opensteer/browser-profile/source-state";
import { BrowserSessionIdSchema, type BrowserSessionId } from "@opensteer/protocol";
import {
  BrowserSignInRequestResponseSchema,
  BrowserSourceClientMessageSchema,
  BrowserSourcePairInputSchema,
  browserSourceProtocolVersion,
  maxBrowserSourceFrameBytes,
  type AgentBrowserSignInResult,
  type BrowserSignInDecision,
  type BrowserSignInOutcome,
  type BrowserSignInProblem,
  type BrowserSourceClientMessage,
  type BrowserSourceHostMessage,
  type BrowserSourceInspection,
  type BrowserSourceStatus,
  type BrowserSourcesState,
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
import type { PasswordSignInService } from "./password-sign-in-service.js";

const pairingLifetimeMs = 15 * 60_000;
const operationTimeoutMs = 25_000;
const helloTimeoutMs = 10_000;
const heartbeatMs = 15_000;
const maxPendingOperations = 8;
const maxPendingSourceConnections = 8;
const rateWindowMs = 10 * 60_000;
const maxCallsPerSessionSite = 3;
const maxCallsPerRun = 30;
const pairChallengeWindowMs = 60_000;
const maxPairChallengesPerAddress = 30;
const drainPageSize = 64;

type SourceReply = Extract<BrowserSourceClientMessage, { operationId: string }>;
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
>;

/**
 * Chrome sign-ins: the connected Chrome profiles (sources), the sites each
 * Workspace may use, and delivering one site's sign-in into a live Browser
 * Session. The Host is the only party that imports: it exports from Chrome,
 * checks the site scope, re-checks authority, and sends `state.import` itself.
 */
export class BrowserSourceService {
  readonly #store: BrowserSourceStore;
  readonly #requests: SignInRequests;
  readonly #browser: Pick<BrowserService, "applySiteCookies" | "signInTarget">;
  /** Signs with the Host identity key the invitation's authority names. */
  readonly #sign: (bytes: Uint8Array) => string;
  readonly #canonicalOrigin: string;
  readonly #currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #onRequestResolved: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #connections = new Map<BrowserSourceId, SourceSocket>();
  readonly #sockets = new Set<WebSocket>();
  readonly #pendingHandshakes = new Set<WebSocket>();
  readonly #pendingByAddress = new Map<string, number>();
  readonly #turns = new Map<string, Promise<unknown>>();
  readonly #pairChallenges = new Map<string, number[]>();
  readonly #drains = new Map<UserId, Promise<void>>();
  readonly #calls = new Map<string, number[]>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #passwords: PasswordSignInEntry;
  #closed = false;

  constructor(options: {
    readonly store: BrowserSourceStore;
    readonly requests: SignInRequests;
    readonly browser: Pick<BrowserService, "applySiteCookies" | "signInTarget">;
    readonly sign: (bytes: Uint8Array) => string;
    readonly canonicalOrigin: string;
    readonly currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    /** A sign-in Request was fulfilled or declined, so its continuation can be sent. */
    readonly onRequestResolved: () => void;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
    /** Workspace-scoped saved logins from the Personal vault authority. */
    readonly passwords: PasswordSignInEntry;
  }) {
    this.#passwords = options.passwords;
    this.#store = options.store;
    this.#requests = options.requests;
    this.#browser = options.browser;
    this.#sign = options.sign;
    this.#canonicalOrigin = options.canonicalOrigin;
    this.#currentRoute = options.currentRoute;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#onRequestResolved = options.onRequestResolved;
    this.#onError = options.onError ?? (() => {});
    this.#now = options.now ?? Date.now;
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
    if (parsed.version !== browserSourceProtocolVersion) {
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
    if (parsed.replaces) {
      const previous = this.#connections.get(parsed.replaces.sourceId);
      if (previous?.ownerId === source.ownerId) this.#sourceUnauthorized(previous.socket);
    }
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

  /** Accepts an upgraded source socket; only its first bounded frame may authenticate it. */
  acceptSocket(socket: WebSocket, ingressOrigin: string, address: string): void {
    if (this.#closed) {
      socket.close(1012, "Host stopping");
      return;
    }
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
      let message: BrowserSourceClientMessage;
      try {
        message = BrowserSourceClientMessageSchema.parse(JSON.parse(bytes.toString("utf8")));
      } catch {
        socket.close(1007, "Invalid source frame");
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
                JSON.stringify({
                  type: "source.proof",
                  nonce: message.nonce,
                  signature,
                } satisfies BrowserSourceHostMessage),
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
        if (message.version !== browserSourceProtocolVersion) {
          socket.send(
            JSON.stringify({
              type: "source.error",
              code: "unsupported-version",
              supportedVersion: browserSourceProtocolVersion,
            } satisfies BrowserSourceHostMessage),
          );
          socket.close(1008, "Browser extension update required");
          return;
        }
        authenticating = true;
        void this.#authenticateSocket(socket, message, destination, ingressOrigin)
          .then((connected) => {
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
        workspaceId: grant.workspaceId,
      })),
    };
  }

  /** What each of the owner's Chrome profiles reports for the site of `url`. */
  async inspect(input: {
    readonly ownerId: UserId;
    readonly url: string;
  }): Promise<BrowserSourceInspection> {
    const site = parseSite(input.url);
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
    if (revoked) {
      const peer = this.#connections.get(input.sourceId);
      if (peer) this.#sourceUnauthorized(peer.socket);
    }
    return revoked;
  }

  /** Stops future sign-ins to the site; browsers already signed in stay signed in. */
  async removeSite(input: {
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
    readonly site: string;
  }): Promise<void> {
    await this.#store.removeGrant({ ...input, site: parseSite(input.site) });
  }

  /**
   * The owner signs the site of `url` in, in a session they control, and the
   * site is remembered for the session's Workspace. The click is the consent.
   */
  async sessionSignIn(input: {
    readonly ownerId: UserId;
    readonly surfaceId?: string;
    readonly sessionId: string;
    readonly url: string;
    readonly sourceId: BrowserSourceId | null;
    readonly idempotencyKey: string;
  }): Promise<BrowserSignInOutcome> {
    const site = parseSite(input.url);
    if (await this.#refusesSite(site)) return problem("not-allowed", site, null);
    const target = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      sessionId: parseSessionId(input.sessionId),
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    });
    if (!target) {
      throw new OpensteerError({ code: "not_found", message: "Browser Session not found." });
    }
    const invocationId = invocationUuid(`owner:${input.ownerId}:${input.idempotencyKey}`);
    const receipt = await this.#store.getSignIn({ ownerId: input.ownerId, invocationId });
    if (receipt) return appliedOutcome(assertReceiptScope(receipt, target.sessionId, site));
    if (!target.live) return problem("session-closed", site, null);
    if (!target.stateImport) return problem("runtime-outdated", site, null);
    const choice = await this.#chooseForOwner(
      input.ownerId,
      target.workspaceId,
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
   * An agent asks for one site in one live session. The session's Workspace is
   * authoritative, whichever Workspace the Run belongs to. Standing grants sign
   * in immediately; anything that needs the owner opens one Request, which
   * completes by itself once a connected Chrome can supply the sign-in.
   */
  async agentSignIn(input: {
    readonly ownerId: UserId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
    readonly callId: string;
    readonly canRequest: boolean;
    readonly loginFill?: boolean;
    readonly sessionId?: string;
    readonly site: string;
    readonly reason: string;
    readonly code?: string;
    readonly targetId?: string;
  }): Promise<AgentBrowserSignInResult> {
    const arrivedAt = Date.now();
    const site = parseSite(input.site);
    if (await this.#refusesSite(site))
      return { reason: "not-allowed", site, status: "unavailable" };
    if (input.sessionId === undefined) {
      const joined = this.#passwords.join({ ...input, arrivedAt, site });
      if (joined) return joined;
      const prior = await this.#requests.findByCallIdentity({
        callId: input.callId,
        originatingRunId: input.runId,
      });
      if (prior) {
        if (
          prior.payload.kind !== "browser.password-sign-in" ||
          prior.payload.scope !== "workspace" ||
          prior.payload.site !== site
        )
          throw new OpensteerError({
            code: "conflict",
            message: "Sign-in call identity belongs to another scope or site.",
          });
        return this.#passwords.replayResult(prior);
      }
      const availability = await this.#passwords.probe(input.ownerId, site);
      if (availability !== "has-login")
        return {
          status: "unavailable",
          site,
          reason:
            availability === "no-login"
              ? "no-saved-login"
              : availability === "off"
                ? "passwords-off"
                : availability === "not-set-up"
                  ? "passwords-not-set-up"
                  : "unsupported",
        };
      return this.#passwords.request({
        ...input,
        arrivedAt,
        site,
        admitStart: () => this.#admitCall(input.runId, input.workspaceId, site),
      });
    }
    const sessionId = parseSessionId(input.sessionId);
    const liveTarget = await this.#browser.signInTarget({
      agentWorkspaceId: input.workspaceId,
      ownerId: input.ownerId,
      sessionId,
    });
    const joined =
      input.loginFill && liveTarget?.live && liveTarget.signIn
        ? this.#passwords.join({ ...input, arrivedAt, site })
        : null;
    if (joined) return joined;
    const invocationId = invocationUuid(`agent:${input.runId}:${input.callId}`);
    const receipt = await this.#store.getSignIn({ ownerId: input.ownerId, invocationId });
    if (receipt) return appliedResult(assertReceiptScope(receipt, sessionId, site));
    const prior = await this.#requests.findByCallIdentity({
      callId: input.callId,
      originatingRunId: input.runId,
    });
    if (prior?.kind === "browser.password-sign-in") {
      if (!input.loginFill) return { status: "unavailable", reason: "runtime-outdated", site };
      if (
        prior.payload.kind !== "browser.password-sign-in" ||
        (prior.payload.scope !== "workspace" && prior.payload.sessionId !== sessionId) ||
        prior.payload.site !== site
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Sign-in call identity belongs to another session or site.",
        });
      }
      return this.#passwords.replayResult(prior);
    }
    if (prior) return this.#requestResult(prior, sessionId, site);
    const target = liveTarget;
    if (!target?.live) return { reason: "session-closed", site, status: "unavailable" };
    const grant = await this.#store.getGrant({
      ownerId: input.ownerId,
      site,
      workspaceId: target.workspaceId,
    });
    // A Runner that cannot fill logins never starts Passwords; Chrome still
    // serves it exactly as before.
    const passwords =
      !grant && target.signIn && input.loginFill
        ? await this.#passwords.probe(input.ownerId, site)
        : "unavailable";
    if (passwords === "has-login") {
      return this.#passwords.request({
        ...input,
        arrivedAt,
        site,
        admitStart: () => this.#admitCall(input.runId, sessionId, site),
      });
    }
    const sources = await this.#store.list(input.ownerId);
    const candidates = !grant ? await this.#candidates(sources, site) : [];
    if (
      passwords === "no-login" &&
      !candidates.some((candidate) => candidate.status === "available")
    ) {
      return { status: "unavailable", reason: "no-saved-login", site };
    }
    if (!target.stateImport) return { reason: "runtime-outdated", site, status: "unavailable" };
    if (!this.#admitCall(input.runId, sessionId, site)) {
      return { reason: "rate-limited", site, status: "unavailable" };
    }
    const pending = await this.#requests.findPendingBrowserSignIn({
      originatingRunId: input.runId,
      ownerId: input.ownerId,
      site,
      workspaceId: target.workspaceId,
    });
    if (pending) return this.#completePending(pending, grant, sources, sessionId, site);
    const ask = async (): Promise<AgentBrowserSignInResult> =>
      input.canRequest
        ? this.#openRequest({ ...input, site, target })
        : { reason: "needs-approval", site, status: "unavailable" };
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
    if (!input.canRequest) return { reason: "needs-approval", site, status: "unavailable" };
    if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "no-state")) {
      return { site, status: "not-signed-in" };
    }
    return ask();
  }

  /** Declining a saved-password sign-in from any device; its Mac settles how it ended. */
  declinePasswordSignIn(input: {
    readonly ownerId: UserId;
    readonly requestId: RequestId;
  }): Promise<Request["status"]> {
    return this.#passwords.decline(input);
  }

  /**
   * The owner's answer to a sign-in Request. Allow remembers the site for the
   * session's Workspace, then signs in; a problem leaves the Request pending
   * and is returned so the card can show how to fix it.
   */
  async respond(input: {
    readonly ownerId: UserId;
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
        }),
      );
      for (const event of declined.events) this.#onWorkspaceEvent(event);
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
        return settled.data.outcome === "applied"
          ? {
              profileName: settled.data.profileName,
              site,
              sourceName: settled.data.sourceName,
              status: "applied",
            }
          : problem("session-closed", site, null);
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
      workspaceId: request.targetWorkspaceId,
    });
    const delivered = await this.#deliverRequest(request, source);
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
    for (const peer of this.#connections.values()) {
      if (peer.routeGeneration !== null) this.#routeChanged(peer.socket);
    }
  }

  #sourceReady(peer: SourceSocket): void {
    void this.#store.markSeen(peer.sourceId).catch(this.#onError);
    const previous = this.#drains.get(peer.ownerId) ?? Promise.resolve();
    const drain = previous
      .then(() => this.#drain(peer.ownerId, peer.sourceId))
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
          workspaceId: request.targetWorkspaceId,
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
  ): Promise<AgentBrowserSignInResult> {
    const sameSession =
      request.payload.kind === "browser.sign-in" && request.payload.sessionId === sessionId;
    const chosen = grant && sameSession ? await this.#standingSource(grant, sources, site) : null;
    if (!chosen) return { replayed: true, requestId: request.id, status: "pending" };
    const delivered = await this.#deliverRequest(request, chosen);
    if (delivered.status === "applied") return delivered;
    const current = (await this.#requests.get(request.id)) ?? request;
    return this.#requestResult(current, sessionId, site);
  }

  /** One Request delivers at a time, and never alongside its decline. */
  #deliverRequest(request: Request, source: BrowserSourceRecord): Promise<RequestDelivery> {
    return this.#inTurn(`request\0${request.id}`, () =>
      this.#deliverRequestInTurn(request, source),
    );
  }

  async #deliverRequestInTurn(
    request: Request,
    source: BrowserSourceRecord,
  ): Promise<RequestDelivery> {
    if (request.payload.kind !== "browser.sign-in") throw new Error("Not a sign-in Request");
    const { site } = request.payload;
    const sessionId = parseSessionId(request.payload.sessionId);
    const target = await this.#browser.signInTarget({ ownerId: request.requestedBy, sessionId });
    const closed = async (): Promise<RequestDelivery> => {
      const settled = await this.#requests.fulfilBrowserSignInRequest({
        ownerId: request.requestedBy,
        requestId: request.id,
        response: { outcome: "session-closed" },
      });
      if (!settled) return { status: "request-closed" };
      for (const event of settled.events) this.#onWorkspaceEvent(event);
      this.#onRequestResolved();
      return problem("session-closed", site, null);
    };
    if (!target?.live || target.workspaceId !== request.targetWorkspaceId) return closed();
    if (!target.stateImport) return problem("runtime-outdated", site, null);
    if (!this.#isConnected(source.id)) return problem("chrome-offline", site, source.name);
    const delivered = await this.#deliver({
      actor: "request",
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
    readonly workspaceId: WorkspaceId;
    readonly callId: string;
    readonly reason: string;
    readonly site: string;
    readonly target: BrowserSignInTarget;
  }): Promise<AgentBrowserSignInResult> {
    const created = await this.#requests
      .create({
        callId: input.callId,
        kind: "browser.sign-in",
        mode: "durable",
        originatingRunId: input.runId,
        originatingThreadId: input.threadId,
        originatingWorkspaceId: input.workspaceId,
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
          title: `Sign in to ${browserSiteDomain(input.site)}`,
        },
        requestedBy: input.ownerId,
        requiredActor: "requester",
        targetWorkspaceId: input.target.workspaceId,
      })
      .catch((error: unknown) => {
        // Method selection used a snapshot; the session can end before the
        // Request is stored, which the database refuses as closed.
        if (error instanceof OpensteerError && error.reason === browserSessionClosedReason) {
          return null;
        }
        throw error;
      });
    if (!created) return { reason: "session-closed", site: input.site, status: "unavailable" };
    for (const event of created.events) this.#onWorkspaceEvent(event);
    return this.#requestResult(
      created.request,
      input.target.sessionId,
      input.site,
      created.replayed,
    );
  }

  #requestResult(
    request: Request,
    sessionId: BrowserSessionId,
    site: string,
    replayed = true,
  ): AgentBrowserSignInResult {
    if (
      request.payload.kind !== "browser.sign-in" ||
      request.payload.site !== site ||
      request.payload.sessionId !== sessionId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "This call already asked for a different site or session.",
      });
    }
    switch (request.status) {
      case "pending":
        return { replayed, requestId: request.id, status: "pending" };
      case "declined":
        return { requestId: request.id, status: "declined" };
      case "fulfilled": {
        const response = BrowserSignInRequestResponseSchema.parse(
          request.response.kind === "external" ? request.response.value : undefined,
        );
        return response.outcome === "applied"
          ? {
              profileName: response.profileName,
              site,
              sourceName: response.sourceName,
              status: "applied",
            }
          : { reason: "session-closed", site, status: "unavailable" };
      }
      case "cancelled":
      case "withdrawn":
        return { reason: "needs-approval", site, status: "unavailable" };
    }
  }

  async #chooseForOwner(
    ownerId: UserId,
    workspaceId: WorkspaceId,
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
      this.#store.getGrant({ ownerId, site, workspaceId }),
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
      peer.socket.close(1008, "Invalid site state");
      return problem("unsupported", site, source.name);
    }
    // Every check below runs after the last round trip before the import, so
    // nothing that changed while Chrome exported is missed.
    const current = await this.#browser.signInTarget({
      ownerId: input.ownerId,
      sessionId: target.sessionId,
    });
    if (!current?.live || current.workspaceId !== target.workspaceId) {
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
      workspaceId: target.workspaceId,
    });
    if (fence === "source-changed" || this.#connections.get(source.id) !== peer) {
      return problem("chrome-offline", site, source.name);
    }
    if (fence === "grant-removed") return { status: "grant-removed" };
    if (fence === "request-closed") return { status: "request-closed" };
    if (fence === "workspace-unavailable") {
      throw new OpensteerError({ code: "forbidden", message: "Workspace is unavailable" });
    }
    const applied = await this.#browser.applySiteCookies(target.sessionId, site, cookies);
    if (applied !== "applied") return problem(applied, site, null);
    const committed = await this.#store.commitSignIn({
      actor: input.actor,
      invocationId: input.invocationId,
      ownerId: input.ownerId,
      profileName: current.profileName,
      rememberSite: input.rememberSite,
      requestId: input.requestId,
      sessionId: target.sessionId,
      site,
      sourceId: source.id,
      sourceName: source.name,
      workspaceId: target.workspaceId,
    });
    if (committed.events.length > 0) {
      for (const event of committed.events) this.#onWorkspaceEvent(event);
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
  #admitCall(runId: RunId, sessionId: BrowserSessionId | WorkspaceId, site: string): boolean {
    return admitWithin(this.#calls, this.#now(), rateWindowMs, [
      [`site\0${sessionId}\0${site}`, maxCallsPerSessionSite],
      [`run\0${runId}`, maxCallsPerRun],
    ]);
  }

  /**
   * Sites no sign-in may reach. Loopback addresses hold this Host's own
   * session cookie on a Personal Deployment (and every local dev server's);
   * the sites of the Deployment's canonical origin and remote route hold it
   * everywhere else. An agent signed in there could approve its own Requests.
   */
  async #refusesSite(site: string): Promise<boolean> {
    const host = browserSiteDomain(site);
    if (isLoopbackHostname(host) || host === "0.0.0.0" || host === "[::]") return true;
    const route = await this.#currentRoute();
    return [this.#canonicalOrigin, route?.document.route.origin].some(
      (origin) => origin !== undefined && ownSiteHost(origin) === host,
    );
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

  async #authenticateSocket(
    socket: WebSocket,
    message: Extract<BrowserSourceClientMessage, { type: "source.hello" }>,
    destination: { readonly origin: string; readonly routeGeneration: number | null },
    ingressOrigin: string,
  ): Promise<SourceSocket> {
    await this.#admitDestination(destination, ingressOrigin);
    const source = await this.#store.authenticate(digest(message.token));
    if (!source || source.id !== message.sourceId)
      throw new OpensteerError({ code: "forbidden", message: "Invalid source credential" });
    const previous = this.#connections.get(source.id);
    if (previous) {
      rejectPending(previous, new Error("Browser source superseded"));
      previous.socket.close(1008, "New connection");
    }
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Source socket closed");
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
    this.#connections.set(source.id, peer);
    try {
      const stillAuthorized = await this.#store.get(source.id, source.ownerId);
      if (!stillAuthorized || stillAuthorized.generation !== peer.generation)
        throw new OpensteerError({ code: "forbidden", message: "Invalid source credential" });
      if (!(await this.#destinationIsCurrent(destination)))
        throw new OpensteerError({ code: "forbidden", message: "Browser source route changed" });
      if (this.#connections.get(source.id) !== peer || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Browser source changed during authentication");
      }
      peer.ready = true;
      socket.send(
        JSON.stringify({
          type: "source.ready",
          sourceId: source.id,
        } satisfies BrowserSourceHostMessage),
      );
      return peer;
    } catch (error) {
      if (this.#connections.get(source.id) === peer) this.#connections.delete(source.id);
      throw error;
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

/**
 * Sliding-window limits kept in memory, so a restart forgets them. A call is
 * admitted only when every key is under its limit, and then counts against all.
 */
function admitWithin(
  ledger: Map<string, number[]>,
  now: number,
  windowMs: number,
  limits: readonly (readonly [key: string, max: number])[],
): boolean {
  const recent = limits.map(
    ([key, max]) =>
      [key, max, (ledger.get(key) ?? []).filter((at) => now - at < windowMs)] as const,
  );
  if (recent.some(([, max, calls]) => calls.length >= max)) return false;
  for (const [key, , calls] of recent) ledger.set(key, [...calls, now]);
  if (ledger.size > 10_000) {
    for (const [key, calls] of ledger) {
      if (calls.every((at) => now - at >= windowMs)) ledger.delete(key);
    }
  }
  return true;
}

function parseSite(input: string): string {
  try {
    return browserSiteFromUrl(input);
  } catch (error) {
    throw new OpensteerError({
      code: "bad_request",
      message: error instanceof Error ? error.message : "Choose one website.",
    });
  }
}

/** The site host of one of this Deployment's own origins, or null when it has none. */
function ownSiteHost(origin: string): string | null {
  try {
    return browserSiteDomain(browserSiteFromUrl(origin));
  } catch {
    // An origin with no site of its own (an intranet name) is not one any
    // sign-in can name either, so nothing needs refusing for it.
    return null;
  }
}

function parseSessionId(input: string): BrowserSessionId {
  const parsed = BrowserSessionIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpensteerError({ code: "bad_request", message: "Browser Session ID is invalid." });
  }
  return parsed.data;
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

function appliedResult(receipt: BrowserSignInReceipt): AgentBrowserSignInResult {
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
      message: "This call already signed in a different site or session.",
    });
  }
  return receipt;
}

/**
 * What the agent learns from one delivery, or null when the owner has to be
 * asked instead: the chosen Chrome went away, or the site stopped being allowed.
 */
function agentResult(delivery: Delivery, site: string): AgentBrowserSignInResult | null {
  if (delivery.status === "grant-removed" || delivery.status === "request-closed") return null;
  if (delivery.status === "applied") return delivery;
  switch (delivery.problem) {
    case "no-state":
      return { site, status: "not-signed-in" };
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
    case "not-allowed":
      return { reason: delivery.problem, site, status: "unavailable" };
  }
}

/** Receipts are keyed by UUID; callers' identities are namespaced before hashing. */
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

function rejectPending(peer: SourceSocket, error: Error): void {
  for (const pending of peer.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  peer.pending.clear();
}

type PasswordSignInEntry = Pick<
  PasswordSignInService,
  "join" | "decline" | "probe" | "replayResult" | "request"
>;
