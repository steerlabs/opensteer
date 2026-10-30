import type { BrowserPasskeys } from "./browser-passkeys.js";
import type { SavedViewReadiness } from "./saved-host-view.js";
import type { BrowserEditingStore } from "./browser-editing.js";
import type { BrowserPreferences } from "./browser-preferences.js";
import type {
  BrowserRasterDensity,
  WorkspaceTabLineage,
  WorkspaceTabActivateResultSchema,
  WorkspaceTabReopenResultSchema,
} from "@opensteer/protocol";
import type { z } from "zod";
import type { NativeViewerSource } from "./surfaces.js";
import type { ComputerViewRetention } from "./computer-view-retention.js";
import type {
  HarnessModelSettingsMap,
  ThreadMessagePage,
  BrowserSessionOpener,
  ComputerView,
  ComputerViewTarget,
  ApprovedComputerApp,
  OwnerWindowInfo,
} from "@opensteer/protocol";
import type { RecentSitesStore } from "./recent-sites.js";
import type { BrowserIdentityChoice } from "./start-page-model.js";
import type {
  ChannelAccessPolicy,
  ChannelAccount,
  ChannelBinding,
  IntegrationConnection,
} from "@opensteer/channel-core";
import type {
  MessageQuote,
  ThreadReadState,
  Thread,
  AssignmentSummary,
  AssignmentView,
  AuthenticatedUser,
  DeploymentShape,
  DelegationDelivery,
  DelegationOutcome,
  ExecutionEnvironmentKind,
  IdentityConfig,
  IntegrationCallSubject,
  ExecutionPreferences,
  ModelSelection,
  MessageAuthor,
  MessageKind,
  NotificationView,
  ProviderContinuationIdentity,
  Request,
  WaitingRequest,
  RequestResponse,
  RunFailure,
  Run,
  RunUsage,
  ThreadAccessMode,
  ThreadInputPolicy,
  ThreadInputQueue,
  ThreadRole,
  ThreadStatus,
  ToolIdentity,
  ToolOutput,
  WorkspaceBackingKind,
  Attachment,
  ArtifactContentPart,
  BrowserPageContentPart,
  ComputerAppContentPart,
  PhoneContentPart,
  ContentPart,
  WorkspaceIconName,
  MarkColor,
} from "@opensteer/core";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import type { WebSocketClient } from "./host-session-client.js";
import type {
  BrowserTabLayout,
  BrowserTabMove,
  BrowserTabGroupColor,
  BrowserDialog,
  BrowserClientMessage,
  BrowserBinaryFrameHeader,
  BrowserSurfaceId,
  HostedBrowserSessionState,
} from "@opensteer/protocol/browser";
import type {
  DurableWindow,
  HostApiClient,
  HostApiCommandInput,
  HostApiCommandOutput,
  HostEnvironmentStatus,
  ThreadMessageWindow,
  WorkspaceFilePreviewMetadata,
  WorkspaceView,
  MachineAccessPolicy,
  MachineSummary,
  ShellSessionHistoryEntry,
} from "@opensteer/protocol";
import type {
  HarnessAuthenticationState,
  HarnessInstanceCatalogView,
  HarnessSourceDescriptor,
} from "@opensteer/protocol";
import type {
  Trigger,
  TriggerOccurrence,
  TriggerRevision,
  TriggerWatchActivation,
} from "@opensteer/triggers";

import type { BrowserWatchState } from "./browser-watch.js";
import type { PlaceActivity } from "./place-activity.js";
import type { ThreadPlace } from "./places.js";
import type {
  BrowserContextCandidate,
  BrowserTabCloseResult,
  BrowserTabOpenResult,
  ThreadPlaceReference,
  BrowserTabCatalog,
} from "@opensteer/protocol";
import type { ClientNetworkState } from "./lifecycle.js";

export type BrowserTabOpenInput =
  | { readonly sessionId: string }
  | {
      readonly identity: BrowserIdentityChoice;
      readonly placement?: { readonly kind: "runner"; readonly runnerId: string };
    };
