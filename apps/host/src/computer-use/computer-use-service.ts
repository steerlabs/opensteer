import { randomUUID } from "node:crypto";
import {
  createId,
  OpensteerError,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import {
  computerAppIdentityKey,
  computerAppUsesSessions,
  isComputerAppDefinition,
  type ComputerAppIdentity,
  type ComputerAppPlatform,
  type IntegrationAccess,
} from "@opensteer/integration-core";
import {
  AndroidPhoneActParamsSchema,
  AndroidPhoneDispatchActParamsSchema,
  ComputerUseDispatchActParamsSchema,
  RunnerAuxiliaryRequestIdSchema,
  loginEnvelopeMaxLifetimeMs,
  LoginTextSchema,
  type LoginReceiverKey,
  type LoginText,
  type LoginEnvelopeBinding,
  AndroidPhoneActResultSchema,
  AndroidPhoneObservationResultSchema,
  AndroidPhoneInstalledAppsResultSchema,
  AndroidPhoneInstalledAppsParamsSchema,
  androidPhoneDefinitionId,
  ComputerUseActParamsSchema,
  ComputerUseWindowsParamsSchema,
  ComputerUseBindParamsSchema,
  ComputerUseDispatchObserveParamsSchema,
  ComputerUseWindowsResultSchema,
  ComputerUseBindResultSchema,
  type WindowInfo,
  ComputerUseActResultSchema,
  ComputerUseInstalledAppsResultSchema,
  ComputerUseObservationResultSchema,
  ComputerUseResolveAppResultSchema,
  computerAppMaxTimeoutMs,
  computerUseMaxSessionApps,
  computerUseMaxTimeoutMs,
  mintComputerUseSessionId,
  type PlaceIdentity,
  type AndroidPhoneInstalledAppsParams,
  type AndroidPhoneInstalledAppsResult,
  type AndroidPhoneObservation,
  type ComputerUseErrorCode,
  type ComputerUseHelperEvent,
  type ComputerUseInstalledAppsParams,
  type ComputerUseObservation,
  type ComputerUseOperation,
  type HostIntegrationsComputerUse,
  type ComputerUseResolvedApp,
  type ComputerUseSessionId,
  type ComputerUseSessionSummary,
} from "@opensteer/protocol";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { PasswordSignInService } from "../browser/password-sign-in-service.js";
import type { RevokedRunGrant } from "@opensteer/database";
import type {
  RunCapabilityBindingAuthorizer,
  RunCapabilityClaims,
} from "../agents/run-capability.js";
import type {
  ComputerAppHub,
  ComputerUseOutcome,
  ComputerUseValue,
} from "../computer-apps/computer-app-hub.js";

/** The definition a Mac's app sessions belong to. */
export const computerUseDefinitionId = "macos-app";

/**
 * The definition whose sessions hold a whole display rather than apps: an
 * Android phone's screen. It is the only one, and the frame says so by its
 * literal, so a display this Host does not know how to read is refused rather
 * than operated.
 */
export type DisplayDefinitionId = typeof androidPhoneDefinitionId;

/** The frame's `params`, which is JSON on a wire rather than any object. */
type ComputerUseFrameParams = HostIntegrationsComputerUse["params"];
const ComputerUseFrameParamsSchema = z.record(z.string(), z.json());
type ComputerReadOperation = "windows" | "bind" | "observe";

/**
 * The one deadline of each call, which the frame carries to the Runner and
 * the helper. It fits both the integrations frame's bound and the helper
 * protocol's, so no hop has to shorten it.
 */
export const computerUseDeadlineMs = {
  act: Math.min(60_000, computerAppMaxTimeoutMs, computerUseMaxTimeoutMs),
  observe: Math.min(30_000, computerAppMaxTimeoutMs, computerUseMaxTimeoutMs),
  windows: Math.min(30_000, computerAppMaxTimeoutMs, computerUseMaxTimeoutMs),
  bind: Math.min(30_000, computerAppMaxTimeoutMs, computerUseMaxTimeoutMs),
} as const;

/**
 * What a model is told to do about an app, or a phone, another task holds. It
 * is exclusive to one session, so asking again in a loop only burns the turn.
 */
export const computerUseBusyNextStep =
  "Continue with other work, or tell the person it is busy; do not retry in a loop.";

const machineTimeoutMs = 30_000;
const closeTimeoutMs = 15_000;
/**
 * How long a session may sit unused before it ends. A Mac's app sits beside
 * the person's own work and a task often pauses to think, so it keeps ten
 * minutes. A phone is held whole, so every other task waits on it; three
 * minutes is the longest a forgotten hold should cost them.
 */
const defaultIdleMs = { app: 10 * 60 * 1_000, display: 3 * 60 * 1_000 } as const;
const defaultSweepIntervalMs = 60 * 1_000;
/** How often one session's action count may move the machines list by itself. */
const defaultActivityNotifyIntervalMs = 2_000;
/** How long after its latest observe or act an agent still counts as acting in an app. */
export const computerUseActingWindowMs = 15_000;

/**
 * A refusal a person or a model can act on, in computer use's own vocabulary.
 *
 * Every expected condition is one of these rather than a transport fault: a
 * Mac that is offline or an app that needs a grant
 * are all ordinary answers, and the gateway turns each into a tool error with
 * this sentence rather than a harness error.
 */
export class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode | "offline";
  readonly retryable: boolean;

  constructor(code: ComputerUseErrorCode | "offline", message: string, retryable = false) {
    super(message);
    this.name = "ComputerUseError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Whether the authorizer refused a task's authority. Only a refusal is final;
 * anything else — a database that did not answer — is asked again by the next
 * call, as a Runner's grant refresh does, rather than ending a session whose
 * task may still hold every right to it.
 */
function authorityRefused(error: unknown): boolean {
  return (
    error instanceof OpensteerError && (error.code === "forbidden" || error.code === "not_found")
  );
}

function authorityEnded(): ComputerUseError {
  return new ComputerUseError("failed", "This task's computer-use authority has ended.");
}

function authorityUnchecked(): ComputerUseError {
  return new ComputerUseError(
    "failed",
    "This task's computer-use authority could not be checked just now, so nothing happened. Try again.",
    true,
  );
}

/**
 * A person's Stop held here until the ledger has it. It outlives the session
 * it ended: a Stop reported after the Host forgot that session, or one the
 * ledger could not take at once, is still retried on the minute sweep.
 */
interface HeldStop {
  /** The computer named the Run and waits to hear the Stop was recorded. */
  readonly acknowledge: boolean;
  /** Who the session belonged to; null for a session this Host already forgot. */
  readonly ownerUserId: UserId | null;
  readonly runId: RunId;
  readonly runnerId: RunnerId;
  readonly sessionId: ComputerUseSessionId;
}

/** The computer a call goes to, and whose it is. */
export interface ComputerUseMachine {
  readonly ownerUserId: UserId;
  readonly runnerId: RunnerId;
  readonly runnerName: string;
}

/**
 * What one call operates: one app on a Mac, or a phone's whole display. A
 * session holds apps or a display, never both, because a computer is one or
 * the other.
 */
export type ComputerUseScope =
  | { readonly app: ComputerAppIdentity; readonly kind: "app" }
  | { readonly definitionId: DisplayDefinitionId; readonly kind: "display" };

/** What the Host resolved from the connection before any frame is built. */
export type ComputerUseTarget = ComputerUseScope & {
  /** The lesser of the connection's ceiling and the calling grant's access. */
  readonly access: IntegrationAccess;
};

export type ComputerUseCallable = ComputerUseMachine & ComputerUseTarget;

/**
 * What a removal or a reduction took back on one computer, which every
 * session holding it must stop using: one app by its key, or a display.
 */
export type ComputerUseHolding =
  | { readonly appKey: string; readonly kind: "app" }
  | { readonly definitionId: string; readonly kind: "display" };

/**
 * The key a holder of this on one computer is indexed by. A bundle identifier
 * never contains a colon, so a display's key cannot be any app's.
 */
export function computerUseHolderKey(holding: ComputerUseHolding): string {
  return holding.kind === "app" ? holding.appKey : `display:${holding.definitionId}`;
}

function holdingOf(scope: ComputerUseScope): ComputerUseHolding {
  return scope.kind === "app"
    ? { appKey: computerAppIdentityKey(scope.app), kind: "app" }
    : { definitionId: scope.definitionId, kind: "display" };
}

/** The words a sentence about one scope uses: "the app" on "that Mac", "the phone" itself. */
function scopeWords(scope: Pick<ComputerUseScope, "kind">): {
  readonly computer: "Mac" | "phone";
  readonly subject: "app" | "phone";
} {
  return scope.kind === "app"
    ? { computer: "Mac", subject: "app" }
    : { computer: "phone", subject: "phone" };
}

/** A passive read of a session for whoever watches it, in its computer's own shape. */

/**
 * A session readied for one call by `prepare`, and spent by the send that
 * follows it or handed back with `release` when the call never sends.
 */
export interface ComputerUseLease {
  readonly sessionId: ComputerUseSessionId;
}

/** The authenticated attempt, including the executing Runner distinct from the target computer. */
export type ComputerUseContext = RunCapabilityClaims<string>;

/**
 * One frame that has left the Host, and the answer still to come.
 *
 * The two halves are separate because they belong in different turns: the send
 * inside the computer's admission turn beside the checks that authorized it,
 * and the wait outside it, where a slow app costs nobody else anything.
 */
export interface ComputerUseDispatch {
  readonly sessionId: ComputerUseSessionId;
  readonly settle: () => Promise<ComputerUseDispatchResult>;
  /** Receipts only: never revives a session or emits a late observation. */
  readonly audit?: Promise<readonly string[]>;
}

interface DispatchOutcome {
  readonly error: ComputerUseError | null;
  /**
   * Null for `observe`; for `act`, what each fully completed action did, in
   * order, so its length is the completed count.
   */
  readonly performed: readonly string[] | null;
  readonly windows?: readonly WindowInfo[];
  readonly window?: WindowInfo;
}

/** One answer, read with the schema of what the call operated. */
export type ComputerUseDispatchResult =
  | (DispatchOutcome & {
      readonly kind: "app";
      readonly observation: ComputerUseObservation | null;
    })
  | (DispatchOutcome & {
      readonly kind: "display";
      readonly observation: AndroidPhoneObservation | null;
    });

export interface ComputerUseMachineOption {
  readonly name: string;
  /** Whether that computer reports the definition ready right now. */
  readonly ready: boolean;
  readonly state: "offline" | "ready" | "permission-required" | "unavailable";
  readonly runnerId: RunnerId;
}

type MachineOwners = ReadonlyMap<RunnerId, { readonly effectiveOwner: UserId | null }>;

/**
 * The durable record of a person's Stops. A Run outlives a Host restart, so a
 * Stop does too: the next Host starts from `initial`, the Stops of every Run
 * that has not ended.
 */
export interface ComputerUseStopLedger {
  readonly initial: readonly { readonly runId: RunId; readonly runnerId: RunnerId }[];
  record(runId: RunId, runnerId: RunnerId): Promise<void>;
  clear(runId: RunId): Promise<void>;
}

/** Admission rechecks the surface grant in the same turn as session checks and send. */
type ComputerUseAdmission = <Result>(send: () => Promise<Result>) => Promise<Result>;

export interface ComputerUseServiceOptions {
  readonly passwords?: Pick<PasswordSignInService, "seal" | "validateLease">;
  readonly loginReceiver?: (runnerId: RunnerId) => LoginReceiverKey | null;
  readonly onSessionEnded?: (sessionId: ComputerUseSessionId) => void;
  readonly onAuthorityRevoked?: (
    context: Pick<ComputerUseContext, "runId" | "bindingGeneration">,
  ) => void;
  readonly onPlaceActivity?: (input: {
    ownerId: UserId;
    threadId: ThreadId;
    home: boolean;
    runId: RunId;
    generation: number;
    place: PlaceIdentity;
    title: string;
    at: number;
    ended: boolean;
  }) => void;
  readonly hub: Pick<
    ComputerAppHub,
    | "acknowledgeComputerUseStop"
    | "attached"
    | "machinesFor"
    | "sendComputerUse"
    | "withRunnerAdmission"
  >;
  /**
   * Every computer this person may own that serves computer apps, with the
   * platform its `integrations` module reports, which decides the definitions
   * it can serve.
   */
  readonly listMachines: (
    ownerUserId: UserId,
  ) => Promise<
    readonly { readonly name: string; readonly platform: ComputerAppPlatform; runnerId: RunnerId }[]
  >;
  readonly machineOwners: (runnerIds: readonly RunnerId[]) => Promise<MachineOwners>;
  readonly authorizer: RunCapabilityBindingAuthorizer;
  /** What a session opening, closing, gaining an app or acting makes stale. */
  readonly onSessionsChanged: () => void;
  /**
   * Which apps an agent is acting in now changed for some of a Mac owner's
   * sessions. It is that person's to know, and it changes too often to make
   * every client reread the machines list.
   */
  readonly onPresenceChanged?: (
    ownerUserId: UserId,
    sessions: readonly {
      readonly actingAppKeys: readonly string[];
      readonly actingDisplay?: boolean;
      readonly sessionId: ComputerUseSessionId;
    }[],
  ) => void;
  readonly actingWindowMs?: number;
  readonly resolveActor?: (
    runId: RunId,
    ownerId: UserId,
  ) => Promise<{ threadId: ThreadId; home: boolean } | null>;
  /**
   * The Thread's own name, for the card and for the sentence a second Run gets
   * when this Mac is in use. It is read as the person running the task, who is
   * the one whose Macs and Threads these are.
   */
  readonly threadTitle: (threadId: ThreadId, ownerUserId: UserId) => Promise<string | null>;
  /**
   * Settles the approvals nobody answered inside their week, on the same
   * minute tick as the idle sessions. Both are the same kind of housekeeping —
   * something the Host opened that nobody will ever finish — and a
   * `computer.app.access` Request whose approval expired would otherwise sit
   * pending forever with no sweep to end it.
   */
  readonly expireSetupRequests?: () => Promise<void>;
  /** Where a person's Stops are kept so that they outlive this Host. */
  readonly stops: ComputerUseStopLedger;
  readonly activityNotifyIntervalMs?: number;
  readonly idleMs?: { readonly app: number; readonly display: number };
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly sweepIntervalMs?: number;
}

interface Session {
  readonly cancellation: AbortController;
  readonly pending: Map<string, ComputerUseTarget>;
  actor: { threadId: ThreadId; home: boolean } | null;
  readonly authority: ComputerUseContext;
  actionCount: number;
  /** When the session's agent last observed or acted in each app, by app key. */
  readonly actedAt: Map<string, number>;
  actingTimer: NodeJS.Timeout | undefined;
  /** The acting apps its owner was last told about. */
  announcedActing: string;
  apps: ComputerAppIdentity[];
  readonly windows: Map<string, { ref: string; id: number; title: string }>;
  readonly windowRefs: Map<string, { ref: string; id: number; title: string }>;
  /**
   * The display this session holds, for a phone, from the moment its first
   * call reserved it; null for a Mac's session, which holds apps instead.
   */
  display: DisplayDefinitionId | null;
  /**
   * Whether the Mac has ever answered for this session.
   *
   * A record is minted before the first frame leaves, because the frame has to
   * carry the id the Mac will open the session under. Until something comes
   * back, nothing is running over there, so an unconfirmed record is never
   * shown to anybody and never makes the Mac look busy.
   */
  confirmed: boolean;
  /**
   * Whether a frame naming this session has ever left the Host.
   *
   * The Runner opens the session on the helper before the operation it was
   * asked for, so a frame that left may have opened one over there even when
   * the answer never came back or refused. Anything this side forgets after
   * that is told to close, or the Mac stays busy with a session nobody holds.
   */
  dispatched: boolean;
  /**
   * Calls readied or waiting for an answer. The idle sweep leaves a session
   * with either alone: ten quiet minutes means nobody is using it, and a call
   * in flight is somebody using it.
   */
  inFlight: number;
  lastActivityNotifiedAt: number;
  activityTimer: NodeJS.Timeout | undefined;
  lastUsedAt: number;
  readonly openedAt: string;
  readonly ownerUserId: UserId;
  readonly runId: RunId;
  readonly runnerId: RunnerId;
  readonly runnerName: string;
  readonly sessionId: ComputerUseSessionId;
  readonly threadId: ThreadId;
  threadTitle: string | null;
  /** Settles once the Thread's name has been read, which the first call waits for. */
  readonly titleReady: Promise<void>;
  readonly workspaceId: WorkspaceId;
}

function sessionKey(runId: RunId, bindingGeneration: number, runnerId: RunnerId): string {
  // UUIDs and the numeric generation cannot contain this separator.
  return `${runId}|${bindingGeneration}|${runnerId}`;
}

function stopKey(runId: RunId, runnerId: RunnerId): string {
  return `${runId}|${runnerId}`;
}

function stopReportKey(stop: Pick<HeldStop, "runId" | "runnerId" | "sessionId">): string {
  return `${stop.runId}|${stop.runnerId}|${stop.sessionId}`;
}

/**
 * The Host's sessions, and the only caller of the computer-use frame.
 *
 * A session is internal and in memory: it holds no durable state, is never
 * resumed, and after any loss the agent simply observes again. There is no
 * `session_open` operation — the first `observe` or `act` for a session id the
 * Mac has not seen opens it there from the frame's own `sessionId`, `app` and
 * `access` — so opening is nothing more than this side minting a record and
 * sending the call the agent asked for.
 *
 * Several Runs can use a Mac. The helper owns app exclusivity; this Host
 * indexes successful app claims so a busy answer can name the holding Thread.
 *
 * A phone is held whole, by one Run at a time, so this Host decides that
 * itself: the display is reserved for the Run inside the admission turn,
 * before its frame leaves, and a second Run is refused there by name. The
 * phone enforces the same rule on its side; this one is what lets the refusal
 * name the Thread holding it, and keeps a second Run's frame from ever
 * reaching a phone that is busy.
 */
export class ComputerUseService {
  readonly #activityNotifyIntervalMs: number;
  readonly #hub: ComputerUseServiceOptions["hub"];
  readonly #idleMs: { readonly app: number; readonly display: number };
  readonly #machineOwners: ComputerUseServiceOptions["machineOwners"];
  readonly #now: () => number;
  readonly #onSessionsChanged: () => void;
  readonly #onAuthorityRevoked: ComputerUseServiceOptions["onAuthorityRevoked"];
  readonly #onSessionEnded: NonNullable<ComputerUseServiceOptions["onSessionEnded"]>;
  readonly #onPresenceChanged: NonNullable<ComputerUseServiceOptions["onPresenceChanged"]>;
  readonly #actingWindowMs: number;
  readonly #authorizer: RunCapabilityBindingAuthorizer;
  readonly #sessions = new Map<string, Session>();
  /** Each lease names its session, and is spent at most once. */
  readonly #leases = new WeakMap<
    ComputerUseLease,
    { readonly session: Session; readonly authority: ComputerUseContext; spent: boolean }
  >();
  /**
   * The session holding each app, or the display, on each computer, by
   * `computerUseHolderKey`. An app is entered once its computer confirmed the
   * claim; a display is entered when it is reserved, before the frame leaves.
   */
  readonly #appOwners = new Map<RunnerId, Map<string, Session>>();
  readonly #listMachines: ComputerUseServiceOptions["listMachines"];
  /**
   * A person's Stop applies to this Run/Mac pair until that Run ends. It holds
   * here the moment it is pressed, and the ledger keeps it for the next Host.
   */
  readonly #stopped: Set<string>;
  readonly #stops: ComputerUseStopLedger;
  /** A Runner chooses reported IDs; only an exact Run/Runner/session tuple may share a write. */
  readonly #unrecordedStops = new Map<string, HeldStop>();
  readonly #stopWrites = new Map<string, Promise<void>>();
  /** Sessions the Host has let go whose close the Mac has not yet answered. */
  readonly #undeliveredCloses = new Set<Session>();
  readonly #onPlaceActivity: ComputerUseServiceOptions["onPlaceActivity"];
  readonly #resolveActor: ComputerUseServiceOptions["resolveActor"];
  readonly #threadTitle: ComputerUseServiceOptions["threadTitle"];
  readonly #expireSetupRequests: (() => Promise<void>) | null;
  readonly #onError: (error: unknown) => void;
  readonly #sweep: NodeJS.Timeout;
  readonly #passwords: ComputerUseServiceOptions["passwords"];
  readonly #loginReceiver: ComputerUseServiceOptions["loginReceiver"];
  #closed = false;

  constructor(options: ComputerUseServiceOptions) {
    this.#onAuthorityRevoked = options.onAuthorityRevoked;
    this.#passwords = options.passwords;
    this.#loginReceiver = options.loginReceiver;
    this.#activityNotifyIntervalMs =
      options.activityNotifyIntervalMs ?? defaultActivityNotifyIntervalMs;
    this.#hub = options.hub;
    this.#listMachines = options.listMachines;
    this.#idleMs = options.idleMs ?? defaultIdleMs;
    this.#machineOwners = options.machineOwners;
    this.#now = options.now ?? (() => Date.now());
    this.#onSessionsChanged = options.onSessionsChanged;
    this.#onSessionEnded = options.onSessionEnded ?? (() => undefined);
    this.#onPresenceChanged = options.onPresenceChanged ?? (() => undefined);
    this.#actingWindowMs = options.actingWindowMs ?? computerUseActingWindowMs;
    this.#authorizer = options.authorizer;
    this.#stops = options.stops;
    this.#stopped = new Set(
      options.stops.initial.map((stop) => stopKey(stop.runId, stop.runnerId)),
    );
    this.#onPlaceActivity = options.onPlaceActivity;
    this.#resolveActor = options.resolveActor;
    this.#threadTitle = options.threadTitle;
    this.#expireSetupRequests = options.expireSetupRequests ?? null;
    this.#onError = options.onError ?? (() => undefined);
    this.#sweep = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ?? defaultSweepIntervalMs,
    );
    this.#sweep.unref();
  }

  // ---- calls -----------------------------------------------------------

  /**
   * Readies this attempt's session on one computer for a call, outside any admission
   * turn.
   *
   * Everything here that waits on the database — the Thread's name, and
   * whether the attempt's grant is still active — happens before the computer's
   * admission turn, so no other call to that Mac queues behind these reads.
   * The session record is minted before the first await, so a Run that ends
   * meanwhile finds it and the dispatch that follows refuses on it.
   */
  async prepare(
    machine: ComputerUseMachine,
    context: ComputerUseContext,
  ): Promise<ComputerUseLease> {
    if (this.#closed) throw new ComputerUseError("failed", "Opensteer is shutting down.", true);
    if (this.#stopped.has(stopKey(context.runId, machine.runnerId)))
      throw stoppedByUser(machine.runnerName);
    const session = this.#session(machine, context);
    session.inFlight += 1;
    const lease: ComputerUseLease = { sessionId: session.sessionId };
    this.#leases.set(lease, { session, authority: context, spent: false });
    try {
      // The name is read once per session and the first call waits for it, so
      // a second Run told the Mac is busy can be told whose Thread has it.
      await session.titleReady;
      await this.#authorizeSession(session, context);
      if (!this.#holds(session))
        throw new ComputerUseError(
          "failed",
          `Computer use for this task on ${machine.runnerName} ended before this call was sent, so nothing happened.`,
        );
    } catch (error) {
      this.release(lease);
      throw error;
    }
    return lease;
  }

  /**
   * Hands back a lease whose call never sent, which is what the caller does
   * when its own checks refuse the call after `prepare`. A session no frame
   * ever left for, and that no other call is about to use, was never a
   * session anywhere, so it goes with it.
   */
  release(lease: ComputerUseLease): void {
    const entry = this.#leases.get(lease);
    if (!entry || entry.spent) return;
    entry.spent = true;
    const session = entry.session;
    session.inFlight -= 1;
    if (!session.dispatched && session.inFlight === 0) this.#forget(session);
  }

  #spend(lease: ComputerUseLease): {
    readonly session: Session;
    readonly authority: ComputerUseContext;
  } {
    const entry = this.#leases.get(lease);
    if (!entry || entry.spent) throw new Error("A computer-use lease is sent at most once.");
    entry.spent = true;
    return entry;
  }

  /**
   * Sends one `observe`, returning once the frame has left the Host.
   *
   * Call this inside the computer's admission turn — the same turn that
   * re-read the connection and the grant — and await `settle` outside it. The
   * check and the frame have to share one turn, or a removal committed between
   * them would be a frame carrying an app nobody may operate any more; and the
   * wait has to be outside it, or one slow app would hold up the disconnect
   * trying to stop it.
   */
  sendObserve(
    lease: ComputerUseLease,
    target: ComputerUseTarget,
    includeScreenshot: boolean,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<ComputerUseDispatch> {
    return this.#dispatch(
      lease,
      target,
      "observe",
      { includeScreenshot },
      signal,
      0,
      undefined,
      deadline,
    );
  }

  sendWindowOperation(
    lease: ComputerUseLease,
    target: ComputerUseTarget,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<ComputerUseDispatch> {
    if (
      target.kind !== "app" ||
      (operation !== "windows" && operation !== "bind" && operation !== "observe")
    )
      throw new ComputerUseError("unsupported", "That computer operation is not supported.");
    const schema =
      operation === "windows"
        ? ComputerUseWindowsParamsSchema
        : operation === "bind"
          ? ComputerUseBindParamsSchema
          : ComputerUseDispatchObserveParamsSchema;
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      this.release(lease);
      throw new ComputerUseError("failed", `Invalid ${operation} arguments.`);
    }
    return this.#dispatch(
      lease,
      target,
      operation,
      ComputerUseFrameParamsSchema.parse(parsed.data),
      signal,
      0,
      undefined,
      deadline,
    );
  }
  /**
   * Sends one batch, validated here before it can reach the computer.
   * Call outside Runner admission: `admit` rechecks surface access around
   * session preflight and dispatch, while vault sealing waits outside it.
   *
   * The catalog publishes the same shape to the model, but the schema in
   * `@opensteer/protocol` for what the call operates — a Mac app's actions or
   * a phone's — is what is enforced: a point the helper could not place inside
   * the target window, an index past the elements one observation may name,
   * or a batch that would outlast its deadline is refused on this side rather
   * than posted.
   */
  async sendAct(
    lease: ComputerUseLease,
    target: ComputerUseTarget,
    params: unknown,
    includeScreenshot: boolean,
    signal?: AbortSignal,
    admit?: ComputerUseAdmission,
    deadline?: number,
  ): Promise<ComputerUseDispatch> {
    const parsed =
      target.kind === "app"
        ? ComputerUseActParamsSchema.safeParse(params)
        : AndroidPhoneActParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.release(lease);
      throw new ComputerUseError("failed", unusableActions(parsed.error, target));
    }
    return this.#dispatch(
      lease,
      target,
      "act",
      ComputerUseFrameParamsSchema.parse({
        ...parsed.data,
        ...(target.kind === "display" ? { includeScreenshot } : {}),
      }),
      signal,
      parsed.data.actions.length,
      admit,
      deadline,
    );
  }

  async #dispatch(
    lease: ComputerUseLease,
    target: ComputerUseTarget,
    operation: "act" | ComputerReadOperation,
    params: ComputerUseFrameParams,
    signal: AbortSignal | undefined,
    requested = 0,
    admit: ComputerUseAdmission = async (send) => send(),
    deadline?: number,
  ): Promise<ComputerUseDispatch> {
    const { session, authority } = this.#spend(lease);
    const key = sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId);
    let addedApp = false;
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`cai:${randomUUID()}`);
    const saved = new Map<number, LoginText>();
    if (operation === "act" && Array.isArray(params.actions)) {
      for (const [index, action] of params.actions.entries()) {
        if (
          typeof action !== "object" ||
          action === null ||
          Array.isArray(action) ||
          action.type !== "type" ||
          typeof action.text !== "object"
        )
          continue;
        saved.set(index, LoginTextSchema.parse(action.text));
      }
    }
    let sent;
    let timeoutMs: number = Math.max(
      1,
      Math.min(
        computerUseDeadlineMs[operation],
        deadline === undefined ? Infinity : deadline - this.#now(),
      ),
    );
    let checkSaved: () => void = () => undefined;
    let savedDeadline: number | undefined;
    const checkSession = () => {
      if (this.#closed) throw new ComputerUseError("failed", "Opensteer is shutting down.", true);
      if (signal?.aborted || (deadline !== undefined && this.#now() >= deadline))
        throw new ComputerUseError("failed", "Computer use was cancelled. Nothing was performed.");
      if (this.#stopped.has(stopKey(session.runId, session.runnerId)))
        throw stoppedByUser(session.runnerName);
      if (this.#sessions.get(key) !== session)
        throw sessionEndedBeforeSend(session.runnerName, target);
    };
    try {
      if (saved.size > 0) {
        // Revocation must find a pending batch even before its first dispatch
        // has made this session a holder of the surface.
        await admit(async () => {
          await this.#authorizeSession(session, authority);
          checkSession();
          session.pending.set(requestId, target);
        });
        const receiver = this.#loginReceiver?.(session.runnerId);
        if (!receiver || !this.#passwords)
          throw new ComputerUseError(
            "unsupported",
            "Update Opensteer on the phone or Mac and its Runner to type saved logins. Nothing was performed.",
          );
        const passwords = this.#passwords;
        const actDeadline = Math.min(
          deadline ?? Infinity,
          this.#now() + Math.min(loginEnvelopeMaxLifetimeMs, computerUseDeadlineMs.act),
        );
        savedDeadline = actDeadline;
        const cancellation = AbortSignal.any([
          session.cancellation.signal,
          ...(signal ? [signal] : []),
        ]);
        const check = () => {
          if (signal?.aborted || this.#now() >= actDeadline)
            throw new ComputerUseError(
              "failed",
              "Saved login typing expired or was cancelled. Nothing was performed.",
            );
          if (this.#closed || this.#sessions.get(key) !== session)
            throw sessionEndedBeforeSend(session.runnerName, target);
          if (this.#stopped.has(stopKey(session.runId, session.runnerId)))
            throw stoppedByUser(session.runnerName);
          if (
            canonicalJson(this.#loginReceiver?.(session.runnerId) ?? null) !==
            canonicalJson(receiver)
          )
            throw new ComputerUseError(
              "unsupported",
              "The saved-login receiver changed. Update or reconnect Opensteer and observe again. Nothing was performed.",
            );
          for (const text of saved.values())
            if (!passwords.validateLease({ ...text, workspaceId: session.workspaceId }))
              throw new ComputerUseError(
                "failed",
                "This saved login ended or belongs to another Workspace. Call sign_in again. Nothing was performed.",
              );
        };
        check();
        const actions = params.actions;
        if (!Array.isArray(actions)) throw new Error("An act has actions");
        const sealedActions = [...actions];
        const expiries: number[] = [];
        for (const [actionIndex, text] of saved) {
          check();
          const binding: LoginEnvelopeBinding = {
            version: 1,
            connectionId: receiver.connectionId,
            connectionGeneration: receiver.connectionGeneration,
            runId: session.runId,
            sessionId: session.sessionId,
            actId: requestId,
            actionIndex,
            field: text.field,
            expiresAt: actDeadline,
          };
          let result;
          try {
            result = await withTimeout(
              passwords.seal({
                ...text,
                workspaceId: session.workspaceId,
                receiver,
                binding,
              }),
              Math.max(1, actDeadline - this.#now()),
              {
                signal: cancellation,
                timeoutError: () => new Error("Saved login preparation expired."),
              },
            );
          } catch {
            throw new ComputerUseError(
              "failed",
              "The saved login could not be prepared. Nothing was performed. Call sign_in again.",
            );
          }
          check();
          if (result.status !== "sealed")
            throw new ComputerUseError(
              "failed",
              "The saved login ended or could not be prepared. Nothing was performed. Call sign_in again.",
            );
          const received = result.envelope.binding;
          if (
            received.expiresAt > binding.expiresAt ||
            received.expiresAt <= this.#now() ||
            canonicalJson({ ...received, expiresAt: binding.expiresAt }) !== canonicalJson(binding)
          )
            throw new ComputerUseError(
              "failed",
              "The saved login did not match this action. Nothing was performed.",
            );
          expiries.push(received.expiresAt);
          const action = sealedActions[actionIndex];
          if (typeof action !== "object" || action === null || Array.isArray(action))
            throw new Error("A saved action is an object");
          sealedActions[actionIndex] = { ...action, text: { sealed: result.envelope } };
        }
        checkSaved = () => {
          check();
          if (expiries.some((expiry) => this.#now() >= expiry))
            throw new ComputerUseError(
              "failed",
              "Saved login typing expired. Nothing was performed.",
            );
        };
        const schema =
          target.kind === "app"
            ? ComputerUseDispatchActParamsSchema
            : AndroidPhoneDispatchActParamsSchema;
        timeoutMs = Math.max(1, actDeadline - this.#now());
        params = ComputerUseFrameParamsSchema.parse(
          schema.parse({
            ...params,
            actions: sealedActions,
            loginContext: { runId: session.runId, actId: requestId },
          }),
        );
      }
      sent = await admit(async () => {
        await this.#authorizeSession(session, authority);
        checkSession();
        checkSaved();
        if (target.kind === "app") addedApp = this.#rememberApp(session, target.app);
        else this.#reserveDisplay(session, target.definitionId);
        if (savedDeadline !== undefined) timeoutMs = Math.max(1, savedDeadline - this.#now());
        session.lastUsedAt = this.#now();
        session.dispatched = true;
        if (target.kind === "app") this.#noteActing(session, computerAppIdentityKey(target.app));

        return this.#hub.sendComputerUse({
          access: target.access,
          app: target.kind === "app" ? target.app : null,
          // Only a display names its definition: a frame to a Mac stays the
          // frame every Mac already reads.
          ...(target.kind === "display" ? { definitionId: target.definitionId } : {}),
          operation,
          params,
          requestId,
          runId: session.runId,
          runnerId: session.runnerId,
          sessionId: session.sessionId,
          signal: AbortSignal.any([session.cancellation.signal, ...(signal ? [signal] : [])]),
          threadTitle: session.threadTitle,
          timeoutMs,
        });
      });
    } catch (error) {
      session.inFlight -= 1;
      if (!session.dispatched && session.inFlight === 0) this.#forget(session);
      throw error;
    } finally {
      session.pending.delete(requestId);
    }
    const sanitizeReceipts = (performed: readonly string[]) =>
      performed.map((receipt, index) => {
        const text = saved.get(index);
        return text ? `Typed saved ${text.field}` : receipt;
      });
    const audit = (sent.audit ?? sent.outcome).then((outcome) => {
      if (outcome.kind !== "ok") return [];
      return sanitizeReceipts(
        parseComputerUseResult(target, operation, outcome.value).performed ?? [],
      );
    });
    // A malformed late result must remain an unknown audit, not an unhandled rejection.
    const auditReceipts = audit.catch(() => []);
    return {
      sessionId: session.sessionId,
      audit: auditReceipts,
      settle: async () => {
        let outcome;
        try {
          outcome = await sent.outcome;
        } finally {
          session.inFlight -= 1;
        }
        let result = this.#settle(session, target, operation, addedApp, outcome, params);
        if (saved.size > 0 && result.performed)
          result = {
            ...result,
            performed: sanitizeReceipts(result.performed),
          };
        if (
          !result.error &&
          target.kind === "display" &&
          operation === "act" &&
          (result.performed?.length ?? 0) > 0 &&
          this.#sessions.get(key) === session
        ) {
          this.#noteActing(session, target.definitionId);
          this.#publishPlaceActivity(session, target.definitionId, false);
        }
        if (
          !result.error &&
          target.kind === "app" &&
          this.#sessions.get(key) === session &&
          session.apps.some(
            (app) => computerAppIdentityKey(app) === computerAppIdentityKey(target.app),
          )
        ) {
          this.#noteActing(session, computerAppIdentityKey(target.app));
          this.#publishPlaceActivity(session, computerAppIdentityKey(target.app), false);
        }
        if (requested > 0 && this.#sessions.get(key) === session) {
          session.actionCount += Math.min(requested, result.performed?.length ?? 0);
          this.#notifyActivity(session);
        }
        return result;
      },
    };
  }

  #settle(
    session: Session,
    target: ComputerUseTarget,
    operation: "act" | ComputerReadOperation,
    addedApp: boolean,
    outcome: ComputerUseOutcome,
    params: ComputerUseFrameParams,
  ): ComputerUseDispatchResult {
    const key = sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId);
    const words = scopeWords(target);
    const releaseApp = () => {
      if (!addedApp || target.kind !== "app") return;
      const appKey = computerAppIdentityKey(target.app);
      this.#publishPlaceActivity(session, appKey, true);
      session.actedAt.delete(appKey);
      session.windows.delete(appKey);
      session.apps = session.apps.filter((app) => computerAppIdentityKey(app) !== appKey);
    };
    if (outcome.kind === "error") {
      if (outcome.abandoned) {
        if (this.#stopped.has(stopKey(session.runId, session.runnerId)))
          throw stoppedByUser(session.runnerName);
        // The Host gave up on this answer — the caller went away, or the
        // deadline and its grace passed — so whatever the Mac is still doing
        // for it belongs to nobody. Only this session ends; the Run may use
        // the Mac again, which a Stop would not allow.
        if (this.#sessions.get(key) === session) {
          this.#forget(session);
          void this.#deliverClose(session);
        }
        throw new ComputerUseError(
          operation === "act" ? "outcome-unknown" : "failed",
          operation === "act"
            ? outcome.message
            : `${outcome.message} Observe the ${words.subject} again before deciding what to do next.`,
          operation !== "act",
        );
      }
      if (outcome.code === "busy") releaseApp();
      this.#forgetAfter(session, outcome.code);
      throw new ComputerUseError(
        outcome.code,
        this.#sentence(session, target, outcome.code, outcome.message),
        outcome.retryable,
      );
    }
    if (this.#sessions.get(key) !== session) {
      if (this.#stopped.has(stopKey(session.runId, session.runnerId)))
        throw stoppedByUser(session.runnerName);
      // The answer arrived after the session ended here, so its observation
      // may already be stale and an act may or may not have happened.
      // The gateway adds the outcome-unknown instructions to an act.
      throw new ComputerUseError(
        operation === "act" ? "outcome-unknown" : "failed",
        `Computer use for this task on ${session.runnerName} ended before this answer arrived.${
          operation === "act"
            ? ""
            : ` Observe the ${words.subject} again before deciding what to do next.`
        }`,
      );
    }
    let result: ComputerUseDispatchResult;
    try {
      result = parseComputerUseResult(target, operation, outcome.value);
    } catch (error) {
      this.#forgetAfter(session, "failed");
      throw error;
    }
    if (result.error?.code === "busy") {
      releaseApp();
      this.#forgetAfter(session, "busy");
    }
    if (result.error) {
      result = {
        ...result,
        error: new ComputerUseError(
          result.error.code,
          this.#sentence(session, target, result.error.code, result.error.message),
          result.error.retryable,
        ),
      };
    }
    if (result.error?.code === "busy") return result;
    let windowChanged = false;
    if (target.kind === "app") {
      const appKey = computerAppIdentityKey(target.app);
      for (const item of result.windows ?? []) session.windowRefs.set(item.ref, item);
      const window =
        result.window ??
        (result.kind === "app" ? result.observation?.window : undefined) ??
        result.windows?.find((window) => window.current) ??
        (operation === "act" && typeof params.window === "string"
          ? session.windowRefs.get(params.window)
          : undefined);
      if (window) {
        const previous = session.windows.get(appKey);
        session.windows.set(appKey, { ref: window.ref, id: window.id, title: window.title });
        session.windowRefs.set(window.ref, { ref: window.ref, id: window.id, title: window.title });
        windowChanged = previous?.ref !== window.ref || previous.title !== window.title;
      } else if (operation === "act" && typeof params.window === "string") {
        // The ref has been bound already. It stays current across input calls.
        const previous = session.windows.get(appKey);
        if (previous?.ref !== params.window) session.windows.delete(appKey);
      }
    }
    const wasUnconfirmed = !session.confirmed;
    session.confirmed = true;
    session.lastUsedAt = this.#now();
    if (wasUnconfirmed || addedApp || windowChanged) this.#onSessionsChanged();
    const owners = this.#appOwners.get(session.runnerId) ?? new Map<string, Session>();
    owners.set(computerUseHolderKey(holdingOf(target)), session);
    this.#appOwners.set(session.runnerId, owners);
    if (result.error) this.#forgetAfter(session, result.error.code);
    return result;
  }

  /**
   * The attempt's session on this computer, minted synchronously if it has none.
   *
   * Nothing is awaited before the record is in the map: two calls racing for
   * one Run's first use of a Mac would otherwise mint two ids and open two
   * sessions, and a Run that ended during its first call would leave a record
   * nothing could find to close.
   */
  #session(machine: ComputerUseMachine, context: ComputerUseContext): Session {
    const key = sessionKey(context.runId, context.bindingGeneration, machine.runnerId);
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const now = this.#now();
    const session: Session = {
      cancellation: new AbortController(),
      pending: new Map(),
      actor: null,
      actedAt: new Map(),
      actingTimer: undefined,
      announcedActing: "",
      authority: context,
      actionCount: 0,
      activityTimer: undefined,
      apps: [],
      windows: new Map(),
      windowRefs: new Map(),
      confirmed: false,
      display: null,
      dispatched: false,
      inFlight: 0,
      lastActivityNotifiedAt: 0,
      lastUsedAt: now,
      openedAt: new Date(now).toISOString(),
      ownerUserId: machine.ownerUserId,
      runId: context.runId,
      runnerId: machine.runnerId,
      runnerName: machine.runnerName,
      sessionId: mintComputerUseSessionId(),
      threadId: context.threadId,
      threadTitle: null,
      titleReady: this.#threadTitle(context.threadId, machine.ownerUserId)
        .then(
          async (title) => {
            session.threadTitle = title;
            const actor = await this.#resolveActor?.(context.runId, machine.ownerUserId);
            session.actor = actor ? { threadId: actor.threadId, home: actor.home } : null;
          },
          () => undefined,
        )
        .catch(() => undefined),
      workspaceId: context.workspaceId,
    };
    this.#sessions.set(key, session);
    return session;
  }

  /** Every later call adds the app when it is new to the session. */
  #rememberApp(session: Session, app: ComputerAppIdentity): boolean {
    if (session.display !== null) throw mixedScopes(session.runnerName);
    const key = computerAppIdentityKey(app);
    if (session.apps.some((held) => computerAppIdentityKey(held) === key)) return false;
    if (session.apps.length >= computerUseMaxSessionApps) {
      throw new ComputerUseError(
        "unsupported",
        `This task is already using ${session.apps.length} apps on ${session.runnerName}, which is as many as one session holds.`,
      );
    }
    session.apps.push(app);
    return true;
  }

  /**
   * Holds the display for this session from before its frame leaves.
   *
   * It runs inside the computer's admission turn, so two Runs can never both
   * find it free. A session that never came to hold anything — its first
   * frame refused, never sent, or answered by nobody — is forgotten, and
   * forgetting it lets the display go with it.
   */
  #reserveDisplay(session: Session, definitionId: DisplayDefinitionId): void {
    if (session.apps.length > 0) throw mixedScopes(session.runnerName);
    const key = computerUseHolderKey({ definitionId, kind: "display" });
    const owners = this.#appOwners.get(session.runnerId) ?? new Map<string, Session>();
    const holder = owners.get(key);
    if (holder && holder !== session) {
      const title = holder.threadTitle;
      throw new ComputerUseError(
        "busy",
        `${session.runnerName} is already being used by another task.${title ? ` (Thread: ${title})` : ""} ${computerUseBusyNextStep}`,
        true,
      );
    }
    session.display = definitionId;
    owners.set(key, session);
    this.#appOwners.set(session.runnerId, owners);
  }

  /**
   * A refusal that leaves nothing running over there takes the record with it.
   *
   * A record the Mac never answered for was never a session here, so it goes
   * on any refusal. A confirmed one survives everything but the refusals that
   * say the session itself is over — `stopped-by-user`, a session the helper
   * no longer holds, or an incompatible helper version.
   *
   * Forgetting is not the same as the Mac forgetting: the Runner opens the
   * session before the operation, so a frame that left may have opened one
   * over there even though this side is giving up on it. That one is told to
   * close, or the Mac is busy with a session nobody will ever use again.
   */
  #forgetAfter(session: Session, code: ComputerUseErrorCode | "offline"): void {
    const over =
      code === "stopped-by-user" || code === "no-session" || code === "incompatible-version";
    if (session.confirmed && !over) return;
    // A Mac refuses with `stopped-by-user` only once its person stopped that
    // session. A phone also refuses so while it is paused or its owner is
    // answering a prompt, which stop no task for good; it reports a person's
    // Stop as `session.stopped`, and that event holds the Stop.
    if (code === "stopped-by-user" && session.display === null) {
      void this.#holdStop(session).catch(this.#onError);
    }
    const mayBeOpen = session.dispatched && !noSessionOpened(code);
    this.#forget(session);
    if (mayBeOpen) void this.#deliverClose(session);
  }

  #forget(session: Session): void {
    const key = sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId);
    if (this.#sessions.get(key) !== session) return;
    this.#sessions.delete(key);
    session.cancellation.abort();
    this.#onSessionEnded(session.sessionId);
    for (const app of session.apps)
      this.#publishPlaceActivity(session, computerAppIdentityKey(app), true);
    if (session.display) this.#publishPlaceActivity(session, session.display, true);
    const owners = this.#appOwners.get(session.runnerId);
    for (const [app, holder] of owners ?? []) if (holder === session) owners?.delete(app);
    if (owners?.size === 0) this.#appOwners.delete(session.runnerId);
    if (session.activityTimer) clearTimeout(session.activityTimer);
    if (session.actingTimer) clearTimeout(session.actingTimer);
    if (session.confirmed) this.#onSessionsChanged();
  }

  /**
   * The computer's own sentence, plus the Thread when this Host is the one
   * holding the session. `busy` names no other Deployment's Thread, because
   * only the Host that opened a session knows what it is for.
   */
  #sentence(
    session: Session,
    scope: ComputerUseScope,
    code: ComputerUseErrorCode | "offline",
    message: string,
  ): string {
    if (code === "no-session") {
      // The computer no longer holds this session — it was stopped, swept or
      // lost with its connection — so nothing of this call ran there.
      return `Computer use for this task on ${session.runnerName} ended before this call ran. Observe the ${scopeWords(scope).subject} again to continue.`;
    }
    if (code !== "busy") return message;
    const holder = this.#appOwners
      .get(session.runnerId)
      ?.get(computerUseHolderKey(holdingOf(scope)));
    const title = holder?.runId !== session.runId ? holder?.threadTitle : null;
    return `${title ? `${message} (Thread: ${title})` : message} ${computerUseBusyNextStep}`;
  }

  // ---- Mac operations --------------------------------------------------

  /** Owned inventory needs no screen-control grant or session, including while paused. */
  async installedApps(
    runnerId: RunnerId,
    actorUserId: UserId,
    params: ComputerUseInstalledAppsParams,
  ): Promise<z.infer<typeof ComputerUseInstalledAppsResultSchema>>;
  async installedApps(
    runnerId: RunnerId,
    actorUserId: UserId,
    params: AndroidPhoneInstalledAppsParams,
    definitionId: DisplayDefinitionId,
  ): Promise<AndroidPhoneInstalledAppsResult>;
  async installedApps(
    runnerId: RunnerId,
    actorUserId: UserId,
    params: ComputerUseInstalledAppsParams | AndroidPhoneInstalledAppsParams,
    definitionId?: DisplayDefinitionId,
  ): Promise<
    z.infer<typeof ComputerUseInstalledAppsResultSchema> | AndroidPhoneInstalledAppsResult
  > {
    const parsed =
      definitionId === androidPhoneDefinitionId
        ? AndroidPhoneInstalledAppsParamsSchema.parse(params)
        : params;
    const outcome = await this.#send(
      {
        access: null,
        app: null,
        operation: "installed_apps",
        params: parsed,
        ...(definitionId ? { definitionId } : {}),
        runnerId,
        timeoutMs: machineTimeoutMs,
      },
      actorUserId,
    );
    if (outcome.kind === "error")
      throw new ComputerUseError(outcome.code, outcome.message, outcome.retryable);
    return definitionId === androidPhoneDefinitionId
      ? AndroidPhoneInstalledAppsResultSchema.parse(outcome.value)
      : ComputerUseInstalledAppsResultSchema.parse(outcome.value);
  }

  /**
   * Name, path, or bundle identifier into the identity the approval pins.
   *
   * Only the Mac can do this, which is why a task asking for an app names one
   * in whatever words it has and never an identity it invented.
   */
  async resolveApp(input: {
    readonly app: string;
    readonly runId?: RunId;
    readonly runnerId: RunnerId;
  }): Promise<ComputerUseResolvedApp> {
    const outcome = await this.#send({
      access: null,
      app: null,
      operation: "resolve_app",
      params: { app: input.app },
      runnerId: input.runnerId,
      ...(input.runId ? { runId: input.runId } : {}),
      timeoutMs: machineTimeoutMs,
    });
    if (outcome.kind === "error") {
      throw new ComputerUseError(outcome.code, outcome.message, outcome.retryable);
    }
    return ComputerUseResolveAppResultSchema.parse(outcome.value).app;
  }

  /**
   * Every computer this person owns that serves one session definition — the
   * Macs for `macos-app`, the phones for `android-phone` — by the platforms
   * the catalog says that definition runs on, and how ready each is now.
   */
  async eligibleMachines(
    ownerUserId: UserId,
    definitionId: typeof computerUseDefinitionId | DisplayDefinitionId,
  ): Promise<readonly ComputerUseMachineOption[]> {
    const inventory = await this.eligibleInventory(ownerUserId);
    return definitionId === androidPhoneDefinitionId ? inventory.phones : inventory.machines;
  }

  async eligibleInventory(ownerUserId: UserId): Promise<{
    readonly machines: readonly ComputerUseMachineOption[];
    readonly phones: readonly ComputerUseMachineOption[];
  }> {
    const machines = await this.#listMachines(ownerUserId);
    const owners = await this.#machineOwners(machines.map((machine) => machine.runnerId));
    const project = (
      definitionId: typeof computerUseDefinitionId | DisplayDefinitionId,
    ): ComputerUseMachineOption[] => {
      const platforms = sessionDefinitionPlatforms(definitionId);
      const live = new Map(
        this.#hub.machinesFor(definitionId).map((machine) => [machine.runnerId, machine]),
      );
      return machines
        .filter(
          (machine) =>
            platforms.has(machine.platform) &&
            owners.get(machine.runnerId)?.effectiveOwner === ownerUserId,
        )
        .map(({ name, runnerId }) => {
          const status = live.get(runnerId)?.status;
          const ready =
            !!status?.operations.length &&
            status.operations.every((operation) => operation.state === "ready");
          return {
            name,
            runnerId,
            ready,
            state: !this.#hub.attached(runnerId)
              ? "offline"
              : ready
                ? "ready"
                : status?.operations.some((operation) => operation.state === "permission-required")
                  ? "permission-required"
                  : "unavailable",
          };
        });
    };
    return {
      machines: project(computerUseDefinitionId),
      phones: project(androidPhoneDefinitionId),
    };
  }

  threadTitle(threadId: ThreadId, ownerUserId: UserId): Promise<string | null> {
    return this.#threadTitle(threadId, ownerUserId);
  }

  /** The Run holding each app, or the display, on this computer, keyed by `computerUseHolderKey`. */
  holders(
    runnerId: RunnerId,
  ): ReadonlyMap<string, { readonly runId: RunId; readonly threadTitle: string | null }> {
    return new Map(
      [...(this.#appOwners.get(runnerId) ?? [])].map(([app, { runId, threadTitle }]) => [
        app,
        { runId, threadTitle },
      ]),
    );
  }

  // ---- ending ----------------------------------------------------------

  /** Ends this exact record without requiring authority that cleanup has already withdrawn. */
  async #closeSession(session: Session): Promise<void> {
    this.#forget(session);
    await this.#deliverClose(session);
  }

  /** Agent release is attempt-authorized; its cleanup never resolves another generation. */
  async releaseSession(authority: ComputerUseContext, runnerId: RunnerId): Promise<boolean> {
    const session = this.#sessions.get(
      sessionKey(authority.runId, authority.bindingGeneration, runnerId),
    );
    if (session) await this.#authorizeSession(session, authority);
    else {
      try {
        await this.#authorizer.assertActiveGrant(authority);
      } catch (error) {
        throw authorityRefused(error) ? authorityEnded() : authorityUnchecked();
      }
    }
    if (!session) return false;
    if (!this.#holds(session)) return false;
    this.#forget(session);
    // Do not wait for an admission turn from inside the turn releasing it.
    void this.#deliverClose(session);
    return true;
  }

  /** A revoked attempt ends only its sessions, without recording or clearing owner Stop. */
  endGrantSessions(grants: readonly Pick<RevokedRunGrant, "runId" | "bindingGeneration">[]): void {
    for (const session of this.#snapshot()) {
      if (
        grants.some(
          (grant) =>
            grant.runId === session.runId &&
            grant.bindingGeneration === session.authority.bindingGeneration,
        )
      ) {
        void this.#closeSession(session);
      }
    }
  }

  /**
   * Tells the Mac a forgotten session is over, and keeps telling it on the
   * minute sweep until it answers. A close that is lost would otherwise leave
   * the Mac's session, and the outline the person sees, up until its idle
   * lease ends. A Mac that went offline ended its sessions with its
   * connection, so there is nothing left to tell it.
   */
  async #deliverClose(session: Session): Promise<void> {
    try {
      await this.#close(session);
      this.#undeliveredCloses.delete(session);
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === "offline") {
        this.#undeliveredCloses.delete(session);
      } else {
        this.#undeliveredCloses.add(session);
      }
    }
  }

  /**
   * Tells the Mac a session is over.
   *
   * It goes for every session a frame has left for, not only a confirmed one:
   * a Run that ends while its first call is still in flight has a session the
   * helper may already hold, and nothing else would ever take it down.
   */
  async #close(session: Session): Promise<void> {
    if (!session.dispatched) return;
    const outcome = await this.#send({
      access: null,
      app: null,
      ...(session.display === null ? {} : { definitionId: session.display }),
      operation: "close",
      params: {},
      runId: session.runId,
      runnerId: session.runnerId,
      sessionId: session.sessionId,
      timeoutMs: closeTimeoutMs,
    });
    if (outcome.kind === "error" && outcome.code !== "no-session") {
      throw new ComputerUseError(outcome.code, outcome.message, outcome.retryable);
    }
  }

  /** A Run that has ended has no authority left, so its sessions end with it. */
  closeForRun(runId: RunId): void {
    for (const key of this.#stopped) {
      if (key.startsWith(`${runId}|`)) this.#stopped.delete(key);
    }
    for (const [key, stopped] of this.#unrecordedStops) {
      if (stopped.runId === runId) this.#unrecordedStops.delete(key);
    }
    void this.#stops.clear(runId).catch(this.#onError);
    for (const session of this.#snapshot()) {
      if (session.runId !== runId) continue;
      void this.#closeSession(session).catch(() => undefined);
    }
  }

  /**
   * Removing an app, or lowering or removing a phone's access, takes authority
   * back, and every session using it ends now rather than running on
   * authority nobody has any more.
   */
  closeForConnection(
    runnerId: RunnerId,
    holding: ComputerUseHolding,
    workspaceId?: WorkspaceId,
  ): void {
    for (const session of this.#snapshot()) {
      if (session.runnerId !== runnerId) continue;
      if (workspaceId !== undefined && session.workspaceId !== workspaceId) continue;
      const holds =
        holding.kind === "app"
          ? session.apps.some((app) => computerAppIdentityKey(app) === holding.appKey)
          : session.display === holding.definitionId;
      const pending = [...session.pending.values()].some((target) =>
        holding.kind === "app"
          ? target.kind === "app" && computerAppIdentityKey(target.app) === holding.appKey
          : target.kind === "display" && target.definitionId === holding.definitionId,
      );
      if (!holds && !pending) continue;
      this.#onAuthorityRevoked?.(session.authority);
      void this.#closeSession(session).catch(() => undefined);
    }
  }

  /**
   * That Mac's stream is gone. The desktop closes the helper session bound to
   * the bridge connection that opened it, so there is nothing left to tell and
   * nothing to send a `close` to.
   */
  forgetRunner(runnerId: RunnerId): void {
    for (const session of this.#undeliveredCloses) {
      if (session.runnerId === runnerId) this.#undeliveredCloses.delete(session);
    }
    for (const session of this.#snapshot()) {
      if (session.runnerId === runnerId) this.#forget(session);
    }
  }

  /** Applies an unsolicited event from the current fenced Runner stream. */
  handleHelperEvent(runnerId: RunnerId, event: ComputerUseHelperEvent): void {
    if (event.event !== "session.stopped") return;
    const session = this.#snapshot().find(
      (candidate) =>
        candidate.runnerId === runnerId && candidate.sessionId === event.params.sessionId,
    );
    if (!session) {
      // A person's Stop for a session this Host already forgot: the stream
      // it was pressed on dropped before it was reported. The computer that
      // sent it can only ever stop a Run on itself.
      if (event.params.reason === "user" && event.params.runId)
        void this.#hold({
          acknowledge: true,
          ownerUserId: null,
          runId: event.params.runId,
          runnerId,
          sessionId: event.params.sessionId,
        }).catch(this.#onError);
      return;
    }
    if (event.params.reason === "user")
      void this.#holdStop(session, event.params.runId === session.runId).catch(this.#onError);
    this.#forget(session);
    // A phone may have received another old-session observe before its
    // Stop reached us. A matching Close drains that work on the same
    // admission queue, ahead of the next holder, without retiring IDs here.
    if (event.params.reason === "user" && session.display !== null)
      void this.#deliverClose(session);
  }

  /**
   * The person pressed Stop from a client rather than from the Mac itself.
   *
   * Stopping is the Host taking the Run's authority on that Mac back, and it
   * is complete when this returns: the Run can never call there again, even
   * after a Host restart, and the session has left the list. Telling the Mac
   * follows; a Mac that does not hear it ends the session with its connection
   * or its idle lease. A session the Host no longer holds has already stopped.
   * A Stop that could not be recorded still holds in this Host, and the
   * caller hears that it would not survive one.
   */
  async stop(sessionId: ComputerUseSessionId, actorUserId: UserId): Promise<void> {
    const session = this.#snapshot().find((candidate) => candidate.sessionId === sessionId);
    if (!session) {
      const pending = [...this.#unrecordedStops.values()].filter(
        (stop) => stop.sessionId === sessionId,
      );
      if (pending.length === 0) return;
      const owners = await this.#machineOwners(pending.map((stop) => stop.runnerId));
      const owned = pending.filter(
        (stop) =>
          (stop.ownerUserId === null || stop.ownerUserId === actorUserId) &&
          owners.get(stop.runnerId)?.effectiveOwner === actorUserId,
      );
      if (owned.length === 0)
        throw new ComputerUseError("unsupported", "Only this computer's owner can do that.");
      await Promise.all(owned.map((stop) => this.#recordStop(stop)));
      return;
    }
    await this.#assertSessionOwner(session, actorUserId);
    // A Stop for this session may have been held while the owner was checked.
    const heldMeanwhile = this.#unrecordedStops.get(stopReportKey(session));
    if (heldMeanwhile) return this.#recordStop(heldMeanwhile);
    if (!this.#holds(session)) return;
    const recorded = this.#holdStop(session);
    this.#forget(session);
    void this.#deliverClose(session);
    await recorded;
  }

  /** Applies a Stop for a session this Host holds at once, and records it for the next Host. */
  #holdStop(session: Session, acknowledge = false): Promise<void> {
    return this.#hold({
      acknowledge,
      ownerUserId: session.ownerUserId,
      runId: session.runId,
      runnerId: session.runnerId,
      sessionId: session.sessionId,
    });
  }

  /**
   * Applies a Stop here at once and keeps it until the ledger has it. Kept
   * before its session is forgotten, so a Stop pressed again meanwhile finds
   * this one and waits for its record rather than reporting success. A Stop
   * reported again while held only adds whether to acknowledge it.
   */
  #hold(stop: HeldStop): Promise<void> {
    this.#stopped.add(stopKey(stop.runId, stop.runnerId));
    const key = stopReportKey(stop);
    const held = this.#unrecordedStops.get(key);
    this.#unrecordedStops.set(key, {
      ...stop,
      acknowledge: stop.acknowledge || (held?.acknowledge ?? false),
      ownerUserId: held?.ownerUserId ?? stop.ownerUserId,
    });
    return this.#recordStop(stop);
  }

  /**
   * Records a held Stop; concurrent callers share one write, and the Stop is
   * kept for the minute sweep until a write succeeds. Only then is a computer
   * that asked told it was recorded: a phone keeps reporting it until told.
   */
  #recordStop(stop: HeldStop): Promise<void> {
    const key = stopReportKey(stop);
    const inFlight = this.#stopWrites.get(key);
    if (inFlight) return inFlight;
    const write = this.#stops
      .record(stop.runId, stop.runnerId)
      .then(() => {
        const recorded = this.#unrecordedStops.get(key) ?? stop;
        this.#unrecordedStops.delete(key);
        if (recorded.acknowledge) {
          void this.#hub
            .acknowledgeComputerUseStop(recorded.runnerId, {
              runId: recorded.runId,
              sessionId: recorded.sessionId,
            })
            .catch(this.#onError);
        }
      })
      .finally(() => {
        this.#stopWrites.delete(key);
      });
    this.#stopWrites.set(key, write);
    return write;
  }

  /**
   * A passive read of what the session's agent is working in: one app
   * window it observed on a Mac, or the phone's screen. It neither opens nor
   * renews a session, and on a phone it never replaces the observation the
   * agent's next act cites. One read runs per computer at a time, at most one
   * every `computerUseCaptureMinIntervalMs`, and every viewer of the session
   * shares it. A session that is gone, stopped or replaced reads as ended.
   */
  /** Passive display admission shares capture's owner and renewable Run grant gate. */
  async authorizeDisplay(
    sessionId: ComputerUseSessionId,
    actorUserId: UserId,
    appKey?: string,
  ): Promise<RunnerId> {
    const session = this.#snapshot().find((candidate) => candidate.sessionId === sessionId);
    if (
      !session ||
      !session.confirmed ||
      !holdsAnything(session) ||
      (appKey === undefined
        ? session.display === null
        : session.display !== null ||
          !session.apps.some((app) => computerAppIdentityKey(app) === appKey))
    ) {
      throw new OpensteerError({ code: "forbidden", message: "That phone session has ended." });
    }
    await this.#assertSessionOwner(session, actorUserId);
    await this.#authorizeSession(session, session.authority);
    if (!this.#holds(session)) {
      throw new OpensteerError({ code: "forbidden", message: "That phone session has ended." });
    }
    return session.runnerId;
  }

  isDisplaySessionLive(
    sessionId: ComputerUseSessionId,
    runnerId: RunnerId,
    appKey?: string,
  ): boolean {
    return this.#snapshot().some(
      (session) =>
        session.sessionId === sessionId &&
        session.runnerId === runnerId &&
        session.confirmed &&
        (appKey === undefined
          ? session.display !== null
          : session.display === null &&
            session.apps.some((app) => computerAppIdentityKey(app) === appKey)) &&
        holdsAnything(session) &&
        this.#holds(session),
    );
  }

  /** Owner input renews idle time, without admitting an agent call or pinning in-flight work. */
  noteOwnerActivity(sessionId: ComputerUseSessionId): void {
    const session = this.#snapshot().find((candidate) => candidate.sessionId === sessionId);
    if (!session || !this.isDisplaySessionLive(sessionId, session.runnerId)) {
      throw new OpensteerError({ code: "forbidden", message: "That phone session has ended." });
    }
    session.lastUsedAt = this.#now();
  }

  async #authorizeSession(session: Session, authority: ComputerUseContext): Promise<void> {
    try {
      // Like reauthorize: validate the renewable live grant, not the original token expiry.
      await this.#authorizer.assertActiveGrant(authority);
    } catch (error) {
      if (!authorityRefused(error)) throw authorityUnchecked();
      this.#forget(session);
      if (session.dispatched) void this.#deliverClose(session);
      throw authorityEnded();
    }
  }

  async #assertSessionOwner(session: Session, actorUserId: UserId): Promise<void> {
    if (session.ownerUserId !== actorUserId) {
      throw new ComputerUseError("unsupported", "Only this computer's owner can do that.");
    }
    await this.#assertMachineOwner(session.runnerId, actorUserId);
  }

  /** Whether this is still the live session for its Run on its Mac. */
  #holds(session: Session): boolean {
    const key = sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId);
    return (
      !this.#closed &&
      !this.#stopped.has(stopKey(session.runId, session.runnerId)) &&
      this.#sessions.get(key) === session
    );
  }

  /** The minute tick: sessions nobody is using, approvals nobody answered. */
  sweep(): void {
    this.sweepIdle();
    for (const session of this.#undeliveredCloses) void this.#deliverClose(session);
    for (const stop of this.#unrecordedStops.values()) {
      void this.#recordStop(stop).catch((error: unknown) => this.#onError(error));
    }
    void this.#expireSetupRequests?.().catch((error: unknown) => this.#onError(error));
  }

  sweepIdle(): void {
    const now = this.#now();
    for (const session of this.#snapshot()) {
      const idleMs = session.display === null ? this.#idleMs.app : this.#idleMs.display;
      if (session.lastUsedAt > now - idleMs || session.inFlight > 0) continue;
      void this.#closeSession(session).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(sessions.map((session) => this.#closeSession(session)));
  }

  // ---- projection ------------------------------------------------------

  /** Every live session on one computer. */
  sessionsForRunner(runnerId: RunnerId): ComputerUseSessionSummary[] {
    return [...this.#sessions.values()]
      .filter(
        (session) => session.runnerId === runnerId && session.confirmed && holdsAnything(session),
      )
      .map((session) =>
        summarize(
          session,
          this.#actingAppKeys(session),
          session.display !== null &&
            this.#now() - (session.actedAt.get(session.display) ?? -Infinity) <
              this.#actingWindowMs,
        ),
      );
  }

  // ---- internals -------------------------------------------------------

  /**
   * The sessions as they stand, so a loop may end one without disturbing the
   * map it is walking.
   */
  #snapshot(): readonly Session[] {
    return Array.from(this.#sessions.values());
  }

  async #send(
    input: {
      readonly access: IntegrationAccess | null;
      readonly app: ComputerAppIdentity | null;
      readonly definitionId?: DisplayDefinitionId;
      readonly operation: ComputerUseOperation;
      readonly params: ComputerUseFrameParams;
      readonly runId?: RunId;
      readonly runnerId: RunnerId;
      readonly sessionId?: ComputerUseSessionId;
      readonly timeoutMs: number;
    },
    actorUserId?: UserId,
  ): Promise<ComputerUseOutcome> {
    // The frame leaves inside the computer's admission turn, the same queue a
    // disconnect and an access change are decided in, and the answer is waited
    // for outside it so a slow app never holds up the turn that is trying to
    // stop it.
    const sent = await this.#hub.withRunnerAdmission(input.runnerId, async () => {
      if (actorUserId) await this.#assertMachineOwner(input.runnerId, actorUserId);
      return this.#hub.sendComputerUse({
        access: input.access,
        app: input.app,
        ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }),
        operation: input.operation,
        params: input.params,
        // Every frame names a Run and a session, including those that are
        // about the Mac rather than one app: the helper reads them as the
        // bridge connection's bookkeeping, not as authority over an app.
        runId: input.runId ?? runlessRunId(),
        runnerId: input.runnerId,
        sessionId: input.sessionId ?? mintComputerUseSessionId(),
        threadTitle: null,
        timeoutMs: input.timeoutMs,
      });
    });
    return sent.outcome;
  }

  async #assertMachineOwner(runnerId: RunnerId, actorUserId: UserId): Promise<void> {
    const owners = await this.#machineOwners([runnerId]);
    if (owners.get(runnerId)?.effectiveOwner !== actorUserId) {
      throw new ComputerUseError("unsupported", "Only this computer's owner can do that.");
    }
  }

  // ---- acting ------------------------------------------------------------

  /** The agent observed or acted in this app just now. */
  #noteActing(session: Session, appKey: string): void {
    session.actedAt.set(appKey, this.#now());
    if (!session.actingTimer) this.#scheduleActingEnd(session, this.#actingWindowMs);
    this.#announceActing(session);
  }

  #publishPlaceActivity(session: Session, key: string, ended: boolean): void {
    if (!session.actor) return;
    const app = session.apps.find((app) => computerAppIdentityKey(app) === key);
    const place: PlaceIdentity =
      session.display !== null
        ? { kind: "phone", machineId: session.runnerId, display: "main" }
        : { kind: "app", machineId: session.runnerId, appKey: key };
    this.#onPlaceActivity?.({
      ownerId: session.ownerUserId,
      ...session.actor,
      runId: session.runId,
      generation: session.authority.bindingGeneration,
      place,
      title: app?.displayName ?? session.runnerName,
      at: this.#now(),
      ended,
    });
  }

  #actingAppKeys(session: Session): string[] {
    const now = this.#now();
    return [...session.actedAt]
      .filter(([, at]) => now - at < this.#actingWindowMs)
      .map(([appKey]) => appKey)
      .filter((appKey) => session.apps.some((app) => computerAppIdentityKey(app) === appKey))
      .sort();
  }

  /** Looks again when the newest call leaves the window; an app leaves as its own does. */
  #scheduleActingEnd(session: Session, delayMs: number): void {
    session.actingTimer = setTimeout(
      () => {
        session.actingTimer = undefined;
        if (
          this.#sessions.get(
            sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId),
          ) !== session
        )
          return;
        const now = this.#now();
        for (const [appKey, at] of session.actedAt) {
          if (now - at >= this.#actingWindowMs) session.actedAt.delete(appKey);
        }
        this.#announceActing(session);
        if (session.actedAt.size > 0) {
          const oldest = Math.min(...session.actedAt.values());
          this.#scheduleActingEnd(session, this.#actingWindowMs - (now - oldest));
        }
      },
      Math.max(0, delayMs),
    );
    session.actingTimer.unref();
  }

  /**
   * Tells the Mac's owner which apps are being acted in, when that changed. A
   * session nobody can see yet is announced whole by the machines list once
   * the Mac confirms it, so only a confirmed one is announced here.
   */
  #announceActing(session: Session): void {
    if (!session.confirmed || !holdsAnything(session)) return;
    const actingAppKeys = this.#actingAppKeys(session);
    const actingDisplay =
      session.display !== null &&
      this.#now() - (session.actedAt.get(session.display) ?? -Infinity) < this.#actingWindowMs;
    const announced = JSON.stringify([actingAppKeys, actingDisplay]);
    if (announced === session.announcedActing) return;
    session.announcedActing = announced;
    this.#onPresenceChanged(session.ownerUserId, [
      {
        actingAppKeys,
        ...(session.display === null ? {} : { actingDisplay }),
        sessionId: session.sessionId,
      },
    ]);
  }

  /**
   * One session's action count may move the machines list only so often: a
   * batch of thirty actions is one visible change to a person watching, not
   * thirty, and everything structural is published the moment it happens.
   */
  #notifyActivity(session: Session): void {
    const now = this.#now();
    const elapsed = now - session.lastActivityNotifiedAt;
    if (elapsed >= this.#activityNotifyIntervalMs) {
      session.lastActivityNotifiedAt = now;
      this.#onSessionsChanged();
      return;
    }
    if (session.activityTimer) return;
    session.activityTimer = setTimeout(() => {
      session.activityTimer = undefined;
      if (
        this.#sessions.get(
          sessionKey(session.runId, session.authority.bindingGeneration, session.runnerId),
        ) !== session
      )
        return;
      session.lastActivityNotifiedAt = this.#now();
      this.#onSessionsChanged();
    }, this.#activityNotifyIntervalMs - elapsed);
    session.activityTimer.unref();
  }
}

