import { type BrowserCookie } from "@opensteer/browser-profile/cookies";
import {
  OpensteerError,
  UserIdSchema,
  type AgentEvent,
  type AuthSessionId,
  type BrowserAccessSuggestion,
  type BrowserProfileGrantId,
  type BrowserProfileId,
  type EnvironmentId,
  type Request,
  type RequestId,
  type RequestResponse,
  type EventData,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  OpensteerStore,
  withDatabaseOperationSignal,
  withoutDatabaseOperationSignal,
  workspaceTabIconRef,
  WorkspaceTabStore,
  type BrowserHistoryStore,
  type BrowserTabGroupStore,
} from "@opensteer/database";
import type { BrowserWorkspaceTabDescriptor, WorkspaceTabLineage } from "@opensteer/protocol";
import {
  browserBootstrapSessionsMaxBytes,
  browserCaptureMaxTargets,
  BrowserClientMessageSchema,
  BrowserContextCandidateSchema,
  BrowserDialogSchema,
  BrowserHistoryUrlSchema,
  browserHostMethods,
  browserPageSite,
  BrowserProfileAccessSchema,
  BrowserServerMessageSchema,
  browserStateImportHostTimeoutMs,
  BrowserSurfaceIdSchema,
  BrowserTabCatalogSchema,
  BrowserTabOpenCommandSchema,
  BrowserTabOpenRefusalDetailsSchema,
  browserViewerCloseCodes,
  createBrowserSessionId,
  decodeBrowserFrameEnvelope,
  InitialPageReadySchema,
  placeIdentityKey,
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
  type BrowserPresence,
  type BrowserProfile,
  type BrowserProfileAccess,
  type BrowserProfileGrant,
  type BrowserRasterDensity,
  type BrowserRuntimeActivity,
  type BrowserServerMessage,
  type BrowserSessionId,
  type BrowserSessionOpenerRecord,
  type BrowserSurface,
  type BrowserSurfaceId,
  type BrowserTabCatalog,
  type BrowserTabCloseCommand,
  type BrowserTabCloseResult,
  type BrowserTabIconInput,
  type BrowserTabOpenBinding,
  type BrowserTabOpenCommand,
  type BrowserTabOpenRefusalReason,
  type BrowserTabOpenResult,
  type HostedBrowserBootstrap,
  type HostedBrowserSession,
  type HostedBrowserSessionState,
  type InitialPageReady,
  type PendingBrowserProfileDeletion,
  type PlaceActivity,
  type PlaceActivityNotice,
  type PlaceIdentity,
  type PlaceOccupant,
  type RequestCreationResult,
  type ThreadPlaceReference,
} from "@opensteer/protocol";
import type { PasskeyMode } from "@opensteer/protocol/passkeys";
import type { BootstrapNoticeSource } from "@opensteer/shared/bootstrapDiagnostics";
import { systemClock, type Clock } from "@opensteer/shared/clock";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, randomUUID } from "node:crypto";
import type { RawData } from "ws";
import WebSocket from "ws";
import { z } from "zod";
import { BrowserCatalogRevisions } from "./browser-catalog-revisions.js";
import { LegacyBrowserClipboard } from "./browser-legacy-clipboard.js";
import type { BrowserLocalProfiles } from "./browser-local-profiles.js";
import type { BrowserAttachTicketSigner } from "./browser-ticket.js";
import { browserViewerEditingVersion, browserViewerMessage } from "./browser-viewer-protocol.js";
import { PasskeyService, type PasskeyViewer } from "./passkey-service.js";

const olderBrowserDialogSchema = BrowserDialogSchema.omit({ id: true });

const maxBrowserCommandBytes = 1_100_000;
const maxBrowserFrameBytes = 8 * 1_024 * 1_024;
const maxBrowserTextBytes = 1 * 1_024 * 1_024;
const maxPendingAgentRequests = 32;
const agentRequestTimeoutMs = 15_000;
const maxBrowserProfiles = 128;
const maxBrowserSessions = 100;
const maxBrowserProfileGrants = 100;
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
export class BrowserCdpConnectionEnded extends Error {
  override readonly name = "BrowserCdpConnectionEnded";
}

/**
 * What a viewer or an agent's browser surface may send. Everything else —
 * CDP, and state export and import in particular — is identity material or
 * control only the Host itself issues, so it is never relayed from a consumer.
 */
