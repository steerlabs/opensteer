import type { TeamRunDelivery, TeamSource } from "@opensteer/core";
import type { PersonShowMessage } from "@opensteer/protocol";
import type { DesktopUpdates } from "../connections/desktop-updates-contract.js";
import type {
  ChannelAccessPolicy,
  ChannelAccount,
  ChannelBinding,
  IntegrationConnection,
} from "@opensteer/channel-core";
import type {
  ArtifactContentPart,
  AssignmentSummary,
  AssignmentView,
  Attachment,
  AuthenticatedUser,
  BrowserPageContentPart,
  ComputerAppContentPart,
  ContentPart,
  DelegationDelivery,
  DelegationOutcome,
  DeploymentShape,
  ExecutionEnvironmentKind,
  ExecutionPreferences,
  IdentityConfig,
  IntegrationCallSubject,
  MarkColor,
  MessageAuthor,
  MessageKind,
  MessageQuote,
  ModelSelection,
  NotificationView,
  PhoneContentPart,
  PlaceEnteredEventView,
  ProviderContinuationIdentity,
  Request,
  RequestResponse,
  Run,
  RunFailure,
  RunUsage,
  Thread,
  ThreadAccessMode,
  ThreadDoneReason,
  QuietTaskDays,
  ThreadInputPolicy,
  ThreadInputQueue,
  ThreadStatus,
  ToolIdentity,
  ToolOutput,
  WaitingRequest,
  IconName,
} from "@opensteer/core";
import type {
  ApprovedComputerApp,
  BrowserRasterDensity,
  BrowserSessionOpener,
  ComputerView,
  ComputerViewTarget,
  DurableWindow,
  HarnessAuthenticationState,
  HarnessInstanceCatalogView,
  HarnessModelSettingsMap,
  HarnessSourceDescriptor,
  HostApiClient,
  HostApiCommandInput,
  HostApiCommandOutput,
  HostEnvironmentStatus,
  MachineAccessPolicy,
  MachineSummary,
  OwnerWindowInfo,
  ShellSessionHistoryEntry,
  ThreadMessagePage,
  ThreadMessageWindow,
  PersonalTabActivateResultSchema,
  PersonalTabReopenResultSchema,
} from "@opensteer/protocol";
import type {
  BrowserBinaryFrameHeader,
  BrowserClientMessage,
  BrowserDialog,
  BrowserSurfaceId,
  BrowserTabGroupColor,
  BrowserTabLayout,
  BrowserTabMove,
  HostedBrowserSessionState,
} from "@opensteer/protocol/browser";
import type {
  Trigger,
  TriggerOccurrence,
  TriggerRevision,
  TriggerWatchActivation,
} from "@opensteer/triggers/models";
import type { z } from "zod";
import type { BrowserEditingStore } from "./browser-editing.js";
import type { BrowserHistoryClient } from "./browser-history.js";
import type { BrowserPasskeys } from "./browser-passkeys.js";
import type { BrowserPreferences } from "./browser-preferences.js";
import type { ComputerViewRetention } from "./computer-view-retention.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import type { WebSocketClient } from "./host-session-client.js";
import type { SavedViewReadiness } from "./saved-host-view.js";
import type { BrowserIdentityChoice } from "./start-page-model.js";
import type { NativeViewerSource } from "./surfaces.js";

import type {
  BrowserContextCandidate,
  BrowserTabCloseResult,
  BrowserTabOpenResult,
  PlaceIdentity,
} from "@opensteer/protocol";
import type { BrowserWatchState } from "./browser-watch.js";
import type { ClientNetworkState } from "./lifecycle.js";
import type { PlaceActivity } from "./place-activity.js";

export interface BrowserIdentityOpenInput {
  readonly identity: BrowserIdentityChoice;
  readonly placement?: { readonly kind: "runner"; readonly runnerId: string };
}
export type BrowserTabOpenInput = { readonly sessionId: string } | BrowserIdentityOpenInput;
export interface BrowserTabOpenOptions {
  readonly signal?: AbortSignal;
  readonly url?: string;
  readonly typed?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly idempotencyKey?: string;
}
export interface PersonalTabActivationOptions {
  readonly opening?: string;
  readonly asleep?: boolean;
}
export interface PendingBrowserTab extends Omit<BrowserTabOpenOptions, "idempotencyKey"> {
  readonly idempotencyKey: string;
  readonly target: BrowserTabOpenInput;
  readonly state: "opening" | "unknown" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
}
export interface BrowserTabOpenHandle {
  readonly idempotencyKey: string;
  readonly result: Promise<BrowserTabOpenResult>;
}
export interface PendingBrowserTabDestination {
  readonly kind: "pending-browser";
  readonly idempotencyKey: string;
}
export interface ComputerViewMutationOptions {
  readonly idempotencyKey?: string;
}

type TranscriptWindow = Omit<ThreadMessageWindow, "threadId"> & {
  threadId: string;
};

/**
 * How a work location is reachable right now.
 *
 * "connected" means a Runner is attached. "disconnected" means the work
 * location's Runner is away and its operator must bring it back.
 */
export type EnvironmentStatus = HostEnvironmentStatus;

/**
 * What the three harness-authentication routes return. The environment status
 * distinguishes an inactive sign-in flow from a disconnected Runner.
 */
export interface HarnessAuthenticationEnvelope {
  authentication: HarnessAuthenticationState;
  environmentStatus: EnvironmentStatus;
}

export interface EnvironmentSummary {
  capabilities: string[];
  connected: boolean;
  harnessDrivers: HarnessDriverSummary[];
  harnessCatalogs: HarnessInstanceCatalogView[];
  /**
   * Whether this person may run the harness sign-in on this work location. The
   * Host computes it per work location — an instance administrator may sign in
   * anywhere, and anyone else may sign in where the Runner is bound to them.
   */
  harnessAuthenticationAllowed: boolean;
  id: string;
  kind: ExecutionEnvironmentKind;
  name: string;
  providerStateModes: ("ambient" | "isolated")[];
  runnerId: string | null;
  status: EnvironmentStatus;

  can: { readonly executeTasks: boolean };
}

