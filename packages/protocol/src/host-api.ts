import { PersonalInputQueueViewSchema } from "./personal-input-queue.js";
import {
  PersonalDetailSnapshotSchema,
  PersonalRequestSummarySchema,
  PersonalNetworkShellSnapshotSchema,
} from "./personal-sync.js";
import {
  PersonalResourceDetailSchema,
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
} from "./resources.js";
import {
  TranscriptItemIdSchema,
  TranscriptItemResultSchema,
  TranscriptItemSchema,
  TranscriptOrderCursorSchema,
  TranscriptPageResultSchema,
} from "./transcript.js";
import {
  pluginOAuthCommands,
  pluginOAuthOutputs,
  PluginOAuthMethodsSchema,
  PluginOAuthStatusSchema,
} from "./plugin-oauth.js";
import { ChannelConnectionInspectionViewSchema } from "@opensteer/channel-core";
import {
  AgentGrantSchema,
  AgentOperationViewSchema,
  AgentSessionIdSchema,
  DeviceIdSchema,
  DeviceDriverGenerationSchema,
  TabIdSchema,
} from "@opensteer/core";
import { MachineListSummarySchema } from "./machines.js";
import { OwnerWindowInfoSchema } from "./computer-use.js";
import {
  TabCommandSchema,
  TabCommandResultSchema,
  TabGetInputSchema,
  TabBootstrapSchema,
} from "./tabs.js";
import {
  AppViewSchema,
  AppCommandSchema,
  AppCommandResultSchema,
  AppsListInputSchema,
  AppsListResultSchema,
} from "./apps.js";
import { MessageOriginSchema, TabViewSchema } from "@opensteer/core";
import {
  TranscriptFileOpenInputSchema,
  TranscriptFileOpenSchema,
  TranscriptFileContentInputSchema,
  TranscriptFileContentSchema,
} from "./transcript-files.js";
import { TeamCommandResultViewSchema, teamReadViews } from "./team-views.js";
import { NeedsYouPageSchema } from "./needs-you.js";
import {
  CompactionSendChoiceSchema,
  IdleCompactionPolicySchema,
  IdleCompactionPolicyViewSchema,
} from "@opensteer/core";
import { AutomaticModelsViewSchema } from "./automatic-models.js";
import { TeamCommandSchema, teamReadSchemas } from "./team-api.js";
import {
  AgentConnectionSchema,
  AgentConnectionIdSchema,
  AgentConnectionConsentSchema,
} from "./agent-connections.js";
import {
  PluginsOverviewViewSchema,
  DevicesOverviewViewSchema,
  SettingsPluginEnableCommandSchema,
  SettingsPluginEnableResultSchema,
} from "./settings.js";
import { PluginCommandResultSchema, PluginCommandSchema, pluginReads } from "./plugins.js";
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
  ChannelDashboardViewSchema,
  ChannelExecutionPolicySchema,
  ChannelRouteSelectorSchema,
  IntegrationConnectionViewSchema,
} from "@opensteer/channel-core";
import {
  PersonalRemoteAdministrationIntentSchema,
  PersonalRemoteAdministrationOperationSchema,
  PersonalRemoteAdministrationStatusSchema,
  PersonalAccountLinkStatusSchema,
  IssuePersonalPairingCodeResponseSchema,
  ApprovePersonalHostAccountLinkRequestSchema,
  ApprovePersonalHostAccountLinkResponseSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  PersonalRemoteAccessStatusSchema,
} from "./personal-remote-access.js";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
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
  LocalPasswordRecoveryTokenSchema,
  MessageContentSchema,
  MessageEditViewSchema,
  MessageIdSchema,
  MessageRevisionViewSchema,
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
  ThreadInputEditLeaseViewSchema,
  ThreadInputPolicySchema,
  ThreadInputViewSchema,
  ThreadVisitSchema,
  IsoDateTimeSchema,
  ThreadTitleSchema,
  ThreadViewSchema,
  TimeZoneSchema,
  QuietTaskDaysSchema,
  PersonNameSchema,
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
  ComputerAppSetupRequestViewSchema,
  ComputerAppSetupReviewRequestViewSchema,
  ComputerUseAppApprovalSchema,
  CreateIntegrationGrantSchema,
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionSummaryViewSchema,
  IntegrationDashboardViewSchema,
  IntegrationGrantIdSchema,
  IntegrationGrantViewSchema,
  IntegrationInstallationIdSchema,
  IntegrationPlatformDashboardViewSchema,
  IntegrationServerIdSchema,
  LocalMcpSecretNameSchema,
  LocalMcpSecretViewSchema,
  LocalMcpSecretValuesSchema,
  localMcpMaxSecrets,
  RequestComputerAppSetupSchema,
  SetComputerAppConnectionSchema,
  DeviceSetComputerAppConnectionSchema,
  DeviceRequestComputerAppSetupSchema,
  DeviceComputerAppSetupRequestViewSchema,
  DeviceIntegrationConnectionSummaryViewSchema,
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
import { ReferenceResolveInputSchema, ReferenceResolveResultSchema } from "./references.js";
import { AppIdSchema } from "@opensteer/core";
import { AgentPhoneHostTargetViewSchema } from "./android-phone.js";
import { AssetUrlsInputSchema, AssetUrlsSchema } from "./assets.js";
import { AttachmentContentSchema, AttachmentReferenceInputSchema } from "./attachments.js";
import { IdentityConfigViewSchema, OwnerProfileViewSchema } from "./bootstrap.js";
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
  BrowserTabIconInputSchema,
  BrowserTabIconResultSchema,
  CreateBrowserProfileBodySchema,
  CreateBrowserProfileResponseSchema,
  StartHostedBrowserBodySchema,
  StartHostedBrowserResponseSchema,
  ThreadBrowserUsageSchema,
  browserUsageRunBatchSize,
} from "./browser.js";
import {
  DurableWindowCursorSchema,
  DurableWindowSchema,
  TaskPageSchema,
  ThreadMessagePageSchema,
} from "./client.js";
import {
  ComputerAppIdentitySchema,
  ComputerAppIdentityViewSchema,
  ComputerUseInstalledAppSchema,
  ComputerUseInstalledAppsParamsSchema,
  ComputerUseSessionIdSchema,
  computerUseMaxInstalledApps,
  computerUseMaxWindows,
} from "./computer-use.js";
import {
  ApprovedComputerAppSchema,
  ComputerViewCloseCommandSchema,
  ComputerViewCloseResultSchema,
  ComputerViewRenewCommandSchema,
  ComputerViewRenewResultSchema,
} from "./computer-view.js";

