import {
  AgentSessionIdSchema,
  DeploymentIdSchema,
  DeviceIdSchema,
  GrantIdSchema,
  IdentityEmailSchema,
  PersonNameSchema,
  RequestIdSchema,
  ThreadAccessModeSchema,
  UserIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import { prefixedIdSchema, ControlPlaneAccountIdSchema } from "./account-id.js";

export const OrganizationIdSchema = prefixedIdSchema("org").brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;
export const WorkAssignmentIdSchema = prefixedIdSchema("was").brand<"WorkAssignmentId">();
export type WorkAssignmentId = z.infer<typeof WorkAssignmentIdSchema>;
export const OrganizationInvitationIdSchema =
  prefixedIdSchema("oi").brand<"OrganizationInvitationId">();
export type OrganizationInvitationId = z.infer<typeof OrganizationInvitationIdSchema>;
export const OrganizationRoleSchema = z.enum(["admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;
export const OrganizationNameSchema = z.string().trim().min(1).max(120);
export const WorkAssignmentStateSchema = z.enum(["active", "offboarding", "ended"]);
export const WorkPolicyRevisionSchema = z.number().int().positive();
export const OrganizationSeatQuantitySchema = z.number().int().min(1).max(1000);

export const WorkHomeMarkerSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  organizationName: OrganizationNameSchema,
  assignmentId: WorkAssignmentIdSchema,
});
export type WorkHomeMarker = z.infer<typeof WorkHomeMarkerSchema>;

export const WorkPolicySchema = z.strictObject({
  externalMaxMode: ThreadAccessModeSchema,
  allowEverything: z.boolean(),
  allowTasks: z.boolean(),
  devices: z.enum(["cloud-computer-only", "assignee-may-enroll"]),
});
export type WorkPolicy = z.infer<typeof WorkPolicySchema>;

export const defaultWorkPolicy: WorkPolicy = Object.freeze({
  externalMaxMode: "approval-required",
  allowEverything: false,
  allowTasks: false,
  devices: "cloud-computer-only",
});

export function workPolicyAllowsGrant(
  policy: WorkPolicy,
  grant: { scope: "everything" } | { scope: "selected"; tasks: boolean },
): boolean {
  return grant.scope === "everything"
    ? policy.allowEverything && policy.allowTasks
    : !grant.tasks || policy.allowTasks;
}

export const WorkPolicyDocumentSchema = z.strictObject({
  assignmentId: WorkAssignmentIdSchema,
  deploymentId: DeploymentIdSchema,
  policy: WorkPolicySchema,
  revision: WorkPolicyRevisionSchema,
  state: WorkAssignmentStateSchema,
});
export type WorkPolicyDocument = z.infer<typeof WorkPolicyDocumentSchema>;
export const WorkPolicyClaimsSchema = WorkPolicyDocumentSchema.extend({
  tokenUse: z.literal("opensteer-work-policy"),
  iss: z.url(),
  aud: DeploymentIdSchema,
  iat: z.number().int().nonnegative(),
});
export type WorkPolicyClaims = z.infer<typeof WorkPolicyClaimsSchema>;
export const WorkPolicyResponseSchema = z.strictObject({ assertion: z.jwt() });
export const WorkPolicyUpdateResponseSchema = z.strictObject({
  revision: WorkPolicyRevisionSchema,
  policy: WorkPolicySchema,
});
export const WorkPolicyAppliedResponseSchema = z.strictObject({
  appliedRevision: WorkPolicyRevisionSchema,
});
export const WorkPolicyAppliedRequestSchema = z.strictObject({
  revision: WorkPolicyRevisionSchema,
});

const instant = z.iso.datetime({ precision: 3 });
const sequence = z.number().int().nonnegative().max(2_147_483_647);
const auditHash = z.string().regex(/^[a-f0-9]{64}$/u);
const localId = z.union([
  z.uuid(),
  z
    .string()
    .regex(
      /^[a-z][a-z0-9]{1,11}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
]);
const recordBase = { sequence: sequence.min(1), at: instant };
const connection = {
  connectionId: localId,
  grantId: GrantIdSchema,
  grantRevision: WorkPolicyRevisionSchema,
};
const device = { deviceId: DeviceIdSchema };
const session = { connectionId: localId, agentSessionId: AgentSessionIdSchema };
const request = { requestId: RequestIdSchema };
export const WorkAuditRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...recordBase,
    kind: z.literal("connection.consent"),
    ...connection,
    ownerId: UserIdSchema,
  }),
  z.strictObject({
    ...recordBase,
    kind: z.literal("connection.grant_changed"),
    ...connection,
    ownerId: UserIdSchema,
  }),
  z.strictObject({ ...recordBase, kind: z.literal("connection.disconnected"), ...connection }),
  z.strictObject({ ...recordBase, kind: z.literal("connection.expired"), ...connection }),
  z.strictObject({ ...recordBase, kind: z.literal("agent_session.started"), ...session }),
  z.strictObject({ ...recordBase, kind: z.literal("agent_session.ended"), ...session }),
  z.strictObject({
    ...recordBase,
    kind: z.literal("operation.direct"),
    ...session,
    operationId: localId,
    toolFamily: z.enum(["tasks", "browser", "computer", "plugins", "settings"]),
    targetKind: z.enum(["task", "browser-profile", "computer-app", "plugin", "settings"]),
    grantedResourceId: localId.nullable(),
    effectiveMode: ThreadAccessModeSchema,
    grantId: GrantIdSchema,
    grantRevision: WorkPolicyRevisionSchema,
    policyRevision: WorkPolicyRevisionSchema,
    decidedBy: z.enum(["owner", "policy", "device", "system"]),
    handedOffAt: instant.nullable(),
    outcome: z.enum(["allowed", "denied", "completed", "failed", "stopped"]),
  }),
  z.strictObject({ ...recordBase, kind: z.literal("request.opened"), ...request }),
  z.strictObject({
    ...recordBase,
    kind: z.literal("request.answered"),
    ...request,
    ownerId: UserIdSchema,
    outcome: z.enum(["approved", "denied", "canceled"]),
  }),
  z.strictObject({ ...recordBase, kind: z.literal("request.expired"), ...request }),
  z.strictObject({ ...recordBase, kind: z.literal("stop"), ownerId: UserIdSchema }),
  z.strictObject({ ...recordBase, kind: z.literal("device.enrolled"), ...device }),
  z.strictObject({ ...recordBase, kind: z.literal("device.removed"), ...device }),
  z.strictObject({
    ...recordBase,
    kind: z.literal("device.switch_changed"),
    ...device,
    enabled: z.enum(["enabled", "disabled"]),
  }),
  z.strictObject({ ...recordBase, kind: z.literal("owner.signed_in"), ownerId: UserIdSchema }),
  z.strictObject({ ...recordBase, kind: z.literal("owner.signed_out"), ownerId: UserIdSchema }),
  z.strictObject({
    ...recordBase,
    kind: z.literal("policy.applied"),
    revision: WorkPolicyRevisionSchema,
  }),
]);
export type WorkAuditRecord = z.infer<typeof WorkAuditRecordSchema>;
export const WorkAuditPushSchema = z
  .strictObject({
    assignmentId: WorkAssignmentIdSchema,
    fromSequence: sequence.min(1),
    records: z.array(WorkAuditRecordSchema).min(1).max(256),
    headHash: auditHash,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  })
  .refine(({ fromSequence, records }) =>
    records.every((record, i) => record.sequence === fromSequence + i),
  );