function summarize(
  session: Session,
  actingAppKeys: string[],
  actingDisplay: boolean,
): ComputerUseSessionSummary {
  return {
    actionCount: session.actionCount,
    actingAppKeys,
    actingDisplay,
    actor: session.actor,
    apps: session.apps.map((app) => ({ ...app })),
    windows: [...session.windows]
      .filter(([appKey]) => session.apps.some((app) => computerAppIdentityKey(app) === appKey))
      .map(([appKey, window]) => ({ appKey, id: window.id, title: window.title })),
    display: session.display !== null,
    openedAt: session.openedAt,
    runId: session.runId,
    sessionId: session.sessionId,
    threadId: session.threadId,
    threadTitle: session.threadTitle,
  };
}

/** Whether a session holds apps or a display yet, which is when it is anybody's to see. */
function holdsAnything(session: Session): boolean {
  return session.apps.length > 0 || session.display !== null;
}

/**
 * The platforms whose computers serve a session definition, as the catalog
 * this Host ships declares them: there is no second list to drift from it.
 */
function sessionDefinitionPlatforms(definitionId: string): ReadonlySet<ComputerAppPlatform> {
  const definition = getIntegrationDefinition(definitionId);
  if (
    !definition ||
    !isComputerAppDefinition(definition) ||
    !computerAppUsesSessions(definition.config)
  ) {
    throw new Error(`${definitionId} is not a computer-use definition in this catalog`);
  }
  return new Set(definition.config.platforms);
}