export interface BrowserTabOpenOptions {
  readonly url?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly idempotencyKey?: string;
}
export interface ComputerViewMutationOptions {
  readonly idempotencyKey?: string;
}

type TranscriptWindow = Omit<ThreadMessageWindow, "threadId"> & { threadId: string };

export interface WorkspaceSummary {
  homeThreadId: string | null;
  description: string;
  fileCount: number;
  harnessLabel: string;
  id: string;
  /** "main" is the owner's implicit home; only "specialized" Workspaces are listed. */
  kind: WorkspaceView["kind"];
  /**
   * The computer holding this Workspace's folder, by name. Null for shared
   * storage and also for a computer whose name the Host does not know, so its
   * absence says nothing about where the files are.
   */
  machineName: string | null;
  name: string;
  /** The chosen icon, or null to show the name's initials. */
  icon: WorkspaceIconName | null;
  runnerLabel: string;
  storageIssue: WorkspaceView["storageIssue"];
  color: MarkColor | null;
  updatedAt: string;
  status: WorkspaceView["status"];
}

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
  /** What this machine can hold, which is what a new-Workspace choice offers. */
  workspaceBackings: WorkspaceBackingKind[];
}

export type HarnessDriverSummary =
  | {
      /** The Thread access modes this engine can enforce; the Host refuses the rest. */
      accessModes: ThreadAccessMode[];
      driverKind: string;
      note?: string | undefined;
      readiness: "configured" | "runtime-check";
      sources: HarnessSourceDescriptor[];
    }
  | {
      driverKind: string;
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
}