export type WorkAuditPush = z.infer<typeof WorkAuditPushSchema>;
export const WorkAuditAcknowledgmentSchema = z.strictObject({ lastSequence: sequence });
export type WorkAuditAcknowledgment = z.infer<typeof WorkAuditAcknowledgmentSchema>;
export const workAuditGenesisHash = "0".repeat(64);

export function canonicalWorkAuditRecord(record: WorkAuditRecord): string {
  const parsed = WorkAuditRecordSchema.parse(record);
  return JSON.stringify(parsed, Object.keys(parsed).sort());
}

export function workAuditSigningBytes(
  batch: Pick<WorkAuditPush, "assignmentId" | "fromSequence" | "records" | "headHash">,
): Uint8Array {
  return new TextEncoder().encode(
    `opensteer-work-audit-v1\0${JSON.stringify([
      batch.assignmentId,
      batch.fromSequence,
      batch.fromSequence + batch.records.length - 1,
      batch.headHash,
    ])}`,
  );
}

export const WorkAuditStatusSchema = z.strictObject({
  lastSequence: sequence,
  lastReceivedAt: instant.nullable(),
  gap: z.strictObject({ expected: sequence.min(1), received: sequence.min(1) }).nullable(),
});

export type WorkAuditStatus = z.infer<typeof WorkAuditStatusSchema>;