import {
  DeviceInitialAccessSchema,
  DevicePreparedIdentitySchema,
  DeviceRefusalContextSchema,
  DeviceSessionBindingProofSchema,
} from "./devices.js";

import { defineRpc, type RpcClient, type RpcDeclaration, type RpcHandlers } from "./rpc.js";
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
/** Client-generated, so a retried take is the same lease. */
const threadInputEditLeaseIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const messageRevisionsPageSize = 20;
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
 * The request headers every rpc caller states its versions in. Phones, Agent
 * Phones, Runners and open windows update apart from their Host, so it serves
 * every caller whose window overlaps its own.
 */
export {
  hostApiCurrentHeader,
  hostApiVersionHeader,
  teamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";

export const HostApiErrorSchema = z.object({
  provenance: z.enum(["transport", "host", "proxy", "protocol", "local"]).optional(),
  machineId: DeviceRefusalContextSchema.shape.machineId.optional(),
  capability: DeviceRefusalContextSchema.shape.capability.optional(),
  code: OpensteerErrorCodeSchema,
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
  retryable: z.boolean(),
});

const durablePageInputSchema = z.strictObject({
  before: DurableWindowCursorSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/**
 * Hosts list every Request kind and ignore this. Older version-64 Hosts hide `device.access`
 * Requests from a read without it, so apps send it on every Request read until
 * `minimumHostApiVersion` passes 64.
 */
export const includeDeviceAccessRequests = { deviceAccessRequests: "include" } as const;
const deviceAccessRequestsInput = { deviceAccessRequests: z.literal("include").optional() };

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

const deviceConnectionViewSchema = DeviceIntegrationConnectionSummaryViewSchema.extend({
  computer: DeviceIntegrationConnectionSummaryViewSchema.shape.computer
    .unwrap()
    .unwrap()
    .extend({ runnerId: RunnerIdSchema.optional() })
    .nullable()
    .default(null),
});

const deviceSetupRequestViewSchema = DeviceComputerAppSetupRequestViewSchema.extend({
  runnerId: RunnerIdSchema.optional(),
});

export const IntegrationDashboardResponseSchema = IntegrationDashboardViewSchema.extend({
  connections: z
    .array(z.union([IntegrationConnectionSummaryViewSchema, deviceConnectionViewSchema]))
    .max(500),
});
export const ComputerAppSetupListResponseSchema = z.object({
  requests: z
    .array(z.union([ComputerAppSetupRequestViewSchema, deviceSetupRequestViewSchema]))
    .max(1_000),
});

export const IphoneScreenAttachCommandSchema = z.strictObject({
  type: z.literal("iphone.screen.attach"),
  idempotencyKey: idempotencyKeySchema,
  driverRunnerId: RunnerIdSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new"), name: z.string().trim().min(1).max(120) }),
    z.strictObject({
      kind: z.literal("existing"),
      deviceId: DeviceIdSchema,
      expectedGeneration: DeviceDriverGenerationSchema,
    }),
  ]),
});
export type IphoneScreenAttachCommand = z.infer<typeof IphoneScreenAttachCommandSchema>;
export const IphoneScreenDetachCommandSchema = z.strictObject({
  type: z.literal("iphone.screen.detach"),
  idempotencyKey: idempotencyKeySchema,
  deviceId: DeviceIdSchema,
  expectedGeneration: DeviceDriverGenerationSchema,
});
export type IphoneScreenDetachCommand = z.infer<typeof IphoneScreenDetachCommandSchema>;
export const IphoneScreenAttachResultSchema = z.object({
  type: z.literal("iphone.screen.attach"),
  deviceId: DeviceIdSchema,
  generation: DeviceDriverGenerationSchema,
});
export type IphoneScreenAttachResult = z.infer<typeof IphoneScreenAttachResultSchema>;
export const IphoneScreenDetachResultSchema = z.object({
  type: z.literal("iphone.screen.detach"),
  deviceId: DeviceIdSchema,
  generation: DeviceDriverGenerationSchema,
});
export type IphoneScreenDetachResult = z.infer<typeof IphoneScreenDetachResultSchema>;
export const DeviceMachineRevokeCommandSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  machineId: z.string().min(1).max(512).pipe(DeviceIdSchema),
  type: z.literal("machine.revoke"),
});
export type DeviceMachineRevokeCommand = z.infer<typeof DeviceMachineRevokeCommandSchema>;
export const DeviceMachineRenameCommandSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  machineId: z.string().min(1).max(512).pipe(DeviceIdSchema),
  name: z.string().trim().min(1).max(120),
  type: z.literal("machine.rename"),
});
export type DeviceMachineRenameCommand = z.infer<typeof DeviceMachineRenameCommandSchema>;
export const DeviceMachineAccessUpdateCommandSchema = z.strictObject({
  type: z.literal("machine.access.update"),
  idempotencyKey: idempotencyKeySchema,
  deviceId: DeviceIdSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  policy: MachineAccessPolicySchema,
  requestReview: z
    .strictObject({ requestId: RequestIdSchema, revision: PersonalRevisionSchema })
    .optional(),
});
export type DeviceMachineAccessUpdateCommand = z.infer<
  typeof DeviceMachineAccessUpdateCommandSchema