export type HarnessDriverSummary =
  | {
      /** The Thread access modes this engine can enforce; the Host refuses the rest. */
      accessModes: ThreadAccessMode[];
      driverKind: string;
      installation?: import("@opensteer/protocol").HarnessInstallation | undefined;
      note?: string | undefined;
      readiness: "configured" | "runtime-check";
      sources: HarnessSourceDescriptor[];
    }
  | {
      driverKind: string;
      installation?: import("@opensteer/protocol").HarnessInstallation | undefined;
      readiness: "unavailable";
      reason: string;
    };

export interface HarnessSummary {
  modelSettings?: HarnessModelSettingsMap | undefined;
  driverKind: string;
  enabled: boolean;
  environmentId: string;
  id: string;
  /** Which account of this driver this work location means when nobody names one. */
  isDefault: boolean;
  name: string;
  runtimeRevision: number;
  /** Who this account talks to; one of its engine's declared sources. */
  sourceId: string;
  /**
   * Where an endpoint account talks to: the base URL it was added with and,
   * for a model server, which server that is. Nothing else of its config.
   */
  endpoint?: { readonly baseUrl: string; readonly runtime?: string | undefined } | undefined;
  stateKind: "ambient" | "isolated";
  /** The Host's word on whether this viewer's defaults may use it; absent means they may. */
  automaticEligible?: boolean | undefined;
}

export interface ThreadSummary {
  lastVisitedAt: string | null;
  latestRunCompletedAt: string | null;
  /** When a person last asked for work; task lists order by this time. */
  askedAt: string;
  doneAt: string | null;
  /** "quiet" when the Host moved it to Done because nothing touched it. */
  doneReason: ThreadDoneReason | null;
  icon: IconName | null;
  color: MarkColor | null;
  providerSessionId: string | null;
  accessMode: ThreadAccessMode;
  continuationIdentity: ProviderContinuationIdentity | null;
  createdAt: string;
  environmentId: string;
  harnessInstanceId: string;
  harnessLabel: string;
  id: string;
  inputQueuePaused: boolean;
  /** One of the person's tasks in navigation lists; see the Host's `Thread.listed`. */
  listed: boolean;
  modelLabel: string;
  modelSelection: ModelSelection;
  parentThreadId: string | null;
  pendingRequests: number;
  purpose: import("@opensteer/core").TaskPurpose;
  teamOrigin: import("@opensteer/core").TeamTaskOrigin | null;
  runnerLabel: string;
  status: ThreadStatus;
  title: string;
  unread: boolean;
  updatedAt: string;
}

/**
 * An automation in a conversation's family, as much of it as that
 * conversation shows: one anchored to it, or one running in its own task
 * linked under it. An archived one is held only in the second case, so its
 * task stays reachable.
 */
export interface ThreadAutomation {
  readonly id: string;
  readonly name: string;
  readonly kind: "schedule" | "webhook" | "watch";
  readonly paused: boolean;
  readonly ended: boolean;
  /** Its own task, linked under the conversation; null when it runs in the conversation itself. */
  readonly taskId: string | null;
  /** When a schedule next fires; null for a watch, a webhook or a paused one. */
  readonly nextFireAt: string | null;
}

/**
 * One of the reader's tasks as the Host's task list reports it: the Thread,
 * what it last said, and why its latest Run failed when it did.
 */
export interface TaskEntry {
  readonly failure: string | null;
  readonly lastReply: string | null;
  readonly thread: ThreadSummary;
}

export const mainDoneTasks = "*";

export interface TaskListState {
  readonly entries: readonly TaskEntry[];
  readonly window: DurableWindow;
}

export interface RunQueueEntry {
  createdAt: string;
  id: string;
  status: "queued" | "starting" | "running" | "waiting";
  threadId: string;
  runOrdinal: number;
}

export interface MessageEntry {
  teamSource?: TeamSource | null;
  addressedToUserId?: string;
  /** False for work drawn for its sender before the Run has received it. */
  published?: boolean;
  quote?: MessageQuote;
  sequence?: string;
  author: MessageAuthor;
  attachments?: readonly ArtifactContentPart[];
  /**
   * The browser pages the message includes, in order: each names the exact
   * session and tab, with the title and address seen when it was included.
   * The transcript model always sets it, empty when there are none; `body`
   * carries only the message's words.
   */
  pages?: readonly BrowserPageContentPart[];
  /** Explicit native place references retained for message reads and rendering. */
  places?: readonly (ComputerAppContentPart | PhoneContentPart)[];
  body: string;
  createdAt: string;
  /** Why a sent message did not, or may not, reach the Run it was sent to. */
  delivery?: {
    reason: string;
    status: "failed" | "unconfirmed";
  };
  id: string;
  kind: "message";
  messageKind: Extract<MessageKind, "assistant" | "input" | "continuation">;
  /**
   * How an input was sent: a report is left for the agent's next turn, a queue
   * or steer is work for it. Absent on the agent's own replies.
   */
  policy?: ThreadInputPolicy;
  runId: string | null;
  /** True while the body is being assembled from streamed deltas. */
  streaming?: boolean;
}

export interface DelegationEntry {
  childRunId: string;
  childThread: { id: string; title: string };
  createdAt: string;
  delegationId: string;
  delivery: DelegationDelivery;
  failure: RunFailure | null;
  id: string;
  kind: "delegation";
  outcome: DelegationOutcome;
  resultPreview: string | null;
  runId: string | null;
  taskPreview: string;
}

export interface AssignmentEntry {
  assignment: AssignmentSummary;
  createdAt: string;
  id: string;
  kind: "assignment";
  runId: string | null;
}

/**
 * Where an assignment's outcome reached the conversation that asked for it.
 * The message itself is written for the model; people read the assignment.
 */
export interface AssignmentReturnEntry {
  assignmentId: string;
  createdAt: string;
  /** The return message's id. */
  id: string;
  kind: "assignment-return";
  /** The Run that took the return, or null for a stop, which starts none. */
  runId: string | null;
  sequence: string;
}

export interface ReasoningEntry {
  completedAt?: string | null | undefined;
  createdAt: string;
  id: string;
  kind: "reasoning";
  runId: string | null;
  state: "done" | "streaming";
  text: string;
}

