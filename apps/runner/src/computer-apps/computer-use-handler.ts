import { WebSocket } from "ws";
import type { RunId } from "@opensteer/core";
import {
  macWindowVideoParams,
  computerUseBridgePasswordsResults,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
  type LoginReceiverKey,
  ComputerViewNativeResultSchema,
  macOwnerViewVersion,
  computerUseUpdateSentence,
  type ComputerViewNativeResult,
  type HostIntegrationsComputerView,
  ComputerUseDispatchActParamsSchema,
  ComputerUseWindowsParamsSchema,
  ComputerUseBindParamsSchema,
  type HostIntegrationsComputerAppWindows,
  ComputerUseDispatchObserveParamsSchema,
  ComputerUseBridgeApprovalAckSchema,
  ComputerUseBridgeApprovalKeyProofSchema,
  ComputerUseInstalledAppsParamsSchema,
  ComputerUseResolveAppParamsSchema,
  computerUseHelperResults,
  computerUseRequestMayHaveEffect,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalKeyProof,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcomeFrame,
  type ComputerUseBridgeEvent,
  type ComputerUseBridgeMethod,
  type ComputerUseDataGrants,
  type ComputerUseIMessageAccountResultSchema,
  type ComputerUseIMessagePollParamsSchema,
  type ComputerUseIMessagePollResult,
  type ComputerUseIMessageSendParamsSchema,
  type ComputerUseIMessageSendResultSchema,
  type ComputerUseDataInvokeParams,
  type ComputerUsePermissions,
  type ComputerUseSessionApp,
  type ComputerUseSessionId,
  type HostIntegrationsComputerUse,
} from "@opensteer/protocol";
import type { z } from "zod";
import {
  ComputerUseBridgeClient,
  ComputerUseBridgeDeadlineError,
  ComputerUseBridgeError,
} from "./computer-use-bridge-client.js";
import type { ComputerAppValue } from "./provider.js";

/** How long a status probe may take before this Mac counts as unreachable. */
export const computerUsePermissionsTimeoutMs = 5_000;
/** Coalesce readiness inspections without separating grants from their negotiated capability. */
const computerUsePermissionsCacheMs = 5_000;
/** How long ending one session may take; the helper closes outside its work queue. */
const sessionCloseTimeoutMs = 10_000;
/**
 * What a caller is told when the Mac answers something this build cannot read.
 * It never names the schema: the model can only observe again either way.
 */
const unexpectedAnswerSentence = "The Mac returned an unexpected answer.";
const stoppedByUserSentence = "The person stopped this session.";
/** Stopped sessions remembered, which is far more than one Mac can produce. */
const rememberedStoppedSessions = 64;
/** How long desktop main may take to acknowledge an approval frame it relays. */
const approvalRelayTimeoutMs = 10_000;
/**
 * Each bridge method's answer schema. The approval methods are desktop main's
 * own rather than the helper's, so they are the entries the helper's table
 * does not have; main acknowledges each at once.
 */
/** Reading `chat.db` and asking Messages its account are quick; a send waits on Messages. */
const imessageReadTimeoutMs = 15_000;
const imessageSendTimeoutMs = 45_000;

const bridgeResults = {
  ...computerUseHelperResults,
  ...computerUseBridgePasswordsResults,
  "approvals.list": ComputerUseBridgeApprovalAckSchema,
  "approvals.outcome": ComputerUseBridgeApprovalAckSchema,
  "approvals.key-challenge": ComputerUseBridgeApprovalKeyProofSchema,
} satisfies Readonly<Record<ComputerUseBridgeMethod, z.ZodType>>;

type ComputerUseReadiness = z.infer<(typeof bridgeResults)["permissions.get"]>;
type ReadinessChange = "readiness-changed" | "readiness-unknown";

/** A helper session event, which the Host hears as a computer-use event. */
export type ComputerUseSessionEvent = Extract<ComputerUseBridgeEvent, { event: "session.stopped" }>;

