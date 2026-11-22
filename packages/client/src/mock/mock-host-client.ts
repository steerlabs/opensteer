import { ItemTextStore } from "../host/item-text-store.js";
import { scopedPersonalApiVersion } from "@opensteer/protocol/personal-sync";
import {
  mockMessageContent,
  mockOverlayRows,
  mockRequestRevision,
  mockScopedShell,
  mockScopedDetail,
  mockScopedItems,
  keepMockReceiptAsker,
  mockScopedLive,
  mockScopedCursor,
  mockScopedResource,
  boundedMockPage,
  mockInputQueue,
} from "./mock-scoped-personal.js";
import type { ThreadViewSource, ThreadViewState } from "../host/scoped-thread-reader.js";
import type { PluginChange } from "@opensteer/protocol";
import { nameConnectionFromHost } from "../host/host-connection.js";
import { disposeMessageOutbox } from "../host/message-outbox.js";
import {
  createConnectionController,
  type ClientScope,
  type ConnectionAttempt,
  type ConnectionController,
  type ConnectionLease,
} from "../connections/connection-controller.js";
import { classifyClientFailure } from "../connections/operation-error.js";
import { HostTransportError } from "../connections/host-transport-error.js";
import {
  DeviceComputerAppSetupRequestReaderSchema,
  type DeviceComputerAppSetupRequest,
} from "@opensteer/integration-core";
import type { ClientCommandInput } from "../host/device-commands.js";
import {
  DeviceIntegrationConnectionSummarySchema,
  type DeviceIntegrationConnectionSummary,
} from "@opensteer/integration-core";
import {
  clientCommandSchema,
  deviceAccessCommand,
  type MachineAccessUpdateInput,
} from "../host/device-commands.js";
import { deviceDriverKey } from "../host/device-projection.js";
import { mockDeviceMachine } from "./mock-device-machine.js";
import { mockPendingRequestsRevision } from "./mock-scoped-personal.js";
import {
  mockIphoneScreenDevice,
  mockIphoneScreenSession,
  type MockIphoneScreenState,
} from "./mock-screen-devices.js";
import { DeviceIdSchema, isPhoneDisplayDefinitionId } from "@opensteer/core";
import {
  DeviceMachineAccessUpdateCommandSchema,
  type IphoneScreenAttachCommand,
  type IphoneScreenDetachCommand,
} from "@opensteer/protocol";
import { NeedsYouPageSchema } from "@opensteer/protocol";
import {
  agentConnectionConsentRefusals,
  agentConnectionVerificationChangedMessage,
} from "@opensteer/protocol";
import { clearRunPageViews } from "../host/run-page-memory.js";
import { BrowserRestartUnavailable, type BrowserPoolReport } from "../host/browser-sleep.js";
import { mockBrowserPoolReport, type BrowserSleepScene } from "./browser-sleep-fixtures.js";
import { clearRunPlacePictures } from "../host/run-place-picture.js";
import { localReference } from "../references/local.js";
import type { IdReference } from "../references/links.js";
import { parseReferenceHref, type ReferenceId } from "@opensteer/core";
import { AssetUrlStore } from "../host/asset-urls.js";
import { ReferenceStore } from "../references/store.js";
import { TranscriptFileController } from "../host/transcript-files.js";
import { openWaitingMessageEditor } from "../host/waiting-message-editor.js";
import { deviceAccess } from "@opensteer/protocol";
import { hostsDeployment } from "../computers/computers.js";
import { heldThread, listedRowThreadId } from "../host/task-list.js";
import { familyAutomations } from "../host/task-family.js";
import { DeploymentSnapshotSchema } from "@opensteer/protocol";
import { firstTriggerFireAt } from "@opensteer/triggers/schedule";
import { mockPersonalFolder } from "./personal-fixtures.js";
import type {
  MockBrowserSource as HostSnapshot,
  MockBrowserSession as BrowserSessionSummary,
} from "./mock-browser-source.js";
import { BrowserSessionIdSchema } from "@opensteer/core";
import type { PersonalTabLineage } from "../host/client.js";
import { MockTabCatalog, seedMockApps } from "./mock-tabs.js";
import { placeList as tabPlaceList } from "../host/places.js";
import type { WindowId } from "@opensteer/core";
import { createTabsClient, type TabsClientPort } from "../host/tabs-client.js";
import { TabViewers } from "../host/tab-viewers.js";
import type { TabsClient } from "../host/tabs-contract.js";
import { TabIdSchema, type App, type TabId, type TabTarget } from "@opensteer/core";
import type {
  AppCommand,
  AppCommandResult,
  PluginCommand,
  PluginEngineStateView,
  PluginRequirementTarget,
  TabCommand,
  TabCommandResult,
} from "@opensteer/protocol";
import { seedMockSubagents } from "./mock-subagents.js";
import { seedMockSubagentScene, type MockSubagentScene } from "./mock-subagent-scenes.js";
import type { NodeDetailSnapshot, NodeDetailSubscription } from "../host/node-detail.js";
import { nodeTranscriptCard } from "../host/transcript-item-view.js";

import {
  CreateBrowserProfileBodySchema,
  personalRemoteAdministrationChangedReason,
} from "@opensteer/protocol";
import { browserProfileHomeCommand } from "../host/browser-access.js";
import {
  mockDeviceAccessRequest,
  mockDevicePlugins,
  mockDeviceTasks,
  mockLightsServerSetup,
  mockTvPairingRequest,
  type MockDevicePlugin,
} from "./mock-devices.js";
import {
  answeredQuestionPreviewBytes,
  answeredQuestionWithin,
  matchModelSelection,
  storedModelSelection as coreStoredModelSelection,
} from "@opensteer/core";
import {
  EnvironmentIdSchema,
  ExecutionNodeIdSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  ModelIdSchema,
  backgroundModelWants,
  excludedBackgroundAccounts,
  modelEffortLabel,
  resolveModelCandidates,
  type AgentHomeSettings,
  type BackgroundModelRole,
  type QuietTaskDays,
  type PersonName,
} from "@opensteer/core";
import {
  AutomaticModelsViewSchema,
  type AgentHomeSettingsFileView,
  type AutomaticModelsView,
  type OwnerProfileView,
} from "@opensteer/protocol";
import { MockDesktopUpdates, type MockDesktopUpdateScenario } from "./mock-desktop-updates.js";
import {
  isMockSignInCommand,
  MockPlugins,
  type MockPluginScenario,
  mockPluginAccountConsent,
  mockPluginRequests,
} from "./mock-plugins.js";
import { MockSettingsFixtures } from "./settings-fixtures.js";
import type { PasswordSignInCard } from "@opensteer/protocol";
import { BrowserCursorStore } from "../host/browser-cursor.js";
import type { PersonShowMessage, PluginRow } from "@opensteer/protocol";
import { RunPlaceStore } from "../host/run-place.js";
import { compareTaskOrder } from "../host/task-entries.js";
import { sharedDisplayStreams } from "../integrations/phone-display-stream.js";

import { BrowserPasskeys } from "../host/browser-passkeys.js";
import { BrowserPreferences } from "../host/browser-preferences.js";

import { sha256 } from "@noble/hashes/sha2.js";
import { channelProviderCatalog } from "@opensteer/channel-core";
import {
  PlaceEnteredEventViewSchema,
  AssignmentIdSchema,
  AssignmentSummarySchema,
  AssignmentViewSchema,
  AttachmentSchema,
  BrowserSurfaceIdSchema,
  DEFAULT_THREAD_ACCESS_MODE,
  DeploymentIdSchema,
  MessageIdSchema,
  MessageAuthorSchema,
  MessageSchema,
  ModelSelectionSchema,
  NotificationViewSchema,
  PendingRequestSchema,
  ProviderContinuationIdentitySchema,
  RequestIdSchema,
  RequestSchema,
  ResolvedRequestSchema,
  RunSchema,
  RunnerIdSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  ThreadInputQueueViewSchema,
  ThreadInputSchema,
  ThreadSchema,
  ThreadTitleSchema,
  UserIdSchema,
  attachmentMaxBytes,
  attachmentNativeImageMediaTypes,
  createId,
  defaultTaskSymbol,
  emptyExecutionPreferences,
  markColorAllocationOrder,
  moveQueueItem,
  nextMarkColor,
  notificationBodyMaxCharacters,
  notificationTitleMaxCharacters,
  provisionalThreadTitle,
  rememberExecutionChoice,
  requestFormAnswersProblem,
  requestOptionDeclines,
  requestTitleText,
  sameProviderContinuationIdentity,
  type AgentEvent,
  AgentEventSchema,
  type AssignmentSummary,
  type AssignmentView,
  type Attachment,
  type AuthSessionSummary,
  type BrowserPageContentPart,
  type ContentPart,
  type ExecutionPreferences,
  type ExecutionChoice as HostExecutionChoice,
  type MarkColor,
  type Message,
  type ModelSelection,
  type NotificationView,
  type Request,
  type RequestResponse,
  type Run,
  type Thread,
  type ThreadAccessMode,
  type ThreadInput,
  type ThreadInputEditLeaseView,
  type ThreadInputQueue,
  type ThreadVisit,
  type WaitingRequest,
  type IconName,
  type MessageEdit,
  type MessageRevisionView,
  threadInputEditLeaseMs,
} from "@opensteer/core";
import type {
  ComputerAppIdentity,
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
  IntegrationGrant,
} from "@opensteer/integration-core";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import { SetComputerAppConnectionSchema } from "@opensteer/integration-core/computer-app-setup";
import { type CreateIntegrationGrant } from "@opensteer/integration-core/models";
import type { PasswordSignInRequestResponse } from "@opensteer/protocol";
import {
  AgentPhoneHostTargetSchema,
  ComputerUseSessionSummarySchema,
  HarnessInstanceCatalogSchema,
  type HarnessInstallation,
  HostApiErrorSchema,
  HostedBrowserSessionSchema,
  browserUsageTabsPerRun,
  browserUsageSessionsPerRead,
  computerAppIdentityKey,
  hostApi,
  messageRevisionsPageSize,
  machineAccessPolicyDefault,
  previousReleaseEligibility,
  rpcSuccess,
  taskLineMaxLength,
  type ComputerUseInstalledApp,
  type HarnessInstanceCatalog,
  type HarnessModelDescriptor,
  type HarnessSourceDescriptor,
  type HarnessSetupMethod,
  type HostApiClient,
  type HostApiCommand,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
  type MachineAccessPolicy,
  type MachineSummary,
  type ModelServer,
  type ThreadMessagePage,
} from "@opensteer/protocol";
import type { BrowserSignInOutcome } from "@opensteer/protocol/browser-sources";
import { delay } from "@opensteer/shared/delay";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import {
  TriggerOccurrenceSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  TriggerWatchActivationSchema,
  MANAGED_MEMORY_REFUSAL,
  type Trigger,
  type TriggerOccurrence,
  type TriggerRevision,
  type TriggerSource,
  type TriggerSummary,
  type TriggerWatchActivation,
} from "@opensteer/triggers/models";
import { z } from "zod";
import { accessModeUnavailableReason } from "../host/access-modes.js";
import { BrowserHistoryClient } from "../host/browser-history.js";
import type { BrowserPreferencesStorage } from "../host/browser-preferences.js";
import type {
  BrowserCommand,
  BrowserFrameStore,
  CreateHarnessInstanceInput,
  CreateThreadInput,
  HarnessAuthenticationEnvelope,
  HarnessSummary,
  HostClient,
  TranscriptFixtureSnapshot as PublicHostSnapshot,
  MachineAccessHistoryPage,
  MachineAccessUpdateOutcome,
  MessageEntry,
  ReasoningEntry,
  ResolveRequestInput,
  RunEntry,
  RunQueueEntry,
  SendMessageInput,
  TaskEntry,
  TaskListState,
  ThreadSummary,
  ToolEntry,
  TranscriptEntry,
  UpdateThreadAccessModeInput,
  UpdateThreadExecutionInput,
  WaitingMessageEditor,
} from "../host/client.js";
import {
  HostClientRequestError,
  mainDoneTasks,
  requestReviewRequired,
  type RequestView,
  type WaitingRequestView,
} from "../host/client.js";
import { computerViewMethods } from "../host/computer-views.js";
import type { ExecutionChoice, ExecutionSelection } from "../host/execution-preferences.js";
import { createInMemoryHostApiClient } from "../host/host-api-client.js";
import {
  rpcErrorStatus,
  unwrapRpcResult,
  type WebSocketClient,
} from "../host/host-session-client.js";
import type { ClientLifecycle } from "../host/lifecycle.js";
import type { NativeViewerSource } from "../host/surfaces.js";
import { threadStopTarget } from "../host/thread-activity.js";
import {
  resolveThreadPlacement,
  threadPlacementOptions,
  type ThreadPlacementOption,
} from "../host/thread-placement.js";
import { isThreadUnread } from "../host/thread-unread.js";
import { withPublishedReplies } from "../host/thread-visits.js";
import { ThreadStateProjection } from "../host/thread-state.js";
import {
  assignmentReturnId,
  finishRunEntries,
  isTerminalRunEntryStatus,
  requestReceipt,
  threadInputDelivery,
  withEditedMessage,
} from "../host/transcript.js";
import { ViewerScope, viewerScopeOf } from "../host/viewer-scope.js";
import { mockAppIcons } from "./mock-app-icons.js";
import {
  mockNightlyTriggerId,
  mockTriggerSummary,
  seedMockAutomations,
  type MockTriggerRecord,
} from "./mock-automations.js";
import { MockChromeSignIns } from "./mock-chrome-sign-ins.js";
import { personalResourceKinds } from "@opensteer/protocol/resources";
import { mockAgentWork, mockAgentWorkThreads } from "./mock-agent-work.js";
import { mockComputerUseMessageId, mockComputerUseTurn } from "./mock-computer-use-transcript.js";
import { MockComputerViews } from "./mock-computer-views.js";
import {
  createInitialIntegrationState,
  mockAgentPhoneRunnerId,
  mockComputerAppInstallation,
  mockComputerAppTools,
  mockComputerUseApps,
  mockComputerUseDefinition,
  mockIntegrationDefinitions,
  mockIphoneAppDefinitions,
  mockMessagesRunnerId,
  mockNotesServer,
  mockLocalServerInstallation,
} from "./mock-integration-fixtures.js";
import { MockPhoneDisplaySocket } from "./mock-phone-display.js";
import {
  MockPlaceWorld,
  seedMockPlaces,
  type MockPlaceEntry,
  type MockPlaceScript,
  type MockPlacesWorld,
} from "./mock-places.js";
import { mockGeneratedTaskIcon, seedMockTaskMarks } from "./mock-task-marks.js";

async function* binaryChunks(body: Blob, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = body.stream().getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

// A mock launch represents the same signed-in person and seeded requests, so
// account-scoped device preferences and drafts behave like a real attachment.
const mockUserId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const mockMainDeploymentId = "dep_00000000-0000-4000-8000-000000000001";

/** Where the preview is served; a pairing names it as the address Chrome connects to. */
function mockPreviewOrigin(): string {
  const origin = globalThis.location?.origin;
  return origin && /^https?:/u.test(origin) ? origin : "http://127.0.0.1:4315";
}
const mockPendingRequestId = RequestIdSchema.parse("req_0192f4a1-1111-4000-8000-000000000001");
/**
 * A Request with far more in it than fits under a transcript: enough choices,
 * and enough words, that the docked Request has to scroll inside itself for its
 * Send to stay reachable. It exists so that case can be exercised in the mock,
 * on a phone as well as in a browser.
 */
const mockLongFormRequestId = RequestIdSchema.parse("req_0192f4a1-2222-4000-8000-000000000002");
const mockPersonQuestionRequestId = RequestIdSchema.parse(
  "req_0192f4a1-2222-4000-8000-000000000044",
);
// Three tasks waiting on a plugin: an account to link, a write to approve and a
// tool's own form, each answered inline and from Needs you.
const mockPluginTasks = [
  {
    kind: "account" as const,
    threadId: "thr_00000000-0000-4000-8000-0000000000e1",
    runId: "run_00000000-0000-4000-8000-0000000000e1",
    requestId: "req_00000000-0000-4000-8000-0000000000e1",
    messageId: "msg_00000000-0000-4000-8000-0000000000e1",
    title: "Triage my GitHub notifications",
    body: "Go through my GitHub notifications and summarise what needs me.",
    createdAt: "2026-11-16T20:10:00.000Z",
  },
  {
    kind: "approval" as const,
    threadId: "thr_00000000-0000-4000-8000-0000000000e2",
    runId: "run_00000000-0000-4000-8000-0000000000e2",
    requestId: "req_00000000-0000-4000-8000-0000000000e2",
    messageId: "msg_00000000-0000-4000-8000-0000000000e2",
    title: "Close ENG-412 in Linear",
    body: "ENG-412 shipped yesterday, close it out and give it to Sam for follow-up.",
    createdAt: "2026-11-16T20:20:00.000Z",
  },
  {
    kind: "input" as const,
    threadId: "thr_00000000-0000-4000-8000-0000000000e3",
    runId: "run_00000000-0000-4000-8000-0000000000e3",
    requestId: "req_00000000-0000-4000-8000-0000000000e3",
    messageId: "msg_00000000-0000-4000-8000-0000000000e3",
    title: "File the login crash in Linear",
    body: "File a Linear issue for the login crash we saw this morning.",
    createdAt: "2026-11-16T20:30:00.000Z",
  },
];

/**
 * Computer use as the preview shows it: the architecture Thread is using Notes
 * on the Mac mini right now and has asked for Numbers, which waits for the
 * person at that Mac.
 */
const mockComputerUseThreadId = "thr_00000000-0000-4000-8000-000000000001";
export const mockReferenceFailureId = ThreadIdSchema.parse(mockComputerUseThreadId);
const mockstorageThreadId = "thr_00000000-0000-4000-8000-000000000002";
const mockComputerUseRequestId = RequestIdSchema.parse("req_0192f4a1-6666-4000-8000-000000000006");
const mockComputerUseSetupRequestId = "0192f4a1-4444-4000-8000-000000000004";
const mockComputerUseReason = "Put the architecture decisions into the Q4 planning sheet.";
const mockComputerUseSession = ComputerUseSessionSummarySchema.parse({
  actionCount: 12,
  apps: [mockComputerUseApps.notes],
  display: false,
  openedAt: "2026-08-09T16:41:00.000Z",
  runId: "run_00000000-0000-4000-8000-000000000001",
  sessionId: "cus_0192f4a1-5555-4000-8000-000000000005",
  threadId: mockComputerUseThreadId,
  threadTitle: "Build the new architecture",
});
/**
 * The preview's Slack Threads clicked through Slack on the Mac mini, and the
 * one still clicking holds it there, so its turn says so with Stop.
 */
const mockSlackOnMacMini = {
  app: "Slack",
  bundleId: "com.tinyspeck.slackmacgap",
  computer: "Mac mini",
  runnerId: DeviceIdSchema.parse(mockMessagesRunnerId),
} as const;
const mockSlackLiveSession = ComputerUseSessionSummarySchema.parse({
  actionCount: 7,
  apps: [{ bundleId: mockSlackOnMacMini.bundleId, displayName: "Slack", teamId: "BQR82RBBHL" }],
  display: false,
  openedAt: "2026-08-06T23:28:24.000Z",
  runId: "run_00000000-0000-4000-8000-000000000006",
  sessionId: "cus_0192f4a1-7777-4000-8000-000000000007",
  threadId: "thr_00000000-0000-4000-8000-000000000006",
  threadTitle: "Switch Slack to Opensteer",
});
/**
 * The preview's agent phone, held whole by one Thread: a display session names
 * no app, because it has the phone's entire screen.
 */
const mockAgentPhoneSession = ComputerUseSessionSummarySchema.parse({
  actionCount: 5,
  apps: [],
  display: true,
  openedAt: "2026-10-11T09:20:00.000Z",
  runId: "run_00000000-0000-4000-8000-000000000007",
  sessionId: "cus_0192f4a1-8888-4000-8000-000000000008",
  threadId: "thr_00000000-0000-4000-8000-000000000007",
  threadTitle: "Check the delivery app for the order",
});
/**
 * A task asking to use the agent phone, for previews that pass it in
 * `pendingRequests`: a phone is asked for whole, so the Request names no app,
 * and its owner allows or declines it from any Opensteer app.
 */
export const mockAgentPhoneAccessRequest = RequestSchema.parse({
  callId: "mock-agent-phone-access",
  cancellationReason: null,
  createdAt: "2026-10-11T09:30:00.000Z",
  id: "req_0192f4a1-7777-4000-8000-000000000007",
  kind: "computer.app.access",
  mode: "durable",
  originatingOccurrenceId: null,
  originatingRunId: "run_00000000-0000-4000-8000-000000000001",
  originatingThreadId: mockComputerUseThreadId,

  payload: {
    access: "read-write",
    app: null,
    definitionId: "android-phone",
    kind: "computer.app.access",
    reason: "Check the order status in the delivery app.",
    runnerId: mockAgentPhoneRunnerId,
    setupRequestId: "0192f4a1-9999-4000-8000-000000000009",
  },
  presentation: {
    detail:
      "Check the order status in the delivery app. Pixel 7 — can see and control. Allow or decline from any Opensteer app.",
    kind: "external",
    subject: { id: "0192f4a1-9999-4000-8000-000000000009", kind: "computer-app-setup" },
    title: "Wants to see and control Pixel 7",
  },
  requestedBy: mockUserId,
  requiredActor: "owner",
  resolvedAt: null,
  resolvedBy: null,
  response: null,
  status: "pending",
});
/**
 * Where the preview's Host says a phone reaches it, as the real Host builds
 * it, named as the preview's Personal Deployment names itself.
 */
const mockAgentPhonePairingTarget = AgentPhoneHostTargetSchema.parse({
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  deploymentName: "Mac mini",
  hostInstanceId: "hst_00000000-0000-4000-8000-000000000001",
  hostUrl: "https://mac-mini.opensteer.example",
});
/** What a Mac with computer use set up has installed, for the picker. */
const mockInstalledApps: readonly ComputerAppIdentity[] = [
  mockComputerUseApps.calendar,
  { bundleId: "com.apple.finder", displayName: "Finder", teamId: null },
  { bundleId: "com.apple.mail", displayName: "Mail", teamId: null },
  mockComputerUseApps.notes,
  mockComputerUseApps.numbers,
  { bundleId: "com.apple.iWork.Pages", displayName: "Pages", teamId: null },
  { bundleId: "com.apple.Preview", displayName: "Preview", teamId: null },
  { bundleId: "com.apple.reminders", displayName: "Reminders", teamId: null },
  mockComputerUseApps.safari,
  { bundleId: "com.apple.systempreferences", displayName: "System Settings", teamId: null },
];

type CommandInputOf<Type extends HostApiCommandInput["type"]> = Extract<
  HostApiCommandInput,
  { readonly type: Type }
>;
type ParsedCommandOf<Type extends HostApiCommand["type"]> = Extract<
  HostApiCommand,
  { readonly type: Type }
>;
type CommandOutputOf<Type extends HostApiCommandOutput["type"]> = Extract<
  HostApiCommandOutput,
  { readonly type: Type }
>;
type RpcData<Name extends keyof HostApiClient> = Extract<
  Awaited<ReturnType<HostApiClient[Name]>>,
  { readonly ok: true }
>["data"];

const DeclinedIntegrationAccessDecisionSchema = z.strictObject({
  decision: z.literal("declined"),
});
const MainIntegrationAccessResponseSchema = z.strictObject({
  kind: z.literal("external"),
  value: z.discriminatedUnion("decision", [
    DeclinedIntegrationAccessDecisionSchema,
    z.strictObject({
      connectionId: z.string().nullable(),
      decision: z.literal("fulfilled"),
    }),
  ]),
});

function mockHumanAuthor(): MessageEntry["author"] {
  return {
    displayName: "Alex",
    kind: "human",
    principalId: `user:${mockUserId}`,
    userId: mockUserId,
  };
}

function mockAgentAuthor(runId: string, threadId: string): MessageEntry["author"] {
  return MessageAuthorSchema.parse({
    displayName: "Opensteer",
    kind: "agent",
    runId,
    threadId,
  });
}

/** A cross-thread arrival: authorship is the sending thread, not this one. */
function mockCrossThreadAuthor(): MessageEntry["author"] {
  return MessageAuthorSchema.parse({
    displayName: "Prepare the product launch",
    kind: "agent",
    runId: "run_00000000-0000-4000-8000-000000000003",
    threadId: "thr_00000000-0000-4000-8000-000000000003",
  });
}

function mockTriggerAuthor(): MessageEntry["author"] {
  return MessageAuthorSchema.parse({
    displayName: "Nightly typecheck",
    kind: "trigger",
    occurrenceId: "toc_00000000-0000-4000-8000-000000000001",
    source: "schedule",
    triggerId: mockNightlyTriggerId,
  });
}
const mockCodexHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000001";
const mockClaudeHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000002";
const mockOpencodeHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000003";
const mockCodexSecondHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000004";
// An account of the same engine pointed at a compatible endpoint: another
// source of one driver, billed by an API key rather than a plan.
const mockOpenRouterHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000005";
const mockPiHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000006";
const mockCursorHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000007";
/** The Cursor account on the work location whose computer has no Cursor CLI. */
const mockAwaySiteCursorHarnessInstanceId = "hin_00000000-0000-4000-8000-000000000008";
/** What an engine that translates every mode declares — Codex and Claude Code do. */
const mockEveryAccessMode = ThreadAccessModeSchema.options;
/**
 * What OpenCode, Pi and Cursor declare: every mode but `auto`, which needs a
 * routine/non-routine judgement none of the three engines makes.
 */
const mockThreeAccessModes = ThreadAccessModeSchema.options.filter((mode) => mode !== "auto");
/** The work location whose computer has no Cursor CLI on it. */
const mockAwaySiteEnvironmentId = "env_00000000-0000-4000-8000-000000000002";
/** Exactly what the Cursor driver reports when the CLI is not installed. */
const mockCursorNotInstalledReason =
  "Cursor's CLI is not installed on this computer. Install it from https://cursor.com/install";
const mockCodexModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const mockCodexContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:pSxxBxKt_qvmNsPlmqubr_-fIkTpCjm-99Sj5xDpX6o",
  driverKind: "codex",
});
const mockClaudeContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:d1b7Rhh1p_M3JPt3vlXtIn1L0FRu8NbrrNP4pJKv7L0",
  driverKind: "claude",
});
const mockOpencodeContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:nPF8q7WZ7blhT3sCyIF96XEGMuWlPJciafqJ_ukGZdw",
  driverKind: "opencode",
});
// A second Codex account: same engine, its own provider conversation, so the
// picker has two profiles of one driver to tell apart.
const mockCodexSecondContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:eJ5PxewcryNN0hWiEKAqZJrYDT2PupqmIqVe6tcSsN8",
  driverKind: "codex",
});
const mockOpenRouterContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:TWtLUcUv8Gm9lxjYPDyBrHv4XEPRVeKIlHYX1SHtq6E",
  driverKind: "codex",
});
const mockPiContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:S3aiiJk4mheXQGVhNrTeGe18ASz30mjaOn5uVMa3Ct0",
  driverKind: "pi",
});
const mockCursorContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  continuationKey: "runner:v1:Ky4W8i_7nCPZlOZXF-nnLvYAVeX-iJBBoTzu4A0XsCY",
  driverKind: "cursor",
});
const mockCodexCatalog = HarnessInstanceCatalogSchema.parse({
  setupMethods: [
    {
      kind: "device-code",
      methodId: "device-code",
      label: "Sign in with ChatGPT",
      connectionSlot: "primary",
    },
  ],
  connections: [
    {
      accountLabel: "demo@opensteer.test",
      authKind: "subscription",
      billingLabel: "Pro",
      connectionSlot: "primary",
      label: "Codex",
      logoutSupported: true,
      status: "connected",
      usage: {
        limitReached: false,
        observedAt: "2026-01-05T09:00:00.000Z",
        windows: [
          { label: "weekly", resetsAt: "2026-01-08T15:15:00.000Z", usedPercent: 39 },
          { label: "5h", resetsAt: "2026-01-05T13:00:00.000Z", usedPercent: 12 },
        ],
      },
    },
  ],
  continuationIdentity: mockCodexContinuationIdentity,
  driverKind: "codex",
  harnessInstanceId: mockCodexHarnessInstanceId,
  models: [
    {
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      modelId: "gpt-5.6-sol",
      options: [
        {
          defaultValue: "low",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            { label: "Minimal", value: "minimal" },
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
            { label: "Extra High", value: "xhigh" },
          ],
        },
        {
          defaultValue: "default",
          id: "speed",
          label: "Speed",
          type: "select",
          values: [
            { label: "Standard", value: "default" },
            { description: "1.5x speed, increased usage", label: "Fast", value: "priority" },
          ],
        },
      ],
      providerId: "openai",
    },
    {
      displayName: "GPT-5.6-Terra",
      isDefault: false,
      modelId: "gpt-5.6-terra",
      options: [
        {
          defaultValue: "medium",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
        },
      ],
      providerId: "openai",
    },
  ],
  status: "ready",
});
// The same engine and the same models under a second account, which is the
// case a single default per (work location, engine) exists to settle.
const mockCodexSecondCatalog = HarnessInstanceCatalogSchema.parse({
  setupMethods: mockCodexCatalog.setupMethods,
  connections: [
    {
      accountLabel: "alex@opensteer.test",
      authKind: "subscription",
      billingLabel: "Team",
      connectionSlot: "primary",
      label: "Codex",
      logoutSupported: true,
      status: "connected",
      usage: {
        limitReached: false,
        observedAt: "2026-01-05T09:00:00.000Z",
        windows: [{ label: "weekly", resetsAt: "2026-01-08T15:15:00.000Z", usedPercent: 4 }],
      },
    },
  ],
  continuationIdentity: mockCodexSecondContinuationIdentity,
  driverKind: "codex",
  harnessInstanceId: mockCodexSecondHarnessInstanceId,
  models: mockCodexCatalog.models,
  status: "ready",
});
const mockClaudeCatalog = HarnessInstanceCatalogSchema.parse({
  setupMethods: [
    {
      kind: "browser-code",
      methodId: "browser-code",
      label: "Sign in with Claude",
      connectionSlot: "primary",
    },
  ],
  connections: [
    {
      accountLabel: "demo@opensteer.test",
      authKind: "subscription",
      billingLabel: "Max",
      connectionSlot: "primary",
      label: "Claude Code",
      logoutSupported: true,
      status: "connected",
    },
  ],
  continuationIdentity: mockClaudeContinuationIdentity,
  driverKind: "claude",
  harnessInstanceId: mockClaudeHarnessInstanceId,
  models: [
    {
      displayName: "Claude Sonnet 5",
      isDefault: true,
      modelId: "claude-sonnet-5",
      options: [
        {
          defaultValue: "default",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            {
              description: "Claude Code chooses for this model",
              label: "Default",
              value: "default",
            },
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
            { label: "Max", value: "max" },
          ],
        },
      ],
      providerId: "anthropic",
    },
    {
      displayName: "Claude Opus 5",
      isDefault: false,
      modelId: "claude-opus-5",
      options: [
        {
          defaultValue: "default",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            {
              description: "Claude Code chooses for this model",
              label: "Default",
              value: "default",
            },
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
            { label: "Extra High", value: "xhigh" },
            { label: "Max", value: "max" },
          ],
        },
        { defaultValue: false, id: "fast", label: "Fast mode", type: "toggle" },
      ],
      providerId: "anthropic",
    },
  ],
  status: "ready",
});
// A second harness reporting the same canonical (providerId, modelId) pairs —
// exercises the picker's model-centric grouping ("via Codex / via opencode").
const mockOpencodeCatalog = HarnessInstanceCatalogSchema.parse({
  setupMethods: [
    {
      kind: "secret-input",
      methodId: "api-key",
      label: "API key",
      inputLabel: "API key",
      connectionSlot: "primary",
    },
  ],
  continuationIdentity: mockOpencodeContinuationIdentity,
  driverKind: "opencode",
  harnessInstanceId: mockOpencodeHarnessInstanceId,
  models: [
    {
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      modelId: "gpt-5.6-sol",
      options: [
        {
          defaultValue: "medium",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
        },
      ],
      providerId: "openai",
    },
    {
      displayName: "Claude Sonnet 5",
      isDefault: false,
      modelId: "claude-sonnet-5",
      options: [
        {
          defaultValue: "medium",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
        },
      ],
      providerId: "anthropic",
    },
  ],
  status: "ready",
});
// A compatible endpoint reports whatever it serves, from providers the engine's
// own lab has nothing to do with, and bills an API key rather than a plan. Its
// models keep the endpoint's own spelling as `nativeModelId`: the canonical
// pair groups them with the same models served elsewhere, and the native id is
// the only string this endpoint answers to.
const mockOpenRouterCatalog = HarnessInstanceCatalogSchema.parse({
  connections: [
    {
      // No billing label: the driver emits one only when it says something
      // `authKind` does not, and "API key" would only repeat it.
      authKind: "api-key",
      connectionSlot: "primary",
      label: "openrouter.ai",
      logoutSupported: true,
      status: "connected",
    },
  ],
  continuationIdentity: mockOpenRouterContinuationIdentity,
  driverKind: "codex",
  harnessInstanceId: mockOpenRouterHarnessInstanceId,
  models: [
    {
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      modelId: "gpt-5.6-sol",
      nativeModelId: "openai/gpt-5.6-sol",
      options: [],
      providerId: "openai",
    },
    {
      displayName: "Llama 4 Maverick (free)",
      isDefault: false,
      modelId: "llama-4-maverick:free",
      nativeModelId: "meta-llama/llama-4-maverick:free",
      options: [],
      providerId: "meta",
    },
  ],
  status: "ready",
});
// An account whose source can be set up two ways — a key typed here, or a code
// read on another device — which is the only thing that puts the sign-in
// dialog's "Choose how to connect" list on screen. Pi's `xai` row declares
// both (`packages/harness-pi/src/sources.ts`).
const mockPiCatalog = HarnessInstanceCatalogSchema.parse({
  connections: [
    {
      authKind: "api-key",
      connectionSlot: "primary",
      label: "xAI",
      logoutSupported: true,
      status: "connected",
    },
  ],
  continuationIdentity: mockPiContinuationIdentity,
  driverKind: "pi",
  harnessInstanceId: mockPiHarnessInstanceId,
  models: [
    {
      displayName: "Grok 5",
      isDefault: true,
      modelId: "grok-5",
      nativeModelId: "xai/grok-5",
      options: [
        {
          defaultValue: "medium",
          id: "thinking",
          label: "Thinking",
          type: "select",
          values: [
            { label: "Off", value: "off" },
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
        },
      ],
      providerId: "xai",
    },
    {
      displayName: "MiniMax M2",
      isDefault: false,
      modelId: "minimax-m2",
      nativeModelId: "minimax/minimax-m2",
      options: [],
      providerId: "minimax",
    },
  ],
  setupMethods: [
    {
      connectionSlot: "primary",
      detail: "Store a xAI API key in this profile's private Pi credential file.",
      inputLabel: "xAI API key",
      kind: "secret-input",
      label: "xAI API key",
      methodId: "pi-api-key",
    },
    {
      connectionSlot: "primary",
      detail: "Sign in to xAI on another device with a code.",
      kind: "device-code",
      label: "xAI sign-in",
      methodId: "pi-device-code",
    },
  ],
  status: "ready",
  steering: true,
});
// Cursor signs itself in: the CLI holds the credential in the computer's own
// keychain, so the catalog reports who it found and offers no setup method.
const mockCursorCatalog = HarnessInstanceCatalogSchema.parse({
  lightModel: { providerId: "xai", modelId: "composer-2.5", options: {} },
  connections: [
    {
      accountLabel: "demo@opensteer.test",
      authKind: "subscription",
      billingLabel: "Pro",
      connectionSlot: "primary",
      label: "Cursor",
      logoutSupported: false,
      status: "connected",
    },
  ],
  continuationIdentity: mockCursorContinuationIdentity,
  driverKind: "cursor",
  harnessInstanceId: mockCursorHarnessInstanceId,
  models: [
    {
      displayName: "Composer 2.5",
      isDefault: true,
      modelId: "composer-2.5",
      options: [{ defaultValue: false, id: "fast", label: "Fast", type: "toggle" }],
      providerId: "xai",
    },
    {
      // Cursor's own spelling of a lab model, folded back onto the canonical
      // pair by the driver's legacy table and sent as the native id.
      displayName: "Claude Sonnet 4.5",
      isDefault: false,
      modelId: "claude-sonnet-4-5",
      nativeModelId: "claude-4.5-sonnet",
      options: [],
      providerId: "anthropic",
    },
  ],
  status: "ready",
});

/** What each engine in this mock says it can drive, exactly as a Runner would. */
const mockCodexSources: HarnessSourceDescriptor[] = [
  {
    detail: "A ChatGPT plan or an OpenAI API key.",
    fields: [],
    kind: "first-party",
    label: "OpenAI",
    quota: "windows",
    sourceId: "openai",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "OpenRouter, a proxy, or a local runtime that speaks OpenAI's Responses API.",
    fields: [
      {
        detail: "Must serve the Responses API; Codex no longer speaks Chat Completions.",
        id: "baseUrl",
        kind: "url",
        label: "Base URL",
        placeholder: "https://openrouter.ai/api/v1",
      },
    ],
    kind: "compatible-endpoint",
    label: "OpenAI-compatible endpoint",
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  },
];
const mockClaudeSources: HarnessSourceDescriptor[] = [
  {
    detail: "A Claude plan or an Anthropic API key.",
    fields: [],
    kind: "first-party",
    label: "Anthropic",
    quota: "none",
    sourceId: "anthropic",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's AWS credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Amazon Bedrock",
    quota: "none",
    sourceId: "bedrock",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's Google Cloud credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Google Vertex AI",
    quota: "none",
    sourceId: "vertex",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's Azure credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Azure AI Foundry",
    quota: "none",
    sourceId: "foundry",
    stateKinds: ["ambient", "isolated"],
  },
];
/**
 * OpenCode's rows, copied from `packages/harness-opencode/src/sources.ts`: the
 * engine has no OAuth path a Runner can drive, so every source is an API key
 * in the account's own private credential file — `isolated` everywhere, and
 * `quota: "none"` because OpenCode reports no plan window at all. Six of the
 * driver's fifteen rows are here, enough for the gateway, first-party and
 * compatible-endpoint copy to have something real to render.
 */
const mockOpencodeSources: HarnessSourceDescriptor[] = [
  {
    detail:
      "OpenCode's own model gateway. Its free models run with no credential; add a Zen API key for the rest.",
    fields: [],
    kind: "gateway",
    label: "OpenCode Zen",
    quota: "none",
    sourceId: "opencode",
    stateKinds: ["isolated"],
  },
  {
    detail:
      "The OpenCode Go plan, billed by OpenCode. Opensteer signs OpenCode in with an API key.",
    fields: [],
    kind: "gateway",
    label: "OpenCode Go",
    quota: "none",
    sourceId: "opencode-go",
    stateKinds: ["isolated"],
  },
  {
    detail: "OpenAI's own API. Opensteer signs OpenCode in with an API key.",
    fields: [],
    kind: "first-party",
    label: "OpenAI",
    quota: "none",
    sourceId: "openai",
    stateKinds: ["isolated"],
  },
  {
    detail: "Anthropic's own API. Opensteer signs OpenCode in with an API key.",
    fields: [],
    kind: "first-party",
    label: "Anthropic",
    quota: "none",
    sourceId: "anthropic",
    stateKinds: ["isolated"],
  },
  {
    detail:
      "OpenRouter, which serves many labs' models on one key. Opensteer signs OpenCode in with an API key.",
    fields: [],
    kind: "gateway",
    label: "OpenRouter",
    quota: "none",
    sourceId: "openrouter",
    stateKinds: ["isolated"],
  },
  {
    detail: "Ollama, LM Studio, oMLX, or any server with an OpenAI-compatible API.",
    fields: [
      {
        id: "runtime",
        kind: "select",
        label: "Runtime",
        defaultValue: "generic",
        options: [
          { value: "generic", label: "Other" },
          { value: "ollama", label: "Ollama" },
          { value: "lmstudio", label: "LM Studio" },
          { value: "omlx", label: "oMLX" },
        ],
      },
      {
        detail: "Must serve OpenAI's Chat Completions API and list its models at /models.",
        id: "baseUrl",
        kind: "url",
        label: "Base URL",
        placeholder: "http://127.0.0.1:11434/v1",
      },
    ],
    modelSettings: true,
    kind: "compatible-endpoint",
    label: "Model server",
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  },
];
/**
 * Pi's rows, copied from `packages/harness-pi/src/sources.ts`. Pi reads the
 * person's own `~/.pi` as well as a private profile, so every row but the
 * compatible endpoint carries both state kinds. `xai` is the row that offers
 * two ways in — an API key and a sign-in on another device — which is what the
 * sign-in dialog's "Choose how to connect" list exists for.
 */
const mockPiSources: HarnessSourceDescriptor[] = [
  {
    detail: "An OpenAI API key, billed to your OpenAI account.",
    fields: [],
    kind: "first-party",
    label: "OpenAI",
    quota: "none",
    sourceId: "openai",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "The Grok models, from an xAI API key or an xAI sign-in on another device.",
    fields: [],
    kind: "first-party",
    label: "xAI",
    quota: "none",
    sourceId: "xai",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Your ChatGPT plan, signed in on another device with a code.",
    fields: [],
    kind: "first-party",
    label: "ChatGPT plan",
    quota: "none",
    sourceId: "openai-codex",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Your GitHub Copilot plan, signed in on another device with a code.",
    fields: [],
    kind: "gateway",
    label: "GitHub Copilot",
    quota: "none",
    sourceId: "github-copilot",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "An OpenCode Go plan, which includes the models on its own list.",
    fields: [],
    kind: "gateway",
    label: "OpenCode Go",
    quota: "none",
    sourceId: "opencode-go",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "A MiniMax API key for the MiniMax models.",
    fields: [],
    kind: "gateway",
    label: "MiniMax",
    quota: "none",
    sourceId: "minimax",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Ollama, LM Studio, oMLX, or any server with an OpenAI-compatible API.",
    fields: [
      {
        id: "runtime",
        kind: "select",
        label: "Runtime",
        defaultValue: "generic",
        options: [
          { value: "generic", label: "Other" },
          { value: "ollama", label: "Ollama" },
          { value: "lmstudio", label: "LM Studio" },
          { value: "omlx", label: "oMLX" },
        ],
      },
      {
        detail: "Must serve Chat Completions; Pi talks to it as `openai-completions`.",
        id: "baseUrl",
        kind: "url",
        label: "Base URL",
        placeholder: "https://openrouter.ai/api/v1",
      },
    ],
    modelSettings: true,
    kind: "compatible-endpoint",
    label: "Model server",
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  },
];
/**
 * Cursor's one row, copied from `packages/harness-cursor/src/cursor-driver.ts`.
 * It is `ambient` only — the sign-in lives in the computer's own keychain, so
 * there is nothing for Opensteer to write and no setup method it can run — and
 * a `gateway` because a Cursor plan pays for other labs' models too.
 */
const mockCursorSources: HarnessSourceDescriptor[] = [
  {
    detail: "Your Cursor plan, signed in with the Cursor CLI on this computer.",
    fields: [],
    kind: "gateway",
    label: "Cursor",
    quota: "none",
    sourceId: "cursor",
    stateKinds: ["ambient"],
  },
];
const mockHarnessSourcesByDriver: Readonly<Record<string, readonly HarnessSourceDescriptor[]>> = {
  claude: mockClaudeSources,
  codex: mockCodexSources,
  cursor: mockCursorSources,
  opencode: mockOpencodeSources,
  pi: mockPiSources,
};

function mockAccountCatalog(harness: HarnessSummary, ready: boolean): HarnessInstanceCatalog {
  const template = [
    mockCodexCatalog,
    mockClaudeCatalog,
    mockCursorCatalog,
    mockOpencodeCatalog,
    mockPiCatalog,
  ].find((item) => item.driverKind === harness.driverKind);
  if (!template || template.status !== "ready")
    throw new Error("This mock engine has no model catalog.");
  const source = mockHarnessSourcesByDriver[harness.driverKind]?.find(
    (item) => item.sourceId === harness.sourceId,
  );
  const kind =
    source?.kind === "cloud-identity"
      ? "local-import"
      : harness.driverKind === "opencode" || source?.kind === "compatible-endpoint"
        ? "secret-input"
        : harness.driverKind === "claude"
          ? "browser-code"
          : "device-code";
  const setupMethods: HarnessSetupMethod[] =
    harness.driverKind === "cursor"
      ? []
      : template.setupMethods.length > 0 && source?.kind === "first-party"
        ? template.setupMethods
        : [
            kind === "secret-input"
              ? {
                  connectionSlot: "primary",
                  kind,
                  methodId: kind,
                  label: "API key",
                  inputLabel: "API key",
                }
              : {
                  connectionSlot: "primary",
                  kind,
                  methodId: kind,
                  label: kind === "local-import" ? "Use this computer’s credentials" : "Sign in",
                },
          ];
  if (!ready)
    return HarnessInstanceCatalogSchema.parse({
      driverKind: harness.driverKind,
      harnessInstanceId: harness.id,
      status: "authentication-required",
      detail: "Sign in required",
      models: [],
      connections: [],
      setupMethods,
    });
  return HarnessInstanceCatalogSchema.parse({
    ...template,
    harnessInstanceId: harness.id,
    setupMethods,
    connections: [
      {
        connectionSlot: "primary",
        label: "Account",
        status: "connected",
        accountLabel: "side@opensteer.test",
        logoutSupported: true,
        authKind:
          kind === "secret-input"
            ? "api-key"
            : kind === "local-import"
              ? "cloud-identity"
              : "subscription",
      },
    ],
  });
}

interface ActiveMockRun {
  cancelled: boolean;
  id: string;
  /** People's messages that joined this Run and that it has not read yet. */
  joined: PendingMockInput[];
  /**
   * The Run as the Host holds it, for one a person's message started: who
   * asked and where its reply goes decide whether their next message joins
   * it. Null for a Run a task's outcome or an automation started, which
   * answers someone else.
   */
  person: Run | null;
  /** Bodies promoted into this Run while it ran, so its reply can acknowledge them. */
  steered: string[];
}

/** One queued message no Run has picked up yet, as the mock Host holds it. */
interface PendingMockInput {
  body: string;
  /** Set once a person edited it while it waited; `message` already holds the edit. */
  edit?: MessageEdit;
  input: ThreadInput;
  message: Message;
}

/** The device a lease taken through this mock's own commands is named for. */
const mockThisDeviceLabel = "Chrome on Mac";

interface MockTaskScript {
  readonly accepted: string;

  readonly answer: string;
  /** A step the task will not take without asking, and what follows a no. */
  readonly decision: {
    readonly accept: string;
    readonly decline: string;
    readonly declinedAnswer: string;
    readonly declinedResult: string;
    readonly detail: string;
    readonly title: string;
  } | null;
  /** A heads-up the task leaves in its assigner's conversation, as a report, before it finishes. */
  readonly note: string | null;
  readonly objective: string;
  /** The task's final reply, which is its result. */
  readonly result: string;
  readonly steps: readonly {
    readonly arguments: Record<string, unknown>;
    readonly output: string;
    readonly tool: { readonly name: string; readonly namespace: string };
  }[];
  readonly title: string;
}

/**
 * The real Host answers these refusals with a typed code the UI branches on
 * (a stale steer target, a message already admitted), so the mock refuses the
 * same way instead of with a bare Error that the rpc envelope would flatten
 * to `internal`.
 */
function sameMockApp(
  left: ComputerAppIdentity | null | undefined,
  right: ComputerAppIdentity | null | undefined,
): boolean {
  return (left?.bundleId.toLowerCase() ?? null) === (right?.bundleId.toLowerCase() ?? null);
}

function mockConflict(message: string): HostClientRequestError {
  return new HostClientRequestError({ code: "conflict", message, status: 409 });
}

function mockNotFound(message: string): HostClientRequestError {
  return new HostClientRequestError({ code: "not_found", message, status: 404 });
}

function mockBadRequest(message: string): HostClientRequestError {
  return new HostClientRequestError({ code: "bad_request", message, status: 400 });
}

/** Only a person's own words are theirs to edit; generated work never is. */
function mockEditable(item: PendingMockInput): boolean {
  return item.input.policy === "queue" && item.message.author.kind === "human";
}

/**
 * The Machines a cohosted Personal Deployment actually has: the computer it
 * runs on, which both executes agents and relays its browser; a laptop that
 * joined only so agents can reach it over SSH; and a messaging service that is
 * enrolled but away.
 */
const mockMachines: readonly MachineSummary[] = [
  {
    // The Mac this deployment runs on: it offers Messages and can read it.
    apps: [
      {
        definitionId: "apple-messages",
        operations: [
          {
            operation: "query_messages",
            detail: "Ready to read",
            remedy: null,
            state: "ready",
          },
          { operation: "export_attachment", detail: "Ready to read", remedy: null, state: "ready" },
          { operation: "send_message", detail: "Ready to read", remedy: null, state: "ready" },
        ],
      },
      // Computer use reports through the same status entry, as the Runner's provider does.
      {
        definitionId: mockComputerUseDefinition.id,
        operations: [
          { operation: "observe", detail: null, remedy: null, state: "ready" },
          { operation: "act", detail: null, remedy: null, state: "ready" },
        ],
      },
    ],
    access: {
      activeSessions: [],
      // The main computer of a Personal Deployment: the Deployment owns it and
      // it still has an owner, so "My agents" is a choice it can be set to.
      ownerReachAvailable: true,
      policy: machineAccessPolicyDefault,
      revision: 1,
    },
    allowedModules: ["agents", "browser", "integrations", "shell"],
    detail: "The computer this deployment runs on.",
    device: { form: "compact", platform: "macos" },
    enrollmentId: "ren_runner_local",
    expiresAt: null,
    // Granted, so Messages here reads Ready; the MacBook below previews the grant still to give.
    // Computer use is set up, approves any app automatically, and is in use.
    computerUse: {
      displayStreamSupported: true,
      appApproval: "automatic",
      detail: null,
      permissions: { accessibility: "granted", screenRecording: "granted" },
      sessions: [mockComputerUseSession, mockSlackLiveSession],
      state: "ready",
    },
    fullDiskAccess: true,
    kind: "home",
    id: "rnr_11111111-1111-4111-8111-111111111111",
    lastSeenAt: null,

    modules: {
      agents: { checkedAt: null, detail: null, readiness: "ready" },
      browser: { checkedAt: null, detail: null, readiness: "ready" },
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "Mac mini",
    ownership: "deployment",

    revocable: false,
    status: "online",
    runtimeVersion: null,
  },
  {
    // A Mac offering Messages that macOS has not let Opensteer read yet.
    apps: [
      {
        definitionId: "apple-messages",
        operations: [
          {
            operation: "query_messages",
            detail: "Reading Messages requires macOS Full Disk Access.",
            remedy: "full-disk-access",
            state: "permission-required",
          },
          {
            operation: "export_attachment",
            detail: "Reading Messages requires macOS Full Disk Access.",
            remedy: "full-disk-access",
            state: "permission-required",
          },
          {
            operation: "send_message",
            detail: "Reading Messages requires macOS Full Disk Access.",
            remedy: "full-disk-access",
            state: "permission-required",
          },
        ],
      },
      {
        definitionId: mockComputerUseDefinition.id,
        operations: ["observe", "act"].map((operation) => ({
          operation,
          detail: "Turn on macOS Accessibility for Opensteer Computer Use.",
          remedy: "accessibility" as const,
          state: "permission-required" as const,
        })),
      },
    ],
    access: {
      activeSessions: [],
      ownerReachAvailable: true,
      policy: {
        apps: false,
        commands: false,
        forwarding: false,
        reach: "owner",
        shares: [{ mode: "read-write", path: "/Users/person/Projects" }],
      },
      revision: 3,
    },
    // A Personal Deployment admits another computer only to be reached, so its
    // grant is exactly `shell` and it never advertises `agents`.
    allowedModules: ["integrations", "shell"],
    detail: null,
    device: { form: "laptop", platform: "macos" },
    enrollmentId: "ren_runner_laptop",
    expiresAt: null,
    // The grant macOS has not given yet, which is why Messages cannot be read.
    // Computer use is halfway set up: Screen Recording on, Accessibility not yet.
    computerUse: {
      displayStreamSupported: false,
      appApproval: "ask",
      detail: null,
      permissions: { accessibility: "denied", screenRecording: "granted" },
      sessions: [],
      state: "permission-required",
    },
    fullDiskAccess: false,
    kind: "computer",
    id: "rnr_33333333-3333-4333-8333-333333333333",
    lastSeenAt: "2026-09-13T08:12:00.000Z",

    modules: {
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "Alex's MacBook Pro",
    ownership: "mine",

    revocable: true,
    status: "online",
    runtimeVersion: null,
  },
  {
    // A Mac with Messages on that is asleep. `apps` is null because a computer
    // that is away reports nothing, so the row reads the connection alone and
    // says the change waits rather than claiming the app is broken.
    apps: null,
    access: {
      activeSessions: [],
      ownerReachAvailable: true,
      policy: machineAccessPolicyDefault,
      revision: 2,
    },
    allowedModules: ["integrations", "shell"],
    detail: null,
    device: { form: "desktop", platform: "macos" },
    enrollmentId: "ren_runner_studio",
    expiresAt: null,
    computerUse: null,
    fullDiskAccess: true,
    kind: "computer",
    id: "rnr_44444444-4444-4444-8444-444444444444",
    lastSeenAt: "2026-09-16T21:40:00.000Z",

    modules: {
      integrations: { checkedAt: null, detail: null, readiness: "unavailable" },
      shell: { checkedAt: null, detail: null, readiness: "unavailable" },
    },
    name: "Studio iMac",
    ownership: "mine",

    revocable: true,
    status: "offline",
    runtimeVersion: null,
  },
  {
    // An Android phone set up over USB: it lends its screen to one task.
    apps: [
      {
        definitionId: "android-phone",
        operations: ["observe", "act", "release"].map((operation) => ({
          detail: null,
          operation,
          remedy: null,
          state: "ready" as const,
        })),
      },
    ],
    access: {
      activeSessions: [],
      ownerReachAvailable: true,
      revision: 1,
      policy: {
        apps: true,
        browser: true,
        commands: false,
        forwarding: false,
        reach: "nobody",
        shares: [],
      },
    },
    allowedModules: ["browser", "integrations"],
    detail: null,
    device: { form: "phone", platform: "android" },
    enrollmentId: "ren_runner_phone",
    expiresAt: null,
    computerUse: {
      // Every client watches phone tasks and owner views through live display.
      displayStreamSupported: true,
      appApproval: null,
      detail: null,
      permissions: null,
      sessions: [mockAgentPhoneSession],
      state: "ready",
    },
    fullDiskAccess: null,
    kind: "agent-phone",
    id: mockAgentPhoneRunnerId,
    lastSeenAt: null,

    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Pixel 7",
    ownership: "mine",

    revocable: true,
    status: "online",
    runtimeVersion: "0.1.117",
  },
  {
    // A service the deployment provisioned: it offers no apps and says so.
    apps: null,
    access: {
      activeSessions: [],
      ownerReachAvailable: false,
      policy: machineAccessPolicyDefault,
      revision: 1,
    },
    allowedModules: ["messaging", "shell"],
    detail: "Delivers Slack messages for this deployment.",
    device: null,
    enrollmentId: "ren_runner_slack",
    expiresAt: null,
    computerUse: null,
    fullDiskAccess: null,
    id: "rnr_22222222-2222-4222-8222-222222222222",
    lastSeenAt: "2026-08-12T19:04:00.000Z",

    modules: { messaging: { checkedAt: null, detail: null, readiness: "unavailable" } },
    name: "Slack runtime",
    ownership: "deployment",

    revocable: true,
    status: "offline",
    runtimeVersion: null,
  },
];

export interface MockPhoneJoin {
  readonly enrollmentId: string;
  /** What the phone advertises; an iPhone's apps alone when omitted. */
  readonly modules?: readonly ("browser" | "integrations")[];
  readonly name: string;
  readonly platform?: "android" | "ios";
  readonly runnerId: string;
}

export interface MockHostClientOptions {
  readonly connectionController?: ConnectionController;
  readonly clientScope?: () => ClientScope | null;
  /** Fail the first metadata batch containing this ID, then resolve normally. */
  referenceResolveFailureId?: ReferenceId;
  /** `seeded`, or one task holding a single scene of the subagent design. */
  subagents?: "seeded" | "absent" | MockSubagentScene;
  desktopUpdates?: MockDesktopUpdateScenario;
  /** The plugin side's state, as the web's `?mock-plugins=` picks it. */
  plugins?: MockPluginScenario;

  agentPlugins?: { id: string; name: string }[];
  memoryPasses?: "active" | "off" | "waiting-for-model";
  /** `seeded`: devices reached through agent-made plugins, with their setup tasks. */
  devices?: "seeded" | "absent";
  iphoneScreen?: MockIphoneScreenState | "absent";
  iphoneScreenHolding?: boolean;
  readonly browserPreferencesStorage?: BrowserPreferencesStorage;
  readonly quietTasksAvailable?: boolean;
  readonly agentImagesAvailable?: boolean;
  /** The platform's lifecycle, reported to display sockets as the real client reports it. */
  readonly lifecycle?: ClientLifecycle;
  /** Automations covering every state the Automations page shows; seeded by default. */
  automations?: "seeded" | "absent";
  /** `none`: no account could run background work; `invalid`: settings.json has an error. */
  automaticModels?: "seeded" | "edited" | "excluded" | "invalid" | "none";
  automaticModelsAvailable?: boolean;
  places?: "seeded" | "absent";

  world?: "seeded" | "first-run" | "busy" | "stress";
  latencyMs?: number;
  /** What a Run does before its reply: the scripted reasoning, tools and streamed text, or only the reply. */
  replies?: "scripted" | "brief";
  now?: () => Date;
  pendingRequests?: readonly Request[];
  /** The sessions `sessions.list` reports; one current session by default. */
  sessions?: readonly AuthSessionSummary[];
  connections?: readonly import("@opensteer/protocol").AgentConnection[];
  connectionConsent?: import("@opensteer/protocol").AgentConnectionConsent;
  /**
   * The consent as the Home presents it once its verification changes: the first approval is
   * refused for the change, and the request reads like this from then on.
   */
  connectionConsentChange?: import("@opensteer/protocol").AgentConnectionConsent;
  /** The work policy `personal.shell.get` reports; none on a personal Home. */
  workPolicy?: import("@opensteer/control-plane-protocol").EffectiveWorkPolicy;
  /** Which paired Chromes can share tabs with a connected agent, as `browser.sources.get` says. */
  chromeTabs?: import("../host/connected-agent-options.js").ChromeTabGrantCatalog;
  /** Whether the connection reads report grants support. Defaults to true. */
  grantsAvailable?: boolean;
  /** The Opensteer website this Home names, where Account billing happens; none by default. */
  portalOrigin?: string;
  /** How the Home is reached: a networked server or Cloud Computer, not this computer. */
  exposure?: "loopback" | "networked";
}

const mockWebhookOrigin = "https://mock.opensteer.invalid";

function watchEnvironment(record: MockTriggerRecord) {
  if (!record.activation) throw new Error("Watch activation not found.");
  return record.activation.environmentId;
}

function mockWatchActivation(
  trigger: Trigger,
  revision: TriggerRevision,
  environmentId: string,
  now: Date,
): TriggerWatchActivation {
  return TriggerWatchActivationSchema.parse({
    anchorThreadId: trigger.anchorThreadId,
    consecutiveFailures: 0,
    createdAt: now.toISOString(),
    createdBy: trigger.createdBy,
    desired: "active",
    environmentId,
    executionGeneration: 0,
    healthySince: null,
    id: createId("triggerWatchActivation"),
    lastError: null,
    lastExitCode: null,
    leaseExpiresAt: null,
    observed: "starting",
    restartCount: 0,
    revisionId: revision.id,
    runnerBootId: null,
    runnerId: null,
    stderrTail: "",
    stdoutTail: "",
    triggerId: trigger.id,
    updatedAt: now.toISOString(),
  });
}

function triggerNextFireAt(source: TriggerSource, now: Date): string | null {
  return source.kind === "schedule" ? firstTriggerFireAt(source.schedule, now).toISOString() : null;
}

/** When a resumed or rescheduled Trigger next fires: never, for an instant already past. */
function resumedFireAt(source: TriggerSource, now: Date): string | null {
  if (source.kind !== "schedule") return null;
  if (source.schedule.kind === "at") {
    return Date.parse(source.schedule.at) > now.getTime() ? source.schedule.at : null;
  }
  return firstTriggerFireAt(source.schedule, now).toISOString();
}

const unsupportedMockRpc = async () => ({
  error: {
    code: "internal" as const,
    message: "This operation is not available in the in-memory preview.",
    retryable: false,
  },
  ok: false as const,
});

/**
 * Carries a typed refusal across the in-memory rpc with its code intact; any
 * other failure is a mock bug and keeps propagating as one.
 */
function mockRefusal(error: unknown) {
  if (!(error instanceof HostClientRequestError)) throw error;
  return {
    error: HostApiErrorSchema.parse({
      code: error.code,
      message: error.message,
      ...(error.reason ? { reason: error.reason } : {}),
      retryable: false,
    }),
    ok: false as const,
  };
}

function mockVoiceEnded(message: string, reason: "voice-ended" | "voice-refused") {
  return {
    error: HostApiErrorSchema.parse({ code: "conflict", message, reason, retryable: false }),
    ok: false as const,
  };
}

/**
 * Every member is written out. The map carries no fallback, so adding an rpc
 * member without teaching the preview about it is a compile error rather than a
 * page that fails at runtime in `VITE_OPENSTEER_USE_MOCK`.
 */
function mockNeedsYou(
  snapshot: Pick<
    PublicHostSnapshot,
    "threads" | "tasks" | "activeTasks" | "doneTasks" | "waitingRequests"
  >,
  before?: string,
  limit = 50,
) {
  const requestRows = snapshot.waitingRequests.flatMap(({ request }) => {
    const thread = snapshot.threads.find(({ id }) => id === request.originatingThreadId);
    return thread
      ? [
          {
            kind: "request" as const,
            request,
            originThreadId: thread.id,
            navigationThreadId: listedRowThreadId(snapshot, thread.id),
            purpose: thread.purpose,
            title: thread.title,
          },
        ]
      : [];
  });
  const rows = requestRows;
  const start = before ? Number(before) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > rows.length)
    throw new Error("Invalid Needs-you cursor.");
  const entries = rows
      .slice(start, start + limit)
      .map((entry) => NeedsYouPageSchema.shape.entries.element.parse(entry)),
    end = start + entries.length;
  return {
    count: rows.length,
    entries,
    window: {
      ...mockWindow(entries.length),
      hasMore: end < rows.length,
      nextBefore: end < rows.length ? String(end) : null,
      totalItems: rows.length,
    },
  };
}

function rpcNotFound(message: string) {
  return { ok: false as const, error: { code: "not_found" as const, message, retryable: false } };
}

function mockItemsPage(
  client: MockHostState,
  input: z.output<(typeof hostApi)["thread.items.page"]["payload"]> & { nodeId?: string },
) {
  const snapshot = client.getSnapshot();
  const revision = String(snapshot.revision);
  const { threadId, nodeId } = input;
  const boundary = input.before ?? input.after;
  if (
    boundary &&
    (boundary.threadId !== threadId ||
      boundary.nodeId !== (nodeId ?? null) ||
      boundary.viewerId !== snapshot.user?.id ||
      boundary.deploymentId !== snapshot.deploymentId)
  )
    return rpcSuccess({ kind: "history-reset" as const });
  const all = mockScopedItems(snapshot, threadId, nodeId, revision, client.nodeEvents);
  const anchor = input.anchorItemId ?? input.aroundMessageId;
  const index = anchor
    ? all.findIndex(
        (row) => row.id === anchor || (row.kind === "message" && row.messageId === anchor),
      )
    : -1;
  if (anchor && index < 0)
    return input.anchorItemId
      ? rpcSuccess({
          kind: "history-reset" as const,
          anchorUnavailable: true as const,
        })
      : rpcNotFound("Item unavailable.");
  const indexAtCursor = boundary ? all.findIndex(({ id }) => id === boundary.beforeId) : -1;
  if (boundary && indexAtCursor < 0) return rpcSuccess({ kind: "history-reset" as const });
  const limit = input.limit ?? 50;
  const end = input.before
    ? indexAtCursor
    : input.after
      ? Math.min(all.length, indexAtCursor + limit + 1)
      : index >= 0
        ? Math.min(all.length, index + Math.ceil(limit / 2))
        : all.length;
  const start = input.after ? indexAtCursor + 1 : Math.max(0, end - limit);
  const items = boundedMockPage(all.slice(start, end), input.after !== undefined);
  const hasMore = items.length > 0 && items[0] !== all[0];
  return rpcSuccess({
    kind: "page" as const,
    threadId,
    nodeId: nodeId ? ExecutionNodeIdSchema.parse(nodeId) : null,
    items,
    revision,
    hasMore,
    nextBefore: hasMore ? mockScopedCursor(snapshot, threadId, nodeId, items[0]) : null,
    nextAfter:
      items.length && items.at(-1) !== all.at(-1)
        ? mockScopedCursor(snapshot, threadId, nodeId, items.at(-1))
        : null,
  });
}

function mockHostApiHandlers(client: MockHostState, failureId?: ReferenceId): HostApiHandlers {
  let referenceFailurePending = failureId !== undefined;
  const handlers: Partial<HostApiHandlers> = {
    ...client.enginePlugins.reads(),
    "references.resolve": async ({ ids }) => {
      const snapshot = client.getSnapshot();
      if (snapshot.session !== "authenticated")
        return {
          ok: false,
          error: { code: "unauthorized", message: "Authentication required", retryable: false },
        };
      if (referenceFailurePending && failureId && ids.includes(failureId)) {
        referenceFailurePending = false;
        return {
          ok: false,
          error: {
            code: "internal",
            message: "Reference lookup temporarily unavailable",
            retryable: true,
          },
        };
      }
      return rpcSuccess(
        hostApi["references.resolve"].success.parse({
          results: [...new Set(ids)].map((id) => {
            const reference = parseReferenceHref(`opensteer:${id}`) as IdReference;
            if (reference.kind === "request") {
              const request = client.referenceRequest(id);
              if (request && heldThread(snapshot, request.originatingThreadId))
                return {
                  status: "available",
                  kind: "request",
                  id: reference.id,
                  threadId: request.originatingThreadId,
                  requestStatus: request.status,
                  title: plainTextExcerpt(requestTitleText(request.presentation), 256) || "Request",
                };
            }
            return localReference(snapshot, reference) ?? { status: "unavailable", id };
          }),
        }),
      );
    },
    "asset.urls": async ({ assets }) => ({
      ok: true,
      data: {
        assets: assets.map(() => ({ status: "unavailable" as const, reason: "missing" as const })),
      },
    }),
    "attention.get": async () => {
      const snapshot = client.getSnapshot();
      return rpcSuccess({
        homeName: snapshot.machines.find(hostsDeployment)?.name ?? null,
        needsYou: mockNeedsYou(snapshot, undefined, 50).count,
        unread: snapshot.threads.some(
          (thread) =>
            thread.listed &&
            thread.purpose === "task" &&
            thread.status !== "archived" &&
            isThreadUnread(thread),
        ),
      });
    },
    "needsYou.get": async (input) =>
      rpcSuccess(mockNeedsYou(client.getSnapshot(), input.before, input.limit)),
    "connections.activity": async (input) =>
      rpcSuccess(client.agentActivity({ connectionId: input.connectionId })),
    "threads.activity": async (input) =>
      rpcSuccess(client.agentActivity({ threadId: input.threadId })),
    "connections.list": async (input) => {
      const connections = client.listConnections(input.includeRevoked === true);
      if (!client.grantsAvailable) return rpcSuccess({ connections });
      const activeIds = new Set(connections.map((connection) => connection.id));
      return rpcSuccess({
        connections,
        endedConnections: client.listConnections(true).filter(({ id }) => !activeIds.has(id)),
      });
    },
    "connections.authorization.get": async ({ requestId }) => {
      try {
        return rpcSuccess({
          ...client.connectionConsent(requestId),
          ...(client.grantsAvailable ? { grantsAvailable: true as const } : {}),
        });
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "personal.remoteAccess.get": async () => rpcSuccess(client.remoteAdministration),
    "personal.accountLink.get": async () =>
      rpcSuccess({
        accountIssuer: client.remoteAdministration.accountIssuer,
        accountLink: client.remoteAdministration.access.accountLink,
        authorityEnvelope: client.remoteAdministration.authorityEnvelope,
        managed: false,
      }),
    "apps.view": unsupportedMockRpc,
    "attachment.get": async ({ attachmentId }) => rpcSuccess(client.getAttachment(attachmentId)),
    "attachment.upload": async ({ attachmentId }, context) =>
      rpcSuccess(await client.uploadAttachment(attachmentId, context.binaryBody)),
    "attachment.content": async ({ attachmentId }) =>
      rpcSuccess(client.readAttachment(attachmentId)),
    "file.open": async ({ threadId, source }) => {
      if (threadId !== null && !client.getSnapshot().threads.some((t) => t.id === threadId))
        return rpcSuccess(hostApi["file.open"].success.parse({ status: "unavailable" }));
      // The mock has no filesystem. Only real fixture attachments can supply bytes.
      if (source.kind !== "attachment") return rpcSuccess({ status: "unavailable" as const });
      try {
        const a = client.getAttachment(source.attachmentId);
        if (
          a.state !== "ready" ||
          !a.sha256 ||
          (!a.messageId && Date.parse(a.expiresAt) <= Date.now())
        )
          return rpcSuccess({ status: "unavailable" as const });
        const content = client.readAttachment(a.id);
        const bytes = content.bytes.subarray(0, 512 * 1024);
        let preview: { kind: "download" } | { kind: "text"; text: string; truncated: boolean } = {
          kind: "download",
        };
        if (!bytes.includes(0))
          try {
            preview = {
              kind: "text",
              text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
                stream: bytes.length < content.bytes.length,
              }),
              truncated: bytes.length < content.bytes.length,
            };
          } catch {
            /* Binary fixture. */
          }
        return rpcSuccess(
          hostApi["file.open"].success.parse({
            status: "ok",
            resource: { kind: "attachment", attachmentId: a.id, revision: a.sha256 },
            name: a.name,
            sizeBytes: a.sizeBytes,
            mediaType: a.mediaType,
            preview,
          }),
        );
      } catch {
        return rpcSuccess({ status: "unavailable" as const });
      }
    },
    "file.content": async ({ threadId, resource }) => {
      if (
        (threadId !== null && !client.getSnapshot().threads.some((t) => t.id === threadId)) ||
        resource.kind !== "attachment"
      )
        throw new HostClientRequestError({
          code: "not_found",
          message: "File unavailable",
          status: 404,
        });
      const a = client.getAttachment(resource.attachmentId);
      if (a.sha256 !== resource.revision || (!a.messageId && Date.parse(a.expiresAt) <= Date.now()))
        throw new HostClientRequestError({
          code: "not_found",
          message: "File unavailable",
          status: 404,
        });
      return rpcSuccess(hostApi["file.content"].success.parse(client.readAttachment(a.id)));
    },
    "browser.password-sign-in.get": async ({ requestId }) =>
      rpcSuccess(client.passwordSignInCard(requestId)),
    "browser.sources.get": async () =>
      rpcSuccess({ ...client.chrome.state(), ...client.chromeTabs }),
    "browser.sources.inspect": async (input) => {
      try {
        return rpcSuccess(client.chrome.inspect(input.url));
      } catch (error) {
        throw mockConflict(error instanceof Error ? error.message : "Choose a website.");
      }
    },
    "auth.config": async () =>
      rpcSuccess(
        hostApi["auth.config"].success.parse(requiredMockIdentityConfig(client.getSnapshot())),
      ),

    // the preview only ever has the one owner.

    "auth.native.complete": async (input) =>
      rpcSuccess({ url: await client.completeNativeAuthorization(input.oauthQuery, input.accept) }),
    "auth.oidc.begin": async (input) =>
      rpcSuccess({
        redirectUrl: await client.beginOidcSignIn(input.providerId, {
          ...(input.oauthQuery ? { oauthQuery: input.oauthQuery } : {}),
          ...(input.returnPath ? { returnPath: input.returnPath } : {}),
        }),
      }),
    "auth.password.recover": async (input) => {
      await client.resetPasswordWithRecovery(input.token, input.newPassword);
      return rpcSuccess({});
    },
    "auth.password.signIn": async (input) => {
      const redirectUrl = await client.signInPassword(
        input,
        input.oauthQuery ? { oauthQuery: input.oauthQuery } : {},
      );
      return rpcSuccess(
        hostApi["auth.password.signIn"].success.parse({
          redirectUrl,
          session: mockAuthenticatedSession(client.getSnapshot()),
        }),
      );
    },
    "auth.password.signUp": async (input) => {
      await client.signUpPassword(input);
      return rpcSuccess(
        hostApi["auth.password.signUp"].success.parse({
          session: mockAuthenticatedSession(client.getSnapshot()),
        }),
      );
    },
    "auth.setup.claim": async (_input) => {
      await client.claimInitialOwner();
      return rpcSuccess(
        hostApi["auth.setup.claim"].success.parse({
          session: mockAuthenticatedSession(client.getSnapshot()),
        }),
      );
    },
    "auth.setup.exchange": async (input) => {
      await client.exchangeSetupToken(input.token);
      return rpcSuccess({});
    },
    "auth.signOut": async () => {
      await client.signOut();
      return rpcSuccess({});
    },
    "browser.history.get": async ({ profileId }) => {
      try {
        return rpcSuccess(client.places!.history(profileId));
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "browser.history.icons.get": async ({ profileId, iconRefs }) => {
      try {
        return rpcSuccess(client.places!.historyIcons(profileId, iconRefs));
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "browser.searchSuggestions.get": async ({ query }) => {
      client.searchSuggestionRequests.push({ query, at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, query.startsWith("slow") ? 500 : 30));
      return rpcSuccess(
        query === "weath"
          ? ["weather tomorrow", "weather today", "weather this week"]
          : query.includes("weather")
            ? [`${query} forecast`, `${query} today`]
            : [],
      );
    },
    "browser.contextCandidate.get": async ({ sessionId, tabId }) => {
      if (!client.places) return unsupportedMockRpc();
      const candidate = await client.places.candidate(sessionId, tabId);
      return rpcSuccess({
        ...candidate,
        ...previousReleaseEligibility(new Date(client.nowIso())),
      });
    },
    "browser.tabIcon.get": async (input) => {
      if (!client.places) return unsupportedMockRpc();
      const tabId =
        "tabId" in input
          ? input.tabId
          : client
              .getSnapshot()
              .browserSessions.find((session) => session.id === input.sessionId)
              ?.surfaces.find(
                (surface) => client.tabCatalog.store.get(surface.id)?.iconRef === input.iconRef,
              )?.id;
      if (!tabId) return rpcSuccess({ favicon: null });
      const row = client.tabCatalog.store.get(tabId);
      return rpcSuccess({ favicon: await client.places.icon(tabId, input.iconRef, row) });
    },
    "personal.shell.get": async ({ selectedThreadId }) =>
      rpcSuccess({
        ...mockScopedShell(client.getSnapshot(), mockThread, selectedThreadId),
      }),
    "thread.snapshot.get": async ({ threadId, nodeId }) => {
      const detail = mockScopedDetail(
        client.getSnapshot(),
        mockThread,
        threadId,
        nodeId,
        undefined,
        undefined,
        client.nodeEvents,
      );
      return detail ? rpcSuccess(detail) : rpcNotFound("Conversation unavailable.");
    },
    "thread.items.page": async (input) => mockItemsPage(client, input),
    "node.items.page": async (input) => mockItemsPage(client, input),
    "thread.overlays.page": async ({ threadId, nodeId, kind, cursor, expectedRevision }) => {
      const snapshot = client.getSnapshot();
      const revision = String(snapshot.revision);
      const [at, rawOffset] = cursor?.split(":") ?? [revision, "0"];
      const offset = Number(rawOffset);
      if (
        at !== revision ||
        (expectedRevision && expectedRevision !== revision) ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        return {
          ok: false,
          error: { code: "conflict", message: "Overlay changed", retryable: false },
        };
      const all = mockOverlayRows(snapshot, threadId, nodeId, kind, revision, client.nodeEvents);
      const nextOffset = offset + 20;
      return rpcSuccess({
        threadId,
        nodeId: nodeId ?? null,
        kind,
        revision,
        entries: all.slice(offset, nextOffset),
        next: nextOffset < all.length ? `${revision}:${nextOffset}` : null,
      });
    },
    "transcript.item.get": async ({ threadId, nodeId, itemId, expectedRevision }) => {
      const snapshot = client.getSnapshot();
      const item = mockScopedItems(
        snapshot,
        threadId,
        nodeId,
        String(snapshot.revision),
        client.nodeEvents,
      ).find(({ id }) => id === itemId);
      if (item && expectedRevision !== undefined && expectedRevision !== item.revision)
        return {
          ok: false,
          error: { code: "conflict", message: "Item changed", retryable: false },
        };
      const address = { threadId, nodeId: nodeId ?? null };
      if (item && nodeId) {
        const event = client.nodeEvents.find((row) => row.eventId === itemId);
        if (event?.type === "node.message" || event?.type === "reasoning.completed")
          return rpcSuccess({
            ...address,
            item,
            body: { kind: "text", text: event.data.text },
            truncated: false,
          });
        if (event?.type === "tool.started") {
          const callId = event.data.callId;
          const completion = client.nodeEvents.find(
            (row) =>
              row.type === "tool.completed" &&
              row.runId === event.runId &&
              row.data.nodeId === nodeId &&
              row.data.callId === callId,
          );
          const output = completion?.type === "tool.completed" ? completion.data.output : undefined;
          return rpcSuccess({
            ...address,
            item,
            truncated: false,
            body: {
              kind: "tool",
              arguments: event.data.arguments,
              ...(output ? { output: { text: output.text, truncation: output.truncation } } : {}),
            },
          });
        }
      }
      const row = snapshot.transcripts[threadId]?.find(({ id }) => id === itemId);
      if (!item || !row) return rpcNotFound("Item unavailable.");
      if (row.kind === "tool")
        return rpcSuccess({
          ...address,
          item,
          body: {
            kind: "tool",
            arguments: row.arguments,
            output: row.output && { text: row.output.text, truncation: row.output.truncation },
          },
          truncated: false,
        });
      if (row.kind === "reasoning")
        return rpcSuccess({
          ...address,
          item,
          body: { kind: "text", text: row.text },
          truncated: false,
        });
      if (row.kind === "assignment")
        return rpcSuccess({
          ...address,
          item,
          body: { kind: "assignment", assignment: row.assignment },
          truncated: false,
        });
      if (row.kind === "message")
        return rpcSuccess(
          hostApi["transcript.item.get"].success.parse({
            ...address,
            item,
            truncated: false,
            body: {
              kind: "message",
              message: {
                id: row.id,
                threadId,
                runId: row.runId,
                author: row.author,
                createdAt: row.createdAt,
                kind: row.messageKind,
                content: mockMessageContent(row),
                published: row.published ?? true,
                edit: row.edit,
                quote: row.quote,
                policy: row.policy,
              },
            },
          }),
        );
      return rpcNotFound("Item has no body.");
    },
    "resources.detail.get": async ({ kind }) =>
      rpcSuccess(
        hostApi["resources.detail.get"].success.parse({
          revision: String(client.getSnapshot().revision),
          data: mockScopedResource(client.bootstrap(), kind),
          next: null,
        }),
      ),
    "tabs.get": async ({ tabId }) => {
      try {
        client.publishedSnapshot();
        return rpcSuccess(client.tabCatalog.tab(tabId));
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "tabs.state": async () => {
      client.publishedSnapshot();
      const tabs = client.tabCatalog.store;
      return rpcSuccess({ tabs: [...tabs.rows.values()], layout: tabs.layout, complete: true });
    },
    "apps.list": async ({ query }) =>
      rpcSuccess({
        apps: client.apps.filter(
          (app) =>
            !query ||
            app.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
            app.folder?.includes(query) === true,
        ),
      }),
    "apps.get": async ({ appId }) => {
      const app = client.apps.find((value) => value.appId === appId);
      return app
        ? rpcSuccess(app)
        : mockRefusal(
            new HostClientRequestError({
              code: "not_found",
              status: 404,
              message: "This app is no longer published.",
            }),
          );
    },
    "channel.connection.check": async (input) =>
      rpcSuccess(await client.checkChannelConnection(input.connectionId)),
    "channels.get": async () =>
      rpcSuccess(hostApi["channels.get"].success.parse(await client.loadChannels())),
    "plugins.overview.get": async () => {
      const deploymentId = DeploymentIdSchema.parse(client.getSnapshot().deploymentId!);
      const overview = client.settings.overview(deploymentId);
      return rpcSuccess({ ...overview, rows: overview.rows.map(listedMockRow) });
    },
    "devices.overview.get": async () => {
      const otherDevices = client.otherDevices();
      return rpcSuccess(
        hostApi["devices.overview.get"].success.parse({
          ...client.settings.devices,
          ...(otherDevices.length ? { otherDevices } : {}),
        }),
      );
    },
    "commands.dispatch": (command) =>
      client
        .executeCommandOnce(command)
        .then((result) => {
          if (result.ok) client.applyThreadCommandResult(result.data);
          return result;
        })
        .catch(mockRefusal),
    "harness.authentication.get": async (input) =>
      rpcSuccess(await client.getHarnessAuthentication(input)),
    "automaticModels.get": async () => rpcSuccess(mockAutomaticModelsView(client)),
    "harness.catalog.refresh": async () => rpcSuccess({}),
    "harness.modelServers.discover": async (input) =>
      rpcSuccess({ servers: mockModelServers(input.address) }),
    // The preview has no Runner to create a call, so voice never starts here.
    "voice.open": async (input) =>
      rpcSuccess({ ...input, threadId: ThreadIdSchema.parse(await client.openVoiceThread(input)) }),
    "voice.start": async () => mockVoiceEnded("The preview has no voice.", "voice-refused"),
    "voice.renew": async () => mockVoiceEnded("This voice call is over.", "voice-ended"),
    "voice.context": async () => mockVoiceEnded("This voice call is over.", "voice-ended"),
    "voice.say": async () => mockVoiceEnded("This voice call is over.", "voice-ended"),
    "voice.stop": async () => rpcSuccess({}),
    ...client.enginePlugins.signInReads(),
    "integration.grants.list": async () =>
      rpcSuccess({
        grants: await client.loadIntegrationGrants(client.getSnapshot().deploymentId!),
      }),
    "computer.app.windows": async (input) => {
      try {
        return rpcSuccess({
          windows: client.computerViews?.windows(input.machineId, input.app) ?? [],
        });
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "integration.computer.apps.approved": async () => {
      try {
        return rpcSuccess({ apps: client.computerViews?.approved() ?? [] });
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "integration.computer.session.stop": async (input) => {
      await client.stopComputerUseSession(input.sessionId);
      return rpcSuccess({});
    },
    "integration.computer.apps.installed": async (input) => {
      try {
        return rpcSuccess(client.listInstalledComputerApps(input));
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "integration.computer.policy.get": async (input) =>
      rpcSuccess({ appApproval: client.computerUseAppApproval(input.runnerId) }),
    "integration.computer.setup.review": async ({ setupRequestId }) =>
      rpcSuccess(client.reviewComputerAppSetup(setupRequestId)),
    // This mock runs no MCP server on a computer, so none takes secrets.
    "integration.server.secrets.list": async () =>
      rpcSuccess({ servers: client.localServerSecrets() }),
    "integration.computer.setup.list": async () =>
      rpcSuccess(
        hostApi["integration.computer.setup.list"].success.parse({
          requests: client.listComputerAppSetupRequests(),
        }),
      ),
    "integration.platform.get": async () =>
      rpcSuccess(
        hostApi["integration.platform.get"].success.parse(await client.loadIntegrationPlatform()),
      ),
    "integrations.get": async () =>
      rpcSuccess(
        hostApi["integrations.get"].success.parse(
          await client.loadIntegrations(),
        ) as RpcData<"integrations.get">,
      ),
    // The preview keeps no durable session history to page back through.
    "machine.access.history": async () => rpcSuccess({ nextCursor: null, sessions: [] }),
    // A computer's placed tasks are counted in this read, from the tasks the preview holds.
    "machines.list": async () => {
      const snapshot = client.getSnapshot();
      const tasks = snapshot.tasks?.entries ?? [];
      return rpcSuccess({
        machines: (await client.loadMachines()).map((machine) => {
          const environments = new Set<string>(
            (snapshot.environments ?? [])
              .filter(({ runnerId }) => runnerId !== null && runnerId === machine.selfRunnerId)
              .map(({ id }) => id),
          );
          return {
            ...machine,
            pinnedThreads: tasks.filter(
              ({ thread }) =>
                thread.status !== "archived" && environments.has(thread.environmentId),
            ).length,
          };
        }),
      });
    },
    // The preview holds every task, so a page is a slice of what it holds.
    "tasks.list": async (input) => {
      const snapshot = client.getSnapshot();
      const entries = (snapshot.tasks?.entries ?? []).filter(
        ({ thread }) =>
          (!input.active || thread.status === "running" || thread.status === "waiting") &&
          (!input.done || thread.doneAt !== null),
      );
      if (input.done) entries.sort(newestDone);
      const start = input.before ? Number(input.before) : 0;
      if (!Number.isInteger(start) || start < 0 || start > entries.length) {
        return mockRefusal(
          new HostClientRequestError({
            code: "bad_request",
            message: "Invalid durable window cursor",
            status: 400,
          }),
        );
      }
      const page = entries.slice(start, start + (input.limit ?? 100));
      const end = start + page.length;
      return rpcSuccess(
        hostApi["tasks.list"].success.parse({
          asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
          tasks: page.map((entry) => ({
            ...entry,
            thread: mockThread(entry.thread),
          })),
          window: {
            byteCount: 2,
            hasMore: end < entries.length,
            itemCount: page.length,
            nextBefore: end < entries.length ? String(end) : null,
            // As on the Host, only a list's first page counts it.
            ...(start === 0 ? { totalItems: entries.length } : {}),
          },
        }),
      );
    },
    "requests.list": async () => {
      const waitingRequests = client.getSnapshot().waitingRequests;
      return rpcSuccess(
        hostApi["requests.list"].success.parse({
          requests: waitingRequests,
          window: mockWindow(waitingRequests.length),
          reviewedRevisions: Object.fromEntries(
            waitingRequests.flatMap(({ request }) =>
              request.reviewedRevision === undefined
                ? []
                : [[request.id, request.reviewedRevision]],
            ),
          ),
          pendingRequestsRevision: mockPendingRequestsRevision(waitingRequests),
        }),
      );
    },
    "sessions.list": async () => rpcSuccess({ sessions: await client.loadSessions() }),
    // The preview runs each Run once, so its one attempt mirrors the Run.
    "run.attempts.list": async ({ runId }) => {
      const entry = Object.values(client.getSnapshot().transcripts)
        .flat()
        .find((item) => item.kind === "run" && item.runId === runId);
      if (entry?.kind !== "run") {
        return mockRefusal(
          new HostClientRequestError({ code: "not_found", message: "Run not found", status: 404 }),
        );
      }
      const attemptId = createId("runAttempt");
      const ended =
        entry.status === "completed" || entry.status === "failed" || entry.status === "interrupted";
      return rpcSuccess(
        hostApi["run.attempts.list"].success.parse({
          nodes: Object.values(client.getSnapshot().transcripts)
            .flat()
            .filter((node) => node.kind === "node" && node.runId === runId)
            .map((node) => {
              if (node.kind !== "node") throw new Error("Node expected.");
              return {
                id: node.nodeId,
                stopSupported: node.stopSupported ?? false,
                stopping: node.stopping ?? false,
                attemptId,
                kind: node.nodeKind,
                model: node.model,
                effort: node.effort,
                parentNodeId: node.parentNodeId,
                phaseIndex: node.phaseIndex,
                phases: node.phases,
                prompt: node.prompt,
                result: node.result,
                runId,
                startedAt: node.createdAt,
                endedAt: node.completedAt,
                status: node.status,
                title: node.title,
                usage: node.usage ?? null,
              };
            }),
          attempts: [
            {
              createdAt: entry.createdAt,
              dispatchedAt: entry.status === "queued" ? null : entry.createdAt,
              endedAt: ended ? entry.createdAt : null,
              engineStart: entry.status === "queued" ? null : "cold",
              id: attemptId,
              modelSelection: null,
              ordinal: 1,
              outcome: ended ? entry.status : null,
              reason: "initial",
              runId,
              runnerId: null,
              startedAt:
                entry.status === "queued" || entry.status === "starting" ? null : entry.createdAt,
              status: "current",
              usage: entry.usage ?? null,
            },
          ],
          runId,
        }),
      );
    },
    "agentPhone.target.get": async () => rpcSuccess(mockAgentPhonePairingTarget),
    "assignment.get": async ({ assignmentId }) => {
      try {
        return rpcSuccess(client.getAssignment(assignmentId));
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "thread.assignments.list": async ({ open, threadId }) => {
      const assignments = client
        .listThreadAssignments(threadId)
        .filter(({ status }) => !open || status === "open");
      return rpcSuccess(
        hostApi["thread.assignments.list"].success.parse({
          assignments,
          threadId,
          window: mockWindow(assignments.length),
        }),
      );
    },
    "thread.browserUsage.get": async ({ threadId, runIds }) => {
      if (!client.getSnapshot().threads.some((thread) => thread.id === threadId)) {
        return mockRefusal(
          new HostClientRequestError({
            code: "not_found",
            message: "Thread not found",
            status: 404,
          }),
        );
      }
      // As the Host answers: per session, the membership, the latest pages
      // people included, and each requested Run's latest pages — or its use of
      // the session when it chose none.
      const latestFirst = (
        a: { readonly lastUsedAt: string },
        b: { readonly lastUsedAt: string },
      ) => b.lastUsedAt.localeCompare(a.lastUsedAt);
      const scopedUses = client
        .getSnapshot()
        .browserUses.filter((use) => use.threadId === threadId);
      const sessionIds = [
        ...new Set([...scopedUses].sort(latestFirst).map((use) => use.sessionId)),
      ].slice(0, browserUsageSessionsPerRead);
      const uses = sessionIds.flatMap((sessionId) => {
        const scoped = scopedUses.filter((use) => use.sessionId === sessionId);
        if (scoped.length === 0) return [];
        const seen = [...scoped].sort(latestFirst).find((use) => use.pageSite);
        const pages = (runId: string | null) => {
          const own = scoped.filter((use) => use.runId === runId);
          const tabs = own.filter((use) => use.tabId).sort(latestFirst);
          if (tabs.length > 0) return tabs.slice(0, browserUsageTabsPerRun);
          return runId === null ? [] : own.slice(0, 1);
        };
        return [
          {
            firstUsedAt: scoped.map((use) => use.firstUsedAt).sort()[0]!,
            lastUsedAt: scoped
              .map((use) => use.lastUsedAt)
              .sort()
              .at(-1)!,
            pageSite: seen?.pageSite ?? null,
            pageTitle: seen?.pageTitle ?? null,
            runId: null,
            tabId: null,
            threadId,
          },
          ...[null, ...runIds].flatMap((runId) => pages(runId)),
        ].map((use) => ({ ...use, sessionId }));
      });
      return rpcSuccess(hostApi["thread.browserUsage.get"].success.parse({ threadId, uses }));
    },
    "thread.inputQueue.get": async (input) => {
      const revision = String(client.getSnapshot().revision);
      return rpcSuccess({
        ...mockInputQueue(
          client.loadThreadInputQueue(input.threadId),
          revision,
          (leaseId, messageId) => client.isLocalEditLease(messageId, leaseId),
        ),
        asOfSequence: revision,
      });
    },
    "thread.message.revisions.list": async (input) => {
      if (input.leaseId !== undefined) {
        const current = client
          .loadThreadInputQueue(input.threadId)
          .items.find(({ message }) => message.id === input.messageId);
        if (
          current?.lease?.leaseId !== input.leaseId ||
          (current?.message.edit?.revision ?? 0) !== input.expectedRevision
        )
          return {
            ok: false,
            error: { code: "conflict", message: "Waiting message changed", retryable: false },
          };
      }
      const page = client.messageRevisionPage(input.messageId, input.before);
      if (input.expectedRevision !== 0 || page.revisions.length) return rpcSuccess(page);
      const row = client
        .loadThreadInputQueue(input.threadId)
        .items.find(({ message }) => message.id === input.messageId);
      if (!row?.lease || row.message.edit) return rpcNotFound("Waiting message unavailable.");
      return rpcSuccess({
        revisions: [
          {
            revision: 0,
            content: row.message.content,
            author: row.message.author,
            deviceLabel: null,
            createdAt: row.message.createdAt,
          },
        ],
        hasMore: false,
      });
    },
    "thread.requests.list": async (input) => {
      const snapshot = client.getSnapshot();
      if (!heldThread(snapshot, input.threadId))
        return mockRefusal(
          new HostClientRequestError({
            code: "not_found",
            message: "Thread not found",
            status: 404,
          }),
        );
      const revision = String(snapshot.revision);
      const target = input.requestId ? client.referenceRequest(input.requestId) : undefined;
      const requests = (
        input.requestId
          ? target
            ? [target]
            : []
          : (client.getSnapshot().requests[input.threadId] ?? [])
      ).filter(
        (request) =>
          request.originatingThreadId === input.threadId &&
          (!input.review ||
            input.review.some(
              ({ id, revision: expected }) =>
                id === request.id && expected === mockRequestRevision(request, revision),
            )) &&
          (input.requestId !== undefined || request.status === "pending"),
      );
      return rpcSuccess(
        hostApi["thread.requests.list"].success.parse({
          requests,
          threadId: input.threadId,
          window: mockWindow(requests.length),
          reviewedRevisions: Object.fromEntries(
            requests
              .filter(({ status }) => status === "pending")
              .map((request) => [request.id, mockRequestRevision(request, revision)]),
          ),
        }),
      );
    },
    "triggers.get": async (input) => {
      try {
        return rpcSuccess(
          hostApi["triggers.get"].success.parse(client.triggerDetail(input.triggerId)),
        );
      } catch (error) {
        return mockRefusal(error);
      }
    },
    "triggers.list": async (input) =>
      rpcSuccess(
        hostApi["triggers.list"].success.parse({
          triggers: client.listTriggers(undefined, input.anchorThreadId, input.systemRole),
        }),
      ),

    "thread.messages.list": async (input) => rpcSuccess(client.listThreadMessages(input)),
  };
  return new Proxy(
    { ...handlers, "tasks.page": handlers["tasks.list"]! },
    {
      get: (target, name) => Reflect.get(target, name) ?? unsupportedMockRpc,
    },
  ) as HostApiHandlers;
}

/** A queued message joins the conversation where a Run takes it, as the Host places it. */
/**
 * Whether a waiting message is the in-app word of the person whose Run it
 * would join: their own, with no reply target of its own.
 */
function sentBy(item: PendingMockInput, run: Run): boolean {
  const { author } = item.message;
  return (
    author.kind === "human" &&
    author.userId === run.requestedBy &&
    item.input.replyTarget === null &&
    run.replyTarget === null
  );
}

function placeMockMessage(
  entries: readonly TranscriptEntry[],
  messageId: string,
  runId: string,
): TranscriptEntry[] {
  const entry = entries.find((candidate) => candidate.id === messageId);
  if (entry?.kind !== "message" && entry?.kind !== "assignment-return") return [...entries];
  return [...entries.filter((candidate) => candidate !== entry), { ...entry, runId }];
}

async function executeMockCommand(
  client: MockHostState,
  command: HostApiCommand,
): Promise<Awaited<ReturnType<HostApiClient["commands.dispatch"]>>> {
  if (
    command.type === "request.respond" ||
    command.type === "browser.sign-in.respond" ||
    command.type === "browser.password-sign-in.respond"
  ) {
    if (command.expectedRevision === undefined) throw requestReviewRequired();
    const request = client.referenceRequest(command.requestId);
    if (
      request?.status === "pending" &&
      mockRequestRevision(request, String(client.getSnapshot().revision)) !==
        command.expectedRevision
    )
      throw new HostClientRequestError({
        code: "conflict",
        reason: "request-changed",
        status: 409,
        message: "Request changed; read it again before answering",
      });
  }
  if (isMockPluginCommand(command)) return rpcSuccess(await client.enginePlugins.command(command));
  if (isMockSignInCommand(command))
    return rpcSuccess(await client.enginePlugins.signInCommand(command));
  switch (command.type) {
    case "settings.plugin.enabled.set":
      return rpcSuccess(
        client.settings.mutate(
          DeploymentIdSchema.parse(client.getSnapshot().deploymentId!),
          command,
        ),
      );
    case "attachment.upload.create":
      return rpcSuccess({ type: command.type, attachment: client.createAttachment(command) });
    case "attachment.upload.discard":
      client.discardAttachment(command.attachmentId);
      return rpcSuccess({ type: command.type });

    case "thread.create": {
      // A repeat under the same key is answered with the Thread it made, as
      // the Host does, so a creation whose answer was lost can be retried.
      const { idempotencyKey, ...request } = command;
      const repeated = client.repeatedThreadCreation(idempotencyKey, request);
      if (repeated !== null) {
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse({
            asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
            thread: mockThread(repeated),
            type: command.type,
            wasDuplicate: true,
          }),
        );
      }
      // The Host is what fills an unnamed access mode in, from the parent
      // Thread or the Deployment's default; the client names all four.
      const parent = command.parentThreadId
        ? client.getSnapshot().threads.find((thread) => thread.id === command.parentThreadId)
        : undefined;
      const thread = await client.createThread({
        accessMode: command.accessMode ?? parent?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
        environmentId: command.environmentId,
        harnessInstanceId: command.harnessInstanceId,
        modelSelection: command.modelSelection,
        ...(command.generateTitle ? { generateTitle: true } : {}),
        ...(command.parentThreadId ? { parentThreadId: command.parentThreadId } : {}),
        title: command.title,
      });
      client.recordThreadCreation(idempotencyKey, request, thread.id);
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
          thread: mockThread(thread),
          type: command.type,
          wasDuplicate: false,
        }),
      );
    }
    case "thread.icon.set": {
      const thread = client.setThreadIcon(command.threadId, command.icon);
      return rpcSuccess({
        type: command.type,
        thread: mockThread(thread),
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
      });
    }
    case "thread.rename": {
      const thread = client.renameThread(command.threadId, command.title);
      return rpcSuccess({
        type: command.type,
        thread: mockThread(thread),
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
      });
    }
    case "thread.sendMessage": {
      if (command.freshContext && command.delivery !== "queue")
        throw mockConflict("freshContext requires queue delivery.");
      const body = command.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      client.assertAttachmentSend(command.threadId, command.content);
      const pages = command.content.flatMap((part) => (part.type === "browser-page" ? [part] : []));
      const unseen = pages.find(
        (page) =>
          !client.getSnapshot().browserSessions.some((session) => session.id === page.sessionId),
      );
      if (unseen) {
        return mockRefusal(
          new HostClientRequestError({
            code: "forbidden",
            message: `This message includes the browser page "${unseen.title || unseen.url}", which you can no longer see. Remove the page and send the message again.`,
            status: 403,
          }),
        );
      }
      const result = await client.sendMessage({
        body,
        ...(command.compaction ? { compaction: command.compaction } : {}),
        content: command.content,
        ...(command.freshContext !== undefined ? { freshContext: command.freshContext } : {}),
        threadId: command.threadId,
        ...(command.quotedMessageId ? { quotedMessageId: command.quotedMessageId } : {}),
      });
      for (const page of pages) client.includeBrowserPage(page, command.threadId);
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          ...result,
          type: command.type,
          wasDuplicate: false,
        }),
      );
    }
    case "assignment.cancel": {
      const assignment = client.cancelAssignment(command.assignmentId);
      return rpcSuccess({ assignment, type: command.type, wasDuplicate: false });
    }
    case "thread.execution.update": {
      const thread = await client.updateThreadExecution(command);
      return rpcSuccess({
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
        thread: mockThread(thread),
        type: command.type,
      });
    }
    case "thread.visit": {
      const visit = client.visitThread(command.threadId, command.visitedAt);
      return rpcSuccess({ ...visit, type: command.type });
    }
    case "thread.done.set": {
      await client.setTaskDone(command.threadId, command.done);
      return rpcSuccess({
        type: command.type,
        thread: mockThread(
          client.getSnapshot().threads.find((thread) => thread.id === command.threadId)!,
        ),
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
        wasDuplicate: false,
      });
    }
    case "notification.preview.register":
      return rpcSuccess({
        type: command.type,
        installationId: command.installationId,
        keyId: command.keyId,
        registered: true,
      });
    // The preview's agents have no clock of the person's to keep.
    case "viewer.timeZone.update":
      return rpcSuccess({ timeZone: command.timeZone, type: command.type });
    case "settings.idleCompaction.set":
      client.setIdleCompactionPolicy(command.policy);
      return rpcSuccess({ type: command.type, policy: command.policy });
    case "viewer.quietTasks.update":
      client.setQuietTaskDays(command.quietTaskDays);
      return rpcSuccess({ quietTaskDays: command.quietTaskDays, type: command.type });
    case "viewer.name.update":
      return rpcSuccess({
        applied: true,
        profile: client.setOwnerProfileName(command.name),
        type: command.type,
      });
    case "thread.access.update": {
      const thread = await client.updateThreadAccessMode(command);
      return rpcSuccess({
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
        thread: mockThread(thread),
        type: command.type,
      });
    }
    case "thread.inputQueue.resume":
      return rpcSuccess({
        thread: mockThread(client.resumeThreadInputQueue(command.threadId)),
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
        type: command.type,
      });
    case "thread.input.steer":
      return rpcSuccess({
        input: client.steerThreadInput(command.threadId, command.messageId, command.expectedRunId),
        type: command.type,
      });
    case "thread.input.cancel":
      return rpcSuccess({
        input: client.cancelThreadInput(command.threadId, command.messageId),
        type: command.type,
      });
    case "thread.input.move":
      client.moveThreadInput(command.threadId, command.messageId, command.beforeMessageId);
      return rpcSuccess({ type: command.type });
    case "thread.input.lease.take":
      return rpcSuccess({ ...client.takeEditLease(command), type: command.type });
    case "thread.input.lease.renew":
      return rpcSuccess({ lease: client.renewEditLease(command), type: command.type });
    case "thread.input.lease.release":
      client.releaseEditLease(command);
      return rpcSuccess({ type: command.type });
    case "thread.input.edit":
      return rpcSuccess({ ...client.editWaitingInput(command), type: command.type });
    case "execution.preferences.remember":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          preferences: client.rememberExecution({
            ...(command.accessMode ? { accessMode: command.accessMode } : {}),
            ...(command.selection ? { selection: command.selection } : {}),
          }),
          type: command.type,
        }),
      );
    case "harness.create":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          harness: mockHarnessRecord(
            await client.createHarnessInstance(command),
            client.harnessSourceConfigs,
          ),
          type: command.type,
        }),
      );
    case "harness.model.configure":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          harness: mockHarnessRecord(
            client.configureHarnessModel(command),
            client.harnessSourceConfigs,
          ),
          type: command.type,
        }),
      );
    case "harness.rename":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          harness: {
            ...(await client.renameHarnessInstance(
              command.environmentId,
              command.harnessInstanceId,
              command.name,
            )),
            config: {},
          },
          type: command.type,
        }),
      );
    case "harness.enabled.set":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          harness: {
            ...(await client.setHarnessInstanceEnabled(
              command.environmentId,
              command.harnessInstanceId,
              command.enabled,
            )),
            config: {},
          },
          type: command.type,
        }),
      );
    case "harness.default.set":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          harness: {
            ...(await client.setDefaultHarnessInstance(
              command.environmentId,
              command.harnessInstanceId,
            )),
            config: {},
          },
          type: command.type,
        }),
      );
    case "harness.delete":
      await client.deleteHarnessInstance(command.environmentId, command.harnessInstanceId);
      return rpcSuccess({ type: command.type });
    case "harness.update": {
      const installation = client.updateHarnessInstallation(
        command.environmentId,
        command.driverKind,
      );
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({ installation, type: command.type }),
      );
    }
    case "harness.authentication.begin":
      return rpcSuccess({
        ...(await client.beginHarnessAuthentication(command)),
        type: command.type,
      });
    case "harness.authentication.submit":
      return rpcSuccess({
        ...(await client.submitHarnessAuthentication(command)),
        type: command.type,
      });
    case "harness.authentication.logout":
      return rpcSuccess({ ...(await client.logoutHarness(command)), type: command.type });
    case "harness.authentication.cancel":
      return rpcSuccess({
        ...(await client.cancelHarnessAuthentication(command)),
        type: command.type,
      });
    case "iphone.screen.attach":
      return rpcSuccess(client.attachIphoneScreen(command));
    case "iphone.screen.detach":
      return rpcSuccess(client.detachIphoneScreen(command));
    case "machine.revoke":
      await client.revokeMachine(command.machineId);
      return rpcSuccess({ type: command.type });
    case "machine.rename":
      await client.renameMachine(command.machineId, command.name);
      return rpcSuccess({ type: command.type });
    case "machine.session.bind":
      await client.bindDeviceSession(command.machineId);
      return rpcSuccess({ type: command.type });
    case "machine.access.update": {
      const revision = await client.updateMachineAccess(
        "deviceId" in command
          ? DeviceMachineAccessUpdateCommandSchema.parse(command).deviceId
          : command.runnerId,
        command.policy,
        command.expectedRevision,
      );
      return rpcSuccess(
        revision === null
          ? { outcome: "conflict" as const, type: command.type }
          : { outcome: "updated" as const, revision, type: command.type },
      );
    }
    // The preview never opens a session, so there is never one to stop.
    case "machine.access.session.stop":
      return rpcSuccess({ ended: false, type: command.type });
    case "personal.remoteAccess.request": {
      const id = globalThis.crypto.randomUUID();
      const latest = client.remoteAdministration.operation;
      const intent = command.intent;
      if (
        intent.action === "recover" &&
        (latest?.id !== intent.operationId || latest.state !== "failed")
      )
        throw new HostClientRequestError({
          code: "conflict",
          message: "This changed on another device. Check it and try again.",
          reason: personalRemoteAdministrationChangedReason,
          status: 409,
        });
      const recovered = intent.action === "recover" ? latest : null;
      client.remoteAdministration = {
        ...client.remoteAdministration,
        revision: client.remoteAdministration.revision + 1,
        operation: {
          id,
          executionId: recovered?.executionId ?? id,
          intent: recovered?.intent ?? intent,
          state: "pending",
          detail: "Waiting for the Opensteer desktop app to run on this computer.",
        },
      };
      for (const listener of client.remoteAdministrationListeners) listener();
      return rpcSuccess({ type: command.type, operation: client.remoteAdministration.operation! });
    }
    case "personal.remoteAccess.pairing.create": {
      if (client.remoteAdministration.access.mode !== "private")
        throw mockConflict("Enable Private network access before creating a pairing code");
      return rpcSuccess({
        type: command.type,
        pairing: {
          code: `osp_${"m".repeat(43)}` as import("@opensteer/protocol").PersonalPairingCode,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          generation: client.remoteAdministration.access.generation,
          schemaVersion: 1 as const,
        },
      });
    }
    case "personal.accountLink.unlink":
      client.remoteAdministration = {
        ...client.remoteAdministration,
        access: { ...client.remoteAdministration.access, accountLink: null },
        revision: client.remoteAdministration.revision + 1,
      };
      return rpcSuccess({ type: command.type });
    case "personal.accountLink.approve":
    case "personal.accountLink.complete":
    case "personal.accountLink.resume":
      return unsupportedMockRpc();
    case "connection.revoke":
      client.revokeConnection(command.connectionId);
      for (const listener of client.connectionsListeners) listener();
      return rpcSuccess({ type: command.type });
    case "connection.authorize": {
      const result = client.authorizeConnection(command);
      for (const listener of client.connectionsListeners) listener();
      return rpcSuccess(result);
    }
    case "connection.update": {
      const connection = client.updateConnection(command);
      for (const listener of client.connectionsListeners) listener();
      return rpcSuccess({ type: command.type, connection });
    }
    case "agent.session.stop":
      return rpcSuccess({
        type: command.type,
        ended: client.stopAgentSession(command.threadId, command.agentSessionId),
      });
    case "connection.remove":
      client.removeConnection(command.connectionId);
      for (const listener of client.connectionsListeners) listener();
      return rpcSuccess({ type: command.type });
    case "connection.uncertain.acknowledge":
      client.acknowledgeUncertainConnection(command.connectionId);
      for (const listener of client.connectionsListeners) listener();
      return rpcSuccess({ type: command.type });
    case "session.revoke":
      await client.revokeSession(command.sessionId);
      return rpcSuccess({ type: command.type });
    case "runner.enrollment.createLocal":
      return rpcSuccess({
        ...(await client.createLocalRunnerEnrollment(
          command.name,
          command.access,
          command.preparedIdentity,
        )),
        type: command.type,
      });

    case "runner.enrollment.createPhone":
      return rpcSuccess({
        ...(await client.createPhoneRunnerEnrollment(
          command.name,
          command.profile,
          command.idempotencyKey,
          command.access,
        )),
        type: command.type,
      });
    case "runner.enrollment.retire":
      return rpcSuccess({
        state: await client.retireRunnerEnrollment(command.enrollmentId),
        type: command.type,
      });
    case "integration.grant.create":
      return rpcSuccess({
        grant: await client.createIntegrationGrant(command.input),
        type: command.type,
      });
    case "integration.disconnect":
      return rpcSuccess({
        ...(await client.disconnectIntegration(command.connectionId)),
        type: command.type,
      });
    case "integration.computer.setup.request":
      if ("deviceId" in command.input) return client.executeCommandOnce(command);
      return rpcSuccess({
        type: command.type,
        request: client.requestComputerAppSetup(command.input),
      });
    case "integration.computer.setup.cancel":
      client.cancelComputerAppSetup(command.requestId);
      return rpcSuccess({ type: command.type });
    case "integration.computer.setup.set":
      if ("deviceId" in command.input) return client.executeCommandOnce(command);
      return rpcSuccess({
        connection: await client.setComputerAppConnection(command.input),
        type: command.type,
      });
    case "integration.computer.setup.respond":
      await client.respondComputerAppSetup(command.setupRequestId, command.decision);
      return rpcSuccess({ type: command.type });
    case "integration.server.secrets.set":
      throw new Error("This mock has no local MCP executor.");
    case "integration.computer.policy.set":
      await client.setComputerUsePolicy(command.input.runnerId);
      return rpcSuccess({ appApproval: "ask", type: command.type });
    case "integration.computer.app.block":
      await client.blockComputerApp(command.connectionId);
      return rpcSuccess({ type: command.type });
    case "plugin.remove":
      await client.removePlugin(command.pluginId);
      return rpcSuccess({ type: command.type });
    case "integration.grant.revoke":
      await client.revokeIntegrationGrant(client.getSnapshot().deploymentId!, command.grantId);
      return rpcSuccess({ type: command.type });
    case "channel.connection.create":
      await client.createChannelConnection({
        accessPolicy: command.accessPolicy,
        credentials: command.credentials,
        provider: command.provider,
        routingMode: command.routingMode,
        deploymentId: client.getSnapshot().deploymentId!,
      });
      return unsupportedMockRpc();
    case "channel.binding.create":
      await client.createChannelBinding(command);
      return unsupportedMockRpc();
    case "channel.binding.update":
    case "channel.access.review":
    case "channel.connection.computer.create":
      return unsupportedMockRpc();
    case "channel.binding.revoke":
      await client.revokeChannelBinding(command.bindingId);
      return rpcSuccess({ type: command.type });
    case "channel.identity.link":
      return rpcSuccess({
        ...(await client.linkChannelIdentity(command.code)),
        type: command.type,
      });
    case "channel.connection.credentials.replace":
      await client.replaceChannelConnectionCredentials(command.connectionId, command.credentials);
      return rpcSuccess({ type: command.type });
    case "channel.connection.status.set":
      await client.setChannelConnectionStatus(command.connectionId, command.status);
      return rpcSuccess({ type: command.type });
    case "node.stop":
      await client.stopNode(command.threadId, command.nodeId);
      return rpcSuccess({ type: command.type, wasDuplicate: false });
    case "run.interrupt":
      await client.stopRun(command.threadId, command.runId);
      return rpcSuccess({ type: command.type, wasDuplicate: false });
    case "request.respond":
      await client.resolveRequest(command);
      return rpcSuccess({ type: command.type });
    case "browser.session.start": {
      const startedBrowser = await client.startBrowser(
        client.getSnapshot().deploymentId!,
        "profileId" in command.input
          ? { kind: "profile", profileId: command.input.profileId }
          : { kind: "fresh" },
        undefined,
        command.input.threadId,
        command.input.viewport,
      );
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          session: { ...startedBrowser, updatedAt: startedBrowser.createdAt },
          wasExisting: false,
        }),
      );
    }
    case "browser.profile.create":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          profile: await client.createBrowserProfile(
            command.input.name,
            command.input.homeRunnerId,
          ),
        }),
      );
    case "browser.source.pair":
      return rpcSuccess({ pairing: client.chrome.pair(mockPreviewOrigin()), type: command.type });
    case "browser.source.rename":
      client.chrome.rename(command.sourceId, command.name);
      return rpcSuccess({ type: command.type });
    case "browser.source.revoke":
      client.chrome.revoke(command.sourceId);
      return rpcSuccess({ type: command.type });
    case "browser.site.remove":
      client.chrome.removeSite(client.getSnapshot().deploymentId!, command.site);
      return rpcSuccess({ type: command.type });
    case "browser.session.sign-in":
      return rpcSuccess({ outcome: client.signInBrowserSession(command), type: command.type });
    case "browser.sign-in.respond":
      return rpcSuccess({ outcome: client.respondBrowserSignIn(command), type: command.type });
    case "browser.password-sign-in.respond":
      return rpcSuccess({ ...client.respondPasswordSignIn(command), type: command.type });

    case "browser.history.remove":
      client.places!.removeHistory(command.profileId, command.url);
      return rpcSuccess({ type: command.type });
    case "browser.history.clear":
      client.places!.removeHistory(command.profileId);
      return rpcSuccess({ type: command.type });
    case "browser.profile.delete": {
      client.places!.history(command.profileId);
      client.places!.deleteHistory(command.profileId);
      client.updatePlaces({
        ...client.getSnapshot(),
        browserProfiles: client
          .getSnapshot()
          .browserProfiles.filter((profile) => profile.id !== command.profileId),
      });
      return rpcSuccess({ type: command.type });
    }
    case "browser.profile.rename": {
      const snapshot = client.getSnapshot();
      const held = snapshot.browserProfiles.find((profile) => profile.id === command.profileId);
      if (!held)
        return mockRefusal(
          new HostClientRequestError({
            code: "not_found",
            message: "Browser profile not found.",
            status: 404,
          }),
        );
      const profile = { ...held, name: command.name };
      client.updatePlaces({
        ...snapshot,
        browserProfiles: snapshot.browserProfiles.map((value) =>
          value.id === profile.id ? profile : value,
        ),
      });
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({ type: command.type, profile }),
      );
    }
    case "computer.view.close":
    case "computer.view.renew":
      if (!client.computerViews) return unsupportedMockRpc();
      // The command result schema still names the old window shape; clients parse the view.
      return rpcSuccess({
        type: command.type,
        view: client.computerViews.command(command),
      } as never);
    case "tab.open":
    case "tab.close":
    case "tab.reopen":
    case "tab.activate":
    case "tab.organize":
    case "tab.group.update":
    case "tab.group.delete":
      return rpcSuccess(await client.tabCommand(command));
    case "app.rename":
    case "app.start":
    case "app.stop":
    case "app.delete":
      return rpcSuccess(client.appCommand(command));
    case "browser.session.close":
      await client.closeBrowser(command.sessionId);
      return unsupportedMockRpc();
    case "trigger.create":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          ...client.createTrigger(command.input),
          type: command.type,
        }),
      );
    case "trigger.update":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          ...client.updateTrigger(command.triggerId, command.input),
          type: command.type,
        }),
      );
    case "trigger.status.set":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          trigger: client.setTriggerStatus(command.triggerId, command.status),
          type: command.type,
        }),
      );
    case "trigger.run":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          occurrence: client.runTrigger(command.triggerId, command.payload),
          type: command.type,
        }),
      );
    case "trigger.cancel":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          canceledOccurrenceIds: client.cancelTriggerOccurrences(
            command.triggerId,
            command.occurrenceId,
          ),
          type: command.type,
        }),
      );
  }
  return unsupportedMockRpc();
}

function mockRpcContext(): HostApiServerContext {
  return {
    headers: {},
    requestId: "mock-request",
    requestUrl: "mock://host",
    session: null,
    setHeader: () => undefined,
    signal: new AbortController().signal,
    surface: "canonical",
  };
}

function requiredMockIdentityConfig(snapshot: HostSnapshot) {
  if (!snapshot.identityConfig) throw new Error("The mock identity configuration is missing.");
  return snapshot.identityConfig;
}

function mockAuthenticatedSession(snapshot: HostSnapshot) {
  if (!snapshot.user) throw new Error("The mock user is missing.");
  return {
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    id: "auth_session_mock_preview_000000000000",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    user: snapshot.user,
  };
}

function mockThread(thread: ThreadSummary): Thread {
  return ThreadSchema.parse({
    returnHint: thread.returnHint ?? null,
    lastVisitedAt: thread.lastVisitedAt,
    latestRunCompletedAt: thread.latestRunCompletedAt,
    providerSessionId: thread.providerSessionId,
    doneAt: thread.doneAt,
    doneReason: thread.doneReason,
    accessMode: thread.accessMode,

    continuationIdentity: thread.continuationIdentity,
    askedAt: thread.askedAt,
    createdAt: thread.createdAt,
    createdBy: mockUserId,
    environmentId: thread.environmentId,
    harnessInstanceId: thread.harnessInstanceId,
    id: thread.id,
    inputQueuePaused: thread.inputQueuePaused,
    lineageRootThreadId: thread.parentThreadId ?? thread.id,
    listed: thread.listed,
    modelSelection: thread.modelSelection,
    parentThreadId: thread.parentThreadId,
    pendingRequests: thread.pendingRequests,
    purpose: thread.purpose,
    status: thread.status,
    title: thread.title,
    icon: thread.icon,
    ...(thread.color === null ? {} : { color: thread.color }),
    updatedAt: thread.updatedAt,
  });
}

function newestDone(left: TaskEntry, right: TaskEntry): number {
  return (right.thread.doneAt ?? "").localeCompare(left.thread.doneAt ?? "");
}

function mockWindow(itemCount: number) {
  return { byteCount: 2, hasMore: false, itemCount, nextBefore: null, totalItems: itemCount };
}

/**
 * The preview's computer runs oMLX and has Ollama installed but stopped; an
 * address the person types answers as a generic server. Each lists what
 * `mockModelServerCatalog` serves once connected.
 */
function mockModelServers(address: string | undefined): ModelServer[] {
  if (address !== undefined) {
    return [
      { baseUrl: address, models: 3, runnableModels: 1, runtime: "generic", status: "ready" },
    ];
  }
  return [
    {
      baseUrl: "http://127.0.0.1:8000/v1",
      models: 3,
      runnableModels: 1,
      runtime: "omlx",
      status: "ready",
    },
    {
      baseUrl: "http://127.0.0.1:11434/v1",
      models: 0,
      runnableModels: 0,
      runtime: "ollama",
      status: "not-running",
    },
  ];
}

/** The wire record of one account: its summary plus the source config it holds. */
function mockModelServerCatalog(harness: HarnessSummary, baseUrl: string) {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // The mock accepted the address already; a label is all this is for.
  }
  return HarnessInstanceCatalogSchema.parse({
    connections: [
      { authKind: "none", connectionSlot: "primary", label: host, status: "connected" },
    ],
    continuationIdentity: ProviderContinuationIdentitySchema.parse({
      continuationKey: `runner:v1:${`${harness.id.replace(/[^A-Za-z0-9_-]/gu, "")}${"A".repeat(43)}`.slice(0, 43)}`,
      driverKind: harness.driverKind,
    }),
    detail: `${host} is reachable and ready`,
    driverKind: harness.driverKind,
    harnessInstanceId: harness.id,
    models: [
      {
        contextWindow: 32_768,
        displayName: "Qwen3 8B",
        isDefault: true,
        maxOutputTokens: 8_192,
        modelId: "qwen3-8b",
        nativeModelId: "qwen3:8b",
        options: [],
        providerId: "qwen",
      },
      {
        displayName: "Llama 3.2 3B",
        isDefault: false,
        modelId: "llama-3.2-3b",
        nativeModelId: "llama3.2:3b",
        needsContextWindow: true,
        options: [],
        providerId: "meta",
        unavailableReason: "Effective context window is unknown",
      },
      {
        displayName: "Gemma 3 1B",
        isDefault: false,
        modelId: "gemma-3-1b",
        nativeModelId: "gemma3:1b",
        options: [],
        providerId: "google",
        unavailableReason: "Ollama reports no tool support for this model",
      },
    ],
    setupMethods: [],
    status: "ready",
  });
}

function mockHarnessRecord(
  harness: HarnessSummary,
  sourceConfigs: ReadonlyMap<string, Readonly<Record<string, string>>>,
) {
  return {
    ...harness,
    config: {
      ...sourceConfigs.get(harness.id),
      ...(harness.modelSettings ? { models: harness.modelSettings } : {}),
    },
  };
}

function mockBootstrap(
  snapshot: HostSnapshot,
  tabs: import("../host/tab-store.js").TabStore,
  sourceConfigs: ReadonlyMap<string, Readonly<Record<string, string>>>,
) {
  return {
    apiVersion: scopedPersonalApiVersion,
    deploymentId: snapshot.deploymentId,
    personalSettings: snapshot.personalSettings,
    can: snapshot.can,
    sessionId: snapshot.sessionId,
    tabs: { tabs: [...tabs.rows.values()], layout: tabs.layout, complete: true },
    latestPlaces: [],
    browser: {
      available: snapshot.browserAvailable,
      placements: snapshot.browserPlacements,
      profiles: snapshot.browserProfiles,
      profileHomes: snapshot.browserProfileHomes,
      profileDeletions: snapshot.browserProfileDeletions,
      ...(snapshot.browserPools ? { pools: snapshot.browserPools } : {}),
    },
    environments: snapshot.environments,
    harnesses: snapshot.harnesses.map((harness) => mockHarnessRecord(harness, sourceConfigs)),
    executionPreferences: snapshot.executionPreferences,
    quietTaskDays: snapshot.quietTaskDays,
    identityConfig: requiredMockIdentityConfig(snapshot),
    machines: snapshot.machines,
    ownerProfile: snapshot.ownerProfile,
    sessionSurface: "canonical",
    user: snapshot.user,
  };
}

/** An exact request the authenticated owner answers through the Host. */
const MockMacAnswerSchema = z.discriminatedUnion("kind", [
  SetComputerAppConnectionSchema.extend({ setupRequestId: z.string().uuid() }),
  z.strictObject({
    appApproval: z.literal("automatic"),
    setupRequestId: z.string().uuid(),
    kind: z.literal("policy"),
    runnerId: RunnerIdSchema,
  }),
]);
type MockMacAnswer = z.output<typeof MockMacAnswerSchema>;

type MockHistoryWindow = {
  readonly ids: ReadonlySet<string>;
  readonly before: import("@opensteer/protocol/transcript").TranscriptOrderCursor | null;
  readonly after: import("@opensteer/protocol/transcript").TranscriptOrderCursor | null;
};

export class MockHostClient implements HostClient {
  #ownsConnection: boolean;
  #scopeProvider: (() => ClientScope | null) | undefined;
  #connectionController: ConnectionController;
  get connection() {
    return this.#connectionController;
  }
  adoptConnection(connection: ConnectionController, scope?: () => ClientScope | null): void {
    if (this.#ownsConnection) this.#connectionController.dispose();
    this.#ownsConnection = false;
    this.#connectionController = connection;
    this.#scopeProvider = scope;
  }
  async openConnection(attempt: ConnectionAttempt): Promise<ConnectionLease> {
    if (!this.#ownsConnection) await this.load();
    // Its own connection is ready only with its state: a reader keyed on that moment sees both.
    else this.#state.markConnected();
    attempt.signal.throwIfAborted();
    const snapshot = this.getSnapshot();
    if (snapshot.session !== "authenticated" || !snapshot.user || !snapshot.deploymentId)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Sign in to continue.",
        retryable: false,
      });
    nameConnectionFromHost(this.#connectionController, snapshot);
    attempt.acceptScope(
      this.#scopeProvider?.() ?? {
        authorityKey: "mock",
        deploymentId: snapshot.deploymentId,
        viewerId: snapshot.user.id,
        loginId: snapshot.sessionId ?? "mock",
      },
    );
    let finish!: (failure: ReturnType<typeof classifyClientFailure>) => void;
    const closed = new Promise<ReturnType<typeof classifyClientFailure>>((resolve) => {
      finish = resolve;
    });
    let wasConnected = snapshot.connection === "connected";
    const unsubscribe = this.subscribe(() => {
      const next = this.getSnapshot();
      if (next.connection === "connected") wasConnected = true;
      if (
        next.session !== "authenticated" ||
        next.connection === "offline" ||
        (wasConnected && next.connection !== "connected")
      ) {
        const failure = classifyClientFailure(
          next.session !== "authenticated"
            ? new HostClientRequestError({
                code: "unauthorized",
                status: 401,
                message: "Sign in to continue.",
                retryable: false,
              })
            : new HostTransportError("unreachable"),
        );
        unsubscribe();
        attempt.fail?.(failure);
        finish(failure);
      }
    });
    const lease = { closed, probe: async () => {}, close: unsubscribe };
    attempt.admit?.(lease);
    return lease;
  }
  deploymentSnapshot(sequence = String(this.getSnapshot().revision)) {
    const snapshot = this.getSnapshot(),
      page = (entries: readonly TaskEntry[]) => ({
        asOfSequence: SequenceSchema.parse(sequence),
        tasks: entries.slice(0, 100).map((entry) => ({
          ...entry,
          thread: mockThread(entry.thread),
        })),
        window: {
          ...mockWindow(Math.min(100, entries.length)),
          hasMore: entries.length > 100,
          nextBefore: entries.length > 100 ? "100" : null,
          totalItems: entries.length,
        },
      });
    const recent = snapshot.tasks?.entries ?? [];
    const cut = DeploymentSnapshotSchema.parse({
      deploymentId: snapshot.deploymentId,
      sequence,
      serializedBytes: 1,
      threads: snapshot.threads.slice(0, 100).map((thread) => mockThread(thread)),
      threadWindow: mockWindow(Math.min(100, snapshot.threads.length)),
      messages: [],
      messageWindows: [],
      messagesOmitted: true,
      pendingRequests: snapshot.waitingRequests.map(({ request }) => request).slice(0, 32),
      pendingRequestWindow: mockWindow(snapshot.waitingRequests.length),
      runQueue: [],
      tasks: {
        recent: page(recent),
        active: page(snapshot.activeTasks),
        done: page(recent.filter(({ thread }) => thread.doneAt !== null)),
      },
      needsYou: mockNeedsYou(snapshot, undefined, undefined),
      resources: (({ tabs, browser }) => ({ tabs, browser }))(this.#state.bootstrap()),
    });
    const serializedBytes = new TextEncoder().encode(JSON.stringify(cut)).byteLength;
    return DeploymentSnapshotSchema.parse({ ...cut, serializedBytes });
  }

  readonly desktopUpdates: MockDesktopUpdates;
  subscribePluginsChanged(
    listener: (message: { type: "host.plugins-changed" } & PluginChange) => void,
  ): () => void {
    this.#state.settings.listeners.add(listener);
    return () => this.#state.settings.listeners.delete(listener);
  }
  subscribePluginEngine(listener: (engine: PluginEngineStateView) => void): () => void {
    return this.#state.enginePlugins.subscribeEngine(listener);
  }
  readonly #personShowListeners = new Set<(message: PersonShowMessage) => void>();
  subscribePersonShow(listener: (message: PersonShowMessage) => void): () => void {
    this.#personShowListeners.add(listener);
    return () => this.#personShowListeners.delete(listener);
  }
  /** A transient Host delivery for local demos, with the same lifecycle filter. */
  receivePersonShow(message: PersonShowMessage): void {
    if (
      this.getSnapshot().session !== "authenticated" ||
      this.#lifecycle?.getSnapshot().visibility === "background"
    )
      return;
    for (const listener of this.#personShowListeners) listener(message);
  }
  readonly automaticModelsAvailable: () => boolean;
  readonly browserPasskeys = new BrowserPasskeys();
  readonly browserHistory: BrowserHistoryClient;
  readonly browserPreferences: BrowserPreferences;
  readonly retainComputerView: HostClient["retainComputerView"];
  readonly #viewer = new ViewerScope();
  #computerViews: { clear(): void; setConnected(connected: boolean): void } = {
    clear: () => undefined,
    setConnected: () => undefined,
  };
  readonly closeComputerView: HostClient["closeComputerView"];
  readonly #viewers = new TabViewers();
  tabViewer(tabId: string) {
    const snapshot = this.getSnapshot();
    return snapshot.tabs.get(tabId as TabId) ? this.#viewers.get(tabId, snapshot.machines) : null;
  }
  readonly openTab: TabsClient["openTab"];
  readonly closeTabs: TabsClient["closeTabs"];
  readonly reopenTab: TabsClient["reopenTab"];
  readonly activateTab: TabsClient["activateTab"];
  readonly organizeTabs: TabsClient["organizeTabs"];
  readonly updateTabGroup: TabsClient["updateTabGroup"];
  readonly deleteTabGroup: TabsClient["deleteTabGroup"];
  readonly listApps: TabsClient["listApps"];
  readonly getApp: TabsClient["getApp"];
  readonly renameApp: TabsClient["renameApp"];
  readonly startApp: TabsClient["startApp"];
  readonly stopApp: TabsClient["stopApp"];
  readonly deleteApp: TabsClient["deleteApp"];

  readonly renewComputerView: HostClient["renewComputerView"];
  readonly listComputerAppWindows: HostClient["listComputerAppWindows"];
  readonly listApprovedComputerApps: HostClient["listApprovedComputerApps"];
  readonly #ownerViews: MockComputerViews;
  readonly #browserPresentationScope = {};
  readonly #browserCursor = new BrowserCursorStore();
  readonly #cursorPoints = new Map<
    string,
    Extract<import("@opensteer/protocol/browser").BrowserServerMessage, { type: "browser.cursor" }>
  >();
  readonly browserFrames: BrowserFrameStore;
  readonly browserWatchFrames: BrowserFrameStore;
  readonly assetUrls: AssetUrlStore;
  readonly references: ReferenceStore;
  readonly transcriptFiles: TranscriptFileController;
  readonly rpc: HostApiClient;
  get cardUseMockStates() {
    return this.#state.cardUseMockStates;
  }
  get searchSuggestionRequests() {
    return this.#state.searchSuggestionRequests;
  }
  /** The mock Host's plugin side, for a test to make background work happen. */
  get enginePlugins() {
    return this.#state.enginePlugins;
  }
  readonly #state: MockHostState;
  readonly #places: MockPlaceWorld;
  readonly #worldSubscription: () => void;
  readonly #lifecycle: ClientLifecycle | null;

  constructor(options: MockHostClientOptions = {}) {
    this.#ownsConnection = options.connectionController === undefined;
    this.#scopeProvider = options.clientScope;
    this.#connectionController =
      options.connectionController ??
      createConnectionController({
        driver: { connect: (attempt) => this.openConnection(attempt) },
      });
    this.desktopUpdates = new MockDesktopUpdates(options.desktopUpdates);
    this.#lifecycle = options.lifecycle ?? null;
    this.#state = new MockHostState(options);
    this.automaticModelsAvailable = () => options.automaticModelsAvailable !== false;
    this.browserPreferences = new BrowserPreferences(options.browserPreferencesStorage);
    this.browserHistory = new BrowserHistoryClient({
      get: async (profileId) =>
        unwrapRpcResult(await this.rpc["browser.history.get"]({ profileId })),
      icons: async (profileId, iconRefs) =>
        unwrapRpcResult(await this.rpc["browser.history.icons.get"]({ profileId, iconRefs })),
      remove: async (profileId, url) => {
        await this.dispatch({
          type: "browser.history.remove",
          profileId,
          url,
          idempotencyKey: crypto.randomUUID(),
        });
      },
      clear: async (profileId) => {
        await this.dispatch({
          type: "browser.history.clear",
          profileId,
          idempotencyKey: crypto.randomUUID(),
        });
      },
    });
    if (options.places !== "absent" && options.world !== "first-run")
      this.#state.seedPlaces(
        options.world === "busy" || options.world === "stress" ? options.world : "seeded",
      );
    this.#places = new MockPlaceWorld(
      this.#state.getSnapshot,
      (snapshot) => this.#state.updatePlaces(snapshot),
      options.now ?? (() => new Date()),
      (profileId) => this.browserHistory.changed(profileId),
      (runId, threadId, data) => this.#state.enterPlace(runId, threadId, data),
    );
    this.#state.places = this.#places;
    this.#ownerViews = new MockComputerViews(
      this.#state.getSnapshot,
      (snapshot) =>
        this.#state.updatePlaces({
          ...this.#state.getSnapshot(),
          ...snapshot,
          browserSessions: this.#state.getSnapshot().browserSessions,
        }),
      () => this.#state.computerConnections(),
      options.now ?? (() => new Date()),
    );
    this.#state.computerViews = this.#ownerViews;
    // The same viewer authority and paused-while-disconnected views as the
    // Host's client; this world's only disconnection is going offline.
    let knownProfiles: string[] = [];
    const syncHistory = () => {
      const snapshot = this.#state.getSnapshot();
      const scope = viewerScopeOf(snapshot);
      if (this.#viewer.change(scope)) {
        clearRunPageViews(this);
        clearRunPlacePictures(this);
        this.#computerViews.clear();
      }
      this.#computerViews.setConnected(scope !== null && snapshot.connection !== "offline");
      this.browserHistory.setScope(scope);
      for (const profile of knownProfiles)
        if (!snapshot.browserProfiles.some((value) => value.id === profile))
          this.browserHistory.drop(profile);
      knownProfiles = snapshot.browserProfiles.map((profile) => profile.id);
      this.browserHistory.setConnected(snapshot.connection === "connected");
      this.browserPreferences.setScope(scope);
    };
    syncHistory();
    this.#worldSubscription = this.#state.subscribe(() => {
      syncHistory();
      this.#places.reconcile();
    });
    const frames: BrowserFrameStore = {
      scope: this.#browserPresentationScope,
      invalidationKey: () => {
        const snapshot = this.#state.getSnapshot();
        return JSON.stringify([snapshot.deploymentId, snapshot.user?.id, snapshot.session]);
      },
      accept: (sessionId, surfaceId, token) => this.#places.accept(sessionId, surfaceId, token),
      get: (sessionId, surfaceId) => this.#places.watchFrame(sessionId, surfaceId),
      subscribe: (sessionId, listener, surfaceId) =>
        this.#places.subscribeWatch(sessionId, surfaceId, listener),
    };
    this.browserFrames = {
      ...frames,
      cursor: this.#browserCursor,
      editing: this.#places.input.editing,
    };
    this.browserWatchFrames = frames;
    this.rpc = createInMemoryHostApiClient(
      mockHostApiHandlers(this.#state, options.referenceResolveFailureId),
      mockRpcContext(),
    );
    this.assetUrls = new AssetUrlStore(
      async (input, signal) =>
        unwrapRpcResult(await this.rpc["asset.urls"](input, signal ? { signal } : undefined)),
      { origin: async () => "http://mock.invalid" },
    );
    this.transcriptFiles = new TranscriptFileController({
      images: { store: this.assetUrls, deploymentId: () => this.#state.getSnapshot().deploymentId },
      rpc: {
        openFile: async (input, signal) =>
          unwrapRpcResult(await this.rpc["file.open"](input, signal ? { signal } : undefined)),
        readFile: async (input, signal) =>
          unwrapRpcResult(await this.rpc["file.content"](input, signal ? { signal } : undefined)),
      },
    });
    const referenceOwner = (snapshot: PublicHostSnapshot) =>
      JSON.stringify([
        snapshot.deploymentId,
        snapshot.user?.id,
        snapshot.sessionId,
        snapshot.session,
      ]);
    let owner = referenceOwner(this.#state.getSnapshot());
    this.references = new ReferenceStore({
      getSnapshot: this.#state.getSnapshot,
      resolveReferences: async (input, signal) =>
        unwrapRpcResult(
          await this.rpc["references.resolve"](input, signal ? { signal } : undefined),
        ),
      subscribe: (listener) =>
        this.#state.subscribe(() => {
          const next = referenceOwner(this.#state.getSnapshot());
          if (next !== owner) {
            owner = next;
            this.assetUrls.reset();
            this.transcriptFiles.reset();
          }
          listener();
        }),
    });
    this.#state.onReferenceEvent = (event) => this.references.accept(event);
    const views = computerViewMethods(
      this.rpc,
      () => undefined,
      () => this.#viewer.generation,
      (viewId) =>
        this.#state
          .getSnapshot()
          .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
          .find((view) => view.viewId === viewId),
      undefined,
      (viewId, generation) =>
        sharedDisplayStreams(this).cancelAutoWake({ kind: "owner-view", viewId, generation }),
    );
    this.#computerViews = views;
    this.retainComputerView = views.retainComputerView;
    this.closeComputerView = (...args) => {
      sharedDisplayStreams(this).cancelAutoWake({
        kind: "owner-view",
        viewId: args[0],
        generation: args[1],
      });
      return views.closeComputerView(...args);
    };
    const tabs = createTabsClient({
      store: this.#state.tabCatalog.store,
      dispatch: async (command) => {
        const result = unwrapRpcResult(await this.rpc["commands.dispatch"](command));
        return result as Awaited<ReturnType<TabsClientPort["dispatch"]>>;
      },
      listApps: async (query) =>
        unwrapRpcResult(await this.rpc["apps.list"](query ? { query } : {})).apps as App[],
      getApp: async (appId) => unwrapRpcResult(await this.rpc["apps.get"]({ appId })) as App,
      activated: (tab, viewer, wake) => {
        this.#viewers.set(tab.tabId, viewer, this.#state.getSnapshot().machines);
        // Only the person's explicit Open may wake a phone, and only once.
        if (wake && viewer.kind === "phone" && viewer.view.state === "ready")
          sharedDisplayStreams(this).armAutoWake({
            kind: "owner-view",
            viewId: viewer.view.viewId,
            generation: viewer.view.generation,
          });
        this.#state.emit();
      },
    });
    this.openTab = tabs.openTab;
    this.closeTabs = tabs.closeTabs;
    this.reopenTab = tabs.reopenTab;
    this.activateTab = tabs.activateTab;
    this.organizeTabs = tabs.organizeTabs;
    this.updateTabGroup = tabs.updateTabGroup;
    this.deleteTabGroup = tabs.deleteTabGroup;
    this.listApps = tabs.listApps;
    this.getApp = tabs.getApp;
    this.renameApp = tabs.renameApp;
    this.startApp = tabs.startApp;
    this.stopApp = tabs.stopApp;
    this.deleteApp = tabs.deleteApp;
    this.renewComputerView = views.renewComputerView;
    this.listApprovedComputerApps = views.listApprovedComputerApps;
    this.listComputerAppWindows = views.listComputerAppWindows;
    this.#state.subscribe(() => {
      if (
        this.getSnapshot().session !== "authenticated" &&
        this.connection.getSnapshot().scope !== null
      )
        this.connection.invalidateScope();
      if (
        this.#ownsConnection &&
        this.getSnapshot().session === "authenticated" &&
        this.connection.getSnapshot().phase === "blocked"
      )
        this.connection.retry();
    });
    if (this.#ownsConnection) this.connection.start();
  }

  applyThreadStateChanged(event: Extract<AgentEvent, { type: "thread.state-changed" }>): void {
    this.#state.applyThreadStateChanged(event);
  }

  receiveAgentInput(
    threadId: string,
    author: z.input<typeof MessageAuthorSchema>,
    body: string,
  ): void {
    this.#state.receiveAgentInput(threadId, MessageAuthorSchema.parse(author), body);
  }

  setPersonalRemoteAccessStatus(
    access: import("@opensteer/protocol").PersonalRemoteAccessStatus,
  ): void {
    this.#state.remoteAdministration = {
      ...this.#state.remoteAdministration,
      access,
      revision: this.#state.remoteAdministration.revision + 1,
    };
    for (const listener of this.#state.remoteAdministrationListeners) listener();
  }

  readonly #viewerSurfaces = new Map<
    string,
    import("@opensteer/protocol/browser-tabs").BrowserViewerSurface
  >();
  browserViewerSurface(sessionId: string, surfaceId: string) {
    const key = `${sessionId}\u0000${surfaceId}`;
    const next = this.#places.viewerSurface(sessionId, surfaceId);
    const held = this.#viewerSurfaces.get(key);
    if (!next) this.#viewerSurfaces.delete(key);
    else if (held && JSON.stringify(held) === JSON.stringify(next)) return held;
    else this.#viewerSurfaces.set(key, next);
    return next;
  }
  readonly getSnapshot = (): PublicHostSnapshot => {
    this.#ownerViews.expire();
    return this.#state.publishedSnapshot();
  };
  setBrowserProfileDeletions(
    deletions: NonNullable<HostSnapshot["browserProfileDeletions"]>,
  ): void {
    this.#state.updatePlaces({ ...this.#state.getSnapshot(), browserProfileDeletions: deletions });
  }

  /**
   * Where profiles live, as another Host would say it: `profileHomes`
   * undefined is a Host older than homes, and a profile mapped to null has
   * not been opened yet.
   */
  setBrowserProfileHomes(
    profileHomes: readonly string[] | undefined,
    homes: Readonly<Record<string, string | null>> = {},
  ): void {
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      browserProfileHomes: profileHomes,
      browserProfiles: snapshot.browserProfiles.map((profile) =>
        profile.name in homes ? { ...profile, homeRunnerId: homes[profile.name]! } : profile,
      ),
    });
  }

  setSearchSuggestionsAvailable(available: boolean): void {
    this.#state.updatePlaces({
      ...this.#state.getSnapshot(),
      searchSuggestionsAvailable: available,
    });
  }

  /**
   * For journeys and tests: what each Cloud Computer's pooled browser reports, as a Home will
   * once it can. While a browser waits to wake or start, its pictures stop as they would.
   */
  setBrowserPools(reports: readonly BrowserPoolReport[] | undefined): void {
    const snapshot = this.#state.getSnapshot();
    const { browserPools: _held, ...rest } = snapshot;
    this.#state.updatePlaces(reports ? { ...rest, browserPools: reports } : rest);
  }

  /** For journeys: one of `browserSleepScenes` for the browser holding this page tab. */
  showBrowserSleepScene(tabId: string, scene: BrowserSleepScene | null): void {
    const tab = this.getSnapshot().tabs.get(tabId as TabId);
    if (tab?.kind !== "page") throw new Error("That is not a page tab.");
    this.setBrowserPools(
      scene ? [mockBrowserPoolReport(scene, tab.computer.computerId, tabId)] : undefined,
    );
  }

  /** The preview Home has no pooled browser to restart: refused, and nothing changes. */
  readonly restartPooledBrowser = (_computerId: string): Promise<void> =>
    Promise.reject(new BrowserRestartUnavailable());

  /** A navigation can stay loading after the restored page has painted. */
  setBrowserLoading(tabId: string, loading: boolean): void {
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((session) => ({
        ...session,
        surfaces: session.surfaces.map((tab) => (tab.id === tabId ? { ...tab, loading } : tab)),
        ...(session.catalog
          ? {
              catalog: {
                ...session.catalog,
                tabs: session.catalog.tabs.map((tab) =>
                  tab.id === tabId ? { ...tab, loading } : tab,
                ),
              },
            }
          : {}),
      })),
    });
  }

  /** For journeys: a Runner's next catalog report, without changing other accounts. */
  setHarnessCatalog(environmentId: string, input: HarnessInstanceCatalog): void {
    const catalog = HarnessInstanceCatalogSchema.parse(input);
    const snapshot = this.#state.getSnapshot();
    const environment = snapshot.environments.find((item) => item.id === environmentId);
    if (
      !environment?.harnessCatalogs.some(
        (item) =>
          item.harnessInstanceId === catalog.harnessInstanceId &&
          item.driverKind === catalog.driverKind,
      )
    )
      throw new Error("The mock has no such account catalog on this work location.");
    this.#state.updatePlaces({
      ...snapshot,
      environments: snapshot.environments.map((item) =>
        item.id === environmentId
          ? {
              ...item,
              harnessCatalogs: item.harnessCatalogs.map((current) =>
                current.harnessInstanceId === catalog.harnessInstanceId ? catalog : current,
              ),
            }
          : item,
      ),
    });
  }
  readonly retainBrowserViewer = (
    sessionId: string,
    surfaceId: string,
    _options?: Parameters<HostClient["retainBrowserViewer"]>[2],
  ): (() => void) => {
    const release = this.#places.retain(sessionId, surfaceId);
    this.#state.refreshBrowserView();
    return () => {
      release();
      this.#state.refreshBrowserView();
    };
  };
  readonly placeActivity = (placeKey: string) => this.#places.activity.get(placeKey);
  readonly subscribePlaceActivity = (placeKey: string, listener: () => void) =>
    this.#places.subscribeActivity(placeKey, listener);
  readonly runPlace = (runId: string) => this.#state.runPlaces.get(runId);
  readonly enterPlace = (runId: string, threadId: string, data: MockPlaceEntry) =>
    this.#state.enterPlace(runId, threadId, data);
  readonly actInPlace = (threadId: string, placeKey: string) =>
    this.#places.actInPlace(threadId, placeKey);
  /** A mock helper's current window for one held app. */
  setComputerSessionWindow(
    machineId: string,
    sessionId: string,
    appKey: string,
    window: { windowId: WindowId; title: string },
  ): void {
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      machines: snapshot.machines.map((machine) =>
        machine.id !== machineId || !machine.computerUse
          ? machine
          : {
              ...machine,
              computerUse: {
                ...machine.computerUse,
                sessions: machine.computerUse.sessions.map((session) =>
                  session.sessionId !== sessionId
                    ? session
                    : {
                        ...session,
                        windows: [
                          ...(session.windows ?? []).filter((value) => value.appKey !== appKey),
                          { appKey, ...window },
                        ],
                      },
                ),
              },
            },
      ),
    });
  }
  /** For journeys: cursors move only for the notices applied through the returned script. */
  readonly scriptPlaces = (): MockPlaceScript => this.#places.script();
  /** The Host's `host.apps.changed` notice, as an app changing elsewhere sends it. */
  readonly appsChanged = (): void => this.#state.appsChanged();
  readonly subscribeRunPlace = (runId: string, listener: () => void) => {
    this.#places.start();
    return this.#state.runPlaces.subscribe(runId, listener);
  };
  readonly readBrowserContextCandidate = (sessionId: string, tabId: string) =>
    this.#places.candidate(sessionId, tabId);
  readonly browserWatchFrame = (sessionId: string, surfaceId: string) =>
    this.#places.watchFrame(sessionId, surfaceId);
  readonly browserWatchState = (sessionId: string, surfaceId: string) =>
    this.#places.watchState(sessionId, surfaceId);
  readonly #viewerStatuses = new Map<string, ReturnType<MockHostClient["browserWatchState"]>>();
  readonly browserViewerState = (sessionId: string, surfaceId: string) => {
    const key = JSON.stringify([sessionId, surfaceId]);
    const next = this.#places.watchState(sessionId, surfaceId);
    const before = this.#viewerStatuses.get(key);
    if (before?.status === next.status && before.error === next.error) return before;
    if (this.#viewerStatuses.size >= 16)
      this.#viewerStatuses.delete(this.#viewerStatuses.keys().next().value!);
    const state = { ...next, frame: null };
    this.#viewerStatuses.set(key, state);
    return state;
  };
  readonly subscribeBrowserWatch = (sessionId: string, surfaceId: string, listener: () => void) =>
    this.#places.subscribeWatch(sessionId, surfaceId, listener);
  readonly readBrowserTabIcon = (tabId: string, iconRef: string) =>
    this.#places.icon(tabId, iconRef, this.getSnapshot().tabs.get(tabId as TabId));
  readonly retainBrowserWatch = (sessionId: string, surfaceId: string): (() => void) =>
    this.retainBrowserViewer(sessionId, surfaceId);
  readonly subscribeLifecycle = (
    listener: (event: "background" | "foreground" | "network") => void,
  ): (() => void) => {
    const lifecycle = this.#lifecycle;
    if (!lifecycle) return () => undefined;
    if (lifecycle.getSnapshot().visibility === "background") listener("background");
    const stops = [
      lifecycle.onBackground(() => listener("background")),
      lifecycle.onForeground(() => listener("foreground")),
      lifecycle.onNetworkChange(() => listener("network")),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  };
  connectComputerDisplay(source: NativeViewerSource): WebSocketClient {
    const phone = this.#state
      .getSnapshot()
      .machines.find((machine) =>
        source.kind === "task-session"
          ? machine.computerUse?.sessions.some(
              (session) =>
                session.sessionId === source.sessionId &&
                (source.appKey
                  ? session.apps.some((app) => computerAppIdentityKey(app) === source.appKey)
                  : session.display),
            )
          : machine.computerUse?.ownerViews?.some(
              (view) =>
                view.viewId === source.viewId &&
                view.generation === source.generation &&
                view.state === "ready",
            ),
      );
    const socket = new MockPhoneDisplaySocket(
      !phone || (phone.phoneDisplay && phone.phoneDisplay.view.state !== "ready")
        ? "ended"
        : phone.computerUse?.displayStreamSupported
          ? "live"
          : "unsupported",
      () => {
        const current = this.getSnapshot().machines.find(({ id }) => id === phone?.id);
        return Boolean(
          current &&
          (!current.phoneDisplay || current.phoneDisplay.input.state === "ready") &&
          (source.kind === "task-session" ||
            this.#state.computerViews?.inputAvailable(source.viewId, source.generation) === true),
        );
      },
      phone?.device?.form === "phone",
    );
    const driverKey = phone ? deviceDriverKey(phone) : null;
    const unsubscribe = this.subscribe(() => {
      const current = this.getSnapshot().machines.find(({ id }) => id === phone?.id);
      if (
        driverKey &&
        (!current ||
          deviceDriverKey(current) !== driverKey ||
          (current.phoneDisplay && current.phoneDisplay.view.state !== "ready"))
      )
        socket.close(4003, "Display authority ended");
      else socket.refreshAuthority();
    });
    socket.addEventListener("close", unsubscribe);
    return socket;
  }

  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId: string): void {
    this.#places.accept(sessionId, surfaceId, token);
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#places.start();
    return this.#state.subscribe(listener);
  };

  async createAttachment(input: {
    readonly name: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly idempotencyKey: string;
  }): Promise<Attachment> {
    const result = await this.dispatch({ ...input, type: "attachment.upload.create" });
    if (result.type !== "attachment.upload.create")
      throw new Error("Attachment reservation response mismatch.");
    return result.attachment;
  }
  async uploadAttachment(input: {
    readonly attachmentId: string;
    readonly source: Blob;
    readonly signal?: AbortSignal;
  }): Promise<Attachment> {
    input.signal?.throwIfAborted();
    return this.#state.uploadAttachment(
      input.attachmentId,
      binaryChunks(input.source, input.signal),
    );
  }
  async viewPluginPage(pluginId: string, theme: "light" | "dark", signal?: AbortSignal) {
    signal?.throwIfAborted();
    const view = unwrapRpcResult(await this.rpc["plugins.page.view"]({ pluginId, theme }));
    return { title: pluginId, url: view.entryUrl ?? view.path };
  }
  async viewApp(
    _appId: string,
    _theme: "light" | "dark",
    _signal?: AbortSignal,
  ): Promise<{ title: string; url: string }> {
    throw new Error("Published apps are unavailable in this preview.");
  }

  async getAttachment(attachmentId: string): Promise<Attachment> {
    return this.#state.getAttachment(attachmentId);
  }
  async readAttachment(attachmentId: string): Promise<Blob> {
    const result = this.#state.readAttachment(attachmentId);
    return new Blob([result.bytes], { type: result.metadata.contentType });
  }
  async discardAttachment(attachmentId: string): Promise<void> {
    this.#state.discardAttachment(attachmentId);
  }

  activateThread(threadId: string): void {
    this.#state.activateThread(threadId);
  }

  watchNode(threadId: string, nodeId: string): NodeDetailSubscription {
    const thread = this.getSnapshot().threads.find((entry) => entry.id === threadId);
    if (!thread) throw new Error("Conversation not found.");
    let releasePage: (() => void) | undefined;
    let rows: NodeDetailSnapshot["entries"] = [];
    let before: import("@opensteer/protocol/transcript").TranscriptOrderCursor | null = null;
    let offset = 0;
    let status: NodeDetailSnapshot["status"] = "loading";
    const sources = new Set<() => void>();
    const onChange = () => {
      for (const listener of sources) listener();
    };
    const read = (): NodeDetailSnapshot => {
      const node = (this.getSnapshot().transcripts[threadId] ?? []).find(
        (entry) => entry.kind === "node" && entry.nodeId === nodeId,
      );
      return {
        threadId,
        nodeId,
        node: node?.kind === "node" ? node : null,
        entries: rows,
        status: node ? status : "missing",
        hasMore: before !== null,
        loadingOlder: false,
        error: null,
      };
    };
    const load = async (reset: boolean) => {
      if (!reset && !before) return;
      const current = ++offset;
      const page = unwrapRpcResult(
        await this.rpc["node.items.page"]({
          threadId,
          nodeId,
          ...(!reset && before ? { before } : {}),
        }),
      );
      if (current !== offset || page.kind !== "page") return;
      const entries = page.items.flatMap((item) => nodeTranscriptCard(item) ?? []);
      rows = reset ? entries : [...entries, ...rows];
      before = page.nextBefore;
      status = "ready";
      view = read();
      onChange();
    };
    let view = read();
    void load(true).catch(() => undefined);
    releasePage = this.subscribe(() => {
      view = read();
      onChange();
    });
    return {
      getSnapshot: () => view,
      subscribe: (listener) => {
        sources.add(listener);
        return () => sources.delete(listener);
      },
      loadOlder: () => load(false),
      retry: () => {
        void load(true).catch(() => undefined);
      },
      release: () => {
        ++offset;
        view = { ...view, status: "closed", entries: [], node: null };
        releasePage?.();
        sources.clear();
      },
    };
  }

  scopedShell(selected?: string, revision?: string) {
    return mockScopedShell(this.getSnapshot(), mockThread, selected, revision);
  }

  scopedDetail(threadId: string, nodeId?: string, anchor?: string, revision?: string) {
    return mockScopedDetail(
      this.getSnapshot(),
      mockThread,
      threadId,
      nodeId,
      anchor,
      revision,
      this.#state.nodeEvents,
      (leaseId, messageId) => this.#state.isLocalEditLease(messageId, leaseId),
    );
  }

  readonly #mockHistory = new Map<string, MockHistoryWindow>();
  readonly #mockOverlays = new Map<string, string | null>();

  readonly #transcriptSources = new Map<string, ThreadViewSource>();

  getThreadTranscript(threadId: string): ThreadViewSource {
    const held = this.#transcriptSources.get(threadId);
    if (held) return held;
    const empty: readonly never[] = [];
    let previous: PublicHostSnapshot | undefined;
    let data: ThreadViewState | undefined;
    let priorWindow: MockHistoryWindow | undefined;
    let priorOverlay: string | null | undefined;
    let priorQueue: ThreadInputQueue | undefined;
    let inputQueue: ThreadViewState["inputQueue"] = null;
    const source = {
      subscribe: this.subscribe,
      getSnapshot: () => {
        const value = this.getSnapshot();
        const window = this.#mockHistory.get(threadId);
        const overlay = this.#mockOverlays.get(`${threadId}:requests`);
        if (value === previous && window === priorWindow && overlay === priorOverlay && data)
          return data;
        priorWindow = window;
        priorOverlay = overlay;
        previous = value;
        const whole = value.transcripts[threadId] ?? empty;
        const entries = window ? whole.filter(({ id }) => window.ids.has(id)) : whole;
        const requests = (value.requests[threadId] ?? empty).map((request) => ({
          ...request,
          reviewedRevision:
            request.status === "pending"
              ? mockRequestRevision(request, String(value.revision))
              : undefined,
        }));
        const runQueue = value.runQueue.filter((run) => run.threadId === threadId);
        const queue = value.inputQueues[threadId];
        if (queue !== priorQueue) {
          priorQueue = queue;
          inputQueue = queue
            ? mockInputQueue(queue, String(value.revision), (id) => this.ownsEditLease(id))
            : null;
        }
        const synchronized = value.connection === "connected";
        const hasMore = window
          ? window.before !== null
          : (value.transcriptWindows[threadId]?.hasMore ?? false);
        const hasNewer = window?.after != null;
        const moreRequests = overlay === undefined ? requests.length > 20 : overlay !== null;
        if (
          data &&
          entries === data.entries &&
          requests === data.requests &&
          inputQueue === data.inputQueue &&
          synchronized === data.synchronized &&
          hasMore === data.hasMore &&
          hasNewer === data.hasNewer &&
          moreRequests === data.moreRequests &&
          runQueue.length === data.runQueue.length &&
          runQueue.every((row, i) => row === data!.runQueue[i])
        )
          return data;
        data = {
          entries,
          requests,
          runQueue,
          inputQueue,
          synchronized,
          hasMore,
          moreRequests,
          hasNewer,
        };
        return data;
      },
    };
    if (this.#transcriptSources.size >= 100) {
      const oldest = this.#transcriptSources.keys().next();
      if (!oldest.done) {
        this.#transcriptSources.delete(oldest.value);
        this.#mockHistory.delete(oldest.value);
        for (const kind of ["requests", "tools", "nodes"])
          this.#mockOverlays.delete(`${oldest.value}:${kind}`);
      }
    }
    this.#transcriptSources.set(threadId, source);
    return source;
  }

  readonly #transcriptTexts = new Map<string, { store: ItemTextStore; release: () => void }>();

  scopedLive(
    ...args: Parameters<typeof mockScopedLive> extends [unknown, ...infer Rest] ? Rest : never
  ) {
    return mockScopedLive(this.getSnapshot(), ...args);
  }

  getThreadItemText(threadId: string, nodeId?: string) {
    if (nodeId) return;
    const id = ThreadIdSchema.safeParse(threadId);
    if (!id.success) return;
    const existing = this.#transcriptTexts.get(threadId);
    if (existing) return existing.store;
    const store = new ItemTextStore();
    store.generation(1);
    let previous = new Set<string>();
    const update = () => {
      const revision = String(this.getSnapshot().revision);
      const frames = this.scopedLive(
        { kind: "thread", threadId: id.data },
        "detail:0",
        1,
        revision,
      );
      const current = new Set(frames.map(({ itemId }) => itemId));
      for (const itemId of previous) if (!current.has(itemId)) store.finishItem(itemId);
      for (const frame of frames) store.apply(frame, revision);
      previous = current;
    };
    update();
    const release = this.subscribe(update);
    this.#transcriptTexts.set(threadId, { store, release });
    if (this.#transcriptTexts.size > 8) {
      const oldest = this.#transcriptTexts.entries().next().value!;
      oldest[1].release();
      oldest[1].store.clear();
      this.#transcriptTexts.delete(oldest[0]);
    }
    return store;
  }

  async readTranscriptItem(threadId: string, itemId: string, nodeId?: string) {
    const result = await this.rpc["transcript.item.get"]({
      threadId,
      itemId,
      ...(nodeId ? { nodeId } : {}),
    });
    return result.ok ? result.data : undefined;
  }

  setTranscriptPosition(_threadId: string, _measure: (() => string | undefined | null) | null) {}

  revealedTranscriptMove(_threadId: string) {}
  async loadMoreOverlays(threadId: string, kind: "requests" | "tools" | "nodes") {
    const key = `${threadId}:${kind}`;
    const cursor =
      this.#mockOverlays.get(key) ?? this.scopedDetail(threadId)?.overlayCursors?.[kind];
    if (!cursor || this.#mockOverlays.get(key) === null) return;
    const page = unwrapRpcResult(
      await this.rpc["thread.overlays.page"]({ threadId, kind, cursor }),
    );
    this.#mockOverlays.set(key, page.next);
    this.#state.refreshBrowserView();
  }
  async loadNewerTranscript(threadId: string) {
    const window = this.#mockHistory.get(threadId);
    if (window?.after) await this.#readMockHistory(threadId, { after: window.after });
  }
  watchPersonalResource() {
    return () => {};
  }

  observeThread(_threadId: string): () => void {
    return () => undefined;
  }

  async getAssignment(assignmentId: string): Promise<AssignmentView> {
    return unwrapRpcResult(await this.rpc["assignment.get"]({ assignmentId }));
  }

  async cancelAssignment(assignmentId: string): Promise<AssignmentSummary> {
    const result = await this.dispatch({
      assignmentId,
      idempotencyKey: `assignment:cancel:${assignmentId}`,
      type: "assignment.cancel",
    });
    if (result.type !== "assignment.cancel") throw new Error("Assignment command mismatch.");
    return result.assignment;
  }

  /**
   * A work location dropping off or coming back. A real Host learns it from
   * the Runner's connection, never from a client, so the preview takes it here.
   */
  setMachineIntegrationReadiness(
    machineId: string,
    readiness: NonNullable<MachineSummary["modules"]["integrations"]>["readiness"],
  ): void {
    this.#state.setMachineIntegrationReadiness(machineId, readiness);
  }

  setEnvironmentConnected(environmentId: string, connected: boolean): void {
    this.#state.setEnvironmentConnected(environmentId, connected);
  }

  goOffline(): void {
    this.#state.goOffline();
  }

  /**
   * What a Mac's helper says about computer use. A real Host hears it on that
   * Mac's own Runner stream, never from a client, so the preview takes it here.
   */
  setComputerUseReadiness(
    machineId: string,
    state: "ready" | "permission-required" | "unavailable",
  ): void {
    this.#state.setComputerUseReadiness(machineId, state);
  }

  /**
   * A computer going offline or coming back. A real Host hears it from that
   * computer's own connection, never from a client, so the preview takes it here.
   */
  setMachineStatus(machineId: string, status: MachineSummary["status"]): void {
    this.#state.setMachineStatus(machineId, status);
  }

  /** Scripted bridge hooks: device reports and taps never enter the production Host API. */
  /** This phone joins as what it advertises: an iPhone its apps and, once qualified, its browser. */
  mockConnectIphone(input: MockPhoneJoin): void {
    this.#state.mockConnectIphone(input);
  }

  /** The phone stopped reaching this Host, as a closed or cut-off app does. */
  mockPhoneAway(runnerId: string): void {
    this.#state.mockPhoneAway(runnerId);
  }

  /** A running subagent reports a new step, as the Host relays its progress line. */
  mockSubagentProgress(threadId: string, nodeId: string, progress: string): void {
    this.#state.mockSubagentProgress(threadId, nodeId, progress);
  }

  /** Adds a settled task of `turns` asks, each a command and a reply, for long-thread journeys. */
  mockLongThread(turns: number): string {
    return this.#state.mockLongThread(turns);
  }

  /** A computer-use task whose last call the Home refused because a Mac was asleep. */
  mockAsleepStep(): void {
    this.#state.mockAsleepStep();
  }

  /** One computer asleep since twenty minutes ago and another waiting for an update. */
  mockDeviceStates(): void {
    this.#state.mockDeviceStates();
  }

  /** The organization applies a new policy version, as the synced shell would bring it. */
  applyWorkPolicy(
    policy: import("@opensteer/control-plane-protocol").EffectiveWorkPolicy | null,
  ): void {
    this.#state.applyWorkPolicy(policy);
  }

  /** Connected agents working tasks themselves, in each state, with a tab each uses. */
  mockAgentWork(
    options: {
      readonly long?: boolean;
      readonly question?: boolean;
      readonly questionChoices?: readonly string[];
    } = {},
  ): void {
    this.#state.mockAgentWork(options);
  }

  /** The person's Stop on a connected agent's task, bound to the session they saw. */
  stopAgentSession(threadId: string, sessionId: string): boolean {
    return this.#state.stopAgentSession(threadId, sessionId);
  }

  /** Rewrites one message's words in place, as a durable update or a streamed token would. */
  mockMessageBody(threadId: string, messageId: string, body: string): void {
    this.#state.mockMessageBody(threadId, messageId, body);
  }

  readonly #editLeases = new Set<string>();

  editWaitingMessage(
    threadId: string,
    messageId: string,
    options?: { readonly takeOver?: boolean },
  ): Promise<WaitingMessageEditor> {
    return openWaitingMessageEditor(
      {
        dispatch: (command) => this.dispatch(command),
        leases: this.#editLeases,
        readRevision: async (threadId, messageId, expectedRevision, leaseId) => {
          const held = this.#state
            .loadThreadInputQueue(threadId)
            .items.find(({ message }) => message.id === messageId);
          if (
            !held ||
            held.lease?.leaseId !== leaseId ||
            (held.message.edit?.revision ?? 0) !== expectedRevision
          )
            throw mockConflict("This waiting message changed.");
          return held.message.content;
        },
        now: () => Date.now(),
      },
      threadId,
      messageId,
      options?.takeOver ?? false,
    );
  }

  async releaseWaitingMessage(threadId: string, messageId: string): Promise<void> {
    await this.dispatch({
      messageId: MessageIdSchema.parse(messageId),
      threadId: ThreadIdSchema.parse(threadId),
      type: "thread.input.lease.release",
    });
  }

  ownsEditLease(leaseId: string): boolean {
    return this.#editLeases.has(leaseId);
  }

  async listMessageRevisions(
    threadId: string,
    messageId: string,
    before?: number,
  ): Promise<{ readonly revisions: readonly MessageRevisionView[]; readonly hasMore: boolean }> {
    return unwrapRpcResult(
      await this.rpc["thread.message.revisions.list"]({
        messageId: MessageIdSchema.parse(messageId),
        threadId: ThreadIdSchema.parse(threadId),
        ...(before === undefined ? {} : { before }),
      }),
    );
  }

  /** Scripted: a task's next Run waits while its AI account is still getting ready. */
  mockAccountPreparing(threadId: string): void {
    this.#state.queueBehindPreparingAccount(threadId);
  }

  /** Scripted: another of the person's devices opens a waiting message to edit it. */
  mockOtherDeviceEdit(threadId: string, messageId: string, deviceLabel = "Alex's iPad"): void {
    this.#state.mockOtherDeviceEdit(threadId, messageId, deviceLabel);
  }

  async cancelThreadInput(threadId: string, messageId: string): Promise<void> {
    await this.dispatch({
      idempotencyKey: `mock-input-cancel:${crypto.randomUUID()}`,
      messageId,
      threadId,
      type: "thread.input.cancel",
    });
  }

  async resumeThreadInputQueue(threadId: string): Promise<void> {
    await this.dispatch({
      idempotencyKey: `mock-input-queue-resume:${crypto.randomUUID()}`,
      threadId,
      type: "thread.inputQueue.resume",
    });
  }

  async steerThreadInput(threadId: string, messageId: string): Promise<void> {
    const expectedRunId = this.#state.loadThreadInputQueue(threadId).steerRunId;
    if (expectedRunId === null) throw new Error("This message cannot be steered right now.");
    await this.dispatch({
      expectedRunId,
      idempotencyKey: `mock-input-steer:${crypto.randomUUID()}`,
      messageId,
      threadId,
      type: "thread.input.steer",
    });
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const result = await this.dispatch({
      type: "thread.create",
      ...input,
      title: input.title?.trim() || "New task",
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    });
    if (result.type !== "thread.create") throw new Error("Thread result mismatch.");
    return this.#state.getSnapshot().threads.find(({ id }) => id === result.thread.id)!;
  }

  async renameThread(threadId: string, title: string): Promise<ThreadSummary> {
    if (!this.#state.getSnapshot().threadRenameAvailable)
      throw new Error("This Host does not support task renaming.");
    const result = await this.dispatch({
      type: "thread.rename",
      threadId,
      title: ThreadTitleSchema.parse(title),
      idempotencyKey: `mock-thread-rename:${crypto.randomUUID()}`,
    });
    if (result.type !== "thread.rename") throw new Error("Thread command mismatch.");
    return this.#state.getSnapshot().threads.find(({ id }) => id === threadId)!;
  }

  async searchThreadMessages(input: {
    threadId: string;
    query: string;
    before?: string;
  }): Promise<ThreadMessagePage> {
    const result = await this.rpc["thread.messages.list"]({ ...input, limit: 50 });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  async loadTranscriptAround(threadId: string, messageId: string): Promise<boolean> {
    await this.#readMockHistory(threadId, { aroundMessageId: messageId });
    return true;
  }

  async loadLatestTranscript(threadId: string): Promise<boolean> {
    if (!this.#state.getSnapshot().threads.some((thread) => thread.id === threadId))
      throw new Error("Thread not found.");
    await this.#readMockHistory(threadId, {});
    return true;
  }

  async #readMockHistory(
    threadId: string,
    query: Omit<Parameters<HostApiClient["thread.items.page"]>[0], "threadId">,
  ): Promise<void> {
    const page = unwrapRpcResult(await this.rpc["thread.items.page"]({ threadId, ...query }));
    if (page.kind === "history-reset") {
      this.#mockHistory.delete(threadId);
      this.#state.refreshBrowserView();
      return;
    }
    const held = this.#mockHistory.get(threadId);
    const ids = new Set(query.before || query.after ? held?.ids : []);
    for (const { id } of page.items) ids.add(id);
    this.#mockHistory.set(threadId, {
      ids,
      before: query.after ? (held?.before ?? page.nextBefore) : page.nextBefore,
      after: query.before ? (held?.after ?? page.nextAfter ?? null) : (page.nextAfter ?? null),
    });
    this.#state.refreshBrowserView();
  }

  subscribePersonalRemoteAccess(listener: () => void): () => void {
    this.#state.remoteAdministrationListeners.add(listener);
    return () => this.#state.remoteAdministrationListeners.delete(listener);
  }

  subscribeConnectionsChanged(listener: () => void): () => void {
    this.#state.connectionsListeners.add(listener);
    return () => this.#state.connectionsListeners.delete(listener);
  }

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    return this.#state.subscribeNotifications(listener);
  }

  async visitThread(threadId: string, visitedAt: string): Promise<void> {
    await this.dispatch({
      type: "thread.visit",
      idempotencyKey: `mock-visit:${crypto.randomUUID()}`,
      threadId,
      visitedAt,
    });
  }

  async setTaskDone(threadId: string, done: boolean): Promise<void> {
    await this.dispatch({
      type: "thread.done.set",
      threadId,
      done,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  /** The preview's task lists always hold every task, so there is no earlier page. */
  async loadEarlierTasks(): Promise<void> {}
  async loadEarlierNeedsYou(): Promise<void> {
    this.#state.loadEarlierNeedsYou();
  }
  async readRequest(threadId: string, requestId: string): Promise<RequestView | null> {
    const { requests, reviewedRevisions } = unwrapRpcResult(
      await this.rpc["thread.requests.list"]({
        requestId: RequestIdSchema.parse(requestId),
        threadId: ThreadIdSchema.parse(threadId),
      }),
    );
    const request = requests.find(({ id }) => id === requestId);
    if (!request) return null;
    const reviewed = { ...request, reviewedRevision: reviewedRevisions?.[request.id] };
    return reviewed;
  }

  async loadDoneTasks(deploymentId?: string): Promise<void> {
    if (this.#state.getSnapshot().quietTasksAvailable) this.#state.loadDoneTasks(deploymentId);
  }

  async loadEarlierDoneTasks(_deploymentId?: string): Promise<void> {}

  /** Moves a task to Done as the Host's quiet pass would, so the preview can show it. */
  moveQuietly(threadId: string): void {
    this.#state.moveQuietly(threadId);
  }

  async setOwnerName(
    name: PersonName | null,
    expectedVersion: string | null,
  ): Promise<{ readonly applied: boolean }> {
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        idempotencyKey: crypto.randomUUID(),
        name,
        expectedVersion,
        type: "viewer.name.update",
      }),
    );
    if (result.type !== "viewer.name.update") throw new Error("Setting command mismatch.");
    return { applied: result.applied };
  }

  async setQuietTaskDays(days: QuietTaskDays): Promise<void> {
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        idempotencyKey: crypto.randomUUID(),
        quietTaskDays: days,
        type: "viewer.quietTasks.update",
      }),
    );
    if (result.type !== "viewer.quietTasks.update") throw new Error("Setting command mismatch.");
  }

  async rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences> {
    const result = await this.dispatch({
      ...(choice.accessMode ? { accessMode: choice.accessMode } : {}),
      idempotencyKey: `mock-execution-preferences:${crypto.randomUUID()}`,
      ...(choice.selection ? { selection: choice.selection } : {}),
      type: "execution.preferences.remember",
    });
    if (result.type !== "execution.preferences.remember") {
      throw new Error("Execution preferences command mismatch.");
    }
    return result.preferences;
  }

  async updateThreadExecution(
    threadId: string,
    selection: Pick<ExecutionSelection, "harnessInstanceId" | "modelSelection">,
    continuation?: { expectedProviderSessionId: string | null },
  ): Promise<ThreadSummary> {
    const thread = this.#state.getSnapshot().threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const result = await this.dispatch({
      harnessInstanceId: selection.harnessInstanceId,
      idempotencyKey: `mock-thread-execution:${crypto.randomUUID()}`,
      modelSelection: selection.modelSelection,
      ...(continuation ? { continuation } : {}),
      threadId,
      type: "thread.execution.update",
    });
    if (result.type !== "thread.execution.update") throw new Error("Thread command mismatch.");
    {
      await this.#rememberQuietly({
        selection: {
          environmentId: thread.environmentId,
          harnessInstanceId: selection.harnessInstanceId,
          modelSelection: selection.modelSelection,
        },
      });
    }
    return this.#projectedThread(threadId);
  }

  async updateThreadAccess(threadId: string, accessMode: ThreadAccessMode): Promise<ThreadSummary> {
    const thread = this.#state.getSnapshot().threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const result = await this.dispatch({
      accessMode,
      idempotencyKey: `mock-thread-access:${crypto.randomUUID()}`,
      threadId,
      type: "thread.access.update",
    });
    if (result.type !== "thread.access.update") throw new Error("Thread command mismatch.");
    await this.#rememberQuietly({ accessMode });
    return this.#projectedThread(threadId);
  }

  #projectedThread(threadId: string): ThreadSummary {
    const thread = this.#state.getSnapshot().threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("The mock Thread was not projected.");
    return thread;
  }

  /** The mutation already succeeded; the next bootstrap is authoritative. */
  async #rememberQuietly(choice: ExecutionChoice): Promise<void> {
    await this.rememberExecution(choice).catch(() => undefined);
  }

  async setIdleCompactionPolicy(
    policy: import("@opensteer/core").IdleCompactionPolicy,
  ): Promise<void> {
    await this.dispatch({
      type: "settings.idleCompaction.set",
      policy,
      idempotencyKey: `idle-compaction:${Date.now()}`,
    });
  }
  async dispatch(command: ClientCommandInput): Promise<HostApiCommandOutput> {
    const parsed = clientCommandSchema.parse(
      browserProfileHomeCommand(command, this.#state.getSnapshot().browserProfileHomes),
    );
    const result = await this.rpc["commands.dispatch"](parsed);
    if (result.ok) return result.data;
    // The same typed refusal the real client raises, so a surface branches on
    // the code here exactly as it would against a Host.
    throw new HostClientRequestError({
      code: result.error.code,
      message: result.error.message,
      ...(result.error.reason === undefined ? {} : { reason: result.error.reason }),
      status: rpcErrorStatus(result.error.code),
    });
  }

  dispose(): void {
    for (const { store, release } of this.#transcriptTexts.values()) {
      release();
      store.clear();
    }
    this.#transcriptTexts.clear();
    clearRunPageViews(this);
    clearRunPlacePictures(this);
    this.references.dispose();
    this.transcriptFiles.dispose();
    this.assetUrls.dispose();
    this.#personShowListeners.clear();
    this.browserHistory.dispose();
    this.#computerViews.clear();
    this.#worldSubscription();
    this.#places.dispose();
    disposeMessageOutbox(this);
    if (this.#ownsConnection) this.connection.dispose();
    this.#state.dispose();
  }

  load(): Promise<void> {
    if (this.#ownsConnection) {
      if (this.connection.getSnapshot().phase !== "ready") this.connection.retry();
      else this.connection.start();
    }
    return this.#state.load();
  }

  async loadEarlierTranscript(threadId: string): Promise<void> {
    const before = this.#mockHistory.get(threadId)?.before;
    if (before) await this.#readMockHistory(threadId, { before });
  }

  async loadThreadInputQueue(threadId: string) {
    return mockInputQueue(
      this.#state.loadThreadInputQueue(threadId),
      String(this.getSnapshot().revision),
      (id) => this.ownsEditLease(id),
    );
  }

  refresh(): Promise<void> {
    return this.#state.refresh();
  }

  async loadMachineAccessHistory(input: {
    readonly before?: string;
    readonly limit: number;
    readonly runnerId: string;
  }): Promise<MachineAccessHistoryPage> {
    const result = await this.rpc["machine.access.history"]({
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: input.limit,
      runnerId: input.runnerId,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  async stopMachineAccessSession(sessionId: string): Promise<boolean> {
    const result = await this.dispatch({
      idempotencyKey: `mock-machine-access-stop:${crypto.randomUUID()}`,
      sessionId,
      type: "machine.access.session.stop",
    });
    if (result.type !== "machine.access.session.stop") {
      throw new Error("Stop session command mismatch.");
    }
    await this.refresh();
    return result.ended;
  }

  /** Preview-only: the Runner a local enrollment token names connects. */
  connectLocalRunner(token: string): string {
    return this.#state.connectLocalRunner(token);
  }

  async bindDeviceSession(input: {
    readonly machineId: string;
    readonly proof: import("@opensteer/protocol").DeviceSessionBindingProof;
  }): Promise<void> {
    const result = await this.dispatch({
      ...input,
      idempotencyKey: globalThis.crypto.randomUUID(),
      type: "machine.session.bind",
    });
    if (result.type !== "machine.session.bind") throw new Error("Device binding command mismatch.");
  }

  async attachIphoneScreen(input: Parameters<HostClient["attachIphoneScreen"]>[0]) {
    const result = await this.dispatch({
      ...input,
      type: "iphone.screen.attach",
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    });
    if (result.type !== "iphone.screen.attach") throw new Error("Screen attach command mismatch.");
    return result;
  }
  async detachIphoneScreen(input: Parameters<HostClient["detachIphoneScreen"]>[0]) {
    const result = await this.dispatch({
      ...input,
      deviceId: DeviceIdSchema.parse(input.deviceId),
      type: "iphone.screen.detach",
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    });
    if (result.type !== "iphone.screen.detach") throw new Error("Screen detach command mismatch.");
    return result;
  }
  setIphoneScreenState(state: MockIphoneScreenState, holding = false): void {
    this.#state.setIphoneScreenState(state, holding);
  }

  async updateMachineAccess(input: MachineAccessUpdateInput): Promise<MachineAccessUpdateOutcome> {
    const command = deviceAccessCommand(input, `mock-machine-access:${crypto.randomUUID()}`);
    const result = await this.dispatch(command);
    if (result.type !== "machine.access.update") {
      throw new Error("Access settings command mismatch.");
    }
    if (result.outcome === "conflict") return { outcome: "conflict" };
    await this.refresh();
    return { outcome: "updated", revision: result.revision };
  }

  /** For journeys: a negotiated Runtime's navigation facts, through the session and catalog projections. */
  setBrowserNavigation(
    sessionId: string,
    tabId: string,
    navigation: {
      navigationVersion?: 1 | undefined;
      canGoBack?: boolean | undefined;
      canGoForward?: boolean | undefined;
    },
  ): void {
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((session) =>
        session.id !== sessionId
          ? session
          : {
              ...session,
              navigationVersion: navigation.navigationVersion,
              ...(session.catalog
                ? {
                    catalog: {
                      ...session.catalog,
                      revision: session.catalog.revision + 1,
                      tabs: session.catalog.tabs.map((tab) =>
                        tab.id !== tabId
                          ? tab
                          : {
                              ...tab,
                              canGoBack: navigation.canGoBack,
                              canGoForward: navigation.canGoForward,
                            },
                      ),
                    },
                  }
                : {}),
            },
      ),
    });
  }

  sendBrowserCommand(sessionId: string, command: BrowserCommand): void {
    if (command.type === "cursor.reset" || command.type === "input.cancel") {
      if (command.surfaceId)
        this.#cursorPoints.delete(JSON.stringify([sessionId, command.surfaceId]));
      if (command.type === "cursor.reset") return;
    }
    if (command.type === "cursor.query") {
      const point = this.#cursorPoints.get(JSON.stringify([sessionId, command.surfaceId]));
      if (point && point.cursorSequence === command.pointSequence)
        this.#browserCursor.receive(sessionId, {
          ...point,
          cursorSequence: command.cursorSequence,
        });
      return;
    }
    if (command.type === "input.pointer" && command.cursorSequence !== undefined) {
      const hint = {
        type: "browser.cursor" as const,
        surfaceId: command.surfaceId,
        consumerToken: "00000000-0000-4000-8000-000000000001",
        cursorSequence: command.cursorSequence,
        documentId:
          this.#state
            .getSnapshot()
            .browserSessions.find((session) => session.id === sessionId)
            ?.surfaces.find((tab) => tab.id === command.surfaceId)?.documentId ?? "mock-document",
        geometryRevision: command.geometryRevision ?? 0,
        captureRevision: command.captureRevision ?? 0,
        cursor: "default" as const,
      };
      this.#cursorPoints.set(JSON.stringify([sessionId, command.surfaceId]), hint);
      this.#browserCursor.receive(sessionId, hint);
    }

    if (
      command.type === "navigation.reload" &&
      command.ignoreCache !== undefined &&
      this.#state.getSnapshot().browserSessions.find((session) => session.id === sessionId)
        ?.navigationVersion !== 1
    )
      throw new Error("This browser does not support reloading without cache.");
    this.#places.command(sessionId, command);
  }

  async stopNode(threadId: string, nodeId: string): Promise<void> {
    await this.#state.stopNode(threadId, nodeId);
  }

  async stopRun(threadId: string, expectedRunId?: string): Promise<void> {
    const snapshot = this.getSnapshot();
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    const run = thread ? threadStopTarget({ runQueue: snapshot.runQueue, thread }) : null;
    if (!run || (expectedRunId && run.id !== expectedRunId))
      throw new Error("This Thread has nothing to stop.");
    await this.dispatch({
      idempotencyKey: `mock-interrupt:${crypto.randomUUID()}`,
      runId: run.id,
      threadId,
      type: "run.interrupt",
    });
  }
}

function mockAutomaticModelsView(state: MockHostState): AutomaticModelsView {
  const snapshot = state.getSnapshot();
  const excludedAccounts = excludedBackgroundAccounts(state.agentHomeSettings);
  const accounts = snapshot.harnesses.map((h) => {
    const env = snapshot.environments.find((e) => e.id === h.environmentId);
    return {
      environmentId: EnvironmentIdSchema.parse(h.environmentId),
      harnessInstanceId: HarnessInstanceIdSchema.parse(h.id),
      harnessRevision: h.runtimeRevision,
      driverKind: HarnessIdSchema.parse(h.driverKind),
      sourceId: h.sourceId,
      isDefault: h.isDefault,
      enabled: h.enabled,
      removed: false,
      available: state.automaticModels !== "none" && !!env?.connected,
      catalog: env?.harnessCatalogs.find((c) => c.harnessInstanceId === h.id) ?? null,
      usage: [],
      accountDisplayName: h.name,
      computerDisplayName: env?.name ?? "Computer",
    };
  });
  const inUse = (role: BackgroundModelRole) => {
    const chosen = resolveModelCandidates({
      wants: backgroundModelWants(state.agentHomeSettings, role),
      accounts,
      excludedAccounts,
      canRun: () => ({ ok: true }),
      now: Date.now(),
    }).candidates[0];
    if (!chosen) return null;
    const account = accounts.find((a) => a.harnessInstanceId === chosen.harnessInstanceId)!;
    const { modelId } = chosen.storedModelSelection;
    const model = account.catalog?.models.find((m) => m.modelId === modelId);
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      accountDisplayName: account.accountDisplayName,
      computerDisplayName: account.computerDisplayName,
      modelDisplayName: model?.displayName ?? modelId,
      effortDisplayName: model ? modelEffortLabel(model, chosen.runModelSelection.options) : null,
      usageLimited: false,
    };
  };
  return AutomaticModelsViewSchema.parse({
    file: state.agentHomeSettingsFile,
    excludedAccounts,
    naming: inUse("naming"),
    light: inUse("light"),
    deep: inUse("deep"),
  });
}
interface MockPlugin {
  id: string;
  name: string;
  scope: "deployment" | "folder";
  source: { directory?: string; folderDirectory?: string };
  currentVersionId: string;
  versions: {
    id: string;
    digest: string;
    manifest: { name: string; version?: string; description?: string; skills: unknown[] };
  }[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
class MockHostState {
  onReferenceEvent: ((event: AgentEvent) => void) | undefined;
  nodeEvents: readonly import("@opensteer/core").AgentEventView[] = [];
  /** The mock Host's tab commands, over its tab catalog and browser world. */
  /** The person's own tabs and apps answer only their signed-in owner, as the Host's scope does. */
  #requireOwner(): void {
    if (this.snapshot.session !== "authenticated")
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Authentication required",
      });
  }
  async tabCommand(command: TabCommand): Promise<TabCommandResult> {
    this.#requireOwner();
    const catalog = this.tabCatalog;
    const republish = () => this.emit();
    switch (command.type) {
      case "tab.open": {
        const tabId = await this.#openTab(
          command.target,
          command.idempotencyKey,
          command.typed === true,
        );
        republish();
        return { type: command.type, tab: catalog.tab(tabId), layout: catalog.layout() };
      }
      case "tab.close": {
        const result = catalog.close(command.tabIds);
        republish();
        return { type: command.type, ...result, layout: catalog.layout() };
      }
      case "tab.reopen": {
        const tabId = catalog.reopen(command.tabId);
        republish();
        return { type: command.type, tab: catalog.tab(tabId), layout: catalog.layout() };
      }
      case "tab.activate":
        return this.#activateTab(command.tabId);
      case "tab.organize": {
        const { type: _type, idempotencyKey: _key, ...input } = command;
        catalog.organize(input);
        republish();
        return {
          type: command.type,
          tabs: command.tabIds.map((id) => catalog.tab(id)),
          layout: catalog.layout(),
        };
      }
      case "tab.group.update": {
        const { type: _type, idempotencyKey: _key, ...input } = command;
        const group = catalog.updateGroup(input);
        republish();
        return { type: command.type, group, layout: catalog.layout() };
      }
      case "tab.group.delete":
        catalog.deleteGroup(command.groupId);
        republish();
        return { type: command.type, layout: catalog.layout() };
    }
  }
  async #openTab(target: TabTarget, idempotencyKey: string, typed = false): Promise<TabId> {
    const catalog = this.tabCatalog;
    if (target.kind === "page") {
      if (!this.places) throw new Error("The browser is unavailable.");
      const targetDevice =
        "guest" in target && target.computerId
          ? this.snapshot.machines.find(({ id }) => id === target.computerId)
          : null;
      const runnerId = targetDevice ? mockDeviceMachine(targetDevice).selfRunnerId : null;
      if ("guest" in target && target.computerId && !runnerId)
        throw new Error("This device cannot host browser pages.");
      const opened = await this.places.openTarget({
        type: "browser.tab.open",
        identity:
          "profileId" in target
            ? { kind: "profile", profileId: target.profileId }
            : { kind: "guest" },
        // As on the Host, Guest without a computer is placed only when one computer can browse.
        ...(runnerId ? { placement: { kind: "runner", runnerId } } : {}),
        url: target.url,
        ...(typed ? { typed: true } : {}),
        idempotencyKey,
      });
      catalog.revealPage(opened.tabId);
      return opened.tabId;
    }
    const held = catalog.singleton(target);
    if (held) return held.tabId;
    if (target.kind === "app") {
      const app = this.apps.find((value) => value.appId === target.appId);
      if (!app)
        throw new HostClientRequestError({
          code: "not_found",
          status: 404,
          message: "This app is no longer published.",
        });
      const tabId = TabIdSchema.parse(createId("tab"));
      catalog.addNative({
        tabId,
        kind: "app",
        computerId: app.computerId,
        title: app.name,
        appId: app.appId,
        openedBy: "person",
        createdAt: this.now().toISOString(),
      });
      return tabId;
    }
    const machine = this.snapshot.machines.find((value) => value.id === target.computerId);
    if (!machine || machine.status !== "online")
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "This computer is offline.",
      });
    const tabId = TabIdSchema.parse(createId("tab"));
    if (target.kind === "phone")
      catalog.addNative({
        tabId,
        kind: "phone",
        computerId: target.computerId,
        title: machine.name,
        openedBy: "person",
        createdAt: this.now().toISOString(),
      });
    else {
      const approved = this.computerViews
        ?.approved()
        .find(
          (app) =>
            app.machineId === target.computerId &&
            app.target.kind === "app" &&
            ("bundleId" in target ? app.target.app.bundleId === target.bundleId : true),
        );
      if (!approved || approved.target.kind !== "app")
        throw new HostClientRequestError({
          code: "access_denied",
          status: 403,
          message: "Approve this app first.",
        });
      catalog.addNative({
        tabId,
        kind: "window",
        computerId: target.computerId,
        title: approved.name,
        appName: approved.target.app.displayName,
        bundleId: approved.target.app.bundleId,
        openedBy: "person",
        createdAt: this.now().toISOString(),
      });
    }
    return tabId;
  }
  #activateTab(tabId: TabId): TabCommandResult {
    const tab = this.tabCatalog.tab(tabId);
    if (tab.state === "unavailable")
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: tab.unavailableReason!,
      });
    const done = (viewer: Extract<TabCommandResult, { type: "tab.activate" }>["viewer"]) => {
      this.emit();
      return { type: "tab.activate" as const, tab: this.tabCatalog.tab(tabId), viewer };
    };
    if (tab.kind === "app") return done({ kind: "app", appId: tab.appId! });
    if (tab.kind === "page") {
      const lineage = this.snapshot.browserGroups?.find((group) =>
        group.tabs?.some((held) => held.id === tabId),
      );
      const session = this.snapshot.browserSessions.find((held) => held.id === lineage?.session.id);
      if (!lineage || !session) throw new Error("This page is unavailable.");
      const live =
        session.state === "ready" && session.catalog?.tabs.some((held) => held.id === tabId);
      const sessionId = live ? session.id : this.places!.restorePage(tabId).session.id;
      return done({
        kind: "page",
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        surfaceId: tabId,
      });
    }
    const native = this.tabCatalog.native(tabId)!;
    if (!this.computerViews) throw new Error("This computer cannot show views.");
    const view =
      tab.kind === "phone"
        ? this.computerViews.open(tab.computer.computerId, { kind: "phone", display: "main" })
        : this.computerViews.open(tab.computer.computerId, {
            kind: "app",
            app: { bundleId: native.bundleId!, displayName: native.appName!, teamId: null },
          });
    return done({ kind: tab.kind, view });
  }
  /** As the real client does on `host.apps.changed`: an Apps page reads again. */
  appsChanged(): void {
    this.snapshot = { ...this.snapshot, appsRevision: this.snapshot.appsRevision + 1 };
    this.emit();
  }
  /** The mock Host's person-side app lifecycle; servers start and stop at once. */
  appCommand(command: AppCommand): AppCommandResult {
    this.#requireOwner();
    const index = this.apps.findIndex((app) => app.appId === command.appId);
    const app = this.apps[index];
    if (!app)
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "This app is no longer published.",
      });
    const at = this.now().toISOString();
    const put = (next: App) => {
      this.apps = this.apps.map((held) => (held.appId === next.appId ? next : held));
      this.appsChanged();
      return next;
    };
    switch (command.type) {
      case "app.rename":
        return { type: command.type, app: put({ ...app, name: command.name, updatedAt: at }) };
      case "app.start":
      case "app.stop": {
        if (!app.server)
          throw new HostClientRequestError({
            code: "invalid_input",
            status: 400,
            message: "An HTML app has no server to start or stop.",
          });
        const state = command.type === "app.start" ? "running" : "stopped";
        return {
          type: command.type,
          app: put({
            ...app,
            state,
            updatedAt: at,
            server: {
              ...app.server,
              desiredState: state,
              state,
              generation: app.server.generation + 1,
              lastError: null,
            },
          }),
        };
      }
      case "app.delete":
        this.apps = this.apps.filter((held) => held.appId !== app.appId);
        this.tabCatalog.removeApp(app.appId);
        this.appsChanged();
        return { type: command.type, appId: app.appId, deleted: true };
    }
  }

  agentHomeSettings: AgentHomeSettings = {};
  agentHomeSettingsFile: AgentHomeSettingsFileView = { status: "missing" };
  readonly automaticModels: NonNullable<MockHostClientOptions["automaticModels"]>;
  readonly grantsAvailable: boolean;
  private connections: import("@opensteer/protocol").AgentConnection[];
  private pendingConnectionConsent: import("@opensteer/protocol").AgentConnectionConsent | null;
  readonly chromeTabs: import("../host/connected-agent-options.js").ChromeTabGrantCatalog;
  workPolicy: import("@opensteer/control-plane-protocol").EffectiveWorkPolicy | null;
  private connectionDecision: { requestId: string; fingerprint: string } | null = null;
  connectionConsent(requestId: string) {
    const consent = this.pendingConnectionConsent;
    if (
      !this.snapshot.user ||
      !consent ||
      consent.requestId !== requestId ||
      Date.parse(consent.expiresAt) <= this.now().getTime()
    )
      throw mockNotFound("This agent connection request expired. Start again from the agent.");
    return consent;
  }
  #consentChange: import("@opensteer/protocol").AgentConnectionConsent | null;
  authorizeConnection(command: Extract<HostApiCommand, { type: "connection.authorize" }>) {
    if (command.decision.kind === "approve" && this.#consentChange) {
      this.pendingConnectionConsent = this.#consentChange;
      this.#consentChange = null;
    }
    const consent = this.connectionConsent(command.requestId);
    if (
      command.decision.kind === "approve" &&
      consent.verificationSnapshot &&
      command.decision.verificationSnapshot !== consent.verificationSnapshot
    )
      throw new HostClientRequestError({
        code: "conflict",
        reason: agentConnectionConsentRefusals.verificationChanged,
        message: agentConnectionVerificationChangedMessage,
        status: 409,
      });
    const fingerprint = JSON.stringify(command.decision);
    if (this.connectionDecision?.requestId === command.requestId) {
      if (this.connectionDecision.fingerprint !== fingerprint)
        throw mockConflict("This connection request has already been answered.");
    } else {
      if (command.decision.kind === "approve") {
        this.connections.push({
          id: `mcn_${crypto.randomUUID()}`,
          userId: this.snapshot.user!.id,
          label: command.decision.label,
          clientName: consent.clientName,
          accessMode: command.decision.accessMode,
          grant: command.decision.grant ?? { scope: "everything" },
          grantRevision: 1,
          consentVersion: command.decision.grant ? 2 : 1,
          client: { fingerprint: null, redirectOrigin: new URL(consent.redirectUri).origin },
          state: "active",
          lastActionUncertain: false,
          revokedAt: null,
          createdAt: this.now().toISOString(),
          lastUsedAt: null,
          expiresAt: new Date(this.now().getTime() + 30 * 24 * 60 * 60_000).toISOString(),
        });
      }
      this.connectionDecision = { requestId: command.requestId, fingerprint };
    }
    return {
      type: "connection.authorize" as const,
      completionPath: `/oauth/mcp/complete?request=${command.requestId}`,
    };
  }
  #agentOperations: ReturnType<typeof mockAgentWork>["operations"] = [];

  /** The preview's direct operations, newest first, as the Home's activity reads page them. */
  agentActivity(filter: { readonly threadId?: string; readonly connectionId?: string }) {
    const operations = this.#agentOperations
      .filter(
        ({ operation, connectionId }) =>
          (filter.threadId === undefined || operation.taskId === filter.threadId) &&
          (filter.connectionId === undefined || connectionId === filter.connectionId),
      )
      .map(({ operation }) => operation)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { operations: operations.slice(0, 50), nextBefore: null };
  }
  listConnections(includeRevoked = false) {
    return this.connections.filter(
      (row) =>
        row.userId === this.snapshot.user?.id &&
        (includeRevoked ||
          (row.state !== "stopped" &&
            (row.expiresAt === null || Date.parse(row.expiresAt) > this.now().getTime()))),
    );
  }
  revokeConnection(id: string) {
    const revokedAt = this.now().toISOString();
    this.connections = this.connections.map((row) =>
      row.id === id && row.userId === this.snapshot.user?.id && row.state !== "stopped"
        ? { ...row, state: "stopped", revokedAt }
        : row,
    );
  }
  updateConnection(command: Extract<HostApiCommand, { type: "connection.update" }>) {
    const current = this.listConnections().find((row) => row.id === command.connectionId);
    if (!current) throw mockConflict("This connected agent is no longer connected.");
    if ((current.grantRevision ?? 1) !== command.expectedRevision)
      throw mockConflict("This connected agent changed since you opened it.");
    const next = {
      ...current,
      ...(command.label !== undefined ? { label: command.label } : {}),
      ...(command.accessMode !== undefined ? { accessMode: command.accessMode } : {}),
      ...(command.grant !== undefined ? { grant: command.grant } : {}),
      grantRevision: (current.grantRevision ?? 1) + 1,
    };
    this.connections = this.connections.map((row) => (row.id === current.id ? next : row));
    return next;
  }
  acknowledgeUncertainConnection(id: string) {
    this.connections = this.connections.map((row) =>
      row.id === id && row.userId === this.snapshot.user?.id
        ? { ...row, lastActionUncertain: false, lastActionUncertainDetail: null }
        : row,
    );
  }
  removeConnection(id: string) {
    this.connections = this.connections.filter(
      (row) =>
        row.id !== id ||
        row.userId !== this.snapshot.user?.id ||
        (row.state !== "stopped" && row.state !== "expired"),
    );
  }
  readonly settings = new MockSettingsFixtures(
    () => this.emit(),
    () => ({
      devices: this.snapshot.machines.filter(
        (machine) =>
          machine.ownership !== "deployment" || machine.allowedModules.includes("agents"),
      ),
    }),
  );
  readonly enginePlugins: MockPlugins;
  /** A link the person made answers every Request waiting on that requirement. */
  private settlePluginAccount(target: PluginRequirementTarget): void {
    for (const request of Object.values(this.snapshot.requests).flat()) {
      const decision = request.presentation.plugin?.decision;
      if (
        request.status === "pending" &&
        request.kind === "plugin.account" &&
        request.presentation.plugin?.plugin.id === target.pluginId &&
        decision?.kind === "account" &&
        decision.requirement === target.requirement &&
        decision.scope === target.scope
      )
        this.settleComputerAppAccess(request, "fulfilled");
    }
  }
  private readonly plugins: MockPlugin[] = [];
  private readonly devicePlugins: MockDevicePlugin[] = [];
  /** A device plugin's declaration and setup task, as the Host derives them from its records. */
  pluginDevice(pluginId: string) {
    const device = this.devicePlugins.find(({ id }) => id === pluginId);
    return device
      ? { device: { kind: device.kind, name: device.name }, setupThreadId: device.setupThreadId }
      : null;
  }
  otherDevices() {
    return this.devicePlugins
      .filter((device) => this.plugins.some(({ id }) => id === device.id))
      .map((device) => {
        const machine = this.snapshot.machines.find(({ id }) => id === device.runnerId);
        return {
          pluginId: device.id,
          name: device.name,
          kind: device.kind,
          computer: machine ? { id: machine.id, name: machine.name, status: machine.status } : null,
          issue: device.issue,
          setupThreadId: device.setupThreadId,
        };
      });
  }
  async listPlugins(_deploymentId?: string): Promise<Record<string, unknown>[]> {
    return this.plugins.map((plugin) => ({ ...plugin, servers: [] }));
  }
  async removePlugin(pluginId: string) {
    const removed = this.integrations.installations.filter(
      ({ installation }) => installation.pluginId === pluginId,
    );
    const index = this.plugins.findIndex((plugin) => plugin.id === pluginId);
    if (index < 0 && removed.length === 0) throw new Error("Plugin not found");
    if (index >= 0) this.plugins.splice(index, 1);
    this.integrations.installations = this.integrations.installations.filter(
      (entry) => !removed.includes(entry),
    );
    for (const entry of removed)
      for (const server of entry.servers) this.enginePlugins.removeLocal(`app_server_${server.id}`);
  }
  /** The local servers whose secrets their computer's owner entered. */
  localServerSecrets() {
    return this.integrations.installations.some(
      ({ installation }) => installation.id === mockNotesServer.installationId,
    )
      ? [
          {
            computer: mockNotesServer.computer,
            id: mockNotesServer.serverId,
            installationId: mockNotesServer.installationId,
            name: "notes-search",
            plugin: mockNotesServer.title,
            secrets: [...mockNotesServer.secrets],
          },
        ]
      : [];
  }
  readonly remoteAdministrationListeners = new Set<() => void>();
  readonly connectionsListeners = new Set<() => void>();
  remoteAdministration: import("@opensteer/protocol").PersonalRemoteAdministrationStatus = {
    access: { accountLink: null, generation: 0, mode: "off", route: null, schemaVersion: 2 },
    accountIssuer: null,
    executorConnected: false,
    operation: null,
    revision: 0,
    authorityEnvelope: {
      document: {
        canonicalOrigin: "http://127.0.0.1:4310",
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { kind: "personal" },
      },
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      signature: "A".repeat(86),
    },
  };
  readonly runPlaces = new RunPlaceStore();
  readonly searchSuggestionRequests: { readonly query: string; readonly at: number }[] = [];
  computerViews: MockComputerViews | undefined;
  computerConnections() {
    return [...this.integrations.connections, ...this.#screenConnections.values()];
  }
  places: MockPlaceWorld | null = null;
  readonly #threadState = new ThreadStateProjection();
  readonly #provisionalTitles = new Set<string>();
  readonly #provisionalIcons = new Set<string>();
  readonly #recentMarkColors = new Map<string, MarkColor[]>();
  readonly #titleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  listThreadMessages(input: {
    threadId: string;
    before?: string | undefined;
    query?: string | undefined;
    aroundMessageId?: string | undefined;
    limit?: number | undefined;
  }): ThreadMessagePage {
    const records = this.publishedMessages(input.threadId);
    if (input.aroundMessageId && !records.some((message) => message.id === input.aroundMessageId))
      throw new Error("Message not found.");
    const matching = input.query
      ? records.filter((message) =>
          message.content.some(
            (part) =>
              part.type === "text" && part.text.toLowerCase().includes(input.query!.toLowerCase()),
          ),
        )
      : records;
    const anchor = input.aroundMessageId
      ? matching.findIndex((message) => message.id === input.aroundMessageId)
      : -1;
    const before = input.before ? Number(input.before) : matching.length;
    if (!Number.isInteger(before) || before < 0 || before > matching.length)
      throw new Error("Invalid message cursor.");
    const end =
      anchor >= 0 ? Math.min(matching.length, anchor + Math.ceil((input.limit ?? 50) / 2)) : before;
    const start = Math.max(0, end - (input.limit ?? 50));
    const messages = matching.slice(start, end);
    return hostApi["thread.messages.list"].success.parse({
      messages,
      threadId: input.threadId,
      window: {
        byteCount: 2,
        hasMore: start > 0,
        itemCount: messages.length,
        nextBefore: start > 0 ? String(start) : null,
        threadId: input.threadId,
        totalItems: matching.length,
      },
    });
  }

  /**
   * Every message a Thread has published, numbered as the Host numbers them:
   * a seeded message without a number of its own takes its place in line.
   */
  private publishedMessages(threadId: string): Message[] {
    if (!this.snapshot.threads.some((thread) => thread.id === threadId))
      throw new HostClientRequestError({
        code: "not_found",
        message: "Thread not found",
        status: 404,
      });
    const hidden = new Set<string>(
      (this.threadInputQueues.get(threadId) ?? []).map((item) => item.message.id),
    );
    const all = (this.snapshot.transcripts[threadId] ?? []).filter(
      (entry): entry is MessageEntry => entry.kind === "message" && !hidden.has(entry.id),
    );
    return all.flatMap((entry, index) => {
      const parsed = MessageSchema.safeParse({
        author: entry.author,
        content: [
          { text: entry.body || " ", type: "text" },
          ...(entry.attachments ?? []),
          ...(entry.pages ?? []),
          ...(entry.places ?? []),
        ],
        createdAt: entry.createdAt,
        id: entry.id,
        kind: entry.messageKind,
        ...(entry.quote ? { quote: entry.quote } : {}),
        runId: entry.runId,
        sequence: entry.sequence ?? String(index + 1),
        threadId,
      });
      return parsed.success ? [parsed.data] : [];
    });
  }

  bootstrap() {
    this.publishedSnapshot();
    return mockBootstrap(
      { ...this.snapshot, machines: this.publishedSnapshot().machines },
      this.tabCatalog.store,
      this.harnessSourceConfigs,
    );
  }

  receiveAgentInput(threadId: string, author: MessageEntry["author"], body: string): void {
    if (author.kind !== "agent") throw new Error("Only an agent's input arrives this way.");
    this.upsertEntry(threadId, {
      author,
      body,
      createdAt: this.now().toISOString(),
      id: this.nextId("message"),
      kind: "message",
      messageKind: "input",
      policy: "queue",
      runId: null,
      sequence: String(++this.sequence),
    });
  }

  applyThreadStateChanged(event: Extract<AgentEvent, { type: "thread.state-changed" }>): void {
    this.onReferenceEvent?.(event);
    const previous = this.snapshot.threads.find(({ id }) => id === event.threadId);
    this.sequence = Math.max(this.sequence, Number(event.sequence));
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === event.threadId
          ? this.#threadState.reconcile(
              {
                ...thread,
                ...event.data,
                title: event.data.title ?? thread.title,
                icon: event.data.icon === undefined ? thread.icon : event.data.icon,
                doneAt: event.data.doneAt === undefined ? thread.doneAt : event.data.doneAt,
                doneReason:
                  event.data.doneReason === undefined ? thread.doneReason : event.data.doneReason,
                latestRunCompletedAt:
                  event.data.latestRunCompletedAt === undefined
                    ? thread.latestRunCompletedAt
                    : event.data.latestRunCompletedAt,
                updatedAt: event.data.updatedAt ?? event.createdAt,
              },
              event.sequence,
              thread,
            )
          : thread,
      ),
    });
    this.#threadState.retainLoaded(this.snapshot.threads);
    const current = this.snapshot.threads.find(({ id }) => id === event.threadId);
    if (current?.title !== previous?.title || current?.icon !== previous?.icon) {
      for (const assignment of this.assignments.values()) {
        if (assignment.workerThreadId !== event.threadId) continue;
        this.publishAssignment({
          ...assignment,
          revision: assignment.revision + 1,
          updatedAt: event.createdAt,
        });
      }
    }
  }

  applyThreadCommandResult(result: HostApiCommandOutput): void {
    switch (result.type) {
      case "thread.create":
      case "thread.rename":
      case "thread.icon.set":
      case "thread.execution.update":
      case "thread.access.update":
      case "thread.inputQueue.resume":
        this.update({
          ...this.snapshot,
          threads: this.snapshot.threads.map((thread) =>
            thread.id === result.thread.id
              ? this.#threadState.reconcile(
                  {
                    ...thread,
                    ...result.thread,
                    askedAt: result.thread.askedAt ?? result.thread.createdAt,
                    icon: result.thread.icon ?? null,
                    color: result.thread.color ?? null,
                  },
                  result.asOfSequence,
                  thread,
                )
              : thread,
          ),
        });
        this.#threadState.retainLoaded(this.snapshot.threads);
    }
  }

  visitThread(threadId: string, visitedAt: string): ThreadVisit {
    if (!this.snapshot.threads.some((thread) => thread.id === threadId))
      throw new Error("Thread not found");
    const lastVisitedAt = [
      this.snapshot.threadVisits[threadId] ?? "",
      new Date(Math.min(Date.parse(visitedAt), this.now().getTime())).toISOString(),
    ]
      .sort()
      .at(-1)!;
    this.update({
      ...this.snapshot,
      threadVisits: { ...this.snapshot.threadVisits, [threadId]: lastVisitedAt },
      threads: this.snapshot.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastVisitedAt, unread: isThreadUnread({ ...thread, lastVisitedAt }) }
          : thread,
      ),
    });
    return { threadId: ThreadIdSchema.parse(threadId), lastVisitedAt };
  }

  /** The preview's stand-in for the Host's hourly pass over quiet tasks. */
  moveQuietly(threadId: string): void {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    if (!thread || thread.doneAt !== null || !this.snapshot.quietTasksAvailable) return;
    this.publishThreadName(
      { ...thread, doneAt: this.now().toISOString(), doneReason: "quiet" },
      {},
    );
  }

  async setTaskDone(threadId: string, done: boolean): Promise<ThreadSummary> {
    const thread = this.snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Task not found.");
    if (thread.purpose !== "task") throw new Error("Only tasks can be Done.");
    const affected = new Set([threadId]);
    if (done) {
      // Discover descendants before cancellation ends their assignments.
      for (let size = 0; size !== affected.size;) {
        size = affected.size;
        for (const assignment of this.assignments.values())
          if (assignment.status === "open" && affected.has(assignment.parentThreadId))
            affected.add(assignment.workerThreadId);
      }
      for (const assignment of this.assignments.values())
        if (assignment.status === "open" && affected.has(assignment.workerThreadId))
          this.cancelAssignment(assignment.id);
    }
    for (const id of affected) {
      const current = this.snapshot.threads.find((item) => item.id === id)!;
      if (done && threadStopTarget({ thread: current, runQueue: this.snapshot.runQueue }))
        await this.stopRun(id);
      if (done) {
        this.threadInputQueues.delete(id);
        for (const record of this.triggers.values())
          if (record.trigger.anchorThreadId === id && record.trigger.status === "active")
            this.setTriggerStatus(record.trigger.id, "paused");
        const at = this.now().toISOString();
        this.update(
          this.withInputQueue(
            {
              ...this.snapshot,
              requests: {
                ...this.snapshot.requests,
                [id]: (this.snapshot.requests[id] ?? []).map((request) =>
                  request.status === "pending"
                    ? {
                        ...request,
                        status: "cancelled",
                        cancellationReason: "thread-archived",
                        resolvedAt: at,
                        resolvedBy: null,
                        response: null,
                        updatedAt: at,
                      }
                    : request,
                ),
              },
            },
            id,
          ),
        );
      }
      const stopped = this.snapshot.threads.find((item) => item.id === id)!;
      this.publishThreadName(
        {
          ...stopped,
          doneAt: done ? this.now().toISOString() : null,
          doneReason: null,
          inputQueuePaused: false,
          ...(done ? { status: "idle", pendingRequests: 0 } : {}),
        },
        {},
      );
    }
    return this.snapshot.threads.find((item) => item.id === threadId)!;
  }

  private readonly attachments = new Map<
    string,
    { attachment: Attachment; bytes: Uint8Array<ArrayBuffer> | null }
  >();
  private readonly attachmentReservations = new Map<string, string>();
  private readonly threadCreations = new Map<
    string,
    { readonly request: string; readonly threadId: string }
  >();

  /** The Thread an earlier `thread.create` under this key made, or null. */
  repeatedThreadCreation(idempotencyKey: string, request: object): ThreadSummary | null {
    const prior = this.threadCreations.get(idempotencyKey);
    if (prior === undefined) return null;
    if (prior.request !== JSON.stringify(request)) {
      throw mockConflict("Thread creation changed under one key.");
    }
    return this.snapshot.threads.find(({ id }) => id === prior.threadId) ?? null;
  }

  recordThreadCreation(idempotencyKey: string, request: object, threadId: string): void {
    this.threadCreations.set(idempotencyKey, { request: JSON.stringify(request), threadId });
  }

  createAttachment(input: {
    readonly name: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly idempotencyKey: string;
  }): Attachment {
    // As the Host: no upload of an image type engines cannot read is reserved.
    if (
      input.mediaType.startsWith("image/") &&
      !(attachmentNativeImageMediaTypes as readonly string[]).includes(input.mediaType)
    )
      throw new HostClientRequestError({
        code: "conflict",
        message: `This image type (${input.mediaType}) is not supported. Use PNG, JPEG, or WebP.`,
        status: 409,
      });
    const priorId = this.attachmentReservations.get(input.idempotencyKey);
    if (priorId) {
      const prior = this.getAttachment(priorId);
      if (
        prior.name !== input.name ||
        prior.mediaType !== input.mediaType ||
        prior.sizeBytes !== input.sizeBytes
      ) {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Attachment reservation changed under one key.",
          status: 409,
        });
      }
      return prior;
    }
    const now = this.now().toISOString();
    const attachment = AttachmentSchema.parse({
      id: createId("attachment"),
      name: input.name,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      state: "uploading",
      kind: null,
      sha256: null,
      width: null,
      height: null,
      uploaderId: mockUserId,
      threadId: null,
      messageId: null,
      createdAt: now,
      expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    });
    this.attachments.set(attachment.id, { attachment, bytes: null });
    this.attachmentReservations.set(input.idempotencyKey, attachment.id);
    return attachment;
  }

  getAttachment(attachmentId: string): Attachment {
    const entry = this.attachments.get(attachmentId);
    if (!entry)
      throw new HostClientRequestError({
        code: "not_found",
        message: "Attachment not found.",
        status: 404,
      });
    return entry.attachment;
  }

  async uploadAttachment(
    attachmentId: string,
    chunks: AsyncIterable<Uint8Array> | undefined,
  ): Promise<Attachment> {
    const entry = this.attachments.get(attachmentId);
    if (!entry)
      throw new HostClientRequestError({
        code: "not_found",
        message: "Attachment not found.",
        status: 404,
      });
    if (!chunks)
      throw new HostClientRequestError({
        code: "bad_request",
        message: "Attachment bytes are missing.",
        status: 400,
      });
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      total += chunk.byteLength;
      if (total > attachmentMaxBytes)
        throw new HostClientRequestError({
          code: "bad_request",
          message: "Attachment is too large.",
          status: 400,
        });
      parts.push(chunk);
    }
    if (total !== entry.attachment.sizeBytes)
      throw new HostClientRequestError({
        code: "bad_request",
        message: "Attachment size changed.",
        status: 400,
      });
    const bytes = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const chunk of parts) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (entry.attachment.state === "ready") {
      if (digest !== entry.attachment.sha256)
        throw new HostClientRequestError({
          code: "conflict",
          message: "Attachment bytes changed on retry.",
          status: 409,
        });
      return entry.attachment;
    }
    const attachment = AttachmentSchema.parse({
      ...entry.attachment,
      sha256: digest,
      state: "ready",
      kind: entry.attachment.mediaType.startsWith("image/") ? "image" : "file",
    });
    this.attachments.set(attachmentId, { attachment, bytes });
    return attachment;
  }

  readAttachment(attachmentId: string): {
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly metadata: {
      readonly contentType: string;
      readonly etag: string;
      readonly modifiedAt: string;
      readonly sizeBytes: number;
      readonly truncated: false;
    };
  } {
    const entry = this.attachments.get(attachmentId);
    if (!entry || !entry.bytes || entry.attachment.state !== "ready")
      throw new HostClientRequestError({
        code: "not_found",
        message: "Attachment not found.",
        status: 404,
      });
    return {
      bytes: entry.bytes,
      metadata: {
        contentType: entry.attachment.mediaType,
        etag: entry.attachment.sha256 ?? "missing",
        modifiedAt: entry.attachment.createdAt,
        sizeBytes: entry.attachment.sizeBytes,
        truncated: false,
      },
    };
  }

  discardAttachment(attachmentId: string): void {
    const entry = this.attachments.get(attachmentId);
    if (!entry) return;
    if (entry.attachment.messageId)
      throw new HostClientRequestError({
        code: "conflict",
        message: "Attachment is already sent.",
        status: 409,
      });
    this.attachments.delete(attachmentId);
  }

  assertAttachmentSend(threadId: string, content: readonly ContentPart[]): void {
    const thread = this.snapshot.threads.find((item) => item.id === threadId);
    if (!thread)
      throw new HostClientRequestError({
        code: "not_found",
        message: "Thread not found.",
        status: 404,
      });
    for (const part of content) {
      if (part.type !== "artifact") continue;
      const attachment = this.getAttachment(part.artifactId);
      const previous = attachment.messageId
        ? this.withdrawnThreadInputs.get(attachment.messageId)
        : undefined;
      const canRebind =
        previous?.threadId === threadId &&
        attachment.threadId === threadId &&
        attachment.uploaderId === mockUserId &&
        previous.policy === "queue" &&
        previous.state === "cancelled" &&
        previous.cancelReason === "withdrawn" &&
        previous.deliveredAt === null &&
        previous.runId === null;
      if (
        attachment.state !== "ready" ||
        (attachment.messageId !== null && !canRebind) ||
        attachment.name !== part.name ||
        attachment.mediaType !== part.mediaType ||
        (part.sizeBytes !== undefined && attachment.sizeBytes !== part.sizeBytes)
      ) {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Attachment is unavailable for this thread.",
          status: 409,
        });
      }
    }
  }

  bindAttachments(content: readonly ContentPart[], threadId: string, messageId: string): void {
    for (const part of content) {
      if (part.type !== "artifact") continue;
      const entry = this.attachments.get(part.artifactId);
      if (entry)
        this.attachments.set(part.artifactId, {
          ...entry,
          attachment: AttachmentSchema.parse({ ...entry.attachment, threadId, messageId }),
        });
    }
  }
  private readonly computerAppSetupRequests = new Map<string, DeviceComputerAppSetupRequest>();
  private readonly referenceRequests = new Map<string, Request>();
  referenceRequest(requestId: string): Request | undefined {
    return (
      Object.values(this.snapshot.requests)
        .flat()
        .find((request) => request.id === requestId) ?? this.referenceRequests.get(requestId)
    );
  }
  private referenceRequestReceipt(request: Exclude<Request, { status: "pending" }>) {
    this.referenceRequests.set(request.id, request);
    const whole = requestReceipt(request);
    // As the Host's card carries it: cut to fit, the whole left to a read of the Request.
    const receipt = whole.question
      ? { ...whole, question: answeredQuestionWithin(whole.question, answeredQuestionPreviewBytes) }
      : whole;
    keepMockReceiptAsker(receipt, request);
    return receipt;
  }
  /** Enrollments retired here, which the preview, like the Host, keeps no row for. */
  private readonly retiredEnrollments = new Set<string>();
  private readonly phoneEnrollments = new Map<
    string,
    {
      readonly name: string;
      readonly profile: "iphone" | null;
      readonly access: import("@opensteer/protocol").DeviceInitialAccess | undefined;
      readonly result: {
        readonly enrollmentId: string;
        readonly expiresAt: string;
        readonly pairing: typeof mockAgentPhonePairingTarget;
        readonly token: string;
      };
    }
  >();

  private readonly activeRuns = new Map<string, ActiveMockRun>();
  private readonly integrations = createInitialIntegrationState(mockUserId);
  readonly chrome: MockChromeSignIns;
  private readonly nextRunOrdinals = new Map<string, number>();
  /** Queued messages per Thread in send order; a Run's seed is never here. */
  private readonly threadInputQueues = new Map<string, PendingMockInput[]>();
  /**
   * Each waiting message's edit lease by message id. `here` marks a lease
   * this client took, as opposed to one a scripted other device holds.
   */
  private readonly editLeases = new Map<
    string,
    { readonly here: boolean; readonly view: ThreadInputEditLeaseView }
  >();
  /** Each edited message's versions, oldest first; the original is kept on the first edit. */
  private readonly messageRevisions = new Map<string, MessageRevisionView[]>();
  /** A saved edit per idempotency key, replayed when the same edit is sent again. */
  private readonly editReceipts = new Map<
    string,
    { readonly edit: MessageEdit; readonly fingerprint: string; readonly message: Message }
  >();
  private readonly withdrawnThreadInputs = new Map<string, ThreadInput>();
  private readonly triggers = new Map<string, MockTriggerRecord>();
  /**
   * What each account's source fields were filled in with. Only a source that
   * declares fields has any, which is why the compatible endpoint is the one
   * seeded entry.
   */
  readonly harnessSourceConfigs = new Map<string, Readonly<Record<string, string>>>([
    [mockOpenRouterHarnessInstanceId, { baseUrl: "https://openrouter.ai/api/v1" }],
  ]);
  private readonly harnessSignIns = new Map<
    string,
    { readonly startedAt: number; readonly method: HarnessSetupMethod }
  >();
  private readonly latencyMs: number;
  private readonly replies: "scripted" | "brief";
  private readonly listeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(notification: NotificationView) => void>();
  private readonly assignments = new Map<string, AssignmentView>();
  private readonly assignmentModels = new Map<
    string,
    { readonly modelSelection: ModelSelection; readonly parentModelSelection: ModelSelection }
  >();

  private readonly taskScripts = new Map<string, MockTaskScript>();
  private readonly now: () => Date;
  private sequence = 10;
  /** The sessions this client can see, until it revokes them. */
  private sessions: AuthSessionSummary[];
  private snapshot: HostSnapshot;
  #published: PublicHostSnapshot | null = null;
  readonly #deviceViews = new WeakMap<MachineSummary[], MachineSummary[]>();
  #pendingBrowserNotification: ReturnType<typeof setTimeout> | null = null;
  readonly tabCatalog = new MockTabCatalog();
  /** The person's published apps, as the mock Host keeps them. */
  apps: App[] = [];
  publishedSnapshot(): PublicHostSnapshot {
    if (!this.#published) this.publishBrowser();
    return this.#published!;
  }
  refreshBrowserView(): void {
    this.emit();
  }
  private publishBrowser(): void {
    this.tabCatalog.publish(this.snapshot);
    const { browserGroups: _groups, ...published } = withPublishedReplies(
      this.#published,
      this.snapshot,
    );
    let machines = this.#deviceViews.get(published.machines);
    if (!machines) {
      machines = published.machines.map((machine) =>
        machine.capabilities === undefined &&
        machine.ownership === "deployment" &&
        !machine.allowedModules.includes("agents")
          ? machine
          : mockDeviceMachine(machine),
      );

      this.#deviceViews.set(published.machines, machines);
    }
    this.#published = { ...published, machines, tabs: this.tabCatalog.store };
  }

  constructor(options: MockHostClientOptions = {}) {
    this.enginePlugins = new MockPlugins({
      changed: (change) => {
        for (const listener of this.settings.listeners)
          listener({ type: "host.plugins-changed", ...change });
      },
      accountLinked: (target) => this.settlePluginAccount(target),
      ...(options.plugins ? { scenario: options.plugins } : {}),
    });
    this.tabCatalog.bind(
      () => this.snapshot,
      () => this.apps,
    );
    this.automaticModels = options.automaticModels ?? "seeded";
    if (this.automaticModels === "edited") {
      this.agentHomeSettings = {
        backgroundModels: {
          deep: [
            { engine: HarnessIdSchema.parse("codex"), model: ModelIdSchema.parse("gpt-6.1-sol") },
          ],
        },
      };
      this.agentHomeSettingsFile = { status: "valid" };
    }
    if (this.automaticModels === "excluded") {
      this.agentHomeSettings = {
        backgroundModels: {
          excludedAccounts: [HarnessInstanceIdSchema.parse(mockClaudeHarnessInstanceId)],
        },
      };
      this.agentHomeSettingsFile = { status: "valid" };
    }
    if (this.automaticModels === "invalid")
      this.agentHomeSettingsFile = {
        status: "invalid",
        error: {
          path: "/Users/you/Opensteer/settings.json",
          line: 4,
          column: 3,
          message: "Expected double-quoted property name",
        },
      };
    this.connections = [...(options.connections ?? [])];
    this.pendingConnectionConsent = options.connectionConsent ?? null;
    this.chromeTabs = options.chromeTabs ?? {};
    this.workPolicy = options.workPolicy ?? null;
    this.#consentChange = options.connectionConsentChange ?? null;
    for (const p of options.agentPlugins ?? []) {
      const id = crypto.randomUUID();
      const at = new Date(0).toISOString();
      this.plugins.push({
        id: p.id,
        name: p.name,
        scope: "folder",
        source: { folderDirectory: `plugins/${p.name}` },
        currentVersionId: id,
        versions: [{ id, digest: id, manifest: { name: p.name, skills: [{}] } }],
        enabled: true,
        createdAt: at,
        updatedAt: at,
      });
    }
    this.sessions = [
      ...(options.sessions ?? [
        {
          absoluteExpiresAt: "2026-10-14T00:00:00.000Z",
          createdAt: "2026-09-14T00:00:00.000Z",
          current: true,
          deviceId: "rnr_33333333-3333-4333-8333-333333333333",
          deviceLabel: "Opensteer for Mac",
          expiresAt: "2026-09-21T00:00:00.000Z",
          form: "computer",
          id: createId("authSession"),
          lastSeenAt: "2026-09-14T00:00:00.000Z",
        },
        // A web tab, and an older iPhone app that signed in before devices bound sessions.
        ...(
          [
            ["Chrome on Mac", "computer"],
            ["Opensteer for iPhone", "mobile"],
          ] as const
        ).map(([deviceLabel, form]) => ({
          absoluteExpiresAt: "2026-10-14T00:00:00.000Z",
          createdAt: "2026-09-14T00:00:00.000Z",
          current: false,
          deviceLabel,
          deviceId: null,
          expiresAt: "2026-09-21T00:00:00.000Z",
          form,
          id: createId("authSession"),
          lastSeenAt: "2026-09-14T00:00:00.000Z",
        })),
      ]),
    ];
    this.grantsAvailable = options.grantsAvailable ?? true;
    this.latencyMs = options.latencyMs ?? 420;
    this.replies = options.replies ?? "scripted";
    this.now = options.now ?? (() => new Date());
    this.chrome = new MockChromeSignIns(this.now);
    const initial = {
      ...seedMockTaskMarks(createInitialSnapshot(this.tabCatalog.store)),

      quietTasksAvailable: options.quietTasksAvailable ?? true,
      agentImagesAvailable: options.agentImagesAvailable ?? true,
    };
    if (options.portalOrigin && initial.identityConfig)
      initial.identityConfig = { ...initial.identityConfig, portalOrigin: options.portalOrigin };
    if (options.exposure && initial.identityConfig)
      initial.identityConfig = {
        ...initial.identityConfig,
        exposure: options.exposure,
        homeKind: options.exposure === "networked" ? "server" : "mac",
        ...(options.exposure === "networked"
          ? { publicOrigin: "https://opensteer.example.com" }
          : {}),
      };
    const firstRun = options.world === "first-run";
    this.snapshot = {
      ...(firstRun ? firstRunWorld(initial) : initial),
      effectiveWorkPolicy: this.workPolicy,
    };
    this.applyAutomaticEligibility();
    for (const thread of this.snapshot.threads) {
      if (thread.icon === null && thread.purpose === "task") this.#provisionalIcons.add(thread.id);
    }
    const anchorThread = this.snapshot.threads.find(
      (thread) => thread.listed && thread.purpose === "task",
    );
    const workThread = this.snapshot.threads.find(({ id }) => id === mockstorageThreadId);
    if (options.automations !== "absent" && anchorThread && workThread) {
      for (const record of seedMockAutomations({
        anchorThread,
        now: this.now(),
        userId: mockUserId,
        workThread,
      })) {
        this.triggers.set(record.trigger.id, record);
      }
    }
    if (options.memoryPasses && this.snapshot.personalSettings) {
      for (const systemRole of ["memory-light", "memory-nightly"] as const) {
        const worker: ThreadSummary = {
          ...initial.threads[0]!,
          id: createId("thread"),
          title: systemRole === "memory-light" ? "Memory light pass" : "Memory nightly pass",
          purpose: "background-job",
          listed: false,
          parentThreadId: null,
          status: "idle",
          pendingRequests: 0,
          doneAt: null,
          doneReason: null,
          inputQueuePaused: false,
        };
        this.snapshot = { ...this.snapshot, threads: [...this.snapshot.threads, worker] };
        const created = this.createTrigger({
          anchorThreadId: ThreadIdSchema.parse(worker.id),
          name: worker.title,
          program: {
            language: "typescript",
            toolContractVersion: 5,
            source: "export default async () => null",
          },
          source: {
            kind: "schedule",
            schedule: {
              kind: "cron",
              expression: systemRole === "memory-light" ? "*/30 8-22 * * *" : "0 3 * * *",
              timezone: "America/New_York",
            },
          },
        });
        const record = this.getTrigger(created.trigger.id);
        this.triggers.set(record.trigger.id, {
          ...record,
          trigger: {
            ...record.trigger,
            systemRole,
            ...(options.memoryPasses === "off"
              ? {
                  status: "paused",
                  pauseReason: "Memory is off at your request.",
                  nextFireAt: null,
                }
              : {}),
            ...(options.memoryPasses === "waiting-for-model"
              ? { waitingReason: "Waiting for an eligible AI account on the hosting computer." }
              : {}),
          },
        });
      }
    }
    // The setup request behind the seeded Numbers Request, dated from this
    // client's clock so it is pending for as long as a real one would be.
    if (!firstRun)
      this.computerAppSetupRequests.set(mockComputerUseSetupRequestId, {
        access: "read-write",
        app: mockComputerUseApps.numbers,
        createdAt: this.now().toISOString(),
        definitionDigest: "mock-definition",
        definitionId: mockComputerUseDefinition.id,
        deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
        expiresAt: new Date(this.now().getTime() + 7 * 86400000).toISOString(),
        id: mockComputerUseSetupRequestId,
        kind: "app",
        ownerUserId: mockUserId,
        policyAppApproval: null,
        reason: mockComputerUseReason,
        deviceId: DeviceIdSchema.parse(mockMessagesRunnerId),
        server: null,
        threadId: ThreadIdSchema.parse(mockComputerUseThreadId),
        threadTitle: "Build the new architecture",
      });
    const pendingRequests = [...(options.pendingRequests ?? [])];
    if (options.devices === "seeded" && !firstRun) {
      pendingRequests.push(...this.seedDevices());
    }
    // A task's computer access Request always stands on its setup request,
    // which the computer — a Mac or a phone — is the one to answer.
    for (const request of pendingRequests) {
      const { payload } = request;
      if (payload.kind !== "computer.app.access") continue;
      if (this.computerAppSetupRequests.has(payload.setupRequestId)) continue;
      this.computerAppSetupRequests.set(payload.setupRequestId, {
        access: payload.access,
        app: payload.app,
        createdAt: this.now().toISOString(),
        definitionDigest: "mock-definition",
        definitionId: payload.definitionId,
        deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
        expiresAt: new Date(this.now().getTime() + 7 * 86400000).toISOString(),
        id: payload.setupRequestId,
        kind: "app",
        ownerUserId: mockUserId,
        policyAppApproval: null,
        reason: payload.reason,
        deviceId: payload.deviceId,
        server: null,
        threadId: ThreadIdSchema.parse(request.originatingThreadId),
        threadTitle: null,
      });
    }
    if (pendingRequests.length) {
      const additions = new Map<string, Request[]>();
      for (const request of pendingRequests) {
        const pending = additions.get(request.originatingThreadId) ?? [];
        pending.push(request);
        additions.set(request.originatingThreadId, pending);
      }
      this.snapshot = {
        ...this.snapshot,
        requests: Object.fromEntries(
          [...new Set([...Object.keys(this.snapshot.requests), ...additions.keys()])].map(
            (threadId) => [
              threadId,
              [...(this.snapshot.requests[threadId] ?? []), ...(additions.get(threadId) ?? [])],
            ],
          ),
        ),
        threads: this.snapshot.threads.map((thread) => ({
          ...thread,
          pendingRequests: thread.pendingRequests + (additions.get(thread.id)?.length ?? 0),
        })),
      };
    }
    if (
      !firstRun &&
      options.subagents !== undefined &&
      options.subagents !== "seeded" &&
      options.subagents !== "absent"
    ) {
      const fixture = seedMockSubagentScene(this.snapshot, options.subagents, this.now());
      this.snapshot = fixture.snapshot;
      this.nodeEvents = fixture.events;
    } else if (!firstRun && options.subagents !== "absent") {
      const fixture = seedMockSubagents(this.snapshot);
      this.snapshot = fixture.snapshot;
      this.nodeEvents = fixture.events;
      for (const assignment of [fixture.assignment, fixture.openAssignment]) {
        this.assignments.set(assignment.id, assignment);
        const worker = this.snapshot.threads.find(
          (thread) => thread.id === assignment.workerThreadId,
        )!;
        const parent = this.snapshot.threads.find(
          (thread) => thread.id === assignment.parentThreadId,
        )!;
        this.assignmentModels.set(assignment.id, {
          modelSelection: worker.modelSelection,
          parentModelSelection: parent.modelSelection,
        });
      }
    }
    for (const run of this.snapshot.runQueue) {
      this.nextRunOrdinals.set(
        run.threadId,
        Math.max(this.nextRunOrdinals.get(run.threadId) ?? 0, run.runOrdinal + 1),
      );
      if (run.status !== "queued") {
        this.activeRuns.set(run.threadId, {
          cancelled: false,
          id: run.id,
          joined: [],
          person: this.seededPersonRun(run),
          steered: [],
        });
      }
    }
    // The rendered transcript and messages API must name the same published
    // positions: opening a seeded result can only mark what was actually seen.
    this.snapshot = {
      ...this.snapshot,
      transcripts: Object.fromEntries(
        Object.entries(this.snapshot.transcripts).map(([threadId, entries]) => {
          const messages = new Map<string, Message>(
            this.publishedMessages(threadId).map((message) => [message.id, message]),
          );
          return [
            threadId,
            entries.map((entry) => {
              const message = entry.kind === "message" ? messages.get(entry.id) : undefined;
              return message ? { ...entry, sequence: message.sequence } : entry;
            }),
          ];
        }),
      ),
    };
    this.snapshot = {
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) => ({
        ...thread,
        latestRunCompletedAt: ["running", "waiting"].includes(thread.status)
          ? null
          : thread.updatedAt,
        lastVisitedAt: thread.unread ? null : thread.updatedAt,
      })),
      waitingRequests: this.waitingRequests(),
    };
    this.snapshot = {
      ...this.snapshot,
      threadVisits: Object.fromEntries(
        this.snapshot.threads.flatMap((thread) =>
          thread.lastVisitedAt ? [[thread.id, thread.lastVisitedAt]] : [],
        ),
      ),
    };
    const tasks = this.taskList(null);
    this.snapshot = { ...this.snapshot, tasks, activeTasks: this.activeTaskEntries(tasks) };
    this.snapshot = {
      ...this.snapshot,
      needsYou: mockNeedsYou(this.snapshot, undefined, this.needsYouLimit),
    };
    if (!firstRun && options.iphoneScreen !== "absent")
      this.setIphoneScreenState(
        options.iphoneScreen ?? "ready",
        options.iphoneScreenHolding ?? false,
      );
  }

  private readonly acceptedCommands = new Map<
    string,
    { command: string; result: ReturnType<typeof executeMockCommand> }
  >();
  async executeCommandOnce(input: HostApiCommand): ReturnType<typeof executeMockCommand> {
    const command = clientCommandSchema.parse(input);
    if (command.type === "machine.access.update" && "deviceId" in command) {
      const revision = await this.updateMachineAccess(
        command.deviceId,
        command.policy,
        command.expectedRevision,
      );
      return rpcSuccess(
        revision === null
          ? { type: command.type, outcome: "conflict" as const }
          : { type: command.type, outcome: "updated" as const, revision },
      );
    }
    if (command.type === "integration.computer.setup.request" && "deviceId" in command.input) {
      const { deviceId, ...input } = command.input;
      const machine = this.snapshot.machines.find(({ id }) => id === deviceId);
      const self = machine ? mockDeviceMachine(machine).selfRunnerId : null;
      if (!self || (input.kind === "app" && isPhoneDisplayDefinitionId(input.definitionId)))
        throw mockBadRequest("Allow phone access from any Opensteer app.");
      return rpcSuccess({
        type: command.type,
        request: this.requestComputerAppSetup({ ...input, runnerId: self }),
      });
    }
    if (command.type === "integration.computer.setup.set" && "deviceId" in command.input) {
      const { deviceId, ...input } = command.input;
      const machine = this.snapshot.machines.find(({ id }) => id === deviceId);
      if (!machine) throw mockNotFound("Device not found.");
      const selfRunnerId = mockDeviceMachine(machine).selfRunnerId;
      if (
        !selfRunnerId &&
        (input.definitionId !== machine.phoneDisplay?.definitionId || input.app !== null)
      )
        throw mockBadRequest("That is not this Device’s phone display.");
      const connection = selfRunnerId
        ? await this.setComputerAppConnection({ ...input, runnerId: selfRunnerId })
        : this.setScreenAccess(deviceId, input.access);
      return rpcSuccess({ type: command.type, connection } as RpcData<"commands.dispatch">);
    }
    if (
      command.type !== "settings.plugin.enabled.set" &&
      command.type !== "thread.sendMessage" &&
      command.type !== "thread.icon.set" &&
      command.type !== "harness.create"
    )
      return executeMockCommand(this, hostApi["commands.dispatch"].payload.parse(command));
    const key = `${this.snapshot.user?.id ?? mockUserId}:${command.idempotencyKey}`;
    const serialized = JSON.stringify(command);
    const previous = this.acceptedCommands.get(key);
    if (previous) {
      if (previous.command !== serialized)
        return Promise.resolve(
          mockRefusal(
            new HostClientRequestError({
              code: "conflict",
              message: "A retry must keep its accepted content.",
              status: 409,
            }),
          ),
        );
      return previous.result.then((result) => {
        if (!result.ok) return result;
        switch (result.data.type) {
          case "thread.sendMessage":
            return rpcSuccess({ ...result.data, wasDuplicate: true });
          case "thread.icon.set": {
            const threadId = result.data.thread.id;
            const thread = this.snapshot.threads.find(({ id }) => id === threadId);
            if (!thread) throw new Error("Thread not found.");
            return rpcSuccess({
              type: "thread.icon.set" as const,
              thread: mockThread(thread),
              asOfSequence: SequenceSchema.parse(String(this.snapshot.revision)),
            });
          }
        }
        return result;
      });
    }
    const result = executeMockCommand(this, command);
    this.acceptedCommands.set(key, { command: serialized, result });
    void result.then(
      (result) => {
        if (!result.ok) this.acceptedCommands.delete(key);
      },
      () => this.acceptedCommands.delete(key),
    );
    return result;
  }
  nowIso(): string {
    return this.now().toISOString();
  }
  seedPlaces(world: MockPlacesWorld = "seeded"): void {
    this.update(seedMockPlaces(this.snapshot, this.now(), world));
    this.#seedTabs(world);
    this.#recentMarkColors.delete(`${this.snapshot.user?.id ?? mockUserId}:thread`);
    const template = this.integrations.connections.find(
      (connection) => connection.definitionId === "macos-app" && connection.status === "connected",
    );
    const studio = this.snapshot.machines.find((machine) => machine.name === "Studio Mac");
    if (template?.computer && studio)
      this.integrations.connections.push({
        ...template,
        id: createIntegrationId("connection"),
        displayName: "Keynote on Studio Mac",
        computer: {
          ...template.computer,
          runnerId: RunnerIdSchema.parse(studio.id),
          app: { bundleId: "com.apple.Keynote", displayName: "Keynote", teamId: null },
        },
      });

    // The busy world's Mac mini has more approved apps than its row shows at once.
    if (world !== "seeded" && template?.computer)
      for (const [bundleId, displayName] of [
        ["com.apple.iWork.Numbers", "Numbers"],
        ["com.apple.mail", "Mail"],
        ["com.apple.Safari", "Safari"],
        ["com.apple.reminders", "Reminders"],
        ["com.apple.iWork.Pages", "Pages"],
      ] as const)
        this.integrations.connections.push({
          ...template,
          id: createIntegrationId("connection"),
          displayName: `${displayName} on ${template.computer.runnerId === studio?.id ? "Studio Mac" : "Mac mini"}`,
          computer: { ...template.computer, app: { bundleId, displayName, teamId: null } },
        });
  }
  /**
   * One person's mixed workspace: a group holding a page, a Mac window, the
   * Agent Phone and an app, beside a closed window and a stopped app.
   */
  #seedTabs(world: MockPlacesWorld): void {
    const home = this.snapshot.machines.find((machine) => machine.id === mockMessagesRunnerId);
    const thread = this.snapshot.threads[0]?.id ?? null;
    this.apps = seedMockApps({ computerId: mockMessagesRunnerId, taskId: thread, now: this.now() });
    this.emit();
    if (!home) return;
    const at = this.now().toISOString();
    const native = (
      key: string,
      tab: Omit<Parameters<MockTabCatalog["addNative"]>[0], "tabId" | "createdAt" | "openedBy">,
    ) => {
      const tabId = TabIdSchema.parse(`tab_00000000-0000-4000-8000-0000000002${key}`);
      this.tabCatalog.addNative({ tabId, createdAt: at, openedBy: "person", ...tab });
      return tabId;
    };
    // A window of an app this Mac approved, so the person can open it.
    const notes = native("01", {
      kind: "window",
      computerId: home.id,
      title: "Launch plan",
      appName: "Notes",
      bundleId: "com.apple.Notes",
    });
    const phone = this.snapshot.machines.some((machine) => machine.id === mockAgentPhoneRunnerId)
      ? native("02", { kind: "phone", computerId: mockAgentPhoneRunnerId, title: "Pixel 7" })
      : null;
    const ferry = native("03", {
      kind: "app",
      computerId: home.id,
      title: this.apps[1]!.name,
      appId: this.apps[1]!.appId,
    });
    native("04", {
      kind: "window",
      computerId: home.id,
      title: "Old draft",
      appName: "Pages",
      bundleId: "com.apple.iWork.Pages",
      closedWindow: true,
    });
    native("05", {
      kind: "app",
      computerId: home.id,
      title: this.apps[2]!.name,
      appId: this.apps[2]!.appId,
    });
    this.emit();
    const firstPage = tabPlaceList(this.publishedSnapshot()).find((place) => place.kind === "page");
    this.tabCatalog.group(
      world === "seeded" ? "Launch prep" : "Lisbon trip",
      "cyan",
      [firstPage?.key, notes, phone, ferry].filter((id): id is TabId => !!id),
    );
    this.emit();
  }
  updatePlaces(snapshot: HostSnapshot): void {
    this.update(snapshot);
  }

  updateHarnessInstallation(environmentId: string, driverKind: string) {
    let installation: HarnessInstallation | undefined;
    this.update({
      ...this.snapshot,
      environments: this.snapshot.environments.map((environment) =>
        environment.id !== environmentId
          ? environment
          : {
              ...environment,
              harnessDrivers: environment.harnessDrivers.map((driver) => {
                if (driver.driverKind !== driverKind || !driver.installation) return driver;
                installation = {
                  ...driver.installation,
                  detail: "Update finished.",
                  latestVersion: driver.installation.latestVersion ?? driver.installation.version,
                  update: "succeeded",
                };
                return { ...driver, installation };
              }),
            },
      ),
    });
    if (!installation) throw new Error("Installed AI engine not found.");
    return installation;
  }
  readonly getSnapshot = (): HostSnapshot => this.snapshot;

  /**
   * As the Host projects a helper's report: the Mac's task sessions and the
   * person's views stay while it asks for permission or is unavailable; only
   * readiness and its permissions change.
   */
  setComputerUseReadiness(
    machineId: string,
    state: "ready" | "permission-required" | "unavailable",
  ): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === machineId && machine.computerUse
          ? {
              ...machine,
              computerUse: {
                ...machine.computerUse,
                detail: null,
                permissions:
                  state === "unavailable"
                    ? null
                    : {
                        accessibility: "granted",
                        screenRecording: state === "ready" ? "granted" : "denied",
                      },
                state,
              },
            }
          : machine,
      ),
    });
  }

  mockMessageBody(threadId: string, messageId: string, body: string): void {
    const entry = this.snapshot.transcripts[threadId]?.find(({ id }) => id === messageId);
    if (entry?.kind !== "message") throw new Error("No such message.");
    this.replaceEntryById(threadId, messageId, { ...entry, body });
  }

  stopAgentSession(threadId: string, sessionId: string): boolean {
    const slot = this.snapshot.threads.find(({ id }) => id === threadId)?.externalWork;
    if (!slot || slot.sessionId !== sessionId || slot.status === "ended") return false;
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: "idle",
              agentSessionId: null,
              pendingRequests: 0,
              externalWork: { ...slot, status: "ended", endReason: "stopped" },
            }
          : thread,
      ),
      requests: {
        ...this.snapshot.requests,
        [threadId]: (this.snapshot.requests[threadId] ?? []).map((request) =>
          request.status === "pending"
            ? ({
                ...request,
                status: "withdrawn",
                resolvedAt: this.now().toISOString(),
              } as unknown as typeof request)
            : request,
        ),
      },
    });
    return true;
  }

  mockAgentWork(
    options: {
      readonly long?: boolean;
      readonly question?: boolean;
      readonly questionChoices?: readonly string[];
    } = {},
  ): void {
    const template = this.snapshot.threads.find(({ purpose }) => purpose === "task");
    const user = this.snapshot.user;
    if (!template || !user) throw new Error("No task to copy.");
    const seed = mockAgentWork({
      now: this.now(),
      userId: user.id,
      template,
      connections: this.connections,
      ...(options.long ? { long: true } : {}),
      ...(options.question ? { question: true } : {}),
      ...(options.questionChoices ? { questionChoices: options.questionChoices } : {}),
    });
    this.#agentOperations = seed.operations;
    this.connections = this.connections.map((connection) =>
      connection.label === "ChatGPT"
        ? {
            ...connection,
            verificationWithdrawnAt: new Date(this.now().getTime() - 3 * 86_400_000).toISOString(),
          }
        : connection,
    );
    this.tabCatalog.markSharedFromChrome(TabIdSchema.parse("mock-tab-0-0"));
    const at = this.now().toISOString();
    // The working agent uses a tab of its own; the waiting one, a tab the person shares.
    const placed: Readonly<Record<string, string>> = {
      "mock-tab-1-0": mockAgentWorkThreads.working,
      "mock-tab-0-0": mockAgentWorkThreads.waiting,
    };
    const browserSessions = this.snapshot.browserSessions.map((session) => {
      if (!session.catalog?.tabs.some(({ id }) => id in placed)) return session;
      const tabs = session.catalog.tabs.map((tab) =>
        tab.id in placed
          ? {
              ...tab,
              occupants: [
                {
                  threadId: ThreadIdSchema.parse(placed[tab.id]!),
                  holding: true,
                  acting: placed[tab.id] === mockAgentWorkThreads.working,
                  lastActiveAt: at,
                },
              ],
            }
          : tab,
      );
      return {
        ...session,
        catalog: { ...session.catalog, tabs },
        threadIds: [...new Set(tabs.flatMap(({ occupants }) => occupants.map((o) => o.threadId)))],
      };
    });
    this.update({
      ...this.snapshot,
      threads: [...this.snapshot.threads, ...seed.threads],
      requests: { ...this.snapshot.requests, ...seed.requests } as typeof this.snapshot.requests,
      browserSessions,
    });
  }

  applyWorkPolicy(
    policy: import("@opensteer/control-plane-protocol").EffectiveWorkPolicy | null,
  ): void {
    this.workPolicy = policy;
    this.update({ ...this.snapshot, effectiveWorkPolicy: policy });
  }

  mockDeviceStates(): void {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.name === "Studio iMac"
          ? { ...machine, status: "offline", asleepSince: since, lastSeenAt: since }
          : machine.name === "Studio Mac"
            ? { ...machine, status: "needs-update" }
            : machine,
      ),
    });
  }

  mockAsleepStep(): void {
    const machine = this.snapshot.machines.find(
      ({ kind, name }) => kind === "computer" && name === "Alex's MacBook Pro",
    );
    const threadId = Object.keys(this.snapshot.transcripts).find((id) =>
      this.snapshot.transcripts[id]?.some(
        (entry) => entry.kind === "tool" && entry.callId === "computer-code",
      ),
    );
    const entries = threadId ? this.snapshot.transcripts[threadId] : undefined;
    if (!machine || !threadId || !entries) throw new Error("No computer-use task to refuse.");
    const code = entries.find(
      (entry): entry is ToolEntry => entry.kind === "tool" && entry.callId === "computer-code",
    )!;
    const refused: ToolEntry = {
      ...code,
      id: `tool:${code.runId}:computer-asleep`,
      callId: "computer-asleep",
      arguments: { computerId: machine.id, code: "await app('Messages').window().observe();" },
      isError: true,
      state: "failed",
      output: {
        text: JSON.stringify({
          error: {
            code: "computer_asleep",
            message: `${machine.name} is asleep.`,
            next: "It will work again when it wakes; other work can continue.",
          },
        }),
      },
    };
    const at = entries.indexOf(code) + 1;
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [threadId]: [...entries.slice(0, at), refused, ...entries.slice(at)],
      },
    });
  }

  mockLongThread(turns: number): string {
    const template = this.snapshot.threads.find(({ purpose }) => purpose === "task");
    if (!template) throw new Error("No task to copy.");
    const threadId = createId("thread");
    const start = Date.parse("2026-06-01T09:00:00.000Z");
    const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
    const entries: TranscriptEntry[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const runId = createId("run");
      const replyId = createId("message");
      entries.push(
        {
          author: mockHumanAuthor(),
          body: `Question ${turn}: what changed in step ${turn}?`,
          createdAt: at(turn * 3),
          id: createId("message"),
          kind: "message",
          messageKind: "input",
          runId: null,
        },
        {
          createdAt: at(turn * 3),
          error: null,
          id: `run:${runId}`,
          kind: "run",
          replyMessageId: replyId,
          runId,
          status: "completed",
        },
        {
          arguments: { command: `git log --oneline -n ${turn + 1}` },
          callId: `call_long_${turn}`,
          completedAt: at(turn * 3 + 1),
          createdAt: at(turn * 3 + 1),
          id: `tool:${runId}:call_long_${turn}`,
          integration: null,
          isError: false,
          kind: "tool",
          output: { text: `Output of step ${turn}\n`.repeat(1 + (turn % 4)) },
          runId,
          state: "done",
          streamText: "",
          tool: { name: "shell", namespace: "codex" },
        },
        {
          author: mockAgentAuthor(runId, threadId),
          body:
            `Reply ${turn}. ` +
            "Step ".repeat(1 + (turn % 7) * 12) +
            (turn % 5 === 0 ? `\n\nA longer paragraph for reply ${turn}.` : ""),
          createdAt: at(turn * 3 + 2),
          id: replyId,
          kind: "message",
          messageKind: "assistant",
          runId,
        },
      );
    }
    const messages = entries.filter(({ kind }) => kind === "message").length;
    this.update({
      ...this.snapshot,
      threads: [
        ...this.snapshot.threads,
        {
          ...template,
          createdAt: at(0),
          icon: null,
          id: threadId,
          parentThreadId: null,
          pendingRequests: 0,
          status: "idle",
          title: "A long conversation",
          unread: false,
          updatedAt: at(turns * 3),
        },
      ],
      transcripts: { ...this.snapshot.transcripts, [threadId]: entries },
      transcriptWindows: {
        ...this.snapshot.transcriptWindows,
        [threadId]: {
          byteCount: 2,
          hasMore: false,
          itemCount: messages,
          nextBefore: null,
          threadId,
          totalItems: messages,
        },
      },
    });
    return threadId;
  }

  mockSubagentProgress(threadId: string, nodeId: string, progress: string): void {
    const entries = this.snapshot.transcripts[threadId] ?? [];
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [threadId]: entries.map((entry) =>
          entry.kind === "node" && entry.nodeId === nodeId && entry.status === "running"
            ? { ...entry, progress }
            : entry,
        ),
      },
    });
  }

  /** As the Host hears a computer go and come back: its status alone changes. */
  setMachineStatus(machineId: string, status: MachineSummary["status"]): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === machineId ? { ...machine, status } : machine,
      ),
    });
  }

  setMachineIntegrationReadiness(
    machineId: string,
    readiness: NonNullable<MachineSummary["modules"]["integrations"]>["readiness"],
  ): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === machineId && machine.modules.integrations
          ? {
              ...machine,
              modules: {
                ...machine.modules,
                integrations: { ...machine.modules.integrations, readiness },
              },
            }
          : machine,
      ),
    });
  }

  setEnvironmentConnected(environmentId: string, connected: boolean): void {
    this.update({
      ...this.snapshot,
      environments: this.snapshot.environments.map((environment) =>
        environment.id === environmentId
          ? { ...environment, connected, status: connected ? "connected" : "disconnected" }
          : environment,
      ),
    });
  }

  getAssignment(assignmentId: string): AssignmentView {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment)
      throw new HostClientRequestError({
        code: "not_found",
        message: "Task not found.",
        status: 404,
      });
    const worker = this.snapshot.threads.find(({ id }) => id === assignment.workerThreadId);
    if (!worker)
      throw new HostClientRequestError({
        code: "forbidden",
        message: "You no longer have access to this task.",
        status: 403,
      });
    return assignment;
  }

  listThreadAssignments(threadId: string): AssignmentSummary[] {
    return [...this.assignments.values()]
      .filter(
        (assignment) =>
          assignment.workerThreadId === threadId || assignment.parentThreadId === threadId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((assignment) => this.assignmentSummary(assignment));
  }

  /**
   * Stop, as the Host does it: the task and its pending decisions end, its Run
   * is interrupted, and the conversation that asked is told without a turn.
   */
  cancelAssignment(assignmentId: string): AssignmentSummary {
    const assignment = this.getAssignment(assignmentId);
    if (assignment.status !== "open") return this.assignmentSummary(assignment);
    const workerId = assignment.workerThreadId;
    const now = this.now().toISOString();
    const active = this.activeRuns.get(workerId);
    if (active) active.cancelled = true;
    this.activeRuns.delete(workerId);
    this.threadInputQueues.delete(workerId);
    const pending = (this.snapshot.requests[workerId] ?? []).filter(
      (request) => request.status === "pending",
    );
    const entries = finishRunEntries(
      this.snapshot.transcripts[workerId] ?? [],
      active?.id ?? null,
      now,
    )
      .map((entry) =>
        entry.kind === "run" &&
        entry.runId === active?.id &&
        !isTerminalRunEntryStatus(entry.status)
          ? { ...entry, status: "interrupted" as const }
          : entry,
      )
      .concat(
        pending.map((request) => ({
          createdAt: now,
          id: `request:${request.id}`,
          kind: "request" as const,
          outcome: "Cancelled · task stopped",
          requestId: request.id,
          requestKind: request.kind,
          runId: request.originatingRunId,
          title: requestTitleText(request.presentation),
          // As a client that saw the live Request open remembers it.
          ...(request.mode === "live" ? { waitedSince: request.createdAt } : {}),
        })),
      );
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          requests: {
            ...this.snapshot.requests,
            [workerId]: (this.snapshot.requests[workerId] ?? []).filter(
              (request) => request.status !== "pending",
            ),
          },
          runQueue: this.snapshot.runQueue.filter((run) => run.threadId !== workerId),
          threads: this.snapshot.threads.map((thread) =>
            thread.id === workerId
              ? { ...thread, pendingRequests: 0, status: "idle", updatedAt: now }
              : thread,
          ),
          transcripts: { ...this.snapshot.transcripts, [workerId]: entries },
        },
        workerId,
      ),
    );
    this.finishAssignment(assignment, { status: "cancelled" });
    return this.assignmentSummary(this.getAssignment(assignmentId));
  }

  private assignmentSummary(assignment: AssignmentView): AssignmentSummary {
    const thread = this.snapshot.threads.find((item) => item.id === assignment.workerThreadId);
    if (!thread) throw new Error("Assignment worker Thread not found.");
    const models = this.assignmentModels.get(assignment.id);
    if (!models) throw new Error("Assignment models not found.");
    const workerModel = models.modelSelection;
    const assigningModel = models.parentModelSelection;
    const queued = this.snapshot.runQueue.find((item) => item.threadId === thread.id);
    const ended = (this.snapshot.transcripts[thread.id] ?? []).findLast(
      (entry): entry is RunEntry => entry.kind === "run" && entry.runId !== null,
    );
    const run = queued ?? (ended ? { id: ended.runId, status: ended.status } : null);
    return AssignmentSummarySchema.parse({
      createdAt: assignment.createdAt,
      currentRunId: run?.id ?? null,
      currentRunStatus: run?.status ?? null,
      finishedAt: assignment.finishedAt,
      id: assignment.id,
      initialRunId: assignment.initialRunId,
      modelLabel:
        workerModel.providerId === assigningModel.providerId &&
        workerModel.modelId === assigningModel.modelId
          ? null
          : workerModel.modelId,
      objectivePreview: assignment.objective,
      origin: assignment.origin,
      parentThreadId: assignment.parentThreadId,
      resultPreview: assignment.resultText,
      returnStatus: assignment.returnStatus,
      revision: assignment.revision,
      status: assignment.status,
      updatedAt: assignment.updatedAt,
      workerThread: {
        environmentId: thread.environmentId,
        id: thread.id,
        pendingRequests: (this.snapshot.requests[thread.id] ?? []).filter(
          (request) => request.status === "pending",
        ).length,
        status: thread.status,
        title: thread.title,
        icon: thread.icon,
        color: thread.color ?? undefined,
        deploymentId: this.snapshot.deploymentId!,
      },
    });
  }

  loadThreadInputQueue(threadId: string): ThreadInputQueue {
    const queue = this.inputQueueView(this.snapshot, threadId);
    if (!queue) throw new Error("Thread not found.");
    // Every queue mutation already projects the view, so a read normally finds
    // it current; answering the stored object then keeps a React effect that
    // activates on every render from looping on a fresh snapshot.
    const stored = this.snapshot.inputQueues[threadId];
    if (stored && JSON.stringify(stored) === JSON.stringify(queue)) return stored;
    this.update({
      ...this.snapshot,
      inputQueues: { ...this.snapshot.inputQueues, [threadId]: queue },
    });
    return queue;
  }

  /**
   * Promotes one queued message into the Run the caller expects, the way the
   * Host does: only the Run the queue read named as steerable, and only a
   * message still waiting. The mock has no Runner to prove injection, so the
   * input stays `claimed`; the transcript shows it, and a reply not yet
   * streamed acknowledges it.
   */
  steerThreadInput(threadId: string, messageId: string, expectedRunId: string): ThreadInput {
    const queue = this.inputQueueView(this.snapshot, threadId);
    if (!queue) throw new Error("Thread not found.");
    if (queue.steerRunId === null || queue.steerRunId !== expectedRunId) {
      throw mockConflict("This Run cannot accept steering. Your message remains queued.");
    }
    if (queue.items.find((item) => item.input.messageId === messageId)?.input.freshContext)
      throw mockConflict("A fresh-context input cannot be steered.");
    const item = this.takePendingInput(threadId, messageId);
    const input = ThreadInputSchema.parse({
      ...item.input,
      runId: expectedRunId,
      state: "claimed",
      updatedAt: this.now().toISOString(),
    });
    const active = this.activeRuns.get(threadId);
    if (active?.id === expectedRunId) active.steered.push(item.body);
    this.snapshot = {
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === threadId ? { ...thread, askedAt: this.now().toISOString() } : thread,
      ),
    };
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          transcripts: {
            ...this.snapshot.transcripts,
            [threadId]: placeMockMessage(
              this.snapshot.transcripts[threadId] ?? [],
              messageId,
              expectedRunId,
            ),
          },
        },
        threadId,
      ),
    );
    return input;
  }

  /** Withdraws a queued message before any Run picks it up; its transcript entry goes with it. */
  cancelThreadInput(threadId: string, messageId: string): ThreadInput {
    if (!this.snapshot.threads.some((candidate) => candidate.id === threadId)) {
      throw new Error("Thread not found.");
    }
    const item = this.takePendingInput(threadId, messageId);
    const input = ThreadInputSchema.parse({
      ...item.input,
      cancelReason: "withdrawn",
      state: "cancelled",
      updatedAt: this.now().toISOString(),
    });
    this.withdrawnThreadInputs.set(messageId, input);
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          transcripts: {
            ...this.snapshot.transcripts,
            [threadId]: (this.snapshot.transcripts[threadId] ?? []).filter(
              (entry) => entry.kind !== "message" || entry.id !== messageId,
            ),
          },
        },
        threadId,
      ),
    );
    return input;
  }

  /**
   * Stands one queued message in front of another, or at the back, the way the
   * Host does: both must still be waiting, and everything else keeps its order.
   */
  moveThreadInput(threadId: string, messageId: string, beforeMessageId: string | null): void {
    const waiting = this.threadInputQueues.get(threadId) ?? [];
    const moving = waiting.find((item) => item.message.id === messageId);
    const before =
      beforeMessageId === null ? null : waiting.find((item) => item.message.id === beforeMessageId);
    if (!moving || before === undefined) {
      throw mockConflict("This message is no longer waiting in the queue");
    }
    this.threadInputQueues.set(threadId, moveQueueItem(waiting, moving, before));
    this.update(this.withInputQueue(this.snapshot, threadId));
  }

  queueBehindPreparingAccount(threadId: string): void {
    const snapshot = this.snapshot;
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    const harness = snapshot.harnesses.find(({ id }) => id === thread?.harnessInstanceId);
    if (!thread || !harness) throw new Error("The mock task needs an account.");
    const waiting = { ...thread, status: "waiting" as const, inputQueuePaused: false };
    const preparing = HarnessInstanceCatalogSchema.parse({
      detail: `Preparing ${harness.name}…`,
      driverKind: harness.driverKind,
      harnessInstanceId: harness.id,
      models: [],
      status: "preparing",
    });
    this.update({
      ...snapshot,
      revision: snapshot.revision + 1,
      threads: snapshot.threads.map((candidate) =>
        candidate.id === threadId ? waiting : candidate,
      ),
      activeTasks: [
        ...snapshot.activeTasks.filter((entry) => entry.thread.id !== threadId),
        { thread: waiting, lastReply: null, failure: null },
      ],
      runQueue: [
        ...snapshot.runQueue.filter((run) => run.threadId !== threadId),
        {
          id: createId("run"),
          threadId,
          status: "queued",
          createdAt: this.now().toISOString(),
          runOrdinal: 1,
        },
      ],
      environments: snapshot.environments.map((environment) =>
        environment.id === harness.environmentId
          ? {
              ...environment,
              connected: true,
              harnessCatalogs: [
                ...environment.harnessCatalogs.filter(
                  ({ harnessInstanceId }) => harnessInstanceId !== harness.id,
                ),
                preparing,
              ],
            }
          : environment,
      ),
    });
  }

  /** The waiting message in line that a lease or an edit acts on. */
  private waitingInput(threadId: string, messageId: string): PendingMockInput {
    const item = (this.threadInputQueues.get(threadId) ?? []).find(
      ({ message }) => message.id === messageId,
    );
    if (!item) throw mockConflict("This message is no longer waiting.");
    if (!mockEditable(item)) throw mockConflict("This message can’t be edited.");
    return item;
  }

  isLocalEditLease(messageId: string, leaseId: string): boolean {
    const lease = this.liveLease(messageId);
    return lease?.here === true && lease.view.leaseId === leaseId;
  }

  private liveLease(messageId: string) {
    const lease = this.editLeases.get(messageId);
    if (lease && Date.parse(lease.view.expiresAt) > this.now().getTime()) return lease;
    return undefined;
  }

  takeEditLease(command: Extract<HostApiCommand, { readonly type: "thread.input.lease.take" }>): {
    readonly lease: ThreadInputEditLeaseView;
    readonly revision: number;
  } {
    const item = this.waitingInput(command.threadId, command.messageId);
    const held = this.liveLease(command.messageId);
    if (held && held.view.leaseId !== command.leaseId && !command.takeOver)
      throw mockConflict(`Being edited on ${held.view.deviceLabel}.`);
    return {
      lease: this.setEditLease(command.threadId, command.messageId, command.leaseId, true),
      revision: item.edit?.revision ?? 0,
    };
  }

  renewEditLease(
    command: Extract<HostApiCommand, { readonly type: "thread.input.lease.renew" }>,
  ): ThreadInputEditLeaseView {
    const held = this.liveLease(command.messageId);
    if (held?.view.leaseId !== command.leaseId)
      throw mockConflict("This edit is no longer held here.");
    const view = { ...held.view, expiresAt: this.leaseExpiry() };
    // Renewals are silent: nothing a reader draws changes.
    this.editLeases.set(command.messageId, { ...held, view });
    return view;
  }

  releaseEditLease(
    command: Extract<HostApiCommand, { readonly type: "thread.input.lease.release" }>,
  ): void {
    const held = this.editLeases.get(command.messageId);
    if (!held || (command.leaseId !== undefined && held.view.leaseId !== command.leaseId)) return;
    this.editLeases.delete(command.messageId);
    this.update(this.withInputQueue(this.snapshot, command.threadId));
    this.admitNextInput(command.threadId);
  }

  /** Another of the person's devices opens a waiting message to edit it, as journeys script. */
  mockOtherDeviceEdit(threadId: string, messageId: string, deviceLabel: string): void {
    this.waitingInput(threadId, messageId);
    this.setEditLease(
      threadId,
      messageId,
      crypto.randomUUID().replaceAll("-", ""),
      false,
      deviceLabel,
    );
  }

  private setEditLease(
    threadId: string,
    messageId: string,
    leaseId: string,
    here: boolean,
    deviceLabel = mockThisDeviceLabel,
  ): ThreadInputEditLeaseView {
    const view = { deviceLabel, expiresAt: this.leaseExpiry(), leaseId };
    this.editLeases.set(messageId, { here, view });
    this.update(this.withInputQueue(this.snapshot, threadId));
    this.lapseEditLease(threadId, messageId, leaseId);
    return view;
  }

  /** As the Host's sweep does, a lease nobody renewed lapses and its queue moves on. */
  private lapseEditLease(threadId: string, messageId: string, leaseId: string): void {
    const held = this.editLeases.get(messageId);
    if (held?.view.leaseId !== leaseId) return;
    const remaining = Date.parse(held.view.expiresAt) - this.now().getTime();
    if (remaining > 0) {
      setTimeout(() => this.lapseEditLease(threadId, messageId, leaseId), remaining);
      return;
    }
    this.editLeases.delete(messageId);
    this.update(this.withInputQueue(this.snapshot, threadId));
    this.admitNextInput(threadId);
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + threadInputEditLeaseMs).toISOString();
  }

  /**
   * Replaces a waiting message in place as the Host does: under this edit's
   * lease or none, from the version the person started on, keeping or
   * dropping its files but adding none. Every version stays in its history.
   */
  editWaitingInput(command: Extract<HostApiCommand, { readonly type: "thread.input.edit" }>): {
    readonly edit: MessageEdit;
    readonly message: Message;
  } {
    const fingerprint = JSON.stringify([
      command.threadId,
      command.messageId,
      command.expectedRevision,
      command.content,
    ]);
    const receipt = this.editReceipts.get(command.idempotencyKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw mockConflict("This edit key was already used for a different edit.");
      return receipt;
    }
    const item = this.waitingInput(command.threadId, command.messageId);
    const held = this.liveLease(command.messageId);
    if (held && held.view.leaseId !== command.leaseId)
      throw mockConflict(`Being edited on ${held.view.deviceLabel}.`);
    const revision = item.edit?.revision ?? 0;
    if (command.expectedRevision !== revision)
      throw mockConflict("This message changed since you opened it.");
    const kept = new Set(
      item.message.content
        .filter((part) => part.type !== "text")
        .map((part) => JSON.stringify(part)),
    );
    if (command.content.some((part) => part.type !== "text" && !kept.has(JSON.stringify(part))))
      throw mockBadRequest("An edit can keep or remove files and places, not add them.");
    const timestamp = this.now().toISOString();
    const history = this.messageRevisions.get(command.messageId) ?? [
      {
        author: item.message.author,
        content: item.message.content,
        createdAt: item.message.createdAt,
        deviceLabel: null,
        revision: 0,
      },
    ];
    const edit: MessageEdit = {
      editedAt: timestamp,
      revision: revision + 1,
    };
    this.messageRevisions.set(command.messageId, [
      ...history,
      {
        author: mockHumanAuthor(),
        content: command.content,
        createdAt: timestamp,
        deviceLabel: held?.view.deviceLabel ?? mockThisDeviceLabel,
        revision: edit.revision,
      },
    ]);
    const message = MessageSchema.parse({ ...item.message, content: command.content });
    item.message = message;
    item.body = command.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    item.edit = edit;
    this.editLeases.delete(command.messageId);
    const transcript = this.snapshot.transcripts[command.threadId];
    this.update(
      this.withInputQueue(
        transcript
          ? {
              ...this.snapshot,
              transcripts: {
                ...this.snapshot.transcripts,
                [command.threadId]: withEditedMessage(transcript, { ...message, edit }, edit),
              },
            }
          : this.snapshot,
        command.threadId,
      ),
    );
    const saved = { edit, fingerprint, message };
    this.editReceipts.set(command.idempotencyKey, saved);
    this.admitNextInput(command.threadId);
    return saved;
  }

  /** A message's versions, newest first, a page at a time; none until it is first edited. */
  messageRevisionPage(
    messageId: string,
    before: number | undefined,
  ): { readonly revisions: MessageRevisionView[]; readonly hasMore: boolean } {
    const newest = [...(this.messageRevisions.get(messageId) ?? [])]
      .reverse()
      .filter((row) => before === undefined || row.revision < before);
    return {
      revisions: newest.slice(0, messageRevisionsPageSize),
      hasMore: newest.length > messageRevisionsPageSize,
    };
  }

  /** Lifts the pause an explicit stop left behind and lets the oldest queued message start. */
  resumeThreadInputQueue(threadId: string): ThreadSummary {
    const thread = this.snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const timestamp = this.now().toISOString();
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          threads: this.snapshot.threads.map((item) =>
            item.id === threadId
              ? { ...item, inputQueuePaused: false, updatedAt: timestamp }
              : item,
          ),
        },
        threadId,
      ),
    );
    this.admitNextInput(threadId);
    const resumed = this.snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!resumed) throw new Error("The mock Thread was not projected.");
    return resumed;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * The UI reads the queue from the snapshot, so activation loads it the way
   * the session client does. A Thread the preview does not hold is a no-op
   * rather than a throw: activation is fire-and-forget for a surface.
   */
  activateThread(threadId: string): void {
    if (this.snapshot.threads.some((thread) => thread.id === threadId)) {
      this.loadThreadInputQueue(threadId);
    }
  }

  /**
   * The queue as the Host would answer it from this snapshot: only the running
   * Run of an unpaused Thread accepts promotions, and every queued message is
   * the viewer's own, so all of them can be withdrawn. Null for an unknown Thread.
   */
  private inputQueueView(snapshot: HostSnapshot, threadId: string): ThreadInputQueue | null {
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return null;
    const running = thread.inputQueuePaused
      ? undefined
      : snapshot.runQueue.find((run) => run.threadId === threadId && run.status === "running");
    const steerRunId = running?.id ?? null;
    return ThreadInputQueueViewSchema.parse({
      threadId,
      paused: thread.inputQueuePaused,
      steerRunId,
      items: (this.threadInputQueues.get(threadId) ?? []).slice(0, 100).map((item) => ({
        message: item.edit ? { ...item.message, edit: item.edit } : item.message,
        input: item.input,
        canCancel: true,
        canEdit: mockEditable(item),
        canMove: true,
        canSteer: steerRunId !== null && !item.input.freshContext,
        lease: this.liveLease(item.message.id)?.view ?? null,
      })),
    });
  }

  /** The snapshot with that Thread's queue view recomputed from the snapshot's own Runs and flags. */
  private withInputQueue(snapshot: HostSnapshot, threadId: string): HostSnapshot {
    const queue = this.inputQueueView(snapshot, threadId);
    if (!queue) return snapshot;
    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              pendingRequests: (snapshot.requests[threadId] ?? []).filter(
                (request) => request.status === "pending",
              ).length,
            }
          : thread,
      ),
      inputQueues: { ...snapshot.inputQueues, [threadId]: queue },
    };
  }

  private takePendingInput(threadId: string, messageId: string): PendingMockInput {
    const item = (this.threadInputQueues.get(threadId) ?? []).find(
      (candidate) => candidate.message.id === messageId,
    );
    if (!item) throw mockConflict("This message is no longer waiting in the queue");
    this.dropPendingInput(threadId, item);
    return item;
  }

  private dropPendingInput(threadId: string, item: PendingMockInput): void {
    const remaining = (this.threadInputQueues.get(threadId) ?? []).filter(
      (candidate) => candidate !== item,
    );
    if (remaining.length === 0) this.threadInputQueues.delete(threadId);
    else this.threadInputQueues.set(threadId, remaining);
  }

  /**
   * Finalization on the Host admits the oldest queued input of an idle,
   * unpaused Thread as its next Run; stop leaves the queue paused so nothing
   * starts until the person resumes it.
   */
  private admitNextInput(threadId: string): void {
    const thread = this.snapshot.threads.find((candidate) => candidate.id === threadId);
    const [next] = this.threadInputQueues.get(threadId) ?? [];
    if (
      !thread ||
      !next ||
      thread.inputQueuePaused ||
      this.liveLease(next.message.id) ||
      this.snapshot.runQueue.some((run) => run.threadId === threadId)
    ) {
      return;
    }
    void this.startRunFromInput(thread, next).execution;
  }

  /**
   * Seeds a Run with one input and starts it: the same path for an idle send
   * and for admission from the queue, so a queued message runs exactly like a
   * fresh one once its turn comes.
   */
  private startRunFromInput(
    thread: ThreadSummary,
    pending: PendingMockInput,
  ): {
    readonly execution: Promise<void>;
    readonly input: ThreadInput;
    readonly message: Message;
    readonly run: Run;
  } {
    if (pending.input.freshContext) {
      thread = {
        ...thread,
        providerSessionId: createId("providerSession"),
        continuationIdentity: null,
      };
      this.publishThreadExecution(thread);
    }
    const timestamp = this.now().toISOString();
    const run: ActiveMockRun = {
      cancelled: false,
      id: this.nextId("run"),
      joined: [],
      person: null,
      steered: [],
    };
    const runOrdinal = this.nextRunOrdinals.get(thread.id) ?? 0;
    this.nextRunOrdinals.set(thread.id, runOrdinal + 1);
    const placement = resolveThreadPlacement(this.snapshot.environments, this.snapshot.harnesses, {
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
    });
    const message: Message = MessageSchema.parse({ ...pending.message, runId: run.id });
    const input: ThreadInput = ThreadInputSchema.parse({
      ...pending.input,
      runId: run.id,
      updatedAt: timestamp,
    });
    const runRecord: Run = RunSchema.parse({
      accessMode: thread.accessMode,
      activationInputId: message.id,
      assignmentId: input.assignmentId,
      causalChainId: input.causalChainId,
      completedAt: null,
      createdAt: timestamp,
      environmentId: thread.environmentId,
      failure: null,
      harnessInstanceId: thread.harnessInstanceId,
      id: run.id,
      providerSessionId: thread.providerSessionId ?? createId("providerSession"),
      modelSelection: thread.modelSelection,
      replyTarget: null,
      requestedBy: mockUserId,
      runOrdinal,
      seedInputId: message.id,
      startedAt: null,
      status: "queued",
      threadId: thread.id,
    });
    if (pending.message.author.kind === "human") run.person = runRecord;
    if (input.assignmentId !== null) {
      const models = this.assignmentModels.get(input.assignmentId);
      if (!models) throw new Error("Assignment models not found.");
      this.assignmentModels.set(input.assignmentId, {
        ...models,
        modelSelection: runRecord.modelSelection,
      });
    }
    this.dropPendingInput(thread.id, pending);
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue: [
            ...this.snapshot.runQueue,
            { createdAt: timestamp, id: run.id, status: "queued", threadId: thread.id, runOrdinal },
          ],
          threads: this.snapshot.threads.map((item) =>
            item.id === thread.id
              ? {
                  ...item,
                  continuationIdentity: item.continuationIdentity ?? placement.continuationIdentity,
                  status: "running",
                  updatedAt: timestamp,
                }
              : item,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [thread.id]: placeMockMessage(
              this.snapshot.transcripts[thread.id] ?? [],
              message.id,
              run.id,
            ),
          },
        },
        thread.id,
      ),
    );
    return {
      execution: this.executeRun(thread, run, pending),
      input,
      message,
      run: runRecord,
    };
  }

  private executeRun(thread: ThreadSummary, run: ActiveMockRun, pending: PendingMockInput) {
    const returned = assignmentReturnId(pending.message);
    if (returned !== null) return this.executeTaskAnswer(thread, run, returned);
    return this.executeMockRun(thread, run, pending.body);
  }

  async completeNativeAuthorization(_oauthQuery: string, _accept: boolean): Promise<string> {
    return "opensteer://oauth/host-callback?code=mock&state=mock";
  }

  async signInPassword(
    _input: import("../host/client.js").PasswordSignInInput,
    _options?: { oauthQuery?: string },
  ): Promise<string | null> {
    await this.load();
    return null;
  }

  async signUpPassword(_input: import("../host/client.js").PasswordSignUpInput): Promise<void> {
    await this.load();
  }

  async resetPasswordWithRecovery(_token: string, _newPassword: string): Promise<void> {}

  async signOut(): Promise<void> {
    await this.revokeSession(this.sessions.find((session) => session.current)?.id);
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.computerUse
          ? { ...machine, computerUse: { ...machine.computerUse, ownerViews: [] } }
          : machine,
      ),
      session: "authentication-required",
      sessionSurface: null,
      user: null,
    });
  }

  async beginHarnessAuthentication(
    input: Extract<HostApiCommand, { type: "harness.authentication.begin" }>,
  ): Promise<HarnessAuthenticationEnvelope> {
    const harness = this.authenticationHarness(input);
    const environment = this.snapshot.environments.find((item) => item.id === input.environmentId);
    if (!environment?.harnessAuthenticationAllowed)
      throw new Error("Sign-in is not allowed on this computer.");
    const catalog = mockAccountCatalog(harness, false);
    const method = catalog.setupMethods.find(
      (item) =>
        item.methodId === input.methodId &&
        (!input.connectionSlot || item.connectionSlot === input.connectionSlot),
    );
    if (!method) throw new Error("This account does not offer that sign-in method.");
    if (!this.harnessSignIns.has(harness.id))
      this.harnessSignIns.set(harness.id, { startedAt: this.now().getTime(), method });
    if (method.kind === "local-import") this.completeHarnessSignIn(harness);
    return this.getHarnessAuthentication(input);
  }

  async submitHarnessAuthentication(
    input: Extract<HostApiCommand, { type: "harness.authentication.submit" }>,
  ): Promise<HarnessAuthenticationEnvelope> {
    const harness = this.authenticationHarness(input);
    if (!this.harnessSignIns.has(harness.id)) throw new Error("Start sign-in first.");
    if (!input.value.trim()) throw new Error("Enter the requested credential.");
    this.completeHarnessSignIn(harness);
    return { authentication: { status: "ready" }, environmentStatus: "connected" };
  }

  async logoutHarness(
    input: Extract<HostApiCommand, { type: "harness.authentication.logout" }>,
  ): Promise<HarnessAuthenticationEnvelope> {
    const harness = this.authenticationHarness(input);
    this.harnessSignIns.delete(harness.id);
    this.setAuthenticationCatalog(harness, false);
    return { authentication: { status: "not-started" }, environmentStatus: "connected" };
  }

  async getHarnessAuthentication(input: {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
  }): Promise<HarnessAuthenticationEnvelope> {
    const harness = this.authenticationHarness(input);
    const environment = this.snapshot.environments.find((item) => item.id === input.environmentId);
    if (!environment?.connected)
      return { authentication: { status: "not-started" }, environmentStatus: "disconnected" };
    const attempt = this.harnessSignIns.get(harness.id);
    if (attempt) {
      if (
        attempt.method.kind === "device-code" &&
        this.now().getTime() - attempt.startedAt >= 8_000
      ) {
        this.completeHarnessSignIn(harness);
      } else {
        const challenge =
          attempt.method.kind === "secret-input"
            ? { kind: "secret-input" as const, inputLabel: attempt.method.inputLabel }
            : attempt.method.kind === "browser-code"
              ? {
                  kind: "browser-code" as const,
                  inputPrompt: "Paste the code from your browser",
                  authorizationUrl: "https://example.com/mock-sign-in",
                }
              : {
                  kind: "device-code" as const,
                  userCode: "DEMO-1234",
                  verificationUrl: "https://example.com/mock-sign-in",
                };
        return { authentication: { status: "pending", challenge }, environmentStatus: "connected" };
      }
    }
    const ready = this.snapshot.environments
      .find((item) => item.id === harness.environmentId)
      ?.harnessCatalogs.some(
        (item) => item.harnessInstanceId === harness.id && item.status === "ready",
      );
    return {
      authentication: { status: ready ? "ready" : "not-started" },
      environmentStatus: "connected",
    };
  }

  async cancelHarnessAuthentication(
    input: Extract<HostApiCommand, { type: "harness.authentication.cancel" }>,
  ): Promise<HarnessAuthenticationEnvelope> {
    this.harnessSignIns.delete(input.harnessInstanceId);
    return { authentication: { status: "not-started" }, environmentStatus: "connected" };
  }

  private authenticationHarness(input: {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
  }): HarnessSummary {
    const harness = this.snapshot.harnesses.find(
      (item) => item.id === input.harnessInstanceId && item.environmentId === input.environmentId,
    );
    if (!harness) throw new Error("AI account not found.");
    return harness;
  }

  private completeHarnessSignIn(harness: HarnessSummary): void {
    this.harnessSignIns.delete(harness.id);
    this.setAuthenticationCatalog(harness, true);
  }

  private setAuthenticationCatalog(harness: HarnessSummary, ready: boolean): void {
    const catalog = mockAccountCatalog(harness, ready);
    this.update({
      ...this.snapshot,
      environments: this.snapshot.environments.map((environment) =>
        environment.id === harness.environmentId
          ? {
              ...environment,
              harnessCatalogs: [
                ...environment.harnessCatalogs.filter(
                  (item) => item.harnessInstanceId !== harness.id,
                ),
                catalog,
              ],
            }
          : environment,
      ),
    });
  }

  async createHarnessInstance(
    input: CreateHarnessInstanceInput & {
      readonly config?: Readonly<Record<string, string>> | undefined;
      readonly sourceId: string;
    },
  ): Promise<HarnessSummary> {
    // The mock refuses exactly what the Host refuses, so a surface built against
    // it cannot rely on an account the real Deployment would never store.
    const source = mockHarnessSourcesByDriver[input.driverKind]?.find(
      (candidate) => candidate.sourceId === input.sourceId,
    );
    if (!source) throw new Error("This AI engine does not offer that source here.");
    if (!source.stateKinds.includes(input.stateKind)) {
      throw new Error(
        `${source.label} accounts only support ${source.stateKinds.join(" or ")} AI engine state.`,
      );
    }
    for (const key of Object.keys(input.config ?? {})) {
      if (!source.fields.some((field) => field.id === key)) {
        throw new Error(`${source.label} has no ${key} setting.`);
      }
    }
    const config: Record<string, string> = {};
    for (const field of source.fields) {
      const value = (input.config?.[field.id] ?? field.defaultValue)?.trim();
      if (!value) {
        if (field.required === false) continue;
        throw new Error(`${field.label} is required.`);
      }
      if (field.kind === "select" && !field.options?.some((option) => option.value === value))
        throw new Error(`${field.label} is not one of the offered choices.`);
      if (field.kind === "url") {
        if (!parseHttpEndpointBaseUrl(value))
          throw new Error(
            `${field.label} must be an HTTP address without credentials, a query, or a fragment.`,
          );
      }
      config[field.id] = value;
    }
    const harness: HarnessSummary = {
      driverKind: input.driverKind,
      enabled: true,
      // As the Host client reads it from the account's config.
      ...(config.baseUrl
        ? {
            endpoint: config.runtime
              ? { baseUrl: config.baseUrl, runtime: config.runtime }
              : { baseUrl: config.baseUrl },
          }
        : {}),
      environmentId: input.environmentId,
      id: createId("harnessInstance"),
      isDefault: !this.snapshot.harnesses.some(
        (candidate) =>
          candidate.driverKind === input.driverKind &&
          candidate.environmentId === input.environmentId &&
          candidate.enabled &&
          candidate.isDefault,
      ),
      name: input.name,
      runtimeRevision: 1,
      sourceId: source.sourceId,
      stateKind: input.stateKind,
    };
    this.harnessSourceConfigs.set(harness.id, config);
    this.update({
      ...this.snapshot,
      harnesses: normalizeMockHarnessDefaults(
        [...this.snapshot.harnesses, harness],
        harness.environmentId,
        harness.driverKind,
        harness.isDefault ? harness.id : undefined,
      ),
    });
    this.applyAutomaticEligibility();
    // A model server answers its first read the way a local one usually does:
    // one model loaded, one the server won't say the size of, one it can't run.
    if (source.modelSettings) {
      const catalog = mockModelServerCatalog(harness, config.baseUrl ?? "");
      this.update({
        ...this.snapshot,
        environments: this.snapshot.environments.map((environment) =>
          environment.id === harness.environmentId
            ? { ...environment, harnessCatalogs: [...environment.harnessCatalogs, catalog] }
            : environment,
        ),
      });
    } else {
      this.setAuthenticationCatalog(
        harness,
        harness.stateKind === "ambient" || harness.driverKind === "cursor",
      );
    }
    return harness;
  }

  configureHarnessModel(
    input: Extract<HostApiCommandInput, { type: "harness.model.configure" }>,
  ): HarnessSummary {
    const current = this.snapshot.harnesses.find(
      (candidate) =>
        candidate.id === input.harnessInstanceId && candidate.environmentId === input.environmentId,
    );
    if (!current) throw new Error("AI engine not found.");
    const environment = this.snapshot.environments.find(
      (candidate) => candidate.id === input.environmentId,
    );
    const source = mockHarnessSourcesByDriver[current.driverKind]?.find(
      (candidate) => candidate.sourceId === current.sourceId,
    );
    if (!environment?.connected || !source?.modelSettings)
      throw new Error("This account does not currently offer model settings.");
    const catalog = environment.harnessCatalogs.find(
      (candidate) => candidate.harnessInstanceId === current.id,
    );
    const currentSettings = { ...current.modelSettings };
    if (
      !Object.hasOwn(currentSettings, input.nativeModelId) &&
      !(
        catalog?.status === "ready" &&
        catalog.models.some(
          (model) => (model.nativeModelId ?? model.modelId) === input.nativeModelId,
        )
      )
    )
      throw new Error("This server has not reported that model.");
    const modelSettings =
      input.settings === null
        ? Object.fromEntries(
            Object.entries(currentSettings).filter(([id]) => id !== input.nativeModelId),
          )
        : { ...currentSettings, [input.nativeModelId]: input.settings };
    const harness = { ...current, modelSettings, runtimeRevision: current.runtimeRevision + 1 };
    this.update({
      ...this.snapshot,
      harnesses: this.snapshot.harnesses.map((candidate) =>
        candidate.id === current.id ? harness : candidate,
      ),
      environments: this.snapshot.environments.map((candidate) =>
        candidate.id !== environment.id
          ? candidate
          : {
              ...candidate,
              harnessCatalogs: candidate.harnessCatalogs.map((entry) =>
                entry !== catalog || entry.status !== "ready"
                  ? entry
                  : {
                      ...entry,
                      models: entry.models.map((model) => {
                        if ((model.nativeModelId ?? model.modelId) !== input.nativeModelId)
                          return model;
                        const {
                          unavailableReason: _reason,
                          needsContextWindow: _needsContext,
                          contextWindow: _context,
                          maxOutputTokens: _output,
                          ...identity
                        } = model;
                        return input.settings
                          ? { ...identity, ...input.settings }
                          : {
                              ...identity,
                              needsContextWindow: true as const,
                              unavailableReason:
                                "Set this model's context length in Model settings.",
                            };
                      }),
                    },
              ),
            },
      ),
    });
    return harness;
  }

  async setDefaultHarnessInstance(
    environmentId: string,
    harnessInstanceId: string,
  ): Promise<HarnessSummary> {
    const current = this.snapshot.harnesses.find(
      (candidate) =>
        candidate.id === harnessInstanceId && candidate.environmentId === environmentId,
    );
    if (!current) throw new Error("AI engine not found.");
    if (!current.enabled) throw new Error("Turn this AI engine on before making it the default.");
    const harness = { ...current, isDefault: true };
    this.update({
      ...this.snapshot,
      harnesses: this.snapshot.harnesses.map((candidate) => {
        if (candidate.id === harness.id) return harness;
        if (
          candidate.environmentId !== harness.environmentId ||
          candidate.driverKind !== harness.driverKind
        ) {
          return candidate;
        }
        return candidate.isDefault ? { ...candidate, isDefault: false } : candidate;
      }),
    });
    return harness;
  }

  async renameHarnessInstance(
    environmentId: string,
    harnessInstanceId: string,
    name: string,
  ): Promise<HarnessSummary> {
    const current = this.snapshot.harnesses.find(
      (candidate) =>
        candidate.id === harnessInstanceId && candidate.environmentId === environmentId,
    );
    if (!current) throw new Error("AI engine not found.");
    const harness = { ...current, name };
    this.update({
      ...this.snapshot,
      harnesses: this.snapshot.harnesses.map((candidate) =>
        candidate.id === harness.id ? harness : candidate,
      ),
    });
    return harness;
  }

  async deleteHarnessInstance(environmentId: string, harnessInstanceId: string): Promise<void> {
    this.harnessSignIns.delete(harnessInstanceId);
    const removed = this.snapshot.harnesses.find(
      (candidate) =>
        candidate.id === harnessInstanceId && candidate.environmentId === environmentId,
    );
    const remaining = this.snapshot.harnesses.filter(
      (candidate) =>
        candidate.id !== harnessInstanceId || candidate.environmentId !== environmentId,
    );
    this.update({
      ...this.snapshot,
      harnesses: removed
        ? normalizeMockHarnessDefaults(remaining, removed.environmentId, removed.driverKind)
        : remaining,
      environments: this.snapshot.environments.map((environment) =>
        environment.id === environmentId
          ? {
              ...environment,
              harnessCatalogs: environment.harnessCatalogs.filter(
                (item) => item.harnessInstanceId !== harnessInstanceId,
              ),
            }
          : environment,
      ),
    });
  }

  async setHarnessInstanceEnabled(
    environmentId: string,
    harnessInstanceId: string,
    enabled: boolean,
  ): Promise<HarnessSummary> {
    const current = this.snapshot.harnesses.find(
      (candidate) =>
        candidate.id === harnessInstanceId && candidate.environmentId === environmentId,
    );
    if (!current) throw new Error("AI engine not found.");
    const harness = { ...current, enabled, isDefault: enabled ? current.isDefault : false };
    this.update({
      ...this.snapshot,
      harnesses: normalizeMockHarnessDefaults(
        this.snapshot.harnesses.map((candidate) =>
          candidate.id === harness.id ? harness : candidate,
        ),
        harness.environmentId,
        harness.driverKind,
        enabled && harness.isDefault ? harness.id : undefined,
      ),
    });
    return this.snapshot.harnesses.find((candidate) => candidate.id === harness.id) ?? harness;
  }

  /**
   * What `triggers.list` answers: every Trigger still in use, most recently
   * changed first; for an anchor, its family, as the Host builds it.
   */
  listTriggers(
    deploymentId?: string,
    anchorThreadId?: string,
    systemRole?: TriggerSummary["systemRole"],
  ): TriggerSummary[] {
    const inFamily = ({ trigger }: MockTriggerRecord) => {
      if (anchorThreadId === undefined) return trigger.status !== "archived";
      if (trigger.anchorThreadId === anchorThreadId) return trigger.status !== "archived";
      const anchor = this.snapshot.threads.find(({ id }) => id === trigger.anchorThreadId);
      return (
        anchor?.parentThreadId === anchorThreadId &&
        ![...this.assignments.values()].some(
          (assignment) => assignment.workerThreadId === anchor.id,
        )
      );
    };
    return [...this.triggers.values()]
      .filter(
        (record) =>
          inFamily(record) &&
          (systemRole === undefined || record.trigger.systemRole === systemRole) &&
          (deploymentId === undefined || mockMainDeploymentId === deploymentId),
      )
      .sort(
        (left, right) =>
          Number(left.trigger.status === "archived") -
            Number(right.trigger.status === "archived") ||
          Number(Boolean(right.trigger.systemRole)) - Number(Boolean(left.trigger.systemRole)) ||
          right.trigger.updatedAt.localeCompare(left.trigger.updatedAt),
      )
      .slice(0, 100)
      .map((record) => mockTriggerSummary(record, this.anchorThreadTitle(record)));
  }

  /** What `triggers.get` answers, archived Triggers included, as the Host does. */
  triggerDetail(triggerId: string) {
    const record = this.getTrigger(triggerId);
    return {
      ...record,
      anchorThread: (() => {
        const thread = this.snapshot.threads.find(({ id }) => id === record.trigger.anchorThreadId);
        return thread
          ? {
              ...mockThread(thread),
              ...(record.trigger.systemRole ? {} : {}),
            }
          : null;
      })(),
      anchorThreadTitle: this.anchorThreadTitle(record),
      createdByThreadTitle:
        this.snapshot.threads.find(({ id }) => id === record.trigger.createdByThreadId)?.title ??
        null,
    };
  }

  getTrigger(triggerId: string): MockTriggerRecord {
    const record = this.triggers.get(triggerId);
    if (!record) {
      throw new HostClientRequestError({
        code: "not_found",
        message: "Trigger not found",
        status: rpcErrorStatus("not_found"),
      });
    }
    return record;
  }

  private anchorThreadTitle(record: MockTriggerRecord): string {
    const thread = this.snapshot.threads.find(({ id }) => id === record.trigger.anchorThreadId);
    if (!thread) throw new Error("Anchor Thread not found.");
    return thread.title;
  }

  /** The Host tells every client when a Trigger changes; so does the preview. */
  private triggersChanged(): void {
    this.snapshot = { ...this.snapshot, triggerRevision: this.snapshot.triggerRevision + 1 };
    this.emit();
  }

  createTrigger(input: ParsedCommandOf<"trigger.create">["input"]) {
    const thread = this.snapshot.threads.find(({ id }) => id === input.anchorThreadId);
    if (!thread) throw new Error("Anchor Thread not found.");
    const now = this.now();
    const triggerId = createId("trigger");
    const revision = TriggerRevisionSchema.parse({
      createdAt: now.toISOString(),
      createdBy: mockUserId,
      createdByThreadId: null,
      id: createId("triggerRevision"),
      ordinal: 1,
      program: input.program,
      source: input.source,
      triggerId,
    });
    const webhookRouteKey = input.source.kind === "webhook" ? `mock-webhook-${triggerId}` : null;
    const trigger = TriggerSchema.parse({
      anchorThreadId: thread.id,
      consecutiveFailures: 0,
      createdAt: now.toISOString(),
      createdBy: mockUserId,
      createdByThreadId: null,
      currentRevisionId: revision.id,
      id: triggerId,
      kind: input.source.kind,
      name: input.name,
      nextFireAt: triggerNextFireAt(input.source, now),
      pauseReason: null,
      status: "active",
      updatedAt: now.toISOString(),
      webhookRouteKey,
    });
    this.triggers.set(triggerId, {
      activation:
        trigger.kind === "watch"
          ? mockWatchActivation(trigger, revision, thread.environmentId, now)
          : null,
      downstreamRuns: [],
      downstreamRunsTruncated: false,
      occurrences: [],
      revision,
      trigger,
    });
    this.triggersChanged();
    return {
      revision,
      trigger,
      wasDuplicate: false,
      ...(webhookRouteKey
        ? {
            webhook: {
              secret: `mock-secret-${triggerId}`,
              url: `${mockWebhookOrigin}/v1/trigger-webhooks/${webhookRouteKey}`,
            },
          }
        : {}),
    };
  }

  updateTrigger(triggerId: string, input: ParsedCommandOf<"trigger.update">["input"]) {
    const record = this.getTrigger(triggerId);
    if (
      record.trigger.systemRole &&
      (input.name !== undefined ||
        input.program !== undefined ||
        (input.source !== undefined &&
          (input.source.kind !== "schedule" ||
            input.source.schedule.kind !== "cron" ||
            input.source.schedule.payload !== undefined)))
    )
      throw mockConflict(MANAGED_MEMORY_REFUSAL);
    if (record.trigger.status === "archived") {
      throw mockConflict("Archived Triggers cannot be changed");
    }
    if (record.revision.id !== input.expectedRevisionId) {
      throw mockConflict("Trigger revision changed; read it again before updating");
    }
    const source = input.source ?? record.revision.source;
    if (source.kind !== record.trigger.kind) {
      throw new Error("A Trigger keeps the ingress it was created with.");
    }
    const now = this.now();
    const revision = TriggerRevisionSchema.parse({
      createdAt: now.toISOString(),
      createdBy: mockUserId,
      createdByThreadId: null,
      id: createId("triggerRevision"),
      ordinal: record.revision.ordinal + 1,
      program: input.program ?? record.revision.program,
      source,
      triggerId,
    });
    // As on the Host: only a new source re-arms the clock, and an elapsed
    // one-time instant stays elapsed.
    const trigger = TriggerSchema.parse({
      ...record.trigger,
      ...(input.program === undefined && input.source === undefined
        ? {}
        : { consecutiveFailures: 0 }),
      currentRevisionId: revision.id,
      name: input.name ?? record.trigger.name,
      nextFireAt:
        input.source === undefined
          ? record.trigger.nextFireAt
          : record.trigger.status === "active"
            ? resumedFireAt(source, now)
            : null,
      updatedAt: now.toISOString(),
    });
    this.triggers.set(triggerId, {
      ...record,
      activation:
        trigger.kind === "watch"
          ? mockWatchActivation(trigger, revision, watchEnvironment(record), now)
          : null,
      revision,
      trigger,
    });
    this.triggersChanged();
    return { revision, trigger };
  }

  setTriggerStatus(triggerId: string, status: Trigger["status"]): Trigger {
    const record = this.getTrigger(triggerId);
    if (record.trigger.systemRole && status === "archived")
      throw mockConflict(MANAGED_MEMORY_REFUSAL);
    if (record.trigger.status === status) return record.trigger;
    if (record.trigger.status === "archived") {
      throw mockConflict("Archived Triggers cannot be reactivated");
    }
    const now = this.now();
    const trigger = TriggerSchema.parse({
      ...record.trigger,
      ...(status === "active" ? { consecutiveFailures: 0 } : {}),
      nextFireAt: status === "active" ? resumedFireAt(record.revision.source, now) : null,
      pauseReason: null,
      status,
      updatedAt: now.toISOString(),
    });
    this.triggers.set(triggerId, {
      ...record,
      activation:
        record.activation && trigger.kind === "watch"
          ? status === "active"
            ? mockWatchActivation(trigger, record.revision, record.activation.environmentId, now)
            : TriggerWatchActivationSchema.parse({
                ...record.activation,
                desired: "stopped",
                leaseExpiresAt: null,
                observed: "stopped",
                updatedAt: now.toISOString(),
              })
          : null,
      trigger,
    });
    this.triggersChanged();
    return trigger;
  }

  /**
   * A manual run records the occurrence and stops there: the preview has no
   * Runner to claim it, so it stays pending exactly as it would on a Host whose
   * work location is offline.
   */
  runTrigger(triggerId: string, payload: unknown): TriggerOccurrence {
    const record = this.getTrigger(triggerId);
    if (record.trigger.systemRole) throw mockConflict(MANAGED_MEMORY_REFUSAL);
    if (record.trigger.status === "archived") throw mockConflict("Archived Trigger cannot run");
    const thread = this.snapshot.threads.find(({ id }) => id === record.trigger.anchorThreadId);
    if (!thread) throw new Error("Anchor Thread not found.");
    const now = this.now().toISOString();
    const occurrenceId = createId("triggerOccurrence");
    const occurrence = TriggerOccurrenceSchema.parse({
      commandId: createId("command"),
      completedAt: null,
      createdAt: now,
      environmentId: thread.environmentId,
      error: null,
      event: {
        id: occurrenceId,
        payload,
        receivedAt: now,
        source: { kind: "manual" },
        trigger: {
          anchorThreadId: record.trigger.anchorThreadId,
          id: record.trigger.id,
          revisionId: record.revision.id,
        },
      },
      exitCode: null,
      id: occurrenceId,
      result: null,
      revisionId: record.revision.id,
      startedAt: null,
      status: "pending",
      stderr: "",
      stdout: "",
      triggerId,
    });
    this.triggers.set(triggerId, { ...record, occurrences: [occurrence, ...record.occurrences] });
    this.triggersChanged();
    return occurrence;
  }

  cancelTriggerOccurrences(triggerId: string, occurrenceId?: string): string[] {
    const record = this.getTrigger(triggerId);
    const completedAt = this.now().toISOString();
    const canceled: string[] = [];
    const occurrences = record.occurrences.map((occurrence) => {
      if (occurrence.status !== "pending") return occurrence;
      if (occurrenceId !== undefined && occurrence.id !== occurrenceId) return occurrence;
      canceled.push(occurrence.id);
      return { ...occurrence, completedAt, status: "canceled" as const };
    });
    this.triggers.set(triggerId, { ...record, occurrences });
    if (canceled.length > 0) this.triggersChanged();
    return canceled;
  }

  /**
   * This client's own session at least. A preview Host that listed none would make
   * "sign out of this deployment" — and the web's device settings — unreachable
   * without a real Host, which is exactly what this exists to avoid.
   */
  async loadSessions() {
    return this.sessions;
  }

  readonly #screenConnections = new Map<string, DeviceIntegrationConnectionSummary>();
  setScreenAccess(
    deviceId: string,
    access: "read" | "read-write",
  ): DeviceIntegrationConnectionSummary {
    const machine = this.snapshot.machines.find(({ id }) => id === deviceId);
    if (!machine || machine.phoneDisplay?.definitionId !== "iphone-screen")
      throw mockNotFound("Screen Device not found.");
    const template = this.integrations.connections.find(({ computer }) => computer?.app === null)!;
    const existing = this.#screenConnections.get(deviceId);
    const connection = DeviceIntegrationConnectionSummarySchema.parse({
      ...template,
      id: existing?.id ?? createIntegrationId("connection"),
      definitionId: "iphone-screen",
      provider: "iphone-screen",
      displayName: machine.name,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      computer: { deviceId, access, app: null, blockedAt: null, policyRevision: null },
    });
    this.#screenConnections.set(deviceId, connection);
    const view =
      machine.phoneDisplay.view.reason?.kind === "approval-required"
        ? { state: "ready" as const, reason: null }
        : machine.phoneDisplay.view;
    const control =
      machine.phoneDisplay.control.reason?.kind === "approval-required"
        ? view
        : machine.phoneDisplay.control;
    if (machine.phoneDisplay)
      this.update({
        ...this.snapshot,
        machines: this.snapshot.machines.map((entry) =>
          entry !== machine
            ? entry
            : {
                ...entry,
                phoneDisplay: {
                  ...entry.phoneDisplay!,
                  view,
                  control,
                  input:
                    access === "read"
                      ? { state: "disabled", reason: { kind: "approval-required" } }
                      : view,
                },
                computerUse: entry.computerUse
                  ? {
                      ...entry.computerUse,
                      sessions:
                        access === "read" && existing?.computer?.access === "read-write"
                          ? []
                          : entry.computerUse.sessions,
                    }
                  : null,
              },
        ),
      });
    for (const request of this.computerAppSetupRequests.values()) {
      if (
        request.kind === "app" &&
        request.deviceId === deviceId &&
        request.definitionId === "iphone-screen" &&
        (access === "read-write" || request.access === "read")
      ) {
        this.computerAppSetupRequests.delete(request.id);
        this.fulfilComputerAppAccessRequest(request.id);
      }
    }
    return connection;
  }
  readonly #screenReplays = new Map<
    string,
    {
      fingerprint: string;
      result:
        | import("@opensteer/protocol").IphoneScreenAttachResult
        | import("@opensteer/protocol").IphoneScreenDetachResult;
    }
  >();
  setIphoneScreenState(state: MockIphoneScreenState, holding = false): void {
    const fixture = mockIphoneScreenDevice(state);
    if (holding && fixture.phoneDisplay?.control.state === "ready")
      fixture.computerUse!.sessions = [mockIphoneScreenSession];
    const prior = this.snapshot.machines.find(({ id }) => id === fixture.id);
    const generation = prior?.phoneDisplay?.driver
      ? prior.phoneDisplay.driver.generation +
        Number(prior.phoneDisplay.driver.attached !== fixture.phoneDisplay!.driver!.attached)
      : fixture.phoneDisplay!.driver!.generation;
    const driver = {
      ...fixture.phoneDisplay!.driver!,
      ...prior?.phoneDisplay?.driver,
      attached: fixture.phoneDisplay!.driver!.attached,
      generation,
    };
    const phone = {
      ...fixture,
      ...(prior?.access
        ? {
            access: {
              ...prior.access,
              policy: { ...prior.access.policy, apps: state !== "apps-off" },
            },
          }
        : {}),
      drivers: [driver],
      phoneDisplay: {
        ...fixture.phoneDisplay!,
        driver,
        setup: {
          location: "driver-mac" as const,
          driverRunnerId: driver.runnerId,
          driverRunnerName: driver.runnerName,
        },
      },
    };
    this.update({
      ...this.snapshot,
      machines: [...this.snapshot.machines.filter(({ id }) => id !== fixture.id), phone],
    });
    this.setScreenAccess(fixture.id, state === "read-only" ? "read" : "read-write");
  }
  #screenReplay(command: IphoneScreenAttachCommand | IphoneScreenDetachCommand) {
    const held = this.#screenReplays.get(command.idempotencyKey);
    if (held && held.fingerprint !== JSON.stringify(command))
      throw mockConflict("Idempotency key already used for another screen command.");
    return held?.result;
  }
  attachIphoneScreen(
    command: IphoneScreenAttachCommand,
  ): import("@opensteer/protocol").IphoneScreenAttachResult {
    const replay = this.#screenReplay(command);
    if (replay) {
      if (replay.type !== command.type) throw mockConflict("Screen command changed.");
      return replay;
    }
    const mac = this.snapshot.machines.find(({ id }) => id === command.driverRunnerId);
    if (
      !mac ||
      mac.device?.platform !== "macos" ||
      !mac.allowedModules.includes("integrations") ||
      (mac.ownership !== "mine" && mac.kind !== "home")
    )
      throw new HostClientRequestError({
        code: "forbidden",
        message: "Choose an owned Mac with integrations for screen setup.",
        status: 403,
      });
    if (mac.status !== "online" || mac.modules.integrations?.readiness !== "ready")
      throw mockConflict(
        "Open Opensteer on the Mac connected to this iPhone and update it to support iPhone Screen.",
      );
    const target =
      command.target.kind === "new"
        ? { ...command.target, name: command.target.name.trim() }
        : command.target;
    if (target.kind === "new" && (!target.name || target.name.length > 120))
      throw mockBadRequest("Device name is invalid");
    const prior =
      target.kind === "existing"
        ? this.snapshot.machines.find(({ id }) => id === target.deviceId)
        : null;
    if (
      target.kind === "existing" &&
      (!prior ||
        prior.selfRunnerId !== null ||
        (prior.ownership !== "mine" && prior.kind !== "home") ||
        prior.phoneDisplay?.definitionId !== "iphone-screen")
    )
      throw new HostClientRequestError({
        code: "forbidden",
        message: "Screen Device not found.",
        status: 403,
      });
    if (
      prior &&
      target.kind === "existing" &&
      prior.phoneDisplay?.driver?.generation !== target.expectedGeneration
    )
      throw mockConflict("The driver generation changed. Refresh this device.");
    const generation = (prior?.phoneDisplay?.driver?.generation ?? 0) + 1;
    const fixture = mockIphoneScreenDevice("setup-needed");
    const deviceId = prior
      ? DeviceIdSchema.parse(prior.id)
      : DeviceIdSchema.parse(`dev_${crypto.randomUUID()}`);
    const driver = {
      ...fixture.phoneDisplay!.driver!,
      runnerId: command.driverRunnerId,
      runnerName: mac.name,
      generation,
      attached: true,
    };
    const phone = {
      ...fixture,
      ...prior,
      id: deviceId,
      name: target.kind === "new" ? target.name : prior!.name,
      drivers: [driver],
      computerUse: { ...fixture.computerUse!, sessions: [], ownerViews: [] },
      phoneDisplay: {
        ...fixture.phoneDisplay!,
        driver,
        setup: {
          location: "driver-mac" as const,
          driverRunnerId: driver.runnerId,
          driverRunnerName: driver.runnerName,
        },
      },
    };
    if (!prior && phone.access)
      phone.access = { ...phone.access, policy: { ...phone.access.policy, apps: false } };
    const enabled = phone.access ? deviceAccess(phone.access.policy).apps : false;
    const control = enabled
      ? phone.phoneDisplay.control
      : { state: "disabled" as const, reason: { kind: "access-off" as const } };
    phone.capabilities = {
      ...phone.capabilities!,
      apps: { ...phone.capabilities!.apps, enabled, ...control },
    };
    phone.phoneDisplay = { ...phone.phoneDisplay, control };
    this.update({
      ...this.snapshot,
      machines: [...this.snapshot.machines.filter(({ id }) => id !== deviceId), phone],
    });
    const result = { type: command.type, deviceId, generation };
    this.#screenReplays.set(command.idempotencyKey, {
      fingerprint: JSON.stringify(command),
      result,
    });
    return result;
  }
  detachIphoneScreen(
    command: IphoneScreenDetachCommand,
  ): import("@opensteer/protocol").IphoneScreenDetachResult {
    const replay = this.#screenReplay(command);
    if (replay) {
      if (replay.type !== command.type) throw mockConflict("Screen command changed.");
      return replay;
    }
    const phone = this.snapshot.machines.find(({ id }) => id === command.deviceId);
    if (
      !phone ||
      phone.selfRunnerId !== null ||
      phone.phoneDisplay?.definitionId !== "iphone-screen"
    )
      throw mockNotFound("Screen Device not found.");
    if (phone.phoneDisplay.driver?.generation !== command.expectedGeneration)
      throw mockConflict("The driver generation changed. Refresh this device.");
    const generation = command.expectedGeneration + 1;
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine === phone ? this.detachedScreen(machine, generation) : machine,
      ),
    });
    const result = { type: command.type, deviceId: command.deviceId, generation };
    this.#screenReplays.set(command.idempotencyKey, {
      fingerprint: JSON.stringify(command),
      result,
    });
    return result;
  }
  private detachedScreen(machine: MachineSummary, generation: number): MachineSummary {
    const display = machine.phoneDisplay!;
    const driver = { ...display.driver!, generation, attached: false };
    const availability = {
      state: "unavailable" as const,
      reason: { kind: "not-connected" as const },
    };
    return {
      ...machine,
      status: "offline",
      drivers: [driver],
      capabilities: {
        ...machine.capabilities!,
        apps: { ...machine.capabilities!.apps, ...availability },
      },
      phoneDisplay: {
        ...display,
        driver,
        control: availability,
        view: availability,
        input: availability,
      },
      computerUse: machine.computerUse
        ? { ...machine.computerUse, sessions: [], ownerViews: [] }
        : null,
    };
  }

  async loadMachines() {
    return this.snapshot.machines.map((machine) => ({ ...machine }));
  }

  async revokeMachine(machineId: string): Promise<void> {
    if (this.snapshot.machines.find((machine) => machine.id === machineId)?.kind === "home")
      throw new Error("Home cannot be removed");
    const machine = this.snapshot.machines.find((machine) => machine.id === machineId);
    const selfRunnerId = machine ? mockDeviceMachine(machine).selfRunnerId : null;
    this.#screenConnections.delete(machineId);
    this.sessions = this.sessions.filter((session) => session.deviceId !== machineId);
    let snapshot = this.snapshot;
    for (const request of Object.values(snapshot.requests).flat()) {
      if (
        request.status !== "pending" ||
        request.payload.kind !== "device.access" ||
        request.payload.machineId !== machineId
      )
        continue;
      snapshot = this.settledRequestSnapshot(
        {
          ...request,
          status: "cancelled",
          cancellationReason: "resource-deleted",
          resolvedAt: this.now().toISOString(),
          resolvedBy: null,
          response: null,
        },
        snapshot,
      );
    }
    // The profiles that live on it go with it, as the Host deletes them.
    this.update({
      ...snapshot,
      browserProfileHomes: snapshot.browserProfileHomes?.filter((id) => id !== selfRunnerId),
      browserProfiles: snapshot.browserProfiles.filter(
        (profile) => selfRunnerId === null || profile.homeRunnerId !== selfRunnerId,
      ),
      machines: snapshot.machines
        .filter((machine) => machine.id !== machineId)
        .map((machine) =>
          machine.phoneDisplay?.driver?.role === "screen" &&
          machine.phoneDisplay.driver.runnerId === selfRunnerId &&
          machine.phoneDisplay.driver.attached
            ? this.detachedScreen(machine, machine.phoneDisplay.driver.generation + 1)
            : machine,
        ),
    });
  }

  async bindDeviceSession(machineId: string): Promise<void> {
    if (
      !this.snapshot.machines.some(
        (machine) =>
          machine.id === machineId &&
          mockDeviceMachine(machine).selfRunnerId !== null &&
          (machine.ownership === "mine" || machine.kind === "home"),
      )
    )
      throw new Error("Device not found");
    const session = this.sessions.find((entry) => entry.current);
    if (!session) throw new Error("Sign in first");
    if (session.deviceId && session.deviceId !== machineId)
      throw new Error("Session is already bound to another device");
    this.sessions = this.sessions.map((entry) =>
      entry.current ? { ...entry, deviceId: machineId } : entry,
    );
  }

  async revokeSession(sessionId?: string): Promise<void> {
    const bound = this.sessions.find((session) => session.id === sessionId)?.deviceId;
    const machine = this.snapshot.machines.find((entry) => entry.id === bound);
    if (machine?.revocable) await this.revokeMachine(machine.id);
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
  }

  async exchangeSetupToken(_token: string): Promise<void> {}

  async claimInitialOwner(): Promise<void> {
    await this.load();
  }

  async beginOidcSignIn(
    _providerId: string,
    _options?: { oauthQuery?: string; returnPath?: string },
  ): Promise<string> {
    return "https://identity.example.test/authorize";
  }

  /** The mock has no provider to revoke at, so it never claims that it did. */
  async disconnectIntegration(
    connectionId: string,
  ): Promise<Omit<CommandOutputOf<"integration.disconnect">, "type">> {
    const screen = [...this.#screenConnections.values()].find(({ id }) => id === connectionId);
    if (screen?.computer) {
      const deviceId = screen.computer.deviceId;
      this.#screenConnections.delete(deviceId);
      const unavailable = {
        state: "unavailable" as const,
        reason: { kind: "approval-required" as const },
      };
      this.update({
        ...this.snapshot,
        machines: this.snapshot.machines.map((machine) =>
          machine.id !== deviceId || !machine.phoneDisplay
            ? machine
            : {
                ...machine,
                phoneDisplay: {
                  ...machine.phoneDisplay,
                  view:
                    machine.phoneDisplay.view.state === "ready"
                      ? unavailable
                      : machine.phoneDisplay.view,
                  control:
                    machine.phoneDisplay.control.state === "ready"
                      ? unavailable
                      : machine.phoneDisplay.control,
                  input: unavailable,
                },
              },
        ),
      });
      this.endComputerUseSessions(deviceId, null);
      return { notice: null, revokedUpstream: false };
    }
    const timestamp = this.now().toISOString();
    const computerConnection = this.integrations.connections.find(
      (connection) => connection.id === connectionId && connection.computer !== null,
    );
    this.integrations.connections = this.integrations.connections.map((connection) =>
      connection.id === connectionId
        ? {
            ...connection,
            status: "revoked",
            statusDetail: "Disconnected from Opensteer.",
            statusReason: null,
            updatedAt: timestamp,
          }
        : connection,
    );
    // A computer app's tools exist only for the connection that materialised
    // them, so turning the app off takes them — and any grant's reach — with it.
    if (computerConnection) this.dropComputerAppTools(connectionId);
    const computer = computerConnection?.computer;
    if (computer) this.endComputerUseSessions(computer.runnerId, computer.app);
    return { notice: null, revokedUpstream: false };
  }

  reviewComputerAppSetup(setupRequestId: string) {
    const request = this.computerAppSetupRequests.get(setupRequestId);
    if (!request) throw new Error("This approval is no longer waiting.");
    this.ownedComputer(request.deviceId);
    return {
      request: this.legacyComputerSetupRequest(request),
      app: request.app
        ? {
            identity: request.app,
            allowed: true,
            path: `/Applications/${request.app.displayName}.app`,
            risk: "standard" as const,
            reason: null,
            running: false,
          }
        : null,
      name:
        request.app?.displayName ??
        request.server?.installationTitle ??
        mockIphoneAppDefinitions.find(({ id }) => id === request.definitionId)?.name ??
        request.definitionId,
    };
  }
  async respondComputerAppSetup(setupRequestId: string, decision: "allow" | "deny"): Promise<void> {
    const { request } = this.reviewComputerAppSetup(setupRequestId);
    if (decision === "deny") {
      this.cancelComputerAppSetup(setupRequestId);
      return;
    }
    if (request.kind === "server") {
      const device = this.devicePlugins.find(({ id }) => id === request.server?.launch.pluginId);
      if (!device) throw new Error("This mock has no local MCP executor.");
      // A device's server is only pretended to run: allowing it is all it waited for.
      this.computerAppSetupRequests.delete(setupRequestId);
      device.issue = null;
      this.update({ ...this.snapshot, machines: [...this.snapshot.machines] });
      return;
    }
    if (
      request.kind === "app" &&
      !this.integrations.installations.some(({ servers }) =>
        servers.some(
          ({ connectionRequirement }) =>
            connectionRequirement.kind === "computer" &&
            connectionRequirement.definitionId === request.definitionId,
        ),
      )
    ) {
      const catalog = this.integrations.catalog.find(
        ({ definition }) => definition.id === request.definitionId,
      );
      if (!catalog) throw new Error("This app is not in the catalog.");
      await this.installCatalogIntegration({
        definitionId: request.definitionId,
        digest: catalog.digest,
      });
    }

    await this.setComputerAppConnection(
      request.kind === "policy"
        ? { kind: "policy", appApproval: "automatic", runnerId: request.runnerId, setupRequestId }
        : {
            kind: "app",
            app: request.app,
            definitionId: request.definitionId,
            access: request.access,
            runnerId: request.runnerId,
            setupRequestId,
          },
    );
    this.update({ ...this.snapshot, machines: [...this.snapshot.machines] });
  }

  /** Seeds the device plugins, their setup tasks and what those tasks wait on; returns the tasks' Requests. */
  private seedDevices(): Request[] {
    const at = new Date(0).toISOString();
    for (const device of mockDevicePlugins()) {
      this.devicePlugins.push(device);
      this.integrations.installations.push(
        mockLocalServerInstallation({
          pluginId: device.id,
          name: device.id,
          title: device.name,
          installedBy: mockUserId,
          issue: device.issue,
        }),
      );
      const id = crypto.randomUUID();
      this.plugins.push({
        id: device.id,
        name: device.id,
        scope: "folder",
        source: { folderDirectory: `plugins/${device.id}` },
        currentVersionId: id,
        versions: [{ id, digest: id, manifest: { name: device.id, skills: [] } }],
        enabled: true,
        createdAt: at,
        updatedAt: at,
      });
    }
    const template = this.snapshot.threads.find(({ purpose }) => purpose === "task");
    if (!template) return [];
    for (const task of mockDeviceTasks) {
      this.#provisionalIcons.add(task.threadId);
      this.snapshot = {
        ...this.snapshot,
        threads: [
          ...this.snapshot.threads,
          {
            ...template,
            createdAt: task.at,
            icon: null,
            id: task.threadId,
            parentThreadId: null,
            pendingRequests: 0,
            status: "waiting",
            title: task.title,
            unread: false,
            updatedAt: task.at,
          },
        ],
        runQueue: [
          ...this.snapshot.runQueue,
          {
            createdAt: task.at,
            id: task.runId,
            runOrdinal: 0,
            status: "waiting",
            threadId: task.threadId,
          },
        ],
        transcriptWindows: {
          ...this.snapshot.transcriptWindows,
          [task.threadId]: {
            byteCount: 2,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            threadId: task.threadId,
            totalItems: 1,
          },
        },
        transcripts: {
          ...this.snapshot.transcripts,
          [task.threadId]: [
            {
              author: mockHumanAuthor(),
              body: task.body,
              createdAt: task.at,
              id: task.messageId,
              kind: "message",
              messageKind: "input",
              runId: null,
            },
            {
              createdAt: task.at,
              error: null,
              id: `run:${task.runId}`,
              kind: "run",
              replyMessageId: null,
              runId: task.runId,
              status: "waiting",
            },
          ],
        },
      };
    }
    const setup = mockLightsServerSetup(mockUserId, this.now());
    this.computerAppSetupRequests.set(
      setup.id,
      DeviceComputerAppSetupRequestReaderSchema.parse(setup),
    );
    return [mockTvPairingRequest(mockUserId), mockDeviceAccessRequest(mockUserId)];
  }

  private selfDeviceId(runnerId: string) {
    const machine = this.snapshot.machines.find(
      (machine) => mockDeviceMachine(machine).selfRunnerId === runnerId,
    );
    if (!machine) throw new Error("This Runner has no Device.");
    return DeviceIdSchema.parse(machine.id);
  }
  private legacyComputerSetupRequest(
    request: DeviceComputerAppSetupRequest,
  ): ComputerAppSetupRequest {
    const machine = this.snapshot.machines.find(({ id }) => id === request.deviceId);
    const runnerId = machine ? mockDeviceMachine(machine).selfRunnerId : null;
    if (!runnerId) throw new Error("This Device has no local app approval to review.");
    const { deviceId: _deviceId, ...rest } = request;
    return { ...rest, runnerId };
  }
  listComputerAppSetupRequests(): ComputerAppSetupRequest[] {
    return [...this.computerAppSetupRequests.values()].flatMap((request) => {
      const machine = this.snapshot.machines.find(({ id }) => id === request.deviceId);
      return Date.parse(request.expiresAt) > this.now().getTime() &&
        machine &&
        mockDeviceMachine(machine).selfRunnerId
        ? [this.legacyComputerSetupRequest(request)]
        : [];
    });
  }

  /**
   * One pending question per scope, as on the Host: an app on one computer, or
   * the automatic policy of one Mac. Asking again for the same access replays
   * the pending request; anything else replaces it.
   */
  requestComputerAppSetup(
    input: Extract<
      ParsedCommandOf<"integration.computer.setup.request">["input"],
      { runnerId: string }
    >,
  ): ComputerAppSetupRequest {
    if (input.kind === "app" && isPhoneDisplayDefinitionId(input.definitionId))
      throw mockBadRequest("Allow phone access from any Opensteer app.");
    const machine = this.ownedComputer(input.runnerId);
    if (
      machine.device?.platform === "ios" &&
      (input.kind === "policy" ||
        !this.integrationDefinition(input.definitionId)?.computerApp?.platforms.includes("ios"))
    )
      throw new Error("This app is not supported on an iPhone.");
    const scope =
      input.kind === "policy"
        ? {
            access: "read-write" as const,
            app: null,
            definitionId: mockComputerUseDefinition.id,
            kind: "policy" as const,
            policyAppApproval: "automatic" as const,
          }
        : {
            access: input.access,
            app: input.app,
            definitionId: input.definitionId,
            kind: "app" as const,
            policyAppApproval: null,
          };
    if (scope.kind === "policy" && machine.computerUse?.state !== "ready") {
      throw new Error(`Computer use is not set up on ${machine.name}.`);
    }
    const current = this.listComputerAppSetupRequests().find(
      (request) =>
        request.runnerId === input.runnerId &&
        request.kind === scope.kind &&
        request.definitionId === scope.definitionId &&
        sameMockApp(request.app, scope.app),
    );
    if (current?.access === scope.access) return current;
    if (current) this.computerAppSetupRequests.delete(current.id);
    const request: DeviceComputerAppSetupRequest = {
      ...scope,
      createdAt: this.now().toISOString(),
      definitionDigest: "mock-definition",
      deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
      expiresAt: new Date(this.now().getTime() + 7 * 86400000).toISOString(),
      id: crypto.randomUUID(),
      ownerUserId: mockUserId,
      reason: null,
      deviceId: DeviceIdSchema.parse(machine.id),
      server: null,
      threadId: null,
      threadTitle: null,
    };
    this.computerAppSetupRequests.set(request.id, request);
    this.update({ ...this.snapshot, machines: [...this.snapshot.machines] });
    return this.legacyComputerSetupRequest(request);
  }

  /** Cancelling a task's request declines it, as the Host settles it. */
  cancelComputerAppSetup(requestId: string): void {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find(
        (candidate) =>
          candidate.payload.kind === "computer.app.access" &&
          candidate.payload.setupRequestId === requestId,
      );
    if (request) this.settleComputerAppAccess(request, "declined");
    else this.computerAppSetupRequests.delete(requestId);
  }

  /** Applies owner-set phone access, a reduction or an exact pending request. */
  async setComputerAppConnection(
    input:
      | Extract<ParsedCommandOf<"integration.computer.setup.set">["input"], { runnerId: string }>
      | MockMacAnswer,
  ): Promise<IntegrationConnectionSummary | null> {
    if (input.kind === "policy") {
      const pending = this.computerAppSetupRequests.get(input.setupRequestId);
      if (
        !pending ||
        pending.kind !== "policy" ||
        pending.deviceId !== this.selfDeviceId(input.runnerId) ||
        Date.parse(pending.expiresAt) <= this.now().getTime()
      ) {
        throw new Error("Review automatic approval in Opensteer.");
      }
      this.computerAppSetupRequests.delete(pending.id);
      this.updateComputerUse(input.runnerId, (report) => ({ ...report, appApproval: "automatic" }));
      return null;
    }
    const definition = this.integrationDefinition(input.definitionId);
    if (!definition?.computerApp) throw new Error("That app is not in this catalog.");
    if (input.access === "read-write" && definition.computerApp.accessLevels.length < 2) {
      throw new Error(`${definition.name} can only be read.`);
    }
    const machine = this.ownedComputer(input.runnerId);
    if (!mockDeviceMachine(machine).phoneDisplay && machine.device?.platform === "ios") {
      this.ownedComputer(input.runnerId);
      if (!definition.computerApp.platforms.includes("ios"))
        throw new Error("This app is not supported on this computer.");
    }
    const phone =
      isPhoneDisplayDefinitionId(input.definitionId) &&
      input.app === null &&
      mockDeviceMachine(machine).phoneDisplay?.definitionId === input.definitionId;
    if (isPhoneDisplayDefinitionId(input.definitionId) && !phone) {
      throw new Error("That is not this device’s phone display connection.");
    }
    if (phone && "setupRequestId" in input) {
      throw new Error("Phone access is set by its owner in Opensteer.");
    }
    if (phone) this.ownedComputer(input.runnerId);
    const entry = this.integrations.installations.find(({ servers }) =>
      servers.some(
        ({ connectionRequirement }) =>
          connectionRequirement.kind === "computer" &&
          connectionRequirement.definitionId === input.definitionId,
      ),
    );
    if (!entry)
      throw new Error(`Ask an administrator to add ${definition.name} to this deployment.`);
    const timestamp = this.now().toISOString();
    const existing = this.integrations.connections.find(
      (connection) =>
        connection.definitionId === input.definitionId &&
        connection.computer?.runnerId === input.runnerId &&
        sameMockApp(connection.computer.app, input.app) &&
        connection.status !== "revoked",
    );
    const approval = "setupRequestId" in input ? input.setupRequestId : null;
    if (
      !phone &&
      (!existing ||
        existing.computer?.blockedAt !== null ||
        (existing.computer.access === "read" && input.access === "read-write") ||
        approval)
    ) {
      const pending = approval ? this.computerAppSetupRequests.get(approval) : undefined;
      if (
        !pending ||
        pending.kind !== "app" ||
        pending.deviceId !== this.selfDeviceId(input.runnerId) ||
        pending.definitionId !== input.definitionId ||
        !sameMockApp(pending.app, input.app) ||
        pending.access !== input.access ||
        Date.parse(pending.expiresAt) <= this.now().getTime()
      ) {
        throw new Error("Review this app access in Opensteer.");
      }
    }
    for (const request of this.computerAppSetupRequests.values()) {
      if (
        request.kind === "app" &&
        request.deviceId === this.selfDeviceId(input.runnerId) &&
        request.definitionId === input.definitionId &&
        sameMockApp(request.app, input.app) &&
        // Only what the new access covers is answered; a wider ask keeps waiting.
        (input.access === "read-write" || request.access === "read")
      ) {
        this.computerAppSetupRequests.delete(request.id);
        this.fulfilComputerAppAccessRequest(request.id);
      }
    }
    const computer = {
      access: input.access,
      app: input.app,
      blockedAt: null,
      policyRevision: existing?.computer?.policyRevision ?? null,
      runnerId: input.runnerId,
    };
    const displayName = input.app ? `${input.app.displayName} on ${machine.name}` : machine.name;
    const connection: IntegrationConnectionSummary = existing
      ? { ...existing, computer, displayName, status: "connected", updatedAt: timestamp }
      : {
          accountIdentifier: null,
          computer,
          connectionMethod: "computer",
          createdAt: timestamp,
          definitionId: definition.id,
          displayName,
          externalIdentityId: null,
          externalTenantId: null,
          id: createIntegrationId("connection"),
          provider: definition.provider,
          status: "connected",
          statusDetail: null,
          statusReason: null,
          updatedAt: timestamp,
        };
    this.integrations.connections = existing
      ? this.integrations.connections.map((candidate) =>
          candidate.id === connection.id ? connection : candidate,
        )
      : [...this.integrations.connections, connection];
    if (phone && existing?.computer?.access === "read-write" && input.access === "read") {
      this.endComputerUseSessions(input.runnerId, null);
    }
    this.dropComputerAppTools(connection.id);
    const serverId = entry.servers[0]!.id;
    this.integrations.installations = this.integrations.installations.map((candidate) =>
      candidate.installation.id === entry.installation.id
        ? {
            ...candidate,
            tools: [
              ...candidate.tools,
              ...mockComputerAppTools({
                access: input.access,
                connectionId: connection.id,
                definitionId: definition.id,
                serverId,
              }),
            ],
          }
        : candidate,
    );
    return connection;
  }

  /** Turning automatic off only narrows, so it needs no Mac and keeps every app. */
  async setComputerUsePolicy(runnerId: string): Promise<void> {
    this.ownedComputer(runnerId);
    for (const request of this.computerAppSetupRequests.values()) {
      if (request.kind === "policy" && request.deviceId === this.selfDeviceId(runnerId)) {
        this.computerAppSetupRequests.delete(request.id);
      }
    }
    this.updateComputerUse(runnerId, (report) => ({ ...report, appApproval: "ask" }));
  }

  /**
   * Keeps the connection so the app can be unblocked on that Mac, and takes
   * everything else: its tools, and any session using it.
   */
  async blockComputerApp(connectionId: string): Promise<void> {
    const connection = this.integrations.connections.find(
      (candidate) =>
        candidate.id === connectionId &&
        candidate.status !== "revoked" &&
        candidate.computer?.app != null,
    );
    const computer = connection?.computer;
    if (!connection || !computer?.app) throw new Error("That app is not approved on a Mac.");
    this.ownedComputer(computer.runnerId);
    const timestamp = this.now().toISOString();
    this.integrations.connections = this.integrations.connections.map((candidate) =>
      candidate.id === connectionId
        ? {
            ...candidate,
            computer: { ...computer, blockedAt: timestamp },
            status: "paused",
            updatedAt: timestamp,
          }
        : candidate,
    );
    this.dropComputerAppTools(connectionId);
    this.endComputerUseSessions(computer.runnerId, computer.app);
  }

  async stopComputerUseSession(sessionId: string): Promise<void> {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.computerUse
          ? {
              ...machine,
              computerUse: {
                ...machine.computerUse,
                sessions: machine.computerUse.sessions.filter(
                  (session) => session.sessionId !== sessionId,
                ),
              },
            }
          : machine,
      ),
    });
  }

  computerUseAppApproval(runnerId: string): "ask" | "automatic" {
    return this.ownedComputer(runnerId).computerUse?.appApproval ?? "ask";
  }

  /** The picker's listing, filtered and paged as the Mac does it. */
  listInstalledComputerApps(input: {
    readonly icons?: boolean | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
    readonly query?: string | undefined;
    readonly runnerId: string;
  }): {
    apps: ComputerUseInstalledApp[];
    total: number;
    unavailableReason?: "offline" | "not-ready";
  } {
    const machine = this.ownedComputer(input.runnerId);
    if (
      mockDeviceMachine(machine).phoneDisplay ||
      machine.selfRunnerId === null ||
      mockDeviceMachine(machine).kind === "phone"
    )
      throw new HostClientRequestError({
        code: "bad_request",
        status: 400,
        message: "Only an owned Mac can list Mac apps.",
      });
    if (machine.status !== "online") return { apps: [], total: 0, unavailableReason: "offline" };
    if (!machine.computerUse || machine.computerUse.state === "unavailable")
      return { apps: [], total: 0, unavailableReason: "not-ready" };
    const needle = (input.query ?? "").trim().toLowerCase();
    const sessionApps = machine.computerUse.sessions.flatMap((session) => session.apps);
    // What is open on the Mac is installed on it too.
    const installed = [
      ...mockInstalledApps,
      ...sessionApps.filter(
        (app, index) =>
          sessionApps.findIndex(
            (other) => other.bundleId.toLowerCase() === app.bundleId.toLowerCase(),
          ) === index &&
          !mockInstalledApps.some(
            (known) => known.bundleId.toLowerCase() === app.bundleId.toLowerCase(),
          ),
      ),
    ];
    const matches = installed.filter(
      (app) =>
        app.displayName.toLowerCase().includes(needle) ||
        app.bundleId.toLowerCase().includes(needle),
    );
    const offset = input.offset ?? 0;
    const running = new Set(sessionApps.map((app) => app.bundleId.toLowerCase()));
    return {
      apps: matches.slice(offset, offset + (input.limit ?? 50)).map((identity) => {
        const iconPng = input.icons ? mockAppIcons[identity.bundleId.toLowerCase()] : undefined;
        return {
          identity,
          ...(iconPng ? { iconPng } : {}),
          running: running.has(identity.bundleId.toLowerCase()),
        };
      }),
      total: matches.length,
    };
  }

  private ownedComputer(runnerId: string): MachineSummary {
    const machine = this.snapshot.machines.find((candidate) => candidate.id === runnerId);
    if (!machine || (machine.ownership !== "mine" && machine.ownership !== "deployment"))
      throw new Error("Only this computer’s owner can request app setup.");
    return machine;
  }

  private updateComputerUse(
    runnerId: string,
    change: (
      report: NonNullable<MachineSummary["computerUse"]>,
    ) => NonNullable<MachineSummary["computerUse"]>,
  ): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === runnerId && machine.computerUse
          ? { ...machine, computerUse: change(machine.computerUse) }
          : machine,
      ),
    });
  }

  /**
   * Taking an app back ends any session that holds it, as the Host does; a
   * phone's connection names no app, and taking it back ends the session
   * holding the phone's screen.
   */
  private endComputerUseSessions(runnerId: string, app: ComputerAppIdentity | null): void {
    this.updateComputerUse(runnerId, (report) => ({
      ...report,
      sessions: report.sessions.filter((session) =>
        app === null ? !session.display : !session.apps.some((held) => sameMockApp(held, app)),
      ),
    }));
  }

  /** An approval a task asked for fulfils that task's Request, as consume does on the Host. */
  private fulfilComputerAppAccessRequest(setupRequestId: string): void {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find(
        (candidate) =>
          candidate.payload.kind === "computer.app.access" &&
          candidate.payload.setupRequestId === setupRequestId,
      );
    if (request) this.settleComputerAppAccess(request, "fulfilled");
  }

  /**
   * Settles an agent's app request without ending its Run: the Run kept
   * working while it waited, and learns the answer as a continuation.
   */

  signInBrowserSession(
    command: Extract<HostApiCommand, { readonly type: "browser.session.sign-in" }>,
  ): BrowserSignInOutcome {
    const session = this.snapshot.browserSessions.find(({ id }) => id === command.sessionId);
    return this.chrome.signIn({
      profileName: this.#browserProfileName(session?.profileId ?? null),
      site: command.url,
      sourceId: command.sourceId,
      deploymentId: this.snapshot.deploymentId!,
    });
  }

  respondBrowserSignIn(
    command: Extract<HostApiCommand, { readonly type: "browser.sign-in.respond" }>,
  ): BrowserSignInOutcome | null {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find((candidate) => candidate.id === command.requestId);
    if (!request || request.status !== "pending" || request.payload.kind !== "browser.sign-in") {
      throw mockConflict("This sign-in Request is no longer waiting.");
    }
    if (command.decision.decision === "decline") {
      this.settleBrowserSignIn(request, "declined", { decision: "declined" });
      return null;
    }
    const session = this.snapshot.browserSessions.find(
      ({ id }) =>
        id === (request.payload.kind === "browser.sign-in" ? request.payload.sessionId : ""),
    );
    this.chrome.remember(
      this.snapshot.deploymentId!,
      request.payload.site,
      command.decision.sourceId,
    );
    const outcome = this.chrome.signIn({
      profileName: this.#browserProfileName(session?.profileId ?? null),
      site: request.payload.site,
      sourceId: command.decision.sourceId,
      deploymentId: this.snapshot.deploymentId!,
    });
    if (outcome.status === "applied") {
      this.settleBrowserSignIn(request, "fulfilled", {
        outcome: "applied",
        profileName: outcome.profileName,
        sourceName: outcome.sourceName,
      });
    }
    return outcome;
  }

  /**
   * Declines a saved-password sign-in from any device. The preview has no Mac
   * to race, so the decline always settles the Request.
   */
  readonly cardUseMockStates = new Map<
    string,
    "pending" | "changed" | "expired" | "declined" | "gone" | "no-card" | "off" | "not-set-up"
  >();

  passwordSignInCard(requestId: string): PasswordSignInCard {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find(({ id }) => id === requestId);
    if (
      !request ||
      request.status !== "pending" ||
      request.payload.kind !== "browser.password-sign-in" ||
      request.payload.permissionVersion !== 6
    )
      return { stage: "gone" };
    if (request.payload.credential === "card") {
      const state = this.cardUseMockStates.get(requestId) ?? "pending";
      if (
        ["expired", "declined", "gone", "off", "not-set-up"].includes(state) ||
        Date.parse(request.payload.expiresAt) <= this.now().getTime()
      )
        return { stage: "gone" };
      return {
        stage: "card-approval",
        permissionVersion: 7,
        cards:
          state === "no-card"
            ? []
            : [
                {
                  id: "00000000-0000-4000-8000-000000000042",
                  revision: state === "changed" ? 2 : 1,
                  brand: "Visa",
                  lastFour: "4242",
                  label: "Preview card",
                  expiryMonth: 12,
                  expiryYear: 2030,
                },
              ],
      };
    }
    return {
      stage: "approval",
      permissionVersion: 6,
      accounts: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          revision: 1,
          username: "passwords-preview@example.test",
          host: new URL(request.payload.site).hostname,
          onPage: false,
          updatedAt: request.createdAt,
          label: null,
        },
      ],
    };
  }

  respondPasswordSignIn(
    command: Extract<HostApiCommand, { readonly type: "browser.password-sign-in.respond" }>,
  ): { status: "declined" | "fulfilled" | "pending"; card?: PasswordSignInCard; message?: string } {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find((candidate) => candidate.id === command.requestId);
    if (
      !request ||
      request.status !== "pending" ||
      request.payload.kind !== "browser.password-sign-in"
    ) {
      throw mockConflict("This sign-in Request is no longer waiting.");
    }
    if (
      command.decision.kind !== "decline" &&
      (command.decision.kind === "approve-card") !== (request.payload.credential === "card")
    )
      throw mockConflict("Choose the matching credential.");
    if (command.decision.kind === "approve-card") {
      const choice = command.decision;
      const chooser = this.passwordSignInCard(request.id);
      if (
        chooser.stage !== "card-approval" ||
        !chooser.cards.some(
          (card) => card.id === choice.cardId && card.revision === choice.revision,
        )
      )
        return { status: "pending", card: chooser, message: "Choose a current saved card." };
      this.settleBrowserSignIn(request, "fulfilled", {
        outcome: "authorized",
        account: "Visa ending 4242",
      });
      return { status: "fulfilled" };
    }
    if (command.decision.kind === "approve") {
      const choice = command.decision;
      const card = this.passwordSignInCard(request.id);
      if (
        card.stage !== "approval" ||
        !card.accounts.some(
          ({ id, revision }) => id === choice.loginId && revision === choice.revision,
        )
      )
        throw mockConflict("Choose a current saved account.");
      this.settleBrowserSignIn(request, "fulfilled", {
        outcome: "authorized",
        account: "p•••@example.test",
      });
      return { status: "fulfilled" };
    }
    this.settleBrowserSignIn(request, "declined", { decision: "declined" });
    return { status: "declined" };
  }

  #browserProfileName(profileId: string | null): string | null {
    if (!profileId) return null;
    return this.snapshot.browserProfiles.find(({ id }) => id === profileId)?.name ?? null;
  }

  private settleBrowserSignIn(
    request: Request,
    status: "declined" | "fulfilled",
    value: Readonly<Record<string, string | null>>,
  ): void {
    const timestamp = this.now().toISOString();
    const resolved = ResolvedRequestSchema.parse({
      ...request,
      resolvedAt: timestamp,
      resolvedBy: mockUserId,
      response: { kind: "external", value },
      status,
    });
    this.update(this.settledRequestSnapshot(resolved));
  }

  private settledRequestSnapshot(
    resolved: Exclude<Request, { status: "pending" }>,
    snapshot = this.snapshot,
  ): HostSnapshot {
    const threadId = resolved.originatingThreadId;
    const request = resolved;
    return {
      ...snapshot,
      requests: {
        ...snapshot.requests,
        [threadId]: (snapshot.requests[threadId] ?? []).filter(
          (candidate) => candidate.id !== request.id,
        ),
      },
      threads: snapshot.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, pendingRequests: Math.max(0, thread.pendingRequests - 1) }
          : thread,
      ),
      transcripts: {
        ...snapshot.transcripts,
        [threadId]: [
          ...(snapshot.transcripts[threadId] ?? []),
          this.referenceRequestReceipt(resolved),
        ],
      },
    };
  }

  private settleComputerAppAccess(request: Request, decision: "declined" | "fulfilled"): void {
    const threadId = request.originatingThreadId;
    if (request.payload.kind === "computer.app.access") {
      this.computerAppSetupRequests.delete(request.payload.setupRequestId);
    }
    const resolved = this.#resolvedRequest(request, { kind: "external", value: { decision } });
    this.update({
      ...this.snapshot,
      requests: {
        ...this.snapshot.requests,
        [threadId]: (this.snapshot.requests[threadId] ?? []).filter(
          (candidate) => candidate.id !== request.id,
        ),
      },
      threads: this.snapshot.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, pendingRequests: Math.max(0, thread.pendingRequests - 1) }
          : thread,
      ),
      transcripts: {
        ...this.snapshot.transcripts,
        [threadId]: [
          ...(this.snapshot.transcripts[threadId] ?? []),
          this.referenceRequestReceipt(resolved),
        ],
      },
    });
  }

  private dropComputerAppTools(connectionId: string): void {
    this.integrations.installations = this.integrations.installations.map((entry) => ({
      ...entry,
      tools: entry.tools.filter((tool) => tool.connectionId !== connectionId),
    }));
  }

  async createIntegrationGrant(input: CreateIntegrationGrant): Promise<IntegrationGrant> {
    const entry = this.integrations.installations.find(
      ({ installation }) => installation.id === input.installationId,
    );
    if (!entry) throw new Error("Integration not found.");
    const grant: IntegrationGrant = {
      access: input.access,
      alias: input.alias,
      connectionId: input.connectionId,
      createdAt: this.now().toISOString(),
      id: createIntegrationId("grant"),
      installationId: input.installationId,
      isDefault: input.isDefault,
      ownerUserId: mockUserId,
      revokedAt: null,
      status: "active",
    };
    this.integrations.grants = [
      ...this.integrations.grants.filter(
        (candidate) =>
          candidate.installationId !== grant.installationId || candidate.alias !== grant.alias,
      ),
      grant,
    ];
    return grant;
  }

  private readonly preparedLocalRunners = new Map<string, string>();

  async createLocalRunnerEnrollment(
    name: string,
    access?: import("@opensteer/protocol").DeviceInitialAccess,
    preparedIdentity?: import("@opensteer/protocol").DevicePreparedIdentity,
  ) {
    const expiresAt = new Date(this.now().getTime() + 10 * 60_000).toISOString();
    const enrollmentId = `ren_${crypto.randomUUID()}`;
    if (preparedIdentity) this.preparedLocalRunners.set(enrollmentId, preparedIdentity.runnerId);
    this.update({
      ...this.snapshot,
      machines: [
        ...this.snapshot.machines,
        {
          access: access
            ? {
                activeSessions: [],
                ownerReachAvailable: true,
                revision: 1,
                policy: {
                  browser: access.browser,
                  apps: access.apps,
                  reach: access.files ? "owner" : "nobody",
                  commands: true,
                  forwarding: true,
                  shares: [],
                },
              }
            : null,
          // A row still waiting to connect has reported no apps either.
          apps: null,
          allowedModules: ["browser", "integrations", "messaging", "shell"],
          detail: null,
          device: null,
          enrollmentId,
          expiresAt,
          // A row that is still waiting to connect has reported nothing yet.
          computerUse: null,
          fullDiskAccess: null,
          kind: "computer",
          id: enrollmentId,
          lastSeenAt: null,

          modules: {
            browser: { checkedAt: null, detail: null, readiness: "unavailable" },
            integrations: { checkedAt: null, detail: null, readiness: "unavailable" },
            messaging: { checkedAt: null, detail: null, readiness: "unavailable" },
            shell: { checkedAt: null, detail: null, readiness: "unavailable" },
          },
          name,
          ownership: "mine",

          revocable: false,
          status: "pending",
          runtimeVersion: null,
        },
      ],
    });
    return {
      enrollmentId,
      expiresAt,
      token: `mock-local-runner-enrollment-token-${enrollmentId}`,
    };
  }

  /** The Runner a local enrollment token names connects, as a desktop's would. */
  connectLocalRunner(token: string): string {
    const enrollmentId = /ren_[0-9a-f-]{36}$/u.exec(token)?.[0];
    const pending = this.snapshot.machines.find((entry) => entry.id === enrollmentId);
    if (!pending) throw new Error("That enrollment is not waiting to connect.");
    const id = this.preparedLocalRunners.get(pending.id) ?? `rnr_${crypto.randomUUID()}`;
    this.preparedLocalRunners.delete(pending.id);
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((entry) =>
        entry === pending
          ? {
              ...entry,
              device: { form: "laptop", platform: "macos" },
              expiresAt: null,
              fullDiskAccess: false,
              id,
              lastSeenAt: this.now().toISOString(),
              revocable: true,
              status: "online",
            }
          : entry,
      ),
    });
    return id;
  }

  /** Null when the editor named a revision the preview has already moved past. */
  async updateMachineAccess(
    machineId: string,
    policy: MachineAccessPolicy,
    expectedRevision: number,
  ): Promise<number | null> {
    const machine = this.snapshot.machines.find((entry) => entry.id === machineId);
    if (!machine?.access || machine.access.revision !== expectedRevision) return null;
    if (machine.kind === "home" && !deviceAccess(policy).browser)
      throw new Error("Home's browser is always available to your agent.");
    const revision = machine.access.revision + 1;
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((entry) =>
        entry.id === machineId && entry.access
          ? {
              ...entry,
              access: {
                ...entry.access,
                policy: {
                  ...entry.access.policy,
                  ...policy,
                  browser: policy.browser ?? deviceAccess(entry.access.policy).browser,
                  apps: policy.apps ?? deviceAccess(entry.access.policy).apps,
                },
                revision,
              },
            }
          : entry,
      ),
    });
    const updatedMachine = this.snapshot.machines.find(({ id }) => id === machineId);
    if (updatedMachine?.phoneDisplay?.definitionId === "iphone-screen") {
      const enabled = deviceAccess(updatedMachine.access!.policy).apps;
      const availability = enabled
        ? updatedMachine.phoneDisplay.control.reason?.kind === "access-off"
          ? updatedMachine.phoneDisplay.view
          : updatedMachine.phoneDisplay.control
        : { state: "disabled" as const, reason: { kind: "access-off" as const } };
      this.update({
        ...this.snapshot,
        machines: this.snapshot.machines.map((machine) =>
          machine !== updatedMachine
            ? machine
            : {
                ...machine,
                capabilities: {
                  ...machine.capabilities!,
                  apps: { ...machine.capabilities!.apps, enabled, ...availability },
                },
                phoneDisplay: {
                  ...machine.phoneDisplay!,
                  control: availability,
                  view: machine.phoneDisplay!.view,
                  input:
                    this.#screenConnections.get(machineId)?.computer?.access === "read"
                      ? { state: "disabled", reason: { kind: "approval-required" } }
                      : machine.phoneDisplay!.view,
                },
                computerUse: { ...machine.computerUse!, sessions: [] },
              },
        ),
      });
    }
    const enabled = deviceAccess(
      this.snapshot.machines.find((entry) => entry.id === machineId)!.access!.policy,
    );
    for (const request of Object.values(this.snapshot.requests).flat()) {
      if (
        request.status === "pending" &&
        request.payload.kind === "device.access" &&
        request.payload.machineId === machineId &&
        enabled[request.payload.access]
      )
        await this.resolveRequest(
          {
            requestId: request.id,
            response: { kind: "external", value: { decision: "fulfilled" } },
          },
          true,
        );
    }
    return revision;
  }

  async renameMachine(machineId: string, name: string): Promise<void> {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === machineId ? { ...machine, name } : machine,
      ),
    });
  }

  /**
   * A phone's one-use enrollment, as the Host mints it: the phone may only
   * ever lend its screen, and the Host says where the phone reaches it.
   */
  /**
   * As the Host answers: a pending computer is retired by leaving the list,
   * one already connected was consumed, and one retired before has expired.
   */
  async retireRunnerEnrollment(enrollmentId: string): Promise<"consumed" | "expired" | "retired"> {
    const machine = this.snapshot.machines.find(
      (candidate) => candidate.enrollmentId === enrollmentId,
    );
    if (!machine) {
      if (this.retiredEnrollments.has(enrollmentId)) return "expired";
      throw new HostClientRequestError({
        code: "not_found",
        message: "Runner enrollment not found",
        status: rpcErrorStatus("not_found"),
      });
    }
    if (machine.status !== "pending") return "consumed";
    this.retiredEnrollments.add(enrollmentId);
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.filter((candidate) => candidate !== machine),
    });
    return machine.expiresAt !== null && Date.parse(machine.expiresAt) <= this.now().getTime()
      ? "expired"
      : "retired";
  }

  async createPhoneRunnerEnrollment(
    name: string,
    profile: "iphone" | undefined,
    idempotencyKey: string,
    access?: import("@opensteer/protocol").DeviceInitialAccess,
  ) {
    const existing = this.phoneEnrollments.get(idempotencyKey);
    if (existing) {
      if (
        existing.name !== name ||
        existing.profile !== (profile ?? null) ||
        JSON.stringify(existing.access) !== JSON.stringify(access)
      )
        throw mockConflict(
          "Idempotency key is already bound to a different Runner enrollment request",
        );
      return existing.result;
    }
    const expiresAt = new Date(this.now().getTime() + 10 * 60_000).toISOString();
    const enrollmentId = `ren_${crypto.randomUUID()}`;
    this.update({
      ...this.snapshot,
      machines: [
        ...this.snapshot.machines,
        {
          access: access
            ? {
                activeSessions: [],
                ownerReachAvailable: true,
                revision: 1,
                policy: {
                  browser: access.browser,
                  apps: access.apps,
                  reach: access.files ? "owner" : "nobody",
                  commands: true,
                  forwarding: true,
                  shares: [],
                },
              }
            : null,
          apps: null,
          allowedModules: ["browser", "integrations"],
          detail: null,
          device: profile === "iphone" ? { form: "phone", platform: "ios" } : null,
          enrollmentId,
          expiresAt,
          computerUse: null,
          fullDiskAccess: null,
          kind: "phone",
          id: enrollmentId,
          lastSeenAt: null,

          modules: {
            browser: { checkedAt: null, detail: null, readiness: "unavailable" },
            integrations: { checkedAt: null, detail: null, readiness: "unavailable" },
          },
          name,
          ownership: "mine",

          revocable: false,
          status: "pending",
          runtimeVersion: null,
        },
      ],
    });
    const result = {
      enrollmentId,
      expiresAt,
      pairing: mockAgentPhonePairingTarget,
      token: `mock-phone-runner-enrollment-token-${enrollmentId}`,
    };
    this.phoneEnrollments.set(idempotencyKey, { name, profile: profile ?? null, result, access });
    return result;
  }

  mockPhoneAway(runnerId: string): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === runnerId ? { ...machine, status: "offline" } : machine,
      ),
    });
  }

  mockConnectIphone(input: MockPhoneJoin): void {
    const enrollment = [...this.phoneEnrollments.values()].find(
      ({ result }) => result.enrollmentId === input.enrollmentId,
    );
    const pending = this.snapshot.machines.find(
      ({ id, status }) => id === input.enrollmentId && status === "pending",
    );
    if (
      enrollment?.profile !== "iphone" ||
      !pending ||
      Date.parse(enrollment.result.expiresAt) <= this.now().getTime()
    )
      throw new Error("That iPhone enrollment is unavailable.");
    const runnerId = RunnerIdSchema.parse(input.runnerId);
    this.update({
      ...this.snapshot,
      // A phone holds browsers too, as every device does.
      browserProfileHomes: this.snapshot.browserProfileHomes && [
        ...this.snapshot.browserProfileHomes,
        runnerId,
      ],
      machines: this.snapshot.machines.map((machine) =>
        machine.id === input.enrollmentId
          ? {
              ...machine,
              allowedModules: ["browser", "integrations"],
              id: runnerId,
              name: input.name,
              status: "online",
              expiresAt: null,
              revocable: true,
              device: {
                form: "phone",
                platform: input.platform ?? "ios",
                ...(input.platform === "android" ? { app: "opensteer" as const } : {}),
              },
              computerUse: null,
              lastSeenAt: this.now().toISOString(),
              apps: !(input.modules ?? ["integrations"]).includes("integrations")
                ? null
                : mockIphoneAppDefinitions.map((definition) => ({
                    definitionId: definition.id,
                    operations: definition.computerApp!.operations.map(({ name }) => ({
                      operation: name,
                      state: "ready",
                      detail: null,
                      remedy: null,
                    })),
                  })),
              modules: Object.fromEntries(
                (input.modules ?? ["integrations"]).map((module) => [
                  module,
                  { checkedAt: this.now().toISOString(), detail: null, readiness: "ready" },
                ]),
              ),
            }
          : machine,
      ),
    });
  }

  async createManagedRunnerEnrollment(name: string) {
    const enrollmentId = `ren_${crypto.randomUUID()}`;
    return {
      enrollmentId,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
      token: `mock-managed-runner-enrollment-token-${name}`,
    };
  }

  async loadChannels() {
    return {
      accessGrants: [],
      accounts: [],
      bindings: [],
      connections: [],
      deliveriesNeedingAttention: 0,
      providers: [...channelProviderCatalog],
    };
  }

  async loadIntegrations(): Promise<RpcData<"integrations.get">> {
    return {
      authorizationSurface: "canonical",
      connections: [
        ...this.integrations.connections,
        ...this.#screenConnections.values(),
      ] as RpcData<"integrations.get">["connections"],
      isAdministrator: true,
    };
  }

  async loadIntegrationPlatform(): Promise<RpcData<"integration.platform.get">> {
    return {
      authorizationSurface: "canonical",
      catalog: [...this.integrations.catalog],
      installations: [...this.integrations.installations],
    };
  }

  /** A device app installed from the catalog, as answering an access Request installs it. */
  async installCatalogIntegration(input: {
    readonly definitionId: string;
    readonly digest: string;
  }): Promise<RpcData<"integration.platform.get">["installations"][number]["installation"]> {
    const entry = this.integrations.catalog.find(
      ({ definition }) => definition.id === input.definitionId,
    );
    if (!entry) throw new Error("Integration not found.");
    if (entry.installationId !== null) {
      const existing = this.integrations.installations.find(
        ({ installation }) => installation.id === entry.installationId,
      );
      if (!existing) throw new Error("Integration installation not found.");
      return existing.installation;
    }
    // Installing resolves an OpenAPI preset's document, so the installation
    // carries the summary its snapshot discloses, not the catalog projection.
    const definition = mockIntegrationDefinitions.find(({ id }) => id === input.definitionId);
    if (!definition) throw new Error("Integration definition not found.");
    const installation = mockComputerAppInstallation({
      createdAt: this.now().toISOString(),
      definition,
      digest: entry.digest,
      installedBy: mockUserId,
      connections: [],
    });
    entry.installationId = installation.installation.id;
    this.integrations.installations.push(installation);
    return installation.installation;
  }

  async loadIntegrationGrants(_deploymentId: string): Promise<IntegrationGrant[]> {
    return this.integrations.grants;
  }

  async revokeIntegrationGrant(_deploymentId: string, grantId: string): Promise<void> {
    this.integrations.grants = this.integrations.grants.filter((grant) => grant.id !== grantId);
  }

  private integrationDefinition(definitionId: string): IntegrationDefinitionSummary | null {
    return (
      mockIntegrationDefinitions.find((definition) => definition.id === definitionId) ??
      this.integrations.catalog.find(({ definition }) => definition.id === definitionId)
        ?.definition ??
      null
    );
  }

  async createChannelConnection(
    _input: import("../host/client.js").CreateChannelConnectionInput,
  ): Promise<import("../host/client.js").CreatedChannelConnection> {
    throw new Error("The mock Host does not persist channel connections.");
  }

  async replaceChannelConnectionCredentials(
    _connectionId: string,
    _credentials: Readonly<Record<string, string>>,
  ): Promise<void> {}

  async checkChannelConnection(
    _connectionId: string,
  ): Promise<import("@opensteer/channel-core").ChannelConnectionInspection> {
    throw new Error("The mock Host does not persist channel connections.");
  }

  async createChannelBinding(
    _input: Omit<CommandInputOf<"channel.binding.create">, "idempotencyKey" | "type">,
  ): Promise<CommandOutputOf<"channel.binding.create">["binding"]> {
    throw new Error("The mock Host does not persist channel bindings.");
  }

  async revokeChannelBinding(_bindingId: string): Promise<void> {
    throw new Error("The mock Host does not persist channel bindings.");
  }

  async linkChannelIdentity(
    _code: string,
  ): Promise<Omit<CommandOutputOf<"channel.identity.link">, "type">> {
    throw new Error("The mock Host does not persist channel identities.");
  }

  async setChannelConnectionStatus(
    _connectionId: string,
    _status: "connected" | "paused" | "revoked",
  ): Promise<void> {}

  /** A person included this page in a message to the conversation, which now uses it. */
  includeBrowserPage(page: BrowserPageContentPart, threadId: string): void {
    const now = this.now().toISOString();
    let site = "";
    try {
      const url = new URL(page.url);
      site = url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
    } catch {
      // An address that does not parse names no site.
    }
    const use = {
      sessionId: page.sessionId,
      firstUsedAt: now,
      lastUsedAt: now,
      pageSite: site,
      pageTitle: page.title,
      runId: null,
      tabId: page.tabId,
      threadId,
    };
    const uses = this.snapshot.browserUses;
    const existing = uses.find(
      (held) =>
        held.sessionId === page.sessionId &&
        held.threadId === threadId &&
        held.runId === null &&
        held.tabId === page.tabId,
    );
    this.update({
      ...this.snapshot,
      browserUses: [
        ...uses.filter((held) => held !== existing),
        ...(uses.some((held) => held.sessionId === page.sessionId && held.threadId === threadId)
          ? []
          : [{ ...use, pageSite: null, pageTitle: null, tabId: null }]),
        { ...use, firstUsedAt: existing?.firstUsedAt ?? now },
      ],
    });
  }

  async startBrowser(
    _deploymentId: string,
    identity: import("../host/client.js").BrowserStartIdentity,
    placement?: import("../host/client.js").BrowserPlacementSummary,
    threadId?: string,
    _viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary> {
    const template = this.snapshot.browserSessions.find((session) => session.origin === "person");
    if (!template) throw new Error("Enable the seeded place fixture to start a browser.");
    if (
      identity.kind === "profile" &&
      !this.snapshot.browserProfiles.some((profile) => profile.id === identity.profileId)
    )
      throw new Error("The selected browser profile is unavailable.");
    const id = `bsn_00000000-0000-4000-8000-${String(900 + this.snapshot.browserSessions.length).padStart(12, "0")}`;
    const tab = {
      ...template.catalog!.tabs[0]!,
      id: BrowserSurfaceIdSchema.parse(`${id}-tab-0`),
      documentId: `${id}-document-0`,
      title: "New tab",
      site: "about:blank",
      occupants: [],
      openerId: null,
      order: 0,
      iconRef: null,
    };
    const session: BrowserSessionSummary = {
      ...template,
      id,
      createdAt: this.now().toISOString(),

      profileId: identity.kind === "profile" ? identity.profileId : null,
      placement: placement ? { kind: "runner", runnerId: placement.runnerId } : template.placement,
      threadIds: threadId ? [threadId] : [],
      attachedRunIds: [],
      acting: false,
      catalog: { generation: 1, revision: 1, tabs: [tab] },

      surfaces: [{ active: true, id: tab.id, title: tab.title, url: "about:blank" }],
      page: { title: "New tab", url: "about:blank" },
    };
    this.update({ ...this.snapshot, browserSessions: [...this.snapshot.browserSessions, session] });
    return session;
  }

  async closeBrowser(sessionId: string): Promise<void> {
    this.update({
      ...this.snapshot,
      browserSessions: this.snapshot.browserSessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              state: "closed",
              attachedRunIds: [],
              acting: false,
              ...(session.catalog
                ? {
                    catalog: {
                      ...session.catalog,
                      revision: session.catalog.revision + 1,
                      tabs: [],
                    },
                  }
                : {}),
            }
          : session,
      ),
    });
  }

  async createBrowserProfile(
    name: string,
    homeRunnerId?: string | null,
    preferredRunnerId?: string | null,
  ): Promise<import("../host/client.js").BrowserProfileSummary> {
    const homes = this.snapshot.browserProfileHomes;
    if (homeRunnerId != null && !homes?.includes(homeRunnerId))
      throw new HostClientRequestError({
        code: "forbidden",
        status: 403,
        message: "This computer can't keep browser profiles.",
      });
    const home =
      homeRunnerId ??
      homes?.find((id) => id === preferredRunnerId) ??
      homes?.find((id) =>
        this.snapshot.machines.some(
          (machine) => machine.id === id && machine.ownership === "deployment",
        ),
      ) ??
      (homes?.length === 1 ? homes[0]! : null);
    if (homes?.length === 0)
      throw new HostClientRequestError({
        code: "folder_unavailable",
        reason: "browser-placement-unavailable",
        status: rpcErrorStatus("folder_unavailable"),
        message: "No computer can hold your browser profiles.",
      });
    if (home === null && homeRunnerId === null && homes !== undefined)
      throw new HostClientRequestError({
        code: "conflict",
        reason: "browser-placement-ambiguous",
        status: 409,
        message: "Choose a computer for this browser profile.",
      });
    const profile = { homeRunnerId: home, id: createId("browserProfile"), name };
    this.update({ ...this.snapshot, browserProfiles: [...this.snapshot.browserProfiles, profile] });
    return profile;
  }

  dispose(): void {
    if (this.#pendingBrowserNotification !== null) clearTimeout(this.#pendingBrowserNotification);
    this.#pendingBrowserNotification = null;
    for (const timer of this.#titleTimers.values()) clearTimeout(timer);
    this.#titleTimers.clear();
    this.#provisionalTitles.clear();
    this.#provisionalIcons.clear();
    this.activeRuns.clear();
    this.runPlaces.dispose();
  }

  markConnected(): void {
    if (this.snapshot.connection !== "connected")
      this.update({ ...this.snapshot, connection: "connected" });
  }

  async load(): Promise<void> {
    if (this.snapshot.connection === "connected") return;
    if (this.latencyMs > 0) await delay(Math.min(this.latencyMs, 180));
    this.update({ ...this.snapshot, connection: "connected" });
  }

  goOffline(): void {
    this.update({ ...this.snapshot, connection: "offline" });
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  private allocateMarkColor(kind: "thread"): MarkColor {
    const key = `${this.snapshot.user?.id ?? mockUserId}:${kind}`;
    let recent = this.#recentMarkColors.get(key);
    if (!recent) {
      const held = this.snapshot.threads;
      recent = [...held]
        .sort((left, right) => {
          const leftAt = left.createdAt;
          const rightAt = right.createdAt;
          return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
        })
        .flatMap(({ color }) => (color === null ? [] : [color]))
        .slice(0, 6);
    }
    const color = nextMarkColor(recent);
    this.#recentMarkColors.set(key, [color, ...recent].slice(0, 6));
    return color;
  }

  renameThread(threadId: string, title: string): ThreadSummary {
    const thread = this.snapshot.threads.find((thread) => thread.id === threadId);
    if (!thread) throw new Error("Task not found.");
    this.#provisionalTitles.delete(threadId);
    this.publishThreadName(thread, { title: ThreadTitleSchema.parse(title) });
    return this.snapshot.threads.find((thread) => thread.id === threadId)!;
  }
  setThreadIcon(threadId: string, icon: IconName | null): ThreadSummary {
    const thread = this.snapshot.threads.find((thread) => thread.id === threadId);
    if (!thread) throw new Error("Task not found.");
    this.#provisionalIcons.delete(threadId);
    this.publishThreadName(thread, { icon: icon ?? defaultTaskSymbol });
    return this.snapshot.threads.find((thread) => thread.id === threadId)!;
  }

  /**
   * As the Host records it: a Run began acting in a tab other than the one it
   * entered last. Entering the same tab again records nothing.
   */
  enterPlace(runId: string, threadId: string, data: MockPlaceEntry): void {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) return;
    const transcript = this.snapshot.transcripts[threadId] ?? [];
    // The mock world names a page by its surface, which is its tab's ID, and a phone or app by its computer.
    const place = data.place;
    const tabId =
      place.kind === "browser"
        ? place.surfaceId
        : this.tabCatalog.nativeAt(place.machineId, (tab) =>
            place.kind === "phone"
              ? tab.kind === "phone"
              : tab.kind === "window" &&
                computerAppIdentityKey({
                  bundleId: tab.bundleId ?? "",
                  displayName: tab.appName ?? "",
                  teamId: null,
                }) === place.appKey,
          );
    if (!tabId) return;
    const last = this.runPlaces.get(runId);
    if (last?.data.tabId === tabId) return;
    const event = PlaceEnteredEventViewSchema.parse({
      createdAt: this.now().toISOString(),
      data: { tabId, title: data.title, site: data.site },
      environmentId: thread.environmentId,
      eventId: createId("event"),
      runId,
      sequence: String(++this.sequence),
      threadId,
      type: "place.entered",
    });
    this.runPlaces.accept(event, false);
    if (place.kind !== "browser") this.places?.actInNativeTab(runId, threadId, tabId);
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [threadId]: [
          ...transcript,
          {
            kind: "place",
            id: event.eventId,
            runId,
            createdAt: event.createdAt,
            ...event.data,
          },
        ],
      },
    });
  }

  private publishThreadName(
    thread: ThreadSummary,
    name: { readonly title?: string; readonly icon?: IconName },
  ): void {
    this.sequence = Math.max(this.sequence, this.snapshot.revision) + 1;
    const event = AgentEventSchema.parse({
      type: "thread.state-changed",
      eventId: createId("event"),
      threadId: thread.id,

      environmentId: thread.environmentId,
      runId: null,
      sequence: String(this.sequence),
      createdAt: this.now().toISOString(),
      data: {
        returnHint: thread.returnHint ?? null,
        title: name.title ?? thread.title,
        icon: name.icon ?? thread.icon,
        doneAt: thread.doneAt,
        doneReason: thread.doneReason,
        status: thread.status,
        inputQueuePaused: thread.inputQueuePaused,
        pendingRequests: thread.pendingRequests,
      },
    });
    if (event.type === "thread.state-changed") this.applyThreadStateChanged(event);
  }

  private generateThreadName(thread: ThreadSummary, body: string): void {
    if (
      (!this.#provisionalTitles.has(thread.id) && !this.#provisionalIcons.has(thread.id)) ||
      this.#titleTimers.has(thread.id)
    )
      return;
    const firstMessage = !(this.snapshot.transcripts[thread.id] ?? []).some(
      (entry) => entry.kind === "message" && entry.messageKind === "input",
    );
    if (!firstMessage || !body.trim()) return;
    const title = provisionalThreadTitle(body.trim().split(/\s+/u).slice(0, 5).join(" "));
    const icon = mockGeneratedTaskIcon(body);
    const timer = setTimeout(
      () => {
        this.#titleTimers.delete(thread.id);
        const titleEligible = this.#provisionalTitles.delete(thread.id);
        const iconEligible = this.#provisionalIcons.delete(thread.id);
        if (!titleEligible && !iconEligible) return;
        const current = this.snapshot.threads.find(({ id }) => id === thread.id);
        if (current)
          this.publishThreadName(current, {
            ...(titleEligible ? { title } : {}),
            ...(iconEligible ? { icon } : {}),
          });
      },
      Math.max(100, this.latencyMs),
    );
    this.#titleTimers.set(thread.id, timer);
  }

  /** The preview's Voice Thread, so its screens can be seen; a call itself never starts here. */
  async openVoiceThread(input: {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
  }): Promise<string> {
    if (this.snapshot.voiceThreadId) return this.snapshot.voiceThreadId;
    const placement = resolveThreadPlacement(
      this.snapshot.environments,
      this.snapshot.harnesses,
      input,
    );
    const thread = await this.createThread({
      ...input,
      accessMode: this.snapshot.executionPreferences.accessMode,
      modelSelection: placement.modelSelection,
      title: "Voice",
    });
    this.update({
      ...this.snapshot,
      voiceThreadId: thread.id,
      threads: this.snapshot.threads.map((item) =>
        item.id === thread.id ? { ...item, listed: false, purpose: "voice" } : item,
      ),
    });
    return thread.id;
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const placement = resolveThreadPlacement(
      this.snapshot.environments,
      this.snapshot.harnesses,
      input,
    );
    const timestamp = this.now().toISOString();
    const thread: ThreadSummary = {
      lastVisitedAt: null,
      latestRunCompletedAt: null,
      id: this.nextId("thread"),
      askedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      doneAt: null,
      doneReason: null,
      accessMode: input.accessMode,
      continuationIdentity: null,
      providerSessionId: createId("providerSession"),
      environmentId: placement.environmentId,
      harnessInstanceId: placement.harnessInstanceId,
      harnessLabel: placement.accountName,
      modelLabel: input.modelSelection.modelId,
      modelSelection: input.modelSelection,
      listed: input.parentThreadId === undefined,
      parentThreadId: input.parentThreadId ?? null,
      inputQueuePaused: false,
      pendingRequests: 0,
      purpose: "task",
      status: "idle",
      title: input.title?.trim() || "New task",
      icon: null,
      color: this.allocateMarkColor("thread"),
      unread: false,
      runnerLabel: placement.whereLabel,
    };
    if (input.generateTitle) this.#provisionalTitles.add(thread.id);
    this.#provisionalIcons.add(thread.id);
    this.update({
      ...this.snapshot,
      threads: [thread, ...this.snapshot.threads],
      requests: { ...this.snapshot.requests, [thread.id]: [] },
      transcripts: { ...this.snapshot.transcripts, [thread.id]: [] },
    });
    return thread;
  }

  /**
   * The mock is the Host here, so it folds a choice in with the one merge rule
   * the Host uses and answers with the whole record.
   */
  rememberExecution(choice: HostExecutionChoice): ExecutionPreferences {
    const preferences = rememberExecutionChoice(this.snapshot.executionPreferences, choice);
    this.update({ ...this.snapshot, executionPreferences: preferences });
    return preferences;
  }

  async updateThreadExecution(
    input: UpdateThreadExecutionInput & {
      continuation?: { expectedProviderSessionId: string | null } | undefined;
    },
  ): Promise<ThreadSummary> {
    const thread = this.snapshot.threads.find((item) => item.id === input.threadId);
    if (!thread) throw new Error("Thread not found.");
    if (
      this.snapshot.runQueue.some(
        (run) => run.threadId === input.threadId && run.status !== "queued",
      )
    )
      throw new Error("An active Run must finish before changing accounts.");
    if (
      input.continuation &&
      input.continuation.expectedProviderSessionId !== thread.providerSessionId
    )
      throw new Error("The selected session changed. Review the choice again.");
    const placement = resolveThreadPlacement(this.snapshot.environments, this.snapshot.harnesses, {
      environmentId: thread.environmentId,
      harnessInstanceId: input.harnessInstanceId,
    });
    const model = placement.models.find(
      (candidate) =>
        candidate.modelId === input.modelSelection.modelId &&
        candidate.providerId === input.modelSelection.providerId,
    );
    if (!model) throw new Error("That model is not available on this work location.");
    const incompatible = Boolean(
      thread.continuationIdentity &&
      (!placement.continuationIdentity ||
        !sameProviderContinuationIdentity(
          thread.continuationIdentity,
          placement.continuationIdentity,
        )),
    );
    if (incompatible && !input.continuation)
      throw new Error("Review this account change before continuing.");
    const harness = this.snapshot.harnesses.find((item) => item.id === input.harnessInstanceId);
    const updated: ThreadSummary = {
      ...thread,
      harnessInstanceId: input.harnessInstanceId,
      harnessLabel: harness?.name ?? thread.harnessLabel,
      providerSessionId: input.continuation
        ? createId("providerSession")
        : thread.providerSessionId,
      continuationIdentity: input.continuation ? null : thread.continuationIdentity,
      modelLabel: model.displayName,
      modelSelection: storedModelSelection(input.modelSelection, model),
      updatedAt: this.now().toISOString(),
    };
    this.publishThreadExecution(updated);
    return updated;
  }

  private publishThreadExecution(thread: ThreadSummary): void {
    const marker: TranscriptEntry = {
      kind: "selection",
      id: createId("event"),
      runId: null,
      createdAt: thread.updatedAt,
      harnessInstanceId: thread.harnessInstanceId,
      modelSelection: thread.modelSelection,
      providerSessionId: thread.providerSessionId,
    };
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((item) => (item.id === thread.id ? thread : item)),
      transcripts: {
        ...this.snapshot.transcripts,
        [thread.id]: [...(this.snapshot.transcripts[thread.id] ?? []), marker],
      },
    });
  }

  async updateThreadAccessMode(input: UpdateThreadAccessModeInput): Promise<ThreadSummary> {
    const thread = this.snapshot.threads.find((item) => item.id === input.threadId);
    if (!thread) throw new Error("Thread not found.");
    assertMockAccessModeEnforceable(
      threadPlacementOptions(this.snapshot.environments, this.snapshot.harnesses).find(
        (option) => option.harnessInstanceId === thread.harnessInstanceId,
      ) ?? null,
      input.accessMode,
    );
    const updated: ThreadSummary = {
      ...thread,
      accessMode: input.accessMode,
      updatedAt: this.now().toISOString(),
    };
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((item) => (item.id === thread.id ? updated : item)),
    });
    return updated;
  }

  /**
   * A human send always queues. On an idle, unpaused Thread the input seeds a
   * Run at once and the call waits for that turn, as the preview always has;
   * while a Run is in flight (or the queue is paused) the input only waits,
   * and finalization or resume admits it. The transcript carries the message
   * from the moment it is sent; the queue view is what hides it meanwhile.
   */
  async sendMessage(
    input: SendMessageInput & { quotedMessageId?: string; freshContext?: boolean },
  ): Promise<{ readonly input: ThreadInput; readonly message: Message; readonly run: Run | null }> {
    const body = input.body.trim();
    if (!body && !input.content?.some((part) => part.type !== "text"))
      throw new Error("Message body is required.");

    let thread = this.snapshot.threads.find((item) => item.id === input.threadId);
    if (!thread) throw new Error("Thread not found.");

    // As the Host does, a person's message reopens a Done task.
    if (thread.doneAt !== null) {
      if (!this.snapshot.quietTasksAvailable)
        throw mockConflict("This task is Done. Reopen it first.");
      thread = await this.setTaskDone(thread.id, false);
    }

    const quoted = input.quotedMessageId
      ? this.snapshot.threads
          .flatMap(
            (sourceThread) =>
              this.listThreadMessages({ threadId: sourceThread.id, limit: 100 }).messages,
          )
          .find((message) => message.id === input.quotedMessageId)
      : null;
    if (input.quotedMessageId && !quoted) throw new Error("The quoted message is unavailable.");
    const quote = quoted
      ? {
          messageId: quoted.id,
          threadId: quoted.threadId,
          author: quoted.author,
          excerpt: quoted.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .slice(0, 4000),
        }
      : null;

    const timestamp = this.now().toISOString();
    if (
      input.compaction === "compactFirst" &&
      thread.returnHint?.eligible &&
      this.snapshot.personalSettings?.idleCompactionPolicy?.mode !== "off" &&
      this.now().getTime() >= thread.returnHint.eligibleAt &&
      !thread.inputQueuePaused &&
      !this.snapshot.runQueue.some((run) => run.threadId === input.threadId)
    ) {
      const compactionRunId = this.nextId("run");
      const marker: TranscriptEntry = {
        error: null,
        replyMessageId: null,
        kind: "run",
        id: `run:${compactionRunId}`,
        runId: compactionRunId,
        createdAt: timestamp,
        status: "completed",
        compaction: { status: "created", reason: "before-send" },
      };
      const compactedThread = { ...thread, returnHint: null };
      thread = compactedThread;
      this.update({
        ...this.snapshot,
        threads: this.snapshot.threads.map((item) =>
          item.id === input.threadId ? compactedThread : item,
        ),
        transcripts: {
          ...this.snapshot.transcripts,
          [thread.id]: [...(this.snapshot.transcripts[thread.id] ?? []), marker],
        },
      });
    }
    const userEntry: TranscriptEntry = {
      author: mockHumanAuthor(),
      attachments: input.content?.filter((part) => part.type === "artifact") ?? [],
      pages: input.content?.filter((part) => part.type === "browser-page") ?? [],
      ...(input.content?.some((part) => part.type === "computer-app" || part.type === "phone")
        ? {
            places: input.content.filter(
              (part) => part.type === "computer-app" || part.type === "phone",
            ),
          }
        : {}),
      body,
      createdAt: timestamp,
      id: this.nextId("message"),
      kind: "message",
      messageKind: "input",
      policy: "queue",
      ...(quote ? { quote } : {}),
      runId: null,
    };
    const message: Message = MessageSchema.parse({
      author: userEntry.author,
      content: input.content ?? [{ text: body, type: "text" }],
      createdAt: timestamp,
      id: userEntry.id,
      kind: "input",
      ...(quote ? { quote } : {}),
      runId: null,
      sequence: String(++this.sequence),
      threadId: thread.id,
    });
    // A person's word to a task joins the work it is doing; otherwise it is
    // just a message in that Thread.
    const assignmentId = this.openAssignmentOf(thread.id)?.id ?? null;
    if (input.content) this.bindAttachments(input.content, thread.id, message.id);
    const threadInput: ThreadInput = ThreadInputSchema.parse({
      ...(input.freshContext ? { freshContext: true } : {}),
      assignmentId,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: timestamp,
      deliveredAt: null,
      messageId: message.id,
      policy: "queue",
      replyTarget: null,
      runId: null,
      state: "pending",
      threadId: thread.id,
      updatedAt: timestamp,
    });
    const pending: PendingMockInput = { body, input: threadInput, message };
    this.generateThreadName(thread, body);
    const joining = input.freshContext ? null : this.replyInProgress(thread, message.author);
    if (joining) {
      // In a conversation the person's message joins the reply in progress
      // where it was sent, and the Host answers with the Run it joined: no
      // placement, no queue.
      const { active: reply, run: joinedRun } = joining;
      const joined = this.joinedInput(pending, reply);
      reply.joined.push(joined);
      reply.steered.push(body);
      this.update(
        this.withInputQueue(
          {
            ...this.snapshot,
            threads: this.snapshot.threads.map((item) =>
              item.id === thread.id ? { ...item, askedAt: timestamp, updatedAt: timestamp } : item,
            ),
            transcripts: {
              ...this.snapshot.transcripts,
              [thread.id]: [
                ...(this.snapshot.transcripts[thread.id] ?? []),
                { ...userEntry, runId: reply.id },
              ],
            },
          },
          thread.id,
        ),
      );
      return { input: joined.input, message: joined.message, run: joinedRun };
    }
    const busy =
      thread.inputQueuePaused || this.snapshot.runQueue.some((run) => run.threadId === thread.id);
    if (busy) {
      this.threadInputQueues.set(thread.id, [
        ...(this.threadInputQueues.get(thread.id) ?? []),
        pending,
      ]);
    }
    const updated: ThreadSummary = { ...thread, askedAt: timestamp, updatedAt: timestamp };
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          threads: this.snapshot.threads.map((item) => (item.id === thread.id ? updated : item)),
          transcripts: {
            ...this.snapshot.transcripts,
            [thread.id]: [...(this.snapshot.transcripts[thread.id] ?? []), userEntry],
          },
        },
        thread.id,
      ),
    );
    if (busy) return { input: threadInput, message, run: null };

    const started = this.startRunFromInput(updated, pending);
    await started.execution;
    return { input: started.input, message: started.message, run: started.run };
  }

  /**
   * The reply a message joins, the way the Host decides it: only in a
   * conversation, only a person's message, only into a Run that person
   * started whose reply goes where an in-app message's does (back here, not
   * to a channel), and only while that Run is running rather than waiting on
   * an approval they have not answered. Anything else waits its turn.
   */
  private replyInProgress(
    thread: ThreadSummary,
    author: Message["author"],
  ): { readonly active: ActiveMockRun; readonly run: Run } | null {
    if (thread.purpose !== "voice" || author.kind !== "human") return null;
    const active = this.activeRuns.get(thread.id);
    const person = active?.person;
    if (!active || active.cancelled || !person) return null;
    if (person.requestedBy !== author.userId || person.replyTarget !== null) return null;
    const running = this.snapshot.runQueue.some(
      (run) => run.id === active.id && run.status === "running",
    );
    const awaiting = (this.snapshot.requests[thread.id] ?? []).some(
      (request) =>
        request.status === "pending" &&
        request.mode === "live" &&
        request.originatingRunId === active.id,
    );
    if (!running || awaiting) return null;
    return {
      active,
      run: RunSchema.parse({
        ...person,
        startedAt: person.startedAt ?? this.now().toISOString(),
        status: "running",
      }),
    };
  }

  /**
   * A Run the preview starts at work, as the Host would hold it: started by
   * the last person's message before it. Null when its transcript has none.
   */
  private seededPersonRun(run: RunQueueEntry): Run | null {
    const thread = this.snapshot.threads.find(({ id }) => id === run.threadId);
    const entries = this.snapshot.transcripts[run.threadId] ?? [];
    const at = entries.findIndex((entry) => entry.kind === "run" && entry.runId === run.id);
    const seed = entries
      .slice(0, at < 0 ? entries.length : at)
      .findLast(
        (entry) =>
          entry.kind === "message" &&
          entry.messageKind === "input" &&
          entry.author.kind === "human",
      );
    if (!thread || seed?.kind !== "message" || seed.author.kind !== "human") return null;
    // Some seeded transcripts carry ids no Host would issue; their Runs take no one's message.
    const parsed = RunSchema.safeParse({
      accessMode: thread.accessMode,
      activationInputId: seed.id,
      assignmentId: null,
      causalChainId: createId("causalChain"),
      completedAt: null,
      createdAt: run.createdAt,
      environmentId: thread.environmentId,
      failure: null,
      harnessInstanceId: thread.harnessInstanceId,
      id: run.id,
      modelSelection: thread.modelSelection,
      providerSessionId: thread.providerSessionId ?? createId("providerSession"),
      replyTarget: null,
      requestedBy: seed.author.userId,
      runOrdinal: run.runOrdinal,
      seedInputId: seed.id,
      startedAt: run.createdAt,
      status: run.status,
      threadId: run.threadId,
    });
    return parsed.success ? parsed.data : null;
  }

  private joinedInput(pending: PendingMockInput, run: ActiveMockRun): PendingMockInput {
    return {
      body: pending.body,
      input: ThreadInputSchema.parse({
        ...pending.input,
        runId: run.id,
        state: "claimed",
        updatedAt: this.now().toISOString(),
      }),
      message: MessageSchema.parse({ ...pending.message, runId: run.id }),
    };
  }

  /**
   * People's messages a conversation held while its reply could not take them
   * — it had not started, or waited on an approval — join it once it can, in
   * the order they were sent, each placed after everything said meanwhile.
   */
  private joinWaitingMessages(thread: ThreadSummary, run: ActiveMockRun): void {
    const { person } = run;
    if (thread.purpose !== "voice" || person === null) return;
    const waiting = (this.threadInputQueues.get(thread.id) ?? []).filter((item) =>
      sentBy(item, person),
    );
    if (waiting.length === 0) return;
    let entries = this.snapshot.transcripts[thread.id] ?? [];
    const barrierIndex = (this.threadInputQueues.get(thread.id) ?? []).findIndex(
      (item) => item.input.freshContext || this.liveLease(item.message.id) !== undefined,
    );
    const beforeBarrier = new Set(
      (this.threadInputQueues.get(thread.id) ?? []).slice(
        0,
        barrierIndex < 0 ? undefined : barrierIndex,
      ),
    );
    for (const item of waiting) {
      if (!beforeBarrier.has(item)) break;
      this.dropPendingInput(thread.id, item);
      run.joined.push(this.joinedInput(item, run));
      run.steered.push(item.body);
      entries = placeMockMessage(entries, item.message.id, run.id);
    }
    this.update(
      this.withInputQueue(
        { ...this.snapshot, transcripts: { ...this.snapshot.transcripts, [thread.id]: entries } },
        thread.id,
      ),
    );
  }

  private openAssignmentOf(threadId: string): AssignmentView | undefined {
    return [...this.assignments.values()].find(
      (assignment) => assignment.workerThreadId === threadId && assignment.status === "open",
    );
  }

  /**
   * The Host's assignment events as the preview projects them: the newest
   * summary on the card where the work was handed out and on the worker's own
   * entry. The snapshot's summaries follow on every update.
   */
  private publishAssignment(assignment: AssignmentView): void {
    this.assignments.set(assignment.id, assignment);
    const summary = this.assignmentSummary(assignment);
    const id = `assignment:${assignment.id}`;
    const entry = (threadId: string, runId: string | null): TranscriptEntry => ({
      assignment: summary,
      createdAt:
        (this.snapshot.transcripts[threadId] ?? []).find((item) => item.id === id)?.createdAt ??
        assignment.createdAt,
      id,
      kind: "assignment",
      runId,
    });
    this.upsertEntry(
      assignment.parentThreadId,
      entry(assignment.parentThreadId, assignment.parentRunId),
    );
    this.upsertEntry(assignment.workerThreadId, entry(assignment.workerThreadId, null));
  }

  /** A task's decision answered: its Run carries on from where it asked, as a live Request's does. */
  private resolveTaskRequest(request: Request, response: RequestResponse): void {
    const workerId = request.originatingThreadId;
    const assignment = this.openAssignmentOf(workerId);
    const script = assignment ? this.taskScripts.get(assignment.id) : undefined;
    const run = this.activeRuns.get(workerId);
    const resolved = this.#resolvedRequest(request, response);
    const accepted = resolved.status === "fulfilled";
    this.setTaskRunStatus(
      workerId,
      request.originatingRunId,
      "running",
      {
        requests: (this.snapshot.requests[workerId] ?? []).filter(({ id }) => id !== request.id),
      },
      this.referenceRequestReceipt(resolved),
    );
    if (!assignment || !script?.decision || !run) return;
    const outcome = accepted
      ? script
      : {
          ...script,
          answer: script.decision.declinedAnswer,
          result: script.decision.declinedResult,
        };
    this.taskScripts.set(assignment.id, outcome);
    void this.streamMockReply(workerId, run, outcome.result).then((current) => {
      if (current) this.endMockRun(workerId, run);
    });
  }

  private setTaskRunStatus(
    workerId: string,
    runId: string | null,
    status: "running" | "waiting",
    change: { readonly requests: readonly Request[] },
    receipt?: TranscriptEntry,
  ): void {
    const pendingRequests = change.requests.filter(
      (request) => request.status === "pending",
    ).length;
    this.update({
      ...this.snapshot,
      requests: { ...this.snapshot.requests, [workerId]: [...change.requests] },
      runQueue: this.snapshot.runQueue.map((entry) =>
        entry.id === runId ? { ...entry, status } : entry,
      ),
      threads: this.snapshot.threads.map((thread) =>
        thread.id === workerId ? { ...thread, pendingRequests, status } : thread,
      ),
      transcripts: {
        ...this.snapshot.transcripts,
        [workerId]: [
          ...(this.snapshot.transcripts[workerId] ?? []).map((entry) =>
            entry.kind === "run" && entry.runId === runId ? { ...entry, status } : entry,
          ),
          ...(receipt ? [receipt] : []),
        ],
      },
    });
  }

  /**
   * Implicit completion, as the Host decides it when a task's Run ends: with
   * nothing still owed — no decision, no queued word from the person — the
   * task is finished and its result is that Run's last reply.
   */
  private settleAssignment(
    threadId: string,
    runId: string,
    ended: "completed" | "interrupted",
  ): void {
    const assignment = this.openAssignmentOf(threadId);
    if (!assignment) return;
    const owed =
      ended === "interrupted" ||
      (this.snapshot.requests[threadId] ?? []).some(({ status }) => status === "pending") ||
      (this.threadInputQueues.get(threadId)?.length ?? 0) > 0;
    if (owed) {
      this.publishAssignment({
        ...assignment,
        revision: assignment.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      return;
    }
    const reply = mockRunReply(this.snapshot.transcripts[threadId] ?? [], runId);
    this.finishAssignment(assignment, {
      resultRunId: runId,
      resultText: reply ? reply.body.trim() || "The task ended without a written reply." : "",
      status: "completed",
    });
  }

  private finishAssignment(
    assignment: AssignmentView,
    outcome:
      | { readonly status: "cancelled" }
      | { readonly resultRunId: string; readonly resultText: string; readonly status: "completed" },
  ): void {
    const now = this.now().toISOString();
    const finished = AssignmentViewSchema.parse({
      ...assignment,
      ...outcome,
      finishedAt: now,
      revision: assignment.revision + 1,
      updatedAt: now,
    });
    if (
      finished.status === "completed" &&
      finished.resultText === "" &&
      finished.parentAssignmentId === null
    ) {
      this.publishAssignment({ ...finished, returnStatus: "delivered", returnMessageId: null });
      return;
    }
    this.publishAssignment(finished);
    this.deliverReturn(finished);
  }

  /**
   * Return delivery: the outcome goes back into the conversation that asked,
   * written for its model. A result starts that conversation's next turn; a
   * stop is only recorded there.
   */
  private deliverReturn(assignment: AssignmentView): void {
    const parent = this.snapshot.threads.find(({ id }) => id === assignment.parentThreadId);
    const worker = this.snapshot.threads.find(({ id }) => id === assignment.workerThreadId);
    if (!parent || !worker) return;
    const now = this.now().toISOString();
    const heading =
      assignment.status === "completed"
        ? "Task completed"
        : assignment.status === "failed"
          ? "Task failed"
          : "Task cancelled";
    const message = MessageSchema.parse({
      author: { cause: "assignment-result", kind: "platform", referenceId: assignment.id },
      content: [
        {
          text: [
            `${heading}: ${worker.title}`,
            `Task: ${worker.id} · Delegation: ${assignment.id}`,
            ...(assignment.resultText ? ["", assignment.resultText] : []),
          ].join("\n"),
          type: "text",
        },
      ],
      createdAt: now,
      id: this.nextId("message"),
      kind: "continuation",
      runId: null,
      sequence: String(++this.sequence),
      threadId: parent.id,
    });
    const report = assignment.status === "cancelled";
    this.upsertEntry(parent.id, {
      assignmentId: assignment.id,
      createdAt: now,
      id: message.id,
      kind: "assignment-return",
      runId: null,
      sequence: message.sequence,
    });
    this.publishAssignment({
      ...assignment,
      returnAttemptedAt: now,
      returnMessageId: message.id,
      returnStatus: "delivered",
      revision: assignment.revision + 1,
      updatedAt: now,
    });
    if (report) return;
    const pending: PendingMockInput = {
      body: "",
      input: ThreadInputSchema.parse({
        assignmentId: null,
        cancelReason: null,
        causalChainId: createId("causalChain"),
        createdAt: now,
        deliveredAt: null,
        messageId: message.id,
        policy: "queue",
        replyTarget: null,
        runId: null,
        state: "pending",
        threadId: parent.id,
        updatedAt: now,
      }),
      message,
    };
    if (
      parent.inputQueuePaused ||
      this.snapshot.runQueue.some((run) => run.threadId === parent.id)
    ) {
      this.threadInputQueues.set(parent.id, [
        ...(this.threadInputQueues.get(parent.id) ?? []),
        pending,
      ]);
      this.update(this.withInputQueue(this.snapshot, parent.id));
      return;
    }
    void this.startRunFromInput(parent, pending).execution;
  }

  private async executeTaskAnswer(
    thread: ThreadSummary,
    run: ActiveMockRun,
    assignmentId: string,
  ): Promise<void> {
    if (!this.beginMockRun(thread, run)) return;
    await delay(this.latencyMs);
    if (!this.isRunCurrent(thread.id, run)) return;
    const answer =
      this.taskScripts.get(assignmentId)?.answer ??
      "The task is done. Its full reply is in the task.";
    if (await this.streamMockReply(thread.id, run, answer)) this.endMockRun(thread.id, run);
  }

  private beginMockRun(thread: ThreadSummary, run: ActiveMockRun): boolean {
    if (!this.snapshot.runQueue.some((entry) => entry.id === run.id)) return false;
    this.activeRuns.set(thread.id, run);
    this.joinWaitingMessages(thread, run);
    const runEntry: RunEntry = {
      createdAt: this.now().toISOString(),
      error: null,
      id: `run:${run.id}`,
      kind: "run",
      replyMessageId: null,
      runId: run.id,
      status: "running",
    };
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue: this.snapshot.runQueue.map((entry) =>
            entry.id === run.id ? { ...entry, status: "running" } : entry,
          ),
          threads: this.snapshot.threads.map((item) =>
            item.id === thread.id ? { ...item, status: "running" } : item,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [thread.id]: [...(this.snapshot.transcripts[thread.id] ?? []), runEntry],
          },
        },
        thread.id,
      ),
    );
    return true;
  }

  /** Streams a reply into a draft and settles it as one message; false when the Run was stopped. */
  private async streamMockReply(
    threadId: string,
    run: ActiveMockRun,
    text: string,
  ): Promise<boolean> {
    // Writing its reply, the Run has read every message that joined it.
    run.joined.length = 0;
    const streamId = `stream:${run.id}`;
    const createdAt = this.now().toISOString();
    let body = "";
    for (const chunk of splitIntoChunks(text, 3)) {
      await delay(this.latencyMs / 3);
      if (!this.isRunCurrent(threadId, run)) return false;
      body = `${body}${chunk}`;
      this.upsertEntry(threadId, {
        author: mockAgentAuthor(run.id, threadId),
        body,
        createdAt,
        id: streamId,
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId: run.id,
        streaming: true,
      });
    }
    await delay(this.latencyMs / 3);
    if (!this.isRunCurrent(threadId, run)) return false;
    this.replaceEntryById(threadId, streamId, {
      author: mockAgentAuthor(run.id, threadId),
      body: text,
      createdAt,
      id: this.nextId("message"),
      kind: "message",
      messageKind: "assistant",
      published: true,
      runId: run.id,
      sequence: String(++this.sequence),
    });
    return true;
  }

  private endMockRun(threadId: string, run: ActiveMockRun): void {
    const answersPerson = this.openAssignmentOf(threadId) === undefined;
    this.activeRuns.delete(threadId);
    const now = this.now().toISOString();
    const runQueue = this.snapshot.runQueue.filter((entry) => entry.id !== run.id);
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue,
          threads: this.snapshot.threads.map((item) =>
            item.id === threadId
              ? {
                  ...item,
                  status: runQueue.some((entry) => entry.threadId === threadId)
                    ? "running"
                    : "idle",
                  updatedAt: now,
                }
              : item,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [threadId]: completeMockRun(
              finishRunEntries(this.snapshot.transcripts[threadId] ?? [], run.id, now),
              run.id,
            ),
          },
        },
        threadId,
      ),
    );
    this.settleAssignment(threadId, run.id, "completed");
    if (answersPerson) this.notifyReply(threadId, run.id);
    this.admitNextInput(threadId);
  }

  private notifyReply(threadId: string, runId: string): void {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    const reply = mockRunReply(this.snapshot.transcripts[threadId] ?? [], runId);
    if (!thread || !reply || false) return;
    const body = mockNotificationExcerpt(reply);
    if (!body) return;
    const notification = NotificationViewSchema.parse({
      body,
      id: createId("notification"),
      kind: "reply-published",
      messageId: reply.id,
      occurredAt: this.now().toISOString(),
      requestId: null,
      runId,
      threadId,
      title:
        threadId === this.snapshot.threads.find((thread) => thread.purpose === "background-job")?.id
          ? "Opensteer"
          : truncateMockText(thread.title, notificationTitleMaxCharacters),
      deploymentId: this.snapshot.deploymentId!,
    });
    for (const listener of this.notificationListeners) listener(notification);
  }

  async stopNode(threadId: string, nodeId: string): Promise<void> {
    const entries = this.snapshot.transcripts[threadId] ?? [];
    const node = entries.find((entry) => entry.kind === "node" && entry.nodeId === nodeId);
    if (node?.kind !== "node" || node.status !== "running" || !node.stopSupported || node.stopping)
      throw new Error("This subagent cannot be stopped.");
    const stoppingIds = new Set([nodeId]);
    if (node.nodeKind === "workflow") {
      for (const parentId of stoppingIds) {
        for (const entry of entries) {
          if (entry.kind === "node" && entry.parentNodeId === parentId)
            stoppingIds.add(entry.nodeId);
        }
      }
    }
    const stopping = entries.map((entry) =>
      entry.kind === "node" && stoppingIds.has(entry.nodeId) && entry.status === "running"
        ? { ...entry, stopping: true }
        : entry,
    );
    this.update({
      ...this.snapshot,
      transcripts: { ...this.snapshot.transcripts, [threadId]: stopping },
    });
    await Promise.resolve();
    const ended = stopping.map((entry) =>
      entry.kind === "node" && stoppingIds.has(entry.nodeId) && entry.status === "running"
        ? {
            ...entry,
            status: "interrupted" as const,
            stopping: false,
            completedAt: this.now().toISOString(),
          }
        : entry,
    );
    this.update({
      ...this.snapshot,
      transcripts: { ...this.snapshot.transcripts, [threadId]: ended },
    });
  }

  async stopRun(threadId: string, expectedRunId?: string): Promise<void> {
    const active = this.activeRuns.get(threadId);
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    // A seeded Run has no script behind it, but the Host interrupts any Run it
    // holds as executing, not only one it is driving.
    const runId =
      active?.id ??
      (thread ? threadStopTarget({ runQueue: this.snapshot.runQueue, thread })?.id : undefined);
    if (runId === undefined || (expectedRunId && runId !== expectedRunId))
      throw new Error("This Thread has nothing to stop.");
    if (active) active.cancelled = true;
    this.activeRuns.delete(threadId);

    const timestamp = this.now().toISOString();
    const runQueue = this.snapshot.runQueue.filter((entry) => entry.id !== runId);
    // In a conversation Stop ends this reply and nothing else: the messages

    // never paused, so the next Send starts a reply of its own.
    const conversation = thread?.purpose === "voice";
    const unsent = new Set<string>(
      conversation ? (active?.joined ?? []).map(({ message }) => message.id) : [],
    );
    const person = active?.person ?? null;
    if (conversation && person !== null) {
      for (const item of this.threadInputQueues.get(threadId) ?? []) {
        if (!sentBy(item, person)) continue;
        this.dropPendingInput(threadId, item);
        unsent.add(item.message.id);
      }
    }
    const stopped = threadInputDelivery({
      cancelReason: "stopped",
      policy: "queue",
      state: "cancelled",
    });
    const entries = finishRunEntries(this.snapshot.transcripts[threadId] ?? [], runId).map(
      (entry) =>
        entry.kind === "run" && entry.runId === runId && !isTerminalRunEntryStatus(entry.status)
          ? { ...entry, status: "interrupted" as const, stopping: false }
          : entry.kind === "message" && unsent.has(entry.id) && stopped
            ? { ...entry, delivery: stopped }
            : entry,
    );
    // An explicit stop of work pauses the queue on the Host, so queued work
    // does not start behind the person's back; nothing is admitted until they
    // resume.
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue,
          threads: this.snapshot.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  inputQueuePaused: conversation ? thread.inputQueuePaused : true,
                  status: runQueue.some((entry) => entry.threadId === threadId)
                    ? "running"
                    : "idle",
                  updatedAt: timestamp,
                }
              : thread,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [threadId]: entries,
          },
        },
        threadId,
      ),
    );
    this.settleAssignment(threadId, runId, "interrupted");
    if (conversation) this.admitNextInput(threadId);
  }

  /**
   * The Request as the Host records its answer: a decision to decline, or a
   * choice of an option that rejects or cancels, declines it; any other answer
   * fulfils it. Its receipt is then derived as the Host's event would be.
   */
  #resolvedRequest(request: Request, response: RequestResponse) {
    const option =
      response.kind === "choice" && request.presentation.kind === "choice"
        ? request.presentation.options.find(({ id }) => id === response.optionId)
        : undefined;
    const declined =
      (response.kind === "external" && response.value?.["decision"] === "declined") ||
      (option !== undefined && requestOptionDeclines(option));
    return ResolvedRequestSchema.parse({
      ...request,
      resolvedAt: this.now().toISOString(),
      resolvedBy: mockUserId,
      response,
      status: declined ? "declined" : "fulfilled",
    });
  }

  async resolveRequest(input: ResolveRequestInput, deviceAccessUpdated = false): Promise<void> {
    const request = Object.values(this.snapshot.requests)
      .flat()
      .find((candidate) => candidate.id === input.requestId);
    if (!request) throw new Error("The mock Host does not have that pending Request.");
    if (request.status !== "pending") throw new Error("The mock Request is no longer pending.");
    if (request.kind === "harness.approval" && this.openAssignmentOf(request.originatingThreadId)) {
      this.resolveTaskRequest(request, input.response);
      return;
    }
    if (request.kind === "browser.sign-in") {
      throw mockConflict("Answer a sign-in Request with Allow or Don’t allow.");
    }
    if (request.kind === "browser.password-sign-in") {
      throw mockConflict("Approve this sign-in on that Mac, or choose Don’t allow.");
    }
    if (request.presentation.kind === "form" && input.response.kind === "form") {
      const problem = requestFormAnswersProblem(
        request.presentation.fields,
        input.response.answers,
      );
      if (problem !== null) throw mockConflict(problem);
    }
    if (request.payload.kind === "device.access") {
      this.ownedComputer(request.payload.machineId);
      const value = input.response.kind === "external" ? input.response.value : undefined;
      if (request.requestedBy !== this.snapshot.user?.id)
        throw mockConflict("Only the device's owner can answer.");
      if (value?.decision !== "declined") {
        const payload = request.payload;
        const machine = this.snapshot.machines.find((entry) => entry.id === payload.machineId);
        if (
          !deviceAccessUpdated ||
          value?.decision !== "fulfilled" ||
          !machine?.access ||
          !deviceAccess(machine.access.policy)[request.payload.access]
        )
          throw mockConflict("Turn device access on through its access settings.");
      }
    }
    if (request.kind === "plugin.account") {
      // Linking an account is what fulfils it; the only direct answer is no.
      if (input.response.kind !== "external" || input.response.value?.["decision"] !== "declined")
        throw mockConflict("Link an account to answer this Request.");
      this.settleComputerAppAccess(request, "declined");
      return;
    }
    if (request.kind === "plugin.approval" || request.kind === "plugin.input") {
      this.settleComputerAppAccess(
        request,
        (input.response.kind === "choice" && input.response.optionId === "accept") ||
          (input.response.kind === "external" && input.response.value?.["action"] === "accept")
          ? "fulfilled"
          : "declined",
      );
      return;
    }
    if (request.kind === "computer.app.access") {
      // Only that Mac can approve; anywhere else the one answer is no.
      if (input.response.kind !== "external" || input.response.value?.["decision"] !== "declined") {
        throw new Error("Approve this app in Opensteer on that Mac.");
      }
      this.settleComputerAppAccess(request, "declined");
      return;
    }
    if (request.kind === "integration.access") {
      if (request.payload.kind !== "integration.access") {
        throw new Error("The mock integration access Request has an invalid payload.");
      }
      const accessPayload = request.payload;
      if (input.response.kind === "choice" && input.response.optionId === "installed") {
        if (accessPayload.installationId !== null || accessPayload.manifest === null) {
          throw new Error("This mock integration access Request is not waiting for installation.");
        }
        const manifest = accessPayload.manifest;
        if (manifest["kind"] !== "catalog") {
          throw new Error("The mock integration install manifest is invalid.");
        }
        const definition = manifest["definition"];
        const definitionId =
          typeof definition === "object" && definition !== null && !Array.isArray(definition)
            ? definition["id"]
            : null;
        const digest = manifest["digest"];
        if (typeof definitionId !== "string" || typeof digest !== "string") {
          throw new Error("The mock integration install manifest is invalid.");
        }
        const catalog = this.integrations.catalog.find(
          (candidate) => candidate.definition.id === definitionId && candidate.digest === digest,
        );
        if (!catalog) {
          throw new Error("The mock Host does not have this exact catalog integration version.");
        }
        const installation = await this.installCatalogIntegration({ definitionId, digest });
        this.#keepIntegrationAccessPending(request, {
          ...request.payload,
          installationId: installation.id,
          manifest: null,
        });
        return;
      }
      if (input.response.kind === "choice" && input.response.optionId.startsWith("server:")) {
        if (accessPayload.installationId === null || accessPayload.requestedServerId !== null) {
          throw new Error("This mock integration access Request is not waiting for a server.");
        }
        const serverId = input.response.optionId.slice("server:".length);
        const installation = this.integrations.installations.find(
          ({ installation }) => installation.id === accessPayload.installationId,
        );
        const server = installation?.servers.find(
          ({ id, status }) => id === serverId && status !== "disabled",
        );
        if (!server) throw new Error("The requested integration server was not found.");
        this.#keepIntegrationAccessPending(request, {
          ...request.payload,
          requestedServerId: server.id,
        });
        return;
      }
      const response = MainIntegrationAccessResponseSchema.parse(input.response);
      if (response.value.decision === "fulfilled") {
        this.#verifyMockIntegrationAccessFulfillment(request, response.value.connectionId);
      }
    }
    if (request.kind === "browser.access") {
      const response = input.response;
      if (request.requestedBy !== this.snapshot.user?.id)
        throw mockConflict("This Request belongs to someone else.");
      if (response.kind !== "external") throw mockConflict("Browser Request response is invalid.");
      const value = response.value;
      if (value?.["decision"] === "fulfilled") {
        let profileId: string;
        if (typeof value["profileId"] === "string") {
          profileId = value["profileId"];
          if (!this.snapshot.browserProfiles.some(({ id }) => id === profileId))
            throw mockConflict("Browser Profile is unavailable.");
        } else {
          const creation = CreateBrowserProfileBodySchema.parse(
            value["createProfile"] ?? { name: value["name"] },
          );
          const environmentId = this.snapshot.threads.find(
            ({ id }) => id === request.originatingThreadId,
          )?.environmentId;
          const preferred = this.snapshot.environments.find(
            ({ id }) => id === environmentId,
          )?.runnerId;
          profileId = (
            await this.createBrowserProfile(creation.name, creation.homeRunnerId, preferred)
          ).id;
        }
      } else if (value?.["decision"] !== "declined")
        throw mockConflict("Browser Request decision is invalid.");
    }
    const resolved = this.#resolvedRequest(request, input.response);
    const timestamp = resolved.resolvedAt;
    const runId = request.originatingRunId;
    const joined = this.answerHeldMessages(request.originatingThreadId, runId, timestamp);
    const transcript = [
      ...(this.snapshot.transcripts[request.originatingThreadId] ?? []),
      this.referenceRequestReceipt(resolved),
      ...joined,
    ];
    const originating = transcript.find((entry) => entry.kind === "run" && entry.runId === runId);
    const entries =
      runId !== null && originating?.kind === "run" && !isTerminalRunEntryStatus(originating.status)
        ? completeMockRun(transcript, runId)
        : transcript;
    const runQueue = this.snapshot.runQueue.filter(
      (entry) => entry.id !== request.originatingRunId,
    );
    this.activeRuns.delete(request.originatingThreadId);
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          requests: {
            ...this.snapshot.requests,
            [request.originatingThreadId]: (
              this.snapshot.requests[request.originatingThreadId] ?? []
            ).filter((candidate) => candidate.id !== request.id),
          },
          runQueue,
          threads: this.snapshot.threads.map((thread) =>
            thread.id === request.originatingThreadId
              ? {
                  ...thread,
                  pendingRequests: Math.max(0, thread.pendingRequests - 1),
                  status: runQueue.some((entry) => entry.threadId === request.originatingThreadId)
                    ? "running"
                    : "idle",
                  updatedAt: timestamp,
                }
              : thread,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [request.originatingThreadId]: entries,
          },
        },
        request.originatingThreadId,
      ),
    );
    // Answering the Request ends its Run in the preview, and a Run ending is
    // what admits the next queued message.
    this.admitNextInput(request.originatingThreadId);
  }

  /**
   * Answering the approval a conversation's reply waited on lets the messages
   * the person sent meanwhile join that reply. The preview's Run then finishes
   * at once, so its reply takes them in here, after them. Nothing for a work
   * Thread, whose queued messages wait for their own turn.
   */
  private answerHeldMessages(
    threadId: string,
    runId: string | null,
    at: string,
  ): TranscriptEntry[] {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    const active = this.activeRuns.get(threadId);
    if (thread?.purpose !== "voice" || runId === null || active?.id !== runId) return [];
    const { person } = active;
    if (person === null) return [];
    const held = (this.threadInputQueues.get(threadId) ?? []).filter((item) =>
      sentBy(item, person),
    );
    if (held.length === 0) return [];
    const placed: TranscriptEntry[] = [];
    for (const item of held) {
      this.dropPendingInput(threadId, item);
      placed.push(
        ...(this.snapshot.transcripts[threadId] ?? []).flatMap((entry) =>
          entry.id === item.message.id && entry.kind === "message" ? [{ ...entry, runId }] : [],
        ),
      );
    }
    const ids = new Set<string>(held.map(({ message }) => message.id));
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [threadId]: (this.snapshot.transcripts[threadId] ?? []).filter(({ id }) => !ids.has(id)),
      },
    });
    return [
      ...placed,
      {
        author: mockAgentAuthor(runId, threadId),
        body: [
          "Done.",
          ...held.map(({ body }) => `- Took in what you added while I waited: “${body}”`),
        ].join("\n"),
        createdAt: at,
        id: this.nextId("message"),
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId,
        sequence: String(++this.sequence),
      },
    ];
  }

  #keepIntegrationAccessPending(
    request: Extract<Request, { readonly status: "pending" }>,
    payload: Extract<Request["payload"], { readonly kind: "integration.access" }>,
  ): void {
    const updated = RequestSchema.parse({ ...request, payload });
    this.update({
      ...this.snapshot,
      requests: {
        ...this.snapshot.requests,
        [request.originatingThreadId]: (
          this.snapshot.requests[request.originatingThreadId] ?? []
        ).map((candidate) => (candidate.id === request.id ? updated : candidate)),
      },
    });
  }

  #verifyMockIntegrationAccessFulfillment(
    request: Extract<Request, { readonly status: "pending" }>,
    connectionId: string | null,
  ): void {
    if (request.payload.kind !== "integration.access" || request.payload.installationId === null) {
      throw new Error("Install the integration before fulfilling this mock access Request.");
    }
    const payload = request.payload;
    const installation = this.integrations.installations.find(
      ({ installation }) => installation.id === payload.installationId,
    );
    const server = installation?.servers.find(
      ({ id, status }) => id === payload.requestedServerId && status === "active",
    );
    if (!installation || !server) {
      throw new Error("Choose an active integration server before fulfilling this mock Request.");
    }
    if (payload.requestedConnectionId !== null && connectionId !== payload.requestedConnectionId) {
      throw new Error("The response does not name the exact account this mock Request asked for.");
    }
    const requirement = server.connectionRequirement;
    switch (requirement.kind) {
      case "none":
        return;
      case "computer": {
        const connected = this.integrations.connections.find(
          (connection) =>
            connection.id === connectionId &&
            connection.definitionId === requirement.definitionId &&
            connection.status === "connected" &&
            connection.computer !== null,
        );
        if (!connected) throw new Error("Choose the requested computer before granting access.");
        if (payload.access === "read-write" && connected.computer?.access !== "read-write") {
          throw new Error("The selected computer app allows reading only.");
        }
        return;
      }
    }
  }

  emit(): void {
    if (this.#pendingBrowserNotification !== null) clearTimeout(this.#pendingBrowserNotification);
    this.#pendingBrowserNotification = null;
    this.publishBrowser();
    for (const listener of this.listeners) listener();
  }

  /**
   * Simulates a full agent run against the new transcript model so the UI can
   * be developed against realistic entries: run lifecycle, streamed reasoning,
   * two structured tool calls, and a streamed assistant reply that is replaced
   * in place by the final markdown message.
   */
  private async executeMockRun(
    thread: ThreadSummary,
    run: ActiveMockRun,
    body: string,
  ): Promise<void> {
    if (!this.snapshot.runQueue.some((entry) => entry.id === run.id)) return;
    this.activeRuns.set(thread.id, run);
    this.joinWaitingMessages(thread, run);
    let runEntry: RunEntry = {
      createdAt: this.now().toISOString(),
      error: null,
      id: `run:${run.id}`,
      kind: "run",
      replyMessageId: null,
      runId: run.id,
      status: "running",
    };
    // Once the Run is running it is the one the queue offers Steer into.
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue: this.snapshot.runQueue.map((entry) =>
            entry.id === run.id ? { ...entry, status: "running" } : entry,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [thread.id]: [...(this.snapshot.transcripts[thread.id] ?? []), runEntry],
          },
        },
        thread.id,
      ),
    );

    if (this.replies === "scripted" && !(await this.streamMockWork(thread, run))) return;

    // The assistant reply streams into a draft, then the final markdown
    // message replaces the draft in place.
    const reply = buildAssistantReply(body, run.steered);
    // Writing its reply, the Run has read every message that joined it.
    run.joined.length = 0;
    const streamId = `stream:${run.id}`;
    let draft: MessageEntry = {
      author: mockAgentAuthor(run.id, thread.id),
      body: "",
      createdAt: this.now().toISOString(),
      id: streamId,
      kind: "message",
      messageKind: "assistant",
      published: true,
      runId: run.id,
      streaming: true,
    };
    if (this.replies === "scripted") {
      for (const chunk of splitIntoChunks(reply, 3)) {
        await delay(this.latencyMs / 3);
        if (!this.isRunCurrent(thread.id, run)) return;
        draft = { ...draft, body: `${draft.body}${chunk}` };
        this.upsertEntry(thread.id, draft);
      }
      await delay(this.latencyMs / 2);
      if (!this.isRunCurrent(thread.id, run)) return;
    }
    const assistantEntry: MessageEntry = {
      author: mockAgentAuthor(run.id, thread.id),
      body: reply,
      createdAt: this.now().toISOString(),
      id: this.nextId("message"),
      kind: "message",
      messageKind: "assistant",
      published: true,
      runId: run.id,
    };
    if (this.replies === "scripted") this.replaceEntryById(thread.id, streamId, assistantEntry);
    else this.upsertEntry(thread.id, assistantEntry);

    // The engine states what the turn consumed just before the Run ends.
    runEntry = {
      ...runEntry,
      replyMessageId: assistantEntry.id,
      status: "completed",
      usage: {
        cachedInputTokens: 12_760,
        cacheWriteTokens: 1_984,
        costUsd: 0.0873,
        inputTokens: 18_430,
        outputTokens: 1_265,
      },
    };
    const runQueue = this.snapshot.runQueue.filter((entry) => entry.id !== run.id);
    this.activeRuns.delete(thread.id);
    const entries = (this.snapshot.transcripts[thread.id] ?? []).map((entry) =>
      entry.id === runEntry.id ? runEntry : entry,
    );
    this.update(
      this.withInputQueue(
        {
          ...this.snapshot,
          runQueue,
          threads: this.snapshot.threads.map((item) =>
            item.id === thread.id
              ? {
                  ...item,
                  status: runQueue.some((entry) => entry.threadId === thread.id)
                    ? "running"
                    : "idle",
                  updatedAt: assistantEntry.createdAt,
                }
              : item,
          ),
          transcripts: {
            ...this.snapshot.transcripts,
            [thread.id]: entries,
          },
        },
        thread.id,
      ),
    );
    const answersPerson = this.openAssignmentOf(thread.id) === undefined;
    this.settleAssignment(thread.id, run.id, "completed");
    if (answersPerson) this.notifyReply(thread.id, run.id);
    // Finalization is what admits the next queued message; each gets its own turn.
    this.admitNextInput(thread.id);
  }
  /** A Run's scripted work before its reply: reasoning, a shell call and an edit, streamed. */
  private async streamMockWork(thread: ThreadSummary, run: ActiveMockRun): Promise<boolean> {
    // Reasoning streams a couple of sentences, then completes.
    let reasoning: ReasoningEntry = {
      createdAt: this.now().toISOString(),
      id: `reasoning:${run.id}:block-1`,
      kind: "reasoning",
      runId: run.id,
      state: "streaming",
      text: "",
    };
    const reasoningSentences = [
      "I should inspect the files before changing anything. ",
      "One shell check plus a focused edit will keep the run small and verifiable.",
    ];
    for (const sentence of reasoningSentences) {
      await delay(this.latencyMs / 2);
      if (!this.isRunCurrent(thread.id, run)) return false;
      reasoning = { ...reasoning, text: `${reasoning.text}${sentence}` };
      this.upsertEntry(thread.id, reasoning);
    }
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return false;
    this.upsertEntry(thread.id, { ...reasoning, state: "done" });

    // A shell tool call streams stdout lines, then completes with canonical output.
    let shell: ToolEntry = {
      arguments: { command: "rg --files src | head -n 3" },
      callId: "call-shell-1",
      createdAt: this.now().toISOString(),
      id: `tool:${run.id}:call-shell-1`,
      integration: null,
      isError: false,
      kind: "tool",
      output: undefined,
      runId: run.id,
      state: "running",
      streamText: "",
      tool: { name: "shell", namespace: "codex" },
    };
    this.upsertEntry(thread.id, shell);
    const stdoutLines = ["src/app.tsx\n", "src/host/client.ts\n", "src/host/transcript.ts\n"];
    for (const line of stdoutLines) {
      await delay(this.latencyMs / 3);
      if (!this.isRunCurrent(thread.id, run)) return false;
      shell = { ...shell, streamText: `${shell.streamText}${line}` };
      this.upsertEntry(thread.id, shell);
    }
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return false;
    this.upsertEntry(thread.id, {
      ...shell,
      output: { text: shell.streamText },
      state: "done",
    });

    // A second, edit-shaped tool call with a diff-ish payload.
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return false;
    const edit: ToolEntry = {
      arguments: {
        patch: "@@ -1,2 +1,3 @@\n # Notes\n+\n+- Recorded this run in the Thread.\n",
        path: "docs/notes.md",
      },
      callId: "call-edit-1",
      createdAt: this.now().toISOString(),
      id: `tool:${run.id}:call-edit-1`,
      integration: null,
      isError: false,
      kind: "tool",
      output: undefined,
      runId: run.id,
      state: "running",
      streamText: "",
      tool: { name: "apply_patch", namespace: "codex" },
    };
    this.upsertEntry(thread.id, edit);
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return false;
    this.upsertEntry(thread.id, {
      ...edit,
      output: { text: "Applied patch to docs/notes.md" },
      state: "done",
    });
    return true;
  }

  private isRunCurrent(threadId: string, run: ActiveMockRun): boolean {
    const current = this.activeRuns.get(threadId);
    return current?.id === run.id && !current.cancelled;
  }

  private nextId(prefix: "message" | "run" | "thread"): string {
    this.sequence += 1;
    return createId(prefix);
  }

  private upsertEntry(threadId: string, entry: TranscriptEntry): void {
    const entries = this.snapshot.transcripts[threadId] ?? [];
    const index = entries.findIndex((item) => item.id === entry.id);
    this.replaceTranscript(
      threadId,
      index < 0
        ? [...entries, entry]
        : entries.map((item, itemIndex) => (itemIndex === index ? entry : item)),
    );
  }

  private replaceEntryById(threadId: string, id: string, replacement: TranscriptEntry): void {
    const next = (this.snapshot.transcripts[threadId] ?? []).map((entry) =>
      entry.id === id ? replacement : entry,
    );
    this.replaceTranscript(threadId, next);
  }

  private replaceTranscript(threadId: string, entries: TranscriptEntry[]): void {
    const run = entries.findLast((entry) => entry.kind === "run");
    const completedAt =
      run?.kind === "run" && ["completed", "failed", "interrupted"].includes(run.status)
        ? (run.endedAt ?? run.createdAt)
        : null;
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              latestRunCompletedAt: completedAt,
              unread: isThreadUnread({ ...thread, latestRunCompletedAt: completedAt }),
            }
          : thread,
      ),
      transcripts: { ...this.snapshot.transcripts, [threadId]: entries },
    });
  }

  /** What a bootstrap tells this viewer about each account, as the Host computes it. */
  applyAutomaticEligibility(): void {
    const excludedAccounts = excludedBackgroundAccounts(this.agentHomeSettings);
    this.snapshot = {
      ...this.snapshot,
      harnesses: this.snapshot.harnesses.map(({ automaticEligible: _stale, ...harness }) =>
        harness.sourceId === "openai-compatible" ||
        excludedAccounts.includes(harness.id as (typeof excludedAccounts)[number])
          ? { ...harness, automaticEligible: false }
          : harness,
      ),
    };
  }

  private update(snapshot: HostSnapshot): void {
    if (
      snapshot.deploymentId !== this.snapshot.deploymentId ||
      snapshot.user?.id !== this.snapshot.user?.id ||
      snapshot.session !== "authenticated"
    ) {
      this.runPlaces.clear();
      this.referenceRequests.clear();
    }
    for (const run of this.snapshot.runQueue)
      if (!snapshot.runQueue.some((next) => next.id === run.id)) this.runPlaces.end(run.id, false);

    const tabsChanged = snapshot.browserSessions !== this.snapshot.browserSessions;
    if (tabsChanged) {
      const at = this.now().toISOString();
      const browserGroups: PersonalTabLineage[] = snapshot.browserSessions.map((session) => {
        const held = this.snapshot.browserGroups?.find((lineage) => lineage.id === session.id);
        return {
          id: BrowserSessionIdSchema.parse(session.id),
          revision: session.catalog?.revision ?? 0,
          createdAt: held?.createdAt ?? session.createdAt ?? at,
          session: HostedBrowserSessionSchema.parse({
            ...session,
            createdAt: session.createdAt ?? at,
            updatedAt: at,
          }),
          tabs: [
            ...(held?.tabs ?? []).filter(
              (tab) =>
                tab.state === "suspended" &&
                !session.catalog?.tabs.some((live) => live.id === tab.id),
            ),
            ...(session.catalog?.tabs ?? []).map((tab) => ({
              kind: "browser" as const,
              id: tab.id,
              sessionId: BrowserSessionIdSchema.parse(session.id),
              title: tab.title,
              site: tab.site,
              iconRef: tab.iconRef,
              order: tab.order,
              openerId: tab.openerId,
              state: "live" as const,
              createdAt:
                held?.tabs?.find((row) => row.id === tab.id)?.createdAt ??
                (held ? at : (session.createdAt ?? at)),
            })),
          ],
        } satisfies PersonalTabLineage;
      });
      browserGroups.push(
        ...(snapshot.browserGroups ?? []).filter(
          (group) =>
            !snapshot.browserSessions.some((session) => session.id === group.session.id) &&
            group.tabs?.some((tab) => tab.state !== "live"),
        ),
      );
      snapshot = { ...snapshot, browserGroups };
    }
    this.snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    if (this.assignments.size > 0) {
      this.snapshot = {
        ...this.snapshot,
        assignments: Object.fromEntries(
          [...this.assignments.values()].map((assignment) => [
            assignment.id,
            this.assignmentSummary(assignment),
          ]),
        ),
      };
    }
    this.snapshot = {
      ...this.snapshot,
      threadAutomations: Object.fromEntries(
        this.snapshot.threads.map((thread) => [
          thread.id,
          familyAutomations(this.listTriggers(undefined, thread.id), thread.id),
        ]),
      ),
    };
    const tasks = this.taskList(this.snapshot.tasks);
    this.snapshot = {
      ...this.snapshot,
      tasks,
      activeTasks: this.activeTaskEntries(tasks),
      waitingRequests: this.waitingRequests(),

      doneTasks: this.doneTaskLists(tasks, this.snapshot.doneTasks),
    };
    if (
      this.snapshot.connection === "connected" &&
      this.snapshot.user &&
      this.snapshot.session === "authenticated"
    ) {
      this.snapshot = {
        ...this.snapshot,
        savedViewReadiness: { tasksReady: true },
      };
    }
    this.snapshot = {
      ...this.snapshot,
      needsYou: mockNeedsYou(this.snapshot, undefined, this.needsYouLimit),
    };
    this.runPlaces.flush();
    this.emit();
  }

  private activeTaskEntries(tasks: TaskListState | null): readonly TaskEntry[] {
    const entries = (tasks?.entries ?? []).filter(
      ({ thread }) => thread.status === "running" || thread.status === "waiting",
    );
    const held = this.snapshot.activeTasks;
    return held.length === entries.length && held.every((entry, index) => entry === entries[index])
      ? held
      : entries;
  }

  /** The Done lists a screen asked for, by `doneTasks` key. */
  private readonly doneTaskScopes = new Set<string>();

  private needsYouLimit = 50;
  loadEarlierNeedsYou(): void {
    this.needsYouLimit += 50;
    this.snapshot = {
      ...this.snapshot,
      needsYou: mockNeedsYou(this.snapshot, undefined, this.needsYouLimit),
    };
    this.emit();
  }

  loadDoneTasks(deploymentId?: string): void {
    this.doneTaskScopes.add(deploymentId ?? mainDoneTasks);
    this.update(this.snapshot);
  }

  setIdleCompactionPolicy(policy: import("@opensteer/core").IdleCompactionPolicy): void {
    if (this.snapshot.personalSettings)
      this.update({
        ...this.snapshot,
        personalSettings: { ...this.snapshot.personalSettings, idleCompactionPolicy: policy },
      });
  }
  setQuietTaskDays(days: QuietTaskDays): void {
    this.update({ ...this.snapshot, quietTaskDays: days });
  }
  setOwnerProfileName(name: PersonName | null): OwnerProfileView {
    const ownerProfile = { name, accountBacked: false, version: null };
    this.update({ ...this.snapshot, ownerProfile });
    return ownerProfile;
  }

  /** Each asked-for Done list: the reader's Done tasks, newest Done first. */
  private doneTaskLists(
    tasks: TaskListState | null,
    _held: Record<string, TaskListState>,
  ): Record<string, TaskListState> {
    if (!tasks) return {};
    return {
      [mainDoneTasks]: {
        entries: tasks.entries.filter(({ thread }) => thread.doneAt !== null).sort(newestDone),
        window: mockWindow(tasks.entries.filter(({ thread }) => thread.doneAt !== null).length),
      },
    };
  }

  /**
   * What `tasks.list` answers, kept current with every change: each listed,
   * unarchived Thread, most recently updated first, with its last reply and
   * why its latest Run failed. The same list is kept while nothing in it moved.
   */
  // Every update rebuilds the list; parsing each reply's Markdown again cost ~0.4ms per task.
  private readonly lineExcerpts = new Map<string, string | null>();
  private lineExcerpt(text: string): string | null {
    const held = this.lineExcerpts.get(text);
    if (held !== undefined) return held;
    const excerpt = plainTextExcerpt(text, taskLineMaxLength);
    this.lineExcerpts.set(text, excerpt);
    return excerpt;
  }
  private taskList(held: TaskListState | null): TaskListState | null {
    if (!this.snapshot.user) return null;
    const entries = this.snapshot.threads
      .filter((thread) => thread.listed && thread.status !== "archived")
      .sort(compareTaskOrder)
      .map((thread): TaskEntry => {
        const transcript = this.snapshot.transcripts[thread.id] ?? [];
        const reply = transcript.findLast(
          (entry): entry is MessageEntry =>
            entry.kind === "message" &&
            entry.messageKind === "assistant" &&
            entry.streaming !== true &&
            (entry.body.trim() !== "" ||
              (entry.attachments?.length ?? 0) > 0 ||
              (entry.pages?.length ?? 0) > 0),
        );
        const latestRun = transcript.findLast((entry) => entry.kind === "run");
        return {
          failure:
            latestRun?.status === "failed" && latestRun.error
              ? this.lineExcerpt(latestRun.error.message)
              : null,
          lastReply: reply ? this.lineExcerpt(reply.body) : null,
          thread,
        };
      });
    const previous = new Map(held?.entries.map((entry) => [entry.thread.id, entry]));
    const kept = entries.map((entry) => {
      const before = previous.get(entry.thread.id);
      return before?.thread === entry.thread &&
        before.lastReply === entry.lastReply &&
        before.failure === entry.failure
        ? before
        : entry;
    });
    if (
      held?.entries.length === kept.length &&
      held.entries.every((entry, index) => entry === kept[index])
    )
      return held;
    return { entries: kept, window: mockWindow(kept.length) };
  }

  /**
   * What `requests.list` answers: every pending Request its reader is the one
   * to answer, with the handed-out work it holds up. A Thread here does one
   * task at a time, so the Run that asked belongs to its open task.
   */
  private waitingRequests(): WaitingRequestView[] {
    const user = this.snapshot.user;
    if (!user) return [];
    const byWorker = new Map(
      [...this.assignments.values()]
        .filter(({ status }) => status === "open")
        .map((assignment) => [assignment.workerThreadId, assignment]),
    );
    return Object.values(this.snapshot.requests)
      .flat()
      .filter(
        (request) =>
          request.status === "pending" &&
          (request.requiredActor === "requester"
            ? request.requestedBy === user.id
            : request.requiredActor === "owner"),
      )
      .map((request) => {
        const held: WaitingRequest["assignments"] = [];
        let assignment = byWorker.get(request.originatingThreadId);
        while (assignment) {
          const worker = this.snapshot.threads.find(({ id }) => id === assignment?.workerThreadId);
          held.push({
            id: AssignmentIdSchema.parse(assignment.id),
            parentThreadId: ThreadIdSchema.parse(assignment.parentThreadId),
            workerThread: {
              id: ThreadIdSchema.parse(assignment.workerThreadId),
              title: worker?.title ?? assignment.objective,
            },
          });
          assignment = assignment.parentAssignmentId
            ? this.assignments.get(assignment.parentAssignmentId)
            : undefined;
        }
        // As the Host does: the asking subagent, and the one it runs inside.
        const nodes = (this.snapshot.transcripts[request.originatingThreadId] ?? []).filter(
          (entry): entry is import("../host/client.js").NodeEntry => entry.kind === "node",
        );
        const asker = nodes.find(({ nodeId }) => nodeId === request.originatingNodeId);
        const within = asker?.parentNodeId
          ? nodes.find(({ nodeId }) => nodeId === asker.parentNodeId)
          : undefined;
        return {
          assignments: held,
          presentation: null,
          request: {
            ...PendingRequestSchema.parse(request),
            reviewedRevision: mockRequestRevision(request, String(this.snapshot.revision)),
          },
          subagent: asker
            ? {
                id: ExecutionNodeIdSchema.parse(asker.nodeId),
                title: asker.title,
                within: within
                  ? { id: ExecutionNodeIdSchema.parse(within.nodeId), title: within.title }
                  : null,
              }
            : null,
        };
      })
      .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt));
  }
}

/** Mirrors the Host's one-enabled-default rule; input order is creation order. */
function normalizeMockHarnessDefaults(
  harnesses: readonly HarnessSummary[],
  environmentId: string,
  driverKind: string,
  preferredId?: string,
): HarnessSummary[] {
  const group = harnesses.filter(
    (candidate) => candidate.environmentId === environmentId && candidate.driverKind === driverKind,
  );
  const chosen =
    group.find((candidate) => candidate.enabled && candidate.id === preferredId) ??
    group.find((candidate) => candidate.enabled && candidate.isDefault) ??
    group.find((candidate) => candidate.enabled);
  return harnesses.map((candidate) => {
    if (candidate.environmentId !== environmentId || candidate.driverKind !== driverKind) {
      return candidate;
    }
    const isDefault = candidate.id === chosen?.id;
    return candidate.isDefault === isDefault ? candidate : { ...candidate, isDefault };
  });
}

/**
 * The Host's rule, mirrored: a Thread is never held to an access mode its
 * engine has declared it cannot enforce.
 */
function assertMockAccessModeEnforceable(
  placement: ThreadPlacementOption | null,
  accessMode: ThreadAccessMode,
): void {
  if (!placement) return;
  const reason = accessModeUnavailableReason(accessMode, placement);
  if (reason !== null) throw new Error(`${reason}.`);
}

/**
 * The Host's admission and storage rules, mirrored: new choices must name
 * listed model options and values, and the native id comes from the catalog.
 */
function storedModelSelection(
  selection: ModelSelection,
  model: HarnessModelDescriptor,
): ModelSelection {
  if (matchModelSelection([model], selection, "refuse").kind !== "offered")
    throw new Error(`Model options are not available for ${model.displayName}`);
  return coreStoredModelSelection(selection, model);
}

function buildAssistantReply(prompt: string, steered: readonly string[] = []): string {
  const subject = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  return [
    "## What I did",
    "",
    `I worked through “${subject}” end to end on the main runner.`,
    "",
    "- Inspected the files before changing anything",
    "- Ran the checks in a sandboxed shell",
    "- Applied one focused patch and recorded it in this Thread",
    // A promoted message reached the Run mid-turn, so the reply says it was heard.
    ...steered.map((text) => `- Took in what you added while I worked: “${text}”`),
    "",
    "```ts",
    'export const runOutcome = { status: "completed", verified: true } as const;',
    "```",
    "",
    "You can inspect Files and Activity on the right.",
  ].join("\n");
}

function splitIntoChunks(value: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(value.length / Math.max(1, count)));
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

const mockLongToolOutput = [
  "August reconciliation report",
  "",
  "✓ Imported 142 card transactions",
  "✓ Matched 136 receipts automatically",
  "✓ Reconciled operating and travel accounts",
  "✓ Verified totals against the bank statement",
  "",
  "REVIEW  2026-08-12  Northstar Cloud     $1,284.00  Missing cost center",
  "REVIEW  2026-08-19  Harbor Conference     $684.20  Receipt total differs",
  "INFO    2026-08-21  Metro Rail              $48.75  Matched to travel",
  "INFO    2026-08-25  Studio Supplies        $219.40  Matched to design",
  "",
  "Subtotal reviewed: $2,236.35",
  "Remaining variance: $0.00",
  "Report written to reports/august.md",
].join("\n");

const mockSlackThreadId = "thr_00000000-0000-4000-8000-000000000005";
const mockSlackLiveThreadId = "thr_00000000-0000-4000-8000-000000000006";
/** A task whose Run failed, so the preview shows why a task stopped. */
const mockStatementsThreadId = "thr_00000000-0000-4000-8000-000000000007";
const mockStatementsRunId = "run_00000000-0000-4000-8000-000000000007";

/** A Thread that asked the agent to click through Slack on this Mac, settled or still clicking. */
function mockComputerUseThreadTranscript(
  threadId: string,
  runId: string,
  state: "running" | "settled",
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    {
      author: mockHumanAuthor(),
      body: "Ok can you click on the opensteer org in slack for me",
      createdAt: "2026-08-06T23:28:03.000Z",
      id: mockComputerUseMessageId(runId, "input"),
      kind: "message",
      messageKind: "input",
      runId: null,
    },
    {
      createdAt: "2026-08-06T23:28:03.500Z",
      error: null,
      id: `run:${runId}`,
      kind: "run",
      replyMessageId: null,
      runId,
      status: "running",
    },
    ...mockComputerUseTurn({
      agent: mockAgentAuthor(runId, threadId),
      place: mockSlackOnMacMini,
      runId,
      state,
    }),
  ];
  entries.splice(2, 0, {
    kind: "tool",
    id: `tool:${runId}:computer-code`,
    callId: "computer-code",
    runId,
    createdAt: "2026-08-06T23:28:10.500Z",
    completedAt: state === "settled" ? "2026-08-06T23:29:32.200Z" : null,
    tool: { name: "computer_use", namespace: "opensteer" },
    arguments: { code: "const slack = await app('Slack'); await slack.window().observe();" },
    integration: null,
    isError: false,
    state: state === "settled" ? "done" : "running",
    streamText: "",
    output: state === "settled" ? { text: "" } : undefined,
  });
  if (state === "settled") return completeMockRun(entries, runId);

  const latest = entries.at(-1);
  if (!latest) return entries;
  const offset = Date.now() - Date.parse(latest.createdAt) - 5_000;
  const shift = (time: string): string => new Date(Date.parse(time) + offset).toISOString();
  return entries.map((entry) =>
    "completedAt" in entry && typeof entry.completedAt === "string"
      ? { ...entry, completedAt: shift(entry.completedAt), createdAt: shift(entry.createdAt) }
      : { ...entry, createdAt: shift(entry.createdAt) },
  );
}

/**
 * A completed Run's reply, by the Host's rule: the last message its agent
 * wrote that says something.
 */
function mockRunReply(
  entries: readonly TranscriptEntry[],
  runId: string,
): MessageEntry | undefined {
  return entries.findLast(
    (entry): entry is MessageEntry =>
      entry.kind === "message" &&
      entry.messageKind === "assistant" &&
      entry.runId === runId &&
      entry.streaming !== true &&
      (entry.body.trim() !== "" || (entry.attachments?.length ?? 0) > 0),
  );
}

/** A reply's plain-text excerpt, as the Host words a notification about it. */
function mockNotificationExcerpt(reply: MessageEntry): string | null {
  const text = reply.body.replace(/\s+/g, " ").trim();
  if (text) return truncateMockText(text, notificationBodyMaxCharacters);
  const files = reply.attachments?.length ?? 0;
  if (files === 0) return null;
  return files === 1 ? "Sent a file" : `Sent ${files} files`;
}

/** Within `limit` UTF-16 units, the measure the schema bounds, never splitting a character. */
function truncateMockText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > limit - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

/** Ends a Run's entry as completed, naming its reply as the Host does. */
function completeMockRun(entries: readonly TranscriptEntry[], runId: string): TranscriptEntry[] {
  const replyMessageId = mockRunReply(entries, runId)?.id ?? null;
  return entries.map((entry) =>
    entry.kind === "run" && entry.runId === runId
      ? { ...entry, replyMessageId, status: "completed" }
      : entry,
  );
}

function firstRunWorld(snapshot: HostSnapshot): HostSnapshot {
  return {
    ...snapshot,
    activeTasks: [],
    assignments: {},
    browserSessions: [],
    browserUses: [],
    machines: snapshot.machines.map((machine) =>
      machine.computerUse
        ? { ...machine, computerUse: { ...machine.computerUse, sessions: [] } }
        : machine,
    ),
    requests: {},
    runQueue: [],
    threads: [],
    transcripts: {},
    transcriptWindows: {},
    waitingRequests: [],
  };
}

function withMockThreadMarks(
  threads: readonly (Omit<ThreadSummary, "icon" | "color" | "doneAt" | "doneReason" | "askedAt"> & {
    readonly doneAt?: string | null;
    readonly doneReason?: ThreadSummary["doneReason"];
  })[],
): ThreadSummary[] {
  return threads.map((thread, index) => ({
    ...thread,
    askedAt: thread.createdAt,
    doneAt: thread.doneAt ?? null,
    doneReason: thread.doneReason ?? null,
    icon: thread.purpose === "voice" ? null : mockGeneratedTaskIcon(thread.title),
    color: markColorAllocationOrder[index % markColorAllocationOrder.length]!,
  }));
}

function createInitialSnapshot(tabs: import("../host/tab-store.js").TabStore): HostSnapshot {
  const transcripts: Record<string, TranscriptEntry[]> = {
    [mockSlackThreadId]: mockComputerUseThreadTranscript(
      mockSlackThreadId,
      "run_00000000-0000-4000-8000-000000000005",
      "settled",
    ),
    [mockSlackLiveThreadId]: mockComputerUseThreadTranscript(
      mockSlackLiveThreadId,
      "run_00000000-0000-4000-8000-000000000006",
      "running",
    ),
    "thr_00000000-0000-4000-8000-000000000001": [
      {
        author: mockHumanAuthor(),
        body: "Build the new Opensteer foundation from scratch. Keep the architecture simple, make the Host authoritative, and keep Folder access explicit for each deployment profile.",
        createdAt: "2026-08-09T16:31:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000001",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        author: mockAgentAuthor(
          "run_00000000-0000-4000-8000-000000000001",
          "thr_00000000-0000-4000-8000-000000000001",
        ),
        body: "The foundation is taking shape around one clear rule: the Host owns durable truth, while Runners execute work in a task’s hosting computer.\n\nThe first slice includes:\n\n- versioned Host and Runner protocols\n- durable task records\n- a storage-neutral filesystem boundary\n- protected local-directory and storage adapters\n- harness-neutral run events\n- clients for web, desktop and mobile",
        createdAt: "2026-08-09T16:34:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000002",
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId: "run_00000000-0000-4000-8000-000000000001",
      },
      {
        createdAt: "2026-08-09T16:34:30.000Z",
        id: "reasoning:run_00000000-0000-4000-8000-000000000001:block-1",
        kind: "reasoning",
        runId: "run_00000000-0000-4000-8000-000000000001",
        state: "done",
        text: "Folder access is an explicit deployment capability, so local binding and storage authority contracts both need review before protocol work continues.",
      },
      {
        arguments: { path: "docs/architecture.md" },
        callId: "call-read-1",
        createdAt: "2026-08-09T16:35:00.000Z",
        id: "tool:run_00000000-0000-4000-8000-000000000001:call-read-1",
        integration: null,
        isError: false,
        kind: "tool",
        output: { text: "# Opensteer architecture\n\nThe Host owns durable product truth." },
        runId: "run_00000000-0000-4000-8000-000000000001",
        state: "done",
        streamText: "",
        tool: { name: "read_file", namespace: "mock" },
      },
      {
        arguments: { command: "pnpm typecheck && pnpm test" },
        callId: "call-shell-1",
        createdAt: "2026-08-09T16:37:00.000Z",
        id: "tool:run_00000000-0000-4000-8000-000000000001:call-shell-1",
        integration: null,
        isError: false,
        kind: "tool",
        output: { text: "protocol packages: 42 passed\n" },
        runId: "run_00000000-0000-4000-8000-000000000001",
        state: "done",
        streamText: "protocol packages: 42 passed\n",
        tool: { name: "shell", namespace: "codex" },
      },
      {
        author: mockCrossThreadAuthor(),
        body: "Launch brief is drafted. The positioning section still cites the old storage copy — flagging it here since the architecture thread owns the source of truth.",
        createdAt: "2026-08-09T16:38:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000011",
        kind: "message",
        messageKind: "input",
        policy: "report",
        runId: null,
      },
      {
        author: mockTriggerAuthor(),
        body: "Nightly check: run `pnpm typecheck` across the workspace and report any regressions in this thread.",
        createdAt: "2026-08-09T16:38:30.000Z",
        id: "msg_00000000-0000-4000-8000-000000000012",
        kind: "message",
        messageKind: "input",
        policy: "queue",
        runId: null,
      },
      {
        createdAt: "2026-08-09T16:39:00.000Z",
        error: null,
        id: "run:run_00000000-0000-4000-8000-000000000001",
        kind: "run",
        replyMessageId: null,
        runId: "run_00000000-0000-4000-8000-000000000001",
        status: "running",
      },
    ],
    "thr_00000000-0000-4000-8000-000000000002": [
      {
        author: mockHumanAuthor(),
        body: "Review the storage integration and identify the smallest contract Opensteer needs.",
        createdAt: "2026-08-09T13:03:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000006",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        author: mockAgentAuthor(
          "run_00000000-0000-4000-8000-000000000002",
          "thr_00000000-0000-4000-8000-000000000002",
        ),
        body: "Opensteer only needs an authority endpoint, a scoped mount grant, and lifecycle visibility. storage should remain unaware of Threads, harnesses, or credentials.\n\nSources: the [storage mount guide](https://storage.example/docs/mounts), the [old mirror](http://mirror.storage.example/docs) and my draft, [storage-contract.md](docs/storage-contract.md). Questions go to [storage@storage.example](mailto:storage@storage.example).\n\nThe local diagram is [mount-sequence.png](/Users/person/Opensteer/mount-sequence.png).\n\n![Mount sequence](/Users/person/Opensteer/mount-sequence.png)\n\n[![Grant flow](https://storage.example/images/grant-flow.png)](https://storage.example/docs/grants)",
        createdAt: "2026-08-09T13:08:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000007",
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId: "run_00000000-0000-4000-8000-000000000002",
      },
    ],
    "thr_00000000-0000-4000-8000-000000000003": [
      {
        author: mockHumanAuthor(),
        body: "Prepare the product launch brief and pull the latest positioning into one document.",
        createdAt: "2026-08-08T20:04:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000008",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        createdAt: "2026-08-08T20:04:30.000Z",
        error: null,
        id: "run:run_00000000-0000-4000-8000-000000000003",
        kind: "run",
        replyMessageId: null,
        runId: "run_00000000-0000-4000-8000-000000000003",
        status: "waiting",
      },
    ],
    ...Object.fromEntries(
      mockPluginTasks.map((task) => [
        task.threadId,
        [
          {
            author: mockHumanAuthor(),
            body: task.body,
            createdAt: task.createdAt,
            id: task.messageId,
            kind: "message" as const,
            messageKind: "input" as const,
            runId: null,
          },
          {
            createdAt: task.createdAt,
            error: null,
            id: `run:${task.runId}`,
            kind: "run" as const,
            replyMessageId: null,
            runId: task.runId,
            status: "waiting" as const,
          },
        ],
      ]),
    ),
    [mockStatementsThreadId]: [
      {
        author: mockHumanAuthor(),
        body: "Download the September statements for both company cards into statements/2026-09.",
        createdAt: "2026-08-08T09:30:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000013",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        createdAt: "2026-08-08T09:30:20.000Z",
        error: {
          code: "harness_error",
          message:
            "The bank asked for a code sent to your phone, and nobody was there to enter it.",
          retryable: true,
        },
        id: `run:${mockStatementsRunId}`,
        kind: "run",
        replyMessageId: null,
        runId: mockStatementsRunId,
        status: "failed",
      },
      {
        author: mockAgentAuthor(mockStatementsRunId, mockStatementsThreadId),
        body: "Signing in to the bank to fetch both statements.",
        createdAt: "2026-08-08T09:31:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000014",
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId: mockStatementsRunId,
      },
    ],
    "thr_00000000-0000-4000-8000-000000000004": [
      {
        author: mockHumanAuthor(),
        body: "Reconcile the August expenses and flag anything that needs my review.",
        createdAt: "2026-08-07T19:12:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000009",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        createdAt: "2026-08-07T19:13:00.000Z",
        id: "request:req_mock-expenses",
        kind: "request",
        outcome: "Fulfilled · Answered",
        requestId: "req_mock-expenses",
        requestKind: "harness.input",
        runId: "run_00000000-0000-4000-8000-000000000004",
        title: "More information needed",
      },
      {
        arguments: { command: "pnpm finance:reconcile --month 2026-08 --verbose" },
        callId: "call-long-output-1",
        createdAt: "2026-08-07T19:14:00.000Z",
        id: "tool:run_00000000-0000-4000-8000-000000000004:call-long-output-1",
        integration: null,
        isError: false,
        kind: "tool",
        output: { text: mockLongToolOutput },
        runId: "run_00000000-0000-4000-8000-000000000004",
        state: "done",
        streamText: mockLongToolOutput,
        tool: { name: "shell", namespace: "codex" },
      },
      {
        author: mockAgentAuthor(
          "run_00000000-0000-4000-8000-000000000004",
          "thr_00000000-0000-4000-8000-000000000004",
        ),
        body: [
          "## August reconciliation",
          "",
          "The books balance, and the full report is in `reports/august.md`. I matched 136 of 142 card transactions automatically and checked the remaining items against the bank statement.",
          "",
          "> Two charges still need a person to confirm their business purpose before the report is final.",
          "",
          "### Items to review",
          "",
          "| Date | Vendor | Amount | What is needed |",
          "| --- | --- | ---: | --- |",
          "| Aug 12 | Northstar Cloud | $1,284.00 | Choose the cost center |",
          "| Aug 19 | Harbor Conference | $684.20 | Confirm the receipt total |",
          "",
          "### Checks completed",
          "",
          "- Reconciled the operating and travel accounts",
          "- Verified that the remaining variance is **$0.00**",
          "- Kept both review items out of the final category totals",
          "- Saved the command output with the run for audit",
          "",
          "The [expense policy](https://example.com/finance/expense-policy) explains which cost center to use. Related request: [Review the remaining charges](opensteer://requests/req_0192f4a1-2222-4000-8000-000000000002).",
          "",
          "[example.com/finance/expense-policy](https://example.com/finance/expense-policy)",
          "",
          "```text",
          "review_items=2",
          "remaining_variance=0.00",
          "status=waiting-for-review",
          "```",
        ].join("\n"),
        createdAt: "2026-08-07T19:15:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000010",
        kind: "message",
        messageKind: "assistant",
        published: true,
        runId: "run_00000000-0000-4000-8000-000000000004",
      },
      {
        createdAt: "2026-08-07T19:15:00.000Z",
        error: null,
        id: "run:run_00000000-0000-4000-8000-000000000004",
        kind: "run",
        replyMessageId: "msg_00000000-0000-4000-8000-000000000010",
        runId: "run_00000000-0000-4000-8000-000000000004",
        status: "completed",
        usage: {
          cachedInputTokens: 31_402,
          cacheWriteTokens: 4_180,
          costUsd: 0.2914,
          inputTokens: 48_215,
          outputTokens: 3_902,
        },
      },
    ],
  };

  return {
    tabs,
    appsRevision: 0,
    assignments: {},
    threadAutomations: {},
    inputQueues: {},
    waitingRequests: [],
    // The mock holds every resource from the start.
    loadedResources: [...personalResourceKinds],
    requests: {
      [mockComputerUseThreadId]: [
        RequestSchema.parse({
          callId: "mock-computer-use-numbers",
          cancellationReason: null,
          createdAt: "2026-08-09T16:45:00.000Z",
          id: mockComputerUseRequestId,
          kind: "computer.app.access",
          mode: "durable",
          originatingOccurrenceId: null,
          originatingRunId: "run_00000000-0000-4000-8000-000000000001",
          originatingThreadId: mockComputerUseThreadId,

          payload: {
            access: "read-write",
            app: mockComputerUseApps.numbers,
            definitionId: "macos-app",
            kind: "computer.app.access",
            reason: mockComputerUseReason,
            runnerId: mockMessagesRunnerId,
            setupRequestId: mockComputerUseSetupRequestId,
          },
          presentation: {
            detail: `${mockComputerUseReason} Numbers on Mac mini — can see and control. Allow or decline from any Opensteer app.`,
            kind: "external",
            subject: { id: mockComputerUseSetupRequestId, kind: "computer-app-setup" },
            title: "Wants to use Numbers on Mac mini",
          },
          requestedBy: mockUserId,
          requiredActor: "owner",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
        }),
      ],
      "thr_00000000-0000-4000-8000-000000000002": [
        RequestSchema.parse({
          callId: "mock-release-plan",
          cancellationReason: null,
          createdAt: "2026-08-09T13:09:00.000Z",
          id: mockLongFormRequestId,
          kind: "harness.input",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: "run_00000000-0000-4000-8000-000000000002",
          originatingThreadId: "thr_00000000-0000-4000-8000-000000000002",

          payload: { kind: "harness.input" },
          presentation: {
            detail:
              "storage now has three backends and the integration suite covers each of them separately. Before the next release I need to know which of them to run, how long to let them run for, and who to tell when one of them fails. Everything below is remembered for the rest of this thread.",
            fields: [
              {
                choices: [
                  { label: "Local directory", value: "local-directory" },
                  { label: "storage over S3", value: "storage-s3" },
                  { label: "storage over GCS", value: "storage-gcs" },
                  { label: "storage over Azure Blob", value: "storage-azure" },
                  { label: "storage over the local verifier", value: "storage-verifier" },
                  { label: "Container overlay", value: "container-overlay" },
                ],
                custom: true,
                id: "backends",
                label: "Backends",
                multiSelect: true,
                prompt: "Which backends should the release suite cover?",
              },
              {
                choices: [
                  { label: "Ten minutes", value: "10m" },
                  { label: "Thirty minutes", value: "30m" },
                  { label: "One hour", value: "1h" },
                  { label: "Until it finishes", value: "unbounded" },
                ],
                custom: true,
                id: "budget",
                label: "Time budget",
                prompt: "How long may the suite run before I stop it?",
              },
              {
                id: "notify",
                label: "Who to tell",
                prompt: "Who should hear about a failure?",
              },
            ],
            kind: "form",
            title: "How should the release suite run?",
          },
          requestedBy: mockUserId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
        }),
      ],
      "thr_00000000-0000-4000-8000-000000000004": [
        RequestSchema.parse({
          callId: "mock-refund-question",
          cancellationReason: null,
          createdAt: "2026-08-07T19:20:00.000Z",
          id: mockPersonQuestionRequestId,
          kind: "person.question",
          mode: "durable",
          originatingOccurrenceId: null,
          originatingRunId: "run_00000000-0000-4000-8000-000000000004",
          originatingThreadId: "thr_00000000-0000-4000-8000-000000000004",
          payload: { kind: "person.question" },
          presentation: {
            detail:
              "```draft\nHi Northwind billing,\n\nYou charged our August design retainer twice, on Aug 3 and Aug 17 ($1,200 each, invoices NW-2291 and NW-2307). Could you refund the second charge to the card on file?\n\nThanks!\n```\n\nTo billing@northwind.example. I'll book the second charge as a receivable until it comes back.",
            fields: [
              {
                choices: [
                  {
                    description: "Email Northwind now and book the receivable",
                    label: "Send the refund request",
                    value: "Send the refund request",
                  },
                  {
                    description: "Keep it in this month's open items",
                    label: "Leave it for now",
                    value: "Leave it for now",
                  },
                ],
                custom: true,
                id: "question_1",
                multiSelect: false,
                prompt: "What should I do about the duplicate charge?",
                secret: false,
              },
            ],
            kind: "form",
            title: "Ask Northwind to refund the duplicate retainer?",
          },
          requestedBy: mockUserId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
        }),
      ],
      "thr_00000000-0000-4000-8000-000000000003": [
        RequestSchema.parse({
          callId: "mock-launch-approval",
          cancellationReason: null,
          createdAt: "2026-08-08T20:05:00.000Z",
          id: mockPendingRequestId,
          kind: "harness.approval",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: "run_00000000-0000-4000-8000-000000000003",
          originatingThreadId: "thr_00000000-0000-4000-8000-000000000003",

          payload: { kind: "harness.approval" },
          presentation: {
            detail: "Send briefs/launch.md to the external announcement list.",
            kind: "choice",
            options: [
              { hint: "allow-once", id: "allow-once", label: "Allow once" },
              { hint: "reject-once", id: "reject", label: "Reject" },
            ],
            risk: "medium",
            title: "Send the launch email",
          },
          requestedBy: mockUserId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
        }),
      ],
      ...Object.fromEntries(
        mockPluginTasks.map((task) => [task.threadId, [mockPluginRequest(task)]]),
      ),
    },
    // The Host calls a Thread running or waiting only while a Run of it is,
    // so every seeded Thread at work holds that Run here too.
    runQueue: [
      {
        createdAt: "2026-08-09T16:39:00.000Z",
        id: "run_00000000-0000-4000-8000-000000000001",
        status: "running",
        threadId: "thr_00000000-0000-4000-8000-000000000001",
        runOrdinal: 0,
      },
      {
        createdAt: "2026-08-09T13:08:00.000Z",
        id: "run_00000000-0000-4000-8000-000000000002",
        status: "waiting",
        threadId: "thr_00000000-0000-4000-8000-000000000002",
        runOrdinal: 0,
      },
      {
        createdAt: "2026-08-08T20:04:30.000Z",
        id: "run_00000000-0000-4000-8000-000000000003",
        status: "waiting",
        threadId: "thr_00000000-0000-4000-8000-000000000003",
        runOrdinal: 0,
      },
      {
        createdAt: "2026-08-06T23:28:03.500Z",
        id: "run_00000000-0000-4000-8000-000000000006",
        status: "running",
        threadId: mockSlackLiveThreadId,
        runOrdinal: 0,
      },
      ...mockPluginTasks.map((task) => ({
        createdAt: task.createdAt,
        id: task.runId,
        status: "waiting" as const,
        threadId: task.threadId,
        runOrdinal: 0,
      })),
    ],
    browserAvailable: false,
    browserPlacements: [],
    browserProfiles: [],
    browserSessions: [],
    browserUses: [],
    connection: "connecting",
    connectionInterrupted: false,
    network: "unknown",
    deploymentShape: { kind: "personal" },
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    sessionId: createId("authSession"),
    personalSettings: { ownerId: mockUserId, agentHome: mockPersonalFolder, voiceThreadId: null },
    can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
    needsYou: null,
    environments: [
      {
        can: { executeTasks: true },
        capabilities: ["filesystem", "container", "network-egress"],
        connected: true,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [
          mockCodexCatalog,
          mockCodexSecondCatalog,
          mockOpenRouterCatalog,
          mockClaudeCatalog,
          mockOpencodeCatalog,
          mockPiCatalog,
          mockCursorCatalog,
        ],
        harnessDrivers: [
          {
            accessModes: [...mockEveryAccessMode],
            driverKind: "codex",
            installation: {
              latestVersion: "0.166.0",
              scope: "ambient",
              update: "available",
              version: "0.163.0",
            },
            readiness: "runtime-check",
            sources: [...mockCodexSources],
          },
          {
            accessModes: [...mockEveryAccessMode],
            driverKind: "claude",
            readiness: "runtime-check",
            sources: [...mockClaudeSources],
          },
          // The three engines with no command sandbox of their own enforce
          // three of the four modes: `auto` needs a routine/non-routine
          // judgement none of them makes, so none of them declares it and the
          // access menu offers it as unusable with the reason.
          {
            accessModes: [...mockThreeAccessModes],
            driverKind: "opencode",
            readiness: "runtime-check",
            sources: [...mockOpencodeSources],
          },
          {
            accessModes: [...mockThreeAccessModes],
            driverKind: "pi",
            readiness: "runtime-check",
            sources: [...mockPiSources],
          },
          {
            accessModes: [...mockThreeAccessModes],
            driverKind: "cursor",
            readiness: "runtime-check",
            sources: [...mockCursorSources],
          },
        ],
        id: "env_00000000-0000-4000-8000-000000000001",
        kind: "main",
        name: "Home Mac",
        providerStateModes: ["ambient", "isolated"],
        // The hosting Runner for this personal Deployment.
        runnerId: "rnr_11111111-1111-4111-8111-111111111111",
        status: "connected",
      },
      // A second computer whose person never installed Cursor's CLI. Cursor
      // ships no bytes of its own, so the Runner reports the engine
      // `unavailable` with the install command, and the account already added
      // for it carries that sentence wherever it is offered.
      {
        can: { executeTasks: true },
        capabilities: ["filesystem"],
        connected: true,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [],
        harnessDrivers: [
          {
            accessModes: [...mockEveryAccessMode],
            driverKind: "claude",
            readiness: "runtime-check",
            sources: [...mockClaudeSources],
          },
          {
            driverKind: "cursor",
            readiness: "unavailable",
            reason: mockCursorNotInstalledReason,
          },
        ],
        id: mockAwaySiteEnvironmentId,
        kind: "main",
        name: "Studio iMac",
        providerStateModes: ["ambient", "isolated"],
        runnerId: "rnr_44444444-4444-4444-8444-444444444444",
        status: "connected",
      },
    ],
    revision: 1,
    harnesses: [
      {
        driverKind: "codex",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockCodexHarnessInstanceId,
        isDefault: true,
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "ambient",
      },
      {
        driverKind: "codex",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockCodexSecondHarnessInstanceId,
        isDefault: false,
        name: "Codex 2",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "isolated",
      },
      {
        driverKind: "codex",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockOpenRouterHarnessInstanceId,
        isDefault: false,
        name: "OpenRouter",
        runtimeRevision: 1,
        sourceId: "openai-compatible",
        stateKind: "isolated",
      },
      {
        driverKind: "claude",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockClaudeHarnessInstanceId,
        isDefault: true,
        name: "Claude Code",
        runtimeRevision: 1,
        sourceId: "anthropic",
        stateKind: "ambient",
      },
      {
        driverKind: "opencode",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockOpencodeHarnessInstanceId,
        isDefault: true,
        name: "OpenCode Zen",
        runtimeRevision: 1,
        sourceId: "opencode",
        // Every OpenCode source keeps its key in the account's own private
        // credential file, so no OpenCode account is ever ambient.
        stateKind: "isolated",
      },
      {
        driverKind: "pi",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockPiHarnessInstanceId,
        isDefault: true,
        name: "xAI",
        runtimeRevision: 1,
        sourceId: "xai",
        stateKind: "isolated",
      },
      {
        driverKind: "cursor",
        enabled: true,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        id: mockCursorHarnessInstanceId,
        isDefault: true,
        name: "Cursor",
        runtimeRevision: 1,
        sourceId: "cursor",
        // Cursor's only sign-in is the CLI's own, in this computer's keychain.
        stateKind: "ambient",
      },
      {
        driverKind: "cursor",
        enabled: true,
        environmentId: mockAwaySiteEnvironmentId,
        id: mockAwaySiteCursorHarnessInstanceId,
        isDefault: true,
        name: "Cursor",
        runtimeRevision: 1,
        sourceId: "cursor",
        stateKind: "ambient",
      },
    ],

    voiceThreadId: null,

    threadVisits: {},
    publishedReplyAt: {},
    tasks: null,
    activeTasks: [],

    doneTasks: {},
    quietTaskDays: 3,
    // The mock stands in for a Personal Deployment on the computer running it:
    // its only identity is the implicit machine owner, so nothing about this
    // fixture names a person.
    identityConfig: {
      deployment: { kind: "personal", name: "Mac mini" },
      emailDeliveryAvailable: false,
      exposure: "loopback",
      homeKind: "mac",
      localPasswordEnabled: false,
      machineOwner: true,
      oidcProviders: [],
      passkeysEnabled: false,
      portalOrigin: null,
      publicOrigin: "http://127.0.0.1:4315",
      setupState: "complete",
      signupPolicy: "closed",
    },
    machines: mockMachines.map((machine) => ({ ...machine })),
    ownerProfile: { name: "Alex", accountBacked: false, version: null },
    role: "owner",
    session: "authenticated",
    sessionSurface: "canonical",
    machineRevision: 0,
    triggerRevision: 0,
    threadLookups: {},
    user: {
      disabledAt: null,
      displayName: "Alex",
      email: "alex@example.com",
      emailVerified: true,
      id: mockUserId,
      image: null,
    },
    executionPreferences: emptyExecutionPreferences,
    threadRenameAvailable: true,
    taskMarksAvailable: true,
    harnessUpdateAvailable: true,

    tabReopenAvailable: true,
    browserProfileManageAvailable: true,
    searchSuggestionsAvailable: true,
    iphoneAppsAvailable: true,
    devicesAvailable: true,
    ownerViewWindowsAvailable: true,
    voiceAvailable: true,

    threads: withMockThreadMarks([
      {
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        createdAt: "2026-07-02T15:20:00.000Z",
        harnessLabel: "Codex",
        id: "thr_00000000-0000-4000-8000-000000000001",
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        purpose: "task",
        runnerLabel: "Home Mac",
        status: "running",
        title: "Build the new architecture",
        unread: false,
        updatedAt: "2026-08-09T16:39:00.000Z",
      },
      {
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        createdAt: "2026-08-09T13:03:00.000Z",
        harnessLabel: "Codex",
        id: "thr_00000000-0000-4000-8000-000000000002",
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        purpose: "task",
        runnerLabel: "Home Mac",
        status: "waiting",
        title: "Review storage integration",
        unread: false,
        updatedAt: "2026-08-09T13:08:00.000Z",
      },
      {
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        createdAt: "2026-08-08T20:04:00.000Z",
        harnessLabel: "Codex",
        id: "thr_00000000-0000-4000-8000-000000000003",
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        purpose: "task",
        runnerLabel: "Home Mac",
        status: "waiting",
        title: "Prepare the product launch",
        unread: true,
        updatedAt: "2026-08-08T20:04:00.000Z",
      },
      {
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        createdAt: "2026-08-07T19:12:00.000Z",
        harnessLabel: "Codex",
        id: "thr_00000000-0000-4000-8000-000000000004",
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        purpose: "task",
        runnerLabel: "Home Mac",
        doneAt: null,
        status: "idle",
        title: "Reconcile August expenses",
        unread: false,
        updatedAt: "2026-08-07T19:12:00.000Z",
      },
      {
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        createdAt: "2026-08-08T09:30:00.000Z",
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        harnessLabel: "Codex",
        id: mockStatementsThreadId,
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 0,
        purpose: "task",
        runnerLabel: "Home Mac",
        status: "failed",
        title: "Download the September card statements",
        unread: false,
        updatedAt: "2026-08-08T09:41:00.000Z",
      },
      ...(
        [
          [mockSlackThreadId, "idle", "Click the Opensteer org in Slack"],
          [mockSlackLiveThreadId, "running", "Switch Slack to Opensteer"],
        ] as const
      ).map(([id, status, title]) => ({
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        createdAt: "2026-08-06T23:28:03.000Z",
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        harnessLabel: "Codex",
        id,
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 0,
        purpose: "task" as const,
        runnerLabel: "Home Mac",
        status,
        title,
        unread: false,
        updatedAt: "2026-08-06T23:29:37.000Z",
        deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      })),
      ...mockPluginTasks.map((task) => ({
        lastVisitedAt: null,
        latestRunCompletedAt: null,
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        createdAt: task.createdAt,
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        harnessLabel: "Codex",
        id: task.threadId,
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        purpose: "task" as const,
        runnerLabel: "Home Mac",
        status: "waiting" as const,
        title: task.title,
        unread: false,
        updatedAt: task.createdAt,
      })),
    ]),
    transcriptWindows: Object.fromEntries(
      Object.entries(transcripts).map(([threadId, entries]) => [
        threadId,
        {
          byteCount: 2,
          hasMore: false,
          itemCount: entries.filter((entry) => entry.kind === "message").length,
          nextBefore: null,
          threadId,
          totalItems: entries.filter((entry) => entry.kind === "message").length,
        },
      ]),
    ),
    transcripts,
  };
}

/**
 * A saved-password sign-in Request for the preview, on the expenses Thread,
 * approved on the mock's Mac mini. A settled one carries `response`, so a page
 * can show every way a sign-in ends.
 */
export function mockPasswordSignInRequest(
  input: {
    readonly expiresAt?: string;
    readonly index?: number;
    readonly response?: PasswordSignInRequestResponse;
    readonly site?: string;
    readonly status?: "declined" | "fulfilled" | "pending";
  } = {},
): Request {
  const index = input.index ?? 1;
  const site = input.site ?? "https://github.com";
  const status = input.status ?? "pending";
  const domain = new URL(site).hostname;
  const createdAt = new Date(Date.UTC(2026, 9, 11, 9, index)).toISOString();
  return RequestSchema.parse({
    callId: `mock-password-sign-in-${index}`,
    cancellationReason: null,
    createdAt,
    id: `req_0192f4a1-6666-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "browser.password-sign-in",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: "run_00000000-0000-4000-8000-000000000004",
    originatingThreadId: mockPasswordSignInThreadId,

    payload: {
      computerName: "Mac mini",
      expiresAt: input.expiresAt ?? new Date(Date.now() + 14 * 60_000).toISOString(),
      kind: "browser.password-sign-in",
      operationId: `0192f4a1-7777-4000-8000-${String(index).padStart(12, "0")}`,
      reason: `Download the October statement from ${domain} to finish the reconciliation.`,
      runnerId: "rnr_11111111-1111-4111-8111-111111111111",
      scope: "personal",
      permissionVersion: 6,
      site,
    },
    presentation: {
      kind: "external",
      subject: { id: site, kind: "browser-site" },
      title: `Sign in to ${domain}`,
    },
    requestedBy: mockUserId,
    requiredActor: "requester",
    resolvedAt: status === "pending" ? null : createdAt,
    resolvedBy: status === "pending" ? null : mockUserId,
    response:
      status === "pending"
        ? null
        : status === "declined"
          ? { kind: "external", value: { decision: "declined" } }
          : input.response
            ? { kind: "external", value: input.response }
            : { kind: "external" },
    status,
  });
}

const mockPasswordSignInThreadId = "thr_00000000-0000-4000-8000-000000000004";

/** A built-in service wears its listing's name, as the Host's own rows do. */
function listedMockRow(row: PluginRow): PluginRow {
  const listed =
    row.source.kind === "built-in" && row.target.kind === "device-app"
      ? mockCatalogProducts[row.target.definitionId]
      : undefined;
  return listed ? { ...row, title: listed.title } : row;
}

/** The Host's catalog listing, for the definitions these fixtures carry. */
const mockCatalogProducts: Readonly<
  Record<string, { title: string; category: string; popular: boolean }>
> = {
  "apple-messages": { title: "iMessage", category: "devices", popular: false },
  "apple-contacts": { title: "Contacts", category: "devices", popular: false },
  "apple-calendar": { title: "Calendar", category: "devices", popular: false },
  "apple-reminders": { title: "Reminders", category: "devices", popular: false },
  "iphone-photos": { title: "Photos", category: "devices", popular: false },
  "iphone-location": { title: "Location", category: "devices", popular: false },
  "macos-app": { title: "Computer use", category: "devices", popular: false },
  "android-phone": { title: "Android phone", category: "devices", popular: false },
};

export function mockCardUseRequest(
  input: Parameters<typeof mockPasswordSignInRequest>[0] = {},
): Request {
  const request = mockPasswordSignInRequest(input);
  if (request.payload.kind !== "browser.password-sign-in")
    throw new Error("Missing Passwords payload");
  return RequestSchema.parse({
    ...request,
    payload: { ...request.payload, credential: "card", reason: "Fill the saved card at checkout." },
    presentation: {
      ...request.presentation,
      title: `Use a saved card on ${new URL(request.payload.site).hostname}?`,
    },
  });
}

export function mockCardUseScenario(
  state: "pending" | "changed" | "expired" | "declined" | "gone" | "no-card" | "off" | "not-set-up",
) {
  const site = "https://shop.example.com";
  const reason =
    state === "no-card"
      ? "no-saved-card"
      : state === "off"
        ? "passwords-off"
        : state === "not-set-up"
          ? "passwords-not-set-up"
          : null;
  if (reason) return { request: null, result: { status: "unavailable", site, reason } };
  const request = mockCardUseRequest({
    site,
    ...(state === "declined"
      ? { status: "declined" }
      : state === "expired"
        ? { status: "fulfilled", response: { outcome: "expired" } }
        : state === "gone"
          ? { status: "fulfilled", response: { outcome: "interrupted" } }
          : {}),
  });
  return {
    request,
    result:
      state === "declined"
        ? { status: "declined", site }
        : state === "expired" || state === "gone"
          ? { status: "unavailable", site, reason: state === "expired" ? "expired" : "interrupted" }
          : { status: "pending", site, requestId: request.id },
  };
}

function isMockPluginCommand(command: HostApiCommand): command is PluginCommand {
  return command.type.startsWith("plugins.");
}

function mockPluginRequest(task: (typeof mockPluginTasks)[number]): Request {
  const base = {
    callId: `mock-plugin-${task.kind}`,
    cancellationReason: null,
    createdAt: task.createdAt,
    id: task.requestId,
    kind: `plugin.${task.kind}`,
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: task.runId,
    originatingThreadId: task.threadId,
    requestedBy: mockUserId,
    requiredActor: "owner",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
  if (task.kind === "account") {
    const { pluginId, pluginName, requirement } = mockPluginRequests.account;
    const consent = mockPluginAccountConsent();
    return RequestSchema.parse({
      ...base,
      payload: { kind: "plugin.account", plugin: pluginId, requirement, scope: "app", consent },
      presentation: {
        kind: "external",
        title: `Connect ${pluginName}`,
        detail:
          "I need your GitHub account to read your notifications.\nLinking trusts this plugin's code. Setup runs with the account before tool approval.",
        subject: { kind: "plugin.account", id: pluginId },
        plugin: {
          plugin: { id: pluginId, name: pluginName, author: "catalog" },
          decision: { kind: "account", requirement, scope: "app", consent },
        },
      },
    });
  }
  if (task.kind === "approval") {
    const { pluginId, pluginName, tool, arguments: args } = mockPluginRequests.approval;
    return RequestSchema.parse({
      ...base,
      payload: {
        kind: "plugin.approval",
        executionId: "exe_mock_approval",
        interactionId: "int_1",
      },
      presentation: {
        kind: "choice",
        title: `${pluginName}: ${tool}`,
        detail:
          "Review the exact arguments below. Earlier code in this tool or program may already have run.",
        options: [
          { id: "accept", label: "Allow once", hint: "allow-once" },
          { id: "decline", label: "Decline", hint: "reject-once" },
        ],
        plugin: {
          plugin: { id: pluginId, name: pluginName, author: "catalog" },
          decision: { kind: "approval", executionId: "exe_mock_approval", tool, arguments: args },
        },
      },
    });
  }
  const { pluginId, pluginName, tool, message, schema } = mockPluginRequests.input;
  return RequestSchema.parse({
    ...base,
    payload: { kind: "plugin.input", executionId: "exe_mock_input", interactionId: "int_1" },
    presentation: {
      kind: "external",
      title: `${pluginName}: ${tool}`,
      detail: message,
      subject: { kind: "plugin.input", id: "exe_mock_input" },
      plugin: {
        plugin: { id: pluginId, name: pluginName, author: "catalog" },
        decision: { kind: "input", executionId: "exe_mock_input", tool, schema },
      },
    },
  });
}