/**
 * Where a Run began acting in a browser tab. It marks the point, not a span:
 * the Host cannot see when the Run stops working there. The title and site are
 * what the page showed then; navigating inside the tab does not change them.
 */
export interface AppEntry {
  createdAt: string;
  id: string;
  kind: "app";
  appId: string;
  version: number;
  title: string;
  runId: string;
}

export interface PlaceEntry {
  createdAt: string;
  id: string;
  kind: "place";
  place: PlaceIdentity;
  runId: string;
  site: string | null;
  title: string;
}

export interface ToolEntry {
  arguments: unknown;
  callId: string;
  completedAt?: string | null | undefined;
  createdAt: string;
  id: string;
  /**
   * What an integration gateway call addressed, as the Host resolved it when
   * it recorded the call. Null for every other tool, and for a call whose
   * reference resolved to nothing or that was recorded before the Host named
   * its subject.
   */
  integration: IntegrationCallSubject | null;
  isError: boolean;
  kind: "tool";
  /** The subagent that made the call; absent for the Run's own agent. */
  nodeId?: string;
  /** Undefined until the call completes; canonical text is ready for every client. */
  output: ToolOutput | undefined;
  outputPreview?: { bytes: number; cut: boolean; digest: string } | undefined;
  runId: string | null;
  /**
   * `failed` is the tool's own report of an error. `stopped` is a call the Run
   * ended before it returned — the person stopped the Run, or the Run failed.
   */
  state: "done" | "failed" | "running" | "stopped";
  /** Accumulated streamed output (stdout chunks, partial arguments) for live display. */
  streamText: string;
  /** Null only when an older page starts after this call's tool.started event. */
  tool: ToolIdentity | null;
}

export interface RequestReceiptEntry {
  createdAt: string;
  /** It was declined, so nothing it asked for was given. */
  declined?: true;
  id: string;
  kind: "request";
  outcome: string;
  requestId: string;
  requestKind: Request["kind"] | null;
  runId: string | null;
  /**
   * For a Request that can fail at what it asked, a saved-password sign-in,
   * whether it did; absent for one whose answer is only a decision.
   */
  succeeded?: boolean;
  title: string;
  /**
   * When a native harness Request began holding its Run. Durable tool-call
   * holds are not measured here.
   */
  waitedSince?: string;
}

/**
 * A live Request still open: the Run that asked has waited on it since
 * `createdAt`. Nothing draws it. Its answer, or its cancellation, takes its
 * place as the receipt, which keeps when the wait began.
 */
export interface RequestWaitEntry {
  createdAt: string;
  id: string;
  kind: "request-wait";
  requestId: string;
  runId: string | null;
}

export type RunEntryStatus =
  "completed" | "failed" | "interrupted" | "queued" | "running" | "starting" | "waiting";

export interface RunEntry {
  compaction?: import("@opensteer/core").NativeCompactionActivity;
  delivery?: TeamRunDelivery | null;
  /** Absent on an older Host: its waking input is unknown. */
  startedBy?: MessageAuthor;
  startedAt?: string;
  personWaiting?: boolean;
  /** Which attempt is executing, once a restart replaced the first one. */
  attempt?: number;
  /** Its engine finished a turn while work it started in the background still runs. */
  background?: boolean;
  createdAt: string;
  /** When it ended, which settles what a page before its end left open. */
  endedAt?: string;
  error: { code: string; message: string; retryable: boolean } | null;
  id: string;
  kind: "run";
  /**
   * The message this Run answered with, as the Host recorded it when the Run
   * completed; null until then, and for a Run that ended any other way or
   * wrote nothing.
   */
  replyMessageId: string | null;
  /**
   * The replies its turns ended with while work they started ran on in the
   * background, as the Host recorded each; shown as replies before the Run
   * ends, and each ends the stretch of the transcript that led up to it.
   */
  turnReplyMessageIds?: readonly string[];
  runId: string | null;
  status: RunEntryStatus;
  /** True after the user asked to stop, until a terminal event confirms it. */
  stopping?: boolean;
  /** What the engine said this Run consumed. Absent when it said nothing. */
  usage?: RunUsage;
  /** What the attempts a restart replaced consumed; part of `usage`. */
  priorUsage?: RunUsage;
}

/**
 * Where a message stood before its sender took it back. It keeps the message's
 * id so that a page folded later still cancels the entry an earlier page
 * carries, and the conversation never shows a withdrawn message as sent.
 */
export interface WithdrawnEntry {
  createdAt: string;
  id: string;
  kind: "withdrawn";
}

/**
 * What became of a message whose own entry this page does not hold: the
 * outcome its input reached, kept under the message's id so that joining the
 * page that holds the message lands the outcome on it. A null `delivery` is a
 * confirmation that clears a doubt an earlier page recorded.
 */
export interface RunDeliveryEntry {
  createdAt: string;
  id: string;
  kind: "run-delivery";
  runId: string | null;
  delivery: TeamRunDelivery;
}

export interface DeliveryEntry {
  teamSource?: TeamSource;
  published?: boolean;
  /** The input's association, retained when its Message is on another history page. */
  inputRunId?: string | null;
  createdAt: string;
  delivery: MessageEntry["delivery"] | null;
  id: string;
  kind: "delivery";
  runId: null;
  /** The message waits again: the Run it was handed to never took it, and no Run holds it. */
  waiting?: true;
}

/**
 * A helper's card in the conversation. Its own work is read only through a node watch.
 */
export interface NodeEntry {
  /** Its engine can stop it without stopping the Run. */
  stopSupported?: boolean;
  stopping?: boolean;
  sequence?: import("@opensteer/core").Sequence;
  completedAt: string | null;
  createdAt: string;
  id: string;
  kind: "node";
  model: string | null;
  effort: string | null;
  nodeKind: import("@opensteer/core").ExecutionNodeKind;
  phaseIndex: number | null;
  phases: readonly string[];
  progress: string | null;
  nodeId: string;
  /** The tool call of the agent that started it, which the subagent stands for. */
  originCallId: string | null;
  parentNodeId: string | null;
  prompt: string | null;
  result: string | null;
  runId: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  title: string;
  /** Its own share, which the Run's usage already includes. */
  usage?: RunUsage;
}