>;
export const DeviceMachineSessionBindCommandSchema = z.strictObject({
  type: z.literal("machine.session.bind"),
  idempotencyKey: idempotencyKeySchema,
  machineId: DeviceIdSchema,
  proof: DeviceSessionBindingProofSchema,
});
export type DeviceMachineSessionBindCommand = z.infer<typeof DeviceMachineSessionBindCommandSchema>;

const AgentOperationPageSchema = z.object({
  operations: z.array(AgentOperationViewSchema).max(100),
  nextBefore: z.string().max(200).nullable(),
});
const otherCommandInputSchema = z.discriminatedUnion("type", [
  IphoneScreenAttachCommandSchema,
  IphoneScreenDetachCommandSchema,
  ComputerViewCloseCommandSchema,
  ComputerViewRenewCommandSchema,
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
  z
    .strictObject({
      content: MessageContentSchema,
      delivery: ThreadInputPolicySchema.extract(["queue", "steer"]).optional().default("queue"),
      compaction: CompactionSendChoiceSchema.optional(),
      freshContext: z.boolean().optional(),
      idempotencyKey: idempotencyKeySchema,
      /** Sent only to a Host advertising `message-origin-v1`. */
      origin: MessageOriginSchema.optional(),
      threadId: ThreadIdSchema,
      type: z.literal("thread.sendMessage"),
      quotedMessageId: MessageIdSchema.optional(),
    })
    .refine((command) => !command.freshContext || command.delivery === "queue", {
      message: "freshContext requires queue delivery",
      path: ["freshContext"],
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
  /**
   * Starts editing a waiting message on this device. The client names the
   * lease, so a retry is the same lease. Another device's live lease is a
   * conflict unless `takeOver`.
   */
  z.strictObject({
    leaseId: threadInputEditLeaseIdSchema,
    messageId: MessageIdSchema,
    takeOver: z.boolean(),
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.lease.take"),
  }),
  /** Extends this device's lease while the person types; a replaced lease stays replaced. */
  z.strictObject({
    leaseId: threadInputEditLeaseIdSchema,
    messageId: MessageIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.lease.renew"),
  }),
  /** Ends this device's lease, or with no `leaseId` releases whichever device holds it. */
  z.strictObject({
    leaseId: threadInputEditLeaseIdSchema.optional(),
    messageId: MessageIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.lease.release"),
  }),
  /**
   * Replaces a waiting message's content in place and ends the lease. Accepted
   * when `leaseId` is the live lease or no device holds one, and the message is
   * still at `expectedRevision` (0 when never edited). Non-text parts may only be
   * kept or removed.
   */
  z.strictObject({
    content: MessageContentSchema,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
    leaseId: threadInputEditLeaseIdSchema.optional(),
    messageId: MessageIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.input.edit"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    type: z.literal("thread.inputQueue.resume"),
  }),
  z.strictObject({
    type: z.literal("thread.visit"),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    visitedAt: IsoDateTimeSchema,
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
  // Sent by apps from before `message-origin-v1`; accepted and ignored.
  z.strictObject({
    type: z.literal("viewer.timeZone.update"),
    idempotencyKey: idempotencyKeySchema,
    timeZone: TimeZoneSchema,
  }),
  z.strictObject({
    type: z.literal("settings.idleCompaction.set"),
    idempotencyKey: idempotencyKeySchema,
    policy: IdleCompactionPolicySchema,
  }),
  // How many untouched days move the reader's tasks to Done. Needs `quiet-tasks-v1`.
  z.strictObject({
    type: z.literal("viewer.quietTasks.update"),
    idempotencyKey: idempotencyKeySchema,
    quietTaskDays: QuietTaskDaysSchema,
  }),
  // The personal owner's own name; null shows "You" and is refused while an Account owns it.
  // Sent only to Hosts whose bootstrap carries `ownerProfile`.
  z.strictObject({
    type: z.literal("viewer.name.update"),
    idempotencyKey: idempotencyKeySchema,
    name: PersonNameSchema.nullable(),
    /** `ownerProfile.version` when the person began editing. */
    expectedVersion: OwnerProfileViewSchema.shape.version,
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
    expectedRevision: PersonalRevisionSchema.optional(),
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
  /**
   * Opens a pending browser sign-in that returns to the engine's own computer
   * in that computer's browser, as a tab the person finishes it in.
   */
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("harness.authentication.browse"),
  }),
  DeviceMachineRevokeCommandSchema,
  DeviceMachineRenameCommandSchema,
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    machineId: RunnerIdSchema,
    proof: DeviceSessionBindingProofSchema,
    type: z.literal("machine.session.bind"),
  }),
  z.strictObject({
    /** The revision the editor last read; a stale one conflicts and ends nothing. */
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: idempotencyKeySchema,
    // Omitted fields keep the stored values.
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
  /** Finishes the link this computer already holds, without a fresh challenge. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("personal.accountLink.resume"),
  }),
  /** Ends this Home's Account link here and at the Account, with no Remote access involved. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("personal.accountLink.unlink"),
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
        verificationSnapshot: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        /** Sent by a client with the grant screen; without it the connection may do everything. */
        grant: AgentGrantSchema.optional(),
      }),
    ]),
    type: z.literal("connection.authorize"),
  }),
  /** Changes take effect on the agent's next call; a narrowing stops its live work. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    connectionId: AgentConnectionIdSchema,
    expectedRevision: z.number().int().min(1),
    label: z.string().trim().min(1).max(120).optional(),
    accessMode: ThreadAccessModeSchema.optional(),
    grant: AgentGrantSchema.optional(),
    type: z.literal("connection.update"),
  }),
  /** The person checked what the agent's last uncertain action did. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    connectionId: AgentConnectionIdSchema,
    type: z.literal("connection.uncertain.acknowledge"),
  }),
  /** The person's Stop on a task a connected agent works itself, bound to the session they saw. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    agentSessionId: AgentSessionIdSchema,
    type: z.literal("agent.session.stop"),
  }),
  /** Takes a revoked or expired connection off the list. */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    connectionId: AgentConnectionIdSchema,
    type: z.literal("connection.remove"),
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
    access: DeviceInitialAccessSchema.optional(),
    preparedIdentity: DevicePreparedIdentitySchema.optional(),
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
    access: DeviceInitialAccessSchema.optional(),
    preparedIdentity: DevicePreparedIdentitySchema.optional(),
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
  // Plugin account sign-in.
  ...pluginOAuthCommands(idempotencyKeySchema),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: z.union([SetComputerAppConnectionSchema, DeviceSetComputerAppConnectionSchema]),
    type: z.literal("integration.computer.setup.set"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: z.union([RequestComputerAppSetupSchema, DeviceRequestComputerAppSetupSchema]),
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
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("plugin.remove"),
    pluginId: z.string(),
  }),
  z.strictObject({
    grantId: IntegrationGrantIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.grant.revoke"),
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
    accessPolicy: ChannelAccessPolicySchema,
    credentials: z.record(z.string(), z.string()),
    idempotencyKey: idempotencyKeySchema,
    provider: z.string().min(1),
    routingMode: z.enum(["dedicated", "shared"]),
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
    type: z.literal("channel.connection.computer.create"),
  }),
  z.strictObject({
    accessPolicy: ChannelAccessPolicySchema,
    accountId: ChannelAccountIdSchema,
    executionPolicy: ChannelExecutionPolicySchema,
    idempotencyKey: idempotencyKeySchema,
    selector: ChannelRouteSelectorSchema,
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
    expectedRevision: PersonalRevisionSchema.optional(),
    type: z.literal("browser.sign-in.respond"),
  }),
  /**
   * Answers saved-login consent as its requester from any authenticated client.
   * The Host commits the broker only after the Request's durable settlement.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: RequestIdSchema,
    expectedRevision: PersonalRevisionSchema.optional(),
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

const commandInputSchema = z.union([
  DeviceMachineAccessUpdateCommandSchema,
  ...TabCommandSchema.options,
  ...AppCommandSchema.options,
  ...TeamCommandSchema.options,
  SettingsPluginEnableCommandSchema,
  ...PluginCommandSchema.options,
  ...otherCommandInputSchema.options,
]);

const commandOutputSchema = z.discriminatedUnion("type", [
  IphoneScreenAttachResultSchema,
  IphoneScreenDetachResultSchema,
  ...TabCommandResultSchema.options,
  ...AppCommandResultSchema.options,
  ...TeamCommandResultViewSchema.options,
  SettingsPluginEnableResultSchema,
  ...PluginCommandResultSchema.options,
  ComputerViewCloseResultSchema,
  ComputerViewRenewResultSchema,
  z.object({ type: z.literal("attachment.upload.create"), attachment: AttachmentSchema }),
  z.object({ type: z.literal("attachment.upload.discard") }),

  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.create"),
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
  z.object({
    lease: ThreadInputEditLeaseViewSchema,
    revision: z.number().int().nonnegative(),
    type: z.literal("thread.input.lease.take"),
  }),
  z.object({
    lease: ThreadInputEditLeaseViewSchema,
    type: z.literal("thread.input.lease.renew"),
  }),
  z.object({ type: z.literal("thread.input.lease.release") }),
  z.object({
    edit: MessageEditViewSchema,
    message: MessageViewSchema,
    type: z.literal("thread.input.edit"),
  }),
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
  z.object({ type: z.literal("thread.visit"), ...ThreadVisitSchema.shape }),
  z.object({
    type: z.literal("thread.done.set"),
    thread: ThreadViewSchema,
    asOfSequence: SequenceSchema,
    wasDuplicate: z.boolean(),
  }),

  z.object({
    type: z.literal("notification.preview.register"),
    installationId: NotificationInstallationIdSchema,
    keyId: NotificationPreviewKeyIdSchema,
    registered: z.literal(true),
  }),
  z.object({ timeZone: TimeZoneSchema, type: z.literal("viewer.timeZone.update") }),
  z.object({
    policy: IdleCompactionPolicyViewSchema,
    type: z.literal("settings.idleCompaction.set"),
  }),
  z.object({ quietTaskDays: QuietTaskDaysSchema, type: z.literal("viewer.quietTasks.update") }),
  // `applied` is false when the Account already had a newer name, which `profile` then shows.
  z.object({
    applied: z.boolean(),
    profile: OwnerProfileViewSchema,
    type: z.literal("viewer.name.update"),
  }),
  z.object({
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.access.update"),
  }),
  z.object({
    preferences: ExecutionPreferencesViewSchema,
    type: z.literal("execution.preferences.remember"),
  }),
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
  z.object({ tabId: TabIdSchema, type: z.literal("harness.authentication.browse") }),
  z.object({ type: z.literal("machine.revoke") }),
  z.object({ type: z.literal("machine.rename") }),
  z.object({ type: z.literal("machine.session.bind") }),
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
  z.object({
    type: z.literal("personal.accountLink.resume"),
    access: PersonalRemoteAccessStatusSchema,
  }),
  z.object({ type: z.literal("personal.accountLink.unlink") }),
  z.object({ type: z.literal("connection.revoke") }),
  z.object({ type: z.literal("connection.update"), connection: AgentConnectionSchema }),
  z.object({ type: z.literal("connection.remove") }),
  z.object({ type: z.literal("connection.uncertain.acknowledge") }),
  z.object({ ended: z.boolean(), type: z.literal("agent.session.stop") }),
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
  z.object({
    connection: z
      .union([IntegrationConnectionSummaryViewSchema, deviceConnectionViewSchema])
      .nullable(),
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
  // Plugin account sign-in.
  ...pluginOAuthOutputs,
  z.object({ type: z.literal("plugin.remove") }),
  z.object({ type: z.literal("integration.grant.revoke") }),
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

// Keep schema implementation types out of the shared RPC registry.
const declaration = <Payload extends z.ZodType, Success extends z.ZodType>(
  method: "GET" | "POST",
  payload: Payload,
  success: Success,
  stream?: true,
): RpcDeclaration<
  z.ZodType<Payload["_zod"]["output"], Payload["_zod"]["input"]>,
  z.ZodType<Success["_zod"]["output"], Success["_zod"]["input"]>,
  typeof HostApiErrorSchema
> => ({ error: HostApiErrorSchema, method, payload, success, ...(stream ? { stream } : {}) });

// Named groups keep TypeScript declaration serialization below its size limit.
const hostApiGroup1 = defineRpc({
  "attention.get": declaration(
    "POST",
    z.strictObject(deviceAccessRequestsInput),
    z.object({
      /** The Mac a personal Opensteer lives on, for a chooser naming it; older Hosts omit it. */
      homeName: z.string().trim().min(1).max(120).nullable().optional(),
      needsYou: z.number().int().nonnegative(),
      unread: z.boolean(),
    }),
  ),
  "needsYou.get": declaration(
    "POST",
    z.strictObject({
      ...deviceAccessRequestsInput,
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
  "team.invite.current.get": declaration(
    "POST",
    teamReadSchemas["team.invite.current.get"].input,
    teamReadViews["team.invite.current.get"],
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
  "team.agent.recipient.get": declaration(
    "POST",
    teamReadSchemas["team.agent.recipient.get"].input,
    teamReadViews["team.agent.recipient.get"],
  ),
  "team.agent.requests.get": declaration(
    "POST",
    teamReadSchemas["team.agent.requests.get"].input,
    teamReadViews["team.agent.requests.get"],
  ),
  "team.share.participants.get": declaration(
    "GET",
    teamReadSchemas["team.share.participants.get"].input,
    teamReadViews["team.share.participants.get"],
  ),
  "team.shares.list": declaration(
    "GET",
    teamReadSchemas["team.shares.list"].input,
    teamReadViews["team.shares.list"],
  ),
  "team.partners.list": declaration(
    "POST",
    teamReadSchemas["team.partners.list"].input,
    teamReadViews["team.partners.list"],
  ),
  "team.partner.invite.preview": declaration(
    "POST",
    teamReadSchemas["team.partner.invite.preview"].input,
    teamReadViews["team.partner.invite.preview"],
  ),
  "team.partner.invites.list": declaration(
    "POST",
    teamReadSchemas["team.partner.invites.list"].input,
    teamReadViews["team.partner.invites.list"],
  ),
  "team.sharing.policy.get": declaration(
    "POST",
    teamReadSchemas["team.sharing.policy.get"].input,
    teamReadViews["team.sharing.policy.get"],
  ),
} as const);

const hostApiGroup2 = defineRpc({
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
  "teams.threadTask.get": declaration(
    "POST",
    teamReadSchemas["teams.threadTask.get"].input,
    teamReadViews["teams.threadTask.get"],
  ),
  "teams.replyTask.get": declaration(
    "POST",
    teamReadSchemas["teams.replyTask.get"].input,
    teamReadViews["teams.replyTask.get"],
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
  "team.knowledge.notes.page": declaration(
    "POST",
    teamReadSchemas["team.knowledge.notes.page"].input,
    teamReadViews["team.knowledge.notes.page"],
  ),
  "team.knowledge.note.get": declaration(
    "POST",
    teamReadSchemas["team.knowledge.note.get"].input,
    teamReadViews["team.knowledge.note.get"],
  ),
  "team.knowledge.note.history": declaration(
    "POST",
    teamReadSchemas["team.knowledge.note.history"].input,
    teamReadViews["team.knowledge.note.history"],
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
  "apps.view": declaration(
    "POST",
    z.strictObject({ appId: AppIdSchema, theme: z.enum(["light", "dark"]) }),
    z.object({
      app: AppViewSchema,
      path: z.string().regex(/^\/v1\/apps\/app_[0-9a-f-]{36}\/(light|dark)\/[A-Za-z0-9_-]{43}\/$/u),
      entryUrl: z.url().max(512).optional(),
    }),
  ),
  "agentPhone.target.get": declaration("GET", emptyInputSchema, AgentPhoneHostTargetViewSchema),
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
} as const);

const hostApiGroup3 = defineRpc({
  "auth.setup.exchange": declaration(
    "POST",
    z.strictObject({ token: z.string().trim().min(16).max(4_096) }),
    emptyOutputSchema,
  ),
  "auth.signOut": declaration("POST", emptyInputSchema, emptyOutputSchema),
  "channel.connection.check": declaration(
    "POST",
    z.strictObject({ connectionId: IntegrationConnectionIdSchema }),
    ChannelConnectionInspectionViewSchema,
  ),
  "channels.get": declaration("GET", emptyInputSchema, ChannelDashboardViewSchema),
  "connections.list": declaration(
    "GET",
    z.strictObject({ includeRevoked: z.boolean().optional() }),
    z.object({
      connections: z.array(AgentConnectionSchema),
      /** Present on Homes with grants. Legacy readers still see only active connections. */
      endedConnections: z.array(AgentConnectionSchema).optional(),
    }),
  ),
  /** A connected agent's direct operations, newest first, paged. */
  "connections.activity": declaration(
    "GET",
    z.strictObject({
      connectionId: AgentConnectionIdSchema,
      before: z.string().min(1).max(200).optional(),
    }),
    AgentOperationPageSchema,
  ),
  /** One task's direct operations, newest first, paged; empty for any other task. */
  "threads.activity": declaration(
    "GET",
    z.strictObject({
      threadId: ThreadIdSchema,
      before: z.string().min(1).max(200).optional(),
    }),
    AgentOperationPageSchema,
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
  "personal.accountLink.get": declaration("GET", emptyInputSchema, PersonalAccountLinkStatusSchema),
  "plugins.overview.get": declaration("GET", z.strictObject({}), PluginsOverviewViewSchema),
  "devices.overview.get": declaration("GET", z.strictObject({}), DevicesOverviewViewSchema),
  "plugins.installed.list": declaration(
    "GET",
    pluginReads["plugins.installed.list"].input,
    pluginReads["plugins.installed.list"].output,
  ),
  "plugins.installed.page": declaration(
    "GET",
    pluginReads["plugins.installed.page"].input,
    pluginReads["plugins.installed.page"].output,
  ),
  "plugins.local.get": declaration(
    "GET",
    pluginReads["plugins.local.get"].input,
    pluginReads["plugins.local.get"].output,
  ),
  "plugins.page.view": declaration(
    "GET",
    pluginReads["plugins.page.view"].input,
    pluginReads["plugins.page.view"].output,
  ),
  "plugins.get": declaration(
    "GET",
    pluginReads["plugins.get"].input,
    pluginReads["plugins.get"].output,
  ),
  "plugins.tools.list": declaration(
    "GET",
    pluginReads["plugins.tools.list"].input,
    pluginReads["plugins.tools.list"].output,
  ),
  "plugins.skills.list": declaration(
    "GET",
    pluginReads["plugins.skills.list"].input,
    pluginReads["plugins.skills.list"].output,
  ),
  "plugins.versions.list": declaration(
    "GET",
    pluginReads["plugins.versions.list"].input,
    pluginReads["plugins.versions.list"].output,
  ),
  "plugins.catalog.list": declaration(
    "GET",
    pluginReads["plugins.catalog.list"].input,
    pluginReads["plugins.catalog.list"].output,
  ),
  "plugins.catalog.get": declaration(
    "GET",
    pluginReads["plugins.catalog.get"].input,
    pluginReads["plugins.catalog.get"].output,
  ),
  "plugins.icons.get": declaration(
    "GET",
    pluginReads["plugins.icons.get"].input,
    pluginReads["plugins.icons.get"].output,
  ),
  "plugins.accounts.list": declaration(
    "GET",
    pluginReads["plugins.accounts.list"].input,
    pluginReads["plugins.accounts.list"].output,
  ),
  "plugins.account.review": declaration(
    "GET",
    pluginReads["plugins.account.review"].input,
    pluginReads["plugins.account.review"].output,
  ),
  "plugins.schedule.runs": declaration(
    "GET",
    pluginReads["plugins.schedule.runs"].input,
    pluginReads["plugins.schedule.runs"].output,
  ),
  "plugins.workflow.runs": declaration(
    "GET",
    pluginReads["plugins.workflow.runs"].input,
    pluginReads["plugins.workflow.runs"].output,
  ),
  "plugins.webhook.setup.get": declaration(
    "GET",
    pluginReads["plugins.webhook.setup.get"].input,
    pluginReads["plugins.webhook.setup.get"].output,
  ),
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
  /** Requires automatic-models-v1. The choices come from settings.json in Agent home. */
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
  // Plugin account sign-in.
  "plugin.authorization.get": declaration(
    "GET",
    z.strictObject({ attemptId: IntegrationAuthorizationAttemptIdSchema }),
    PluginOAuthStatusSchema,
  ),
  "plugin.authorization.methods": declaration(
    "GET",
    z.strictObject({ connection: z.string().min(1) }),
    PluginOAuthMethodsSchema,
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
      /** What is being approved, as a person knows it; an older Host sends none. */
      name: z.string().min(1).max(255).optional(),
      /** Which of a server's secrets already have a value, which allowing can keep. */
      savedSecrets: z.array(LocalMcpSecretNameSchema).max(localMcpMaxSecrets).optional(),
    }),
  ),
  "integration.computer.setup.list": declaration(
    "GET",
    emptyInputSchema,
    ComputerAppSetupListResponseSchema,
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
} as const);

const hostApiGroup4 = defineRpc({
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
  "integration.platform.get": declaration(
    "GET",
    emptyInputSchema,
    IntegrationPlatformDashboardViewSchema,
  ),
  "integrations.get": declaration("GET", emptyInputSchema, IntegrationDashboardResponseSchema),
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
    durablePageInputSchema.extend(deviceAccessRequestsInput),
    z.object({
      requests: readableRequestList(WaitingRequestViewSchema, 100),
      window: DurableWindowSchema,
      /** The shell's `counts.pendingRequestsRevision` in the cut this page was read from. */
      pendingRequestsRevision: PersonalRevisionSchema,
    }),
  ),
  "tasks.list": declaration(
    "GET",
    z
      .strictObject({
        active: z.boolean().optional(),
        done: z.boolean().optional(),
        ...deviceAccessRequestsInput,
      })
      .extend(durablePageInputSchema.shape)
      .refine((input) => !(input.active && input.done), "Active work is never Done"),
    TaskPageSchema,
  ),
  "tasks.page": declaration(
    "GET",
    z
      .strictObject({
        done: z.boolean().optional(),
        /** Running and waiting tasks past the shell's active window. */
        active: z.literal(true).optional(),
        before: z.string().max(4096).optional(),
        limit: z.int().min(1).max(50).optional(),
      })
      .refine((input) => !(input.done && input.active)),
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
  /** Personal only: signed addresses for image files on the hosting computer. */
  "asset.urls": declaration("POST", AssetUrlsInputSchema, AssetUrlsSchema),
  "file.open": declaration("POST", TranscriptFileOpenInputSchema, TranscriptFileOpenSchema),
  "file.content": declaration(
    "GET",
    TranscriptFileContentInputSchema,
    TranscriptFileContentSchema,
    true,
  ),
  "thread.assignments.list": declaration(
    "GET",
    z
      .strictObject({
        /** Only work still under way, however far back it was handed out. Needs `task-family-v1`. */
        open: z.boolean().optional(),
        ...deviceAccessRequestsInput,
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
    z.strictObject({
      threadId: ThreadIdSchema,
      expectedRevision: PersonalRevisionSchema.optional(),
    }),
    PersonalInputQueueViewSchema,
  ),
  /** A waiting message's versions, newest first, a bounded page at a time. */
  "thread.message.revisions.list": declaration(
    "GET",
    z.strictObject({
      threadId: ThreadIdSchema,
      messageId: MessageIdSchema,
      before: z.number().int().positive().optional(),
      expectedRevision: z.int().nonnegative().optional(),
      leaseId: z.string().min(1).max(64).optional(),
    }),
    z.object({
      revisions: z.array(MessageRevisionViewSchema).max(messageRevisionsPageSize),
      hasMore: z.boolean(),
    }),
  ),
  /**
   * What each of the Thread's active Runs is streaming right now, as `replace`
   * items. A reader that opened the Thread mid-turn, or saw a gap in a stream,
   * reads this to draw the whole stream instead of the part it happened to see.
   */
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
  "references.resolve": declaration(
    "POST",
    ReferenceResolveInputSchema,
    ReferenceResolveResultSchema,
  ),
  "thread.requests.list": declaration(
    "GET",
    z
      .strictObject({
        threadId: ThreadIdSchema,
        requestId: RequestIdSchema.optional(),
        review: z
          .array(z.strictObject({ id: RequestIdSchema, revision: PersonalRevisionSchema }))
          .min(1)
          .max(20)
          .refine((requests) => new Set(requests.map(({ id }) => id)).size === requests.length)
          .optional(),
        ...deviceAccessRequestsInput,
      })
      .extend(durablePageInputSchema.shape)
      .refine(
        (input) =>
          !(input.requestId && input.review) &&
          (!(input.requestId || input.review) ||
            (input.before === undefined && input.limit === undefined)),
        "A targeted Request read cannot page",
      ),
    z.object({
      requests: readableRequestList(RequestViewSchema, 100),
      threadId: ThreadIdSchema,
      window: DurableWindowSchema,
      reviewedRevisions: z.record(RequestIdSchema, PersonalRevisionSchema).optional(),
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

      /**
       * This conversation's family: what runs in it, then what runs in tasks
       * linked under it, ended ones included and listed last. Needs `task-family-v1`.
       */
      anchorThreadId: ThreadIdSchema.optional(),
    }),
    z.object({ triggers: z.array(TriggerSummaryViewSchema).max(100) }),
  ),
} as const);

const transcriptScopeInput = { threadId: ThreadIdSchema, nodeId: ExecutionNodeIdSchema.optional() };
const transcriptPageInput = {
  after: TranscriptOrderCursorSchema.optional(),
  before: TranscriptOrderCursorSchema.optional(),
  anchorItemId: TranscriptItemIdSchema.optional(),
  aroundMessageId: MessageIdSchema.optional(),
  limit: z.int().min(1).max(100).optional(),
};

const workspaceHostApi = defineRpc({
  "personal.shell.get": declaration(
    "GET",
    z.strictObject({ selectedThreadId: ThreadIdSchema.optional() }),
    PersonalNetworkShellSnapshotSchema,
  ),
  "personal.readiness.get": declaration(
    "GET",
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("runner"),
        environmentId: EnvironmentIdSchema,
        runnerId: RunnerIdSchema,
      }),
      z.strictObject({
        kind: z.literal("browser-placement"),
        environmentId: EnvironmentIdSchema,
        runtimeId: z.string().trim().min(1).max(255),
      }),
    ]),
    z.object({ ready: z.boolean(), pluginAgentWorkStoppedSince: IsoDateTimeSchema.optional() }),
  ),
  "thread.snapshot.get": declaration(
    "GET",
    z.strictObject(transcriptScopeInput),
    PersonalDetailSnapshotSchema,
  ),
  "thread.items.page": declaration(
    "GET",
    z.strictObject({ threadId: ThreadIdSchema, ...transcriptPageInput }),
    TranscriptPageResultSchema,
  ),
  "node.items.page": declaration(
    "GET",
    z.strictObject({
      threadId: ThreadIdSchema,
      nodeId: ExecutionNodeIdSchema,
      ...transcriptPageInput,
    }),
    TranscriptPageResultSchema,
  ),
  "transcript.item.get": declaration(
    "GET",
    z.strictObject({
      ...transcriptScopeInput,
      itemId: TranscriptItemIdSchema,
      expectedRevision: PersonalRevisionSchema.optional(),
    }),
    TranscriptItemResultSchema,
  ),
  "thread.overlays.page": declaration(
    "GET",
    z.strictObject({
      ...transcriptScopeInput,
      kind: z.enum(["requests", "tools", "nodes"]),
      expectedRevision: PersonalRevisionSchema.optional(),
      cursor: z.string().max(4096).optional(),
    }),
    z.object({
      threadId: ThreadIdSchema,
      nodeId: ExecutionNodeIdSchema.nullable(),
      kind: z.enum(["requests", "tools", "nodes"]),
      revision: PersonalRevisionSchema,
      entries: z.array(z.union([PersonalRequestSummarySchema, TranscriptItemSchema])).max(20),
      next: z.string().max(4096).nullable(),
    }),
  ),
  "resources.detail.get": declaration(
    "GET",
    z.strictObject({
      kind: PersonalResourceKindSchema,
      id: z.string().max(255).optional(),
      cursor: z.string().max(4096).optional(),
    }),
    PersonalResourceDetailSchema,
  ),
  "machines.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({ machines: z.array(MachineListSummarySchema).max(400) }),
  ),
  "computer.app.windows": declaration(
    "POST",
    z.strictObject({ machineId: RunnerIdSchema, app: ComputerAppIdentitySchema }),
    z.object({
      windows: z.array(z.object(OwnerWindowInfoSchema.shape)).max(computerUseMaxWindows),
    }),
  ),
  "tabs.get": declaration("GET", TabGetInputSchema, TabViewSchema),
  "tabs.state": declaration("GET", z.strictObject({}), TabBootstrapSchema),
  "apps.list": declaration("GET", AppsListInputSchema, AppsListResultSchema),
  "apps.get": declaration("GET", z.strictObject({ appId: AppIdSchema }), AppViewSchema),
});
export const hostApi: typeof hostApiGroup1 &
  typeof hostApiGroup2 &
  typeof hostApiGroup3 &
  typeof hostApiGroup4 &
  typeof workspaceHostApi = {
  ...hostApiGroup1,
  ...hostApiGroup2,
  ...hostApiGroup3,
  ...hostApiGroup4,
  ...workspaceHostApi,
};

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
