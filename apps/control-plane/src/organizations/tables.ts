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
  billingRefreshedAt: Generated<Date | null>;
  closingAt: Generated<Date | null>;
  closedAt: Generated<Date | null>;
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
  previousSubscriptionId: Generated<string | null>;
  closeRequestedAt: Generated<Date | null>;
  returnUrl: Generated<string | null>;
  founderAccountId: ControlPlaneAccountId | null;
  requestId: string;
  name: string;
  seats: number;
  stripePriceId: string;
  currency: string;
  createdAt: Timestamp;
  sessionId: string | null;
  url: string | null;
  sentAt: Generated<Date | null>;
  expiresAt: Timestamp;
  paidAt: Generated<Date | null>;
  status: "open" | "completed" | "expired" | "refunded";
}

export interface OrganizationSeatChangeTable {
  organizationId: OrganizationId;
  requestId: string;
  subscriptionId: string;
  itemId: string;
  previousInvoiceId: string | null;
  quantity: number;
  increase: boolean;
  createdAt: Timestamp;
  invoiceId: Generated<string | null>;
  invoiceUrl: Generated<string | null>;
  expiresAt: Generated<Date | null>;
  abandonRequestedAt: Generated<Date | null>;
  status: "pending" | "applied" | "abandoned" | "expired";
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
  finalAudit: Generated<"confirmed" | "unconfirmed" | null>;
  retainUntil: NullableTimestamp;
  retentionSeconds: Generated<number>;
  offboardingCheckedAt: Generated<Date | null>;
  suspendedAt: NullableTimestamp;
  endedAt: NullableTimestamp;
  appliedRevision: Generated<number>;
  auditSequence: Generated<number>;
  auditHeadHash: Generated<string>;
  auditReceivedAt: NullableTimestamp;
  auditGapReceived: number | null;
  auditGapExpected: Generated<number | null>;
  auditGapThrough: Generated<number | null>;
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