export type TranscriptEntry =
  | AppEntry
  | SelectionEntry
  | NodeEntry
  | AssignmentEntry
  | AssignmentReturnEntry
  | DelegationEntry
  | DeliveryEntry
  | RunDeliveryEntry
  | MessageEntry
  | PlaceEntry
  | ReasoningEntry
  | RequestReceiptEntry
  | RequestWaitEntry
  | RunEntry
  | ToolEntry
  | WithdrawnEntry;

export interface SelectionEntry {
  runId: null;
  kind: "selection";
  id: string;
  createdAt: string;
  harnessInstanceId: string;
  modelSelection: ModelSelection;
  providerSessionId: string | null;
}

export interface BrowserTabSummary {
  documentId?: string | undefined;
  active: boolean;
  /** The site's icon as a data URL, while the page names one that loads. */
  favicon?: string | undefined;
  sizedByAgent?: boolean | undefined;
  /** The page is loading; absent from an older Browser Runtime. */
  loading?: boolean | undefined;
  navigationFailed?: boolean | undefined;
  id: BrowserSurfaceId;
  title: string;
  url: string;
}

export interface BrowserFrameView {
  data: ArrayBuffer | Uint8Array<ArrayBuffer>;
  header: BrowserBinaryFrameHeader;
}

export interface BrowserProfileDeletionSummary {
  profileId: string;
  computerId: string;
  state: "pending-computer" | "pending-restart";
}

export interface BrowserProfileSummary {
  /** The computer it lives on; null for an old profile not opened yet, or from an older Host. */
  homeRunnerId: string | null;
  id: string;
  name: string;
}

/** Every browser runs on a computer, and a computer is a Runner. */
export interface BrowserPlacementSummary {
  available: boolean;
  environmentIds: string[];
  kind: "runner";
  label: string;
  runnerId: string;
  runtimeId: string | null;
  unavailableReason?: string | undefined;
}

/**
 * Identity is chosen when a Browser Session opens and never changes: either an
 * existing profile, or fresh (signed out, state discarded when it ends). The
 * client always states one — the Host never picks for it.
 */
export type BrowserStartIdentity =
  { readonly kind: "fresh" } | { readonly kind: "profile"; readonly profileId: string };

/** A presenter's hold on the raster density it needs; see `BrowserFrameStore.rasterDemand`. */
export interface BrowserRasterDemand {
  update: (density: BrowserRasterDensity) => void;
  release: () => void;
}

export interface BrowserFrameStore {
  readonly cursor?: import("./browser-cursor.js").BrowserCursorStore;
  /** Changes only when previously displayed pixels lose authorization. */
  readonly invalidationKey?: (sessionId: string, surfaceId: string) => string | number;
  readonly editing?: BrowserEditingStore;
  /** Application/auth scope shared by Control and Watch picture presenters. */
  readonly scope?: object;
  /** Hold this delivery until accept; unclaimed replacements can be discarded by the store. */
  claim?: (sessionId: string, surfaceId: string, token: string) => void;
  accept?: (sessionId: string, surfaceId: string, token: string) => void;
  get: (sessionId: string, surfaceId: string) => BrowserFrameView | null;
  subscribe: (sessionId: string, listener: () => void, surfaceId: string) => () => void;
  /**
   * Leases the raster density one presenter of an exact target needs. Holders
   * retained with `rasterDemand` share their leases' maximum; until measured a
   * lease asks for 2.
   */
  rasterDemand?: (sessionId: string, surfaceId: string) => BrowserRasterDemand;
}

/**
 * One durable use of a browser by a conversation: its membership (no Run, no
 * page), a page a person included (no Run), or a page a Run used. The title
 * and site are what that page showed at its latest use, so a link to a
 * browser that has ended can still say which site it was.
 */
export interface BrowserSessionUseSummary {
  readonly sessionId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly tabId?: string | null | undefined;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  readonly pageTitle?: string | null | undefined;
  /** The page's origin, never its path or query. */
  readonly pageSite?: string | null | undefined;
}

export interface BrowserInventory {
  readonly generation: number;
  readonly revision: number;
  readonly inventoryRevision?: number | undefined;
}

export interface PersonalTabLineage {
  readonly whole?: boolean;
  id: import("@opensteer/protocol").BrowserSessionId;
  revision: number;
  createdAt: string;
  unavailableReason?: string | undefined;
  session: import("@opensteer/protocol").HostedBrowserSession;
  tabs?:
    | Array<{
        kind: "browser";
        id: BrowserSurfaceId;
        sessionId: import("@opensteer/protocol").BrowserSessionId;
        title: string;
        site: string;
        iconRef?: string | null | undefined;
        order: number;
        openerId: BrowserSurfaceId | null;
        state: "suspended" | "restoring" | "live";
        createdAt?: string | undefined;
      }>
    | undefined;
}

export interface BrowserSessionSummary {
  readonly browserTabs?: import("./browser-tab-store.js").BrowserTabStore;
  /** Host freshness for bootstrap lifecycle reconciliation. */
  updatedAt?: string;
  navigationVersion?: 1 | undefined;
  tabRestoreVersion?: 1 | undefined;
  opener?: BrowserSessionOpener;
  access: "read" | "read-write";
  /**
   * An agent is acting in this browser now: it sent a command within the
   * last few seconds. An attached Run that is thinking is not acting.
   */
  acting?: boolean;
  attachedRunIds: string[];
  createdAt?: string;
  /** The page a person sees: its title and site (origin), never path or query. */
  page?: { readonly title: string; readonly url: string } | null;
  /**
   * The conversations using this browser that the reader can open, as the
   * catalog names them, most recently active first and bounded per browser.
   */
  threadIds?: readonly string[];
  dialog: BrowserDialog | null;
  error: string | null;
  id: string;
  origin: "agent" | "trigger" | "person";
  placement: { kind: "runner"; runnerId: string };
  /** A temporary session can be signed in without a saved profile. */
  profileId: string | null;
  runtimeId: string;
  state: HostedBrowserSessionState;
  viewerError: string | null;
  viewerState: "connecting" | "disconnected" | "synchronized";
  watchViewerError?: string | null;
  watchViewerState?: "connecting" | "disconnected" | "synchronized";
}

