import { TeamCommandResultViewSchema, teamReadViews } from "./team-views.js";
import {
  FolderFileKeySchema,
  FolderFileCursorSchema,
  FolderFileRevisionSchema,
  FolderDirectoryPageViewSchema,
  FolderFilePreviewMetadataViewSchema,
} from "./files.js";
import { NeedsYouPageSchema } from "./needs-you.js";
import { TaskFolderSchema } from "@opensteer/core";
import { ToolOutputViewSchema } from "@opensteer/core";
import { AutomaticModelsViewSchema } from "./automatic-models.js";
import { TeamCommandSchema, teamReadSchemas } from "./team-api.js";
import { AutomaticModelConfigSchema, AutomaticModelConfigViewSchema } from "@opensteer/core";
import {
  AgentConnectionSchema,
  AgentConnectionIdSchema,
  AgentConnectionConsentSchema,
} from "./agent-connections.js";
import {
  PluginTargetSchema,
  PluginsOverviewViewSchema,
  PluginDetailViewSchema,
  PluginsDirectoryViewSchema,
  DevicesOverviewViewSchema,
  SettingsPluginEnableCommandSchema,
  SettingsPluginEnableResultSchema,
} from "./settings.js";
import { CardApprovalSchema } from "./card-use.js";
import { PasswordSignInCardViewSchema, PasswordSignInApprovalSchema } from "./password-sign-in.js";
import { ComputerUseResolvedAppSchema } from "./computer-use.js";
import {
  ChannelAccessGrantViewSchema,
  ChannelAccessPolicySchema,
  ChannelAccountIdSchema,
  ChannelAccountViewSchema,
  ChannelBindingIdSchema,
  ChannelBindingViewSchema,
  ChannelConnectionInspectionViewSchema,
  ChannelDashboardViewSchema,
  ChannelExecutionPolicySchema,
  ChannelRouteSelectorSchema,
  IntegrationConnectionViewSchema,
} from "@opensteer/channel-core";
import {
  PersonalRemoteAdministrationIntentSchema,
  PersonalRemoteAdministrationOperationSchema,
  PersonalRemoteAdministrationStatusSchema,
  IssuePersonalPairingCodeResponseSchema,
  ApprovePersonalHostAccountLinkRequestSchema,
  ApprovePersonalHostAccountLinkResponseSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  PersonalRemoteAccessStatusSchema,
} from "./personal-remote-access.js";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
  SpecialistRegistrationViewSchema,
  AssignmentIdSchema,
  AssignmentSummarySchema,
  AssignmentViewSchema,
  AttachmentIdSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  AttachmentSchema,
  AuthSessionIdSchema,
  AuthSessionSummarySchema,
  AuthenticatedSessionViewSchema,
  BrowserProfileIdSchema,
  BrowserSiteSchema,
  BrowserSourceIdSchema,
  BrowserSurfaceIdSchema,
  EnvironmentIdSchema,
  ExecutionNodeIdSchema,
  ExecutionNodeViewSchema,
  ExecutionPreferencesViewSchema,
  ExecutionSelectionSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  HarnessInstanceStateKindSchema,
  IdentityPasswordSchema,
  LiveRunProgressViewSchema,
  LocalPasswordRecoveryTokenSchema,
  MessageContentSchema,
  MessageIdSchema,
  MessageViewSchema,
  ModelSelectionSchema,
  NotificationInstallationIdSchema,
  NotificationPreviewKeyIdSchema,
  NotificationPreviewKeySchema,
  OpensteerErrorCodeSchema,
  ProviderSessionIdSchema,
  RequestIdSchema,
  RequestResponseSchema,
  RequestViewSchema,
  RunAttemptViewSchema,
  RunIdSchema,
  RunViewSchema,
  RunnerIdSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  ThreadInputPolicySchema,
  ThreadInputQueueViewSchema,
  ThreadInputViewSchema,
  ThreadReadStateSchema,
  ThreadTitleSchema,
  ThreadViewSchema,
  TimeZoneSchema,
  QuietTaskDaysSchema,
  TriggerIdSchema,
  TriggerOccurrenceIdSchema,
  WaitingRequestViewSchema,
  IconNameSchema,
  attachmentMaxBytes,
  identityPasswordMaxLength,
  readableRequestList,
  type AuthenticatedSession,
} from "@opensteer/core";
import {
  BeginIntegrationAuthorizationSchema,
  BeginMcpAuthorizationSchema,
  ComputerAppSetupRequestViewSchema,
  ComputerAppSetupReviewRequestViewSchema,
  ComputerUseAppApprovalSchema,
  ConnectIntegrationApiKeySchema,
  CreateIntegrationGrantSchema,
  InstallAgentPluginSchema,
  InstallCatalogIntegrationSchema,
  InstallRemoteMcpSchema,
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationAuthorizationReturnProofSchema,
  IntegrationAuthorizationStartViewSchema,
  IntegrationAuthorizationStatusViewSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionSummaryViewSchema,
  IntegrationDashboardViewSchema,
  IntegrationGrantIdSchema,
  IntegrationGrantViewSchema,
  IntegrationInstallationIdSchema,
  IntegrationInstallationViewSchema,
  IntegrationPlatformDashboardViewSchema,
  IntegrationProviderApplicationViewSchema,
  IntegrationRepositoryAccessViewSchema,
  IntegrationServerIdSchema,
  LocalMcpSecretNameSchema,
  LocalMcpSecretViewSchema,
  LocalMcpSecretValuesSchema,
  localMcpMaxSecrets,
  RequestComputerAppSetupSchema,
  SaveIntegrationProviderApplicationSchema,
  SetComputerAppConnectionSchema,
  SetIntegrationApplicationSourceDefaultSchema,
  SetIntegrationProviderApplicationStatusSchema,
} from "@opensteer/integration-core";
import {
  CreateTriggerHttpBodySchema,
  TriggerOccurrenceViewSchema,
  TriggerRevisionViewSchema,
  TriggerSummaryViewSchema,
  TriggerViewSchema,
  TriggerWatchActivationViewSchema,
  UpdateTriggerHttpBodySchema,
} from "@opensteer/triggers/models";
import { z } from "zod";
import { AppIdSchema, AppSchema } from "@opensteer/core";
import { AgentPhoneHostTargetViewSchema } from "./android-phone.js";
import { AttachmentContentSchema, AttachmentReferenceInputSchema } from "./attachments.js";
import { AppTabsSchema, HostBootstrapSchema, IdentityConfigViewSchema } from "./bootstrap.js";
import {
  BrowserSignInDecisionSchema,
  BrowserSignInOutcomeSchema,
  BrowserSourceInspectionSchema,
  BrowserSourceNameSchema,
  BrowserSourcePairingSchema,
  BrowserSourcesStateSchema,
} from "./browser-sources.js";
import {
  BrowserContextCandidateInputSchema,
  BrowserContextCandidateSchema,
  BrowserHistoryIconsInputSchema,
  BrowserHistoryIconsSchema,
  BrowserHistoryInputSchema,
  BrowserHistorySchema,
  BrowserHistoryUrlSchema,
  BrowserProfileDeletionSchema,
  BrowserProfileNameSchema,
  BrowserProfileSchema,
  BrowserTabCloseCommandSchema,
  BrowserTabCloseResultSchema,
  BrowserTabIconInputSchema,
  BrowserTabIconResultSchema,
  BrowserTabOpenCommandSchema,
  BrowserTabOpenResultSchema,
  CreateBrowserProfileBodySchema,
  CreateBrowserProfileResponseSchema,
  StartHostedBrowserBodySchema,
  StartHostedBrowserResponseSchema,
  ThreadBrowserUsageSchema,
  PersonalTabActivateCommandSchema,
  PersonalTabActivateResultSchema,
  PersonalTabCloseCommandSchema,
  PersonalTabCloseResultSchema,
  PersonalTabGroupUpdateCommandSchema,
  PersonalTabGroupUpdateResultSchema,
  PersonalTabReopenCommandSchema,
  PersonalTabReopenResultSchema,
  PersonalTabsCloseCommandSchema,
  PersonalTabsCloseResultSchema,
  PersonalTabsGroupCommandSchema,
  PersonalTabsGroupResultSchema,
  PersonalTabsMoveCommandSchema,
  PersonalTabsMoveResultSchema,
  PersonalTabsUngroupCommandSchema,
  PersonalTabsUngroupResultSchema,
  browserUsageRunBatchSize,
} from "./browser.js";
import {
  DurableWindowCursorSchema,
  DurableWindowSchema,
  TaskPageSchema,
  NodeEventPageSchema,
  ThreadEventPageSchema,
  ThreadMessagePageSchema,
  turnPageMaxTurns,
} from "./client.js";
import {
  ComputerAppIdentitySchema,
  ComputerAppIdentityViewSchema,
  ComputerUseInstalledAppSchema,
  ComputerUseInstalledAppsParamsSchema,
  ComputerUseSessionIdSchema,
  OwnerWindowInfoSchema,
  computerUseMaxInstalledApps,
  computerUseMaxWindows,
} from "./computer-use.js";
import {
  ApprovedComputerAppSchema,
  ComputerViewCloseCommandSchema,
  ComputerViewCloseResultSchema,
  ComputerViewOpenCommandSchema,
  ComputerViewOpenResultSchema,
  ComputerViewRenewCommandSchema,
  ComputerViewRenewResultSchema,
} from "./computer-view.js";