const consumerMessageTypes: ReadonlySet<BrowserClientMessage["type"]> = new Set([
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
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly ownerId: UserId;
}

export interface ActiveBrowserProfileGrant {
  readonly access: BrowserProfileAccess;
  readonly createdAt: Date;
  readonly grantId: BrowserProfileGrantId;
  readonly profileId: BrowserProfileId;
  readonly workspaceId: WorkspaceId;
}

/** One granted browser profile as an agent sees it. */

export interface BrowserSessionRecord {
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly createdAt: Date;
  readonly id: BrowserSessionId;
  readonly origin: "agent" | "trigger" | "workspace";
  readonly placementKey: string;
  readonly runnerId: RunnerId;
  /** Null exactly for a fresh session: no identity, no durable state. */
  readonly profileId: BrowserProfileId | null;
  readonly runtimeId: string;
  readonly state: HostedBrowserSessionState;
  readonly updatedAt: Date;
  readonly workspaceId: WorkspaceId;
}

export interface BrowserSessionWithAttachmentCountRecord extends BrowserSessionRecord {
  readonly activeAttachmentCount: number;
}

export interface BrowserSessionRepository {
  recordRunPlace(input: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly data: EventData<"place.entered">;
  }): Promise<AgentEvent | undefined>;
  findMainWorkspaceForOwner(
    ownerId: UserId,
  ): Promise<{ readonly id: WorkspaceId } | null | undefined>;
  getBrowserTabOpen(ownerId: UserId, key: string): Promise<BrowserTabOpenBinding | null>;
  bindBrowserTabOpen(input: {
    binding: BrowserTabOpenBinding;
    identityKey: string | null;
    runnerId: RunnerId;
  }): Promise<void>;
  settleBrowserTabOpen(binding: BrowserTabOpenBinding): Promise<void>;
  rememberedBrowserPlacement(ownerId: UserId, identityKey: string): Promise<RunnerId | null>;
  browserSessionOpenerForBinding(
    agentBindingId: string,
    ownerId: UserId,
  ): Promise<BrowserSessionOpenerRecord | null>;
  latestNativePlaces?(ownerId: UserId): Promise<readonly ThreadPlaceReference[]>;
  authorizedPlaceThreadIds?(
    ownerId: UserId,
    threadIds: readonly ThreadId[],
  ): Promise<readonly ThreadId[]>;
  effectiveMachineOwners?(
    runnerIds: readonly RunnerId[],
  ): Promise<ReadonlyMap<RunnerId, { readonly effectiveOwner: UserId | null }>>;
  listBrowserSessionViewers(
    sessionId: BrowserSessionId,
  ): Promise<{ readonly userIds: readonly UserId[]; readonly workspaceId: WorkspaceId } | null>;
  resolvePlaceActors(input: {
    readonly agentBindingIds: readonly string[];
    readonly ownerIds: readonly UserId[];
  }): Promise<
    readonly {
      agentBindingId: string;
      ownerId: UserId;
      runId: RunId;
      threadId: ThreadId;
      home: boolean;
      generation: number;
      lineageThreadIds: ThreadId[];
      lineageWorkspaceIds: WorkspaceId[];
    }[]
  >;
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
      readonly originatingWorkspaceId: WorkspaceId;
      readonly payload: Request["payload"];
      readonly presentation: Request["presentation"];
      readonly requestedBy: UserId;
      readonly requiredActor: "requester";
      readonly targetWorkspaceId: WorkspaceId;
    }): Promise<{
      readonly events: readonly AgentEvent[];
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
      readonly resolvedBy: UserId;
      readonly response: RequestResponse;
    }): Promise<{
      readonly events: readonly AgentEvent[];
      readonly grant: ActiveBrowserProfileGrant | null;
      readonly profile: BrowserProfileRecord | null;
      readonly request: Request;
    }>;
  };
  createBrowserProfile(input: {
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
  }): Promise<BrowserProfileRecord>;
  createBrowserProfileGrant(input: {
    readonly access: BrowserProfileAccess;
    readonly createdBy: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<ActiveBrowserProfileGrant>;
  createBrowserSession(input: {
    readonly tabGroupId?: BrowserSessionId;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "workspace";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<BrowserSessionRecord>;
  countBrowserSessionAttachments(sessionId: BrowserSessionId): Promise<number>;
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
    readonly workspaceId: WorkspaceId;
  }): Promise<boolean>;
  detachBrowserSessionAttachments(agentBindingId: string): Promise<readonly BrowserSessionId[]>;
  detachBrowserSessionAttachmentsForProfileGrant(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<number>;
  failActiveBrowserSessions(placementKey?: string): Promise<{
    readonly events: readonly AgentEvent[];
    readonly failed: number;
  }>;
  findActiveBrowserSessionForWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<BrowserSessionRecord | null>;
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
  getWorkspaceForOwner(
    workspaceId: WorkspaceId,
    ownerId: UserId,
  ): Promise<{ readonly id: WorkspaceId; readonly kind: "main" | "specialized" } | null>;
  listBrowserProfiles(ownerId: UserId): Promise<readonly BrowserProfileRecord[]>;
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
    readonly allOwnerWorkspaces: boolean;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly BrowserSessionWithAttachmentCountRecord[]>;
  listActiveBrowserProfileGrants(ownerId: UserId): Promise<readonly ActiveBrowserProfileGrant[]>;
  listActiveBrowserProfileGrantsForWorkspace(
    workspaceId: WorkspaceId,
    ownerId: UserId,
  ): Promise<readonly ActiveBrowserProfileGrant[]>;
  listBrowserSessions(ownerId: UserId): Promise<readonly BrowserSessionRecord[]>;
  /** The conversations using each session that the reader can open, bounded per session. */
  listBrowserSessionThreads(input: {
    readonly ownerId: UserId;
    readonly sessionIds: readonly BrowserSessionId[];
  }): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>>;
  transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly session: BrowserSessionRecord;
  }>;
}

/** What a page showed when a conversation used it. */
export interface BrowserUsePage {
  readonly site: string;
  readonly title: string;
}

/** A conversation whose visible browser usage changed, and its Workspace. */
export interface BrowserUsageCredit {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  /** Its catalog conversation list changed through a first use or a revisit. */
  readonly joined: boolean;
  /** Sessions whose catalog changed; their viewers can span the conversation's Workspace. */
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

export interface BrowserRuntimeTarget {
  readonly placementKey: string;
  readonly runtimeId: string;
  readonly main?: boolean;
  readonly localProfileStorage?: { storageInstanceId: string; engine: "electron" | "chromium" };
  /** The Runtime accepts `state.import`; one that predates it is never sent the frame. */
  readonly stateImport?: boolean;
  /** The Runtime stages page-bound files; one that predates it cannot receive any. */
  readonly fileStaging?: boolean;
  /** The Runtime authorizes and fills saved logins (`login.*`, version 3). */
  readonly signIn?: boolean;
  /** The Runtime enforces the agent CDP boundary; agents get no CDP on one without it. */
  readonly cdpBoundary?: boolean;
  /** Shared pages, dialog IDs, view following and the attach ticket's initial size. */
  readonly sharedControl?: boolean;
  /** The Runtime observes a target without starting a screencast. */
  readonly targetControl?: boolean;
  readonly navigationVersion?: boolean;
  readonly navigationAttributionVersion?: boolean;
  readonly workspaceTabRestoreVersion?: boolean;
  readonly captureRegion?: boolean;
  readonly rasterDemand?: boolean;
  readonly passkeys?: boolean;
  readonly editing?: 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  /** The computer whose Runner relays this Runtime, as this Deployment names it. */
  readonly computer?: { readonly name: string; readonly runnerId: RunnerId };
  connect(ticket: string): BrowserRuntimeConnection;
}

export type BrowserRuntimePlacement = BrowserPlacement;

export interface BrowserRuntimeTargetResolver {
  placements(): readonly BrowserRuntimePlacement[];
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
 * The identity a Browser Session opens with, mirroring the workspace start body.
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
  readonly initialSurfaceId?: BrowserSurfaceId;
  readonly dormantSurfaceIds?: readonly BrowserSurfaceId[];
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly agentBindingId?: string;
  readonly threadId?: ThreadId;
  /**
   * A machine the caller named. Unlike `environmentId`, which only expresses
   * where the work already is, this one is a decision: the session lands on
   * that machine's browser or the call is refused.
   */
  readonly chosenEnvironmentId?: EnvironmentId;
  readonly environmentId?: EnvironmentId;
  readonly initialUrl?: string;
  readonly origin?: "agent" | "trigger" | "workspace";
  readonly ownerId: UserId;
  readonly placement?: BrowserPlacementSelector;
  readonly reuseExisting?: boolean;
  /** The size of the view a person starts the browser from; its first page opens at it. */
  readonly viewport?: { readonly height: number; readonly width: number };
  readonly workspaceId: WorkspaceId;
} & BrowserSessionIdentityInput;

/** A live session as a Chrome sign-in sees it. */
export interface BrowserSignInTarget {
  readonly tabId?: BrowserSurfaceId;
  readonly sessionId: BrowserSessionId;
  /** The session's own Workspace: the one a signed-in site is remembered for. */
  readonly workspaceId: WorkspaceId;
  /** A profile-backed session shares its browser context with every session on the profile. */
  readonly profileId: BrowserProfileId | null;
  readonly profileName: string | null;
  readonly live: boolean;
  readonly stateImport: boolean;
  /** The session's browser runs saved-password sign-ins on its computer. */
  readonly signIn: boolean;
  /** The computer that runs the session's browser, when a Runner relays it. */
  readonly computer: { readonly name: string; readonly runnerId: RunnerId } | null;
}

export type ApplySiteCookiesResult = "applied" | "session-closed" | "runtime-outdated";

export interface StartBrowserSessionResult {
  readonly session: HostedBrowserSession;
  readonly wasExisting: boolean;
}

type BrowserCdpRequest = Extract<BrowserClientMessage, { readonly type: "cdp.command" }>;
type BrowserCdpResponse = Extract<BrowserServerMessage, { readonly type: "cdp.result" }>;
type BrowserCdpWireResponse = Extract<
  BrowserServerMessage,
  { readonly type: "cdp.error" | "cdp.result" }
>;

interface BrowserServiceOptions {
  readonly hostOrigin: URL;
  readonly personal?: boolean;
  readonly history?: BrowserHistoryStore;
  readonly onHistoryChanged?: (ownerId: UserId, profileId: BrowserProfileId) => void;
  readonly passkeys?: boolean;
  readonly passkeyOwnOrigins?: () => readonly string[];
  readonly onProfilesChanged?: (ownerId: UserId, workspaceId: WorkspaceId) => void;
  readonly workspaceTabs?: WorkspaceTabStore;
  readonly tabGroups?: BrowserTabGroupStore;
  readonly onCatalogChanged?: (sessionId: BrowserSessionId, workspaceId: WorkspaceId) => void;
  readonly onPlaceNotice?: (
    ownerId: UserId,
    notice:
      PlaceActivityNotice | { type: "host.thread-place-changed"; reference: ThreadPlaceReference },
  ) => void;
  readonly connectTimeoutMs?: number;
  /**
   * Announces that viewers' browser catalogs changed in this Workspace.
   *
   * The list reaches a client through the HTTP bootstrap, which it re-reads on
   * a poll — so without this an agent-opened browser stays invisible for the
   * length of that interval.
   */
  readonly onSessionsChanged: (
    workspaceId: WorkspaceId,
    sessionIds: readonly BrowserSessionId[],
    source: BootstrapNoticeSource,
  ) => void;
  /**
   * What a person sees about one browser changed: its page, or whether an
   * agent is acting in it. These change often, so they never reread a list.
   */
  readonly onPresenceChanged?: (change: {
    readonly presence: BrowserPresence;
    readonly workspaceId: WorkspaceId;
  }) => void;
  /** Conversations whose visible browser usage changed. */
  readonly onUsageChanged?: (credits: readonly BrowserUsageCredit[]) => void;
  /** A best-effort write that failed after the agent was already answered. */
  readonly onError?: (error: unknown) => void;
  /** Drives activity expiry and native coalescing; browser commands and connection deadlines use real time. */
  readonly activityClock?: Clock;
  readonly actingWindowMs?: number;
  readonly actorMetadataTimeoutMs?: number;
  readonly onWorkspaceEvent: (event: AgentEvent) => void;
  readonly localProfiles?: BrowserLocalProfiles;
  readonly eraseLocalProfiles?: (runnerId: RunnerId) => Promise<void>;
  readonly repository: BrowserSessionRepository;
  readonly signer: BrowserAttachTicketSigner;
  readonly targetResolver?: BrowserRuntimeTargetResolver;
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
  lineageWorkspaceIds: readonly WorkspaceId[];
  readonly audience: Map<UserId, { threadId: ThreadId; home: boolean }>;
  readonly surfaces: Map<string, { at: number; seq: number; heldAt?: number }>;
  seq: number;
  lastSurfaceId: string | null;
}

export class BrowserService {
  readonly #nativeActivity = new Map<
    string,
    { activity: PlaceActivity; ownerId: UserId; title: string; timer: (() => void) | null }
  >();
  readonly #actors = new Map<string, BrowserActor>();
  readonly #actorKeys = new Map<string, string | null>();
  readonly #activityTimers = new Map<string, NodeJS.Timeout>();
  readonly #activityPending = new Map<
    string,
    { actor: BrowserActor; activity: BrowserRuntimeActivity; order: number; at: number }
  >();
  readonly #latestPlaces = new Map<UserId, Map<ThreadId, ThreadPlaceReference>>();
  readonly #history: BrowserHistoryStore | undefined;
  readonly #historyTails = new Map<BrowserProfileId, Promise<unknown>>();
  readonly #onHistoryChanged: NonNullable<BrowserServiceOptions["onHistoryChanged"]>;
  readonly #workspaceTabs: WorkspaceTabStore | undefined;
  readonly #tabGroups: BrowserTabGroupStore | undefined;
  readonly #endedCatalogs = new Map<BrowserSessionId, BrowserTabCatalog>();
  readonly #closeResults = new Map<
    string,
    { fingerprint: string; outcome: BrowserTabCloseResult["outcome"] }
  >();
  readonly #onProfilesChanged: NonNullable<BrowserServiceOptions["onProfilesChanged"]>;
  readonly #onCatalogChanged: NonNullable<BrowserServiceOptions["onCatalogChanged"]>;
  readonly #onPlaceNotice: NonNullable<BrowserServiceOptions["onPlaceNotice"]>;
  #placeOrder = 0;
  #placeSequence = 0;
  #authorityGeneration = 0;
  readonly #actorEpochs = new Map<string, number>();
  readonly #holdings = new Map<BrowserSessionId, ReadonlySet<string>>();
  readonly #actorResolutions = new Map<string, Promise<void>>();
  readonly #sessionOperations = new Map<string, Promise<unknown>>();
  /**
   * The tab each Run last entered, so only a move to another tab reaches the
   * database; the durable check there still holds across a Host restart.
   */
  readonly #runPlaces = new Map<string, string>();
  readonly #catalogNotices = new Map<BrowserSessionId, NodeJS.Timeout>();
  readonly #brokers = new Map<BrowserSessionId, HostedBrowserBroker>();
  #validateLoginLease:
    | ((input: {
        loginRef: string;
        sessionId: BrowserSessionId;
        workspaceId: WorkspaceId;
      }) => boolean)
    | undefined;
  readonly #passkeys: boolean;
  readonly #passkeyOwnOrigins: () => readonly string[];
  readonly #authConsumers = new Map<AuthSessionId, Set<BrowserConsumerPeer>>();
  readonly #connectTimeoutMs: number;
  readonly #onSessionsChanged: (
    workspaceId: WorkspaceId,
    sessionIds: readonly BrowserSessionId[],
    source: BootstrapNoticeSource,
  ) => void;
  readonly #onPresenceChanged: NonNullable<BrowserServiceOptions["onPresenceChanged"]>;
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
  /** What each session's viewers were last told, so a repeat is not sent. */
  readonly #announcedPresence = new Map<BrowserSessionId, string>();
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #repository: BrowserSessionRepository;
  readonly #localProfiles: BrowserLocalProfiles | undefined;
  readonly #eraseLocalProfiles: BrowserServiceOptions["eraseLocalProfiles"];
  readonly #sessionProfiles = new Map<BrowserSessionId, BrowserProfileId>();
  readonly #signer: BrowserAttachTicketSigner;
  readonly #targetResolver: BrowserRuntimeTargetResolver | undefined;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #operationTail = Promise.resolve();

  constructor(options: BrowserServiceOptions) {
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
    this.#workspaceTabs = options.workspaceTabs;
    this.#tabGroups = options.tabGroups;
    this.#onCatalogChanged = options.onCatalogChanged ?? (() => undefined);
    this.#onPlaceNotice = options.onPlaceNotice ?? (() => undefined);
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.#onSessionsChanged = options.onSessionsChanged;
    this.#onProfilesChanged = options.onProfilesChanged ?? (() => {});
    this.#onPresenceChanged = options.onPresenceChanged ?? (() => undefined);
    this.#onUsageChanged = options.onUsageChanged ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#activityClock = options.activityClock ?? systemClock;
    this.#actingWindowMs = options.actingWindowMs ?? browserActingWindowMs;
    this.#actorMetadataTimeoutMs = options.actorMetadataTimeoutMs ?? browserActorMetadataTimeoutMs;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#repository = options.repository;
    this.#signer = options.signer;
    this.#targetResolver = options.targetResolver;
  }

  get available(): boolean {
    return Boolean(this.#targetResolver) && !this.#closed;
  }

  async acknowledgeNativeProfileReady(
    profileId: BrowserProfileId,
    ticket: string,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    const claims = this.#signer.readNativeReady(ticket);
    const expiresAt = Date.parse(claims.operationExpiresAt);
    const remaining = Math.max(1, expiresAt - Date.now());
    const deadline = AbortSignal.timeout(remaining);
    const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
    await withDatabaseOperationSignal(signal, expiresAt, () =>
      withTimeout(
        (async () => {
          if (
            claims.identity.kind !== "profile-local" ||
            claims.identity.binding.profileId !== profileId ||
            !this.#localProfiles
          )
            throw new OpensteerError({
              code: "forbidden",
              message: "Native profile readiness authority does not match.",
            });
          const session = await this.#repository.getBrowserSessionForOwner(
            claims.sessionId,
            UserIdSchema.parse(claims.subject),
          );
          if (
            !session ||
            session.profileId !== profileId ||
            session.runnerId !== claims.identity.binding.runnerId ||
            session.runtimeId !== claims.runtimeId ||
            isTerminal(session.state)
          )
            throw new OpensteerError({
              code: "forbidden",
              message: "Native profile readiness session has ended.",
            });
          await this.#localProfiles.acknowledgeReady(claims.identity.binding);
        })(),
        remaining,
        {
          signal,
          timeoutError: () =>
            new OpensteerError({
              code: "conflict",
              reason: "browser-open.timeout",
              message: "Native profile readiness timed out. Retry opening the profile.",
            }),
        },
      ),
    );
  }
  async initialize(): Promise<void> {
    const failed = await this.#repository.failActiveBrowserSessions();
    await this.#workspaceTabs?.suspend();
    await this.#workspaceTabs?.prune();
    await this.#tabGroups?.prune();
    await this.pruneHistory();
    for (const event of failed.events) this.#onWorkspaceEvent(event);
  }

  async bootstrap(ownerId: UserId): Promise<HostedBrowserBootstrap> {
    const [profiles, sessions, grants] = await Promise.all([
      this.#repository.listBrowserProfiles(ownerId),
      this.#repository.listBrowserSessions(ownerId),
      this.#repository.listActiveBrowserProfileGrants(ownerId),
    ]);
    if (
      profiles.length > maxBrowserProfiles ||
      sessions.length > maxBrowserSessions ||
      grants.length > maxBrowserProfileGrants
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Browser catalog limit exceeded.",
      });
    }
    const sessionIds = sessions.map((session) => session.id);
    const [attachedRuns, threads, visibleOpeners] = await Promise.all([
      this.#repository.listAttachedRunIdsForBrowserSessions(sessionIds),
      this.#repository.listBrowserSessionThreads({ ownerId, sessionIds }),
      this.#visibleOpenerThreads(ownerId, sessions),
    ]);
    await Promise.all(sessions.map((session) => this.#restoreHoldings(session.id)));
    const [workspaceTabs, tabGroups] = await Promise.all([
      this.#workspaceTabs?.list(ownerId),
      this.#tabGroups?.layout(ownerId),
    ]);
    const bootstrap: HostedBrowserBootstrap = {
      ...(workspaceTabs ? { workspaceTabRestoreVersion: 1, workspaceTabs } : {}),
      ...(tabGroups ? { tabGroupsVersion: 1, tabGroups } : {}),
      ...(this.#localProfiles
        ? { profileDeletions: await this.#localProfiles.pendingDeletions(ownerId) }
        : {}),
      profileGrants: grants.map(publicProfileGrant),
      available: !this.#closed && this.#placements().some((placement) => placement.available),
      placements: this.#placements(),
      profiles: profiles.map(publicProfile),
      sessions: sessions.map((session) => ({
        tabCatalog: this.#catalog(ownerId, session.id),
        ...publicSession(session),
        navigationVersion: this.#brokers.get(session.id)?.navigationVersion,
        workspaceTabRestoreVersion: this.#workspaceTabs
          ? this.#brokers.get(session.id)?.workspaceTabRestoreVersion
          : undefined,
        opener: projectBrowserSessionOpener(session.opener ?? null, {
          userId: ownerId,
          visibleThreadIds: visibleOpeners,
        }),
        ...this.#presence(session.id),
        attachedRunIds: [...(attachedRuns.get(session.id) ?? [])],
        threadIds: [...(threads.get(session.id) ?? [])],
      })),
    };
    if (
      Buffer.byteLength(JSON.stringify(bootstrap.sessions), "utf8") >
      browserBootstrapSessionsMaxBytes
    ) {
      for (const session of bootstrap.sessions) {
        delete session.tabCatalog;
      }
    }
    if (
      workspaceTabs &&
      Buffer.byteLength(JSON.stringify(workspaceTabs), "utf8") > browserBootstrapSessionsMaxBytes
    )
      for (const group of workspaceTabs) delete group.tabs;
    return bootstrap;
  }

  async readWorkspaceTabs(
    ownerId: UserId,
    groupId: BrowserSessionId,
  ): Promise<WorkspaceTabLineage> {
    const resolved = (await this.#workspaceTabs?.lineageForSession(groupId)) ?? groupId;
    const group = await this.#workspaceTabs?.read(ownerId, resolved);
    if (!group) throw new OpensteerError({ code: "not_found", message: "Browser tabs not found." });
    return group;
  }

  activateWorkspaceTab(ownerId: UserId, tabId: BrowserSurfaceId) {
    return this.#activateWorkspaceTab(ownerId, tabId);
  }

  async restoreAgentWorkspaceTab(
    input: {
      readonly ownerId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly agentBindingId: string;
    },
    tabId: BrowserSurfaceId,
  ) {
    const restored = await this.#activateWorkspaceTab(input.ownerId, tabId, input);
    return { tabId, sessionId: restored.session.id };
  }

  async #activateWorkspaceTab(
    ownerId: UserId,
    tabId: BrowserSurfaceId,
    agent?: {
      readonly ownerId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly agentBindingId: string;
    },
  ) {
    const tabs = this.#workspaceTabs;
    const initial = await tabs?.get(ownerId, tabId);
    if (!tabs || !initial)
      throw new OpensteerError({ code: "not_found", message: "Browser tab not found." });
    return this.#serializeKey(`group:${initial.groupId}`, async () => {
      const row = await tabs.get(ownerId, tabId);
      const previous = await tabs.session(ownerId, initial.groupId);
      if (!row || !previous)
        throw new OpensteerError({ code: "not_found", message: "This tab has closed." });
      await this.#workspaceTabRestoreAccess(ownerId, initial.groupId, row.url);
      if (agent && !(await this.agentMayAccessSession(agent, previous)))
        throw new OpensteerError({
          code: "forbidden",
          message: "This tab is not a saved tab you can reach.",
        });
      const url = row.url;
      let sessionId = previous.id;
      let broker = this.#brokers.get(sessionId);
      if (!broker?.live) {
        sessionId = createBrowserSessionId();
        const dormantSurfaceIds =
          (await this.readWorkspaceTabs(ownerId, initial.groupId)).tabs
            ?.filter((tab) => tab.id !== tabId)
            .map((tab) => tab.id) ?? [];
        const finish = await this.#serializeKey(
          `start:${ownerId}:${previous.profileId ?? previous.id}`,
          () =>
            this.#prepareStart({
              sessionId,
              tabGroupId: initial.groupId,
              initialSurfaceId: tabId,
              dormantSurfaceIds,
              ...(url === "about:blank" ? {} : { initialUrl: url }),
              ownerId,
              workspaceId: previous.workspaceId,
              placement: placementOf(previous),
              ...(previous.profileId ? { profileId: previous.profileId } : { fresh: true }),
              origin: previous.origin,
              opener: previous.opener ?? null,
            }),
        );
        await finish();
        broker = this.#brokers.get(sessionId);
      } else if (!broker.catalog(() => []).tabs.some((tab) => tab.id === tabId)) {
        await tabs.bind(initial.groupId, sessionId, tabId);
        if (row.favicon) broker.restoreIcon(tabId, row.url, row.favicon);
        await broker.requestCdp({
          type: "cdp.command",
          requestId: randomUUID(),
          command: {
            method: browserHostMethods.openTab,
            parameters: {
              idempotencyKey: `restore:${tabId}`,
              surfaceId: tabId,
              ...(url === "about:blank" ? {} : { url }),
            },
          },
        });
      }
      if (!(await tabs.get(ownerId, tabId))) {
        if (broker?.live)
          await this.#disposeWorkspaceTab(ownerId, previous.workspaceId, sessionId, tabId, broker);
        throw new OpensteerError({ code: "not_found", message: "This tab has closed." });
      }
      await this.#flushCatalogNotice(sessionId, previous.workspaceId);
      const session = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
      if (!session || !broker?.live) throw unavailable("The browser computer disconnected.");
      if (agent) {
        if (!(await this.agentMayAccessSession(agent, session)))
          throw new OpensteerError({
            code: "forbidden",
            message: "This tab is not a saved tab you can reach.",
          });
        await this.#holdForAgent(agent, session);
      }
      return {
        type: "workspace.tab.activate" as const,
        group: await this.readWorkspaceTabs(ownerId, initial.groupId),
        session: await this.#personSession(session, ownerId),
        tabId,
        catalog: this.#catalog(ownerId, sessionId),
      };
    });
  }

  async #workspaceTabRestoreAccess(
    ownerId: UserId,
    groupId: BrowserSessionId,
    url: string,
    database?: WorkspaceTabStore["database"],
  ) {
    const tabs = database ? new WorkspaceTabStore(database) : this.#workspaceTabs;
    const repository = database ? new OpensteerStore(database) : this.#repository;
    const previous = await tabs?.session(ownerId, groupId);
    if (!previous)
      throw new OpensteerError({ code: "not_found", message: "Browser tabs not found." });
    const group = await tabs?.read(ownerId, groupId, database);
    if (!group) throw new OpensteerError({ code: "not_found", message: "Browser tabs not found." });
    if (group.unavailableReason)
      throw new OpensteerError({ code: "conflict", message: group.unavailableReason });
    if (previous.profileId && !(await repository.getBrowserProfile(previous.profileId, ownerId)))
      throw new OpensteerError({
        code: "not_found",
        message: "This browser profile is no longer available.",
      });
    if (url !== "about:blank" && !/^https?:\/\//i.test(url))
      throw new OpensteerError({
        code: "conflict",
        message: "This page address cannot be reopened.",
      });
    const target = this.#resolveTarget(placementOf(previous));
    if (!target)
      throw new OpensteerError({
        code: "runner_offline",
        reason: "browser-placement-waiting",
        retryable: true,
        message: "Waiting for this browser computer to connect.",
      });
    if (!target.workspaceTabRestoreVersion)
      throw new OpensteerError({
        code: "conflict",
        message: "Update this browser computer to reopen tabs.",
      });
  }

  async reopenWorkspaceTab(ownerId: UserId, idempotencyKey: string) {
    const tabs = this.#workspaceTabs;
    if (!tabs || !this.#tabGroups)
      throw new OpensteerError({ code: "not_found", message: "No recently closed tab to reopen." });
    const row = await tabs.reopen(
      ownerId,
      async (source, database) => {
        await this.#workspaceTabRestoreAccess(ownerId, source.groupId, source.url, database);
      },
      idempotencyKey,
    );
    const group = await this.readWorkspaceTabs(ownerId, row.groupId);
    this.#onSessionsChanged(group.session.workspaceId, [group.session.id], "browser.tabs");
    return {
      type: "workspace.tab.reopen" as const,
      tabId: BrowserSurfaceIdSchema.parse(row.id),
      group,
      layout: await this.#tabGroups.layout(ownerId),
    };
  }

  async closeWorkspaceTab(ownerId: UserId, tabId: BrowserSurfaceId, person = true) {
    const row = await this.#workspaceTabs?.close(ownerId, tabId, person);
    if (!row) throw new OpensteerError({ code: "not_found", message: "Browser tab not found." });
    // Closing commits before joining activation's turn, so a late open must dispose its page.
    await this.#serializeKey(`group:${row.groupId}`, async () => {
      const session = await this.#workspaceTabs!.session(ownerId, row.groupId);
      const broker = session ? this.#brokers.get(session.id) : undefined;
      if (session && broker?.live)
        await this.#disposeWorkspaceTab(ownerId, session.workspaceId, session.id, tabId, broker);
      if (session) this.#onSessionsChanged(session.workspaceId, [session.id], "browser.tabs");
    });
    return {
      type: "workspace.tab.close" as const,
      group: await this.readWorkspaceTabs(ownerId, row.groupId),
    };
  }

  async #disposeWorkspaceTab(
    ownerId: UserId,
    workspaceId: WorkspaceId,
    sessionId: BrowserSessionId,
    tabId: BrowserSurfaceId,
    broker: HostedBrowserBroker,
  ): Promise<void> {
    // The durable lane closes by stable ID, live or dormant, without the inventory fence.
    const response = await broker.requestCdp({
      type: "cdp.command",
      requestId: randomUUID(),
      command: {
        method: browserHostMethods.closeTab,
        parameters: {
          surfaceId: tabId,
          inventoryRevision: broker.inventoryRevision,
          durable: true,
        },
      },
    });
    const { outcome } = z
      .object({ outcome: z.enum(["tab-closed", "session-closed"]) })
      .parse(response.result);
    if (outcome === "session-closed") {
      const record = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
      if (record) await this.#stopRecord(record);
    }
    await this.#flushCatalogNotice(sessionId, workspaceId, broker);
  }

  async createProfile(input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly idempotencyKey: string;
    /**
     * The Workspace the change was made from, which addresses the owner's
     * notice. The person's own command names none: their client applies the
     * command's result itself.
     */
    readonly workspaceId: WorkspaceId | null;
  }): Promise<BrowserProfile> {
    const profile = await this.#repository.createBrowserProfile(input);
    if (input.workspaceId) this.#onProfilesChanged(input.ownerId, input.workspaceId);
    return publicProfile(profile);
  }

  async renameProfile(input: {
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
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<PendingBrowserProfileDeletion | undefined> {
    const { sessionIds, deletion } = await this.#serializeKey(
      `profile-admission:${input.profileId}`,
      () => this.#repository.deleteBrowserProfile(input),
    );
    this.invalidatePlaceAuthority();
    const stops = await Promise.allSettled(
      sessionIds.map((sessionId) => this.stop(input.ownerId, sessionId)),
    );
    for (const stop of stops) if (stop.status === "rejected") this.#onError(stop.reason);
    if (deletion) await this.#eraseLocalProfiles?.(deletion.computerId).catch(() => undefined);
    await this.#ownerProfilesChanged(input.ownerId);
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

  /** Every device of the owner rereads its profiles, whichever Workspace it follows. */
  async #ownerProfilesChanged(ownerId: UserId): Promise<void> {
    const main = await this.#repository.findMainWorkspaceForOwner(ownerId);
    if (main) this.#onProfilesChanged(ownerId, main.id);
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
    const finish = await this.#prepareStart(
      input,
      undefined,
      personNavigation ? { ownerId: input.ownerId, typed: personNavigation.typed } : undefined,
    );
    const result = await finish();
    if (input.threadId) {
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
        tabCatalog: this.#catalog(input.ownerId, result.session.id),
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
    readonly pages: readonly {
      readonly sessionId: BrowserSessionId;
      readonly title: string;
      readonly url: string;
    }[];
    readonly workspaceId: WorkspaceId;
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
      if (!(await this.agentMayAccessSession(input, record))) {
        throw new OpensteerError({
          code: "forbidden",
          message: `This message includes the browser page "${label}" from a browser this conversation's Workspace can't use. Remove the page, or send it from a conversation in that browser's Workspace or in Main.`,
        });
      }
    }
  }

  #catalog(ownerId: UserId, sessionId: BrowserSessionId): BrowserTabCatalog {
    const broker = this.#brokers.get(sessionId);
    if (!broker)
      return this.#endedCatalogs.get(sessionId) ?? { generation: 0, revision: 0, tabs: [] };
    return broker.catalog((surfaceId) => {
      const occupants = new Map<ThreadId, PlaceOccupant>();
      for (const actor of this.#actors.values()) {
        if (actor.sessionId !== sessionId) continue;
        const identity = actor.audience.get(ownerId);
        const use = actor.surfaces.get(surfaceId);
        if (!identity || !use) continue;
        const holding =
          this.#holdings.get(sessionId)?.has(`${actor.binding}:${surfaceId}`) === true;
        const acting = this.#activityClock.now() - use.at < this.#actingWindowMs;
        if (!holding && !acting) continue;
        const previous = occupants.get(identity.threadId);
        occupants.set(identity.threadId, {
          threadId: identity.threadId,
          home: identity.home,
          holding: holding || previous?.holding === true,
          acting: acting || previous?.acting === true,
          lastActiveAt: new Date(
            Math.max(use.at, use.heldAt ?? 0, previous ? Date.parse(previous.lastActiveAt) : 0),
          ).toISOString(),
        });
      }
      return [...occupants.values()];
    }, ownerId);
  }

  async readTabCatalog(ownerId: UserId, sessionId: BrowserSessionId): Promise<BrowserTabCatalog> {
    const record = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
    if (!record || (this.#workspaceTabs && isTerminal(record.state)))
      throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
    await this.#restoreHoldings(sessionId);
    return this.#catalog(ownerId, sessionId);
  }

  async readTabIcon(
    ownerId: UserId,
    input: BrowserTabIconInput,
  ): Promise<{ favicon: string | null }> {
    if (this.#workspaceTabs) {
      const groupId = await this.#workspaceTabs.lineageForSession(input.sessionId);
      const session = groupId ? await this.#workspaceTabs.session(ownerId, groupId) : null;
      if (!session)
        throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
      if (session.id !== input.sessionId) return { favicon: null };
    } else if (!(await this.#repository.getBrowserSessionForOwner(input.sessionId, ownerId))) {
      throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
    }
    const broker = this.#brokers.get(input.sessionId);
    return {
      favicon:
        (broker?.live ? broker.icon(input.iconRef) : null) ??
        (await this.#workspaceTabs?.icon(ownerId, input.sessionId, input.iconRef)) ??
        null,
    };
  }

  async readContextCandidate(
    ownerId: UserId,
    input: BrowserContextCandidateInput,
  ): Promise<BrowserContextCandidate> {
    await this.readTabCatalog(ownerId, input.sessionId);
    const broker = this.#brokers.get(input.sessionId);
    if (!broker?.live || !broker.targetedStreaming)
      throw new OpensteerError({
        code: "conflict",
        message: "Update the browser computer to read this page.",
      });
    const response = await broker.requestCdp({
      type: "cdp.command",
      requestId: randomUUID(),
      command: {
        method: browserHostMethods.contextCandidate,
        parameters: { surfaceId: input.tabId },
      },
    });
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
  }

  async #resolveIdentityOpen(
    ownerId: UserId,
    command: {
      identity: NonNullable<BrowserTabOpenCommand["identity"]>;
      placement?: BrowserTabOpenCommand["placement"];
    },
  ) {
    const workspace = await this.#repository.findMainWorkspaceForOwner(ownerId);
    if (!workspace)
      throw new OpensteerError({ code: "not_found", message: "Main Workspace not found." });
    const profileId = command.identity.kind === "profile" ? command.identity.profileId : null;
    const identityKey = profileId ?? "guest";
    if (profileId && !(await this.#repository.getBrowserProfile(profileId, ownerId)))
      throw this.#tabOpenRefusal(
        "browser-profile-unavailable",
        "That browser profile is unavailable. Choose a profile.",
      );
    const storage =
      profileId && this.#localProfiles
        ? await this.#localProfiles.storage(profileId)
        : { kind: "unbound" as const };
    const boundRunnerId = storage.kind === "unbound" ? undefined : storage.binding.runnerId;
    if (boundRunnerId && command.placement && command.placement.runnerId !== boundRunnerId)
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        "This profile belongs to another computer. Open it on its owning computer.",
      );
    const holder = profileId
      ? await this.#repository.findBrowserSessionHoldingProfilePlacement(profileId)
      : null;
    if (holder && command.placement && !samePlacement(command.placement, placementOf(holder)))
      throw this.#tabOpenRefusal(
        "browser-placement-unavailable",
        "That profile is already held on another computer. Choose that computer or close its browser first.",
      );
    const remembered =
      !command.placement && !holder
        ? await this.#repository.rememberedBrowserPlacement(ownerId, identityKey)
        : null;
    const eligible = this.#placements().filter((candidate) => candidate.available);
    let placement =
      (boundRunnerId ? { kind: "runner" as const, runnerId: boundRunnerId } : command.placement) ??
      (holder
        ? placementOf(holder)
        : remembered
          ? { kind: "runner" as const, runnerId: remembered }
          : null);
    if (!placement) {
      if (eligible.length > 1)
        throw this.#tabOpenRefusal(
          "browser-placement-ambiguous",
          "Choose which computer should open this browser.",
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
      );
    return {
      workspace,
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
    input: { profileId: BrowserProfileId; idempotencyKey: string; url?: string },
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

  async openTab(ownerId: UserId, input: BrowserTabOpenCommand): Promise<BrowserTabOpenResult> {
    const expiresAt = Date.now() + 20_000;
    const cancellation = new AbortController();
    const budget: BrowserTabOpenBudget = {
      signal: cancellation.signal,
      expiresAt: expiresAt - 2_000,
    };
    const timeout = () =>
      new OpensteerError({
        code: "conflict",
        message: "Opening this browser timed out. Retry to open a new page.",
        reason: "browser-open.timeout",
      });
    const timer = setTimeout(() => cancellation.abort(timeout()), 18_000);
    timer.unref?.();
    try {
      return await withDatabaseOperationSignal(budget.signal, budget.expiresAt, () =>
        withTimeout(this.#openTab(ownerId, input, budget), 18_000, {
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
          "Opening did not confirm its outcome. Retry this request to recover its original page.",
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
                    from: ["starting", "ready", "closing"],
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
          if (settled?.outcome.kind === "failed") throw this.#tabOpenFailure(settled);
        } catch (settlementError) {
          if (
            settlementError instanceof OpensteerError &&
            settlementError.reason === "browser-tab-open-failed"
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
    }
  }

  #openTab(
    ownerId: UserId,
    input: BrowserTabOpenCommand,
    budget: BrowserTabOpenBudget,
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
          const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
          let binding = await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey);
          if (binding) {
            if (binding.requestFingerprint !== fingerprint)
              throw new OpensteerError({
                code: "conflict",
                message: "Idempotency key already used.",
              });
            if (binding.outcome.kind === "pending") budget.admitted = binding;
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
            const resolved = await this.#resolveIdentityOpen(ownerId, {
              identity: command.identity!,
              ...(command.placement ? { placement: command.placement } : {}),
            });
            const { workspace, profileId, placement } = resolved;
            identityKey = resolved.identityKey;
            runnerId = placement.runnerId;
            const sessions = await this.#repository.listBrowserSessions(ownerId);
            record =
              sessions
                .filter(
                  (candidate) =>
                    candidate.workspaceId === workspace.id &&
                    candidate.state === "ready" &&
                    candidate.origin === "workspace" &&
                    candidate.opener?.kind === "person" &&
                    candidate.opener.userId === ownerId &&
                    candidate.profileId === profileId &&
                    samePlacement(placement, placementOf(candidate)) &&
                    this.#brokers.get(candidate.id)?.live,
                )
                .sort(
                  (left, right) =>
                    left.createdAt.getTime() - right.createdAt.getTime() ||
                    left.id.localeCompare(right.id),
                )[0] ?? null;
            if (!record)
              opening = {
                ownerId,
                workspaceId: workspace.id,
                placement,
                sessionId: createBrowserSessionId(),
                ...(profileId ? { profileId } : { fresh: true as const }),
                ...(command.url ? { initialUrl: command.url } : {}),
                ...(command.viewport ? { viewport: command.viewport } : {}),
              };
          }
          budget.signal.throwIfAborted();
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
          admitted = binding;
          budget.admitted = binding;
          await this.#repository.bindBrowserTabOpen({ binding, identityKey, runnerId });
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
              command.url ? { ownerId, typed: command.typed === true } : undefined,
            );
            const openingBinding = binding;
            pendingFinish = async () => {
              await finish();
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
                `identity:${ownerId}:${command.identity.kind === "profile" ? command.identity.profileId : "guest"}`,
                selectAndStart,
              );
        return await this.#resumeTabOpen(ownerId, command, binding, budget);
      } catch (error) {
        // Initial-start failures close their exact broker before reaching here.
        // An additional page can fail definitively only on the Runtime's reply;
        // a missing response retains its key and uncertain outcome.
        if (admitted && (admitted.browserStarted || error instanceof BrowserCdpRefusal)) {
          await this.#repository.settleBrowserTabOpen({
            ...admitted,
            outcome: { kind: "failed", reason: "failed" },
          });
          const settled = await this.#repository.getBrowserTabOpen(ownerId, command.idempotencyKey);
          if (settled?.outcome.kind === "failed") throw this.#tabOpenFailure(settled);
        }
        throw error;
      }
    });
  }

  #tabOpenFailure(binding: BrowserTabOpenBinding): OpensteerError {
    return this.#tabOpenRefusal(
      "browser-tab-open-failed",
      binding.outcome.kind === "failed" && binding.outcome.reason === "interrupted"
        ? "Opening was interrupted by a Host restart. Retry to open a new page."
        : "The browser could not open this page. Retry to open a new page.",
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
      "The browser session has ended. Open a new browser.",
    );
  }

  #tabOpenRefusal(reason: BrowserTabOpenRefusalReason, message: string): OpensteerError {
    return new OpensteerError({
      code: "conflict",
      reason,
      message,
      details: BrowserTabOpenRefusalDetailsSchema.parse({ placements: this.#placements() }),
      retryable: reason === "browser-session-unavailable",
    });
  }

  async #resumeTabOpen(
    ownerId: UserId,
    command: BrowserTabOpenCommand,
    binding: BrowserTabOpenBinding,
    budget: BrowserTabOpenBudget,
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
      if (binding.outcome.kind !== "opened") {
        this.#requireOpenableSession(record);
        // A submitted initial page cannot be repeated after an uncertain start.
        if (binding.browserStarted)
          throw this.#tabOpenRefusal(
            "browser-tab-open-outcome-unknown",
            "The original page outcome is unknown. Inspect the browser before opening another page.",
          );
        const broker = this.#brokers.get(record.id);
        if (!broker?.live || !broker.targetedStreaming)
          throw this.#tabOpenRefusal(
            "browser-session-unavailable",
            "This browser is not ready to open a page. Try again shortly.",
          );
        const navigationId = command.url
          ? broker.beginHistoryNavigation(ownerId, command.typed === true)
          : undefined;
        budget.pageRequested = true;
        const response = await broker.requestCdp({
          type: "cdp.command",
          requestId: randomUUID(),
          ...(navigationId ? { navigationId } : {}),
          command: {
            method: browserHostMethods.openTab,
            parameters: {
              operationAuthority: this.#signer.issue({
                access: "full-control",
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
        });
        const { tabId } = z.object({ tabId: BrowserSurfaceIdSchema }).parse(response.result);
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
      await this.#flushCatalogNotice(record.id, record.workspaceId);
      const visible = await this.#visibleOpenerThreads(ownerId, [record]);
      return {
        type: "browser.tab.open",
        sessionId: record.id,
        browserStarted: binding.browserStarted,
        session: {
          ...publicSession(record),
          navigationVersion: this.#brokers.get(record.id)?.navigationVersion,
          workspaceTabRestoreVersion: this.#workspaceTabs
            ? this.#brokers.get(record.id)?.workspaceTabRestoreVersion
            : undefined,
          opener: projectBrowserSessionOpener(record.opener ?? null, {
            userId: ownerId,
            visibleThreadIds: visible,
          }),
        },
        tabId: binding.outcome.tabId,
        catalog: this.#catalog(ownerId, record.id),
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
      workspaceTabRestoreVersion: this.#workspaceTabs
        ? this.#brokers.get(record.id)?.workspaceTabRestoreVersion
        : undefined,
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

  closeTab(ownerId: UserId, command: BrowserTabCloseCommand): Promise<BrowserTabCloseResult> {
    return this.#serializeKey(command.sessionId, async () => {
      const key = `${ownerId}:${command.idempotencyKey}`;
      const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const previous = this.#closeResults.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new OpensteerError({ code: "conflict", message: "Idempotency key already used." });
        await this.readTabCatalog(ownerId, command.sessionId);
        return {
          type: "browser.tab.close",
          sessionId: command.sessionId,
          outcome: previous.outcome,
          catalog: this.#catalog(ownerId, command.sessionId),
        };
      }
      const catalog = await this.readTabCatalog(ownerId, command.sessionId);
      const broker = this.#brokers.get(command.sessionId);
      if (!broker?.live || !broker.targetedStreaming)
        throw new OpensteerError({
          code: "conflict",
          message: "The browser computer is unavailable or needs an update.",
        });
      if (
        catalog.generation !== command.expectedGeneration ||
        (catalog.inventoryRevision ?? catalog.revision) !== command.expectedRevision
      )
        throw new OpensteerError({
          code: "conflict",
          reason: staleBrowserTabInventoryReason,
          message: "The browser tabs changed. Review them before closing.",
        });
      const response = await broker
        .requestCdp({
          type: "cdp.command",
          requestId: randomUUID(),
          command: {
            method: browserHostMethods.closeTab,
            parameters: {
              surfaceId: command.surfaceId,
              inventoryRevision: broker.inventoryRevision,
            },
          },
        })
        .catch((error: unknown) => {
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
      await this.#workspaceTabs?.close(ownerId, command.surfaceId, false);
      if (outcome === "session-closed") {
        const record = await this.#repository.getBrowserSessionForOwner(command.sessionId, ownerId);
        if (record) await this.#stopRecord(record);
      }
      const result: BrowserTabCloseResult = {
        type: "browser.tab.close",
        sessionId: command.sessionId,
        outcome,
        catalog: this.#catalog(ownerId, command.sessionId),
      };
      this.#closeResults.set(key, { fingerprint, outcome });
      if (this.#closeResults.size > 1_000)
        this.#closeResults.delete(this.#closeResults.keys().next().value!);
      return result;
    });
  }

  noteNativeActivity(input: {
    ownerId: UserId;
    threadId: ThreadId;
    home: boolean;
    runId: RunId;
    generation: number;
    place: PlaceIdentity;
    title: string;
    at: number;
    ended: boolean;
  }): void {
    const key = `${placeIdentityKey(input.place)}:${input.runId}:${input.generation}`;
    const previous = this.#nativeActivity.get(key);
    const seq = ++this.#placeSequence;
    if (input.ended) {
      previous?.timer?.();
      this.#nativeActivity.delete(key);
      this.#onPlaceNotice(input.ownerId, {
        type: "host.place-activity-cleared",
        place: input.place,
        runId: input.runId,
        generation: input.generation,
        seq,
      });
      return;
    }
    const entry = {
      ownerId: input.ownerId,
      title: input.title,
      timer: previous?.timer ?? null,
      activity: {
        place: input.place,
        threadId: input.threadId,
        home: input.home,
        runId: input.runId,
        generation: input.generation,
        seq,
        order: ++this.#placeOrder,
        at: input.at,
        expiresAt: input.at + this.#actingWindowMs,
        geometryRevision: 0,
        pointer: null,
      } satisfies PlaceActivity,
    };
    const reference: ThreadPlaceReference = {
      threadId: entry.activity.threadId,
      runId: entry.activity.runId,
      place: entry.activity.place,
      title: entry.title,
      site: null,
      iconRef: null,
      order: entry.activity.order,
      at: new Date(entry.activity.at).toISOString(),
    };
    const latest =
      this.#latestPlaces.get(entry.ownerId) ?? new Map<ThreadId, ThreadPlaceReference>();
    if ((latest.get(entry.activity.threadId)?.order ?? -1) > entry.activity.order) return;
    latest.delete(entry.activity.threadId);
    latest.set(entry.activity.threadId, reference);
    if (latest.size > 4096) latest.delete(latest.keys().next().value!);
    this.#latestPlaces.set(entry.ownerId, latest);
    this.#onPlaceNotice(entry.ownerId, { type: "host.thread-place-changed", reference });
    this.#nativeActivity.set(key, entry);
    if (entry.timer) return;
    entry.timer = this.#activityClock.schedule(() => {
      const current = this.#nativeActivity.get(key);
      if (!current) return;
      current.timer = null;
      const activity = current.activity;
      this.#onPlaceNotice(current.ownerId, { type: "host.place-activity", activity });
    }, 100);
  }

  async latestPlaces(ownerId: UserId): Promise<readonly ThreadPlaceReference[]> {
    const latest = new Map(
      ((await this.#repository.latestNativePlaces?.(ownerId)) ?? []).map((reference) => [
        reference.threadId,
        reference,
      ]),
    );
    for (const reference of this.#latestPlaces.get(ownerId)?.values() ?? []) {
      if ((latest.get(reference.threadId)?.at ?? "") <= reference.at)
        latest.set(reference.threadId, reference);
    }
    const references = [...latest.values()];
    if (references.length === 0) return [];
    const [threads, sessions, owners] = await Promise.all([
      this.#repository.authorizedPlaceThreadIds?.(
        ownerId,
        references.map(({ threadId }) => threadId),
      ) ?? [],
      this.#repository.listBrowserSessions(ownerId),
      this.#repository.effectiveMachineOwners?.(
        references.flatMap(({ place }) => (place.kind === "browser" ? [] : [place.machineId])),
      ) ?? new Map<RunnerId, { readonly effectiveOwner: UserId | null }>(),
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

  invalidatePlaceAuthority(workspaceId?: WorkspaceId, threadIds?: readonly ThreadId[]): void {
    // Pending lineage reads have no known scope yet; fence them without clearing live actors.
    this.#authorityGeneration++;
    for (const [key, token] of this.#actorKeys) if (token === null) this.#actorKeys.delete(key);
    for (const actor of this.#actors.values()) {
      const broker = this.#brokers.get(actor.sessionId);
      if (
        threadIds
          ? !threadIds.some((threadId) => actor.lineageThreadIds.includes(threadId))
          : workspaceId &&
            broker?.workspaceId !== workspaceId &&
            !actor.lineageWorkspaceIds.includes(workspaceId)
      )
        continue;
      const key = `${actor.sessionId}:${actor.binding}`;
      this.#actorEpochs.set(key, (this.#actorEpochs.get(key) ?? 0) + 1);
      this.#actorKeys.delete(key);
      this.#startActorResolution(
        { agentBindingId: actor.binding, ownerId: actor.ownerId },
        actor.sessionId,
      );
      if (broker) this.#queueCatalogNotice(actor.sessionId, broker.workspaceId);
    }
    if (workspaceId && !threadIds)
      for (const [sessionId, broker] of this.#brokers)
        if (broker.workspaceId === workspaceId) this.#queueCatalogNotice(sessionId, workspaceId);
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
    this.#brokers.get(actor.sessionId)?.bumpCatalog();
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
      const old = [...this.#actors.values()].find(
        (actor) => actor.sessionId === sessionId && actor.binding === input.agentBindingId,
      );
      if (old) this.#clearActor(old);
      this.#actorKeys.set(key, null);
      return;
    }
    const old = [...this.#actors.values()].find(
      (actor) => actor.sessionId === sessionId && actor.binding === input.agentBindingId,
    );
    const actor: BrowserActor = old ?? {
      token: randomUUID(),
      sessionId,
      binding: input.agentBindingId,
      ownerId: input.ownerId,
      generation: source.generation,
      runId: source.runId,
      audience: new Map(),
      surfaces: new Map(),
      lastSurfaceId: null,
      seq: 0,
      lineageThreadIds: source.lineageThreadIds,
      lineageWorkspaceIds: source.lineageWorkspaceIds,
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
    actor.lineageWorkspaceIds = source.lineageWorkspaceIds;
    actor.audience.clear();
    for (const [ownerId, identity] of next) actor.audience.set(ownerId, identity);
    this.#actors.set(actor.token, actor);
    this.#actorKeys.set(key, actor.token);
    if (this.#actorKeys.size > 4096) this.#actorKeys.delete(this.#actorKeys.keys().next().value!);
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
    });
  }

  async catalogsForViewers(
    sessionId: BrowserSessionId,
  ): Promise<ReadonlyMap<UserId, BrowserTabCatalog>> {
    const viewers = await this.#repository.listBrowserSessionViewers(sessionId);
    await this.#restoreHoldings(sessionId, viewers?.userIds ?? []);
    await Promise.all(
      [...this.#actorResolutions]
        .filter(([key]) => key.startsWith(`${sessionId}:`))
        .map(([, work]) => work),
    );
    return new Map(
      (viewers?.userIds ?? []).map((ownerId) => [ownerId, this.#catalog(ownerId, sessionId)]),
    );
  }

  async flushPendingTabDescriptors(): Promise<void> {
    await Promise.all(
      [...this.#brokers]
        .filter(
          ([sessionId, broker]) =>
            this.#catalogNotices.has(sessionId) ||
            broker.durableCatalog().dirty ||
            this.#sessionOperations.has(`catalog:${sessionId}`),
        )
        .map(([sessionId, broker]) =>
          this.#flushCatalogNotice(sessionId, broker.workspaceId, broker),
        ),
    );
  }

  tabOccupants(ownerId: UserId, sessionId: BrowserSessionId, tabId: BrowserSurfaceId) {
    return this.#catalog(ownerId, sessionId).tabs.find((tab) => tab.id === tabId)?.occupants ?? [];
  }

  /** The saved session's record when the agent may reach it, live or not; otherwise null. */
  async agentReachableSavedSession(
    input: { readonly ownerId: UserId; readonly workspaceId: WorkspaceId },
    sessionId: BrowserSessionId,
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "getWorkspaceForOwner"
      | "listActiveBrowserProfileGrantsForWorkspace"
    > = this.#repository,
  ): Promise<BrowserSessionRecord | null> {
    const session = await repository.getBrowserSessionForOwner(sessionId, input.ownerId);
    return session !== null && (await this.agentMayAccessSession(input, session, repository))
      ? session
      : null;
  }

  #queueCatalogNotice(sessionId: BrowserSessionId, workspaceId: WorkspaceId): void {
    if (this.#catalogNotices.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.#catalogNotices.delete(sessionId);
      void this.#flushCatalogNotice(sessionId, workspaceId).catch(this.#onError);
    }, 100);
    timer.unref();
    this.#catalogNotices.set(sessionId, timer);
  }

  #flushCatalogNotice(
    sessionId: BrowserSessionId,
    workspaceId: WorkspaceId,
    broker = this.#brokers.get(sessionId),
  ): Promise<void> {
    const timer = this.#catalogNotices.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#catalogNotices.delete(sessionId);
    return this.#serializeKey(`catalog:${sessionId}`, async () => {
      if (broker && this.#workspaceTabs) {
        const { tabs, closed, revision, dirty } = broker.durableCatalog();
        if (dirty) {
          if (await this.#workspaceTabs.record(sessionId, tabs, closed))
            this.#onSessionsChanged(workspaceId, [sessionId], "browser.catalog-flush");
          broker.acknowledgeClosed(closed, revision);
        }
      }
      this.#onCatalogChanged(sessionId, workspaceId);
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
    const page = broker.pageOf(activity.surfaceId);
    const placeKey = `${sessionId}:${activity.surfaceId}`;
    if (page && this.#runPlaces.get(actor.runId) !== placeKey) {
      this.#runPlaces.set(actor.runId, placeKey);
      const data: EventData<"place.entered"> = {
        place: { kind: "browser", sessionId, surfaceId: activity.surfaceId },
        title: page.title.slice(0, 256),
        site: (() => {
          try {
            const origin = new URL(page.site).origin;
            return origin === "null" ? null : origin;
          } catch {
            return null;
          }
        })(),
      };
      void this.#serializeKey(`place:${actor.runId}`, async () => {
        const event = await this.#repository.recordRunPlace({
          runId: actor.runId,
          bindingGeneration: actor.generation,
          data,
        });
        if (event) this.#onWorkspaceEvent(event);
      }).catch(this.#onError);
    }

    if (actor.lastSurfaceId !== activity.surfaceId) {
      actor.lastSurfaceId = activity.surfaceId;
      void this.#repository
        .recordAgentBrowserUse({
          agentBindingId: actor.binding,
          ownerId: actor.ownerId,
          sessionId,
          tabId: activity.surfaceId,
          page: this.#brokers.get(sessionId)?.pageOf(activity.surfaceId) ?? null,
        })
        .then((credits) => this.announceUsage(credits))
        .catch(this.#onError);
    }
    this.#noteAgentCommand(sessionId, actor.binding);
    const at = this.#activityClock.now();
    const previous = actor.surfaces.get(activity.surfaceId);
    const wasActing = previous !== undefined && at - previous.at < this.#actingWindowMs;
    actor.surfaces.set(activity.surfaceId, { at, seq: activity.seq });
    const previousTimer = this.#actingTimers.get(sessionId);
    if (previousTimer) previousTimer();
    const deadlines = [...this.#actors.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .flatMap((entry) => [...entry.surfaces.values()].map(({ at }) => at + this.#actingWindowMs))
      .filter((deadline) => deadline > at);
    this.#scheduleActingEnd(sessionId, Math.min(at + this.#actingWindowMs, ...deadlines) - at);
    if (!wasActing) this.#brokers.get(sessionId)?.bumpCatalog();
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
          const value: PlaceActivity = {
            threadId: identity.threadId,
            home: identity.home,
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
          const page = broker.pageOf(place.surfaceId);
          if (!page) continue;
          const reference: ThreadPlaceReference = {
            threadId: identity.threadId,
            runId: pending.actor.runId,
            place,
            order,
            at: new Date(pending.at).toISOString(),
            title: page.title,
            site: page.site,
            iconRef: null,
          };
          const latest =
            this.#latestPlaces.get(ownerId) ?? new Map<ThreadId, ThreadPlaceReference>();
          if ((latest.get(identity.threadId)?.order ?? -1) > order) continue;
          const oldReference = latest.get(identity.threadId);
          // Only a repeat of what clients already hold stays quiet: another Run
          // in the same place is news, since its reply's picture depends on it.
          if (
            oldReference &&
            oldReference.runId === reference.runId &&
            placeIdentityKey(oldReference.place) === placeIdentityKey(place) &&
            oldReference.title === reference.title &&
            oldReference.site === reference.site
          ) {
            latest.set(identity.threadId, reference);
            continue;
          }
          latest.delete(identity.threadId);
          latest.set(identity.threadId, reference);
          if (latest.size > 4096) latest.delete(latest.keys().next().value!);
          this.#latestPlaces.set(ownerId, latest);
          this.#onPlaceNotice(ownerId, { type: "host.thread-place-changed", reference });
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

  /**
   * Conversations' visible usage changed. First uses and revisits that move
   * the catalog's conversation list also refresh the viewers' catalogs.
   */
  announceUsage(credits: readonly BrowserUsageCredit[]): void {
    if (credits.length === 0) return;
    this.#onUsageChanged(credits);
    for (const workspaceId of new Set(
      credits.flatMap((credit) => (credit.joined ? [credit.workspaceId] : [])),
    )) {
      const sessionIds = [
        ...new Set(
          credits
            .filter((credit) => credit.workspaceId === workspaceId)
            .flatMap((credit) => credit.catalogSessionIds ?? []),
        ),
      ];
      this.#onSessionsChanged(workspaceId, sessionIds, "browser.usage");
    }
  }

  async listGrantedProfiles(
    ownerId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<
    readonly {
      readonly access: "full-control";
      readonly grantId: import("@opensteer/core").BrowserProfileGrantId;
      readonly id: BrowserProfileId;
      readonly name: string;
    }[]
  > {
    const grants = await this.#repository.listActiveBrowserProfileGrantsForWorkspace(
      workspaceId,
      ownerId,
    );
    const profiles = await Promise.all(
      grants.map(async (grant) => ({
        grant,
        profile: await this.#repository.getBrowserProfile(grant.profileId, ownerId),
      })),
    );
    return profiles.flatMap(({ grant, profile }) =>
      profile
        ? [
            {
              access: grant.access,
              grantId: grant.grantId,
              id: profile.id,
              name: profile.name,
            } as const,
          ]
        : [],
    );
  }

  async listAgentSessions(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly AgentBrowserSessionSummary[]> {
    const workspace = await this.#repository.getWorkspaceForOwner(input.workspaceId, input.ownerId);
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found." });
    }
    const [records, grants, profiles, attached] = await Promise.all([
      this.#repository.listActiveBrowserSessionsForAgent({
        allOwnerWorkspaces: workspace.kind === "main",
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
      }),
      this.#repository.listActiveBrowserProfileGrantsForWorkspace(input.workspaceId, input.ownerId),
      this.#repository.listBrowserProfiles(input.ownerId),
      this.#repository.listActiveBrowserSessionsForAgentBinding(input.agentBindingId),
    ]);
    const attachedIds = new Set(attached.map((record) => record.id));
    const grantedProfileIds = new Set(grants.map((grant) => grant.profileId));
    const profileNames = new Map(profiles.map((profile) => [profile.id, profile.name]));
    return records.flatMap((record): readonly AgentBrowserSessionSummary[] => {
      // A fresh session has no profile to name and no grant to check.
      if (record.profileId === null) {
        return [
          {
            ...publicSession(record),
            activeAttachmentCount: record.activeAttachmentCount,
            attached: attachedIds.has(record.id),
            profileName: null,
          },
        ];
      }
      if (!grantedProfileIds.has(record.profileId)) return [];
      const profileName = profileNames.get(record.profileId);
      if (!profileName) return [];
      return [
        {
          ...publicSession(record),
          activeAttachmentCount: record.activeAttachmentCount,
          attached: attachedIds.has(record.id),
          profileName,
        },
      ];
    });
  }

  async openAgentSession(input: {
    readonly agentBindingId: string;
    readonly chosenEnvironmentId?: EnvironmentId;
    readonly environmentId?: EnvironmentId;
    readonly fresh?: true;
    readonly ownerId: UserId;
    readonly profileId?: BrowserProfileId;
    readonly sessionId?: BrowserSessionId;
    readonly workspaceId: WorkspaceId;
  }): Promise<{ readonly session: AgentBrowserSessionSummary; readonly wasExisting: boolean }> {
    // The tool and control-plane schemas already enforce this; the service keeps
    // its own invariant so identity can never be inferred here.
    if ([input.fresh, input.profileId, input.sessionId].filter(Boolean).length !== 1) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "Choose exactly one of an existing Browser Session, a granted browser profile, or a fresh session.",
      });
    }
    const chosenEnvironmentId = input.chosenEnvironmentId;
    if (chosenEnvironmentId && input.sessionId) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "An existing Browser Session already runs on a computer, so attaching to it cannot choose one.",
      });
    }
    // Opening by profile or fresh always starts a new session; continuing one
    // is always by its ID. A Run may hold several sessions at once.
    if (input.sessionId) {
      const record = await this.#repository.getBrowserSessionForOwner(
        input.sessionId,
        input.ownerId,
      );
      if (!record || isTerminal(record.state)) {
        throw new OpensteerError({ code: "not_found", message: "Browser Session not found." });
      }
      if (!(await this.agentMayAccessSession(input, record))) {
        throw new OpensteerError({
          code: "forbidden",
          message: "That Browser Session is not available to this Workspace.",
        });
      }
      await this.#holdForAgent(input, record);
      return {
        session: await this.#agentSessionSummary(input, record.id),
        wasExisting: true,
      };
    }

    // Transport is never gated: only a profile-backed open consults the grants.
    if (input.profileId) {
      const grants = await this.#repository.listActiveBrowserProfileGrantsForWorkspace(
        input.workspaceId,
        input.ownerId,
      );
      if (!grants.some((grant) => grant.profileId === input.profileId)) {
        throw new OpensteerError({
          code: "forbidden",
          message: "That browser profile is not available to this Workspace.",
        });
      }
    }
    const opening = {
      agentBindingId: input.agentBindingId,
      ...(chosenEnvironmentId ? { chosenEnvironmentId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      origin: input.agentBindingId.startsWith("trigger:")
        ? ("trigger" as const)
        : ("agent" as const),
      ownerId: input.ownerId,
      reuseExisting: false,
      workspaceId: input.workspaceId,
    };
    const opened = await this.start(
      input.profileId
        ? { ...opening, profileId: input.profileId }
        : { ...opening, fresh: true as const },
    );
    const openedRecord = await this.#repository.getBrowserSessionForOwner(
      opened.session.id,
      input.ownerId,
    );
    if (!openedRecord || !(await this.agentMayAccessSession(input, openedRecord))) {
      await this.stop(input.ownerId, opened.session.id).catch(() => undefined);
      throw new OpensteerError({
        code: "forbidden",
        message: "The Browser Session became unavailable to this Workspace while it was opening.",
      });
    }
    await this.#holdForAgent(input, openedRecord);
    return {
      session: await this.#agentSessionSummary(input, opened.session.id),
      wasExisting: false,
    };
  }

  async hasBrowserProfileAccess(ownerId: UserId, workspaceId: WorkspaceId): Promise<boolean> {
    return (
      (await this.#repository.listActiveBrowserProfileGrantsForWorkspace(workspaceId, ownerId))
        .length > 0
    );
  }

  async closeAgentSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly workspaceId: WorkspaceId;
  }): Promise<BrowserSessionId | null> {
    const record = await this.#repository.getBrowserSessionForOwner(input.sessionId, input.ownerId);
    if (!record || isTerminal(record.state)) return null;
    if (!(await this.agentMayAccessSession(input, record))) {
      throw new OpensteerError({
        code: "forbidden",
        message: "That Browser Session is not available to this Workspace.",
      });
    }
    await this.stop(input.ownerId, record.id);
    return record.id;
  }

  async drainRunPlaces(runId: RunId): Promise<void> {
    this.#forgetAgentBinding(`run:${runId}`);
    await this.#sessionOperations.get(`place:${runId}`);
    this.#runPlaces.delete(runId);
  }

  /**
   * A Run's end releases every session it held; the sessions themselves stay
   * open. Its agent stops acting in them at once, and any command of its that
   * answers afterwards does not make it look acting again.
   */
  async detachAgentSessionsForBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionId[]> {
    this.#forgetAgentBinding(agentBindingId);
    if (agentBindingId.startsWith("run:")) {
      const runId = agentBindingId.slice(4);
      await this.#sessionOperations.get(`place:${runId}`);
      this.#runPlaces.delete(runId);
    }
    const records = await this.#repository.listActiveBrowserSessionsForAgentBinding(agentBindingId);
    const detached = await this.#repository.detachBrowserSessionAttachments(agentBindingId);
    for (const workspaceId of new Set(records.map((record) => record.workspaceId))) {
      this.#onSessionsChanged(
        workspaceId,
        records.filter((record) => record.workspaceId === workspaceId).map((record) => record.id),
        "browser.detach",
      );
    }
    return detached;
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

  async detachAgentSessionsForRevokedProfileGrant(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<number> {
    this.invalidatePlaceAuthority();
    // The revocation already committed; the owner's clients reread their grants.
    this.#onProfilesChanged(input.ownerId, input.workspaceId);
    const detached = await this.#repository.detachBrowserSessionAttachmentsForProfileGrant(input);
    if (detached > 0) {
      const sessions = await this.#repository.listBrowserSessions(input.ownerId);
      this.#onSessionsChanged(
        input.workspaceId,
        sessions
          .filter(
            (session) =>
              session.workspaceId === input.workspaceId && session.profileId === input.profileId,
          )
          .map((session) => session.id),
        "browser.grant-revoked",
      );
    }
    return detached;
  }

  /**
   * One CDP connection bound to one Browser Session for its whole life. A
   * connection that names its session uses it and records that the binding
   * holds it. One that names none belongs to a Runner that predates session
   * addressing: it follows the binding's most recently opened session and ends
   * when another is opened (a new Host admits older Runners).
   *
   * Every command re-checks authority; once the session is gone or no longer
   * this Workspace's, the command fails with `BrowserCdpConnectionEnded` and the
   * connection ends with it.
   */
  async attachCdpForAgent(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly sessionId?: BrowserSessionId;
      readonly workspaceId: WorkspaceId;
    },
    onEvent: (event: Extract<BrowserServerMessage, { type: "cdp.event" }>["event"]) => void,
    onClosed?: () => void,
  ): Promise<{
    readonly session: HostedBrowserSession;
    close(): void;
    /**
     * Admits the command and hands it to the browser, resolving once it is on
     * its way; `result` settles with the browser's answer. Commands dispatched
     * in turn reach the browser in that order, whenever each is answered.
     */
    dispatch(command: BrowserCdpRequest["command"]): Promise<{ readonly result: Promise<unknown> }>;
    request(command: BrowserCdpRequest["command"]): Promise<unknown>;
  }> {
    const explicit = input.sessionId;
    const record = explicit
      ? await this.#usableAgentSession(input, explicit)
      : await this.#followedAgentSession(input);
    const broker = this.#brokers.get(record.id);
    if (!broker) {
      throw new BrowserCdpConnectionEnded(
        record.state === "starting"
          ? `Browser Session ${record.id} is still starting. Try again in a moment.`
          : `Browser Session ${record.id} lost its browser connection. Open a new one with browser_session_open.`,
      );
    }
    // A refused connection holds nothing and used nothing, so both refusals
    // come before anything is recorded.
    if (!broker.cdpBoundary) {
      throw new BrowserCdpConnectionEnded(
        `The browser running Browser Session ${record.id} is an older Opensteer version that doesn't protect sign-ins from agents. Update Opensteer on that computer, then open a new session.`,
      );
    }
    if (!broker.sharedControl) {
      throw new BrowserCdpConnectionEnded(
        `The browser running Browser Session ${record.id} cannot keep your tab separate from the agent's tab. Update Opensteer on that computer, then open a new session.`,
      );
    }
    if (explicit) await this.#holdForAgent(input, record);
    let attachmentClosed = false;
    const assertAttached = (bindingWasEnded: boolean) => {
      if (
        attachmentClosed ||
        this.#closed ||
        (!bindingWasEnded && this.#endedBindings.has(input.agentBindingId))
      )
        throw new BrowserCdpConnectionEnded("This browser attachment has ended.");
    };
    const unsubscribe = broker.subscribeCdp(onEvent, () => {
      attachmentClosed = true;
      onClosed?.();
    });
    const expired = { result: Promise.resolve({ status: "expired" }) };
    // Admission is everything before the command is handed to the browser; its
    // fences apply until then. The answer arrives on `result`.
    const dispatch = async (
      command: BrowserCdpRequest["command"],
    ): Promise<{ readonly result: Promise<unknown> }> => {
      const bindingWasEnded = this.#endedBindings.has(input.agentBindingId);
      const lease =
        command.method === "Opensteer.fillLogin"
          ? z.object({ loginRef: z.string() }).safeParse(command.parameters)
          : null;
      const fillAllowed = () =>
        lease === null ||
        (lease.success &&
          broker.signIn &&
          broker.live &&
          this.#brokers.has(record.id) &&
          this.#validateLoginLease?.({
            loginRef: lease.data.loginRef,
            sessionId: record.id,
            workspaceId: input.workspaceId,
          }));
      if (!fillAllowed()) return expired;
      assertAttached(bindingWasEnded);
      // Resolve attribution before admission so the first command has its actor
      // token and session authority is still checked after the metadata read.
      // A late command may answer after its Run ended, but cannot recreate
      // its actor. A Run ending during admission still fences that command.
      const actorToken =
        broker.targetedStreaming && !bindingWasEnded
          ? await this.#actorToken(input, record.id)
          : undefined;
      if (!fillAllowed()) return expired;
      assertAttached(bindingWasEnded);
      if (explicit) {
        await this.#usableAgentSession(input, record.id);
      } else if ((await this.#followedAgentSession(input)).id !== record.id) {
        throw new BrowserCdpConnectionEnded(
          "This Run opened another Browser Session. Run Browser Harness again to use it.",
        );
      }
      if (command.method === "Opensteer.stageFile" && !broker.fileStaging) {
        throw new OpensteerError({
          code: "conflict",
          message: `The browser running Browser Session ${record.id} is an older Opensteer version that cannot receive files. Update Opensteer on that computer.`,
        });
      }
      if (Object.values(browserHostMethods).some((method) => method === command.method))
        throw new OpensteerError({
          code: "forbidden",
          message: "This operation is reserved for the Host.",
        });
      // Session admission awaits storage; authority can end during that read.
      if (!fillAllowed()) return expired;
      assertAttached(bindingWasEnded);
      this.#noteAgentCommand(record.id, input.agentBindingId);
      assertAttached(bindingWasEnded);
      const answered = broker.requestCdp({
        command,
        ...(actorToken ? { actorToken } : {}),
        requestId: globalThis.crypto.randomUUID(),
        type: "cdp.command",
      });
      return {
        result: answered.then((response) => {
          if (command.method === "Target.attachToTarget") {
            const target = z
              .object({ surfaceId: BrowserSurfaceIdSchema })
              .safeParse(response.result);
            // Which page a Run used is durable and true even when its Run ended
            // while the command was answering; the live attachment is not
            // touched here, so that end cannot be undone. The agent has its page
            // either way: recording it never delays the answer or fails it.
            if (target.success) {
              void this.#repository
                .recordAgentBrowserUse({
                  agentBindingId: input.agentBindingId,
                  ownerId: input.ownerId,
                  page: broker.pageOf(target.data.surfaceId),
                  sessionId: record.id,
                  tabId: target.data.surfaceId,
                })
                .then((credits) => this.announceUsage(credits))
                .catch(this.#onError);
            }
          }
          return response.result;
        }),
      };
    };
    return {
      close: () => {
        attachmentClosed = true;
        unsubscribe();
      },
      dispatch,
      request: async (command) => (await dispatch(command)).result,
      session: publicSession(record),
    };
  }

  async grantProfileToWorkspace(input: {
    readonly access: BrowserProfileAccess;
    readonly createdBy: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<BrowserProfileGrant> {
    const access = BrowserProfileAccessSchema.parse(input.access);
    const profile = await this.#repository.getBrowserProfile(input.profileId, input.createdBy);
    if (!profile) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found." });
    }
    const grant = await this.#repository.createBrowserProfileGrant({ ...input, access });
    this.#onProfilesChanged(input.createdBy, input.workspaceId);
    return publicProfileGrant(grant);
  }

  /**
   * Durable agent request for browser profile access. The suggestion is advisory:
   * the owner chooses, creates, or declines a profile in Opensteer's approval UI.
   */
  async requestAccess(input: {
    readonly callId: string;
    readonly originatingWorkspaceId: WorkspaceId;
    readonly ownerId: UserId;
    readonly reason: string;
    readonly runId: RunId;
    readonly suggestion: BrowserAccessSuggestion;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }): Promise<RequestCreationResult & { readonly kind: "browser.access" }> {
    const workspace = await this.#repository.getWorkspaceForOwner(input.workspaceId, input.ownerId);
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found." });
    }
    if (workspace.kind === "main") {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "browser_access_request grants a browser profile only to a specialized Workspace. From Main, pass that Workspace's workspaceId. To browse in Main, open a session with an inherited profile from browser_profile_list, or with fresh: true for signed-out browsing.",
      });
    }
    // Asking the owner for access the Workspace already holds would only put a
    // question in front of them whose answer is already yes. A replayed call
    // still returns the Request it made.
    if (
      input.suggestion.kind === "existing" &&
      !(await this.#repository.requests.findByCallIdentity({
        callId: input.callId,
        originatingRunId: input.runId,
      }))
    ) {
      const profileId = input.suggestion.profileId;
      const grants = await this.#repository.listActiveBrowserProfileGrantsForWorkspace(
        input.workspaceId,
        input.ownerId,
      );
      if (grants.some((grant) => grant.profileId === profileId)) {
        throw new OpensteerError({
          code: "conflict",
          message: `This Workspace can already use browser profile ${profileId}; no Request is needed. Open it with browser_session_open {"profileId":"${profileId}"}. If the website shows you signed out, use sign_in.`,
        });
      }
    }
    const created = await this.#repository.requests.create({
      callId: input.callId,
      kind: "browser.access",
      mode: "durable",
      originatingRunId: input.runId,
      originatingThreadId: input.threadId,
      originatingWorkspaceId: input.originatingWorkspaceId,
      payload: { kind: "browser.access", reason: input.reason, suggestion: input.suggestion },
      presentation: {
        detail: input.reason,
        kind: "external",
        subject: { id: input.workspaceId, kind: "workspace" },
        title: "Browser profile access",
      },
      requestedBy: input.ownerId,
      requiredActor: "requester",
      targetWorkspaceId: input.workspaceId,
    });
    for (const event of created.events) this.#onWorkspaceEvent(event);
    return {
      kind: "browser.access",
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }

  /**
   * The session a sign-in would change, when the caller may act on it: its
   * owner, or an agent whose Workspace may reach it. Null when it is gone.
   */
  async signInTarget(input: {
    readonly ownerId: UserId;
    readonly targetId?: string;
    readonly surfaceId?: string;
    readonly sessionId: BrowserSessionId;
    readonly agentWorkspaceId?: WorkspaceId;
  }): Promise<BrowserSignInTarget | null> {
    const record = await this.#repository.getBrowserSessionForOwner(input.sessionId, input.ownerId);
    if (!record) return null;
    if (
      input.agentWorkspaceId !== undefined &&
      !(await this.agentMayAccessSession(
        { ownerId: input.ownerId, workspaceId: input.agentWorkspaceId },
        record,
      ))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "That Browser Session is not available to this Workspace.",
      });
    }
    const profile =
      record.profileId === null
        ? null
        : await this.#repository.getBrowserProfile(record.profileId, input.ownerId);
    const broker = this.#brokers.get(record.id);
    let tabId = input.surfaceId ? BrowserSurfaceIdSchema.parse(input.surfaceId) : undefined;
    if (tabId && !broker?.pageOf(tabId))
      throw new OpensteerError({
        code: "not_found",
        message: "The sign-in page is no longer available.",
      });
    if (input.targetId && broker?.live && broker.targetedStreaming) {
      const response = await broker.requestCdp({
        type: "cdp.command",
        requestId: randomUUID(),
        command: { method: "Target.getTargetInfo", parameters: { targetId: input.targetId } },
      });
      tabId = z
        .object({ targetInfo: z.object({ surfaceId: BrowserSurfaceIdSchema.optional() }) })
        .parse(response.result).targetInfo.surfaceId;
    }
    return {
      ...(tabId ? { tabId } : {}),
      live: record.state === "ready" && broker?.live === true,
      profileId: record.profileId,
      profileName: profile?.name ?? null,
      sessionId: record.id,
      signIn: broker?.signIn ?? false,
      computer: broker?.computer ?? null,
      stateImport: broker?.stateImport ?? false,
      workspaceId: record.workspaceId,
    };
  }

  setLoginLeaseValidator(
    validate: (input: {
      loginRef: string;
      sessionId: BrowserSessionId;
      workspaceId: WorkspaceId;
    }) => boolean,
  ): void {
    this.#validateLoginLease = validate;
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
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<{
    readonly grant: BrowserProfileGrant | null;
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
      resolvedBy: input.resolvedBy,
      response: input.response,
    });
    for (const event of resolved.events) this.#onWorkspaceEvent(event);
    if (resolved.request.status === "fulfilled" && (resolved.profile || resolved.grant))
      this.#onProfilesChanged(input.resolvedBy, resolved.request.targetWorkspaceId);
    return {
      grant: resolved.grant ? publicProfileGrant(resolved.grant) : null,
      profile: resolved.profile ? publicProfile(resolved.profile) : null,
      request: resolved.request,
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
      readonly editing?: 1 | 2 | undefined;
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
    const detachAuth = () => {
      peers.delete(peer);
      if (peers.size === 0) this.#authConsumers.delete(options.authSessionId);
    };
    try {
      const persisted = await this.#repository.getBrowserSessionForOwner(sessionId, ownerId);
      if (!persisted) {
        throw new OpensteerError({ code: "not_found", message: "Browser session not found." });
      }
      const broker = this.#brokers.get(sessionId);
      if (!broker || isTerminal(persisted.state)) {
        throw new OpensteerError({
          code: "conflict",
          message: "The browser session is no longer attached to its Runtime.",
        });
      }
      await broker.ready();
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
      // Workspace; the outlet rereads it on a clock rather than per frame.
      const stillVisible = async () =>
        Boolean(await this.#repository.getBrowserSessionForOwner(sessionId, ownerId));
      return await broker.attach(
        peer,
        options.mode,
        stillVisible,
        detachAuth,
        options.editing,
        options.passkeys,
        ownerId,
        options.signedIn,
      );
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
      await this.#workspaceTabs?.closeLineage(sessionId);
      await this.#stopRecord(persisted);
    });
  }

  revokePlaceReader(ownerId: UserId, workspaceId: WorkspaceId): void {
    for (const actor of this.#actors.values())
      if (
        actor.audience.has(ownerId) &&
        (this.#brokers.get(actor.sessionId)?.workspaceId === workspaceId ||
          actor.lineageWorkspaceIds.includes(workspaceId))
      ) {
        actor.audience.delete(ownerId);
        for (const surfaceId of actor.surfaces.keys())
          this.#onPlaceNotice(ownerId, {
            type: "host.place-activity-cleared",
            place: {
              kind: "browser",
              sessionId: actor.sessionId,
              surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
            },
            runId: actor.runId,
            generation: actor.generation,
            seq: ++this.#placeSequence,
          });
      }
  }

  async revokeWorkspaceUser(ownerId: UserId, workspaceId: WorkspaceId): Promise<void> {
    this.revokePlaceReader(ownerId, workspaceId);
    this.invalidatePlaceAuthority(workspaceId);
    const sessions = await this.#repository.listBrowserSessions(ownerId);
    const matching = sessions.filter(
      (session) => session.workspaceId === workspaceId && !isTerminal(session.state),
    );
    const results = await Promise.allSettled(
      matching.map((session) => this.stop(ownerId, session.id)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Browser sessions could not be revoked");
    }
  }

  /**
   * Lets go of a session whose machine was retired.
   *
   * The durable row is already failed by the revocation that called this, so
   * there is nothing to write: what is left is the live broker, which would
   * otherwise keep relaying for a computer the Deployment no longer trusts.
   */
  abandonSession(sessionId: BrowserSessionId): void {
    const broker = this.#brokers.get(sessionId);
    if (!broker) return;
    this.#brokers.delete(sessionId);
    void broker.stop().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#authorityGeneration++;
    for (const actor of this.#actors.values()) this.#clearActor(actor);
    for (const timer of this.#catalogNotices.values()) clearTimeout(timer);
    this.#catalogNotices.clear();
    for (const timer of this.#activityTimers.values()) clearTimeout(timer);
    this.#activityTimers.clear();
    this.#activityPending.clear();
    for (const entry of this.#nativeActivity.values()) entry.timer?.();
    this.#nativeActivity.clear();
    for (const peers of this.#authConsumers.values()) {
      for (const peer of peers) peer.close(1001, "Host browser service closing");
    }
    this.#authConsumers.clear();
    this.#closePromise = (async () => {
      await Promise.allSettled(this.#sessionOperations.values());
      await this.#operationTail;
      await Promise.all(
        [...this.#brokers].map(([sessionId, broker]) =>
          this.#flushCatalogNotice(sessionId, broker.workspaceId, broker),
        ),
      );
      await Promise.allSettled([...this.#brokers.values()].map((broker) => broker.stop()));
      await Promise.allSettled(this.#historyTails.values());
      await this.#workspaceTabs?.suspend();
      this.#brokers.clear();
    })();
    return this.#closePromise;
  }

  #prepareStart(
    input: StartBrowserSessionInput,
    onInitialPage?: (tabId: BrowserSurfaceId) => void,
    personNavigation?: { ownerId: UserId; typed: boolean },
  ): Promise<() => Promise<StartBrowserSessionResult>> {
    return this.#serializeKey(
      input.profileId
        ? `profile-admission:${input.profileId}`
        : `start:${input.ownerId}:${input.workspaceId}`,
      () => this.#admitStart(input, onInitialPage, personNavigation),
    );
  }

  async #admitStart(
    input: StartBrowserSessionInput,
    onInitialPage?: (tabId: BrowserSurfaceId) => void,
    personNavigation?: { ownerId: UserId; typed: boolean },
  ): Promise<() => Promise<StartBrowserSessionResult>> {
    if (this.#closed) throw unavailable("The Host browser service is shutting down.");
    const workspace = await this.#repository.getWorkspaceForOwner(input.workspaceId, input.ownerId);
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found." });
    }
    const initialUrl = input.initialUrl ? safeNavigationUrl(input.initialUrl) : undefined;

    const origin = input.origin ?? "workspace";
    const existing =
      input.reuseExisting !== true || origin !== "workspace"
        ? null
        : await this.#repository.findActiveBrowserSessionForWorkspace(input.workspaceId);
    if (existing) {
      const broker = this.#brokers.get(existing.id);
      if (broker) {
        // Identity is immutable, so a Workspace session that does not already
        // carry the requested identity is a conflict rather than a reuse.
        if (input.fresh && existing.profileId !== null) {
          throw new OpensteerError({
            code: "conflict",
            message: "This Workspace is using a browser profile.",
          });
        }
        if (input.profileId && existing.profileId === null) {
          throw new OpensteerError({
            code: "conflict",
            message: "This Workspace is using a signed-out browser session.",
          });
        }
        if (input.profileId && existing.profileId !== input.profileId) {
          throw new OpensteerError({
            code: "conflict",
            message: "This Workspace is using a different browser profile.",
          });
        }
        if (input.placement && !samePlacement(input.placement, placementOf(existing))) {
          throw new OpensteerError({
            code: "conflict",
            message: "This Workspace browser session is running on another placement.",
          });
        }
        return async () => {
          await broker.ready();
          return { session: await this.#personSession(existing, input.ownerId), wasExisting: true };
        };
      }
      await this.#transitionBrowserSession({
        from: ["starting", "ready", "closing"],
        sessionId: existing.id,
        state: "failed",
      });
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
    const boundRunnerId = storage?.kind === "local" ? storage.binding.runnerId : undefined;
    if (boundRunnerId && input.placement && input.placement.runnerId !== boundRunnerId)
      throw unavailable(
        "This profile belongs to another computer. Open it on its owning computer.",
      );
    if (
      boundRunnerId &&
      input.chosenEnvironmentId &&
      !this.#targetResolver
        ?.placements()
        .some(
          (candidate) =>
            candidate.runnerId === boundRunnerId &&
            candidate.environmentIds.includes(input.chosenEnvironmentId!),
        )
    )
      throw unavailable(
        "This profile belongs to another computer. Open it on its owning computer.",
      );
    // A fresh session holds no profile, so it has no placement affinity to honor.
    const placementHolder =
      input.placement || !profile
        ? null
        : await this.#repository.findBrowserSessionHoldingProfilePlacement(profile.id);
    // A profile's live state sits on exactly one machine, so a named machine
    // that disagrees with the one already holding it is a refusal rather than
    // a move: two browsers must never load the same profile at once.
    if (input.chosenEnvironmentId && placementHolder) {
      const holder = this.#connectedPlacements().find(
        (candidate) => candidate.runnerId === placementHolder.runnerId,
      );
      if (!holder?.environmentIds.includes(input.chosenEnvironmentId)) {
        throw new OpensteerError({
          code: "conflict",
          message: `That browser profile is already open on ${holder?.label ?? "another computer"}. Close that session before opening the profile somewhere else.`,
        });
      }
    }
    const placement =
      (boundRunnerId ? { kind: "runner" as const, runnerId: boundRunnerId } : input.placement) ??
      (placementHolder ? placementOf(placementHolder) : this.#defaultPlacement(input));
    const target = this.#resolveTarget(placement);
    if (!target)
      throw unavailable(
        boundRunnerId
          ? "Waiting for this computer to open its browser profile. Reconnect the owning computer."
          : "The selected Browser Runtime is not connected.",
      );

    const sessionId = input.sessionId ?? createBrowserSessionId();
    const localIdentity =
      profile && this.#localProfiles
        ? await this.#localProfiles.identity(profile.id, placement.runnerId, target)
        : null;
    if (input.initialSurfaceId && !target.workspaceTabRestoreVersion)
      throw unavailable("Update this browser computer to reopen tabs.");
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
            : origin === "workspace"
              ? { kind: "person", userId: input.ownerId }
              : origin === "trigger"
                ? { kind: "automation" }
                : null,
      placementKey: target.placementKey,
      profileId: profile?.id ?? null,
      runtimeId: target.runtimeId,
      workspaceId: input.workspaceId,
    });
    if (input.tabGroupId && input.initialSurfaceId)
      await this.#workspaceTabs?.bind(input.tabGroupId, sessionId, input.initialSurfaceId);
    this.#onSessionsChanged(record.workspaceId, [record.id], "browser.start");
    const initialHistoryNavigation =
      profile && initialUrl && personNavigation && target.navigationAttributionVersion
        ? { ...personNavigation, navigationId: randomUUID() }
        : undefined;
    input.operationBudget?.signal.throwIfAborted();
    const ticket = this.#signer.issue({
      ...(input.operationBudget
        ? {
            operationExpiresAt: new Date(input.operationBudget.expiresAt).toISOString(),
            remainingBudgetMs: Math.max(1, input.operationBudget.expiresAt - Date.now()),
          }
        : {}),
      access: "full-control",
      ...(target.passkeys && this.#passkeys ? { passkeys: 1 } : {}),
      ...(target.navigationVersion ? { navigationVersion: 1 } : {}),
      ...(target.navigationAttributionVersion ? { navigationAttributionVersion: 1 } : {}),
      ...(target.editing
        ? {
            editingVersion: target.editing,
            ...(target.editing === 2 ? { clipboard: target.clipboard === true } : {}),
          }
        : {}),
      ...(target.workspaceTabRestoreVersion &&
      origin !== "trigger" &&
      !input.agentBindingId?.startsWith("trigger:") &&
      !input.agentBindingId?.startsWith("watch:")
        ? {
            workspaceTabRestoreVersion: 1,
            initialSurfaceId: input.initialSurfaceId,
            dormantSurfaceIds: input.dormantSurfaceIds ? [...input.dormantSurfaceIds] : undefined,
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
    });
    const correlationId = sessionId;
    let stage = "runtime-connection";
    const restoredTab = input.initialSurfaceId
      ? await this.#workspaceTabs?.get(input.ownerId, input.initialSurfaceId)
      : null;
    let socket: BrowserRuntimeConnection;
    try {
      input.operationBudget?.signal.throwIfAborted();
      socket = withoutDatabaseOperationSignal(() => target.connect(ticket));
    } catch (error) {
      await this.#transitionBrowserSession({
        from: ["starting"],
        sessionId,
        state: "failed",
      });
      throw browserStartUnavailable(correlationId, stage, error);
    }
    let readinessBudget = input.operationBudget;
    const broker = withoutDatabaseOperationSignal(
      () =>
        new HostedBrowserBroker({
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
          ...(input.initialSurfaceId && restoredTab?.favicon
            ? {
                restoredIcon: {
                  id: input.initialSurfaceId,
                  url: restoredTab.url,
                  favicon: restoredTab.favicon,
                },
              }
            : {}),
          onPageChanged: () => this.#announcePresence(sessionId),
          onTabsChanged: () => this.#queueCatalogNotice(sessionId, record.workspaceId),
          onActivity: (activity) => this.#runtimeActivity(sessionId, activity),
          workspaceId: record.workspaceId,
          cdpBoundary: target.cdpBoundary === true,
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
          signIn: target.signIn === true,
          stateImport: target.stateImport === true,
          onState: (state) => {
            const transition = () =>
              this.#transitionBrowserSession({
                ...(state === "ready" ? { from: ["starting", "ready"] as const } : {}),
                sessionId,
                state,
              });
            return readinessBudget
              ? withDatabaseOperationSignal(
                  readinessBudget.signal,
                  readinessBudget.expiresAt,
                  transition,
                )
              : transition();
          },
          onTerminal: async () => {
            for (const actor of this.#actors.values())
              if (actor.sessionId === sessionId) this.#clearActor(actor);
            const endedBroker = this.#brokers.get(sessionId);
            await this.#flushCatalogNotice(sessionId, record.workspaceId, endedBroker);
            await this.#workspaceTabs?.suspend(sessionId);
            if (this.#workspaceTabs)
              this.#onSessionsChanged(record.workspaceId, [sessionId], "browser.terminal");
            const previous = endedBroker?.catalog(() => []);
            if (previous)
              this.#endedCatalogs.set(sessionId, {
                ...previous,
                revision: previous.revision + 1,
                tabs: [],
              });
            if (this.#endedCatalogs.size > maxBrowserSessions)
              this.#endedCatalogs.delete(this.#endedCatalogs.keys().next().value!);
            this.#onCatalogChanged(sessionId, record.workspaceId);
            this.#forgetActing(sessionId);
            this.#announcePresence(sessionId);
            this.#brokers.delete(sessionId);
            this.#sessionProfiles.delete(sessionId);
            this.#holdings.delete(sessionId);
            this.#announcedPresence.delete(sessionId);
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
        if (
          target.workspaceTabRestoreVersion &&
          origin !== "trigger" &&
          !input.agentBindingId?.startsWith("trigger:") &&
          !input.agentBindingId?.startsWith("watch:")
        )
          await broker.workspaceTabsReady();
        let initialTabId = broker.catalog(() => []).tabs[0]?.id;
        {
          const ready = InitialPageReadySchema.parse(socket.initialPage);
          if (
            ready.operationKey !== (input.initialPageOperationKey ?? sessionId) ||
            ready.navigation !== (initialUrl ? "submitted" : "blank")
          )
            throw unavailable("The browser returned mismatched initial page readiness.");
          initialTabId = ready.surfaceId;
        }
        await this.#flushCatalogNotice(sessionId, record.workspaceId);
        if (initialTabId) onInitialPage?.(initialTabId);
        stage = "session-read";
        const latest = await this.#repository.getBrowserSessionForOwner(sessionId, input.ownerId);
        const session = await this.#personSession(latest ?? record, input.ownerId);
        readinessBudget = undefined;
        return { session, wasExisting: false };
      } catch (error) {
        this.#brokers.delete(sessionId);
        await broker.abort(`The session failed during ${stage}.`).catch(() => undefined);
        await this.#transitionBrowserSession({
          from: ["starting", "ready", "closing"],
          sessionId,
          state: "failed",
        }).catch(() => undefined);
        throw browserStartUnavailable(correlationId, stage, error);
      }
    };
  }

  #resolveTarget(placement: BrowserPlacementSelector): BrowserRuntimeTarget | undefined {
    return this.#targetResolver?.resolve(placement);
  }

  /**
   * The session an agent names, if this Workspace may drive it now. Every
   * refusal says what the agent can do next, because the agent reads it
   * straight from its CDP client.
   */
  async #usableAgentSession(
    input: { readonly ownerId: UserId; readonly workspaceId: WorkspaceId },
    sessionId: BrowserSessionId,
  ): Promise<BrowserSessionRecord> {
    const record = await this.#repository.getBrowserSessionForOwner(sessionId, input.ownerId);
    if (!record) {
      throw new BrowserCdpConnectionEnded(
        `Browser Session ${sessionId} was not found. browser_session_list shows the sessions this Workspace can use.`,
      );
    }
    const [workspace, grants] = await Promise.all([
      this.#repository.getWorkspaceForOwner(input.workspaceId, input.ownerId),
      record.profileId === null
        ? []
        : this.#repository.listActiveBrowserProfileGrantsForWorkspace(
            input.workspaceId,
            input.ownerId,
          ),
    ]);
    const granted =
      record.profileId === null || grants.some((grant) => grant.profileId === record.profileId);
    // A fresh session carries no identity, so grants say nothing about it: it is
    // reachable from the Workspace that opened it and from the owner's Main.
    const reachable =
      workspace !== null && (workspace.kind === "main" || record.workspaceId === input.workspaceId);
    if (!isTerminal(record.state) && granted && reachable) return record;
    // Only a refusal needs the profile's name.
    const profile =
      record.profileId === null
        ? null
        : await this.#repository.getBrowserProfile(record.profileId, input.ownerId);
    const profileLabel = profile ? `"${profile.name}"` : "";
    if (isTerminal(record.state)) {
      throw new BrowserCdpConnectionEnded(
        record.profileId === null
          ? `Browser Session ${sessionId} has ended. Open a new one with browser_session_open.`
          : granted
            ? `Browser Session ${sessionId} has ended. Its profile ${profileLabel} is still available: open a new session with browser_session_open {"profileId":"${record.profileId}"}.`
            : `Browser Session ${sessionId} has ended, and its profile ${profileLabel} is no longer available to this Workspace.`,
      );
    }
    if (!granted) {
      throw new BrowserCdpConnectionEnded(
        `Browser Session ${sessionId} uses the profile ${profileLabel}, which is no longer available to this Workspace.`,
      );
    }
    throw new BrowserCdpConnectionEnded(
      `Browser Session ${sessionId} belongs to another Workspace. browser_session_list shows the sessions this Workspace can use.`,
    );
  }

  async #followedAgentSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<BrowserSessionRecord> {
    const [latest] = await this.#repository.listActiveBrowserSessionsForAgentBinding(
      input.agentBindingId,
    );
    if (!latest) {
      throw new BrowserCdpConnectionEnded(
        "This Run has no open Browser Session. Open one with browser_session_open.",
      );
    }
    return this.#usableAgentSession(input, latest.id);
  }

  async agentMayAccessSession(
    input: { readonly ownerId: UserId; readonly workspaceId: WorkspaceId },
    record: BrowserSessionRecord,
    repository: Pick<
      BrowserSessionRepository,
      | "getBrowserSessionForOwner"
      | "getWorkspaceForOwner"
      | "listActiveBrowserProfileGrantsForWorkspace"
    > = this.#repository,
  ): Promise<boolean> {
    const [owned, workspace, grants] = await Promise.all([
      repository.getBrowserSessionForOwner(record.id, input.ownerId),
      repository.getWorkspaceForOwner(input.workspaceId, input.ownerId),
      record.profileId === null
        ? []
        : repository.listActiveBrowserProfileGrantsForWorkspace(input.workspaceId, input.ownerId),
    ]);
    if (!owned || !workspace) return false;
    // A fresh session carries no identity, so grants say nothing about it: it is
    // reachable from the Workspace that opened it and from the owner's Main.
    if (
      record.profileId !== null &&
      !grants.some((grant) => grant.profileId === record.profileId)
    ) {
      return false;
    }
    return workspace.kind === "main" || record.workspaceId === input.workspaceId;
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
      readonly workspaceId: WorkspaceId;
    },
    record: BrowserSessionRecord,
  ): Promise<void> {
    const [attached, credits] = await Promise.all([
      this.#repository.attachBrowserSession({
        agentBindingId: input.agentBindingId,
        ownerId: input.ownerId,
        sessionId: record.id,
        workspaceId: input.workspaceId,
      }),
      this.#repository.recordAgentBrowserUse({
        agentBindingId: input.agentBindingId,
        ownerId: input.ownerId,
        page: null,
        sessionId: record.id,
        tabId: null,
      }),
    ]);
    if (attached) this.#onSessionsChanged(record.workspaceId, [record.id], "browser.attach");
    this.announceUsage(credits);
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
        this.#brokers.get(sessionId)?.bumpCatalog();
        this.#announcePresence(sessionId);
      },
      Math.max(0, delayMs),
    );
    this.#actingTimers.set(sessionId, cancel);
  }

  #forgetAgentBinding(agentBindingId: string): void {
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
    const presence: BrowserPresence = { sessionId, ...this.#presence(sessionId) };
    const announced = JSON.stringify([presence.acting, presence.page]);
    if (this.#announcedPresence.get(sessionId) === announced) return;
    this.#announcedPresence.set(sessionId, announced);
    this.#onPresenceChanged({ presence, workspaceId: broker.workspaceId });
  }

  async #agentSessionSummary(
    input: {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly workspaceId: WorkspaceId;
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
        message: "The Browser Session is no longer available to this Run.",
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
    if (broker) {
      await broker.stop();
      return;
    }
    if (!isTerminal(record.state)) {
      await this.#transitionBrowserSession({
        from: ["starting", "ready", "closing"],
        sessionId: record.id,
        state: "closed",
      });
    }
  }

  async #transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  }): Promise<BrowserSessionRecord> {
    const transitioned = await this.#repository.transitionBrowserSession(input);
    for (const event of transitioned.events) this.#onWorkspaceEvent(event);
    this.#onSessionsChanged(
      transitioned.session.workspaceId,
      [transitioned.session.id],
      "browser.transition",
    );
    return transitioned.session;
  }

  /**
   * Which computer a session lands on.
   *
   * A named computer is answered exactly or refused: substituting another one
   * would make the choice decorative. When nobody named one, a Runner that runs
   * agents on this work location and also offers a browser is the same
   * computer, so the browser belongs next to the agent by default. This is now
   * an enrolled fact — the environment binding — rather than a co-location
   * claim the machine made about itself and the Host had to verify.
   */
  #defaultPlacement(input: {
    readonly chosenEnvironmentId?: EnvironmentId;
    readonly environmentId?: EnvironmentId;
  }): BrowserPlacementSelector {
    const placements = this.#placements();
    const connected = placements.filter((placement) => placement.available);
    const { chosenEnvironmentId, environmentId } = input;
    if (chosenEnvironmentId) {
      const chosen = connected.filter((placement) =>
        placement.environmentIds.includes(chosenEnvironmentId),
      );
      if (chosen.length === 1 && chosen[0]) return placementSelector(chosen[0]);
      if (chosen.length > 1) throw runnerPlacementConflict(chosen);
      const incompatible = placements.find(
        (placement) =>
          !placement.available && placement.environmentIds.includes(chosenEnvironmentId),
      );
      if (incompatible?.unavailableReason) throw unavailable(incompatible.unavailableReason);
      if (connected.length === 0) throw unavailable("No Browser Runtime is connected.");
      throw new OpensteerError({
        code: "bad_request",
        message: `That computer does not run a connected browser. These do: ${browserMachineChoices(connected)}.`,
      });
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
    throw unavailable("No Browser Runtime is connected.");
  }

  #connectedPlacements(): readonly BrowserPlacement[] {
    return this.#targetResolver?.placements().filter((placement) => placement.available) ?? [];
  }

  #placements(): BrowserPlacement[] {
    return this.#targetResolver?.placements().map(publicPlacement) ?? [];
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

