import { ScreenPresentationInputSchema } from "./screen-presentation.js";
import {
  WorkspaceTabsInputSchema,
  WorkspaceTabLineageSchema,
  WorkspaceTabActivateCommandSchema,
  WorkspaceTabActivateResultSchema,
  WorkspaceTabCloseCommandSchema,
  WorkspaceTabCloseResultSchema,
  WorkspaceTabReopenCommandSchema,
  WorkspaceTabReopenResultSchema,
  WorkspaceTabsGroupCommandSchema,
  WorkspaceTabsGroupResultSchema,
  WorkspaceTabsUngroupCommandSchema,
  WorkspaceTabsUngroupResultSchema,
  WorkspaceTabsMoveCommandSchema,
  WorkspaceTabsMoveResultSchema,
  WorkspaceTabGroupUpdateCommandSchema,
  WorkspaceTabGroupUpdateResultSchema,
  WorkspaceTabsCloseCommandSchema,
  WorkspaceTabsCloseResultSchema,
} from "./browser.js";
import {
  ComputerViewOpenCommandSchema,
  ComputerViewCloseCommandSchema,
  ComputerViewRenewCommandSchema,
  ComputerViewOpenResultSchema,
  ComputerViewCloseResultSchema,
  ComputerViewRenewResultSchema,
  ApprovedComputerAppSchema,
} from "./computer-view.js";
import {
  AssignmentIdSchema,
  AssignmentSummarySchema,
  AssignmentViewSchema,
  AttachmentIdSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  AttachmentSchema,
  attachmentMaxBytes,
  AuthenticatedSessionViewSchema,
  type AuthenticatedSession,
  AuthSessionIdSchema,
  AuthSessionSummarySchema,
  BrowserProfileGrantIdSchema,
  BrowserProfileIdSchema,
  BrowserSiteSchema,
  BrowserSourceIdSchema,
  BrowserSurfaceIdSchema,
  EnvironmentIdSchema,
  ExecutionPreferencesViewSchema,
  ExecutionSelectionSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  HarnessInstanceStateKindSchema,
  IdentityPasswordSchema,
  InvitationPreviewSchema,
  LocalPasswordRecoveryTokenSchema,
  MessageContentSchema,
  MessageIdSchema,
  MessageViewSchema,
  ModelSelectionSchema,
  OpensteerErrorCodeSchema,
  ProviderSessionIdSchema,
  RequestIdSchema,
  RequestViewSchema,
  readableRequestList,
  WaitingRequestViewSchema,
  RequestResponseSchema,
  ExecutionNodeViewSchema,
  RunAttemptViewSchema,
  RunIdSchema,
  RunnerIdSchema,
  RunViewSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  TimeZoneSchema,
  TriggerOccurrenceIdSchema,
  ThreadInputViewSchema,
  ThreadInputQueueViewSchema,
  ThreadInputPolicySchema,
  ThreadTitleSchema,
  MarkColorSchema,
  ThreadViewSchema,
  ThreadReadStateSchema,
  WorkspaceNotificationPreferenceSchema,
  LiveRunProgressViewSchema,
  SequenceSchema,
  UserIdSchema,
  TriggerIdSchema,
  WorkspaceIconNameSchema,
  WorkspaceIdSchema,
  WorkspaceInvitationIdSchema,
  WorkspaceInvitationSchema,
  WorkspaceMembershipRoleSchema,
  WorkspaceMembershipSchema,
  identityPasswordMaxLength,
} from "@opensteer/core";
import { AgentPhoneHostTargetViewSchema } from "./android-phone.js";
import { AttachmentContentSchema, AttachmentReferenceInputSchema } from "./attachments.js";
import {
  ChannelAccessPolicySchema,
  ChannelAccessGrantViewSchema,
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
  BeginIntegrationAuthorizationSchema,
  BeginMcpAuthorizationSchema,
  ConnectIntegrationApiKeySchema,
  CreateIntegrationGrantSchema,
  InstallCatalogIntegrationSchema,
  InstallRemoteMcpSchema,
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationAuthorizationStartViewSchema,
  IntegrationAuthorizationStatusViewSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionSummaryViewSchema,
  IntegrationDashboardViewSchema,
  IntegrationRepositoryAccessViewSchema,
  IntegrationGrantIdSchema,
  IntegrationGrantViewSchema,
  IntegrationInstallationIdSchema,
  IntegrationInstallationViewSchema,
  IntegrationPlatformDashboardViewSchema,
  IntegrationProviderApplicationViewSchema,
  InstallAgentPluginSchema,
  SaveIntegrationProviderApplicationSchema,
  SetIntegrationApplicationSourceDefaultSchema,
  SetIntegrationProviderApplicationStatusSchema,
  ComputerUseAppApprovalSchema,
  SetComputerAppConnectionSchema,
  RequestComputerAppSetupSchema,
  RegisterComputerUseApprovalKeySchema,
  ComputerAppSetupRequestViewSchema,
} from "@opensteer/integration-core";
import {
  CreateTriggerHttpBodySchema,
  TriggerOccurrenceViewSchema,
  TriggerRevisionViewSchema,
  TriggerSummaryViewSchema,
  TriggerViewSchema,
  TriggerWatchActivationViewSchema,
  UpdateTriggerHttpBodySchema,
} from "@opensteer/triggers";
import { WorkspaceStorageChoiceSchema } from "@opensteer/workspace";
import { z } from "zod";
import {
  BrowserProfileNameSchema,
  BrowserProfileSchema,
  CreateBrowserProfileBodySchema,
  BrowserContextCandidateInputSchema,
  BrowserContextCandidateSchema,
  BrowserTabCloseCommandSchema,
  BrowserTabCloseResultSchema,
  BrowserTabOpenCommandSchema,
  BrowserTabOpenResultSchema,
  BrowserTabCatalogInputSchema,
  BrowserTabCatalogViewSchema,
  BrowserTabIconInputSchema,
  BrowserTabIconResultSchema,
  browserUsageRunBatchSize,
  ThreadBrowserUsageSchema,
  CreateBrowserProfileGrantResponseSchema,
  CreateBrowserProfileResponseSchema,
  SaveBrowserSessionProfileBodySchema,
  SaveBrowserSessionProfileResponseSchema,
  StartHostedBrowserBodySchema,
  StartHostedBrowserResponseSchema,
} from "./browser.js";
import { HostBootstrapSchema, IdentityConfigViewSchema } from "./bootstrap.js";
import {
  BrowserSignInDecisionSchema,
  BrowserSignInOutcomeSchema,
  BrowserSourcesStateSchema,
  BrowserSourceInspectionSchema,
  BrowserSourcePairingSchema,
  BrowserSourceNameSchema,
} from "./browser-sources.js";
import {
  DurableWindowCursorSchema,
  DurableWindowSchema,
  TaskPageSchema,
  ThreadEventPageSchema,
  ThreadMessagePageSchema,
  WorkspaceCatalogPageSchema,
  WorkspaceViewSchema,
} from "./client.js";
import {
  WorkspaceDirectoryPageViewSchema,
  WorkspaceFileCursorSchema,
  WorkspaceFileKeySchema,
  WorkspaceFilePreviewMetadataViewSchema,
  WorkspaceFileRevisionSchema,
} from "./files.js";
import {
  ComputerAppIdentitySchema,
  OwnerWindowInfoSchema,
  computerUseMaxWindows,
  ComputerAppIdentityViewSchema,
  ComputerUseInstalledAppSchema,
  ComputerUseInstalledAppsParamsSchema,
  ComputerUseSessionIdSchema,
  computerUseMaxInstalledApps,
} from "./computer-use.js";
import { MachineSummarySchema } from "./machines.js";
import { HarnessAuthenticationStateViewSchema, HarnessSourceIdSchema } from "./runner.js";
import { RunnerModuleNameSchema } from "./runner-identity.js";
import {
  MachineAccessPolicySchema,
  ShellHistoryCursorSchema,
  ShellSessionHistoryEntrySchema,
  ShellSessionIdSchema,
  machineAccessHistoryMaxSessions,
} from "./shell.js";
import {
  HarnessModelSettingsSchema,
  HarnessModelSettingsMapViewSchema,
  maxModelServers,
  ModelServerViewSchema,
} from "./runner.js";
import { defineRpc, type RpcClient, type RpcHandlers } from "./rpc.js";
import {
  VoiceEmptyResultSchema,
  VoiceRenewInputSchema,
  VoiceSayInputSchema,
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
const invitationSelectorSchema = z.string().regex(/^[A-Za-z0-9_-]{24,96}$/);
const invitationVerifierSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

/**
 * The request header every rpc caller states its protocol epoch in. A request
 * that omits it is a client from before negotiation existed, and the Host
 * refuses it: there are none in the wild, because the Host serves its own web
 * bundle and the Desktop ships with the Host it talks to.
 */
export const hostApiVersionHeader = "x-opensteer-api-version";

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

const WorkspaceMembershipViewSchema = z.object(WorkspaceMembershipSchema.shape);
const WorkspaceInvitationViewSchema = z.object(WorkspaceInvitationSchema.shape);
const InvitationPreviewViewSchema = z.object(InvitationPreviewSchema.shape);
const AuthSessionSummaryViewSchema = z.object(AuthSessionSummarySchema.shape);

const workspaceMemberSchema = z.object({
  ...WorkspaceMembershipSchema.shape,
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  emailVerified: z.boolean(),
});

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
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    attachmentId: AttachmentIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("attachment.upload.discard"),
  }),
  z.strictObject({
    icon: WorkspaceIconNameSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(160),
    quotaBytes: z.number().int().positive().optional(),
    quotaInodes: z.number().int().positive().optional(),
    // Absent means the Deployment's default backing, and for a local directory
    // the caller's own machine. A quota is meaningful only for shared storage,
    // so the Host refuses one alongside a local-directory choice.
    storage: WorkspaceStorageChoiceSchema.optional(),
    type: z.literal("workspace.create"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("workspace.storage.retry"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    icon: WorkspaceIconNameSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("workspace.icon.set"),
    workspaceId: WorkspaceIdSchema,
  }),
  /** A specialist's colour, chosen. Sent only to a Host that advertises `task-marks-v1`. */
  z.strictObject({
    color: MarkColorSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("workspace.color.set"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("workspace.delete"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("workspace.deletion.recover"),
    workspaceId: WorkspaceIdSchema,
  }),
  z
    .strictObject({
      idempotencyKey: idempotencyKeySchema,
      // An email invitation binds to one address: redemption by anyone else is
      // refused. A link invitation is bearer, so it must carry no address at
      // all rather than an advisory one nothing enforces.
      intendedEmail: emailSchema.optional(),
      invitationType: z.enum(["email", "link"]).default("link"),
      lifetimeSeconds: z
        .number()
        .int()
        .min(5 * 60)
        .max(30 * 24 * 60 * 60)
        .default(7 * 24 * 60 * 60),
      role: WorkspaceMembershipRoleSchema,
      type: z.literal("workspace.invitation.create"),
      workspaceId: WorkspaceIdSchema,
    })
    .superRefine((value, context) => {
      if ((value.invitationType === "email") !== (value.intendedEmail !== undefined)) {
        context.addIssue({ code: "custom", message: "Email invitations require an email address" });
      }
    }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    invitationId: WorkspaceInvitationIdSchema,
    type: z.literal("workspace.invitation.revoke"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    role: WorkspaceMembershipRoleSchema.optional(),
    state: z.enum(["active", "revoked"]).optional(),
    type: z.literal("workspace.member.update"),
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    accessMode: ThreadAccessModeSchema.optional(),
    environmentId: EnvironmentIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    modelSelection: ModelSelectionSchema,
    parentThreadId: ThreadIdSchema.optional(),
    home: z.literal(true).optional(),
    /**
     * `title` is the first line of the message that will start the Thread, for
     * its engine to replace with a name of its own. Absent, `title` is a name
     * someone chose and nothing replaces it. Sent only to a Host that
     * advertises `thread-titles-v1`.
     */
    generateTitle: z.literal(true).optional(),
    title: ThreadTitleSchema,
    type: z.literal("thread.create"),
    workspaceId: WorkspaceIdSchema,
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
  /**
   * A person picks a Thread's symbol; null is "Use default", the plain
   * document. Nothing replaces it afterwards, even when it is the symbol the
   * Thread already had. Chat has none. Sent only to a Host that advertises
   * `task-marks-v1`.
   */
  z.strictObject({
    icon: WorkspaceIconNameSchema.nullable(),
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
    screenPresentation: ScreenPresentationInputSchema.optional(),
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
    type: z.literal("thread.shared-done.set"),
    idempotencyKey: idempotencyKeySchema,
    threadId: ThreadIdSchema,
    done: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("workspace.notifications.update"),
    idempotencyKey: idempotencyKeySchema,
    workspaceId: WorkspaceIdSchema,
    muted: z.boolean(),
  }),
  // The reader's IANA time zone, which a client reports from its own clock so
  // an agent asked for "5pm" means the person's 5pm.
  z.strictObject({
    type: z.literal("viewer.timeZone.update"),
    idempotencyKey: idempotencyKeySchema,
    timeZone: TimeZoneSchema,
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
  z.strictObject({
    allowedModules: z.array(RunnerModuleNameSchema).min(1).max(5),
    idempotencyKey: idempotencyKeySchema,
    name: z.string().trim().min(1).max(120),
    type: z.literal("runner.enrollment.createManaged"),
  }),
  /**
   * A phone sharing Android's screen or iPhone data apps. The Host fixes the
   * integrations grant and pairing target; the optional iPhone profile pins
   * its integrations-only native descriptor at redemption and authentication.
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
    input: RegisterComputerUseApprovalKeySchema,
    type: z.literal("integration.computer.approval-key.set"),
  }),
  z.strictObject({
    attemptId: IntegrationAuthorizationAttemptIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.authorization.cancel"),
  }),
  z.strictObject({
    connectionId: IntegrationConnectionIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("integration.mcp.disconnect"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: InstallAgentPluginSchema,
    type: z.literal("integration.agentPlugin.install"),
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
    workspaceId: WorkspaceIdSchema,
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
    type: z.literal("channel.connection.create"),
    workspaceId: WorkspaceIdSchema,
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
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    accessPolicy: ChannelAccessPolicySchema,
    accountId: ChannelAccountIdSchema,
    executionPolicy: ChannelExecutionPolicySchema,
    idempotencyKey: idempotencyKeySchema,
    selector: ChannelRouteSelectorSchema,
    type: z.literal("channel.binding.create"),
    workspaceId: WorkspaceIdSchema,
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
    workspaceId: WorkspaceIdSchema,
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
    workspaceId: WorkspaceIdSchema,
  }),
  /**
   * Signs the site of `url` in, in one live Browser Session, with a Chrome
   * sign-in, and remembers the site for the session's Workspace. `sourceId`
   * answers a `choose-source` outcome; otherwise the Host picks the Workspace's
   * preferred Chrome or the only signed-in one.
   */
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
   * Declines a saved-password sign-in from any device. It is settled by the
   * Mac's answer: a sign-in already handed over is reported as signed in.
   */
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    requestId: RequestIdSchema,
    type: z.literal("browser.password-sign-in.decline"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    input: SaveBrowserSessionProfileBodySchema,
    sessionId: z.string().min(1),
    type: z.literal("browser.session.profile.save"),
  }),
  z.strictObject({
    idempotencyKey: idempotencyKeySchema,
    profileId: BrowserProfileIdSchema,
    type: z.literal("browser.profile.grant"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    grantId: BrowserProfileGrantIdSchema,
    idempotencyKey: idempotencyKeySchema,
    type: z.literal("browser.profileGrant.revoke"),
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
  BrowserTabOpenCommandSchema,
  WorkspaceTabActivateCommandSchema,
  WorkspaceTabCloseCommandSchema,
  WorkspaceTabReopenCommandSchema,
  WorkspaceTabsGroupCommandSchema,
  WorkspaceTabsUngroupCommandSchema,
  WorkspaceTabsMoveCommandSchema,
  WorkspaceTabGroupUpdateCommandSchema,
  WorkspaceTabsCloseCommandSchema,
  ...otherCommandInputSchema.options,
]);

const commandOutputSchema = z.discriminatedUnion("type", [
  WorkspaceTabActivateResultSchema,
  WorkspaceTabCloseResultSchema,
  WorkspaceTabReopenResultSchema,
  WorkspaceTabsGroupResultSchema,
  WorkspaceTabsUngroupResultSchema,
  WorkspaceTabsMoveResultSchema,
  WorkspaceTabGroupUpdateResultSchema,
  WorkspaceTabsCloseResultSchema,
  BrowserTabOpenResultSchema,
  ComputerViewOpenResultSchema,
  ComputerViewCloseResultSchema,
  ComputerViewRenewResultSchema,
  BrowserTabCloseResultSchema,
  z.object({ type: z.literal("attachment.upload.create"), attachment: AttachmentSchema }),
  z.object({ type: z.literal("attachment.upload.discard") }),
  z.object({ type: z.literal("workspace.create"), workspace: WorkspaceViewSchema }),
  z.object({ type: z.literal("workspace.storage.retry"), workspace: WorkspaceViewSchema }),
  z.object({ type: z.literal("workspace.icon.set"), workspace: WorkspaceViewSchema }),
  z.object({ type: z.literal("workspace.color.set"), workspace: WorkspaceViewSchema }),
  z.object({ type: z.literal("workspace.delete"), workspace: WorkspaceViewSchema }),
  z.object({ type: z.literal("workspace.deletion.recover"), workspace: WorkspaceViewSchema }),
  z.object({
    invitation: WorkspaceInvitationViewSchema,
    invitationUrl: z.url(),
    type: z.literal("workspace.invitation.create"),
  }),
  z.object({ type: z.literal("workspace.invitation.revoke") }),
  z.object({ membership: workspaceMemberSchema, type: z.literal("workspace.member.update") }),
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
    asOfSequence: SequenceSchema,
    thread: ThreadViewSchema,
    type: z.literal("thread.shared-done.set"),
    wasDuplicate: z.boolean(),
  }),
  WorkspaceNotificationPreferenceSchema.extend({
    type: z.literal("workspace.notifications.update"),
  }),
  z.object({ timeZone: TimeZoneSchema, type: z.literal("viewer.timeZone.update") }),
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
  z.object({ type: z.literal("request.respond") }),
  z.object({ harness: harnessRecordSchema, type: z.literal("harness.create") }),
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
    token: z.string().min(16).max(4_096),
    type: z.literal("runner.enrollment.createManaged"),
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
    approvalKeyId: z.string().min(1).max(128),
    type: z.literal("integration.computer.approval-key.set"),
  }),
  z.object({ type: z.literal("integration.computer.policy.set"), appApproval: z.literal("ask") }),
  z.object({ type: z.literal("integration.computer.app.block") }),
  IntegrationAuthorizationStatusViewSchema.extend({
    type: z.literal("integration.authorization.cancel"),
  }),
  z.object({ type: z.literal("integration.mcp.disconnect") }),
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
    type: z.literal("integration.agentPlugin.install"),
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
  z.object({ type: z.literal("integration.apiKey.connect") }),
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
    type: z.literal("browser.password-sign-in.decline"),
    /** How the Request ended; `pending` only if the Mac has not answered yet. */
    status: z.enum(["declined", "fulfilled", "pending", "withdrawn", "cancelled"]),
  }),
  SaveBrowserSessionProfileResponseSchema.extend({
    type: z.literal("browser.session.profile.save"),
  }),
  CreateBrowserProfileGrantResponseSchema.extend({ type: z.literal("browser.profile.grant") }),
  z.object({ type: z.literal("browser.profileGrant.revoke") }),
  z.object({ profile: BrowserProfileSchema, type: z.literal("browser.profile.rename") }),
  z.object({ type: z.literal("browser.profile.delete") }),
  z.object({ type: z.literal("browser.session.close") }),
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
  "workspace.tabs.get": declaration("GET", WorkspaceTabsInputSchema, WorkspaceTabLineageSchema),
  "browser.tabs.get": declaration("GET", BrowserTabCatalogInputSchema, BrowserTabCatalogViewSchema),
  "browser.tabIcon.get": declaration("GET", BrowserTabIconInputSchema, BrowserTabIconResultSchema),
  /**
   * Where an Android phone reaches this Deployment now, as the Host itself
   * knows it — the target `runner.enrollment.createPhone` pairs with, read
   * without minting anything. Setup compares it with the address an enrolled
   * phone holds and moves the phone when the route changed. A Personal
   * Deployment with remote access off refuses with reason
   * `personal-remote-access-off`.
   */
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
  "browser.sources.get": declaration("GET", emptyInputSchema, BrowserSourcesStateSchema),
  "browser.sources.inspect": declaration(
    "POST",
    z.strictObject({ url: z.string().min(1).max(2_048) }),
    BrowserSourceInspectionSchema,
  ),
  "auth.config": declaration("GET", emptyInputSchema, IdentityConfigViewSchema),
  "auth.invitation.accept": declaration(
    "POST",
    emptyInputSchema,
    z.object({ membership: WorkspaceMembershipViewSchema }),
  ),
  "auth.invitation.exchange": declaration(
    "POST",
    z.strictObject({ selector: invitationSelectorSchema, verifier: invitationVerifierSchema }),
    z.object({ preview: InvitationPreviewViewSchema }),
  ),
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
   * A voice call on one of the person's ChatGPT accounts on that work
   * location's computer. The client's offer goes to the Runner, which creates
   * the call; audio then flows between the client and the vendor only.
   * Requires `voice-v1`; errors carry a `VoiceRefusalReason`.
   */
  "voice.start": declaration("POST", VoiceStartInputSchema, VoiceStartResultSchema),
  /** Keeps a call alive for another lease, rechecking the person may still use it. */
  "voice.renew": declaration("POST", VoiceRenewInputSchema, VoiceEmptyResultSchema),
  /** Has the voice tell the person something, such as Chat's reply. */
  "voice.say": declaration("POST", VoiceSayInputSchema, VoiceEmptyResultSchema),
  /** Ends a call. Ending one that is already over succeeds. */
  "voice.stop": declaration("POST", VoiceStopInputSchema, VoiceEmptyResultSchema),
  "integration.authorization.get": declaration(
    "GET",
    z.strictObject({ attemptId: IntegrationAuthorizationAttemptIdSchema }),
    IntegrationAuthorizationStatusViewSchema,
  ),
  "integration.grants.list": declaration(
    "GET",
    z.strictObject({ workspaceId: WorkspaceIdSchema }),
    z.object({ grants: z.array(IntegrationGrantViewSchema).max(1_000) }),
  ),
  "integration.computer.policy.get": declaration(
    "GET",
    z.strictObject({ runnerId: RunnerIdSchema }),
    z.object({ appApproval: ComputerUseAppApprovalSchema }),
  ),
  "integration.computer.setup.list": declaration(
    "GET",
    emptyInputSchema,
    z.object({ requests: z.array(ComputerAppSetupRequestViewSchema).max(1_000) }),
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
  /**
   * The pending Requests the signed-in person is the one to answer, across
   * every Workspace they belong to, each with the handed-out work it holds up.
   * It is reread whenever `host.requests-changed` arrives.
   */
  "requests.list": declaration(
    "GET",
    durablePageInputSchema,
    z.object({
      requests: readableRequestList(WaitingRequestViewSchema, 100),
      window: DurableWindowSchema,
    }),
  ),
  /**
   * The signed-in person's tasks across every Workspace they belong to, or in
   * the one named, most recently updated first, with their read state. The
   * active filter keeps only running or waiting work. It is reread whenever
   * `host.tasks-changed` arrives.
   */
  "tasks.list": declaration(
    "GET",
    z
      .strictObject({ active: z.boolean().optional(), workspaceId: WorkspaceIdSchema.optional() })
      .extend(durablePageInputSchema.shape),
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
  "thread.events.list": declaration(
    "GET",
    z
      .strictObject({ threadId: ThreadIdSchema, aroundMessageId: MessageIdSchema.optional() })
      .extend(durablePageInputSchema.shape)
      .refine(
        (input) => !input.aroundMessageId || !input.before,
        "An anchored read cannot also page",
      ),
    ThreadEventPageSchema,
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
      workspaceId: WorkspaceIdSchema.optional(),
      /** Only those that run in this conversation. Needs `task-family-v1`. */
      anchorThreadId: ThreadIdSchema.optional(),
    }),
    z.object({ triggers: z.array(TriggerSummaryViewSchema).max(100) }),
  ),
  "workspace.catalog.list": declaration("GET", durablePageInputSchema, WorkspaceCatalogPageSchema),
  "workspace.files.list": declaration(
    "POST",
    z.strictObject({
      cursor: WorkspaceFileCursorSchema.optional(),
      knownRevision: WorkspaceFileRevisionSchema.optional(),
      parentKey: WorkspaceFileKeySchema,
      retainedCursor: WorkspaceFileCursorSchema.optional(),
      workspaceId: WorkspaceIdSchema,
    }),
    WorkspaceDirectoryPageViewSchema,
  ),
  "workspace.files.preview": declaration(
    "POST",
    z.strictObject({ fileKey: WorkspaceFileKeySchema, workspaceId: WorkspaceIdSchema }),
    z.object({
      bytes: z.instanceof(Uint8Array),
      metadata: WorkspaceFilePreviewMetadataViewSchema,
    }),
    true,
  ),
  "workspace.invitations.list": declaration(
    "GET",
    z.strictObject({ workspaceId: WorkspaceIdSchema }),
    z.object({ invitations: z.array(WorkspaceInvitationViewSchema).max(1_000) }),
  ),
  "workspace.members.list": declaration(
    "GET",
    z.strictObject({ workspaceId: WorkspaceIdSchema }),
    z.object({ members: z.array(workspaceMemberSchema).max(1_000) }),
  ),
  "workspace.prefetch": declaration(
    "POST",
    z.strictObject({ workspaceId: WorkspaceIdSchema }),
    emptyOutputSchema,
  ),
} as const);

export type HostApiCommand = z.output<typeof commandInputSchema>;
export type HostApiCommandInput = z.input<typeof commandInputSchema>;
export type HostApiCommandOutput = z.output<typeof commandOutputSchema>;
export type HostApiClient = RpcClient<typeof hostApi>;

export interface HostApiServerContext {
  readonly binaryBody?: AsyncIterable<Uint8Array>;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly requestId: string;
  readonly requestUrl: string;
  readonly session: AuthenticatedSession | null;
  readonly setHeader: (name: string, value: string | readonly string[]) => void;
  readonly signal: AbortSignal;
  readonly surface: "canonical" | "personal-remote" | null;
}

export type HostApiHandlers = RpcHandlers<typeof hostApi, HostApiServerContext>;

export type HostApiScope =
  "exact-origin" | "exact-origin-session" | "mutation" | "public" | "session";
