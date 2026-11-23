import { AsyncLocalStorage } from "node:async_hooks";
import { StandardCdpProfileLeases } from "./standard-cdp-profile-leases.js";
import {
  cdpCommandRefusal,
  connectionAutoAttachParameters,
  connectionCdpRefusal,
  type BrowserRuntime,
} from "@opensteer/browser-runtime-core";
import type {
  StandardCdpAttemptReconciliation,
  StandardCdpLeaseReconciliation,
  StandardCdpMode,
} from "@opensteer/protocol/standard-cdp";
import {
  StandardCdpTickets,
  standardCdpConnectPrefix,
  type CdpAuthority,
  type StandardCdpFacts,
  type StandardCdpPoolReservation,
  type StandardCdpTicketClaims,
} from "./standard-cdp-tickets.js";
import {
  directStandardTransport,
  relayStandardTransport,
  standardCdpAdmissionMs,
  standardCdpMaxLivePerBinding,
  standardCdpMaxLivePerRunner,
} from "./standard-cdp-transport.js";
import type { DeviceId } from "@opensteer/core";
import { authorizeTabTarget } from "../tabs/tab-authority.js";
import type { PageTabsPort } from "../tabs/tab-service.js";
import type { TabActor } from "../tabs/ports.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import {
  TabStore,
  acquireBrowserStandardCdpLease,
  admitExecution,
  listBrowserStandardCdpLeases,
  releaseBrowserStandardCdpLease,
  executionAccess,
  selectedGrantOf,
  type TabRecord,
  type TabWrite,
} from "@opensteer/database";
import type { PageBinding, TabOpenedBy, TabTarget } from "@opensteer/core";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import {
  keyedStreamHardCapBytes,
  KeyedStreamPublisher,
  KeyedStreamReceiver,
  keyedStreamBytes,
} from "@opensteer/protocol/keyed-stream";
import type {
  BrowserTabRecord,
  BrowserTabStreamMeta,
  BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";
import {
  BrowserRuntimeServerMessageSchema,
  type BrowserRuntimeServerMessage,
  type BrowserSessionState,
} from "@opensteer/protocol/browser";
type BrowserAgentTabOpenInput = {
  identity: { kind: "guest"; computer?: RunnerId } | { kind: "profile"; profile: string };
  url?: string;
  operationKey: string;
};
type BrowserAgentTabOpenResult = {
  tabId: BrowserSurfaceId;
  sessionId: BrowserSessionId;
  backend: "cdp" | "actions";
};
type BrowserTabOpenAgent = {
  readonly ownerId: UserId;
  readonly agentBindingId: string;
  readonly threadId: ThreadId;
  readonly browserSend?: PooledBrowserSend;
};

declare const ownedBrowserSessionBrand: unique symbol;
/** A browser session record loaded via `getBrowserSessionForOwner` for the checked owner. */
export type OwnedBrowserSessionRecord = BrowserSessionRecord & {
  readonly [ownedBrowserSessionBrand]: UserId;
};

export async function loadOwnedBrowserSession(
  repository: Pick<BrowserSessionRepository, "getBrowserSessionForOwner">,
  sessionId: BrowserSessionId,
  ownerId: UserId,
): Promise<OwnedBrowserSessionRecord | null> {
  const record = await repository.getBrowserSessionForOwner(sessionId, ownerId);
  return record ? (record as OwnedBrowserSessionRecord) : null;
}
import { browserBasicInputAllows, type BrowserPoolReportView } from "@opensteer/protocol/browser";
import { editingClipboardPartCount } from "@opensteer/protocol/editing";
import {
  BrowserListTabsParametersSchema,
  BrowserResumeTabParametersSchema,
  BrowserActionRequestSchema,
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserActionEvent,
  type BrowserActionErrorCode,
  type BrowserAgentBackend,
} from "@opensteer/protocol/browser-actions";
import type { BrowserEngine } from "@opensteer/protocol";
import type { AdministrationCommandIdentity } from "@opensteer/database";
import { RunPlaceRecorder } from "../agents/run-place-recorder.js";
import { type BrowserCookie } from "@opensteer/browser-profile/cookies";
import {
  OpensteerError,
  agentGrantAllows,
  threadAccessModeAtMost,
  RunnerIdSchema,
  RunIdSchema,
  type AuthSessionId,
  type BrowserAccessSuggestion,
  type BrowserProfileId,
  type EnvironmentId,
  type Request,
  type RequestId,
  type RequestResponse,
  type EventData,
  type RunId,
  type RunnerId,
  type ThreadId,
  type TabId,
  type UserId,
  type DeploymentId,
} from "@opensteer/core";
import {
  BrowserPoolAdmissionClosed,
  OpensteerStore,
  withDatabaseOperationSignal,
  withoutDatabaseOperationSignal,
  type BrowserHistoryStore,
  type BrowserSessionCut,
} from "@opensteer/database";
import {
  browserCaptureMaxTargets,
  BrowserClientMessageSchema,
  BrowserContextCandidateSchema,
  BrowserDialogSchema,
  BrowserHistoryUrlSchema,
  browserHostMethods,
  browserPageSite,
  browserStateImportHostTimeoutMs,
  BrowserSurfaceIdSchema,
  BrowserTabOpenCommandSchema,
  BrowserTabOpenRefusalDetailsSchema,
  browserViewerCloseCodes,
  createBrowserSessionId,
  decodeBrowserFrameEnvelope,
  InitialPageReadySchema,
  previousReleaseEligibility,
  projectBrowserSessionOpener,
  staleBrowserTabInventoryReason,
  type AgentBrowserSessionSummary,
  type BrowserBinaryFrameHeader,
  type BrowserClientMessage,
  type BrowserContextCandidate,
  type BrowserContextCandidateInput,
  type BrowserDialog,
  type BrowserPagePresence,
  type BrowserPlacement,
  type BrowserPlacementSelector,
  type BrowserProfile,
  type BrowserRasterDensity,
  type BrowserRuntimeActivity,
  type BrowserServerMessage,
  BrowserSessionIdSchema,
  type BrowserSessionId,
  type BrowserSessionOpenerRecord,
  type BrowserSurface,
  type BrowserSurfaceId,
  type BrowserTabCloseCommand,
  type BrowserTabCloseResult,
  type BrowserTabIconInput,
  type BrowserTabOpenBinding,
  type BrowserTabOpenCommand,
  type BrowserTabOpenRefusalReason,
  type BrowserTabOpenResult,
  type HostedBrowserSession,
  type HostedBrowserSessionState,
  type InitialPageReady,
  type PendingBrowserProfileDeletion,
  type TabPlaceActivity,
  type PlaceOccupant,
  type PersonFillVersion,
  type RequestCreationResult,
} from "@opensteer/protocol";
import type { PasskeyMode } from "@opensteer/protocol/passkeys";
import { systemClock, type Clock } from "@opensteer/shared/clock";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { RawData } from "ws";
import WebSocket from "ws";
import { z } from "zod";
import { LegacyBrowserClipboard } from "./browser-legacy-clipboard.js";
import type { BrowserLocalProfiles } from "./browser-local-profiles.js";
import type { BrowserAttachTicketSigner } from "./browser-ticket.js";
import type { BrowserPoolGate, BrowserPoolReservation } from "./browser-pool-gate.js";
import type { BrowserPoolAdopter, BrowserPoolCoordinator } from "./browser-pool-coordinator.js";
import { PooledBrowserRelay } from "./browser-pool-relay.js";
import type { BrowserPoolDocument, BrowserPoolRuntimeFence } from "@opensteer/browser-runtime-core";
import {
  listBrowserPoolRuntimeSessions,
  readBrowserPoolOwner,
  closeBrowserPoolSessions,
  type BrowserPoolCloseEvidence,
  type BrowserPoolSessionTarget,
  readBrowserPoolSlot,
  listBrowserPoolReportedNotices,
  listBrowserPoolReadySessions,
  listBrowserPoolClosingSessions,
  listBrowserPoolUnconfirmedClosings,
  dismissBrowserPoolUnconfirmedSession,
  stopBrowserPoolSession,
  seeBrowserPoolDocumentLoss,
  readBrowserPoolSessionLineage,
  type BrowserPoolSessionLoss,
  type BrowserPoolTargetIdentity,
} from "@opensteer/database";
import type { PooledBrowserSend } from "../agent-sessions/agent-session-service.js";
import { browserViewerEditingVersion, browserViewerMessage } from "./browser-viewer-protocol.js";
import type { ShadowCatalog, ShadowInventory } from "./shadow-comparison.js";
import { ShadowHostSession, ShadowReader } from "./shadow-host.js";
import { PasskeyService, type PasskeyViewer } from "./passkey-service.js";

const olderBrowserDialogSchema = BrowserDialogSchema.omit({ id: true });

const maxBrowserCommandBytes = 1_100_000;
const maxBrowserFrameBytes = 8 * 1_024 * 1_024;
const maxBrowserTextBytes = 1 * 1_024 * 1_024;
/** Phone runtimes report their own engines; the shadow comparison is for desktop and standalone. */
const phoneEngines = new Set(["wkwebview", "android-webview"]);
const maxPendingAgentRequests = 32;
const agentRequestTimeoutMs = 15_000;
/** An open's work budget; it also bounds waiting for this computer's browser to arrive. */
const browserOpenWorkMs = 18_000;
const maxBrowserProfiles = 128;
/** A live state export walks every context, so it gets more room than a CDP call. */

/** How long after its latest command an agent still counts as acting in a browser. */
export const browserActingWindowMs = 15_000;
/** Optional attribution must not hold page commands behind a stalled metadata store. */
export const browserActorMetadataTimeoutMs = 1_000;
/**
 * How long a Run that ended is remembered, so a command it sent just before
 * its end and that answers after cannot make the browser look acting again.
 * It is longer than any agent command may take.
 */
const endedBindingMemoryMs = 5 * 60_000;
/** Page title and site changes are announced at most this often per session. */
const pageNoticeDelayMs = 250;

/**
 * An agent CDP connection can no longer reach its Browser Session. The message
 * is written for the agent reading it and names its next step.
 */
/** A connected agent's direct-work session, which finds tabs with `discover`, not `tab_list`. */
function connectedAgentBinding(agentBindingId: string | undefined): boolean {
  return agentBindingId?.startsWith("session:") === true;
}

export class BrowserCdpConnectionEnded extends Error {
  override readonly name = "BrowserCdpConnectionEnded";
}

function browserCommandOutcomeUnknown(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "outcome-unknown",
    message:
      "The browser disconnected before confirming the action. Observe the page before trying again.",
  });
}

function browserActionFailure(reason: BrowserActionErrorCode, message: string): OpensteerError {
  return new OpensteerError({
    code: reason === "forbidden" ? "forbidden" : "conflict",
    reason,
    message,
  });
}

/**
 * What a viewer or an agent's browser surface may send. Everything else —
 * CDP, and state export and import in particular — is identity material or
 * control only the Host itself issues, so it is never relayed from a consumer.
 */
const consumerMessageTypes: ReadonlySet<BrowserClientMessage["type"]> = new Set([
  "autofill.fill",
  "passwordSave.answer",
  "cursor.query",
  "cursor.reset",
  "input.command",
  "input.compose",
  "input.text",
  "clipboard.copy",
  "clipboard.cut",
  "clipboard.paste-data",
  "clipboard.part",
  "viewport.set",
  "viewport.follow",
  "surface.activate",
  "surface.close",
  "surface.open",
  "navigation.go",
  "navigation.back",
  "navigation.forward",
  "navigation.reload",
  "navigation.stop",
  "input.pointer",
  "input.wheel",
  "input.key",
  "input.cancel",
  "dialog.respond",
  "clipboard.paste",
] satisfies readonly BrowserClientMessage["type"][]);

export interface BrowserProfileRecord {
  readonly homeRunnerId?: RunnerId | null;
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly ownerId: UserId;
  /** `engine-sign-in`: where an AI engine signs in; no connected agent's grant may name it. */
  readonly purpose?: "person" | "engine-sign-in";
}

/** One granted browser profile as an agent sees it. */

export interface BrowserSessionRecord {
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly createdAt: Date;
  readonly id: BrowserSessionId;
  readonly origin: "agent" | "trigger" | "person";
  readonly placementKey: string;
  readonly runnerId: RunnerId;
  /** Null exactly for a fresh session: no identity, no durable state. */
  readonly profileId: BrowserProfileId | null;
  readonly runtimeId: string;
  readonly state: HostedBrowserSessionState;
  /** W15: Stop never got its replaced browser's word; kept closing honestly (Rule 4). */
  readonly closeUnconfirmed?: true;
  readonly updatedAt: Date;
}

export interface BrowserSessionWithAttachmentCountRecord extends BrowserSessionRecord {
  readonly activeAttachmentCount: number;
}

export interface BrowserSessionRepository {
  recordRunTabPlace(input: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly data: EventData<"place.entered">;
  }): Promise<boolean>;

  getBrowserTabOpen(ownerId: UserId, key: string): Promise<BrowserTabOpenBinding | null>;
  bindBrowserTabOpen(input: {
    binding: BrowserTabOpenBinding;
    identityKey: string | null;
    runnerId: RunnerId;
    pooled?: true;
  }): Promise<void>;
  settleBrowserTabOpen(binding: BrowserTabOpenBinding): Promise<void>;
  rememberedBrowserPlacement(ownerId: UserId, identityKey: string): Promise<RunnerId | null>;
  browserSessionOpenerForBinding(
    agentBindingId: string,
    ownerId: UserId,
  ): Promise<BrowserSessionOpenerRecord | null>;
  authorizedPlaceThreadIds?(
    ownerId: UserId,
    threadIds: readonly ThreadId[],
  ): Promise<readonly ThreadId[]>;
  effectiveDeviceOwners?: OpensteerStore["effectiveDeviceOwners"];
  requireSelfDeviceId?: OpensteerStore["requireSelfDeviceId"];
  requireDeviceSelfRunnerId?: OpensteerStore["requireDeviceSelfRunnerId"];
  listBrowserSessionViewers(
    sessionId: BrowserSessionId,
  ): Promise<{ readonly userIds: readonly UserId[] } | null>;
  resolvePlaceActors(input: {
    readonly agentBindingIds: readonly string[];
    readonly ownerIds: readonly UserId[];
  }): Promise<
    readonly {
      agentBindingId: string;
      ownerId: UserId;
      runId: RunId;
      threadId: ThreadId;
      generation: number;
      lineageThreadIds: ThreadId[];
    }[]
  >;
  listBrowserSessionAttachmentBindings?(sessionId: BrowserSessionId): Promise<readonly string[]>;
  listBrowserPlaceHoldings(sessionId: BrowserSessionId): Promise<
    readonly {
      agentBindingId: string;
      ownerId: UserId;
      tabId: string | null;
      lastUsedAt: Date;
    }[]
  >;
  readonly requests: {
    create(input: {
      readonly callId: string;
      readonly kind: "browser.access";
      readonly mode: "durable";
      readonly originatingRunId: RunId;
      readonly originatingThreadId: ThreadId;
      readonly payload: Request["payload"];
      readonly presentation: Request["presentation"];
      readonly requestedBy: UserId;
      readonly requiredActor: "requester";
    }): Promise<{
      readonly replayed: boolean;
      readonly request: Request;
    }>;
    findByCallIdentity(input: {
      readonly callId: string;
      readonly originatingRunId: RunId;
    }): Promise<Request | null>;
    get(id: RequestId): Promise<Request | null>;
    resolveBrowserRequest(input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      readonly resolvedBy: UserId;
      readonly settlementSessionId?: string;
      readonly response: RequestResponse;
    }): Promise<{
      readonly profile: BrowserProfileRecord | null;
      readonly request: Request;
    }>;
  };
  createBrowserProfile(input: {
    readonly homeRunnerId?: RunnerId | null;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
    readonly purpose?: "person" | "engine-sign-in";
  }): Promise<BrowserProfileRecord>;

  createBrowserSession(input: {
    readonly ownerId: UserId;
    readonly tabGroupId?: BrowserSessionId;
    readonly tabGeneration?: number;
    readonly previousPageBinding?: PageBinding;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "person";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly pooled?: true;
    readonly onPooledComputer?: true;
    readonly pooledRunner?: RunnerId;
  }): Promise<BrowserSessionRecord>;
  countBrowserSessionAttachments(sessionId: BrowserSessionId): Promise<number>;
  /** One consistent read of a session's open tabs and Run eligibility; null if it is gone. */
  readBrowserSessionCut?(
    ownerId: UserId,
    sessionId: BrowserSessionId,
    surfaces?: readonly string[],
  ): Promise<BrowserSessionCut | null>;
  /** A person brought a browser, or one of its pages, into a conversation. */
  recordBrowserSessionUse(input: {
    readonly sessionId: BrowserSessionId;
    readonly threadId: ThreadId;
    readonly ownerId: UserId;
    readonly tabId?: string | null;
    readonly page?: BrowserUsePage | null;
  }): Promise<readonly BrowserUsageCredit[]>;
  /** A Run used a session, and which page; durable whether or not the Run is still active. */
  recordAgentBrowserUse(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly tabId: string | null;
    readonly page: BrowserUsePage | null;
  }): Promise<readonly BrowserUsageCredit[]>;
  /** The live attachment, written only while a Run's binding is active. */
  attachBrowserSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly pool?: BrowserPoolTargetIdentity;
  }): Promise<boolean>;
  detachBrowserSessionAttachments(agentBindingId: string): Promise<readonly BrowserSessionId[]>;

  failActiveBrowserSessions(
    placementKey?: string,
    pooledRunner?: RunnerId,
  ): Promise<{
    readonly failed: number;
  }>;
  findActiveBrowserSessionForPerson(ownerId: UserId): Promise<BrowserSessionRecord | null>;
  listActiveBrowserSessionsForAgentBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionRecord[]>;
  listAttachedRunIdsForBrowserSessions(
    sessionIds: readonly BrowserSessionId[],
  ): Promise<ReadonlyMap<BrowserSessionId, readonly RunId[]>>;
  findBrowserSessionHoldingProfilePlacement(
    profileId: BrowserProfileId,
  ): Promise<BrowserSessionRecord | null>;
  getBrowserProfile(
    profileId: BrowserProfileId,
    ownerId: UserId,
  ): Promise<BrowserProfileRecord | null>;
  getBrowserSessionForOwner(
    sessionId: BrowserSessionId,
    ownerId: UserId,
  ): Promise<BrowserSessionRecord | null>;

  listBrowserProfiles(ownerId: UserId): Promise<readonly BrowserProfileRecord[]>;
  listEligibleBrowserRunners: OpensteerStore["listEligibleBrowserRunners"];
  renameBrowserProfile(input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfileRecord>;
  deleteBrowserProfile(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<{
    readonly sessionIds: readonly BrowserSessionId[];
    readonly deletion?: PendingBrowserProfileDeletion;
  }>;
  listActiveBrowserSessionsForAgent(input: {
    readonly ownerId: UserId;
  }): Promise<readonly BrowserSessionWithAttachmentCountRecord[]>;

  resolveResourceAccess?: OpensteerStore["resolveResourceAccess"];
  runCapabilityScope?: OpensteerStore["runCapabilityScope"];
  assertActiveGrant?: OpensteerStore["assertActiveGrant"];
  listBrowserSessions(
    ownerId: UserId,
    options?: { readonly pooled?: boolean },
  ): Promise<readonly BrowserSessionRecord[]>;
  /** The conversations using each session that the reader can open, bounded per session. */
  listBrowserSessionThreads(input: {
    readonly ownerId: UserId;
    readonly sessionIds: readonly BrowserSessionId[];
  }): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>>;
  transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: Exclude<HostedBrowserSessionState, "closed">;
  }): Promise<{
    readonly session: BrowserSessionRecord;
  }>;
  /** A session that is not pooled; a pooled one is refused by the store's own statement. */
  closeUnpooledBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
  }): Promise<{
    readonly session: BrowserSessionRecord;
  }>;
}

/** What a page showed when a conversation used it. */
export interface BrowserUsePage {
  readonly site: string;
  readonly title: string;
}

/** A conversation whose visible browser usage changed, and its task. */
export interface BrowserUsageCredit {
  readonly threadId: ThreadId;
  /** Its catalog conversation list changed through a first use or a revisit. */
  readonly joined: boolean;
  /** Sessions whose catalog changed; their viewers can span the person. */
  readonly catalogSessionIds?: readonly BrowserSessionId[];
}

export interface BrowserRuntimeConnection {
  readonly initialPage?: InitialPageReady | undefined;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: string, options: { readonly binary: false }, callback: (error?: Error) => void): void;
  terminate(): void;
}

export interface PersonBrowserReconnect {
  prepare(): Promise<void>;
  ticket(): string;
}

export interface BrowserRuntimeTarget {
  /** The person fill version the runtime advertises (`person-fill.ts`). */
  readonly personFill?: PersonFillVersion | undefined;
  readonly placementKey: string;
  readonly runtimeId: string;
  readonly main?: boolean;
  readonly localProfileStorage?: { storageInstanceId: string; engine: BrowserEngine };
  /** The Runtime accepts `state.import`; one that predates it is never sent the frame. */
  readonly stateImport?: boolean;
  /** The Runtime stages page-bound files; one that predates it cannot receive any. */
  readonly fileStaging?: boolean;
  /** The Runtime authorizes and fills saved logins (`login.*`, version 3). */
  readonly cardFill?: boolean;
  readonly signIn?: boolean;
  /** The Runtime enforces the agent CDP boundary; agents get no CDP on one without it. */
  readonly cdpBoundary?: boolean;
  readonly agentActions?: boolean | undefined;
  readonly basicInput?: 1 | undefined;
  readonly surfaceState?: 1 | undefined;
  /** Shared pages, dialog IDs, view following and the attach ticket's initial size. */
  readonly sharedControl?: boolean;
  /** The Runtime observes a target without starting a screencast. */
  readonly targetControl?: boolean;
  readonly navigationVersion?: boolean;
  readonly navigationAttributionVersion?: boolean;
  readonly tabRestoreVersion?: boolean;
  readonly popupFollowVersion?: boolean;
  /** The Runtime reads the attach ticket's `actor` claim. */
  readonly actorClaim?: boolean;
  readonly captureRegion?: boolean;
  readonly rasterDemand?: boolean;
  readonly passkeys?: boolean;
  readonly editing?: 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  /** The computer whose Runner relays this Runtime, as this Deployment names it. */
  readonly computer?: { readonly name: string; readonly runnerId: RunnerId };
  connect(ticket: string, reconnect?: PersonBrowserReconnect): BrowserRuntimeConnection;
  readonly wholeContextCdp?: boolean;
  readonly standardCdpLineage?: boolean;
  /** The runtime holds a connected agent's CDP rules itself for a command marked as one's. */
  readonly connectionCommands?: boolean;
  readonly standardCdpRecovery?: {
    readonly relayId: string;
    boot(): Promise<string>;
    assertCurrent(): void;
  };
  reconcileStandardCdpAttempt?(attempt: StandardCdpAttemptReconciliation): Promise<string>;
  readonly standardRuntime?: Pick<BrowserRuntime, "attachStandardCdp">;
  connectStandard?(
    ticket: string,
    signal: AbortSignal,
  ): Promise<{
    readonly connection: BrowserRuntimeConnection;
    readonly mode: StandardCdpMode;
  }>;
}

export type BrowserRuntimePlacement = BrowserPlacement & { readonly agents?: boolean };

export interface BrowserRuntimeTargetResolver {
  pendingAdmission?(runnerId: RunnerId): boolean;
  waitForTarget?(runnerId: RunnerId, signal: AbortSignal): Promise<void>;
  placements(runnerIds?: readonly RunnerId[]): readonly BrowserRuntimePlacement[];
  resolve(placement: BrowserPlacementSelector): BrowserRuntimeTarget | undefined;
}

export interface BrowserConsumerPeer {
  readonly id: string;
  isOpen(): boolean;
  close(code: number, reason: string): void;
  send(data: Buffer | string, binary: boolean): Promise<void>;
}

export type BrowserConsumerMode = "control" | "watch";

/**
 * The identity a Browser Session opens with, mirroring the browser start body.
 * It is chosen once, explicitly, and never guessed: a profile, or fresh (no
 * profile and no durable state).
 */
type BrowserSessionIdentityInput =
  | { readonly profileId: BrowserProfileId; readonly fresh?: never }
  | { readonly fresh: true; readonly profileId?: never };

export type StartBrowserSessionInput = {
  readonly operationBudget?: { readonly signal: AbortSignal; readonly expiresAt: number };
  readonly initialPageOperationKey?: string;
  readonly sessionId?: BrowserSessionId;
  readonly tabGroupId?: BrowserSessionId;
  readonly tabGeneration?: number;
  readonly previousPageBinding?: PageBinding;
  readonly initialSurfaceId?: BrowserSurfaceId;
  /** The initial tab's row exactly as binding it to this session wrote it. */
  readonly onPageBound?: (row: TabRecord) => void;
  readonly dormantSurfaceIds?: readonly BrowserSurfaceId[];
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly agentBindingId?: string;
  readonly threadId?: ThreadId;
  /**
   * A computer the caller named. Unlike `environmentId`, which only expresses
   * where the work already is, this one is a decision: the session lands on
   * that computer's browser or the call is refused.
   */
  readonly chosenRunnerId?: RunnerId;
  readonly environmentId?: EnvironmentId;
  readonly initialUrl?: string;
  readonly origin?: "agent" | "trigger" | "person";
  readonly ownerId: UserId;
  readonly placement?: BrowserPlacementSelector;
  readonly reuseExisting?: boolean;
  /** The size of the view a person starts the browser from; its first page opens at it. */
  readonly viewport?: { readonly height: number; readonly width: number };
} & BrowserSessionIdentityInput;

/** A live session as a Chrome sign-in sees it. */
type LoginLeaseValidator = (input: {
  loginRef: string;
  sessionId: BrowserSessionId;
  deploymentId: DeploymentId;
  bindingId?: string;
  profileId?: BrowserProfileId | null;
  tabId?: BrowserSurfaceId;
}) => boolean | Promise<boolean>;

export interface BrowserSignInTarget {
  readonly tabGeneration?: number;
  readonly tabUrl?: string | null;
  readonly agentBindingId?: string;
  readonly deploymentId: DeploymentId;
  readonly tabId?: BrowserSurfaceId;
  readonly sessionId: BrowserSessionId;
  /** A profile-backed session shares its browser context with every session on the profile. */
  readonly profileId: BrowserProfileId | null;
  readonly profileName: string | null;
  readonly live: boolean;
  readonly stateImport: boolean;
  readonly main: boolean;
  readonly engine?: BrowserEngine;
  /** The session's browser runs saved-password sign-ins on its computer. */
  readonly cardFill?: boolean;
  readonly signIn: boolean;
  /** The computer that runs the session's browser, when a Runner relays it. */
  readonly computer: { readonly name: string; readonly runnerId: RunnerId } | null;
}

export type ApplySiteCookiesResult = "applied" | "session-closed" | "runtime-outdated";

export interface StartBrowserSessionResult {
  readonly session: HostedBrowserSession;
  readonly wasExisting: boolean;
}

interface ConfirmedCdpDispatch {
  readonly maxBytes: number;
  readonly maxImageBytes?: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly signal?: AbortSignal;
  readonly eventBudget?: Pick<ConfirmedCdpDispatch, "maxBytes" | "maxDepth" | "maxEntries">;
  readonly browserSend?: PooledBrowserSend;
}

type BrowserCdpRequest = Extract<BrowserClientMessage, { readonly type: "cdp.command" }>;
type BrowserCdpResponse = Extract<BrowserServerMessage, { readonly type: "cdp.result" }>;
type BrowserCdpWireResponse = Extract<
  BrowserServerMessage,
  { readonly type: "cdp.error" | "cdp.result" }
>;

type BrowserPlaceActivity = Omit<TabPlaceActivity, "tabId"> & {
  place: import("@opensteer/core").PlaceIdentity;
};
type BrowserPlaceActivityNotice =
  | { type: "host.place-activity"; activity: BrowserPlaceActivity }
  | {
      type: "host.place-activity-cleared";
      place: import("@opensteer/core").PlaceIdentity;
      runId: RunId;
      generation: number;
      seq: number;
    };

export interface TabPlaceHooks {
  write(input: {
    runId: RunId;
    bindingGeneration: number;
    data: EventData<"place.entered">;
  }): Promise<boolean>;
  notice(
    ownerId: UserId,
    notice: z.infer<typeof import("@opensteer/protocol").TabPlaceActivityNoticeSchema>,
  ): void;
}

interface BrowserServiceOptions {
  readonly requireAgentAccess?: (runnerId: RunnerId) => Promise<void>;
  /** Whether agents may see this computer's tabs, online or not; refuses like `requireAgentAccess`. */
  readonly requireAgentVisibility?: (runnerId: RunnerId) => Promise<void>;
  readonly detachRunnerAgents?: (runnerId: RunnerId) => Promise<readonly BrowserSessionId[]>;
  readonly deploymentId: DeploymentId;
  readonly hostOrigin: URL;
  readonly personal?: boolean;
  readonly profileRequestRunner?: (runId: RunId) => Promise<RunnerId | null>;
  readonly history?: BrowserHistoryStore;
  readonly onHistoryChanged?: (ownerId: UserId, profileId: BrowserProfileId) => void;
  readonly passkeys?: boolean;
  readonly passkeyOwnOrigins?: () => readonly string[];
  readonly onProfilesChanged?: (ownerId: UserId) => void;
  readonly tabs?: TabStore;
  readonly tabPlaces?: TabPlaceHooks;
  readonly onTabsChanged?: (
    ownerId?: UserId,
    tabIds?: readonly BrowserSurfaceId[],
    stateChanged?: boolean,
  ) => void;
  readonly onMissingActor?: (sessionId: BrowserSessionId, agentBindingId: string) => void;
  readonly onPlaceNotice?: (ownerId: UserId, notice: BrowserPlaceActivityNotice) => void;
  readonly connectTimeoutMs?: number;
  readonly onSessionsChanged: (sessionIds: readonly BrowserSessionId[]) => void;
  /**
   * What a person sees about one browser changed: its page, or whether an
   * agent is acting in it. These change often, so they never reread a list.
   */
  readonly onUsageChanged?: (credits: readonly BrowserUsageCredit[]) => void;
  /** A best-effort write that failed after the agent was already answered. */
  readonly onError?: (error: unknown) => void;
  /** Drives activity expiry and place coalescing; browser commands and connection deadlines use real time. */
  readonly activityClock?: Clock;
  readonly actingWindowMs?: number;
  readonly actorMetadataTimeoutMs?: number;
  readonly localProfiles?: BrowserLocalProfiles;
  readonly eraseLocalProfiles?: (runnerId: RunnerId) => Promise<void>;
  readonly repository: BrowserSessionRepository;
  readonly signer: BrowserAttachTicketSigner;
  readonly targetResolver?: BrowserRuntimeTargetResolver;
  /** Each pooled Cloud Computer's coordinator, by its Runner; empty for an ordinary Home. */
  readonly pools?: ReadonlyMap<RunnerId, BrowserPoolCoordinator>;
  /**
   * A pooled Cloud Computer's Runner, before its coordinator is chosen: the startup sweep keeps
   * that Runner's sessions for the coordinator to reattach or end with their notes.
   */
  readonly pooledRunner?: RunnerId;
  /** New sessions' ids (a random one each by default); a search derives them from its seed. */
  readonly newSessionId?: () => BrowserSessionId;
}

/**
 * The Host owns the single upstream Browser Runtime connection. UI clients attach
 * as bounded consumers; future agent controllers can use the same broker boundary.
 */
interface BrowserActor {
  readonly token: string;
  readonly binding: string;
  readonly sessionId: BrowserSessionId;
  readonly ownerId: UserId;
  readonly generation: number;
  readonly runId: RunId;
  lineageThreadIds: readonly ThreadId[];
  readonly audience: Map<UserId, { threadId: ThreadId }>;
  readonly surfaces: Map<
    string,
    {
      at: number;
      seq: number;
      heldAt?: number;
      recordedPage?: { readonly key: string; readonly at: number };
    }
  >;
  usageTail?: Promise<void>;
  seq: number;
}

type StandardCdpAuthority = Pick<StandardCdpFacts, "grantRevision" | "agentConnectionId"> & {
  readonly mode: import("@opensteer/core").ThreadAccessMode;
  readonly threadId: ThreadId | null;
};
interface StandardCdpEntry {
  readonly claims: StandardCdpTicketClaims;
  runnerId?: RunnerId;
  mode?: StandardCdpMode;
  since?: string;
  close(reason: string): void;
}

export class BrowserService {
  readonly #deploymentId: DeploymentId;
  readonly #personal: boolean;
  readonly #profileRequestRunner: BrowserServiceOptions["profileRequestRunner"];
  readonly #nativeActivity = new Map<
    string,
    { activity: BrowserPlaceActivity; ownerId: UserId; title: string; timer: (() => void) | null }
  >();
  readonly #actors = new Map<string, BrowserActor>();
  readonly #actorKeys = new Map<string, string | null>();
  /** Shadow comparisons of the catalog with what each session's runtime reports. */
  readonly #shadows = new Map<BrowserSessionId, ShadowHostSession>();
  /** Reads every shadow comparison's cut, one at a time for the whole Host. */
  readonly #shadowReader = new ShadowReader();
  readonly #activityTimers = new Map<string, NodeJS.Timeout>();
  readonly #activityPending = new Map<
    string,
    { actor: BrowserActor; activity: BrowserRuntimeActivity; order: number; at: number }
  >();
  readonly #history: BrowserHistoryStore | undefined;
  readonly #historyTails = new Map<BrowserProfileId, Promise<unknown>>();
  readonly #onHistoryChanged: NonNullable<BrowserServiceOptions["onHistoryChanged"]>;
  readonly #workspaceTabs: TabStore | undefined;
  readonly #onTabsChanged: NonNullable<BrowserServiceOptions["onTabsChanged"]>;
  /**
   * Pages whose saved URL is a destination their runtime has not committed yet (an intended
   * open or a restore); the runtime's interim about:blank must not replace it.
   */
  readonly #pagesAwaitingNavigation = new Set<BrowserSurfaceId>();
  readonly #workspacePageGenerations = new Map<string, number>();
  /**
   * Pages a task's own open is adding to a browser the person started. The Home learns which page
   * an open created only from its answer, so until then no new page of that browser is recorded
   * as the person's.
   */
  readonly #taskPageOpens = new Map<
    BrowserSessionId,
    { inFlight: number; readonly openers: Map<BrowserSurfaceId, TabOpenedBy> }
  >();
  readonly #closeResults = new Map<
    string,
    { fingerprint: string; outcome: BrowserTabCloseResult["outcome"] }
  >();
  readonly #onProfilesChanged: NonNullable<BrowserServiceOptions["onProfilesChanged"]>;
  readonly #onMissingActor: NonNullable<BrowserServiceOptions["onMissingActor"]>;
  readonly #tabPlaceNotice: TabPlaceHooks["notice"];
  readonly #onPlaceNotice: NonNullable<BrowserServiceOptions["onPlaceNotice"]>;
  #placeOrder = 0;
  #placeSequence = 0;
  #authorityGeneration = 0;
  readonly #actorEpochs = new Map<string, number>();
  readonly #holdings = new Map<BrowserSessionId, ReadonlySet<string>>();
  readonly #actorResolutions = new Map<string, Promise<void>>();
  readonly #sessionOperations = new Map<string, Promise<unknown>>();
  readonly #runPlaces: RunPlaceRecorder;

  readonly #tabDescriptorTimers = new Map<BrowserSessionId, NodeJS.Timeout>();
  readonly #pendingPageCloses = new Map<
    BrowserSessionId,
    Map<BrowserSurfaceId, { fence?: Promise<void>; initial: Promise<void> }>
  >();
  readonly #brokers = new Map<BrowserSessionId, HostedBrowserBroker>();
  readonly #personUseGroups = new Map<
    BrowserSessionId,
    {
      tabs: Set<BrowserSurfaceId>;
      ended: boolean;
      ownerId: UserId;
      profileId: BrowserProfileId | null;
    }
  >();
  #endPersonUse(groupId: BrowserSessionId): void {
    const group = this.#personUseGroups.get(groupId);
    if (group) {
      group.ended = true;
      group.tabs.clear();
    }
    this.#personUseGroups.delete(groupId);
  }
  readonly #requestPins = new Map<
    string,
    readonly {
      sessionId: BrowserSessionId;
      runId: RunId | null;
      surfaceId: BrowserSurfaceId | null;
    }[]
  >();
  #validateLoginLease: LoginLeaseValidator | undefined;
  readonly #passkeys: boolean;
  readonly #passkeyOwnOrigins: () => readonly string[];
  readonly #authConsumers = new Map<AuthSessionId, Set<BrowserConsumerPeer>>();
  readonly #connectTimeoutMs: number;
  readonly #onSessionsChanged: (sessionIds: readonly BrowserSessionId[]) => void;
  readonly #onUsageChanged: NonNullable<BrowserServiceOptions["onUsageChanged"]>;
  readonly #onError: NonNullable<BrowserServiceOptions["onError"]>;
  readonly #activityClock: Clock;
  readonly #actingWindowMs: number;
  readonly #actorMetadataTimeoutMs: number;
  /** When each agent binding last sent a command to each live session. */
  readonly #agentCommands = new Map<BrowserSessionId, Map<string, number>>();
  readonly #actingTimers = new Map<BrowserSessionId, () => void>();
  /** Bindings whose Run ended, by when; see `endedBindingMemoryMs`. */
  readonly #endedBindings = new Map<string, number>();
  readonly #actionAttachments = new Map<
    string,
    {
      readonly binding: string;
      readonly profileId: BrowserProfileId | null;
      readonly ownerId: UserId;
      readonly close: () => void;
    }
  >();
  /** What each session's viewers were last told, so a repeat is not sent. */
  readonly #announcedPresence = new Map<BrowserSessionId, string>();
  readonly #agentAdmissions = new KeyedMutationQueue();
  readonly #runnerAccessGeneration = new Map<RunnerId, number>();
  #accessGeneration = 0;
  readonly #deviceAccessDisabled = new Error("This device's browser access was turned off.");
  readonly #requireAgentAccess: (runnerId: RunnerId) => Promise<void>;
  readonly #requireAgentVisibility: (runnerId: RunnerId) => Promise<void>;
  readonly #detachRunnerAgents: BrowserServiceOptions["detachRunnerAgents"];
  readonly standardCdpTickets = new StandardCdpTickets();
  readonly #standardCdpAttachments = new Map<string, StandardCdpEntry>();
  readonly #standardCdpProfiles = new StandardCdpProfileLeases();
  readonly #deviceAttachments = new Map<
    string,
    { runnerId: RunnerId; close: () => void; binding?: string }
  >();
  readonly #inRunnerAdmission = new AsyncLocalStorage<boolean>();
  withRunnerAdmission<T>(runnerId: RunnerId, action: () => Promise<T>): Promise<T> {
    return this.#agentAdmissions.run(runnerId, () => this.#inRunnerAdmission.run(true, action));
  }

  #runProfileLane<T>(
    profileId: BrowserProfileId | null,
    operation: (waited: boolean) => Promise<T>,
  ): Promise<T> {
    if (profileId && this.#inRunnerAdmission.getStore()) {
      throw new Error(
        `BrowserService lock-order violation: profile lane (${profileId}) acquired inside runner admission lane.`,
      );
    }
    return this.#standardCdpProfiles.run(profileId, operation);
  }

  /**
   * Admits an agent and sends its command in the computer's admission lane, so
   * turning browser access off cannot land between them; the answer is awaited
   * after the lane is released. Without an agent the command is the person's.
   */
  async disableAgentAccess(runnerId: RunnerId): Promise<void> {
    this.#accessGeneration++;
    this.#runnerAccessGeneration.set(
      runnerId,
      (this.#runnerAccessGeneration.get(runnerId) ?? 0) + 1,
    );
    for (const waiters of this.#poolAgentWaiters.values())
      for (const waiter of waiters)
        if (waiter.runnerId === runnerId) waiter.controller.abort(this.#deviceAccessDisabled);
    for (const attachment of this.#deviceAttachments.values())
      if (attachment.runnerId === runnerId) attachment.close();
    const detached = await this.#detachRunnerAgents?.(runnerId);
    if (detached?.length) {
      for (const sessionId of detached) {
        this.#holdings.delete(sessionId);
        this.#forgetLastHeldSession(sessionId);
        this.#forgetActing(sessionId);
        for (const actor of this.#actors.values())
          if (actor.sessionId === sessionId) this.#clearActor(actor);
      }
      this.#onSessionsChanged(detached);
    }
  }
  readonly #repository: BrowserSessionRepository;
  readonly #localProfiles: BrowserLocalProfiles | undefined;
  readonly #eraseLocalProfiles: BrowserServiceOptions["eraseLocalProfiles"];
  readonly #sessionProfiles = new Map<BrowserSessionId, BrowserProfileId>();
  readonly #lastHeldBindingBySession = new Map<BrowserSessionId, string>();
  readonly #lastHeldSessionByBinding = new Map<string, BrowserSessionId>();
  readonly #signer: BrowserAttachTicketSigner;
  readonly #targetResolver: BrowserRuntimeTargetResolver | undefined;
  /** Held here by Runner, so a Runner that is away or removed still has its coordinator. */
  readonly #pools: Map<RunnerId, BrowserPoolCoordinator>;
  readonly #pooledRunner: RunnerId | undefined;
  readonly #newSessionId: () => BrowserSessionId;
  readonly #poolWaiters = new Map<BrowserSessionId, Set<AbortController>>();
  readonly #poolAgentWaiters = new Map<
    string,
    Set<{ readonly controller: AbortController; readonly runnerId?: RunnerId }>
  >();
  readonly #closing = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #operationTail = Promise.resolve();

  constructor(options: BrowserServiceOptions) {
    this.#pools = new Map(options.pools ?? []);
    this.#newSessionId = options.newSessionId ?? createBrowserSessionId;
    // A Home given a pool is a pooled computer, its coordinator here or not later (W11).
    this.#pooledRunner = options.pooledRunner ?? [...(options.pools?.keys() ?? [])][0];
    // A personal Home has one pooled Cloud Computer at most: the startup sweep keeps its rows.
    if (this.#pools.size > 1) throw new Error("A Home serves at most one pooled browser.");
    this.#requireAgentAccess = options.requireAgentAccess ?? (async () => {});
    this.#requireAgentVisibility = options.requireAgentVisibility ?? (async () => {});
    this.#detachRunnerAgents = options.detachRunnerAgents;
    this.#deploymentId = options.deploymentId;
    this.#personal = options.personal === true;
    this.#profileRequestRunner = options.profileRequestRunner;
    this.#localProfiles = options.localProfiles;
    this.#eraseLocalProfiles = options.eraseLocalProfiles;
    this.#passkeys = options.passkeys === true;
    this.#passkeyOwnOrigins = options.passkeyOwnOrigins ?? (() => [options.hostOrigin.origin]);
    this.#history =
      options.history ??
      (options.repository instanceof OpensteerStore
        ? options.repository.browserHistory
        : undefined);
    this.#onHistoryChanged = options.onHistoryChanged ?? (() => undefined);
    this.#workspaceTabs = options.tabs;
    this.#onTabsChanged = options.onTabsChanged ?? (() => undefined);
    this.#onMissingActor = options.onMissingActor ?? (() => undefined);
    if (options.tabs && !options.tabPlaces)
      throw new Error("Workspace tabs require tab-place persistence and publication hooks.");
    this.#tabPlaceNotice = options.tabPlaces?.notice ?? (() => {});
    this.#onPlaceNotice = (ownerId, notice) => {
      if (!options.tabs) {
        options.onPlaceNotice?.(ownerId, notice);
        return;
      }
      if (notice.type === "host.place-activity") {
        const { place, ...activity } = notice.activity;
        if (place.kind === "browser")
          options.tabPlaces!.notice(ownerId, {
            type: notice.type,
            activity: { ...activity, tabId: place.surfaceId },
          });
      } else {
        const { place, ...cleared } = notice;
        if (place.kind === "browser")
          options.tabPlaces!.notice(ownerId, { ...cleared, tabId: place.surfaceId });
      }
    };
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.#onSessionsChanged = (sessionIds) => {
      for (const id of sessionIds) {
        this.#brokers.get(id)?.refreshSessionState();
        // Attachments changed: who may use the session is part of its comparison.
        this.#shadows.get(id)?.catalogChanged();
      }
      this.#invalidatePageSessions(sessionIds);
      options.onSessionsChanged(sessionIds);
    };
    this.#onTabsChanged();
    this.#onProfilesChanged = (ownerId) => {
      this.#onTabsChanged(ownerId);
      options.onProfilesChanged?.(ownerId);
    };
    this.#onUsageChanged = options.onUsageChanged ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#activityClock = options.activityClock ?? systemClock;
    this.#actingWindowMs = options.actingWindowMs ?? browserActingWindowMs;
    this.#actorMetadataTimeoutMs = options.actorMetadataTimeoutMs ?? browserActorMetadataTimeoutMs;
    this.#runPlaces = new RunPlaceRecorder({
      clock: this.#activityClock,
      write: (input) =>
        options.tabPlaces?.write(input) ?? this.#repository.recordRunTabPlace(input),
      onError: (error) => this.#onError(error),
    });
    this.#repository = options.repository;
    this.#signer = options.signer;
    this.#targetResolver = options.targetResolver;
  }

  get available(): boolean {
    return Boolean(this.#targetResolver) && !this.#closed;
  }

  get usesPoolAdmission(): boolean {
    return this.#pools.size > 0;
  }

  isPlacementReady(runnerId: RunnerId, runtimeId: string): boolean {
    if (this.#closed) return false;
    try {
      return this.#targetResolver?.resolve({ kind: "runner", runnerId })?.runtimeId === runtimeId;
    } catch (error) {
      if (error instanceof OpensteerError && error.code === "runner_offline") return false;
      throw error;
    }
  }

  pooledDirectBrowser(runnerId: RunnerId) {
    const pool = this.#pool(runnerId);
    if (!pool) return undefined;
    return {
      identity: () => pool.identity(),
      reserve: (signal: AbortSignal) => pool.gate.reserve(signal),
      /**
       * The page's document: live, or while the browser is away the one last known. Null: its
       * session is being reattached and no document is known (after a Home crash); undefined:
       * there is no such page.
       */
      pageDocument: (sessionId: BrowserSessionId, tabId: TabId): string | null | undefined =>
        this.pageInventory(sessionId)?.records.get(tabId)?.documentId ??
        (pool.gate.retiringOrAdopting
          ? (pool.knownDocument(sessionId, tabId) ??
            (pool.reattaching(sessionId) ? null : undefined))
          : undefined),
    };
  }

  async pooledScriptPageWitness(ownerId: UserId, sessionId: BrowserSessionId, tabId: TabId) {
    const tab = await this.#workspaceTabs?.get(ownerId, tabId);
    const documentId = this.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    if (
      tab?.pageBinding?.sessionId !== sessionId ||
      tab.pageBinding.surfaceId !== tabId ||
      !tab.profileId ||
      !documentId
    )
      return undefined;
    return JSON.stringify([tab.profileId, tab.generation, tab.pageBinding.lineageId, documentId]);
  }

  /**
   * A pooled Cloud Computer's coordinator, chosen by its Home's target service for the target it
   * read (phase B, W6): nothing else adds one, and a Home with no target has none.
   */
  async adoptPool(runnerId: RunnerId, coordinator: BrowserPoolCoordinator): Promise<void> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    if (this.#pools.size && !this.#pools.has(runnerId))
      throw new Error("A Home serves at most one pooled browser.");
    if (this.#pools.has(runnerId))
      throw new Error("This pooled browser already has a coordinator.");
    this.#pools.set(runnerId, coordinator);
    coordinator.setAdopter(this.#poolAdopter(runnerId));
    // Its first recovery is not awaited here: a pool host that does not answer holds this
    // browser's gate closed, never the Home's start.
    void coordinator.recover().catch((error: unknown) => this.#onError(error));
  }

  /**
   * W8: a replaced target that still holds Stops waiting for its word. Its coordinator, in drain
   * mode, asks it until none waits (each ended by evidence about that target), then goes. Only its
   * end requests and status reads are sent; it serves nothing.
   */
  drainPool(runnerId: RunnerId, coordinator: BrowserPoolCoordinator): Promise<void> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    this.#draining.add(coordinator);
    coordinator.setAdopter(this.#poolAdopter(runnerId, true));
    const drained = coordinator.drain();
    void drained.finally(() => this.#draining.delete(coordinator)).catch(() => undefined);
    return drained;
  }

  /** Replaced targets being drained (W8). */
  readonly #draining = new Set<BrowserPoolCoordinator>();

  /**
   * A different target replaces this one: everything in flight on it ends (each with its
   * outcome or its note), and the coordinator goes. The next one is adopted on its own.
   */
  async retirePool(runnerId: RunnerId, reason: string): Promise<void> {
    const coordinator = this.#pools.get(runnerId);
    if (!coordinator) return;
    try {
      await coordinator.retire(reason);
    } finally {
      this.#pools.delete(runnerId);
    }
    this.#onTabsChanged();
  }

  async initialize(): Promise<void> {
    if (this.#personal) {
      const pooled = [...this.#pools.keys()][0] ?? this.#pooledRunner;
      if (pooled) await this.#repository.failActiveBrowserSessions(undefined, pooled);
      else await this.#repository.failActiveBrowserSessions();
    }
    await this.pruneHistory();
    for (const [runnerId, pool] of this.#pools) {
      // The gate stays closed until the state the sweep kept is recovered. Recovery is not
      // waited for: while its host does not answer it goes on for as long as that lasts, and the
      // Home starts all the same (as adoptPool does).
      pool.setAdopter(this.#poolAdopter(runnerId));
      void pool.recover().catch((error: unknown) => this.#onError(error));
    }
  }

  /**
   * The Home's per-session part of a pooled adoption; one session's failure is its own. Only a
   * pooled target's coordinator calls it, so no ordinary Home reaches any of it.
   */
  #poolAdopter(runnerId: RunnerId, draining = false): BrowserPoolAdopter {
    if (!draining && !this.#pools.has(runnerId))
      throw new Error("Only the pooled target adopts retained sessions.");
    return {
      inventory: () =>
        [...this.#brokers]
          .filter(([, broker]) => broker.pooled && broker.live)
          .flatMap(([sessionId]) =>
            [...(this.pageInventory(sessionId)?.records.keys() ?? [])].map((surfaceId) => ({
              sessionId,
              surfaceId,
            })),
          ),
      live: (sessionId) => this.#brokers.get(sessionId)?.live === true,
      pagesOf: async (sessionId) => {
        if (!(this.#repository instanceof OpensteerStore)) return [];
        const owner = await readBrowserPoolOwner(this.#repository.database);
        return owner ? (await this.savedPages(owner, sessionId)).map((tab) => tab.id) : [];
      },
      withoutChannel: async (target) => {
        // No live Runner is needed: a Runner that is away still has its sessions.
        if (!(this.#repository instanceof OpensteerStore)) return [];
        const ready = await listBrowserPoolReadySessions(this.#repository.database, target);
        // A ready session whose broker is gone or no longer live has no channel here.
        return ready.filter((sessionId) => !this.#brokers.get(sessionId)?.live);
      },
      ending: async (target) => {
        if (!(this.#repository instanceof OpensteerStore)) return [];
        const closing = await listBrowserPoolClosingSessions(this.#repository.database, target);
        // One with a broker is being stopped through it.
        return closing.filter((sessionId) => !this.#brokers.has(sessionId));
      },
      endTicket: async ({ sessionId, fence, runtimeId, signal }) => {
        if (this.#closed || !(this.#repository instanceof OpensteerStore)) return undefined;
        const owner = await readBrowserPoolOwner(this.#repository.database);
        const record = owner
          ? await this.#repository.getBrowserSessionForOwner(sessionId, owner)
          : null;
        signal?.throwIfAborted();
        // A row another path already ended has nothing left to end.
        if (!record || isTerminal(record.state)) return "gone";
        if (
          record.state !== "closing" ||
          record.runnerId !== runnerId ||
          record.runtimeId !== runtimeId
        )
          return undefined;
        const origin = record.origin === "person" ? "person" : "agent";
        // Only an end: the runtime refuses this ticket on every attach, and finds the session by
        // its id (the identity is not what it ends).
        return this.#signer.issue({
          creationOrigin:
            origin === "person" && record.opener?.kind === "person" ? "person" : "agent",
          actor: origin,
          access: "read-write",
          pool: { ...fence, end: true },
          identity: { kind: "fresh" },
          runtimeId,
          sessionId,
          subject: owner!,
        });
      },
      ended: async (sessionId, target, evidence = { kind: "runtime-ended" }) => {
        // Only a row still closing: another path that ended it has its own evidence.
        const owner =
          this.#repository instanceof OpensteerStore
            ? await readBrowserPoolOwner(this.#repository.database)
            : undefined;
        const row = owner
          ? await this.#repository.getBrowserSessionForOwner(sessionId, owner)
          : null;
        if (row?.state !== "closing") return;
        await this.#transitionBrowserSession({
          from: ["closing"],
          sessionId,
          state: "closed",
          evidence,
          target,
        });
      },
      quiesce: async (signal) => {
        if (!(this.#repository instanceof OpensteerStore)) return;
        // Its target's own, known with or without a slot row yet.
        const sessions = await listBrowserPoolRuntimeSessions(
          this.#repository.database,
          this.#pools.get(runnerId)!.ownSessions,
        );
        // An unredeemed ticket would hold the gate until it expires, or attach meanwhile.
        this.standardCdpTickets.revokePooled((claims) =>
          sessions.includes(claims.browserSessionId),
        );
        for (const entry of this.#standardCdpAttachments.values())
          if (entry.runnerId === runnerId) entry.close("This browser is restarting.");
        // Each socket is ended at once; waiting for the brokers to finish ends with the step.
        const detached = Promise.all(
          sessions.map((sessionId) =>
            this.#brokers.get(sessionId)?.detachPooled("This browser is restarting."),
          ),
        );
        if (!signal) return void (await detached);
        void detached.catch(() => undefined);
        await withTimeout(detached, quiesceDetachMs, {
          signal,
          timeoutError: () => new Error("A pooled browser did not let go in time."),
        });
      },
      reattach: async ({ sessions, documents, fence, attempt, signal }) => {
        const losses: BrowserPoolSessionLoss[] = [];
        for (const sessionId of sessions) {
          if (signal?.aborted) break;
          try {
            losses.push(
              ...(await this.#adoptPooledSession(
                runnerId,
                sessionId,
                documents,
                fence,
                attempt,
                signal,
              )),
            );
          } catch (error) {
            // This session is not reattached; the runtime reports it lost, the rest proceed.
            this.#onError(error);
          }
        }
        return losses;
      },
    };
  }

  /** A ready session is reattached under a fresh attempt and kept. */
  async #adoptPooledSession(
    runnerId: RunnerId,
    sessionId: BrowserSessionId,
    documents: readonly BrowserPoolDocument[],
    fence: BrowserPoolRuntimeFence,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly BrowserPoolSessionLoss[]> {
    const pool = this.#pool(runnerId);
    const target = this.#resolveTarget({ kind: "runner", runnerId });
    if (!pool || !target || this.#closed || !(this.#repository instanceof OpensteerStore))
      return [];
    const database = this.#repository.database;
    const owner = await readBrowserPoolOwner(database);
    const record = owner
      ? await this.#repository.getBrowserSessionForOwner(sessionId, owner)
      : null;
    // Stop or Disconnect while parked already ended this row: it is not reattached.
    if (
      !record ||
      record.state !== "ready" ||
      // Adoption does not rebuild a Trigger's session yet; a stopped one is ended by its runtime.
      record.origin === "trigger" ||
      record.runnerId !== runnerId ||
      record.runtimeId !== target.runtimeId ||
      record.placementKey !== target.placementKey
    )
      return [];
    const ownerId = owner!;
    const profile = record.profileId
      ? await this.#repository.getBrowserProfile(record.profileId, ownerId)
      : null;
    let identity: Parameters<BrowserAttachTicketSigner["issue"]>[0]["identity"] = { kind: "fresh" };
    if (record.profileId) {
      if (profile?.homeRunnerId !== runnerId || !this.#localProfiles)
        throw new Error("The pooled profile is not on this computer.");
      const local = await this.#localProfiles.identity(
        record.profileId,
        runnerId,
        target,
        false,
        signal,
      );
      if (!local.initialized) throw new Error("The pooled profile has no storage.");
      identity = local;
    }
    signal?.throwIfAborted();
    const origin = record.origin === "person" ? "person" : "agent";
    // A Stop that committed during the lookups above wins: the row is read again before attach.
    const stillReady = async () =>
      (await this.#repository.getBrowserSessionForOwner(sessionId, ownerId))?.state === "ready";
    const adopting = { active: true };
    // Under Stop's own lane: the row is read again, the lineage read, the ticket sent and the
    // broker registered, so a Stop either commits before (nothing is attached) or finds the broker.
    // The wait to enter the lane ends with the attempt; once entered, the lane is awaited, never
    // abandoned, and once the attempt has ended nothing in it is sent.
    let entered = false;
    const lane = this.#serialize(async () => {
      entered = true;
      if (signal?.aborted || !(await stillReady()) || this.#closed) return undefined;
      // Person use is keyed by the session's persistent lineage, which survives the old broker.
      const groupId = (await readBrowserPoolSessionLineage(database, sessionId)) ?? sessionId;
      if (signal?.aborted) return undefined;
      const socket = target.connect(
        this.#signer.issue({
          creationOrigin:
            origin === "person" && record.opener?.kind === "person" ? "person" : "agent",
          actor: origin,
          access: "read-write",
          reattach: true,
          pool: { ...fence, attachment: attempt },
          identity,
          runtimeId: target.runtimeId,
          sessionId,
          subject: ownerId,
          ...(target.tabRestoreVersion ? { tabRestoreVersion: 1 as const } : {}),
          ...(target.surfaceState ? { surfaceState: target.surfaceState } : {}),
          ...(target.basicInput ? { basicInput: target.basicInput } : {}),
          ...(target.navigationVersion ? { navigationVersion: 1 as const } : {}),
          ...(target.navigationAttributionVersion
            ? { navigationAttributionVersion: 1 as const }
            : {}),
          ...(target.popupFollowVersion ? { popupFollowVersion: 1 as const } : {}),
          ...(target.editing ? { editingVersion: target.editing } : {}),
          ...(target.editing === 2 ? { clipboard: target.clipboard === true } : {}),
        }),
      );
      // The person's use of tabs survives the park with the session.
      const personUse = this.#personUseGroups.get(groupId) ?? {
        tabs: new Set<BrowserSurfaceId>(),
        ended: false,
        ownerId,
        profileId: record.profileId,
      };
      const broker = new HostedBrowserBroker({
        poolAdmission: this.#poolAdmission(pool, adopting),
        onChannelLost: (documents) => pool.channelLost(sessionId, documents),
        adoptedFromPool: true,
        personUse,
        onPersonUseChanged: () => {
          if (personUse.ended) return;
          if (personUse.tabs.size) this.#personUseGroups.set(groupId, personUse);
          else if (this.#personUseGroups.get(groupId) === personUse)
            this.#personUseGroups.delete(groupId);
        },
        sessionId,
        socket,
        groupId,
        profileId: record.profileId,
        tabRestoreVersion: target.tabRestoreVersion === true,
        ...(this.#workspaceTabs
          ? {
              personTabGeneration: async (surfaceId: BrowserSurfaceId) => {
                const tab = await this.#workspaceTabs!.get(ownerId, surfaceId);
                return tab?.pageBinding?.sessionId === sessionId ? tab.generation : null;
              },
            }
          : {}),
        historyWrite: (operation) => {
          if (!this.#history || !profile) return;
          void this.#historyOperation(profile.id, async () => {
            if (await operation(this.#history!)) this.#onHistoryChanged(ownerId, profile.id);
          }).catch(() => this.#onError(new Error("Browser history persistence failed")));
        },
        readSessionState: () => this.#sessionState(sessionId),
        onPageChanged: () => this.#announcePresence(sessionId),
        onTabsChanged: (structural) => {
          if (structural) void this.#flushTabDescriptors(sessionId).catch(this.#onError);
          else this.#queueTabDescriptors(sessionId);
        },
        onRecordsChanged: (ids) => this.tabInventoryChanged(sessionId, ids),
        onActivity: (activity) => this.#runtimeActivity(sessionId, activity),
        cdpBoundary: target.cdpBoundary === true,
        agentActions: target.agentActions === true,
        basicInput: target.basicInput,
        surfaceState: target.surfaceState,
        sharedControl: target.sharedControl === true,
        navigation: target.navigationVersion === true,
        targetControl: target.targetControl === true,
        captureRegion: target.captureRegion === true,
        rasterDemand: target.rasterDemand === true,
        passkeys: false,
        passkeyOwnOrigins: this.#passkeyOwnOrigins,
        editing: target.editing,
        clipboard: target.editing === 1 || target.clipboard === true,
        computer: target.computer ?? null,
        connectTimeoutMs: this.#connectTimeoutMs,
        fileStaging: false,
        signIn: false,
        stateImport: false,
        // A pooled broker says closed only on its runtime's `closed` status (P16): that runtime,
        // under the fence its ticket named, ended the session (V1).
        onState: (state) =>
          state === "closed"
            ? this.#transitionBrowserSession({
                from: ["closing"],
                sessionId,
                state,
                evidence: { kind: "runtime-ended" },
                target: { slotId: fence.slot, term: fence.term },
              })
            : // A reattach that did not take ends nothing: the session stays ready for the next
              // attempt, and its window's end records the loss with its note.
              state === "failed"
              ? Promise.resolve(record)
              : this.#transitionBrowserSession({
                  ...(state === "ready" ? { from: ["starting", "ready"] as const } : {}),
                  sessionId,
                  state,
                }),
        onTerminal: () => {
          if (this.#brokers.get(sessionId) === broker) {
            this.#brokers.delete(sessionId);
            this.#sessionProfiles.delete(sessionId);
          }
          this.#onTabsChanged();
        },
      });
      this.#brokers.set(sessionId, broker);
      if (record.profileId) this.#sessionProfiles.set(sessionId, record.profileId);
      return broker;
    });
    const broker = await enteredOrAborted(lane, () => entered, signal);
    if (!broker) return [];
    let stopped = false;
    try {
      await withTimeout(broker.ready(), this.#connectTimeoutMs, {
        ...(signal ? { signal } : {}),
        timeoutError: () => new Error("The retained browser session did not reattach."),
      });
      // Stop may have taken the row while the channel attached: then it is not adopted, and the
      // channel is ended before this returns. The row is the Stop's: closing until the runtime's
      // own word (the adoption leaves the session out), never written here.
      if (!(await stillReady())) {
        stopped = true;
        await broker.detachPooled(
          "The retained browser session was stopped while it reattached.",
          signal,
        );
        pool.stopped();
        throw new Error("The retained browser session was stopped while it reattached.");
      }
      const live = this.pageInventory(sessionId)?.records;
      const losses: { surfaceId: string; documentId: string | null }[] = [];
      for (const document of documents.filter((document) => document.sessionId === sessionId)) {
        const tab = await this.#workspaceTabs?.get(ownerId, document.surfaceId, true);
        const page = live?.get(document.surfaceId);
        if (!page) {
          losses.push({ surfaceId: document.surfaceId, documentId: document.documentId });
          continue;
        }
        // Only a tab the person closed, or one now bound elsewhere, has its page closed.
        if (!tab || (!tab.closedAt && tab.pageBinding?.sessionId === sessionId)) {
          if (page.documentId !== document.documentId)
            losses.push({ surfaceId: document.surfaceId, documentId: document.documentId });
          continue;
        }
        // The person closed this tab while parked: its page closes now, nothing is lost.
        if (this.#workspaceTabs)
          await broker.requestCdp(
            {
              type: "cdp.command",
              requestId: randomUUID(),
              command: {
                method: browserHostMethods.closeTab,
                parameters: {
                  surfaceId: document.surfaceId,
                  inventoryRevision: broker.inventoryRevision,
                },
              },
            },
            signal,
          );
      }
      return losses.length
        ? [{ sessionId, reason: "document-changed", surfaces: losses, endSession: false }]
        : [];
    } catch (error) {
      if (!stopped)
        await broker
          .detachPooled("The retained browser session did not reattach.", signal)
          .catch(() => undefined);
      throw error;
    } finally {
      adopting.active = false;
    }
  }

  /** Every send of a pooled broker: a park before D is vetoed, a send after it waits. */
  #poolAdmission(
    pool: BrowserPoolCoordinator,
    adopting?: { active: boolean },
  ): PoolBrokerAdmission {
    const pass: BrowserPoolReservation = { release: () => {} };
    return {
      now: () => (adopting?.active ? pass : pool.gate.backgroundNow()),
      wait: (signal) => (adopting?.active ? Promise.resolve(pass) : pool.gate.background(signal)),
      retiring: () => pool.gate.retiringOrAdopting,
      // An adoption's pass has no end of its own; a restart's or a removal's hold still refuses.
      refusesWrite: (reservation) => pool.gate.refusesWrite(reservation),
    };
  }

  async workspaceBootstrap(
    ownerId: UserId,
  ): Promise<import("@opensteer/protocol").HostedBrowserBootstrap> {
    const [profiles, homes] = await Promise.all([
      this.#repository.listBrowserProfiles(ownerId),
      this.#repository.listEligibleBrowserRunners(ownerId),
    ]);
    if (profiles.length > maxBrowserProfiles)
      throw new OpensteerError({ code: "conflict", message: "Browser catalog limit exceeded." });
    return {
      profileHomes: homes.map((home) => home.id),
      profiles: profiles.map(publicProfile),
      available:
        !this.#closed && this.#eligiblePlacements(homes).some((placement) => placement.available),
      placements: this.#eligiblePlacements(homes).map(publicPlacement),
      ...(this.#localProfiles
        ? { profileDeletions: await this.#localProfiles.pendingDeletions(ownerId) }
        : {}),
    };
  }

  resourcePlacements(ids?: readonly RunnerId[]): BrowserPlacement[] {
    if (this.#closed) return [];
    const allowed = ids && new Set(ids);
    return (this.#targetResolver?.placements(ids) ?? [])
      .filter(({ runnerId }) => !allowed || allowed.has(runnerId))
      .map(publicPlacement);
  }

  #placeData(sessionId: BrowserSessionId, surfaceId: BrowserSurfaceId) {
    const page = this.#brokers.get(sessionId)?.pageOf(surfaceId);
    if (!page) return null;
    let site: string | null = null;
    try {
      const { origin } = new URL(page.site);
      site = origin === "null" ? null : origin;
    } catch {
      /* A page with no site still has a place. */
    }
    return {
      place: { kind: "browser" as const, sessionId, surfaceId },
      title: page.title.slice(0, 256),
      site,
    };
  }

  /** Only people create profiles; every device of theirs learns of it, not just the one that asked. */
  async createProfile(input: {
    readonly homeRunnerId?: RunnerId | null;
    readonly name: string;
    readonly ownerId: UserId;
    readonly idempotencyKey: string;
    /** `engine-sign-in` keeps it out of every connected agent's grant. */
    readonly purpose?: "person" | "engine-sign-in";
  }): Promise<BrowserProfile> {
    if (!input.homeRunnerId && this.#repository instanceof OpensteerStore) {
      const previous = await this.#repository.database
        .selectFrom("commands")
        .select("payload")
        .where("requestedBy", "=", input.ownerId)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        const request = z
          .object({ request: z.object({ homeRunnerId: z.string().nullable().optional() }) })
          .safeParse(previous.payload);
        const homeRunnerId = request.success ? request.data.request.homeRunnerId : undefined;
        const profile = await this.#repository.createBrowserProfile({
          ownerId: input.ownerId,
          name: input.name,
          idempotencyKey: input.idempotencyKey,
          ...(homeRunnerId === undefined
            ? {}
            : { homeRunnerId: homeRunnerId === null ? null : RunnerIdSchema.parse(homeRunnerId) }),
        });
        return publicProfile(profile);
      }
    }
    const homeRunnerId =
      input.homeRunnerId ??
      (await this.#defaultProfileHome(input.ownerId, undefined, input.homeRunnerId === undefined));
    const profile = await this.#repository.createBrowserProfile({ ...input, homeRunnerId });
    await this.#ownerProfilesChanged(input.ownerId);
    return publicProfile(profile);
  }

  async renameProfile(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfile> {
    const profile = await this.#repository.renameBrowserProfile(input);
    await this.#ownerProfilesChanged(input.ownerId);
    return publicProfile(profile);
  }

  /**
   * Deletes a profile, its tabs and its grants at once, then stops its live
   * sessions. The deletion already fences those: they can neither save nor
   * start again, and a Host that stops first fails them on restart, so a stop
   * that fails is reported rather than failing a deletion that has happened.
   */
  async deleteProfile(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<PendingBrowserProfileDeletion | undefined> {
    const { sessionIds, deletion } = await this.#serializeKey(
      `profile-admission:${input.profileId}`,
      () => this.#repository.deleteBrowserProfile(input),
    );
    for (const [id, group] of this.#personUseGroups)
      if (group.profileId === input.profileId) this.#endPersonUse(id);
    this.invalidatePlaceAuthority();
    const stops = await Promise.allSettled(
      sessionIds.map((sessionId) => this.stop(input.ownerId, sessionId)),
    );
    for (const stop of stops) if (stop.status === "rejected") this.#onError(stop.reason);
    if (deletion) await this.#eraseLocalProfiles?.(deletion.computerId).catch(() => undefined);
    await this.#ownerProfilesChanged(input.ownerId);
    // Retried agent operations replay admission; subsequent reads show erasure progress.
    if (input.administration) return deletion;
    return (await this.#localProfiles?.pendingDeletions(input.ownerId))?.find(
      (item) => item.profileId === input.profileId,
    );
  }

  async fenceLocalProfile(profileId: BrowserProfileId): Promise<void> {
    for (const [sessionId, heldProfileId] of this.#sessionProfiles) {
      if (heldProfileId === profileId)
        await this.#brokers.get(sessionId)?.abort("Browser profile storage authority changed.");
    }
  }

  /** Every device of the owner rereads its profiles, on every device. */
  async #ownerProfilesChanged(ownerId: UserId): Promise<void> {
    this.#onProfilesChanged(ownerId);
  }

  async profilesRemoved(
    profiles: readonly { id: BrowserProfileId; ownerId: UserId }[],
  ): Promise<void> {
    this.invalidatePlaceAuthority();
    for (const [id, group] of this.#personUseGroups)
      if (profiles.some((profile) => profile.id === group.profileId)) this.#endPersonUse(id);
    for (const { id } of profiles) await this.fenceLocalProfile(id);
    for (const ownerId of new Set(profiles.map((profile) => profile.ownerId)))
      await this.#ownerProfilesChanged(ownerId);
  }

  async #defaultProfileHome(
    ownerId: UserId,
    request?: { readonly runnerId: RunnerId | null },
    legacy = false,
  ): Promise<RunnerId | null> {
    const homes = await this.#repository.listEligibleBrowserRunners(ownerId);
    const preferred = homes.find((home) => home.id === request?.runnerId);
    const main = this.#personal ? homes.find((home) => home.kind === "main") : undefined;
    const selected = preferred ?? main ?? (homes.length === 1 ? homes[0] : undefined);
    if (selected) return selected.id;
    if (homes.length === 0)
      throw new OpensteerError({
        code: "runner_offline",
        reason: "browser-placement-unavailable",
        message: "No computer can hold your browser profiles.",
      });
    if (legacy) return null;
    throw new OpensteerError({
      code: "conflict",
      reason: "browser-placement-ambiguous",
      message: "Choose a computer for this browser profile.",
    });
  }

  /**
   * Opens a session. One a person opens from a conversation belongs to that
   * conversation from the start, before any Run has used it.
   * Restored sessions keep their opener, so visit attribution is a caller opt-in.
   */
  async start(
    input: StartBrowserSessionInput,
    personNavigation?: { readonly typed: boolean },
  ): Promise<StartBrowserSessionResult> {
    const budget = this.#poolStartBudget(input.operationBudget?.signal);
    try {
      return await this.#startSession(input, personNavigation, budget);
    } finally {
      budget?.pool?.reservation.release();
    }
  }

  async #startSession(
    input: StartBrowserSessionInput,
    personNavigation?: { readonly typed: boolean },
    budget?: BrowserTabOpenBudget,
  ): Promise<StartBrowserSessionResult> {
    const finish = await this.#prepareStart(
      input,
      undefined,
      personNavigation ? { ownerId: input.ownerId, typed: personNavigation.typed } : undefined,
      budget,
    );
    const result = await finish();
    const record = await this.#repository.getBrowserSessionForOwner(
      result.session.id,
      input.ownerId,
    );
    const broker = this.#brokers.get(result.session.id);
    if (
      this.#workspaceTabs &&
      record &&
      broker &&
      record.origin !== "trigger" &&
      record.opener?.kind !== "automation"
    ) {
      const profile = record.profileId
        ? (await this.#repository.listBrowserProfiles(input.ownerId)).find(
            (profile) => profile.id === record.profileId,
          )
        : null;
      for (const descriptor of broker.clientRows(this.#presence(record.id)).records.values()) {
        await this.#workspaceTabs.open(
          {
            id: descriptor.id,
            ownerId: input.ownerId,
            computerId: await this.#selfDeviceId(record.runnerId),
            kind: "page",
            title: descriptor.title,
            url: descriptor.url,
            profileId: record.profileId,
            profileName: profile?.name ?? null,
            openedBy:
              record.opener?.kind === "task" ? { taskId: record.opener.threadId } : "person",
            pageBinding: {
              lineageId: broker.groupId,
              sessionId: record.id,
              surfaceId: descriptor.id,
            },
          },
          `session-start:${record.id}:${descriptor.id}`,
        );
        const admitted = await this.#workspaceTabs.get(input.ownerId, descriptor.id);
        if (admitted)
          this.#workspacePageGenerations.set(`${record.id}:${descriptor.id}`, admitted.generation);
      }
      await this.#flushTabDescriptors(record.id);
      this.#onTabsChanged(input.ownerId);
    }
    if (input.threadId) {
      this.#forgetLastHeldSession(result.session.id);
      this.announceUsage(
        await this.#repository.recordBrowserSessionUse({
          ownerId: input.ownerId,
          sessionId: result.session.id,
          threadId: input.threadId,
        }),
      );
    }
    const threads = await this.#repository.listBrowserSessionThreads({
      ownerId: input.ownerId,
      sessionIds: [result.session.id],
    });
    return {
      ...result,
      session: {
        ...result.session,
        ...this.#presence(result.session.id),
        threadIds: [...(threads.get(result.session.id) ?? [])],
      },
    };
  }

  /**
   * Refuses, before a message exists, a page its sender may not bring into the
   * conversation: one of a browser they can no longer see, or one the
   * conversation's agent could not use — the same rule its CDP connection
   * meets, so a page is never credited to a conversation whose agent is
   * refused it. The page itself is never read: a reference may outlive it.
   */
  async assertPagesUsable(input: {
    readonly ownerId: UserId;
    readonly threadId?: ThreadId;
    readonly pages: readonly {
      readonly sessionId: BrowserSessionId;
      readonly title: string;
      readonly url: string;
    }[];
  }): Promise<void> {
    for (const page of input.pages) {
      const label = page.title || browserPageSite(page.url) || "this page";
      const record = await this.#repository.getBrowserSessionForOwner(
        page.sessionId,
        input.ownerId,
      );
      if (!record) {
        throw new OpensteerError({
          code: "forbidden",
          message: `This message includes the browser page "${label}", which you can no longer see. Remove the page and send the message again.`,
        });
      }
      if (
        input.threadId &&
        !(await this.agentMayAccessSession(
          { ...input, ...(input.threadId ? { agentBindingId: `thread:${input.threadId}` } : {}) },
          record,
        ))
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: `This message includes the browser page "${label}" from a browser this person can't use. Remove the page, or send it from a conversation in that person's tasks.`,
        });
      }
    }
  }

  #occupants(ownerId: UserId, sessionId: BrowserSessionId, surfaceId: string): PlaceOccupant[] {
    const occupants = new Map<ThreadId, PlaceOccupant>();
    for (const actor of this.#actors.values()) {
      if (actor.sessionId !== sessionId) continue;
      const identity = actor.audience.get(ownerId);
      const use = actor.surfaces.get(surfaceId);
      if (!identity || !use) continue;
      const holding = this.#holdings.get(sessionId)?.has(`${actor.binding}:${surfaceId}`) === true;
      const acting = this.#activityClock.now() - use.at < this.#actingWindowMs;
      if (!holding && !acting) continue;
      const previous = occupants.get(identity.threadId);
      occupants.set(identity.threadId, {
        threadId: identity.threadId,
        holding: holding || previous?.holding === true,
        acting: acting || previous?.acting === true,
        lastActiveAt: new Date(
          Math.max(use.at, use.heldAt ?? 0, previous ? Date.parse(previous.lastActiveAt) : 0),
        ).toISOString(),
      });
    }
    return [...occupants.values()];
  }

  async #requireSession(
    ownerId: UserId,
    sessionId: BrowserSessionId,
  ): Promise<BrowserSessionRecord> {
    const record = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
    if (!record || this.#ended(record))
      throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
    return record;
  }

  /**
   * Ended for anything new: a terminal row, or a pooled one a Stop left closing until its runtime
   * answers. An ordinary Home's closing row is as before.
   */
  #ended(record: BrowserSessionRecord): boolean {
    return (
      isTerminal(record.state) ||
      (record.state === "closing" &&
        ((this.#pools.size > 0 && this.#pool(record.runnerId) !== undefined) ||
          this.#isPooledRunner(record.runnerId)))
    );
  }

  /** The pooled computer's runner, with or without its coordinator here now. */
  #isPooledRunner(runnerId: RunnerId): boolean {
    return this.#pooledRunner !== undefined && runnerId === this.#pooledRunner;
  }

  async readTabIcon(
    ownerId: UserId,
    input: BrowserTabIconInput,
  ): Promise<{ favicon: string | null }> {
    if (this.#workspaceTabs) {
      const { rows } = await this.#workspaceTabs.snapshot(ownerId);
      const row = rows.find(
        (row) =>
          row.kind === "page" &&
          ("tabId" in input
            ? row.id === input.tabId
            : row.pageBinding?.sessionId === input.sessionId) &&
          row.iconRef === input.iconRef,
      );
      return { favicon: row?.favicon ?? null };
    }
    if ("tabId" in input) return { favicon: null };
    if (!(await this.#repository.getBrowserSessionForOwner(input.sessionId, ownerId)))
      throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
    const broker = this.#brokers.get(input.sessionId);
    return {
      favicon: (broker?.live ? broker.icon(input.iconRef) : null) ?? null,
    };
  }

  async readContextCandidate(
    ownerId: UserId,
    input: BrowserContextCandidateInput,
  ): Promise<BrowserContextCandidate> {
    const session = await this.#requireSession(ownerId, input.sessionId);
    const pool = this.#pool(session.runnerId);
    const signal = pool
      ? AbortSignal.any([this.#closing.signal, AbortSignal.timeout(browserOpenWorkMs)])
      : undefined;
    const readTab = async () => {
      const row = await this.#workspaceTabs?.get(ownerId, input.tabId);
      if (row?.pageBinding?.sessionId !== session.id || row.pageBinding.surfaceId !== input.tabId)
        throw new OpensteerError({ code: "not_found", message: "This tab has closed." });
      return row;
    };
    const before = pool ? await readTab() : undefined;
    const reservation =
      pool && signal ? await this.#reservePool(pool.gate, signal, session.id) : undefined;
    try {
      const broker = this.#brokers.get(input.sessionId);
      if (!broker?.live)
        throw new OpensteerError({
          code: "conflict",
          message: "Update the browser computer to read this page.",
        });
      const response = await broker.requestCdp(
        {
          type: "cdp.command",
          requestId: randomUUID(),
          command: {
            method: browserHostMethods.contextCandidate,
            parameters: { surfaceId: input.tabId },
          },
        },
        signal,
        before
          ? {
              recheck: async () => {
                const current = await this.#requireSession(ownerId, session.id);
                const tab = await readTab();
                if (
                  current.runtimeId !== session.runtimeId ||
                  current.runnerId !== session.runnerId ||
                  tab.generation !== before.generation
                )
                  throw new OpensteerError({ code: "not_found", message: "This tab has closed." });
              },
              submitted: () => {},
            }
          : undefined,
      );
      const candidate = BrowserContextCandidateSchema.parse(response.result);
      if (candidate.sessionId !== input.sessionId || candidate.tabId !== input.tabId)
        throw new OpensteerError({ code: "conflict", message: "The browser page changed." });
      return {
        sessionId: candidate.sessionId,
        tabId: candidate.tabId,
        documentId: candidate.documentId,
        title: candidate.title,
        url: candidate.url,
        ...previousReleaseEligibility(new Date()),
      };
    } finally {
      reservation?.release();
    }
  }

  async #resolveIdentityOpen(
    ownerId: UserId,
    command: {
      identity: NonNullable<BrowserTabOpenCommand["identity"]>;
      placement?: BrowserTabOpenCommand["placement"];
    },
    signal: AbortSignal,
  ): Promise<{
    profileId: BrowserProfileId | null;
    placement: BrowserPlacementSelector;
    identityKey: string;
    holder: BrowserSessionRecord | null;
    storage: Awaited<ReturnType<BrowserLocalProfiles["storage"]>>;
    target: BrowserRuntimeTarget;
  }> {
    const profileId = command.identity.kind === "profile" ? command.identity.profileId : null;
    const identityKey = profileId ?? "guest";
    const profile = profileId ? await this.#repository.getBrowserProfile(profileId, ownerId) : null;
    if (profileId && !profile)
      throw this.#tabOpenRefusal(
        "browser-profile-unavailable",
        "That browser profile is unavailable. Choose a profile.",
      );
    const storage =
      profileId && this.#localProfiles
        ? await this.#localProfiles.storage(profileId)
        : { kind: "unbound" as const };
    const boundRunnerId =
      profile?.homeRunnerId ?? (storage.kind === "unbound" ? undefined : storage.binding.runnerId);
    const holder = profileId
      ? await this.#repository.findBrowserSessionHoldingProfilePlacement(profileId)
      : null;
    if (
      !boundRunnerId &&
      holder &&
      command.placement &&
      !samePlacement(command.placement, placementOf(holder))
    )
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        "That profile is already held on another computer. Choose that computer or close its browser first.",
      );
    const remembered =
      profileId && !command.placement && !holder
        ? await this.#repository.rememberedBrowserPlacement(ownerId, identityKey)
        : null;
    const homes = await this.#repository.listEligibleBrowserRunners(ownerId);
    const main = this.#personal ? homes.find((home) => home.kind === "main") : undefined;
    const intended: BrowserPlacementSelector | null =
      (boundRunnerId ? { kind: "runner" as const, runnerId: boundRunnerId } : command.placement) ??
      (main && !profile
        ? { kind: "runner" as const, runnerId: main.id }
        : holder
          ? placementOf(holder)
          : remembered
            ? { kind: "runner" as const, runnerId: remembered }
            : null);
    if (await this.#waitForBrowser(homes, intended?.runnerId, signal))
      return this.#resolveIdentityOpen(ownerId, command, signal);
    if (boundRunnerId) this.#requireProfileHome(profile!, boundRunnerId, homes);
    const eligible = this.#eligiblePlacements(homes).filter((candidate) => candidate.available);
    if (
      command.placement &&
      !eligible.some((candidate) => candidate.runnerId === command.placement?.runnerId)
    )
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        "The selected browser computer is unavailable.",
        this.#eligiblePlacements(homes),
      );
    if (this.#personal && !profile && !command.placement && !main)
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        "The main computer's browser is unavailable.",
      );
    let placement = intended;
    if (!placement) {
      if (eligible.length > 1)
        throw this.#tabOpenRefusal(
          "browser-placement-ambiguous",
          "Choose which computer should open this browser.",
          eligible,
        );
      placement = eligible[0] ? placementSelector(eligible[0]) : null;
    }
    if (
      !placement ||
      !eligible.some((candidate) => candidate.runnerId === placement.runnerId) ||
      !this.#resolveTarget(placement)
    )
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        boundRunnerId
          ? "Waiting for this computer to open its browser profile. Reconnect the owning computer."
          : "The selected browser computer is unavailable.",
        this.#eligiblePlacements(homes),
      );
    return {
      profileId,
      identityKey,
      placement,
      holder,
      storage,
      target: this.#resolveTarget(placement)!,
    };
  }

  #historyOperation<T>(profileId: BrowserProfileId, operation: () => Promise<T>): Promise<T> {
    const pending = (this.#historyTails.get(profileId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#historyTails.set(profileId, pending);
    void pending
      .finally(() => {
        if (this.#historyTails.get(profileId) === pending) this.#historyTails.delete(profileId);
      })
      .catch(() => undefined);
    return pending;
  }

  async pruneHistory(): Promise<void> {
    try {
      for (const { ownerId, profileId } of (await this.#history?.prune()) ?? [])
        this.#onHistoryChanged(ownerId, profileId);
    } catch {
      this.#onError(new Error("Browser history persistence failed"));
    }
  }

  async readHistory(ownerId: UserId, profileId: BrowserProfileId) {
    if (!this.#history) throw new Error("Browser history store unavailable");
    return this.#historyOperation(profileId, () => this.#history!.list(profileId, ownerId));
  }

  async readHistoryIcons(
    ownerId: UserId,
    input: { profileId: BrowserProfileId; iconRefs: readonly string[] },
  ) {
    if (!this.#history) throw new Error("Browser history store unavailable");
    return this.#historyOperation(input.profileId, () =>
      this.#history!.icons(input.profileId, ownerId, input.iconRefs),
    );
  }

  async forgetHistory(
    ownerId: UserId,
    input: {
      profileId: BrowserProfileId;
      administration?: AdministrationCommandIdentity | undefined;
      idempotencyKey: string;
      url?: string;
      authoritySource?: Readonly<Record<string, unknown>>;
    },
  ) {
    if (!(await this.#repository.getBrowserProfile(input.profileId, ownerId)))
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    if (!this.#history) throw new Error("Browser history store unavailable");
    const changed = await this.#historyOperation(input.profileId, () =>
      input.url === undefined
        ? this.#history!.clear({ ...input, ownerId })
        : this.#history!.remove({ ...input, url: input.url, ownerId }),
    );
    if (changed) this.#onHistoryChanged(ownerId, input.profileId);
  }

  async openTab(
    ownerId: UserId,
    input: BrowserTabOpenCommand,
    agent?: BrowserTabOpenAgent,
    confirmedSignal?: AbortSignal,
  ): Promise<BrowserTabOpenResult> {
    confirmedSignal?.throwIfAborted();
    const expiresAt = Date.now() + 20_000;
    const cancellation = new AbortController();
    const budget: BrowserTabOpenBudget = {
      signal: confirmedSignal
        ? AbortSignal.any([confirmedSignal, cancellation.signal])
        : cancellation.signal,
      expiresAt: expiresAt - 2_000,
      abort: (reason) => cancellation.abort(reason),
      ...(confirmedSignal ? { confirmed: true } : {}),
      ...(agent?.browserSend ? { browserSend: agent.browserSend } : {}),
    };
    const timeout = () =>
      new OpensteerError({
        code: "conflict",
        message: "Opening this browser timed out. Retry to open a new page.",
        reason: "browser-open.timeout",
      });
    const timer = setTimeout(() => cancellation.abort(timeout()), browserOpenWorkMs);
    timer.unref?.();
    try {
      return await withDatabaseOperationSignal(budget.signal, budget.expiresAt, () =>
        confirmedSignal
          ? this.#openTab(ownerId, input, budget, agent)
          : withTimeout(this.#openTab(ownerId, input, budget, agent), browserOpenWorkMs, {
              signal: budget.signal,
              timeoutError: timeout,
            }),
      );
    } catch (error) {
      cancellation.abort(error);
      // An unanswered page request may still have opened its page; its key recovers it.
      if (
        budget.pageRequested &&
        !(error instanceof BrowserCdpRefusal) &&
        !(error instanceof OpensteerError && error.reason === "browser-tab-open-failed")
      )
        throw this.#tabOpenRefusal(
          "browser-tab-open-outcome-unknown",
          budget.pool
            ? "Opening did not confirm its outcome. Inspect the browser before opening another page."
            : "Opening did not confirm its outcome. Retry this request to recover its original page.",
        );
      if (budget.admitted) {
        const remaining = Math.max(1, expiresAt - Date.now());
        try {
          const settlement = AbortSignal.timeout(remaining);
          const settled = await withDatabaseOperationSignal(settlement, expiresAt, () =>
            withTimeout(
              (async () => {
                await this.#repository.settleBrowserTabOpen({
                  ...budget.admitted!,
                  outcome: { kind: "failed", reason: "failed" },
                });
                if (budget.admitted!.browserStarted)
                  await this.#transitionBrowserSession({
                    from: budget.pool ? ["starting"] : ["starting", "ready", "closing"],
                    sessionId: budget.admitted!.chosenSessionId,
                    state: "failed",
                  }).catch(() => undefined);
                return this.#repository.getBrowserTabOpen(ownerId, budget.admitted!.idempotencyKey);
              })(),
              remaining,
              { timeoutError: timeout },
            ),
          );
          if (settled?.outcome.kind === "failed" && budget.admitted.browserStarted) {
            const broker = this.#brokers.get(budget.admitted.chosenSessionId);
            void withoutDatabaseOperationSignal(() =>
              broker?.abort("Browser opening failed."),
            )?.catch(() => undefined);
          }
          if (settled?.outcome.kind === "failed")
            throw error instanceof OpensteerError && error.code === "forbidden"
              ? error
              : this.#tabOpenFailure(settled);
        } catch (settlementError) {
          if (
            settlementError === error ||
            (settlementError instanceof OpensteerError &&
              settlementError.reason === "browser-tab-open-failed")
          )
            throw settlementError;
        }
        throw this.#tabOpenRefusal(
          "browser-tab-open-outcome-unknown",
          "Opening did not confirm its outcome. Retry this request to recover its original page.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      budget.cleanupPoolAbort?.();
    }
  }

  #openTab(
    ownerId: UserId,
    input: BrowserTabOpenCommand,
    budget: BrowserTabOpenBudget,
    agent?: BrowserTabOpenAgent,
  ): Promise<BrowserTabOpenResult> {
    const parsed = BrowserTabOpenCommandSchema.parse(input);
    const command = parsed.url ? { ...parsed, url: safeNavigationUrl(parsed.url) } : parsed;
    // A caller/key binds once; only opens of the same identity share selection/start work.
    return this.#serializeKey(`tab-open:${ownerId}:${command.idempotencyKey}`, async () => {
      budget.signal.throwIfAborted();
      let admitted: BrowserTabOpenBinding | undefined;
      try {
        let pendingFinish: (() => Promise<void>) | undefined;
        const select = async () => {
          budget.signal.throwIfAborted();
          if (agent) await this.admitAgentBrowser(agent);
          const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
          let binding = await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey);
          if (binding) {
            if (binding.requestFingerprint !== fingerprint)
              throw new OpensteerError({
                code: "conflict",
                message: "Idempotency key already used.",
              });
            if (binding.outcome.kind === "pending") {
              if (this.#pools.size) {
                const bound = await this.#repository.getBrowserSessionForOwner(
                  binding.chosenSessionId,
                  ownerId,
                );
                if (!bound || this.#pools.has(bound.runnerId))
                  throw this.#tabOpenRefusal(
                    "browser-tab-open-outcome-unknown",
                    "The original page outcome is unknown. Inspect the browser before opening another page.",
                  );
              }
              budget.admitted = binding;
            }
            return binding;
          }
          let record: BrowserSessionRecord | null = null;
          let opening: StartBrowserSessionInput | null = null;
          let identityKey: string | null = null;
          let runnerId: RunnerId;
          if (command.sessionId !== undefined) {
            record = await this.#repository.getBrowserSessionForOwner(command.sessionId, ownerId);
            if (!record)
              throw new OpensteerError({
                code: "not_found",
                message: "Browser session not found.",
              });
            this.#requireOpenableSession(record);
            runnerId = record.runnerId;
          } else {
            const resolved = await this.#resolveIdentityOpen(
              ownerId,
              {
                identity: command.identity!,
                ...(command.placement ? { placement: command.placement } : {}),
              },
              budget.signal,
            );
            const { profileId, placement } = resolved;
            identityKey = resolved.identityKey;
            runnerId = placement.runnerId;
            const sessions = await this.#repository.listBrowserSessions(ownerId);
            const candidates = sessions
              .filter(
                (candidate) =>
                  candidate.state === "ready" &&
                  (agent
                    ? candidate.origin !== "trigger" &&
                      (profileId !== null ||
                        (candidate.opener?.kind === "task" &&
                          candidate.opener.threadId === agent.threadId))
                    : candidate.origin === "person" &&
                      candidate.opener?.kind === "person" &&
                      candidate.opener.userId === ownerId) &&
                  candidate.profileId === profileId &&
                  samePlacement(placement, placementOf(candidate)) &&
                  this.#brokers.get(candidate.id)?.live,
              )
              .sort(
                (left, right) =>
                  left.createdAt.getTime() - right.createdAt.getTime() ||
                  left.id.localeCompare(right.id),
              );
            record = candidates[0] ?? null;
            if (!record)
              opening = {
                ownerId,
                placement,
                sessionId: this.#newSessionId(),
                ...(agent
                  ? {
                      origin: "agent" as const,
                      agentBindingId: agent.agentBindingId,
                      opener: await this.#repository.browserSessionOpenerForBinding(
                        agent.agentBindingId,
                        ownerId,
                      ),
                    }
                  : {}),
                ...(profileId ? { profileId } : { fresh: true as const }),
                ...(command.url ? { initialUrl: command.url } : {}),
                ...(command.viewport ? { viewport: command.viewport } : {}),
              };
          }
          budget.signal.throwIfAborted();
          if (agent) {
            budget.openAccessGeneration = this.#runnerAccessGeneration.get(runnerId) ?? 0;
            await this.admitAgentBrowser(
              agent,
              "read-write",
              record ? [record] : [],
              this.#repository,
              false,
              record
                ? undefined
                : {
                    profileId:
                      opening && "profileId" in opening ? (opening.profileId ?? null) : null,
                  },
            );
            if (!record) await this.#requireAgentAccess(runnerId);
          }
          const pooled = this.#pool(runnerId);
          if (
            budget.browserSend &&
            !isDeepStrictEqual(budget.browserSend.target, pooled?.identity())
          )
            throw unavailable("The pooled browser changed before opening the page.");
          if (pooled) {
            const openRecheck = agent
              ? async () => {
                  await this.admitAgentBrowser(
                    agent,
                    "read-write",
                    record ? [record] : [],
                    this.#repository,
                    false,
                    record
                      ? undefined
                      : {
                          profileId:
                            opening && "profileId" in opening ? (opening.profileId ?? null) : null,
                        },
                  );
                  await this.#requireAgentAccess(runnerId);
                }
              : undefined;
            const reservation = agent
              ? await this.#reserveAgentPool(
                  pooled.gate,
                  agent.agentBindingId,
                  record?.id,
                  budget.signal,
                  runnerId,
                  openRecheck,
                )
              : await this.#reservePool(pooled.gate, budget.signal, record?.id);
            budget.pool = { target: pooled, reservation };
            const ended = reservation.ended;
            if (ended) {
              const onEnded = () =>
                budget.abort?.(
                  ended.reason ?? new BrowserPoolAdmissionClosed("This browser is restarting."),
                );
              if (ended.aborted) onEnded();
              else {
                ended.addEventListener("abort", onEnded, { once: true });
                budget.cleanupPoolAbort = () => ended.removeEventListener("abort", onEnded);
              }
            }
            reservation.onForcedEnd?.(async () => {
              budget.abort?.(new BrowserPoolAdmissionClosed("This browser is restarting."));
            });
            budget.signal.throwIfAborted();
            if (openRecheck && reservation.waited) await openRecheck();
            if (record) {
              const current = await this.#repository.getBrowserSessionForOwner(record.id, ownerId);
              if (
                !current ||
                current.runnerId !== runnerId ||
                current.runtimeId !== record.runtimeId
              )
                throw unavailable("The browser session changed while waiting.");
              this.#requireOpenableSession(current);
              record = current;
            }
          }
          binding = {
            callerUserId: ownerId,
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: fingerprint,
            chosenSessionId: record?.id ?? opening!.sessionId!,
            browserStarted: opening !== null,
            initialPageOperationKey: createHash("sha256")
              .update(`${ownerId}:${command.idempotencyKey}`)
              .digest("hex"),
            outcome: { kind: "pending" },
          };
          if (!pooled) {
            admitted = binding;
            budget.admitted = binding;
          }
          await this.#repository.bindBrowserTabOpen({
            binding,
            identityKey,
            runnerId,
            ...(pooled ? { pooled: true } : {}),
          });
          admitted = binding;
          budget.admitted = binding;
          budget.signal.throwIfAborted();
          if (opening) {
            let tabId: BrowserSurfaceId | undefined;
            const finish = await this.#prepareStart(
              {
                ...opening!,
                operationBudget: budget,
                initialPageOperationKey: binding.initialPageOperationKey,
              },
              (openedTabId) => {
                tabId = openedTabId;
              },
              command.url && !agent ? { ownerId, typed: command.typed === true } : undefined,
            );
            const openingBinding = binding;
            const openingSessionId = opening.sessionId!;
            const openingProfileId =
              "profileId" in opening ? ((opening.profileId as BrowserProfileId) ?? null) : null;
            // The exact profile, or Guest, again at the start and once the browser is up; a
            // browser this open started is stopped when either check refuses it.
            const admitExact = async () => {
              if (!agent) return;
              try {
                await this.admitAgentBrowser(agent, "read-write", [], this.#repository, false, {
                  profileId: openingProfileId,
                });
                await this.#requireAgentAccess(runnerId);
              } catch (error) {
                await this.stop(ownerId, openingSessionId).catch(() => undefined);
                throw error;
              }
            };
            pendingFinish = async () => {
              // A start refused before it finished is still settled, so its attach is observed.
              await admitExact().catch(async (error: unknown) => {
                await finish().catch(() => undefined);
                throw error;
              });
              await finish();
              await admitExact();
              if (!tabId)
                throw this.#tabOpenRefusal(
                  "browser-tab-open-outcome-unknown",
                  "The browser opened without a confirmed page. Inspect the browser before trying again.",
                );
              await this.#repository.settleBrowserTabOpen({
                ...openingBinding,
                outcome: { kind: "opened", tabId },
              });
            };
          }
          return binding;
        };
        const selectAndStart = async () => {
          let binding = await select();
          // Another open of this identity must see the admitted session ready
          // before selecting reuse. Different identities have independent lanes.
          if (pendingFinish) {
            await pendingFinish();
            binding =
              (await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey)) ??
              binding;
          }
          return binding;
        };
        const binding =
          command.identity === undefined
            ? await selectAndStart()
            : await this.#serializeKey(
                `identity:${ownerId}:${command.identity.kind === "profile" ? command.identity.profileId : agent ? `guest:${agent.threadId}:${command.placement?.runnerId}` : "guest"}`,
                selectAndStart,
              );
        return await this.#resumeTabOpen(ownerId, command, binding, budget, agent);
      } catch (error) {
        // Initial-start failures close their exact broker before reaching here.
        // An additional page can fail definitively only on the Runtime's reply;
        // a missing response retains its key and uncertain outcome.
        if (
          admitted &&
          (!budget.pool || !budget.pageRequested) &&
          (admitted.browserStarted || error instanceof BrowserCdpRefusal)
        ) {
          await this.#repository.settleBrowserTabOpen({
            ...admitted,
            outcome: { kind: "failed", reason: "failed" },
          });
          const settled = await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey);
          // A refusal of the task's authority stays a refusal; anything else failed to open.
          if (settled?.outcome.kind === "failed")
            throw error instanceof OpensteerError && error.code === "forbidden"
              ? error
              : this.#tabOpenFailure(settled, error);
        }
        throw error;
      } finally {
        budget.pool?.reservation.release();
      }
    });
  }

  #tabOpenFailure(binding: BrowserTabOpenBinding, cause?: unknown): OpensteerError {
    return this.#tabOpenRefusal(
      "browser-tab-open-failed",
      binding.outcome.kind === "failed" && binding.outcome.reason === "interrupted"
        ? "Opening was interrupted by a Host restart. Retry to open a new page."
        : "The browser could not open this page. Retry to open a new page.",
      [],
      cause,
    );
  }

  #requireOpenableSession(record: BrowserSessionRecord): void {
    if (record.state === "ready") return;
    if (record.state === "starting")
      throw this.#tabOpenRefusal(
        "browser-session-unavailable",
        "This browser is still starting. Try again shortly.",
      );
    throw this.#tabOpenRefusal(
      "browser-session-closed",
      "The browser has ended. Open another tab.",
    );
  }

  #tabOpenRefusal(
    reason: BrowserTabOpenRefusalReason,
    message: string,
    placements: readonly BrowserPlacement[] = [],
    cause?: unknown,
  ): OpensteerError {
    return new OpensteerError({
      ...(cause === undefined ? {} : { cause }),
      code: "conflict",
      reason,
      message,
      details: BrowserTabOpenRefusalDetailsSchema.parse({ placements }),
      retryable: reason === "browser-session-unavailable",
    });
  }

  async #resumeTabOpen(
    ownerId: UserId,
    command: BrowserTabOpenCommand,
    binding: BrowserTabOpenBinding,
    budget: BrowserTabOpenBudget,
    agent?: BrowserTabOpenAgent,
  ): Promise<BrowserTabOpenResult> {
    if (binding.outcome.kind === "failed") throw this.#tabOpenFailure(binding);
    return this.#serializeKey(binding.chosenSessionId, async () => {
      const record = await this.#repository.getBrowserSessionForOwner(
        binding.chosenSessionId,
        ownerId,
      );
      if (!record)
        throw this.#tabOpenRefusal(
          "browser-tab-open-outcome-unknown",
          "The original browser is unavailable. This request cannot start another browser.",
        );
      budget.signal.throwIfAborted();
      const accessGeneration =
        budget.openAccessGeneration ?? this.#runnerAccessGeneration.get(record.runnerId) ?? 0;
      if (agent && binding.outcome.kind === "opened")
        await this.admitAgentBrowser(agent, "read-write", [record]);
      if (binding.outcome.kind !== "opened") {
        // Admission and the page request share the computer's admission lane, so
        // turning browser access off cannot land between them.
        const send = async () => {
          if (agent) await this.admitAgentBrowser(agent, "read-write", [record]);
          budget.signal.throwIfAborted();
          this.#requireOpenableSession(record);
          // A submitted initial page cannot be repeated after an uncertain start.
          if (binding.browserStarted)
            throw this.#tabOpenRefusal(
              "browser-tab-open-outcome-unknown",
              "The original page outcome is unknown. Inspect the browser before opening another page.",
            );
          const broker = this.#brokers.get(record.id);
          if (!broker?.live)
            throw this.#tabOpenRefusal(
              "browser-session-unavailable",
              "This browser is not ready to open a page. Try again shortly.",
            );
          if (
            budget.confirmed &&
            (!broker.supportsCdpReplyBudget || !broker.supportsScriptCancellation)
          )
            throw new OpensteerError({
              code: "conflict",
              message: "Update the browser computer to run browser scripts.",
            });
          const navigationId =
            command.url && !agent
              ? broker.beginHistoryNavigation(ownerId, command.typed === true)
              : undefined;
          if (!budget.pool) budget.pageRequested = true;
          const request = broker.requestCdp(
            {
              type: "cdp.command",
              ...(budget.confirmed
                ? { replyBudget: { maxBytes: 4096, maxDepth: 8, maxEntries: 64 } }
                : {}),
              requestId: randomUUID(),
              ...(navigationId ? { navigationId } : {}),
              command: {
                method: browserHostMethods.openTab,
                parameters: {
                  operationAuthority: this.#signer.issue({
                    creationOrigin: agent ? "agent" : "person",
                    access: "read-write",
                    ...(budget.pool ? { pool: budget.pool.target.fence() } : {}),
                    identity: { kind: "fresh" },
                    runtimeId: record.runtimeId,
                    sessionId: record.id,
                    subject: ownerId,
                    operationExpiresAt: new Date(budget.expiresAt).toISOString(),
                    remainingBudgetMs: Math.max(1, budget.expiresAt - Date.now()),
                    initialNavigation: {
                      operationKey: binding.initialPageOperationKey,
                      ...(command.url ? { url: command.url } : {}),
                    },
                  }),
                  idempotencyKey: binding.initialPageOperationKey,
                  ...(command.url === undefined ? {} : { url: command.url }),
                  ...(command.viewport === undefined ? {} : { viewport: command.viewport }),
                },
              },
            },
            budget.confirmed || budget.pool ? budget.signal : undefined,
            budget.pool
              ? {
                  recheck: async () => {
                    const current = await this.#repository.getBrowserSessionForOwner(
                      record.id,
                      ownerId,
                    );
                    if (
                      !current ||
                      current.runnerId !== record.runnerId ||
                      current.runtimeId !== record.runtimeId ||
                      current.profileId !== record.profileId
                    )
                      throw unavailable("The browser session changed while waiting.");
                    this.#requireOpenableSession(current);
                    if (agent) {
                      await this.admitAgentBrowser(agent, "read-write", [current]);
                      await this.#requireAgentAccess(record.runnerId);
                    }
                    await budget.browserSend?.recheck();
                  },
                  submitted: () => {
                    budget.pageRequested = true;
                    budget.browserSend?.submitted();
                  },
                  ...(budget.browserSend ? { acknowledged: budget.browserSend.acknowledged } : {}),
                }
              : undefined,
          );
          // Awaited just after the lane releases; a rejection meanwhile is not unhandled.
          request.catch(() => undefined);
          return { broker, navigationId, request };
        };
        const opens = agent ? this.#beginTaskPageOpen(record.id) : undefined;
        let tabId: BrowserSurfaceId;
        let broker: Awaited<ReturnType<typeof send>>["broker"];
        let navigationId: Awaited<ReturnType<typeof send>>["navigationId"];
        try {
          const sent = agent ? await this.withRunnerAdmission(record.runnerId, send) : await send();
          ({ broker, navigationId } = sent);
          const response = await sent.request;
          ({ tabId } = z.object({ tabId: BrowserSurfaceIdSchema }).parse(response.result));
          if (opens && agent) opens.openers.set(tabId, { taskId: agent.threadId });
        } finally {
          if (opens) {
            opens.inFlight--;
            if (!opens.inFlight && !opens.openers.size) this.#taskPageOpens.delete(record.id);
            // Pages held back while this open was in flight are recorded now.
            this.#queueTabDescriptors(record.id);
          }
        }
        broker.bindHistoryNavigation(navigationId, tabId);
        binding = { ...binding, outcome: { kind: "opened", tabId } };
        await this.#repository.settleBrowserTabOpen(binding);
        binding =
          (await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey)) ?? binding;
        if (binding.outcome.kind === "failed") throw this.#tabOpenFailure(binding);
      }
      if (binding.outcome.kind !== "opened")
        throw this.#tabOpenRefusal(
          "browser-tab-open-outcome-unknown",
          "The page outcome is unknown.",
        );
      if (budget.pool && agent && !agent.browserSend)
        await this.#holdForAgent(agent, record, { accessGeneration, recheck: true });
      await this.#flushTabDescriptors(record.id);
      this.#onTabsChanged();
      const visible = await this.#visibleOpenerThreads(ownerId, [record]);
      return {
        type: "browser.tab.open",
        groupId: this.#brokers.get(record.id)?.groupId ?? record.id,
        sessionId: record.id,
        browserStarted: binding.browserStarted,
        session: {
          ...publicSession(record),
          navigationVersion: this.#brokers.get(record.id)?.navigationVersion,
          tabRestoreVersion: this.#brokers.get(record.id)?.tabRestoreVersion,
          opener: projectBrowserSessionOpener(record.opener ?? null, {
            userId: ownerId,
            visibleThreadIds: visible,
          }),
        },
        tabId: binding.outcome.tabId,
      };
    });
  }

  async #personSession(
    record: BrowserSessionRecord,
    ownerId: UserId,
  ): Promise<HostedBrowserSession> {
    const visible = await this.#visibleOpenerThreads(ownerId, [record]);
    return {
      ...publicSession(record),
      navigationVersion: this.#brokers.get(record.id)?.navigationVersion,
      tabRestoreVersion: this.#brokers.get(record.id)?.tabRestoreVersion,
      opener: projectBrowserSessionOpener(record.opener ?? null, {
        userId: ownerId,
        visibleThreadIds: visible,
      }),
    };
  }

  async #visibleOpenerThreads(
    ownerId: UserId,
    records: readonly BrowserSessionRecord[],
  ): Promise<ReadonlySet<ThreadId>> {
    const ids = [
      ...new Set(
        records.flatMap((record) =>
          record.opener && "threadId" in record.opener ? [record.opener.threadId] : [],
        ),
      ),
    ];
    return new Set((await this.#repository.authorizedPlaceThreadIds?.(ownerId, ids)) ?? []);
  }

  #requestPhysicalTabClose(
    broker: HostedBrowserBroker,
    surfaceId: BrowserSurfaceId,
    durable: boolean,
  ) {
    return broker.requestCdp({
      type: "cdp.command",
      requestId: randomUUID(),
      command: {
        method: browserHostMethods.closeTab,
        parameters: {
          surfaceId,
          inventoryRevision: broker.inventoryRevision,
          ...(durable ? { durable: true } : {}),
        },
      },
    });
  }

  #queuePhysicalPageClose(
    sessionId: BrowserSessionId,
    surfaceId: BrowserSurfaceId,
    onFailure?: () => void,
    witness?: { ownerId: UserId; row: TabRecord },
  ): Promise<void> {
    const broker = this.#brokers.get(sessionId);
    if (!broker?.live) return Promise.resolve();
    let pending = this.#pendingPageCloses.get(sessionId);
    if (!pending) {
      pending = new Map();
      this.#pendingPageCloses.set(sessionId, pending);
    }
    const existing = pending.get(surfaceId);
    if (existing) return existing.initial;
    const fence = Promise.withResolvers<void>();
    const initial = Promise.withResolvers<void>();
    const entry: { fence?: Promise<void>; initial: Promise<void> } = {
      fence: fence.promise,
      initial: initial.promise,
    };
    pending.set(surfaceId, entry);
    const releaseFence = () => {
      delete entry.fence;
      fence.resolve();
    };
    const close = async () => {
      if (broker.pooled) {
        initial.resolve();
        await this.#closePooledPage(broker, sessionId, surfaceId, witness);
        return;
      }
      let backoff = 250;
      let reported = false;
      const failed = (error: unknown) => {
        if (reported) return;
        reported = true;
        onFailure?.();
        this.#onError(error);
      };
      while (!this.#closed && broker.live) {
        try {
          if (entry.fence) {
            try {
              await broker.requestCdp({
                type: "cdp.command",
                requestId: randomUUID(),
                command: { method: browserHostMethods.fenceTab, parameters: { surfaceId } },
              });
              releaseFence();
            } catch (error) {
              // A runtime without the separate fence can still close the page. Keep
              // the forwarding barrier up until one of those operations succeeds.
              failed(error);
            }
          }
          const response = await this.#requestPhysicalTabClose(broker, surfaceId, true);
          z.object({ outcome: z.enum(["tab-closed", "session-closed"]) }).parse(response.result);
          releaseFence();
          return;
        } catch (error) {
          failed(error);
        } finally {
          initial.resolve();
        }
        await delay(backoff, undefined, { signal: this.#closing.signal, ref: false });
        backoff = Math.min(backoff * 2, 5_000);
      }
    };
    void close()
      .finally(() => {
        pending.delete(surfaceId);
        if (!pending.size) this.#pendingPageCloses.delete(sessionId);
        initial.resolve();
        releaseFence();
      })
      .catch((error: unknown) => {
        if (!this.#closed) {
          if (broker.pooled) onFailure?.();
          this.#onError(error);
        }
      });
    return initial.promise;
  }

  async #closePooledPage(
    broker: HostedBrowserBroker,
    sessionId: BrowserSessionId,
    surfaceId: BrowserSurfaceId,
    witness?: { ownerId: UserId; row: TabRecord },
  ) {
    if (!witness || !this.#pools.size || !(this.#repository instanceof OpensteerStore))
      throw unavailable("The pooled browser page has no durable close witness.");
    const runnerId = (await this.#repository.getBrowserSessionForOwner(sessionId, witness.ownerId))
      ?.runnerId;
    const pool = runnerId ? this.#pools.get(runnerId) : undefined;
    if (!pool) return;
    const documentId = this.pageInventory(sessionId)?.records.get(surfaceId)?.documentId;
    if (!documentId) return;
    const identity = pool.identity();
    const signal = AbortSignal.any([this.#closing.signal, AbortSignal.timeout(browserOpenWorkMs)]);
    const reservation = await pool.gate.background(signal);
    let tracked: PooledBrowserRelay | undefined;
    try {
      const recheck = async () => {
        const row = await this.#workspaceTabs?.get(witness.ownerId, witness.row.id, true);
        if (
          !row?.closedAt ||
          row.generation !== witness.row.generation + 1 ||
          !isDeepStrictEqual(row.pageBinding, witness.row.pageBinding) ||
          this.#brokers.get(sessionId) !== broker ||
          !isDeepStrictEqual(pool.identity(), identity) ||
          this.pageInventory(sessionId)?.records.get(surfaceId)?.documentId !== documentId
        )
          throw unavailable("The closed browser page changed before cleanup.");
        signal.throwIfAborted();
      };
      await recheck();
      const relay = await PooledBrowserRelay.open(this.#repository.database, identity, reservation);
      tracked = relay;
      const admission = {
        recheck,
        submitted: () => relay.submitted(),
        acknowledged: () => relay.acknowledged(),
      };
      await broker.requestCdp(
        {
          type: "cdp.command",
          requestId: randomUUID(),
          command: { method: browserHostMethods.fenceTab, parameters: { surfaceId } },
        },
        signal,
        admission,
      );
      const result = await broker.requestCdp(
        {
          type: "cdp.command",
          requestId: randomUUID(),
          command: {
            method: browserHostMethods.closeTab,
            parameters: { surfaceId, inventoryRevision: broker.inventoryRevision, durable: true },
          },
        },
        signal,
        admission,
      );
      z.object({ outcome: z.enum(["tab-closed", "session-closed"]) }).parse(result.result);
      relay.confirmedClosed();
    } finally {
      if (tracked) await tracked.close();
      else reservation.release();
    }
  }

  async closeEngineSignInPage(
    ownerId: UserId,
    tabId: TabId,
    idempotencyKey: string,
  ): Promise<void> {
    const tab = await this.#workspaceTabs?.get(ownerId, tabId, true);
    if (tab?.closedAt) await this.#closeDurablePage(ownerId, tab, idempotencyKey);
  }

  async #closeDurablePage(ownerId: UserId, tab: TabRecord, idempotencyKey: string): Promise<void> {
    const binding = tab.pageBinding;
    if (!binding) return;
    const broker = this.#brokers.get(binding.sessionId);
    if (!broker?.live || !broker.pageOf(binding.surfaceId)) return;
    await this.closeTab(
      ownerId,
      {
        type: "browser.tab.close",
        sessionId: binding.sessionId,
        surfaceId: binding.surfaceId,
        inventoryRevision: broker.inventoryRevision,
        idempotencyKey,
      },
      true,
    );
  }

  closeTab(
    ownerId: UserId,
    command: BrowserTabCloseCommand,
    durableClose = false,
  ): Promise<BrowserTabCloseResult> {
    return this.#serializeKey(command.sessionId, async () => {
      const key = `${ownerId}:${command.idempotencyKey}`;
      const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const previous = this.#closeResults.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new OpensteerError({ code: "conflict", message: "Idempotency key already used." });
        await this.#requireSession(ownerId, command.sessionId);
        return {
          type: "browser.tab.close",
          sessionId: command.sessionId,
          outcome: previous.outcome,
        };
      }
      await this.#requireSession(ownerId, command.sessionId);
      const broker = this.#brokers.get(command.sessionId);
      if (!broker?.live)
        throw new OpensteerError({
          code: "conflict",
          message: "The browser computer is unavailable or needs an update.",
        });
      const durable = durableClose && broker.tabRestoreVersion === 1;
      if (!durable && broker.inventoryRevision !== command.inventoryRevision)
        throw new OpensteerError({
          code: "conflict",
          reason: staleBrowserTabInventoryReason,
          message: "The browser tabs changed. Review them before closing.",
        });
      const response = await this.#requestPhysicalTabClose(
        broker,
        command.surfaceId,
        durable,
      ).catch((error: unknown) => {
        if (
          error instanceof OpensteerError &&
          (error.code === "conflict" || error.code === "not_found")
        )
          throw new OpensteerError({
            code: "conflict",
            reason: staleBrowserTabInventoryReason,
            message: "The browser tabs changed. Review them before closing.",
            cause: error,
          });
        throw error;
      });
      const { outcome } = z
        .object({ outcome: z.enum(["tab-closed", "session-closed"]) })
        .parse(response.result);
      this.#onTabsChanged();
      if (outcome === "session-closed") {
        const record = await this.#repository.getBrowserSessionForOwner(command.sessionId, ownerId);
        if (record) await this.#stopRecord(record);
      }
      const result: BrowserTabCloseResult = {
        type: "browser.tab.close",
        groupId: this.#brokers.get(command.sessionId)?.groupId ?? command.sessionId,
        sessionId: command.sessionId,
        outcome,
      };
      this.#closeResults.set(key, { fingerprint, outcome });
      if (this.#closeResults.size > 1_000)
        this.#closeResults.delete(this.#closeResults.keys().next().value!);
      return result;
    });
  }

  #enterRunPlace(
    runId: RunId,
    generation: number,
    data: { place: import("@opensteer/core").PlaceIdentity; title: string; site: string | null },
    settled?: import("../agents/run-place-recorder.js").RunPlaceSettled,
  ): void {
    if (data.place.kind === "browser")
      this.#runPlaces.enter(
        runId,
        generation,
        { tabId: data.place.surfaceId, title: data.title, site: data.site },
        settled,
      );
  }
  beginRunTabPlace(runId: RunId, generation: number) {
    return this.#runPlaces.begin(runId, generation);
  }
  noteTabActivity(input: {
    ownerId: UserId;
    threadId: ThreadId;
    runId: RunId;
    generation: number;
    tabId: import("@opensteer/core").TabId;
    title: string;
    at: number;
    ended: boolean;
  }): void {
    const seq = ++this.#placeSequence;
    if (input.ended) {
      this.#tabPlaceNotice(input.ownerId, {
        type: "host.place-activity-cleared",
        tabId: input.tabId,
        runId: input.runId,
        generation: input.generation,
        seq,
      });
      return;
    }
    const order = ++this.#placeOrder;
    this.#tabPlaceNotice(input.ownerId, {
      type: "host.place-activity",
      activity: {
        tabId: input.tabId,
        threadId: input.threadId,
        runId: input.runId,
        generation: input.generation,
        seq,
        order,
        at: input.at,
        expiresAt: input.at + this.#actingWindowMs,
        pointer: null,
        geometryRevision: 0,
      },
    });
  }
  async #selfDeviceId(runnerId: RunnerId): Promise<DeviceId> {
    if (!this.#repository.requireSelfDeviceId)
      throw new OpensteerError({ code: "not_found", message: "Device identity unavailable" });
    return this.#repository.requireSelfDeviceId(runnerId);
  }
  async #selfRunnerId(deviceId: DeviceId): Promise<RunnerId> {
    if (!this.#repository.requireDeviceSelfRunnerId)
      throw new OpensteerError({ code: "not_found", message: "Self runtime unavailable" });
    return this.#repository.requireDeviceSelfRunnerId(deviceId);
  }
  async readablePlaces<
    T extends {
      readonly threadId: ThreadId;
      readonly place: import("@opensteer/core").PlaceIdentity;
    },
  >(ownerId: UserId, references: readonly T[]): Promise<T[]> {
    if (references.length === 0) return [];
    const [threads, sessions, owners] = await Promise.all([
      this.#repository.authorizedPlaceThreadIds?.(
        ownerId,
        references.map(({ threadId }) => threadId),
      ) ?? [],
      this.#repository.listBrowserSessions(ownerId),
      this.#repository.effectiveDeviceOwners?.(
        references.flatMap(({ place }) => (place.kind === "browser" ? [] : [place.machineId])),
      ) ?? new Map<DeviceId, { readonly effectiveOwner: UserId | null }>(),
    ]);
    const visibleThreads = new Set(threads);
    const visibleSessions = new Set(sessions.map(({ id }) => id));
    return references.filter(
      ({ threadId, place }) =>
        visibleThreads.has(threadId) &&
        (place.kind === "browser"
          ? visibleSessions.has(place.sessionId)
          : owners.get(place.machineId)?.effectiveOwner === ownerId),
    );
  }

  /** A revoked Run can't act, so its presence ends now, before its Runner acknowledges. */
  endRevokedRunActors(
    grants: readonly { readonly runId: RunId; readonly bindingGeneration: number }[],
  ): void {
    // A lineage read already under way predates the revocation and could reinstall the actor.
    this.#authorityGeneration++;
    for (const actor of this.#actors.values())
      if (
        grants.some(
          (grant) => grant.runId === actor.runId && grant.bindingGeneration === actor.generation,
        )
      )
        this.#clearActor(actor);
  }

  invalidatePlaceAuthority(threadIds?: readonly ThreadId[], ownerId?: UserId): void {
    this.#onTabsChanged();
    // Pending lineage reads have no known scope yet; fence them without clearing live actors.
    this.#authorityGeneration++;
    for (const [key, token] of this.#actorKeys) if (token === null) this.#actorKeys.delete(key);
    for (const actor of this.#actors.values()) {
      if (ownerId && actor.ownerId !== ownerId) continue;
      if (threadIds && !threadIds.some((id) => actor.lineageThreadIds.includes(id))) continue;
      const key = `${actor.sessionId}:${actor.binding}`;
      this.#actorEpochs.set(key, (this.#actorEpochs.get(key) ?? 0) + 1);
      this.#actorKeys.delete(key);
      this.#startActorResolution(
        { agentBindingId: actor.binding, ownerId: actor.ownerId },
        actor.sessionId,
      );
    }
  }

  #clearActor(actor: BrowserActor): void {
    this.#actors.delete(actor.token);
    this.#actorEpochs.delete(`${actor.sessionId}:${actor.binding}`);
    this.#actorKeys.delete(`${actor.sessionId}:${actor.binding}`);
    for (const surfaceId of actor.surfaces.keys()) {
      const place = {
        kind: "browser",
        sessionId: actor.sessionId,
        surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
      } as const;
      for (const ownerId of actor.audience.keys())
        this.#onPlaceNotice(ownerId, {
          type: "host.place-activity-cleared",
          place,
          runId: actor.runId,
          generation: actor.generation,
          seq: ++this.#placeSequence,
        });
    }
    this.#onTabsChanged(
      actor.ownerId,
      [...actor.surfaces.keys()].map((id) => BrowserSurfaceIdSchema.parse(id)),
    );
  }

  #startActorResolution(
    input: { agentBindingId: string; ownerId: UserId },
    sessionId: BrowserSessionId,
  ): void {
    const key = `${sessionId}:${input.agentBindingId}`;
    if (!this.#actorKeys.has(key) && !this.#actorResolutions.has(key)) {
      const epoch = this.#authorityGeneration;
      const actorEpoch = this.#actorEpochs.get(key) ?? 0;
      const work = this.#repository
        .listBrowserSessionViewers(sessionId)
        .then(async (viewers) => {
          const audience = await this.#repository.resolvePlaceActors({
            agentBindingIds: [input.agentBindingId],
            ownerIds: viewers?.userIds ?? [],
          });
          if (
            this.#closed ||
            epoch !== this.#authorityGeneration ||
            actorEpoch !== (this.#actorEpochs.get(key) ?? 0) ||
            this.#endedBindings.has(input.agentBindingId)
          )
            return;
          this.#installActor(input, sessionId, audience);
        })
        .catch((error: unknown) => {
          if (
            epoch === this.#authorityGeneration &&
            actorEpoch === (this.#actorEpochs.get(key) ?? 0)
          )
            this.#actorKeys.set(key, null);
          this.#onError(error);
        })
        .finally(() => {
          this.#actorResolutions.delete(key);
          if (
            !this.#closed &&
            !this.#actorKeys.has(key) &&
            this.#brokers.has(sessionId) &&
            !this.#endedBindings.has(input.agentBindingId)
          )
            this.#startActorResolution(input, sessionId);
        });
      this.#actorResolutions.set(key, work);
    }
  }

  async #actorToken(
    input: { agentBindingId: string; ownerId: UserId },
    sessionId: BrowserSessionId,
  ): Promise<string | undefined> {
    const key = `${sessionId}:${input.agentBindingId}`;
    this.#startActorResolution(input, sessionId);
    let pending = this.#actorResolutions.get(key);
    if (!pending) return this.#actorKeys.get(key) ?? undefined;
    let expired = false;
    const deadline = new Error("Browser actor metadata deadline elapsed.");
    const resolved = async () => {
      while (pending && !expired) {
        await pending;
        if (this.#closed || this.#endedBindings.has(input.agentBindingId)) return undefined;
        // Invalidation starts a replacement before the old lookup finishes.
        pending = this.#actorResolutions.get(key);
      }
      return expired ? undefined : (this.#actorKeys.get(key) ?? undefined);
    };
    try {
      return await withTimeout(resolved(), this.#actorMetadataTimeoutMs, {
        timeoutError: () => {
          expired = true;
          return deadline;
        },
      });
    } catch (error) {
      if (error !== deadline) throw error;
      return undefined;
    }
  }

  #installActor(
    input: { agentBindingId: string; ownerId: UserId },
    sessionId: BrowserSessionId,
    audience: Awaited<ReturnType<BrowserSessionRepository["resolvePlaceActors"]>>,
  ): void {
    const key = `${sessionId}:${input.agentBindingId}`;
    const source = audience[0];
    if (!source) {
      this.#onMissingActor(sessionId, input.agentBindingId);
      const old = [...this.#actors.values()].find(
        (actor) => actor.sessionId === sessionId && actor.binding === input.agentBindingId,
      );
      if (old) this.#clearActor(old);
      this.#actorKeys.set(key, null);
      return;
    }
    let old = [...this.#actors.values()].find(
      (actor) => actor.sessionId === sessionId && actor.binding === input.agentBindingId,
    );
    if (old && old.generation !== source.generation) {
      this.#clearActor(old);
      old = undefined;
    }
    const actor: BrowserActor = old ?? {
      token: randomUUID(),
      sessionId,
      binding: input.agentBindingId,
      ownerId: input.ownerId,
      generation: source.generation,
      runId: source.runId,
      audience: new Map(),
      surfaces: new Map(),
      seq: 0,
      lineageThreadIds: source.lineageThreadIds,
    };
    const next = new Map(audience.map((identity) => [identity.ownerId, identity]));
    for (const ownerId of actor.audience.keys())
      if (!next.has(ownerId))
        for (const surfaceId of actor.surfaces.keys())
          this.#onPlaceNotice(ownerId, {
            type: "host.place-activity-cleared",
            place: {
              kind: "browser",
              sessionId,
              surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
            },
            runId: actor.runId,
            generation: actor.generation,
            seq: ++this.#placeSequence,
          });
    actor.lineageThreadIds = source.lineageThreadIds;
    actor.audience.clear();
    for (const [ownerId, identity] of next) actor.audience.set(ownerId, identity);
    this.#actors.set(actor.token, actor);
    this.#invalidatePageSessions([sessionId]);
    this.#actorKeys.set(key, actor.token);
    if (this.#actorKeys.size > 4096) this.#actorKeys.delete(this.#actorKeys.keys().next().value!);
  }

  /**
   * A commit changed these catalog tabs: only the sessions that report or
   * bound one of them read their cut again.
   */
  shadowTabsChanged(tabIds: ReadonlySet<string>): void {
    if (tabIds.size === 0) return;
    for (const [sessionId, shadow] of this.#shadows) {
      const surfaces = this.#brokers.get(sessionId)?.shadowFacts()?.surfaces;
      const prefix = `${sessionId}:`;
      if (
        [...tabIds].some(
          (id) => surfaces?.has(id) || this.#workspacePageGenerations.has(`${prefix}${id}`),
        )
      )
        shadow.catalogChanged();
    }
  }

  /**
   * A commit may have changed these Runs' eligibility (null: any Run's): only
   * the sessions whose cut or actors involve them read their cut again.
   */
  shadowRunsChanged(runIds: readonly string[] | null): void {
    for (const [sessionId, shadow] of this.#shadows) {
      const involved = new Set(shadow.runs);
      for (const actor of this.#actors.values())
        if (actor.sessionId === sessionId) involved.add(actor.runId);
      if (runIds === null ? involved.size > 0 : runIds.some((id) => involved.has(id)))
        shadow.catalogChanged();
    }
  }

  #startShadow(sessionId: BrowserSessionId, ownerId: UserId): void {
    if (
      !this.#workspaceTabs ||
      !this.#repository.readBrowserSessionCut ||
      this.#shadows.has(sessionId)
    )
      return;
    const shadow = new ShadowHostSession({
      session: sessionId,
      reader: this.#shadowReader,
      read: (surfaces, signal) => this.#shadowCatalog(sessionId, ownerId, surfaces, signal),
      inventory: () => this.#shadowInventory(sessionId),
    });
    this.#shadows.set(sessionId, shadow);
    shadow.catalogChanged();
  }

  /** One cut, bounded by the reader's deadline and abandoned when the comparison stops. */
  async #shadowCatalog(
    sessionId: BrowserSessionId,
    ownerId: UserId,
    surfaces: readonly string[],
    signal: AbortSignal,
  ): Promise<ShadowCatalog | null> {
    const cut = await withDatabaseOperationSignal(signal, Date.now() + 5_000, () =>
      this.#repository.readBrowserSessionCut!(ownerId, sessionId, surfaces),
    );
    if (!cut) return null;
    return {
      ended: cut.state === "closing" || cut.state === "closed" || cut.state === "failed",
      tabs: new Map(cut.tabs.map((tab) => [tab.tabId, tab.generation])),
      closed: new Set(cut.closed),
      eligible: new Set(
        cut.bindings.flatMap(({ run }) =>
          run && run.refusal === null && run.bindingGeneration !== null
            ? [`${run.runId}:${run.bindingGeneration}`]
            : [],
        ),
      ),
      // A Run with no facts at all is unknown, never taken as ineligible.
      known: new Set(
        cut.bindings.flatMap(({ run }) => (run && run.refusal !== "no-run" ? [run.runId] : [])),
      ),
    };
  }

  /** What the runtime reports for the session now, with what the Host knows of each surface. */
  #shadowInventory(sessionId: BrowserSessionId): ShadowInventory | null {
    const facts = this.#brokers.get(sessionId)?.shadowFacts();
    if (!facts) return null;
    const prefix = `${sessionId}:`;
    const admitted = new Map<string, number>();
    for (const [key, generation] of this.#workspacePageGenerations)
      if (key.startsWith(prefix)) admitted.set(key.slice(prefix.length), generation);
    const holders = [];
    for (const actor of this.#actors.values())
      if (actor.sessionId === sessionId)
        for (const surface of actor.surfaces.keys())
          holders.push({ surface, run: actor.runId, bindingGeneration: actor.generation });
    return { ...facts, admitted, holders };
  }

  #restoreHoldings(sessionId: BrowserSessionId, viewers?: readonly UserId[]): Promise<void> {
    return this.#serializeKey(`holdings:${sessionId}`, async () => {
      const epoch = this.#authorityGeneration;
      const holdings = await this.#repository.listBrowserPlaceHoldings(sessionId);
      if (epoch !== this.#authorityGeneration || this.#closed) return;
      const missing = [
        ...new Map(
          holdings
            .filter((holding) => !this.#actorKeys.has(`${sessionId}:${holding.agentBindingId}`))
            .map((holding) => [holding.agentBindingId, holding]),
        ).values(),
      ];
      if (missing.length) {
        const ownerIds =
          viewers ?? (await this.#repository.listBrowserSessionViewers(sessionId))?.userIds ?? [];
        const audience = await this.#repository.resolvePlaceActors({
          agentBindingIds: missing.map((holding) => holding.agentBindingId),
          ownerIds,
        });
        if (epoch !== this.#authorityGeneration || this.#closed) return;
        for (const holding of missing)
          if (!this.#endedBindings.has(holding.agentBindingId))
            this.#installActor(
              holding,
              sessionId,
              audience.filter((identity) => identity.agentBindingId === holding.agentBindingId),
            );
      }
      this.#holdings.set(
        sessionId,
        new Set(
          holdings.flatMap((holding) =>
            holding.tabId ? [`${holding.agentBindingId}:${holding.tabId}`] : [],
          ),
        ),
      );
      for (const holding of holdings) {
        const token = this.#actorKeys.get(`${sessionId}:${holding.agentBindingId}`);
        const actor = token ? this.#actors.get(token) : undefined;
        if (actor && holding.tabId && !actor.surfaces.has(holding.tabId))
          actor.surfaces.set(holding.tabId, {
            at: 0,
            seq: 0,
            heldAt: holding.lastUsedAt.getTime(),
          });
      }
      this.#invalidatePageSessions([sessionId]);
    });
  }

  async flushPendingTabDescriptors(): Promise<void> {
    await Promise.all(
      [...this.#brokers]
        .filter(
          ([sessionId, broker]) =>
            this.#tabDescriptorTimers.has(sessionId) ||
            broker.hasTabChanges ||
            this.#sessionOperations.has(`catalog:${sessionId}`),
        )
        .map(([sessionId, broker]) => this.#flushTabDescriptors(sessionId, broker)),
    );
  }

  tabOccupants(ownerId: UserId, sessionId: BrowserSessionId, tabId: BrowserSurfaceId) {
    return this.#occupants(ownerId, sessionId, tabId);
  }

  /** The saved session's record when the agent may reach it, live or not; otherwise null. */
  async agentReachableSavedSession(
    input: {
      readonly ownerId: UserId;
      readonly agentBindingId?: string;
    },
    sessionId: BrowserSessionId,
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "listBrowserSessions"
      | "resolveResourceAccess"
      | "runCapabilityScope"
      | "assertActiveGrant"
    > = this.#repository,
  ): Promise<BrowserSessionRecord | null> {
    const session = await repository.getBrowserSessionForOwner(sessionId, input.ownerId);
    return session !== null &&
      (await this.agentMayAccessSession(input, session, repository, "read"))
      ? session
      : null;
  }

  #beginTaskPageOpen(sessionId: BrowserSessionId) {
    let opens = this.#taskPageOpens.get(sessionId);
    if (!opens) {
      opens = { inFlight: 0, openers: new Map() };
      this.#taskPageOpens.set(sessionId, opens);
    }
    opens.inFlight++;
    return opens;
  }

  #queueTabDescriptors(sessionId: BrowserSessionId): void {
    if (this.#tabDescriptorTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.#tabDescriptorTimers.delete(sessionId);
      void this.#flushTabDescriptors(sessionId).catch(this.#onError);
    }, 100);
    timer.unref();
    this.#tabDescriptorTimers.set(sessionId, timer);
  }

  #flushTabDescriptors(
    sessionId: BrowserSessionId,
    broker = this.#brokers.get(sessionId),
  ): Promise<void> {
    const timer = this.#tabDescriptorTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#tabDescriptorTimers.delete(sessionId);
    return this.#serializeKey(`catalog:${sessionId}`, async () => {
      if (broker && this.#workspaceTabs) {
        const changes = broker.tabChanges();
        let ownerId: UserId | undefined;
        let record: BrowserSessionRecord | null = null;
        try {
          ownerId = (await this.#repository.listBrowserSessionViewers(sessionId))?.userIds[0];
          if (ownerId)
            record = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
        } finally {
          if (!record) {
            for (const tab of changes.tabs)
              if (
                tab.creatorAttachmentId &&
                !this.#workspacePageGenerations.has(`${sessionId}:${tab.id}`)
              )
                await this.#closeUnrecordedStandardCdpPage(sessionId, tab);
          }
        }
        const pending =
          record && ownerId
            ? await this.#writeWorkspacePages(
                record,
                ownerId,
                broker.groupId,
                changes.tabs,
                changes.closed,
              )
            : new Set<BrowserSurfaceId>();
        broker.acknowledgeTabChanges({
          ...changes,
          tabs: changes.tabs.filter((tab) => !pending.has(tab.id)),
        });
        if (record)
          this.#onTabsChanged(
            ownerId,
            [...changes.tabs.map((tab) => tab.id), ...changes.closed],
            changes.stateDirty,
          );
      }
    });
  }

  #serializeKey<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#sessionOperations.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#sessionOperations.set(sessionId, result);
    void result
      .finally(() => {
        if (this.#sessionOperations.get(sessionId) === result)
          this.#sessionOperations.delete(sessionId);
      })
      .catch(() => undefined);
    return result;
  }

  #recordActorUse(actor: BrowserActor, surfaceId: BrowserSurfaceId, force = false): Promise<void> {
    const broker = this.#brokers.get(actor.sessionId);
    const key = broker?.pageKeyOf(surfaceId);
    if (key === undefined) return Promise.resolve();
    const previous = actor.surfaces.get(surfaceId);
    if (!force && previous?.recordedPage?.key === key) return actor.usageTail ?? Promise.resolve();
    const recordedPage = { key, at: this.#activityClock.now() };
    actor.surfaces.set(surfaceId, { at: 0, seq: 0, ...previous, recordedPage });
    const page = broker?.pageOf(surfaceId) ?? null;
    // Separate transactions keep lastUsedAt ordered; now() is fixed inside a transaction.
    const tail = (actor.usageTail ?? Promise.resolve())
      .then(() =>
        this.#repository.recordAgentBrowserUse({
          agentBindingId: actor.binding,
          ownerId: actor.ownerId,
          sessionId: actor.sessionId,
          tabId: surfaceId,
          page,
        }),
      )
      .then(async (credits) => {
        this.#noteLastHeldSession(actor.sessionId, actor.binding);
        this.announceUsage(credits);
        await this.#restoreHoldings(actor.sessionId);
      })
      .catch((error: unknown) => {
        const surface = actor.surfaces.get(surfaceId);
        if (surface?.recordedPage === recordedPage) delete surface.recordedPage;
        this.#onError(error);
      });
    actor.usageTail = tail;
    return tail;
  }

  #runtimeActivity(sessionId: BrowserSessionId, activity: BrowserRuntimeActivity): void {
    const actor = this.#actors.get(activity.actorToken);
    if (
      !actor ||
      actor.sessionId !== sessionId ||
      this.#endedBindings.has(actor.binding) ||
      activity.seq <= actor.seq
    )
      return;
    const broker = this.#brokers.get(sessionId);
    if (!broker?.live || broker.geometryOf(activity.surfaceId) === undefined) return;
    if (broker.geometryOf(activity.surfaceId) !== activity.geometryRevision)
      activity = { ...activity, pointer: null };
    actor.seq = activity.seq;
    const data = this.#placeData(sessionId, activity.surfaceId);
    const surfaceId = activity.surfaceId;
    // The Run's settled tab is its latest use, even after it stopped, so the
    // actor is held here rather than looked up when the place lands.
    if (data)
      this.#enterRunPlace(actor.runId, actor.generation, data, async (at, coalesced) => {
        const recorded = actor.surfaces.get(surfaceId)?.recordedPage;
        if (!coalesced && recorded && recorded.at >= at) return;
        await this.#recordActorUse(actor, surfaceId, true);
      });

    this.#noteAgentCommand(sessionId, actor.binding);
    const at = this.#activityClock.now();
    const previous = actor.surfaces.get(activity.surfaceId);
    const wasActing = previous !== undefined && at - previous.at < this.#actingWindowMs;
    actor.surfaces.set(activity.surfaceId, { ...previous, at, seq: activity.seq });
    if (this.#requestPins.size) broker.refreshSessionState();
    void this.#recordActorUse(actor, activity.surfaceId);
    const previousTimer = this.#actingTimers.get(sessionId);
    if (previousTimer) previousTimer();
    const deadlines = [...this.#actors.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .flatMap((entry) => [...entry.surfaces.values()].map(({ at }) => at + this.#actingWindowMs))
      .filter((deadline) => deadline > at);
    this.#scheduleActingEnd(sessionId, Math.min(at + this.#actingWindowMs, ...deadlines) - at);
    if (!wasActing) {
      this.#invalidatePageSessions([sessionId]);
    }
    const key = `${sessionId}:${activity.surfaceId}`;
    this.#activityPending.set(`${key}:${actor.token}`, {
      actor,
      activity,
      at,
      order: ++this.#placeOrder,
    });
    if (this.#activityTimers.has(key)) return;
    const flush = () => {
      let delivered = false;
      this.#activityTimers.delete(key);
      for (const [pendingKey, pending] of this.#activityPending) {
        if (delivered) break;
        if (!pendingKey.startsWith(`${key}:`)) continue;
        this.#activityPending.delete(pendingKey);
        if (this.#actors.get(pending.actor.token) !== pending.actor) continue;
        const broker = this.#brokers.get(sessionId);
        if (!broker?.live || this.#activityClock.now() >= pending.at + this.#actingWindowMs)
          continue;
        const order = pending.order;
        delivered = true;
        const place = {
          kind: "browser",
          sessionId,
          surfaceId: pending.activity.surfaceId,
        } as const;
        for (const [ownerId, identity] of pending.actor.audience) {
          const value: BrowserPlaceActivity = {
            threadId: identity.threadId,
            place,
            runId: pending.actor.runId,
            generation: pending.actor.generation,
            seq: ++this.#placeSequence,
            order,
            at: pending.at,
            expiresAt: pending.at + this.#actingWindowMs,
            pointer:
              broker.geometryOf(pending.activity.surfaceId) === pending.activity.geometryRevision
                ? pending.activity.pointer
                : null,
            geometryRevision: pending.activity.geometryRevision,
          };
          this.#onPlaceNotice(ownerId, { type: "host.place-activity", activity: value });
        }
      }
      if (
        [...this.#activityPending.keys()].some((pendingKey) => pendingKey.startsWith(`${key}:`))
      ) {
        const next = setTimeout(flush, 100);
        next.unref();
        this.#activityTimers.set(key, next);
      }
    };
    const timer = setTimeout(flush, 100);
    timer.unref();
    this.#activityTimers.set(key, timer);
  }

  announceUsage(credits: readonly BrowserUsageCredit[]): void {
    if (!credits.length) return;
    this.#onUsageChanged(credits);
    const ids = [
      ...new Set(credits.filter((c) => c.joined).flatMap((c) => c.catalogSessionIds ?? [])),
    ];
    if (ids.length) this.#onSessionsChanged(ids);
  }

  async listProfiles(ownerId: UserId) {
    const [profiles, homes] = await Promise.all([
      this.#repository.listBrowserProfiles(ownerId),
      this.#repository.listEligibleBrowserRunners(ownerId),
    ]);
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      home: this.#profileHome(profile, homes),
      ...(profile.purpose === "engine-sign-in" ? { purpose: profile.purpose } : {}),
    }));
  }

  async listAgentProfiles(ownerId: UserId) {
    return this.listProfiles(ownerId);
  }

  async openAgentTab(
    agent: {
      ownerId: UserId;
      agentBindingId: string;
      threadId: ThreadId;
      environmentId?: EnvironmentId;
    },
    input: BrowserAgentTabOpenInput,
  ): Promise<BrowserAgentTabOpenResult> {
    const scope = await this.admitAgentBrowser(agent);
    if (scope && scope.threadId !== agent.threadId)
      throw new OpensteerError({
        code: "forbidden",
        message: "This tab belongs to a different task binding.",
      });
    let identity: NonNullable<BrowserTabOpenCommand["identity"]>;
    let placement: BrowserPlacementSelector | undefined;
    if (input.identity.kind === "profile") {
      const profiles = await this.#repository.listBrowserProfiles(agent.ownerId);
      const name = input.identity.profile;
      const byId = profiles.find((profile) => profile.id === name);
      const matches = byId
        ? [byId]
        : profiles.filter((profile) => profile.name.toLowerCase() === name.toLowerCase());
      if (matches.length !== 1)
        throw new OpensteerError({
          code: "bad_request",
          message: matches.length
            ? "That profile name is ambiguous. Use browser_profile_list and pass a profile ID."
            : "Unknown browser profile. Use browser_profile_list to find its name or ID.",
        });
      identity = { kind: "profile", profileId: matches[0]!.id };
    } else {
      identity = { kind: "guest" };
      const homes = await this.#repository.listEligibleBrowserRunners(agent.ownerId);
      placement = this.#defaultPlacement(
        {
          origin: "agent",
          ...(input.identity.computer ? { chosenRunnerId: input.identity.computer } : {}),
          ...(agent.environmentId ? { environmentId: agent.environmentId } : {}),
        },
        this.#eligiblePlacements(homes),
        homes,
      );
    }
    const opened = await this.openTab(
      agent.ownerId,
      {
        type: "browser.tab.open",
        identity,
        ...(placement ? { placement } : {}),
        ...(input.url && input.url !== "about:blank" ? { url: input.url } : {}),
        idempotencyKey: createHash("sha256")
          .update(`agent:${agent.agentBindingId}:${input.operationKey}`)
          .digest("hex"),
      },
      agent,
    );
    const { backend, record } = await this.#admitAgentBackend(
      { ...agent, sessionId: opened.sessionId },
      undefined,
      true,
    );
    await this.admitAgentBrowser(agent, "read-write", [record]);
    await this.#recordAgentTabPlace(agent, record, opened.tabId);
    return { tabId: opened.tabId, sessionId: opened.sessionId, backend };
  }

  readonly pageTabs: PageTabsPort = {
    open: (actor, target, key, typed) => this.#openWorkspacePage(actor, target, key, typed),
    admitted: async (write) => {
      const row = await this.#workspaceTabs?.get(write.ownerId, write.id);
      if (row?.pageBinding && row.pageBinding.sessionId === write.pageBinding?.sessionId) {
        this.#workspacePageGenerations.set(
          `${row.pageBinding.sessionId}:${row.id}`,
          row.generation,
        );
        if (row.url && row.url !== "about:blank") this.#pagesAwaitingNavigation.add(row.id);
        await this.#flushTabDescriptors(row.pageBinding.sessionId);
      }
    },
    states: (ownerId, rows) => this.#workspacePageStates(ownerId, rows),
    state: async (ownerId, row) => (await this.#workspacePageStates(ownerId, [row])).get(row.id)!,
    activate: async (ownerId, row) => {
      const pooledSession =
        this.#pools.size && row.pageBinding
          ? await this.#repository.getBrowserSessionForOwner(row.pageBinding.sessionId, ownerId)
          : null;
      const pool =
        pooledSession && !this.#ended(pooledSession)
          ? this.#pool(pooledSession.runnerId)
          : undefined;
      const signal = pool
        ? AbortSignal.any([this.#closing.signal, AbortSignal.timeout(browserOpenWorkMs)])
        : undefined;
      let expectedSession = row.pageBinding?.sessionId;
      const recheck = async () => {
        signal?.throwIfAborted();
        const current = await this.#requireWorkspaceGeneration(ownerId, row);
        if (pool && current.pageBinding?.sessionId !== expectedSession)
          throw new OpensteerError({ code: "not_found", message: "This tab has changed browser." });
        return current;
      };
      if (pool) await recheck();
      const reservation =
        pool && signal ? await this.#reservePool(pool.gate, signal, pooledSession!.id) : undefined;
      try {
        if (pool) await recheck();
        const session = await this.#restoreWorkspacePage(ownerId, row, undefined, signal);
        expectedSession = session.id;
        const broker = this.#brokers.get(session.id);
        if (broker?.surfaceStateOf(row.id) === "suspended")
          await broker.requestCdp(
            {
              type: "cdp.command",
              requestId: randomUUID(),
              command: { method: browserHostMethods.resumeTab, parameters: { surfaceId: row.id } },
            },
            signal,
            pool
              ? {
                  recheck: async () => {
                    await recheck();
                  },
                  submitted: () => {},
                }
              : undefined,
          );
        const current = await recheck();
        await this.pageTabs.admitted!(pool ? current : row);
        await broker?.markPersonUsed(row.id);
        return { kind: "page", sessionId: session.id, surfaceId: row.id };
      } finally {
        reservation?.release();
      }
    },
    bind: (claims, row) => this.bindPage(claims, row),
    bindBrowserScript: (actor, row) => {
      if (
        row.pageBinding &&
        this.tabOccupants(actor.authority.ownerId, row.pageBinding.sessionId, row.id).some(
          ({ threadId, holding }) => holding && threadId !== actor.threadId,
        )
      )
        throw new OpensteerError({
          code: "conflict",
          message: "This tab is in use by another task.",
        });
      return this.#bindWorkspacePage(actor.authority, row, actor.signal, actor.browserSend);
    },
    closeViewers: async (ownerId, row, closePage) => {
      const binding = row.pageBinding;
      if (!binding) return;
      const closing = closePage
        ? this.#queuePhysicalPageClose(binding.sessionId, binding.surfaceId, undefined, {
            ownerId,
            row,
          })
        : undefined;
      this.#brokers.get(binding.sessionId)?.removePersonTab(row.id, row.generation);
      await closing;
    },
  };

  async #workspacePageStates(ownerId: UserId, rows: TabRecord[]) {
    const profiles = rows.some((row) => row.profileId)
      ? new Set((await this.#repository.listBrowserProfiles(ownerId)).map((profile) => profile.id))
      : new Set();
    return new Map<BrowserSurfaceId, import("../tabs/ports.js").NativeTabTargetState>(
      rows.map((row) => {
        if (row.profileId && !profiles.has(row.profileId))
          return [
            row.id,
            {
              state: "unavailable" as const,
              unavailableCode: "profile-unavailable" as const,
              unavailableReason: "This browser profile is unavailable.",
              usedBy: [],
            },
          ];
        const binding = row.pageBinding;
        const broker = binding ? this.#brokers.get(binding.sessionId) : undefined;
        return [
          row.id,
          {
            state:
              broker?.live && broker.pageOf(row.id) && broker.surfaceStateOf(row.id) !== "suspended"
                ? ("open" as const)
                : ("asleep" as const),
            usedBy: binding
              ? this.#occupants(ownerId, binding.sessionId, row.id).map((holder) => ({
                  taskId: holder.threadId,
                }))
              : [],
          },
        ];
      }),
    );
  }
  async #requireWorkspaceGeneration(ownerId: UserId, row: TabRecord) {
    const current = await this.#workspaceTabs?.get(ownerId, row.id);
    if (!current || current.generation !== row.generation)
      throw new OpensteerError({ code: "not_found", message: "This tab has closed." });
    return current;
  }
  async #openWorkspacePage(
    actor: TabActor,
    target: Extract<TabTarget, { kind: "page" }>,
    key: string,
    typed = false,
  ): Promise<TabWrite> {
    const ownerId =
      actor.kind === "person"
        ? actor.ownerId
        : actor.kind === "run"
          ? actor.claims.requestedBy
          : actor.kind === "browser-binding"
            ? actor.authority.ownerId
            : actor.caller.userId;
    if (actor.kind === "connection")
      throw new OpensteerError({
        code: "forbidden",
        message: "Opening a page requires a Run or the person.",
      });
    const agent =
      actor.kind === "run"
        ? {
            ownerId,
            agentBindingId: `run:${actor.claims.runId}`,
            threadId: actor.claims.threadId,
            environmentId: actor.claims.environmentId,
          }
        : actor.kind === "browser-binding"
          ? {
              ...actor.authority,
              threadId: actor.threadId,
              ...(actor.browserSend ? { browserSend: actor.browserSend } : {}),
            }
          : undefined;
    const profiles = await this.#repository.listBrowserProfiles(ownerId);
    const profile =
      "profileId" in target ? profiles.find((profile) => profile.id === target.profileId) : null;
    if ("profileId" in target && !profile)
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found." });
    const eligibleRunners =
      !profile && actor.kind === "run"
        ? await this.#repository.listEligibleBrowserRunners(ownerId)
        : null;
    const placement =
      eligibleRunners && actor.kind === "run"
        ? this.#defaultPlacement(
            {
              origin: "agent",
              environmentId: actor.claims.environmentId,
              ...("computerId" in target && target.computerId
                ? { chosenRunnerId: await this.#selfRunnerId(target.computerId) }
                : {}),
            },
            this.#eligiblePlacements(eligibleRunners),
            eligibleRunners,
          )
        : undefined;
    if (actor.kind === "browser-binding") actor.signal?.throwIfAborted();
    const opened = await this.openTab(
      ownerId,
      {
        type: "browser.tab.open",
        idempotencyKey: key,
        identity: profile ? { kind: "profile", profileId: profile.id } : { kind: "guest" },
        ...(placement
          ? { placement }
          : "computerId" in target && target.computerId
            ? {
                placement: {
                  kind: "runner" as const,
                  runnerId: await this.#selfRunnerId(target.computerId),
                },
              }
            : {}),
        ...(target.url === "about:blank" ? {} : { url: target.url }),
        ...(typed && actor.kind === "person" ? { typed: true } : {}),
        ...(target.viewport ? { viewport: target.viewport } : {}),
      },
      agent,
      actor.kind === "browser-binding" ? actor.signal : undefined,
    );
    const record = await this.#repository.getBrowserSessionForOwner(opened.sessionId, ownerId);
    if (!record)
      throw new OpensteerError({
        code: "not_found",
        message: "The browser ended before opening its tab.",
      });
    if (agent) {
      await this.#admitAgentBackend(
        { ...agent, sessionId: record.id },
        undefined,
        !agent.browserSend,
      );
      await this.#recordAgentTabPlace(agent, record, opened.tabId);
    }
    const descriptor = this.#brokers
      .get(record.id)
      ?.clientRows(this.#presence(record.id))
      .records.get(opened.tabId);
    const openedBy: TabOpenedBy = agent ? { taskId: agent.threadId } : "person";
    this.#workspacePageGenerations.set(`${record.id}:${opened.tabId}`, 1);
    return {
      id: opened.tabId,
      ownerId,
      kind: "page",
      computerId: await this.#selfDeviceId(record.runnerId),
      title: descriptor?.title ?? target.url,
      url:
        descriptor?.url === "about:blank" && target.url !== "about:blank"
          ? target.url
          : (descriptor?.url ?? target.url),
      favicon: (() => {
        const broker = this.#brokers.get(record.id);
        const ref = broker?.clientRows(this.#presence(record.id)).iconRef(opened.tabId);
        return ref ? (broker?.icon(ref) ?? null) : null;
      })(),
      profileId: record.profileId,
      profileName: profile?.name ?? null,
      openedBy,
      pageBinding: {
        lineageId: opened.groupId ?? record.id,
        sessionId: record.id,
        surfaceId: opened.tabId,
      },
    };
  }
  async #restoreWorkspacePage(
    ownerId: UserId,
    initial: TabRecord,
    agent?: CdpAuthority,
    signal?: AbortSignal,
  ): Promise<BrowserSessionRecord> {
    if (!this.#workspaceTabs)
      throw new OpensteerError({ code: "not_found", message: "Workspace tabs are unavailable." });
    const tabs = this.#workspaceTabs;
    return this.#serializeKey(
      `workspace-restore:${initial.pageBinding?.lineageId ?? initial.id}`,
      async () => {
        signal?.throwIfAborted();
        let row = await this.#requireWorkspaceGeneration(ownerId, initial);
        const binding = row.pageBinding;
        if (!binding)
          throw new OpensteerError({
            code: "conflict",
            message: "This page has no restorable browser identity.",
          });
        if (this.#pendingPageCloses.get(binding.sessionId)?.has(binding.surfaceId))
          throw new OpensteerError({
            code: "conflict",
            message: "This browser tab is still closing.",
          });
        const previous = await this.#repository.getBrowserSessionForOwner(
          binding.sessionId,
          ownerId,
        );
        if (agent && previous) await this.admitAgentBrowser(agent, "read-write", [previous]);
        const broker = this.#brokers.get(binding.sessionId);
        if (previous && !this.#ended(previous) && broker?.live && broker.pageOf(row.id)) {
          this.#workspacePageGenerations.set(`${previous.id}:${row.id}`, row.generation);
          return previous;
        }
        // A restore remains on its saved computer and profile, including Guest.
        const homes = await this.#repository.listEligibleBrowserRunners(ownerId);
        const rowRunnerId = await this.#selfRunnerId(row.computerId);
        if (!homes.some((home) => home.id === rowRunnerId))
          throw new OpensteerError({
            code: "forbidden",
            message: "This browser computer is unavailable.",
          });
        // The exact profile, or Guest, this restore starts.
        if (agent)
          await this.admitAgentBrowser(agent, "read-write", [], this.#repository, false, {
            profileId: row.profileId,
          });
        signal?.throwIfAborted();
        const sessionId = this.#newSessionId();
        this.#workspacePageGenerations.set(`${sessionId}:${row.id}`, row.generation);
        const dormant = (await tabs.snapshot(ownerId)).rows
          .filter(
            (other) =>
              other.kind === "page" &&
              other.id !== row.id &&
              other.pageBinding?.lineageId === binding.lineageId,
          )
          .map((other) => other.id);
        this.#pagesAwaitingNavigation.add(row.id);
        const budget = this.#poolStartBudget(signal);
        let bound: TabRecord | undefined;
        try {
          const finish = await this.#prepareStart(
            {
              ownerId,
              sessionId,
              tabGroupId: binding.lineageId,
              initialSurfaceId: row.id,
              onPageBound: (written) => {
                bound = written;
              },
              tabGeneration: row.generation,
              previousPageBinding: binding,
              dormantSurfaceIds: dormant,
              ...(this.#pools.has(rowRunnerId) && row.url === "about:blank"
                ? {}
                : { initialUrl: row.url! }),
              placement: { kind: "runner", runnerId: rowRunnerId },
              ...(row.profileId ? { profileId: row.profileId } : { fresh: true }),
              origin: agent ? "agent" : "person",
              ...(agent ? { agentBindingId: agent.agentBindingId } : {}),
              opener:
                previous?.opener ??
                (agent
                  ? await this.#repository.browserSessionOpenerForBinding(
                      agent.agentBindingId,
                      ownerId,
                    )
                  : { kind: "person", userId: ownerId }),
            },
            undefined,
            undefined,
            budget,
          );
          await finish();
          try {
            row = await this.#requireWorkspaceGeneration(ownerId, initial);
          } catch (error) {
            this.#pagesAwaitingNavigation.delete(initial.id);
            // Only the tab's own verdict that it is gone ends the page that started for it: no
            // tab shows that page and no one could close it. Any other failure leaves the person's
            // open tab bound to its live session for the next activation. The witness is the row
            // as the bind wrote it; the refusal does not wait on the close.
            if (error instanceof OpensteerError && error.code === "not_found")
              void this.#queuePhysicalPageClose(
                sessionId,
                initial.id,
                undefined,
                bound ? { ownerId, row: bound } : undefined,
              ).catch((closeError: unknown) => this.#onError(closeError));
            throw error;
          }
          const record = row.pageBinding
            ? await this.#repository.getBrowserSessionForOwner(row.pageBinding.sessionId, ownerId)
            : null;
          if (!record)
            throw new OpensteerError({ code: "not_found", message: "The restored browser ended." });
          if (agent)
            await this.#admitAgentBackend({ ...agent, sessionId: record.id }, undefined, true);
          return record;
        } finally {
          budget?.pool?.reservation.release();
        }
      },
    );
  }
  async bindPage(claims: RunToolScope, row: TabRecord) {
    return this.#bindWorkspacePage(
      { ownerId: claims.requestedBy, agentBindingId: `run:${claims.runId}` },
      row,
    );
  }
  async #bindWorkspacePage(
    agent: CdpAuthority,
    row: TabRecord,
    signal?: AbortSignal,
    pooled?: PooledBrowserSend,
  ) {
    signal?.throwIfAborted();
    await this.admitAgentBrowser(agent);
    const current = await this.#requireWorkspaceGeneration(agent.ownerId, row);
    const old = current.pageBinding;
    if (pooled) {
      const session = old && (await this.#usableAgentSession(agent, old.sessionId, false));
      if (
        !session ||
        session.runnerId !== pooled.target.runnerId ||
        session.runtimeId !== pooled.target.runtimeId ||
        !this.#brokers.get(session.id)?.live ||
        !(await this.pooledScriptPageWitness(agent.ownerId, session.id, row.id))
      )
        throw new BrowserCdpConnectionEnded("This browser page is stale.");
      const { backend } = await this.#admitAgentBackend({ ...agent, sessionId: session.id });
      await this.#requireWorkspaceGeneration(agent.ownerId, row);
      return { tabId: row.id, sessionId: session.id, backend, reloaded: false };
    }
    const found =
      this.#pools.size &&
      old &&
      (await this.#repository.getBrowserSessionForOwner(old.sessionId, agent.ownerId));
    // An ended session (a pooled one a Stop left closing included) wakes nothing for this page.
    const existing = found && !this.#ended(found) ? found : undefined;
    const pool = existing ? this.#pool(existing.runnerId) : undefined;
    if (pool && existing) {
      await this.admitAgentBrowser(agent, "read-write", [existing]);
      await this.#requireAgentAccess(existing.runnerId);
    }
    const reservation =
      pool && existing
        ? await this.#reserveAgentPool(
            pool.gate,
            agent.agentBindingId,
            existing.id,
            signal,
            existing.runnerId,
            async () => {
              await this.admitAgentBrowser(agent, "read-write", [existing]);
              await this.#requireAgentAccess(existing.runnerId);
            },
          )
        : undefined;
    try {
      if (reservation) {
        const fresh = await this.#requireWorkspaceGeneration(agent.ownerId, row);
        if (fresh.pageBinding?.sessionId !== old?.sessionId)
          throw new BrowserCdpConnectionEnded("This browser page changed while waiting.");
      }
      const live =
        old &&
        this.#brokers.get(old.sessionId)?.live &&
        this.#brokers.get(old.sessionId)?.pageOf(row.id);
      const session = await this.#restoreWorkspacePage(agent.ownerId, current, agent, signal);
      const { backend } = await this.#admitAgentBackend(
        { ...agent, sessionId: session.id },
        undefined,
        true,
      );
      const fresh = await this.#requireWorkspaceGeneration(agent.ownerId, row);
      await this.pageTabs.admitted!(fresh);
      await this.admitAgentBrowser(agent, "read-write", [session]);
      await this.#recordAgentTabPlace(agent, session, row.id);
      return { tabId: row.id, sessionId: session.id, backend, reloaded: !live };
    } finally {
      reservation?.release();
    }
  }
  async #writeWorkspacePages(
    record: BrowserSessionRecord,
    ownerId: UserId,
    lineageId: BrowserSessionId,
    descriptors: readonly PageDescriptor[],
    closed: readonly BrowserSurfaceId[],
  ): Promise<Set<BrowserSurfaceId>> {
    const tabs = this.#workspaceTabs;
    const pending = new Set<BrowserSurfaceId>();
    if (!tabs || record.origin === "trigger" || record.opener?.kind === "automation")
      return pending;
    for (const descriptor of descriptors) {
      if (this.#pendingPageCloses.get(record.id)?.has(descriptor.id)) continue;
      const binding: PageBinding = { lineageId, sessionId: record.id, surfaceId: descriptor.id };
      let row: TabRecord | null;
      if (descriptor.creatorAttachmentId) {
        try {
          row = await this.#recordStandardCdpPage(record, descriptor, binding, ownerId, tabs);
          this.#workspacePageGenerations.set(`${record.id}:${row.id}`, row.generation);
        } catch (error) {
          await this.#closeUnrecordedStandardCdpPage(record.id, descriptor);
          if (!(error instanceof BrowserCdpConnectionEnded)) this.#onError(error);
          continue;
        }
      } else row = await tabs.get(ownerId, descriptor.id, true);
      if (!row && !descriptor.openerId && record.origin === "person") {
        const opens = this.#taskPageOpens.get(record.id);
        const openedBy = opens?.openers.get(descriptor.id);
        if (!openedBy && opens?.inFlight) {
          pending.add(descriptor.id);
          continue;
        }
        const profile = record.profileId
          ? (await this.#repository.listBrowserProfiles(ownerId)).find(
              (profile) => profile.id === record.profileId,
            )
          : null;
        const write: TabWrite = {
          id: descriptor.id,
          ownerId,
          kind: "page",
          computerId: await this.#selfDeviceId(record.runnerId),
          title: descriptor.title,
          url: descriptor.url,
          profileId: record.profileId,
          profileName: profile?.name ?? null,
          openedBy: openedBy ?? "person",
          pageBinding: binding,
          ...(descriptor.favicon !== undefined ? { favicon: descriptor.favicon } : {}),
        };
        await tabs.open(write, `person-page:${record.id}:${descriptor.id}`, async (tx) =>
          authorizeTabTarget({ kind: "person", ownerId }, write, tx),
        );
        if (opens) {
          opens.openers.delete(descriptor.id);
          if (!opens.inFlight && !opens.openers.size) this.#taskPageOpens.delete(record.id);
        }
      } else if (!row && descriptor.openerId) {
        const opener = await tabs.get(ownerId, descriptor.openerId, true);
        if (!opener) {
          pending.add(descriptor.id);
          continue;
        }
        if (opener.pageBinding?.sessionId !== record.id) continue;
        await tabs.open(
          {
            id: descriptor.id,
            ownerId,
            kind: "page",
            computerId: await this.#selfDeviceId(record.runnerId),
            title: descriptor.title,
            url: descriptor.url,
            profileId: opener.profileId,
            profileName: opener.profileName,
            openedBy: opener.openedBy,
            openerTabId: descriptor.openerId,
            pageBinding: binding,
            ...(descriptor.favicon !== undefined ? { favicon: descriptor.favicon } : {}),
          },
          `popup:${record.id}:${descriptor.id}`,
        );
      }
      if (!row) {
        row = await tabs.get(ownerId, descriptor.id, true);
        if (row)
          this.#workspacePageGenerations.set(`${record.id}:${descriptor.id}`, row.generation);
      }
      if (!row) {
        pending.add(descriptor.id);
        continue;
      }
      if (!row.closedAt) {
        const generation = this.#workspacePageGenerations.get(`${record.id}:${row.id}`);
        if (generation === undefined) {
          pending.add(row.id);
          continue;
        }
        await tabs.updatePage(
          ownerId,
          row.id,
          generation,
          binding,
          descriptor,
          this.#pagesAwaitingNavigation.has(row.id),
        );
        if (descriptor.url !== "about:blank") this.#pagesAwaitingNavigation.delete(row.id);
      }
    }
    for (const tabId of closed) {
      const row = await tabs.get(ownerId, tabId);
      if (
        row?.pageBinding?.sessionId !== record.id ||
        this.#workspacePageGenerations.get(`${record.id}:${tabId}`) !== row.generation
      )
        continue;
      await tabs.close(
        ownerId,
        [tabId],
        `physical-close:${record.id}:${tabId}:${row.generation}`,
        async (_tx, rows) => {
          const current = rows.find((row) => row.id === tabId);
          if (
            !current ||
            current.generation !== row.generation ||
            current.pageBinding?.sessionId !== record.id
          )
            throw new OpensteerError({ code: "conflict", message: "The page binding changed." });
        },
      );
      this.#pagesAwaitingNavigation.delete(tabId);
    }
    if (pending.size && pending.size < descriptors.length)
      return this.#writeWorkspacePages(
        record,
        ownerId,
        lineageId,
        descriptors.filter((descriptor) => pending.has(descriptor.id)),
        [],
      );
    return pending;
  }

  async #recordStandardCdpPage(
    record: BrowserSessionRecord,
    descriptor: PageDescriptor,
    pageBinding: PageBinding,
    ownerId: UserId,
    tabs: TabStore,
  ): Promise<TabRecord> {
    const claims = this.#standardCdpAttachments.get(descriptor.creatorAttachmentId!)?.claims;
    const threadId = claims?.facts.threadId;
    const existing = await tabs.get(ownerId, descriptor.id, true);
    if (existing) {
      if (
        existing.closedAt ||
        existing.openedBy === "person" ||
        !existing.openedBy ||
        (threadId && existing.openedBy.taskId !== threadId) ||
        existing.pageBinding?.sessionId !== record.id
      )
        throw new BrowserCdpConnectionEnded("This page is no longer an open task tab.");
      return existing;
    }
    if (
      !claims?.facts.seed ||
      !threadId ||
      claims.browserSessionId !== record.id ||
      claims.authority.ownerId !== ownerId
    )
      throw new BrowserCdpConnectionEnded("This page's browser authority has ended.");
    const actor = { kind: "browser-binding", authority: claims.authority, threadId } as const;
    const profile = (await this.#repository.listBrowserProfiles(ownerId)).find(
      (item) => item.id === record.profileId,
    );
    const opener = descriptor.openerId ? await tabs.get(ownerId, descriptor.openerId, true) : null;
    const write: TabWrite = {
      id: descriptor.id,
      ownerId,
      kind: "page",
      computerId: await this.#selfDeviceId(record.runnerId),
      title: descriptor.title,
      url: descriptor.url,
      profileId: record.profileId,
      profileName: profile?.name ?? null,
      openedBy: { taskId: threadId },
      ...(opener?.pageBinding?.sessionId === record.id ? { openerTabId: opener.id } : {}),
      pageBinding,
      ...(descriptor.favicon !== undefined ? { favicon: descriptor.favicon } : {}),
    };
    await tabs.open(write, `connected-page:${record.id}:${descriptor.id}`, async (tx) => {
      if (
        this.#endedBindings.has(claims.authority.agentBindingId) ||
        (claims.authority.expiresAt ?? Infinity) <= Date.now()
      )
        throw new BrowserCdpConnectionEnded("This page's browser authority has ended.");
      await authorizeTabTarget(actor, write, tx);
    });
    const row = await tabs.get(ownerId, descriptor.id);
    if (!row) throw new BrowserCdpConnectionEnded("This page is no longer an open task tab.");
    return row;
  }

  async #closeUnrecordedStandardCdpPage(
    sessionId: BrowserSessionId,
    descriptor: PageDescriptor,
  ): Promise<void> {
    await this.#queuePhysicalPageClose(sessionId, descriptor.id, () => {
      const creator = this.#standardCdpAttachments.get(descriptor.creatorAttachmentId!);
      creator?.close("A page could not be added to Tabs.");
    });
  }

  async #recordAgentTabPlace(
    agent: { ownerId: UserId; agentBindingId: string },
    record: BrowserSessionRecord,
    tabId: BrowserSurfaceId,
  ) {
    if (this.#endedBindings.has(agent.agentBindingId))
      throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    const actorKey = `${record.id}:${agent.agentBindingId}`;
    const existingToken = this.#actorKeys.get(actorKey);
    const existingActor = existingToken ? this.#actors.get(existingToken) : undefined;
    const actor = existingActor
      ? { runId: existingActor.runId, generation: existingActor.generation }
      : (
          await this.#repository.resolvePlaceActors({
            agentBindingIds: [agent.agentBindingId],
            ownerIds: [agent.ownerId],
          })
        )[0];
    const data = this.#placeData(record.id, tabId);
    if (actor && data) this.#enterRunPlace(actor.runId, actor.generation, data);
    const broker = this.#brokers.get(record.id);
    const key = broker?.pageKeyOf(tabId);
    const previous = existingActor?.surfaces.get(tabId);
    if (key !== undefined && existingActor && previous?.recordedPage?.key === key) {
      return;
    }
    this.announceUsage(
      await this.#repository.recordAgentBrowserUse({
        ...agent,
        sessionId: record.id,
        tabId,
        page: data ? { title: data.title, site: data.site ?? "" } : null,
      }),
    );
    this.#noteLastHeldSession(record.id, agent.agentBindingId);
    await this.#restoreHoldings(record.id);
    if (key !== undefined) {
      const token = this.#actorKeys.get(actorKey);
      const installed = token ? this.#actors.get(token) : undefined;
      if (installed) {
        const currentSurface = installed.surfaces.get(tabId);
        installed.surfaces.set(tabId, {
          at: 0,
          seq: 0,
          ...currentSurface,
          recordedPage: { key, at: this.#activityClock.now() },
        });
      }
    }
  }

  async listAgentSessions(input: {
    agentBindingId: string;
    ownerId: UserId;
  }): Promise<readonly AgentBrowserSessionSummary[]> {
    const [records, profiles, attached] = await Promise.all([
      this.#repository.listActiveBrowserSessionsForAgent({ ownerId: input.ownerId }),
      this.#repository.listBrowserProfiles(input.ownerId),
      this.#repository.listActiveBrowserSessionsForAgentBinding(input.agentBindingId),
    ]);
    const ids = new Set(attached.map((r) => r.id));
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    return records.flatMap((record) =>
      record.profileId !== null && !names.has(record.profileId)
        ? []
        : [
            {
              ...publicSession(record),
              activeAttachmentCount: record.activeAttachmentCount,
              attached: ids.has(record.id),
              profileName: record.profileId === null ? null : names.get(record.profileId)!,
            },
          ],
    );
  }

  async openAgentSession(input: {
    readonly agentBindingId: string;
    readonly chosenRunnerId?: RunnerId;
    readonly environmentId?: EnvironmentId;
    readonly fresh?: true;
    readonly ownerId: UserId;
    readonly profileId?: BrowserProfileId;
    readonly sessionId?: BrowserSessionId;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly session: AgentBrowserSessionSummary; readonly wasExisting: boolean }> {
    // The tool and control-plane schemas already enforce this; the service keeps
    // its own invariant so identity can never be inferred here.
    if ([input.fresh, input.profileId, input.sessionId].filter(Boolean).length !== 1) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Choose an existing tab, a browser profile, or Guest.",
      });
    }
    const chosenRunnerId = input.chosenRunnerId;
    if (chosenRunnerId && input.sessionId) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "An existing tab already belongs to a computer, so selecting it cannot choose one.",
      });
    }
    // Opening by profile or fresh always starts a new session; continuing one
    // is always by its ID. A Run may hold several sessions at once.
    if (input.sessionId) {
      const record = await this.#repository.getBrowserSessionForOwner(
        input.sessionId,
        input.ownerId,
      );
      if (!record || this.#ended(record)) {
        throw new OpensteerError({ code: "not_found", message: "Browser tab unavailable." });
      }
      const accessGeneration = this.#runnerAccessGeneration.get(record.runnerId) ?? 0;
      if (!(await this.agentMayAccessSession(input, record))) {
        throw new OpensteerError({
          code: "forbidden",
          message: "That tab is not available to this task.",
        });
      }
      const pool = this.#pool(record.runnerId);
      if (pool) await this.#requireAgentAccess(record.runnerId);
      const reservation = pool
        ? await this.#reserveAgentPool(
            pool.gate,
            input.agentBindingId,
            record.id,
            input.signal,
            record.runnerId,
            () => this.#admitAgentSession(input, record.id, false),
          )
        : undefined;
      try {
        await this.#holdForAgent(input, record, {
          recheck: Boolean(pool && reservation?.waited),
          requireAccess: true,
          accessGeneration,
        });
        return {
          session: await this.#agentSessionSummary(input, record.id),
          wasExisting: true,
        };
      } finally {
        reservation?.release();
      }
    }

    if (
      input.profileId &&
      !(await this.#repository.getBrowserProfile(input.profileId, input.ownerId))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "This browser profile is unavailable.",
      });
    // The exact profile, or Guest, before any browser starts for this binding.
    const globalAccessGeneration = this.#accessGeneration;
    await this.admitAgentBrowser(input, "read-write", [], this.#repository, false, {
      profileId: input.profileId ?? null,
    });
    const opening = {
      agentBindingId: input.agentBindingId,
      ...(chosenRunnerId ? { chosenRunnerId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      origin: input.agentBindingId.startsWith("trigger:")
        ? ("trigger" as const)
        : ("agent" as const),
      ownerId: input.ownerId,
      reuseExisting: false,
    };
    const budget = this.#poolStartBudget(input.signal);
    try {
      const selection = input.profileId
        ? { ...opening, profileId: input.profileId }
        : { ...opening, fresh: true as const };
      const opened = budget
        ? await this.#startSession(selection, undefined, budget)
        : await this.start(selection);
      const openedRecord = await this.#repository.getBrowserSessionForOwner(
        opened.session.id,
        input.ownerId,
      );
      // The post-open check refusing, by throwing or otherwise, stops the browser it started.
      const reachable =
        openedRecord &&
        (await this.agentMayAccessSession(input, openedRecord).catch(async (error: unknown) => {
          await this.stop(input.ownerId, opened.session.id).catch(() => undefined);
          throw error;
        }));
      if (!reachable) {
        await this.stop(input.ownerId, opened.session.id).catch(() => undefined);
        throw new OpensteerError({
          code: "forbidden",
          message: "The browser became unavailable to this task while it was opening.",
        });
      }
      await this.#holdForAgent(input, openedRecord, {
        requireAccess: true,
        globalAccessGeneration,
      });
      return {
        session: await this.#agentSessionSummary(input, opened.session.id),
        wasExisting: false,
      };
    } finally {
      budget?.pool?.reservation.release();
    }
  }

  async hasBrowserProfiles(ownerId: UserId): Promise<boolean> {
    return (await this.#repository.listBrowserProfiles(ownerId)).length > 0;
  }

  async closeAgentSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
  }): Promise<BrowserSessionId | null> {
    const record = await this.#repository.getBrowserSessionForOwner(input.sessionId, input.ownerId);
    if (!record || this.#ended(record)) return null;
    if (!(await this.agentMayAccessSession(input, record))) {
      throw new OpensteerError({
        code: "forbidden",
        message: "That tab is not available to this task.",
      });
    }
    return this.withRunnerAdmission(record.runnerId, async () => {
      await this.#requireAgentAccess(record.runnerId);
      await this.stop(input.ownerId, record.id);
      return record.id;
    });
  }

  /**
   * Lets the places a Run has entered so far land before its terminal event is
   * committed. It ends nothing: the event may yet be refused, or the Run go on.
   */
  async drainRunPlaces(runId: RunId): Promise<void> {
    // A refused write was reported where it failed; it must not hold up the Run's end.
    await this.#runPlaces.drain(runId);
  }

  /**
   * A Run's end releases every session it held; the sessions themselves stay
   * open. Its agent stops acting in them at once, and any command of its that
   * answers afterwards does not make it look acting again.
   */
  browserBindingEnded(agentBindingId: string): boolean {
    return this.#closed || this.#endedBindings.has(agentBindingId);
  }

  async detachAgentSessionsForBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionId[]> {
    this.#forgetAgentBinding(agentBindingId);
    // A later Host startup fails surviving sessions and deletes their attachments.
    if (this.#closed) return [];
    return this.#serializeKey(`detach:${agentBindingId}`, async () => {
      if (agentBindingId.startsWith("run:")) {
        const runId = agentBindingId.slice(4);
        await this.#runPlaces.drain(runId);
        this.#runPlaces.forget(runId);
      }
      const records =
        await this.#repository.listActiveBrowserSessionsForAgentBinding(agentBindingId);
      const detached = await this.#repository.detachBrowserSessionAttachments(agentBindingId);
      this.#onSessionsChanged(records.map((record) => record.id));
      return detached;
    });
  }

  closeTriggerSessionsForBinding(agentBindingId: string): Promise<readonly BrowserSessionId[]> {
    if (!agentBindingId.startsWith("trigger:") && !agentBindingId.startsWith("watch:")) {
      throw new TypeError("Only Trigger and watch bindings have lifecycle-owned sessions.");
    }
    return this.#serialize(async () => {
      const records =
        await this.#repository.listActiveBrowserSessionsForAgentBinding(agentBindingId);
      for (const record of records) await this.#stopRecord(record);
      return records.map((record) => record.id);
    });
  }

  /**
   * One CDP connection bound to one Browser Session for its whole life. A
   * connection that names its session uses it and records that the binding
   * holds it. One that names none belongs to a Runner that predates session
   * addressing: it follows the binding's most recently opened session and ends
   * when another is opened (a new Host admits older Runners).
   *
   * Every command re-checks authority; once the session is gone or no longer
   * this task's, the command fails with `BrowserCdpConnectionEnded` and the
   * connection ends with it.
   */
  async #admitAgentBackend(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly sessionId?: BrowserSessionId;
    },
    requested?: "cdp" | "actions",
    hold = false,
    captureAuthority?: (facts: StandardCdpAuthority) => void,
    /** Hears the same facts as `captureAuthority` without changing how the admission answers. */
    noteAuthority?: (facts: StandardCdpAuthority) => void,
    lane?: {
      readonly heldProfileId?: BrowserProfileId | null;
      readonly profileWaited?: boolean;
      readonly inRunnerAdmission?: boolean;
    },
  ) {
    const globalAccessGeneration = this.#accessGeneration;
    const sessionId = input.sessionId ?? (await this.#followedAgentSessionId(input));
    // Attaching is new access; a command on an open attachment follows its Run's end.
    // Check authority before inspecting the broker so an unauthorized caller never
    // learns broker state, and defer forwarding captured facts until broker checks pass.
    let captured: StandardCdpAuthority | undefined;
    const record = await this.#admitAgentSession(
      input,
      sessionId,
      !hold && !captureAuthority,
      captureAuthority || noteAuthority
        ? (facts) => {
            captured = facts;
          }
        : undefined,
    );
    const broker = this.#brokers.get(record.id);
    if (!broker)
      throw new BrowserCdpConnectionEnded(
        connectedAgentBinding(input.agentBindingId)
          ? "This tab lost its browser connection. Open it again with the same tabId; discover lists the tabs shared with you."
          : "This tab lost its browser connection. Use tab_list and Browser Harness openPage(tabId) to reconnect.",
      );
    const backend: "cdp" | "actions" | undefined = broker.cdpBoundary
      ? "cdp"
      : broker.agentActions
        ? "actions"
        : undefined;
    if (!backend || (requested !== undefined && requested !== backend))
      throw browserActionFailure(
        "unsupported-operation",
        "This tab does not support that agent backend.",
      );
    if (!broker.sharedControl)
      throw browserActionFailure(
        "unsupported-operation",
        "The browser cannot keep your tab separate from the agent's tab. Update Opensteer on that computer, then reopen the tab.",
      );
    if (captured) (captureAuthority ?? noteAuthority)?.(captured);
    if (hold && input.sessionId)
      await this.#holdForAgent(input, record, { ...lane, globalAccessGeneration });
    return { record, broker, backend };
  }

  async agentBackend(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
  }): Promise<BrowserAgentBackend> {
    const { backend } = await this.#admitAgentBackend(input);
    return { sessionId: input.sessionId, backend, version: 1 };
  }

  async attachActionsForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly sessionId: BrowserSessionId;
    },
    onEvent: (event: BrowserActionEvent) => void,
    onClosed?: () => void,
  ) {
    const record = await this.#usableAgentSession(input, input.sessionId, false);
    if (this.#pool(record.runnerId))
      throw new BrowserCdpConnectionEnded("This browser action transport has no detach receipt.");
    return this.#attachActionsForAgent(input, onEvent, onClosed);
  }

  async #attachActionsForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly sessionId: BrowserSessionId;
    },
    onEvent: (event: BrowserActionEvent) => void,
    onClosed?: () => void,
  ) {
    const { record, broker } = await this.#admitAgentBackend(input, "actions", true);
    const attachmentId = globalThis.crypto.randomUUID();
    const actorToken = (await this.#actorToken(input, record.id)) ?? globalThis.crypto.randomUUID();
    let closed = false;
    const assertOpen = () => {
      if (closed || this.#closed || this.#endedBindings.has(input.agentBindingId))
        throw new BrowserCdpConnectionEnded("This browser attachment has ended.");
    };
    const unsubscribe = broker.subscribeActions(attachmentId, onEvent, () => close());
    const close = () => {
      if (closed) return;
      closed = true;
      this.#deviceAttachments.delete(attachmentId);
      this.#actionAttachments.delete(attachmentId);
      unsubscribe();
      broker.detachActions(attachmentId);
      void broker
        .sendHostCommand({ type: "agent.detach", sessionId: record.id, attachmentId })
        .catch(() => undefined);
      onClosed?.();
    };
    await this.withRunnerAdmission(record.runnerId, async () => {
      this.#deviceAttachments.set(attachmentId, { runnerId: record.runnerId, close });
      this.#actionAttachments.set(attachmentId, {
        binding: input.agentBindingId,
        profileId: record.profileId,
        ownerId: input.ownerId,
        close,
      });
      try {
        await this.#admitAgentBackend(input, "actions");
        assertOpen();
        await broker.sendHostCommand({
          type: "agent.attach",
          sessionId: record.id,
          attachmentId,
          actorToken,
          backend: "actions",
        });
        assertOpen();
      } catch (error) {
        close();
        throw error;
      }
    });
    return {
      session: publicSession(record),
      close,
      dispatch: async (
        value: BrowserActionRequest,
      ): Promise<{ readonly result: Promise<BrowserActionResult> }> => {
        return this.withRunnerAdmission(record.runnerId, async () => {
          const request = BrowserActionRequestSchema.parse(value);
          assertOpen();
          if (request.sessionId !== record.id)
            throw browserActionFailure("forbidden", "The action addresses another browser.");
          await this.#admitAgentBackend(input, "actions");
          assertOpen();
          broker.assertActionTarget(request);
          if (
            (request.action.type === "file.stage" || request.action.type === "file.choose") &&
            !broker.fileStaging
          )
            throw browserActionFailure(
              "unsupported-operation",
              "This browser does not support file staging.",
            );
          this.#noteAgentCommand(record.id, input.agentBindingId);
          return {
            result: broker.requestAction({
              type: "agent.action",
              attachmentId,
              actorToken,
              requestId: globalThis.crypto.randomUUID(),
              request,
            }),
          };
        });
      },
    };
  }

  async reconcileStandardCdpLeases(
    runnerId: RunnerId,
    relayId: string,
    reconcile: (lease: StandardCdpLeaseReconciliation) => Promise<string>,
  ): Promise<void> {
    if (this.#closed || !(this.#repository instanceof OpensteerStore)) return;
    const database = this.#repository.database;
    const leases = await listBrowserStandardCdpLeases(database, runnerId);
    await Promise.all(
      leases
        .filter((lease) => lease.relayId !== relayId)
        .map(async (lease) => {
          try {
            const bootId = await reconcile({
              profileId: lease.profileId,
              generation: lease.generation,
            });
            await this.#standardCdpProfiles.release(lease.profileId, lease.generation, () =>
              releaseBrowserStandardCdpLease(database, lease, {
                contactLost: bootId !== lease.bootId,
              }),
            );
          } catch (error) {
            this.#onError(error);
          }
        }),
    );
  }

  async issueStandardCdpTicket(input: {
    readonly authority: CdpAuthority;
    readonly browserSessionId: BrowserSessionId;
    readonly mode: StandardCdpMode;
    readonly ttl?: number;
    readonly seedTabId?: TabId;
    readonly recheckPooledTarget?: () => Promise<void>;
    readonly operationWitness?: {
      readonly grantRevision: number;
      readonly mode: NonNullable<StandardCdpFacts["accessMode"]>;
      readonly targetGeneration: number | null;
    };
  }): Promise<{ readonly ticket: string; readonly path: string; readonly mode: StandardCdpMode }> {
    const reserve = await this.#reserveBeforeCdpIssue(input);
    const { facts, mode, record } = await this.#standardCdpAdmission(input, input.seedTabId).catch(
      (error: unknown) => {
        reserve?.release();
        throw error;
      },
    );
    const pooled = this.#pool(record.runnerId);
    try {
      const witness = input.operationWitness;
      if (
        witness &&
        (facts.grantRevision !== witness.grantRevision ||
          facts.accessMode !== witness.mode ||
          (witness.targetGeneration !== null &&
            facts.seed?.generation !== witness.targetGeneration))
      )
        throw new BrowserCdpConnectionEnded(
          "This browser authority changed. Request a new attachment.",
        );
      if (this.#closed || this.#endedBindings.has(input.authority.agentBindingId))
        throw new BrowserCdpConnectionEnded("This browser authority has ended.");
      if (pooled && !reserve) throw new BrowserCdpConnectionEnded("The browser runtime changed.");
      let pool: StandardCdpPoolReservation | undefined;
      if (pooled && reserve) {
        if (!(this.#repository instanceof OpensteerStore) || !facts.agentConnectionId)
          throw new BrowserCdpConnectionEnded("This pooled connection has no durable attempt.");
        const documentId =
          facts.seed &&
          this.pageInventory(record.id)?.records.get(facts.seed.surfaceId)?.documentId;
        if (facts.seed && !documentId)
          throw new BrowserCdpConnectionEnded("This browser tab is no longer available.");
        await input.recheckPooledTarget?.();
        if (this.browserBindingEnded(input.authority.agentBindingId))
          throw new BrowserCdpConnectionEnded("This browser authority has ended.");
        pool = {
          target: pooled.identity(),
          release: reserve.release,
          ...(reserve.ended ? { ended: reserve.ended } : {}),
          ...(documentId ? { documentId } : {}),
        };
      }
      const ticket = this.standardCdpTickets.issue({ ...input, facts, mode }, pool);
      return { ticket, path: `${standardCdpConnectPrefix}${ticket}`, mode };
    } catch (error) {
      reserve?.release();
      throw error;
    }
  }

  /**
   * A parked pooled browser wakes before a ticket is issued, never after. Visibility comes from
   * Home data first, so a session outside the task's reach is refused with no wake.
   */
  async #reserveBeforeCdpIssue(input: {
    readonly authority: CdpAuthority;
    readonly browserSessionId: BrowserSessionId;
  }): Promise<BrowserPoolReservation | undefined> {
    if (!this.#pools.size) return undefined;
    const record = await this.#repository.getBrowserSessionForOwner(
      input.browserSessionId,
      input.authority.ownerId,
    );
    const pooled = record && !this.#ended(record) && this.#pool(record.runnerId);
    if (!record || !pooled) return undefined;
    const { authority } = input;
    // Current access is checked from Home data before the wake: a refused caller wakes nothing.
    if (
      this.#closed ||
      this.#endedBindings.has(authority.agentBindingId) ||
      (authority.expiresAt !== undefined && authority.expiresAt <= Date.now())
    )
      throw new BrowserCdpConnectionEnded("This browser authority has ended.");
    const held = await this.#repository.listActiveBrowserSessionsForAgentBinding(
      authority.agentBindingId,
    );
    if (!held.some(({ id }) => id === record.id))
      throw new BrowserCdpConnectionEnded("This task does not have access to that browser tab.");
    await this.admitAgentBrowser(authority, "read-write", [record]);
    await this.#requireAgentAccess(record.runnerId);
    return pooled.gate.reserve(
      AbortSignal.any([this.#closing.signal, AbortSignal.timeout(browserOpenWorkMs)]),
    );
  }

  async attachStandardCdpForAgent(
    claims: StandardCdpTicketClaims,
    signal: AbortSignal,
    admission?: AbortSignal,
    pool?: StandardCdpPoolReservation,
  ) {
    const id = randomUUID();
    const heldEnds = (gate: BrowserPoolGate | undefined) => {
      if (gate ? gate.refusesWrite(pool) : pool?.ended?.aborted)
        throw new BrowserCdpConnectionEnded(
          "This browser is restarting. Request a new attachment.",
        );
    };
    const ending = new AbortController();
    const entry: StandardCdpEntry = {
      claims,
      close: (reason) => ending.abort(new BrowserCdpConnectionEnded(reason)),
    };
    if (
      [...this.#standardCdpAttachments.values()].filter(
        (other) => other.claims.authority.agentBindingId === claims.authority.agentBindingId,
      ).length >= standardCdpMaxLivePerBinding
    ) {
      pool?.release();
      throw new BrowserCdpConnectionEnded("This task has too many live browser connections.");
    }
    this.#standardCdpAttachments.set(id, entry);
    const life = AbortSignal.any([signal, ending.signal, this.#closing.signal]);
    life.addEventListener(
      "abort",
      () => {
        delete entry.since;
      },
      { once: true },
    );
    let profileLease: { profileId: BrowserProfileId; generation: number } | undefined;
    const database =
      this.#repository instanceof OpensteerStore ? this.#repository.database : undefined;
    const releaseProfile = (held: NonNullable<typeof profileLease>) =>
      this.#standardCdpProfiles.release(held.profileId, held.generation, async () => {
        if (database)
          await releaseBrowserStandardCdpLease(database, {
            ...held,
            sessionId: claims.browserSessionId,
          });
      });
    const attempts =
      this.#repository instanceof OpensteerStore && claims.facts.agentConnectionId
        ? this.#repository.connectionCdpAttempts()
        : undefined;
    let attemptRecorded = false;
    let handedOff = false;
    let transportOwnsPool = false;
    const verify = async (check: AbortSignal, expiresAt: number, checkSeed = false) => {
      const checked = AbortSignal.any([life, check]);
      checked.throwIfAborted();
      const admitted = await withDatabaseOperationSignal(checked, expiresAt, () =>
        this.#standardCdpAdmission(
          claims,
          checkSeed ? claims.facts.seed?.surfaceId : undefined,
          claims.facts.seed,
        ),
      );
      const pooled = this.#pool(admitted.record.runnerId);
      if (
        JSON.stringify(admitted.facts) !== JSON.stringify(claims.facts) ||
        admitted.mode !== claims.mode ||
        Boolean(pooled) !== Boolean(pool) ||
        (pool && !isDeepStrictEqual(pooled?.identity(), pool.target))
      )
        throw new BrowserCdpConnectionEnded(
          "This browser authority changed. Request a new attachment.",
        );
      // A restart or a removal holds admission: no ticket is redeemed and no frame passes.
      if (pool) heldEnds(pooled?.gate);
      checked.throwIfAborted();
      return admitted;
    };
    try {
      const deadline = AbortSignal.any([
        life,
        admission ?? AbortSignal.timeout(standardCdpAdmissionMs),
      ]);
      const expiresAt = Date.now() + standardCdpAdmissionMs;
      const admitted = await this.#runProfileLane(claims.facts.profileId, async () => {
        const verified = await verify(deadline, expiresAt, true);
        if (pool && (!attempts || !verified.target.standardCdpRecovery))
          throw new BrowserCdpConnectionEnded("This pooled connection has no durable attempt.");
        const { profileId } = verified.facts;
        const current = profileId ? this.#standardCdpProfiles.held(profileId) : undefined;
        if (current)
          throw new BrowserCdpConnectionEnded("This browser profile is already exclusively held.");
        const recovery =
          claims.mode === "whole-context" ? verified.target.standardCdpRecovery : undefined;
        const bootId = recovery ? await recovery.boot() : undefined;
        deadline.throwIfAborted();
        recovery?.assertCurrent();
        const lease =
          claims.mode === "whole-context" && profileId
            ? {
                ...this.#standardCdpProfiles.acquire(profileId, claims.authority.agentBindingId),
                ...(bootId ? { bootId } : {}),
              }
            : undefined;
        if (lease && profileId) {
          profileLease = { profileId, generation: lease.generation };
          if (database)
            await withDatabaseOperationSignal(deadline, expiresAt, () =>
              acquireBrowserStandardCdpLease(database, {
                profileId,
                sessionId: claims.browserSessionId,
                ownerId: claims.authority.ownerId,
                ...lease,
                ...(recovery ? { relayId: recovery.relayId } : {}),
                ...(attempts ? { attemptId: id } : {}),
              }),
            );
        }
        return { ...verified, lease };
      });
      const { record, broker, target, mode, identity, lease } = admitted;
      const unsubscribe = broker.subscribeCdp(
        () => undefined,
        () => entry.close("This browser connection ended."),
      );
      this.#deviceAttachments.set(id, {
        runnerId: record.runnerId,
        close: () => entry.close("Browser access on this computer ended."),
      });
      const removeSubscriptions = () => {
        unsubscribe();
        this.#deviceAttachments.delete(id);
      };
      if (life.aborted) removeSubscriptions();
      else life.addEventListener("abort", removeSubscriptions, { once: true });
      const authority = admitted.authorityDetails;
      const operationExpiresAt = new Date(expiresAt).toISOString();
      let attemptRecovery: StandardCdpAttemptReconciliation | undefined;
      if (attempts && claims.mode === "session") {
        if (!target.reconcileStandardCdpAttempt || !target.standardCdpRecovery)
          throw new BrowserCdpConnectionEnded(
            "This computer needs a newer version of Opensteer for a direct browser connection. You can still use browser_use.",
          );
        const runtimeBootId = await target.standardCdpRecovery.boot();
        deadline.throwIfAborted();
        attemptRecovery = {
          attachmentId: id,
          sessionId: record.id,
          runtimeBootId,
          operationExpiresAt,
        };
      }
      if (attempts) {
        if (!authority?.agentConnectionId || authority.grantRevision === null)
          throw new BrowserCdpConnectionEnded("This browser authority has ended.");
        const { agentConnectionId, grantRevision, mode, threadId } = authority;
        attemptRecorded = true;
        await withDatabaseOperationSignal(deadline, expiresAt, () =>
          attempts.open(record.id, id, {
            connectionId: agentConnectionId,
            grantRevision,
            mode,
            threadId,
            ...(attemptRecovery ? { recovery: attemptRecovery } : {}),
          }),
        );
        deadline.throwIfAborted();
      }
      const { opening } = await this.withRunnerAdmission(record.runnerId, async () => {
        deadline.throwIfAborted();
        if (
          [...this.#standardCdpAttachments.values()].filter(
            (other) => other.runnerId === record.runnerId,
          ).length >= standardCdpMaxLivePerRunner
        )
          throw new BrowserCdpConnectionEnded(
            "This computer has too many live browser connections.",
          );
        entry.runnerId = record.runnerId;
        if (pool) {
          await verify(deadline, expiresAt, true);
          const document =
            claims.facts.seed &&
            this.pageInventory(record.id)?.records.get(claims.facts.seed.surfaceId)?.documentId;
          if (document !== pool.documentId)
            throw new BrowserCdpConnectionEnded("This browser page changed before attachment.");
        }
        const ticket = this.#signer.issue({
          access: "read-write",
          creationOrigin: "agent",
          ...(target.actorClaim || pool ? { actor: "agent" } : {}),
          ...(pool
            ? {
                pool: {
                  slot: pool.target.slotId,
                  term: pool.target.term,
                  instance: pool.target.instanceId,
                  epoch: pool.target.epoch,
                  attachment: 1,
                },
              }
            : {}),
          standardCdp: mode,
          ...(attemptRecovery
            ? {
                standardCdpAttempt: {
                  attachmentId: id,
                  runtimeBootId: attemptRecovery.runtimeBootId,
                },
              }
            : {}),
          ...(claims.facts.seed
            ? {
                standardCdpLineage: {
                  attachmentId: id,
                  seedSurfaceId: claims.facts.seed.surfaceId,
                },
              }
            : {}),
          ...(lease ? { standardCdpLease: lease } : {}),
          identity: identity ?? { kind: "fresh" },
          runtimeId: target.runtimeId,
          sessionId: record.id,
          subject: claims.authority.ownerId,
          operationExpiresAt,
        });
        if (lease || attemptRecovery) target.standardCdpRecovery?.assertCurrent();
        // The attach leaves for the guest here: the pool's admission is checked at the dispatch.
        if (pool) heldEnds(this.#pool(record.runnerId!)?.gate);
        handedOff = true;
        return {
          opening: target.standardRuntime
            ? directStandardTransport(target.standardRuntime, ticket, deadline)
            : target.connectStandard!(ticket, deadline).then(({ connection, mode: effective }) =>
                relayStandardTransport(connection, effective),
              ),
        };
      });
      const transport = await opening;
      const held = profileLease;
      if (pool && attempts) {
        transportOwnsPool = true;
        const settled = transport.settled.then(async () => {
          await attempts.settled(record.id, id);
          if (held) await releaseProfile(held);
        });
        const lost = transport.contactLost?.then(() => attempts.lost(record.id, id));
        const recorded = lost ? Promise.race([settled, lost]) : settled;
        // Every exit releases the hold, even when recording the end or the flush fails.
        void recorded
          .catch(this.#onError)
          .then(async () => {
            if (claims.facts.seed) await this.#flushTabDescriptors(record.id, broker);
          })
          .catch(this.#onError)
          .finally(() => {
            this.#standardCdpAttachments.delete(id);
            pool.release();
          });
        void settled.catch(this.#onError);
        void lost?.catch(this.#onError);
      } else {
        const terminal = transport.contactLost
          ? Promise.race([transport.settled, transport.contactLost])
          : transport.settled;
        void terminal
          .then(async () => {
            try {
              if (claims.facts.seed) await this.#flushTabDescriptors(record.id, broker);
            } finally {
              this.#standardCdpAttachments.delete(id);
            }
          })
          .catch(this.#onError);
        if (attempts) {
          void transport.settled.then(() => attempts.settled(record.id, id)).catch(this.#onError);
          if (transport.contactLost)
            void transport.contactLost
              .then(() => attempts.lost(record.id, id))
              .catch(this.#onError);
        }
        if (held) void transport.settled.then(() => releaseProfile(held)).catch(this.#onError);
      }
      const close = () => transport.close();
      if (life.aborted) close();
      else life.addEventListener("abort", close, { once: true });
      deadline.throwIfAborted();
      if (transport.mode !== claims.mode)
        throw new BrowserCdpConnectionEnded(
          "This browser authority changed. Request a new attachment.",
        );
      transport.signal.addEventListener("abort", () => ending.abort(transport.signal.reason), {
        once: true,
      });
      if (transport.signal.aborted) {
        entry.close("Browser Runtime ended.");
        life.throwIfAborted();
      }
      entry.mode = transport.mode;
      entry.since = new Date().toISOString();
      return {
        ...transport,
        signal: life,
        close: () => entry.close("CDP client disconnected."),
        reauthorize: async (signal = AbortSignal.timeout(1_000)) => {
          await verify(signal, Date.now() + 1_000);
        },
        send: async (frame: Buffer) => {
          for (;;) {
            await verify(AbortSignal.timeout(1_000), Date.now() + 1_000);
            const next = await this.withRunnerAdmission(record.runnerId, async () => {
              life.throwIfAborted();
              const fences = [...(this.#pendingPageCloses.get(record.id)?.values() ?? [])].flatMap(
                ({ fence }) => (fence ? [fence] : []),
              );
              if (fences.length) return { fences };
              if (pool) {
                await verify(AbortSignal.timeout(1_000), Date.now() + 1_000, true);
                // The live document is compared at every frame, as at attach.
                if (
                  claims.facts.seed &&
                  this.pageInventory(record.id)?.records.get(claims.facts.seed.surfaceId)
                    ?.documentId !== pool.documentId
                )
                  throw new BrowserCdpConnectionEnded(
                    "This browser page changed. Request a new attachment.",
                  );
              }
              // After the frame's last asynchronous step, immediately before it is written.
              if (pool) heldEnds(this.#pool(record.runnerId!)?.gate);
              return { work: transport.send(frame) };
            });
            if (next.work) return next.work;
            await withTimeout(Promise.all(next.fences), agentRequestTimeoutMs, {
              signal: life,
              timeoutError: () => new BrowserCdpConnectionEnded("A browser tab is still closing."),
            });
          }
        },
      };
    } catch (error) {
      this.#standardCdpAttachments.delete(id);
      entry.close("CDP attachment refused.");
      try {
        if (attempts && attemptRecorded && !transportOwnsPool) {
          if (handedOff) await attempts.lost(claims.browserSessionId, id);
          else await attempts.settled(claims.browserSessionId, id);
        }
        if (profileLease && !handedOff) await releaseProfile(profileLease).catch(this.#onError);
      } finally {
        if (!transportOwnsPool) pool?.release();
      }
      throw error;
    }
  }

  closeStandardCdpForBinding(agentBindingId: string, reason: string): void {
    this.standardCdpTickets.revoke(agentBindingId);
    for (const { claims, close } of this.#standardCdpAttachments.values())
      if (claims.authority.agentBindingId === agentBindingId) close(reason);
  }

  stopStandardCdpAttempt(id: string): void {
    this.#standardCdpAttachments.get(id)?.close("Agent connection authority ended.");
  }

  async reconcileConfinedStandardCdpAttempt(
    runnerId: RunnerId,
    attempt: StandardCdpAttemptReconciliation,
  ): Promise<"ended" | "contact-lost" | undefined> {
    const target = this.#resolveTarget({ kind: "runner", runnerId });
    if (!target?.reconcileStandardCdpAttempt) return;
    const bootId = await target.reconcileStandardCdpAttempt(attempt);
    return bootId === attempt.runtimeBootId ? "ended" : "contact-lost";
  }

  lowerStandardCdpTaskMode(threadId: ThreadId, accessMode: StandardCdpAuthority["mode"]): void {
    this.standardCdpTickets.revokePooled(
      ({ facts }) =>
        facts.threadId === threadId &&
        !!facts.accessMode &&
        !threadAccessModeAtMost(facts.accessMode, accessMode),
    );
    for (const [
      id,
      {
        claims: { facts },
      },
    ] of this.#standardCdpAttachments)
      if (
        facts.threadId === threadId &&
        facts.accessMode &&
        !threadAccessModeAtMost(facts.accessMode, accessMode)
      )
        this.stopStandardCdpAttempt(id);
  }

  closeStandardCdpForConnection(connectionId: string, reason: string): void {
    const bindings = this.standardCdpTickets.bindingsForConnection(connectionId);
    for (const { claims } of this.#standardCdpAttachments.values())
      if (claims.facts.agentConnectionId === connectionId)
        bindings.add(claims.authority.agentBindingId);
    for (const binding of bindings) this.closeStandardCdpForBinding(binding, reason);
  }

  listStandardCdpAttachmentsForBinding(agentBindingId: string) {
    return [...this.#standardCdpAttachments.values()].flatMap(({ claims, mode, since }) =>
      claims.authority.agentBindingId === agentBindingId && mode && since
        ? [
            {
              browserSessionId: claims.browserSessionId,
              profileId: claims.facts.profileId,
              mode,
              since,
            },
          ]
        : [],
    );
  }

  async #standardCdpAdmission(
    input: Pick<StandardCdpTicketClaims, "authority" | "browserSessionId" | "mode">,
    seedTabId?: TabId,
    previousSeed?: StandardCdpFacts["seed"],
  ) {
    const { authority, browserSessionId } = input;
    if (
      this.#closed ||
      this.#endedBindings.has(authority.agentBindingId) ||
      (authority.expiresAt !== undefined && authority.expiresAt <= Date.now())
    )
      throw new BrowserCdpConnectionEnded("This browser authority has ended.");
    let authorityDetails: StandardCdpAuthority | undefined;
    const { record, broker } = await this.#admitAgentBackend(
      { ...authority, sessionId: browserSessionId },
      "cdp",
      false,
      (facts) => {
        authorityDetails = facts;
      },
    );
    const held = await this.#repository.listActiveBrowserSessionsForAgentBinding(
      authority.agentBindingId,
    );
    if (!held.some(({ id }) => id === record.id))
      throw new BrowserCdpConnectionEnded("This task does not have access to that browser tab.");
    const target = this.#resolveTarget(placementOf(record));
    const connected =
      authority.agentBindingId.startsWith("session:") ||
      (authorityDetails?.agentConnectionId && !authority.agentBindingId.startsWith("run:"));
    let seed: StandardCdpFacts["seed"];
    if (connected) {
      if (!target?.standardCdpLineage)
        throw new BrowserCdpConnectionEnded(
          "This device needs a newer version of Opensteer for a direct browser connection. You can still use browser_use.",
        );
      if (!authorityDetails?.agentConnectionId || !authorityDetails.threadId)
        throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
      if (seedTabId) {
        const row = await this.#workspaceTabs?.get(authority.ownerId, seedTabId);
        if (
          !row ||
          row.kind !== "page" ||
          row.openedBy === "person" ||
          row.openedBy?.taskId !== authorityDetails.threadId ||
          row.pageBinding?.sessionId !== record.id ||
          row.pageBinding.surfaceId !== seedTabId ||
          !broker.pageOf(seedTabId)
        )
          throw new BrowserCdpConnectionEnded(
            "This task does not have access to that browser tab.",
          );
        seed = { surfaceId: row.pageBinding.surfaceId, generation: row.generation };
      } else if (previousSeed) seed = previousSeed;
      else
        throw new BrowserCdpConnectionEnded("This task does not have access to that browser tab.");
    }
    if (
      !broker.live ||
      !target ||
      target.runtimeId !== record.runtimeId ||
      target.placementKey !== record.placementKey ||
      (!target.connectStandard && !target.standardRuntime)
    )
      throw new BrowserCdpConnectionEnded(
        "This browser tab does not support direct browser connections.",
      );
    const identity =
      record.profileId && this.#localProfiles
        ? await this.#localProfiles.identity(record.profileId, record.runnerId, target, false)
        : null;
    if (record.profileId && !identity)
      throw new BrowserCdpConnectionEnded("The saved browser profile is unavailable.");
    const facts: StandardCdpFacts = {
      profileId: record.profileId,
      profileBindingId: identity?.binding.bindingId ?? null,
      runtimeId: target.runtimeId,
      placementKey: target.placementKey,
      ...(seed ? { seed } : {}),
      agentConnectionId: authorityDetails?.agentConnectionId ?? null,
      grantRevision: authorityDetails?.grantRevision ?? null,
      ...(authorityDetails?.agentConnectionId
        ? { accessMode: authorityDetails.mode, threadId: authorityDetails.threadId }
        : {}),
    };
    let mode: StandardCdpMode = "session";
    if (input.mode === "whole-context" && record.profileId && target.wholeContextCdp) {
      const holders = await this.#repository.listBrowserSessionAttachmentBindings?.(record.id);
      const others = await this.#repository.listBrowserSessions(authority.ownerId);
      if (
        holders?.length === 1 &&
        holders[0] === authority.agentBindingId &&
        !others.some(
          (other) =>
            other.id !== record.id &&
            other.profileId === record.profileId &&
            !isTerminal(other.state),
        ) &&
        ![...this.#standardCdpAttachments.values()].some(
          (other) =>
            other.claims.facts.profileId === record.profileId &&
            other.claims.authority.agentBindingId !== authority.agentBindingId,
        )
      )
        mode = "whole-context";
    }
    if (this.#closed || this.#endedBindings.has(authority.agentBindingId))
      throw new BrowserCdpConnectionEnded("This browser authority has ended.");
    return { facts, mode, record, target, broker, identity, authorityDetails };
  }

  async attachCdpForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly expiresAt?: number;
      readonly sessionId?: BrowserSessionId;
      readonly scriptTabId?: TabId;
      readonly scriptThreadId?: ThreadId;
      readonly browserSend?: PooledBrowserSend;
      readonly expectedPooledWitness?: string;
      readonly signal?: AbortSignal;
    },
    onEvent: (event: Extract<BrowserServerMessage, { type: "cdp.event" }>["event"]) => void,
    onClosed?: () => void,
  ): Promise<{
    readonly session: HostedBrowserSession;
    readonly pooledWitness?: string;
    readonly pooledClose?: () => Promise<void>;
    close(): void;
    /**
     * Admits the command and hands it to the browser, resolving once it is on
     * its way; `result` settles with the browser's answer. Commands dispatched
     * in turn reach the browser in that order, whenever each is answered.
     */
    dispatch(
      command: BrowserCdpRequest["command"],
      confirmed?: ConfirmedCdpDispatch,
    ): Promise<{ readonly result: Promise<unknown> }>;
    request(command: BrowserCdpRequest["command"]): Promise<unknown>;
  }> {
    const record = input.sessionId
      ? await this.#usableAgentSession(input, input.sessionId, false)
      : await this.#followedAgentSession(input, false);
    const pool = !input.browserSend && this.#pool(record.runnerId);
    if (pool) {
      if (!(this.#repository instanceof OpensteerStore))
        throw new BrowserCdpConnectionEnded("This pooled connection has no durable attempt.");
      await this.admitAgentBrowser(input, "read-write", [record]);
      await this.#requireAgentAccess(record.runnerId);
      const gate = await this.#reserveAgentPool(
        pool.gate,
        input.agentBindingId,
        record.id,
        input.signal,
        record.runnerId,
        () => this.#admitAgentSession(input, record.id, false),
      );
      let relay: PooledBrowserRelay | undefined;
      try {
        relay = await PooledBrowserRelay.open(this.#repository.database, pool.identity(), gate);
        const admitted = relay;
        return await this.#attachCdpForAgent(input, onEvent, onClosed, admitted);
      } catch (error) {
        if (relay) await relay.close();
        else gate.release();
        throw error;
      }
    }
    // Always acquire the profile lane before the runner admission lane (PH1).
    return this.#runProfileLane(record.profileId, (profileWaited) =>
      this.withRunnerAdmission(record.runnerId, () =>
        this.#attachCdpForAgent(input, onEvent, onClosed, undefined, {
          heldProfileId: record.profileId,
          profileWaited,
          inRunnerAdmission: true,
        }),
      ),
    );
  }

  async #attachCdpForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly expiresAt?: number;
      readonly sessionId?: BrowserSessionId;
      readonly scriptTabId?: TabId;
      readonly scriptThreadId?: ThreadId;
      readonly browserSend?: PooledBrowserSend;
      readonly expectedPooledWitness?: string;
    },
    onEvent: (event: Extract<BrowserServerMessage, { type: "cdp.event" }>["event"]) => void,
    onClosed?: () => void,
    pooledRelay?: PooledBrowserRelay,
    lane?: {
      readonly heldProfileId?: BrowserProfileId | null;
      readonly profileWaited?: boolean;
      readonly inRunnerAdmission?: boolean;
    },
  ): Promise<{
    readonly session: HostedBrowserSession;
    readonly pooledWitness?: string;
    readonly pooledClose?: () => Promise<void>;
    close(): void;
    /**
     * Admits the command and hands it to the browser, resolving once it is on
     * its way; `result` settles with the browser's answer. Commands dispatched
     * in turn reach the browser in that order, whenever each is answered.
     */
    dispatch(
      command: BrowserCdpRequest["command"],
      confirmed?: ConfirmedCdpDispatch,
    ): Promise<{ readonly result: Promise<unknown> }>;
    request(command: BrowserCdpRequest["command"]): Promise<unknown>;
  }> {
    // Work under a connection's authority, as the one authority rule resolved this attachment's
    // binding: settled here, once, and never read again per command.
    let connectionWork = connectedAgentBinding(input.agentBindingId);
    const globalAccessGeneration = this.#accessGeneration;
    const { record, broker } = await this.#admitAgentBackend(
      input,
      "cdp",
      !input.browserSend,
      undefined,
      (facts) => {
        if (facts.agentConnectionId !== null) connectionWork = true;
      },
      lane,
    );
    const accessGeneration = this.#runnerAccessGeneration.get(record.runnerId) ?? 0;
    // A runtime that says it can hold the rules itself is told the work is a connection's, so a
    // command it unpacks is checked where it is unpacked; the Home's gate stays for any other.
    const runtimeHoldsConnection =
      connectionWork && this.#resolveTarget(placementOf(record))?.connectionCommands === true;
    const pool = input.browserSend && this.#pool(record.runnerId);
    const pageWitness = (tabId: TabId) =>
      this.pooledScriptPageWitness(input.ownerId, record.id, tabId);
    const expectedPage = pool && input.scriptTabId && (await pageWitness(input.scriptTabId));
    if (
      input.browserSend &&
      (!pool ||
        !expectedPage ||
        (input.expectedPooledWitness && input.expectedPooledWitness !== expectedPage))
    )
      throw new BrowserCdpConnectionEnded("This browser page is stale.");
    if (input.scriptTabId && (this.#endedBindings.has(input.agentBindingId) || this.#closed))
      throw new BrowserCdpConnectionEnded("This browser attachment has ended.");
    if (input.scriptTabId && !broker.supportsBrowserScriptAttachments)
      throw new OpensteerError({
        code: "conflict",
        message: "Update the browser computer to run browser scripts.",
      });
    const scriptAttachmentId = input.scriptTabId ? randomUUID() : undefined;
    let scriptOpening: Promise<BrowserCdpResponse> | undefined;
    const nativeAttachment =
      this.#resolveTarget(placementOf(record))?.localProfileStorage?.engine === "android-webview"
        ? {
            attachmentId: randomUUID(),
            actorToken: (await this.#actorToken(input, record.id)) ?? randomUUID(),
          }
        : null;
    const deviceAttachmentId = randomUUID();
    let attachmentClosed = false;
    const assertAttached = (bindingWasEnded: boolean) => {
      if (
        attachmentClosed ||
        this.#closed ||
        (!bindingWasEnded && this.#endedBindings.has(input.agentBindingId))
      )
        throw new BrowserCdpConnectionEnded("This browser attachment has ended.");
    };
    const close = () => {
      if (attachmentClosed) return;
      attachmentClosed = true;
      this.#deviceAttachments.delete(deviceAttachmentId);
      unsubscribe();
      if (scriptAttachmentId && scriptOpening) {
        void broker
          .sendScriptCleanup({
            type: "cdp.command",
            scriptAttachmentId,
            requestId: randomUUID(),
            command: { method: browserHostMethods.closeScriptAttachment },
          })
          .catch(this.#onError);
      }
      if (nativeAttachment) {
        this.#actionAttachments.delete(nativeAttachment.attachmentId);
        void broker
          .sendHostCommand({
            type: "agent.detach",
            sessionId: record.id,
            attachmentId: nativeAttachment.attachmentId,
          })
          .catch(() => undefined);
      }
      if (pooledRelay) void pooledRelay.close().catch(this.#onError);
      onClosed?.();
    };
    const unsubscribe = broker.subscribeCdp((event) => {
      if (event.scriptAttachmentId === scriptAttachmentId) onEvent(event);
    }, close);
    const inRunnerAdmission = Boolean(lane?.inRunnerAdmission);
    const admissionWaited = !inRunnerAdmission && this.#agentAdmissions.busy(record.runnerId);
    const registerAttachment = async () => {
      if (
        !nativeAttachment &&
        (admissionWaited ||
          this.#accessGeneration !== globalAccessGeneration ||
          (this.#runnerAccessGeneration.get(record.runnerId) ?? 0) !== accessGeneration)
      ) {
        try {
          await this.#admitAgentSession(input, record.id, false);
        } catch (error) {
          close();
          throw error;
        }
      }
      this.#deviceAttachments.set(deviceAttachmentId, {
        runnerId: record.runnerId,
        close,
        ...(scriptAttachmentId || pooledRelay ? { binding: input.agentBindingId } : {}),
      });
      if (nativeAttachment) {
        this.#actionAttachments.set(nativeAttachment.attachmentId, {
          binding: input.agentBindingId,
          profileId: record.profileId,
          ownerId: input.ownerId,
          close,
        });
        try {
          await this.#admitAgentBackend(input, "cdp");
          assertAttached(false);
          await broker.sendHostCommand({
            type: "agent.attach",
            sessionId: record.id,
            backend: "cdp",
            ...nativeAttachment,
          });
          assertAttached(false);
        } catch (error) {
          close();
          throw error;
        }
      }
    };
    if (inRunnerAdmission) await registerAttachment();
    else await this.withRunnerAdmission(record.runnerId, registerAttachment);
    const expired = { result: Promise.resolve({ status: "expired" }) };
    // Admission is everything before the command is handed to the browser; its
    // fences apply until then. The answer arrives on `result`.
    const dispatch = async (
      requested: BrowserCdpRequest["command"],
      confirmed?: ConfirmedCdpDispatch,
    ): Promise<{ readonly result: Promise<unknown> }> => {
      // Refused before any effect, whatever runtime the browser runs: neither the clipboard nor
      // a browser permission is in any grant. The runtime's router refuses the same commands.
      // A connection's work sends only what a standard browser_connect client may, and its
      // page auto-attach reaches iframes and workers only, never paused at start.
      const refusal =
        cdpCommandRefusal(requested.method, requested.parameters, connectionWork) ??
        (connectionWork
          ? connectionCdpRefusal(
              requested.method,
              requested.parameters,
              requested.sessionId !== undefined,
            )
          : undefined);
      if (refusal) throw new OpensteerError({ code: "forbidden", message: refusal });
      const command =
        connectionWork && requested.method === "Target.setAutoAttach" && requested.sessionId
          ? { ...requested, parameters: connectionAutoAttachParameters(requested.parameters) }
          : requested;
      return this.withRunnerAdmission(record.runnerId, async () => {
        confirmed?.signal?.throwIfAborted();
        if (confirmed && input.expiresAt !== undefined && input.expiresAt <= Date.now())
          throw new OpensteerError({ code: "forbidden", message: "Browser authority expired." });
        const bindingWasEnded = this.#endedBindings.has(input.agentBindingId);
        if (confirmed && bindingWasEnded) assertAttached(false);
        if (
          pooledRelay &&
          (command.method === "Target.setAutoAttach" ||
            command.method === "Target.autoAttachRelated")
        )
          throw new BrowserCdpConnectionEnded("Use an explicit page attachment on this browser.");
        if (confirmed && !broker.supportsCdpReplyBudget)
          throw new OpensteerError({
            code: "conflict",
            message: "Update the browser computer to run browser scripts.",
          });
        const lease =
          command.method === "Opensteer.fillLogin" || command.method === "Opensteer.fillCard"
            ? z.object({ loginRef: z.string() }).safeParse(
                command.method === "Opensteer.fillCard"
                  ? {
                      loginRef: z.object({ cardRef: z.string() }).safeParse(command.parameters).data
                        ?.cardRef,
                    }
                  : command.parameters,
              )
            : null;
        if (lease && broker.live && this.#resolveTarget(placementOf(record))?.main !== true)
          return {
            result: Promise.resolve({ status: "unavailable", reason: "main-browser-required" }),
          };
        const fillAllowed = async () =>
          lease?.success &&
          (command.method === "Opensteer.fillCard" ? broker.cardFill : broker.signIn) &&
          broker.live &&
          this.#brokers.has(record.id) &&
          (await this.#validateLoginLease?.({
            loginRef: lease.data.loginRef,
            sessionId: record.id,
            deploymentId: this.#deploymentId,
            ...(input.agentBindingId.startsWith("session:")
              ? {
                  bindingId: input.agentBindingId,
                  profileId: record.profileId,
                  ...(input.scriptTabId ? { tabId: input.scriptTabId } : {}),
                }
              : {}),
          }));
        if (lease && !(await fillAllowed())) return expired;
        assertAttached(bindingWasEnded);
        // Resolve attribution before admission so the first command has its actor
        // token and session authority is still checked after the metadata read.
        // A late command may answer after its Run ended, but cannot recreate
        // its actor. A Run ending during admission still fences that command.
        const actorToken =
          nativeAttachment?.actorToken ??
          (!bindingWasEnded ? await this.#actorToken(input, record.id) : undefined);
        if (lease && !(await fillAllowed())) return expired;
        assertAttached(bindingWasEnded);
        const admitted = await this.#admitAgentBackend(input, "cdp");
        if (admitted.record.id !== record.id)
          throw new BrowserCdpConnectionEnded(
            "This Run selected another browser. Bind the exact tab with Browser Harness openPage(tabId).",
          );
        if (input.scriptTabId) {
          if (
            this.tabOccupants(input.ownerId, record.id, input.scriptTabId).some(
              ({ threadId, holding }) => holding && threadId !== input.scriptThreadId,
            )
          )
            throw new OpensteerError({
              code: "conflict",
              message: "This tab is in use by another task.",
            });
          if (
            command.method === browserHostMethods.resumeTab &&
            (scriptOpening ||
              command.parameters?.surfaceId !== input.scriptTabId ||
              !confirmed?.eventBudget)
          )
            throw new OpensteerError({
              code: "forbidden",
              message: "Bind tabs with openPage(tabId).",
            });
        }
        if (command.method === "Opensteer.stageFile" && !broker.fileStaging) {
          throw new OpensteerError({
            code: "conflict",
            message:
              "The computer running this tab has an older Opensteer version that cannot receive files. Update Opensteer on that computer.",
          });
        }
        if (
          (command.method === browserHostMethods.listTabs ||
            command.method === browserHostMethods.resumeTab) &&
          broker.surfaceState !== 1
        )
          throw browserActionFailure(
            "unsupported-operation",
            "Update the browser computer to list and resume sleeping tabs.",
          );
        if (command.method === browserHostMethods.listTabs) {
          if (!BrowserListTabsParametersSchema.safeParse(command.parameters ?? {}).success)
            throw new OpensteerError({ code: "bad_request", message: "Invalid tab-list cursor." });
        } else if (command.method === browserHostMethods.resumeTab) {
          const parsed = BrowserResumeTabParametersSchema.safeParse(command.parameters);
          if (!parsed.success)
            throw new OpensteerError({
              code: "bad_request",
              message: "A tab surfaceId is required.",
            });
          const { surfaceId } = parsed.data;
          if (broker.surfaceStateOf(surfaceId) === undefined)
            throw new OpensteerError({
              code: "not_found",
              message: "This tab is no longer available in this browser.",
            });
        } else if (Object.values(browserHostMethods).some((method) => method === command.method))
          throw new OpensteerError({
            code: "forbidden",
            message: "This operation is reserved for the Host.",
          });
        // Session admission awaits storage; authority can end during that read.
        if (lease && !(await fillAllowed())) return expired;
        assertAttached(bindingWasEnded);
        this.#noteAgentCommand(record.id, input.agentBindingId);
        assertAttached(bindingWasEnded);
        const replyBudget = confirmed && {
          maxBytes: Math.min(confirmed.maxBytes, maxBrowserTextBytes - 4096),
          maxDepth: confirmed.maxDepth,
          maxEntries: confirmed.maxEntries,
          ...(confirmed.maxImageBytes === undefined
            ? {}
            : { maxImageBytes: confirmed.maxImageBytes }),
        };
        const browserSend = confirmed?.browserSend;
        if (pool && !browserSend)
          throw new BrowserCdpConnectionEnded("This pooled browser command has no admission.");
        if (
          browserSend &&
          (browserSend.target.runnerId !== record.runnerId ||
            browserSend.target.runtimeId !== record.runtimeId)
        )
          throw new BrowserCdpConnectionEnded("This page changed browser.");
        const answered = broker.requestCdp(
          {
            ...(replyBudget ? { replyBudget } : {}),
            ...(scriptAttachmentId ? { scriptAttachmentId } : {}),
            ...(confirmed?.eventBudget ? { scriptEventBudget: confirmed.eventBudget } : {}),
            command,
            ...(actorToken ? { actorToken } : {}),
            ...(nativeAttachment ? { attachmentId: nativeAttachment.attachmentId } : {}),
            ...(runtimeHoldsConnection ? { connection: true as const } : {}),
            requestId: globalThis.crypto.randomUUID(),
            type: "cdp.command",
          },
          confirmed?.signal,
          browserSend
            ? {
                recheck: async () => {
                  await this.#requireAgentAccess(record.runnerId);
                  if (lease && !(await fillAllowed())) throw new BrowserCdpConnectionEnded();
                  await browserSend.recheck();
                  if (!input.scriptTabId || (await pageWitness(input.scriptTabId)) !== expectedPage)
                    throw new BrowserCdpConnectionEnded("This browser page is stale.");
                  assertAttached(false);
                },
                submitted: browserSend.submitted,
                acknowledged: browserSend.acknowledged,
              }
            : pooledRelay
              ? {
                  recheck: async () => {
                    await this.#requireAgentAccess(record.runnerId);
                    await this.admitAgentBrowser(input, "read-write", [record]);
                    assertAttached(false);
                  },
                  submitted: () => pooledRelay.submitted(),
                  acknowledged: () => pooledRelay.acknowledged(),
                }
              : undefined,
        );
        pooledRelay?.track(command.method, command.parameters, answered);
        if (scriptAttachmentId && command.method === browserHostMethods.resumeTab)
          scriptOpening = answered;
        return {
          result: answered.then(async (response) => {
            if (
              command.method === "Target.createTarget" &&
              this.#workspaceTabs &&
              record.origin !== "trigger" &&
              record.opener?.kind !== "automation"
            ) {
              const created = z
                .object({ surfaceId: BrowserSurfaceIdSchema })
                .safeParse(response.result);
              const actor = actorToken ? this.#actors.get(actorToken) : undefined;
              if (created.success && actor) {
                const id = created.data.surfaceId;
                const descriptor = broker.clientRows(this.#presence(record.id)).records.get(id);
                const profile = record.profileId
                  ? (await this.#repository.listBrowserProfiles(input.ownerId)).find(
                      (profile) => profile.id === record.profileId,
                    )
                  : null;
                const write: TabWrite = {
                  id,
                  ownerId: input.ownerId,
                  computerId: await this.#selfDeviceId(record.runnerId),
                  kind: "page",
                  title: descriptor?.title ?? "New tab",
                  url: descriptor?.url ?? "about:blank",
                  profileId: record.profileId,
                  profileName: profile?.name ?? null,
                  openedBy: actor.audience.get(input.ownerId)
                    ? { taskId: actor.audience.get(input.ownerId)!.threadId }
                    : "person",
                  pageBinding: { lineageId: broker.groupId, sessionId: record.id, surfaceId: id },
                };
                await this.#workspaceTabs.open(write, `cdp-open:${record.id}:${id}`, async (tx) => {
                  await this.admitAgentBrowser(
                    input,
                    "read-write",
                    [record],
                    new OpensteerStore(tx),
                  );
                });
                await this.pageTabs.admitted!(write);
                this.#onTabsChanged(input.ownerId, [id]);
              }
            }
            if (command.method === "Target.attachToTarget") {
              const target = z
                .object({ surfaceId: BrowserSurfaceIdSchema })
                .safeParse(response.result);
              // Which page a Run used is durable and true even when its Run ended
              // while the command was answering; the live attachment is not
              // touched here, so that end cannot be undone. The agent has its page
              // either way: recording it never delays the answer or fails it.
              const actor = actorToken ? this.#actors.get(actorToken) : undefined;
              // An actor's own lane skips a page it already recorded: switching back is not a new use.
              if (
                target.success &&
                actor?.sessionId === record.id &&
                broker.pageKeyOf(target.data.surfaceId) !== undefined
              ) {
                void this.#recordActorUse(actor, target.data.surfaceId);
              } else if (target.success) {
                void this.#repository
                  .recordAgentBrowserUse({
                    agentBindingId: input.agentBindingId,
                    ownerId: input.ownerId,
                    page: broker.pageOf(target.data.surfaceId),
                    sessionId: record.id,
                    tabId: target.data.surfaceId,
                  })
                  .then(async (credits) => {
                    this.#noteLastHeldSession(record.id, input.agentBindingId);
                    this.announceUsage(credits);
                    await this.#restoreHoldings(record.id);
                  })
                  .catch(this.#onError);
              }
            }
            return response.result;
          }),
        };
      });
    };
    return {
      close,
      dispatch,
      request: async (command) => (await dispatch(command)).result,
      session: publicSession(record),
      ...(expectedPage ? { pooledWitness: expectedPage } : {}),
      ...(pooledRelay
        ? {
            pooledClose: async () => {
              close();
              await pooledRelay.close();
            },
          }
        : {}),
    };
  }

  /**
   * Durable agent request for browser profile access. The suggestion is advisory:
   * the owner chooses, creates, or declines a profile in Opensteer's approval UI.
   */
  async requestAccess(input: {
    callId: string;
    ownerId: UserId;
    reason: string;
    runId: RunId;
    suggestion: BrowserAccessSuggestion;
    threadId: ThreadId;
  }): Promise<RequestCreationResult & { kind: "browser.access" }> {
    if (
      input.suggestion.kind === "existing" &&
      (await this.#repository.getBrowserProfile(input.suggestion.profileId, input.ownerId)) &&
      !(await this.#repository.requests.findByCallIdentity({
        callId: input.callId,
        originatingRunId: input.runId,
      }))
    )
      throw new OpensteerError({
        code: "conflict",
        message:
          "This browser profile is already available. Open a page with tab_open and its profileId.",
      });
    const created = await this.#repository.requests.create({
      callId: input.callId,
      kind: "browser.access",
      mode: "durable",
      originatingRunId: input.runId,
      originatingThreadId: input.threadId,
      payload: { kind: "browser.access", reason: input.reason, suggestion: input.suggestion },
      presentation: {
        detail: input.reason,
        kind: "external",
        title: "Browser profile",
        subject: { kind: "browser-site", id: "browser-profile" },
      },
      requestedBy: input.ownerId,
      requiredActor: "requester",
    });
    return {
      kind: "browser.access",
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }

  /**
   * The session a sign-in would change, when the caller may act on it: its
   * owner, or its owner's active agent. Null when it is gone.
   */
  async signInTarget(input: {
    readonly ownerId: UserId;
    readonly targetId?: string;
    readonly surfaceId?: string;
    readonly tabId?: BrowserSurfaceId;
    readonly sessionId?: BrowserSessionId;
    readonly agentBindingId?: string;
  }): Promise<BrowserSignInTarget | null> {
    const workspaceRow =
      input.tabId && this.#workspaceTabs
        ? await this.#workspaceTabs.get(input.ownerId, input.tabId)
        : null;
    const bound = workspaceRow?.pageBinding
      ? await this.#repository.getBrowserSessionForOwner(
          workspaceRow.pageBinding.sessionId,
          input.ownerId,
        )
      : null;
    if (
      input.tabId &&
      (!workspaceRow || !bound || (input.sessionId && input.sessionId !== bound.id))
    ) {
      if (input.agentBindingId === undefined) return null;
      throw new OpensteerError({
        code: "conflict",
        message: "This sign-in tab has closed or changed browser. Select its tab again.",
      });
    }
    const sessionId = bound?.id ?? input.sessionId;
    const record = sessionId
      ? await this.#repository.getBrowserSessionForOwner(sessionId, input.ownerId)
      : null;
    if (!record) return null;
    const ended = this.#ended(record);
    if (
      input.agentBindingId !== undefined &&
      !(await this.agentMayAccessSession(
        {
          ownerId: input.ownerId,
          ...(input.agentBindingId ? { agentBindingId: input.agentBindingId } : {}),
        },
        record,
      ))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "That tab is not available to this task.",
      });
    }
    const profile =
      record.profileId === null
        ? null
        : await this.#repository.getBrowserProfile(record.profileId, input.ownerId);
    const broker = this.#brokers.get(record.id);
    let tabId =
      input.tabId ?? (input.surfaceId ? BrowserSurfaceIdSchema.parse(input.surfaceId) : undefined);
    if (tabId && (ended || !broker?.pageOf(tabId))) {
      if (input.tabId && input.agentBindingId === undefined) return null;
      throw new OpensteerError({
        code: "not_found",
        message: "The sign-in page is no longer available.",
      });
    }
    if (input.targetId && !ended && broker?.live) {
      const response = await broker.requestCdp({
        type: "cdp.command",
        requestId: randomUUID(),
        command: { method: "Target.getTargetInfo", parameters: { targetId: input.targetId } },
      });
      tabId = z
        .object({ targetInfo: z.object({ surfaceId: BrowserSurfaceIdSchema.optional() }) })
        .parse(response.result).targetInfo.surfaceId;
    }
    if (input.agentBindingId) await this.admitAgentBrowser(input, "read-write", [record]);
    if (input.tabId) {
      const currentWorkspace = this.#workspaceTabs
        ? await this.#workspaceTabs.get(input.ownerId, input.tabId)
        : null;
      const latest = currentWorkspace?.pageBinding
        ? { id: currentWorkspace.pageBinding.sessionId }
        : null;
      if (
        !latest ||
        latest.id !== record.id ||
        (workspaceRow && currentWorkspace?.generation !== workspaceRow.generation) ||
        ended ||
        !broker?.pageOf(input.tabId)
      ) {
        if (input.agentBindingId === undefined) return null;
        throw new OpensteerError({
          code: "conflict",
          message: "This sign-in tab has closed or changed browser. Select its tab again.",
        });
      }
    }
    const target = this.#resolveTarget(placementOf(record));
    return {
      ...(tabId ? { tabId } : {}),
      ...(workspaceRow
        ? {
            tabGeneration: workspaceRow.generation,
            tabUrl: (tabId && broker?.pageOf(tabId)?.site) || null,
          }
        : {}),
      ...(input.agentBindingId ? { agentBindingId: input.agentBindingId } : {}),
      live: !ended && record.state === "ready" && broker?.live === true,
      profileId: record.profileId,
      profileName: profile?.name ?? null,
      sessionId: record.id,
      deploymentId: this.#deploymentId,
      cardFill: broker?.cardFill ?? false,
      signIn: broker?.signIn ?? false,
      computer: broker?.computer ?? null,
      stateImport: broker?.stateImport ?? false,
      main: target?.main === true,
      ...(target?.localProfileStorage ? { engine: target.localProfileStorage.engine } : {}),
    };
  }

  setLoginLeaseValidator(validate: LoginLeaseValidator): void {
    this.#validateLoginLease = validate;
  }

  #invalidatePageSessions(sessionIds: readonly BrowserSessionId[]) {
    // Who acts on or holds these sessions' pages changed: their comparisons may too.
    for (const id of sessionIds) this.#shadows.get(id)?.inventoryChanged();
    const ids = [...this.#workspacePageGenerations.keys()].flatMap((key) => {
      const session = sessionIds.find((id) => key.startsWith(`${id}:`));
      return session ? [BrowserSurfaceIdSchema.parse(key.slice(session.length + 1))] : [];
    });
    this.#onTabsChanged(undefined, ids);
  }
  tabInventoryChanged(sessionId?: BrowserSessionId, ids?: readonly string[]): void {
    if (ids)
      this.#onTabsChanged(
        undefined,
        ids.map((id) => BrowserSurfaceIdSchema.parse(id)),
      );
    else if (sessionId) this.#invalidatePageSessions([sessionId]);
    else this.#onTabsChanged();
  }
  pageInventory(sessionId: BrowserSessionId): BrowserLiveRows | undefined {
    return this.#brokers.get(sessionId)?.clientRows(this.#presence(sessionId));
  }
  async savedPages(owner: UserId, sessionId?: BrowserSessionId) {
    const snapshot = await this.#workspaceTabs?.snapshot(owner);
    return (
      snapshot?.rows.filter(
        (row) =>
          row.kind === "page" &&
          (!sessionId ||
            row.pageBinding?.sessionId === sessionId ||
            row.pageBinding?.lineageId === sessionId),
      ) ?? []
    );
  }
  tabStateOf(sessionId: BrowserSessionId, surfaceId: BrowserSurfaceId) {
    return this.#brokers.get(sessionId)?.surfaceStateOf(surfaceId);
  }

  setRequestPins(
    key: string,
    pins: readonly {
      sessionId: BrowserSessionId;
      runId: RunId | null;
      surfaceId?: BrowserSurfaceId;
    }[],
  ): void {
    const previous = this.#requestPins.get(key) ?? [];
    if (pins.length)
      this.#requestPins.set(
        key,
        pins.map((pin) => ({
          ...pin,
          surfaceId:
            pin.surfaceId ??
            previous.find((old) => old.sessionId === pin.sessionId && old.runId === pin.runId)
              ?.surfaceId ??
            this.#requestSurface(pin.sessionId, pin.runId),
        })),
      );
    else this.#requestPins.delete(key);
    for (const id of new Set([...previous, ...pins].map((pin) => pin.sessionId)))
      this.#brokers.get(id)?.refreshSessionState();
  }

  observeRequest(request: Request): void {
    const payload = request.payload;
    if (payload.kind !== "browser.sign-in" && payload.kind !== "browser.password-sign-in") return;
    const sessionId =
      "sessionId" in payload ? BrowserSessionIdSchema.parse(payload.sessionId) : null;
    this.setRequestPins(
      request.id,
      request.status === "pending" && sessionId
        ? [
            {
              sessionId,
              runId: request.originatingRunId,
              ...(payload.kind === "browser.sign-in" && payload.tabId
                ? { surfaceId: payload.tabId }
                : {}),
            },
          ]
        : [],
    );
  }

  #requestSurface(sessionId: BrowserSessionId, runId: RunId | null): BrowserSurfaceId | null {
    if (!runId) return null;
    const actor = [...this.#actors.values()].find(
      (actor) => actor.sessionId === sessionId && actor.runId === runId,
    );
    const latest =
      actor &&
      [...actor.surfaces].sort(
        (a, b) =>
          Math.max(b[1].at, b[1].recordedPage?.at ?? 0) -
            Math.max(a[1].at, a[1].recordedPage?.at ?? 0) || b[1].seq - a[1].seq,
      )[0];
    return latest ? BrowserSurfaceIdSchema.parse(latest[0]) : null;
  }

  async #sessionState(
    sessionId: BrowserSessionId,
  ): Promise<Pick<BrowserSessionState, "runs" | "pinned" | "keepAwake">> {
    const runs = await this.#repository.countBrowserSessionAttachments(sessionId);
    const pinned = new Set<BrowserSurfaceId>();
    let keepAwake = false;
    for (const pins of this.#requestPins.values())
      for (const pin of pins) {
        if (pin.sessionId !== sessionId) continue;
        const surfaceId = pin.surfaceId ?? this.#requestSurface(sessionId, pin.runId);
        if (surfaceId) {
          pin.surfaceId = surfaceId;
          pinned.add(surfaceId);
        } else keepAwake = true;
      }
    return { runs, pinned: [...pinned], ...(keepAwake ? { keepAwake: true } : {}) };
  }

  /**
   * Replaces one site's cookies in a live session's browser context. Only the
   * Host sends `state.import`, with its own random operation ID, and only to a
   * Runtime that advertised it; callers have already authorized the transfer.
   */
  async applySiteCookies(
    sessionId: BrowserSessionId,
    site: string,
    cookies: readonly BrowserCookie[],
  ): Promise<ApplySiteCookiesResult> {
    const broker = this.#brokers.get(sessionId);
    if (!broker || this.#closed) return "session-closed";
    if (!broker.stateImport) return "runtime-outdated";
    try {
      await broker.requestStateImport(site, cookies);
    } catch (error) {
      if (!this.#brokers.has(sessionId)) return "session-closed";
      throw error;
    }
    return "applied";
  }

  async resolveRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{
    readonly profile: BrowserProfile | null;
    readonly request: Request;
  }> {
    const pending = await this.#repository.requests.get(input.requestId);
    if (
      !pending ||
      pending.status !== "pending" ||
      pending.requestedBy !== input.resolvedBy ||
      pending.kind !== "browser.access" ||
      input.response.kind !== "external"
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Browser Request is no longer pending or cannot use this response",
      });
    }
    const resolved = await this.#repository.requests.resolveBrowserRequest({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      resolvedBy: input.resolvedBy,
      ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      response: await this.#profileRequestResponse(input.response, pending),
    });
    if (resolved.request.status === "fulfilled" && resolved.profile)
      this.#onProfilesChanged(input.resolvedBy);
    return {
      profile: resolved.profile ? publicProfile(resolved.profile) : null,
      request: resolved.request,
    };
  }

  async #profileRequestResponse(
    response: RequestResponse,
    request: Request,
  ): Promise<RequestResponse> {
    if (response.kind !== "external") return response;
    const value = z
      .union([
        z.strictObject({
          decision: z.literal("fulfilled"),
          createProfile: z.strictObject({
            name: z.string(),
            homeRunnerId: RunnerIdSchema.nullable().optional(),
          }),
        }),
        z.strictObject({ decision: z.literal("fulfilled"), name: z.string() }),
      ])
      .safeParse(response.value);
    if (!value.success) return response;
    const creation =
      "createProfile" in value.data ? value.data.createProfile : { name: value.data.name };
    if ("homeRunnerId" in creation && creation.homeRunnerId) return response;
    const preferred = request.originatingRunId
      ? await this.#profileRequestRunner?.(request.originatingRunId)
      : null;
    const homeRunnerId = await this.#defaultProfileHome(
      request.requestedBy,
      {
        runnerId: preferred ?? null,
      },
      !("homeRunnerId" in creation) || creation.homeRunnerId === undefined,
    );
    return {
      ...response,
      value: { decision: "fulfilled", createProfile: { name: creation.name, homeRunnerId } },
    };
  }

  async attach(
    ownerId: UserId,
    sessionId: BrowserSessionId,
    peer: BrowserConsumerPeer,
    options: {
      readonly authSessionId: AuthSessionId;
      readonly mode: BrowserConsumerMode;
      readonly passkeys?: PasskeyMode | undefined;
      readonly popups?: boolean | undefined;
      /** The person fill version the viewer understands. */
      readonly autofill?: PersonFillVersion | undefined;
      readonly editing?: 1 | 2 | undefined;
      readonly basicInput?: 1 | undefined;
      readonly surfaceState?: 1 | undefined;
      /**
       * Whether the login that opened the socket is still signed in. Read once,
       * after this peer can be reached by `closeAuthSession`, so a login ended
       * at any moment is caught by one or the other. Throws when it cannot tell.
       */
      readonly signedIn: () => Promise<boolean>;
    },
  ): Promise<BrowserConsumerAttachment> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    // Registered before any await: a login that ends while admission reads
    // storage closes this peer through `closeAuthSession`, as it does later.
    const peers = this.#authConsumers.get(options.authSessionId) ?? new Set<BrowserConsumerPeer>();
    peers.add(peer);
    this.#authConsumers.set(options.authSessionId, peers);
    // The reservation only wakes a parked browser for this viewer: it is released once the viewer
    // is attached, and the viewer is then counted as one (W10), which never holds the repair.
    let pooledViewer: BrowserPoolReservation | undefined;
    let viewing: (() => void) | undefined;
    let detached = false;
    const detachAuth = () => {
      detached = true;
      pooledViewer?.release();
      viewing?.();
      peers.delete(peer);
      if (peers.size === 0) this.#authConsumers.delete(options.authSessionId);
    };
    try {
      let persisted = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
      if (!persisted) {
        throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
      }
      const pool = this.#pool(persisted.runnerId);
      if (pool && !this.#ended(persisted)) {
        if (!peer.isOpen() || !(await options.signedIn()))
          throw new OpensteerError({ code: "forbidden", message: "Browser access ended." });
        pooledViewer = await this.#reservePool(
          pool.gate,
          AbortSignal.any([this.#closing.signal, AbortSignal.timeout(this.#connectTimeoutMs)]),
          sessionId,
        );
        persisted = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
        if (!persisted || !peer.isOpen())
          throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
      }
      const broker = this.#brokers.get(sessionId);
      if (!broker || this.#ended(persisted)) {
        throw new OpensteerError({
          code: "conflict",
          message: "The browser session is no longer attached to its Runtime.",
        });
      }
      await withTimeout(broker.ready(), this.#connectTimeoutMs, {
        timeoutError: () => unavailable("Browser is reconnecting."),
      });
      let signedIn: boolean;
      try {
        signedIn = await withTimeout(options.signedIn(), consumerAccessRecheckMs, {
          timeoutError: () => new Error("Browser login check timed out."),
        });
      } catch (error) {
        peer.close(browserViewerCloseCodes.tryAgain, "Browser login could not be checked");
        throw error;
      }
      if (!signedIn) peer.close(browserViewerCloseCodes.loginEnded, "Browser login ended");
      if (!peer.isOpen()) {
        throw new OpensteerError({ code: "forbidden", message: "Browser access ended." });
      }
      // Access can end without a login ending, as when a person leaves the
      // personal inventory; the outlet rereads it on a clock rather than per frame.
      const stillVisible = async () =>
        Boolean(await this.#repository.getBrowserSessionForOwner(sessionId, ownerId));
      const attached = await broker.attach(
        peer,
        options.mode,
        stillVisible,
        detachAuth,
        options.editing,
        options.passkeys,
        options.popups === true,
        ownerId,
        options.signedIn,
        {
          basicInput: options.basicInput,
          surfaceState: options.surfaceState,
          autofill: options.autofill,
        },
      );
      if (pooledViewer && !detached) {
        viewing = this.#pool(persisted.runnerId)?.gate.viewing();
        pooledViewer.release();
        pooledViewer = undefined;
      }
      return attached;
    } catch (error) {
      detachAuth();
      throw error;
    }
  }

  /**
   * A login that ended or expired. Its viewers reconnect with whatever
   * credential the client holds now, which is refused if there is none.
   */
  closeAuthSession(sessionId: AuthSessionId): void {
    for (const peer of this.#authConsumers.get(sessionId) ?? []) {
      peer.close(browserViewerCloseCodes.loginEnded, "Browser login ended");
    }
    this.#authConsumers.delete(sessionId);
  }

  stop(ownerId: UserId, sessionId: BrowserSessionId): Promise<void> {
    return this.#serialize(async () => {
      const persisted = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
      if (!persisted) {
        throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
      }
      for (const waiter of this.#poolWaiters.get(sessionId) ?? [])
        waiter.abort(
          new OpensteerError({ code: "conflict", message: "The person stopped this browser." }),
        );
      this.#endPersonUse(this.#brokers.get(sessionId)?.groupId ?? sessionId);
      await this.#stopRecord(persisted);
    });
  }

  /**
   * Lets go of a session whose machine was retired.
   *
   * The durable row is already failed by the revocation that called this, so
   * there is nothing to write: what is left is the live broker, which would
   * otherwise keep relaying for a computer the Deployment no longer trusts.
   */
  /**
   * What clients show of a pooled browser: phase and since, the last fresh start, failed starts,
   * and the pages not kept until seen. Nothing for an ordinary Home, and no read either.
   */
  async resourcePools(runnerIds: readonly RunnerId[]): Promise<readonly BrowserPoolReportView[]> {
    if (!this.#pools.size || !(this.#repository instanceof OpensteerStore)) return [];
    const reports: BrowserPoolReportView[] = [];
    for (const runnerId of runnerIds)
      if (this.#pools.has(runnerId)) reports.push(...(await this.#poolReport(runnerId)));
    return reports;
  }

  async #poolReport(runnerId: RunnerId): Promise<readonly BrowserPoolReportView[]> {
    const database = (this.#repository as OpensteerStore).database;
    const slot = await readBrowserPoolSlot(database, runnerId);
    const shown = this.#pool(runnerId)?.report();
    const notReady = poolNotReady(shown);
    // A first start the controller refused has no slot row yet: it is reported all the same.
    if (!slot && shown)
      return [
        {
          runnerId,
          phase: shown.phase,
          since: shown.since.toISOString(),
          ...(notReady ? { notReady } : {}),
        },
      ];
    // A removed device's slot waits only for its guest to stop: there is no browser to show.
    if (!slot || slot.phase === "releasing") return [];
    const start = slot.lastStart as { reason?: string; id?: string } | null;
    // The newest unseen notice of each tab, bounded well under the protocol's limit; older
    // unseen ones fall to retention.
    const losses = await listBrowserPoolReportedNotices(database, runnerId);
    const owner = await readBrowserPoolOwner(database);
    const pages = await Promise.all(
      losses.map(async ({ surfaceId, sessionId, intentId, typed }) => {
        const tab = owner ? await this.#workspaceTabs?.get(owner, surfaceId) : null;
        // Reopened in another session: it came back by reloading. Otherwise it is lost.
        const reloaded =
          tab?.pageBinding?.sessionId !== undefined && tab.pageBinding.sessionId !== sessionId;
        return {
          surfaceId,
          noticeId: intentId,
          outcome: reloaded ? ("reloaded" as const) : ("lost" as const),
          typed:
            typed === true
              ? ("yes" as const)
              : typed === false
                ? ("no" as const)
                : ("unknown" as const),
        };
      }),
    );
    const unconfirmedClosings = await listBrowserPoolUnconfirmedClosings(database, runnerId);
    return [
      {
        runnerId,
        phase: shown?.phase ?? slot.phase,
        since: (shown?.since ?? slot.phaseSince).toISOString(),
        ...(start?.reason && start.id
          ? { start: { reason: start.reason as never, at: start.id } }
          : {}),
        ...(slot.failedStarts ? { failures: slot.failedStarts } : {}),
        ...(pages.length ? { pages } : {}),
        ...(notReady ? { notReady } : {}),
        ...(unconfirmedClosings.length
          ? {
              unconfirmedClosings: unconfirmedClosings.map(({ sessionId, surfaceIds }) => ({
                sessionId,
                surfaceIds: [...surfaceIds],
              })),
            }
          : {}),
      },
    ];
  }

  /**
   * The owner's Restart browser on a pooled Cloud Computer browser. The owner is decided where
   * every person's authority is (`admitExecution`). Before the guest is replaced, every Standard
   * CDP connection and broker of this computer is closed without ending its row, so each send
   * already dispatched gets its outcome and the fresh start notes each session it ends.
   */
  async restartPooledBrowser(
    ownerId: UserId,
    runnerId: RunnerId,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!this.#pools.has(runnerId) || !(this.#repository instanceof OpensteerStore))
      throw new OpensteerError({ code: "not_found", message: "This browser does not restart." });
    const database = this.#repository.database;
    await admitExecution(database, { ownerUserId: ownerId, subject: { kind: "person" } });
    await this.#pool(runnerId)!.restart(idempotencyKey ? { key: idempotencyKey } : {});
  }

  /** The person was shown a pooled browser's note: it leaves the report. Nothing elsewhere. */
  async poolNoticeSeen(ownerId: UserId, surfaceId: BrowserSurfaceId, noticeId: string) {
    if (!this.#pools.size || !(this.#repository instanceof OpensteerStore))
      throw new OpensteerError({ code: "not_found", message: "This note is not here." });
    await seeBrowserPoolDocumentLoss(this.#repository.database, ownerId, surfaceId, noticeId);
  }

  /**
   * W15: removes an unconfirmed-closing replaced-browser session from the person's list without
   * changing its database state (Rule 4: an unconfirmed Stop stays closing).
   */
  async dismissUnconfirmedSession(ownerId: UserId, sessionId: BrowserSessionId): Promise<void> {
    if (!(this.#repository instanceof OpensteerStore))
      throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
    await dismissBrowserPoolUnconfirmedSession(this.#repository.database, {
      ownerId,
      sessionId,
      subject: { kind: "person" },
    });
    this.#onSessionsChanged([sessionId]);
  }

  /**
   * A removed device's pooled browser: `ended` are the sessions its revocation already ended,
   * which get their notes with the rest. An ordinary Home returns before any read.
   */
  async poolDeviceRemoved(
    runnerId: RunnerId,
    ended: readonly BrowserSessionId[] = [],
  ): Promise<void> {
    await this.#pools.get(runnerId)?.releaseDevice(ended);
  }

  abandonSession(sessionId: BrowserSessionId): void {
    const broker = this.#brokers.get(sessionId);
    if (!broker) return;
    this.#endPersonUse(broker.groupId);
    this.#brokers.delete(sessionId);
    this.#taskPageOpens.delete(sessionId);
    void broker.stop().then(
      () => {
        // A pooled close the runtime did not answer left the row closing: the loop ends it.
        if (broker.pooled) for (const pool of this.#pools.values()) pool.stopped();
      },
      () => undefined,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closing.abort(unavailable("The Host browser service is shutting down."));
    this.standardCdpTickets.revokePooled(() => true);
    this.#onTabsChanged();
    this.#authorityGeneration++;
    for (const actor of this.#actors.values()) this.#clearActor(actor);
    for (const timer of this.#tabDescriptorTimers.values()) clearTimeout(timer);
    this.#tabDescriptorTimers.clear();
    for (const timer of this.#activityTimers.values()) clearTimeout(timer);
    this.#activityTimers.clear();
    this.#activityPending.clear();
    for (const entry of this.#nativeActivity.values()) entry.timer?.();
    this.#nativeActivity.clear();
    for (const peers of this.#authConsumers.values()) {
      for (const peer of peers) peer.close(1001, "Host browser service closing");
    }
    this.#authConsumers.clear();
    // A drain is the next Home's to go on with, from the retired target's record (W8).
    for (const coordinator of this.#draining) coordinator.close();
    this.#draining.clear();
    this.#closePromise = (async () => {
      await this.#runPlaces.close();
      await Promise.allSettled(this.#sessionOperations.values());
      await this.#operationTail;
      await Promise.all(
        [...this.#brokers].map(([sessionId, broker]) =>
          this.#flushTabDescriptors(sessionId, broker),
        ),
      );
      // A pooled session outlives this Home: nothing is sent for its channel (a close would be
      // relayed to the guest as the session's end) and its row is kept. The Home's link to the
      // Runner ends with the Home, the guest sees its channel lost and keeps the person's pages
      // for its window, and the next Home reattaches them (V7).
      await Promise.allSettled(
        [...this.#brokers.values()].map((broker) =>
          broker.pooled ? broker.letGoPooled("The Home is shutting down.") : broker.stop(),
        ),
      );
      await Promise.allSettled(this.#historyTails.values());
      this.#brokers.clear();
      for (const id of this.#personUseGroups.keys()) this.#endPersonUse(id);
      this.#requestPins.clear();
    })();
    return this.#closePromise;
  }

  #prepareStart(
    input: StartBrowserSessionInput,
    onInitialPage?: (tabId: BrowserSurfaceId) => void,
    personNavigation?: { ownerId: UserId; typed: boolean },
    poolStart?: BrowserTabOpenBudget,
  ): Promise<() => Promise<StartBrowserSessionResult>> {
    return this.#serializeKey(
      input.profileId ? `profile-admission:${input.profileId}` : `start:${input.ownerId}`,
      () => this.#admitStart(input, onInitialPage, personNavigation, poolStart),
    );
  }

  async #admitStart(
    input: StartBrowserSessionInput,
    onInitialPage?: (tabId: BrowserSurfaceId) => void,
    personNavigation?: { ownerId: UserId; typed: boolean },
    poolStart?: BrowserTabOpenBudget,
  ): Promise<() => Promise<StartBrowserSessionResult>> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    const initialUrl = input.initialUrl ? safeNavigationUrl(input.initialUrl) : undefined;

    const origin = input.origin ?? "person";
    const found =
      input.reuseExisting !== true || origin !== "person"
        ? null
        : await this.#repository.findActiveBrowserSessionForPerson(input.ownerId);
    // A pooled session a Stop left closing is neither reused nor ended here: it stays closing
    // until its runtime answers, and this start opens another.
    const existing = found && !this.#ended(found) ? found : null;
    if (existing) {
      const pool = poolStart && this.#pool(existing.runnerId);
      if (pool && poolStart) {
        const reservation = await this.#reservePool(pool.gate, poolStart.signal, existing.id);
        poolStart.pool = { target: pool, reservation };
      }
      const broker = this.#brokers.get(existing.id);
      if (broker) {
        // Identity is immutable, so a personal session that does not already
        // carry the requested identity is a conflict rather than a reuse.
        if (input.fresh && existing.profileId !== null) {
          throw new OpensteerError({
            code: "conflict",
            message: "This browser is using a browser profile.",
          });
        }
        if (input.profileId && existing.profileId === null) {
          throw new OpensteerError({
            code: "conflict",
            message: "This browser is using a signed-out browser session.",
          });
        }
        if (input.profileId && existing.profileId !== input.profileId) {
          throw new OpensteerError({
            code: "conflict",
            message: "This browser is using a different browser profile.",
          });
        }
        if (
          !input.profileId &&
          input.placement &&
          !samePlacement(input.placement, placementOf(existing))
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "This browser browser session is running on another placement.",
          });
        }
        return async () => {
          await broker.ready();
          return { session: await this.#personSession(existing, input.ownerId), wasExisting: true };
        };
      }
      // A pooled one with no channel here may still be held by its guest: it is stopped, and ends
      // with the runtime's answer. Any other is a row with no browser behind it.
      if (this.#pool(existing.runnerId) || this.#isPooledRunner(existing.runnerId))
        await this.#stopRecord(existing);
      else
        await this.#transitionBrowserSession({
          from: ["starting", "ready", "closing"],
          sessionId: existing.id,
          state: "failed",
        });
      if (poolStart?.pool) {
        poolStart.pool.reservation.release();
        delete poolStart.pool;
      }
    }

    const profile = input.profileId
      ? await this.#repository.getBrowserProfile(input.profileId, input.ownerId)
      : null;
    if (input.profileId && !profile) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found." });
    }
    if (profile && !this.#localProfiles)
      throw unavailable("Native browser profile storage is unavailable.");
    const storage = profile ? await this.#localProfiles!.storage(profile.id) : null;
    const boundRunnerId =
      profile?.homeRunnerId ?? (storage?.kind === "local" ? storage.binding.runnerId : undefined);
    const homes = await this.#repository.listEligibleBrowserRunners(input.ownerId);
    const placementHolder =
      boundRunnerId || input.placement || !profile
        ? null
        : await this.#repository.findBrowserSessionHoldingProfilePlacement(profile.id);
    const placements = this.#eligiblePlacements(homes);
    const placement =
      (boundRunnerId ? { kind: "runner" as const, runnerId: boundRunnerId } : input.placement) ??
      (placementHolder
        ? placementOf(placementHolder)
        : this.#defaultPlacement(input, placements, homes));
    // Only the computer this open will use is worth waiting for.
    if (await this.#waitForBrowser(homes, placement.runnerId, input.operationBudget?.signal))
      return this.#admitStart(input, onInitialPage, personNavigation, poolStart);
    if (boundRunnerId) this.#requireProfileHome(profile!, boundRunnerId, homes);
    if (origin !== "person") await this.#requireAgentAccess(placement.runnerId);
    if (!placements.some((candidate) => candidate.runnerId === placement.runnerId))
      throw unavailable("The selected browser computer is unavailable for this open.");
    let target = this.#resolveTarget(placement);
    if (!target)
      throw unavailable(
        boundRunnerId
          ? "Waiting for this computer to open its browser profile. Reconnect the owning computer."
          : "The selected Browser Runtime is not connected.",
      );
    const pooled = this.#pool(placement.runnerId);
    // On a pooled computer a session is created bound to its target, or not at all (W11): with
    // no coordinator here (before its target is adopted, between two targets) it is refused
    // before any row is written.
    if (!pooled && this.#isPooledRunner(placement.runnerId))
      throw new BrowserPoolAdmissionClosed("The pooled browser is between states. Try again.");
    let poolBudget = input.operationBudget as BrowserTabOpenBudget | undefined;
    if (pooled && poolStart) {
      if (input.agentBindingId) {
        await this.admitAgentBrowser(
          { ownerId: input.ownerId, agentBindingId: input.agentBindingId },
          "read-write",
          [],
          this.#repository,
          false,
          { profileId: profile?.id ?? null },
        );
      }
      const reservation = input.agentBindingId
        ? await this.#reserveAgentPool(
            pooled.gate,
            input.agentBindingId,
            undefined,
            poolStart.signal,
            placement.runnerId,
            async () => {
              await this.admitAgentBrowser(
                { ownerId: input.ownerId, agentBindingId: input.agentBindingId! },
                "read-write",
                [],
                this.#repository,
                false,
                { profileId: profile?.id ?? null },
              );
              await this.#requireAgentAccess(placement.runnerId);
            },
          )
        : await this.#reservePool(pooled.gate, poolStart.signal);
      poolStart.pool = { target: pooled, reservation };
      poolStart.signal.throwIfAborted();
      const current = this.#resolveTarget(placement);
      if (!current || current.runtimeId !== target.runtimeId)
        throw unavailable("The browser runtime changed while waiting.");
      target = current;
      poolBudget = poolStart;
      input = { ...input, operationBudget: poolStart };
    }
    if (pooled && poolBudget?.pool?.target !== pooled)
      throw unavailable("The pooled browser has no start reservation.");

    const admit = async () => {
      const sessionId = input.sessionId ?? this.#newSessionId();
      const localIdentity =
        profile && this.#localProfiles
          ? await this.#localProfiles.identity(profile.id, placement.runnerId, target)
          : null;
      if (input.initialSurfaceId && !target.tabRestoreVersion)
        throw unavailable("Update this browser computer to reopen tabs.");
      if (input.agentBindingId) {
        await this.admitAgentBrowser(
          { ownerId: input.ownerId, agentBindingId: input.agentBindingId },
          "read-write",
          [],
          this.#repository,
          false,
          { profileId: profile?.id ?? null },
        );
        await this.#requireAgentAccess(placement.runnerId);
      }
      const record = await this.#repository.createBrowserSession({
        id: sessionId,
        ...(input.tabGroupId ? { tabGroupId: input.tabGroupId } : {}),
        runnerId: placement.runnerId,
        origin,
        opener:
          input.opener !== undefined
            ? input.opener
            : input.agentBindingId
              ? await this.#repository.browserSessionOpenerForBinding(
                  input.agentBindingId,
                  input.ownerId,
                )
              : origin === "person"
                ? { kind: "person", userId: input.ownerId }
                : origin === "trigger"
                  ? { kind: "automation" }
                  : null,
        placementKey: target.placementKey,
        profileId: profile?.id ?? null,
        runtimeId: target.runtimeId,
        ownerId: input.ownerId,
        ...(pooled ? { pooled: true } : {}),
        ...(this.#pooledRunner !== undefined
          ? { onPooledComputer: true as const, pooledRunner: this.#pooledRunner }
          : {}),
      });
      if (input.initialSurfaceId && this.#workspaceTabs) {
        const row = await this.#workspaceTabs.get(input.ownerId, input.initialSurfaceId);
        if (row?.pageBinding && input.tabGroupId === row.pageBinding.lineageId) {
          const bound = await this.#workspaceTabs.bindPage(
            input.ownerId,
            row.id,
            input.tabGeneration ?? row.generation,
            input.previousPageBinding ?? row.pageBinding,
            { lineageId: input.tabGroupId, sessionId, surfaceId: row.id },
          );
          if (!bound)
            throw new OpensteerError({
              code: "conflict",
              message: "The page closed during restoration.",
            });
          input.onPageBound?.(bound);
        }
      }
      if (input.tabGroupId) this.#onTabsChanged();
      this.#onSessionsChanged([record.id]);
      const initialHistoryNavigation =
        profile && initialUrl && personNavigation && target.navigationAttributionVersion
          ? { ...personNavigation, navigationId: randomUUID() }
          : undefined;
      input.operationBudget?.signal.throwIfAborted();
      const tabRestore =
        target.tabRestoreVersion &&
        origin !== "trigger" &&
        !input.agentBindingId?.startsWith("trigger:") &&
        !input.agentBindingId?.startsWith("watch:");
      // The target this session's guest is: the ticket's fence, and the target any end its
      // runtime reports is about (W1).
      const poolFence = pooled ? pooled.fence() : undefined;
      const poolTarget = poolFence ? { slotId: poolFence.slot, term: poolFence.term } : undefined;
      const attachAuthority: Parameters<BrowserAttachTicketSigner["issue"]>[0] = {
        creationOrigin:
          origin === "person" && record.opener?.kind === "person" ? "person" : "agent",
        ...(target.actorClaim || pooled ? { actor: origin === "person" ? "person" : "agent" } : {}),
        ...(poolFence ? { pool: poolFence } : {}),
        access: "read-write",
        ...(target.passkeys && this.#passkeys ? { passkeys: 1 } : {}),
        ...(target.personFill && target.main === true && this.#personal
          ? { personFillVersion: target.personFill }
          : {}),
        ...(target.navigationVersion ? { navigationVersion: 1 } : {}),
        ...(target.navigationAttributionVersion ? { navigationAttributionVersion: 1 } : {}),
        ...(target.popupFollowVersion ? { popupFollowVersion: 1 } : {}),
        ...(target.basicInput ? { basicInput: target.basicInput } : {}),
        ...(target.surfaceState ? { surfaceState: target.surfaceState } : {}),
        ...(target.editing
          ? {
              editingVersion: target.editing,
              ...(target.editing === 2 ? { clipboard: target.clipboard === true } : {}),
            }
          : {}),
        ...(tabRestore
          ? {
              tabRestoreVersion: 1,
              initialSurfaceId: input.initialSurfaceId,
            }
          : {}),
        initialNavigation: {
          operationKey: input.initialPageOperationKey ?? sessionId,
          ...(initialHistoryNavigation
            ? { navigationId: initialHistoryNavigation.navigationId }
            : {}),
          ...(initialUrl ? { url: initialUrl } : {}),
        },
        identity: localIdentity ?? { kind: "fresh" },
        runtimeId: target.runtimeId,
        sessionId,
        subject: input.ownerId,
        // The first page opens at the person's view before anything loads in
        // it. An older browser computer refuses a ticket field it does not know.
        ...(input.viewport && target.sharedControl === true ? { viewport: input.viewport } : {}),
      };
      const ticket = this.#signer.issue({
        ...attachAuthority,
        ...(input.operationBudget
          ? {
              operationExpiresAt: new Date(input.operationBudget.expiresAt).toISOString(),
              remainingBudgetMs: Math.max(1, input.operationBudget.expiresAt - Date.now()),
            }
          : {}),
      });
      const correlationId = sessionId;
      let stage = "runtime-connection";
      const restoredTab = input.initialSurfaceId
        ? await this.#workspaceTabs?.get(input.ownerId, input.initialSurfaceId)
        : null;
      let socket: BrowserRuntimeConnection;
      try {
        input.operationBudget?.signal.throwIfAborted();
        const reconnect =
          attachAuthority.actor === "person" && !pooled
            ? {
                prepare: async () => {
                  const broker = this.#brokers.get(sessionId);
                  if (!broker) throw new Error("The browser session has ended.");
                  await broker.prepareRuntimeReconnect();
                },
                ticket: () => this.#signer.issue({ ...attachAuthority, reattach: true }),
              }
            : undefined;
        if (pooled && poolBudget) {
          await poolBudget.browserSend?.recheck();
          poolBudget.signal.throwIfAborted();
          poolBudget.pageRequested = true;
          poolBudget.browserSend?.submitted();
        }
        socket = withoutDatabaseOperationSignal(() => target.connect(ticket, reconnect));
      } catch (error) {
        await this.#transitionBrowserSession({
          from: ["starting"],
          sessionId,
          state: "failed",
        });
        throw browserStartUnavailable(correlationId, stage, error);
      }
      let readinessBudget = input.operationBudget;
      const groupId = input.tabGroupId ?? sessionId;
      const personUse = this.#personUseGroups.get(groupId) ?? {
        tabs: new Set<BrowserSurfaceId>(),
        ended: false,
        ownerId: input.ownerId,
        profileId: record.profileId,
      };
      const broker = withoutDatabaseOperationSignal(
        () =>
          new HostedBrowserBroker({
            ...(pooled
              ? {
                  poolAdmission: this.#poolAdmission(pooled),
                  onChannelLost: (documents) => pooled.channelLost(sessionId, documents),
                }
              : {}),
            personUse,
            onPersonUseChanged: () => {
              if (personUse.ended) return;
              if (personUse.tabs.size) this.#personUseGroups.set(groupId, personUse);
              else if (this.#personUseGroups.get(groupId) === personUse)
                this.#personUseGroups.delete(groupId);
            },
            tabRestoreVersion: tabRestore,
            ...(tabRestore && input.initialSurfaceId
              ? { savedTabIds: [input.initialSurfaceId, ...(input.dormantSurfaceIds ?? [])] }
              : {}),
            profileId: record.profileId,
            ...(initialHistoryNavigation ? { initialHistoryNavigation } : {}),
            historyWrite: (operation) => {
              if (!this.#history || !profile) return;
              void this.#historyOperation(profile.id, async () => {
                if (await operation(this.#history!))
                  this.#onHistoryChanged(profile.ownerId, profile.id);
              }).catch(() => this.#onError(new Error("Browser history persistence failed")));
            },
            groupId: input.tabGroupId ?? sessionId,
            ...(input.initialSurfaceId && restoredTab?.favicon && restoredTab.url
              ? {
                  restoredIcon: {
                    id: input.initialSurfaceId,
                    url: restoredTab.url,
                    favicon: restoredTab.favicon,
                  },
                }
              : {}),
            readSessionState: () => this.#sessionState(sessionId),
            onPageChanged: () => this.#announcePresence(sessionId),
            ...(this.#workspaceTabs
              ? {
                  personTabGeneration: async (surfaceId: BrowserSurfaceId) => {
                    let row = await this.#workspaceTabs!.get(input.ownerId, surfaceId);
                    if (!row) {
                      await this.#flushTabDescriptors(sessionId);
                      row = await this.#workspaceTabs!.get(input.ownerId, surfaceId);
                    }
                    return row?.pageBinding?.sessionId === sessionId ? row.generation : null;
                  },
                }
              : {}),
            onTabsChanged: (structural) => {
              if (structural) void this.#flushTabDescriptors(sessionId).catch(this.#onError);
              else this.#queueTabDescriptors(sessionId);
              this.#shadows.get(sessionId)?.inventoryChanged();
            },
            onRecordsChanged: (ids) => this.tabInventoryChanged(sessionId, ids),
            onActivity: (activity) => this.#runtimeActivity(sessionId, activity),
            cdpBoundary: target.cdpBoundary === true,
            agentActions: target.agentActions === true,
            basicInput: target.basicInput,
            surfaceState: target.surfaceState,
            sharedControl: target.sharedControl === true,
            navigation: target.navigationVersion === true,
            targetControl: target.targetControl === true,
            captureRegion: target.captureRegion === true,
            rasterDemand: target.rasterDemand === true,
            passkeys: target.passkeys === true && this.#passkeys,
            passkeyOwnOrigins: this.#passkeyOwnOrigins,
            editing: target.editing,
            clipboard: target.editing === 1 || target.clipboard === true,
            computer: target.computer ?? null,
            connectTimeoutMs: this.#connectTimeoutMs,
            fileStaging: target.fileStaging === true,
            cardFill: target.main === true && target.cardFill === true,
            signIn: target.main === true && target.signIn === true,
            stateImport: target.stateImport === true,
            onState: (state) => {
              // Abort waits on the ready frame, so a held row lock must not outlive the attach deadline.
              const budget =
                readinessBudget ??
                (state === "ready"
                  ? {
                      signal: new AbortController().signal,
                      expiresAt: Date.now() + this.#connectTimeoutMs,
                    }
                  : undefined);
              const transition = async () => {
                if (
                  state === "ready" &&
                  localIdentity?.kind === "profile-local" &&
                  !localIdentity.initialized
                )
                  await this.#localProfiles!.acknowledgeReady(localIdentity.binding);
                // A pooled broker says closed only on its runtime's `closed` status (P16, V1).
                if (state === "closed")
                  return poolTarget
                    ? this.#transitionBrowserSession({
                        // Only a Stop's closing row: the person's durable ask (W2).
                        from: ["closing"],
                        sessionId,
                        state,
                        evidence: { kind: "runtime-ended" },
                        target: poolTarget,
                      })
                    : this.#transitionBrowserSession({ sessionId, state, evidence: "not-pooled" });
                return this.#transitionBrowserSession({
                  ...(state === "ready" ? { from: ["starting", "ready"] as const } : {}),
                  sessionId,
                  state,
                });
              };
              return budget
                ? withDatabaseOperationSignal(budget.signal, budget.expiresAt, transition)
                : transition();
            },
            onTerminal: async () => {
              for (const actor of this.#actors.values())
                if (actor.sessionId === sessionId) this.#clearActor(actor);
              const endedBroker = this.#brokers.get(sessionId);
              await this.#flushTabDescriptors(sessionId, endedBroker);
              this.#onTabsChanged();
              this.#onTabsChanged();
              this.#forgetActing(sessionId);
              this.#announcePresence(sessionId);
              this.#brokers.delete(sessionId);
              this.#taskPageOpens.delete(sessionId);
              this.#shadows.get(sessionId)?.stop();
              this.#shadows.delete(sessionId);
              this.#sessionProfiles.delete(sessionId);
              this.#holdings.delete(sessionId);
              this.#forgetLastHeldSession(sessionId);
              this.#announcedPresence.delete(sessionId);
              this.#onTabsChanged();
              if (!tabRestore) this.#endPersonUse(groupId);
            },
            sessionId,
            socket,
          }),
      );
      this.#brokers.set(sessionId, broker);
      if (profile) this.#sessionProfiles.set(sessionId, profile.id);
      return async () => {
        try {
          stage = "runtime-readiness";
          await broker.ready();
          let initialTabId: BrowserSurfaceId | undefined;
          {
            const ready = InitialPageReadySchema.parse(socket.initialPage);
            if (
              ready.operationKey !== (input.initialPageOperationKey ?? sessionId) ||
              ready.navigation !== (initialUrl ? "submitted" : "blank")
            )
              throw unavailable("The browser returned mismatched initial page readiness.");
            initialTabId = ready.surfaceId;
            poolBudget?.browserSend?.acknowledged();
          }
          await this.#flushTabDescriptors(sessionId);
          if (initialTabId) onInitialPage?.(initialTabId);
          // A Personal workspace session on a desktop or standalone runtime: compared in shadow.
          if (
            tabRestore &&
            target.stateImport === true &&
            !phoneEngines.has(target.localProfileStorage?.engine ?? "")
          )
            this.#startShadow(sessionId, input.ownerId);
          stage = "session-read";
          const latest = await this.#repository.getBrowserSessionForOwner(sessionId, input.ownerId);
          if (pooled && latest?.state !== "ready")
            throw unavailable("The browser session ended before it was ready.");
          const session = await this.#personSession(latest ?? record, input.ownerId);
          readinessBudget = undefined;
          return { session, wasExisting: false };
        } catch (error) {
          this.#brokers.delete(sessionId);
          this.#taskPageOpens.delete(sessionId);
          await broker.abort(`The session failed during ${stage}.`).catch(() => undefined);
          await this.#transitionBrowserSession({
            from: pooled ? ["starting"] : ["starting", "ready", "closing"],
            sessionId,
            state: "failed",
          }).catch(() => undefined);
          throw browserStartUnavailable(correlationId, stage, error);
        }
      };
    };
    // Always acquire the profile lane before the runner admission lane (PH1).
    return this.#runProfileLane(profile?.id ?? null, async () => {
      if (profile && this.#standardCdpProfiles.held(profile.id))
        throw new BrowserCdpConnectionEnded(
          "An attachment holds exclusive access to this browser profile.",
        );
      if (origin === "person" && !input.agentBindingId) return admit();
      return this.withRunnerAdmission(placement.runnerId, async () => {
        await this.#requireAgentAccess(placement.runnerId);
        return admit();
      });
    });
  }

  #resolveTarget(placement: BrowserPlacementSelector): BrowserRuntimeTarget | undefined {
    return this.#targetResolver?.resolve(placement);
  }

  #pool(runnerId: RunnerId | null | undefined): BrowserPoolCoordinator | undefined {
    return runnerId ? this.#pools.get(runnerId) : undefined;
  }

  #poolStartBudget(upstream?: AbortSignal): BrowserTabOpenBudget | undefined {
    if (!this.#pools.size) return undefined;
    return {
      expiresAt: Date.now() + browserOpenWorkMs,
      signal: AbortSignal.any([
        this.#closing.signal,
        AbortSignal.timeout(browserOpenWorkMs),
        ...(upstream ? [upstream] : []),
      ]),
    };
  }

  async #reservePool(gate: BrowserPoolGate, signal: AbortSignal, sessionId?: BrowserSessionId) {
    if (!sessionId) return gate.reserve(signal);
    const waiters = this.#poolWaiters.get(sessionId) ?? new Set<AbortController>();
    const waiter = new AbortController();
    waiters.add(waiter);
    this.#poolWaiters.set(sessionId, waiters);
    try {
      return await gate.reserve(AbortSignal.any([signal, waiter.signal]));
    } finally {
      waiters.delete(waiter);
      if (!waiters.size) this.#poolWaiters.delete(sessionId);
    }
  }

  async #reserveAgentPool(
    gate: BrowserPoolGate,
    binding: string,
    sessionId?: BrowserSessionId,
    upstream?: AbortSignal,
    runnerId?: RunnerId,
    onDisabled?: () => Promise<unknown>,
  ) {
    if (this.browserBindingEnded(binding)) throw new BrowserCdpConnectionEnded();
    const waiters =
      this.#poolAgentWaiters.get(binding) ??
      new Set<{ readonly controller: AbortController; readonly runnerId?: RunnerId }>();
    const waiter = new AbortController();
    const entry = { controller: waiter, ...(runnerId ? { runnerId } : {}) };
    waiters.add(entry);
    this.#poolAgentWaiters.set(binding, waiters);
    try {
      return await this.#reservePool(
        gate,
        AbortSignal.any([
          waiter.signal,
          this.#closing.signal,
          upstream ?? AbortSignal.timeout(browserOpenWorkMs),
        ]),
        sessionId,
      );
    } catch (error) {
      if (
        runnerId &&
        waiter.signal.aborted &&
        waiter.signal.reason === this.#deviceAccessDisabled
      ) {
        await this.withRunnerAdmission(runnerId, async () => {
          if (onDisabled) await onDisabled();
          else await this.#requireAgentAccess(runnerId);
        });
        throw new BrowserCdpConnectionEnded("This device's browser access was turned off.");
      }
      throw error;
    } finally {
      waiters.delete(entry);
      if (!waiters.size) this.#poolAgentWaiters.delete(binding);
    }
  }

  async #loadUsableOwnedSession(
    input: { ownerId: UserId; agentBindingId?: string },
    sessionId: BrowserSessionId,
  ): Promise<OwnedBrowserSessionRecord> {
    const record = await loadOwnedBrowserSession(this.#repository, sessionId, input.ownerId);
    if (!record || this.#ended(record))
      throw new BrowserCdpConnectionEnded(
        connectedAgentBinding(input.agentBindingId)
          ? "This tab has ended or is unavailable. Use discover to find an open tab and pass its tabId."
          : "This tab has ended or is unavailable. Use tab_list and Browser Harness openPage(tabId).",
      );
    return record;
  }

  /**
   * Resolves binding authority, then loads the owned session row and checks
   * profile grant and device access so session ownership is always checked
   * after `resolveResourceAccess` with a single `getBrowserSessionForOwner` read.
   */
  async #admitAgentSession(
    input: { ownerId: UserId; agentBindingId?: string },
    sessionId: BrowserSessionId,
    endedBindingAnswers = false,
    captureAuthority?: (facts: StandardCdpAuthority) => void,
  ): Promise<OwnedBrowserSessionRecord> {
    if (!input.agentBindingId)
      throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    if (this.#endedBindings.has(input.agentBindingId)) {
      if (!endedBindingAnswers)
        throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
      // Its connection's own token check ends it; until then the command only answers.
      const record = await this.#loadUsableOwnedSession(input, sessionId);
      await this.#requireAgentAccess(record.runnerId);
      return record;
    }
    let scope: Awaited<ReturnType<OpensteerStore["runCapabilityScope"]>> = null;
    if (input.agentBindingId.startsWith("run:") && this.#repository.runCapabilityScope) {
      scope = await this.#repository.runCapabilityScope(
        RunIdSchema.parse(input.agentBindingId.slice(4)),
      );
      if (!scope || scope.requestedBy !== input.ownerId)
        throw new OpensteerError({
          code: "forbidden",
          message: "This task's browser access has ended.",
        });
      await this.#repository.assertActiveGrant?.(scope);
    }
    const authority = this.#repository.resolveResourceAccess
      ? await this.#repository.resolveResourceAccess({
          ownerUserId: input.ownerId,
          agentBindingId: input.agentBindingId,
          explicitAccess: "read-write",
        })
      : null;
    if (authority) {
      captureAuthority?.({
        mode: authority.execution.mode,
        threadId: authority.execution.threadId,
        grantRevision: authority.execution.agentConnection?.grantRevision ?? null,
        agentConnectionId: authority.execution.agentConnection?.agentConnectionId ?? null,
      });
      const level = executionAccess(authority.execution, "read-write");
      if (!level || level !== "read-write")
        throw new OpensteerError({
          code: "forbidden",
          message: "This task has read-only browser access and cannot drive or change tabs.",
        });
    }
    const record = await this.#loadUsableOwnedSession(input, sessionId);
    if (authority) {
      const grant = selectedGrantOf(authority.execution);
      if (
        grant &&
        (!record.profileId ||
          !agentGrantAllows(
            grant,
            { kind: "browser-profile", profileId: record.profileId },
            "read-write",
          ))
      ) {
        if (input.agentBindingId.startsWith("session:"))
          throw new OpensteerError({ code: "not_found", message: "Tab not found." });
        throw new OpensteerError({
          code: "forbidden",
          message:
            "This browser profile is not one this connected agent may use. The person can change what it may use under Connected agents.",
        });
      }
      if (authority.execution.agentConnection && record.profileId === null)
        throw new OpensteerError({
          code: "forbidden",
          message: "This connected agent needs a saved browser profile. Guest is unavailable.",
        });
    }
    await this.#requireAgentAccess(record.runnerId);
    if (scope) await this.#repository.assertActiveGrant?.(scope);
    if (this.#endedBindings.has(input.agentBindingId))
      throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    return record;
  }

  /**
   * The session an agent names, if this task may drive it now. Every
   * refusal says what the agent can do next, because the agent reads it
   * straight from its CDP client.
   */
  async #usableAgentSession(
    input: { ownerId: UserId; agentBindingId?: string },
    sessionId: BrowserSessionId,
    authorize = true,
  ): Promise<OwnedBrowserSessionRecord> {
    if (authorize) return this.#admitAgentSession(input, sessionId, true);
    return this.#loadUsableOwnedSession(input, sessionId);
  }

  async #followedAgentSessionId(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
  }): Promise<BrowserSessionId> {
    const [latest] = await this.#repository.listActiveBrowserSessionsForAgentBinding(
      input.agentBindingId,
    );
    if (!latest) {
      throw new BrowserCdpConnectionEnded(
        "This Run has no selected tab. Use tab_list and Browser Harness openPage(tabId), or tab_open with a Guest page target.",
      );
    }
    return latest.id;
  }

  async #followedAgentSession(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
    },
    authorize = true,
  ): Promise<OwnedBrowserSessionRecord> {
    return this.#usableAgentSession(input, await this.#followedAgentSessionId(input), authorize);
  }

  async admitAgentBrowser(
    input: { ownerId: UserId; agentBindingId?: string },
    access: "read" | "read-write" = "read-write",
    records: readonly BrowserSessionRecord[] = [],
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "listBrowserSessions"
      | "resolveResourceAccess"
      | "runCapabilityScope"
      | "assertActiveGrant"
    > = this.#repository,
    endedBindingAnswers = false,
    /** A browser about to start or restore: its exact profile, or null for Guest. */
    opening?: { readonly profileId: BrowserProfileId | null },
    captureAuthority?: (facts: StandardCdpAuthority) => void,
  ) {
    if (!input.agentBindingId)
      throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    if (this.#endedBindings.has(input.agentBindingId)) {
      if (!endedBindingAnswers)
        throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
      // Its connection's own token check ends it; until then the command only answers.
      for (const record of records)
        if (!(await repository.getBrowserSessionForOwner(record.id, input.ownerId)))
          throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
      if (records.length) {
        await Promise.all(
          [...new Set(records.map((record) => record.runnerId))].map((runnerId) =>
            this.#requireAgentAccess(runnerId),
          ),
        );
      }
      return null;
    }
    let scope: Awaited<ReturnType<OpensteerStore["runCapabilityScope"]>> = null;
    if (input.agentBindingId.startsWith("run:") && repository.runCapabilityScope) {
      scope = await repository.runCapabilityScope(RunIdSchema.parse(input.agentBindingId.slice(4)));
      if (!scope || scope.requestedBy !== input.ownerId)
        throw new OpensteerError({
          code: "forbidden",
          message: "This task's browser access has ended.",
        });
      await repository.assertActiveGrant?.(scope);
    }
    if (repository.resolveResourceAccess) {
      const authority = await repository.resolveResourceAccess({
        ownerUserId: input.ownerId,
        agentBindingId: input.agentBindingId,
        explicitAccess: "read-write",
        ...(opening?.profileId
          ? { grantTarget: { kind: "browser-profile", profileId: opening.profileId } }
          : {}),
      });
      const grant = selectedGrantOf(authority.execution);
      captureAuthority?.({
        mode: authority.execution.mode,
        threadId: authority.execution.threadId,
        grantRevision: authority.execution.agentConnection?.grantRevision ?? null,
        agentConnectionId: authority.execution.agentConnection?.agentConnectionId ?? null,
      });
      // Exactly the level asked for: the intersection can be read where a write was requested.
      const level = executionAccess(authority.execution, access);
      if (!level || (access === "read-write" && level !== "read-write"))
        throw new OpensteerError({
          code: "forbidden",
          message:
            access === "read-write"
              ? "This task has read-only browser access and cannot drive or change tabs."
              : "This task cannot read browser tabs.",
        });
      // A connection's selected grant reaches only the browser profiles it names, checked on the
      // exact profile before anything starts; Guest is never one of them.
      const profiles = [
        ...records.map((record) => record.profileId),
        ...(opening ? [opening.profileId] : []),
      ];
      if (
        grant &&
        (profiles.length
          ? profiles.some(
              (profileId) =>
                !profileId ||
                !agentGrantAllows(grant, { kind: "browser-profile", profileId }, access),
            )
          : !grant.resources.some((resource) => resource.kind === "browser-profile"))
      ) {
        if (input.agentBindingId.startsWith("session:") && profiles.length)
          throw new OpensteerError({ code: "not_found", message: "Tab not found." });
        throw new OpensteerError({
          code: "forbidden",
          message:
            "This browser profile is not one this connected agent may use. The person can change what it may use under Connected agents.",
        });
      }
      if (authority.execution.agentConnection && profiles.includes(null))
        throw new OpensteerError({
          code: "forbidden",
          message: "This connected agent needs a saved browser profile. Guest is unavailable.",
        });
    }
    if (records.length) {
      const owned = new Set(
        (records.length === 1
          ? [await repository.getBrowserSessionForOwner(records[0]!.id, input.ownerId)].filter(
              (record) => record !== null,
            )
          : await repository.listBrowserSessions(input.ownerId)
        ).map((record) => record.id),
      );
      if (records.some((record) => !owned.has(record.id)))
        throw new OpensteerError({
          code: "forbidden",
          message: connectedAgentBinding(input.agentBindingId)
            ? "This tab is unavailable to this task. Use discover to find an open tab and pass its tabId."
            : "This tab is unavailable to this task. Use tab_list to find an open page tab.",
        });
      await Promise.all(
        [...new Set(records.map((record) => record.runnerId))].map((runnerId) =>
          this.#requireAgentAccess(runnerId),
        ),
      );
    }
    if (scope) await repository.assertActiveGrant?.(scope);
    if (this.#endedBindings.has(input.agentBindingId))
      throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    return scope;
  }

  async agentMayAccessSession(
    input: { ownerId: UserId; agentBindingId?: string },
    record: BrowserSessionRecord,
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "listBrowserSessions"
      | "resolveResourceAccess"
      | "runCapabilityScope"
      | "assertActiveGrant"
    > = this.#repository,
    access: "read" | "read-write" = "read-write",
  ): Promise<boolean> {
    await this.admitAgentBrowser(input, access, [record], repository);
    return true;
  }

  async agentReachableSavedSessions(
    input: { ownerId: UserId; agentBindingId: string },
    access: "read" | "read-write" = "read",
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "listBrowserSessions"
      | "resolveResourceAccess"
      | "runCapabilityScope"
      | "assertActiveGrant"
    > = this.#repository,
  ) {
    await this.admitAgentBrowser(input, access, [], repository);
    const grant = repository.resolveResourceAccess
      ? (
          await repository.resolveResourceAccess({
            ownerUserId: input.ownerId,
            agentBindingId: input.agentBindingId,
          })
        ).execution.agentConnection?.grant
      : undefined;
    // A selected grant reaches only the sessions of the profiles it names.
    const records = (await repository.listBrowserSessions(input.ownerId)).filter(
      (record) =>
        grant?.scope !== "selected" ||
        (record.profileId !== null &&
          agentGrantAllows(
            grant,
            { kind: "browser-profile", profileId: record.profileId },
            access,
          )),
    );
    const runners = [...new Set(records.map((record) => record.runnerId))];
    // An offline computer's tabs stay listed; using one says the computer is offline.
    const admissions = await Promise.allSettled(
      runners.map((runnerId) => this.#requireAgentVisibility(runnerId)),
    );
    for (const admission of admissions) {
      if (
        admission.status === "rejected" &&
        !(
          admission.reason instanceof OpensteerError &&
          (admission.reason.code === "forbidden" || admission.reason.code === "not_found")
        )
      )
        throw admission.reason;
    }
    const allowed = new Set(
      runners.filter((_, index) => admissions[index]?.status === "fulfilled"),
    );
    return new Map(
      records.filter((record) => allowed.has(record.runnerId)).map((record) => [record.id, record]),
    );
  }

  async agentBrowserComputers(ownerId: UserId) {
    return this.#repository.listEligibleBrowserRunners(ownerId);
  }

  /**
   * The binding holds the session live for as long as its Run is active, and
   * the Run's conversations keep that it used it. A harness reconnects for
   * every call, so only a new attachment changes which Runs a person sees
   * attached; uses announce only changes to the visible usage projection.
   */
  async #holdForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
    },
    record: BrowserSessionRecord,
    options?: {
      readonly recheck?: boolean;
      readonly requireAccess?: boolean;
      readonly accessGeneration?: number;
      readonly globalAccessGeneration?: number;
      readonly heldProfileId?: BrowserProfileId | null;
      readonly profileWaited?: boolean;
      readonly inRunnerAdmission?: boolean;
    },
  ): Promise<void> {
    const accessGeneration =
      options?.accessGeneration ?? this.#runnerAccessGeneration.get(record.runnerId) ?? 0;
    const runInProfile = async (profileWaited: boolean) => {
      const held = record.profileId ? this.#standardCdpProfiles.held(record.profileId) : undefined;
      if (held && held.bindingId !== input.agentBindingId)
        throw new BrowserCdpConnectionEnded(
          "Another task holds exclusive access to this browser profile.",
        );
      const pool = this.#pool(record.runnerId);
      const reservation = pool
        ? await this.#reserveAgentPool(
            pool.gate,
            input.agentBindingId,
            record.id,
            undefined,
            record.runnerId,
            () => this.#admitAgentSession(input, record.id, false),
          )
        : undefined;
      try {
        // Rule 7 (PH6): a person's own agent on an unpooled personal Home does not queue behind
        // sibling holds on the runner admission lane or pay an extra #admitAgentSession pass when
        // another admission is in flight. It still honours the device switch (generation checks
        // before and after attachBrowserSession) and task mode (admitted before and re-checked on
        // profile waits or generation changes).
        const useRunnerLane = Boolean(pool || connectedAgentBinding(input.agentBindingId));
        const admissionWaited =
          useRunnerLane &&
          !options?.inRunnerAdmission &&
          this.#agentAdmissions.busy(record.runnerId);
        const accessChanged = () =>
          (this.#runnerAccessGeneration.get(record.runnerId) ?? 0) !== accessGeneration ||
          (options?.globalAccessGeneration !== undefined &&
            this.#accessGeneration !== options.globalAccessGeneration);
        const holdStep = async () => {
          if (this.#closed || this.#endedBindings.has(input.agentBindingId))
            throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
          const mustRecheck = Boolean(
            options?.recheck ||
            profileWaited ||
            reservation?.waited ||
            admissionWaited ||
            accessChanged(),
          );
          if (mustRecheck) await this.#admitAgentSession(input, record.id, false);
          else if (options?.requireAccess) await this.#requireAgentAccess(record.runnerId);
          // Run attachment and usage sequentially so they never contend on client_sync_state,
          // and skip repeat session-only usage writes only when this binding's last recorded
          // session and this session's last recorded binding are both unchanged.
          const attached = await this.#repository.attachBrowserSession({
            agentBindingId: input.agentBindingId,
            ownerId: input.ownerId,
            sessionId: record.id,
            ...(pool ? { pool: pool.identity() } : {}),
          });
          if (!useRunnerLane && !options?.inRunnerAdmission && accessChanged()) {
            await this.#detachRunnerAgents?.(record.runnerId);
            throw this.#deviceAccessDisabled;
          }
          if (!attached && (this.#closed || this.#endedBindings.has(input.agentBindingId))) return;
          if (attached) this.#onSessionsChanged([record.id]);
          if (
            attached ||
            this.#lastHeldSessionByBinding.get(input.agentBindingId) !== record.id ||
            this.#lastHeldBindingBySession.get(record.id) !== input.agentBindingId
          ) {
            const credits = await this.#repository.recordAgentBrowserUse({
              agentBindingId: input.agentBindingId,
              ownerId: input.ownerId,
              page: null,
              sessionId: record.id,
              tabId: null,
            });
            this.#noteLastHeldSession(record.id, input.agentBindingId);
            this.announceUsage(credits);
          }
        };
        if (options?.inRunnerAdmission || !useRunnerLane) await holdStep();
        else await this.withRunnerAdmission(record.runnerId, holdStep);
      } finally {
        reservation?.release();
      }
    };
    if (options?.heldProfileId !== undefined && options.heldProfileId === record.profileId) {
      return runInProfile(Boolean(options.profileWaited));
    }
    return this.#runProfileLane(record.profileId, runInProfile);
  }

  /**
   * What a person sees about one session now. An agent is acting while the
   * session is live and one of its commands arrived within the window; an
   * attached Run that is thinking, or waiting on someone, is not acting.
   */
  #presence(sessionId: BrowserSessionId): {
    readonly acting: boolean;
    readonly page: BrowserPagePresence | null;
  } {
    const broker = this.#brokers.get(sessionId);
    if (!broker?.live) return { acting: false, page: broker?.page ?? null };
    const latest = Math.max(0, ...(this.#agentCommands.get(sessionId)?.values() ?? []));
    return { acting: this.#activityClock.now() - latest < this.#actingWindowMs, page: broker.page };
  }

  #noteAgentCommand(sessionId: BrowserSessionId, agentBindingId: string): void {
    if (this.#endedBindings.has(agentBindingId) || !this.#brokers.has(sessionId)) return;
    const commands = this.#agentCommands.get(sessionId) ?? new Map<string, number>();
    commands.set(agentBindingId, this.#activityClock.now());
    this.#agentCommands.set(sessionId, commands);
    if (!this.#actingTimers.has(sessionId)) {
      this.#scheduleActingEnd(sessionId, this.#actingWindowMs);
    }
    this.#announcePresence(sessionId);
  }

  /** Checks again when the newest command leaves the window, and says so once none is left. */
  #scheduleActingEnd(sessionId: BrowserSessionId, delayMs: number): void {
    const cancel = this.#activityClock.schedule(
      () => {
        this.#actingTimers.delete(sessionId);
        const commands = this.#agentCommands.get(sessionId);
        const now = this.#activityClock.now();
        for (const [binding, at] of commands ?? []) {
          if (now - at >= this.#actingWindowMs) commands?.delete(binding);
        }
        const deadlines = [
          ...[...(commands?.values() ?? [])].map((at) => at + this.#actingWindowMs),
          ...[...this.#actors.values()]
            .filter((actor) => actor.sessionId === sessionId)
            .flatMap((actor) =>
              [...actor.surfaces.values()].map(({ at }) => at + this.#actingWindowMs),
            ),
        ].filter((at) => at > now);
        if (deadlines.length) this.#scheduleActingEnd(sessionId, Math.min(...deadlines) - now);
        if (!commands?.size) this.#agentCommands.delete(sessionId);
        this.#invalidatePageSessions([sessionId]);
        this.#announcePresence(sessionId);
      },
      Math.max(0, delayMs),
    );
    this.#actingTimers.set(sessionId, cancel);
  }

  #noteLastHeldSession(sessionId: BrowserSessionId, agentBindingId: string): void {
    if (!this.#endedBindings.has(agentBindingId) && this.#brokers.has(sessionId)) {
      this.#lastHeldBindingBySession.set(sessionId, agentBindingId);
      this.#lastHeldSessionByBinding.set(agentBindingId, sessionId);
    } else {
      this.#lastHeldSessionByBinding.delete(agentBindingId);
    }
  }

  #forgetLastHeldSession(sessionId: BrowserSessionId): void {
    this.#lastHeldBindingBySession.delete(sessionId);
    for (const [binding, lastSessionId] of this.#lastHeldSessionByBinding) {
      if (lastSessionId === sessionId) this.#lastHeldSessionByBinding.delete(binding);
    }
  }

  #forgetAgentBinding(agentBindingId: string): void {
    this.#lastHeldSessionByBinding.delete(agentBindingId);
    for (const waiter of this.#poolAgentWaiters.get(agentBindingId) ?? [])
      waiter.controller.abort(new BrowserCdpConnectionEnded("The browser task ended."));
    this.closeStandardCdpForBinding(agentBindingId, "The browser task ended.");
    for (const attachment of this.#deviceAttachments.values())
      if (attachment.binding === agentBindingId) attachment.close();
    for (const attachment of this.#actionAttachments.values())
      if (attachment.binding === agentBindingId) attachment.close();
    for (const actor of this.#actors.values())
      if (actor.binding === agentBindingId) this.#clearActor(actor);
    const now = this.#activityClock.now();
    this.#endedBindings.delete(agentBindingId);
    this.#endedBindings.set(agentBindingId, now);
    // Kept in the order they ended, so the oldest are first to go.
    for (const [binding, endedAt] of this.#endedBindings) {
      if (now - endedAt < endedBindingMemoryMs) break;
      this.#endedBindings.delete(binding);
    }
    for (const [sessionId, commands] of this.#agentCommands) {
      if (!commands.delete(agentBindingId)) continue;
      if (commands.size === 0) this.#forgetActing(sessionId);
      this.#announcePresence(sessionId);
    }
  }

  #forgetActing(sessionId: BrowserSessionId): void {
    this.#agentCommands.delete(sessionId);
    const timer = this.#actingTimers.get(sessionId);
    timer?.();
    this.#actingTimers.delete(sessionId);
  }

  /** Tells the session's viewers what changed, unless it is what they were last told. */
  #announcePresence(sessionId: BrowserSessionId): void {
    const broker = this.#brokers.get(sessionId);
    if (!broker) return;
    const presence = this.#presence(sessionId);
    const announced = JSON.stringify([presence.acting, presence.page]);
    if (this.#announcedPresence.get(sessionId) === announced) return;
    this.#announcedPresence.set(sessionId, announced);
    this.#invalidatePageSessions([sessionId]);
  }

  async #agentSessionSummary(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
    },
    sessionId: BrowserSessionId,
  ): Promise<AgentBrowserSessionSummary> {
    const [record, attached, activeAttachmentCount] = await Promise.all([
      this.#repository.getBrowserSessionForOwner(sessionId, input.ownerId),
      this.#repository.listActiveBrowserSessionsForAgentBinding(input.agentBindingId),
      this.#repository.countBrowserSessionAttachments(sessionId),
    ]);
    if (!record || !(await this.agentMayAccessSession(input, record))) {
      throw new OpensteerError({
        code: "conflict",
        message: "This tab is no longer available to this Run.",
      });
    }
    const profile =
      record.profileId === null
        ? null
        : await this.#repository.getBrowserProfile(record.profileId, input.ownerId);
    if (record.profileId !== null && !profile) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found." });
    }
    return {
      ...publicSession(record),
      activeAttachmentCount,
      attached: attached.some((session) => session.id === sessionId),
      profileName: profile?.name ?? null,
    };
  }

  async #stopRecord(record: BrowserSessionRecord): Promise<void> {
    const broker = this.#brokers.get(record.id);
    const pool = this.#pool(record.runnerId);
    // A session of the pooled runner is pooled whether or not a coordinator is here now (before
    // its target is adopted, or between two targets): never closed without its evidence (W1).
    const pooled =
      (pool !== undefined && record.runtimeId === pool.runtimeId) ||
      (this.#pooledRunner !== undefined && record.runnerId === this.#pooledRunner);
    if (pooled && this.#repository instanceof OpensteerStore) {
      // "The person asked to stop" is durable before the Stop returns, whatever a broker of it
      // is doing (one already finishing a lost channel included, W2): under the slot's lock,
      // closed on a parked guest of its own target, closing otherwise until its evidence.
      const written = isTerminal(record.state)
        ? undefined
        : await stopBrowserPoolSession(this.#repository.database, {
            sessionId: record.id,
            runnerId: record.runnerId,
          });
      if (written) this.#onSessionsChanged([record.id]);
      // Its channel, if it has one, is closed as a Stop closes it; the runtime's own `closed`,
      // or the end step's answer, ends the row.
      if (broker) await (broker.pooled ? broker.stopWithReceipt(5_000) : broker.stop());
      if (written === "closing" || broker?.pooled) pool?.stopped();
      return;
    }
    if (broker) {
      await broker.stop();
      if (broker.pooled) pool?.stopped();
      return;
    }
    if (isTerminal(record.state)) return;
    if (pooled) {
      // A pooled session in a store without the pool's tables: closing until its runtime says.
      if (record.state !== "closing")
        await this.#transitionBrowserSession({
          from: ["starting", "ready"],
          sessionId: record.id,
          state: "closing",
        });
      pool?.stopped();
      return;
    }
    // Not pooled: closed by the writer that refuses a pooled session in its own statement.
    await this.#transitionBrowserSession({
      from: ["starting", "ready", "closing"],
      sessionId: record.id,
      state: "closed",
      evidence: "not-pooled",
    });
  }

  /**
   * Every write of a session's state here. `closed` names its evidence (V1): a pooled row is
   * closed only through the pool's one writer, with the evidence it holds; any other row says
   * `not-pooled` and is written as before.
   */
  async #transitionBrowserSession(
    input:
      | {
          readonly from?: readonly HostedBrowserSessionState[];
          readonly sessionId: BrowserSessionId;
          readonly state: Exclude<HostedBrowserSessionState, "closed">;
        }
      | {
          readonly from?: readonly HostedBrowserSessionState[];
          readonly sessionId: BrowserSessionId;
          readonly state: "closed";
          readonly evidence: BrowserPoolCloseEvidence;
          /** The target the evidence is about: only that target's own session is closed (W1). */
          readonly target: BrowserPoolSessionTarget;
        }
      | {
          readonly from?: readonly HostedBrowserSessionState[];
          readonly sessionId: BrowserSessionId;
          readonly state: "closed";
          readonly evidence: "not-pooled";
        },
  ): Promise<BrowserSessionRecord> {
    if (input.state === "closed" && input.evidence !== "not-pooled") {
      const database = (this.#repository as OpensteerStore).database;
      await closeBrowserPoolSessions(database, input.target, [input.sessionId], input.evidence);
      const owner = await readBrowserPoolOwner(database);
      const row = owner
        ? await this.#repository.getBrowserSessionForOwner(input.sessionId, owner)
        : null;
      if (!row) throw new Error("The pooled browser session is gone.");
      this.#onSessionsChanged([row.id]);
      return row;
    }
    const { from, sessionId } = input;
    // A session that is not pooled closes through the writer that refuses a pooled one in its
    // own statement (W5); any other state through the general transition, which cannot close.
    const transitioned =
      input.state === "closed"
        ? await this.#repository.closeUnpooledBrowserSession({
            ...(from ? { from } : {}),
            sessionId,
          })
        : await this.#repository.transitionBrowserSession({
            ...(from ? { from } : {}),
            sessionId,
            state: input.state,
          });
    this.#onSessionsChanged([transitioned.session.id]);
    return transitioned.session;
  }

  async #waitForBrowser(
    homes: Awaited<ReturnType<OpensteerStore["listEligibleBrowserRunners"]>>,
    runnerId: RunnerId | undefined,
    operationSignal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    const resolver = this.#targetResolver;
    if (!runnerId || !resolver?.waitForTarget || !homes.some((home) => home.id === runnerId))
      return false;
    if (
      resolver
        .placements()
        .some((placement) => placement.runnerId === runnerId && placement.available)
    )
      return false;
    if (
      !homes.some((home) => home.id === runnerId && home.kind === "main") &&
      !resolver.pendingAdmission?.(runnerId)
    )
      return false;
    // A restore has no open budget of its own, so it waits no longer than an open would.
    const signal = AbortSignal.any([
      this.#closing.signal,
      operationSignal ?? AbortSignal.timeout(browserOpenWorkMs),
    ]);
    try {
      await resolver.waitForTarget(runnerId, signal);
    } catch (error) {
      if (this.#closing.signal.aborted || operationSignal?.aborted) throw error;
      // It never arrived or can't be admitted: the ordinary refusal explains why.
      return false;
    }
    return true;
  }

  #defaultPlacement(
    input: {
      readonly chosenRunnerId?: RunnerId;
      readonly environmentId?: EnvironmentId;
      readonly origin?: "agent" | "trigger" | "person";
    },
    placements: readonly BrowserRuntimePlacement[],
    homes: Awaited<ReturnType<OpensteerStore["listEligibleBrowserRunners"]>>,
  ): BrowserPlacementSelector {
    const connected = placements.filter((placement) => placement.available);
    if (this.#personal && (input.origin ?? "person") === "person") {
      const main = homes.find((home) => home.kind === "main");
      if (main) return { kind: "runner", runnerId: main.id };
      throw unavailable("The main computer's browser is unavailable.");
    }
    const { chosenRunnerId, environmentId } = input;
    if (chosenRunnerId) {
      const chosen = connected.filter((placement) => placement.runnerId === chosenRunnerId);
      if (
        chosen.length === 0 &&
        (homes.some((home) => home.id === chosenRunnerId && home.kind === "main") ||
          this.#targetResolver?.pendingAdmission?.(chosenRunnerId))
      )
        return { kind: "runner", runnerId: chosenRunnerId };
      if (chosen.length === 1 && chosen[0]) return placementSelector(chosen[0]);
      if (chosen.length > 1) throw runnerPlacementConflict(chosen);
      const incompatible = placements.find(
        (placement) => !placement.available && placement.runnerId === chosenRunnerId,
      );
      if (incompatible?.unavailableReason) throw unavailable(incompatible.unavailableReason);
      if (connected.length === 0) throw unavailable("No Browser Runtime is connected.");
      throw new OpensteerError({
        code: "bad_request",
        message: `That computer does not run a connected browser. These do: ${browserMachineChoices(connected)}.`,
      });
    }
    if (this.#personal) {
      const main = homes.find((home) => home.kind === "main");
      const hostingBrowser = connected.find((placement) => placement.runnerId === main?.id);
      if (hostingBrowser) return placementSelector(hostingBrowser);
    }
    if (environmentId) {
      const colocated = connected.filter((placement) =>
        placement.environmentIds.includes(environmentId),
      );
      if (colocated.length === 1 && colocated[0]) return placementSelector(colocated[0]);
      if (colocated.length > 1) throw runnerPlacementConflict(colocated);
      const incompatible = placements.find(
        (placement) => !placement.available && placement.environmentIds.includes(environmentId),
      );
      if (incompatible?.unavailableReason) throw unavailable(incompatible.unavailableReason);
    }
    if (connected.length === 1 && connected[0]) return placementSelector(connected[0]);
    if (connected.length > 1) throw runnerPlacementConflict(connected);
    const incompatible = placements.find((placement) => placement.unavailableReason);
    if (incompatible?.unavailableReason) throw unavailable(incompatible.unavailableReason);
    // Nothing is connected yet: the hosting computer's browser is the one on its way.
    const main = this.#personal ? homes.find((home) => home.kind === "main") : undefined;
    if (main && this.#targetResolver?.waitForTarget) return { kind: "runner", runnerId: main.id };
    throw unavailable("No Browser Runtime is connected.");
  }

  #eligiblePlacements(
    homes: Awaited<ReturnType<OpensteerStore["listEligibleBrowserRunners"]>>,
  ): BrowserRuntimePlacement[] {
    const ids = new Set(homes.map((home) => home.id));
    return (
      this.#targetResolver?.placements().filter((placement) => ids.has(placement.runnerId)) ?? []
    );
  }

  #profileHome(
    profile: BrowserProfileRecord,
    homes: Awaited<ReturnType<OpensteerStore["listEligibleBrowserRunners"]>>,
  ) {
    const home = homes.find((candidate) => candidate.id === profile.homeRunnerId);
    if (!home) return null;
    return {
      runnerId: home.id,
      name: home.name,
      reachable: this.#eligiblePlacements(homes).some(
        (placement) => placement.runnerId === home.id && placement.available,
      ),
    };
  }

  #requireProfileHome(
    profile: BrowserProfileRecord,
    runnerId: RunnerId,
    homes: Awaited<ReturnType<OpensteerStore["listEligibleBrowserRunners"]>>,
  ): void {
    const home = homes.find((candidate) => candidate.id === runnerId);
    if (!home)
      throw this.#tabOpenRefusal(
        "browser-profile-unavailable",
        "That browser profile is unavailable.",
      );
    if (
      !this.#eligiblePlacements(homes).some(
        (placement) => placement.runnerId === runnerId && placement.available,
      )
    )
      throw new OpensteerError({
        code: "conflict",
        reason: "browser-profile-home-unavailable",
        message: `${profile.name} is on ${home.name}, which is offline or its browser is unavailable.`,
        details: { runnerId, name: home.name },
        retryable: true,
      });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface PendingStateImport {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly timeout: NodeJS.Timeout;
}

/** How a pooled broker's sends pass the gate. */
interface PoolBrokerAdmission {
  now(): BrowserPoolReservation | undefined;
  wait(signal: AbortSignal): Promise<BrowserPoolReservation>;
  retiring(): boolean;
  /** At the write: whether these bytes may not leave for the guest now (`refusesWrite`). */
  refusesWrite(reservation: BrowserPoolReservation | undefined): boolean;
}

interface HostedBrowserBrokerOptions {
  readonly poolAdmission?: PoolBrokerAdmission;
  /**
   * A pooled broker's channel was lost without the Home closing it; `documents` is each tab's
   * document when it was lost, which stands for the live one until the session is back.
   */
  readonly onChannelLost?: (documents: ReadonlyMap<string, string>) => void;
  /** A broker an adoption built: its first ready does not replay saved tabs. */
  readonly adoptedFromPool?: boolean;
  readonly personUse?: { tabs: Set<BrowserSurfaceId>; ended: boolean };
  readonly onPersonUseChanged?: () => void;
  readonly readSessionState: () => Promise<
    Pick<BrowserSessionState, "runs" | "pinned" | "keepAwake">
  >;
  readonly savedTabIds?: readonly BrowserSurfaceId[];
  readonly tabRestoreVersion?: boolean | undefined;
  readonly initialHistoryNavigation?: { navigationId: string; ownerId: UserId; typed: boolean };
  readonly profileId: BrowserProfileId | null;
  readonly historyWrite: (operation: (store: BrowserHistoryStore) => Promise<boolean>) => void;
  readonly navigation: boolean;
  readonly groupId: BrowserSessionId;
  readonly restoredIcon?: {
    readonly id: BrowserSurfaceId;
    readonly url: string;
    readonly favicon: string;
  };
  readonly personTabGeneration?: (surfaceId: BrowserSurfaceId) => Promise<number | null>;
  readonly onTabsChanged: (structural?: boolean) => void;
  readonly onRecordsChanged: (ids: readonly string[]) => void;
  readonly onActivity: (activity: BrowserRuntimeActivity) => void;
  /** The active page's title or site changed; called at most once per `pageNoticeDelayMs`. */
  readonly onPageChanged: () => void;
  readonly cdpBoundary: boolean;
  readonly agentActions?: boolean | undefined;
  readonly basicInput?: 1 | undefined;
  readonly surfaceState?: 1 | undefined;
  readonly sharedControl: boolean;
  readonly targetControl: boolean;
  readonly captureRegion: boolean;
  readonly rasterDemand: boolean;
  readonly editing: 1 | 2 | undefined;
  readonly passkeys: boolean;
  readonly passkeyOwnOrigins: () => readonly string[];
  readonly clipboard: boolean;
  readonly computer: { readonly name: string; readonly runnerId: RunnerId } | null;
  readonly connectTimeoutMs: number;
  readonly fileStaging: boolean;
  readonly cardFill?: boolean;
  readonly signIn: boolean;
  readonly stateImport: boolean;
  readonly onState: (state: HostedBrowserSessionState) => Promise<BrowserSessionRecord>;
  readonly onTerminal: () => void | Promise<void>;
  readonly sessionId: BrowserSessionId;
  readonly socket: BrowserRuntimeConnection;
}

export class HostedBrowserBroker {
  readonly #poolAdmission: PoolBrokerAdmission | undefined;
  readonly #onChannelLost: ((documents: ReadonlyMap<string, string>) => void) | undefined;
  /** The runtime announced this session's end: its close is not a lost channel. */
  /** The runtime said `closed`: its own word that the session and its pages ended. */
  #runtimeEnded = false;
  /** The runtime said `closing`: it is ending the session, which it has not said it finished. */
  #runtimeClosing = false;
  readonly #adoptedFromPool: boolean;
  /** A pooled broker's end, for sends waiting on admission; an ordinary broker has none. */
  readonly #poolEnded: AbortController | undefined;
  readonly profileId: BrowserProfileId | null;
  readonly #historyWrite: HostedBrowserBrokerOptions["historyWrite"];
  readonly #historyNavigations = new Map<
    string,
    { ownerId: UserId; typed: boolean; surfaceId?: BrowserSurfaceId }
  >();
  readonly #historyDocuments = new Map<
    string,
    { surfaceId: BrowserSurfaceId; url: string; title: string }
  >();
  readonly #historyIcons = new Map<BrowserSurfaceId, string>();

  beginHistoryNavigation(ownerId: UserId, typed: boolean, surfaceId?: BrowserSurfaceId) {
    if (!this.profileId || this.#snapshot?.navigationAttributionVersion !== 1) return undefined;
    const navigationId = randomUUID();
    this.#historyNavigations.set(navigationId, {
      ownerId,
      typed,
      ...(surfaceId ? { surfaceId } : {}),
    });
    if (this.#historyNavigations.size > 256)
      this.#historyNavigations.delete(this.#historyNavigations.keys().next().value!);
    return navigationId;
  }

  cancelHistoryNavigation(navigationId: string | undefined) {
    if (navigationId) this.#historyNavigations.delete(navigationId);
  }

  bindHistoryNavigation(navigationId: string | undefined, surfaceId: BrowserSurfaceId) {
    const navigation = navigationId ? this.#historyNavigations.get(navigationId) : undefined;
    if (navigation) navigation.surfaceId = surfaceId;
  }

  #recordHistoryCommit(
    event: Extract<BrowserServerMessage, { type: "navigation.committed" }>,
  ): void {
    const profileId = this.profileId;
    const navigation = this.#historyNavigations.get(event.navigationId);
    if (
      !profileId ||
      !navigation ||
      (navigation.surfaceId && navigation.surfaceId !== event.surfaceId)
    )
      return;
    this.#historyNavigations.delete(event.navigationId);
    if (!BrowserHistoryUrlSchema.safeParse(event.url).success) return;
    const surface = this.#surfaces.find(
      (surface) => surface.id === event.surfaceId && surface.documentId === event.documentId,
    );
    const title = surface?.title.slice(0, 200) ?? "";
    const favicon = surface ? (surface.favicon ?? this.#surfaceIcon(surface)?.favicon) : undefined;
    this.#historyDocuments.set(event.documentId, {
      surfaceId: event.surfaceId,
      url: event.url,
      title,
    });
    // A previous icon write may have found no history, or clear may have erased it.
    this.#historyIcons.delete(event.surfaceId);
    if (favicon)
      this.#historyIcons.set(event.surfaceId, `${new URL(event.url).origin}\0${favicon}`);
    this.#historyWrite((store) =>
      store.recordVisit({
        profileId,
        ownerId: navigation.ownerId,
        url: event.url,
        title,
        typed: navigation.typed,
        ...(favicon ? { favicon } : {}),
      }),
    );
  }

  #reconcileHistory(surfaces: readonly BrowserSurface[]): void {
    const profileId = this.profileId;
    if (!profileId) return;
    for (const [id, navigation] of this.#historyNavigations)
      if (navigation.surfaceId && !surfaces.some((surface) => surface.id === navigation.surfaceId))
        this.#historyNavigations.delete(id);
    for (const [id, document] of this.#historyDocuments)
      if (
        !surfaces.some((surface) => surface.id === document.surfaceId && surface.documentId === id)
      )
        this.#historyDocuments.delete(id);
    for (const id of this.#historyIcons.keys())
      if (!surfaces.some((surface) => surface.id === id)) this.#historyIcons.delete(id);
    for (const surface of surfaces) {
      const document = surface.documentId
        ? this.#historyDocuments.get(surface.documentId)
        : undefined;
      if (document && document.title !== surface.title.slice(0, 200)) {
        document.title = surface.title.slice(0, 200);
        const { url, title } = document;
        this.#historyWrite((store) => store.retitle({ profileId, url, title }));
      }
      const icon = this.#surfaceIcon(surface);
      if (!icon || surface.navigationFailed) continue;
      if (!BrowserHistoryUrlSchema.safeParse(surface.url).success) continue;
      const origin = new URL(surface.url).origin;
      const fingerprint = `${origin}\0${icon.favicon}`;
      if (this.#historyIcons.get(surface.id) === fingerprint) continue;
      this.#historyIcons.set(surface.id, fingerprint);
      this.#historyWrite((store) => store.retainIcon({ profileId, origin, favicon: icon.favicon }));
    }
  }

  readonly #navigation: boolean;
  get navigationVersion(): 1 | undefined {
    return this.#navigation && this.live ? 1 : undefined;
  }
  readonly #restoreTabs: boolean;
  readonly #savedTabIds: readonly BrowserSurfaceId[] | undefined;
  readonly #tabs = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
  readonly #dirtyTabs = new Map<string, PageDescriptor>();
  readonly #closedTabs = new Set<BrowserSurfaceId>();
  #tabStateRevision = 0;
  #storedTabStateRevision = 0;
  #surfaces: BrowserSurface[] = [];
  get tabRestoreVersion(): 1 | undefined {
    return this.#restoreTabs ? 1 : undefined;
  }
  get hasTabChanges(): boolean {
    return (
      this.#dirtyTabs.size > 0 ||
      this.#closedTabs.size > 0 ||
      this.#tabStateRevision !== this.#storedTabStateRevision
    );
  }
  tabChanges() {
    return {
      tabs: [...this.#dirtyTabs.values()],
      closed: [...this.#closedTabs],
      stateRevision: this.#tabStateRevision,
      stateDirty: this.#tabStateRevision !== this.#storedTabStateRevision,
    };
  }
  acknowledgeTabChanges(changes: ReturnType<HostedBrowserBroker["tabChanges"]>): void {
    for (const row of changes.tabs)
      if (this.#dirtyTabs.get(row.id) === row) this.#dirtyTabs.delete(row.id);
    for (const id of changes.closed) this.#closedTabs.delete(id);
    this.#storedTabStateRevision = changes.stateRevision;
  }
  readonly #personTabGeneration: HostedBrowserBrokerOptions["personTabGeneration"];
  readonly #onTabsChanged: (structural?: boolean) => void;
  readonly #onRecordsChanged: (ids: readonly string[]) => void;
  readonly #onActivity: (activity: BrowserRuntimeActivity) => void;
  readonly #runtimeTargets = new Map<string, boolean>();
  readonly #runtimeRaster = new Map<
    string,
    {
      density: BrowserRasterDensity;
      wanted: BrowserRasterDensity;
      lowerAt: number;
      timer: NodeJS.Timeout | null;
    }
  >();
  readonly #latestFrames = new Map<
    string,
    { frame: Buffer; header: BrowserBinaryFrameHeader; documentId: string }
  >();
  readonly #frameIds = new Map<string, number>();
  readonly #onPageChanged: () => void;
  #pageNoticeTimer: NodeJS.Timeout | null = null;
  readonly #cdpListeners = new Set<
    (event: Extract<BrowserServerMessage, { type: "cdp.event" }>["event"]) => void
  >();
  readonly #cdpTerminalListeners = new Set<() => void>();
  readonly #consumers = new Map<string, BrowserConsumerOutlet>();
  readonly #connectTimeoutMs: number;
  readonly #onState: HostedBrowserBrokerOptions["onState"];
  readonly #onTerminal: () => void | Promise<void>;
  #readyPromise: Promise<void>;
  #reconnectReady: PromiseWithResolvers<void> | null = null;
  readonly #sessionId: BrowserSessionId;
  readonly #groupId: BrowserSessionId;
  readonly #socket: BrowserRuntimeConnection;
  #snapshot: Extract<BrowserRuntimeServerMessage, { type: "browser.snapshot" }> | null = null;
  readonly #editingContexts = new Map<
    BrowserSurfaceId,
    Extract<BrowserServerMessage, { type: "browser.editing" }>
  >();
  #answeredOlderDialogId: string | null = null;
  readonly #actionListeners = new Map<string, (event: BrowserActionEvent) => void>();
  readonly #pendingActions = new Map<
    string,
    {
      readonly attachmentId: string;
      readonly action: string;
      readonly resolve: (result: BrowserActionResult) => void;
      readonly reject: (error: unknown) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  readonly #pendingCdpRequests = new Map<
    string,
    {
      readonly expectedType: "cdp.result";
      readonly removeAbort: () => void;
      readonly acknowledge: (() => void) | undefined;
      readonly bounded: boolean;
      submitted: boolean;
      readonly reject: (error: unknown) => void;
      readonly resolve: (response: BrowserCdpResponse) => void;
      readonly timeout: NodeJS.Timeout | undefined;
    }
  >();
  /**
   * `state.import` is correlated by the Host's own operation ID, never by
   * `browser.error`. Imports share the export queue, so a `browser.error`
   * arriving while an import is outstanding cannot be taken for an export's.
   */
  readonly #pendingStateImports = new Map<string, PendingStateImport>();
  #scriptCleanup = 0;
  #commandTail = Promise.resolve();
  #runtimeFrameTail = Promise.resolve();
  #stateImportTail = Promise.resolve();
  #streamReconcileTail = Promise.resolve();
  #runtimeReady = false;
  #reconnecting = false;
  #runtimeConnectionGeneration = 0;
  #protocolFailed = false;
  /** The first thing that broke this session's runtime connection. */
  #failure: string | null = null;
  #settled = false;
  #finishPromise: Promise<void> | null = null;
  /** A Stop was asked of this broker (W2): only that makes a runtime's closing or closed the end. */
  #stopping = false;
  /**
   * The Home lets this broker go itself (a local detach, its own shutdown): its channel's close
   * is not a lost channel. It never makes a runtime's closing or closed the end of the session.
   */
  #detaching = false;

  readonly cdpBoundary: boolean;
  readonly agentActions?: boolean | undefined;
  readonly basicInput?: 1 | undefined;
  readonly surfaceState?: 1 | undefined;
  readonly sharedControl: boolean;
  readonly targetControl: boolean;
  readonly captureRegion: boolean;
  readonly rasterDemand: boolean;
  readonly editing: 1 | 2 | undefined;
  readonly passkeys: boolean;
  readonly passkeyOwnOrigins: () => readonly string[];
  readonly clipboard: boolean;
  readonly computer: { readonly name: string; readonly runnerId: RunnerId } | null;
  readonly fileStaging: boolean;
  readonly cardFill?: boolean;
  readonly signIn: boolean;
  readonly stateImport: boolean;

  readonly #readSessionState: HostedBrowserBrokerOptions["readSessionState"];
  #sessionStateTimer: NodeJS.Timeout | undefined;
  #sessionStateHold: BrowserPoolReservation | undefined;
  #sessionStateGeneration = 0;
  #lastSessionState: string | undefined;
  readonly #personUse: { tabs: Set<BrowserSurfaceId>; ended: boolean };
  readonly #pendingPersonUse: Set<BrowserSurfaceId>;
  readonly #onPersonUseChanged: () => void;
  #sessionStateSending: Promise<void> | undefined;
  #rejectReady: ((error: Error) => void) | null = null;
  readonly #passkeys: PasskeyService | undefined;
  constructor(options: HostedBrowserBrokerOptions) {
    this.#poolAdmission = options.poolAdmission;
    this.#poolEnded = options.poolAdmission ? new AbortController() : undefined;
    this.#onChannelLost = options.onChannelLost;
    this.#adoptedFromPool = options.adoptedFromPool === true;
    this.#personUse = options.personUse ?? { tabs: new Set(), ended: false };
    this.#pendingPersonUse = new Set(this.#personUse.tabs);
    this.#onPersonUseChanged = options.onPersonUseChanged ?? (() => undefined);
    this.#readSessionState = options.readSessionState;
    this.#restoreTabs = options.tabRestoreVersion === true;
    this.#savedTabIds = options.savedTabIds;
    this.profileId = options.profileId;
    this.#historyWrite = options.historyWrite;
    if (options.initialHistoryNavigation) {
      const { navigationId, ownerId, typed } = options.initialHistoryNavigation;
      this.#historyNavigations.set(navigationId, { ownerId, typed });
    }
    this.passkeys = options.passkeys;
    this.passkeyOwnOrigins = options.passkeyOwnOrigins;
    this.#passkeys = options.passkeys
      ? new PasskeyService({
          onChanged: () => this.refreshSessionState(),
          ownOrigins: options.passkeyOwnOrigins,
          viewers: () =>
            [...this.#consumers.values()].map((outlet): PasskeyViewer => ({
              token: outlet.clipboardToken,
              userId: outlet.userId,
              fullControl: outlet.mode === "control",
              mode: outlet.passkeys,
              surfaceId: outlet.subscription === null ? null : outlet.surfaceId,
              live: outlet.peer.isOpen(),
              authorized: outlet.authorized,
              send: (message) => {
                void outlet.sendText(JSON.stringify(message)).catch(() => outlet.close());
              },
            })),
          result: (message) => {
            void this.#sendCommand(message).catch(() => undefined);
          },
        })
      : undefined;
    this.#navigation = options.navigation;
    this.#personTabGeneration = options.personTabGeneration;
    this.#onTabsChanged = options.onTabsChanged;
    this.#onRecordsChanged = options.onRecordsChanged;
    this.#onActivity = options.onActivity;
    this.#onPageChanged = options.onPageChanged;
    this.cdpBoundary = options.cdpBoundary;
    this.agentActions = options.agentActions;
    this.basicInput = options.basicInput;
    this.surfaceState = options.surfaceState;
    this.sharedControl = options.sharedControl;
    this.targetControl = options.targetControl;
    this.captureRegion = options.captureRegion;
    this.rasterDemand = options.rasterDemand;
    this.editing = options.editing;
    this.clipboard = options.clipboard;
    this.computer = options.computer;
    this.fileStaging = options.fileStaging;
    this.cardFill = options.cardFill === true;
    this.signIn = options.signIn;
    this.stateImport = options.stateImport;
    this.#connectTimeoutMs = options.connectTimeoutMs;
    this.#onState = options.onState;
    this.#onTerminal = options.onTerminal;
    this.#sessionId = options.sessionId;
    this.#groupId = options.groupId;
    if (options.restoredIcon)
      this.restoreIcon(
        options.restoredIcon.id,
        options.restoredIcon.url,
        options.restoredIcon.favicon,
      );
    this.#socket = options.socket;
    this.#readyPromise = this.#waitUntilReady();
  }

  removePersonTab(surfaceId: BrowserSurfaceId, generation?: number): void {
    const newerViewer =
      generation !== undefined &&
      [...this.#consumers.values()].some(
        (outlet) =>
          outlet.surfaceId === surfaceId &&
          outlet.tabGeneration !== null &&
          outlet.tabGeneration > generation,
      );
    if (!newerViewer) {
      this.#personUse.tabs.delete(surfaceId);
      this.#pendingPersonUse.delete(surfaceId);
    }
    for (const outlet of this.#consumers.values())
      if (
        outlet.surfaceId === surfaceId &&
        (generation === undefined ||
          outlet.tabGeneration === null ||
          outlet.tabGeneration <= generation)
      ) {
        outlet.peer.close(1000, "Tab closed");
        outlet.close();
      }
    this.#onPersonUseChanged();
    this.refreshSessionState();
  }
  async markPersonUsed(surfaceId: BrowserSurfaceId): Promise<void> {
    if (!this.live || !this.#tabs.rows.has(surfaceId) || this.#personUse.ended) return;
    if (!this.#personUse.tabs.has(surfaceId)) {
      this.#personUse.tabs.add(surfaceId);
      this.#pendingPersonUse.add(surfaceId);
      this.#onPersonUseChanged();
    }
    this.#sessionStateGeneration++;
    await this.#sendSessionState();
  }

  /** What this runtime reports now, and who uses which tab, for the Host's shadow comparison. */
  shadowFacts(): Pick<ShadowInventory, "surfaces" | "pending" | "personUsed" | "viewing"> | null {
    // Only a whole, committed inventory is compared.
    if (!this.live || this.#tabs.state !== "committed") return null;
    const surfaces = new Map<string, "live" | "suspended">();
    for (const [id, row] of this.#tabs.rows) surfaces.set(id, row.state ?? "live");
    const viewing = new Set<string>();
    for (const outlet of this.#consumers.values()) {
      const id =
        outlet.subscription === null ? null : (outlet.surfaceId ?? this.#tabs.meta?.activeId);
      if (id) viewing.add(id);
    }
    return {
      surfaces,
      pending: new Set(this.#dirtyTabs.keys()),
      personUsed: new Set(this.#personUse.tabs),
      viewing,
    };
  }

  refreshSessionState(): void {
    this.#sessionStateGeneration++;
    if (!this.live || this.#snapshot?.surfaceState !== 1 || this.#sessionStateTimer) return;
    // A protection fact waiting to be sent keeps a park from starting, or vetoes it before D.
    this.#sessionStateHold = this.#poolAdmission?.now();
    this.#sessionStateTimer = setTimeout(() => {
      this.#sessionStateTimer = undefined;
      const hold = this.#sessionStateHold;
      this.#sessionStateHold = undefined;
      void this.#sendSessionState()
        .catch(() => undefined)
        .finally(() => hold?.release());
    }, 50);
    this.#sessionStateTimer.unref();
  }

  /** Sends a pending session state now instead of after its short delay. */
  async #flushSessionState(): Promise<void> {
    if (this.#sessionStateTimer) clearTimeout(this.#sessionStateTimer);
    this.#sessionStateTimer = undefined;
    const hold = this.#sessionStateHold;
    this.#sessionStateHold = undefined;
    try {
      if (this.live && this.#snapshot?.surfaceState === 1)
        await this.#sendSessionState().catch(() => undefined);
    } finally {
      hold?.release();
    }
  }

  #sendSessionState(): Promise<void> {
    if (this.#sessionStateSending) return this.#sessionStateSending;
    const send = async () => {
      let generation: number;
      do {
        generation = this.#sessionStateGeneration;
        await this.#writeSessionState();
      } while (this.live && generation !== this.#sessionStateGeneration);
    };
    this.#sessionStateSending = send().finally(() => {
      this.#sessionStateSending = undefined;
    });
    return this.#sessionStateSending;
  }

  async #writeSessionState(): Promise<void> {
    if (!this.live || this.#snapshot?.surfaceState !== 1) return;
    const generation = this.#sessionStateGeneration;
    let facts: Awaited<ReturnType<HostedBrowserBrokerOptions["readSessionState"]>>;
    try {
      facts = await this.#readSessionState();
    } catch {
      facts = { runs: 0, pinned: [], keepAwake: true };
    }
    if (!this.live || generation !== this.#sessionStateGeneration) return;
    const viewed = new Set<BrowserSurfaceId>();
    const pinned = new Set(facts.pinned);
    for (const id of this.#passkeys?.pendingSurfaceIds ?? [])
      pinned.add(BrowserSurfaceIdSchema.parse(id));
    for (const outlet of this.#consumers.values()) {
      if (outlet.subscription === null) continue;
      const id = outlet.surfaceId ?? this.#tabs.meta?.activeId;
      if (id && this.#tabs.rows.has(id))
        (outlet.mode === "control" ? viewed : pinned).add(BrowserSurfaceIdSchema.parse(id));
    }
    let message: Extract<BrowserClientMessage, { type: "session.state" }> = {
      type: "session.state" as const,
      ...facts,
      viewed: [...viewed].sort(),
      personUsed: [],
      pinned: [...pinned].sort(),
    };
    let markBytes = 0;
    for (const id of this.#pendingPersonUse) markBytes = Math.max(markBytes, keyedStreamBytes(id));
    if (keyedStreamBytes(message) + markBytes > keyedStreamHardCapBytes)
      message = {
        type: "session.state",
        runs: facts.runs,
        viewed: [],
        personUsed: [],
        pinned: [],
        keepAwake: true,
      };
    const encoded = JSON.stringify(message);
    const baseBytes = keyedStreamBytes(message);
    const send = async (ids: BrowserSurfaceId[]) => {
      ids = this.#personUse.ended
        ? []
        : ids.filter((id) => this.#personUse.tabs.has(id) && this.#tabs.rows.has(id));
      await this.#sendCommand({ ...message, personUsed: ids });
      for (const id of ids) this.#pendingPersonUse.delete(id);
      this.#lastSessionState = encoded;
    };
    let ids: BrowserSurfaceId[] = [];
    let bytes = baseBytes;
    for (const id of this.#pendingPersonUse) {
      if (this.#personUse.ended || !this.#personUse.tabs.has(id)) {
        this.#pendingPersonUse.delete(id);
        continue;
      }
      if (!this.#tabs.rows.has(id)) continue;
      const addition = keyedStreamBytes(id) + (ids.length ? 1 : 0);
      if (bytes + addition > keyedStreamHardCapBytes) {
        await send(ids);
        if (!this.live || generation !== this.#sessionStateGeneration) return;
        ids = [];
        bytes = baseBytes;
      }
      bytes += keyedStreamBytes(id) + (ids.length ? 1 : 0);
      ids.push(id);
    }
    if (ids.length || encoded !== this.#lastSessionState) await send(ids);
  }

  async #sendSavedTabs(): Promise<void> {
    if (!this.#savedTabIds) return;
    const rows = new Map(this.#savedTabIds.map((id) => [id, { id }]));
    const publisher = new KeyedStreamPublisher({
      ids: () => rows.keys(),
      read: (id) => rows.get(BrowserSurfaceIdSchema.parse(id)),
      meta: () => ({}),
      targetBytes: 64 * 1024,
      envelopeBytes: keyedStreamBytes({ type: "session.saved", stream: null }) - 4,
    });
    for (let stream = publisher.next(); stream; stream = publisher.next()) {
      await this.#sendCommand({ type: "session.saved", stream });
      publisher.settled(stream, true);
    }
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  /** The Runtime has sent its snapshot and the session has not ended. */
  get live(): boolean {
    return this.#runtimeReady && !this.#settled;
  }

  get pooled(): boolean {
    return this.#poolAdmission !== undefined;
  }

  get groupId(): BrowserSessionId {
    return this.#groupId;
  }
  clientRows(presence: Pick<BrowserLiveRows, "acting" | "page">): BrowserLiveRows {
    return {
      groupId: this.#groupId,
      records: this.#tabs.rows,
      inventoryRevision: this.inventoryRevision,
      navigation: this.#navigation,
      ready: this.live,
      ...presence,
      iconRef: (id) => {
        const row = this.#tabs.rows.get(id);
        return row ? (this.#surfaceIcon(row)?.ref ?? null) : null;
      },
    };
  }
  get inventoryRevision(): number {
    return this.#tabs.meta?.inventoryRevision ?? 0;
  }
  readonly #icons = new Map<string, { favicon: string; ref: string }>();
  #iconBytes = 0;
  readonly #restoredIcons = new Map<
    BrowserSurfaceId,
    { url: string; favicon: string; ref: string }
  >();
  readonly #dialogs = new Map<string, BrowserDialog>();
  restoreIcon(id: BrowserSurfaceId, url: string, favicon: string): void {
    this.#restoredIcons.set(id, { url, favicon, ref: pageIconRef(this.#groupId, favicon) });
  }
  #surfaceIcon(surface: Pick<BrowserSurface, "id" | "url">) {
    const row = this.#tabs.rows.get(surface.id);
    const current = row?.icon ? this.#icons.get(row.icon) : undefined;
    if (current) return current;
    const restored = this.#restoredIcons.get(surface.id);
    return restored && (restored.url === surface.url || surface.url === "about:blank")
      ? restored
      : undefined;
  }
  icon(iconRef: string): string | null {
    return (
      this.#surfaces
        .map((surface) => this.#surfaceIcon(surface))
        .find((icon) => icon?.ref === iconRef)?.favicon ?? null
    );
  }
  /** The page the person sees: the active tab's title and site. */
  get page(): BrowserPagePresence | null {
    const surface = this.#surfaces.find((surface) => surface.active);
    if (!surface) return null;
    return { title: surface.title.slice(0, 256), url: browserPageSite(surface.url) };
  }

  geometryOf(surfaceId: string): number | undefined {
    return this.#surfaces.find((surface) => surface.id === surfaceId)?.geometryRevision;
  }

  surfaceStateOf(surfaceId: string) {
    return this.#surfaces.find((surface) => surface.id === surfaceId)?.state;
  }

  /**
   * What one tab shows now, as a conversation's use of it records it. A page
   * that failed to load shows an address it never reached, so it records none.
   */
  pageOf(surfaceId: string): BrowserUsePage | null {
    const surface = this.#surfaces.find((surface) => surface.id === surfaceId);
    if (!surface) return null;
    return {
      site: surface.navigationFailed ? "" : browserPageSite(surface.url).slice(0, 2048),
      title: surface.title.slice(0, 256),
    };
  }

  pageKeyOf(surfaceId: string): string | undefined {
    const surface = this.#surfaces.find((surface) => surface.id === surfaceId);
    return surface
      ? JSON.stringify([surface.documentId, surface.url, surface.title, surface.navigationFailed])
      : undefined;
  }

  #noticePage(): void {
    if (this.#pageNoticeTimer !== null) return;
    this.#pageNoticeTimer = setTimeout(() => {
      this.#pageNoticeTimer = null;
      if (!this.#settled) this.#onPageChanged();
    }, pageNoticeDelayMs);
    this.#pageNoticeTimer.unref();
  }

  async attach(
    peer: BrowserConsumerPeer,
    mode: BrowserConsumerMode,
    stillVisible: () => Promise<boolean>,
    onClose: () => void,
    editing: 1 | 2 | undefined = undefined,
    passkeys: PasskeyMode | undefined = undefined,
    popups: boolean,
    userId: UserId,
    signedIn: () => Promise<boolean>,
    negotiation: {
      readonly basicInput?: 1 | undefined;
      readonly surfaceState?: 1 | undefined;
      readonly autofill?: PersonFillVersion | undefined;
    } = {},
  ): Promise<BrowserConsumerAttachment> {
    if (this.#settled) throw new OpensteerError({ code: "conflict", message: "Browser closed." });
    if (!this.#snapshot || !this.#runtimeReady) {
      throw new OpensteerError({
        code: "conflict",
        message: "Browser is not synchronized.",
        retryable: true,
      });
    }
    if (this.#consumers.has(peer.id)) {
      throw new OpensteerError({ code: "conflict", message: "Browser consumer already attached." });
    }
    let outlet: BrowserConsumerOutlet;
    const visible = async () =>
      (await stillVisible()) &&
      (!this.#personTabGeneration ||
        !outlet.surfaceId ||
        (await this.#personTabGeneration(BrowserSurfaceIdSchema.parse(outlet.surfaceId))) ===
          outlet.tabGeneration);
    outlet = new BrowserConsumerOutlet(peer, mode, visible, () => {
      onClose();
      const wasSubscribed = outlet.subscription !== null;
      this.#consumers.delete(peer.id);
      this.refreshSessionState();
      this.#passkeys?.refresh();
      if (
        outlet.mode === "control" &&
        this.#runtimeReady &&
        this.#snapshot?.inputLanesVersion === 1
      )
        void this.#sendCommand({
          type: "input.cancel",
          producerId: outlet.clipboardToken,
          inputGeneration: outlet.inputGeneration,
          ...(this.#snapshot.personFillVersion === 2 ? { ended: true as const } : {}),
        }).catch(() => undefined);
      if (wasSubscribed) {
        void this.#reconcileStreaming().catch(() => undefined);
      }
    });
    outlet.userId = userId;
    outlet.passkeys = this.passkeys ? passkeys : undefined;
    outlet.popups = popups && mode === "control";
    outlet.autofill = mode === "control" ? (negotiation.autofill ?? 0) : 0;
    outlet.authorized = async () => (await visible()) && (await signedIn());
    this.#consumers.set(peer.id, outlet);
    try {
      outlet.basicInput = negotiation.basicInput === 1 && this.#snapshot.basicInput === 1;
      outlet.surfaceState = negotiation.surfaceState === 1 && this.#snapshot.surfaceState === 1;
      const version = this.#snapshot.editingVersion;
      outlet.editing = browserViewerEditingVersion(this.#snapshot, editing);
      outlet.clipboard = Boolean(
        outlet.editing && (version === 1 || this.#snapshot.clipboard === true),
      );
      const {
        cdpReplyBudget: _cdpReplyBudget,
        scriptAttachments: _scriptAttachments,
        scriptCancellation: _scriptCancellation,
        ...viewerSnapshot
      } = this.#snapshot;
      await outlet.sendText(
        JSON.stringify(
          browserViewerMessage(
            {
              ...viewerSnapshot,
              surfaces: this.#surfaces,
              inventoryRevision: this.inventoryRevision,
            },
            outlet.editing,
            outlet.passkeys,
            outlet.clipboardToken,
            outlet.popups,
            {
              basicInput: outlet.basicInput,
              surfaceState: outlet.surfaceState,
              autofill: outlet.autofill,
            },
          ),
        ),
      );
    } catch (error) {
      outlet.close();
      throw error;
    }
    return new BrowserConsumerAttachment(
      (frame, isBinary) => this.#handleConsumerFrame(outlet, frame, isBinary),
      () => {
        outlet.close();
      },
    );
  }

  async sendHostCommand(input: BrowserClientMessage): Promise<void> {
    const message = BrowserClientMessageSchema.parse(input);
    return this.#sendCommand(message);
  }

  subscribeCdp(
    listener: (event: Extract<BrowserServerMessage, { type: "cdp.event" }>["event"]) => void,
    onTerminal?: () => void,
  ): () => void {
    if (this.#settled) throw new OpensteerError({ code: "conflict", message: "Browser closed." });
    this.#cdpListeners.add(listener);
    if (onTerminal) this.#cdpTerminalListeners.add(onTerminal);
    return () => {
      this.#cdpListeners.delete(listener);
      if (onTerminal) this.#cdpTerminalListeners.delete(onTerminal);
    };
  }

  subscribeActions(
    attachmentId: string,
    onEvent: (event: BrowserActionEvent) => void,
    onTerminal: () => void,
  ): () => void {
    this.#actionListeners.set(attachmentId, onEvent);
    const terminal = this.subscribeCdp(() => undefined, onTerminal);
    return () => {
      this.#actionListeners.delete(attachmentId);
      terminal();
    };
  }

  detachActions(attachmentId: string): void {
    this.#actionListeners.delete(attachmentId);
    for (const [id, pending] of this.#pendingActions) {
      if (pending.attachmentId !== attachmentId) continue;
      clearTimeout(pending.timeout);
      this.#pendingActions.delete(id);
      pending.reject(
        browserActionFailure(
          "outcome-unknown",
          "The agent attachment ended before the action answered.",
        ),
      );
    }
  }

  assertActionTarget(request: BrowserActionRequest): void {
    if (["session.tabs", "surface.open"].includes(request.action.type)) return;
    const surface = this.#surfaces.find((candidate) => candidate.id === request.surfaceId);
    if (!surface) throw browserActionFailure("target-closed", "The tab no longer exists.");
    if (request.action.type === "surface.resume") return;
    if (surface.state === "suspended" && request.action.type !== "surface.close")
      throw browserActionFailure("target-suspended", "The tab is suspended.");
    if (request.documentId !== undefined && request.documentId !== surface.documentId)
      throw browserActionFailure("stale-document", "The tab has another document.");
    if (
      request.geometryRevision !== undefined &&
      request.geometryRevision !== surface.geometryRevision
    )
      throw browserActionFailure("stale-geometry", "The tab geometry changed.");
  }

  requestAction(
    message: Extract<BrowserClientMessage, { type: "agent.action" }>,
  ): Promise<BrowserActionResult> {
    if (this.#settled || !this.#runtimeReady)
      return Promise.reject(new BrowserCdpConnectionEnded("The browser connection ended."));
    if (this.#pendingActions.size >= maxPendingAgentRequests)
      return Promise.reject(
        browserActionFailure("too-large", "Too many browser actions are pending."),
      );
    return new Promise<BrowserActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingActions.delete(message.requestId);
        const observation = [
          "session.tabs",
          "page.info",
          "page.wait",
          "dom.snapshot",
          "dom.query",
          "dom.wait",
          "page.capture",
        ].includes(message.request.action.type);
        reject(
          browserActionFailure(
            observation ? "timeout" : "outcome-unknown",
            observation
              ? "The browser observation did not answer before its deadline."
              : "The browser action did not answer before its deadline. Do not retry input.",
          ),
        );
      }, message.request.timeoutMs);
      timeout.unref();
      this.#pendingActions.set(message.requestId, {
        attachmentId: message.attachmentId,
        action: message.request.action.type,
        resolve,
        reject,
        timeout,
      });
      void this.#sendCommand(message).catch((error: unknown) => {
        const pending = this.#pendingActions.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pendingActions.delete(message.requestId);
        reject(error);
      });
    });
  }

  get supportsBrowserScriptAttachments(): boolean {
    return this.#snapshot?.scriptAttachments === 1 && this.supportsScriptCancellation;
  }

  get supportsScriptCancellation(): boolean {
    return this.#snapshot?.scriptCancellation === 1;
  }

  get supportsCdpReplyBudget(): boolean {
    return this.#snapshot?.cdpReplyBudget === 1;
  }

  async sendScriptCleanup(message: BrowserCdpRequest): Promise<void> {
    if (this.#scriptCleanup >= 256) throw new Error("Browser script cleanup queue is full.");
    this.#scriptCleanup++;
    try {
      const signal = AbortSignal.timeout(5_000);
      await withTimeout(this.#sendCommand(message, signal), 5_000, {
        signal,
        timeoutError: () => new Error("Browser script cleanup deadline exceeded."),
      });
    } finally {
      this.#scriptCleanup--;
    }
  }

  requestCdp(
    message: BrowserCdpRequest,
    signal?: AbortSignal,
    admission?: { recheck(): Promise<void>; submitted(): void; acknowledged?(): void },
  ): Promise<BrowserCdpResponse> {
    signal?.throwIfAborted();
    const parsed = BrowserClientMessageSchema.parse(message) as BrowserCdpRequest;
    if (this.#settled || !this.#runtimeReady) {
      return Promise.reject(
        new OpensteerError({ code: "conflict", message: "Browser Runtime is not ready." }),
      );
    }
    if (this.#pendingCdpRequests.size >= maxPendingAgentRequests) {
      return Promise.reject(
        new OpensteerError({
          code: "conflict",
          message: "Too many CDP requests are pending.",
          retryable: true,
        }),
      );
    }
    if (this.#pendingCdpRequests.has(parsed.requestId)) {
      return Promise.reject(
        new OpensteerError({ code: "conflict", message: "CDP request ID is already active." }),
      );
    }
    return new Promise<BrowserCdpResponse>((resolve, reject) => {
      const timeout = parsed.replyBudget
        ? undefined
        : setTimeout(() => {
            this.#pendingCdpRequests.delete(parsed.requestId);
            reject(
              new OpensteerError({
                code: "timeout",
                message: "Browser Runtime did not answer the CDP request in time.",
                retryable: true,
              }),
            );
          }, agentRequestTimeoutMs);
      timeout?.unref();
      const cancel = () => {
        if (!pending.submitted || this.#pendingCdpRequests.get(parsed.requestId) !== pending)
          return;
        void this.sendScriptCleanup({
          type: "cdp.command",
          requestId: randomUUID(),
          ...(parsed.scriptAttachmentId ? { scriptAttachmentId: parsed.scriptAttachmentId } : {}),
          command: {
            method: browserHostMethods.cancelScriptCommand,
            parameters: { requestId: parsed.requestId },
          },
        }).catch((error: unknown) => console.error("browser.script.cancel.failed", error));
      };
      const pending = {
        expectedType: "cdp.result" as const,
        submitted: false,
        reject,
        resolve,
        timeout,
        bounded: parsed.replyBudget !== undefined,
        removeAbort: () => signal?.removeEventListener("abort", cancel),
        acknowledge: admission?.acknowledged,
      };
      if (this.supportsScriptCancellation && parsed.replyBudget)
        signal?.addEventListener("abort", cancel, { once: true });
      this.#pendingCdpRequests.set(parsed.requestId, pending);
      void this.#sendCommand(
        parsed,
        signal,
        () => {
          pending.submitted = true;
          admission?.submitted();
        },
        admission?.recheck,
      ).catch((error) => {
        if (this.#pendingCdpRequests.get(parsed.requestId) !== pending) return;
        if (parsed.replyBudget && pending.submitted) {
          this.#socket.terminate();
          return;
        }
        clearTimeout(pending.timeout);
        pending.removeAbort();
        this.#pendingCdpRequests.delete(parsed.requestId);
        pending.reject(error);
      });
    });
  }

  requestStateImport(site: string, cookies: readonly BrowserCookie[]): Promise<void> {
    const operation = this.#stateImportTail.then(
      () => this.#importState(site, cookies),
      () => this.#importState(site, cookies),
    );
    this.#stateImportTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #importState(site: string, cookies: readonly BrowserCookie[]): Promise<void> {
    if (this.#settled || !this.#runtimeReady) {
      return Promise.reject(
        new OpensteerError({ code: "conflict", message: "Browser Runtime is not ready." }),
      );
    }
    const operationId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pendingStateImports.delete(operationId)) return;
        reject(
          new OpensteerError({
            code: "timeout",
            message: "Browser Runtime did not apply the sign-in in time.",
            retryable: true,
          }),
        );
      }, browserStateImportHostTimeoutMs);
      timeout.unref();
      this.#pendingStateImports.set(operationId, { reject, resolve, timeout });
      void this.#sendCommand({
        cookies: [...cookies],
        operationId,
        site,
        type: "state.import",
      }).catch((error: unknown) => {
        const pending = this.#pendingStateImports.get(operationId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pendingStateImports.delete(operationId);
        pending.reject(error);
      });
    });
  }

  async prepareRuntimeReconnect(): Promise<void> {
    await this.#runtimeFrameTail;
    if (!this.live || this.#stopping || this.#detaching)
      throw new Error("The browser session has ended.");
    this.#runtimeReady = false;
    this.#reconnecting = true;
    const reconnectReady = Promise.withResolvers<void>();
    reconnectReady.promise.catch(() => undefined);
    this.#reconnectReady = reconnectReady;
    this.#readyPromise = reconnectReady.promise;
    this.#lastSessionState = undefined;
    ++this.#runtimeConnectionGeneration;
    this.#snapshot = null;
    this.#dialogs.clear();
    this.#latestFrames.clear();
    this.#frameIds.clear();
    this.#editingContexts.clear();
    for (const listener of this.#cdpTerminalListeners) {
      try {
        listener();
      } catch {
        // One agent's transport cannot prevent the person's reconnect.
      }
    }
    this.#cdpTerminalListeners.clear();
    this.#cdpListeners.clear();
    for (const attachmentId of this.#actionListeners.keys()) this.detachActions(attachmentId);
    for (const pending of this.#pendingCdpRequests.values()) {
      clearTimeout(pending.timeout);
      pending.removeAbort();
      pending.reject(browserCommandOutcomeUnknown());
    }
    this.#pendingCdpRequests.clear();
    for (const pending of this.#pendingStateImports.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new OpensteerError({ code: "conflict", message: "The device is restarting." }),
      );
    }
    this.#pendingStateImports.clear();
    await this.#streamReconcileTail;
    this.#runtimeTargets.clear();
    for (const raster of this.#runtimeRaster.values()) if (raster.timer) clearTimeout(raster.timer);
    this.#runtimeRaster.clear();
  }

  async stop(): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    if (this.#poolAdmission) {
      // A pooled session says closed only on the runtime's own `closed` status, or its answer to
      // the end step's request; nothing heard leaves the row closing for that step.
      this.#stopping = true;
      this.#runtimeReady = false;
      this.#rejectReady?.(new Error(this.#failure ?? "Browser session stopped during attach."));
      await this.#onState("closing").catch(() => undefined);
      await this.stopWithReceipt(5_000);
      return;
    }
    this.#stopping = true;
    this.#runtimeReady = false;
    this.#rejectReady?.(new Error(this.#failure ?? "Browser session stopped during attach."));
    await this.#onState("closing").catch(() => undefined);
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.close();
    else if (this.#socket.readyState === WebSocket.OPEN)
      this.#socket.close(1000, "Host stopped session");
    await waitForSocketClose(this.#socket, 5_000);
    await this.#runtimeFrameTail;
    await this.#finish("closed", 1000, "Browser session closed");
  }

  /**
   * Closes the channel the way Stop does and says whether the channel's close came back as the
   * Home's own 1000. That is no answer about the session (only the runtime's `closed` status, or
   * its answer to an end request, is): the session's row is the caller's to write.
   */
  async stopWithReceipt(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.#finishPromise) {
      await this.#finishPromise.catch(() => undefined);
      return false;
    }
    this.#stopping = true;
    this.#runtimeReady = false;
    this.#rejectReady?.(new Error(this.#failure ?? "Browser session stopped during attach."));
    if (this.#socket.readyState !== WebSocket.OPEN) {
      this.#socket.terminate();
      await this.#runtimeFrameTail;
      await this.#finish("pooled", 1000, "Browser session closed");
      return false;
    }
    const answered = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
      const abort = () => resolve(false);
      signal?.addEventListener("abort", abort, { once: true });
      this.#socket.once("close", (code: number) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve(code === 1000);
      });
    });
    this.#socket.close(1000, "Host stopped session");
    const receipt = await answered;
    if (!receipt) this.#socket.terminate();
    await this.#runtimeFrameTail;
    // Never closed from here: the row is the end step's, on the runtime's own word.
    await this.#finish("pooled", 1000, "Browser session closed");
    return receipt;
  }

  /**
   * A pooled reattach that did not take: this broker goes, and the session's row stays for the
   * next attempt inside its window or the end its deadline records with a note.
   */
  /**
   * `signal`: a step's wait for the frames already received ends with it; the broker still
   * finishes once they are handled.
   */
  async detachPooled(reason: string, signal?: AbortSignal): Promise<void> {
    this.#failure ??= reason;
    // The Home ends this channel itself: its close is not a lost channel.
    this.#detaching = true;
    this.#runtimeReady = false;
    this.#rejectReady?.(new Error(this.#failure));
    if (
      this.#socket.readyState === WebSocket.CONNECTING ||
      this.#socket.readyState === WebSocket.OPEN
    )
      this.#socket.terminate();
    const finished = this.#runtimeFrameTail.then(() =>
      this.#finish("pooled", 1011, "Browser Runtime disconnected"),
    );
    if (!signal) return finished;
    void finished.catch(() => undefined);
    await untilSettledOrAborted(finished, signal);
  }

  /** The Home goes: this broker finishes here and sends nothing; its row is kept as it is. */
  async letGoPooled(reason: string): Promise<void> {
    this.#failure ??= reason;
    this.#detaching = true;
    this.#runtimeReady = false;
    this.#rejectReady?.(new Error(this.#failure));
    await this.#runtimeFrameTail;
    await this.#finish("pooled", 1001, "Browser Runtime disconnected");
  }

  async abort(reason: string): Promise<void> {
    this.#failure ??= reason;
    if (this.#poolAdmission && (this.#stopping || this.#detaching)) {
      if (this.#finishPromise) return this.#finishPromise;
      await this.#runtimeFrameTail;
      await this.#finish("pooled", 1011, "Browser Runtime disconnected");
      return;
    }
    this.#rejectReady?.(new Error(this.#failure));
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else if (this.#socket.readyState === WebSocket.OPEN) this.#socket.terminate();
    await this.#runtimeFrameTail;
    await this.#finish("failed", 1011, "Browser session failed");
  }

  async #waitUntilReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const abortReady = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#rejectReady = null;
        reject(error);
      };
      this.#rejectReady = abortReady;
      const timeout = setTimeout(() => {
        this.#protocolFailed = true;
        const error = new Error("Browser Runtime attach timed out.");
        abortReady(error);
        if (this.#socket.readyState === WebSocket.OPEN)
          this.#socket.close(1002, "attach timed out");
      }, this.#connectTimeoutMs);
      timeout.unref();
      const fail = (error: unknown) => {
        this.#failure ??= error instanceof Error ? error.message : String(error);
        this.#protocolFailed = true;
        this.#runtimeReady = false;
        const normalized =
          error instanceof Error ? error : new Error("Browser Runtime attach failed.");
        abortReady(normalized);
        this.#rejectReconnectReady(normalized);
        if (this.#socket.readyState === WebSocket.OPEN) {
          this.#socket.close(1002, "invalid Browser Runtime protocol");
        }
      };
      this.#socket.on("error", fail);
      this.#socket.on("message", (raw, isBinary) => {
        const handled = this.#runtimeFrameTail.then(() => this.#handleRuntimeFrame(raw, isBinary));
        this.#runtimeFrameTail = handled.then(
          () => undefined,
          () => undefined,
        );
        void handled
          .then((becameReady) => {
            if (!becameReady || settled) return;
            if (this.#stopping || this.#detaching || !this.#runtimeReady) {
              abortReady(new Error(this.#failure ?? "Browser Runtime detached during attach."));
              return;
            }
            settled = true;
            ready = true;
            clearTimeout(timeout);
            this.#rejectReady = null;
            resolve();
          })
          .catch(fail);
      });
      this.#socket.on("close", (code, reason) => {
        this.#failure ??= `Browser Runtime closed the connection (${code} ${reason.toString()}).`;
        abortReady(
          new Error(`Browser Runtime closed during attach (${code} ${reason.toString()}).`),
        );
        const retired =
          !this.#stopping &&
          !this.#detaching &&
          this.#poolAdmission?.retiring() &&
          code === 1012 &&
          reason.toString() === "browser-pool-retire";
        // A pooled guest outlives its Runner: a close the Home did not ask for, and that the
        // runtime did not announce as the session's end, is a lost channel whatever its code.
        const channelLost =
          !this.#stopping &&
          !this.#detaching &&
          !retired &&
          ready &&
          this.#poolAdmission !== undefined &&
          !this.#runtimeEnded;
        // A pooled session says closed only on the runtime's `closed` (or its end request's
        // answer): never on the channel's own close, whatever its code, before or after ready.
        const pooledOutcome = (): "closed" | "failed" | "pooled" =>
          this.#runtimeEnded
            ? "closed"
            : retired || channelLost || this.#stopping || this.#detaching || this.#runtimeClosing
              ? "pooled"
              : "failed";
        if (channelLost) {
          const documents = new Map(
            [...this.#tabs.rows].map(([surfaceId, row]) => [surfaceId, row.documentId]),
          );
          queueMicrotask(() => this.#onChannelLost?.(documents));
        }
        void this.#runtimeFrameTail
          .then(async () => {
            const outcome = this.#poolAdmission
              ? pooledOutcome()
              : this.#stopping || code === 1000
                ? "closed"
                : "failed";
            await this.#finish(
              outcome,
              this.#stopping ? 1000 : 1011,
              this.#stopping ? "Browser session closed" : "Browser Runtime disconnected",
            );
          })
          .catch((error: unknown) => {
            console.error("browser.session.finish.failed", this.#sessionId, error);
          });
      });
    });
  }

  async #handleRuntimeFrame(raw: RawData, isBinary: boolean): Promise<boolean> {
    if (this.#settled || this.#protocolFailed) return false;
    const frame = rawDataBuffer(raw);
    if (isBinary) {
      if (frame.byteLength > maxBrowserFrameBytes + 20_000) {
        throw new Error("Browser Runtime sent an oversized binary frame.");
      }
      if (!this.#runtimeReady) {
        throw new Error("Browser Runtime sent a frame before the session was ready.");
      }
      const decoded = decodeBrowserFrameEnvelope(frame, maxBrowserFrameBytes);
      if (decoded.header.watchToken) {
        throw new Error("Browser Runtime sent a Host-only Watch token.");
      }
      const targetSurface = this.#tabs.rows.get(decoded.header.surfaceId);
      if (
        !targetSurface ||
        decoded.header.frameId <= (this.#frameIds.get(decoded.header.surfaceId) ?? -1)
      )
        return false;
      if (decoded.header.geometryRevision !== targetSurface.geometryRevision) return false;
      if (
        ![...this.#consumers.values()].some(
          (consumer) =>
            consumer.subscription === "frames" && consumer.surfaceId === decoded.header.surfaceId,
        )
      )
        return false;
      this.#frameIds.set(decoded.header.surfaceId, decoded.header.frameId);
      this.#latestFrames.delete(decoded.header.surfaceId);
      this.#latestFrames.set(decoded.header.surfaceId, {
        frame,
        header: decoded.header,
        documentId: targetSurface.documentId,
      });
      let retainedBytes = [...this.#latestFrames.values()].reduce(
        (sum, entry) => sum + entry.frame.byteLength,
        0,
      );
      for (const [id, entry] of this.#latestFrames) {
        if (retainedBytes <= 32 * 1024 * 1024) break;
        this.#latestFrames.delete(id);
        retainedBytes -= entry.frame.byteLength;
      }
      for (const consumer of this.#consumers.values()) {
        if (consumer.subscription === "frames" && consumer.surfaceId === decoded.header.surfaceId)
          consumer.sendFrame(frame, decoded.header);
      }
      return false;
    }
    if (frame.byteLength > maxBrowserTextBytes) {
      throw new Error("Browser Runtime sent an oversized text frame.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.toString("utf8"));
    } catch (error) {
      throw new Error("Browser Runtime sent invalid JSON.", { cause: error });
    }
    if (
      !this.sharedControl &&
      typeof decoded === "object" &&
      decoded !== null &&
      "type" in decoded &&
      (decoded.type === "browser.snapshot" || decoded.type === "browser.dialog.changed") &&
      "dialog" in decoded &&
      decoded.dialog !== null
    ) {
      decoded = {
        ...decoded,
        dialog: { ...olderBrowserDialogSchema.parse(decoded.dialog), id: randomUUID() },
      };
    }
    let message: BrowserServerMessage | BrowserRuntimeServerMessage =
      BrowserRuntimeServerMessageSchema.parse(decoded);
    if (message.type === "passkey.ceremony" || message.type === "passkey.cancel") {
      if (!this.#passkeys || !this.#runtimeReady)
        throw new Error("Browser passkeys were not negotiated.");
      if (message.type === "passkey.ceremony") {
        const surfaceId = message.surfaceId;
        if (!this.#surfaces.some((surface) => surface.id === surfaceId))
          throw new Error("Unknown passkey surface.");
        this.#passkeys.ceremony(message);
      } else this.#passkeys.cancel(message.ceremonyId);
      return false;
    }
    if (
      message.type === "browser.passkey.request" ||
      message.type === "browser.passkey.offer" ||
      message.type === "browser.passkey.withdrawn" ||
      message.type === "browser.passkey.notice"
    )
      throw new Error("Runtime cannot send viewer passkey messages.");
    if (!this.#snapshot && message.type === "browser.error") {
      throw agentProtocolError(message.error);
    }
    if (!this.#snapshot && message.type !== "browser.snapshot") {
      throw new Error("Browser Runtime sent an event before its snapshot.");
    }
    if (message.type === "agent.event") {
      this.#actionListeners.get(message.attachmentId)?.(message.event);
      return false;
    }
    if (message.type === "agent.result" || message.type === "agent.error") {
      const pending = this.#pendingActions.get(message.requestId);
      if (!pending || pending.attachmentId !== message.attachmentId) return false;
      clearTimeout(pending.timeout);
      this.#pendingActions.delete(message.requestId);
      if (message.type === "agent.error")
        pending.reject(
          new OpensteerError({
            code: "conflict",
            reason: message.error.code,
            message: message.error.message,
            ...(message.error.dialog ? { details: { dialog: message.error.dialog } } : {}),
          }),
        );
      else if (message.result.type !== pending.action)
        pending.reject(
          browserActionFailure("outcome-unknown", "The browser answered a different action."),
        );
      else pending.resolve(message.result);
      return false;
    }
    if (isCdpResponse(message)) {
      this.#handleCdpResponse(message);
      return false;
    }
    if (message.type === "navigation.committed") {
      this.#recordHistoryCommit(message);
      return false;
    }
    if (message.type === "browser.activity") {
      this.#onActivity(message);
      return false;
    }
    if (message.type === "cdp.event") {
      for (const listener of this.#cdpListeners) listener(message.event);
      return false;
    }
    if (
      message.type === "signin.probe.result" ||
      message.type === "login.needs" ||
      message.type === "login.ended" ||
      message.type === "login.result"
    )
      return false;
    if (message.type === "state.import.result") {
      const pending = this.#pendingStateImports.get(message.operationId);
      if (!pending) return false;
      clearTimeout(pending.timeout);
      this.#pendingStateImports.delete(message.operationId);
      if (message.error) pending.reject(agentProtocolError(message.error));
      else pending.resolve();
      return false;
    }
    if (message.type === "browser.tab.icon") {
      if (createHash("sha256").update(message.favicon).digest("base64url") !== message.key)
        throw new Error("Browser icon key mismatch.");
      const bytes = Buffer.byteLength(message.favicon);
      if (!this.#icons.has(message.key) && this.#iconBytes + bytes <= 16 * 1024 * 1024) {
        this.#icons.set(message.key, {
          favicon: message.favicon,
          ref: pageIconRef(this.#groupId, message.favicon),
        });
        this.#iconBytes += bytes;
      }
      return false;
    }
    if (message.type === "browser.snapshot") {
      if (this.#snapshot) throw new Error("Browser Runtime sent a duplicate snapshot.");
      if (message.sessionId !== this.#sessionId) throw new Error("Browser session ID mismatch.");
      if (message.access !== "read-write") throw new Error("Browser access negotiation failed.");
      if (message.targetedStreamingVersion !== 1)
        throw new Error("Browser Runtime requires targeted streaming version 1.");
      if (
        message.editingVersion !== undefined &&
        (message.editingVersion !== this.editing ||
          (message.editingVersion === 2 && message.clipboard !== this.clipboard))
      )
        throw new Error("Browser editing was not negotiated by this Host.");
      if (
        (message.basicInput !== undefined && message.basicInput !== this.basicInput) ||
        (message.surfaceState !== undefined && message.surfaceState !== this.surfaceState)
      )
        throw new Error("Browser basic input or surface state was not negotiated.");
      this.#snapshot = message;
      if (message.dialog) this.#dialogs.set(message.dialog.surfaceId, message.dialog);
      return false;
    }
    if (message.type === "browser.tabs") {
      if (frame.byteLength > keyedStreamHardCapBytes)
        throw new Error("Browser tab frame exceeds the hard byte cap.");
      const withoutUnknownIcon = <T extends { icon?: string | null | undefined }>(row: T): T =>
        row.icon && !this.#icons.has(row.icon) ? { ...row, icon: null } : row;
      const stream =
        message.stream.op === "rows"
          ? { ...message.stream, rows: message.stream.rows.map(withoutUnknownIcon) }
          : message.stream.op === "change"
            ? {
                ...message.stream,
                ...(message.stream.add ? { add: message.stream.add.map(withoutUnknownIcon) } : {}),
                ...(message.stream.update
                  ? { update: message.stream.update.map(withoutUnknownIcon) }
                  : {}),
              }
            : message.stream;
      const previousPage = this.page;
      const previousActive = this.#tabs.meta?.activeId ?? null;
      let changed:
        { added: string[]; updated: string[]; removed: string[]; structural: boolean } | undefined;
      const unsubscribe = this.#tabs.onChange((value) => {
        changed = value;
      });
      const result = this.#tabs.apply(stream);
      unsubscribe();
      if (result === "resync") {
        await this.#sendCommand({ type: "tabs.resync" });
        return false;
      }
      if (result !== "applied" || !changed) return false;
      const changes = changed;
      for (const id of [...changes.added, ...changes.updated]) {
        const row = this.#tabs.rows.get(id)!;
        const previous = this.#surfaces.find((surface) => surface.id === id);
        if (previous && previous.documentId !== row.documentId)
          this.#passkeys?.documentChanged(row.id);
        if (previous?.state !== row.state) this.#tabStateRevision++;
        const icon = row.icon ? this.#icons.get(row.icon) : undefined;
        const restored = this.#restoredIcons.get(row.id);
        const favicon =
          icon?.favicon ??
          (restored?.url === row.url || row.url === "about:blank" ? restored?.favicon : null) ??
          null;
        if (icon || (restored && row.url !== restored.url && row.url !== "about:blank"))
          this.#restoredIcons.delete(row.id);
        if (
          (this.#restoreTabs || row.creatorAttachmentId !== undefined) &&
          (!previous ||
            previous.title !== row.title ||
            previous.url !== row.url ||
            previous.order !== row.order ||
            previous.openerId !== row.openerId ||
            row.creatorAttachmentId !== undefined ||
            (previous.favicon ?? null) !== favicon)
        )
          this.#dirtyTabs.set(id, {
            id: row.id,
            title: row.title,
            url: row.url,
            order: row.order,
            openerId: row.openerId,
            ...(row.creatorAttachmentId ? { creatorAttachmentId: row.creatorAttachmentId } : {}),
            favicon,
          });
      }
      for (const id of changes.removed) {
        const tabId = BrowserSurfaceIdSchema.parse(id);
        this.#personUse.tabs.delete(tabId);
        this.#pendingPersonUse.delete(tabId);
        this.#passkeys?.documentChanged(tabId);
        this.#editingContexts.delete(tabId);
        this.#dialogs.delete(tabId);
        this.#tabStateRevision++;
        if (this.#restoreTabs && stream.op === "change") {
          this.#dirtyTabs.delete(id);
          this.#closedTabs.add(tabId);
        }
      }
      const active = this.#tabs.meta?.activeId ?? null;
      if (!this.#runtimeReady) {
        const saved = new Set(this.#savedTabIds);
        for (const id of this.#personUse.tabs)
          if (!this.#tabs.rows.has(id) && !saved.has(id)) {
            this.#personUse.tabs.delete(id);
            this.#pendingPersonUse.delete(id);
          }
      }
      this.#onPersonUseChanged();
      this.#surfaces = [...this.#tabs.rows.values()].map((row) => {
        const { icon, creatorAttachmentId: _creator, ...surface } = row;
        return {
          ...surface,
          active: row.id === active,
          ...(icon && this.#icons.has(icon) ? { favicon: this.#icons.get(icon)!.favicon } : {}),
        };
      });
      assertBrowserDialogSurface(this.#snapshot?.dialog ?? null, this.#surfaces);
      this.#reconcileHistory(this.#surfaces);
      // A broker being stopped or detached never makes its row ready again: Stop or detach already
      // took it (X6).
      let becameReady = false;
      if (!this.#runtimeReady && !this.#stopping && !this.#detaching) {
        let readyConfirmed = true;
        if (!this.#reconnecting) {
          if (!this.#adoptedFromPool) await this.#sendSavedTabs();
          const updated = await this.#onState("ready");
          readyConfirmed = updated?.state === "ready";
        }
        if (readyConfirmed && !this.#stopping && !this.#detaching) {
          becameReady = true;
          this.#reconnecting = false;
          this.#runtimeReady = true;
          // #onState("ready") transitions the session and may schedule a deferred
          // refreshSessionState() timer with a pool hold; flush it now so no stale
          // 50 ms hold outlives the initial session.state send.
          if (this.#sessionStateTimer) clearTimeout(this.#sessionStateTimer);
          this.#sessionStateTimer = undefined;
          const hold = this.#sessionStateHold;
          this.#sessionStateHold = undefined;
          try {
            await this.#sendSessionState();
          } finally {
            hold?.release();
          }
          const reconnectReady = this.#reconnectReady;
          this.#reconnectReady = null;
          reconnectReady?.resolve();
        }
      }
      this.#onRecordsChanged([...changes.added, ...changes.updated, ...changes.removed]);
      this.#onTabsChanged(
        changes.added.length > 0 || changes.removed.length > 0 || changes.structural,
      );
      const page = this.page;
      if (previousPage?.title !== page?.title || previousPage?.url !== page?.url)
        this.#noticePage();
      void this.#reconcileStreaming().catch(() => undefined);
      for (const [id, frame] of this.#latestFrames)
        if (
          this.#tabs.rows.get(id)?.geometryRevision !== frame.header.geometryRevision ||
          this.#tabs.rows.get(id)?.documentId !== frame.documentId
        ) {
          this.#latestFrames.delete(id);
          this.#frameIds.delete(id);
        }
      const changedIds = new Set([...changes.added, ...changes.updated, ...changes.removed]);
      for (const consumer of this.#consumers.values()) {
        consumer.dropPendingOutside(consumer.surfaceId);
        if (consumer.surfaceId && changedIds.has(consumer.surfaceId))
          this.#sendViewerSurface(consumer);
      }
      if (
        !becameReady &&
        (previousActive !== active ||
          changes.removed.length ||
          changes.added.some((id) => this.#pendingPersonUse.has(BrowserSurfaceIdSchema.parse(id))))
      )
        this.refreshSessionState();
      return stream.op === "end" && this.#runtimeReady && !this.#stopping && !this.#detaching;
    } else if (message.type === "browser.dialog.changed") {
      if (!this.#snapshot) throw new Error("Browser Runtime snapshot is unavailable.");
      assertBrowserDialogSurface(message.dialog, this.#surfaces);
      const dialogSurface = message.dialog?.surfaceId ?? message.surfaceId;
      if (dialogSurface) {
        if (message.dialog) this.#dialogs.set(dialogSurface, message.dialog);
        else this.#dialogs.delete(dialogSurface);
      }
      if (
        !message.surfaceId ||
        message.surfaceId === this.#surfaces.find((surface) => surface.active)?.id
      )
        this.#snapshot = { ...this.#snapshot, dialog: message.dialog };
    } else if (message.type === "browser.status") {
      if (!this.#snapshot) throw new Error("Browser Runtime snapshot is unavailable.");
      // Only `closed` ends a pooled session's row; `closing` is not that (P16).
      if (message.state === "closing") this.#runtimeClosing = true;
      if (message.state === "closed") this.#runtimeEnded = true;
      if (message.state === "closing") {
        this.#runtimeReady = false;
        this.#latestFrames.clear();
        // A pooled session the runtime ends on its own, not on a Stop, is not the person's
        // closing: its row stays as it is, and its end is a loss with its note.
        if (!this.#poolAdmission || this.#stopping) await this.#onState("closing");
      }
      if (message.state === "closed") this.#runtimeReady = false;
    }

    if (message.type === "browser.editing") this.#editingContexts.set(message.surfaceId, message);
    for (const consumer of this.#consumers.values()) {
      // A person's autofill and save offers reach only the viewer they name,
      // and save offers only one that negotiated them.
      if (
        (message.type.startsWith("browser.autofill.") ||
          message.type.startsWith("browser.passwordSave.")) &&
        (Math.min(this.#snapshot?.personFillVersion ?? 0, consumer.autofill) <
          (message.type.startsWith("browser.passwordSave.") ? 2 : 1) ||
          consumer.mode !== "control" ||
          !("consumerToken" in message) ||
          message.consumerToken !== consumer.clipboardToken)
      )
        continue;
      if (
        message.type === "browser.cursor" &&
        (consumer.mode !== "control" ||
          consumer.clipboardToken !== message.consumerToken ||
          message.surfaceId !== consumer.surfaceId)
      )
        continue;
      if (
        message.type === "browser.error" &&
        message.producerId &&
        message.producerId !== consumer.clipboardToken
      )
        continue;
      if (
        message.type === "browser.popup.opened" &&
        (!consumer.popups || message.consumerToken !== consumer.clipboardToken)
      )
        continue;
      if (
        message.type === "clipboard.result" &&
        message.consumerToken === consumer.clipboardToken
      ) {
        consumer.clipboardOperations.delete(message.operationId);
        if (consumer.failedClipboardOperations.delete(message.operationId)) continue;
        consumer.recordEditing(`clipboard.${message.outcome}`);
      }
      if (message.type === "clipboard.written" && message.consumerToken === consumer.clipboardToken)
        consumer.recordEditing("clipboard.written");
      if (
        !consumer.clipboard &&
        !consumer.basicInput &&
        consumer.mode === "control" &&
        "consumerToken" in message &&
        message.consumerToken === consumer.clipboardToken
      ) {
        const projected = consumer.legacyClipboard.read(message);
        if (projected && consumer.surfaceId === projected.surfaceId)
          void consumer.sendText(JSON.stringify(projected)).catch(() => undefined);
      }
      if (
        !consumer.clipboard &&
        !consumer.basicInput &&
        (message.type === "clipboard.result" ||
          message.type === "clipboard.written" ||
          message.type === "clipboard.part")
      )
        continue;
      if (!consumer.editing && !consumer.basicInput && editingServerKinds.has(message.type))
        continue;
      if (consumer.mode === "watch" && message.type.startsWith("clipboard.")) continue;
      if (
        (message.type === "clipboard.result" ||
          message.type === "clipboard.written" ||
          message.type === "clipboard.part" ||
          message.type === "browser.contextmenu") &&
        (!message.consumerToken || message.consumerToken !== consumer.clipboardToken)
      )
        continue;
      if (consumer.basicInput) {
        if (message.type === "clipboard.written") continue;
        if (message.type === "clipboard.result") {
          if (
            message.outcome === "cut" ||
            (message.items &&
              (message.items.length !== 1 ||
                message.items.some(
                  (item) => item.type !== "text/plain" || item.name !== undefined,
                )))
          )
            continue;
          if (message.items) {
            if (consumer.basicClipboardResults.size >= 32)
              consumer.basicClipboardResults.delete(
                consumer.basicClipboardResults.keys().next().value!,
              );
            consumer.basicClipboardResults.set(message.operationId, {
              next: 0,
              total: editingClipboardPartCount(message.items),
            });
          }
        }
        if (message.type === "clipboard.part") {
          const permit = consumer.basicClipboardResults.get(message.part.operationId);
          if (!permit || message.part.index !== permit.next) continue;
          if (++permit.next === permit.total)
            consumer.basicClipboardResults.delete(message.part.operationId);
        }
      }
      // A viewer names the surface it shows only by subscribing; until then a
      // targeted viewer would take the active surface's editing for its own.
      if (
        message.type === "browser.editing" &&
        (consumer.subscription === null || message.surfaceId !== consumer.surfaceId)
      )
        continue;
      if (
        message.type === "clipboard.data" &&
        message.consumerToken &&
        consumer.clipboardToken !== message.consumerToken
      )
        continue;
      if (message.type === "clipboard.data" && !message.consumerToken) continue;
      if (
        (message.type === "browser.dialog.changed" || message.type === "clipboard.data") &&
        (message.surfaceId ??
          (message.type === "browser.dialog.changed" ? message.dialog?.surfaceId : null)) !==
          consumer.surfaceId
      )
        continue;
      void consumer
        .sendText(
          JSON.stringify(
            browserViewerMessage(
              message,
              consumer.editing,
              consumer.passkeys,
              consumer.clipboardToken,
              consumer.popups,
              {
                basicInput: consumer.basicInput,
                surfaceState: consumer.surfaceState,
                autofill: consumer.autofill,
              },
            ),
          ),
        )
        .catch(() => undefined);
    }
    if (message.type === "browser.status" && message.state === "closed") {
      // A pooled session the runtime ended on its own (its browser went, or its host was
      // retired), not on a Stop: the person did not end it, so its row is not closed here. It is
      // a loss, the pool's to record with its notes when its window ends.
      if (this.#poolAdmission && !this.#stopping) {
        const documents = new Map(
          [...this.#tabs.rows].map(([surfaceId, row]) => [surfaceId, row.documentId]),
        );
        queueMicrotask(() => this.#onChannelLost?.(documents));
        if (this.#socket.readyState === WebSocket.OPEN)
          this.#socket.close(1000, "Browser Runtime closed session");
        await this.#finish("pooled", 1011, "Browser Runtime disconnected");
        return false;
      }
      if (message.reason === "retired") this.#stopping = true;
      if (this.#socket.readyState === WebSocket.OPEN) {
        this.#socket.close(1000, "Browser Runtime closed session");
      }
      await this.#finish(
        "closed",
        this.#stopping ? 1000 : 1011,
        this.#stopping ? "Browser session closed" : "Browser Runtime disconnected",
      );
    }
    return false;
  }

  #handleCdpResponse(message: BrowserCdpWireResponse): void {
    const pending = this.#pendingCdpRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.removeAbort();
    this.#pendingCdpRequests.delete(message.requestId);
    if (message.type === "cdp.error") {
      if (pending.submitted) pending.acknowledge?.();
      const cause = agentProtocolError(message.error);
      if (pending.bounded) {
        const words = {
          bad_message: "The browser rejected the CDP command or its parameters.",
          conflict:
            cause.reason === "browser-command-cancelled"
              ? "The browser command was cancelled before dispatch."
              : "The browser could not complete the command in its current state.",
          forbidden: "This CDP operation is outside the browser attachment's authority.",
          internal: "The browser command failed.",
          not_found: "The browser target or CDP session no longer exists.",
        };
        if (message.error.code === "internal")
          console.error("browser.script.command.failed", cause);
        pending.reject(
          new BrowserCdpRefusal(
            new OpensteerError({
              code: cause.code,
              message: words[message.error.code],
              retryable: cause.retryable,
              ...(cause.reason === "browser-reply-limit" ||
              cause.reason === "browser-command-cancelled" ||
              cause.reason === "browser-input-canceled" ||
              cause.reason === "browser-tab-open-closed"
                ? { reason: cause.reason }
                : {}),
            }),
          ),
        );
      } else pending.reject(new BrowserCdpRefusal(cause));
      return;
    }
    if (message.type !== pending.expectedType) {
      pending.reject(new Error("Browser Runtime returned the wrong correlated CDP response."));
      throw new Error("Browser Runtime returned the wrong correlated CDP response.");
    }
    if (pending.submitted) pending.acknowledge?.();
    pending.resolve(message);
  }

  #sendViewerSurface(outlet: BrowserConsumerOutlet): void {
    if (!outlet.surfaceId || outlet.subscription === null) return;
    const row = this.#tabs.rows.get(outlet.surfaceId);
    if (!row) {
      outlet.sendSurface(outlet.surfaceId, null);
      return;
    }
    const {
      icon: _icon,
      order: _order,
      openerId: _opener,
      creatorAttachmentId: _creator,
      ...surface
    } = row;
    const icon = this.#surfaceIcon(row);
    outlet.sendSurface(
      row.id,
      { ...surface, favicon: null },
      icon
        ? {
            key: row.icon ?? createHash("sha256").update(icon.favicon).digest("base64url"),
            favicon: icon.favicon,
          }
        : null,
    );
  }

  async #handleConsumerFrame(
    outlet: BrowserConsumerOutlet,
    frame: Buffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      return Promise.reject(
        new OpensteerError({
          code: "bad_request",
          message: "Binary browser commands are not accepted.",
        }),
      );
    }
    if (frame.byteLength > maxBrowserCommandBytes) {
      return Promise.reject(
        new OpensteerError({ code: "bad_request", message: "Browser command is too large." }),
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.toString("utf8"));
    } catch (error) {
      return Promise.reject(
        new OpensteerError({
          code: "bad_request",
          message: "Browser command is invalid JSON.",
          cause: error,
        }),
      );
    }
    let message: BrowserClientMessage;
    try {
      message = BrowserClientMessageSchema.parse(decoded);
    } catch (error) {
      if (outlet.clipboard && outlet.mode === "control") {
        const paste = z
          .object({
            type: z.literal("clipboard.paste-data"),
            surfaceId: BrowserSurfaceIdSchema,
            operationId: z.uuid(),
          })
          .safeParse(decoded);
        const part = z
          .object({ type: z.literal("clipboard.part"), part: z.object({ operationId: z.uuid() }) })
          .safeParse(decoded);
        const pending = part.success
          ? outlet.clipboardOperations.get(part.data.part.operationId)
          : undefined;
        const operationId = paste.success
          ? paste.data.operationId
          : part.success
            ? part.data.part.operationId
            : undefined;
        const surfaceId = paste.success ? paste.data.surfaceId : pending;
        if (operationId && surfaceId) {
          if (outlet.failedClipboardOperations.has(operationId)) return Promise.resolve();
          if (outlet.clipboardOperations.has(operationId))
            outlet.failedClipboardOperations.add(operationId);
          outlet.editingCounters["clipboard.too-large"] =
            (outlet.editingCounters["clipboard.too-large"] ?? 0) + 1;
          return outlet.sendText(
            JSON.stringify({
              type: "clipboard.result",
              surfaceId,
              operationId,
              outcome: "too-large",
            }),
          );
        }
      }
      return Promise.reject(
        new OpensteerError({
          code: "bad_request",
          message: "Browser command is invalid.",
          cause: error,
        }),
      );
    }
    const requestedSurface =
      message.type === "stream.unsubscribe"
        ? null
        : "surfaceId" in message && typeof message.surfaceId === "string"
          ? message.surfaceId
          : outlet.surfaceId;
    if (this.#personTabGeneration && requestedSurface) {
      const generation = await this.#personTabGeneration(
        BrowserSurfaceIdSchema.parse(requestedSurface),
      );
      if (
        generation === null ||
        (outlet.surfaceId === requestedSurface &&
          outlet.tabGeneration !== null &&
          outlet.tabGeneration !== generation)
      )
        throw new OpensteerError({
          code: "not_found",
          message: "This tab has closed or its viewer was replaced.",
        });
      if (message.type === "stream.subscribe") outlet.tabGeneration = generation;
    }
    if (
      message.type === "passkey.claim" ||
      message.type === "passkey.respond" ||
      (message.type === "passkey.cancel" && "requestId" in message)
    ) {
      if (!outlet.passkeys || outlet.mode !== "control")
        return Promise.reject(new Error("Browser passkeys were not negotiated."));
      return this.#passkeys?.viewer(outlet.clipboardToken, message) ?? Promise.resolve();
    }
    if (message.type === "passkey.result" || message.type === "passkey.cancel")
      return Promise.reject(new Error("Viewer cannot answer a runtime ceremony."));
    if (message.type === "autofill.fill" || message.type === "passwordSave.answer") {
      const needed = message.type === "passwordSave.answer" ? 2 : 1;
      if (
        outlet.mode !== "control" ||
        Math.min(this.#snapshot?.personFillVersion ?? 0, outlet.autofill) < needed
      )
        return Promise.reject(new Error("Browser autofill was not negotiated."));
    }
    outlet.recordEditing(message.type);
    if (
      message.type === "clipboard.part" &&
      outlet.failedClipboardOperations.has(message.part.operationId)
    )
      return Promise.resolve();
    if ("consumerToken" in message) {
      const { consumerToken: _consumerToken, ...input } = message;
      message = input;
    }
    if (
      !outlet.editing &&
      !outlet.basicInput &&
      (editingClientKinds.has(message.type) ||
        (message.type === "input.key" &&
          (message.modifiers.includes("primary") ||
            message.location !== undefined ||
            message.repeat !== undefined)))
    )
      return Promise.reject(
        new OpensteerError({ code: "forbidden", message: "Browser editing was not negotiated." }),
      );
    if (
      !outlet.clipboard &&
      !outlet.basicInput &&
      (message.type === "clipboard.copy" ||
        message.type === "clipboard.cut" ||
        message.type === "clipboard.paste-data" ||
        message.type === "clipboard.part")
    )
      return Promise.reject(
        new OpensteerError({
          code: "forbidden",
          message: "The engine clipboard was not negotiated.",
        }),
      );
    if (
      outlet.basicInput &&
      (!browserBasicInputAllows(message) ||
        (message.type === "clipboard.part" &&
          !outlet.clipboardOperations.has(message.part.operationId)))
    )
      return outlet.sendText(
        JSON.stringify({
          type: "browser.error",
          error: {
            code: "conflict",
            reason: "unsupported-operation",
            message:
              "Basic input supports only text, backward deletion, Enter, select-all, composition and plain-text copy/paste.",
            retryable: false,
          },
        }),
      );
    if (message.type === "stream.subscribe" || message.type === "stream.unsubscribe") {
      const subscription =
        message.type === "stream.subscribe"
          ? message.frames === false
            ? "control"
            : "frames"
          : null;
      const surfaceId = message.type === "stream.subscribe" ? (message.surfaceId ?? null) : null;
      if (subscription !== null && !surfaceId)
        return Promise.reject(
          new OpensteerError({
            code: "bad_request",
            message: "A viewer subscription requires a surface.",
          }),
        );
      if (subscription === "control" && outlet.mode !== "control")
        return Promise.reject(
          new OpensteerError({
            code: "forbidden",
            message: "Only control viewers may observe a target without pictures.",
          }),
        );
      if (subscription === "control" && !this.targetControl) {
        const error = {
          code: "conflict" as const,
          reason: "browser-target-control-unsupported",
          message: "Update the browser computer for control-only target subscriptions.",
          retryable: false,
        };
        return outlet.sendText(JSON.stringify({ type: "browser.error", error })).then(() => {
          throw new OpensteerError(error);
        });
      }
      if (surfaceId && !this.#surfaces.some((surface) => surface.id === surfaceId))
        return Promise.reject(
          new OpensteerError({ code: "not_found", message: "Browser tab not found." }),
        );
      const frameWindow =
        message.type === "stream.subscribe" && !!surfaceId && message.frameWindow === 1;
      const captureRegion = message.type === "stream.subscribe" && message.captureRegion === true;
      if (
        outlet.subscription === subscription &&
        outlet.surfaceId === surfaceId &&
        outlet.captureRegion === captureRegion &&
        outlet.frameWindow === frameWindow
      )
        return Promise.resolve();
      // A viewer's queued input is cancelled when it stops showing its tab (another tab, or none;
      // a closed socket cancels too). A change of picture options on the same tab changes the
      // meaning of nothing queued: keys carry no picture coordinates, a pointer or wheel event
      // names its capture and geometry revisions and the runtime refuses it when they moved, and
      // `frames`, `frameWindow` and `captureRegion` only choose and pace this viewer's pictures.
      if (
        outlet.mode === "control" &&
        outlet.subscription !== null &&
        outlet.surfaceId !== surfaceId &&
        this.#snapshot?.inputLanesVersion === 1
      )
        void this.#sendCommand({
          type: "input.cancel",
          producerId: outlet.clipboardToken,
          inputGeneration: outlet.inputGeneration++,
        }).catch(() => undefined);
      const previous = {
        subscription: outlet.subscription,
        surfaceId: outlet.surfaceId,
        captureRegion: outlet.captureRegion,
        frameWindow: outlet.frameWindow,
        rasterDensity: outlet.rasterDensity,
      };
      if (outlet.surfaceId !== surfaceId || outlet.subscription === null) outlet.rasterDensity = 2;
      outlet.surfaceId = surfaceId;
      outlet.subscription = subscription;
      this.refreshSessionState();
      // A pooled runtime may just have been adopted: the viewer's protection reaches it before
      // the subscription does, so no frame passes ahead of it.
      if (this.#poolAdmission) await this.#flushSessionState();
      this.#passkeys?.refresh();
      // Editing reaches a viewer only once it names what it shows, so each
      // subscription starts from that surface's current field.
      const shown =
        subscription === null
          ? undefined
          : this.#surfaces.find((surface) => surface.id === surfaceId);
      const context = shown && this.#editingContexts.get(shown.id);
      if (
        (outlet.editing || outlet.basicInput) &&
        context &&
        context.geometryRevision === shown.geometryRevision
      )
        void outlet.sendText(JSON.stringify(context)).catch(() => undefined);
      outlet.frameWindow = frameWindow;
      outlet.captureRegion = captureRegion;
      outlet.resetSubscription();
      outlet.subscription = subscription;
      this.#sendViewerSurface(outlet);
      // Already streaming for someone else: this viewer starts from the
      // current picture rather than a blank until the page next paints.
      const latest = surfaceId ? this.#latestFrames.get(surfaceId) : undefined;
      if (subscription === "frames" && latest) outlet.sendFrame(latest.frame, latest.header);
      if (subscription !== null && surfaceId) {
        const dialog = this.#dialogs.get(surfaceId) ?? null;
        void outlet
          .sendText(JSON.stringify({ type: "browser.dialog.changed", surfaceId, dialog }))
          .catch(() => undefined);
      }
      return this.#reconcileStreaming().catch((error: unknown) => {
        if (outlet.subscription === subscription && outlet.surfaceId === surfaceId) {
          outlet.resetSubscription();
          outlet.subscription = previous.subscription;
          outlet.captureRegion = previous.captureRegion;
          outlet.frameWindow = previous.frameWindow;
          outlet.rasterDensity = previous.rasterDensity;
          outlet.surfaceId = previous.surfaceId;
          this.refreshSessionState();
        }
        throw error;
      });
    }
    if (message.type === "stream.demand") {
      if (outlet.subscription !== "frames" || outlet.surfaceId !== message.surfaceId)
        return Promise.reject(
          new OpensteerError({
            code: "conflict",
            message: "Raster demand must name this viewer's picture.",
          }),
        );
      if (outlet.rasterDensity === message.density) return Promise.resolve();
      outlet.rasterDensity = message.density;
      return this.#reconcileStreaming();
    }
    if (message.type === "stream.ack")
      return message.surfaceId && message.surfaceId !== outlet.surfaceId
        ? Promise.resolve()
        : outlet.acknowledge(message.token);
    if (outlet.mode === "watch") {
      return Promise.reject(
        new OpensteerError({
          code: "forbidden",
          message: "Watch can only manage its picture subscription and receipts.",
        }),
      );
    }
    if (!consumerMessageTypes.has(message.type)) {
      return Promise.reject(
        new OpensteerError({
          code: "forbidden",
          message: "This browser command is reserved for the Host.",
        }),
      );
    }
    if (outlet.surfaceId !== null) {
      if (message.type === "surface.activate") return Promise.resolve();
      if (message.type === "surface.close")
        return Promise.reject(
          new OpensteerError({
            code: "forbidden",
            message: "Close the tab through browser.tab.close.",
          }),
        );
      if ("surfaceId" in message && message.surfaceId && message.surfaceId !== outlet.surfaceId)
        return Promise.reject(
          new OpensteerError({ code: "forbidden", message: "The command addresses another tab." }),
        );
      if (
        [
          "navigation.go",
          "navigation.back",
          "navigation.forward",
          "navigation.reload",
          "navigation.stop",
          "dialog.respond",
        ].includes(message.type) &&
        (!("surfaceId" in message) || !message.surfaceId)
      )
        return Promise.reject(
          new OpensteerError({
            code: "bad_request",
            message: "A targeted command requires a surface.",
          }),
        );
    }
    const addressedSurface =
      "surfaceId" in message && message.surfaceId ? message.surfaceId : outlet.surfaceId;
    if (
      addressedSurface &&
      message.type !== "input.cancel" &&
      this.#surfaces.some(
        (surface) => surface.id === addressedSurface && surface.state === "suspended",
      )
    )
      return outlet.sendText(
        JSON.stringify({
          type: "browser.error",
          error: {
            code: "conflict",
            reason: "target-suspended",
            message: "The tab is suspended.",
            retryable: false,
          },
        }),
      );
    if (
      !outlet.clipboard &&
      this.clipboard &&
      this.#snapshot?.editingVersion !== undefined &&
      message.type === "input.key"
    ) {
      if (message.action === "up" && outlet.legacyClipboardKeys.delete(message.code))
        return Promise.resolve();
      const key = message.key.toLowerCase();
      if (
        message.action === "down" &&
        (key === "c" || key === "x") &&
        (message.modifiers.includes("meta") || message.modifiers.includes("control")) &&
        !message.modifiers.includes("alt") &&
        !message.modifiers.includes("shift")
      ) {
        if (outlet.legacyClipboardKeys.size >= 128 && !outlet.legacyClipboardKeys.has(message.code))
          return outlet.sendText(
            JSON.stringify({
              type: "browser.error",
              error: {
                code: "conflict",
                reason: "browser-input-overload",
                retryable: false,
                message: "Browser input was not applied. Try the action again.",
              },
            }),
          );
        outlet.legacyClipboardKeys.add(message.code);
        message = {
          type: key === "c" ? "clipboard.copy" : "clipboard.cut",
          surfaceId: message.surfaceId,
          operationId: outlet.legacyClipboard.begin(
            message.surfaceId,
            key === "c" ? "copied" : "cut",
          ),
          inputGeneration: message.inputGeneration,
        };
      }
    }
    if (
      message.type === "input.key" ||
      message.type === "clipboard.paste" ||
      message.type === "input.command" ||
      message.type === "input.compose" ||
      message.type === "input.text" ||
      message.type === "clipboard.copy" ||
      message.type === "clipboard.cut" ||
      message.type === "clipboard.paste-data" ||
      message.type === "input.pointer" ||
      message.type === "input.wheel"
    )
      message = { ...message, targeted: true };
    if (message.type === "input.cancel" && this.#snapshot?.inputLanesVersion !== 1)
      return Promise.resolve();
    // A consumer can advance only its own generation, never choose its identity.
    if (
      message.inputGeneration !== undefined &&
      message.inputGeneration === outlet.inputGeneration + 1
    )
      outlet.inputGeneration = message.inputGeneration;
    // Never trust a producer identity supplied by the consumer.
    message = {
      ...message,
      producerId: outlet.clipboardToken,
      inputGeneration: outlet.inputGeneration,
      inputSequence: ++outlet.inputSequence,
      inputSequenceStart: undefined,
    };
    if (message.type === "input.cancel") outlet.inputGeneration++;
    if (message.type === "clipboard.paste-data") {
      if (outlet.clipboardOperations.size >= 32)
        return outlet.sendText(
          JSON.stringify({
            type: "clipboard.result",
            surfaceId: message.surfaceId,
            operationId: message.operationId,
            outcome: "too-large",
          }),
        );
      outlet.clipboardOperations.set(message.operationId, message.surfaceId);
    }
    let navigationId: string | undefined;
    if (message.type === "navigation.go") {
      // Consumers cannot choose an attribution id, even if they know another viewer's id.
      navigationId = outlet.userId
        ? this.beginHistoryNavigation(
            outlet.userId,
            message.typed === true,
            BrowserSurfaceIdSchema.optional().parse(
              message.surfaceId ?? outlet.surfaceId ?? undefined,
            ),
          )
        : undefined;
      message = { ...message, navigationId };
    }
    return this.#sendCommand(
      message.type === "input.key" ||
        ((this.#snapshot?.editingVersion !== undefined || outlet.editing || outlet.basicInput) &&
          (message.type === "input.pointer" ||
            message.type === "input.command" ||
            message.type === "clipboard.copy" ||
            message.type === "clipboard.cut" ||
            message.type === "clipboard.paste-data"))
        ? { ...message, consumerToken: outlet.clipboardToken }
        : message,
    ).catch((error: unknown) => {
      if (navigationId) this.#historyNavigations.delete(navigationId);
      throw error;
    });
  }

  #reconcileStreaming(): Promise<void> {
    const operation = this.#streamReconcileTail.then(async () => {
      if (this.#settled) return;
      const surfaces = new Set<string>(this.#surfaces.map((surface) => surface.id));
      const targets = new Set(
        [...this.#consumers.values()].flatMap((consumer) =>
          consumer.subscription === "frames" &&
          consumer.surfaceId &&
          surfaces.has(consumer.surfaceId)
            ? [consumer.surfaceId]
            : [],
        ),
      );
      const admitted = new Set([...targets].slice(0, browserCaptureMaxTargets));
      // Picture demand wins for a shared surface; observation consumes no capture slot.
      const wanted = new Map([...admitted].map((target) => [target, true]));
      for (const consumer of this.#consumers.values())
        if (
          consumer.subscription === "control" &&
          consumer.surfaceId &&
          surfaces.has(consumer.surfaceId) &&
          !wanted.has(consumer.surfaceId)
        )
          wanted.set(consumer.surfaceId, false);
      for (const target of this.#runtimeTargets.keys())
        if (!wanted.has(target)) {
          await this.#sendCommand({
            type: "stream.unsubscribe",
            surfaceId: BrowserSurfaceIdSchema.parse(target),
          });
          this.#runtimeTargets.delete(target);
          const raster = this.#runtimeRaster.get(target);
          if (raster?.timer) clearTimeout(raster.timer);
          this.#runtimeRaster.delete(target);
        }
      for (const [target, frames] of wanted)
        if (this.#runtimeTargets.get(target) !== frames) {
          await this.#sendCommand({
            type: "stream.subscribe",
            surfaceId: BrowserSurfaceIdSchema.parse(target),
            ...(frames ? {} : { frames: false }),
            ...(this.captureRegion ? { captureRegion: true } : {}),
          });
          this.#runtimeTargets.set(target, frames);
        }
      if (this.rasterDemand) {
        for (const [target, frames] of wanted) {
          let raster = this.#runtimeRaster.get(target);
          if (!raster) {
            raster = { density: 2, wanted: 2, lowerAt: 0, timer: null };
            this.#runtimeRaster.set(target, raster);
          }
          if (!frames) {
            if (raster.timer) clearTimeout(raster.timer);
            raster.timer = null;
            raster.wanted = raster.density;
            raster.lowerAt = 0;
            continue;
          }
          let density: BrowserRasterDensity = 0.75;
          for (const viewer of this.#consumers.values())
            if (viewer.subscription === "frames" && viewer.surfaceId === target)
              density = Math.max(density, viewer.rasterDensity) as BrowserRasterDensity;
          const now = performance.now();
          if (density !== raster.wanted) {
            if (raster.timer) clearTimeout(raster.timer);
            raster.timer = null;
            raster.wanted = density;
            raster.lowerAt = now + 1_000;
          }
          if (density === raster.density) continue;
          if (density < raster.density && now < raster.lowerAt) {
            raster.timer ??= setTimeout(() => {
              raster.timer = null;
              void this.#reconcileStreaming().catch(() => undefined);
            }, raster.lowerAt - now);
            raster.timer.unref();
            continue;
          }
          if (raster.timer) clearTimeout(raster.timer);
          raster.timer = null;
          await this.#sendCommand({
            type: "stream.demand",
            surfaceId: BrowserSurfaceIdSchema.parse(target),
            density,
          });
          raster.density = density;
        }
      }
      for (const target of this.#frameIds.keys())
        if (!admitted.has(target)) this.#frameIds.delete(target);
      for (const consumer of this.#consumers.values())
        if (consumer.subscription === "frames" && consumer.surfaceId)
          consumer.sendStreamState(admitted.has(consumer.surfaceId) ? "admitted" : "capacity");
    });
    this.#streamReconcileTail = operation.catch(() => undefined);
    return operation;
  }

  #sendCommand(
    message: BrowserClientMessage,
    signal?: AbortSignal,
    onSubmit?: () => void,
    recheck?: () => Promise<void>,
  ): Promise<void> {
    if (
      message.type === "navigation.reload" &&
      message.ignoreCache !== undefined &&
      this.navigationVersion !== 1
    )
      return Promise.reject(
        new OpensteerError({
          code: "conflict",
          message: "Update the browser computer to reload without cache.",
        }),
      );
    // Taken at queue time: a queued send keeps a park from starting, or vetoes one before D.
    const admission = this.#poolAdmission;
    let poolHold = admission?.now();
    const admitted =
      admission && !poolHold
        ? this.#commandTail.then(async () => {
            const ended = this.#poolEnded!.signal;
            poolHold = await admission.wait(signal ? AbortSignal.any([signal, ended]) : ended);
          })
        : this.#commandTail;
    const generation = this.#runtimeConnectionGeneration;
    const tail = recheck ? admitted.then(recheck) : admitted;
    const operation = tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          signal?.throwIfAborted();
          if (
            generation !== this.#runtimeConnectionGeneration ||
            this.#settled ||
            this.#protocolFailed ||
            (!this.#runtimeReady &&
              message.type !== "session.saved" &&
              message.type !== "tabs.resync") ||
            this.#socket.readyState !== WebSocket.OPEN
          ) {
            reject(
              new OpensteerError({
                code: "conflict",
                message: "Browser Runtime is not connected.",
                ...(this.#reconnecting && !this.#settled && !this.#protocolFailed
                  ? { retryable: true }
                  : {}),
              }),
            );
            return;
          }
          let compatible: BrowserClientMessage = message;
          if (!this.captureRegion) {
            if (message.type === "input.pointer" || message.type === "input.wheel") {
              const { captureRevision: _captureRevision, ...legacy } = message;
              compatible = legacy;
            } else if (message.type === "stream.subscribe") {
              const { captureRegion: _captureRegion, ...legacy } = message;
              compatible = legacy;
            }
          }
          if (this.#snapshot?.inputLanesVersion !== 1) {
            const {
              producerId: _producerId,
              inputGeneration: _inputGeneration,
              inputSequence: _inputSequence,
              inputSequenceStart: _inputSequenceStart,
              ...legacy
            } = compatible;
            compatible =
              message.type === "autofill.fill" || message.type === "passwordSave.answer"
                ? { ...legacy, producerId: message.producerId }
                : legacy;
            if (legacy.type === "input.pointer") {
              const {
                geometryRevision: _revision,
                modifiers: _modifiers,
                buttons: _buttons,
                ...pointer
              } = legacy;
              compatible = pointer;
            } else if (legacy.type === "input.wheel") {
              const { geometryRevision: _revision, modifiers: _modifiers, ...wheel } = legacy;
              compatible = wheel;
            }
          }
          let runtimeMessage: object = compatible;
          if (!this.sharedControl) {
            switch (message.type) {
              case "viewport.follow":
                resolve();
                return;
              case "viewport.set":
                runtimeMessage = {
                  type: message.type,
                  height: message.height,
                  width: message.width,
                };
                break;
              case "surface.open":
                runtimeMessage = { type: message.type, url: message.url };
                break;
              case "dialog.respond":
                if (
                  this.#snapshot?.dialog?.id !== message.dialogId ||
                  this.#answeredOlderDialogId === message.dialogId
                ) {
                  reject(
                    new OpensteerError({
                      code: "conflict",
                      message: "There is no active browser dialog.",
                    }),
                  );
                  return;
                }
                this.#answeredOlderDialogId = message.dialogId;
                runtimeMessage = {
                  type: message.type,
                  accept: message.accept,
                  promptText: message.promptText,
                };
                break;
            }
          }
          const frame = JSON.stringify(runtimeMessage);
          // The pool's admission is checked here, where the bytes leave, after the last await.
          if (admission?.refusesWrite(poolHold)) {
            reject(new BrowserPoolAdmissionClosed("This browser is restarting or was removed."));
            return;
          }
          onSubmit?.();
          this.#socket.send(frame, { binary: false }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    const settled = admission ? operation.finally(() => poolHold?.release()) : operation;
    this.#commandTail = settled.catch(() => undefined);
    return settled;
  }

  #rejectReconnectReady(error: unknown): void {
    const pending = this.#reconnectReady;
    if (!pending) return;
    this.#reconnectReady = null;
    pending.reject(error);
  }

  #finish(
    state: "closed" | "failed" | "pooled",
    consumerCloseCode: number,
    consumerCloseReason: string,
  ): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#settled = true;
    this.#rejectReconnectReady(
      new OpensteerError({ code: "conflict", message: this.#failure ?? "Browser closed." }),
    );
    if (this.#sessionStateTimer) clearTimeout(this.#sessionStateTimer);
    this.#sessionStateHold?.release();
    this.#sessionStateHold = undefined;
    // An ordinary broker allocates nothing for the pool here, and constructs no error.
    this.#poolEnded?.abort(
      new OpensteerError({ code: "conflict", message: "Browser Runtime is not connected." }),
    );
    this.#historyNavigations.clear();
    this.#historyDocuments.clear();
    this.#historyIcons.clear();
    for (const raster of this.#runtimeRaster.values()) if (raster.timer) clearTimeout(raster.timer);
    this.#runtimeRaster.clear();
    this.#passkeys?.close();
    if (state === "failed") {
      console.error("browser.session.failed", this.#sessionId, this.#failure ?? "unknown");
    }
    // Socket close and stop() must await the same durable terminal transition.
    this.#finishPromise = Promise.resolve().then(async () => {
      if (this.#pageNoticeTimer !== null) clearTimeout(this.#pageNoticeTimer);
      this.#cdpListeners.clear();
      for (const listener of this.#cdpTerminalListeners) {
        try {
          listener();
        } catch {
          // A downstream transport cannot prevent durable Browser Session cleanup.
        }
      }
      this.#cdpTerminalListeners.clear();
      for (const attachmentId of this.#actionListeners.keys()) this.detachActions(attachmentId);
      this.#runtimeReady = false;
      for (const pending of this.#pendingStateImports.values()) {
        clearTimeout(pending.timeout);
        pending.reject(
          new OpensteerError({ code: "conflict", message: "Browser Runtime disconnected." }),
        );
      }
      this.#pendingStateImports.clear();
      for (const pending of this.#pendingCdpRequests.values()) {
        clearTimeout(pending.timeout);
        pending.removeAbort();
        pending.reject(
          pending.submitted && pending.timeout === undefined
            ? browserCommandOutcomeUnknown()
            : new OpensteerError({ code: "conflict", message: "Browser Runtime disconnected." }),
        );
      }
      this.#pendingCdpRequests.clear();
      for (const consumer of this.#consumers.values()) {
        consumer.peer.close(consumerCloseCode, consumerCloseReason);
        consumer.close();
      }
      this.#consumers.clear();
      try {
        if (state !== "pooled") await this.#onState(state);
      } catch (cause) {
        throw new OpensteerError({
          cause,
          code: "internal",
          message:
            "The browser disconnected, but Opensteer could not save its ended state. Use tab_list to select another tab.",
        });
      } finally {
        try {
          await this.#onTerminal();
        } finally {
          this.#icons.clear();
        }
      }
    });
    return this.#finishPromise;
  }
}

export class BrowserConsumerAttachment {
  #closed = false;
  readonly #detach: () => void;
  readonly #handle: (frame: Buffer, isBinary: boolean) => Promise<void>;

  constructor(handle: (frame: Buffer, isBinary: boolean) => Promise<void>, detach: () => void) {
    this.#handle = handle;
    this.#detach = detach;
  }

  handle(frame: Buffer, isBinary: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Browser consumer is detached."));
    return this.#handle(frame, isBinary);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
  }
}

/** How often a viewer's access to its session is read again. */
const consumerAccessRecheckMs = 5_000;
/** How long a Watch viewer may hold a picture before it is let go as stalled. */
const watchAcknowledgementTimeoutMs = 15_000;
const browserFrameCreditBytes = 1_024 * 1_024;
const browserFrameCreditMax = 4;
// Beyond this receipt delay, sending more pictures only risks a long stale queue.
const browserFramePipelineDelayMs = 500;
const browserFrameQueueBudgetMs = 32;
const browserFrameRateEstimateMs = 10_000;

/**
 * Each viewer has independent credit and one replaceable pending picture.
 * Negotiated viewers pipeline only while receipt timing permits, pacing writes
 * to avoid converting a frame-rate improvement into older pictures on screen.
 */
export class BrowserConsumerOutlet {
  #surfaceLast: string | null = null;
  #streamState: "admitted" | "capacity" | null = null;
  #surfacePending: { data: string; icon: { key: string; favicon: string } | null } | null = null;
  readonly #sentIcons = new Set<string>();
  #surfaceSending = false;
  frameWindow = false;
  #window = 1;
  #baselineDelay = Infinity;
  readonly #receiptDelays: number[] = [];
  #deliveryRate: { bytesPerMs: number; at: number } | null = null;
  #lastReceipt: { sentAt: number; acknowledgedAt: number } | null = null;
  #paceAt = 0;
  #paceTimer: NodeJS.Timeout | null = null;
  userId: UserId | null = null;
  passkeys: PasskeyMode | undefined;
  /** Understands `browser.popup.opened`, and hears its own token for reporting native input. */
  popups = false;
  /** The person fill version this controller negotiated; 0 for none. */
  autofill: 0 | PersonFillVersion = 0;
  authorized: () => Promise<boolean> = async () => false;
  readonly clipboardToken = randomUUID();
  readonly legacyClipboard = new LegacyBrowserClipboard(this.clipboardToken, maxBrowserTextBytes);
  readonly legacyClipboardKeys = new Set<string>();
  readonly clipboardOperations = new Map<string, BrowserSurfaceId>();
  readonly failedClipboardOperations = new Set<string>();
  readonly editingCounters: Record<string, number> = {};
  inputSequence = 0;
  inputGeneration = 0;
  readonly peer: BrowserConsumerPeer;
  readonly mode: BrowserConsumerMode;
  readonly #stillVisible: () => Promise<boolean>;
  readonly #onClose: () => void;
  readonly #accessTimer: NodeJS.Timeout;
  #closed = false;
  #frameInFlight = false;
  #pending: { readonly frame: Buffer; readonly header: BrowserBinaryFrameHeader } | null = null;
  #outstanding = new Map<
    string,
    { sentAt: number; bytes: number; timer: NodeJS.Timeout; saturated: boolean }
  >();
  readonly diagnostics: {
    editing?: Readonly<Record<string, number>>;
    stage: string;
    frameId?: number;
    bytes?: number;
    durationMs?: number;
    code?: number;
    reason?: string;
  }[] = [];
  #diagnose(record: (typeof this.diagnostics)[number]): void {
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    const diagnostic = { ...record, editing: { ...this.editingCounters } };
    this.diagnostics.push(diagnostic);
    if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
      console.info(JSON.stringify({ browserOutlet: true, ...diagnostic }));
  }
  recordEditing(kind: string): void {
    this.editingCounters[kind] = (this.editingCounters[kind] ?? 0) + 1;
    this.#diagnose({ stage: "editing", reason: kind });
  }
  #lastFrameId = -1;
  #accessRead = false;
  subscription: null | "frames" | "control" = null;
  surfaceId: string | null = null;
  tabGeneration: number | null = null;
  captureRegion = false;
  rasterDensity: BrowserRasterDensity = 2;
  basicInput = false;
  surfaceState = false;
  readonly basicClipboardResults = new Map<string, { next: number; readonly total: number }>();
  editing: 1 | 2 | undefined;
  clipboard = false;
  #captureRefusal: number | null = null;

  constructor(
    peer: BrowserConsumerPeer,
    mode: BrowserConsumerMode,
    stillVisible: () => Promise<boolean>,
    onClose: () => void,
  ) {
    this.peer = peer;
    this.mode = mode;
    this.#stillVisible = stillVisible;
    this.#onClose = onClose;
    this.#accessTimer = setInterval(() => void this.#recheckAccess(), consumerAccessRecheckMs);
    this.#accessTimer.unref();
  }

  async #recheckAccess(): Promise<void> {
    if (this.#closed || this.#accessRead) return;
    this.#accessRead = true;
    try {
      const visible = await withTimeout(this.#stillVisible(), consumerAccessRecheckMs, {
        timeoutError: () => new Error("Browser access check timed out."),
      });
      if (!visible) {
        this.#end(browserViewerCloseCodes.accessEnded, "Browser access ended");
      }
    } catch {
      // Unknown is not allowed, a read that never answers included: the viewer
      // is let go, and reconnecting reads access again from the start.
      this.#end(browserViewerCloseCodes.tryAgain, "Browser access could not be checked");
    } finally {
      this.#accessRead = false;
    }
  }

  async sendText(data: string): Promise<void> {
    if (this.#closed) return;
    try {
      await this.peer.send(data, false);
    } catch (error) {
      this.#end(1011, "Browser consumer write failed");
      throw error;
    }
  }

  sendStreamState(state: "admitted" | "capacity"): void {
    if (
      this.#closed ||
      this.subscription !== "frames" ||
      !this.surfaceId ||
      this.#streamState === state
    )
      return;
    this.#streamState = state;
    void this.sendText(
      JSON.stringify({ type: "browser.stream.state", surfaceId: this.surfaceId, state }),
    ).catch(() => undefined);
  }

  sendSurface(
    surfaceId: string,
    surface: BrowserViewerSurface | null,
    icon: { key: string; favicon: string } | null = null,
  ): void {
    if (this.#closed || this.subscription === null || this.surfaceId !== surfaceId) return;
    const data = JSON.stringify({
      type: "browser.surface",
      surfaceId,
      surface,
      ...(surface ? { icon: icon?.key ?? null } : {}),
    });
    if (data === this.#surfaceLast) return;
    this.#surfaceLast = data;
    this.#surfacePending = { data, icon };
    if (!this.#surfaceSending) void this.#flushSurface();
  }

  async #flushSurface(): Promise<void> {
    this.#surfaceSending = true;
    try {
      while (!this.#closed && this.#surfacePending !== null) {
        const { data, icon } = this.#surfacePending;
        this.#surfacePending = null;
        if (icon && !this.#sentIcons.has(icon.key)) {
          await this.sendText(JSON.stringify({ type: "browser.tab.icon", ...icon }));
          this.#sentIcons.add(icon.key);
        }
        await this.sendText(data);
      }
    } catch {
      // sendText closes the outlet on a failed write.
    } finally {
      this.#surfaceSending = false;
    }
  }

  sendFrame(frame: Buffer, header: BrowserBinaryFrameHeader): void {
    if (this.#closed || this.subscription !== "frames" || header.frameId <= this.#lastFrameId)
      return;
    if (
      !this.captureRegion &&
      header.capture &&
      (header.capture.width !== header.viewportWidth ||
        header.capture.height !== header.viewportHeight)
    ) {
      if (this.#captureRefusal !== header.capture.revision) {
        this.#captureRefusal = header.capture.revision;
        void this.sendText(
          JSON.stringify({
            type: "browser.error",
            error: {
              code: "conflict",
              reason: "browser-capture-region-unsupported",
              retryable: false,
              message:
                "Update this viewer to show a natively cropped browser page, or explicitly Fit the page.",
            },
          }),
        ).catch(() => undefined);
      }
      return;
    }
    if (
      this.#frameInFlight ||
      this.#outstanding.size >= this.#window ||
      (this.#outstanding.size > 0 &&
        [...this.#outstanding.values()].reduce((sum, item) => sum + item.bytes, 0) +
          frame.byteLength -
          frame.readUInt32BE(0) +
          Buffer.byteLength(
            JSON.stringify({ ...header, watchToken: "00000000-0000-0000-0000-000000000000" }),
          ) >
          browserFrameCreditBytes)
    ) {
      if (this.#pending) this.#diagnose({ stage: "drop", frameId: this.#pending.header.frameId });
      this.#pending = { frame, header };
      return;
    }
    if (this.frameWindow && performance.now() < this.#paceAt) {
      if (this.#pending) this.#diagnose({ stage: "drop", frameId: this.#pending.header.frameId });
      this.#pending = { frame, header };
      this.#paceTimer ??= setTimeout(() => {
        this.#paceTimer = null;
        this.#flushPending();
      }, this.#paceAt - performance.now());
      this.#paceTimer.unref();
      return;
    }
    this.#lastFrameId = header.frameId;
    this.#frameInFlight = true;
    let outbound = frame;
    {
      const token = randomUUID();
      const timer = setTimeout(
        () =>
          this.#end(
            browserViewerCloseCodes.tryAgain,
            "Browser presentation acknowledgement timed out",
          ),
        watchAcknowledgementTimeoutMs,
      );
      timer.unref();
      const { capture: _capture, ...legacyHeader } = header;
      outbound = watchFrameEnvelope(frame, this.captureRegion ? header : legacyHeader, token);
      this.#outstanding.set(token, {
        sentAt: performance.now(),
        bytes: outbound.byteLength,
        timer,
        saturated: this.#outstanding.size + 1 >= this.#window,
      });
    }
    const started = performance.now();
    if (this.frameWindow && this.#window > 1)
      this.#paceAt =
        started +
        Math.max(
          this.#baselineDelay / this.#window,
          this.#deliveryRate ? outbound.byteLength / this.#deliveryRate.bytesPerMs : 0,
        );
    void this.peer.send(outbound, true).then(
      () => {
        this.#diagnose({
          stage: "send",
          frameId: header.frameId,
          bytes: outbound.byteLength,
          durationMs: performance.now() - started,
        });
        this.#frameInFlight = false;
        this.#flushPending();
      },
      () => this.#end(browserViewerCloseCodes.tryAgain, "Slow browser consumer"),
    );
  }

  acknowledge(token: string): Promise<void> {
    const receipt = this.#outstanding.get(token);
    if (!receipt) return Promise.resolve();
    const delay = performance.now() - receipt.sentAt;
    this.#diagnose({ stage: "credit", durationMs: delay });
    clearTimeout(receipt.timer);
    this.#outstanding.delete(token);
    // A path change must be able to retire the old minimum. The bounded
    // recent window also keeps one delayed receipt from defining the baseline.
    const previousBaseline = this.#baselineDelay;
    this.#receiptDelays.push(delay);
    if (this.#receiptDelays.length > 16) this.#receiptDelays.shift();
    this.#baselineDelay = Math.min(...this.#receiptDelays);
    if (this.#baselineDelay > previousBaseline * 1.25) this.#deliveryRate = null;
    const now = performance.now();
    if (this.frameWindow) {
      const previous = this.#lastReceipt;
      const spacing = previous ? now - previous.acknowledgedAt : 0;
      // Concurrent writes whose receipts spread farther apart than their sends
      // expose serialization or decoder pressure. Pace at that delivery rate
      // rather than filling the link's queue with already-outdated pictures.
      if (
        previous &&
        receipt.sentAt < previous.acknowledgedAt &&
        spacing > receipt.sentAt - previous.sentAt + 5
      )
        this.#deliveryRate = { bytesPerMs: receipt.bytes / spacing, at: now };
      else if (this.#deliveryRate && now - this.#deliveryRate.at > browserFrameRateEstimateMs)
        this.#deliveryRate = null;
      const ceiling = this.#deliveryRate
        ? Math.max(
            1,
            Math.min(
              browserFrameCreditMax,
              Math.floor(
                ((this.#baselineDelay + browserFrameQueueBudgetMs) *
                  this.#deliveryRate.bytesPerMs) /
                  receipt.bytes,
              ),
            ),
          )
        : browserFrameCreditMax;
      this.#window = Math.min(this.#window, ceiling);
      if (delay > 1.25 * this.#baselineDelay + 10)
        this.#window = Math.max(1, Math.floor(this.#window / 2));
      else if (receipt.saturated && delay <= browserFramePipelineDelayMs)
        this.#window = Math.min(ceiling, this.#window + 1);
      this.#lastReceipt = { sentAt: receipt.sentAt, acknowledgedAt: now };
    }
    if (!this.#frameInFlight) this.#flushPending();
    return Promise.resolve();
  }

  /** Another tab came forward: a waiting picture of the one before is dropped. */
  dropPendingOutside(activeSurfaceId: string | null): void {
    if (this.#pending && this.#pending.header.surfaceId !== activeSurfaceId) this.#pending = null;
  }

  /** Subscribing again starts over: no credit owed, no picture waiting. */
  resetSubscription(): void {
    this.#surfaceLast = null;
    this.#streamState = null;
    this.#surfacePending = null;
    for (const receipt of this.#outstanding.values()) clearTimeout(receipt.timer);
    this.#outstanding.clear();
    this.#window = 1;
    this.#baselineDelay = Infinity;
    this.#receiptDelays.length = 0;
    this.#deliveryRate = null;
    this.#lastReceipt = null;
    this.#paceAt = 0;
    if (this.#paceTimer) clearTimeout(this.#paceTimer);
    this.#paceTimer = null;
    this.#pending = null;
    this.#lastFrameId = -1;
  }

  #flushPending(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.sendFrame(pending.frame, pending.header);
  }

  #end(code: number, reason: string): void {
    if (this.#closed) return;
    this.#diagnose({ stage: "local-close", code, reason });
    this.peer.close(code, reason);
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#surfacePending = null;
    this.legacyClipboard.close();
    this.legacyClipboardKeys.clear();
    this.#pending = null;
    for (const receipt of this.#outstanding.values()) clearTimeout(receipt.timer);
    this.#outstanding.clear();
    this.#window = 1;
    this.#baselineDelay = Infinity;
    this.#receiptDelays.length = 0;
    this.#deliveryRate = null;
    this.#lastReceipt = null;
    this.#paceAt = 0;
    if (this.#paceTimer) clearTimeout(this.#paceTimer);
    this.#paceTimer = null;
    clearInterval(this.#accessTimer);
    this.#onClose();
  }
}

function watchFrameEnvelope(
  frame: Buffer,
  header: BrowserBinaryFrameHeader,
  token: string,
): Buffer {
  const originalHeaderLength = frame.readUInt32BE(0);
  const encodedHeader = Buffer.from(JSON.stringify({ ...header, watchToken: token }), "utf8");
  const image = frame.subarray(4 + originalHeaderLength);
  const envelope = Buffer.allocUnsafe(4 + encodedHeader.byteLength + image.byteLength);
  envelope.writeUInt32BE(encodedHeader.byteLength, 0);
  encodedHeader.copy(envelope, 4);
  image.copy(envelope, 4 + encodedHeader.byteLength);
  return envelope;
}

export function publicProfile(record: BrowserProfileRecord): BrowserProfile {
  return {
    homeRunnerId: record.homeRunnerId ?? null,
    id: record.id,
    name: record.name,
    ...(record.purpose === "engine-sign-in" ? { purpose: record.purpose } : {}),
  };
}

function publicSession(record: BrowserSessionRecord): HostedBrowserSession {
  return {
    access: "read-write",
    ...(record.closeUnconfirmed ? { closeUnconfirmed: true as const } : {}),
    createdAt: record.createdAt.toISOString(),
    id: record.id,
    origin: record.origin,
    placement: placementOf(record),
    profileId: record.profileId,
    runtimeId: record.runtimeId,
    state: record.state,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function placementOf(record: BrowserSessionRecord): BrowserPlacementSelector {
  return { kind: "runner", runnerId: record.runnerId };
}

export function publicPlacement(placement: BrowserRuntimePlacement): BrowserPlacement {
  return {
    available: placement.available,
    environmentIds: placement.environmentIds,
    kind: placement.kind,
    label: placement.label,
    runnerId: placement.runnerId,
    runtimeId: placement.runtimeId,
    ...(placement.unavailableReason ? { unavailableReason: placement.unavailableReason } : {}),
  };
}

function placementSelector(placement: BrowserPlacement): BrowserPlacementSelector {
  return { kind: "runner", runnerId: placement.runnerId };
}

/**
 * Names the candidates so the refusal is actionable: the agent retries the
 * same call with one of these computers instead of guessing.
 */
function browserMachineChoices(placements: readonly BrowserPlacement[]): string {
  return placements
    .map((placement) => `${placement.label} (computerId ${placement.runnerId})`)
    .join(", ");
}

function runnerPlacementConflict(placements: readonly BrowserPlacement[]): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: `Choose which connected computer should run this browser: ${browserMachineChoices(placements)}.`,
  });
}

function samePlacement(left: BrowserPlacementSelector, right: BrowserPlacementSelector): boolean {
  return left.runnerId === right.runnerId;
}

function isCdpResponse(
  message: BrowserServerMessage | BrowserRuntimeServerMessage,
): message is BrowserCdpWireResponse {
  return message.type === "cdp.error" || message.type === "cdp.result";
}

function assertBrowserDialogSurface(
  dialog: Extract<BrowserServerMessage, { type: "browser.snapshot" }>["dialog"],
  surfaces: Extract<BrowserServerMessage, { type: "browser.snapshot" }>["surfaces"],
): void {
  if (dialog && !surfaces.some((surface) => surface.id === dialog.surfaceId)) {
    throw new Error("Browser Runtime dialog references an unknown surface.");
  }
}

function agentProtocolError(error: {
  readonly code: "bad_message" | "conflict" | "forbidden" | "internal" | "not_found";
  readonly message: string;
  readonly retryable: boolean;
  readonly reason?: string | undefined;
}): OpensteerError {
  return new OpensteerError({
    code: error.code === "bad_message" ? "bad_request" : error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.reason ? { reason: error.reason } : {}),
  });
}

function safeNavigationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only HTTP and HTTPS browser navigation is allowed.",
    });
  }
  return url.toString();
}

/** Reasons the coordinator gives when its target is over: a new one is awaited. */
const poolOverReasons = new Set(["slot-deleted", "fenced", "browser-replaced"]);

/**
 * Why a pooled browser cannot be used now, as its report says it: a target that is over is a
 * browser being set up again; a start the host refused carries its reason; calls unanswered past
 * their bound mean the browser cannot be reached.
 */
function poolNotReady(
  shown: ReturnType<BrowserPoolCoordinator["report"]>,
): { readonly reason: string } | undefined {
  if (shown?.refused)
    return { reason: poolOverReasons.has(shown.refused) ? "setting-up" : shown.refused };
  if (shown?.unreachable) return { reason: "unreachable" };
  if (shown?.proxyDown) return { reason: "egress-proxy-down" };
  return undefined;
}

/** `promise`, or the signal's reason once it fires first; what it awaits goes on. */
function untilSettledOrAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * The lane's result; or, if `signal` fires before the lane's work has begun, undefined at once.
 * Work already begun is awaited to its end. Work that begins after the signal fired sees it and
 * returns undefined itself, so nothing is left registered.
 */
async function enteredOrAborted<T>(
  lane: Promise<T | undefined>,
  entered: () => boolean,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!signal) return lane;
  if (signal.aborted && !entered()) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const abort = () => {
      if (!entered()) resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    lane.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** How long a restart's quiesce waits for the old runtime's brokers to finish detaching. */
const quiesceDetachMs = 15_000;

function isTerminal(state: HostedBrowserSessionState): boolean {
  return state === "closed" || state === "failed";
}

function waitForSocketClose(socket: BrowserRuntimeConnection, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);
    timeout.unref();
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function unavailable(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({
    cause,
    code: "runner_offline",
    message,
    retryable: true,
  });
}

function browserStartUnavailable(
  correlationId: string,
  stage: string,
  cause: unknown,
): OpensteerError {
  const error = new Error(`Browser Session ${correlationId} failed during ${stage}.`, { cause });
  console.error("browser.session.start.failed", correlationId, stage, error);
  return unavailable("The Browser Runtime could not start this browser.", error);
}

const editingClientKinds = new Set<string>([
  "input.command",
  "input.compose",
  "input.text",
  "clipboard.copy",
  "clipboard.cut",
  "clipboard.paste-data",
  "clipboard.part",
]);
const editingServerKinds = new Set<string>([
  "browser.editing",
  "clipboard.result",
  "clipboard.written",
  "clipboard.part",
  "browser.contextmenu",
]);

interface BrowserTabOpenBudget {
  readonly confirmed?: true;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly abort?: (reason?: unknown) => void;
  readonly browserSend?: PooledBrowserSend;
  openAccessGeneration?: number;
  admitted?: BrowserTabOpenBinding;
  pageRequested?: boolean;
  cleanupPoolAbort?: () => void;
  pool?: {
    target: BrowserPoolCoordinator;
    reservation: BrowserPoolReservation;
  };
}

class BrowserCdpRefusal extends OpensteerError {
  constructor(cause: OpensteerError) {
    super({
      cause,
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
      ...(cause.reason ? { reason: cause.reason } : {}),
    });
  }
}

interface BrowserLiveRows {
  readonly groupId: BrowserSessionId;
  readonly records: ReadonlyMap<string, BrowserTabRecord>;
  readonly inventoryRevision: number;
  readonly navigation: boolean;
  readonly ready: boolean;
  readonly acting: boolean;
  readonly page: BrowserPagePresence | null;
  iconRef(id: string): string | null;
}
type PageDescriptor = Pick<
  BrowserTabRecord,
  "id" | "title" | "url" | "order" | "openerId" | "creatorAttachmentId"
> & {
  readonly favicon?: string | null;
};

function pageIconRef(lineageId: BrowserSessionId, favicon: string): string {
  return createHash("sha256").update(lineageId).update("\0").update(favicon).digest("base64url");
}