/**
 * The Runner passes the computer's result envelope through without unwrapping
 * it, and what it holds is read with the schemas of what the call operated.
 */
function parseComputerUseResult(
  scope: ComputerUseScope,
  operation: "act" | ComputerReadOperation,
  value: ComputerUseValue,
): ComputerUseDispatchResult {
  if (scope.kind === "display") {
    if (operation === "observe") {
      const parsed = AndroidPhoneObservationResultSchema.safeParse(value);
      if (!parsed.success) throw unreadableObservation("observe", scope);
      return {
        error: null,
        kind: "display",
        observation: parsed.data.observation,
        performed: null,
      };
    }
    const parsed = AndroidPhoneActResultSchema.safeParse(value);
    if (!parsed.success) throw unreadableObservation("act", scope);
    return {
      error: parsed.data.error
        ? new ComputerUseError(parsed.data.error.code, parsed.data.error.message)
        : null,
      kind: "display",
      observation: parsed.data.observation,
      performed: parsed.data.performed,
    };
  }
  if (operation === "windows") {
    const parsed = ComputerUseWindowsResultSchema.safeParse(value);
    if (!parsed.success) throw unreadableObservation(operation, scope);
    return {
      kind: "app",
      error: null,
      observation: null,
      performed: null,
      windows: parsed.data.windows,
    };
  }
  if (operation === "bind") {
    const parsed = ComputerUseBindResultSchema.safeParse(value);
    if (!parsed.success) throw unreadableObservation(operation, scope);
    return {
      kind: "app",
      error: null,
      observation: null,
      performed: null,
      window: parsed.data.window,
    };
  }
  if (operation === "observe") {
    const parsed = ComputerUseObservationResultSchema.safeParse(value);
    if (!parsed.success) throw unreadableObservation("observe", scope);
    return { error: null, kind: "app", observation: parsed.data.observation, performed: null };
  }
  const parsed = ComputerUseActResultSchema.safeParse(value);
  if (!parsed.success) throw unreadableObservation("act", scope);
  return {
    error: parsed.data.error
      ? new ComputerUseError(parsed.data.error.code, parsed.data.error.message)
      : null,
    kind: "app",
    observation: null,
    performed: parsed.data.performed,
  };
}

