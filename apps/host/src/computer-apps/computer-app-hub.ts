import { type DisplaySource, type MacWindowTarget } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { OpensteerError, type RunId, type RunnerId } from "@opensteer/core";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import type {
  ComputerAppIdentity,
  IntegrationServerId,
  IntegrationToolEffect,
  LocalMcpLaunch,
} from "@opensteer/integration-core";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import {
  computerOwnerViewSupported,
  macOwnerViewVersion,
  macWindowVideoOwnerViewVersions,
  HostIntegrationsComputerAppWindowsSchema,
  ComputerUseViewWindowsResultSchema,
  type OwnerWindowInfo,
  type RunnerIntegrationsComputerAppWindowsResult,
  PasswordSignInAuthorityCommandSchema,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityResult,
  type PasswordSignInAuthorityEvent,
  type LoginReceiverKey,
  type HostIntegrationsComputerView,
  type RunnerIntegrationsComputerViewResult,
  type ComputerUseSessionId,
  computerAppMaxConcurrentInvokes,
  computerAppMaxTimeoutMs,
  runnerIntegrationsCompatibilityReason,
  RunnerAuxiliaryRequestIdSchema,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcomeFrame,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppErrorCode,
  type ComputerUseErrorCode,
  type ComputerUseHelperEvent,
  type HostIntegrationsComputerUse,
  type HostIntegrationsInvoke,
  type HostIntegrationsMcpMessage,
  type HostIntegrationsOperation,
  type IntegrationsModuleEvent,
  type MachineAppStatus,
  type McpSessionCloseCode,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryRequestId,
  sameRunnerAuxiliaryFence,
  type RunnerIntegrationsComputerUseResult,
  type RunnerIntegrationsResult,
} from "@opensteer/protocol";
import { MutationQueue } from "@opensteer/shared/mutationQueue";

export const computerAppSubmitTimeoutMs = 10_000;
/** How long a computer has to start an MCP server it was asked to run. */
export const computerMcpOpenTimeoutMs = 30_000;

/** Why a session with a computer's MCP server could not open, or ended. */
export class ComputerMcpSessionError extends Error {
  readonly code: McpSessionCloseCode | "offline";

  constructor(code: McpSessionCloseCode | "offline", message: string) {
    super(message);
    this.code = code;
    this.name = "ComputerMcpSessionError";
  }
}

/** Refusals from the owner-only picker transport, without a task session. */
export class ComputerAppWindowsError extends Error {
  readonly code: ComputerUseErrorCode | "offline";
  constructor(code: ComputerUseErrorCode | "offline", message: string) {
    super(message);
    this.name = "ComputerAppWindowsError";
    this.code = code;
  }
}

function abandonedMcpSession(): ComputerMcpSessionError {
  return new ComputerMcpSessionError("offline", "That MCP session was closed as it opened.");
}

/** One open session with an MCP server a computer runs. */
export interface ComputerMcpSession {
  close(): Promise<void>;
  send(message: HostIntegrationsMcpMessage["message"]): Promise<void>;
}

interface McpSessionEntry {
  readonly onclose: (error: ComputerMcpSessionError | null) => void;
  readonly onmessage: (message: unknown) => void;
  /** Settles the open while the computer has not answered it. */
  opening: { resolve(): void; reject(error: ComputerMcpSessionError): void } | null;
}

/** The value a computer app returns, as the result frame carries it. */
export type ComputerAppValue = Extract<
  RunnerIntegrationsResult["result"],
  { readonly kind: "ok" }
>["value"];

/**
 * What the `integrations` module's stream can do, as whatever routes invokes
 * over it sees. The fence, the lease and the Runner's identity all come from
 * the registry that admitted the socket.
 */
export interface ComputerAppControlPeer {
  readonly id: string;
  close(code: number, reason: string): void;
  send(message: HostIntegrationsOperation): Promise<void>;
}

/** A transport refusal made before the invoke frame was handed to its socket. */
export class ComputerAppSubmissionNotStartedError extends Error {
  readonly close: { readonly code: number; readonly reason: string } | null;

  constructor(
    message: string,
    close: { readonly code: number; readonly reason: string } | null = null,
  ) {
    super(message);
    this.name = "ComputerAppSubmissionNotStartedError";
    this.close = close;
  }
}

/**
 * How one invoke ended.
 *
 * Every expected condition is a value rather than a thrown error, because each
 * one becomes a sentence in a tool result: a computer that is asleep, an app
 * that needs a grant and an operation the computer's build does not know are
 * all ordinary answers, not faults of the Host.
 */
export type ComputerAppInvokeOutcome =
  | { readonly kind: "ok"; readonly value: ComputerAppValue }
  | {
      readonly code: ComputerAppErrorCode | "lost" | "offline";
      readonly kind: "error";
      readonly message: string;
      /** Whether trying again could plausibly give a different answer. */
      readonly retryable: boolean;
    };