/** What desktop main says about approvals, which this Runner relays to its Host. */
export type ComputerUseApprovalEvent =
  | {
      readonly kind: "answer";
      readonly answer: ComputerAppApprovalAnswerFrame;
      /** The MCP server and launch the person allowed, from desktop main; null otherwise. */
      readonly server: { readonly launchDigest: string; readonly serverId: string } | null;
    }
  | { readonly kind: "sync" };

/**
 * One Mac's computer use, as the `integrations` module handler sees it.
 *
 * It owns the bridge client and the only state this side keeps: which sessions
 * it has opened. Opening is bookkeeping — the session's id and the Thread's
 * title — and happens once per session; every observe and act then carries the
 * app and the access the Host resolved for that call, which the helper
 * enforces on the call itself.
 *
 * Every call carries the Host's deadline, less the time already spent here.
 * A call this end stops waiting for ends its own session and nothing else: the
 * bridge is every Run's on this Runner.
 *
 * Nothing here is durable. A session is forgotten when the Host closes it, when
 * the person stops it, when a call on it runs past its deadline, and when the
 * bridge drops — the desktop closes the helper's side then, so remembering it
 * would make the next `observe` ask a session that no longer exists.
 */
export class ComputerUseHandler {
  readonly #client: ComputerUseBridgeClient;
  readonly #bridge: { readonly token: string; readonly url: URL };
  readonly #videoListeners = new Set<
    (
      event: Extract<
        ComputerUseBridgeEvent,
        {
          event:
            | "display.state"
            | "display.source-ended"
            | "display.source-changed"
            | "display.owner-input";
        }
      >,
    ) => void
  >();
  readonly #sessions = new Map<ComputerUseSessionId, SessionState>();
  readonly #listeners = new Set<(event: ComputerUseSessionEvent) => void>();
  readonly #approvalListeners = new Set<(event: ComputerUseApprovalEvent) => void>();
  readonly #passwordListeners = new Set<(event: PasswordSignInAuthorityEvent) => void>();
  #loginTextNegotiated = false;
  #passwordsBridgeConfirmed = false;
  #passwordCapabilities: {
    authority: 1 | null;
    receiver: LoginReceiverKey | null;
  } = { authority: null, receiver: null };
  readonly #grantListeners = new Set<() => void>();
  readonly #readinessListeners = new Set<(reason: ReadinessChange) => void>();
  readonly #now: () => number;
  #readinessEpoch = 0;
  #readiness: (ComputerUseReadiness & { readonly at: number }) | undefined;
  readonly #stopped = new Set<ComputerUseSessionId>();

  constructor(options: {
    readonly bridge: { readonly token: string; readonly url: URL };
    /** How long past a deadline the bridge is waited for, shortened by tests. */
    readonly graceMs?: number;
    readonly now?: () => number;
  }) {
    this.#bridge = options.bridge;
    this.#now = options.now ?? Date.now;
    this.#client = new ComputerUseBridgeClient({
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      now: this.#now,
      // A desktop this Runner just (re)connected to may have missed the list.
      onConnected: () => {
        // The initial probe opens this connection; loss already fenced older replies.
        this.#readiness = undefined;
        this.#announceApproval({ kind: "sync" });
      },
      ownerInputVersion: () => this.#readiness?.ownerInputVersion,
      onEvent: (event) => this.#receiveEvent(event),
      onLost: () => this.#bridgeLost(),
      token: options.bridge.token,
      url: options.bridge.url,
    });
  }

  async videoRequest<Method extends keyof typeof macWindowVideoParams>(
    method: Method,
    params: z.infer<(typeof macWindowVideoParams)[Method]>,
    deadline: number,
  ) {
    if (
      method === "display.resolve" &&
      "ownerInputVersion" in params &&
      params.ownerInputVersion === 2
    ) {
      await this.permissions({ deadline });
    }
    return await this.#request(method, params, { deadline });
  }

  openVideoAttachment(token: string): WebSocket {
    const url = new URL(this.#bridge.url);
    url.pathname += `/display/${encodeURIComponent(token)}`;
    return new WebSocket(url, {
      headers: { authorization: `Bearer ${this.#bridge.token}` },
      maxPayload: 4 * 1_024 * 1_024,
      perMessageDeflate: false,
      followRedirects: false,
    });
  }

  onVideoEvent(
    listener: (
      event: Extract<
        ComputerUseBridgeEvent,
        {
          event:
            | "display.state"
            | "display.source-ended"
            | "display.source-changed"
            | "display.owner-input";
        }
      >,
    ) => void,
  ): () => void {
    this.#videoListeners.add(listener);
    return () => this.#videoListeners.delete(listener);
  }

  /** Readiness requires both the grants and authenticated window-protocol support. */
  async permissions(options?: RequestOptions): Promise<ComputerUsePermissions> {
    options?.signal?.throwIfAborted();
    const at = this.#now();
    const readiness =
      this.#readiness && at - this.#readiness.at < computerUsePermissionsCacheMs
        ? this.#readiness
        : await this.#probePermissions({
            deadline: Math.min(options?.deadline ?? Infinity, at + computerUsePermissionsTimeoutMs),
            ...(options?.signal ? { signal: options.signal } : {}),
          });
    const { permissions } = readiness;
    options?.signal?.throwIfAborted();
    // Bridge configuration advertises this Runner's implementation, not what
    // its authenticated Desktop/helper actually negotiated. Probe failures
    // keep their original diagnosis and are retried rather than cached here.
    if (
      readiness.computerUseVersion !== 2 &&
      permissions.accessibility === "granted" &&
      permissions.screenRecording === "granted"
    )
      throw new ComputerUseBridgeError("incompatible-version", computerUseUpdateSentence);
    return permissions;
  }

  /** Revalidate owner media independently of an individual caller's request budget. */
  async revalidateReadiness(): Promise<void> {
    const epoch = this.#readinessEpoch;
    const hadReadiness = this.#readiness !== undefined;
    try {
      await this.permissions();
      const current = this.#readiness;
      // Attachment can open a new bridge after the target was resolved.
      if (
        !hadReadiness &&
        epoch === this.#readinessEpoch &&
        (current?.permissions.accessibility !== "granted" ||
          current.permissions.screenRecording !== "granted" ||
          current.computerUseVersion !== 2 ||
          current.ownerViewVersion !== 3)
      )
        this.#announceReadinessChanged("readiness-unknown");
    } catch {
      if (epoch === this.#readinessEpoch) this.#announceReadinessChanged("readiness-unknown");
    }
  }

  async #probePermissions(options: RequestOptions): Promise<ComputerUseReadiness> {
    const epoch = this.#readinessEpoch;
    const result = await this.#request("permissions.get", {}, options);
    if (epoch === this.#readinessEpoch) {
      const previous = this.#readiness;
      this.#readiness = { ...result, at: this.#now() };
      if (
        previous &&
        (previous.permissions.accessibility !== result.permissions.accessibility ||
          previous.permissions.screenRecording !== result.permissions.screenRecording ||
          previous.ownerViewVersion !== result.ownerViewVersion ||
          previous.ownerInputVersion !== result.ownerInputVersion ||
          previous.computerUseVersion !== result.computerUseVersion)
      )
        this.#announceReadinessChanged("readiness-changed");
    }
    return result;
  }

  async #requireWindowProtocol(options: RequestOptions): Promise<void> {
    // Only a helper that reports its grants without version 2 is known to be
    // too old. One that has not reported yet may simply not be installed, and
    // real work is what installs and launches it: the call goes on to the
    // desktop, whose helper answers for its own grants and version.
    await this.permissions(options);
  }

  negotiateLoginText(enabled: boolean): void {
    this.#loginTextNegotiated = enabled;
  }

  async passwordsCapabilities(deadline = this.#now() + computerUsePermissionsTimeoutMs) {
    try {
      this.#passwordCapabilities = await this.#request("passwords.capabilities", {}, { deadline });
      this.#passwordsBridgeConfirmed = true;
    } catch {
      this.#passwordsBridgeConfirmed = false;
      this.#passwordCapabilities = { authority: null, receiver: null };
    }
    return this.#passwordCapabilities;
  }

  passwordsSnapshot() {
    return this.#passwordCapabilities;
  }

  onPasswordEvent(listener: (event: PasswordSignInAuthorityEvent) => void): () => void {
    this.#passwordListeners.add(listener);
    return () => this.#passwordListeners.delete(listener);
  }

  async passwordControl(
    command: PasswordSignInAuthorityCommand,
    deadline: number,
    signal?: AbortSignal,
  ) {
    try {
      return await this.#request("passwords.control", command, {
        deadline,
        ...(signal ? { signal } : {}),
      });
    } catch {
      return { type: "unavailable" as const };
    }
  }

  computerUseVersion(): 2 | undefined {
    return this.#readiness?.computerUseVersion;
  }

  ownerViewVersion(): number | undefined {
    return this.#readiness?.ownerViewVersion;
  }

  async runView(
    frame: HostIntegrationsComputerView,
    signal: AbortSignal,
    receivedAt = this.#now(),
  ): Promise<ComputerViewNativeResult> {
    if (frame.version !== macOwnerViewVersion || frame.target.kind !== "app") {
      throw new ComputerUseBridgeError("unsupported", "That owner view is not supported.");
    }
    const authority = {
      viewId: frame.viewId,
      generation: frame.generation,
      leaseDurationMs: frame.leaseDurationMs,
    };
    const params = frame.operation === "open" ? { ...authority, target: frame.target } : authority;
    const result = ComputerViewNativeResultSchema.parse(
      await this.#request(`view.${frame.operation}`, params, {
        deadline: receivedAt + frame.timeoutMs,
        signal,
      }),
    );
    if (result.viewId !== frame.viewId || result.generation !== frame.generation) {
      throw new ComputerUseBridgeError("failed", "The Mac answered another owner view.");
    }
    return result;
  }

  async runViewWindows(
    frame: HostIntegrationsComputerAppWindows,
    signal: AbortSignal,
    receivedAt = this.#now(),
  ) {
    return await this.#request(
      "view.windows",
      { app: frame.app },
      { deadline: receivedAt + frame.timeoutMs, signal },
    );
  }

  /** The helper's data grants, read as `permissions` reads its own two. */
  async dataGrants(): Promise<ComputerUseDataGrants> {
    const result = await this.#request(
      "data.status",
      {},
      { deadline: this.#now() + computerUsePermissionsTimeoutMs },
    );
    return result.grants;
  }

  /**
   * One operation of an app the helper serves. It is not a session: nothing
   * is claimed, nothing is opened, and the Mac's person sees no overlay; the
   * helper checks the contract and the access itself before any app is read.
   */
  async dataInvoke(
    params: ComputerUseDataInvokeParams,
    options: RequestOptions,
  ): Promise<ComputerAppValue> {
    return (await this.#request("data.invoke", params, options)).value;
  }

  /** The Apple account this Mac's Messages uses for iMessage, and its newest row. */
  async imessageAccount(): Promise<z.infer<typeof ComputerUseIMessageAccountResultSchema>> {
    return await this.#request(
      "imessage.account",
      {},
      { deadline: this.#now() + imessageReadTimeoutMs },
    );
  }

  /** The iMessage channel's next rows, renewing its claim on the account. */
  async imessagePoll(
    params: z.infer<typeof ComputerUseIMessagePollParamsSchema>,
  ): Promise<ComputerUseIMessagePollResult> {
    return await this.#request("imessage.poll", params, {
      deadline: this.#now() + imessageReadTimeoutMs,
    });
  }

  /** One iMessage reply, sent once for its key however often it is asked. */
  async imessageSend(
    params: z.infer<typeof ComputerUseIMessageSendParamsSchema>,
  ): Promise<z.infer<typeof ComputerUseIMessageSendResultSchema>> {
    return await this.#request("imessage.send", params, {
      deadline: this.#now() + imessageSendTimeoutMs,
    });
  }

  /**
   * Resolves with the helper's result, or rejects with a bridge error.
   *
   * `receivedAt` is when the frame arrived, from which the Host's `timeoutMs`
   * is counted: that one instant is the deadline of every call this frame
   * makes, and each hop is given what is left of it when its frame is written.
   * A call with none left never reaches the Mac: it is refused as not done,
   * which is true.
   */
  async run(
    frame: HostIntegrationsComputerUse,
    signal: AbortSignal,
    receivedAt: number = this.#now(),
  ): Promise<ComputerAppValue> {
    const deadline = receivedAt + frame.timeoutMs;
    const options = (): RequestOptions => ({ deadline, signal });
    switch (frame.operation) {
      case "permissions": {
        const result = await this.#probePermissions(options());
        return { permissions: result.permissions };
      }
      case "installed_apps": {
        const params = ComputerUseInstalledAppsParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("installed_apps", params.error);
        const result = await this.#request("apps.installed", params.data, options());
        // Rebuilt only for the type: an icon that was not asked for is an
        // absent key, which JSON has and `iconPng?: string | undefined` lacks.
        return {
          apps: result.apps.map(({ iconPng, ...app }) =>
            iconPng === undefined ? app : { ...app, iconPng },
          ),
          total: result.total,
        };
      }
      case "resolve_app": {
        const params = ComputerUseResolveAppParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("resolve_app", params.error);
        return await this.#request("app.resolve", { app: params.data.app }, options());
      }
      case "windows": {
        const params = ComputerUseWindowsParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("windows", params.error);
        await this.#requireWindowProtocol(options());
        const app = this.#target(frame);
        const session = await this.#ensureOpen(frame, deadline);
        return await this.#onSession(frame.sessionId, session, () =>
          this.#request("session.windows", { app, sessionId: frame.sessionId }, options()),
        );
      }
      case "bind": {
        const params = ComputerUseBindParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("bind", params.error);
        await this.#requireWindowProtocol(options());
        const app = this.#target(frame);
        const session = await this.#ensureOpen(frame, deadline);
        return await this.#onSession(frame.sessionId, session, () =>
          this.#request(
            "session.bind",
            { app, window: params.data.window, sessionId: frame.sessionId },
            options(),
          ),
        );
      }
      case "observe": {
        const params = ComputerUseDispatchObserveParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("observe", params.error);
        await this.#requireWindowProtocol(options());
        const app = this.#target(frame);
        const session = await this.#ensureOpen(frame, deadline);
        return await this.#onSession(frame.sessionId, session, () =>
          this.#request(
            "session.observe",
            {
              app,
              window: params.data.window,
              includeScreenshot: params.data.includeScreenshot,
              sessionId: frame.sessionId,
            },
            options(),
          ),
        );
      }
      case "act": {
        // Validated before the session is touched: a batch this build cannot
        // read is the agent's mistake, and opening a session for it would put
        // the Mac's pill in front of the person for nothing.
        const params = ComputerUseDispatchActParamsSchema.safeParse(frame.params);
        if (!params.success) throw invalidParams("act", params.error);
        await this.#requireWindowProtocol(options());
        const saved = params.data.actions.some(
          (action) => action.type === "type" && typeof action.text !== "string",
        );
        if (saved) {
          const capabilities = await this.passwordsCapabilities(deadline);
          const receiver = capabilities.receiver;
          if (!receiver) {
            throw new ComputerUseBridgeError(
              "unsupported",
              "Update Opensteer to type saved logins.",
            );
          }
          // Sealed for another helper connection or batch: nothing has been
          // typed, and the Host seals the next act for the current connection.
          if (
            !params.data.loginContext ||
            params.data.loginContext.runId !== frame.runId ||
            params.data.loginContext.actId !== frame.requestId ||
            params.data.actions.some(
              (action) =>
                action.type === "type" &&
                typeof action.text !== "string" &&
                (action.text.sealed.binding.sessionId !== frame.sessionId ||
                  action.text.sealed.binding.connectionId !== receiver.connectionId ||
                  action.text.sealed.binding.connectionGeneration !==
                    receiver.connectionGeneration),
            )
          ) {
            throw new ComputerUseBridgeError(
              "failed",
              "The saved login was sealed for an earlier connection, so nothing was typed. Act again.",
            );
          }
        }
        const app = this.#target(frame);
        const session = await this.#ensureOpen(frame, deadline);
        return await this.#onSession(frame.sessionId, session, () =>
          this.#request(
            "session.act",
            {
              actions: params.data.actions,
              ...(params.data.loginContext ? { loginContext: params.data.loginContext } : {}),
              app,
              window: params.data.window,
              snapshot: params.data.snapshot,
              sessionId: frame.sessionId,
            },
            options(),
          ),
        ).catch((error: unknown) => {
          if (!saved) throw error;
          throw new ComputerUseBridgeError(
            error instanceof ComputerUseBridgeError ? error.code : "failed",
            "Saved login text could not be typed.",
          );
        });
      }
      case "close":
        // Fence pending opens before yielding to the bridge. Their late answers
        // cannot restore a session whose owner has already ended it.
        this.#forgetSession(frame.sessionId);
        return await this.#request("session.close", { sessionId: frame.sessionId }, options());
    }
  }

  /** The bridge connection owns all native work, including pending opens. */
  releaseSessions(): void {
    this.#readinessEpoch += 1;
    this.#readiness = undefined;
    this.#forgetEverySession();
    this.#passwordCapabilities = { authority: null, receiver: null };
    this.#client.disconnect();
  }

  onEvent(listener: (event: ComputerUseSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The person's answers and desktop main's requests for the whole list. */
  /** The person at the Mac answered macOS about a grant. */
  onGrantsChanged(listener: () => void): () => void {
    this.#grantListeners.add(listener);
    return () => this.#grantListeners.delete(listener);
  }

  /** A completed check changed window readiness, or its authority could not be checked. */
  onReadinessChanged(listener: (reason: ReadinessChange) => void): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  onApprovalEvent(listener: (event: ComputerUseApprovalEvent) => void): () => void {
    this.#approvalListeners.add(listener);
    return () => this.#approvalListeners.delete(listener);
  }

  /**
   * Hands desktop main the Host's whole approval list for this Mac. It never
   * reaches the helper; main shows the panels and answers later, as an event.
   * Connecting for it is what brings the bridge up when nothing else has.
   */
  async relayApprovals(list: ComputerAppApprovalList): Promise<void> {
    await this.#request("approvals.list", list, { deadline: this.#now() + approvalRelayTimeoutMs });
  }

  /** Hands desktop main what the Host did with one of its answers. */
  async relayApprovalOutcome(frame: ComputerAppApprovalOutcomeFrame): Promise<void> {
    await this.#request("approvals.outcome", frame, {
      deadline: this.#now() + approvalRelayTimeoutMs,
    });
  }

  async proveApprovalKey(
    challenge: ComputerAppApprovalKeyChallenge,
  ): Promise<ComputerAppApprovalKeyProof> {
    const proof = await this.#request("approvals.key-challenge", challenge, {
      deadline: this.#now() + approvalRelayTimeoutMs,
    });
    if (proof.challengeId !== challenge.challengeId) {
      throw new ComputerUseBridgeError(
        "failed",
        "The Mac answered a different approval key challenge.",
      );
    }
    return proof;
  }

  close(): void {
    this.#readinessEpoch += 1;
    this.#readiness = undefined;
    this.#forgetEverySession();
    this.#client.close();
  }

  #target(frame: HostIntegrationsComputerUse): ComputerUseSessionApp {
    // The frame schema refuses an `observe` or `act` without both, so this is
    // the type narrowing and not a second policy.
    if (!frame.app || !frame.access) {
      throw new ComputerUseBridgeError("failed", "This request named no app.");
    }
    return { access: frame.access, identity: frame.app };
  }

  /**
   * The session the helper holds for this id, opened once.
   *
   * Concurrent calls on a new session share the one open. An open that fails
   * leaves nothing behind here, so the next call opens again; one this end
   * stopped waiting for is ended on the Mac as well, since it may have
   * happened there.
   */
  async #ensureOpen(frame: HostIntegrationsComputerUse, deadline: number): Promise<SessionState> {
    const sessionId = frame.sessionId;
    if (this.#stopped.has(sessionId)) {
      throw new ComputerUseBridgeError("stopped-by-user", stoppedByUserSentence);
    }
    let state = this.#sessions.get(sessionId);
    if (!state) {
      const opening: SessionState = { opened: Promise.resolve(), runId: frame.runId };
      // No signal: a cancelled first call must not fail the calls sharing
      // this open, and opening is bookkeeping the helper answers at once.
      this.#sessions.set(sessionId, opening);
      opening.opened = (async () => {
        if (this.#loginTextNegotiated) await this.passwordsCapabilities(deadline);
        this.#requireCurrent(sessionId, opening);
        return await this.#request(
          "session.open",
          {
            sessionId,
            threadTitle: frame.threadTitle,
            ...(this.#passwordsBridgeConfirmed ? { runId: frame.runId } : {}),
          },
          { deadline },
        );
      })()
        .then((result) => {
          if (result.sessionId !== sessionId) {
            throw new ComputerUseBridgeError("failed", unexpectedAnswerSentence);
          }
        })
        .catch((error: unknown) => {
          if (this.#sessions.get(sessionId) === opening) {
            this.#sessions.delete(sessionId);
            if (error instanceof ComputerUseBridgeDeadlineError) this.#endSession(sessionId);
          }
          throw error;
        });
      this.#sessions.set(sessionId, opening);
      state = opening;
    }
    if (state.runId !== frame.runId)
      throw new ComputerUseBridgeError("no-session", "That session belongs to another Run.");
    await state.opened;
    this.#requireCurrent(sessionId, state);
    return state;
  }

  /**
   * One observe or act on an open session. A call this end gave up on ends
   * that session — on the Mac and for the Host — because the helper may still
   * be working on it for nobody; every other session carries on.
   */
  async #onSession<Result>(
    sessionId: ComputerUseSessionId,
    state: SessionState,
    call: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof ComputerUseBridgeDeadlineError &&
        this.#sessions.get(sessionId) === state
      ) {
        this.#forgetSession(sessionId);
        this.#endSession(sessionId);
      }
      throw error;
    }
  }

  /**
   * Ends one session on the Mac and tells the Host it ended, which is what
   * makes the Run's next call start a session of its own.
   */
  #endSession(sessionId: ComputerUseSessionId): void {
    void this.#request(
      "session.close",
      { sessionId },
      { deadline: this.#now() + sessionCloseTimeoutMs },
    ).catch(() => undefined);
    this.#announce({
      event: "session.stopped",
      kind: "event",
      params: { reason: "app-quit", sessionId },
    });
  }

  #requireCurrent(sessionId: ComputerUseSessionId, state: SessionState): void {
    if (this.#stopped.has(sessionId)) {
      throw new ComputerUseBridgeError("stopped-by-user", stoppedByUserSentence);
    }
    if (this.#sessions.get(sessionId) !== state) {
      throw new ComputerUseBridgeError("no-session", "The computer use session has ended.");
    }
  }

  /**
   * One bridge call, with the answer parsed by the schema of the method that
   * was asked. Nothing unvalidated is ever handed back: a Mac answering a
   * shape this build cannot read is a refusal the model can act on — observe
   * again — rather than JSON passed through to the Host.
   */
  async #request<Method extends ComputerUseBridgeMethod>(
    method: Method,
    params: unknown,
    options: RequestOptions,
  ): Promise<z.infer<(typeof bridgeResults)[Method]>> {
    const answer = await this.#client.request(method, params, {
      deadline: options.deadline,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = bridgeResults[method].safeParse(answer);
    if (!parsed.success) {
      if (!computerUseRequestMayHaveEffect(method, params)) {
        throw new ComputerUseBridgeError("failed", unexpectedAnswerSentence);
      }
      throw new ComputerUseBridgeError(
        "outcome-unknown",
        method === "session.act"
          ? "The Mac returned an unexpected answer; the actions may already have taken effect."
          : "The Mac returned an unexpected answer; the change may already have been made.",
      );
    }
    return parsed.data as z.infer<(typeof bridgeResults)[Method]>;
  }

  #receiveEvent(event: ComputerUseBridgeEvent): void {
    if (event.event === "passwords.event") {
      for (const listener of this.#passwordListeners) listener(event.params);
      return;
    }
    if (
      event.event === "display.owner-input" ||
      event.event === "display.state" ||
      event.event === "display.source-ended" ||
      event.event === "display.source-changed"
    ) {
      for (const listener of this.#videoListeners) listener(event);
      return;
    }
    if (event.event === "grants.changed") {
      this.#passwordCapabilities = { ...this.#passwordCapabilities, receiver: null };
      this.#readinessEpoch += 1;
      // A refresh hint invalidates freshness, not the last negotiated capability.
      if (this.#readiness) this.#readiness = { ...this.#readiness, at: -Infinity };
      for (const listener of this.#grantListeners) listener();
      return;
    }
    if (event.event === "approval.answer") {
      this.#announceApproval({ answer: event.params, kind: "answer", server: event.server });
      return;
    }
    if (event.event === "session.stopped") {
      this.#forgetSession(event.params.sessionId);
      if (event.params.reason === "user") {
        if (this.#stopped.size >= rememberedStoppedSessions) {
          const oldest = this.#stopped.values().next();
          if (!oldest.done) this.#stopped.delete(oldest.value);
        }
        this.#stopped.add(event.params.sessionId);
      }
    }
    this.#announce(event);
  }

  #announce(event: ComputerUseSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #announceApproval(event: ComputerUseApprovalEvent): void {
    for (const listener of this.#approvalListeners) listener(event);
  }

  #forgetSession(sessionId: ComputerUseSessionId): void {
    this.#sessions.delete(sessionId);
  }

  #forgetEverySession(): void {
    this.#sessions.clear();
  }

  #announceReadinessChanged(reason: ReadinessChange): void {
    for (const listener of this.#readinessListeners) listener(reason);
  }

  #bridgeLost(): void {
    this.#passwordsBridgeConfirmed = false;
    this.#passwordCapabilities = { authority: null, receiver: null };
    this.#readinessEpoch += 1;
    this.#readiness = undefined;
    this.#announceReadinessChanged("readiness-unknown");
    for (const listener of this.#grantListeners) listener();
    const sessions = [...this.#sessions.keys()];
    this.#forgetEverySession();
    // The desktop ends native ownership when this socket goes away. Tell the
    // Host even when no call is pending, so its live session cannot outlast it.
    for (const sessionId of sessions) {
      this.#announce({
        event: "session.stopped",
        kind: "event",
        params: { reason: "app-quit", sessionId },
      });
    }
  }
}

export interface RequestOptions {
  /** When the call must be answered by, in the handler's clock. */
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

interface SessionState {
  readonly runId: RunId;
  opened: Promise<void>;
}

/**
 * The refusal an unreadable `params` earns. It names the field rather than the
 * schema, because the field is what the caller can fix.
 */
function invalidParams(operation: string, error: z.ZodError): ComputerUseBridgeError {
  const path = error.issues[0]?.path.join(".") ?? "";
  return new ComputerUseBridgeError(
    "failed",
    `This ${operation} request could not be read${path ? ` (${path})` : ""}.`,
  );
}