interface HostedBrowserBrokerOptions {
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
  readonly onTabsChanged: () => void;
  readonly onActivity: (activity: BrowserRuntimeActivity) => void;
  /** The active page's title or site changed; called at most once per `pageNoticeDelayMs`. */
  readonly onPageChanged: () => void;
  readonly workspaceId: WorkspaceId;
  readonly cdpBoundary: boolean;
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
  readonly signIn: boolean;
  readonly stateImport: boolean;
  readonly onState: (state: HostedBrowserSessionState) => Promise<BrowserSessionRecord>;
  readonly onTerminal: () => void | Promise<void>;
  readonly sessionId: BrowserSessionId;
  readonly socket: BrowserRuntimeConnection;
}

class HostedBrowserBroker {
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
    const surface = this.#snapshot?.surfaces.find(
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
      if (!icon || !BrowserHistoryUrlSchema.safeParse(surface.url).success) continue;
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
  readonly #durableReady = Promise.withResolvers<void>();
  workspaceTabsReady(): Promise<void> {
    return withTimeout(this.#durableReady.promise, this.#connectTimeoutMs, {
      timeoutError: () => new Error("Browser Runtime did not send its durable tab inventory."),
    });
  }
  #durableTabs: BrowserWorkspaceTabDescriptor[] = [];
  readonly #durableClosed = new Set<BrowserSurfaceId>();
  #durableRevision = 0;
  get workspaceTabRestoreVersion(): 1 | undefined {
    return this.#durableRevision > 0 ? 1 : undefined;
  }
  #storedDurableRevision = 0;
  #durableIcon(tab: BrowserWorkspaceTabDescriptor) {
    const surface = this.#snapshot?.surfaces.find(
      (surface) => surface.id === tab.id && surface.url === tab.url,
    );
    return surface ? this.#surfaceIcon(surface) : undefined;
  }
  #durableIconRefs(): string {
    return JSON.stringify(
      this.#durableTabs.map((tab) => [tab.id, this.#durableIcon(tab)?.ref ?? null]),
    );
  }
  #durableDescriptors() {
    return this.#durableTabs.map((tab) => {
      const icon = this.#durableIcon(tab);
      return { ...tab, ...(icon ? { favicon: icon.favicon } : {}) };
    });
  }
  durableCatalog() {
    return {
      tabs: this.#durableDescriptors(),
      closed: [...this.#durableClosed],
      revision: this.#durableRevision,
      dirty: this.#storedDurableRevision < this.#durableRevision,
    };
  }
  acknowledgeClosed(ids: readonly BrowserSurfaceId[], revision: number) {
    this.#storedDurableRevision = revision;
    for (const id of ids) this.#durableClosed.delete(id);
  }
  readonly #onTabsChanged: () => void;
  readonly #onActivity: (activity: BrowserRuntimeActivity) => void;
  readonly #catalogGeneration = Date.now();
  readonly #catalogRevisions = new BrowserCatalogRevisions();
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
  readonly #latestFrames = new Map<string, { frame: Buffer; header: BrowserBinaryFrameHeader }>();
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
  readonly #readyPromise: Promise<void>;
  readonly #sessionId: BrowserSessionId;
  readonly #groupId: BrowserSessionId;
  readonly #socket: BrowserRuntimeConnection;
  #snapshot: Extract<BrowserServerMessage, { type: "browser.snapshot" }> | null = null;
  readonly #editingContexts = new Map<
    BrowserSurfaceId,
    Extract<BrowserServerMessage, { type: "browser.editing" }>
  >();
  /**
   * Viewers that sent this runtime a key it cannot attribute back to them,
   * for the life of its one connection, including viewers since detached.
   */
  readonly #unaddressedKeySenders = new Set<string>();
  #answeredOlderDialogId: string | null = null;
  readonly #pendingCdpRequests = new Map<
    string,
    {
      readonly expectedType: "cdp.result";
      readonly reject: (error: unknown) => void;
      readonly resolve: (response: BrowserCdpResponse) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  /**
   * `state.import` is correlated by the Host's own operation ID, never by
   * `browser.error`. Imports share the export queue, so a `browser.error`
   * arriving while an import is outstanding cannot be taken for an export's.
   */
  readonly #pendingStateImports = new Map<string, PendingStateImport>();
  #commandTail = Promise.resolve();
  #runtimeFrameTail = Promise.resolve();
  #stateImportTail = Promise.resolve();
  #lastFrameId = -1;
  /**
   * The newest picture of the active tab while the Runtime streams. A viewer
   * that subscribes to a page that is not repainting gets it at once instead
   * of waiting for the page to change.
   */
  #latestFrame: { readonly frame: Buffer; readonly header: BrowserBinaryFrameHeader } | null = null;
  #streamReconcileTail = Promise.resolve();
  #runtimeReady = false;
  #runtimeStreaming = false;
  #protocolFailed = false;
  /** The first thing that broke this session's runtime connection. */
  #failure: string | null = null;
  #settled = false;
  #finishPromise: Promise<void> | null = null;
  #stopping = false;

  readonly cdpBoundary: boolean;
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
  readonly signIn: boolean;
  readonly stateImport: boolean;
  readonly workspaceId: WorkspaceId;

  readonly #passkeys: PasskeyService | undefined;
  constructor(options: HostedBrowserBrokerOptions) {
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
          ownOrigins: options.passkeyOwnOrigins,
          viewers: () =>
            [...this.#consumers.values()].map((outlet): PasskeyViewer => ({
              token: outlet.clipboardToken,
              userId: outlet.userId,
              fullControl: outlet.mode === "control",
              mode: outlet.passkeys,
              surfaceId:
                outlet.subscription === null
                  ? null
                  : (outlet.surfaceId ??
                    this.#snapshot?.surfaces.find((surface) => surface.active)?.id ??
                    null),
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
    this.#onTabsChanged = options.onTabsChanged;
    this.#onActivity = options.onActivity;
    this.#onPageChanged = options.onPageChanged;
    this.workspaceId = options.workspaceId;
    this.cdpBoundary = options.cdpBoundary;
    this.sharedControl = options.sharedControl;
    this.targetControl = options.targetControl;
    this.captureRegion = options.captureRegion;
    this.rasterDemand = options.rasterDemand;
    this.editing = options.editing;
    this.clipboard = options.clipboard;
    this.computer = options.computer;
    this.fileStaging = options.fileStaging;
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

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  /** The Runtime has sent its snapshot and the session has not ended. */
  get live(): boolean {
    return this.#runtimeReady && !this.#settled;
  }

  get targetedStreaming(): boolean {
    return this.#snapshot?.targetedStreamingVersion === 1;
  }
  get inventoryRevision(): number {
    return this.#snapshot?.inventoryRevision ?? this.#inventoryRevision;
  }
  #inventoryRevision = 0;
  readonly #icons = new Map<
    BrowserSurfaceId,
    { url: string; favicon: string; ref: string; restoring: boolean }
  >();
  readonly #dialogs = new Map<string, BrowserDialog>();
  bumpCatalog(): void {
    this.#catalogRevisions.announce();
    this.#onTabsChanged();
  }
  restoreIcon(id: BrowserSurfaceId, url: string, favicon: string): void {
    this.#rememberIcon(id, url, favicon, true);
  }
  #rememberIcon(id: BrowserSurfaceId, url: string, favicon: string, restoring: boolean): void {
    if (this.#icons.size >= 64 && !this.#icons.has(id))
      this.#icons.delete(this.#icons.keys().next().value!);
    this.#icons.set(id, {
      url,
      favicon,
      ref: workspaceTabIconRef(this.#groupId, favicon),
      restoring,
    });
  }
  #reconcileIcons(surfaces: readonly BrowserSurface[]): void {
    for (const [id, icon] of this.#icons)
      if (!icon.restoring && !surfaces.some((surface) => surface.id === id)) this.#icons.delete(id);
    for (const surface of surfaces) {
      const held = this.#icons.get(surface.id);
      if (surface.favicon) this.#rememberIcon(surface.id, surface.url, surface.favicon, false);
      else if (held?.url === surface.url) held.restoring = false;
      else if (held && !(held.restoring && surface.url === "about:blank"))
        this.#icons.delete(surface.id);
    }
  }
  #surfaceIcon(surface: BrowserSurface) {
    const icon = this.#icons.get(surface.id);
    return icon && (icon.url === surface.url || (icon.restoring && surface.url === "about:blank"))
      ? icon
      : undefined;
  }
  icon(iconRef: string): string | null {
    return (
      this.#snapshot?.surfaces
        .map((surface) => this.#surfaceIcon(surface))
        .find((icon) => icon?.ref === iconRef)?.favicon ?? null
    );
  }
  catalog(occupants: (surfaceId: string) => PlaceOccupant[], viewer?: UserId): BrowserTabCatalog {
    const candidate = {
      generation: this.#catalogGeneration,
      revision: this.#catalogRevisions.revision,
      inventoryRevision: this.inventoryRevision,
      tabs:
        this.#snapshot?.surfaces.map((surface, index) => ({
          id: surface.id,
          title: surface.title.slice(0, 256),
          site: browserPageSite(surface.url).slice(0, 2048),
          iconRef: this.#surfaceIcon(surface)?.ref ?? null,
          order: surface.order ?? index,
          openerId: surface.openerId ?? null,
          availability: this.live ? "ready" : "unavailable",
          ...(surface.loading ? { loading: true } : {}),
          ...(surface.navigationFailed ? { navigationFailed: true } : {}),
          ...(surface.canGoBack === undefined ? {} : { canGoBack: surface.canGoBack }),
          ...(surface.canGoForward === undefined ? {} : { canGoForward: surface.canGoForward }),
          documentId: surface.documentId ?? null,
          occupants: occupants(surface.id),
        })) ?? [],
    };
    const validated = BrowserTabCatalogSchema.parse(candidate);
    if (!viewer) return validated;
    const { catalog, unannounced } = this.#catalogRevisions.assign(viewer, validated);
    // A change no announced mutation covered reaches the viewer's other connections
    // through one notice. New or evicted readers get a fresh revision but no notice:
    // more readers than the history bound would otherwise evict each other forever.
    if (unannounced) this.#onTabsChanged();
    return catalog;
  }

  /** The page the person sees: the active tab's title and site. */
  get page(): BrowserPagePresence | null {
    const surface = this.#snapshot?.surfaces.find((surface) => surface.active);
    if (!surface) return null;
    return { title: surface.title.slice(0, 256), url: browserPageSite(surface.url) };
  }

  geometryOf(surfaceId: string): number | undefined {
    return this.#snapshot?.surfaces.find((surface) => surface.id === surfaceId)?.geometryRevision;
  }

  /** What one tab shows now, as a conversation's use of it records it. */
  pageOf(surfaceId: string): BrowserUsePage | null {
    const surface = this.#snapshot?.surfaces.find((surface) => surface.id === surfaceId);
    if (!surface) return null;
    return {
      site: browserPageSite(surface.url).slice(0, 2048),
      title: surface.title.slice(0, 256),
    };
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
    userId: UserId,
    signedIn: () => Promise<boolean>,
  ): Promise<BrowserConsumerAttachment> {
    if (this.#settled) throw new OpensteerError({ code: "conflict", message: "Browser closed." });
    if (!this.#snapshot || !this.#runtimeReady) {
      throw new OpensteerError({ code: "conflict", message: "Browser is not synchronized." });
    }
    if (this.#consumers.has(peer.id)) {
      throw new OpensteerError({ code: "conflict", message: "Browser consumer already attached." });
    }
    let outlet: BrowserConsumerOutlet;
    outlet = new BrowserConsumerOutlet(peer, mode, stillVisible, () => {
      onClose();
      const wasSubscribed = outlet.subscription !== null;
      this.#consumers.delete(peer.id);
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
        }).catch(() => undefined);
      if (wasSubscribed) {
        void this.#reconcileStreaming().catch(() => undefined);
      }
    });
    outlet.userId = userId;
    outlet.passkeys = this.passkeys ? passkeys : undefined;
    outlet.authorized = async () => (await stillVisible()) && (await signedIn());
    this.#consumers.set(peer.id, outlet);
    try {
      const version = this.#snapshot.editingVersion;
      outlet.editing = browserViewerEditingVersion(this.#snapshot, editing);
      outlet.clipboard = Boolean(
        outlet.editing && (version === 1 || this.#snapshot.clipboard === true),
      );
      await outlet.sendText(
        JSON.stringify(
          browserViewerMessage(
            this.#snapshot,
            outlet.editing,
            outlet.passkeys,
            outlet.clipboardToken,
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

  requestCdp(message: BrowserCdpRequest): Promise<BrowserCdpResponse> {
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
      const timeout = setTimeout(() => {
        this.#pendingCdpRequests.delete(parsed.requestId);
        reject(
          new OpensteerError({
            code: "timeout",
            message: "Browser Runtime did not answer the CDP request in time.",
            retryable: true,
          }),
        );
      }, agentRequestTimeoutMs);
      timeout.unref();
      this.#pendingCdpRequests.set(parsed.requestId, {
        expectedType: "cdp.result",
        reject,
        resolve,
        timeout,
      });
      void this.#sendCommand(parsed).catch((error) => {
        const pending = this.#pendingCdpRequests.get(parsed.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
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

  async stop(): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#stopping = true;
    this.#runtimeReady = false;
    await this.#onState("closing").catch(() => undefined);
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.close();
    else if (this.#socket.readyState === WebSocket.OPEN)
      this.#socket.close(1000, "Host stopped session");
    await waitForSocketClose(this.#socket, 5_000);
    await this.#runtimeFrameTail;
    await this.#finish("closed", 1000, "Browser session closed");
  }

  async abort(reason: string): Promise<void> {
    this.#failure ??= reason;
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else if (this.#socket.readyState === WebSocket.OPEN) this.#socket.terminate();
    await this.#runtimeFrameTail;
    await this.#finish("failed", 1011, "Browser session failed");
  }

  async #waitUntilReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        this.#protocolFailed = true;
        const error = new Error("Browser Runtime attach timed out.");
        reject(error);
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
        if (!ready) {
          clearTimeout(timeout);
          reject(normalized);
        }
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
            if (!becameReady || ready) return;
            ready = true;
            clearTimeout(timeout);
            resolve();
          })
          .catch(fail);
      });
      this.#socket.on("close", (code, reason) => {
        this.#failure ??= `Browser Runtime closed the connection (${code} ${reason.toString()}).`;
        if (!ready) {
          clearTimeout(timeout);
          reject(new Error(`Browser Runtime closed during attach (${code} ${reason.toString()}).`));
        }
        void this.#runtimeFrameTail
          .then(() =>
            this.#finish(
              this.#stopping || code === 1000 ? "closed" : "failed",
              this.#stopping ? 1000 : 1011,
              this.#stopping ? "Browser session closed" : "Browser Runtime disconnected",
            ),
          )
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
      const activeSurface = this.#snapshot?.surfaces.find(
        (surface) =>
          surface.id === decoded.header.surfaceId && (this.targetedStreaming || surface.active),
      );
      // A cast from the tab just deactivated can arrive after its surface
      // update. It is old output, not a new image for the selected tab.
      if (
        !activeSurface ||
        decoded.header.surfaceId !== activeSurface.id ||
        decoded.header.frameId <=
          (this.targetedStreaming
            ? (this.#frameIds.get(decoded.header.surfaceId) ?? -1)
            : this.#lastFrameId)
      )
        return false;
      if (
        this.targetedStreaming &&
        decoded.header.geometryRevision !== activeSurface.geometryRevision
      )
        return false;
      if (
        ![...this.#consumers.values()].some(
          (consumer) =>
            consumer.subscription === "frames" &&
            (consumer.surfaceId === null
              ? activeSurface.active
              : consumer.surfaceId === decoded.header.surfaceId),
        )
      )
        return false;
      this.#frameIds.set(decoded.header.surfaceId, decoded.header.frameId);
      this.#latestFrames.delete(decoded.header.surfaceId);
      this.#latestFrames.set(decoded.header.surfaceId, { frame, header: decoded.header });
      let retainedBytes = [...this.#latestFrames.values()].reduce(
        (sum, entry) => sum + entry.frame.byteLength,
        0,
      );
      for (const [id, entry] of this.#latestFrames) {
        if (retainedBytes <= 32 * 1024 * 1024) break;
        this.#latestFrames.delete(id);
        retainedBytes -= entry.frame.byteLength;
      }
      this.#lastFrameId = decoded.header.frameId;
      if (activeSurface.active) this.#latestFrame = { frame, header: decoded.header };
      for (const consumer of this.#consumers.values()) {
        if (
          consumer.subscription === "frames" &&
          (consumer.surfaceId === null
            ? activeSurface.active
            : consumer.surfaceId === decoded.header.surfaceId)
        )
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
    const message = BrowserServerMessageSchema.parse(decoded);
    if (message.type === "passkey.ceremony" || message.type === "passkey.cancel") {
      if (!this.#passkeys || !this.#runtimeReady)
        throw new Error("Browser passkeys were not negotiated.");
      if (message.type === "passkey.ceremony") {
        if (!this.#snapshot?.surfaces.some((surface) => surface.id === message.surfaceId))
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
    if (message.type === "browser.workspace-tabs") {
      this.#durableTabs = message.tabs;
      this.#durableRevision++;
      this.#durableReady.resolve();
      for (const id of message.closed) this.#durableClosed.add(id);
      this.#onTabsChanged();
      return false;
    }
    if (message.type === "browser.snapshot") {
      if (this.#snapshot) throw new Error("Browser Runtime sent a duplicate snapshot.");
      if (message.sessionId !== this.#sessionId) throw new Error("Browser session ID mismatch.");
      if (message.access !== "full-control") throw new Error("Browser access negotiation failed.");
      assertBrowserDialogSurface(message.dialog, message.surfaces);
      if (
        message.editingVersion !== undefined &&
        (message.editingVersion !== this.editing ||
          (message.editingVersion === 2 && message.clipboard !== this.clipboard))
      )
        throw new Error("Browser editing was not negotiated by this Host.");
      this.#snapshot = message;
      this.#reconcileIcons(message.surfaces);
      this.#reconcileHistory(message.surfaces);
      this.#inventoryRevision = message.inventoryRevision ?? 1;
      if (message.dialog) this.#dialogs.set(message.dialog.surfaceId, message.dialog);
      await this.#onState("ready");
      this.#runtimeReady = true;
      this.bumpCatalog();
    } else if (message.type === "browser.surfaces.changed") {
      if (!this.#snapshot) throw new Error("Browser Runtime snapshot is unavailable.");
      const previousPage = this.page;
      const previousActive = this.#snapshot.surfaces.find((surface) => surface.active)?.id ?? null;
      assertBrowserDialogSurface(this.#snapshot.dialog, message.surfaces);
      const previousSurfaces = this.#snapshot.surfaces;
      for (const surface of previousSurfaces) {
        const next = message.surfaces.find((candidate) => candidate.id === surface.id);
        if (!next || next.documentId !== surface.documentId)
          this.#passkeys?.documentChanged(surface.id);
      }
      const previousIcons = this.#durableIconRefs();
      const inventoryChanged =
        JSON.stringify(previousSurfaces.map(({ id, order }) => [id, order])) !==
        JSON.stringify(message.surfaces.map(({ id, order }) => [id, order]));
      if (inventoryChanged) this.#inventoryRevision++;
      this.#snapshot = {
        ...this.#snapshot,
        surfaces: message.surfaces,
        ...(message.inventoryRevision === undefined
          ? {}
          : { inventoryRevision: message.inventoryRevision }),
      };
      for (const surfaceId of this.#editingContexts.keys())
        if (!message.surfaces.some((surface) => surface.id === surfaceId))
          this.#editingContexts.delete(surfaceId);
      this.#reconcileIcons(message.surfaces);
      this.#reconcileHistory(message.surfaces);
      if (previousIcons !== this.#durableIconRefs()) {
        this.#durableRevision++;
        this.#onTabsChanged();
      }
      const visible = (surfaces: readonly BrowserSurface[]) =>
        surfaces.map(
          ({
            id,
            order,
            title,
            url,
            favicon,
            loading,
            documentId,
            openerId,
            canGoBack,
            canGoForward,
          }) => ({
            canGoBack,
            canGoForward,
            id,
            order,
            title,
            site: browserPageSite(url),
            favicon,
            loading,
            documentId,
            openerId,
          }),
        );
      if (JSON.stringify(visible(previousSurfaces)) !== JSON.stringify(visible(message.surfaces)))
        this.bumpCatalog();
      for (const id of this.#dialogs.keys())
        if (!message.surfaces.some((surface) => surface.id === id)) this.#dialogs.delete(id);
      const page = this.page;
      if (previousPage?.title !== page?.title || previousPage?.url !== page?.url)
        this.#noticePage();
      // A title or address changing is not a new picture. Only another tab
      // coming forward makes a picture that is not yet sent out of date.
      const active = message.surfaces.find((surface) => surface.active)?.id ?? null;
      if (this.targetedStreaming) {
        void this.#reconcileStreaming().catch(() => undefined);
      }
      if (this.#latestFrame && this.#latestFrame.header.surfaceId !== active) {
        this.#latestFrame = null;
      }
      for (const [id] of this.#latestFrames)
        if (
          !message.surfaces.some(
            (surface) =>
              surface.id === id &&
              surface.geometryRevision === this.#latestFrames.get(id)?.header.geometryRevision,
          )
        ) {
          this.#latestFrames.delete(id);
          this.#frameIds.delete(id);
        }
      if (this.targetedStreaming)
        this.#latestFrame = active ? (this.#latestFrames.get(active) ?? null) : null;
      for (const consumer of this.#consumers.values()) {
        if (consumer.surfaceId === null && previousActive !== active) consumer.resetSubscription();
        consumer.dropPendingOutside(consumer.surfaceId ?? active);
      }
    } else if (message.type === "browser.dialog.changed") {
      if (!this.#snapshot) throw new Error("Browser Runtime snapshot is unavailable.");
      assertBrowserDialogSurface(message.dialog, this.#snapshot.surfaces);
      const dialogSurface = message.dialog?.surfaceId ?? message.surfaceId;
      if (dialogSurface) {
        if (message.dialog) this.#dialogs.set(dialogSurface, message.dialog);
        else this.#dialogs.delete(dialogSurface);
      }
      if (
        !message.surfaceId ||
        message.surfaceId === this.#snapshot.surfaces.find((surface) => surface.active)?.id
      )
        this.#snapshot = { ...this.#snapshot, dialog: message.dialog };
    } else if (message.type === "browser.status") {
      if (!this.#snapshot) throw new Error("Browser Runtime snapshot is unavailable.");
      if (message.state === "closing") {
        this.#runtimeReady = false;
        this.#latestFrame = null;
        await this.#onState("closing");
      }
      if (message.state === "closed") this.#runtimeReady = false;
    }

    if (message.type === "browser.editing") this.#editingContexts.set(message.surfaceId, message);
    const [unaddressedAuthor, ...otherSenders] = this.#unaddressedKeySenders;
    for (const consumer of this.#consumers.values()) {
      if (
        message.type === "browser.error" &&
        message.producerId &&
        message.producerId !== consumer.clipboardToken
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
        consumer.mode === "control" &&
        "consumerToken" in message &&
        message.consumerToken === consumer.clipboardToken
      ) {
        const projected = consumer.legacyClipboard.read(message);
        if (
          projected &&
          (consumer.surfaceId === null || consumer.surfaceId === projected.surfaceId)
        )
          void consumer.sendText(JSON.stringify(projected)).catch(() => undefined);
      }
      if (
        !consumer.clipboard &&
        (message.type === "clipboard.result" ||
          message.type === "clipboard.written" ||
          message.type === "clipboard.part")
      )
        continue;
      if (!consumer.editing && editingServerKinds.has(message.type)) continue;
      if (consumer.mode === "watch" && message.type.startsWith("clipboard.")) continue;
      if (
        (message.type === "clipboard.result" ||
          message.type === "clipboard.written" ||
          message.type === "clipboard.part" ||
          message.type === "browser.contextmenu") &&
        (!message.consumerToken || message.consumerToken !== consumer.clipboardToken)
      )
        continue;
      // A viewer names the surface it shows only by subscribing; until then a
      // targeted viewer would take the active surface's editing for its own.
      if (
        message.type === "browser.editing" &&
        (consumer.subscription === null ||
          message.surfaceId !==
            (consumer.surfaceId ?? this.#snapshot?.surfaces.find((surface) => surface.active)?.id))
      )
        continue;
      if (
        message.type === "clipboard.data" &&
        message.consumerToken &&
        consumer.clipboardToken !== message.consumerToken
      )
        continue;
      // A runtime too old to stamp keys returns copies without a token. Their
      // author is known only while one viewer has ever sent it such keys; once
      // two have, or that one left, the text goes nowhere rather than into
      // someone else's clipboard.
      if (
        message.type === "clipboard.data" &&
        !message.consumerToken &&
        (otherSenders.length > 0 || consumer.clipboardToken !== unaddressedAuthor)
      )
        continue;
      if (
        (message.type === "browser.dialog.changed" || message.type === "clipboard.data") &&
        consumer.surfaceId !== null &&
        (message.surfaceId ??
          (message.type === "browser.dialog.changed" ? message.dialog?.surfaceId : null)) !==
          consumer.surfaceId
      )
        continue;
      if (
        message.type === "browser.dialog.changed" &&
        consumer.surfaceId === null &&
        message.surfaceId &&
        message.surfaceId !== this.#snapshot?.surfaces.find((surface) => surface.active)?.id
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
            ),
          ),
        )
        .catch(() => undefined);
    }
    if (message.type === "browser.surfaces.changed" && this.#latestFrame) {
      for (const consumer of this.#consumers.values())
        if (consumer.subscription === "frames" && consumer.surfaceId === null)
          consumer.sendFrame(this.#latestFrame.frame, this.#latestFrame.header);
    }
    if (message.type === "browser.status" && message.state === "closed") {
      if (this.#socket.readyState === WebSocket.OPEN) {
        this.#socket.close(1000, "Browser Runtime closed session");
      }
      await this.#finish(
        "closed",
        this.#stopping ? 1000 : 1011,
        this.#stopping ? "Browser session closed" : "Browser Runtime disconnected",
      );
    }
    return message.type === "browser.snapshot";
  }

  #handleCdpResponse(message: BrowserCdpWireResponse): void {
    const pending = this.#pendingCdpRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pendingCdpRequests.delete(message.requestId);
    if (message.type === "cdp.error") {
      pending.reject(new BrowserCdpRefusal(agentProtocolError(message.error)));
      return;
    }
    if (message.type !== pending.expectedType) {
      pending.reject(new Error("Browser Runtime returned the wrong correlated CDP response."));
      throw new Error("Browser Runtime returned the wrong correlated CDP response.");
    }
    pending.resolve(message);
  }

  #handleConsumerFrame(
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
    if (message.type === "stream.subscribe" || message.type === "stream.unsubscribe") {
      const subscription =
        message.type === "stream.subscribe"
          ? message.frames === false
            ? "control"
            : "frames"
          : null;
      const surfaceId = message.type === "stream.subscribe" ? (message.surfaceId ?? null) : null;
      if (subscription === "control" && outlet.mode !== "control")
        return Promise.reject(
          new OpensteerError({
            code: "forbidden",
            message: "Only control viewers may observe a target without pictures.",
          }),
        );
      if (subscription === "control" && !surfaceId)
        return Promise.reject(
          new OpensteerError({
            code: "bad_request",
            message: "A control-only subscription requires a surface.",
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
      if (surfaceId && !this.targetedStreaming)
        return Promise.reject(
          new OpensteerError({
            code: "conflict",
            message: "Update the browser computer for targeted viewing.",
          }),
        );
      if (surfaceId && !this.#snapshot?.surfaces.some((surface) => surface.id === surfaceId))
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
      if (
        outlet.mode === "control" &&
        outlet.subscription !== null &&
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
      this.#passkeys?.refresh();
      // Editing reaches a viewer only once it names what it shows, so each
      // subscription starts from that surface's current field.
      const shown =
        subscription === null
          ? undefined
          : this.#snapshot?.surfaces.find((surface) =>
              surfaceId ? surface.id === surfaceId : surface.active,
            );
      const context = shown && this.#editingContexts.get(shown.id);
      if (outlet.editing && context && context.geometryRevision === shown.geometryRevision)
        void outlet.sendText(JSON.stringify(context)).catch(() => undefined);
      outlet.frameWindow = frameWindow;
      outlet.captureRegion = captureRegion;
      outlet.resetSubscription();
      outlet.subscription = subscription;
      // Already streaming for someone else: this viewer starts from the
      // current picture rather than a blank until the page next paints.
      const latest = surfaceId ? this.#latestFrames.get(surfaceId) : this.#latestFrame;
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
      this.targetedStreaming &&
      (message.type === "input.key" ||
        message.type === "clipboard.paste" ||
        message.type === "input.command" ||
        message.type === "input.compose" ||
        message.type === "input.text" ||
        message.type === "clipboard.copy" ||
        message.type === "clipboard.cut" ||
        message.type === "clipboard.paste-data" ||
        message.type === "input.pointer" ||
        message.type === "input.wheel")
    )
      message = { ...message, targeted: outlet.surfaceId !== null };
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
    // The complement of the stamping below for keys: the runtime cannot say
    // whose copy follows a key it received without a token.
    if (
      message.type === "input.key" &&
      !this.targetedStreaming &&
      this.#snapshot?.editingVersion === undefined &&
      !outlet.editing
    )
      this.#unaddressedKeySenders.add(outlet.clipboardToken);
    let navigationId: string | undefined;
    if (message.type === "navigation.go") {
      // Consumers cannot choose an attribution id, even if they know another viewer's id.
      navigationId = outlet.userId
        ? this.beginHistoryNavigation(
            outlet.userId,
            message.typed === true,
            BrowserSurfaceIdSchema.optional().parse(
              message.surfaceId ??
                outlet.surfaceId ??
                this.#snapshot?.surfaces.find((surface) => surface.active)?.id,
            ),
          )
        : undefined;
      message = { ...message, navigationId };
    }
    return this.#sendCommand(
      (message.type === "input.key" && this.targetedStreaming) ||
        ((this.#snapshot?.editingVersion !== undefined || outlet.editing) &&
          (message.type === "input.pointer" ||
            message.type === "input.key" ||
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
      const surfaces = new Set<string>(this.#snapshot?.surfaces.map((surface) => surface.id));
      const targets = new Set(
        [...this.#consumers.values()].flatMap((consumer) =>
          consumer.subscription === "frames" &&
          consumer.surfaceId &&
          surfaces.has(consumer.surfaceId)
            ? [consumer.surfaceId]
            : [],
        ),
      );
      const legacy = [...this.#consumers.values()].some(
        (consumer) => consumer.subscription === "frames" && consumer.surfaceId === null,
      );
      const active = this.#snapshot?.surfaces.find((surface) => surface.active)?.id;
      if (this.targetedStreaming && legacy && active) targets.add(active);
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
      if (this.rasterDemand && this.targetedStreaming) {
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
            if (
              viewer.subscription === "frames" &&
              (viewer.surfaceId === target || (viewer.surfaceId === null && active === target))
            )
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
      if (!legacy) {
        for (const target of this.#latestFrames.keys())
          if (!admitted.has(target)) this.#latestFrames.delete(target);
        if (this.#latestFrame && !admitted.has(this.#latestFrame.header.surfaceId))
          this.#latestFrame = null;
      }
      for (const consumer of this.#consumers.values())
        if (consumer.subscription === "frames" && consumer.surfaceId)
          void consumer
            .sendText(
              JSON.stringify({
                type: "browser.stream.state",
                surfaceId: consumer.surfaceId,
                state: admitted.has(consumer.surfaceId) ? "admitted" : "capacity",
              }),
            )
            .catch(() => undefined);
      if (this.targetedStreaming) {
        this.#runtimeStreaming = legacy;
        return;
      }
      const streaming = [...this.#consumers.values()].some(
        (consumer) => consumer.subscription === "frames" && consumer.surfaceId === null,
      );
      if (streaming !== this.#runtimeStreaming) {
        await this.#sendCommand({
          type: streaming ? "stream.subscribe" : "stream.unsubscribe",
          ...(streaming && this.captureRegion ? { captureRegion: true } : {}),
        });
        this.#runtimeStreaming = streaming;
        // A stopped screencast leaves no picture that is still current.
        if (!streaming) this.#latestFrame = null;
      }
    });
    this.#streamReconcileTail = operation.catch(() => undefined);
    return operation;
  }

  #sendCommand(message: BrowserClientMessage): Promise<void> {
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
    const operation = this.#commandTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (
            this.#settled ||
            this.#protocolFailed ||
            !this.#runtimeReady ||
            this.#socket.readyState !== WebSocket.OPEN
          ) {
            reject(
              new OpensteerError({
                code: "conflict",
                message: "Browser Runtime is not connected.",
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
            compatible = legacy;
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
          // Released relays parse strict messages before routing them; one
          // unknown field would disconnect every browser on that computer.
          if (!this.targetedStreaming && "targeted" in compatible) {
            const {
              targeted: _targeted,
              producerId: _producerId,
              inputGeneration: _inputGeneration,
              inputSequence: _inputSequence,
              inputSequenceStart: _inputSequenceStart,
              ...released
            } = compatible;
            if (this.#snapshot?.editingVersion === undefined && "consumerToken" in released) {
              const { consumerToken: _consumerToken, ...legacy } = released;
              compatible = legacy;
            } else compatible = released;
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
          this.#socket.send(JSON.stringify(runtimeMessage), { binary: false }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    this.#commandTail = operation.catch(() => undefined);
    return operation;
  }

  #finish(
    state: "closed" | "failed",
    consumerCloseCode: number,
    consumerCloseReason: string,
  ): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#settled = true;
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
        pending.reject(
          new OpensteerError({ code: "conflict", message: "Browser Runtime disconnected." }),
        );
      }
      this.#pendingCdpRequests.clear();
      for (const consumer of this.#consumers.values()) {
        consumer.peer.close(consumerCloseCode, consumerCloseReason);
        consumer.close();
      }
      this.#consumers.clear();
      try {
        await this.#onState(state);
      } catch (cause) {
        throw new OpensteerError({
          cause,
          code: "internal",
          message: `Browser Session ${this.#sessionId} disconnected, but Opensteer could not save its ended state. Open a new one with browser_session_open.`,
        });
      } finally {
        try {
          await this.#onTerminal();
        } finally {
          this.#icons.clear();
          this.#catalogRevisions.clear();
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
  captureRegion = false;
  rasterDensity: BrowserRasterDensity = 2;
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

function publicProfile(record: BrowserProfileRecord): BrowserProfile {
  return { id: record.id, name: record.name };
}

function publicSession(record: BrowserSessionRecord): HostedBrowserSession {
  return {
    access: "full-control",
    createdAt: record.createdAt.toISOString(),
    id: record.id,
    origin: record.origin,
    placement: placementOf(record),
    profileId: record.profileId,
    runtimeId: record.runtimeId,
    state: record.state,
    updatedAt: record.updatedAt.toISOString(),
    workspaceId: record.workspaceId,
  };
}

function placementOf(record: BrowserSessionRecord): BrowserPlacementSelector {
  return { kind: "runner", runnerId: record.runnerId };
}

function publicPlacement(placement: BrowserRuntimePlacement): BrowserPlacement {
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
 * same call with one of these `environmentId`s instead of guessing.
 */
function browserMachineChoices(placements: readonly BrowserPlacement[]): string {
  return placements
    .map((placement) =>
      placement.environmentIds.length > 0
        ? `${placement.label} (environmentId ${placement.environmentIds.join(" or ")})`
        : `${placement.label} (no work location, so it cannot be named)`,
    )
    .join(", ");
}

function runnerPlacementConflict(placements: readonly BrowserPlacement[]): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: `Choose which connected computer should run this browser session: ${browserMachineChoices(placements)}.`,
  });
}

function samePlacement(left: BrowserPlacementSelector, right: BrowserPlacementSelector): boolean {
  return left.runnerId === right.runnerId;
}

function publicProfileGrant(record: {
  readonly access: BrowserProfileAccess;
  readonly createdAt: Date;
  readonly grantId: import("@opensteer/core").BrowserProfileGrantId;
  readonly profileId: BrowserProfileId;
  readonly workspaceId: WorkspaceId;
}): BrowserProfileGrant {
  return {
    access: BrowserProfileAccessSchema.parse(record.access),
    createdAt: record.createdAt.toISOString(),
    id: record.grantId,
    profileId: record.profileId,
    workspaceId: record.workspaceId,
  };
}

function isCdpResponse(message: BrowserServerMessage): message is BrowserCdpWireResponse {
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
    code: "workspace_unavailable",
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
  return unavailable("The Browser Runtime could not start a session.", error);
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
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  admitted?: BrowserTabOpenBinding;
  pageRequested?: boolean;
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
