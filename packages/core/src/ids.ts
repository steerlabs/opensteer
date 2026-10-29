import { z } from "zod";

const idPrefixes = {
  attachment: "att",
  authAccount: "aat",
  authAdmission: "adm",
  authSession: "ses",
  authVerification: "vrf",
  browserProfile: "bpr",
  browserProfileGrant: "bpg",
  browserSource: "bsr",
  browserTabGroup: "btg",
  causalChain: "cch",
  command: "cmd",
  credential: "cred",
  deployment: "dep",
  delegation: "dlg",
  environment: "env",
  event: "evt",
  executionNode: "nod",
  grant: "grt",
  harnessInstance: "hin",
  hostInstance: "hst",
  message: "msg",
  notification: "ntf",
  ownerEnrollment: "oen",
  providerSession: "psn",
  run: "run",
  runAttempt: "rat",
  runner: "rnr",
  securityAudit: "sau",
  securityEffect: "sef",
  storageAuthority: "sta",
  thread: "thr",
  request: "req",
  trigger: "trg",
  triggerWatchActivation: "twa",
  triggerOccurrence: "toc",
  triggerRevision: "trv",
  user: "usr",
  workspace: "wsp",
  workspaceBinding: "wbd",
  workspaceInvitation: "inv",
  workspaceMembership: "wmb",
} as const;

export type IdKind = keyof typeof idPrefixes;

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type BrowserProfileId = Brand<string, "BrowserProfileId">;
export type AttachmentId = Brand<string, "AttachmentId">;
export type BrowserProfileGrantId = Brand<string, "BrowserProfileGrantId">;
export type BrowserTabGroupId = Brand<string, "BrowserTabGroupId">;
export type BrowserSourceId = Brand<string, "BrowserSourceId">;
export type CausalChainId = Brand<string, "CausalChainId">;
export type AuthAccountId = Brand<string, "AuthAccountId">;
export type AuthAdmissionId = Brand<string, "AuthAdmissionId">;
export type AuthSessionId = Brand<string, "AuthSessionId">;
export type AuthVerificationId = Brand<string, "AuthVerificationId">;
export type CommandId = Brand<string, "CommandId">;
export type CredentialId = Brand<string, "CredentialId">;
export type DeploymentId = Brand<string, "DeploymentId">;
export type DelegationId = Brand<string, "DelegationId">;
export type GrantId = Brand<string, "GrantId">;
export type RunAttemptId = Brand<string, "RunAttemptId">;
export type ExecutionNodeId = Brand<string, "ExecutionNodeId">;
/** Assignments retain the IDs issued for historical delegations. */
export type AssignmentId = DelegationId;
export type EnvironmentId = Brand<string, "EnvironmentId">;
export type EventId = Brand<string, "EventId">;
export type HarnessInstanceId = Brand<string, "HarnessInstanceId">;
export type HostInstanceId = Brand<string, "HostInstanceId">;
export type MessageId = Brand<string, "MessageId">;
export type NotificationId = Brand<string, "NotificationId">;
export type OwnerEnrollmentId = Brand<string, "OwnerEnrollmentId">;
export type ProviderSessionId = Brand<string, "ProviderSessionId">;
export type RunId = Brand<string, "RunId">;
export type RunnerId = Brand<string, "RunnerId">;
export type SecurityAuditId = Brand<string, "SecurityAuditId">;
export type SecurityEffectId = Brand<string, "SecurityEffectId">;
export type StorageAuthorityId = Brand<string, "StorageAuthorityId">;
export type ThreadId = Brand<string, "ThreadId">;
export type RequestId = Brand<string, "RequestId">;
export type TriggerId = Brand<string, "TriggerId">;
export type TriggerWatchActivationId = Brand<string, "TriggerWatchActivationId">;
export type TriggerOccurrenceId = Brand<string, "TriggerOccurrenceId">;
export type TriggerRevisionId = Brand<string, "TriggerRevisionId">;
export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type WorkspaceBindingId = Brand<string, "WorkspaceBindingId">;
export type WorkspaceInvitationId = Brand<string, "WorkspaceInvitationId">;
export type WorkspaceMembershipId = Brand<string, "WorkspaceMembershipId">;