export interface ThreadSummary {
  doneAt: string | null;
  icon: WorkspaceIconName | null;
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
  role: ThreadRole;
  runnerLabel: string;
  status: ThreadStatus;
  title: string;
  unread: boolean;
  updatedAt: string;
  workspaceId: string;
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

/** The reader's tasks across every Workspace, as far as they have been read. */
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
  childThread: { id: string; title: string; workspaceId: string };
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
   * When the Run that asked began waiting on the answer: a live Request holds
   * it from when it opened. Absent for a durable one, which leaves it working.
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
export interface DeliveryEntry {
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
 * A subagent the Run's engine started. Its tool calls are entries naming it by
 * `nodeId`; its own text is not a message, and `result` is what it returned.
 */
export interface NodeEntry {
  completedAt: string | null;
  createdAt: string;
  id: string;
  kind: "node";
  model: string | null;
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
  | SelectionEntry
  | NodeEntry
  | AssignmentEntry
  | AssignmentReturnEntry
  | DelegationEntry
  | DeliveryEntry
  | MessageEntry
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

export interface WorkspaceFilePreview {
  /** Null when the bounded preview is binary or not safely decodable as UTF-8. */
  content: string | null;
  metadata: WorkspaceFilePreviewMetadata;
}

export interface BrowserTabSummary {
  active: boolean;
  /** The site's icon as a data URL, while the page names one that loads. */
  favicon?: string | undefined;
  sizedByAgent?: boolean | undefined;
  /** The page is loading; absent from an older Browser Runtime. */
  loading?: boolean | undefined;
  id: BrowserSurfaceId;
  title: string;
  url: string;
}

export interface BrowserFrameView {
  data: ArrayBuffer | Uint8Array<ArrayBuffer>;
  header: BrowserBinaryFrameHeader;
}

export interface BrowserProfileSummary {
  id: string;
  name: string;
  revision: number;
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

export interface BrowserProfileGrantSummary {
  access: "full-control";
  createdAt: string;
  id: string;
  profileId: string;
  workspaceId: string;
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
  readonly editing?: BrowserEditingStore;
  /** Application/auth scope shared by Control and Watch picture presenters. */
  readonly scope?: object;
  accept?: (sessionId: string, surfaceId: string | undefined, token: string) => void;
  get: (sessionId: string, surfaceId?: string) => BrowserFrameView | null;
  subscribe: (sessionId: string, listener: () => void, surfaceId?: string) => () => void;
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
  readonly threadId: string;
  readonly runId: string | null;
  readonly tabId?: string | null | undefined;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  readonly pageTitle?: string | null | undefined;
  /** The page's origin, never its path or query. */
  readonly pageSite?: string | null | undefined;
}

export interface BrowserSessionSummary {
  navigationVersion?: 1 | undefined;
  workspaceTabRestoreVersion?: 1 | undefined;
  opener?: BrowserSessionOpener;
  tabCatalog?: BrowserTabCatalog;
  access: "full-control";
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
  /** The uses of this browser by the conversations this client shows. */
  uses?: readonly BrowserSessionUseSummary[];
  dialog: BrowserDialog | null;
  error: string | null;
  id: string;
  origin: "agent" | "trigger" | "workspace";
  placement: { kind: "runner"; runnerId: string };
  /** A temporary session can be signed in without a saved profile. */
  profileId: string | null;
  runtimeId: string;
  state: HostedBrowserSessionState;
  tabs: BrowserTabSummary[];
  viewerError: string | null;
  viewerState: "connecting" | "disconnected" | "synchronized";
  watchViewerError?: string | null;
  watchViewerState?: "connecting" | "disconnected" | "synchronized";
  workspaceId: string;
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
  readonly savedViewReadiness?: SavedViewReadiness;
  readonly latestPlaces?: readonly ThreadPlaceReference[];
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
  browserProfileGrants: BrowserProfileGrantSummary[];
  workspaceTabRestoreVersion?: 1 | undefined;
  workspaceTabs?: WorkspaceTabLineage[] | undefined;
  /** Tab activation calls owned by this client, before the Host reports restoration. */
  readonly activatingWorkspaceTabs?: readonly string[] | undefined;
  browserTabGroups?: BrowserTabLayout | undefined;
  browserAvailable: boolean;
  browserPlacements: BrowserPlacementSummary[];
  browserProfiles: BrowserProfileSummary[];
  browserSessions: BrowserSessionSummary[];
  connection: HostConnectionState;
  /** Reachability reported by the platform, distinct from Host availability. */
  network: ClientNetworkState;
  /**
   * The Deployment's declared axes. `defaultWorkspaceBacking` is what a new
   * Workspace gets when nobody chooses, and whether shared storage is offered
   * at all. Null until the first bootstrap lands.
   */
  deploymentShape: DeploymentShape | null;
  environments: EnvironmentSummary[];
  /**
   * What this person chose last, as the Host remembers it for them in this
   * Deployment. Empty until the first bootstrap lands, and the Host's word
   * thereafter: every app they open reads the same record.
   */
  executionPreferences: ExecutionPreferences;
  harnesses: HarnessSummary[];
  homeWorkspaceId: string | null;
  homeThreadId: string | null;
  notificationMutes: string[];
  threadReadStates: Record<string, ThreadReadState>;
  /**
   * The reader's tasks across every Workspace they belong to, from the Host's
   * task list and reread whenever it says they changed. Null until the first
   * page lands. Read state for each lives in `threadReadStates`.
   */
  tasks: TaskListState | null;
  /** All listed running or waiting tasks, across every Workspace, independent of history paging. */
  activeTasks: readonly TaskEntry[];
  /**
   * One Workspace's tasks, for each Workspace whose own list a screen asked
   * for with `loadWorkspaceTasks`; reread with `tasks` whenever they change.
   */
  workspaceTasks: Record<string, TaskListState>;
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
   * Thread started from a message is named from it by its engine.
   */
  threadRenameAvailable: boolean;
  /** The Host serves `task-marks-v1`: task icons and specialist colours can be chosen. */
  taskMarksAvailable: boolean;
  sharedTaskDoneAvailable?: boolean;
  workspaceTabReopenAvailable?: boolean;
  searchSuggestionsAvailable?: boolean;
  iphoneAppsAvailable: boolean;
  ownerViewWindowsAvailable?: boolean;
  threads: ThreadSummary[];
  transcriptWindows: Record<string, TranscriptWindow>;
  transcripts: Record<string, TranscriptEntry[]>;
  user: AuthenticatedUser | null;
  /** Host-declared deployment capability; false for Personal deployments. */
  workspaceSharingAvailable: boolean;
  workspaceWindow: DurableWindow;
  workspaces: WorkspaceSummary[];
}

/**
 * Everything a new Thread needs, named outright. The caller resolved where it
 * runs, on which account, with which model and access mode, and shows that
 * to the person before this is sent — the client fills nothing in on their
 * behalf.
 */
export interface CreateThreadInput {
  home?: true;
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
   * its engine to replace. Dropped for a Host without `thread-titles-v1`.
   */
  generateTitle?: true;
  workspaceId: string;
}

export interface CreateWorkspaceInput {
  icon?: WorkspaceIconName;
  name: string;
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
  workspaceId: string;
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

export interface WorkspaceMemberSummary {
  displayName: string;
  email: string;
  emailVerified: boolean;
  generation: number;
  id: string;
  invitedBy: string | null;
  joinedAt: string;
  role: "collaborator" | "owner";
  state: "active" | "revoked";
  userId: string;
  workspaceId: string;
}

export interface WorkspaceInvitationSummary {
  acceptedAt: string | null;
  acceptedBy: string | null;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  id: string;
  intendedEmail: string | null;
  revokedAt: string | null;
  role: "collaborator" | "owner";
  selector: string;
  type: "email" | "link";
  workspaceId: string;
}

export interface WorkspaceSharingSnapshot {
  invitations: WorkspaceInvitationSummary[];
  members: WorkspaceMemberSummary[];
}

export type InitialOwnerClaimInput = PasswordSignInInput;

export interface TriggerDetail {
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

type WorkspaceFileList = Extract<
  Awaited<ReturnType<HostApiClient["workspace.files.list"]>>,
  { readonly ok: true }
>["data"];

/** One page of a computer's session history, newest session first. */
export interface MachineAccessHistoryPage {
  readonly nextCursor: string | null;
  readonly sessions: readonly ShellSessionHistoryEntry[];
}

/** A conflict is not a failure: it means somebody else wrote first. */
export type MachineAccessUpdateOutcome =
  { readonly outcome: "conflict" } | { readonly outcome: "updated"; readonly revision: number };

export interface HostClient {
  readonly browserPasskeys?: BrowserPasskeys;
  readonly recentSites: RecentSitesStore;
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
    options?: ComputerViewMutationOptions,
  ): Promise<ComputerView>;
  closeComputerView(
    viewId: string,
    generation: number,
    options?: ComputerViewMutationOptions,
  ): Promise<ComputerView>;
  renewComputerView(
    viewId: string,
    generation: number,
    options?: ComputerViewMutationOptions,
  ): Promise<ComputerView>;
  readonly browserFrames: BrowserFrameStore;
  readonly browserWatchFrames: BrowserFrameStore;
  readonly rpc: HostApiClient;
  createAttachment(input: {
    readonly workspaceId: string;
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
  activateWorkspace(workspaceId: string): void;
  /** Starts a Thread and remembers its selection and access mode as the person's latest choice. */
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  createHome(
    input: Omit<CreateThreadInput, "parentThreadId" | "title" | "home">,
  ): Promise<ThreadSummary>;
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
  markThreadRead(threadId: string, throughSequence: string): Promise<void>;
  /** Sets shared Done or reopens the task. */
  setTaskDone(threadId: string, done: boolean): Promise<Thread>;
  /** Reads the first page of one Workspace's tasks and keeps that list current from then on. */
  loadWorkspaceTasks(workspaceId: string): Promise<void>;
  /** Reads the next page of the reader's task list, or of one Workspace's. */
  loadEarlierTasks(workspaceId?: string): Promise<void>;
  setWorkspaceNotificationMute(workspaceId: string, muted: boolean): Promise<void>;
  /**
   * Domain mutations, including `thread.icon.set` and `workspace.color.set`.
   * Mark edits are optimistic and require `taskMarksAvailable`; a refused
   * edit rolls back and rejects so its surface can show the Host's error.
   */
  dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput>;
  dispose(): void;
  getSnapshot(): HostSnapshot;
  listWorkspaceFiles(
    workspaceId: string,
    input: {
      readonly cursor?: string;
      readonly knownRevision?: string;
      readonly parentKey: string;
      readonly retainedCursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<WorkspaceFileList>;
  load(): Promise<void>;
  loadEarlierTranscript(threadId: string): Promise<void>;
  loadEarlierWorkspaces(): Promise<void>;
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
  previewWorkspaceFile(
    workspaceId: string,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview>;
  readonly retainBrowserViewer: (
    sessionId: string,
    surfaceId?: string,
    options?: {
      readonly picture?: boolean;
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      readonly rasterDemand?: boolean;
    },
  ) => () => void;
  /** Reads the verified Host descriptor's optional target-control capability. */
  readonly browserTargetControlAvailable?: () => Promise<boolean | null>;
  readonly retainBrowserWatch: (
    sessionId: string,
    surfaceId?: string,
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
  latestPlaceOfThread(threadId: string): ThreadPlace | null;
  subscribeLatestPlace(threadId: string, listener: () => void): () => void;
  readBrowserContextCandidate(sessionId: string, tabId: string): Promise<BrowserContextCandidate>;
  openBrowserTab(
    target: string | BrowserTabOpenInput,
    options?: BrowserTabOpenOptions,
  ): Promise<BrowserTabOpenResult>;
  readWorkspaceTabs?(sessionId: string): Promise<WorkspaceTabLineage | null>;
  activateWorkspaceTab?(
    tabId: string,
  ): Promise<z.infer<typeof WorkspaceTabActivateResultSchema> | null>;
  reopenWorkspaceTab?(): Promise<z.infer<typeof WorkspaceTabReopenResultSchema>>;
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
  closeWorkspaceTabs(tabIds: readonly string[]): Promise<{
    readonly closed: readonly string[];
    readonly failed: readonly { readonly tabId: string; readonly message: string }[];
  }>;
  closeBrowserTab(
    sessionId: string,
    surfaceId: string,
    expected: Pick<BrowserTabCatalog, "generation" | "revision" | "inventoryRevision">,
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
  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId?: string): void;
  /** Only a person's explicit Retry may reopen a terminal realtime refusal. */
  refresh(options?: { readonly retryConnection?: boolean }): Promise<void>;
  /**
   * Records a choice the person just made as what their next Thread starts
   * from, and updates the snapshot with the Host's merged answer. The
   * composer calls this when a control is used before any Thread exists;
   * the Thread mutations below call it themselves once the Host accepts.
   */
  rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences>;
  /**
   * Stands one of the reader's own queued messages in front of another, or
   * at the back when `beforeMessageId` is null. The snapshot's queue takes the
   * new order at once; a refusal rereads the Host's order and is rethrown.
   */
  moveThreadInput(
    threadId: string,
    messageId: string,
    beforeMessageId: string | null,
  ): Promise<void>;
  /** Lets a queue a Stop paused admit work again. Idempotent on the Host. */
  resumeThreadInputQueue(threadId: string): Promise<void>;
  sendBrowserCommand(sessionId: string, command: BrowserCommand): void;
  startBrowser(
    workspaceId: string,
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
  updateMachineAccess(input: {
    readonly expectedRevision: number;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: string;
  }): Promise<MachineAccessUpdateOutcome>;
  workspaceFileDownloadUrl(workspaceId: string, fileKey: string): string;
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
