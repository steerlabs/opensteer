import type { ColumnType, Generated } from "kysely";
import type {
  ControlPlaneAccountId,
  OrganizationId,
  OrganizationInvitationId,
  OrganizationRole,
  WorkAssignmentId,
  WorkPolicy,
  CloudComputerId,
} from "@opensteer/control-plane-protocol";
import type { NullableTimestamp, Timestamp } from "../database/schema.js";
import type { BillingStatus } from "../cloud-computers/tables.js";

export interface OrganizationTable {
  id: OrganizationId;
  name: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  billingCurrency: string;
  billingStatus: BillingStatus;
  paidSeats: number;
  pendingSeats: number | null;
  pendingSeatRequestId: string | null;
  pendingSeatSince: NullableTimestamp;
  policy: ColumnType<WorkPolicy, string, string>;
  policyRevision: Generated<number>;
  createdAt: Timestamp;
}

export interface OrganizationMemberTable {
  organizationId: OrganizationId;
  accountId: ControlPlaneAccountId;
  role: OrganizationRole;
  createdAt: Timestamp;
}

export interface OrganizationInvitationTable {
  id: OrganizationInvitationId;
  organizationId: OrganizationId;
  email: string;
  role: OrganizationRole;
  createdAt: Timestamp;
  acceptedAt: NullableTimestamp;
}

export interface OrganizationCheckoutTable {
  organizationId: OrganizationId;
  founderAccountId: ControlPlaneAccountId | null;
  requestId: string;
  name: string;
  seats: number;
  stripePriceId: string;
  currency: string;
  createdAt: Timestamp;
  sessionId: string | null;
  url: string | null;
  status: "open" | "completed" | "expired";
}

export interface WorkAssignmentTable {
  id: WorkAssignmentId;
  organizationId: OrganizationId;
  assigneeAccountId: ControlPlaneAccountId | null;
  cloudComputerId: CloudComputerId;
  requestId: string;
  state: "active" | "offboarding" | "ended";
  createdAt: Timestamp;
  signInCutAt: NullableTimestamp;
  flushUntil: NullableTimestamp;
  retainUntil: NullableTimestamp;
  suspendedAt: NullableTimestamp;
  endedAt: NullableTimestamp;
  appliedRevision: Generated<number>;
  auditSequence: Generated<number>;
  auditHeadHash: Generated<string>;
  auditReceivedAt: NullableTimestamp;
  auditGapReceived: number | null;
}

export interface WorkAuditRecordTable {
  assignmentId: WorkAssignmentId;
  sequence: number;
  canonicalRecord: string;
  hash: string;
  receivedAt: Timestamp;
}

export interface WorkAuditBatchTable {
  assignmentId: WorkAssignmentId;
  fromSequence: number;
  lastSequence: number;
  headHash: string;
  signature: string;
}