/**
 * Pointer and wheel input always names the modifier keys held, an empty list
 * for a touch: targeted control refuses it otherwise (epoch 41), and an
 * exception thrown into a touch handler ends a Release mobile app.
 */
type BrowserCommandFor<Message> = Message extends BrowserClientMessage
  ? Message extends { readonly type: "input.pointer" | "input.wheel" }
    ? Message & Required<Pick<Message, "modifiers">>
    : Message
  : never;
export type BrowserCommand = BrowserCommandFor<BrowserClientMessage>;

export type HostConnectionState = "connected" | "connecting" | "offline";
type HostSessionState = "authenticated" | "authentication-required" | "checking";
export type ThreadLookupState = "failed" | "loading" | "missing";

export interface HostSnapshot {
  /** Live tab selectors, shared with HostClient.browserTabs. */
  readonly browserTabs?: import("./browser-tab-store.js").BrowserTabStore;
  readonly openingAppTabs?: readonly string[];
  readonly appTabs?: readonly import("@opensteer/protocol").AppTab[];
  readonly appVersions?: Readonly<Record<string, number>>;
  readonly pendingBrowserTabs?: readonly PendingBrowserTab[];
  readonly savedViewReadiness?: SavedViewReadiness;
  /**
   * Per conversation this client shows, whether its browser usage has been
   * read: `loading` only until the first answer, never on a later reread.
   */
  readonly browserUsage?: Record<
    string,
    { readonly loading: boolean; readonly error: string | null }
  >;
  /**
   * Every assignment this client holds, revision-merged from assignment
   * events, history pages, Thread reads and cancel receipts. Cards, strips and
   * task details read it here and nowhere else.
   */
  assignments: Record<string, AssignmentSummary>;
  /**
   * The automations anchored to each conversation this client has open, read
   * with its assignments. A conversation not read yet, or on a Host that cannot
   * list them by conversation, has no entry.
   */
  threadAutomations: Readonly<Record<string, readonly ThreadAutomation[]>>;
  /** Null until the Host has identified the deployment owning this session. */
  deploymentId: string | null;
  requests: Record<string, Request[]>;
  /**
   * The pending Requests this person is the one to answer, wherever they were
   * asked, each with the handed-out work it holds up. "Needs you" on a task,
   * a sidebar row and the questions above a conversation all read this.
   */
  waitingRequests: readonly WaitingRequest[];
  runQueue: RunQueueEntry[];
  tabRestoreVersion?: 1 | undefined;
  /** Tab activation calls owned by this client, before the Host reports restoration. */
  readonly activatingPersonalTabs?: readonly string[] | undefined;
  browserTabGroups?: BrowserTabLayout | undefined;
  browserAvailable: boolean;
  browserPlacements: BrowserPlacementSummary[];
  browserProfiles: BrowserProfileSummary[];
  /**
   * The computers this person may make a profile on, as the Host decides.
   * Absent from a Host older than profile homes, which is offered no choice.
   */
  browserProfileHomes?: readonly string[] | undefined;
  browserProfileDeletions?: BrowserProfileDeletionSummary[] | undefined;
  browserSessions: BrowserSessionSummary[];
  /** Recorded browser uses of the conversations this client shows, including ended sessions. */
  readonly browserUses: readonly BrowserSessionUseSummary[];
  connection: HostConnectionState;
  /** The connection has been down long enough to say so, or stopped trying. */
  connectionInterrupted: boolean;
  /** Reachability reported by the platform, distinct from Host availability. */
  network: ClientNetworkState;

  deploymentShape: DeploymentShape | null;
  personalSettings: import("@opensteer/core").PersonalSettings | null;
  can: {
    readonly createTasks: boolean;
    readonly useVoice: boolean;
    readonly manageComputers: boolean;
    readonly managePrivateResources: boolean;
  } | null;
  needsYou: import("@opensteer/protocol").NeedsYouPage | null;
  environments: EnvironmentSummary[];
  /**
   * What this person chose last, as the Host remembers it for them in this
   * Deployment. Empty until the first bootstrap lands, and the Host's word
   * thereafter: every app they open reads the same record.
   */
  executionPreferences: ExecutionPreferences;
  harnesses: HarnessSummary[];
  /** The person's Voice Thread, once it exists: their spoken manager. */
  voiceThreadId: string | null;
  threadVisits: Record<string, string>;
  /** Per loaded transcript, the Host time of its newest published, settled assistant reply. */
  publishedReplyAt: Record<string, string>;

  tasks: TaskListState | null;

  activeTasks: readonly TaskEntry[];

  doneTasks: Record<string, TaskListState>;
  /** Days untouched before the reader's tasks move to Done; null until the Host says. */
  quietTaskDays: QuietTaskDays | null;
  identityConfig: IdentityConfig | null;
  /**
   * The Host's durable pending-input queue, per Thread, for the Threads this
   * client has activated. Absent until its first read lands; reloaded from
   * the Host whenever an event touches that Thread's inputs or Runs, and
   * patched in place when this client sends, steers or cancels. The transcript
   * shows every message except the ones held here.
   */
  inputQueues: Record<string, ThreadInputQueue>;
  machines: MachineSummary[];
  /** Bumped when a machine's access sessions change, so readers refetch. */
  machineRevision: number;
  ownerName: string | null;
  revision: number;
  session: HostSessionState;
  /**
   * How the authenticated session reached the Host. Null before bootstrap and
   * for older Hosts that do not report it; null grants no local authority.
   */
  sessionSurface: "canonical" | "personal-remote" | null;
  triggerRevision: number;
  /** Resolution state for Threads referenced (e.g. by URL) but not yet loaded. */
  threadLookups: Record<string, ThreadLookupState>;
  /**
   * The Host serves `thread-titles-v1`: a person can rename a Thread, and a new
   * Thread started from a message is named by background work.
   */
  threadRenameAvailable: boolean;
  /** The Host serves `task-marks-v1`: task icons and colours can be chosen. */
  taskMarksAvailable: boolean;
  integrationAppFinishAvailable?: boolean;
  /** The Host accepts a desktop app's return port on integration sign-in. */
  integrationAppReturnPortAvailable?: boolean;
  /**
   * The Host serves `quiet-tasks-v1`: it moves quiet tasks to Done, lists Done
   * newest Done first, and reopens a Done task when its writer may reopen it.
   */
  quietTasksAvailable?: boolean;
  /** The Host accepts installed-engine update commands. */
  harnessUpdateAvailable?: boolean;
  tabReopenAvailable?: boolean;
  /** The Host serves `browser-profile-manage-v1`: a person can rename and delete profiles. */
  browserProfileManageAvailable?: boolean;
  searchSuggestionsAvailable?: boolean;
  iphoneAppsAvailable: boolean;
  /** The Host serves `devices-v1`: device setup choices, session binding and the Browser and Apps switches. */
  devicesAvailable?: boolean;
  ownerViewWindowsAvailable?: boolean;
  /** The Host advertises voice-run-v1: a call's agent runs as a Run with Opensteer's tools. */
  voiceAvailable?: boolean;
  threads: ThreadSummary[];
  transcriptWindows: Record<string, TranscriptWindow>;
  transcripts: Record<string, TranscriptEntry[]>;
  user: AuthenticatedUser | null;
  /** Recovery can replace the session with no other visible change, ending what was bound to it. */
  sessionId?: string;
}

