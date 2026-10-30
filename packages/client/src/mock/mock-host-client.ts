import { emptySavedViewReadiness } from "../host/saved-host-view.js";
import { BrowserPreferences } from "../host/browser-preferences.js";

import { WorkspaceTabActivations } from "../host/workspace-tab-activations.js";
import {
  arrangedBrowserTabLayout,
  browserTabArrangement,
  browserTabOrderTabs,
} from "../host/browser-tab-order.js";
import { groupBrowserTabs, ungroupBrowserTabs, moveBrowserTabs } from "@opensteer/core";
import { BrowserTabGroupClient, removeGroupedTabs } from "../host/browser-tab-groups.js";
import {
  BrowserTabGroupColorSchema,
  WorkspaceTabLineageSchema,
  type BrowserTabLayout,
} from "@opensteer/protocol";
import { placeList } from "../host/places.js";
import type { NativeViewerSource } from "../host/surfaces.js";
import {
  BrowserTabOpenCommandSchema,
  computerAppIdentityKey,
  previousReleaseEligibility,
} from "@opensteer/protocol";
import { MockComputerViews } from "./mock-computer-views.js";
import { RecentSitesStore, type RecentSitesStorage } from "../host/recent-sites.js";
import type { ClientLifecycle } from "../host/lifecycle.js";
import { computerViewMethods } from "../host/computer-views.js";
import { ViewerScope, viewerScopeOf } from "../host/viewer-scope.js";
import type { BrowserTabOpenInput, BrowserTabOpenOptions } from "../host/client.js";
import {
  MockPlaceWorld,
  seedMockPlaces,
  type MockPlaceScript,
  type MockPlacesWorld,
} from "./mock-places.js";
import { MockPhoneDisplaySocket } from "./mock-phone-display.js";
import { mockGeneratedTaskIcon, seedMockTaskMarks } from "./mock-task-marks.js";
import { ThreadStateProjection } from "../host/thread-state.js";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import { delay } from "@opensteer/shared/delay";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BrowserSignInOutcome } from "@opensteer/protocol/browser-sources";
import type { PasswordSignInRequestResponse } from "@opensteer/protocol";
import { MockChromeSignIns } from "./mock-chrome-sign-ins.js";
import {
  mockNightlyTriggerId,
  mockTriggerSummary,
  seedMockAutomations,
  type MockTriggerRecord,
} from "./mock-automations.js";
import {
  provisionalThreadTitle,
  ThreadTitleSchema,
  defaultTaskSymbol,
  nextMarkColor,
  markColorAllocationOrder,
  type MarkColor,
  AgentEventSchema,
  CHAT_THREAD_TITLE,
  DeploymentIdSchema,
  AttachmentSchema,
  AssignmentSummarySchema,
  AssignmentViewSchema,
  attachmentMaxBytes,
  attachmentNativeImageMediaTypes,
  type Attachment,
  type AssignmentSummary,
  type AssignmentView,
  type WaitingRequest,
  type ContentPart,
  DEFAULT_THREAD_ACCESS_MODE,
  ModelSelectionSchema,
  MessageAuthorSchema,
  MessageSchema,
  SequenceSchema,
  ProviderContinuationIdentitySchema,
  RequestIdSchema,
  RequestSchema,
  ResolvedRequestSchema,
  RunSchema,
  ThreadAccessModeSchema,
  ThreadInputSchema,
  ThreadInputQueueViewSchema,
  ThreadIdSchema,
  AssignmentIdSchema,
  PendingRequestSchema,
  ThreadSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  createId,
  emptyExecutionPreferences,
  moveQueueItem,
  notificationBodyMaxCharacters,
  notificationTitleMaxCharacters,
  NotificationViewSchema,
  rememberExecutionChoice,
  requestTitleText,
  sameProviderContinuationIdentity,
  RunnerIdSchema,
  type AuthSessionSummary,
  type EnvironmentId,
  type ExecutionChoice as HostExecutionChoice,
  type ExecutionPreferences,
  type Message,
  type NotificationView,
  type Sequence,
  type ThreadReadState,
  type WorkspaceNotificationPreference,
  type ModelSelection,
  type Request,
  type RequestResponse,
  type Run,
  type Thread,
  type ThreadAccessMode,
  type ThreadInput,
  type ThreadInputQueue,
  type WorkspaceIconName,
  type AgentEvent,
  requestOptionDeclines,
  type BrowserPageContentPart,
  BrowserSurfaceIdSchema,
} from "@opensteer/core";
import {
  AgentPhoneHostTargetSchema,
  androidPhoneDefinitionId,
  browserUsageTabsPerRun,
  ComputerUseSessionSummarySchema,
  HarnessInstanceCatalogSchema,
  type HarnessInstanceCatalog,
  type ComputerUseInstalledApp,
  type HarnessModelDescriptor,
  type HarnessSourceDescriptor,
  type ModelServer,
  HostApiErrorSchema,
  hostApi,
  rpcSuccess,
  type HostApiClient,
  type HostApiCommand,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
  type ThreadMessagePage,
  machineAccessPolicyDefault,
  taskLineMaxLength,
  type MachineAccessPolicy,
  type MachineSummary,
} from "@opensteer/protocol";
import {
  TriggerOccurrenceSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  TriggerWatchActivationSchema,
  firstTriggerFireAt,
  type Trigger,
  type TriggerOccurrence,
  type TriggerRevision,
  type TriggerSource,
  type TriggerSummary,
  type TriggerWatchActivation,
} from "@opensteer/triggers";
import { channelProviderCatalog } from "@opensteer/channel-core";
import { createIntegrationId, type IntegrationConnectionId } from "@opensteer/integration-core/ids";
import { z } from "zod";
import type {
  ComputerAppIdentity,
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
  IntegrationGrant,
  IntegrationOAuthApplicationSource,
  IntegrationProviderApplication,
  IntegrationRepositoryAccess,
} from "@opensteer/integration-core";
import {
  ComputerAppApprovalSchema,
  IntegrationInstallManifestSummarySchema,
  SetComputerAppConnectionSchema,
  integrationCredentialRejectedDetail,
  type CreateIntegrationGrant,
} from "@opensteer/integration-core/models";
import type {
  BrowserCommand,
  BrowserProfileGrantSummary,
  BrowserFrameStore,
  BrowserSessionSummary,
  CreateHarnessInstanceInput,
  CreateThreadInput,
  CreateWorkspaceInput,
  HarnessAuthenticationEnvelope,
  HarnessSummary,
  HostClient,
  HostSnapshot,
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
  WorkspaceSummary,
} from "../host/client.js";
import { HostClientRequestError } from "../host/client.js";
import type { ExecutionChoice, ExecutionSelection } from "../host/execution-preferences.js";
import {
  assignmentReturnId,
  drawnLiveStream,
  finishRunEntries,
  foldTranscriptEvent,
  isTerminalRunEntryStatus,
  requestReceipt,
  threadInputDelivery,
} from "../host/transcript.js";
import { threadStopTarget } from "../host/thread-activity.js";
import {
  resolveThreadPlacement,
  threadPlacementOptions,
  type ThreadPlacementOption,
} from "../host/thread-placement.js";
import { accessModeUnavailableReason } from "../host/access-modes.js";
import { createInMemoryHostApiClient } from "../host/host-api-client.js";
import {
  rpcErrorStatus,
  unwrapRpcResult,
  type WebSocketClient,
} from "../host/host-session-client.js";
import { isThreadUnread } from "../host/thread-read-state.js";

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
import { mockComputerUseTurn } from "./mock-computer-use-transcript.js";
import {
  createInitialIntegrationState,
  mockAgentPhoneRunnerId,
  mockCatalogTools,
  mockComputerAppTools,
  mockComputerAppInstallation,
  mockComputerUseApps,
  mockComputerUseDefinition,
  mockHostedOAuthDisclosure,
  mockIntegrationCallbackUrl,
  mockIntegrationDefinitions,
  mockIntegrationDigest,
  mockIntegrationInstallation,
  mockMessagesRunnerId,
  mockIphoneAppDefinitions,
  mockGitHubRevoked,
  mockRejectedApiKey,
  mockTmdbInstallation,
  mockTmdbProposal,
  mockVapi,
  type MockIntegrationAttempt,
} from "./mock-integration-fixtures.js";
import { mockAppIcons } from "./mock-app-icons.js";

// A mock launch represents the same signed-in person and seeded requests, so
// account-scoped device preferences and drafts behave like a real attachment.
const mockUserId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const mockMainWorkspaceId = "wsp_00000000-0000-4000-8000-000000000001";

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
// A task whose agent proposed Vapi and asks for the exact account the service
// rejected: the reconnect card, end to end, against the seeded accounts.
const mockVapiThreadId = mockVapi.threadId;
const mockVapiRunId = "run_00000000-0000-4000-8000-000000000008";
const mockVapiReason =
  "Vapi rejected the saved key on my first call, so I need that account reconnected to list your assistants.";
// A task whose agent researched TMDB and proposed it: the install review, the
// key form and the rejected key, against an integration not yet installed.
const mockTmdbThreadId = mockTmdbProposal.threadId;
const mockTmdbRunId = "run_00000000-0000-4000-8000-000000000009";
const mockTmdbReason =
  "Set up read-only TMDB lookups for movies and TV shows with your own API Read Access Token.";

/**
 * Computer use as the preview shows it: the architecture Thread is using Notes
 * on the Mac mini right now and has asked for Numbers, which waits for the
 * person at that Mac.
 */