export interface ComputerAppInvokeInput {
  /** The lesser of the connection's ceiling and the calling grant's access. */
  readonly access: HostIntegrationsInvoke["access"];
  readonly arguments: HostIntegrationsInvoke["arguments"];
  /** The Host's `computerAppOperationContract`, which the Runner must match. */
  readonly contract: HostIntegrationsInvoke["contract"];
  readonly definitionId: HostIntegrationsInvoke["definitionId"];
  /** What the operation does, which decides what losing the answer means. */
  readonly effect: IntegrationToolEffect;
  readonly operation: HostIntegrationsInvoke["operation"];
  readonly runnerId: RunnerId;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** One invoke whose frame has left the Host, or failed to. */
export interface ComputerAppInvokeSend {
  readonly outcome: Promise<ComputerAppInvokeOutcome>;
}

/** The value one computer-use operation answers with, as the frame carries it. */
export type ComputerUseValue = Extract<
  RunnerIntegrationsComputerUseResult["result"],
  { readonly kind: "ok" }
>["value"];

/**
 * How one computer-use operation ended.
 *
 * The codes are computer use's own vocabulary rather than the invoke codes,
 * plus `offline` for a Mac this Host cannot reach at all — which the helper
 * cannot say about itself, and which reads as a different sentence than any
 * refusal the helper makes.
 */
export type ComputerUseOutcome =
  | { readonly kind: "ok"; readonly value: ComputerUseValue }
  | {
      /**
       * Set when this Host stopped waiting for an answer the Mac may still
       * give — the caller cancelled, or the deadline and its grace passed —
       * rather than the Mac or the stream saying anything.
       */
      readonly abandoned?: "cancelled" | "deadline";
      readonly code: ComputerUseErrorCode | "offline";
      readonly kind: "error";
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * How much longer than a computer-use deadline this Host waits.
 *
 * The frame carries the deadline to every hop and each hop counts it from
 * when it received the frame, so the helper can stop between actions at the
 * deadline and still report what it completed. Every hop waits the deadline
 * plus a grace longer than the grace of the hop inside it, and the Host is
 * the outermost, so an inner hop's answer — its report, or its own
 * outcome-unknown after it closed that one session — always arrives first.
 * Giving up at the deadline itself would turn an answer on its way into an
 * unknown outcome.
 */
export const computerUseAnswerGraceMs = 6_000;

export interface ComputerUseSendInput {
  readonly requestId?: RunnerAuxiliaryRequestId;
  /** The lesser of the connection's ceiling and the calling grant's access. */
  readonly access: HostIntegrationsComputerUse["access"];
  /** What the Host resolved from the connection; never a caller's argument. */
  readonly app: HostIntegrationsComputerUse["app"];
  /**
   * Set only for a computer app that is not the Mac's — an Android phone —
   * and left off otherwise, so a frame to a Mac stays the frame it always was.
   */
  readonly definitionId?: NonNullable<HostIntegrationsComputerUse["definitionId"]>;
  readonly operation: HostIntegrationsComputerUse["operation"];
  readonly params: HostIntegrationsComputerUse["params"];
  readonly runId: HostIntegrationsComputerUse["runId"];
  readonly runnerId: RunnerId;
  readonly sessionId: HostIntegrationsComputerUse["sessionId"];
  readonly threadTitle: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ComputerUseSend {
  readonly outcome: Promise<ComputerUseOutcome>;
  /** Fenced native settlement, retained after the caller abandons its answer. */
  readonly audit?: Promise<ComputerUseOutcome>;
}

export interface PhoneDisplayCapabilityDiagnostic {
  readonly runnerId: RunnerId;
  readonly connectionGeneration: number;
  readonly protocolVersion: number | null;
  readonly runtimeVersion: string | null;
  readonly state: "attached" | "reported" | "detached";
  readonly displayAvailable: boolean | null;
  readonly reason: RunnerStreamLossReason | null;
}

export interface ComputerAppHubOptions {
  readonly onPhoneDisplayCapability?: (status: PhoneDisplayCapabilityDiagnostic) => void;
  readonly onDisplayEvent?: (
    runnerId: RunnerId,
    event: Extract<
      IntegrationsModuleEvent,
      {
        type:
          | "runner.integrations.display.input-result"
          | "runner.integrations.display.editing"
          | "runner.integrations.display.clipboard"
          | "runner.integrations.mac-owner.event"
          | "runner.integrations.display.state"
          | "runner.integrations.display.control-state"
          | "runner.integrations.display.source-ended"
          | "runner.integrations.display.source-changed";
      }
    >,
  ) => void;
  /**
   * The definitions this Host's catalog describes. The catalog is the one
   * description of an app, so a computer reporting one this Host does not know
   * is reporting something nobody here could name or call.
   */
  readonly knownDefinitionIds: () => ReadonlySet<string>;
  /** What every attach, detach and changed status makes stale. */
  readonly onChanged: () => void;
  /**
   * That computer's `integrations` stream is gone.
   *
   * The desktop closes the helper session bound to a bridge connection the
   * moment that Runner's socket drops, so the Host's own record of it is over
   * too and holding it would make the Mac look busy to the next Run.
   */
  readonly onRunnerDetached?: (runnerId: RunnerId, reason: RunnerStreamLossReason) => void;
  /** An unsolicited helper event from the current fenced stream. */
  readonly onComputerUseEvent?: (runnerId: RunnerId, event: ComputerUseHelperEvent) => void;
  /**
   * That computer's `integrations` stream is now the current one. Its Mac is
   * owed the whole approval list, which is how an approval made while it was
   * away reaches it.
   */
  readonly onRunnerAttached?: (runnerId: RunnerId) => void;
  /** The person's answer to one approval, from the Mac it waits on. */
  readonly onComputerAppApprovalAnswer?: (
    runnerId: RunnerId,
    answer: ComputerAppApprovalAnswerFrame,
  ) => void;
  /** That Mac asked for its whole approval list again. */
  readonly onComputerAppApprovalsSync?: (runnerId: RunnerId) => void;
}

interface PendingInvoke {
  readonly effect: IntegrationToolEffect;
  readonly kind: "invoke";
  /** Idempotent: the first answer to arrive is the one the caller gets. */
  readonly settle: (outcome: ComputerAppInvokeOutcome) => void;
}

interface PendingComputerUse {
  readonly effect: IntegrationToolEffect;
  readonly kind: "computer-use";
  readonly settle: (outcome: ComputerUseOutcome, terminal?: boolean) => void;
}

type PendingCall = PendingInvoke | PendingComputerUse;

export type PasswordSignInHubEvent =
  PasswordSignInAuthorityEvent | { readonly type: "authority-lost" };

interface AttachedIntegrations {
  loginText: LoginReceiverKey | null;
  passwordSignIn: boolean;
  readonly pendingPasswords: Map<
    RunnerAuxiliaryRequestId,
    (result: PasswordSignInAuthorityResult) => void
  >;
  apps: readonly MachineAppStatus[];
  statusReceived: boolean;
  ownerViewVersion: number | undefined;
  displayAvailable: boolean;
  readonly displayResolutions: Map<
    RunnerAuxiliaryRequestId,
    (target: MacWindowTarget | null) => void
  >;
  readonly pendingOwnerWindows: Map<
    RunnerAuxiliaryRequestId,
    (result: RunnerIntegrationsComputerAppWindowsResult["result"]) => void
  >;
  readonly pendingViews: Map<
    RunnerAuxiliaryRequestId,
    { settle(result: RunnerIntegrationsComputerViewResult["result"]): void }
  >;
  readonly mcpSessions: Map<string, McpSessionEntry>;
  readonly peer: ComputerAppControlPeer;
  readonly pending: Map<RunnerAuxiliaryRequestId, PendingCall>;
  readonly approvalKeyProofs: Map<string, (signature: string | null) => void>;
  stream: RunnerAuxiliaryStream;
}

/** One attached computer as the computer-app surfaces name it, from its live stream. */
export interface ComputerAppMachine {
  readonly name: string;
  readonly runnerId: RunnerId;
  readonly status: MachineAppStatus | null;
}

/**
 * The Host's end of every `integrations` stream: the last status each computer
 * reported, and the invokes in flight on it.
 *
 * Admission and the wait for an answer are deliberately separate calls. An
 * invoke is decided under `withRunnerAdmission` — is the connection still
 * there, does its access still cover this operation — and `send` returns as
 * soon as the frame has left, so the turn a disconnect or an access change
 * needs is not held for the seconds an app takes to answer. `invoke` is the
 * whole thing for a caller with nothing to serialise against.
 *
 * Losing the answer to a `write` is not the same as the write not happening.
 * A deadline, an abort and a dropped stream all end a call without knowing
 * what the computer did, so a write reports `outcome-unknown` and nothing is
 * ever retried here; a read changed nothing and is a plain retryable failure.
 * Only `ComputerAppSubmissionNotStartedError` proves the frame never left. A
 * generic send rejection remains uncertain because the socket may already
 * have accepted the complete frame.
 */
export class ComputerAppHub {
  readonly #byPeer = new Map<string, AttachedIntegrations>();
  readonly #byRunner = new Map<RunnerId, AttachedIntegrations>();
  readonly #options: ComputerAppHubOptions;
  readonly #passwordListeners = new Set<
    (runnerId: RunnerId, event: PasswordSignInHubEvent) => void
  >();
  readonly #turns = new Map<RunnerId, { readonly queue: MutationQueue; waiting: number }>();
  #closed = false;

  constructor(options: ComputerAppHubOptions) {
    this.#options = options;
  }

  // ---- stream ----------------------------------------------------------

  attach(peer: ComputerAppControlPeer, stream: RunnerAuxiliaryStream): void {
    if (this.#closed) throw new Error("The computer app hub is closed.");
    const runnerId = stream.identity.runnerId;
    const previous = this.#byRunner.get(runnerId);
    // The registry closes a superseded stream and reports it lost, but that is
    // its own event; this keeps the maps truthful if the order ever differs.
    if (previous && previous.peer !== peer) this.#drop(previous, "superseded");
    const entry: AttachedIntegrations = {
      apps: [],
      statusReceived: false,
      loginText: null,
      passwordSignIn: false,
      pendingPasswords: new Map(),
      ownerViewVersion: undefined,
      displayAvailable: false,
      pendingViews: new Map(),
      pendingOwnerWindows: new Map(),
      displayResolutions: new Map(),
      mcpSessions: new Map(),
      peer,
      pending: new Map(),
      approvalKeyProofs: new Map(),
      stream,
    };
    this.#byPeer.set(peer.id, entry);
    this.#byRunner.set(runnerId, entry);
    this.#reportPhoneDisplayCapability(entry, "attached");
    this.#options.onChanged();
    this.#options.onRunnerAttached?.(runnerId);
  }

  renew(peer: ComputerAppControlPeer, stream: RunnerAuxiliaryStream): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    entry.stream = stream;
  }

  detach(peer: ComputerAppControlPeer, reason: RunnerStreamLossReason): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    this.#drop(entry, reason);
  }

  /** The registry dropped the stream, so no socket event will arrive. */
  detachRunner(runnerId: RunnerId, reason: RunnerStreamLossReason): void {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) return;
    this.#drop(entry, reason);
    entry.peer.close(reason === "revoked" ? 4003 : 4001, `integrations stream ${reason}`);
  }

  /**
   * Reads one module frame and returns.
   *
   * The auxiliary dispatcher is serial, so nothing here waits on a send or a
   * database call: a status is applied and a result is handed to whoever is
   * waiting for it, both synchronously.
   */
  async handleMessage(
    peer: ComputerAppControlPeer,
    stream: RunnerAuxiliaryStream,
    message: IntegrationsModuleEvent,
  ): Promise<void> {
    const entry = this.#byPeer.get(peer.id);
    if (entry === undefined || entry.peer !== peer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The integrations stream is not attached.",
      });
    }
    if (!sameRunnerAuxiliaryFence(entry.stream.fence, stream.fence)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "That frame belongs to a superseded integrations stream.",
      });
    }
    if (message.type === "runner.integrations.password-sign-in-result") {
      entry.pendingPasswords.get(message.requestId)?.(message.result);
      return;
    }
    if (message.type === "runner.integrations.password-sign-in-event") {
      if (this.passwordSignInSupported(stream.identity.runnerId))
        this.#emitPasswordSignIn(stream.identity.runnerId, message.event);
      return;
    }
    if (message.type === "runner.integrations.status") {
      const module = entry.stream.identity.modules?.integrations;
      entry.loginText =
        module?.platform !== "ios" &&
        module?.loginText === 1 &&
        message.loginText &&
        (module.platform !== "android" ||
          (message.loginText.connectionId === stream.auxiliaryStreamId &&
            message.loginText.connectionGeneration === stream.fence.connectionGeneration))
          ? message.loginText
          : null;
      const supported =
        module?.platform === "darwin" &&
        module.passwordSignIn === 1 &&
        message.passwordSignIn === 1;
      if (entry.passwordSignIn && !supported) {
        for (const settle of entry.pendingPasswords.values()) settle({ type: "unavailable" });
        this.#emitPasswordSignIn(stream.identity.runnerId, { type: "authority-lost" });
      }
      entry.passwordSignIn = supported;
      this.#applyStatus(entry, message.apps, message.ownerViewVersion, message.displayAvailable);
      return;
    }
    if (message.type === "runner.integrations.computer-use-event") {
      this.#options.onComputerUseEvent?.(stream.identity.runnerId, message.event);
      return;
    }
    // The runner is the one this authenticated, fenced stream belongs to, so
    // an answer can only ever be about an approval waiting on this Mac.
    if (message.type === "runner.integrations.computer-app-approval-answer") {
      if (!this.relaysComputerAppApprovals(stream.identity.runnerId)) return;
      this.#options.onComputerAppApprovalAnswer?.(stream.identity.runnerId, {
        answer: message.answer,
        setupRequestId: message.setupRequestId,
      });
      return;
    }
    if (message.type === "runner.integrations.computer-app-approvals-sync") {
      if (!this.relaysComputerAppApprovals(stream.identity.runnerId)) return;
      this.#options.onComputerAppApprovalsSync?.(stream.identity.runnerId);
      return;
    }
    if (message.type === "runner.integrations.computer-app-approval-key-proof") {
      entry.approvalKeyProofs.get(message.challengeId)?.(message.signature);
      return;
    }
    if (
      message.type === "runner.integrations.mcp.opened" ||
      message.type === "runner.integrations.mcp.message" ||
      message.type === "runner.integrations.mcp.closed"
    ) {
      this.#mcpFrame(entry, message);
      return;
    }
    if (message.type === "runner.integrations.display.resolved") {
      entry.displayResolutions.get(message.requestId)?.(message.target);
      return;
    }
    if (message.type === "runner.integrations.computer-app-windows-result") {
      entry.pendingOwnerWindows.get(message.requestId)?.(message.result);
      return;
    }
    if (message.type === "runner.integrations.computer-view-result") {
      entry.pendingViews.get(message.requestId)?.settle(message.result);
      return;
    }
    if (
      message.type === "runner.integrations.display.input-result" ||
      message.type === "runner.integrations.display.editing" ||
      message.type === "runner.integrations.display.clipboard" ||
      message.type === "runner.integrations.mac-owner.event" ||
      message.type === "runner.integrations.display.state" ||
      message.type === "runner.integrations.display.control-state" ||
      message.type === "runner.integrations.display.source-ended" ||
      message.type === "runner.integrations.display.source-changed"
    ) {
      this.#options.onDisplayEvent?.(stream.identity.runnerId, message);
      return;
    }
    const pending = entry.pending.get(message.requestId);
    // A result races the cancel a deadline or an abort already sent, so a
    // request this stream no longer holds is the answer to a call that is
    // over. Refusing the frame would close a healthy stream over a lost race.
    if (!pending) return;
    // Computer use rides the same stream but answers in its own vocabulary, so
    // a frame whose kind does not match the call waiting on that request id is
    // not an answer to it and settles nothing.
    if (message.type === "runner.integrations.computer-use-result") {
      if (pending.kind !== "computer-use") return;
      pending.settle(computerUseOutcomeForResult(message.result));
      return;
    }
    if (pending.kind !== "invoke") return;
    pending.settle(outcomeForResult(message.result));
  }

  // ---- MCP servers a computer runs ----------------------------------------

  /**
   * Opens a session with an MCP server that computer runs, resolving once
   * the computer started it. The computer decides whether it may: it runs
   * only a launch its owner approved there, and refuses anything else as
   * `unapproved`. Messages go through unread both ways; `onclose` is called
   * once, with why, whenever the session ends other than by `close`. Aborting
   * `signal` while it opens ends it there, and on the computer.
   */
  async openMcpSession(input: {
    readonly launch: LocalMcpLaunch;
    readonly onclose: (error: ComputerMcpSessionError | null) => void;
    readonly onmessage: (message: unknown) => void;
    readonly runnerId: RunnerId;
    readonly serverId: IntegrationServerId;
    readonly signal: AbortSignal;
  }): Promise<ComputerMcpSession> {
    const entry = this.#byRunner.get(input.runnerId);
    if (this.#closed || !entry) {
      throw new ComputerMcpSessionError("offline", "That computer is offline.");
    }
    if (entry.stream.identity.modules?.integrations?.platform === "ios")
      throw new ComputerMcpSessionError("failed", "Local servers can't run on an iPhone.");
    const incompatibility = runnerIntegrationsCompatibilityReason(
      entry.stream.identity.modules.integrations,
    );
    if (incompatibility) throw new ComputerMcpSessionError("failed", incompatibility);
    if (input.signal.aborted) throw abandonedMcpSession();
    const sessionId = randomUUID();
    const session: McpSessionEntry = {
      onclose: input.onclose,
      onmessage: input.onmessage,
      opening: null,
    };
    const opened = new Promise<void>((resolve, reject) => {
      session.opening = { reject, resolve };
    });
    // The stream can end, or the opener give up, rejecting this before
    // anything awaits it below.
    opened.catch(() => undefined);
    const abandon = () => session.opening?.reject(abandonedMcpSession());
    input.signal.addEventListener("abort", abandon, { once: true });
    entry.mcpSessions.set(sessionId, session);
    const fence = { ...entry.stream.fence, module: "integrations" as const };
    let timer: NodeJS.Timeout | undefined;
    try {
      const submission = await this.#submit(entry, {
        ...fence,
        launch: input.launch,
        serverId: input.serverId,
        sessionId,
        type: "host.integrations.mcp.open",
      });
      if (submission !== "sent") {
        entry.mcpSessions.delete(sessionId);
        if (submission === "timed-out") this.#dropForSubmissionTimeout(entry, null);
        throw new ComputerMcpSessionError("offline", "That computer's connection dropped.");
      }
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ComputerMcpSessionError(
                "failed",
                "That computer did not start the MCP server in time.",
              ),
            ),
          computerMcpOpenTimeoutMs,
        );
        timer.unref();
      });
      try {
        await Promise.race([opened, late]);
      } catch (error) {
        if (entry.mcpSessions.delete(sessionId)) {
          void this.#submit(entry, { ...fence, sessionId, type: "host.integrations.mcp.close" });
        }
        throw error;
      }
    } finally {
      input.signal.removeEventListener("abort", abandon);
      if (timer) clearTimeout(timer);
    }
    return {
      close: async () => {
        if (!entry.mcpSessions.delete(sessionId)) return;
        await this.#submit(entry, { ...fence, sessionId, type: "host.integrations.mcp.close" });
      },
      send: async (message) => {
        if (!entry.mcpSessions.has(sessionId)) {
          throw new ComputerMcpSessionError("offline", "That MCP session has ended.");
        }
        const sent = await this.#submit(entry, {
          ...fence,
          message,
          sessionId,
          type: "host.integrations.mcp.message",
        });
        if (sent !== "sent") {
          if (sent === "timed-out") this.#dropForSubmissionTimeout(entry, null);
          throw new ComputerMcpSessionError("offline", "That computer's connection dropped.");
        }
      },
    };
  }

  #mcpFrame(
    entry: AttachedIntegrations,
    message: Extract<
      IntegrationsModuleEvent,
      {
        readonly type:
          | "runner.integrations.mcp.closed"
          | "runner.integrations.mcp.message"
          | "runner.integrations.mcp.opened";
      }
    >,
  ): void {
    const session = entry.mcpSessions.get(message.sessionId);
    // A frame for a session the Host already closed races that close.
    if (!session) return;
    if (message.type === "runner.integrations.mcp.opened") {
      session.opening?.resolve();
      session.opening = null;
      return;
    }
    if (message.type === "runner.integrations.mcp.message") {
      if (!session.opening) session.onmessage(message.message);
      return;
    }
    entry.mcpSessions.delete(message.sessionId);
    const error = message.error
      ? new ComputerMcpSessionError(message.error.code, message.error.message)
      : null;
    if (session.opening) {
      session.opening.reject(
        error ?? new ComputerMcpSessionError("failed", "The MCP server did not start."),
      );
      return;
    }
    session.onclose(error);
  }

  // ---- status ----------------------------------------------------------

  /** What one computer reports, or null when it is not attached at all. */
  status(runnerId: RunnerId): readonly MachineAppStatus[] | null {
    return this.#byRunner.get(runnerId)?.apps ?? null;
  }

  loginReceiver(runnerId: RunnerId): LoginReceiverKey | null {
    return this.#byRunner.get(runnerId)?.loginText ?? null;
  }

  passwordSignInSupported(runnerId: RunnerId): boolean {
    return !this.#closed && this.#byRunner.get(runnerId)?.passwordSignIn === true;
  }

  onPasswordSignIn(
    listener: (runnerId: RunnerId, event: PasswordSignInHubEvent) => void,
  ): () => void {
    this.#passwordListeners.add(listener);
    return () => this.#passwordListeners.delete(listener);
  }

  #emitPasswordSignIn(runnerId: RunnerId, event: PasswordSignInHubEvent): void {
    for (const listener of this.#passwordListeners) listener(runnerId, event);
  }

  async sendPasswordSignIn(
    runnerId: RunnerId,
    command: PasswordSignInAuthorityCommand,
  ): Promise<PasswordSignInAuthorityResult> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry || !this.passwordSignInSupported(runnerId) || entry.pendingPasswords.size >= 128)
      return { type: "unavailable" };
    const parsed = PasswordSignInAuthorityCommandSchema.parse(command);
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    const timeoutMs = command.type === "signin.probe" ? 5_000 : 60_000;
    return new Promise((resolve) => {
      const finish = (result: PasswordSignInAuthorityResult) => {
        if (!entry.pendingPasswords.delete(requestId)) return;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ type: "unavailable" }), timeoutMs);
      timer.unref();
      entry.pendingPasswords.set(requestId, finish);
      void this.#submit(entry, {
        ...entry.stream.fence,
        module: "integrations",
        type: "host.integrations.password-sign-in",
        requestId,
        timeoutMs,
        command: parsed,
      })
        .then((submitted) => {
          if (submitted !== "sent") finish({ type: "unavailable" });
          if (submitted === "timed-out") this.#dropForSubmissionTimeout(entry, null);
        })
        .catch(() => finish({ type: "unavailable" }));
    });
  }

  ownerViewSupported(runnerId: RunnerId): boolean {
    const entry = this.#byRunner.get(runnerId);
    if (entry?.stream.identity.modules.integrations?.platform === "ios") return false;
    if (entry?.stream.identity.modules.integrations?.platform === "android")
      return (
        this.displayStream(runnerId) !== null && this.displayStream(runnerId) !== "unsupported"
      );
    return computerOwnerViewSupported(
      "app",
      entry?.stream.identity.modules.integrations?.ownerViewVersion,
      entry?.ownerViewVersion,
    );
  }

  async ownerWindows(
    runnerId: RunnerId,
    app: ComputerAppIdentity,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<OwnerWindowInfo[]> {
    const entry = this.#byRunner.get(runnerId);
    if (this.#closed || !entry || Date.parse(entry.stream.streamLeaseExpiresAt) <= Date.now())
      throw new ComputerAppWindowsError("offline", "That computer is offline.");
    if (
      !this.ownerViewSupported(runnerId) ||
      entry.stream.identity.modules.integrations?.platform !== "darwin"
    )
      throw new ComputerAppWindowsError(
        "incompatible-version",
        "Update Opensteer on that Mac to list its windows.",
      );
    if (options.signal?.aborted)
      throw new ComputerAppWindowsError("failed", "The window listing was cancelled.");
    if (entry.pendingOwnerWindows.size >= 128)
      throw new ComputerAppWindowsError("busy", "That computer is busy.");
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    const frame = HostIntegrationsComputerAppWindowsSchema.parse({
      ...entry.stream.fence,
      type: "host.integrations.computer-app-windows",
      module: "integrations",
      app,
      requestId,
      timeoutMs: options.timeoutMs,
    });
    return new Promise((resolve, reject) => {
      const finish = (result: RunnerIntegrationsComputerAppWindowsResult["result"]) => {
        if (!entry.pendingOwnerWindows.delete(requestId)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (result.kind === "error") {
          reject(new ComputerAppWindowsError(result.code, result.message));
          return;
        }
        const parsed = ComputerUseViewWindowsResultSchema.safeParse(result.value);
        if (!parsed.success) {
          reject(
            new ComputerAppWindowsError(
              "failed",
              "The computer returned an unreadable window list.",
            ),
          );
          return;
        }
        resolve(parsed.data.windows);
      };
      const abort = () => {
        finish({ kind: "error", code: "failed", message: "The window listing was cancelled." });
        void this.#cancel(entry, requestId);
      };
      const timer = setTimeout(() => {
        finish({
          kind: "error",
          code: "failed",
          message: "The computer did not list its windows in time.",
        });
        void this.#cancel(entry, requestId);
      }, options.timeoutMs + computerUseAnswerGraceMs);
      timer.unref();
      entry.pendingOwnerWindows.set(requestId, finish);
      options.signal?.addEventListener("abort", abort, { once: true });
      void this.#submit(entry, frame).then(
        (submitted) => {
          if (submitted === "sent") return;
          finish({
            kind: "error",
            code: "failed",
            message: "The window listing could not be sent.",
          });
          if (submitted === "timed-out") this.#dropForSubmissionTimeout(entry, null);
        },
        () => finish({ kind: "error", code: "failed", message: "The computer disconnected." }),
      );
      if (options.signal?.aborted) abort();
    });
  }

  async sendComputerView(input: {
    readonly runnerId: RunnerId;
    readonly request: Pick<
      HostIntegrationsComputerView,
      "viewId" | "generation" | "leaseDurationMs" | "target" | "operation" | "timeoutMs"
    >;
    readonly signal?: AbortSignal;
  }): Promise<RunnerIntegrationsComputerViewResult["result"]> {
    const entry = this.#byRunner.get(input.runnerId);
    if (!entry || !this.ownerViewSupported(input.runnerId))
      return {
        kind: "error",
        code: "unsupported",
        message: "This computer does not support owner views.",
      };
    if (input.signal?.aborted)
      return { kind: "error", code: "ended", message: "The view read was cancelled." };
    if (entry.pendingViews.size >= 128)
      return { kind: "error", code: "unavailable", message: "That computer is busy." };
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    return new Promise((resolve) => {
      let answered = false;
      const answer = (result: RunnerIntegrationsComputerViewResult["result"]) => {
        if (answered) return;
        answered = true;
        input.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const finish = (result: RunnerIntegrationsComputerViewResult["result"]) => {
        clearTimeout(timer);
        entry.pendingViews.delete(requestId);
        answer(result);
      };
      const abort = () => {
        answer({ kind: "error", code: "ended", message: "The view read was cancelled." });
        void this.#cancel(entry, requestId);
      };
      const timer = setTimeout(
        () =>
          finish({
            kind: "error",
            code: "unavailable",
            message: "That computer did not answer in time.",
          }),
        input.request.timeoutMs + computerUseAnswerGraceMs,
      );
      timer.unref();
      entry.pendingViews.set(requestId, { settle: finish });
      input.signal?.addEventListener("abort", abort, { once: true });
      void this.#submit(entry, {
        ...entry.stream.fence,
        ...input.request,
        type: "host.integrations.computer-view",
        version: input.request.target.kind === "app" ? macOwnerViewVersion : 1,
        module: "integrations",
        requestId,
      }).then(
        (submitted) => {
          if (submitted === "sent") return;
          const result = {
            kind: "error",
            code: "unavailable",
            message: "The owner-view request could not be sent.",
          } as const;
          finish(result);
          if (submitted instanceof ComputerAppSubmissionNotStartedError && submitted.close)
            entry.peer.close(submitted.close.code, submitted.close.reason);
        },
        () =>
          finish({ kind: "error", code: "unavailable", message: "That computer disconnected." }),
      );
      if (input.signal?.aborted) abort();
    });
  }

  /** Distinguish a missing/expired stream from a live peer without this capability. */
  displayStream(runnerId: RunnerId):
    | {
        readonly fence: RunnerAuxiliaryFrameFence & { readonly module: "integrations" };
        readonly mac?: true;
        readonly editingVersion?: 1;
        readonly displayCut?: 1;
      }
    | "unsupported"
    | null {
    const stream = this.#byRunner.get(runnerId)?.stream;
    if (this.#closed || !stream || Date.parse(stream.streamLeaseExpiresAt) <= Date.now())
      return null;
    const module = stream.identity.modules.integrations;
    if (module?.platform === "ios") return null;
    if (
      stream.fence.module !== "integrations" ||
      (module?.platform !== "android" &&
        (module?.platform !== "darwin" ||
          module.macWindowVideoVersion !== 1 ||
          !macWindowVideoOwnerViewVersions.includes(
            this.#byRunner.get(runnerId)?.ownerViewVersion ?? 0,
          ))) ||
      !this.#byRunner.get(runnerId)?.displayAvailable ||
      runnerIntegrationsCompatibilityReason(module) !== null
    )
      return "unsupported";
    return {
      fence: { ...stream.fence, module: stream.fence.module },
      ...(module.platform === "darwin" ? { mac: true as const } : {}),
      ...(module.platform === "android" && module.editing === 1 && module.displayCut === 1
        ? { displayCut: 1 as const }
        : {}),
      ...(module.platform === "android" && module.editing === 1
        ? { editingVersion: 1 as const }
        : {}),
    };
  }

  async resolveDisplay(
    runnerId: RunnerId,
    source: DisplaySource,
    timeoutMs: number,
  ): Promise<MacWindowTarget> {
    const entry = this.#byRunner.get(runnerId);
    const live = this.displayStream(runnerId);
    if (
      !entry ||
      !live ||
      live === "unsupported" ||
      !live.mac ||
      entry.displayResolutions.size >= 8
    )
      throw new Error("Window resolution unavailable");
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    return await new Promise<MacWindowTarget>((resolve, reject) => {
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      const finish = (target: MacWindowTarget | null) => {
        if (!entry.displayResolutions.delete(requestId)) return;
        clearTimeout(timer);
        if (target && this.#byRunner.get(runnerId) === entry) resolve(target);
        else reject(new Error("Window resolution ended"));
      };
      entry.displayResolutions.set(requestId, finish);
      void this.#sendControl(entry, {
        ...live.fence,
        type: "host.integrations.display.resolve",
        ...(entry.stream.identity.modules.integrations?.macOwnerInputVersion === 1
          ? { ownerInputVersion: 1 as const }
          : {}),
        requestId,
        source,
        timeoutMs: Math.max(1, Math.min(30_000, timeoutMs)),
      }).then(
        (sent) => {
          if (!sent) finish(null);
        },
        () => finish(null),
      );
    });
  }

  async sendDisplay(
    fence: RunnerAuxiliaryFrameFence,
    message: HostIntegrationsOperation,
  ): Promise<boolean> {
    const entry = this.#byRunner.get(fence.runnerId);
    const live = this.displayStream(fence.runnerId);
    if (
      !entry ||
      !live ||
      live === "unsupported" ||
      !sameRunnerAuxiliaryFence(live.fence, fence) ||
      !sameRunnerAuxiliaryFence(live.fence, message)
    )
      return false;
    return this.#sendControl(entry, message);
  }

  appStatus(runnerId: RunnerId, definitionId: string): MachineAppStatus | null {
    const apps = this.#byRunner.get(runnerId)?.apps;
    return apps?.find((app) => app.definitionId === definitionId) ?? null;
  }

  /** An empty first report means unsupported; a new stream has not told us yet. */
  reportsApp(
    runnerId: RunnerId,
    definitionId: string,
  ): "offline" | "connecting" | "absent" | "reported" {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) return "offline";
    if (!entry.statusReceived) return "connecting";
    return entry.apps.some((app) => app.definitionId === definitionId) ? "reported" : "absent";
  }

  attached(runnerId: RunnerId): boolean {
    return this.#byRunner.has(runnerId);
  }

  /**
   * Whether this computer's Runner relays approvals to a desktop that shows
   * them. An older Runner, or one no desktop supervises, is never sent an
   * approval frame: it could not parse it, and nobody there could answer it.
   */
  relaysComputerAppApprovals(runnerId: RunnerId): boolean {
    const entry = this.#byRunner.get(runnerId);
    const module = entry?.stream.identity.modules.integrations;
    return (
      (module?.platform === "darwin" || module?.platform === "ios") &&
      module.computerAppApprovals === true &&
      runnerIntegrationsCompatibilityReason(module) === null
    );
  }

  /**
   * Why an attached computer cannot show its owner approvals, in that owner's
   * words, or null when it can. An offline computer is not refused: its
   * approvals wait for it to come back.
   */
  approvalRelayRefusal(runnerId: RunnerId): string | null {
    const entry = this.#byRunner.get(runnerId);
    if (!entry || this.relaysComputerAppApprovals(runnerId)) return null;
    if (entry.stream.identity.modules.integrations?.platform === "android") return null;
    if (entry.stream.identity.modules?.integrations?.platform === "ios")
      return "Update Opensteer on this iPhone to approve access.";
    return "Update Opensteer on this Mac and open its desktop app to approve access.";
  }

  /**
   * Sends one Mac every approval waiting on it. Best effort, like a cancel:
   * the list is complete every time, so the next one repairs a lost one.
   */
  async sendComputerAppApprovals(
    runnerId: RunnerId,
    list: {
      readonly approvalKeyId: ComputerAppApprovalList["approvalKeyId"];
      readonly approvals: readonly ComputerAppApprovalList["approvals"][number][];
    },
  ): Promise<boolean> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry || !this.relaysComputerAppApprovals(runnerId)) return false;
    return this.#sendControl(entry, {
      ...entry.stream.fence,
      module: "integrations",
      approvalKeyId: list.approvalKeyId,
      approvals: [...list.approvals],
      type: "host.integrations.computer-app-approvals",
    });
  }

  /** Tells one Mac what became of its answer. */
  async sendComputerAppApprovalOutcome(
    runnerId: RunnerId,
    frame: ComputerAppApprovalOutcomeFrame,
  ): Promise<boolean> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry || !this.relaysComputerAppApprovals(runnerId)) return false;
    return this.#sendControl(entry, {
      ...entry.stream.fence,
      module: "integrations",
      outcome: frame.outcome,
      setupRequestId: frame.setupRequestId,
      type: "host.integrations.computer-app-approval-outcome",
    });
  }

  /**
   * Tells a phone that its owner's Stop is durably recorded, so it may stop
   * reporting it. Best effort: a phone that does not hear it reports the Stop
   * again on its next stream, and recording it again changes nothing.
   */
  async acknowledgeComputerUseStop(
    runnerId: RunnerId,
    stop: { readonly runId: RunId; readonly sessionId: ComputerUseSessionId },
  ): Promise<boolean> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) return false;
    return this.#sendControl(entry, {
      ...entry.stream.fence,
      module: "integrations",
      runId: stop.runId,
      sessionId: stop.sessionId,
      type: "host.integrations.computer-use-stop-recorded",
    });
  }

  /** Proves that the desktop on the currently attached Mac holds a nominated key. */
  async proveComputerAppApprovalKey(
    runnerId: RunnerId,
    challenge: ComputerAppApprovalKeyChallenge,
  ): Promise<string | null> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry || !this.relaysComputerAppApprovals(runnerId)) return null;
    if (challenge.runnerId !== runnerId) return null;
    let settle!: (signature: string | null) => void;
    const proof = new Promise<string | null>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(
      () => settle(null),
      Math.max(0, Date.parse(challenge.expiresAt) - Date.now()),
    );
    timer.unref();
    entry.approvalKeyProofs.set(challenge.challengeId, settle);
    try {
      const delivered = await this.#sendControl(entry, {
        ...entry.stream.fence,
        ...challenge,
        module: "integrations",
        type: "host.integrations.computer-app-approval-key-challenge",
      });
      if (!delivered) return null;
      return await proof;
    } finally {
      clearTimeout(timer);
      entry.approvalKeyProofs.delete(challenge.challengeId);
    }
  }

  /**
   * Every attached computer and what it says about one definition, by the name
   * its own stream carries. It is the only place the Host can name a computer
   * that is lending apps or its screen without reading the registry again.
   */
  machinesFor(definitionId: string): readonly ComputerAppMachine[] {
    return [...this.#byRunner.entries()].map(([runnerId, entry]) => ({
      name: entry.stream.identity.name,
      runnerId,
      status: entry.apps.find((app) => app.definitionId === definitionId) ?? null,
    }));
  }

  // ---- invoking --------------------------------------------------------

  /**
   * Sends one invoke, returning once the frame has left the Host or failed to.
   *
   * Call this inside `withRunnerAdmission` and await the returned `outcome`
   * outside it, so slow computers do not queue behind each other.
   */
  async send(input: ComputerAppInvokeInput): Promise<ComputerAppInvokeSend> {
    if (this.#closed) return settled(offline("Opensteer is shutting down."));
    const entry = this.#byRunner.get(input.runnerId);
    if (!entry) return settled(offline("That computer is offline."));
    // No queue: a caller waiting behind three other calls would spend its whole
    // deadline waiting, and report a timeout the computer never caused.
    if (agentPendingCount(entry) >= computerAppMaxConcurrentInvokes) {
      return settled({
        code: "busy",
        kind: "error",
        message: "That computer is already running as many requests as it accepts.",
        retryable: true,
      });
    }
    // Nothing has been sent, so even a write is simply undone rather than
    // unknown.
    const isAborted = () => input.signal?.aborted === true;
    if (isAborted()) {
      return settled({
        code: "lost",
        kind: "error",
        message: "The request was cancelled before it was sent.",
        retryable: true,
      });
    }
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    const timeoutMs = Math.min(input.timeoutMs ?? computerAppMaxTimeoutMs, computerAppMaxTimeoutMs);
    let resolve!: (outcome: ComputerAppInvokeOutcome) => void;
    const outcome = new Promise<ComputerAppInvokeOutcome>((settle) => {
      resolve = settle;
    });
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    // The listener is attached only after the invoke has been handed to the
    // socket, so an abort here always means a frame the computer may already
    // be acting on: it is told to stop, and the caller is told nothing is known.
    const onAbort = () => {
      finish(lossOutcome(input.effect, "The request was cancelled."));
      void this.#cancel(entry, requestId);
    };
    const finish = (result: ComputerAppInvokeOutcome) => {
      if (done) return;
      done = true;
      entry.pending.delete(requestId);
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // In memory before anything is awaited: the slot this call holds has to be
    // visible to the next caller, and a result that arrives while the send is
    // still completing has to find its request.
    entry.pending.set(requestId, { effect: input.effect, kind: "invoke", settle: finish });
    const submission = await this.#submit(entry, {
      // The fence names the exact stream; the module is restated because
      // only an `integrations` stream ever reaches this hub.
      ...entry.stream.fence,
      module: "integrations",
      access: input.access,
      arguments: input.arguments,
      contract: input.contract,
      definitionId: input.definitionId,
      operation: input.operation,
      requestId,
      timeoutMs,
      type: "host.integrations.invoke",
    });
    if (submission === "failed") {
      // `peer.send` has already handed the frame to the WebSocket when its
      // completion callback rejects. That callback cannot prove whether the
      // Runner received and acted on a complete frame, so a write has the same
      // uncertainty as any other lost answer. Reads remain safely retryable.
      finish(
        submissionLoss(
          input.effect,
          "That computer's connection ended while the request was being sent.",
        ),
      );
      return { outcome };
    }
    if (submission instanceof ComputerAppSubmissionNotStartedError) {
      finish(offline("That computer's connection ended before the request was sent."));
      if (submission.close) entry.peer.close(submission.close.code, submission.close.reason);
      return { outcome };
    }
    if (submission === "timed-out") {
      this.#dropForSubmissionTimeout(entry, requestId);
      return { outcome };
    }
    if (done) return { outcome };
    // Submission has its own shorter bound. The operation deadline starts only
    // after the socket confirms that it accepted the frame for delivery.
    timer = setTimeout(() => {
      finish(lossOutcome(input.effect, "That computer did not answer in time."));
      void this.#cancel(entry, requestId);
    }, timeoutMs);
    timer.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) onAbort();
    return { outcome };
  }

  /** The whole call, for a caller that holds no admission turn of its own. */
  async invoke(input: ComputerAppInvokeInput): Promise<ComputerAppInvokeOutcome> {
    const sent = await this.send(input);
    return sent.outcome;
  }

  /**
   * Sends one computer-use operation, returning once the frame has left.
   *
   * It is `send` with the other frame of the pair: the same stream, the same
   * fence, the same concurrency cap, the same cancellation, and the same rule
   * about a lost answer — an `act` may already have happened in the app, so it
   * is `outcome-unknown` and nothing retries it, while an `observe` changed
   * nothing and is an ordinary `failed` the caller may try again.
   */
  async sendComputerUse(input: ComputerUseSendInput): Promise<ComputerUseSend> {
    const effect: IntegrationToolEffect = input.operation === "act" ? "write" : "read";
    if (this.#closed) return settledComputerUse(computerUseOffline("Opensteer is shutting down."));
    const entry = this.#byRunner.get(input.runnerId);
    if (!entry) return settledComputerUse(computerUseOffline("That computer is offline."));
    if (entry.stream.identity.modules?.integrations?.platform === "ios")
      return settledComputerUse({
        kind: "error",
        code: "unsupported",
        message: "Computer use isn't available on an iPhone.",
        retryable: false,
      });
    if (
      input.operation !== "close" &&
      agentPendingCount(entry) >= computerAppMaxConcurrentInvokes
    ) {
      return settledComputerUse({
        code: "busy",
        kind: "error",
        message: "That computer is already running as many requests as it accepts.",
        retryable: true,
      });
    }
    const isAborted = () => input.signal?.aborted === true;
    if (isAborted()) {
      return settledComputerUse({
        code: "failed",
        kind: "error",
        message: "The request was cancelled before it was sent.",
        retryable: true,
      });
    }
    const requestId =
      input.requestId ?? RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    const timeoutMs = Math.min(input.timeoutMs ?? computerAppMaxTimeoutMs, computerAppMaxTimeoutMs);
    let resolve!: (outcome: ComputerUseOutcome) => void;
    const outcome = new Promise<ComputerUseOutcome>((settle) => {
      resolve = settle;
    });
    let resolveAudit!: (outcome: ComputerUseOutcome) => void;
    const audit = new Promise<ComputerUseOutcome>((resolve) => {
      resolveAudit = resolve;
    });
    let abandoned = false;
    let done = false;
    let answered = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      const response = {
        ...computerUseLoss(effect, "The request was cancelled."),
        abandoned: "cancelled" as const,
      };
      if (abandoned || done) return;
      abandoned = true;
      answer(response);
      void this.#cancel(entry, requestId);
    };
    const answer = (result: ComputerUseOutcome) => {
      if (answered) return;
      answered = true;
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const finish = (result: ComputerUseOutcome, terminal = false) => {
      if (done) return;
      // Cancellation acknowledgement is not the native batch's final report.
      // A previous Runner may never send another result; the original bounded
      // deadline below still closes this collector in that case.
      if (
        abandoned &&
        !terminal &&
        input.operation === "act" &&
        result.kind === "error" &&
        result.code === "outcome-unknown" &&
        !result.abandoned
      )
        return;
      done = true;
      entry.pending.delete(requestId);
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolveAudit(result);
      answer(result);
    };
    entry.pending.set(requestId, {
      effect,
      kind: "computer-use",
      settle: finish,
    });
    const submission = await this.#submit(entry, {
      ...entry.stream.fence,
      module: "integrations",
      access: input.access,
      app: input.app,
      ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }),
      operation: input.operation,
      params: input.params,
      requestId,
      runId: input.runId,
      sessionId: input.sessionId,
      threadTitle: input.threadTitle,
      timeoutMs,
      type: "host.integrations.computer-use",
    });
    if (submission === "failed") {
      finish(
        computerUseSubmissionLoss(
          effect,
          "That computer's connection ended while the request was being sent.",
        ),
      );
      return { outcome, audit };
    }
    if (submission instanceof ComputerAppSubmissionNotStartedError) {
      finish(computerUseOffline("That computer's connection ended before the request was sent."));
      if (submission.close) entry.peer.close(submission.close.code, submission.close.reason);
      return { outcome, audit };
    }
    if (submission === "timed-out") {
      this.#dropForSubmissionTimeout(entry, requestId);
      return { outcome, audit };
    }
    if (done) return { outcome, audit };
    timer = setTimeout(() => {
      const response = {
        ...computerUseLoss(effect, "That computer did not answer in time."),
        abandoned: "deadline" as const,
      };
      finish(response);
      void this.#cancel(entry, requestId);
    }, timeoutMs + computerUseAnswerGraceMs);
    timer.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) onAbort();
    return { outcome, audit };
  }

  /**
   * Runs one thing in a computer's admission turn.
   *
   * An access change, a disconnect and a machine revocation decide whether the
   * call being admitted right now is still authorized, so they belong in the
   * same queue as admission rather than beside it. Only admission belongs in
   * the turn: a call already sent must finish outside it, or four slow apps
   * would hold up the disconnect that is trying to stop them. Do not call
   * anything that takes this turn again from inside the task.
   */
  async withRunnerAdmission<Result>(
    runnerId: RunnerId,
    task: () => Promise<Result> | Result,
  ): Promise<Result> {
    const turn = this.#turns.get(runnerId) ?? { queue: new MutationQueue(), waiting: 0 };
    this.#turns.set(runnerId, turn);
    turn.waiting += 1;
    try {
      return await turn.queue.run(async () => task());
    } finally {
      turn.waiting -= 1;
      if (turn.waiting === 0 && this.#turns.get(runnerId) === turn) this.#turns.delete(runnerId);
    }
  }

  /** Host shutdown: no call outlives the Host that was waiting for it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const attached = [...this.#byPeer.values()];
    this.#byPeer.clear();
    this.#byRunner.clear();
    for (const entry of attached) {
      this.#settleAll(entry, "Opensteer is shutting down.");
      entry.peer.close(1001, "Host stopping");
    }
    if (attached.length > 0) this.#options.onChanged();
  }

  #applyStatus(
    entry: AttachedIntegrations,
    apps: readonly MachineAppStatus[],
    ownerViewVersion: number | undefined,
    displayAvailable: boolean | undefined,
  ): void {
    if (entry.stream.identity.modules?.integrations?.platform === "ios") {
      ownerViewVersion = undefined;
      displayAvailable = false;
    }
    const known = this.#options.knownDefinitionIds();
    const next = apps.flatMap((app): readonly MachineAppStatus[] => {
      if (!known.has(app.definitionId)) return [];
      const definition = getIntegrationDefinition(app.definitionId);
      if (!definition || !isComputerAppDefinition(definition)) return [app];
      const platform = entry.stream.identity.modules?.integrations?.platform;
      if (platform && !definition.config.platforms.includes(platform)) return [];
      const declared = new Set(definition.config.operations.map(({ name }) => name));
      const reported = new Set<string>();
      for (const operation of app.operations) {
        if (!declared.has(operation.operation) || reported.has(operation.operation)) return [];
        reported.add(operation.operation);
      }
      return [app];
    });
    if (
      entry.statusReceived &&
      sameAppStatus(entry.apps, next) &&
      entry.ownerViewVersion === ownerViewVersion &&
      entry.displayAvailable === (displayAvailable === true)
    )
      return;
    entry.statusReceived = true;
    entry.apps = next;
    entry.ownerViewVersion = ownerViewVersion;
    entry.displayAvailable = displayAvailable === true;
    this.#reportPhoneDisplayCapability(entry, "reported");
    this.#options.onChanged();
  }

  #reportPhoneDisplayCapability(
    entry: AttachedIntegrations,
    state: PhoneDisplayCapabilityDiagnostic["state"],
    reason: RunnerStreamLossReason | null = null,
  ): void {
    if (!this.#options.onPhoneDisplayCapability) return;
    const identity = entry.stream.identity;
    const module = identity.modules.integrations;
    if (module?.platform !== "android") return;
    this.#options.onPhoneDisplayCapability?.({
      runnerId: identity.runnerId,
      connectionGeneration: entry.stream.fence.connectionGeneration,
      protocolVersion: module.protocolVersion ?? null,
      runtimeVersion: identity.runtimeVersion ?? null,
      state,
      displayAvailable: state === "reported" ? entry.displayAvailable : null,
      reason,
    });
  }

  #drop(entry: AttachedIntegrations, reason: RunnerStreamLossReason): void {
    this.#reportPhoneDisplayCapability(entry, "detached", reason);
    this.#byPeer.delete(entry.peer.id);
    const runnerId = entry.stream.identity.runnerId;
    if (this.#byRunner.get(runnerId) === entry) this.#byRunner.delete(runnerId);
    this.#settleAll(
      entry,
      reason === "revoked" ? "That computer was removed." : "That computer went offline.",
    );
    this.#options.onRunnerDetached?.(runnerId, reason);
    this.#options.onChanged();
  }

  #settleAll(entry: AttachedIntegrations, message: string): void {
    entry.loginText = null;
    if (entry.passwordSignIn) {
      entry.passwordSignIn = false;
      this.#emitPasswordSignIn(entry.stream.identity.runnerId, { type: "authority-lost" });
    }
    for (const settle of entry.pendingPasswords.values()) settle({ type: "unavailable" });
    for (const settle of entry.displayResolutions.values()) settle(null);
    entry.displayResolutions.clear();
    for (const finish of entry.pendingOwnerWindows.values())
      finish({ kind: "error", code: "failed", message });
    for (const pending of entry.pendingViews.values())
      pending.settle({ kind: "error", code: "unavailable", message });
    for (const settle of entry.approvalKeyProofs.values()) settle(null);
    entry.approvalKeyProofs.clear();
    const sessions = [...entry.mcpSessions.values()];
    entry.mcpSessions.clear();
    for (const session of sessions) {
      const lost = new ComputerMcpSessionError("offline", message);
      if (session.opening) session.opening.reject(lost);
      else session.onclose(lost);
    }
    for (const pending of entry.pending.values()) {
      if (pending.kind === "computer-use") {
        pending.settle(computerUseLoss(pending.effect, message), true);
        continue;
      }
      pending.settle(lossOutcome(pending.effect, message));
    }
  }

  /**
   * Tells a computer to stop. It is best-effort by nature: the caller has
   * already been answered, and a cancel that cannot be delivered says nothing
   * about what the computer did with the call.
   */
  async #cancel(entry: AttachedIntegrations, requestId: RunnerAuxiliaryRequestId): Promise<void> {
    if (this.#byPeer.get(entry.peer.id) !== entry) return;
    const submission = await this.#submit(entry, {
      ...entry.stream.fence,
      module: "integrations",
      requestId,
      type: "host.integrations.cancel",
    });
    if (submission === "timed-out") this.#dropForSubmissionTimeout(entry, null);
    if (submission instanceof ComputerAppSubmissionNotStartedError && submission.close) {
      entry.peer.close(submission.close.code, submission.close.reason);
    }
  }

  /** A frame nobody waits on an answer to; the stream's fate is its only result. */
  async #sendControl(
    entry: AttachedIntegrations,
    message: HostIntegrationsOperation,
  ): Promise<boolean> {
    if (this.#closed || this.#byPeer.get(entry.peer.id) !== entry) return false;
    const submission = await this.#submit(entry, message);
    if (submission === "timed-out") this.#dropForSubmissionTimeout(entry, null);
    if (submission === "failed" || submission instanceof ComputerAppSubmissionNotStartedError) {
      // A control frame that did not arrive might have been the only push of
      // a new approval. Retire the broken stream so its reconnect replays the
      // complete list; no approval-specific retry queue can repair a socket.
      if (this.#byPeer.get(entry.peer.id) === entry) {
        this.#drop(entry, "transport-disconnected");
        entry.peer.close(
          submission instanceof ComputerAppSubmissionNotStartedError && submission.close
            ? submission.close.code
            : 1011,
          submission instanceof ComputerAppSubmissionNotStartedError && submission.close
            ? submission.close.reason
            : "integrations control frame could not be sent",
        );
      }
    }
    return submission === "sent";
  }

  async #submit(
    entry: AttachedIntegrations,
    message: HostIntegrationsOperation,
  ): Promise<"failed" | "sent" | "timed-out" | ComputerAppSubmissionNotStartedError> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), computerAppSubmitTimeoutMs);
      timer.unref();
    });
    const sent = entry.peer.send(message).then(
      () => "sent" as const,
      (error: unknown) =>
        error instanceof ComputerAppSubmissionNotStartedError ? error : ("failed" as const),
    );
    const result = await Promise.race([sent, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  #dropForSubmissionTimeout(
    entry: AttachedIntegrations,
    requestId: RunnerAuxiliaryRequestId | null,
  ): void {
    if (this.#byPeer.get(entry.peer.id) !== entry) return;
    this.#byPeer.delete(entry.peer.id);
    const runnerId = entry.stream.identity.runnerId;
    if (this.#byRunner.get(runnerId) === entry) this.#byRunner.delete(runnerId);
    entry.peer.close(1011, "integrations stream submission timed out");
    if (requestId !== null) {
      // An unresolved WebSocket callback says only that submission was not
      // confirmed. Bytes already handed to the socket may still have reached
      // the Runner, and a graceful close does not retract them.
      const stalled = "That computer's connection stalled while the request was being sent.";
      const pending = entry.pending.get(requestId);
      if (pending?.kind === "computer-use") {
        pending.settle(computerUseSubmissionLoss(pending.effect, stalled), true);
      } else if (pending) {
        pending.settle(submissionLoss(pending.effect, stalled));
      }
    }
    this.#settleAll(entry, "That computer went offline.");
    this.#options.onRunnerDetached?.(runnerId, "transport-disconnected");
    this.#options.onChanged();
  }
}

function offline(message: string): ComputerAppInvokeOutcome {
  return { code: "offline", kind: "error", message, retryable: true };
}

/**
 * What ending a call without an answer means.
 *
 * Cancelling a write is not undoing it: the message may already have been
 * sent, so the only truthful answer is that nobody knows, and nothing may
 * retry on the agent's behalf. A read changed nothing on that computer, so it
 * is an ordinary failure the caller may try again.
 */
function lossOutcome(effect: IntegrationToolEffect, message: string): ComputerAppInvokeOutcome {
  return effect === "write"
    ? { code: "outcome-unknown", kind: "error", message, retryable: false }
    : { code: "lost", kind: "error", message, retryable: true };
}

/** A socket submission was attempted but never confirmed. */
function submissionLoss(effect: IntegrationToolEffect, message: string): ComputerAppInvokeOutcome {
  return effect === "write" ? lossOutcome(effect, message) : offline(message);
}

function outcomeForResult(result: RunnerIntegrationsResult["result"]): ComputerAppInvokeOutcome {
  if (result.kind === "ok") return { kind: "ok", value: result.value };
  return {
    code: result.code,
    kind: "error",
    message: result.message,
    // Only a computer that was too busy to start says the same call could
    // succeed unchanged; every other refusal needs something to change first.
    retryable: result.code === "busy",
  };
}

function settled(outcome: ComputerAppInvokeOutcome): ComputerAppInvokeSend {
  return { outcome: Promise.resolve(outcome) };
}

function computerUseOffline(message: string): ComputerUseOutcome {
  return { code: "offline", kind: "error", message, retryable: true };
}

/**
 * Losing the answer to an `act` is not the act not happening: the batch may
 * already have run in the app, so nobody retries it on the agent's behalf. An
 * `observe` changed nothing there, so it is an ordinary retryable failure.
 */
function computerUseLoss(
  effect: IntegrationToolEffect,
  message: string,
): Extract<ComputerUseOutcome, { readonly kind: "error" }> {
  return effect === "write"
    ? { code: "outcome-unknown", kind: "error", message, retryable: false }
    : { code: "failed", kind: "error", message, retryable: true };
}

function computerUseSubmissionLoss(
  effect: IntegrationToolEffect,
  message: string,
): ComputerUseOutcome {
  return effect === "write" ? computerUseLoss(effect, message) : computerUseOffline(message);
}

function computerUseOutcomeForResult(
  result: RunnerIntegrationsComputerUseResult["result"],
): ComputerUseOutcome {
  if (result.kind === "ok") return { kind: "ok", value: result.value };
  return {
    code: result.code,
    kind: "error",
    message: result.message,
    // Only a Mac already running a session says this same call could succeed
    // unchanged once that one ends; every other refusal needs something else
    // to change first, and `outcome-unknown` is never tried again at all.
    retryable: result.code === "busy",
  };
}

function settledComputerUse(outcome: ComputerUseOutcome): ComputerUseSend {
  const settled = Promise.resolve(outcome);
  return { outcome: settled, audit: settled };
}

function agentPendingCount(entry: AttachedIntegrations): number {
  return entry.pending.size;
}

function sameAppStatus(
  left: readonly MachineAppStatus[],
  right: readonly MachineAppStatus[],
): boolean {
  return (
    left.length === right.length &&
    left.every((app, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        app.definitionId === other.definitionId &&
        app.operations.length === other.operations.length &&
        app.operations.every((operation, operationIndex) => {
          const otherOperation = other.operations[operationIndex];
          return (
            otherOperation !== undefined &&
            operation.operation === otherOperation.operation &&
            operation.state === otherOperation.state &&
            operation.detail === otherOperation.detail &&
            operation.remedy === otherOperation.remedy
          );
        })
      );
    })
  );
}
