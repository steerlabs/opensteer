import type { PluginChange } from "@opensteer/protocol";
import type { ClientScope } from "../connections/connection-controller.js";
import { failureProvenance } from "../connections/operation-error.js";
import type { ClientCommandInput } from "./device-commands.js";
import type { MachineAccessUpdateInput, IphoneScreenAttachInput } from "./device-commands.js";
import type { TabsClient } from "./tabs-contract.js";
import type { AnsweredQuestion } from "@opensteer/core";
import type { PersonShowMessage, PluginEngineStateView } from "@opensteer/protocol";
import type { DesktopUpdates } from "../connections/desktop-updates-contract.js";
import type { ChannelAccount, IntegrationConnection } from "@opensteer/channel-core";
import type {
  ArtifactContentPart,
  AssignmentSummary,
  AssignmentView,
  Attachment,
  AuthSessionId,
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
  MessageEdit,
  MessageKind,
  MessageQuote,
  MessageRevisionView,
  ModelSelection,
  NotificationView,
  PhoneContentPart,
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
  PersonName,
  ThreadInputPolicy,
  ThreadInputQueue,
  ThreadStatus,
  ToolIdentity,
  ToolOutput,
  WaitingRequest,
  IconName,
} from "@opensteer/core";
import type {
  OwnerProfileView,
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
  HostApiCommandOutput,
  HostEnvironmentStatus,
  MachineSummary,
  OwnerWindowInfo,
  ShellSessionHistoryEntry,
  ThreadMessagePage,
  ThreadMessageWindow,
} from "@opensteer/protocol";
import type {
  BrowserBinaryFrameHeader,
  BrowserClientMessage,
  BrowserDialog,
  BrowserSurfaceId,
  HostedBrowserSessionState,
} from "@opensteer/protocol/browser";
import type {
  Trigger,
  TriggerOccurrence,
  TriggerRevision,
  TriggerWatchActivation,
} from "@opensteer/triggers/models";
import type { BrowserEditingStore } from "./browser-editing.js";
import type { BrowserHistoryClient } from "./browser-history.js";
import type { BrowserPasskeys } from "./browser-passkeys.js";
import type { BrowserPreferences } from "./browser-preferences.js";
import type { ComputerViewRetention } from "./computer-view-retention.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import type { WebSocketClient } from "./host-session-client.js";
import type { SavedViewReadiness } from "./saved-host-view.js";
import type { NativeViewerSource } from "./surfaces.js";

import type { BrowserContextCandidate } from "@opensteer/protocol";
import type { BrowserWatchState } from "./browser-watch.js";
import type { ClientNetworkState } from "./lifecycle.js";
import type { PlaceActivity } from "./place-activity.js";