/**
 * Everything a new Thread needs, named outright. The caller resolved where it
 * runs, on which account, with which model and access mode, and shows that
 * to the person before this is sent — the client fills nothing in on their
 * behalf.
 */
export interface CreateThreadInput {
  accessMode: ThreadAccessMode;
  environmentId: string;
  harnessInstanceId: string;
  /**
   * The key a caller holds across attempts, so a creation whose answer was
   * lost is repeated as the same command and the Host returns the Thread it
   * already made. Each call makes a fresh key when this is absent.
   */
  idempotencyKey?: string;
  modelSelection: ModelSelection;
  parentThreadId?: string;
  title?: string;
  /**
   * `title` is the first line of the message that will start the Thread, for
   * background naming to replace. Dropped for a Host without `thread-titles-v1`.
   */
  generateTitle?: true;
}

export interface CreateHarnessInstanceInput {
  driverKind: string;
  environmentId: string;
  name: string;
  stateKind: "ambient" | "isolated";
}

export interface SendMessageInput {
  body: string;
  content?: readonly ContentPart[];
  quotedMessageId?: string;
  threadId: string;
}

export interface UpdateThreadExecutionInput {
  harnessInstanceId: string;
  modelSelection: ModelSelection;
  threadId: string;
}

export interface UpdateThreadAccessModeInput {
  accessMode: ThreadAccessMode;
  threadId: string;
}

export interface ResolveRequestInput {
  requestId: string;
  response: RequestResponse;
}

export interface CreateChannelConnectionInput {
  accessPolicy: ChannelAccessPolicy;
  credentials: Readonly<Record<string, string>>;
  provider: string;
  routingMode: "dedicated" | "shared";
  deploymentId: string;
}

export interface CreatedChannelConnection {
  account: ChannelAccount;
  binding: ChannelBinding;
  connection: IntegrationConnection;
}

export interface PasswordSignInInput {
  email: string;
  password: string;
}

export type PasswordSignUpInput = PasswordSignInInput;

export type InitialOwnerClaimInput = PasswordSignInInput;

export interface TriggerDetail {
  anchorThread?: Thread | null | undefined;
  activation: TriggerWatchActivation | null;
  anchorThreadTitle: string;
  createdByThreadTitle: string | null;
  downstreamRuns: { occurrenceId: string; run: Run; threadTitle: string }[];
  downstreamRunsTruncated: boolean;
  occurrences: TriggerOccurrence[];
  revision: TriggerRevision;
  trigger: Trigger;
}

export interface CreatedTrigger {
  revision: TriggerRevision;
  trigger: Trigger;
  wasDuplicate: boolean;
  webhook?: { secret: string; url: string } | undefined;
}

/** One page of a computer's session history, newest session first. */
export interface MachineAccessHistoryPage {
  readonly nextCursor: string | null;
  readonly sessions: readonly ShellSessionHistoryEntry[];
}

/** A conflict is not a failure: it means somebody else wrote first. */
export type MachineAccessUpdateOutcome =
  { readonly outcome: "conflict" } | { readonly outcome: "updated"; readonly revision: number };