import { MachineSummarySchema } from "./machines.js";
import { defineRpc, type RpcClient, type RpcHandlers } from "./rpc.js";
import { RunnerModuleNameSchema } from "./runner-identity.js";
import {
  HarnessAuthenticationStateViewSchema,
  HarnessInstallationSchema,
  HarnessModelSettingsMapViewSchema,
  HarnessModelSettingsSchema,
  HarnessSourceIdSchema,
  ModelServerViewSchema,
  maxModelServers,
} from "./runner.js";
import {
  MachineAccessPolicySchema,
  ShellHistoryCursorSchema,
  ShellSessionHistoryEntrySchema,
  ShellSessionIdSchema,
  machineAccessHistoryMaxSessions,
} from "./shell.js";
import {
  VoiceContextInputSchema,
  VoiceEmptyResultSchema,
  VoiceRenewInputSchema,
  VoiceSayInputSchema,
  VoiceOpenInputSchema,
  VoiceOpenResultSchema,
  VoiceStartInputSchema,
  VoiceStartResultSchema,
  VoiceStopInputSchema,
} from "./voice.js";

const emptyInputSchema = z.strictObject({});
const emptyOutputSchema = z.object({});
/** Forward tolerant at every reachable object, as every Host response is. */
const ComputerUseInstalledAppViewSchema = z.object({
  ...ComputerUseInstalledAppSchema.shape,
  identity: ComputerAppIdentityViewSchema,
});
const idempotencyKeySchema = z.string().trim().min(1).max(255);
const emailSchema = z.email().max(320);
// An interrupted native OAuth authorization rides through sign-in as its opaque
// original query string. Bounding it keeps an unauthenticated caller from
// making the Host carry an arbitrarily large one.
const oauthQuerySchema = z.string().min(1).max(32_768);
// Sign-in compares against whatever was stored, so it takes any password the
// signup rules could have produced rather than today's minimum length.
const submittedPasswordSchema = z.string().min(1).max(identityPasswordMaxLength);
const oidcProviderIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
// Sign-in returns the browser to where it started. Only the two destinations
// the flow can legitimately resume are accepted, so a redirect cannot be aimed
// at an arbitrary path.
const oidcReturnPathSchema = z
  .string()
  .regex(/^\/(?:$|invite\/[A-Za-z0-9_-]{24,96}$)/)
  .default("/");

/**
 * The request header every rpc caller states its protocol epoch in. A request
 * that omits it is a client from before negotiation existed, and the Host
 * refuses it: there are none in the wild, because the Host serves its own web
 * bundle and the Desktop ships with the Host it talks to.
 */