/** Who a new page browses as, and for a Guest the computer it opens on. */
export interface BrowserIdentityOpenInput {
  readonly identity: import("./start-page-model.js").BrowserIdentityChoice;
  readonly placement?: { readonly kind: "runner"; readonly runnerId: string };
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
  /** When the person stopped agents on this location's computer, while that holds. */
  agentsStoppedSince?: string | null | undefined;
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

/** The revision belongs to the request body returned by the same Host read. */
export type RequestView = Request & { readonly reviewedRevision?: string | undefined };
export type WaitingRequestView = Omit<WaitingRequest, "request"> & {
  readonly request: Extract<RequestView, { status: "pending" }>;
};

export function requestReviewRequired(): HostClientRequestError {
  return new HostClientRequestError({
    code: "conflict",
    reason: "request-review-required",
    status: 409,
    message: "Review the latest request before answering.",
  });
}

export function requestDecision(request: Pick<RequestView, "id" | "reviewedRevision">): {
  requestId: Request["id"];
  expectedRevision: string;
} {
  if (request.reviewedRevision === undefined) throw requestReviewRequired();
  return { requestId: request.id, expectedRevision: request.reviewedRevision };
}

export interface ThreadSummary {
  returnHint?: import("@opensteer/core").CompactionReturnHint | null | undefined;
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
  /** A Run waits to start and none is executing, as the shell's task row says. */
  runQueued?: boolean;
  /** A connected agent or a chat started this task, so the person's own engine rules do not apply. */
  startedByOther?: boolean | undefined;
  /** A connected agent works this task itself; Stop it with `agent.session.stop`. */
  agentSessionId?: string | null;
  /** A connected agent's own task: its session and connection, kept after the session ends. */
  externalWork?: import("@opensteer/protocol/personal-sync").PersonalTaskExternalWork | null;
  /** The chat or connected agent that started this task ended, so it takes no new messages. */
  endedOrigin?: "chat" | "agent" | null | undefined;
  /** Active provider retry on the task's executing Run, when retrying. */
  retry?: import("@opensteer/core").RunRetry | null;
  id: string;
  inputQueuePaused: boolean;
  /** One of the person's tasks in navigation lists; see the Host's `Thread.listed`. */
  listed: boolean;
  modelLabel: string;
  modelSelection: ModelSelection;
  parentThreadId: string | null;
  pendingRequests: number;
  purpose: import("@opensteer/core").TaskPurpose;
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
  maintenance?: Run["maintenance"];
  createdAt: string;
  id: string;
  status: "queued" | "starting" | "running" | "waiting";
  threadId: string;
  runOrdinal: number;
}

export interface MessageEntry {
  readonly itemId?: string;
  readonly itemRevision?: string;
  readonly previewTruncated?: boolean;
  /** The stream has a queued input, while the full queue view may still be on its way. */
  readonly queuePending?: true;
  readonly localDelivery?: {
    readonly inTranscript?: true;
    readonly phase: "waiting" | "sending" | "rejected" | "restoring";
    readonly attempted: boolean;
    readonly issue?: import("../feedback/client-issue.js").ClientIssue;
  };
  readonly clientSendKey?: string;
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
  /**
   * Set once a person edited the message while it waited; the content above
   * is already the edit. Its mark opens the history (`listMessageRevisions`).
   */
  edit?: MessageEdit;
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
  readonly itemId?: string;
  readonly itemRevision?: string;
  readonly previewTruncated?: boolean;
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
  tabId: import("@opensteer/core").TabId;
  runId: string;
  site: string | null;
  title: string;
}

export interface ToolEntry {
  readonly itemId?: string;
  readonly itemRevision?: string;
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
  /** A settled agent question's record, which the thread shows as its own row. */
  question?: AnsweredQuestion;
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
  retry?: import("@opensteer/core").RunRetry;
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
  /** The profile an AI engine signs in through; never offered to a connected agent. */
  purpose?: "engine-sign-in" | undefined;
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
  /** Host freshness for bootstrap lifecycle reconciliation. */
  updatedAt?: string;
  navigationVersion?: 1 | undefined;
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

export type ComputerViewRemovedListener = (
  view: Extract<
    import("@opensteer/protocol").HostToClientMessage,
    { type: "host.computer-view.removed" }
  >,
) => void;

export interface HostSnapshot {
  /** The person's tab catalog and layout, shared by every surface; patched row by row. */
  readonly tabs: import("./tab-store.js").TabStore;
  /** Bumped by host.apps.changed and every reconnect; an Apps page rereads on change. */
  readonly appsRevision: number;
  readonly appVersions?: Readonly<Record<string, number>>;
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
  /**
   * The pending Requests this person is the one to answer, wherever they were
   * asked, each with the handed-out work it holds up. "Needs you" on a task,
   * a sidebar row and the questions above a conversation all read this.
   */
  waitingRequests: readonly WaitingRequestView[];
  /**
   * The resource kinds whose first read has landed for this viewer. Until a kind is here, its
   * fields are unknown rather than empty: a surface says it is loading, never "none".
   */
  loadedResources: readonly import("@opensteer/protocol/resources").PersonalResourceKind[];
  /** Kinds whose newest read could not be installed (too large or malformed); the last complete one stays. */
  unreadableResources?: readonly import("@opensteer/protocol/resources").PersonalResourceKind[];
  runQueue: RunQueueEntry[];
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
  /**
   * What each Cloud Computer's pooled browser reports about its sleep, from the Home's browser
   * placements. Absent for every other Home. Read only through `browserSleepFromHome`.
   */
  browserPools?: readonly import("./browser-sleep.js").BrowserPoolReport[] | undefined;
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
  /** Undefined before the shell arrives and null when it reports a personal Home. */
  effectiveWorkPolicy?: import("@opensteer/control-plane-protocol").EffectiveWorkPolicy | null;
  needsYou: import("@opensteer/protocol").NeedsYouPage | null;
  attentionSummaries?: readonly import("zod").infer<
    typeof import("@opensteer/protocol/personal-sync").PersonalShellSnapshotSchema
  >["attention"][number][];
  pendingRequestCount?: number;
  needsYouCount?: number;
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
  machines: MachineSummary[];
  /** Bumped when a machine's access sessions change, so readers refetch. */
  machineRevision: number;
  /** The personal owner's name; null before bootstrap or from a Host that has none. */
  ownerProfile: OwnerProfileView | null;
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
  /** The Host serves `agent-images-v1`: transcript images load from the hosting computer. */
  agentImagesAvailable?: boolean;
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
  user: AuthenticatedUser | null;
  /** The signed-in person's relation to this Home, as the Home says it. Absent from older Homes. */
  role?: "owner" | "member";
  /** Recovery can replace the session with no other visible change, ending what was bound to it. */
  sessionId?: AuthSessionId;
}

export interface TranscriptFixtureSnapshot extends HostSnapshot {
  requests: Record<string, Request[]>;
  inputQueues: Record<string, ThreadInputQueue>;
  transcriptWindows: Record<string, TranscriptWindow>;
  transcripts: Record<string, TranscriptEntry[]>;
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
  compaction?: import("@opensteer/core").CompactionSendChoice;
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
  credentials: Readonly<Record<string, string>>;
  provider: string;
  routingMode: "dedicated" | "shared";
  deploymentId: string;
}

export interface CreatedChannelConnection {
  account: ChannelAccount;
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

/**
 * One device editing one waiting message. `revision` is the version the
 * lease was taken at. `touch` on every keystroke; renewals go out at most
 * every half minute. `save` replaces the message in place and ends the edit,
 * if the message is still at `expectedRevision`: the version the person's
 * words were written against (`WaitingDraft.baseRevision`). It rejects with
 * code `conflict` when the message was already taken or changed elsewhere,
 * leaving the person's text with them.
 */
export interface WaitingMessageEditor {
  /** The full body at `revision`, read under the lease: the only thing an edit opens from. */
  readonly content: readonly ContentPart[];
  readonly leaseId: string;
  readonly revision: number;
  touch(): void;
  /** The full body at `revision`, read under this lease: what a locked draft opens from. */
  read(revision: number): Promise<readonly ContentPart[]>;
  save(content: readonly ContentPart[], expectedRevision: number): Promise<MessageEdit>;
  cancel(): Promise<void>;
}

export interface HostClient extends TabsClient {
  readonly connection: import("../connections/connection-controller.js").ClientConnection;
  openConnection(
    attempt: import("../connections/connection-controller.js").ConnectionAttempt,
  ): Promise<import("../connections/connection-controller.js").ConnectionLease>;
  /**
   * What this device's own activation of a tab bound — its page session, its
   * view of a window or phone, or its app — until the tab leaves the list.
   */
  tabViewer(tabId: string): import("@opensteer/protocol").TabViewer | null;
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
  readonly iphoneSetup?: import("./iphone-setup.js").IphoneSetupPort | undefined;
  readonly browserPasskeys?: BrowserPasskeys;
  /**
   * Closes every page of this Cloud Computer's browser and starts it fresh. Refused with
   * `BrowserRestartUnavailable` for a browser the Home does not report as pooled; call
   * through `restartPooledBrowser`.
   */
  readonly restartPooledBrowser?: (computerId: string) => Promise<void>;
  /** Popups this client's own input opens from one tab, as each one opens. */
  readonly subscribeBrowserPopups?: (
    sessionId: string,
    surfaceId: string,
    listener: (popupId: string) => void,
  ) => () => void;
  readonly browserHistory: BrowserHistoryClient;
  readonly browserPreferences: BrowserPreferences;
  readonly subscribeComputerViewRemoved?: (listener: ComputerViewRemovedListener) => () => void;
  retainComputerView(
    viewId: string,
    generation: number,
    options?: { readonly visible?: boolean },
  ): ComputerViewRetention;
  /** The opaque windows of one approved app, for opening one exactly as a tab. */
  listComputerAppWindows(
    machineId: string,
    app: Extract<ComputerViewTarget, { kind: "app" }>["app"],
  ): Promise<readonly OwnerWindowInfo[]>;
  listApprovedComputerApps(): Promise<readonly ApprovedComputerApp[]>;
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
  readonly assetUrls?: import("./asset-urls.js").AssetUrlStore;
  readonly references: import("../references/store.js").ReferenceStore;
  readonly transcriptFiles: import("./transcript-files.js").TranscriptFileController;
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
  viewApp(
    appId: string,
    theme: "light" | "dark",
    signal?: AbortSignal,
  ): Promise<{ readonly title: string; readonly url: string }>;
  viewPluginPage(
    pluginId: string,
    theme: "light" | "dark",
    signal?: AbortSignal,
  ): Promise<{ readonly title: string; readonly url: string }>;
  getAttachment(attachmentId: string): Promise<Attachment>;
  readAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob>;
  discardAttachment(attachmentId: string): Promise<void>;
  activateThread(threadId: string): void;
  deactivateThread?(threadId: string): void;
  getThreadTranscript(
    threadId: string,
  ): import("./scoped-thread-reader.js").ThreadViewSource | undefined;
  getThreadItemText(
    threadId: string,
    nodeId?: string,
  ): import("./item-text-store.js").ItemTextStore | undefined;
  getCachedTranscriptItem?(
    threadId: string,
    itemId: string,
    nodeId?: string,
  ): import("@opensteer/protocol/transcript").TranscriptItemResult | undefined;
  subscribeTranscriptBody?(
    threadId: string,
    itemId: string,
    nodeId: string | undefined,
    listener: () => void,
  ): () => void;
  readTranscriptItem(
    threadId: string,
    itemId: string,
    nodeId?: string,
  ): Promise<import("@opensteer/protocol/transcript").TranscriptItemResult | undefined>;
  /**
   * The view's one-shot measurement of the row in view (undefined at the latest messages), asked
   * only when the client needs the reader's position: a repair, a subscription. Ordinary
   * scrolling is never reported. Null releases it.
   */
  setTranscriptPosition(threadId: string, measure: (() => string | undefined | null) | null): void;
  /**
   * The view has revealed the target of the reader's move under way (the linked message is on
   * screen, or the foot after Return to latest): the move has landed and gives up the position.
   * Until then a repair keeps centring on the move's target, and its page is read again.
   */
  revealedTranscriptMove(threadId: string): void;
  watchPersonalResource(
    kind: import("@opensteer/protocol/resources").PersonalResourceKind,
    listener: () => void,
  ): () => void;
  /**
   * Keeps another Thread's transcript, pending Requests and assignments live
   * while held, without changing the active conversation or its read state.
   * Returns the release; holds are counted.
   */
  observeThread(threadId: string): () => void;
  watchNode(threadId: string, nodeId: string): import("./node-detail.js").NodeDetailSubscription;
  /** Starts a Thread and remembers its selection and access mode as the person's latest choice. */
  createThread(input: CreateThreadInput, expectedLogin?: ClientScope): Promise<ThreadSummary>;
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
  /**
   * A move of the reader's: resolves true once its page landed, or false when a newer move (a
   * later jump, Return to latest, a scroll) superseded it, which then says nothing about the
   * message. Only a move that landed may judge what its page holds.
   */
  loadTranscriptAround(threadId: string, messageId: string): Promise<boolean>;
  loadLatestTranscript(threadId: string): Promise<boolean>;
  /**
   * What the Host decided this viewer should be told — a reply, a Request, a
   * failure — each delivered once while this client is attached. Nothing is
   * replayed: what was missed is still unread in its Thread.
   */
  subscribeNotifications(listener: (notification: NotificationView) => void): () => void;
  /** Invalidates remote administration on Host changes and stream recovery. */
  subscribePluginsChanged(
    listener: (message: { type: "host.plugins-changed" } & PluginChange) => void,
  ): () => void;
  /** The plugin engine's state as the Host reports it; nothing to reread. */
  subscribePluginEngine(listener: (engine: PluginEngineStateView) => void): () => void;
  subscribePersonalRemoteAccess(listener: () => void): () => void;
  /** Told when this person approves or revokes a connected agent on any device. */
  subscribeConnectionsChanged(listener: () => void): () => void;
  subscribePersonShow(listener: (message: PersonShowMessage) => void): () => void;
  visitThread(threadId: string, visitedAt: string): Promise<void>;
  /** Sets shared Done or reopens the task. */
  setTaskDone(threadId: string, done: boolean): Promise<void>;