export interface HostClient {
  readonly browserTabs: import("./browser-tab-store.js").BrowserTabStore;
  /**
   * The page a viewer of this tab holds now, exactly (its address, icon and
   * size owner); undefined until a viewer of it is admitted. A list row reads
   * the tab's row instead, which carries only its site. The same object
   * returns until the page changes.
   */
  browserViewerSurface(
    sessionId: string,
    surfaceId: string,
  ): import("@opensteer/protocol/browser-tabs").BrowserViewerSurface | undefined;
  /** A Host without a network supplies its own; every other client reaches updates by route. */
  readonly desktopUpdates?: DesktopUpdates;
  readonly browserPasskeys?: BrowserPasskeys;
  /** Popups this client's own input opens from one tab, as each one opens. */
  readonly subscribeBrowserPopups?: (
    sessionId: string,
    surfaceId: string,
    listener: (popupId: string) => void,
  ) => () => void;
  readonly browserHistory: BrowserHistoryClient;
  readonly browserPreferences: BrowserPreferences;
  retainComputerView(
    viewId: string,
    generation: number,
    options?: { readonly visible?: boolean },
  ): ComputerViewRetention;
  listComputerAppWindows(
    machineId: string,
    app: Extract<ComputerViewTarget, { kind: "app" }>["app"],
  ): Promise<readonly OwnerWindowInfo[]>;
  listApprovedComputerApps(): Promise<readonly ApprovedComputerApp[]>;
  openComputerView(
    machineId: string,
    target: ComputerViewTarget,
    options?: ComputerViewMutationOptions & {
      /** False when nobody pressed anything: a phone wakes only for a person's Open. */
      readonly wake?: boolean;
    },
  ): Promise<ComputerView>;
  closeComputerView(
    viewId: string,
    generation: number,
    options?: ComputerViewMutationOptions,
  ): Promise<ComputerView>;
  closePhoneTab(machineId: string): Promise<void>;
  renewComputerView(
    viewId: string,
    generation: number,
    options?: ComputerViewMutationOptions,
  ): Promise<ComputerView>;
  readonly browserFrames: BrowserFrameStore;
  readonly browserWatchFrames: BrowserFrameStore;
  readonly rpc: HostApiClient;
  createAttachment(input: {
    readonly name: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly idempotencyKey: string;
  }): Promise<Attachment>;
  uploadAttachment(input: {
    readonly attachmentId: string;
    readonly source: Blob;
    readonly signal?: AbortSignal;
  }): Promise<Attachment>;
  openAppTab(appId: string): Promise<void>;
  closeAppTab(appId: string): Promise<void>;
  viewApp(
    appId: string,
    theme: "light" | "dark",
    signal?: AbortSignal,
  ): Promise<{ readonly app: import("@opensteer/core").OpensteerApp; readonly url: string }>;
  getAttachment(attachmentId: string): Promise<Attachment>;
  readAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob>;
  discardAttachment(attachmentId: string): Promise<void>;
  activateThread(threadId: string): void;
  /**
   * Keeps another Thread's transcript, pending Requests and assignments live
   * while held, without changing the active conversation or its read state.
   * Returns the release; holds are counted.
   */
  observeThread(threadId: string): () => void;
  watchNode(threadId: string, nodeId: string): import("./node-detail.js").NodeDetailSubscription;
  /** Starts a Thread and remembers its selection and access mode as the person's latest choice. */
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  /**
   * Names a Thread for good; its engine never renames it afterwards. Only
   * while `threadRenameAvailable`.
   */
  renameThread(threadId: string, title: string): Promise<ThreadSummary>;
  /** The exact assignment; a 403 or 404 also drops whatever this client held for it. */
  getAssignment(assignmentId: string): Promise<AssignmentView>;
  cancelAssignment(assignmentId: string): Promise<AssignmentSummary>;
  searchThreadMessages(input: {
    threadId: string;
    query: string;
    before?: string;
  }): Promise<ThreadMessagePage>;
  loadTranscriptAround(threadId: string, messageId: string): Promise<void>;
  loadLatestTranscript(threadId: string): Promise<void>;
  /**
   * What the Host decided this viewer should be told — a reply, a Request, a
   * failure — each delivered once while this client is attached. Nothing is
   * replayed: what was missed is still unread in its Thread.
   */
  subscribeNotifications(listener: (notification: NotificationView) => void): () => void;
  /** Invalidates remote administration on Host changes and stream recovery. */
  subscribePluginsChanged(
    listener: (message: { type: "host.plugins-changed" }) => void,
  ): () => void;
  subscribePersonalRemoteAccess(listener: () => void): () => void;
  /** Told when this person approves or revokes a connected agent on any device. */
  subscribeConnectionsChanged(listener: () => void): () => void;
  subscribePersonShow(listener: (message: PersonShowMessage) => void): () => void;
  visitThread(threadId: string, visitedAt: string): Promise<void>;
  /** Sets shared Done or reopens the task. */
  setTaskDone(threadId: string, done: boolean): Promise<void>;

  loadEarlierTasks(): Promise<void>;
  loadEarlierNeedsYou(): Promise<void>;

  loadDoneTasks(deploymentId?: string): Promise<void>;
  loadEarlierDoneTasks(deploymentId?: string): Promise<void>;
  setIdleCompactionPolicy(policy: import("@opensteer/core").IdleCompactionPolicy): Promise<void>;
  setQuietTaskDays(days: QuietTaskDays): Promise<void>;

  dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput>;
  dispose(): void;
  getSnapshot(): HostSnapshot;
  load(): Promise<void>;
  loadEarlierTranscript(threadId: string): Promise<void>;
  /**
   * Takes back one of the reader's own queued messages before any Run picks
   * it up. The snapshot's queue drops it at once; a lost answer is retried
   * under the same key rather than as a second cancellation.
   */
  cancelThreadInput(threadId: string, messageId: string): Promise<void>;
  /**
   * Reads the Host's durable pending-input truth into `snapshot.inputQueues`;
   * transcript pagination is not authoritative. Activating a Thread reads its
   * queue and every event that touches it reads again, so no surface calls
   * this itself.
   */
  loadThreadInputQueue(threadId: string): Promise<ThreadInputQueue>;
  loadMachineAccessHistory(input: {
    readonly before?: string;
    readonly limit: number;
    readonly runnerId: string;
  }): Promise<MachineAccessHistoryPage>;
  readonly retainBrowserViewer: (
    sessionId: string,
    surfaceId: string,
    options?: {
      readonly picture?: boolean;
      // Only a holder whose own browser holds the tab may set this; other engines refuse to observe sleeping tabs.
      readonly asleep?: boolean;
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      readonly rasterDemand?: boolean;
    },
  ) => () => void;
  /** Reads the verified Host descriptor's optional target-control capability. */
  readonly automaticModelsAvailable?: () => boolean;
  readonly browserTargetControlAvailable?: () => Promise<boolean | null>;
  readonly retainBrowserWatch: (
    sessionId: string,
    surfaceId: string,
    options?: {
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      readonly rasterDemand?: boolean;
    },
  ) => () => void;
  /**
   * Opens the owner's live display socket for one phone session, under this
   * client's login as browser viewers are. The caller owns the socket; the
   * shared phone display streams pool it.
   */
  connectComputerDisplay(
    source: NativeViewerSource,
    options?: { readonly editing?: 1 },
  ): WebSocketClient;
  /**
   * The platform's lifecycle as this client applies it to its own sockets:
   * hidden, shown again, and each network change, after which every socket it
   * handed out is suspect. Owners of display sockets follow it the same way. A
   * client hidden when this is called says so at once.
   */
  subscribeLifecycle?(
    listener: (event: "background" | "foreground" | "network") => void,
  ): () => void;
  placeActivity(placeKey: string): readonly PlaceActivity[];
  subscribePlaceActivity(placeKey: string, listener: () => void): () => void;
  /** Newest ordered place.entered for this nonterminal Run, independent of loaded history. */
  runPlace(runId: string): PlaceEnteredEventView | null;
  subscribeRunPlace(runId: string, listener: () => void): () => void;
  readBrowserContextCandidate(sessionId: string, tabId: string): Promise<BrowserContextCandidate>;
  browserPresentationDeadline?(sessionId: string, tabId: string): number | null;
  markBrowserPagePresented?(sessionId: string, tabId: string): void;
  beginBrowserTabOpen(
    target: string | BrowserTabOpenInput,
    options?: BrowserTabOpenOptions,
  ): BrowserTabOpenHandle;
  dismissPendingBrowserTab(idempotencyKey: string): void;
  openBrowserTab(
    target: string | BrowserTabOpenInput,
    options?: BrowserTabOpenOptions,
  ): Promise<BrowserTabOpenResult>;
  readPersonalTabs?(sessionId: string): Promise<PersonalTabLineage | null>;
  activatePersonalTab?(
    tabId: string,
    options?: PersonalTabActivationOptions,
  ): Promise<z.infer<typeof PersonalTabActivateResultSchema> | null>;
  reopenPersonalTab?(): Promise<z.infer<typeof PersonalTabReopenResultSchema>>;
  groupBrowserTabs(
    tabIds: readonly string[],
    target:
      | { readonly groupId: string }
      | { readonly title?: string; readonly color?: BrowserTabGroupColor },
  ): Promise<string>;
  moveBrowserTabs(move: BrowserTabMove): Promise<void>;
  ungroupBrowserTabs(tabIds: readonly string[]): Promise<void>;
  updateBrowserTabGroup(
    groupId: string,
    update: {
      readonly title?: string;
      readonly color?: BrowserTabGroupColor;
      readonly collapsed?: boolean;
    },
  ): Promise<void>;
  closePersonalTabs(tabIds: readonly string[]): Promise<{
    readonly closed: readonly string[];
    readonly failed: readonly { readonly tabId: string; readonly message: string }[];
  }>;
  closeBrowserTab(
    sessionId: string,
    surfaceId: string,
    expected: BrowserInventory,
  ): Promise<BrowserTabCloseResult>;
  browserWatchFrame(sessionId: string, surfaceId: string): BrowserFrameView | null;
  browserWatchState(sessionId: string, surfaceId: string): BrowserWatchState;
  /**
   * The interactive view of one exact tab, as `retainBrowserViewer(sessionId, surfaceId)`
   * holds it: connecting, live, or unavailable with the reason. Its changes reach
   * `browserFrames.subscribe(sessionId, listener, surfaceId)`.
   */
  subscribeBrowserViewer?: (
    sessionId: string,
    surfaceId: string,
    listener: () => void,
  ) => () => void;
  browserViewerState(sessionId: string, surfaceId: string): BrowserWatchState;
  subscribeBrowserWatch(sessionId: string, surfaceId: string, listener: () => void): () => void;
  readBrowserTabIcon(sessionId: string, iconRef: string): Promise<string | null>;
  /**
   * The view is done with this Control or Watch picture — drawn, or dropped because it
   * could not be — so the next may come. A late or repeated token is ignored.
   */
  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId: string): void;
  /** Only a person's explicit Retry may reopen a terminal realtime refusal. */
  refresh(options?: { readonly retryConnection?: boolean }): Promise<void>;
  /**
   * Records a choice the person just made as what their next Thread starts
   * from, and updates the snapshot with the Host's merged answer. The
   * composer calls this when a control is used before any Thread exists;
   * the Thread mutations below call it themselves once the Host accepts.
   */
  rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences>;
  /** Lets a queue a Stop paused admit work again. Idempotent on the Host. */
  resumeThreadInputQueue(threadId: string): Promise<void>;
  sendBrowserCommand(sessionId: string, command: BrowserCommand): void;
  startBrowser(
    deploymentId: string,
    identity: BrowserStartIdentity,
    placement?: BrowserPlacementSummary,
    threadId?: string,
    viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary>;
  stopMachineAccessSession(sessionId: string): Promise<boolean>;
  /**
   * Promotes one of the reader's own queued messages into the Run the queue
   * read named as steerable. The snapshot's queue drops it at once and the
   * transcript shows it; the Host restores it to the queue if the Run refuses.
   * A lost answer is retried under the same key, never as a second promotion.
   */
  steerThreadInput(threadId: string, messageId: string): Promise<void>;
  stopRun(threadId: string): Promise<void>;
  stopNode(threadId: string, nodeId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Moves a Thread to another access mode; remembered once the Host accepts. */
  updateThreadAccess(threadId: string, accessMode: ThreadAccessMode): Promise<ThreadSummary>;
  /**
   * Moves a Thread to another account and model on its own work location;
   * remembered once the Host accepts. An incompatible choice requires explicit
   * continuation against the session the person reviewed.
   */
  updateThreadExecution(
    threadId: string,
    selection: Pick<ExecutionSelection, "harnessInstanceId" | "modelSelection">,
    continuation?: { expectedProviderSessionId: string | null },
  ): Promise<ThreadSummary>;
  bindDeviceSession(input: {
    readonly machineId: string;
    readonly proof: import("@opensteer/protocol").DeviceSessionBindingProof;
  }): Promise<void>;
  updateMachineAccess(input: {
    readonly expectedRevision: number;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: string;
  }): Promise<MachineAccessUpdateOutcome>;
}

export class HostClientRequestError extends Error {
  readonly code: string;
  /**
   * The Host's stable discriminator within that code, carried through
   * unchanged so a surface branches on `unsupported-version` rather than on
   * the sentence beside it. Undefined for refusals that need no distinction.
   */
  readonly reason: string | undefined;
  readonly status: number;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly status: number;
  }) {
    super(options.message);
    this.name = "HostClientRequestError";
    this.code = options.code;
    this.reason = options.reason;
    this.status = options.status;
  }
}

/**
 * Whether the Host answered no, rather than the answer never arriving. A
 * refused command changed nothing and may be changed and sent anew; anything
 * else may have landed, so it is only ever repeated as the same command.
 */
export function isHostRefusal(error: unknown): boolean {
  return (
    error instanceof HostClientRequestError &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