export {
  hostApiVersionHeader,
  teamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";

export const HostApiErrorSchema = z.object({
  code: OpensteerErrorCodeSchema,
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
  retryable: z.boolean(),
});

const durablePageInputSchema = z.strictObject({
  before: DurableWindowCursorSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const AuthSessionSummaryViewSchema = z.object(AuthSessionSummarySchema.shape);

const harnessRecordSchema = z.object({
  modelSettings: HarnessModelSettingsMapViewSchema.optional(),
  config: z.unknown(),
  driverKind: z.string().min(1),
  enabled: z.boolean(),
  environmentId: EnvironmentIdSchema,
  id: HarnessInstanceIdSchema,
  isDefault: z.boolean(),
  name: z.string().trim().min(1).max(120),
  runtimeRevision: z.number().int().positive(),
  sourceId: z.string().min(1).max(100),
  stateKind: HarnessInstanceStateKindSchema,
});

const harnessAuthenticationEnvelopeSchema = z.object({
  authentication: HarnessAuthenticationStateViewSchema,
  environmentStatus: z.enum(["connected", "disconnected"]),
});

const otherCommandInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("app.tab.open"),
    appId: AppIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    type: z.literal("app.tab.close"),
    appId: AppIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    type: z.literal("phone.tab.close"),
    machineId: RunnerIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  ComputerViewOpenCommandSchema,
  ComputerViewCloseCommandSchema,
  ComputerViewRenewCommandSchema,
  BrowserTabCloseCommandSchema,
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    mediaType: AttachmentMediaTypeSchema,
    name: AttachmentNameSchema,
    sizeBytes: z.number().int().nonnegative().max(attachmentMaxBytes),
    type: z.literal("attachment.upload.create"),
  }),
  z.strictObject({
    attachmentId: AttachmentIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("attachment.upload.discard"),
  }),

  /** A specialist's colour, chosen. Sent only to a Host that advertises `task-marks-v1`. */

  z.strictObject({
    accessMode: ThreadAccessModeSchema.optional(),
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    modelSelection: ModelSelectionSchema,
    parentThreadId: ThreadIdSchema.optional(),
    /**
     * `title` is the first line of the message that will start the Thread, for
     * background naming to replace with a generated name. Absent, `title` is a name
     * someone chose and nothing replaces it. Sent only to a Host that
     * advertises `thread-titles-v1`.
     */
    generateTitle: z.literal(true).optional(),
    title: ThreadTitleSchema,
    type: z.literal("thread.create"),
    folder: TaskFolderSchema.optional(),
  }),
  /**
   * A person names a Thread. Nothing replaces the name afterwards, even when
   * it is the title the Thread already had. Sent only to a Host that
   * advertises `thread-titles-v1`.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    title: ThreadTitleSchema,
    type: z.literal("thread.rename"),
  }),

  z.strictObject({
    icon: IconNameSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.icon.set"),
  }),
  z.strictObject({
    content: MessageContentSchema,
    delivery: ThreadInputPolicySchema.extract(["queue", "steer"]).optional().default("queue"),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.sendMessage"),
    quotedMessageId: MessageIdSchema.optional(),
  }),
  z.strictObject({
    assignmentId: AssignmentIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("assignment.cancel"),
  }),
  z.strictObject({
    threadId: ThreadIdSchema,
    messageId: MessageIdSchema,
    expectedRunId: RunIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("thread.input.steer"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    messageId: MessageIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.cancel"),
  }),
  z.strictObject({
    /** The waiting message to stand in front of, or null for the back of the queue. */
    beforeMessageId: MessageIdSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    messageId: MessageIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.move"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.inputQueue.resume"),
  }),
  z.strictObject({
    type: z.literal("thread.read.mark"),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    throughSequence: SequenceSchema,
  }),
  // The epoch-48 personal-placement command is accepted only to return a typed
  // update-required refusal. It must never reach shared Done or receipt lookup.
  z.strictObject({
    type: z.literal("thread.done.set"),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    done: z.boolean(),
  }),
  // Marks a task Done, which stops it and the work it handed out and refuses
  // new work until it is reopened, or reopens it. Every member sees the change.

  z.strictObject({
    type: z.literal("notification.preview.register"),
    installationId: NotificationInstallationIdSchema,
    accountId: ControlPlaneAccountIdSchema,
    keyId: NotificationPreviewKeyIdSchema,
    key: NotificationPreviewKeySchema,
  }),
  // The reader's IANA time zone, which a client reports from its own clock so
  // an agent asked for "5pm" means the person's 5pm.
  z.strictObject({
    type: z.literal("viewer.timeZone.update"),
    idempotencyKey: idempotencyKeySchema,
    timeZone: TimeZoneSchema,
  }),
  // How many untouched days move the reader's tasks to Done. Needs `quiet-tasks-v1`.
  z.strictObject({
    type: z.literal("viewer.quietTasks.update"),
    idempotencyKey: idempotencyKeySchema,
    quietTaskDays: QuietTaskDaysSchema,
  }),
  z.strictObject({
    continuation: z
      .strictObject({
        expectedProviderSessionId: ProviderSessionIdSchema.nullable(),
      })
      .optional(),
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    modelSelection: ModelSelectionSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.execution.update"),
  }),
  z.strictObject({
    accessMode: ThreadAccessModeSchema,
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.access.update"),
  }),
  z.strictObject({
    type: z.literal("automaticModels.set"),
    idempotencyKey: idempotencyKeySchema,
    config: AutomaticModelConfigSchema,
  }),
  // A choice a person just made, to start their next Thread from. The Host
  // folds it into the one record it keeps per person, so a phone and a desktop
  // never disagree about what was chosen last. Either half may be absent —
  // an access mode changes without a model, and vice versa — but not both.
  z
    .strictObject({
      accessMode: ThreadAccessModeSchema.optional(),
      idempotencyKey: idempotencyKeySchema,
      selection: ExecutionSelectionSchema.optional(),
      type: z.literal("execution.preferences.remember"),
    })
    .refine(
      (value) => value.accessMode !== undefined || value.selection !== undefined,
      "A remembered choice names an access mode, a selection, or both",
    ),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("run.interrupt"),
  }),
  z.strictObject({
    type: z.literal("node.stop"),
    idempotencyKey: idempotencyKeySchema,
    nodeId: ExecutionNodeIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: RequestIdSchema,
    response: RequestResponseSchema,
    type: z.literal("request.respond"),
  }),
  z.strictObject({
    /** Source fields the person filled in (a base URL, a region); the driver validates them. */
    config: z.record(z.string().max(60), z.string().max(2_048)).optional(),
    driverKind: HarnessIdSchema,
    environmentId: EnvironmentIdSchema,
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(120),
    sourceId: HarnessSourceIdSchema,
    stateKind: HarnessInstanceStateKindSchema,
    type: z.literal("harness.create"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    nativeModelId: z.string().trim().min(1).max(255),
    settings: HarnessModelSettingsSchema.nullable(),
    type: z.literal("harness.model.configure"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(120),
    type: z.literal("harness.rename"),
  }),
  z.strictObject({
    enabled: z.boolean(),
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.enabled.set"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.default.set"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.delete"),
  }),
  z.strictObject({
    driverKind: HarnessIdSchema,
    environmentId: EnvironmentIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.update"),
  }),
  z.strictObject({
    connectionSlot: z.string().min(1).max(100).optional(),
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    methodId: z.string().min(1).max(100),
    type: z.literal("harness.authentication.begin"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.authentication.submit"),
    value: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    connectionSlot: z.string().min(1).max(100).optional(),
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.authentication.logout"),
  }),
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.authentication.cancel"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    machineId: z.string().min(1).max(512),
    type: z.literal("machine.revoke"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    machineId: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(120),
    type: z.literal("machine.rename"),
  }),
  z.strictObject({
    /** The revision the editor last read; a stale one conflicts and ends nothing. */
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: idempotencyKeySchema,
    policy: MachineAccessPolicySchema,
    runnerId: RunnerIdSchema,
    type: z.literal("machine.access.update"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    sessionId: ShellSessionIdSchema,
    type: z.literal("machine.access.session.stop"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    intent: PersonalRemoteAdministrationIntentSchema,
    type: z.literal("personal.remoteAccess.request"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("personal.remoteAccess.pairing.create"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    challenge: ApprovePersonalHostAccountLinkRequestSchema,
    type: z.literal("personal.accountLink.approve"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    completion: ConsumePersonalHostAccountLinkRequestSchema,
    type: z.literal("personal.accountLink.complete"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    connectionId: AgentConnectionIdSchema,
    type: z.literal("connection.revoke"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    decision: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("deny") }),
      z.strictObject({
        kind: z.literal("approve"),
        label: z.string().trim().min(1).max(120),
        accessMode: ThreadAccessModeSchema,
      }),
    ]),
    type: z.literal("connection.authorize"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    sessionId: AuthSessionIdSchema,
    type: z.literal("session.revoke"),
  }),
  z.strictObject({
    /** What the computer redeeming this token may ever advertise. */
    allowedModules: z.array(RunnerModuleNameSchema).min(1).max(5),
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(120),
    type: z.literal("runner.enrollment.createLocal"),
  }),

  /**
   * A phone sharing Android's screen or iPhone data apps. The Host fixes the
   * integrations grant and pairing target; the optional iPhone profile pins
   * its phone native descriptor at redemption and authentication.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(120),
    profile: z.literal("iphone").optional(),
    type: z.literal("runner.enrollment.createPhone"),
  }),
  /**
   * Makes an enrollment its owner minted unusable at once, so setup can
   * replace it without two that could both be redeemed.
   */
  z.strictObject({
    enrollmentId: z.string().min(1).max(256),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("runner.enrollment.retire"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: BeginMcpAuthorizationSchema,
    type: z.literal("integration.mcp.authorization.begin"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: SetComputerAppConnectionSchema,
    type: z.literal("integration.computer.setup.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: RequestComputerAppSetupSchema,
    type: z.literal("integration.computer.setup.request"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: z.strictObject({ runnerId: RunnerIdSchema, appApproval: z.literal("ask") }),
    type: z.literal("integration.computer.policy.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    connectionId: IntegrationConnectionIdSchema,
    type: z.literal("integration.computer.app.block"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: z.uuid(),
    type: z.literal("integration.computer.setup.cancel"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    setupRequestId: z.uuid(),
    decision: z.enum(["allow", "deny"]),
    /** Allowing a server: what its owner entered for the secrets its launch declares. */
    secrets: LocalMcpSecretValuesSchema.optional(),
    type: z.literal("integration.computer.setup.respond"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    /** New values for some of an approved server's secrets; the rest keep theirs. */
    secrets: LocalMcpSecretValuesSchema,
    serverId: IntegrationServerIdSchema,
    type: z.literal("integration.server.secrets.set"),
  }),
  z.strictObject({
    attemptId: IntegrationAuthorizationAttemptIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.authorization.cancel"),
  }),
  /**
   * The app that started an app-finished consent hands back the browser's
   * one-use return proof; until then the Account service keeps the result
   * sealed. Sent only to a Host advertising `integration-app-finish-v1`.
   */
  z.strictObject({
    attemptId: IntegrationAuthorizationAttemptIdSchema,
    idempotencyKey: idempotencyKeySchema,
    returnProof: IntegrationAuthorizationReturnProofSchema,
    type: z.literal("integration.authorization.return"),
  }),
  z.strictObject({
    connectionId: IntegrationConnectionIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.mcp.disconnect"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("plugin.update"),
    pluginId: z.string(),
    input: InstallAgentPluginSchema,
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("plugin.remove"),
    pluginId: z.string(),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("plugin.activation.set"),
    pluginId: z.string(),

    active: z.boolean(),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("plugin.list"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("specialist.add"),

    pluginId: z.string().min(1),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("specialist.remove"),

    specialistId: z.string().min(1),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("specialist.list"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: InstallAgentPluginSchema,
    type: z.literal("plugin.install"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: InstallRemoteMcpSchema,
    type: z.literal("integration.remoteMcp.install"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: InstallCatalogIntegrationSchema,
    type: z.literal("integration.catalog.install"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    installationId: IntegrationInstallationIdSchema,
    type: z.literal("integration.uninstall"),
  }),
  z.strictObject({
    grantId: IntegrationGrantIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.grant.revoke"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: SaveIntegrationProviderApplicationSchema,
    type: z.literal("integration.providerApplication.save"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: BeginIntegrationAuthorizationSchema,
    type: z.literal("integration.authorization.begin"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: ConnectIntegrationApiKeySchema,
    type: z.literal("integration.apiKey.connect"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: CreateIntegrationGrantSchema,
    type: z.literal("integration.grant.create"),
  }),
  z.strictObject({
    connectionId: IntegrationConnectionIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.disconnect"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: SetIntegrationProviderApplicationStatusSchema,
    provider: z.string().min(1),
    type: z.literal("integration.providerApplication.status.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: SetIntegrationApplicationSourceDefaultSchema,
    provider: z.string().min(1),
    type: z.literal("integration.applicationSourceDefault.set"),
  }),
  z.strictObject({
    accessPolicy: ChannelAccessPolicySchema,
    credentials: z.record(z.string(), z.string()),
    idempotencyKey: idempotencyKeySchema,
    provider: z.string().min(1),
    routingMode: z.enum(["dedicated", "shared"]),
    folder: TaskFolderSchema,
    type: z.literal("channel.connection.create"),
  }),
  z.strictObject({
    connectionId: IntegrationConnectionIdSchema,
    credentials: z.record(z.string(), z.string()),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("channel.connection.credentials.replace"),
  }),
  /**
   * A channel whose transport runs on one of the owner's computers — iMessage
   * through that Mac — pinned there, using its app connection. `ownerHandles`
   * are where the owner writes from, linked to them at once.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    ownerHandles: z.array(z.string().trim().min(3).max(320)).min(1).max(8),
    provider: z.string().min(1),
    runnerId: RunnerIdSchema,
    folder: TaskFolderSchema,
    type: z.literal("channel.connection.computer.create"),
  }),
  z.strictObject({
    accessPolicy: ChannelAccessPolicySchema,
    accountId: ChannelAccountIdSchema,
    executionPolicy: ChannelExecutionPolicySchema,
    idempotencyKey: idempotencyKeySchema,
    selector: ChannelRouteSelectorSchema,
    folder: TaskFolderSchema,
    type: z.literal("channel.binding.create"),
  }),
  z.strictObject({
    bindingId: ChannelBindingIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("channel.binding.revoke"),
  }),
  z.strictObject({
    accessPolicy: ChannelAccessPolicySchema,
    bindingId: ChannelBindingIdSchema,
    expectedRevision: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("channel.binding.update"),
  }),
  z.strictObject({
    bindingId: ChannelBindingIdSchema,
    externalUserId: z.string().trim().min(1).max(512),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approved", "declined", "revoked"]),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("channel.access.review"),
  }),
  z.strictObject({
    code: z.string().trim().min(8).max(32),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("channel.identity.link"),
  }),
  z.strictObject({
    connectionId: IntegrationConnectionIdSchema,
    idempotencyKey: idempotencyKeySchema,
    status: z.enum(["connected", "paused", "revoked"]),
    type: z.literal("channel.connection.status.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: StartHostedBrowserBodySchema,
    type: z.literal("browser.session.start"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: CreateBrowserProfileBodySchema,
    type: z.literal("browser.profile.create"),
  }),
  z.strictObject({ idempotencyKey: idempotencyKeySchema, type: z.literal("browser.source.pair") }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    name: BrowserSourceNameSchema,
    sourceId: BrowserSourceIdSchema,
    type: z.literal("browser.source.rename"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    sourceId: BrowserSourceIdSchema,
    type: z.literal("browser.source.revoke"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    site: BrowserSiteSchema,
    type: z.literal("browser.site.remove"),
  }),

  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    sessionId: z.string().min(1).max(128),
    sourceId: BrowserSourceIdSchema.nullable(),
    type: z.literal("browser.session.sign-in"),
    surfaceId: BrowserSurfaceIdSchema.optional(),
    url: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    decision: BrowserSignInDecisionSchema,
    idempotencyKey: idempotencyKeySchema,
    requestId: RequestIdSchema,
    type: z.literal("browser.sign-in.respond"),
  }),
  /**
   * Answers saved-login consent as its requester from any authenticated client.
   * The Host commits the broker only after the Request's durable settlement.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: RequestIdSchema,
    type: z.literal("browser.password-sign-in.respond"),
    decision: z.union([
      z.strictObject({ kind: z.literal("decline") }),
      z.strictObject({ kind: z.literal("approve"), ...PasswordSignInApprovalSchema.shape }),
      z.strictObject({ kind: z.literal("approve-card"), ...CardApprovalSchema.shape }),
    ]),
  }),

  /** Requires the Host's `browser-profile-manage-v1` capability. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    name: BrowserProfileNameSchema,
    profileId: BrowserProfileIdSchema,
    type: z.literal("browser.profile.rename"),
  }),
  /**
   * Erases the profile's saved sign-ins and site data, revokes every grant of
   * it and closes its tabs. Requires `browser-profile-manage-v1`.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    profileId: BrowserProfileIdSchema,
    type: z.literal("browser.profile.delete"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    sessionId: z.string().min(1),
    type: z.literal("browser.session.close"),
  }),
  /** Forgets one address from the person's own profile's history, and its site's icon when unused. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    profileId: BrowserProfileIdSchema,
    url: BrowserHistoryUrlSchema,
    type: z.literal("browser.history.remove"),
  }),
  /** Forgets the person's own profile's whole history and its retained icons. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    profileId: BrowserProfileIdSchema,
    type: z.literal("browser.history.clear"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: CreateTriggerHttpBodySchema,
    type: z.literal("trigger.create"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: UpdateTriggerHttpBodySchema,
    triggerId: TriggerIdSchema,
    type: z.literal("trigger.update"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    status: z.enum(["active", "paused", "archived"]),
    triggerId: TriggerIdSchema,
    type: z.literal("trigger.status.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    payload: z.unknown().optional(),
    triggerId: TriggerIdSchema,
    type: z.literal("trigger.run"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    occurrenceId: TriggerOccurrenceIdSchema.optional(),
    triggerId: TriggerIdSchema,
    type: z.literal("trigger.cancel"),
  }),
]);

const commandInputSchema = z.discriminatedUnion("type", [
  ...TeamCommandSchema.options,
  SettingsPluginEnableCommandSchema,
  BrowserTabOpenCommandSchema,
  PersonalTabActivateCommandSchema,
  PersonalTabCloseCommandSchema,
  PersonalTabReopenCommandSchema,
  PersonalTabsGroupCommandSchema,
  PersonalTabsUngroupCommandSchema,
  PersonalTabsMoveCommandSchema,
  PersonalTabGroupUpdateCommandSchema,
  PersonalTabsCloseCommandSchema,
  ...otherCommandInputSchema.options,
]);

const commandOutputSchema = z.discriminatedUnion("type", [
  ...TeamCommandResultViewSchema.options,
  SettingsPluginEnableResultSchema,
  PersonalTabActivateResultSchema,
  PersonalTabCloseResultSchema,
  PersonalTabReopenResultSchema,
  PersonalTabsGroupResultSchema,
  PersonalTabsUngroupResultSchema,
  PersonalTabsMoveResultSchema,
  PersonalTabGroupUpdateResultSchema,
  PersonalTabsCloseResultSchema,
  BrowserTabOpenResultSchema,
  ComputerViewOpenResultSchema,
  ComputerViewCloseResultSchema,
  ComputerViewRenewResultSchema,
  BrowserTabCloseResultSchema,
  z.object({ type: z.literal("attachment.upload.create"), attachment: AttachmentSchema }),
  z.object({ type: z.literal("attachment.upload.discard") }),

  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.create"),
    folder: z.object(TaskFolderSchema.shape).optional(),
    wasDuplicate: z.boolean(),
  }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.rename"),
  }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.icon.set"),
  }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.inputQueue.resume"),
  }),
  z.object({ input: ThreadInputViewSchema, type: z.literal("thread.input.cancel") }),
  z.object({ type: z.literal("thread.input.move") }),
  z.object({ input: ThreadInputViewSchema, type: z.literal("thread.input.steer") }),
  z.object({
    input: ThreadInputViewSchema,
    message: MessageViewSchema,
    run: RunViewSchema.nullable(),
    type: z.literal("thread.sendMessage"),
    wasDuplicate: z.boolean(),
  }),
  z.object({
    assignment: AssignmentSummarySchema,
    type: z.literal("assignment.cancel"),
    wasDuplicate: z.boolean(),
  }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.execution.update"),
  }),
  z.object({ type: z.literal("thread.read.mark"), state: ThreadReadStateSchema }),
  z.object({ type: z.literal("thread.done.set"), state: ThreadReadStateSchema }),

  z.object({
    type: z.literal("notification.preview.register"),
    installationId: NotificationInstallationIdSchema,
    keyId: NotificationPreviewKeyIdSchema,
    registered: z.literal(true),
  }),
  z.object({ timeZone: TimeZoneSchema, type: z.literal("viewer.timeZone.update") }),
  z.object({ quietTaskDays: QuietTaskDaysSchema, type: z.literal("viewer.quietTasks.update") }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.access.update"),
  }),
  z.object({
    preferences: ExecutionPreferencesViewSchema,
    type: z.literal("execution.preferences.remember"),
  }),
  z.object({ type: z.literal("automaticModels.set"), config: AutomaticModelConfigViewSchema }),
  z.object({ type: z.literal("run.interrupt"), wasDuplicate: z.boolean() }),
  z.object({ type: z.literal("node.stop"), wasDuplicate: z.boolean() }),
  z.object({ type: z.literal("request.respond") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.create") }),
  z.object({ installation: HarnessInstallationSchema, type: z.literal("harness.update") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.rename") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.model.configure") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.enabled.set") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.default.set") }),
  z.object({ type: z.literal("harness.delete") }),
  harnessAuthenticationEnvelopeSchema.extend({ type: z.literal("harness.authentication.begin") }),
  harnessAuthenticationEnvelopeSchema.extend({ type: z.literal("harness.authentication.submit") }),
  harnessAuthenticationEnvelopeSchema.extend({ type: z.literal("harness.authentication.logout") }),
  harnessAuthenticationEnvelopeSchema.extend({ type: z.literal("harness.authentication.cancel") }),
  z.object({ type: z.literal("machine.revoke") }),
  z.object({ type: z.literal("machine.rename") }),
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("updated"),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      type: z.literal("machine.access.update"),
    }),
    z.object({ outcome: z.literal("conflict"), type: z.literal("machine.access.update") }),
  ]),
  z.object({ ended: z.boolean(), type: z.literal("machine.access.session.stop") }),
  z.object({
    type: z.literal("personal.remoteAccess.request"),
    operation: PersonalRemoteAdministrationOperationSchema,
  }),
  z.object({
    type: z.literal("personal.remoteAccess.pairing.create"),
    pairing: z.object(IssuePersonalPairingCodeResponseSchema.shape),
  }),
  z.object({
    type: z.literal("personal.accountLink.approve"),
    proof: ApprovePersonalHostAccountLinkResponseSchema,
  }),
  z.object({
    type: z.literal("personal.accountLink.complete"),
    access: PersonalRemoteAccessStatusSchema,
  }),
  z.object({ type: z.literal("connection.revoke") }),
  z.object({
    type: z.literal("connection.authorize"),
    completionPath: z.string().startsWith("/oauth/mcp/complete?"),
  }),
  z.object({ type: z.literal("session.revoke") }),
  z.object({
    enrollmentId: z.string().min(1).max(256),
    expiresAt: z.iso.datetime({ offset: true }),
    token: z.string().min(32).max(4_096),
    type: z.literal("runner.enrollment.createLocal"),
  }),

  z.object({
    enrollmentId: z.string().min(1).max(256),
    expiresAt: z.iso.datetime({ offset: true }),
    pairing: AgentPhoneHostTargetViewSchema,
    token: z.string().min(32).max(4_096),
    type: z.literal("runner.enrollment.createPhone"),
  }),
  z.object({
    /**
     * Why no Runner can redeem it now: `retired` by this command, already
     * `consumed` by a Runner, or `expired` — run out, or retired before.
     */
    state: z.enum(["consumed", "expired", "retired"]),
    type: z.literal("runner.enrollment.retire"),
  }),
  IntegrationAuthorizationStartViewSchema.extend({
    type: z.literal("integration.mcp.authorization.begin"),
  }),
  z.object({
    connection: IntegrationConnectionSummaryViewSchema.nullable(),
    type: z.literal("integration.computer.setup.set"),
  }),
  z.object({
    request: ComputerAppSetupRequestViewSchema,
    type: z.literal("integration.computer.setup.request"),
  }),
  z.object({ type: z.literal("integration.computer.setup.cancel") }),
  z.object({
    type: z.literal("integration.computer.setup.respond"),
  }),
  z.object({ type: z.literal("integration.server.secrets.set") }),
  z.object({ type: z.literal("integration.computer.policy.set"), appApproval: z.literal("ask") }),
  z.object({ type: z.literal("integration.computer.app.block") }),
  IntegrationAuthorizationStatusViewSchema.extend({
    type: z.literal("integration.authorization.cancel"),
  }),
  IntegrationAuthorizationStatusViewSchema.extend({
    type: z.literal("integration.authorization.return"),
  }),
  z.object({ type: z.literal("integration.mcp.disconnect") }),
  z.object({ type: z.literal("plugin.update") }),
  z.object({ type: z.literal("plugin.remove") }),
  z.object({ type: z.literal("specialist.add"), specialist: SpecialistRegistrationViewSchema }),
  z.object({ type: z.literal("specialist.remove") }),
  z.object({
    type: z.literal("specialist.list"),
    specialists: z.array(SpecialistRegistrationViewSchema),
  }),
  z.object({ type: z.literal("plugin.activation.set") }),
  z.object({ type: z.literal("plugin.list"), plugins: z.array(z.record(z.string(), z.unknown())) }),
  z.object({
    issues: z
      .array(
        z.object({
          component: z.enum(["manifest", "mcp", "skill"]),
          entry: z.string().nullable(),
          message: z.string(),
        }),
      )
      .max(1_000),
    type: z.literal("plugin.install"),
  }),
  z.object({
    installation: IntegrationInstallationViewSchema,
    type: z.literal("integration.remoteMcp.install"),
  }),
  z.object({
    installation: IntegrationInstallationViewSchema,
    type: z.literal("integration.catalog.install"),
  }),
  // The counts are the honest part of the answer: a proposed integration's
  // definition exists only in the row being removed, so its accounts go with
  // it, while a catalog definition survives the uninstall and keeps its own.
  z.object({
    cancelledRequests: z.number().int().nonnegative(),
    removedConnections: z.number().int().nonnegative(),
    type: z.literal("integration.uninstall"),
  }),
  z.object({ type: z.literal("integration.grant.revoke") }),
  z.object({
    application: IntegrationProviderApplicationViewSchema,
    type: z.literal("integration.providerApplication.save"),
  }),
  IntegrationAuthorizationStartViewSchema.extend({
    type: z.literal("integration.authorization.begin"),
  }),
  /**
   * The exact account the key connected or reconnected, so a card answers its
   * request with that account and never a look-alike. Older Hosts omit it.
   */
  z.object({
    connectionId: IntegrationConnectionIdSchema.optional(),
    type: z.literal("integration.apiKey.connect"),
  }),
  z.object({ grant: IntegrationGrantViewSchema, type: z.literal("integration.grant.create") }),
  /**
   * Revocation is best effort: the credential is always destroyed locally, and
   * `notice` says so honestly when the provider's copy outlived the disconnect.
   */
  z.object({
    notice: z.string().min(1).max(500).nullable(),
    revokedUpstream: z.boolean(),
    type: z.literal("integration.disconnect"),
  }),
  z.object({
    application: IntegrationProviderApplicationViewSchema,
    type: z.literal("integration.providerApplication.status.set"),
  }),
  z.object({ type: z.literal("integration.applicationSourceDefault.set") }),
  z.object({
    account: ChannelAccountViewSchema,
    binding: ChannelBindingViewSchema,
    connection: IntegrationConnectionViewSchema,
    type: z.literal("channel.connection.create"),
  }),
  z.object({ type: z.literal("channel.connection.credentials.replace") }),
  z.object({
    account: ChannelAccountViewSchema,
    binding: ChannelBindingViewSchema,
    connection: IntegrationConnectionViewSchema,
    type: z.literal("channel.connection.computer.create"),
  }),
  z.object({ binding: ChannelBindingViewSchema, type: z.literal("channel.binding.create") }),
  z.object({ type: z.literal("channel.binding.revoke") }),
  z.object({ binding: ChannelBindingViewSchema, type: z.literal("channel.binding.update") }),
  z.object({ grant: ChannelAccessGrantViewSchema, type: z.literal("channel.access.review") }),
  z.object({
    account: ChannelAccountViewSchema,
    identity: z.object({
      displayName: z.string().min(1).max(160),
      externalUserId: z.string().min(1).max(512),
    }),
    type: z.literal("channel.identity.link"),
  }),
  z.object({ type: z.literal("channel.connection.status.set") }),
  StartHostedBrowserResponseSchema.extend({ type: z.literal("browser.session.start") }),
  CreateBrowserProfileResponseSchema.extend({ type: z.literal("browser.profile.create") }),
  z.object({ type: z.literal("browser.source.pair"), pairing: BrowserSourcePairingSchema }),
  z.object({ type: z.literal("browser.source.rename") }),
  z.object({ type: z.literal("browser.source.revoke") }),
  z.object({ type: z.literal("browser.site.remove") }),
  z.object({ type: z.literal("browser.session.sign-in"), outcome: BrowserSignInOutcomeSchema }),
  /** `outcome` is null after a decline. A pending Request stays pending on any problem. */
  z.object({
    type: z.literal("browser.sign-in.respond"),
    outcome: BrowserSignInOutcomeSchema.nullable(),
  }),
  z.object({
    type: z.literal("browser.password-sign-in.respond"),
    card: PasswordSignInCardViewSchema.optional(),
    message: z.string().max(200).optional(),
    /** How the Request ended. */
    status: z.enum(["declined", "fulfilled", "pending", "withdrawn", "cancelled"]),
  }),

  z.object({ profile: BrowserProfileSchema, type: z.literal("browser.profile.rename") }),
  z.object({
    type: z.literal("browser.profile.delete"),
    deletion: BrowserProfileDeletionSchema.optional().catch(undefined),
  }),
  z.object({ type: z.literal("app.tab.open"), appTabs: AppTabsSchema }),
  z.object({ type: z.literal("app.tab.close"), appTabs: AppTabsSchema }),
  z.object({ type: z.literal("phone.tab.close") }),
  z.object({ type: z.literal("browser.session.close") }),
  z.object({ type: z.literal("browser.history.remove") }),
  z.object({ type: z.literal("browser.history.clear") }),
  z.object({
    revision: TriggerRevisionViewSchema,
    trigger: TriggerViewSchema,
    type: z.literal("trigger.create"),
    wasDuplicate: z.boolean(),
    webhook: z.object({ secret: z.string().min(1), url: z.url() }).optional(),
  }),
  z.object({
    revision: TriggerRevisionViewSchema,
    trigger: TriggerViewSchema,
    type: z.literal("trigger.update"),
  }),
  z.object({ trigger: TriggerViewSchema, type: z.literal("trigger.status.set") }),
  z.object({ occurrence: TriggerOccurrenceViewSchema, type: z.literal("trigger.run") }),
  z.object({
    canceledOccurrenceIds: z.array(z.string().min(1)).max(100),
    type: z.literal("trigger.cancel"),
  }),
]);

const declaration = <Payload extends z.ZodType, Success extends z.ZodType>(
  method: "GET" | "POST",
  payload: Payload,
  success: Success,
  stream?: true,
) => ({ error: HostApiErrorSchema, method, payload, success, ...(stream ? { stream } : {}) });

export const hostApi = defineRpc({
  "folder.files.list": declaration(
    "POST",
    z.strictObject({
      folder: TaskFolderSchema,
      parentKey: FolderFileKeySchema,
      cursor: FolderFileCursorSchema.optional(),
      knownRevision: FolderFileRevisionSchema.optional(),
    }),
    FolderDirectoryPageViewSchema,
  ),
  "folder.files.preview": declaration(
    "POST",
    z.strictObject({ folder: TaskFolderSchema, fileKey: FolderFileKeySchema }),
    z.object({
      metadata: FolderFilePreviewMetadataViewSchema,
      content: z.string().max(512 * 1024),
    }),
  ),
  "needsYou.get": declaration(
    "POST",
    z.strictObject({
      before: z.string().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    NeedsYouPageSchema,
  ),
  "team.bootstrap.get": declaration(
    "POST",
    teamReadSchemas["team.bootstrap.get"].input,
    teamReadViews["team.bootstrap.get"],
  ),
  "team.sidebar.get": declaration(
    "POST",
    teamReadSchemas["team.sidebar.get"].input,
    teamReadViews["team.sidebar.get"],
  ),
  "team.channels.list": declaration(
    "POST",
    teamReadSchemas["team.channels.list"].input,
    teamReadViews["team.channels.list"],
  ),
  "team.channel.get": declaration(
    "POST",
    teamReadSchemas["team.channel.get"].input,
    teamReadViews["team.channel.get"],
  ),
  "team.channel.access.get": declaration(
    "POST",
    teamReadSchemas["team.channel.access.get"].input,
    teamReadViews["team.channel.access.get"],
  ),
  "team.channel.instructions.get": declaration(
    "POST",
    teamReadSchemas["team.channel.instructions.get"].input,
    teamReadViews["team.channel.instructions.get"],
  ),
  "team.messages.page": declaration(
    "POST",
    teamReadSchemas["team.messages.page"].input,
    teamReadViews["team.messages.page"],
  ),
  "team.thread.page": declaration(
    "POST",
    teamReadSchemas["team.thread.page"].input,
    teamReadViews["team.thread.page"],
  ),
  "team.message.get": declaration(
    "POST",
    teamReadSchemas["team.message.get"].input,
    teamReadViews["team.message.get"],
  ),
  "team.messages.check": declaration(
    "POST",
    teamReadSchemas["team.messages.check"].input,
    teamReadViews["team.messages.check"],
  ),
  "team.search": declaration(
    "POST",
    teamReadSchemas["team.search"].input,
    teamReadViews["team.search"],
  ),
  "team.members.list": declaration(
    "POST",
    teamReadSchemas["team.members.list"].input,
    teamReadViews["team.members.list"],
  ),
  "team.groups.list": declaration(
    "POST",
    teamReadSchemas["team.groups.list"].input,
    teamReadViews["team.groups.list"],
  ),
  "team.group.get": declaration(
    "POST",
    teamReadSchemas["team.group.get"].input,
    teamReadViews["team.group.get"],
  ),
  "team.invites.list": declaration(
    "POST",
    teamReadSchemas["team.invites.list"].input,
    teamReadViews["team.invites.list"],
  ),
  "team.audit.page": declaration(
    "POST",
    teamReadSchemas["team.audit.page"].input,
    teamReadViews["team.audit.page"],
  ),
  "team.notices.page": declaration(
    "POST",
    teamReadSchemas["team.notices.page"].input,
    teamReadViews["team.notices.page"],
  ),
  "team.knowledge.topics.list": declaration(
    "POST",
    teamReadSchemas["team.knowledge.topics.list"].input,
    teamReadViews["team.knowledge.topics.list"],
  ),
  "team.knowledge.topic.get": declaration(
    "POST",
    teamReadSchemas["team.knowledge.topic.get"].input,
    teamReadViews["team.knowledge.topic.get"],
  ),
  "team.knowledge.topic.access.get": declaration(
    "POST",
    teamReadSchemas["team.knowledge.topic.access.get"].input,
    teamReadViews["team.knowledge.topic.access.get"],
  ),
  "team.agent.requests.get": declaration(
    "POST",
    teamReadSchemas["team.agent.requests.get"].input,
    teamReadViews["team.agent.requests.get"],
  ),
  "team.links.list": declaration(
    "POST",
    teamReadSchemas["team.links.list"].input,
    teamReadViews["team.links.list"],
  ),
  "teams.links.list": declaration(
    "POST",
    teamReadSchemas["teams.links.list"].input,
    teamReadViews["teams.links.list"],
  ),
  "teams.channelFolder.get": declaration(
    "POST",
    teamReadSchemas["teams.channelFolder.get"].input,
    teamReadViews["teams.channelFolder.get"],
  ),
  "teams.threadTask.get": declaration(
    "POST",
    teamReadSchemas["teams.threadTask.get"].input,
    teamReadViews["teams.threadTask.get"],
  ),
  "team.mentions.page": declaration(
    "POST",
    teamReadSchemas["team.mentions.page"].input,
    teamReadViews["team.mentions.page"],
  ),
  "team.pins.page": declaration(
    "POST",
    teamReadSchemas["team.pins.page"].input,
    teamReadViews["team.pins.page"],
  ),
  "team.files.page": declaration(
    "POST",
    teamReadSchemas["team.files.page"].input,
    teamReadViews["team.files.page"],
  ),
  "team.knowledge.facts.page": declaration(
    "POST",
    teamReadSchemas["team.knowledge.facts.page"].input,
    teamReadViews["team.knowledge.facts.page"],
  ),
  "team.knowledge.history.page": declaration(
    "POST",
    teamReadSchemas["team.knowledge.history.page"].input,
    teamReadViews["team.knowledge.history.page"],
  ),

  "browser.searchSuggestions.get": declaration(
    "GET",
    z.strictObject({ query: z.string().trim().min(1).max(200) }),
    z.array(z.string().min(1).max(200)).max(8),
  ),
  "browser.contextCandidate.get": declaration(
    "GET",
    BrowserContextCandidateInputSchema,
    BrowserContextCandidateSchema,
  ),
  "browser.tabIcon.get": declaration("GET", BrowserTabIconInputSchema, BrowserTabIconResultSchema),
  "browser.history.get": declaration("GET", BrowserHistoryInputSchema, BrowserHistorySchema),
  "browser.history.icons.get": declaration(
    "GET",
    BrowserHistoryIconsInputSchema,
    BrowserHistoryIconsSchema,
  ),
  /**
   * Where an Android phone reaches this Deployment now, as the Host itself
   * knows it — the target `runner.enrollment.createPhone` pairs with, read
   * without minting anything. Setup compares it with the address an enrolled
   * phone holds and moves the phone when the route changed. A Personal
   * Deployment with remote access off refuses with reason
   * `personal-remote-access-off`.
   */
  "agentPhone.target.get": declaration("GET", emptyInputSchema, AgentPhoneHostTargetViewSchema),
  "apps.get": declaration("GET", z.strictObject({ appId: AppIdSchema }), AppSchema),
  "apps.view": declaration(
    "POST",
    z.strictObject({ appId: AppIdSchema, theme: z.enum(["light", "dark"]) }),
    z.object({
      app: AppSchema,
      path: z.string().regex(/^\/v1\/apps\/app_[0-9a-f-]{36}\/(light|dark)\/[A-Za-z0-9_-]{43}\/$/u),
      /** One-use address on the app's own origin; absent on routes without one. */
      entryUrl: z.url().max(512).optional(),
    }),
  ),
  "attachment.get": declaration("GET", AttachmentReferenceInputSchema, AttachmentSchema),
  "attachment.upload": {
    ...declaration("POST", AttachmentReferenceInputSchema, AttachmentSchema),
    binaryRequest: true,
  },
  "attachment.content": declaration(
    "GET",
    AttachmentReferenceInputSchema,
    AttachmentContentSchema,
    true,
  ),
  "browser.password-sign-in.get": declaration(
    "POST",
    z.strictObject({ requestId: RequestIdSchema }),
    PasswordSignInCardViewSchema,
  ),
  "browser.sources.get": declaration("GET", emptyInputSchema, BrowserSourcesStateSchema),
  "browser.sources.inspect": declaration(
    "POST",
    z.strictObject({ url: z.string().min(1).max(2_048) }),
    BrowserSourceInspectionSchema,
  ),
  "auth.config": declaration("GET", emptyInputSchema, IdentityConfigViewSchema),

  "auth.native.complete": declaration(
    "POST",
    z.strictObject({ accept: z.boolean(), oauthQuery: oauthQuerySchema }),
    z.object({ url: z.url() }),
  ),
  "auth.oidc.begin": declaration(
    "POST",
    z.strictObject({
      oauthQuery: oauthQuerySchema.optional(),
      providerId: oidcProviderIdSchema,
      returnPath: oidcReturnPathSchema,
    }),
    z.object({ redirectUrl: z.url() }),
  ),
  "auth.password.recover": declaration(
    "POST",
    z.strictObject({
      newPassword: IdentityPasswordSchema,
      token: LocalPasswordRecoveryTokenSchema,
    }),
    emptyOutputSchema,
  ),
  "auth.password.signIn": declaration(
    "POST",
    z.strictObject({
      email: emailSchema,
      oauthQuery: oauthQuerySchema.optional(),
      password: submittedPasswordSchema,
    }),
    z.object({ redirectUrl: z.url().nullable(), session: AuthenticatedSessionViewSchema }),
  ),
  "auth.password.signUp": declaration(
    "POST",
    z.strictObject({ email: emailSchema, password: IdentityPasswordSchema }),
    z.object({ session: AuthenticatedSessionViewSchema }),
  ),
  "auth.setup.claim": declaration(
    "POST",
    z.discriminatedUnion("kind", [
      z.strictObject({
        email: emailSchema,
        kind: z.literal("password"),
        password: submittedPasswordSchema,
      }),
      z.strictObject({
        kind: z.literal("local-machine-owner"),
        token: z.string().trim().min(16).max(4_096),
      }),
    ]),
    z.object({ session: AuthenticatedSessionViewSchema }),
  ),
  "auth.setup.exchange": declaration(
    "POST",
    z.strictObject({ token: z.string().trim().min(16).max(4_096) }),
    emptyOutputSchema,
  ),
  "auth.signOut": declaration("POST", emptyInputSchema, emptyOutputSchema),
  "bootstrap.get": declaration("GET", emptyInputSchema, HostBootstrapSchema),
  "channel.connection.check": declaration(
    "POST",
    z.strictObject({ connectionId: IntegrationConnectionIdSchema }),
    ChannelConnectionInspectionViewSchema,
  ),
  "channels.get": declaration("GET", emptyInputSchema, ChannelDashboardViewSchema),
  "connections.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({ connections: z.array(AgentConnectionSchema) }),
  ),
  "connections.authorization.get": declaration(
    "GET",
    z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
    AgentConnectionConsentSchema,
  ),
  "personal.remoteAccess.get": declaration(
    "GET",
    emptyInputSchema,
    PersonalRemoteAdministrationStatusSchema,
  ),
  "plugins.overview.get": declaration("GET", z.strictObject({}), PluginsOverviewViewSchema),
  "plugins.detail.get": declaration(
    "GET",
    z.strictObject({ target: PluginTargetSchema }),
    PluginDetailViewSchema,
  ),
  "plugins.directory.get": declaration("GET", z.strictObject({}), PluginsDirectoryViewSchema),
  "devices.overview.get": declaration("GET", z.strictObject({}), DevicesOverviewViewSchema),
  "commands.dispatch": declaration("POST", commandInputSchema, commandOutputSchema),
  "assignment.get": declaration(
    "GET",
    z.strictObject({ assignmentId: AssignmentIdSchema }),
    AssignmentViewSchema,
  ),
  "harness.authentication.get": declaration(
    "GET",
    z.strictObject({
      environmentId: EnvironmentIdSchema,
      harnessInstanceId: HarnessInstanceIdSchema,
    }),
    harnessAuthenticationEnvelopeSchema,
  ),
  /** Requires automatic-models-v1; automaticModels.set is a person-only commands.dispatch mutation. */
  "automaticModels.get": declaration("GET", z.strictObject({}), AutomaticModelsViewSchema),
  "harness.catalog.refresh": declaration(
    "POST",
    z.strictObject({
      environmentId: EnvironmentIdSchema,
      harnessInstanceId: HarnessInstanceIdSchema,
    }),
    emptyOutputSchema,
  ),
  /**
   * The model servers on a work location's computer, found from each server
   * app's own settings; with `address`, what the server there is.
   */
  "harness.modelServers.discover": declaration(
    "POST",
    z.strictObject({
      address: z.string().trim().min(1).max(2_048).optional(),
      environmentId: EnvironmentIdSchema,
    }),
    z.object({ servers: z.array(ModelServerViewSchema).max(maxModelServers) }),
  ),
  /**
   * A voice call on one of the person's ChatGPT accounts on that computer,
   * as one Run on the person's Voice Thread. The client's offer
   * goes to the Runner, which creates the call; audio then flows between the
   * client and the vendor only. Starting again with the same session id
   * returns the same call; a new session ends the person's other call.
   * Requires `voice-run-v1`; errors carry a `VoiceRefusalReason`.
   */
  "voice.start": declaration("POST", VoiceStartInputSchema, VoiceStartResultSchema),
  /** Creates the person's Voice Thread if needed, so it can be opened and set up before a call. */
  "voice.open": declaration("POST", VoiceOpenInputSchema, VoiceOpenResultSchema),
  /** Keeps a call alive for another lease, rechecking the person may still use it. */
  "voice.renew": declaration("POST", VoiceRenewInputSchema, VoiceEmptyResultSchema),
  /** Has the voice tell the person something once, such as a task needing them. */
  "voice.say": declaration("POST", VoiceSayInputSchema, VoiceEmptyResultSchema),
  /** Ends a call by stopping its Run. Ending one that is already over succeeds. */
  "voice.stop": declaration("POST", VoiceStopInputSchema, VoiceEmptyResultSchema),
  /** Replaces what the call's agent knows the person is looking at. */
  "voice.context": declaration("POST", VoiceContextInputSchema, VoiceEmptyResultSchema),
  "integration.authorization.get": declaration(
    "GET",
    z.strictObject({ attemptId: IntegrationAuthorizationAttemptIdSchema }),
    IntegrationAuthorizationStatusViewSchema,
  ),
  "integration.grants.list": declaration(
    "GET",
    z.strictObject({}),
    z.object({ grants: z.array(IntegrationGrantViewSchema).max(1_000) }),
  ),
  "integration.computer.policy.get": declaration(
    "GET",
    z.strictObject({ runnerId: RunnerIdSchema }),
    z.object({ appApproval: ComputerUseAppApprovalSchema }),
  ),
  "integration.computer.setup.review": declaration(
    "POST",
    z.strictObject({ setupRequestId: z.uuid() }),
    z.object({
      request: ComputerAppSetupReviewRequestViewSchema,
      app: z
        .object({ ...ComputerUseResolvedAppSchema.shape, identity: ComputerAppIdentityViewSchema })
        .nullable(),
      /** Which of a server's secrets already have a value, which allowing can keep. */
      savedSecrets: z.array(LocalMcpSecretNameSchema).max(localMcpMaxSecrets).optional(),
    }),
  ),
  "integration.computer.setup.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({ requests: z.array(ComputerAppSetupRequestViewSchema).max(1_000) }),
  ),
  /** Plugin servers on the caller's computers whose secrets the caller may change; never values. */
  "integration.server.secrets.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({
      servers: z
        .array(
          z.object({
            computer: z.string().nullable(),
            installationId: IntegrationInstallationIdSchema,
            id: IntegrationServerIdSchema,
            name: z.string(),
            plugin: z.string(),
            secrets: z.array(LocalMcpSecretViewSchema).max(localMcpMaxSecrets),
          }),
        )
        .max(1_000),
    }),
  ),
  /**
   * The picker's list, asked of the Mac itself.
   *
   * It is a read of a live computer rather than of this Host's tables: only
   * that Mac knows what is installed on it, and only its owner may ask. A Mac
   * that is asleep answers the standard offline sentence as an rpc error.
   */
  /**
   * Stop a live session from any client, which is the person saying so from
   * somewhere other than the Mac's own pill. Only that Mac's owner may.
   */
  "integration.computer.session.stop": declaration(
    "POST",
    z.strictObject({ sessionId: ComputerUseSessionIdSchema }),
    emptyOutputSchema,
  ),
  "computer.app.windows": declaration(
    "POST",
    z.strictObject({ machineId: RunnerIdSchema, app: ComputerAppIdentitySchema }),
    z.object({
      windows: z.array(z.object(OwnerWindowInfoSchema.shape)).max(computerUseMaxWindows),
    }),
  ),
  "integration.computer.apps.approved": declaration(
    "GET",
    emptyInputSchema,
    z.object({ apps: z.array(ApprovedComputerAppSchema).max(500) }),
  ),
  "integration.computer.apps.installed": declaration(
    "POST",
    ComputerUseInstalledAppsParamsSchema.extend({ runnerId: RunnerIdSchema }),
    z.object({
      apps: z.array(ComputerUseInstalledAppViewSchema).max(computerUseMaxInstalledApps),
      total: z.number().int().nonnegative(),
      unavailableReason: z.enum(["offline", "not-ready"]).optional(),
    }),
  ),
  "specialist.list": declaration(
    "GET",
    z.strictObject({}),
    z.object({ specialists: z.array(SpecialistRegistrationViewSchema) }),
  ),

  "plugin.list": declaration(
    "GET",
    z.strictObject({}),
    z.object({ plugins: z.array(z.record(z.string(), z.unknown())) }),
  ),
  "integration.platform.get": declaration(
    "GET",
    emptyInputSchema,
    IntegrationPlatformDashboardViewSchema,
  ),
  "integration.repositoryAccess.check": declaration(
    "POST",
    z.strictObject({ connectionId: IntegrationConnectionIdSchema }),
    IntegrationRepositoryAccessViewSchema,
  ),
  "integrations.get": declaration("GET", emptyInputSchema, IntegrationDashboardViewSchema),
  "machines.list": declaration(
    "GET",
    emptyInputSchema,
    // Four registry projections feed one list, each read a page of 100 deep: the bound
    // has to admit all of them or a busy Deployment fails its own response.
    z.object({ machines: z.array(MachineSummarySchema).max(400) }),
  ),
  "machine.access.history": declaration(
    "GET",
    z.strictObject({
      before: ShellHistoryCursorSchema.optional(),
      limit: z.number().int().min(1).max(machineAccessHistoryMaxSessions),
      runnerId: RunnerIdSchema,
    }),
    z.object({
      nextCursor: ShellHistoryCursorSchema.nullable(),
      sessions: z.array(ShellSessionHistoryEntrySchema).max(machineAccessHistoryMaxSessions),
    }),
  ),

  "requests.list": declaration(
    "GET",
    durablePageInputSchema,
    z.object({
      requests: readableRequestList(WaitingRequestViewSchema, 100),
      window: DurableWindowSchema,
    }),
  ),

  "tasks.list": declaration(
    "GET",
    z
      .strictObject({
        active: z.boolean().optional(),
        done: z.boolean().optional(),
      })
      .extend(durablePageInputSchema.shape)
      .refine((input) => !(input.active && input.done), "Active work is never Done"),
    TaskPageSchema,
  ),
  /**
   * The Run's executions and the subagents they started, oldest first: the
   * newest hundred attempts and two hundred subagents of a Run with more.
   */
  "run.attempts.list": declaration(
    "GET",
    z.strictObject({ runId: RunIdSchema }),
    z.object({
      attempts: z.array(RunAttemptViewSchema).max(100),
      nodes: z.array(ExecutionNodeViewSchema).max(200),
      runId: RunIdSchema,
    }),
  ),
  "sessions.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({ sessions: z.array(AuthSessionSummaryViewSchema).max(100) }),
  ),
  "tool.output.get": declaration(
    "GET",
    z.strictObject({
      threadId: ThreadIdSchema,
      runId: RunIdSchema,
      callId: z.string().min(1),
      nodeId: ExecutionNodeIdSchema.optional(),
    }),
    z.object({ output: ToolOutputViewSchema }),
  ),
  "thread.events.list": declaration(
    "GET",
    z
      .strictObject({
        threadId: ThreadIdSchema,
        aroundMessageId: MessageIdSchema.optional(),
        placeEvents: z.literal("include").optional(),
        toolOutputs: z.literal("preview").optional(),
        /** Whole turns, newest first, up to this many. Needs `history-turns-v1`. */
        turns: z.number().int().positive().max(turnPageMaxTurns).optional(),
      })
      .extend(durablePageInputSchema.shape)
      .refine(
        (input) => !input.aroundMessageId || !input.before,
        "An anchored read cannot also page",
      )
      .refine(
        (input) => input.turns === undefined || (!input.aroundMessageId && !input.limit),
        "A turn page sets its own size",
      ),
    ThreadEventPageSchema,
  ),
  /**
   * One subagent's own events through `through`, the sequence its watch
   * began after. Needs `node-detail-v1`.
   */
  "node.events.list": declaration(
    "GET",
    z
      .strictObject({
        nodeId: ExecutionNodeIdSchema,
        threadId: ThreadIdSchema,
        toolOutputs: z.literal("preview").optional(),
        through: SequenceSchema.optional(),
      })
      .extend(durablePageInputSchema.shape),
    NodeEventPageSchema,
  ),
  "thread.assignments.list": declaration(
    "GET",
    z
      .strictObject({
        /** Only work still under way, however far back it was handed out. Needs `task-family-v1`. */
        open: z.boolean().optional(),
        threadId: ThreadIdSchema,
      })
      .extend(durablePageInputSchema.shape),
    z.object({
      assignments: z.array(AssignmentSummarySchema).max(100),
      threadId: ThreadIdSchema,
      window: DurableWindowSchema,
    }),
  ),
  "thread.browserUsage.get": declaration(
    "POST",
    z.strictObject({
      threadId: ThreadIdSchema,
      runIds: z.array(RunIdSchema).max(browserUsageRunBatchSize),
    }),
    ThreadBrowserUsageSchema,
  ),
  "thread.inputQueue.get": declaration(
    "GET",
    z.strictObject({ threadId: ThreadIdSchema }),
    ThreadInputQueueViewSchema,
  ),
  /**
   * What each of the Thread's active Runs is streaming right now, as `replace`
   * items. A reader that opened the Thread mid-turn, or saw a gap in a stream,
   * reads this to draw the whole stream instead of the part it happened to see.
   */
  "thread.live.get": declaration(
    "GET",
    z.strictObject({ threadId: ThreadIdSchema }),
    z.object({
      runs: z
        .array(z.object({ afterSequence: SequenceSchema, progress: LiveRunProgressViewSchema }))
        .max(64),
      threadId: ThreadIdSchema,
    }),
  ),
  "thread.messages.list": declaration(
    "POST",
    z
      .strictObject({
        threadId: ThreadIdSchema,
        before: z.string().min(1).max(2048).optional(),
        query: z.string().trim().min(1).max(256).optional(),
        aroundMessageId: MessageIdSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .refine(
        (input) => !input.aroundMessageId || (!input.before && !input.query),
        "An anchored read cannot also search or page",
      ),
    ThreadMessagePageSchema,
  ),
  "thread.readState.get": declaration(
    "GET",
    z.strictObject({ threadId: ThreadIdSchema }),
    ThreadReadStateSchema,
  ),
  "thread.requests.list": declaration(
    "GET",
    z.strictObject({ threadId: ThreadIdSchema }).extend(durablePageInputSchema.shape),
    z.object({
      requests: readableRequestList(RequestViewSchema, 100),
      threadId: ThreadIdSchema,
      window: DurableWindowSchema,
    }),
  ),
  "triggers.get": declaration(
    "GET",
    z.strictObject({ triggerId: TriggerIdSchema }),
    z.object({
      downstreamRuns: z
        .array(
          z.object({
            occurrenceId: TriggerOccurrenceIdSchema,
            run: RunViewSchema,
            threadTitle: ThreadViewSchema.shape.title,
          }),
        )
        .max(100),
      downstreamRunsTruncated: z.boolean(),
      activation: TriggerWatchActivationViewSchema.nullable(),
      anchorThread: ThreadViewSchema.nullable().optional(),
      anchorThreadTitle: ThreadViewSchema.shape.title,
      createdByThreadTitle: ThreadViewSchema.shape.title.nullable().default(null),
      occurrences: z.array(TriggerOccurrenceViewSchema).max(100),
      revision: TriggerRevisionViewSchema,
      trigger: TriggerViewSchema,
    }),
  ),
  "triggers.list": declaration(
    "GET",
    z.strictObject({
      systemRole: z.enum(["memory-light", "memory-nightly"]).optional(),

      /** Only those that run in this conversation. Needs `task-family-v1`. */
      anchorThreadId: ThreadIdSchema.optional(),
    }),
    z.object({ triggers: z.array(TriggerSummaryViewSchema).max(100) }),
  ),
} as const);

export type HostApiCommand = z.output<typeof commandInputSchema>;
export type HostApiCommandInput = z.input<typeof commandInputSchema>;
export type HostApiCommandOutput = z.output<typeof commandOutputSchema>;
export type HostApiClient = RpcClient<typeof hostApi>;

export interface HostApiServerContext {
  readonly binaryBody?: AsyncIterable<Uint8Array>;
  readonly afterResponse?: (effect: () => void) => void;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly requestId: string;
  readonly requestUrl: string;
  readonly session: AuthenticatedSession | null;
  readonly setHeader: (name: string, value: string | readonly string[]) => void;
  readonly signal: AbortSignal;
  readonly surface: "canonical" | "personal-remote" | null;
}

export type HostApiHandlers = RpcHandlers<typeof hostApi, HostApiServerContext>;

export type HostApiScope = "exact-origin" | "mutation" | "public" | "session";