const organization = { id: OrganizationIdSchema, name: OrganizationNameSchema };
const invitation = {
  id: OrganizationInvitationIdSchema,
  email: IdentityEmailSchema,
  role: OrganizationRoleSchema,
  createdAt: instant,
};
const person = {
  accountId: ControlPlaneAccountIdSchema,
  displayName: PersonNameSchema,
  email: IdentityEmailSchema,
};
export const MyOrganizationsResponseSchema = z.strictObject({
  organizations: z.array(z.strictObject({ ...organization, role: OrganizationRoleSchema })),
  invitations: z.array(
    z.strictObject({ ...invitation, organization: z.strictObject(organization) }),
  ),
});
export type MyOrganizationsResponse = z.infer<typeof MyOrganizationsResponseSchema>;
const homeStatus = z.enum(["preparing", "ready", "needs_attention", "suspended", "deleted"]);
export const WorkAssignmentViewSchema = z.strictObject({
  ...WorkHomeMarkerSchema.shape,
  assignee: z.strictObject(person).nullable(),
  computerId: prefixedIdSchema("cc")
    .refine((id) => id === id.toLowerCase())
    .brand<"CloudComputerId">(),
  state: WorkAssignmentStateSchema,
  homeStatus,
  reason: z.string().min(1).max(1000).nullable(),
  address: z.url({ protocol: /^https$/u }).nullable(),
  policyRevision: WorkPolicyRevisionSchema,
  appliedRevision: sequence,
  policyStatus: z.enum(["Applied", "Pending on Home"]),
  signInCut: z.boolean(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  retainUntil: instant.nullable(),
  audit: WorkAuditStatusSchema,
});
export type WorkAssignmentView = z.infer<typeof WorkAssignmentViewSchema>;
export const WorkHomeResponseSchema = z
  .strictObject({
    assignment: WorkAssignmentViewSchema.omit({ assignee: true, audit: true }),
    policy: WorkPolicySchema,
  })
  .nullable();
export type WorkHomeResponse = z.infer<typeof WorkHomeResponseSchema>;
export const OrganizationAdminResponseSchema = z.strictObject({
  ...organization,
  seats: z.strictObject({
    paid: sequence,
    assigned: sequence,
    free: sequence,
    pending: sequence.nullable(),
  }),
  billingStatus: z.enum(["active", "payment_failed", "past_due", "unpaid", "canceled", "inactive"]),
  members: z.array(z.strictObject({ ...person, role: OrganizationRoleSchema })),
  invitations: z.array(z.strictObject(invitation)),
  assignments: z.array(WorkAssignmentViewSchema),
  policy: WorkPolicySchema,
  policyRevision: WorkPolicyRevisionSchema,
});
export type OrganizationAdminResponse = z.infer<typeof OrganizationAdminResponseSchema>;
export const OrganizationCheckoutRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: OrganizationNameSchema,
  seats: OrganizationSeatQuantitySchema,
});
export const OrganizationCheckoutResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https$/u }),
});
export const OrganizationSeatsRequestSchema = z.strictObject({
  requestId: z.uuid(),
  seats: OrganizationSeatQuantitySchema,
});
export const OrganizationInviteRequestSchema = z.strictObject({
  email: IdentityEmailSchema,
  role: OrganizationRoleSchema,
});
export const OrganizationInviteResponseSchema = z.strictObject(invitation);
export const OrganizationMemberRequestSchema = z.strictObject({ role: OrganizationRoleSchema });
export const OrganizationAssignmentRequestSchema = z.strictObject({
  requestId: z.uuid(),
  accountId: ControlPlaneAccountIdSchema,
});
export const OrganizationOffboardRequestSchema = z.strictObject({
  retentionSeconds: z
    .number()
    .int()
    .min(0)
    .max(365 * 86_400),
});
export const OrganizationPolicyRequestSchema = z.strictObject({
  expectedRevision: WorkPolicyRevisionSchema,
  policy: WorkPolicySchema,
});
export const WorkAuditExportQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
});
export const accountOrganizationsPath = "/v1/account/organizations";
export const organizationWorkPath = "/v1/work-assignments";
export const WorkAuditFlushRequestSchema = z.strictObject({ assertion: z.jwt() });
export const workAuditFlushPath = "/v1/managed-home/work-audit/flush";
export const WorkAuditFlushClaimsSchema = z.strictObject({
  tokenUse: z.literal("opensteer-work-audit-flush"),
  iss: z.url(),
  aud: z.url(),
  assignmentId: WorkAssignmentIdSchema,
  deploymentId: DeploymentIdSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