function unreadableObservation(
  operation: "act" | ComputerReadOperation,
  scope: Pick<ComputerUseScope, "kind">,
): ComputerUseError {
  return new ComputerUseError(
    operation === "act" ? "outcome-unknown" : "failed",
    scope.kind === "app"
      ? "That Mac answered with an observation this Host cannot read. Update Opensteer there."
      : "That phone answered with an observation this Host cannot read. Update the Opensteer Agent Phone app there.",
  );
}

/** A computer is a Mac or a phone; a session that already holds one kind never takes the other. */
function mixedScopes(runnerName: string): ComputerUseError {
  return new ComputerUseError(
    "unsupported",
    `This task's session on ${runnerName} cannot hold both apps and the whole screen.`,
  );
}

/**
 * A batch the protocol refuses, said so a model can fix it: each offending
 * field by its path, what is wrong with it, and what to do next.
 */
function unusableActions(error: z.ZodError, scope: Pick<ComputerUseScope, "kind">): string {
  const problems = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.reduce<string>(
      (written, part) =>
        typeof part === "number"
          ? `${written}[${part}]`
          : written
            ? `${written}.${String(part)}`
            : String(part),
      "",
    );
    const missing = issue.code === "invalid_type" && issue.message.endsWith("received undefined");
    return `${path || "arguments"}: ${missing ? "is required" : issue.message}`;
  });
  const more =
    error.issues.length > problems.length
      ? ` (and ${error.issues.length - problems.length} more)`
      : "";
  return `Those actions are not usable — ${problems.join("; ")}${more}. Correct those fields as the computer tool describes, ${scope.kind === "app" ? "observe this window again, and act on its snapshot" : "observe the phone again, and act on its observationId"}.`;
}

function sessionEndedBeforeSend(
  runnerName: string,
  scope: Pick<ComputerUseScope, "kind">,
): ComputerUseError {
  return new ComputerUseError(
    "failed",
    `Computer use for this task on ${runnerName} ended before this call was sent, so nothing happened. Observe the ${scopeWords(scope).subject} again to continue.`,
  );
}

function stoppedByUser(runnerName: string): ComputerUseError {
  return new ComputerUseError(
    "stopped-by-user",
    `Computer use was stopped for this task on ${runnerName}.`,
  );
}

/** A frame that never reached the Mac cannot have opened a session. */
function noSessionOpened(code: ComputerUseErrorCode | "offline"): boolean {
  return code === "offline";
}

/**
 * Mac-wide operations belong to a person at a keyboard rather than a
 * Run, and the frame has a Run on it either way. A synthetic id keeps the one
 * frame shape honest without inventing a Run row that does not exist.
 */
function runlessRunId(): RunId {
  return createId("run");
}