  loadEarlierTasks(): Promise<void>;
  loadEarlierNeedsYou(): Promise<void>;
  /**
   * One Request of a task by id, settled or not; null once the Host has none.
   * Asks for device Requests as the rest of this client's Request reads do.
   */
  readRequest(threadId: string, requestId: string): Promise<RequestView | null>;

  loadDoneTasks(deploymentId?: string): Promise<void>;
  loadEarlierDoneTasks(deploymentId?: string): Promise<void>;
  setIdleCompactionPolicy(policy: import("@opensteer/core").IdleCompactionPolicy): Promise<void>;
  setQuietTaskDays(days: QuietTaskDays): Promise<void>;
  /** False when the Account already had a newer name, which the snapshot then shows. */
  setOwnerName(
    name: PersonName | null,
    /** `ownerProfile.version` when the person began editing. */
    expectedVersion: string | null,
  ): Promise<{ readonly applied: boolean }>;

  dispatch(
    command: ClientCommandInput,
    options?: { readonly preserveOrigin?: boolean; readonly expectedLogin?: ClientScope },
  ): Promise<HostApiCommandOutput>;
  /** Where a message sent now comes from; `dispatch` adds it to `thread.sendMessage`. */
  messageOrigin?(): import("@opensteer/core").MessageOrigin | undefined;
  dispose(): void;
  getSnapshot(): HostSnapshot;
  /** Reads these resource kinds again, for a screen that said it could not load them. */
  retryResources?(
    kinds: readonly import("@opensteer/protocol/resources").PersonalResourceKind[],
  ): void;
  /** A reader of its own (see `SnapshotReader`), for a client whose fields are read on demand. */
  readonly snapshotReader?: () => import("./host-snapshot-store.js").SnapshotReader;
  load(): Promise<void>;
  loadEarlierTranscript(threadId: string): Promise<void>;
  loadNewerTranscript(threadId: string): Promise<void>;
  loadMoreOverlays(threadId: string, kind: "requests" | "tools" | "nodes"): Promise<void>;
  /**
   * Takes back one of the reader's own queued messages before any Run picks
   * it up. The snapshot's queue drops it at once; a lost answer is retried
   * under the same key rather than as a second cancellation.
   */
  cancelThreadInput(threadId: string, messageId: string): Promise<void>;
  /**
   * Starts editing one waiting message in place on this device: takes its
   * edit lease (another device's only with `takeOver`), so no Run takes it
   * while the person types. The editor renews the lease as `touch` is called
   * and ends it on `save` or `cancel`; a lease that lapsed is not an error
   * until a save finds the message already taken.
   */
  editWaitingMessage(
    threadId: string,
    messageId: string,
    options?: { readonly takeOver?: boolean },
  ): Promise<WaitingMessageEditor>;
  /** Ends whichever device's edit lease holds a waiting message, so its queue can move. */
  releaseWaitingMessage(threadId: string, messageId: string): Promise<void>;
  /**
   * Whether this device holds that edit lease: an editor open here, rather
   * than another device. Settled before the Host reports the take, so a
   * queue read never shows this device's own edit as someone else's.
   */
  ownsEditLease(leaseId: string): boolean;
  /** One page of a message's versions, newest first. */
  listMessageRevisions(
    threadId: string,
    messageId: string,
    before?: number,
  ): Promise<{ readonly revisions: readonly MessageRevisionView[]; readonly hasMore: boolean }>;
  /**
   * Reads the Host's durable pending-input truth into `snapshot.inputQueues`;
   * transcript pagination is not authoritative. Activating a Thread reads its
   * queue and every event that touches it reads again, so no surface calls
   * this itself.
   */
  loadThreadInputQueue(threadId: string): Promise<import("@opensteer/protocol").PersonalInputQueue>;
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
  runPlace(runId: string): import("./run-place.js").RunPlace | null;
  subscribeRunPlace(runId: string, listener: () => void): () => void;
  readBrowserContextCandidate(sessionId: string, tabId: string): Promise<BrowserContextCandidate>;
  browserPresentationDeadline?(sessionId: string, tabId: string): number | null;
  markBrowserPagePresented?(sessionId: string, tabId: string): void;
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
  /** A page tab's stored site icon, whether or not this device has the page awake. */
  readBrowserTabIcon(tabId: string, iconRef: string): Promise<string | null>;
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
  stopMachineAccessSession(sessionId: string): Promise<boolean>;
  /**
   * Promotes one of the reader's own queued messages into the Run the queue
   * read named as steerable. The snapshot's queue drops it at once and the
   * transcript shows it; the Host restores it to the queue if the Run refuses.
   * A lost answer is retried under the same key, never as a second promotion.
   */
  steerThreadInput(threadId: string, messageId: string): Promise<void>;
  /** Stops the task's current work: the Run under way when the Host receives it. */
  stopRun(threadId: string, expectedRunId?: string): Promise<void>;
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
  attachIphoneScreen(
    input: IphoneScreenAttachInput,
  ): Promise<import("@opensteer/protocol").IphoneScreenAttachResult>;
  detachIphoneScreen(input: {
    readonly deviceId: string;
    readonly expectedGeneration: number;
    readonly idempotencyKey?: string;
  }): Promise<import("@opensteer/protocol").IphoneScreenDetachResult>;
  updateMachineAccess(input: MachineAccessUpdateInput): Promise<MachineAccessUpdateOutcome>;
}

export class HostClientRequestError extends Error {
  readonly code: string;
  /**
   * The Host's stable discriminator within that code, carried through
   * unchanged so a surface branches on `unsupported-version` rather than on
   * the sentence beside it. Undefined for refusals that need no distinction.
   */
  readonly reason: string | undefined;
  /** The Host's own word on whether the same call may succeed later. */
  readonly retryable: boolean;
  readonly status: number;
  readonly provenance: import("../connections/operation-error.js").ClientFailureProvenance;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly status: number;
    readonly provenance?: import("../connections/operation-error.js").ClientFailureProvenance;
  }) {
    super(options.message);
    this.name = "HostClientRequestError";
    this.code = options.code;
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.provenance = options.provenance ?? failureProvenance(options.reason ?? "");
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
    error.provenance === "host" &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Every HostSnapshot field a resource detail fills, with the kinds it reads. A real client's
 * snapshot watches these kinds the first time anything reads the field, so a screen that shows
 * one never stays empty for want of a separate watch.
 */
export const resourceBackedFields = {
  personalSettings: ["settings"],
  quietTaskDays: ["settings"],
  executionPreferences: ["settings"],
  voiceThreadId: ["settings"],
  identityConfig: ["identity"],
  ownerProfile: ["owner-profile"],
  environments: ["environment", "harness-catalog"],
  machines: ["machine"],
  machineRevision: ["machine"],
  harnesses: ["harness"],
  tabs: ["tab", "tab-layout"],
  browserProfiles: ["browser-profile"],
  browserProfileDeletions: ["browser-profile"],
  browserPlacements: ["browser-placement"],
  // A pooled browser's report rides the placement resource: reading it watches that kind.
  browserPools: ["browser-placement"],
  browserProfileHomes: ["browser-home"],
  browserAvailable: ["browser-availability"],
} as const satisfies Partial<
  Record<
    keyof HostSnapshot,
    readonly import("@opensteer/protocol/resources").PersonalResourceKind[]
  >
>;