export interface IdByKind {
  readonly attachment: AttachmentId;
  readonly authAccount: AuthAccountId;
  readonly authAdmission: AuthAdmissionId;
  readonly authSession: AuthSessionId;
  readonly authVerification: AuthVerificationId;
  readonly browserProfile: BrowserProfileId;
  readonly browserProfileGrant: BrowserProfileGrantId;
  readonly browserTabGroup: BrowserTabGroupId;
  readonly browserSource: BrowserSourceId;
  readonly causalChain: CausalChainId;
  readonly command: CommandId;
  readonly credential: CredentialId;
  readonly deployment: DeploymentId;
  readonly delegation: DelegationId;
  readonly environment: EnvironmentId;
  readonly event: EventId;
  readonly grant: GrantId;
  readonly harnessInstance: HarnessInstanceId;
  readonly hostInstance: HostInstanceId;
  readonly message: MessageId;
  readonly notification: NotificationId;
  readonly ownerEnrollment: OwnerEnrollmentId;
  readonly providerSession: ProviderSessionId;
  readonly run: RunId;
  readonly runAttempt: RunAttemptId;
  readonly executionNode: ExecutionNodeId;
  readonly runner: RunnerId;
  readonly securityAudit: SecurityAuditId;
  readonly securityEffect: SecurityEffectId;
  readonly storageAuthority: StorageAuthorityId;
  readonly thread: ThreadId;
  readonly request: RequestId;
  readonly trigger: TriggerId;
  readonly triggerWatchActivation: TriggerWatchActivationId;
  readonly triggerOccurrence: TriggerOccurrenceId;
  readonly triggerRevision: TriggerRevisionId;
  readonly user: UserId;
  readonly workspace: WorkspaceId;
  readonly workspaceBinding: WorkspaceBindingId;
  readonly workspaceInvitation: WorkspaceInvitationId;
  readonly workspaceMembership: WorkspaceMembershipId;
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function idSchema<K extends IdKind>(kind: K): z.ZodType<IdByKind[K]> {
  return z
    .string()
    .regex(new RegExp(`^${idPrefixes[kind]}_${uuidPattern}$`, "i"))
    .transform((value) => value as IdByKind[K]);
}

export function createId<K extends IdKind>(kind: K): IdByKind[K] {
  return `${idPrefixes[kind]}_${globalThis.crypto.randomUUID()}` as IdByKind[K];
}

export const AuthAdmissionIdSchema = idSchema("authAdmission");
export const AttachmentIdSchema = idSchema("attachment");
export const AuthSessionIdSchema = idSchema("authSession");
export const BrowserProfileIdSchema = idSchema("browserProfile");
export const BrowserProfileGrantIdSchema = idSchema("browserProfileGrant");
export const BrowserTabGroupIdSchema = idSchema("browserTabGroup");
export const BrowserSourceIdSchema = idSchema("browserSource");
export const CausalChainIdSchema = idSchema("causalChain");
export const CommandIdSchema = idSchema("command");
export const DeploymentIdSchema = idSchema("deployment");
export const DelegationIdSchema = idSchema("delegation");
export const AssignmentIdSchema = DelegationIdSchema;
export const EnvironmentIdSchema = idSchema("environment");
export const EventIdSchema = idSchema("event");
export const GrantIdSchema = idSchema("grant");
export const HarnessInstanceIdSchema = idSchema("harnessInstance");
export const HostInstanceIdSchema = idSchema("hostInstance");
export const MessageIdSchema = idSchema("message");
export const NotificationIdSchema = idSchema("notification");
export const ProviderSessionIdSchema = idSchema("providerSession");
export const RunIdSchema = idSchema("run");
export const RunAttemptIdSchema = idSchema("runAttempt");
export const ExecutionNodeIdSchema = idSchema("executionNode");
export const RunnerIdSchema = idSchema("runner");
export const StorageAuthorityIdSchema = idSchema("storageAuthority");
export const ThreadIdSchema = idSchema("thread");
export const RequestIdSchema = idSchema("request");
export const TriggerIdSchema = idSchema("trigger");
export const TriggerWatchActivationIdSchema = idSchema("triggerWatchActivation");
export const TriggerOccurrenceIdSchema = idSchema("triggerOccurrence");
export const TriggerRevisionIdSchema = idSchema("triggerRevision");
export const UserIdSchema = idSchema("user");
export const WorkspaceIdSchema = idSchema("workspace");
export const WorkspaceBindingIdSchema = idSchema("workspaceBinding");
export const WorkspaceInvitationIdSchema = idSchema("workspaceInvitation");
export const WorkspaceMembershipIdSchema = idSchema("workspaceMembership");

export const BrowserSessionIdSchema = z
  .string()
  .regex(/^bsn_[0-9a-f-]{36}$/i)
  .brand<"BrowserSessionId">();
export type BrowserSessionId = z.infer<typeof BrowserSessionIdSchema>;

/** A page (tab) inside one Browser Session, as the Browser Runtime names it. */
export const BrowserSurfaceIdSchema = z.string().min(1).max(512).brand<"BrowserSurfaceId">();
export type BrowserSurfaceId = z.infer<typeof BrowserSurfaceIdSchema>;

export const SequenceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .brand<"Sequence">();

export type Sequence = z.infer<typeof SequenceSchema>;

export const zeroSequence = "0" as Sequence;

export function compareSequence(left: Sequence, right: Sequence): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