const mockComputerUseThreadId = "thr_00000000-0000-4000-8000-000000000001";
const mockPortableFsThreadId = "thr_00000000-0000-4000-8000-000000000002";
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
  runnerId: mockMessagesRunnerId,
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
  originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  payload: {
    access: "read-write",
    app: null,
    definitionId: "android-phone",
    kind: "computer.app.access",
    reason: "Check the order status in the delivery app.",
    runnerId: mockAgentPhoneRunnerId,
    setupRequestId: "0192f4a1-9999-4000-8000-000000000009",
    workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  },
  presentation: {
    detail:
      "Check the order status in the delivery app. Pixel 7 — can see and control. Allow or decline from any Opensteer app.",
    kind: "external",
    subject: { id: "0192f4a1-9999-4000-8000-000000000009", kind: "computer-app-setup" },
    title: "Wants to see and control Pixel 7",
  },
  requestedBy: mockUserId,
  requiredActor: "workspace-owner",
  resolvedAt: null,
  resolvedBy: null,
  response: null,
  status: "pending",
  targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
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
const SpecializedIntegrationAccessResponseSchema = z.strictObject({
  kind: z.literal("external"),
  value: z.discriminatedUnion("decision", [
    DeclinedIntegrationAccessDecisionSchema,
    z.strictObject({
      access: z.enum(["read", "read-write"]),
      alias: z.string(),
      connectionId: z.string().nullable(),
      decision: z.literal("fulfilled"),
      isDefault: z.boolean(),
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
  return {
    displayName: "Opensteer",
    kind: "agent",
    runId,
    threadId,
    workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
    workspaceName: "Main",
  } as MessageEntry["author"];
}

/** A cross-thread arrival: authorship is the sending thread, not this one. */
function mockCrossThreadAuthor(): MessageEntry["author"] {
  return {
    displayName: "Prepare the product launch",
    kind: "agent",
    runId: "run_00000000-0000-4000-8000-000000000003",
    threadId: "thr_00000000-0000-4000-8000-000000000003",
    workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
    workspaceName: "Customer launch",
  } as MessageEntry["author"];
}

function mockTriggerAuthor(): MessageEntry["author"] {
  return {
    displayName: "Nightly typecheck",
    kind: "trigger",
    occurrenceId: "toc_00000000-0000-4000-8000-000000000001",
    source: "schedule",
    triggerId: mockNightlyTriggerId,
  } as MessageEntry["author"];
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

interface MockWorkspaceFile {
  content: string | null;
  path: string;
  type: "directory" | "file";
}

const mockWorkspaceFiles: Readonly<Record<string, readonly MockWorkspaceFile[]>> = {
  "wsp_00000000-0000-4000-8000-000000000003": [
    { content: null, path: "reports", type: "directory" },
    {
      content: "# August reconciliation\n\nPending review.",
      path: "reports/august.md",
      type: "file",
    },
  ],
  "wsp_00000000-0000-4000-8000-000000000002": [
    { content: null, path: "briefs", type: "directory" },
    {
      content: "# Launch brief\n\nOpensteer gives everyday teams durable AI workspaces.",
      path: "briefs/launch.md",
      type: "file",
    },
  ],
  "wsp_00000000-0000-4000-8000-000000000001": [
    { content: null, path: "apps", type: "directory" },
    { content: null, path: "apps/host", type: "directory" },
    { content: null, path: "apps/web", type: "directory" },
    { content: null, path: "docs", type: "directory" },
    {
      content:
        "# Opensteer architecture\n\nThe Host owns durable product truth. Runners own execution. Workspaces own files and memory.",
      path: "docs/architecture.md",
      type: "file",
    },
    { content: null, path: "packages", type: "directory" },
    { content: null, path: "packages/protocol", type: "directory" },
    { content: null, path: "packages/protocol/src", type: "directory" },
    {
      content: "export interface HostClient {\n  subscribe(listener: () => void): () => void;\n}\n",
      path: "packages/protocol/src/client.ts",
      type: "file",
    },
    {
      content: '{\n  "name": "opensteer",\n  "private": true\n}\n',
      path: "package.json",
      type: "file",
    },
  ],
};

function encodeMockFileKey(path: string): string {
  const binary = Array.from(new TextEncoder().encode(path.replaceAll("/", "\0")), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function mockFileForKey(workspaceId: string, key: string): MockWorkspaceFile | undefined {
  return mockWorkspaceFiles[workspaceId]?.find((file) => encodeMockFileKey(file.path) === key);
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
  input: ThreadInput;
  message: Message;
}

/** What a task Home hands out in the preview does, from the ask to Home's answer. */
interface MockTaskScript {
  /** Home's one sentence as it hands the work on. */
  readonly accepted: string;
  /** Home's answer once the task's result is back. */
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

const mockWebSearch = { name: "web_search", namespace: "codex" } as const;

const mockMattressTask: MockTaskScript = {
  accepted: "I’ll compare the best mattresses in the browser and bring the shortlist back here.",
  answer:
    "The comparison is back. For side sleeping, the **Helix Midnight Luxe** ($1,749) is the pick: it’s zoned to take pressure off your shoulder, and returns are free for 100 nights. If you’d rather spend less, the **Nectar Premier** ($1,149) is the best value, and the **Saatva Classic** suits you if you prefer springs. Want me to check delivery dates for one of them?",
  decision: null,
  note: "Heads up: Helix’s 20% sale ends Sunday, so the Helix prices I’m comparing include it.",
  objective:
    "Research the best mattresses for a side sleeper under $2,000. Check current prices, trial length and return costs on each brand’s own site, and bring back a shortlist of three with one line on each.",
  result:
    "**Shortlist for a side sleeper under $2,000**\n\n1. **Helix Midnight Luxe**: $1,749 (queen). Zoned support that relieves the shoulder; 100-night trial, free returns.\n2. **Saatva Classic, Plush Soft**: $1,995. Coil-on-coil with a pillow top; 365-night trial, $99 return pickup.\n3. **Nectar Premier**: $1,149. Memory foam and the best value; 365-night trial, free returns.\n\nPrices checked on each brand’s site today.",
  steps: [
    {
      arguments: { url: "https://www.google.com" },
      output: "Opened a browser.",
      tool: { name: "browser_session_open", namespace: "opensteer" },
    },
    {
      arguments: { query: "best mattress for side sleepers under $2000" },
      output: "Helix Midnight Luxe, Saatva Classic, Nectar Premier, Purple Plus…",
      tool: mockWebSearch,
    },
    {
      arguments: {
        action: { type: "openPage", url: "https://helixsleep.com/products/midnight-luxe" },
      },
      output: "Helix Midnight Luxe, queen $1,749. 100-night trial.",
      tool: mockWebSearch,
    },
    {
      arguments: {
        action: { type: "openPage", url: "https://www.saatva.com/mattresses/saatva-classic" },
      },
      output: "Saatva Classic, queen $1,995. 365-night home trial.",
      tool: mockWebSearch,
    },
  ],
  title: "Compare mattresses",
};

const mockBookingTask: MockTaskScript = {
  accepted: "I’ll find a table for four at Nopa on Friday and check with you before booking.",
  answer:
    "You’re booked at **Nopa on Friday at 7:30 pm** for four. The confirmation is in your email.",
  decision: {
    accept: "Book it",
    decline: "Don’t book",
    declinedAnswer:
      "I didn’t book it. Nopa still has 7:30 pm open on Friday if you change your mind.",
    declinedResult: "Not booked. Friday at 7:30 pm is still open at Nopa.",
    detail:
      "Submits the reservation on opentable.com. Nopa holds $50 on your card and releases it at the meal.",
    title: "Book Nopa for 4 at 7:30 pm on Friday",
  },
  note: null,
  objective:
    "Book a table for four at Nopa this Friday around 7:30 pm. Ask before submitting anything that holds a card.",
  result:
    "Booked: **Nopa, Friday at 7:30 pm, 4 people**. The confirmation is in your email; the $50 hold is released at the meal.",
  steps: [
    {
      arguments: { query: "Nopa San Francisco reservations Friday" },
      output: "Nopa · OpenTable · 560 Divisadero St",
      tool: mockWebSearch,
    },
    {
      arguments: {
        action: { type: "openPage", url: "https://www.opentable.com/r/nopa-san-francisco" },
      },
      output: "Friday: 7:00 pm, 7:30 pm and 9:15 pm open for 4.",
      tool: mockWebSearch,
    },
  ],
  title: "Book a table for Friday",
};

/** Home hands an ask on when it is research or an errand; anything else it answers itself. */
function mockTaskScript(body: string): MockTaskScript | null {
  if (/\bmattress/i.test(body)) return mockMattressTask;
  if (/\b(book|reserve)\b/i.test(body)) return mockBookingTask;
  if (!/\b(research|compare|look into|find out)\b/i.test(body)) return null;
  const ask = body
    .trim()
    .replace(/^(can|could|would) you\s+|^please\s+/i, "")
    .replace(/[?.!]+$/, "");
  const title = `${ask.charAt(0).toUpperCase()}${ask.slice(1)}`.slice(0, 60);
  return {
    ...mockMattressTask,
    accepted: `I’ll ${ask} and bring what I find back here.`,
    answer: "The research is back: three sources agree on the main points.",
    note: null,
    objective: `${title}. Bring back a short summary with sources.`,
    result: `**${title}**\n\nThree sources agree on the main points; the details are in this task.`,
    steps: mockMattressTask.steps
      .slice(0, 2)
      .map((step) => (step.tool === mockWebSearch ? { ...step, arguments: { query: ask } } : step)),
    title,
  };
}

function mockDelegateCall(
  runId: string,
  assignment: AssignmentView,
  title: string,
  workspaceId: string,
): ToolEntry {
  const createdAt = assignment.createdAt;
  return {
    arguments: { task: assignment.objective, title },
    callId: "call-delegate-1",
    completedAt: createdAt,
    createdAt,
    id: `tool:${runId}:call-delegate-1`,
    integration: null,
    isError: false,
    kind: "tool",
    output: {
      text: JSON.stringify({
        assignment: { id: assignment.id },
        thread: { id: assignment.workerThreadId, workspaceId },
      }),
    },
    runId,
    state: "done",
    streamText: "",
    tool: { name: "thread_delegate", namespace: "opensteer" },
  };
}

function mockTaskStep(
  runId: string,
  index: number,
  step: MockTaskScript["steps"][number],
  createdAt: string,
): ToolEntry {
  return {
    arguments: step.arguments,
    callId: `call-task-${index}`,
    completedAt: null,
    createdAt,
    id: `tool:${runId}:call-task-${index}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: undefined,
    runId,
    state: "running",
    streamText: "",
    tool: { ...step.tool },
  };
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
            operation: "list_conversations",
            detail: "Ready to read",
            remedy: null,
            state: "ready",
          },
          { operation: "read_messages", detail: "Ready to read", remedy: null, state: "ready" },
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
      approvalKeyId: `sha256:${"A".repeat(43)}`,
      detail: null,
      permissions: { accessibility: "granted", screenRecording: "granted" },
      sessions: [mockComputerUseSession, mockSlackLiveSession],
      state: "ready",
    },
    fullDiskAccess: true,
    id: "rnr_11111111-1111-4111-8111-111111111111",
    lastSeenAt: null,
    localWorkspaces: 2,
    modules: {
      agents: { checkedAt: null, detail: null, readiness: "ready" },
      browser: { checkedAt: null, detail: null, readiness: "ready" },
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "Mac mini",
    ownership: "deployment",
    ownerName: null,
    pinnedThreads: 3,
    revocable: false,
    status: "online",
    runtimeVersion: null,
    unlinkedLocalFolders: 0,
  },
  {
    // A Mac offering Messages that macOS has not let Opensteer read yet.
    apps: [
      {
        definitionId: "apple-messages",
        operations: [
          {
            operation: "list_conversations",
            detail: "Reading Messages requires macOS Full Disk Access.",
            remedy: "full-disk-access",
            state: "permission-required",
          },
          {
            operation: "read_messages",
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
      approvalKeyId: null,
      detail: null,
      permissions: { accessibility: "denied", screenRecording: "granted" },
      sessions: [],
      state: "permission-required",
    },
    fullDiskAccess: false,
    id: "rnr_33333333-3333-4333-8333-333333333333",
    lastSeenAt: "2026-09-13T08:12:00.000Z",
    localWorkspaces: 0,
    modules: {
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "Alex's MacBook Pro",
    ownership: "mine",
    ownerName: null,
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    runtimeVersion: null,
    unlinkedLocalFolders: 1,
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
    id: "rnr_44444444-4444-4444-8444-444444444444",
    lastSeenAt: "2026-09-16T21:40:00.000Z",
    localWorkspaces: 0,
    modules: {
      integrations: { checkedAt: null, detail: null, readiness: "unavailable" },
      shell: { checkedAt: null, detail: null, readiness: "unavailable" },
    },
    name: "Studio iMac",
    ownership: "mine",
    ownerName: null,
    pinnedThreads: 0,
    revocable: true,
    status: "offline",
    runtimeVersion: null,
    unlinkedLocalFolders: 0,
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
    access: null,
    allowedModules: ["integrations"],
    detail: null,
    device: { form: "phone", platform: "android" },
    enrollmentId: "ren_runner_phone",
    expiresAt: null,
    computerUse: {
      // Every client watches phone tasks and owner views through live display.
      displayStreamSupported: true,
      appApproval: null,
      approvalKeyId: null,
      detail: null,
      permissions: null,
      sessions: [mockAgentPhoneSession],
      state: "ready",
    },
    fullDiskAccess: null,
    id: mockAgentPhoneRunnerId,
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Pixel 7",
    ownership: "mine",
    ownerName: null,
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    runtimeVersion: "0.1.117",
    unlinkedLocalFolders: 0,
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
    localWorkspaces: 0,
    modules: { messaging: { checkedAt: null, detail: null, readiness: "unavailable" } },
    name: "Slack runtime",
    ownership: "deployment",
    ownerName: null,
    pinnedThreads: 0,
    revocable: true,
    status: "offline",
    runtimeVersion: null,
    unlinkedLocalFolders: 0,
  },
];

export interface MockHostClientOptions {
  readonly recentSitesStorage?: RecentSitesStorage;
  readonly sharedTaskDoneAvailable?: boolean;
  /** The platform's lifecycle, reported to display sockets as the real client reports it. */
  readonly lifecycle?: ClientLifecycle;
  /** Automations covering every state the Automations page shows; seeded by default. */
  automations?: "seeded" | "absent";
  places?: "seeded" | "absent";
  /** Development fixture for the first message before a Chat exists. */
  initialHome?: "seeded" | "absent";
  /**
   * `first-run`: a reader who has asked nothing yet — no Chat, no tasks, no
   * places — for the screens a first visit sees.
   */
  world?: "seeded" | "first-run" | "busy" | "stress";
  latencyMs?: number;
  now?: () => Date;
  pendingRequests?: readonly Request[];
  /** The sessions `sessions.list` reports; one current session by default. */
  sessions?: readonly AuthSessionSummary[];
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
    workspaceId: trigger.workspaceId,
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

/**
 * Every member is written out. The map carries no fallback, so adding an rpc
 * member without teaching the preview about it is a compile error rather than a
 * page that fails at runtime in `VITE_OPENSTEER_USE_MOCK`.
 */
function mockHostApiHandlers(client: MockHostState): HostApiHandlers {
  return {
    "attachment.get": async ({ attachmentId }) => rpcSuccess(client.getAttachment(attachmentId)),
    "attachment.upload": async ({ attachmentId }, context) =>
      rpcSuccess(await client.uploadAttachment(attachmentId, context.binaryBody)),
    "attachment.content": async ({ attachmentId }) =>
      rpcSuccess(client.readAttachment(attachmentId)),
    "browser.sources.get": async () => rpcSuccess(client.chrome.state()),
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
    // Accepting an invitation admits a second identity into a Workspace, and
    // the preview only ever has the one owner.
    "auth.invitation.accept": unsupportedMockRpc,
    "auth.invitation.exchange": async () =>
      rpcSuccess(
        hostApi["auth.invitation.exchange"].success.parse({
          preview: await client.exchangeInvitation(),
        }),
      ),
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
    "workspace.tabs.get": async ({ groupId }) => {
      const group = client.getSnapshot().workspaceTabs?.find((group) => group.id === groupId);
      return group
        ? rpcSuccess(group)
        : mockRefusal(
            new HostClientRequestError({
              code: "not_found",
              status: 404,
              message: "Browser tabs not found.",
            }),
          );
    },
    "browser.tabs.get": async ({ sessionId }) => {
      const catalog = client
        .getSnapshot()
        .browserSessions.find((session) => session.id === sessionId)?.tabCatalog;
      return catalog
        ? rpcSuccess(catalog)
        : mockRefusal(
            new HostClientRequestError({
              code: "not_found",
              status: 404,
              message: "Browser session not found.",
            }),
          );
    },
    "browser.tabIcon.get": async ({ sessionId, iconRef }) => {
      if (!client.places) return unsupportedMockRpc();
      return rpcSuccess({ favicon: await client.places.icon(sessionId, iconRef) });
    },
    "bootstrap.get": async () =>
      rpcSuccess(hostApi["bootstrap.get"].success.parse(client.bootstrap())),
    "channel.connection.check": async (input) =>
      rpcSuccess(await client.checkChannelConnection(input.connectionId)),
    "channels.get": async () =>
      rpcSuccess(hostApi["channels.get"].success.parse(await client.loadChannels())),
    "commands.dispatch": (command) =>
      client
        .executeCommandOnce(command)
        .then((result) => {
          if (result.ok) client.applyThreadCommandResult(result.data);
          return result;
        })
        .catch(mockRefusal),
    "harness.authentication.get": async () => rpcSuccess(await client.getHarnessAuthentication()),
    "harness.catalog.refresh": async () => rpcSuccess({}),
    "harness.modelServers.discover": async (input) =>
      rpcSuccess({ servers: mockModelServers(input.address) }),
    "integration.authorization.get": async (input) =>
      rpcSuccess(await client.getIntegrationAuthorization(input.attemptId)),
    "integration.grants.list": async (input) =>
      rpcSuccess({ grants: await client.loadIntegrationGrants(input.workspaceId) }),
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
    "integration.computer.setup.list": async () =>
      rpcSuccess({ requests: client.listComputerAppSetupRequests() }),
    "integration.platform.get": async () =>
      rpcSuccess(
        hostApi["integration.platform.get"].success.parse(await client.loadIntegrationPlatform()),
      ),
    "integration.repositoryAccess.check": (input) =>
      client.checkRepositoryAccess(input.connectionId).then(rpcSuccess).catch(mockRefusal),
    "integrations.get": async () =>
      rpcSuccess(hostApi["integrations.get"].success.parse(await client.loadIntegrations())),
    // The preview keeps no durable session history to page back through.
    "machine.access.history": async () => rpcSuccess({ nextCursor: null, sessions: [] }),
    "machines.list": async () => rpcSuccess({ machines: await client.loadMachines() }),
    // The preview holds every task, so a page is a slice of what it holds.
    "tasks.list": async (input) => {
      const snapshot = client.getSnapshot();
      if (
        input.workspaceId &&
        !snapshot.workspaces.some((workspace) => workspace.id === input.workspaceId)
      ) {
        return mockRefusal(
          new HostClientRequestError({
            code: "not_found",
            message: "Workspace not found",
            status: 404,
          }),
        );
      }
      const entries = (snapshot.tasks?.entries ?? []).filter(
        ({ thread }) =>
          (!input.workspaceId || thread.workspaceId === input.workspaceId) &&
          (!input.active || thread.status === "running" || thread.status === "waiting"),
      );
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
          readStates: page.map(({ thread }) => client.threadReadState(thread.id)),
          tasks: page.map((entry) => ({ ...entry, thread: mockThread(entry.thread) })),
          window: {
            byteCount: 2,
            hasMore: end < entries.length,
            itemCount: page.length,
            nextBefore: end < entries.length ? String(end) : null,
            totalItems: entries.length,
          },
        }),
      );
    },
    "requests.list": async () => {
      const { waitingRequests } = client.getSnapshot();
      return rpcSuccess(
        hostApi["requests.list"].success.parse({
          requests: waitingRequests,
          window: mockWindow(waitingRequests.length),
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
      const ended =
        entry.status === "completed" || entry.status === "failed" || entry.status === "interrupted";
      return rpcSuccess(
        hostApi["run.attempts.list"].success.parse({
          attempts: [
            {
              createdAt: entry.createdAt,
              dispatchedAt: entry.status === "queued" ? null : entry.createdAt,
              endedAt: ended ? entry.createdAt : null,
              engineStart: entry.status === "queued" ? null : "cold",
              id: createId("runAttempt"),
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
    // The preview projects transcripts directly; it keeps no durable event log
    // to page back through.
    "thread.events.list": async ({ threadId }) => {
      const thread = client.getSnapshot().threads.find((item) => item.id === threadId);
      if (!thread) throw new Error("Thread not found.");
      return rpcSuccess(
        hostApi["thread.events.list"].success.parse({
          readState: client.threadReadState(threadId),
          thread: mockThread(thread),
          events: [],
          threadId,
          window: { ...mockWindow(0), threadId },
        }),
      );
    },
    "thread.assignments.list": async ({ threadId }) => {
      const assignments = client.listThreadAssignments(threadId);
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
      const uses = client.getSnapshot().browserSessions.flatMap((session) => {
        const scoped = (session.uses ?? []).filter((use) => use.threadId === threadId);
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
        ].map((use) => ({ ...use, sessionId: session.id }));
      });
      return rpcSuccess(hostApi["thread.browserUsage.get"].success.parse({ threadId, uses }));
    },
    "thread.inputQueue.get": async (input) =>
      rpcSuccess(client.loadThreadInputQueue(input.threadId)),
    "thread.live.get": async (input) => rpcSuccess(client.liveStreams(input.threadId)),
    "thread.requests.list": async (input) => {
      const requests = client.getSnapshot().requests[input.threadId] ?? [];
      return rpcSuccess(
        hostApi["thread.requests.list"].success.parse({
          requests,
          threadId: input.threadId,
          window: mockWindow(requests.length),
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
          triggers: client.listTriggers(input.workspaceId),
        }),
      ),
    "workspace.catalog.list": async () => {
      const snapshot = client.getSnapshot();
      return rpcSuccess(
        hostApi["workspace.catalog.list"].success.parse({
          notificationPreferences: snapshot.workspaces.map(({ id }) =>
            client.workspaceNotificationPreference(id),
          ),
          window: snapshot.workspaceWindow,
          workspaces: snapshot.workspaces.map(mockWorkspaceView),
        }),
      );
    },
    "workspace.files.list": async (input) =>
      rpcSuccess(
        hostApi["workspace.files.list"].success.parse(
          await client.listWorkspaceFiles(input.workspaceId, { parentKey: input.parentKey }),
        ),
      ),
    "workspace.files.preview": async (input) => {
      const preview = await client.previewWorkspaceFile(input.workspaceId, input.fileKey);
      return rpcSuccess({
        bytes: new TextEncoder().encode(preview.content ?? ""),
        metadata: preview.metadata,
      });
    },
    "workspace.invitations.list": async (input) =>
      rpcSuccess({
        invitations: (await client.loadWorkspaceSharing(input.workspaceId)).invitations,
      }),
    "workspace.members.list": async (input) =>
      rpcSuccess(
        hostApi["workspace.members.list"].success.parse({
          members: (await client.loadWorkspaceSharing(input.workspaceId)).members,
        }),
      ),
    // Every Workspace is already resident in memory, so there is nothing to warm.
    "workspace.prefetch": async () => rpcSuccess({}),
    "thread.messages.list": async (input) => rpcSuccess(client.listThreadMessages(input)),
    "thread.readState.get": async ({ threadId }) => rpcSuccess(client.threadReadState(threadId)),
  } satisfies HostApiHandlers;
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

async function executeMockCommand(client: MockHostState, command: HostApiCommand) {
  switch (command.type) {
    case "attachment.upload.create":
      return rpcSuccess({ type: command.type, attachment: client.createAttachment(command) });
    case "attachment.upload.discard":
      client.discardAttachment(command.attachmentId);
      return rpcSuccess({ type: command.type });
    case "workspace.create":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(
            await client.createWorkspace({
              ...(command.icon ? { icon: command.icon } : {}),
              name: command.name,
            }),
          ),
        }),
      );
    case "workspace.icon.set":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(
            await client.setWorkspaceIcon(command.workspaceId, command.icon),
          ),
        }),
      );
    case "workspace.color.set":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(
            await client.setWorkspaceColor(command.workspaceId, command.color),
          ),
        }),
      );
    case "workspace.storage.retry":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(await client.retryWorkspaceStorage(command.workspaceId)),
        }),
      );
    case "workspace.delete":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(await client.deleteWorkspace(command.workspaceId)),
        }),
      );
    case "workspace.deletion.recover":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          type: command.type,
          workspace: mockWorkspaceView(await client.recoverWorkspace(command.workspaceId)),
        }),
      );
    case "workspace.invitation.create": {
      const result = await client.createWorkspaceInvitation(command);
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({ ...result, type: command.type }),
      );
    }
    case "workspace.invitation.revoke":
      await client.revokeWorkspaceInvitation();
      return rpcSuccess({ type: command.type });
    case "workspace.member.update":
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          membership: await client.updateWorkspaceMember({
            ...(command.role ? { role: command.role } : {}),
            ...(command.state ? { state: command.state } : {}),
            userId: command.userId,
            workspaceId: command.workspaceId,
          }),
          type: command.type,
        }),
      );
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
      const priorHomeId = command.home
        ? client.getSnapshot().workspaces.find((workspace) => workspace.id === command.workspaceId)
            ?.homeThreadId
        : null;
      const thread = await client.createThread({
        accessMode: command.accessMode ?? parent?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
        environmentId: command.environmentId,
        harnessInstanceId: command.harnessInstanceId,
        modelSelection: command.modelSelection,
        ...(command.home ? { home: true } : {}),
        ...(command.generateTitle ? { generateTitle: true } : {}),
        ...(command.parentThreadId ? { parentThreadId: command.parentThreadId } : {}),
        title: command.home ? CHAT_THREAD_TITLE : command.title,
        workspaceId: command.workspaceId,
      });
      client.recordThreadCreation(idempotencyKey, request, thread.id);
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({
          asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
          thread: mockThread(thread),
          type: command.type,
          wasDuplicate: Boolean(command.home && priorHomeId === thread.id),
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
        content: command.content,
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
    case "thread.read.mark": {
      const state = client.markThreadRead(command.threadId, command.throughSequence);
      return rpcSuccess({ state, type: command.type });
    }
    case "thread.done.set":
      return {
        ok: false as const,
        error: HostApiErrorSchema.parse({
          code: "bad_request",
          reason: "shared-task-done-required",
          message:
            "Update Opensteer on this device to mark tasks Done. Done now stops the task for everyone.",
          retryable: false,
        }),
      };
    case "thread.shared-done.set":
      return rpcSuccess({
        thread: mockThread(await client.setTaskDone(command.threadId, command.done)),
        asOfSequence: SequenceSchema.parse(String(client.getSnapshot().revision)),
        wasDuplicate: false,
        type: command.type,
      });
    case "workspace.notifications.update": {
      const preference = client.setWorkspaceNotificationMute(command.workspaceId, command.muted);
      return rpcSuccess({
        ...preference,
        type: command.type,
      });
    }
    // The preview's agents have no clock of the person's to keep.
    case "viewer.timeZone.update":
      return rpcSuccess({ timeZone: command.timeZone, type: command.type });
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
    case "harness.authentication.begin":
      return rpcSuccess({ ...(await client.beginHarnessAuthentication()), type: command.type });
    case "harness.authentication.submit":
      return rpcSuccess({ ...(await client.submitHarnessAuthentication()), type: command.type });
    case "harness.authentication.logout":
      return rpcSuccess({ ...(await client.logoutHarness()), type: command.type });
    case "harness.authentication.cancel":
      return rpcSuccess({ ...(await client.cancelHarnessAuthentication()), type: command.type });
    case "machine.revoke":
      await client.revokeMachine(command.machineId);
      return rpcSuccess({ type: command.type });
    case "machine.rename":
      await client.renameMachine(command.machineId, command.name);
      return rpcSuccess({ type: command.type });
    case "machine.access.update": {
      const revision = await client.updateMachineAccess(
        command.runnerId,
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
    case "session.revoke":
      await client.revokeSession(command.sessionId);
      return rpcSuccess({ type: command.type });
    case "runner.enrollment.createLocal":
      return rpcSuccess({
        ...(await client.createLocalRunnerEnrollment(command.name)),
        type: command.type,
      });
    case "runner.enrollment.createManaged":
      return rpcSuccess({
        ...(await client.createManagedRunnerEnrollment(command.name)),
        type: command.type,
      });
    case "runner.enrollment.createPhone":
      return rpcSuccess({
        ...(await client.createPhoneRunnerEnrollment(
          command.name,
          command.profile,
          command.idempotencyKey,
        )),
        type: command.type,
      });
    case "runner.enrollment.retire":
      return rpcSuccess({
        state: await client.retireRunnerEnrollment(command.enrollmentId),
        type: command.type,
      });
    case "integration.authorization.cancel":
      return rpcSuccess({
        ...(await client.cancelIntegrationAuthorization(command.attemptId)),
        type: command.type,
      });
    case "integration.providerApplication.save":
      return rpcSuccess({
        application: await client.saveIntegrationProviderApplication(command.input),
        type: command.type,
      });
    case "integration.authorization.begin":
      return rpcSuccess({
        ...(await client.beginIntegrationAuthorization({
          ...command.input,
          returnPath: command.input.returnPath ?? "/",
        })),
        type: command.type,
      });
    case "integration.apiKey.connect":
      await client.connectIntegrationApiKey(command.input);
      return rpcSuccess({ type: command.type });
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
      return rpcSuccess({
        type: command.type,
        request: client.requestComputerAppSetup(command.input),
      });
    case "integration.computer.setup.cancel":
      client.cancelComputerAppSetup(command.requestId);
      return rpcSuccess({ type: command.type });
    case "integration.computer.setup.set":
      return rpcSuccess({
        connection: await client.setComputerAppConnection(command.input),
        type: command.type,
      });
    case "integration.computer.approval-key.set":
      return rpcSuccess({
        approvalKeyId: client.registerComputerUseApprovalKey(command.input),
        type: command.type,
      });
    case "integration.computer.policy.set":
      await client.setComputerUsePolicy(command.input.runnerId);
      return rpcSuccess({ appApproval: "ask", type: command.type });
    case "integration.computer.app.block":
      await client.blockComputerApp(command.connectionId);
      return rpcSuccess({ type: command.type });
    case "integration.providerApplication.status.set":
      return rpcSuccess({
        application: await client.setIntegrationProviderApplicationStatus({
          ...command.input,
          provider: command.provider,
        }),
        type: command.type,
      });
    case "integration.applicationSourceDefault.set":
      await client.setIntegrationApplicationSourceDefault({
        ...command.input,
        provider: command.provider,
      });
      return rpcSuccess({ type: command.type });
    case "integration.mcp.authorization.begin":
      return rpcSuccess(await client.beginMcpAuthorization(command.input));
    case "integration.mcp.disconnect":
      await client.disconnectMcpConnection(command.connectionId);
      return rpcSuccess({ type: command.type });
    case "integration.agentPlugin.install": {
      const result = await client.installAgentPlugin(command.input.directory);
      return rpcSuccess({ ...result, type: command.type });
    }
    case "integration.catalog.install":
      return rpcSuccess({
        installation: await client.installCatalogIntegration(command.input),
        type: command.type,
      });
    case "integration.remoteMcp.install":
      return rpcSuccess({
        installation: await client.installRemoteMcp(command.input),
        type: command.type,
      });
    case "integration.uninstall":
      return rpcSuccess({
        ...(await client.uninstallIntegration(command.installationId)),
        type: command.type,
      });
    case "integration.grant.revoke":
      await client.revokeIntegrationGrant(command.workspaceId, command.grantId);
      return rpcSuccess({ type: command.type });
    case "channel.connection.create":
      await client.createChannelConnection({
        accessPolicy: command.accessPolicy,
        credentials: command.credentials,
        provider: command.provider,
        routingMode: command.routingMode,
        workspaceId: command.workspaceId,
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
    case "run.interrupt":
      await client.stopRun(command.threadId);
      return rpcSuccess({ type: command.type, wasDuplicate: false });
    case "request.respond":
      await client.resolveRequest(command);
      return rpcSuccess({ type: command.type });
    case "browser.session.start": {
      const startedBrowser = await client.startBrowser(
        command.workspaceId,
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
      await client.createBrowserProfile(command.input.name);
      return unsupportedMockRpc();
    case "browser.source.pair":
      return rpcSuccess({ pairing: client.chrome.pair(mockPreviewOrigin()), type: command.type });
    case "browser.source.rename":
      client.chrome.rename(command.sourceId, command.name);
      return rpcSuccess({ type: command.type });
    case "browser.source.revoke":
      client.chrome.revoke(command.sourceId);
      return rpcSuccess({ type: command.type });
    case "browser.site.remove":
      client.chrome.removeSite(command.workspaceId, command.site);
      return rpcSuccess({ type: command.type });
    case "browser.session.sign-in":
      return rpcSuccess({ outcome: client.signInBrowserSession(command), type: command.type });
    case "browser.sign-in.respond":
      return rpcSuccess({ outcome: client.respondBrowserSignIn(command), type: command.type });
    case "browser.password-sign-in.decline":
      return rpcSuccess({ status: client.declinePasswordSignIn(command), type: command.type });
    case "browser.session.profile.save":
      await client.saveBrowserSessionProfile(command.sessionId, command.input.name);
      return unsupportedMockRpc();
    case "browser.profile.grant":
      await client.grantBrowserProfile(command);
      return unsupportedMockRpc();
    case "browser.profileGrant.revoke":
      await client.revokeBrowserProfileGrant(command.grantId);
      return unsupportedMockRpc();
    case "computer.view.open":
    case "computer.view.close":
    case "computer.view.renew":
      if (!client.computerViews) return unsupportedMockRpc();
      return rpcSuccess({ type: command.type, view: client.computerViews.command(command) });
    case "workspace.tabs.group": {
      const layout = client.tabGroups;
      const known = new Set(
        placeList(client.getSnapshot()).flatMap((place) =>
          place.kind === "browser" && place.destination.kind === "browser"
            ? [place.destination.tabId]
            : [],
        ),
      );
      if (command.tabIds.some((id) => !known.has(id))) throw new Error("The tab is unavailable.");
      const existing = command.groupId
        ? layout.groups.find((group) => group.id === command.groupId)
        : undefined;
      if (command.groupId && !existing) throw new Error("The group no longer exists.");
      const groupId = existing?.id ?? createId("browserTabGroup");
      const color =
        command.color ??
        BrowserTabGroupColorSchema.options.reduce(
          (least, color) =>
            layout.groups.filter((group) => group.color === color).length <
            layout.groups.filter((group) => group.color === least).length
              ? color
              : least,
          "grey",
        );
      const next = removeGroupedTabs(layout, command.tabIds);
      const group = {
        id: groupId,
        title: command.title ?? "",
        color,
        collapsed: false,
        ...existing,
        tabIds: [
          ...(existing?.tabIds.filter((id) => !command.tabIds.includes(id)) ?? []),
          ...new Set(command.tabIds),
        ],
      };
      client.setTabGroups(
        arrangedBrowserTabLayout(
          {
            ...layout,
            revision: layout.revision + 1,
            groups: [...next.groups.filter((held) => held.id !== groupId), group],
          },
          groupBrowserTabs(
            browserTabArrangement(layout, browserTabOrderTabs(client.getSnapshot().workspaceTabs)),
            command.tabIds,
            groupId,
          ),
        ),
      );
      return rpcSuccess({ type: command.type, groupId, layout: client.tabGroups });
    }
    case "workspace.tabs.ungroup":
      client.setTabGroups(
        arrangedBrowserTabLayout(
          {
            ...client.tabGroups,
            revision: client.tabGroups.revision + 1,
          },
          ungroupBrowserTabs(
            browserTabArrangement(
              client.tabGroups,
              browserTabOrderTabs(client.getSnapshot().workspaceTabs),
            ),
            command.tabIds,
          ),
        ),
      );
      return rpcSuccess({ type: command.type, layout: client.tabGroups });
    case "workspace.tabs.move": {
      const result = moveBrowserTabs(
        browserTabArrangement(
          client.tabGroups,
          browserTabOrderTabs(client.getSnapshot().workspaceTabs),
        ),
        command,
      );
      if (!result.ok)
        throw new HostClientRequestError({
          message: result.message,
          code: result.code,
          status: result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400,
        });
      client.setTabGroups(
        arrangedBrowserTabLayout(
          { ...client.tabGroups, revision: client.tabGroups.revision + 1 },
          result.arrangement,
        ),
      );
      return rpcSuccess({ type: command.type, layout: client.tabGroups });
    }
    case "workspace.tabGroup.update": {
      if (!client.tabGroups.groups.some((group) => group.id === command.groupId))
        throw new Error("The group no longer exists.");
      const { title, color, collapsed } = command;
      client.setTabGroups({
        ...client.tabGroups,
        revision: client.tabGroups.revision + 1,
        groups: client.tabGroups.groups.map((group) =>
          group.id === command.groupId
            ? {
                ...group,
                ...(title === undefined ? {} : { title }),
                ...(color === undefined ? {} : { color }),
                ...(collapsed === undefined ? {} : { collapsed }),
              }
            : group,
        ),
      });
      return rpcSuccess({ type: command.type, layout: client.tabGroups });
    }
    case "workspace.tabs.close": {
      const closed: string[] = [];
      const failed: { tabId: string; message: string }[] = [];
      for (const tabId of new Set(command.tabIds)) {
        const place = placeList(client.getSnapshot()).find(
          (place) =>
            place.kind === "browser" &&
            place.destination.kind === "browser" &&
            place.destination.tabId === tabId,
        );
        const sessionId =
          place?.destination.kind === "browser" ? place.destination.sessionId : null;
        const catalog = client
          .getSnapshot()
          .browserSessions.find((session) => session.id === sessionId)?.tabCatalog;
        try {
          if (!catalog && place?.workspaceTab && place.workspaceTab.state !== "live") {
            const snapshot = client.getSnapshot();
            client.updatePlaces({
              ...snapshot,
              workspaceTabs: snapshot.workspaceTabs?.map((lineage) =>
                lineage.tabs?.some((tab) => tab.id === tabId)
                  ? {
                      ...lineage,
                      revision: lineage.revision + 1,
                      tabs: lineage.tabs.filter((tab) => tab.id !== tabId),
                    }
                  : lineage,
              ),
            });
            client.setTabGroups({
              ...removeGroupedTabs(client.tabGroups, [tabId]),
              order: client.tabGroups.order?.filter((id) => id !== tabId),
            });
            closed.push(tabId);
            continue;
          }
          if (!client.places || !sessionId || !catalog) throw new Error("The tab is unavailable.");
          await client.places.close(sessionId, tabId, catalog);
          closed.push(tabId);
        } catch (error) {
          failed.push({ tabId, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return rpcSuccess(
        hostApi["commands.dispatch"].success.parse({ type: command.type, closed, failed }),
      );
    }
    case "workspace.tab.reopen": {
      if (!client.places) return unsupportedMockRpc();
      const result = client.places.reopen(command.idempotencyKey);
      client.setTabGroups(result.layout);
      return rpcSuccess(result);
    }
    case "workspace.tab.activate":
      return client.places
        ? rpcSuccess(client.places.activateWorkspaceTab(command.tabId))
        : unsupportedMockRpc();
    case "workspace.tab.close":
      return unsupportedMockRpc();
    case "browser.tab.open": {
      if (!client.places) return unsupportedMockRpc();
      return rpcSuccess(await client.places.openTarget(command));
    }
    case "browser.tab.close": {
      if (!client.places) return unsupportedMockRpc();
      return rpcSuccess(
        await client.places.close(command.sessionId, command.surfaceId, {
          generation: command.expectedGeneration,
          revision: command.expectedRevision,
          inventoryRevision: command.expectedRevision,
        }),
      );
    }
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

function mockWorkspaceView(workspace: WorkspaceSummary) {
  return {
    homeThreadId: workspace.homeThreadId,
    capacity: { kind: "host-filesystem" as const },
    createdAt: workspace.updatedAt,
    icon: workspace.icon,
    ...(workspace.color === null ? {} : { color: workspace.color }),
    id: workspace.id,
    kind: workspace.kind,
    location: {
      environmentId: "env_00000000-0000-4000-8000-000000000001" as EnvironmentId,
      kind: "machine" as const,
      name: "Main runner",
    },
    name: workspace.name,
    status: workspace.status,
    storageIssue: workspace.storageIssue,
    updatedAt: workspace.updatedAt,
  };
}

function mockThread(thread: ThreadSummary): Thread {
  return ThreadSchema.parse({
    providerSessionId: thread.providerSessionId,
    doneAt: thread.doneAt,
    accessMode: thread.accessMode,
    capabilityProfileId: "workspace",
    continuationIdentity: thread.continuationIdentity,
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
    role: thread.role,
    status: thread.status,
    title: thread.title,
    icon: thread.icon,
    ...(thread.color === null ? {} : { color: thread.color }),
    updatedAt: thread.updatedAt,
    workspaceId: thread.workspaceId,
  });
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
  sourceConfigs: ReadonlyMap<string, Readonly<Record<string, string>>>,
  preference: (workspaceId: string) => WorkspaceNotificationPreference,
) {
  if (!snapshot.deploymentShape) throw new Error("Mock deployment shape is missing.");
  return {
    browser: {
      available: snapshot.browserAvailable,
      ...(snapshot.browserTabGroups
        ? { tabGroupsVersion: 1, tabGroups: snapshot.browserTabGroups }
        : {}),
      workspaceTabRestoreVersion: snapshot.workspaceTabRestoreVersion,
      workspaceTabs: snapshot.workspaceTabs,
      placements: snapshot.browserPlacements,
      profileGrants: snapshot.browserProfileGrants,
      profiles: snapshot.browserProfiles,
      // The catalog names each browser's conversations, as the Host's does.
      sessions: snapshot.browserSessions.map((session) => ({
        ...session,
        updatedAt: session.createdAt,
        threadIds: session.threadIds ?? [
          ...new Set((session.uses ?? []).map((use) => use.threadId)),
        ],
      })),
    },
    deploymentShape: snapshot.deploymentShape,
    deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
    notificationPreferences: snapshot.workspaces.map(({ id }) => preference(id)),
    environments: snapshot.environments,
    executionPreferences: snapshot.executionPreferences,
    harnesses: snapshot.harnesses.map((harness) => mockHarnessRecord(harness, sourceConfigs)),
    homeWorkspace: snapshot.workspaces[0] ? mockWorkspaceView(snapshot.workspaces[0]) : null,
    identityConfig: requiredMockIdentityConfig(snapshot),
    machines: snapshot.machines,
    sessionSurface: "canonical" as const,
    user: snapshot.user,
    workspaceSharingAvailable: snapshot.workspaceSharingAvailable,
    workspaces: snapshot.workspaces.map(mockWorkspaceView),
    workspaceWindow: snapshot.workspaceWindow,
  };
}

/** The person's signed answer on a Mac, as its Runner stream carries it to a real Host. */
const MockMacAnswerSchema = z.discriminatedUnion("kind", [
  SetComputerAppConnectionSchema.extend({ approval: ComputerAppApprovalSchema }),
  z.strictObject({
    appApproval: z.literal("automatic"),
    approval: ComputerAppApprovalSchema,
    kind: z.literal("policy"),
    runnerId: RunnerIdSchema,
  }),
]);
type MockMacAnswer = z.output<typeof MockMacAnswerSchema>;

export class MockHostClient implements HostClient {
  readonly recentSites: RecentSitesStore;
  readonly browserPreferences: BrowserPreferences;
  readonly retainComputerView: HostClient["retainComputerView"];
  readonly #viewer = new ViewerScope();
  #computerViews: { clear(): void; setConnected(connected: boolean): void } = {
    clear: () => undefined,
    setConnected: () => undefined,
  };
  readonly openComputerView: HostClient["openComputerView"];
  readonly closeComputerView: HostClient["closeComputerView"];
  readonly renewComputerView: HostClient["renewComputerView"];
  readonly listComputerAppWindows: HostClient["listComputerAppWindows"];
  readonly listApprovedComputerApps: HostClient["listApprovedComputerApps"];
  readonly #ownerViews: MockComputerViews;
  readonly #browserPresentationScope = {};
  readonly browserFrames: BrowserFrameStore;
  readonly browserWatchFrames: BrowserFrameStore;
  readonly rpc: HostApiClient;
  get searchSuggestionRequests() {
    return this.#state.searchSuggestionRequests;
  }
  readonly #tabGroups: BrowserTabGroupClient;
  readonly #workspaceTabActivations: WorkspaceTabActivations;
  readonly #state: MockHostState;
  readonly #places: MockPlaceWorld;
  readonly #worldSubscription: () => void;
  readonly #lifecycle: ClientLifecycle | null;

  constructor(options: MockHostClientOptions = {}) {
    this.#lifecycle = options.lifecycle ?? null;
    this.#state = new MockHostState(options);
    this.browserPreferences = new BrowserPreferences(options.recentSitesStorage);
    this.recentSites = new RecentSitesStore({
      ...(options.recentSitesStorage ? { storage: options.recentSitesStorage } : {}),
      now: () => (options.now?.() ?? new Date()).getTime(),
    });
    if (
      options.places !== "absent" &&
      options.initialHome !== "absent" &&
      options.world !== "first-run"
    )
      this.#state.seedPlaces(
        options.world === "busy" || options.world === "stress" ? options.world : "seeded",
      );
    this.#places = new MockPlaceWorld(
      this.#state.getSnapshot,
      (snapshot) => this.#state.updatePlaces(snapshot),
      options.now ?? (() => new Date()),
    );
    this.#state.places = this.#places;
    this.#workspaceTabActivations = new WorkspaceTabActivations({
      snapshot: this.#state.getSnapshot,
      subscribe: (listener) => this.#state.subscribe(listener),
      changed: (ids) =>
        this.#state.updatePlaces({ ...this.#state.getSnapshot(), activatingWorkspaceTabs: ids }),
      dispatch: async (tabId) => {
        const dormant = this.#dormantBrowser;
        // Only the journey's scripted tab waits to be finished; any other saved tab opens at once.
        if (dormant?.tabId !== tabId) return this.#places.activateWorkspaceTab(tabId);
        await new Promise<void>((resolve, reject) => {
          dormant.finish = (error) => (error ? reject(new Error(error)) : resolve());
        }).finally(() => {
          dormant.finish = undefined;
        });
        const group = this.#state
          .getSnapshot()
          .workspaceTabs!.find((value) => value.session.id === dormant.session.id)!;
        return {
          type: "workspace.tab.activate",
          group,
          session: group.session,
          tabId: BrowserSurfaceIdSchema.parse(tabId),
          catalog: dormant.session.tabCatalog!,
        };
      },
      apply: (result) => {
        const dormant = this.#dormantBrowser;
        if (dormant?.tabId !== result.tabId) return;
        const snapshot = this.#state.getSnapshot();
        this.#state.updatePlaces({
          ...snapshot,
          browserSessions: [...snapshot.browserSessions, dormant.session],
        });
      },
    });
    this.#ownerViews = new MockComputerViews(
      this.#state.getSnapshot,
      (snapshot) => this.#state.updatePlaces(snapshot),
      () => this.#state.computerConnections(),
      options.now ?? (() => new Date()),
    );
    this.#state.computerViews = this.#ownerViews;
    // The same viewer authority and paused-while-disconnected views as the
    // Host's client; this world's only disconnection is going offline.
    const syncRecents = () => {
      const snapshot = this.#state.getSnapshot();
      const scope = viewerScopeOf(snapshot);
      if (this.#viewer.change(scope)) {
        this.#workspaceTabActivations.clear();
        this.#computerViews.clear();
      }
      this.#computerViews.setConnected(scope !== null && snapshot.connection !== "offline");
      this.recentSites.setScope(scope);
      this.browserPreferences.setScope(scope);
    };
    syncRecents();
    this.#worldSubscription = this.#state.subscribe(() => {
      syncRecents();
      this.#places.reconcile();
    });
    const frames: BrowserFrameStore = {
      scope: this.#browserPresentationScope,
      accept: (sessionId, surfaceId, token) =>
        this.#places.accept(
          sessionId,
          surfaceId ?? this.#places.activeSurface(sessionId) ?? "",
          token,
        ),
      get: (sessionId, surfaceId) =>
        this.#places.watchFrame(
          sessionId,
          surfaceId ?? this.#places.activeSurface(sessionId) ?? "",
        ),
      subscribe: (sessionId, listener, surfaceId) =>
        this.#places.subscribeWatch(
          sessionId,
          surfaceId ?? this.#places.activeSurface(sessionId) ?? "",
          listener,
        ),
    };
    this.browserFrames = frames;
    this.browserWatchFrames = frames;
    this.rpc = createInMemoryHostApiClient(mockHostApiHandlers(this.#state), mockRpcContext());
    this.#tabGroups = new BrowserTabGroupClient(
      this.rpc,
      (browserTabGroups) =>
        this.#state.updatePlaces({ ...this.#state.getSnapshot(), browserTabGroups }),
      () => this.#viewer.generation,
      () => browserTabOrderTabs(this.#state.getSnapshot().workspaceTabs),
    );
    this.#tabGroups.receive(this.#state.getSnapshot().browserTabGroups);
    this.#state.projectTabGroups = () => this.#tabGroups.receive(this.#state.tabGroups);
    const views = computerViewMethods(
      this.rpc,
      () => undefined,
      () => this.#viewer.generation,
      (viewId) =>
        this.#state
          .getSnapshot()
          .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
          .find((view) => view.viewId === viewId),
    );
    this.#computerViews = views;
    this.retainComputerView = views.retainComputerView;
    this.openComputerView = views.openComputerView;
    this.closeComputerView = views.closeComputerView;
    this.renewComputerView = views.renewComputerView;
    this.listApprovedComputerApps = views.listApprovedComputerApps;
    this.listComputerAppWindows = views.listComputerAppWindows;
  }

  applyThreadStateChanged(event: Extract<AgentEvent, { type: "thread.state-changed" }>): void {
    this.#state.applyThreadStateChanged(event);
  }

  /** For journeys: an agent's input as the Host attributes it, such as one from a teammate's Chat. */
  receiveAgentInput(
    threadId: string,
    author: z.input<typeof MessageAuthorSchema>,
    body: string,
  ): void {
    this.#state.receiveAgentInput(threadId, MessageAuthorSchema.parse(author), body);
  }

  readonly getSnapshot = (): HostSnapshot => {
    this.#ownerViews.expire();
    return this.#state.getSnapshot();
  };
  setSearchSuggestionsAvailable(available: boolean): void {
    this.#state.updatePlaces({ ...this.getSnapshot(), searchSuggestionsAvailable: available });
  }

  #dormantBrowser: {
    session: BrowserSessionSummary;
    tabId: string;
    finish?: ((error?: string) => void) | undefined;
  } | null = null;

  /** A saved tab whose activation is completed explicitly by the journey. */
  scriptDormantBrowser(options: {
    profileName: string;
    connected?: boolean;
    unavailableReason?: string;
  }) {
    this.#places.script();
    const snapshot = this.#state.getSnapshot();
    const session = snapshot.browserSessions.find(
      (value) => value.profileId && value.tabCatalog?.tabs.length,
    );
    if (!session?.tabCatalog) throw new Error("No mock browser to suspend.");
    const tab = session.tabCatalog.tabs[0]!;
    this.#dormantBrowser = {
      session: {
        ...session,
        tabs: session.tabs.map((value) =>
          value.id === tab.id ? { ...value, loading: true } : value,
        ),
        tabCatalog: {
          ...session.tabCatalog,
          tabs: session.tabCatalog.tabs.map((value) =>
            value.id === tab.id ? { ...value, loading: true } : value,
          ),
        },
      },
      tabId: tab.id,
    };
    this.#state.updatePlaces({
      ...snapshot,
      browserProfiles: snapshot.browserProfiles.map((profile) =>
        profile.id === session.profileId ? { ...profile, name: options.profileName } : profile,
      ),
      browserPlacements: snapshot.browserPlacements.map((placement) =>
        placement.runnerId === session.placement.runnerId
          ? {
              ...placement,
              available: options.connected !== false,
              unavailableReason: options.unavailableReason,
            }
          : placement,
      ),
      workspaceTabs: snapshot.workspaceTabs?.map((group) =>
        group.session.id === session.id
          ? {
              ...group,
              tabs: group.tabs?.map((row) => ({ ...row, state: "suspended" as const })),
            }
          : group,
      ),
      browserSessions: snapshot.browserSessions.filter((value) => value.id !== session.id),
    });
    return { sessionId: session.id, tabId: tab.id, title: tab.title, site: tab.site };
  }

  /** A navigation can stay loading after the restored page has painted. */
  setBrowserLoading(tabId: string, loading: boolean): void {
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((session) => ({
        ...session,
        tabs: session.tabs.map((tab) => (tab.id === tabId ? { ...tab, loading } : tab)),
        ...(session.tabCatalog
          ? {
              tabCatalog: {
                ...session.tabCatalog,
                tabs: session.tabCatalog.tabs.map((tab) =>
                  tab.id === tabId ? { ...tab, loading } : tab,
                ),
              },
            }
          : {}),
      })),
    });
  }

  finishBrowserActivation(error?: string): void {
    if (!this.#dormantBrowser?.finish) throw new Error("No browser activation is pending.");
    this.#dormantBrowser.finish(error);
  }

  readonly activateWorkspaceTab: NonNullable<HostClient["activateWorkspaceTab"]> = (tabId) =>
    this.#workspaceTabActivations.activate(tabId);

  /** Connection, closure and lasting reasons can change while a saved tab waits. */
  setDormantBrowserState(change: {
    connected?: boolean;
    unavailableReason?: string;
    closed?: boolean;
    accountChanged?: boolean;
    restoring?: boolean;
  }): void {
    const dormant = this.#dormantBrowser;
    if (!dormant) throw new Error("No saved browser tab is scripted.");
    const snapshot = this.#state.getSnapshot();
    this.#state.updatePlaces({
      ...snapshot,
      ...(change.accountChanged && snapshot.user
        ? { user: { ...snapshot.user, id: createId("user") } }
        : {}),
      browserPlacements: snapshot.browserPlacements.map((placement) =>
        placement.runnerId === dormant.session.placement.runnerId
          ? {
              ...placement,
              ...(change.connected === undefined ? {} : { available: change.connected }),
              ...(change.unavailableReason === undefined
                ? {}
                : { unavailableReason: change.unavailableReason }),
            }
          : placement,
      ),
      workspaceTabs: snapshot.workspaceTabs?.map((group) =>
        group.session.id === dormant.session.id
          ? {
              ...group,
              tabs: change.closed
                ? []
                : group.tabs?.map((row) => ({
                    ...row,
                    ...(change.restoring ? { state: "restoring" as const } : {}),
                  })),
            }
          : group,
      ),
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
  readonly retainBrowserViewer = (sessionId: string, surfaceId?: string): (() => void) =>
    this.#places.retain(sessionId, surfaceId ?? this.#places.activeSurface(sessionId) ?? "");
  readonly placeActivity = (placeKey: string) => this.#places.activity.get(placeKey);
  readonly subscribePlaceActivity = (placeKey: string, listener: () => void) =>
    this.#places.subscribeActivity(placeKey, listener);
  readonly latestPlaceOfThread = (threadId: string) => this.#places.latest.get(threadId);
  readonly actInPlace = (threadId: string, placeKey: string) =>
    this.#places.actInPlace(threadId, placeKey);
  /** A mock helper's current window for one held app. */
  setComputerSessionWindow(
    machineId: string,
    sessionId: string,
    appKey: string,
    window: { id: number; title: string },
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
  readonly subscribeLatestPlace = (threadId: string, listener: () => void) => {
    this.#places.start();
    return this.#places.latest.subscribe(threadId, listener);
  };
  readonly readBrowserContextCandidate = (sessionId: string, tabId: string) =>
    this.#places.candidate(sessionId, tabId);
  readonly openBrowserTab = async (
    target: string | BrowserTabOpenInput,
    options: BrowserTabOpenOptions = {},
  ) => {
    const started = this.#viewer.generation;
    const opened = await this.#places.openTarget(
      BrowserTabOpenCommandSchema.parse({
        type: "browser.tab.open",
        ...(typeof target === "string" ? { sessionId: target } : target),
        ...options,
        idempotencyKey: options.idempotencyKey ?? `open-tab:${crypto.randomUUID()}`,
      }),
    );
    if (started !== this.#viewer.generation)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while the browser was opening.",
      });
    return opened;
  };
  readonly reopenWorkspaceTab = async () => {
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "workspace.tab.reopen",
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    if (result.type !== "workspace.tab.reopen") throw new Error("Unexpected tab reopen result.");
    this.#tabGroups.receive(result.layout);
    return result;
  };
  readonly groupBrowserTabs: HostClient["groupBrowserTabs"] = (ids, target) =>
    this.#tabGroups.groupBrowserTabs(ids, target);
  readonly moveBrowserTabs: HostClient["moveBrowserTabs"] = (move) =>
    this.#tabGroups.moveBrowserTabs(move);
  readonly ungroupBrowserTabs: HostClient["ungroupBrowserTabs"] = (ids) =>
    this.#tabGroups.ungroupBrowserTabs(ids);
  readonly updateBrowserTabGroup: HostClient["updateBrowserTabGroup"] = (id, update) =>
    this.#tabGroups.updateBrowserTabGroup(id, update);
  readonly closeWorkspaceTabs: HostClient["closeWorkspaceTabs"] = async (tabIds) => {
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "workspace.tabs.close",
        tabIds: tabIds.map((id) => BrowserSurfaceIdSchema.parse(id)),
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    if (result.type !== "workspace.tabs.close") throw new Error("Unexpected tabs close result.");
    this.#state.updatePlaces({
      ...this.#state.getSnapshot(),
      browserTabGroups: this.#tabGroups.receive(this.#state.tabGroups),
    });
    return result;
  };
  /** Apply a bootstrap layout from another actor, including stale rereads in journeys. */
  readonly applyBrowserTabLayout = (layout: BrowserTabLayout | undefined) => {
    if (layout && layout.revision >= this.#state.tabGroups.revision)
      this.#state.setTabGroups(layout);
    this.#state.updatePlaces({
      ...this.#state.getSnapshot(),
      browserTabGroups: this.#tabGroups.receive(layout),
    });
  };
  readonly closeBrowserTab = (
    sessionId: string,
    surfaceId: string,
    expected: { readonly generation: number; readonly revision: number },
  ) =>
    this.#places.close(sessionId, surfaceId, expected).then((result) => {
      this.#state.updatePlaces({
        ...this.#state.getSnapshot(),
        browserTabGroups: this.#tabGroups.receive(this.#state.tabGroups),
      });
      return result;
    });
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
  readonly readBrowserTabIcon = (sessionId: string, iconRef: string) =>
    this.#places.icon(sessionId, iconRef);
  readonly retainBrowserWatch = (sessionId: string, surfaceId?: string): (() => void) =>
    this.#places.retain(sessionId, surfaceId ?? this.#places.activeSurface(sessionId) ?? "");
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
    const phone = this.getSnapshot().machines.find((machine) =>
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
    return new MockPhoneDisplaySocket(
      !phone ? "ended" : phone.computerUse?.displayStreamSupported ? "live" : "unsupported",
    );
  }
  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId?: string): void {
    if (surfaceId) {
      this.#places.accept(sessionId, surfaceId, token);
      return;
    }
    const active = this.#places.activeSurface(sessionId);
    if (active) this.#places.accept(sessionId, active, token);
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#places.start();
    return this.#state.subscribe(listener);
  };

  async createAttachment(input: {
    readonly workspaceId: string;
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

  /** The preview projects every Thread it holds, so there is nothing to hold open. */
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
  setEnvironmentConnected(environmentId: string, connected: boolean): void {
    this.#state.setEnvironmentConnected(environmentId, connected);
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
  mockConnectIphone(input: { enrollmentId: string; runnerId: string; name: string }): void {
    this.#state.mockConnectIphone(input);
  }

  async mockAnswerIphoneApproval(input: {
    setupRequestId: string;
    decision: "allow" | "deny";
  }): Promise<void> {
    await this.#state.mockAnswerIphoneApproval(input);
  }

  /**
   * The person's signed answer on a Mac. A real Host takes it on that Mac's
   * own Runner stream, never as a client command, so the mock takes it here.
   */
  async answerComputerAppApprovalOnMac(
    input: z.input<typeof MockMacAnswerSchema>,
  ): Promise<IntegrationConnectionSummary | null> {
    return this.#state.setComputerAppConnection(MockMacAnswerSchema.parse(input));
  }

  activateWorkspace(workspaceId: string): void {
    this.#state.activateWorkspace(workspaceId);
  }

  async cancelThreadInput(threadId: string, messageId: string): Promise<void> {
    await this.dispatch({
      idempotencyKey: `mock-input-cancel:${crypto.randomUUID()}`,
      messageId,
      threadId,
      type: "thread.input.cancel",
    });
  }

  /** Like the session client, the queue takes the new order before the Host answers. */
  async moveThreadInput(
    threadId: string,
    messageId: string,
    beforeMessageId: string | null,
  ): Promise<void> {
    this.#state.moveThreadInput(threadId, messageId, beforeMessageId);
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
      accessMode: input.accessMode,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
      idempotencyKey: input.idempotencyKey ?? `mock-thread:${crypto.randomUUID()}`,
      modelSelection: input.modelSelection,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.home ? { home: true } : {}),
      ...(input.generateTitle && this.getSnapshot().threadRenameAvailable
        ? { generateTitle: true }
        : {}),
      title: input.title?.trim() || "Untitled thread",
      type: "thread.create",
      workspaceId: input.workspaceId,
    });
    if (result.type !== "thread.create") throw new Error("Thread command mismatch.");
    const thread = this.getSnapshot().threads.find(({ id }) => id === result.thread.id);
    if (!thread) throw new Error("The mock Thread was not projected.");
    await this.#rememberQuietly({
      accessMode: input.accessMode,
      selection: {
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        modelSelection: input.modelSelection,
      },
    });
    return thread;
  }

  async renameThread(threadId: string, title: string): Promise<ThreadSummary> {
    if (!this.getSnapshot().threadRenameAvailable)
      throw new Error("This Host does not support task renaming.");
    const result = await this.dispatch({
      type: "thread.rename",
      threadId,
      title: ThreadTitleSchema.parse(title),
      idempotencyKey: `mock-thread-rename:${crypto.randomUUID()}`,
    });
    if (result.type !== "thread.rename") throw new Error("Thread command mismatch.");
    return this.getSnapshot().threads.find(({ id }) => id === threadId)!;
  }

  async createHome(
    input: Omit<CreateThreadInput, "parentThreadId" | "title" | "home">,
  ): Promise<ThreadSummary> {
    return this.createThread({ ...input, home: true, title: CHAT_THREAD_TITLE });
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

  async loadTranscriptAround(threadId: string, messageId: string): Promise<void> {
    const result = await this.rpc["thread.messages.list"]({
      threadId,
      aroundMessageId: messageId,
      limit: 50,
    });
    if (!result.ok) throw new Error(result.error.message);
    // The preview keeps the whole transcript resident, including the requested source.
    this.#state.updatePlaces({
      ...this.getSnapshot(),
      savedViewReadiness: {
        ...(this.getSnapshot().savedViewReadiness ?? emptySavedViewReadiness()),
        home: {
          status: "window",
          threadId,
          workspaceId: this.getSnapshot().threads.find(({ id }) => id === threadId)!.workspaceId,
          latest: false,
        },
      },
    });
  }

  async loadLatestTranscript(threadId: string): Promise<void> {
    if (!this.getSnapshot().threads.some((thread) => thread.id === threadId))
      throw new Error("Thread not found.");
    const snapshot = this.getSnapshot();
    if (threadId === snapshot.homeThreadId && snapshot.homeWorkspaceId)
      this.#state.updatePlaces({
        ...snapshot,
        savedViewReadiness: {
          ...(snapshot.savedViewReadiness ?? emptySavedViewReadiness()),
          home: { status: "window", threadId, workspaceId: snapshot.homeWorkspaceId, latest: true },
        },
      });
  }

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    return this.#state.subscribeNotifications(listener);
  }

  async markThreadRead(threadId: string, throughSequence: string): Promise<void> {
    await this.dispatch({
      type: "thread.read.mark",
      idempotencyKey: `mock-read:${crypto.randomUUID()}`,
      threadId,
      throughSequence,
    });
  }

  async setTaskDone(threadId: string, done: boolean): Promise<Thread> {
    const result = await this.dispatch({
      done,
      idempotencyKey: `mock-done:${crypto.randomUUID()}`,
      threadId,
      type: "thread.shared-done.set",
    });
    if (result.type !== "thread.shared-done.set") throw new Error("Done command mismatch.");
    return result.thread;
  }

  async loadWorkspaceTasks(workspaceId: string): Promise<void> {
    this.#state.loadWorkspaceTasks(workspaceId);
  }

  /** The preview's task lists always hold every task, so there is no earlier page. */
  async loadEarlierTasks(_workspaceId?: string): Promise<void> {}

  async setWorkspaceNotificationMute(workspaceId: string, muted: boolean): Promise<void> {
    await this.dispatch({
      type: "workspace.notifications.update",
      idempotencyKey: `mock-mute:${crypto.randomUUID()}`,
      workspaceId,
      muted,
    });
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
    const thread = this.getSnapshot().threads.find(({ id }) => id === threadId);
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
    await this.#rememberQuietly({
      selection: {
        environmentId: thread.environmentId,
        harnessInstanceId: selection.harnessInstanceId,
        modelSelection: selection.modelSelection,
      },
    });
    return this.#projectedThread(threadId);
  }

  async updateThreadAccess(threadId: string, accessMode: ThreadAccessMode): Promise<ThreadSummary> {
    const thread = this.getSnapshot().threads.find(({ id }) => id === threadId);
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
    const thread = this.getSnapshot().threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("The mock Thread was not projected.");
    return thread;
  }

  /** The mutation already succeeded; the next bootstrap is authoritative. */
  async #rememberQuietly(choice: ExecutionChoice): Promise<void> {
    await this.rememberExecution(choice).catch(() => undefined);
  }

  async dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput> {
    const result = await this.rpc["commands.dispatch"](command);
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
    this.#workspaceTabActivations.dispose();
    this.#state.updatePlaces({ ...this.#state.getSnapshot(), activatingWorkspaceTabs: [] });
    this.#computerViews.clear();
    this.#worldSubscription();
    this.#places.dispose();
    this.#state.dispose();
  }

  listWorkspaceFiles(
    workspaceId: string,
    input: { readonly parentKey: string },
    _signal?: AbortSignal,
  ) {
    return this.#state.listWorkspaceFiles(workspaceId, input);
  }

  load(): Promise<void> {
    return this.#state.load();
  }

  loadEarlierTranscript(threadId: string): Promise<void> {
    return this.#state.loadEarlierTranscript(threadId);
  }

  loadEarlierWorkspaces(): Promise<void> {
    return this.#state.loadEarlierWorkspaces();
  }

  loadThreadInputQueue(threadId: string): Promise<ThreadInputQueue> {
    return Promise.resolve(this.#state.loadThreadInputQueue(threadId));
  }

  previewWorkspaceFile(workspaceId: string, fileKey: string, _signal?: AbortSignal) {
    return this.#state.previewWorkspaceFile(workspaceId, fileKey);
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

  async updateMachineAccess(input: {
    readonly expectedRevision: number;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: string;
  }): Promise<MachineAccessUpdateOutcome> {
    const result = await this.dispatch({
      expectedRevision: input.expectedRevision,
      idempotencyKey: `mock-machine-access:${crypto.randomUUID()}`,
      policy: input.policy,
      runnerId: input.runnerId,
      type: "machine.access.update",
    });
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
              ...(session.tabCatalog
                ? {
                    tabCatalog: {
                      ...session.tabCatalog,
                      revision: session.tabCatalog.revision + 1,
                      tabs: session.tabCatalog.tabs.map((tab) =>
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
    if (
      command.type === "navigation.reload" &&
      command.ignoreCache !== undefined &&
      this.getSnapshot().browserSessions.find((session) => session.id === sessionId)
        ?.navigationVersion !== 1
    )
      throw new Error("This browser does not support reloading without cache.");
    this.#places.command(sessionId, command);
  }

  async startBrowser(
    workspaceId: string,
    identity: import("../host/client.js").BrowserStartIdentity,
    placement?: import("../host/client.js").BrowserPlacementSummary,
    threadId?: string,
    viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary> {
    const result = await this.dispatch({
      idempotencyKey: `mock-browser:${crypto.randomUUID()}`,
      input: {
        ...(viewport ? { viewport } : {}),
        ...(threadId ? { threadId: ThreadIdSchema.parse(threadId) } : {}),
        ...(placement
          ? { placement: { kind: "runner" as const, runnerId: placement.runnerId } }
          : {}),
        ...(identity.kind === "fresh"
          ? { fresh: true as const }
          : { profileId: identity.profileId }),
      },
      type: "browser.session.start",
      workspaceId,
    });
    if (result.type !== "browser.session.start") throw new Error("Browser command mismatch.");
    const session = this.getSnapshot().browserSessions.find(({ id }) => id === result.session.id);
    if (!session) throw new Error("The mock Browser Session was not projected.");
    return session;
  }

  async stopRun(threadId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    const run = thread ? threadStopTarget({ runQueue: snapshot.runQueue, thread }) : null;
    if (!run) throw new Error("This Thread has nothing to stop.");
    await this.dispatch({
      idempotencyKey: `mock-interrupt:${crypto.randomUUID()}`,
      runId: run.id,
      threadId,
      type: "run.interrupt",
    });
  }

  workspaceFileDownloadUrl(workspaceId: string, fileKey: string): string {
    return this.#state.workspaceFileDownloadUrl(workspaceId, fileKey);
  }
}

class MockHostState {
  readonly searchSuggestionRequests: { readonly query: string; readonly at: number }[] = [];
  computerViews: MockComputerViews | undefined;
  computerConnections() {
    return this.integrations.connections;
  }
  places: MockPlaceWorld | null = null;
  readonly #threadState = new ThreadStateProjection();
  readonly #provisionalTitles = new Set<string>();
  readonly #provisionalIcons = new Set<string>();
  readonly #recentMarkColors = new Map<string, MarkColor[]>();
  readonly #titleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly preferenceRevisions = new Map<string, number>();
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

  /** The latest of these messages the reader has not read, by number. */
  private unreadAfter(messages: readonly Message[], read: string | null): Sequence | null {
    let latest: Sequence | null = null;
    for (const message of messages) {
      if (read !== null && BigInt(message.sequence) <= BigInt(read)) continue;
      if (message.author.kind === "human" && message.author.userId === this.snapshot.user?.id)
        continue;
      if (latest === null || BigInt(message.sequence) > BigInt(latest)) latest = message.sequence;
    }
    return latest;
  }

  threadReadState(threadId: string): ThreadReadState {
    const existing = this.snapshot.threadReadStates[threadId];
    const read = existing?.readSequence ?? null;
    const unread = this.unreadAfter(this.publishedMessages(threadId), read);
    return {
      threadId: ThreadIdSchema.parse(threadId),
      readSequence: read === null ? null : SequenceSchema.parse(read),
      unreadSequence: unread === null ? null : SequenceSchema.parse(unread),
      placement:
        read === null
          ? null
          : {
              done: this.snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null,
              sequence: SequenceSchema.parse(read),
            },
      placementRevision: SequenceSchema.parse(String(this.snapshot.revision)),
      asOfSequence: SequenceSchema.parse(String(this.snapshot.revision)),
    };
  }

  bootstrap() {
    return mockBootstrap(this.snapshot, this.harnessSourceConfigs, (workspaceId) =>
      this.workspaceNotificationPreference(workspaceId),
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
    const previous = this.snapshot.threads.find(({ id }) => id === event.threadId);
    this.sequence = Math.max(this.sequence, Number(event.sequence));
    this.#threadState.record(event);
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === event.threadId
          ? this.#threadState.reconcile(thread, event.sequence, thread)
          : thread,
      ),
    });
    this.#threadState.retainLoaded(this.snapshot.threads);
    this.applyThreadReadStates([this.threadReadState(event.threadId)]);
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
      case "thread.shared-done.set":
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

  applyThreadReadStates(states: readonly ThreadReadState[]): void {
    const readStates = { ...this.snapshot.threadReadStates };
    for (const state of states) readStates[state.threadId] = state;
    this.update({
      ...this.snapshot,
      threadReadStates: readStates,
      threads: this.snapshot.threads.map((thread) => ({
        ...thread,
        unread: isThreadUnread(readStates[thread.id]),
      })),
    });
  }

  markThreadRead(threadId: string, throughSequence: string): ThreadReadState {
    const current = this.threadReadState(threadId);
    const messages = this.publishedMessages(threadId);
    if (!messages.some((message) => message.sequence === throughSequence))
      throw mockConflict("Read position must name a published message in this Thread");
    const readSequence = SequenceSchema.parse(
      String(
        current.readSequence === null
          ? BigInt(throughSequence)
          : BigInt(current.readSequence) > BigInt(throughSequence)
            ? BigInt(current.readSequence)
            : BigInt(throughSequence),
      ),
    );
    const state: ThreadReadState = {
      ...current,
      readSequence,
      placement: {
        done: this.snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null,
        sequence: readSequence,
      },
      placementRevision: current.asOfSequence,
      unreadSequence: this.unreadAfter(messages, readSequence),
    };
    this.applyThreadReadStates([state]);
    return state;
  }

  async setTaskDone(threadId: string, done: boolean): Promise<ThreadSummary> {
    if (!this.snapshot.sharedTaskDoneAvailable)
      throw new Error("This Host does not support shared task Done.");
    const thread = this.snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Task not found.");
    if (
      thread.role !== "work" ||
      this.snapshot.homeThreadId === threadId ||
      this.snapshot.workspaces.some((workspace) => workspace.homeThreadId === threadId)
    )
      throw new Error("Chat cannot be Done.");
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
          inputQueuePaused: false,
          ...(done ? { status: "idle", pendingRequests: 0 } : {}),
        },
        {},
      );
    }
    return this.snapshot.threads.find((item) => item.id === threadId)!;
  }

  workspaceNotificationPreference(workspaceId: string): WorkspaceNotificationPreference {
    if (!this.snapshot.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new Error("Workspace not found.");
    return {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      muted: this.snapshot.notificationMutes.includes(workspaceId),
      revision: SequenceSchema.parse(String(this.preferenceRevisions.get(workspaceId) ?? 0)),
    };
  }

  setWorkspaceNotificationMute(
    workspaceId: string,
    muted: boolean,
  ): WorkspaceNotificationPreference {
    if (!this.snapshot.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new Error("Workspace not found.");
    const others = this.snapshot.notificationMutes.filter((id) => id !== workspaceId);
    this.preferenceRevisions.set(workspaceId, (this.preferenceRevisions.get(workspaceId) ?? 0) + 1);
    this.update({ ...this.snapshot, notificationMutes: muted ? [...others, workspaceId] : others });
    return this.workspaceNotificationPreference(workspaceId);
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
    readonly workspaceId: string;
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
        prior.workspaceId !== input.workspaceId ||
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
      workspaceId: input.workspaceId,
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
        attachment.workspaceId !== thread.workspaceId ||
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
  private readonly computerAppSetupRequests = new Map<string, ComputerAppSetupRequest>();
  /** Enrollments retired here, which the preview, like the Host, keeps no row for. */
  private readonly retiredEnrollments = new Set<string>();
  private readonly phoneEnrollments = new Map<
    string,
    {
      readonly name: string;
      readonly profile: "iphone" | null;
      readonly result: {
        readonly enrollmentId: string;
        readonly expiresAt: string;
        readonly pairing: typeof mockAgentPhonePairingTarget;
        readonly token: string;
      };
    }
  >();
  private readonly iphoneApprovalKeys = new Map<string, string>();
  private readonly activeRuns = new Map<string, ActiveMockRun>();
  private readonly integrations = createInitialIntegrationState(mockUserId);
  private readonly integrationAttempts = new Map<string, MockIntegrationAttempt>();
  readonly chrome: MockChromeSignIns;
  private readonly nextRunOrdinals = new Map<string, number>();
  /** Queued messages per Thread in send order; a Run's seed is never here. */
  private readonly threadInputQueues = new Map<string, PendingMockInput[]>();
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
  private readonly latencyMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(notification: NotificationView) => void>();
  private readonly assignments = new Map<string, AssignmentView>();
  private readonly assignmentModels = new Map<
    string,
    { readonly modelSelection: ModelSelection; readonly parentModelSelection: ModelSelection }
  >();
  /** What each task in the preview does and how Home answers once it is back. */
  private readonly taskScripts = new Map<string, MockTaskScript>();
  private readonly now: () => Date;
  private sequence = 10;
  /** The sessions this client can see, until it revokes them. */
  private sessions: AuthSessionSummary[];
  private snapshot: HostSnapshot;
  tabGroups: BrowserTabLayout = { revision: 0, groups: [], order: [] };
  projectTabGroups: (() => BrowserTabLayout | undefined) | undefined;
  setTabGroups(layout: BrowserTabLayout): void {
    this.tabGroups = layout;
    this.update({ ...this.snapshot, browserTabGroups: layout });
  }

  constructor(options: MockHostClientOptions = {}) {
    this.sessions = [
      ...(options.sessions ?? [
        {
          absoluteExpiresAt: "2026-10-14T00:00:00.000Z",
          createdAt: "2026-09-14T00:00:00.000Z",
          current: true,
          deviceLabel: "Chrome on Mac",
          expiresAt: "2026-09-21T00:00:00.000Z",
          form: "computer",
          id: createId("authSession"),
          lastSeenAt: "2026-09-14T00:00:00.000Z",
          machineLocal: false,
        },
      ]),
    ];
    this.latencyMs = options.latencyMs ?? 420;
    this.now = options.now ?? (() => new Date());
    this.chrome = new MockChromeSignIns(this.now);
    const initial = {
      ...seedMockTaskMarks(createInitialSnapshot()),
      browserTabGroups: this.tabGroups,
      sharedTaskDoneAvailable: options.sharedTaskDoneAvailable ?? true,
    };
    const firstRun = options.world === "first-run";
    this.snapshot = firstRun
      ? firstRunWorld(initial)
      : options.initialHome === "absent"
        ? withoutInitialHome(initial)
        : initial;
    if (options.initialHome !== "absent" && !firstRun) this.seedHomeTask();
    for (const thread of this.snapshot.threads) {
      if (thread.icon === null && thread.id !== this.snapshot.homeThreadId)
        this.#provisionalIcons.add(thread.id);
    }
    const homeThread = this.snapshot.threads.find(({ id }) => id === this.snapshot.homeThreadId);
    const workThread = this.snapshot.threads.find(({ id }) => id === mockPortableFsThreadId);
    if (options.automations !== "absent" && homeThread && workThread) {
      for (const record of seedMockAutomations({
        homeThread,
        now: this.now(),
        userId: mockUserId,
        workThread,
      })) {
        this.triggers.set(record.trigger.id, record);
      }
    }
    // The setup request behind the seeded Numbers Request, dated from this
    // client's clock so it is pending for as long as a real one would be.
    if (options.initialHome !== "absent" && !firstRun)
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
        runnerId: mockMessagesRunnerId,
        server: null,
        threadId: ThreadIdSchema.parse(mockComputerUseThreadId),
        threadTitle: "Build the new architecture",
        workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001"),
        workspaceName: "Main",
      });
    // A task's computer access Request always stands on its setup request,
    // which the computer — a Mac or a phone — is the one to answer.
    for (const request of options.pendingRequests ?? []) {
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
        runnerId: payload.runnerId,
        server: null,
        threadId: ThreadIdSchema.parse(request.originatingThreadId),
        threadTitle: null,
        workspaceId: payload.workspaceId,
        workspaceName: null,
      });
    }
    if (options.pendingRequests?.length) {
      const additions = new Map<string, Request[]>();
      for (const request of options.pendingRequests) {
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
    // The reader has read each seeded Thread through its latest message,
    // except the ones seeded unread.
    const readStates = Object.fromEntries(
      this.snapshot.threads.map((thread) => {
        const state = this.threadReadState(thread.id);
        const latest = this.listThreadMessages({ threadId: thread.id, limit: 1 }).messages.at(-1);
        if (!latest) return [thread.id, state];
        return [
          thread.id,
          thread.unread
            ? { ...state, readSequence: null, unreadSequence: latest.sequence }
            : { ...state, readSequence: latest.sequence, unreadSequence: null },
        ];
      }),
    );
    // What `requests.list` and `tasks.list` would answer for what is seeded above.
    this.snapshot = {
      ...this.snapshot,
      threadReadStates: readStates,
      waitingRequests: this.waitingRequests(),
    };
    this.snapshot = {
      ...this.snapshot,
      threadReadStates: Object.fromEntries(
        this.snapshot.threads.map((thread) => [thread.id, this.threadReadState(thread.id)]),
      ),
    };
    const tasks = this.taskList(null);
    this.snapshot = { ...this.snapshot, tasks, activeTasks: this.activeTaskEntries(tasks) };
  }

  private readonly acceptedCommands = new Map<
    string,
    { command: string; result: ReturnType<typeof executeMockCommand> }
  >();
  executeCommandOnce(input: HostApiCommand): ReturnType<typeof executeMockCommand> {
    const command = hostApi["commands.dispatch"].payload.parse(input);
    if (
      command.type !== "thread.sendMessage" &&
      command.type !== "thread.icon.set" &&
      command.type !== "workspace.color.set"
    )
      return executeMockCommand(this, command);
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
          case "workspace.color.set": {
            const workspaceId = result.data.workspace.id;
            const workspace = this.snapshot.workspaces.find(({ id }) => id === workspaceId);
            if (!workspace) throw new Error("Workspace not found.");
            return rpcSuccess(
              hostApi["commands.dispatch"].success.parse({
                type: "workspace.color.set",
                workspace: mockWorkspaceView(workspace),
              }),
            );
          }
          default:
            return result;
        }
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
  updatePlaces(snapshot: HostSnapshot): void {
    this.update(snapshot);
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

  /** As the Host hears a computer go and come back: its status alone changes. */
  setMachineStatus(machineId: string, status: MachineSummary["status"]): void {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((machine) =>
        machine.id === machineId ? { ...machine, status } : machine,
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

  /** The Host's two refusals: no such task, or one in a Workspace this viewer cannot open. */
  getAssignment(assignmentId: string): AssignmentView {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment)
      throw new HostClientRequestError({
        code: "not_found",
        message: "Task not found.",
        status: 404,
      });
    const worker = this.snapshot.threads.find(({ id }) => id === assignment.workerThreadId);
    if (!worker || !this.snapshot.workspaces.some(({ id }) => id === worker.workspaceId))
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
        workspaceId: thread.workspaceId,
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
    const item = this.takePendingInput(threadId, messageId);
    const input = ThreadInputSchema.parse({
      ...item.input,
      runId: expectedRunId,
      state: "claimed",
      updatedAt: this.now().toISOString(),
    });
    const active = this.activeRuns.get(threadId);
    if (active?.id === expectedRunId) active.steered.push(item.body);
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
      items: (this.threadInputQueues.get(threadId) ?? []).map((item) => ({
        message: item.message,
        input: item.input,
        canCancel: true,
        canMove: true,
        canSteer: steerRunId !== null,
      })),
    });
  }

  /** The snapshot with that Thread's queue view recomputed from the snapshot's own Runs and flags. */
  private withInputQueue(snapshot: HostSnapshot, threadId: string): HostSnapshot {
    const queue = this.inputQueueView(snapshot, threadId);
    if (!queue) return snapshot;
    return { ...snapshot, inputQueues: { ...snapshot.inputQueues, [threadId]: queue } };
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

  /**
   * What a Run in the preview does with the input that started it: Home
   * answers a task's return and hands substantial asks to a task; every other
   * Run is the generic one.
   */
  private executeRun(thread: ThreadSummary, run: ActiveMockRun, pending: PendingMockInput) {
    const returned = assignmentReturnId(pending.message);
    if (returned !== null) return this.executeTaskAnswer(thread, run, returned);
    const script = thread.id === this.snapshot.homeThreadId ? mockTaskScript(pending.body) : null;
    if (script) return this.executeHomeDelegation(thread, run, script);
    return this.executeMockRun(thread, run, pending.body);
  }

  activateWorkspace(_workspaceId: string): void {}

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

  async exchangeInvitation() {
    return {
      expiresAt: new Date(this.now().getTime() + 7 * 86_400_000).toISOString(),
      invitationType: "link" as const,
      inviterName: "Alex",
      requiresVerifiedEmail: false,
      role: "collaborator" as const,
      workspaceName: "Opensteer",
    };
  }

  async acceptInvitation(): Promise<void> {}

  async beginHarnessAuthentication(): Promise<HarnessAuthenticationEnvelope> {
    return { authentication: { status: "ready" }, environmentStatus: "connected" };
  }

  async submitHarnessAuthentication(): Promise<HarnessAuthenticationEnvelope> {
    return { authentication: { status: "ready" }, environmentStatus: "connected" };
  }

  async logoutHarness(): Promise<HarnessAuthenticationEnvelope> {
    return { authentication: { status: "not-started" }, environmentStatus: "connected" };
  }

  async getHarnessAuthentication(): Promise<HarnessAuthenticationEnvelope> {
    return { authentication: { status: "ready" }, environmentStatus: "connected" };
  }

  async cancelHarnessAuthentication(): Promise<HarnessAuthenticationEnvelope> {
    return { authentication: { status: "not-started" }, environmentStatus: "connected" };
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

  /** What `triggers.list` answers: every Trigger still in use, most recently changed first. */
  listTriggers(workspaceId?: string): TriggerSummary[] {
    return [...this.triggers.values()]
      .filter(
        ({ trigger }) =>
          trigger.status !== "archived" &&
          (workspaceId === undefined || trigger.workspaceId === workspaceId),
      )
      .sort((left, right) => right.trigger.updatedAt.localeCompare(left.trigger.updatedAt))
      .map((record) => mockTriggerSummary(record, this.anchorThreadTitle(record)));
  }

  /** What `triggers.get` answers, archived Triggers included, as the Host does. */
  triggerDetail(triggerId: string) {
    const record = this.getTrigger(triggerId);
    return {
      ...record,
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
      workspaceId: thread.workspaceId,
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
          workspaceId: record.trigger.workspaceId,
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

  async loadMachines() {
    return this.snapshot.machines.map((machine) => ({ ...machine }));
  }

  async revokeMachine(machineId: string): Promise<void> {
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.filter((machine) => machine.id !== machineId),
    });
  }

  async revokeSession(sessionId?: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
  }

  async loadWorkspaceSharing(workspaceId: string) {
    return {
      invitations: [],
      members: [
        {
          displayName: "Alex",
          email: "alex@example.com",
          emailVerified: true,
          generation: 1,
          id: "wmb_00000000-0000-4000-8000-000000000001",
          invitedBy: null,
          joinedAt: this.now().toISOString(),
          role: "owner" as const,
          state: "active" as const,
          userId: mockUserId,
          workspaceId,
        },
      ],
    };
  }

  async listWorkspaceFiles(workspaceId: string, input: { readonly parentKey: string }) {
    await delay(Math.min(this.latencyMs, 180));
    const { parentKey } = input;
    const parentPath = parentKey === "" ? "" : mockFileForKey(workspaceId, parentKey)?.path;
    if (parentPath === undefined) throw new Error("Folder not found.");
    const prefix = parentPath === "" ? "" : `${parentPath}/`;
    const files = mockWorkspaceFiles[workspaceId] ?? [];
    const entries = files
      .filter((file) => {
        if (!file.path.startsWith(prefix)) return false;
        return !file.path.slice(prefix.length).includes("/");
      })
      .map((file) => {
        const contentBytes = file.content ? new TextEncoder().encode(file.content).byteLength : 0;
        const name = file.path.slice(prefix.length);
        return {
          executable: false,
          hidden: name.startsWith("."),
          key: encodeMockFileKey(file.path),
          kind: file.type,
          mode: file.type === "directory" ? 0o755 : 0o644,
          modifiedAt: "2026-08-09T16:39:00.000Z",
          name,
          sizeBytes: contentBytes,
        };
      });
    return {
      cursor: null,
      entries,
      parentKey,
      revision: `mock_revision_${workspaceId}_${parentKey || "root"}`,
    };
  }

  async previewWorkspaceFile(workspaceId: string, fileKey: string) {
    await delay(Math.min(this.latencyMs, 180));
    const file = mockFileForKey(workspaceId, fileKey);
    if (!file || file.type !== "file") throw new Error("File not found.");
    const content = file.content ?? "";
    return {
      content,
      metadata: {
        contentType: "text/plain; charset=utf-8",
        etag: `mock-${fileKey}`,
        modifiedAt: "2026-08-09T16:39:00.000Z",
        sizeBytes: new TextEncoder().encode(content).byteLength,
        truncated: false,
      },
    };
  }

  workspaceFileDownloadUrl(workspaceId: string, fileKey: string): string {
    const content = mockFileForKey(workspaceId, fileKey)?.content ?? "";
    return `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
  }

  async createWorkspaceInvitation(input: { role: "collaborator" | "owner"; workspaceId: string }) {
    return {
      invitation: {
        acceptedAt: null,
        acceptedBy: null,
        createdAt: this.now().toISOString(),
        createdBy: mockUserId,
        expiresAt: new Date(this.now().getTime() + 7 * 86_400_000).toISOString(),
        id: "inv_00000000-0000-4000-8000-000000000001",
        intendedEmail: null,
        revokedAt: null,
        role: input.role,
        selector: "mock_selector_that_is_long_enough",
        type: "link" as const,
        workspaceId: input.workspaceId,
      },
      invitationUrl: "https://opensteer.example.test/invite/mock#verifier",
    };
  }

  async revokeWorkspaceInvitation(): Promise<void> {}

  async updateWorkspaceMember(input: {
    role?: "collaborator" | "owner";
    state?: "active" | "revoked";
    userId: string;
    workspaceId: string;
  }) {
    return {
      displayName: "Alex",
      email: "alex@example.com",
      emailVerified: true,
      generation: 2,
      id: "wmb_00000000-0000-4000-8000-000000000001",
      invitedBy: null,
      joinedAt: this.now().toISOString(),
      role: input.role ?? ("owner" as const),
      state: input.state ?? ("active" as const),
      userId: input.userId,
      workspaceId: input.workspaceId,
    };
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

  async beginIntegrationAuthorization(
    input: CommandInputOf<"integration.authorization.begin">["input"],
  ): Promise<Omit<CommandOutputOf<"integration.authorization.begin">, "type">> {
    const attemptId = createIntegrationId("oauthAttempt");
    const definition = this.integrationDefinition(input.definitionId);
    if (!definition) throw new Error("Integration not found.");
    this.integrationAttempts.set(attemptId, {
      definitionId: input.definitionId,
      provider: definition.provider,
      ...(input.exactApplicationSource
        ? { source: input.exactApplicationSource as IntegrationOAuthApplicationSource }
        : {}),
    });
    return {
      attemptId,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
      launchTicket: "a".repeat(43),
    };
  }

  /** The mock has no provider to revoke at, so it never claims that it did. */
  async disconnectIntegration(
    connectionId: string,
  ): Promise<Omit<CommandOutputOf<"integration.disconnect">, "type">> {
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

  listComputerAppSetupRequests(): ComputerAppSetupRequest[] {
    return [...this.computerAppSetupRequests.values()].filter(
      (request) => Date.parse(request.expiresAt) > this.now().getTime(),
    );
  }

  /**
   * One pending question per scope, as on the Host: an app on one computer, or
   * the automatic policy of one Mac. Asking again for the same access replays
   * the pending request; anything else replaces it.
   */
  requestComputerAppSetup(
    input: ParsedCommandOf<"integration.computer.setup.request">["input"],
  ): ComputerAppSetupRequest {
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
    const request: ComputerAppSetupRequest = {
      ...scope,
      createdAt: this.now().toISOString(),
      definitionDigest: "mock-definition",
      deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
      expiresAt: new Date(this.now().getTime() + 7 * 86400000).toISOString(),
      id: crypto.randomUUID(),
      ownerUserId: mockUserId,
      reason: null,
      runnerId: input.runnerId,
      server: null,
      threadId: null,
      threadTitle: null,
      workspaceId: null,
      workspaceName: null,
    };
    this.computerAppSetupRequests.set(request.id, request);
    return request;
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

  /** Pins the desktop's approval key for one Mac, as the real Host does. */
  registerComputerUseApprovalKey(
    input: ParsedCommandOf<"integration.computer.approval-key.set">["input"],
  ): string {
    const machine = this.ownedComputer(input.runnerId);
    if (machine?.device?.form === "phone" && machine.device?.platform === "android") {
      throw new Error("An Android phone has no approval key.");
    }
    const keyId = `sha256:${input.publicKey
      .replace(/[^A-Za-z0-9]/gu, "")
      .slice(-43)
      .padStart(43, "A")}`;
    if (machine.device?.platform === "ios") this.iphoneApprovalKeys.set(input.runnerId, keyId);
    else this.updateComputerUse(input.runnerId, (report) => ({ ...report, approvalKeyId: keyId }));
    return keyId;
  }

  /** Applies owner-set phone access, Mac narrowing, or a signed Mac answer. */
  async setComputerAppConnection(
    input: ParsedCommandOf<"integration.computer.setup.set">["input"] | MockMacAnswer,
  ): Promise<IntegrationConnectionSummary | null> {
    if (input.kind === "policy") {
      const pending = this.computerAppSetupRequests.get(input.approval.requestId);
      if (
        !pending ||
        pending.kind !== "policy" ||
        pending.runnerId !== input.runnerId ||
        Date.parse(pending.expiresAt) <= this.now().getTime()
      ) {
        throw new Error("Confirm automatic approval in Opensteer on that Mac.");
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
    const machine = this.snapshot.machines.find((candidate) => candidate.id === input.runnerId);
    if (!machine) throw new Error("That computer is not part of this deployment.");
    if (machine.device?.platform === "ios") {
      this.ownedComputer(input.runnerId);
      if (!definition.computerApp.platforms.includes("ios"))
        throw new Error("This app is not supported on this computer.");
    }
    const phone =
      input.definitionId === androidPhoneDefinitionId &&
      input.app === null &&
      machine.device?.form === "phone" &&
      machine.device?.platform === "android";
    if (input.definitionId === androidPhoneDefinitionId && !phone) {
      throw new Error("That is not an Android phone connection.");
    }
    if (phone && "approval" in input) {
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
    const approval = "approval" in input ? input.approval : null;
    if (
      !phone &&
      (!existing ||
        existing.computer?.blockedAt !== null ||
        (existing.computer.access === "read" && input.access === "read-write") ||
        approval)
    ) {
      const pending = approval ? this.computerAppSetupRequests.get(approval.requestId) : undefined;
      if (
        !pending ||
        pending.kind !== "app" ||
        pending.runnerId !== input.runnerId ||
        pending.definitionId !== input.definitionId ||
        !sameMockApp(pending.app, input.app) ||
        pending.access !== input.access ||
        Date.parse(pending.expiresAt) <= this.now().getTime()
      ) {
        throw new Error("Approve this access in Opensteer on the computer that provides the app.");
      }
    }
    for (const request of this.computerAppSetupRequests.values()) {
      if (
        request.kind === "app" &&
        request.runnerId === input.runnerId &&
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
          applicationSource: null,
          authMethodId: "computer",
          authorizationDigest: null,
          computer,
          connectionMethod: "computer",
          createdAt: timestamp,
          definitionId: definition.id,
          displayName,
          externalIdentityId: null,
          externalTenantId: null,
          grantedScopes: [],
          id: createIntegrationId("connection"),
          provider: definition.provider,
          providerApplicationId: null,
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
      if (request.kind === "policy" && request.runnerId === runnerId) {
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
    if (machine.device?.platform === "android")
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
  /**
   * The preview has no live Browser Runtime, so a session it does not list is
   * taken as open: the sign-in lands and its Workspace is the Request's own.
   */
  signInBrowserSession(
    command: Extract<HostApiCommand, { readonly type: "browser.session.sign-in" }>,
  ): BrowserSignInOutcome {
    const session = this.snapshot.browserSessions.find(({ id }) => id === command.sessionId);
    return this.chrome.signIn({
      profileName: this.#browserProfileName(session?.profileId ?? null),
      site: command.url,
      sourceId: command.sourceId,
      workspaceId: session?.workspaceId ?? mockMainWorkspaceId,
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
      request.targetWorkspaceId,
      request.payload.site,
      command.decision.sourceId,
    );
    const outcome = this.chrome.signIn({
      profileName: this.#browserProfileName(session?.profileId ?? null),
      site: request.payload.site,
      sourceId: command.decision.sourceId,
      workspaceId: request.targetWorkspaceId,
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
  declinePasswordSignIn(
    command: Extract<HostApiCommand, { readonly type: "browser.password-sign-in.decline" }>,
  ): "declined" {
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
    this.settleBrowserSignIn(request, "declined", { decision: "declined" });
    return "declined";
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
    const threadId = request.originatingThreadId;
    const timestamp = this.now().toISOString();
    const resolved = ResolvedRequestSchema.parse({
      ...request,
      resolvedAt: timestamp,
      resolvedBy: mockUserId,
      response: { kind: "external", value },
      status,
    });
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
        [threadId]: [...(this.snapshot.transcripts[threadId] ?? []), requestReceipt(resolved)],
      },
    });
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
        [threadId]: [...(this.snapshot.transcripts[threadId] ?? []), requestReceipt(resolved)],
      },
    });
  }

  private dropComputerAppTools(connectionId: string): void {
    this.integrations.installations = this.integrations.installations.map((entry) => ({
      ...entry,
      tools: entry.tools.filter((tool) => tool.connectionId !== connectionId),
    }));
  }

  async connectIntegrationApiKey(
    input: CommandInputOf<"integration.apiKey.connect">["input"],
  ): Promise<void> {
    const definition = this.integrationDefinition(input.definitionId);
    if (!definition) throw new Error("Integration not found.");
    // The Host's own words when a checked key is turned away; nothing is saved.
    if (definition.apiKey?.check && Object.values(input.values).includes(mockRejectedApiKey)) {
      throw new Error(`${definition.name} rejected this key.`);
    }
    const timestamp = this.now().toISOString();
    if (input.connectionId) {
      const reconnected = this.integrations.connections.find(
        (connection) =>
          connection.id === input.connectionId &&
          connection.connectionMethod === "api-key" &&
          connection.definitionId === definition.id &&
          connection.status !== "revoked",
      );
      if (!reconnected) throw new Error("This connection is no longer available to reconnect");
      this.integrations.connections = this.integrations.connections.map((connection) =>
        connection === reconnected
          ? {
              ...connection,
              displayName: input.displayName?.trim() || connection.displayName,
              status: "connected",
              statusDetail: null,
              statusReason: null,
              updatedAt: timestamp,
            }
          : connection,
      );
      await this.#settleMainAccessRequests(reconnected.id);
      return;
    }
    const connectionId = createIntegrationId("connection");
    this.integrations.connections.push({
      accountIdentifier: null,
      applicationSource: { kind: "api-key" },
      authMethodId: input.authMethodId,
      authorizationDigest: mockIntegrationDigest(`${definition.id}-authorization`),
      computer: null,
      connectionMethod: "api-key",
      createdAt: timestamp,
      definitionId: definition.id,
      displayName: input.displayName?.trim() || definition.name,
      externalIdentityId: `mock-${definition.id}-key`,
      externalTenantId: null,
      grantedScopes: [],
      id: connectionId,
      provider: definition.provider,
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: timestamp,
    });
    await this.#settleMainAccessRequests(connectionId);
  }

  /**
   * The Host's rule: a connection that gains authority settles the Main-target
   * access Requests waiting on it, and settling one resumes its agent.
   */
  async #settleMainAccessRequests(connectionId: string): Promise<void> {
    const waiting = Object.values(this.snapshot.requests)
      .flat()
      .filter(
        (request): request is Extract<Request, { readonly status: "pending" }> =>
          request.status === "pending" &&
          request.payload.kind === "integration.access" &&
          request.payload.installationId !== null &&
          (request.payload.requestedConnectionId === null ||
            request.payload.requestedConnectionId === connectionId) &&
          this.snapshot.workspaces.find(({ id }) => id === request.targetWorkspaceId)?.kind ===
            "main",
      );
    for (const request of waiting) {
      try {
        this.#verifyMockIntegrationAccessFulfillment(request, connectionId);
      } catch {
        continue;
      }
      await this.resolveRequest({
        requestId: request.id,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      });
    }
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
      workspaceId: input.workspaceId,
    };
    this.integrations.grants = [
      ...this.integrations.grants.filter(
        (candidate) =>
          candidate.workspaceId !== grant.workspaceId ||
          candidate.installationId !== grant.installationId ||
          candidate.alias !== grant.alias,
      ),
      grant,
    ];
    return grant;
  }

  async createLocalRunnerEnrollment(name: string) {
    const expiresAt = new Date(this.now().getTime() + 10 * 60_000).toISOString();
    const enrollmentId = `ren_${crypto.randomUUID()}`;
    this.update({
      ...this.snapshot,
      machines: [
        ...this.snapshot.machines,
        {
          access: null,
          // A row still waiting to connect has reported no apps either.
          apps: null,
          allowedModules: ["agents", "shell"],
          detail: null,
          device: null,
          enrollmentId,
          expiresAt,
          // A row that is still waiting to connect has reported nothing yet.
          computerUse: null,
          fullDiskAccess: null,
          id: enrollmentId,
          lastSeenAt: null,
          localWorkspaces: 0,
          modules: { agents: { checkedAt: null, detail: null, readiness: "unavailable" } },
          name,
          ownership: "mine",
          ownerName: null,
          pinnedThreads: 0,
          revocable: false,
          status: "pending",
          runtimeVersion: null,
          unlinkedLocalFolders: 0,
        },
      ],
    });
    return {
      enrollmentId,
      expiresAt,
      token: "mock-local-runner-enrollment-token-with-sufficient-length",
    };
  }

  /** Null when the editor named a revision the preview has already moved past. */
  async updateMachineAccess(
    machineId: string,
    policy: MachineAccessPolicy,
    expectedRevision: number,
  ): Promise<number | null> {
    const machine = this.snapshot.machines.find((entry) => entry.id === machineId);
    if (!machine?.access || machine.access.revision !== expectedRevision) return null;
    const revision = machine.access.revision + 1;
    this.update({
      ...this.snapshot,
      machines: this.snapshot.machines.map((entry) =>
        entry.id === machineId && entry.access
          ? { ...entry, access: { ...entry.access, policy, revision } }
          : entry,
      ),
    });
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
  ) {
    const existing = this.phoneEnrollments.get(idempotencyKey);
    if (existing) {
      if (existing.name !== name || existing.profile !== (profile ?? null))
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
          access: null,
          apps: null,
          allowedModules: ["integrations"],
          detail: null,
          device: profile === "iphone" ? { form: "phone", platform: "ios" } : null,
          enrollmentId,
          expiresAt,
          computerUse: null,
          fullDiskAccess: null,
          id: enrollmentId,
          lastSeenAt: null,
          localWorkspaces: 0,
          modules: { integrations: { checkedAt: null, detail: null, readiness: "unavailable" } },
          name,
          ownership: "mine",
          ownerName: null,
          pinnedThreads: 0,
          revocable: false,
          status: "pending",
          runtimeVersion: null,
          unlinkedLocalFolders: 0,
        },
      ],
    });
    const result = {
      enrollmentId,
      expiresAt,
      pairing: mockAgentPhonePairingTarget,
      token: `mock-phone-runner-enrollment-token-${enrollmentId}`,
    };
    this.phoneEnrollments.set(idempotencyKey, { name, profile: profile ?? null, result });
    return result;
  }

  mockConnectIphone(input: { enrollmentId: string; runnerId: string; name: string }): void {
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
      machines: this.snapshot.machines.map((machine) =>
        machine.id === input.enrollmentId
          ? {
              ...machine,
              id: runnerId,
              name: input.name,
              status: "online",
              expiresAt: null,
              revocable: true,
              device: { form: "phone", platform: "ios" },
              computerUse: null,
              lastSeenAt: this.now().toISOString(),
              apps: mockIphoneAppDefinitions.map((definition) => ({
                definitionId: definition.id,
                operations: definition.computerApp!.operations.map(({ name }) => ({
                  operation: name,
                  state: "ready",
                  detail: null,
                  remedy: null,
                })),
              })),
              modules: {
                integrations: {
                  checkedAt: this.now().toISOString(),
                  detail: null,
                  readiness: "ready",
                },
              },
            }
          : machine,
      ),
    });
  }

  async mockAnswerIphoneApproval(input: {
    setupRequestId: string;
    decision: "allow" | "deny";
  }): Promise<void> {
    const request = this.listComputerAppSetupRequests().find(
      ({ id }) => id === input.setupRequestId,
    );
    if (
      !request ||
      request.kind !== "app" ||
      this.ownedComputer(request.runnerId).device?.platform !== "ios" ||
      !this.iphoneApprovalKeys.has(request.runnerId)
    )
      throw new Error("This iPhone approval is no longer waiting.");
    if (input.decision === "deny") this.cancelComputerAppSetup(request.id);
    else {
      const catalog = this.integrations.catalog.find(
        ({ definition }) => definition.id === request.definitionId,
      );
      if (!catalog) throw new Error("That app is not in this catalog.");
      await this.installCatalogIntegration({
        definitionId: request.definitionId,
        digest: catalog.digest,
      });
      await this.setComputerAppConnection({
        kind: "app",
        app: request.app,
        runnerId: request.runnerId,
        definitionId: request.definitionId,
        access: request.access,
        approval: {
          requestId: request.id,
          expiresAt: new Date(this.now().getTime() + 30_000).toISOString(),
          signature: "A".repeat(86),
        },
      });
    }
    this.update({ ...this.snapshot });
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
      applications: [...this.integrations.applications],
      authorizationSurface: "canonical",
      callbackUrls: { ...this.integrations.callbackUrls },
      connections: [...this.integrations.connections],
      hostedOAuthDisclosure: mockHostedOAuthDisclosure,
      isAdministrator: true,
      providerAuthorizations: { ...this.integrations.providerAuthorizations },
      providers: [...this.integrations.providers],
    };
  }

  async loadIntegrationPlatform(): Promise<RpcData<"integration.platform.get">> {
    return {
      authorizationSurface: "canonical",
      catalog: [...this.integrations.catalog],
      connections: [...this.integrations.mcpConnections],
      installations: [...this.integrations.installations],
    };
  }

  async beginMcpAuthorization(
    _input: CommandInputOf<"integration.mcp.authorization.begin">["input"],
  ): Promise<CommandOutputOf<"integration.mcp.authorization.begin">> {
    throw new Error("The mock Host does not authorize MCP accounts.");
  }

  async cancelIntegrationAuthorization(
    attemptId: string,
  ): Promise<Omit<CommandOutputOf<"integration.authorization.cancel">, "type">> {
    this.integrationAttempts.delete(attemptId);
    return {
      connectionId: null,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
      failureCode: null,
      status: "cancelled",
    };
  }

  async getIntegrationAuthorization(
    attemptId: string,
  ): Promise<RpcData<"integration.authorization.get">> {
    const attempt = this.integrationAttempts.get(attemptId);
    let connectionId: IntegrationConnectionId | null = null;
    if (attempt) {
      this.integrationAttempts.delete(attemptId);
      connectionId = this.completeIntegrationAttempt(attempt);
      await this.#settleMainAccessRequests(connectionId);
    }
    return {
      connectionId,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
      failureCode: null,
      status: "completed",
    };
  }

  async disconnectMcpConnection(connectionId: string): Promise<void> {
    const timestamp = this.now().toISOString();
    this.integrations.mcpConnections = this.integrations.mcpConnections.map((connection) =>
      connection.connectionId === connectionId
        ? { ...connection, status: "revoked", updatedAt: timestamp }
        : connection,
    );
  }

  async installAgentPlugin(_directory: string) {
    return { issues: [] };
  }

  async installCatalogIntegration(
    input: CommandInputOf<"integration.catalog.install">["input"],
  ): Promise<CommandOutputOf<"integration.catalog.install">["installation"]> {
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
    const installation =
      definition.adapter === "computer"
        ? mockComputerAppInstallation({
            createdAt: this.now().toISOString(),
            definition,
            digest: entry.digest,
            installedBy: mockUserId,
            connections: [],
          })
        : mockIntegrationInstallation({
            createdAt: this.now().toISOString(),
            definition,
            digest: entry.digest,
            installedBy: mockUserId,
            providerApplicationRequired: definition.authMethods.some(
              ({ kind }) => kind === "oauth",
            ),
            skills: [],
            tools: mockCatalogTools(definition),
          });
    entry.installationId = installation.installation.id;
    this.integrations.installations.push(installation);
    return installation.installation;
  }

  async installRemoteMcp(
    input: CommandInputOf<"integration.remoteMcp.install">["input"],
  ): Promise<CommandOutputOf<"integration.remoteMcp.install">["installation"]> {
    const timestamp = this.now().toISOString();
    const installationId = createIntegrationId("installation");
    const installation: CommandOutputOf<"integration.remoteMcp.install">["installation"] = {
      createdAt: timestamp,
      description: input.description ?? "",
      id: installationId,
      manifest: { kind: "remote-mcp", url: input.url },
      name: input.name,
      provenance: { installedBy: mockUserId, source: "remote-mcp" },
      revision: 1,
      sourceKind: "remote-mcp",
      status: "active",
      title: input.title,
      trust: "administrator-approved",
      updatedAt: timestamp,
      version: null,
    };
    this.integrations.installations.push({
      installation,
      servers: [
        {
          connectionRequirement: { kind: "mcp-oauth" },
          id: createIntegrationId("server"),
          installationId,
          name: input.name,
          status: "active",
          statusDetail: null,
          toolGeneration: 0,
          transportType: "streamable-http",
          updatedAt: timestamp,
        },
      ],
      skills: [],
      tools: [],
    });
    return installation;
  }

  /**
   * Mirrors the Host cascade: the installation and its dependents go, accounts
   * for a proposed definition go with it because that definition exists nowhere
   * else, catalog accounts stay, and pending access Requests for the
   * installation are cancelled.
   */
  async uninstallIntegration(
    installationId: string,
  ): Promise<Omit<CommandOutputOf<"integration.uninstall">, "type">> {
    const entry = this.integrations.installations.find(
      ({ installation }) => installation.id === installationId,
    );
    if (!entry) throw new Error("Integration installation not found.");
    const mcpConnections = this.integrations.mcpConnections.filter(
      (connection) => connection.installationId === installationId,
    );
    // A proposal's definition id is its installation name; nothing else carries it.
    const proposedDefinitionId =
      entry.installation.sourceKind === "proposed" ? entry.installation.name : null;
    const providerConnections = proposedDefinitionId
      ? this.integrations.connections.filter(
          (connection) => connection.definitionId === proposedDefinitionId,
        )
      : [];
    this.integrations.installations = this.integrations.installations.filter(
      ({ installation }) => installation.id !== installationId,
    );
    this.integrations.mcpConnections = this.integrations.mcpConnections.filter(
      (connection) => connection.installationId !== installationId,
    );
    this.integrations.connections = this.integrations.connections.filter(
      (connection) => !providerConnections.includes(connection),
    );
    this.integrations.grants = this.integrations.grants.filter(
      (grant) => grant.installationId !== installationId,
    );
    for (const candidate of this.integrations.catalog) {
      if (candidate.installationId === installationId) candidate.installationId = null;
    }
    return {
      cancelledRequests: this.#cancelIntegrationAccessRequests(installationId),
      removedConnections: mcpConnections.length + providerConnections.length,
    };
  }

  #cancelIntegrationAccessRequests(installationId: string): number {
    const cancelled = new Map<string, number>();
    const requests = Object.fromEntries(
      Object.entries(this.snapshot.requests).map(([threadId, pending]) => {
        const kept = pending.filter(
          (request) =>
            request.payload.kind !== "integration.access" ||
            request.payload.installationId !== installationId,
        );
        if (kept.length !== pending.length) cancelled.set(threadId, pending.length - kept.length);
        return [threadId, kept];
      }),
    );
    if (cancelled.size === 0) return 0;
    this.update({
      ...this.snapshot,
      requests,
      threads: this.snapshot.threads.map((thread) => {
        const removed = cancelled.get(thread.id);
        return removed === undefined
          ? thread
          : {
              ...thread,
              pendingRequests: Math.max(0, thread.pendingRequests - removed),
              updatedAt: this.now().toISOString(),
            };
      }),
    });
    return [...cancelled.values()].reduce((total, count) => total + count, 0);
  }

  async loadIntegrationGrants(workspaceId: string): Promise<IntegrationGrant[]> {
    return this.integrations.grants.filter((grant) => grant.workspaceId === workspaceId);
  }

  async revokeIntegrationGrant(workspaceId: string, grantId: string): Promise<void> {
    this.integrations.grants = this.integrations.grants.filter(
      (grant) => grant.workspaceId !== workspaceId || grant.id !== grantId,
    );
  }

  async saveIntegrationProviderApplication(
    input: CommandInputOf<"integration.providerApplication.save">["input"],
  ): Promise<IntegrationProviderApplication> {
    const availability = input.availability ?? "deployment";
    const existing = this.integrations.applications.find((application) =>
      input.applicationId
        ? application.id === input.applicationId
        : application.provider === input.provider && application.availability === "deployment",
    );
    if (
      input.expectedRevision !== null &&
      input.expectedRevision !== (existing?.revision ?? null)
    ) {
      throw new Error("This provider application changed. Reload and try again.");
    }
    const timestamp = this.now().toISOString();
    const callbackUrl =
      this.integrations.callbackUrls[input.provider] ?? mockIntegrationCallbackUrl(input.provider);
    const application: IntegrationProviderApplication = {
      availability,
      callbackUrl,
      canManage: true,
      clientId: input.clientId,
      configuredSecretFields: [
        ...new Set([...(existing?.configuredSecretFields ?? []), ...Object.keys(input.secrets)]),
      ],
      createdAt: existing?.createdAt ?? timestamp,
      displayName: input.displayName,
      id: existing?.id ?? createIntegrationId("providerApplication"),
      ownerUserId:
        availability === "personal" ? ("usr_00000000-0000-4000-8000-000000000001" as never) : null,
      provider: input.provider,
      revision: (existing?.revision ?? 0) + 1,
      status: "active",
      updatedAt: timestamp,
    };
    this.integrations.applications = [
      ...this.integrations.applications.filter(({ id }) => id !== application.id),
      application,
    ];
    this.integrations.callbackUrls[input.provider] = callbackUrl;
    this.selectApplicationSource(application, "deployment-oauth");
    return application;
  }

  async setIntegrationProviderApplicationStatus(
    input: CommandInputOf<"integration.providerApplication.status.set">["input"] &
      Pick<CommandInputOf<"integration.providerApplication.status.set">, "provider">,
  ): Promise<IntegrationProviderApplication> {
    const existing = this.integrations.applications.find((application) =>
      input.applicationId
        ? application.id === input.applicationId
        : application.provider === input.provider && application.availability === "deployment",
    );
    if (!existing) throw new Error("This provider has no OAuth application.");
    if (existing.revision !== input.expectedRevision) {
      throw new Error("This provider application changed. Reload and try again.");
    }
    const application: IntegrationProviderApplication = {
      ...existing,
      revision: existing.revision + 1,
      status: input.status,
      updatedAt: this.now().toISOString(),
    };
    this.integrations.applications = this.integrations.applications.map((candidate) =>
      candidate.provider === application.provider ? application : candidate,
    );
    this.selectApplicationSource(
      application,
      input.status === "active" ? "deployment-oauth" : "hosted-oauth",
    );
    return application;
  }

  async setIntegrationApplicationSourceDefault(
    input: CommandInputOf<"integration.applicationSourceDefault.set">["input"] &
      Pick<CommandInputOf<"integration.applicationSourceDefault.set">, "provider">,
  ): Promise<void> {
    const authorization = this.integrations.providerAuthorizations[input.provider];
    const source = authorization?.availableSources.find(
      ({ kind }) => kind === input.applicationSource,
    );
    if (!authorization || !source) {
      throw new Error("That sign-in method is not available for this provider.");
    }
    this.integrations.providerAuthorizations[input.provider] = {
      ...authorization,
      code: "READY",
      detail:
        source.kind === "hosted-oauth"
          ? "Opensteer-managed sign-in is ready for new accounts."
          : "The custom OAuth app configured for this deployment is ready.",
      selectedSource: source,
      selectedSourceKind: source.kind,
      hostedOAuthStatus: authorization.hostedOAuthStatus,
    };
  }

  private integrationDefinition(definitionId: string): IntegrationDefinitionSummary | null {
    return (
      mockIntegrationDefinitions.find((definition) => definition.id === definitionId) ??
      this.integrations.catalog.find(({ definition }) => definition.id === definitionId)
        ?.definition ??
      null
    );
  }

  /**
   * The mock provider always signs in as alex@example.com. As on the Host, an
   * account it already holds for that identity is updated in place, which is
   * how signing in again reconnects it; any other sign-in adds an account.
   */
  private completeIntegrationAttempt(attempt: MockIntegrationAttempt): IntegrationConnectionId {
    const definition = this.integrationDefinition(attempt.definitionId);
    const selectedSource =
      attempt.source ??
      this.integrations.providerAuthorizations[attempt.provider]?.selectedSource ??
      null;
    const timestamp = this.now().toISOString();
    // As on the Host, a GitHub sign-in waits until its app reaches a repository.
    const github = attempt.provider === "github";
    const externalIdentityId = `mock-${attempt.definitionId}-identity`;
    const existing = this.integrations.connections.find(
      (connection) =>
        connection.definitionId === attempt.definitionId &&
        connection.provider === attempt.provider &&
        connection.externalIdentityId === externalIdentityId &&
        connection.externalTenantId === null &&
        connection.status !== "revoked",
    );
    const connection: IntegrationConnectionSummary = {
      accountIdentifier: "alex@example.com",
      applicationSource: selectedSource,
      authMethodId:
        definition?.authMethods.find(({ kind }) => kind === "oauth")?.id ?? "managed-oauth",
      authorizationDigest: mockIntegrationDigest(`${attempt.definitionId}-authorization`),
      computer: null,
      connectionMethod: "managed-oauth",
      createdAt: existing?.createdAt ?? timestamp,
      definitionId: attempt.definitionId,
      displayName: "alex@example.com",
      externalIdentityId,
      externalTenantId: null,
      grantedScopes: [],
      id: existing?.id ?? createIntegrationId("connection"),
      provider: attempt.provider,
      providerApplicationId:
        selectedSource?.kind === "deployment-oauth" ? selectedSource.providerApplicationId : null,
      status: github ? "needs-attention" : "connected",
      statusDetail: github ? "Check repository access to finish connecting GitHub." : null,
      statusReason: github ? "permissions" : null,
      updatedAt: timestamp,
    };
    this.integrations.connections = existing
      ? this.integrations.connections.map((candidate) =>
          candidate === existing ? connection : candidate,
        )
      : [...this.integrations.connections, connection];
    return connection.id;
  }

  /** Keeps the provider authorization consistent with the saved application. */
  private selectApplicationSource(
    application: IntegrationProviderApplication,
    preferred: "deployment-oauth" | "hosted-oauth",
  ): void {
    const authorization = this.integrations.providerAuthorizations[application.provider];
    const hosted = authorization?.availableSources.find(({ kind }) => kind === "hosted-oauth");
    const deployment: IntegrationOAuthApplicationSource | null =
      application.status === "active"
        ? {
            callbackUrl: application.callbackUrl,
            kind: "deployment-oauth",
            providerApplicationId: application.id,
            providerApplicationRevision: application.revision,
          }
        : null;
    const availableSources = [...(hosted ? [hosted] : []), ...(deployment ? [deployment] : [])];
    const selectedSource =
      (preferred === "deployment-oauth" ? deployment : (hosted ?? null)) ??
      availableSources[0] ??
      null;
    this.integrations.providerAuthorizations[application.provider] = {
      availableSources,
      code: selectedSource ? "READY" : "PROVIDER_APPLICATION_REQUIRED",
      detail: selectedSource
        ? selectedSource.kind === "hosted-oauth"
          ? "Opensteer-managed sign-in is ready for new accounts."
          : "The custom OAuth app configured for this deployment is ready."
        : "Add an OAuth application for this deployment before connecting an account.",
      selectedSource,
      selectedSourceKind: selectedSource?.kind ?? null,
      hostedOAuthStatus: authorization?.hostedOAuthStatus ?? "unsupported",
    };
  }

  /**
   * The Host's repository check, as far as the preview goes: no seeded GitHub
   * App reaches a repository yet, and GitHub refuses the token it revoked,
   * which the Host records so that account is offered a sign-in instead.
   */
  async checkRepositoryAccess(connectionId: string): Promise<IntegrationRepositoryAccess> {
    if (connectionId === mockGitHubRevoked.connectionId) {
      const statusDetail = integrationCredentialRejectedDetail(
        this.integrationDefinition("github")?.name ?? "GitHub",
        "sign-in",
      );
      this.integrations.connections = this.integrations.connections.map((connection) =>
        connection.id === connectionId
          ? {
              ...connection,
              status: "needs-attention",
              statusDetail,
              statusReason: null,
              updatedAt: this.now().toISOString(),
            }
          : connection,
      );
      throw new HostClientRequestError({ code: "conflict", message: statusDetail, status: 409 });
    }
    return { installationUrl: null, installations: [], ready: false };
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
      firstUsedAt: now,
      lastUsedAt: now,
      pageSite: site,
      pageTitle: page.title,
      runId: null,
      tabId: page.tabId,
      threadId,
    };
    this.update({
      ...this.snapshot,
      browserSessions: this.snapshot.browserSessions.map((session) =>
        session.id !== page.sessionId
          ? session
          : {
              ...session,
              uses: [
                ...(session.uses ?? []).filter(
                  (existing) =>
                    !(
                      existing.threadId === threadId &&
                      existing.runId === null &&
                      (existing.tabId ?? null) === page.tabId
                    ),
                ),
                ...(session.uses?.some((existing) => existing.threadId === threadId)
                  ? []
                  : [{ ...use, pageSite: null, pageTitle: null, tabId: null }]),
                use,
              ],
            },
      ),
    });
  }

  async startBrowser(
    workspaceId: string,
    identity: import("../host/client.js").BrowserStartIdentity,
    placement?: import("../host/client.js").BrowserPlacementSummary,
    threadId?: string,
    _viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary> {
    const template = this.snapshot.browserSessions.find(
      (session) => session.origin === "workspace",
    );
    if (!template) throw new Error("Enable the seeded place fixture to start a browser.");
    if (
      identity.kind === "profile" &&
      !this.snapshot.browserProfiles.some((profile) => profile.id === identity.profileId)
    )
      throw new Error("The selected browser profile is unavailable.");
    const id = `bsn_00000000-0000-4000-8000-${String(900 + this.snapshot.browserSessions.length).padStart(12, "0")}`;
    const tab = {
      ...template.tabCatalog!.tabs[0]!,
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
      workspaceId,
      profileId: identity.kind === "profile" ? identity.profileId : null,
      placement: placement ? { kind: "runner", runnerId: placement.runnerId } : template.placement,
      threadIds: threadId ? [threadId] : [],
      attachedRunIds: [],
      acting: false,
      tabCatalog: { generation: 1, revision: 1, tabs: [tab] },
      tabs: [{ active: true, id: tab.id, title: tab.title, url: "about:blank" }],
      page: { title: "New tab", url: "about:blank" },
    };
    this.update({ ...this.snapshot, browserSessions: [...this.snapshot.browserSessions, session] });
    return session;
  }

  async saveBrowserSessionProfile(
    _sessionId: string,
    _name: string,
  ): Promise<import("../host/client.js").BrowserProfileSummary> {
    throw new Error("The opt-in mock does not provide browser profiles.");
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
              ...(session.tabCatalog
                ? {
                    tabCatalog: {
                      ...session.tabCatalog,
                      revision: session.tabCatalog.revision + 1,
                      tabs: [],
                    },
                  }
                : {}),
              tabs: [],
            }
          : session,
      ),
    });
  }

  async createBrowserProfile(
    _name: string,
  ): Promise<import("../host/client.js").BrowserProfileSummary> {
    throw new Error("The opt-in mock does not provide browser profiles.");
  }

  async grantBrowserProfile(_input: {
    profileId: string;
    workspaceId: string;
  }): Promise<BrowserProfileGrantSummary> {
    throw new Error("The opt-in mock does not provide browser profile grants.");
  }

  async revokeBrowserProfileGrant(_grantId: string): Promise<void> {
    throw new Error("The opt-in mock does not provide browser profile grants.");
  }

  dispose(): void {
    for (const timer of this.#titleTimers.values()) clearTimeout(timer);
    this.#titleTimers.clear();
    this.#provisionalTitles.clear();
    this.#provisionalIcons.clear();
    this.activeRuns.clear();
  }

  async load(): Promise<void> {
    if (this.snapshot.connection === "connected") return;
    await delay(Math.min(this.latencyMs, 180));
    this.update({ ...this.snapshot, connection: "connected" });
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  private allocateMarkColor(kind: "thread" | "workspace"): MarkColor {
    const key = `${this.snapshot.user?.id ?? mockUserId}:${kind}`;
    let recent = this.#recentMarkColors.get(key);
    if (!recent) {
      const held = kind === "thread" ? this.snapshot.threads : this.snapshot.workspaces;
      recent = [...held]
        .sort((left, right) => {
          const leftAt = "createdAt" in left ? left.createdAt : left.updatedAt;
          const rightAt = "createdAt" in right ? right.createdAt : right.updatedAt;
          return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
        })
        .flatMap(({ color }) => (color === null ? [] : [color]))
        .slice(0, 6);
    }
    const color = nextMarkColor(recent);
    this.#recentMarkColors.set(key, [color, ...recent].slice(0, 6));
    return color;
  }

  async setWorkspaceColor(workspaceId: string, color: MarkColor): Promise<WorkspaceSummary> {
    const workspace = this.snapshot.workspaces.find(({ id }) => id === workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    if (workspace.kind === "main") throw new Error("Main's mark cannot be changed.");
    if (workspace.status === "deleting" || workspace.status === "deleted")
      throw new Error("Workspace is being deleted.");
    const updated = { ...workspace, color, updatedAt: this.now().toISOString() };
    this.update({
      ...this.snapshot,
      workspaces: this.snapshot.workspaces.map((item) =>
        item.id === workspaceId ? updated : item,
      ),
    });
    return updated;
  }

  async setWorkspaceIcon(
    workspaceId: string,
    icon: WorkspaceIconName | null,
  ): Promise<WorkspaceSummary> {
    const workspace = this.snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    if (workspace.kind === "main") throw new Error("Main's mark cannot be changed.");
    if (workspace.status === "deleting" || workspace.status === "deleted") {
      throw new Error("Workspace is being deleted.");
    }
    const updated = { ...workspace, icon };
    this.update({
      ...this.snapshot,
      workspaces: this.snapshot.workspaces.map((item) =>
        item.id === workspaceId ? updated : item,
      ),
    });
    return updated;
  }

  async retryWorkspaceStorage(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = this.snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
    return this.setWorkspaceStatus(workspaceId, "deleting");
  }

  async recoverWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
    return this.setWorkspaceStatus(workspaceId, "ready");
  }

  private setWorkspaceStatus(
    workspaceId: string,
    status: WorkspaceSummary["status"],
  ): WorkspaceSummary {
    const workspace = this.snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    const next = { ...workspace, status };
    this.update({
      ...this.snapshot,
      workspaces: this.snapshot.workspaces.map((item) => (item.id === workspaceId ? next : item)),
    });
    return next;
  }

  async loadEarlierTranscript(_threadId: string): Promise<void> {}

  async loadEarlierWorkspaces(): Promise<void> {}

  async createWorkspace(input: CreateWorkspaceInput) {
    const name = input.name.trim();
    if (!name) throw new Error("Workspace name is required.");
    const timestamp = this.now().toISOString();
    const workspace = {
      description: "A durable Opensteer Workspace.",
      fileCount: 0,
      harnessLabel: this.snapshot.harnesses[0]?.name ?? "Opensteer",
      homeThreadId: null,
      icon: input.icon ?? null,
      id: this.nextId("workspace"),
      kind: "specialized" as const,
      machineName: "Main runner",
      name,
      runnerLabel: this.snapshot.environments[0]?.name ?? "Main runner",
      status: "ready" as const,
      storageIssue: null,
      color: this.allocateMarkColor("workspace"),
      updatedAt: timestamp,
    };
    this.update({
      ...this.snapshot,
      workspaceWindow: {
        ...this.snapshot.workspaceWindow,
        itemCount: this.snapshot.workspaceWindow.itemCount + 1,
        totalItems: this.snapshot.workspaceWindow.totalItems + 1,
      },
      workspaces: [workspace, ...this.snapshot.workspaces],
    });
    return workspace;
  }

  renameThread(threadId: string, title: string): ThreadSummary {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not found.");
    if (
      thread.id === this.snapshot.homeThreadId ||
      this.snapshot.workspaces.some((workspace) => workspace.homeThreadId === threadId)
    )
      throw new HostClientRequestError({
        code: "bad_request",
        message: "Chat cannot be renamed.",
        status: 400,
      });
    const trimmed = ThreadTitleSchema.parse(title);
    this.#provisionalTitles.delete(threadId);
    if (thread.title !== trimmed) this.publishThreadName(thread, { title: trimmed });
    return this.snapshot.threads.find(({ id }) => id === threadId)!;
  }

  setThreadIcon(threadId: string, icon: WorkspaceIconName | null): ThreadSummary {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not found.");
    if (
      threadId === this.snapshot.homeThreadId ||
      this.snapshot.workspaces.some(({ homeThreadId }) => homeThreadId === threadId)
    )
      throw new Error("Chat's icon cannot be changed.");
    this.#provisionalIcons.delete(threadId);
    const chosen = icon ?? defaultTaskSymbol;
    if (thread.icon !== chosen) this.publishThreadName(thread, { icon: chosen });
    return this.snapshot.threads.find(({ id }) => id === threadId)!;
  }

  private publishThreadName(
    thread: ThreadSummary,
    name: { readonly title?: string; readonly icon?: WorkspaceIconName },
  ): void {
    this.sequence = Math.max(this.sequence, this.snapshot.revision) + 1;
    const event = AgentEventSchema.parse({
      type: "thread.state-changed",
      eventId: createId("event"),
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      environmentId: thread.environmentId,
      runId: null,
      sequence: String(this.sequence),
      createdAt: this.now().toISOString(),
      data: {
        title: name.title ?? thread.title,
        icon: name.icon ?? thread.icon,
        doneAt: thread.doneAt,
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

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const workspace = this.snapshot.workspaces.find((item) => item.id === input.workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    if (input.home) {
      if (workspace.kind !== "main") throw new Error("Chat belongs to the Main Workspace.");
      const existing =
        workspace.homeThreadId &&
        this.snapshot.threads.find((thread) => thread.id === workspace.homeThreadId);
      if (existing) return existing;
    }
    const placement = resolveThreadPlacement(
      this.snapshot.environments,
      this.snapshot.harnesses,
      input,
    );
    const harness = this.snapshot.harnesses.find((item) => item.id === placement.harnessInstanceId);
    const modelSelection = input.modelSelection;
    const model = placement.models.find(
      (candidate) =>
        candidate.modelId === modelSelection.modelId &&
        candidate.providerId === modelSelection.providerId,
    );
    if (!model) throw new Error("That model is not available on this work location.");
    const storedSelection = storedModelSelection(modelSelection, model);

    const timestamp = this.now().toISOString();
    const { accessMode } = input;
    assertMockAccessModeEnforceable(placement, accessMode);
    const thread: ThreadSummary = {
      accessMode,
      continuationIdentity: null,
      providerSessionId: createId("providerSession"),
      createdAt: timestamp,
      environmentId: placement.environmentId,
      harnessInstanceId: placement.harnessInstanceId,
      harnessLabel: harness?.name ?? workspace.harnessLabel,
      id: this.nextId("thread"),
      inputQueuePaused: false,
      listed:
        input.parentThreadId === undefined ||
        this.snapshot.threads.find(({ id }) => id === input.parentThreadId)?.role ===
          "conversation",
      modelLabel: model.displayName,
      modelSelection: storedSelection,
      parentThreadId: input.parentThreadId ?? null,
      pendingRequests: 0,
      role: input.home ? "conversation" : "work",
      runnerLabel: placement.whereLabel,
      doneAt: null,
      status: "idle",
      title: input.title?.trim() || "Untitled thread",
      icon: null,
      color: this.allocateMarkColor("thread"),
      unread: false,
      updatedAt: timestamp,
      workspaceId: workspace.id,
    };

    if (input.generateTitle && !input.home) this.#provisionalTitles.add(thread.id);
    if (!input.home) this.#provisionalIcons.add(thread.id);
    this.update({
      ...this.snapshot,
      requests: { ...this.snapshot.requests, [thread.id]: [] },
      threads: [thread, ...this.snapshot.threads],
      workspaces: input.home
        ? this.snapshot.workspaces.map((item) =>
            item.id === workspace.id ? { ...item, homeThreadId: thread.id } : item,
          )
        : this.snapshot.workspaces,
      ...(input.home ? { homeThreadId: thread.id } : {}),
      transcriptWindows: {
        ...this.snapshot.transcriptWindows,
        [thread.id]: {
          byteCount: 2,
          hasMore: false,
          itemCount: 0,
          nextBefore: null,
          threadId: thread.id,
          totalItems: 0,
        },
      },
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
    // The Host records the switch as an event, and its marker is what that
    // event folds into, live or reloaded.
    const recorded = AgentEventSchema.parse({
      createdAt: updated.updatedAt,
      data: { thread: mockThread(updated) },
      environmentId: updated.environmentId,
      eventId: createId("event"),
      runId: null,
      sequence: String(++this.sequence),
      threadId: updated.id,
      type: "thread.execution-updated",
      workspaceId: updated.workspaceId,
    });
    this.update({
      ...this.snapshot,
      threads: this.snapshot.threads.map((item) => (item.id === thread.id ? updated : item)),
      transcripts: {
        ...this.snapshot.transcripts,
        [thread.id]: foldTranscriptEvent(this.snapshot.transcripts[thread.id] ?? [], recorded),
      },
    });
    return updated;
  }

  /** The streams a reply is still writing, as the Host's live read reports them. */
  liveStreams(threadId: string) {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const runs = new Map<string, unknown[]>();
    for (const entry of this.snapshot.transcripts[threadId] ?? []) {
      const drawn = drawnLiveStream(entry);
      if (!drawn) continue;
      runs.set(drawn.runId, [
        ...(runs.get(drawn.runId) ?? []),
        { ...drawn.key, length: drawn.text.length, op: "replace", text: drawn.text },
      ]);
    }
    return hostApi["thread.live.get"].success.parse({
      runs: [...runs].map(([runId, items]) => ({
        afterSequence: String(this.sequence),
        progress: { items, runId, threadId, workspaceId: thread.workspaceId },
      })),
      threadId,
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
    input: SendMessageInput & { quotedMessageId?: string },
  ): Promise<{ readonly input: ThreadInput; readonly message: Message; readonly run: Run | null }> {
    const body = input.body.trim();
    if (!body && !input.content?.some((part) => part.type !== "text"))
      throw new Error("Message body is required.");

    const thread = this.snapshot.threads.find((item) => item.id === input.threadId);
    if (!thread) throw new Error("Thread not found.");

    if (thread.doneAt !== null) throw mockConflict("This task is Done. Reopen it first.");

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
    const joining = this.replyInProgress(thread, message.author);
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
              item.id === thread.id ? { ...item, updatedAt: timestamp } : item,
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
    const updated: ThreadSummary = { ...thread, updatedAt: timestamp };
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
    if (thread.role !== "conversation" || author.kind !== "human") return null;
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
    if (thread.role !== "conversation" || person === null) return;
    const waiting = (this.threadInputQueues.get(thread.id) ?? []).filter((item) =>
      sentBy(item, person),
    );
    if (waiting.length === 0) return;
    let entries = this.snapshot.transcripts[thread.id] ?? [];
    for (const item of waiting) {
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

  /* ---- Tasks: Home hands work to a Thread of its own, and it reports back ---- */

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

  /**
   * Home's side of handing work on: the delegate call, the task and its own
   * Thread, and one sentence about it. Home's turn then ends, so its composer
   * is free while the task runs on its own.
   */
  private async executeHomeDelegation(
    home: ThreadSummary,
    run: ActiveMockRun,
    script: MockTaskScript,
  ): Promise<void> {
    if (!this.beginMockRun(home, run)) return;
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(home.id, run)) return;
    const { assignment, run: taskRun } = this.createTask(home, run.id, script);
    this.upsertEntry(home.id, mockDelegateCall(run.id, assignment, script.title, home.workspaceId));
    void this.executeTaskRun(assignment.workerThreadId, taskRun, script);
    if (await this.streamMockReply(home.id, run, script.accepted)) this.endMockRun(home.id, run);
  }

  /** A worker Thread in its parent's Workspace, the handoff message and the open assignment. */
  private createTask(
    parent: ThreadSummary,
    parentRunId: string,
    script: MockTaskScript,
    createdAt = this.now().toISOString(),
  ): { readonly assignment: AssignmentView; readonly run: ActiveMockRun } {
    const run: ActiveMockRun = {
      cancelled: false,
      id: this.nextId("run"),
      joined: [],
      person: null,
      steered: [],
    };
    const seed = (this.snapshot.transcripts[parent.id] ?? []).find(
      (entry) =>
        entry.kind === "message" &&
        entry.runId === parentRunId &&
        (entry.messageKind === "input" || entry.messageKind === "continuation"),
    );
    const worker: ThreadSummary = {
      ...parent,
      createdAt,
      id: this.nextId("thread"),
      inputQueuePaused: false,
      listed:
        parent.role === "conversation" && seed?.kind === "message" && seed.author.kind === "human",
      parentThreadId: parent.id,
      pendingRequests: 0,
      providerSessionId: createId("providerSession"),
      role: "work",
      status: "running",
      title: script.title,
      icon: mockGeneratedTaskIcon(`${script.title} ${script.objective}`),
      color: this.allocateMarkColor("thread"),
      unread: false,
      updatedAt: createdAt,
    };
    const handoff: MessageEntry = {
      author: MessageAuthorSchema.parse({
        // As the Host attributes it: "Chat" is the owner's name for it alone.
        displayName:
          parent.id === this.snapshot.homeThreadId
            ? `${this.snapshot.user?.displayName ?? "Alex"}’s Opensteer`
            : parent.title,
        kind: "agent",
        runId: parentRunId,
        threadId: parent.id,
        workspaceId: parent.workspaceId,
        workspaceName:
          this.snapshot.workspaces.find(({ id }) => id === parent.workspaceId)?.name ?? "Main",
      }),
      body: script.objective,
      createdAt,
      id: this.nextId("message"),
      kind: "message",
      messageKind: "input",
      policy: "queue",
      runId: run.id,
      sequence: String(++this.sequence),
    };
    const assignment = AssignmentViewSchema.parse({
      createdAt,
      finishedAt: null,
      id: createId("delegation"),
      initialInputMessageId: handoff.id,
      initialRunId: run.id,
      objective: script.objective,
      origin: "run",
      parentAssignmentId: null,
      parentOccurrenceId: null,
      parentRunId,
      parentThreadId: parent.id,
      parentWatchActivationId: null,
      replyTarget: null,
      resultRunId: null,
      resultText: null,
      returnAttemptedAt: null,
      returnMessageId: null,
      returnReason: null,
      returnStatus: "pending",
      revision: 1,
      status: "open",
      updatedAt: createdAt,
      workerThreadId: worker.id,
    });
    this.assignmentModels.set(assignment.id, {
      modelSelection: worker.modelSelection,
      parentModelSelection: parent.modelSelection,
    });
    this.taskScripts.set(assignment.id, script);
    this.nextRunOrdinals.set(worker.id, 1);
    this.update({
      ...this.snapshot,
      runQueue: [
        ...this.snapshot.runQueue,
        { createdAt, id: run.id, runOrdinal: 0, status: "queued", threadId: worker.id },
      ],
      threads: [...this.snapshot.threads, worker],
      transcripts: { ...this.snapshot.transcripts, [worker.id]: [handoff] },
    });
    this.publishAssignment(assignment);
    return { assignment, run };
  }

  /** The task's own Run: a few browser steps, then a decision or its reply. */
  private async executeTaskRun(
    workerId: string,
    run: ActiveMockRun,
    script: MockTaskScript,
  ): Promise<void> {
    const worker = this.snapshot.threads.find(({ id }) => id === workerId);
    if (!worker || !this.beginMockRun(worker, run)) return;
    for (const [index, step] of script.steps.entries()) {
      await delay(this.latencyMs);
      if (!this.isRunCurrent(workerId, run)) return;
      const call = mockTaskStep(run.id, index, step, this.now().toISOString());
      this.upsertEntry(workerId, call);
      await delay(this.latencyMs * 2);
      if (!this.isRunCurrent(workerId, run)) return;
      this.upsertEntry(workerId, {
        ...call,
        completedAt: this.now().toISOString(),
        output: { text: step.output },
        state: "done",
      });
      if (index === 0 && script.note !== null) this.leaveTaskNote(worker, run.id, script.note);
    }
    if (script.decision !== null) {
      this.openTaskDecision(workerId, run.id, script.decision);
      return;
    }
    if (await this.streamMockReply(workerId, run, script.result)) this.endMockRun(workerId, run);
  }

  /** A report from a task to the conversation that asked for it: it starts nothing there. */
  private leaveTaskNote(worker: ThreadSummary, runId: string, note: string): void {
    const parentId = this.openAssignmentOf(worker.id)?.parentThreadId;
    if (!parentId) return;
    this.upsertEntry(parentId, {
      author: MessageAuthorSchema.parse({
        displayName: worker.title,
        kind: "agent",
        runId,
        threadId: worker.id,
        workspaceId: worker.workspaceId,
        workspaceName:
          this.snapshot.workspaces.find(({ id }) => id === worker.workspaceId)?.name ?? "Main",
      }),
      body: note,
      createdAt: this.now().toISOString(),
      id: this.nextId("message"),
      kind: "message",
      messageKind: "input",
      policy: "report",
      runId: null,
      sequence: String(++this.sequence),
    });
  }

  /** The task asks before a step it cannot take back, and its Run waits for the answer. */
  private openTaskDecision(
    workerId: string,
    runId: string,
    decision: NonNullable<MockTaskScript["decision"]>,
    createdAt = this.now().toISOString(),
  ): void {
    const worker = this.snapshot.threads.find(({ id }) => id === workerId);
    if (!worker) return;
    const request = RequestSchema.parse({
      callId: `mock-decision-${runId}`,
      cancellationReason: null,
      createdAt,
      id: createId("request"),
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: runId,
      originatingThreadId: workerId,
      originatingWorkspaceId: worker.workspaceId,
      payload: { kind: "harness.approval" },
      presentation: {
        detail: decision.detail,
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow-once", label: decision.accept },
          { hint: "reject-once", id: "reject", label: decision.decline },
        ],
        risk: "medium",
        title: decision.title,
      },
      requestedBy: mockUserId,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: worker.workspaceId,
    });
    this.setTaskRunStatus(workerId, runId, "waiting", {
      requests: [...(this.snapshot.requests[workerId] ?? []), request],
    });
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
      requestReceipt(resolved),
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
      resultText: reply?.body ?? "The task ended without a written reply.",
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
            `Task Thread: ${worker.id} · Assignment: ${assignment.id}`,
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

  /** Home's turn after a task's outcome reached it: the answer the person asked for. */
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

  /**
   * The preview's side of the Host's decision that a Run replied to the person:
   * one notification, unless they muted the Workspace it replied in. A task's
   * reply is never one; it returns to the agent that assigned it.
   */
  private notifyReply(threadId: string, runId: string): void {
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    const reply = mockRunReply(this.snapshot.transcripts[threadId] ?? [], runId);
    if (!thread || !reply || this.snapshot.notificationMutes.includes(thread.workspaceId)) return;
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
        threadId === this.snapshot.homeThreadId
          ? "Opensteer"
          : truncateMockText(thread.title, notificationTitleMaxCharacters),
      workspaceId: thread.workspaceId,
    });
    for (const listener of this.notificationListeners) listener(notification);
  }

  /**
   * An ask already handed to a task that is waiting on the person, so the
   * preview opens with a card that needs them and a decision to answer.
   */
  private seedHomeTask(): void {
    const home = this.snapshot.threads.find(({ id }) => id === this.snapshot.homeThreadId);
    if (!home) return;
    const script = mockBookingTask;
    const startedAt = this.now().getTime() - 4 * 60_000;
    const at = (seconds: number) => new Date(startedAt + seconds * 1_000).toISOString();
    const pictureRun = this.nextId("run");
    const pictureReplyId = this.nextId("message");
    const homeRun = this.nextId("run");
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [home.id]: [
          ...(this.snapshot.transcripts[home.id] ?? []),
          // An engine links a file it saved by its path on the Runner, which
          // names nothing the reader's app can open.
          {
            author: mockHumanAuthor(),
            body: "Can you search for tiger, go to Images, pick the coolest picture and download it?",
            createdAt: at(-90),
            id: this.nextId("message"),
            kind: "message",
            messageKind: "input",
            runId: pictureRun,
            sequence: String(++this.sequence),
          },
          {
            createdAt: at(-89),
            error: null,
            id: `run:${pictureRun}`,
            kind: "run",
            replyMessageId: pictureReplyId,
            runId: pictureRun,
            status: "completed",
          },
          {
            arguments: {
              command:
                "curl --fail --location https://images.example/tiger-in-snow.jpg --output ~/Downloads/tiger-in-snow.jpg",
            },
            callId: "call-download-1",
            completedAt: at(-62),
            createdAt: at(-70),
            id: `tool:${pictureRun}:call-download-1`,
            integration: null,
            isError: false,
            kind: "tool",
            output: { text: "/Users/person/Downloads/tiger-in-snow.jpg\n  pixelWidth: 1920\n" },
            runId: pictureRun,
            state: "done",
            streamText: "",
            tool: { name: "shell", namespace: "codex" },
          },
          {
            author: mockAgentAuthor(pictureRun, home.id),
            body: "Picked a tiger charging through snow and downloaded the full HD photo to your Downloads folder: [tiger-in-snow.jpg](/Users/person/Downloads/tiger-in-snow.jpg). 🐅",
            createdAt: at(-60),
            id: pictureReplyId,
            kind: "message",
            messageKind: "assistant",
            runId: pictureRun,
            sequence: String(++this.sequence),
          },
          {
            author: mockHumanAuthor(),
            body: "Can you book a table for four at Nopa on Friday?",
            createdAt: at(0),
            id: this.nextId("message"),
            kind: "message",
            messageKind: "input",
            runId: homeRun,
            sequence: String(++this.sequence),
          },
          {
            createdAt: at(1),
            error: null,
            id: `run:${homeRun}`,
            kind: "run",
            replyMessageId: null,
            runId: homeRun,
            status: "completed",
          },
        ],
      },
    });
    const { assignment, run } = this.createTask(home, homeRun, script, at(2));
    this.upsertEntry(
      home.id,
      mockDelegateCall(homeRun, assignment, script.title, home.workspaceId),
    );
    this.upsertEntry(home.id, {
      author: mockAgentAuthor(homeRun, home.id),
      body: script.accepted,
      createdAt: at(3),
      id: this.nextId("message"),
      kind: "message",
      messageKind: "assistant",
      runId: homeRun,
      sequence: String(++this.sequence),
    });
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [home.id]: completeMockRun(this.snapshot.transcripts[home.id] ?? [], homeRun),
      },
    });
    const workerId = assignment.workerThreadId;
    this.update({
      ...this.snapshot,
      transcripts: {
        ...this.snapshot.transcripts,
        [workerId]: [
          ...(this.snapshot.transcripts[workerId] ?? []),
          {
            createdAt: at(4),
            error: null,
            id: `run:${run.id}`,
            kind: "run",
            replyMessageId: null,
            runId: run.id,
            status: "running",
          },
          ...script.steps.map((step, index): ToolEntry => ({
            ...mockTaskStep(run.id, index, step, at(6 + index * 8)),
            completedAt: at(10 + index * 8),
            output: { text: step.output },
            state: "done",
          })),
        ],
      },
    });
    if (script.decision) this.openTaskDecision(workerId, run.id, script.decision, at(30));
  }

  async stopRun(threadId: string): Promise<void> {
    const active = this.activeRuns.get(threadId);
    const thread = this.snapshot.threads.find(({ id }) => id === threadId);
    // A seeded Run has no script behind it, but the Host interrupts any Run it
    // holds as executing, not only one it is driving.
    const runId =
      active?.id ??
      (thread ? threadStopTarget({ runQueue: this.snapshot.runQueue, thread })?.id : undefined);
    if (runId === undefined) throw new Error("This Thread has nothing to stop.");
    if (active) active.cancelled = true;
    this.activeRuns.delete(threadId);

    const timestamp = this.now().toISOString();
    const runQueue = this.snapshot.runQueue.filter((entry) => entry.id !== runId);
    // In a conversation Stop ends this reply and nothing else: the messages
    // the person sent into it that it never read are not sent, and Chat is
    // never paused, so the next Send starts a reply of its own.
    const conversation = thread?.role === "conversation";
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

  async resolveRequest(input: ResolveRequestInput): Promise<void> {
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
        const reviewed = IntegrationInstallManifestSummarySchema.safeParse(manifest);
        if (reviewed.success && reviewed.data.kind === "proposal") {
          if (reviewed.data.proposal.digest !== mockTmdbProposal.digest) {
            throw new Error("The mock Host installs only the proposal it seeded.");
          }
          const installation = mockTmdbInstallation(mockUserId);
          this.integrations.installations = [
            ...this.integrations.installations.filter(
              (entry) => entry.installation.id !== installation.installation.id,
            ),
            installation,
          ];
          this.#keepIntegrationAccessPending(request, {
            ...request.payload,
            installationId: installation.installation.id,
            manifest: null,
            requestedServerId: mockTmdbProposal.serverId,
          });
          return;
        }
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
      const target = this.snapshot.workspaces.find(({ id }) => id === request.targetWorkspaceId);
      if (!target) throw new Error("The mock Host does not have the target Workspace.");
      const response = (
        target.kind === "main"
          ? MainIntegrationAccessResponseSchema
          : SpecializedIntegrationAccessResponseSchema
      ).parse(input.response);
      if (response.value.decision === "fulfilled") {
        this.#verifyMockIntegrationAccessFulfillment(request, response.value.connectionId);
      }
    }
    const resolved = this.#resolvedRequest(request, input.response);
    const timestamp = resolved.resolvedAt;
    const runId = request.originatingRunId;
    const joined = this.answerHeldMessages(request.originatingThreadId, runId, timestamp);
    const transcript = [
      ...(this.snapshot.transcripts[request.originatingThreadId] ?? []),
      requestReceipt(resolved),
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
    if (thread?.role !== "conversation" || runId === null || active?.id !== runId) return [];
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
      case "provider": {
        const connected = this.integrations.connections.some(
          (connection) =>
            connection.id === connectionId &&
            connection.definitionId === requirement.definitionId &&
            connection.status === "connected",
        );
        if (!connected) throw new Error("Connect the requested account before granting access.");
        return;
      }
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
      case "mcp-oauth": {
        const connected = this.integrations.mcpConnections.some(
          (connection) =>
            connection.connectionId === connectionId &&
            connection.installationId === installation.installation.id &&
            connection.serverId === server.id &&
            connection.status === "connected",
        );
        if (!connected)
          throw new Error("Connect the requested MCP account before granting access.");
      }
    }
  }

  private emit(): void {
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
      "The request is scoped to this Workspace, so I should inspect the files before changing anything. ",
      "One shell check plus a focused edit will keep the run small and verifiable.",
    ];
    for (const sentence of reasoningSentences) {
      await delay(this.latencyMs / 2);
      if (!this.isRunCurrent(thread.id, run)) return;
      reasoning = { ...reasoning, text: `${reasoning.text}${sentence}` };
      this.upsertEntry(thread.id, reasoning);
    }
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return;
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
      if (!this.isRunCurrent(thread.id, run)) return;
      shell = { ...shell, streamText: `${shell.streamText}${line}` };
      this.upsertEntry(thread.id, shell);
    }
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return;
    this.upsertEntry(thread.id, {
      ...shell,
      output: { text: shell.streamText },
      state: "done",
    });

    // A second, edit-shaped tool call with a diff-ish payload.
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return;
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
    if (!this.isRunCurrent(thread.id, run)) return;
    this.upsertEntry(thread.id, {
      ...edit,
      output: { text: "Applied patch to docs/notes.md" },
      state: "done",
    });

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
      runId: run.id,
      streaming: true,
    };
    for (const chunk of splitIntoChunks(reply, 3)) {
      await delay(this.latencyMs / 3);
      if (!this.isRunCurrent(thread.id, run)) return;
      draft = { ...draft, body: `${draft.body}${chunk}` };
      this.upsertEntry(thread.id, draft);
    }
    await delay(this.latencyMs / 2);
    if (!this.isRunCurrent(thread.id, run)) return;
    const assistantEntry: MessageEntry = {
      author: mockAgentAuthor(run.id, thread.id),
      body: reply,
      createdAt: this.now().toISOString(),
      id: this.nextId("message"),
      kind: "message",
      messageKind: "assistant",
      runId: run.id,
    };
    this.replaceEntryById(thread.id, streamId, assistantEntry);

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

  private isRunCurrent(threadId: string, run: ActiveMockRun): boolean {
    const current = this.activeRuns.get(threadId);
    return current?.id === run.id && !current.cancelled;
  }

  private nextId(prefix: "message" | "run" | "thread" | "workspace"): string {
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
    this.update({
      ...this.snapshot,
      transcripts: { ...this.snapshot.transcripts, [threadId]: entries },
    });
  }

  private update(snapshot: HostSnapshot): void {
    const tabsChanged = snapshot.browserSessions !== this.snapshot.browserSessions;
    if (tabsChanged) {
      const at = this.now().toISOString();
      const workspaceTabs = snapshot.browserSessions.map((session) => {
        const held = this.snapshot.workspaceTabs?.find((lineage) => lineage.id === session.id);
        return WorkspaceTabLineageSchema.parse({
          id: session.id,
          revision: session.tabCatalog?.revision ?? 0,
          createdAt: held?.createdAt ?? session.createdAt ?? at,
          session: { ...session, createdAt: session.createdAt ?? at, updatedAt: at },
          tabs: [
            ...(held?.tabs ?? []).filter(
              (tab) =>
                tab.state === "suspended" &&
                !session.tabCatalog?.tabs.some((live) => live.id === tab.id),
            ),
            ...(session.tabCatalog?.tabs ?? []).map((tab) => ({
              kind: "browser",
              id: tab.id,
              sessionId: session.id,
              title: tab.title,
              site: tab.site,
              iconRef: tab.iconRef,
              order: tab.order,
              openerId: tab.openerId,
              state: "live",
              createdAt:
                held?.tabs?.find((row) => row.id === tab.id)?.createdAt ??
                (held ? at : (session.createdAt ?? at)),
            })),
          ],
        });
      });
      workspaceTabs.push(
        ...(snapshot.workspaceTabs ?? []).filter(
          (group) =>
            !snapshot.browserSessions.some((session) => session.id === group.session.id) &&
            group.tabs?.some((tab) => tab.state !== "live"),
        ),
      );
      const known = new Set(
        workspaceTabs.flatMap((lineage) => (lineage.tabs ?? []).map((tab) => tab.id)),
      );
      const removed = (this.snapshot.workspaceTabs ?? []).flatMap((lineage) =>
        (lineage.tabs ?? []).filter((tab) => !known.has(tab.id)).map((tab) => tab.id),
      );
      if (removed.length)
        this.tabGroups = {
          ...removeGroupedTabs(this.tabGroups, removed),
          order: this.tabGroups.order?.filter((id) => !removed.includes(id)),
        };
      snapshot = {
        ...snapshot,
        workspaceTabs,
        workspaceTabRestoreVersion: 1,
        ...(removed.length ? { browserTabGroups: this.tabGroups } : {}),
      };
    }
    this.snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    if (tabsChanged && this.projectTabGroups)
      this.snapshot = { ...this.snapshot, browserTabGroups: this.projectTabGroups() };
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
    const tasks = this.taskList(this.snapshot.tasks);
    this.snapshot = {
      ...this.snapshot,
      tasks,
      activeTasks: this.activeTaskEntries(tasks),
      waitingRequests: this.waitingRequests(),
      workspaceTasks: this.workspaceTaskLists(tasks, this.snapshot.workspaceTasks),
    };
    if (
      this.snapshot.connection === "connected" &&
      this.snapshot.user &&
      this.snapshot.session === "authenticated"
    ) {
      const held = this.snapshot.savedViewReadiness ?? emptySavedViewReadiness();
      const main = this.snapshot.workspaces.find(
        ({ id, kind }) => kind === "main" && id === this.snapshot.homeWorkspaceId,
      );
      const home = !main
        ? { status: "unknown" as const }
        : !this.snapshot.homeThreadId
          ? { status: "absent" as const, workspaceId: main.id }
          : held.home.status === "window" && held.home.threadId === this.snapshot.homeThreadId
            ? held.home
            : {
                status: "window" as const,
                threadId: this.snapshot.homeThreadId,
                workspaceId: main.id,
                latest: true,
              };
      this.snapshot = {
        ...this.snapshot,
        savedViewReadiness: { tasksReady: true, workspaceRefusal: held.workspaceRefusal, home },
      };
    }
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

  /** The Workspaces whose own task list a screen asked for. */
  private readonly workspaceTaskScopes = new Set<string>();

  loadWorkspaceTasks(workspaceId: string): void {
    if (!this.snapshot.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new HostClientRequestError({
        code: "not_found",
        message: "Workspace not found",
        status: 404,
      });
    this.workspaceTaskScopes.add(workspaceId);
    this.update(this.snapshot);
  }

  /**
   * Each asked-for Workspace's tasks: the reader's list, cut to that
   * Workspace. A list nothing in moved stays the same list.
   */
  private workspaceTaskLists(
    tasks: TaskListState | null,
    held: Record<string, TaskListState>,
  ): Record<string, TaskListState> {
    if (!tasks) {
      this.workspaceTaskScopes.clear();
      return {};
    }
    let changed = Object.keys(held).length !== this.workspaceTaskScopes.size;
    const lists: Record<string, TaskListState> = {};
    for (const workspaceId of this.workspaceTaskScopes) {
      const entries = tasks.entries.filter(({ thread }) => thread.workspaceId === workspaceId);
      const previous = held[workspaceId];
      const same =
        previous?.entries.length === entries.length &&
        previous.entries.every((entry, index) => entry === entries[index]);
      lists[workspaceId] =
        same && previous ? previous : { entries, window: mockWindow(entries.length) };
      changed ||= lists[workspaceId] !== previous;
    }
    return changed ? lists : held;
  }

  /**
   * What `tasks.list` answers, kept current with every change: each listed,
   * unarchived Thread, most recently updated first, with its last reply and
   * why its latest Run failed. The same list is kept while nothing in it moved.
   */
  private taskList(held: TaskListState | null): TaskListState | null {
    if (!this.snapshot.user) return null;
    const entries = this.snapshot.threads
      .filter((thread) => thread.listed && thread.status !== "archived")
      .sort((left, right) =>
        left.updatedAt === right.updatedAt
          ? right.id.localeCompare(left.id)
          : right.updatedAt.localeCompare(left.updatedAt),
      )
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
              ? plainTextExcerpt(latestRun.error.message, taskLineMaxLength)
              : null,
          lastReply: reply ? plainTextExcerpt(reply.body, taskLineMaxLength) : null,
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
  private waitingRequests(): WaitingRequest[] {
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
            : request.requiredActor === "workspace-owner" || user.instanceRole === "administrator"),
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
        // The preview's engines start no subagents.
        return { assignments: held, request: PendingRequestSchema.parse(request), subagent: null };
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
  for (const [optionId, value] of Object.entries(selection.options)) {
    const option = model.options.find((candidate) => candidate.id === optionId);
    const listed =
      option?.type === "toggle"
        ? typeof value === "boolean"
        : option?.type === "select" &&
          typeof value === "string" &&
          option.values.some((candidate) => candidate.value === value);
    if (!listed)
      throw new Error(`Model option ${optionId} is not available for ${model.displayName}`);
  }
  const { nativeModelId: _clientSupplied, ...requested } = selection;
  return {
    ...requested,
    ...(model.nativeModelId === undefined ? {} : { nativeModelId: model.nativeModelId }),
  };
}

function buildAssistantReply(prompt: string, steered: readonly string[] = []): string {
  const subject = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  return [
    "## What I did",
    "",
    `I worked through “${subject}” end to end on the main runner.`,
    "",
    "- Inspected the Workspace files before changing anything",
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
      id: `msg_cu_${runId}_input`,
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
  // New Host receipts share the historical subjects and headline format; the
  // outer engine tool is a separate compact step and has no computer subject.
  for (const entry of entries) {
    if (
      entry.kind === "tool" &&
      entry.tool?.name === "integration_call" &&
      entry.integration?.computerApp
    ) {
      entry.tool = {
        name: `computer.${entry.integration.operation.name === "act" ? "click" : "observe"}`,
        namespace: "opensteer.integrations",
      };
      entry.arguments = { window: 101 };
    }
  }
  entries.splice(2, 0, {
    kind: "tool",
    id: `tool:${runId}:computer-code`,
    callId: "computer-code",
    runId,
    createdAt: "2026-08-06T23:28:10.500Z",
    completedAt: state === "settled" ? "2026-08-06T23:29:32.200Z" : null,
    tool: { name: "computer", namespace: "opensteer.integrations" },
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

/** The alternate mock keeps unrelated work while removing every seeded Chat reference. */
/** Nothing asked yet: the deployment, its Workspaces and computers, and no work at all. */
function firstRunWorld(snapshot: HostSnapshot): HostSnapshot {
  return {
    ...withoutInitialHome(snapshot),
    activeTasks: [],
    assignments: {},
    browserSessions: [],
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

function withoutInitialHome(snapshot: HostSnapshot): HostSnapshot {
  const homeId = snapshot.homeThreadId;
  const home = snapshot.threads.find((thread) => thread.id === homeId);
  if (!homeId || !home) throw new Error("The seeded mock has no Chat to remove.");
  return {
    ...snapshot,
    homeThreadId: null,
    machines: snapshot.machines.map((machine) =>
      machine.computerUse
        ? {
            ...machine,
            computerUse: {
              ...machine.computerUse,
              sessions: machine.computerUse.sessions.filter(
                (session) => session.threadId !== homeId,
              ),
            },
          }
        : machine,
    ),
    requests: Object.fromEntries(
      Object.entries(snapshot.requests).filter(([threadId]) => threadId !== homeId),
    ),
    runQueue: snapshot.runQueue.filter((run) => run.threadId !== homeId),
    threads: snapshot.threads.filter((thread) => thread.id !== homeId),
    transcripts: Object.fromEntries(
      Object.entries(snapshot.transcripts).filter(([threadId]) => threadId !== homeId),
    ),
    transcriptWindows: Object.fromEntries(
      Object.entries(snapshot.transcriptWindows).filter(([threadId]) => threadId !== homeId),
    ),
    workspaces: snapshot.workspaces.map((workspace) =>
      workspace.id === home.workspaceId ? { ...workspace, homeThreadId: null } : workspace,
    ),
  };
}

function withMockThreadMarks(
  threads: readonly (Omit<ThreadSummary, "icon" | "color" | "doneAt"> & {
    readonly doneAt?: string | null;
  })[],
): ThreadSummary[] {
  return threads.map((thread, index) => ({
    ...thread,
    doneAt: thread.doneAt ?? null,
    icon: thread.role === "conversation" ? null : mockGeneratedTaskIcon(thread.title),
    color: markColorAllocationOrder[index % markColorAllocationOrder.length]!,
  }));
}

function createInitialSnapshot(): HostSnapshot {
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
        body: "Build the new Opensteer foundation from scratch. Keep the architecture simple, make the Host authoritative, and keep Workspace storage explicit for each deployment profile.",
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
        body: "The foundation is taking shape around one clear rule: the Host owns durable truth, while Runners execute work in a Thread’s pinned environment.\n\nThe first slice includes:\n\n- versioned Host and Runner protocols\n- durable Workspace and Thread records\n- a storage-neutral filesystem boundary\n- protected local-directory and PortableFS adapters\n- harness-neutral run events\n- one web client that works hosted or on-prem",
        createdAt: "2026-08-09T16:34:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000002",
        kind: "message",
        messageKind: "assistant",
        runId: "run_00000000-0000-4000-8000-000000000001",
      },
      {
        createdAt: "2026-08-09T16:34:30.000Z",
        id: "reasoning:run_00000000-0000-4000-8000-000000000001:block-1",
        kind: "reasoning",
        runId: "run_00000000-0000-4000-8000-000000000001",
        state: "done",
        text: "Workspace storage is an explicit deployment capability, so local binding and PortableFS authority contracts both need review before protocol work continues.",
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
        body: "Review the PortableFS integration and identify the smallest contract Opensteer needs.",
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
        body: "Opensteer only needs an authority endpoint, a scoped mount grant, and lifecycle visibility. PortableFS should remain unaware of Threads, harnesses, or credentials.\n\nSources: the [PortableFS mount guide](https://portablefs.example/docs/mounts), the [old mirror](http://mirror.portablefs.example/docs) and my draft, [portablefs-contract.md](docs/portablefs-contract.md). Questions go to [storage@portablefs.example](mailto:storage@portablefs.example).\n\n![Mount sequence](/Users/person/Workspaces/main/mount-sequence.png)\n\n[![Grant flow](https://portablefs.example/images/grant-flow.png)](https://portablefs.example/docs/grants)",
        createdAt: "2026-08-09T13:08:00.000Z",
        id: "msg_00000000-0000-4000-8000-000000000007",
        kind: "message",
        messageKind: "assistant",
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
    [mockVapiThreadId]: [
      {
        author: mockHumanAuthor(),
        body: "List the assistants on our Vapi account.",
        createdAt: "2026-08-09T09:30:00.000Z",
        id: "msg_00000000-0000-4000-8000-0000000000f1",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        createdAt: "2026-08-09T09:30:20.000Z",
        error: null,
        id: `run:${mockVapiRunId}`,
        kind: "run",
        replyMessageId: null,
        runId: mockVapiRunId,
        status: "waiting",
      },
    ],
    [mockTmdbThreadId]: [
      {
        author: mockHumanAuthor(),
        body: "Let me look up movies and TV shows on TMDB with my own API key.",
        createdAt: "2026-08-09T10:00:00.000Z",
        id: "msg_00000000-0000-4000-8000-0000000000f9",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        createdAt: "2026-08-09T10:00:20.000Z",
        error: null,
        id: `run:${mockTmdbRunId}`,
        kind: "run",
        replyMessageId: null,
        runId: mockTmdbRunId,
        status: "waiting",
      },
    ],
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
    assignments: {},
    inputQueues: {},
    waitingRequests: [],
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
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          payload: {
            access: "read-write",
            app: mockComputerUseApps.numbers,
            definitionId: "macos-app",
            kind: "computer.app.access",
            reason: mockComputerUseReason,
            runnerId: mockMessagesRunnerId,
            setupRequestId: mockComputerUseSetupRequestId,
            workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          },
          presentation: {
            detail: `${mockComputerUseReason} Numbers on Mac mini — can see and control. Approve on that Mac.`,
            kind: "external",
            subject: { id: mockComputerUseSetupRequestId, kind: "computer-app-setup" },
            title: "Wants to use Numbers on Mac mini",
          },
          requestedBy: mockUserId,
          requiredActor: "workspace-owner",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
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
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          payload: { kind: "harness.input" },
          presentation: {
            detail:
              "PortableFS now has three backends and the integration suite covers each of them separately. Before the next release I need to know which of them to run, how long to let them run for, and who to tell when one of them fails. Everything below is remembered for the rest of this thread.",
            fields: [
              {
                choices: [
                  { label: "Local directory", value: "local-directory" },
                  { label: "PortableFS over S3", value: "portablefs-s3" },
                  { label: "PortableFS over GCS", value: "portablefs-gcs" },
                  { label: "PortableFS over Azure Blob", value: "portablefs-azure" },
                  { label: "PortableFS over the local verifier", value: "portablefs-verifier" },
                  { label: "Container overlay", value: "container-overlay" },
                ],
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
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
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
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000002",
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
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000002",
        }),
      ],
      [mockVapiThreadId]: [
        RequestSchema.parse({
          callId: "mock-vapi-reconnect",
          cancellationReason: null,
          createdAt: "2026-08-09T09:32:00.000Z",
          id: mockVapi.requestId,
          kind: "integration.access",
          mode: "durable",
          originatingOccurrenceId: null,
          originatingRunId: mockVapiRunId,
          originatingThreadId: mockVapiThreadId,
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          payload: {
            access: "read",
            installationId: mockVapi.installationId,
            kind: "integration.access",
            manifest: null,
            reason: mockVapiReason,
            requestedConnectionId: mockVapi.connectionId,
            requestedServerId: mockVapi.serverId,
          },
          presentation: {
            agentProposed: true,
            detail: mockVapiReason,
            kind: "external",
            subject: { id: mockVapi.installationId, kind: "integration-installation" },
            title: "Vapi API access",
          },
          requestedBy: mockUserId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
        }),
      ],
      [mockTmdbThreadId]: [
        RequestSchema.parse({
          callId: "mock-tmdb-proposal",
          cancellationReason: null,
          createdAt: "2026-08-09T10:02:00.000Z",
          id: mockTmdbProposal.requestId,
          kind: "integration.access",
          mode: "durable",
          originatingOccurrenceId: null,
          originatingRunId: mockTmdbRunId,
          originatingThreadId: mockTmdbThreadId,
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          payload: {
            access: "read",
            installationId: null,
            kind: "integration.access",
            manifest: mockTmdbProposal.manifest,
            reason: mockTmdbReason,
            requestedConnectionId: null,
            requestedServerId: null,
          },
          presentation: {
            agentProposed: true,
            detail: mockTmdbReason,
            kind: "external",
            subject: {
              id: `proposal:${mockTmdbProposal.digest}`,
              kind: "integration-install-manifest",
            },
            title: "TMDB access",
          },
          requestedBy: mockUserId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
        }),
      ],
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
      {
        createdAt: "2026-08-09T09:30:20.000Z",
        id: mockVapiRunId,
        status: "waiting",
        threadId: mockVapiThreadId,
        runOrdinal: 0,
      },
      {
        createdAt: "2026-08-09T10:00:20.000Z",
        id: mockTmdbRunId,
        status: "waiting",
        threadId: mockTmdbThreadId,
        runOrdinal: 0,
      },
    ],
    browserProfileGrants: [],
    browserAvailable: false,
    browserPlacements: [],
    browserProfiles: [],
    browserSessions: [],
    connection: "connecting",
    network: "unknown",
    deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    environments: [
      {
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
        name: "Main runner",
        providerStateModes: ["ambient", "isolated"],
        // The Mac mini's own Runner: the Main Mac a Personal deployment runs on.
        runnerId: "rnr_11111111-1111-4111-8111-111111111111",
        status: "connected",
        workspaceBackings: ["local-directory"],
      },
      // A second computer whose person never installed Cursor's CLI. Cursor
      // ships no bytes of its own, so the Runner reports the engine
      // `unavailable` with the install command, and the account already added
      // for it carries that sentence wherever it is offered.
      {
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
        workspaceBackings: ["local-directory"],
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
    homeWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
    homeThreadId: "thr_00000000-0000-4000-8000-000000000001",
    notificationMutes: [],
    threadReadStates: {},
    tasks: null,
    activeTasks: [],
    workspaceTasks: {},
    // The mock stands in for a Personal Deployment on the computer running it:
    // its only identity is the implicit machine owner, so nothing about this
    // fixture names a person.
    identityConfig: {
      deployment: { cloud: false, kind: "personal", name: "Mac mini" },
      emailDeliveryAvailable: false,
      exposure: "loopback",
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
    ownerName: "Alex",
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
      instanceRole: "administrator",
    },
    executionPreferences: emptyExecutionPreferences,
    threadRenameAvailable: true,
    taskMarksAvailable: true,
    sharedTaskDoneAvailable: true,
    workspaceTabReopenAvailable: true,
    searchSuggestionsAvailable: true,
    iphoneAppsAvailable: true,
    ownerViewWindowsAvailable: true,
    workspaceSharingAvailable: true,
    threads: withMockThreadMarks([
      {
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
        role: "conversation",
        runnerLabel: "Main runner",
        status: "running",
        title: "Build the new architecture",
        unread: false,
        updatedAt: "2026-08-09T16:39:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      },
      {
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
        role: "work",
        runnerLabel: "Main runner",
        status: "waiting",
        title: "Review PortableFS integration",
        unread: false,
        updatedAt: "2026-08-09T13:08:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      },
      {
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
        role: "work",
        runnerLabel: "Main runner",
        status: "waiting",
        title: "Prepare the product launch",
        unread: true,
        updatedAt: "2026-08-08T20:04:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
      },
      {
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
        pendingRequests: 0,
        role: "work",
        runnerLabel: "Main runner",
        doneAt: null,
        status: "idle",
        title: "Reconcile August expenses",
        unread: false,
        updatedAt: "2026-08-07T19:12:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000003",
      },
      {
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
        role: "work",
        runnerLabel: "Main runner",
        status: "failed",
        title: "Download the September card statements",
        unread: false,
        updatedAt: "2026-08-08T09:41:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000003",
      },
      ...(
        [
          [mockSlackThreadId, "idle", "Click the Opensteer org in Slack"],
          [mockSlackLiveThreadId, "running", "Switch Slack to Opensteer"],
        ] as const
      ).map(([id, status, title]) => ({
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
        role: "work" as const,
        runnerLabel: "Main runner",
        status,
        title,
        unread: false,
        updatedAt: "2026-08-06T23:29:37.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      })),
      {
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        createdAt: "2026-08-09T09:30:00.000Z",
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        harnessLabel: "Codex",
        id: mockVapiThreadId,
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        role: "work",
        runnerLabel: "Main runner",
        status: "waiting",
        title: "List the Vapi assistants",
        unread: false,
        updatedAt: "2026-08-09T09:32:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      },
      {
        accessMode: DEFAULT_THREAD_ACCESS_MODE,
        continuationIdentity: mockCodexContinuationIdentity,
        providerSessionId: createId("providerSession"),
        createdAt: "2026-08-09T10:00:00.000Z",
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        harnessInstanceId: mockCodexHarnessInstanceId,
        harnessLabel: "Codex",
        id: mockTmdbThreadId,
        inputQueuePaused: false,
        listed: true,
        modelLabel: "GPT-5.6-Sol",
        modelSelection: mockCodexModelSelection,
        parentThreadId: null,
        pendingRequests: 1,
        role: "work",
        runnerLabel: "Main runner",
        status: "waiting",
        title: "Look up movies on TMDB",
        unread: false,
        updatedAt: "2026-08-09T10:02:00.000Z",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000001",
      },
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
    workspaceWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 3,
      nextBefore: null,
      totalItems: 3,
    },
    workspaces: [
      {
        description: "The new product, Host, Runners, protocols, and UI.",
        homeThreadId: "thr_00000000-0000-4000-8000-000000000001",
        fileCount: 18,
        harnessLabel: "Codex",
        id: "wsp_00000000-0000-4000-8000-000000000001",
        kind: "main",
        icon: null,
        machineName: "Main runner",
        name: "Main",
        runnerLabel: "Main runner",
        status: "ready",
        storageIssue: null,
        color: "blue",
        updatedAt: "2026-08-09T16:39:00.000Z",
      },
      {
        description: "Positioning, launch briefs, website, and customer proof.",
        homeThreadId: null,
        fileCount: 27,
        harnessLabel: "Codex",
        id: "wsp_00000000-0000-4000-8000-000000000002",
        kind: "specialized",
        icon: "rocket",
        machineName: "Main runner",
        name: "Customer launch",
        runnerLabel: "Main runner",
        status: "ready",
        storageIssue: null,
        color: "green",
        updatedAt: "2026-08-08T20:04:00.000Z",
      },
      {
        description: "Monthly close, invoices, budgets, and operating reports.",
        homeThreadId: null,
        fileCount: 42,
        harnessLabel: "Codex",
        id: "wsp_00000000-0000-4000-8000-000000000003",
        kind: "specialized",
        icon: "chart",
        machineName: "Main runner",
        name: "Finance & operations",
        runnerLabel: "Main runner",
        status: "ready",
        storageIssue: null,
        color: "lime",
        updatedAt: "2026-08-07T19:12:00.000Z",
      },
    ],
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
    originatingWorkspaceId: mockPasswordSignInWorkspaceId,
    payload: {
      computerName: "Mac mini",
      expiresAt: input.expiresAt ?? new Date(Date.now() + 14 * 60_000).toISOString(),
      kind: "browser.password-sign-in",
      operationId: `0192f4a1-7777-4000-8000-${String(index).padStart(12, "0")}`,
      reason: `Download the October statement from ${domain} to finish the reconciliation.`,
      runnerId: "rnr_11111111-1111-4111-8111-111111111111",
      sessionId: "bss_preview",
      site,
    },
    presentation: {
      kind: "external",
      subject: { id: site, kind: "browser-site" },
      title: `Sign in to ${domain}`,
    },
    requestedBy: mockUserId,
    requiredActor: "workspace-owner",
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
    targetWorkspaceId: mockPasswordSignInWorkspaceId,
  });
}

const mockPasswordSignInThreadId = "thr_00000000-0000-4000-8000-000000000004";
const mockPasswordSignInWorkspaceId = "wsp_00000000-0000-4000-8000-000000000003";
