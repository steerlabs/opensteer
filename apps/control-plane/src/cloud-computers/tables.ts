import type { ColumnType, Generated } from "kysely";
import type {
  CloudComputerDesired,
  CloudComputerId,
  CloudComputerProviderWrite,
  CloudComputerReport,
  GoogleComputeServerRef,
  WorkAssignmentId,
  OrganizationId,
  ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import type { NullableTimestamp, Timestamp } from "../database/schema.js";
import type { CloudComputerConfig } from "./config.js";

export type BillingStatus =
  "active" | "payment_failed" | "past_due" | "unpaid" | "canceled" | "inactive";

export interface CloudComputerTable {
  id: CloudComputerId;
  accountId: ControlPlaneAccountId | null;
  workAssignmentId: Generated<WorkAssignmentId | null>;
  generation: number;
  state: CloudComputerDesired["state"];
  hostname: string;
  region: string;
  serverType: string;
  release: ColumnType<CloudComputerConfig["release"], string, string>;
  setupCodeDigest: string | null;
  sealedSetupCode: string | null;
  bootstrapDigest: string | null;
  sealedBootstrapToken: string | null;
  bootstrapExpiresAt: NullableTimestamp;
  backupKeyProject: Generated<string | null>;
  backupKeyVersion: Generated<number | null>;
  bootstrapReceipt: ColumnType<unknown, string | null, string | null>;
  bootstrapReceiptAt: NullableTimestamp;
  oidcClientId: string | null;
  sealedOidcClientSecret: string | null;
  sealedHostCredential: string | null;
  claimAttempt: Generated<number>;
  claimNextAt: NullableTimestamp;
  claimError: string | null;
  readinessStartedAt: Timestamp;
  phase: CloudComputerReport["phase"];
  providerServerId: string | null;
  providerServerRef: Generated<GoogleComputeServerRef | null>;
  ipv4: string | null;
  ipv6: string | null;
  deploymentId: string | null;
  hostKeyFingerprint: string | null;
  lastError: CloudComputerReport["lastError"];
  operatorSuspension: string | null;
  ownerSuspended: Generated<boolean>;
  egressUnavailable: Generated<boolean>;
  stripeCheckoutId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  billingCurrency: string;
  billingStatus: BillingStatus;
  renewsAt: Generated<Date | null>;
  revision: Generated<number>;
  everReady: Generated<boolean>;
  generationReady: Generated<boolean>;
  dnsQuarantined: Generated<boolean>;
  createAttempted: Generated<boolean>;
  bootCompletedAt: NullableTimestamp;
  lastBackupAt: Generated<Date | null>;
  lastBackupSnapshotId: Generated<string | null>;
  completedBootDigest: string | null;
  previousProviderServerId: string | null;
  previousProviderServerRef: Generated<GoogleComputeServerRef | null>;
  restoreSnapshot: string | null;
  ipv6Enabled: Generated<boolean>;
  deletionRequestedAt: NullableTimestamp;
  /** Set once the billing pass settled this computer's deletion with Stripe; see `reconcileBilling`. */
  billingSettledAt: Generated<Date | null>;
  vmDestroyedAt: Generated<Date | null>;
  backupsUnreadableAt: Generated<Date | null>;
  backupObjectsRemovedAt: Generated<Date | null>;
  backupCleanupAttemptedAt: Generated<Date | null>;
  ownerAccessAt: Generated<Date | null>;
  pendingProviderWrites: ColumnType<CloudComputerProviderWrite[], string | undefined, string>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  reportedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
  tombstonedAt: NullableTimestamp;
}

export interface CloudComputerCheckoutTable {
  accountId: ControlPlaneAccountId;
  requestId: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  lastStripeAttemptAt: NullableTimestamp;
  targetComputerId: CloudComputerId | null;
  paidAt: Generated<Date | null>;
  returnUrl: Generated<string | null>;
  stripeSessionId: string | null;
  url: string | null;
  stripePriceId: string;
  currency: string;
  status: "open" | "completed" | "expired" | "refunded";
}

export interface CloudComputerEgressEndpointTable {
  id: string;
  url: string;
  username: string;
  sealedPassword: string;
  publicAddress: Generated<string | null>;
  retired: Generated<boolean>;
  needsRotation: Generated<boolean>;
  computerId: CloudComputerId | null;
}

export interface CloudComputerStripeEventTable {
  id: string;
  type: string;
  receivedAt: Timestamp;
  deferredCheckout: ColumnType<unknown, string | null | undefined, string | null>;
}

export interface CloudComputerBackupTargetTable {
  id: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  principalFingerprint: string;
  region: Generated<string>;
  sealedCredentials: string;
  computerId: CloudComputerId | null;
  checkoutKey: string | null;
  purgeComputerId: Generated<CloudComputerId | null>;
  reservedOrganizationId: Generated<OrganizationId | null>;
  organizationReservationRequestId: Generated<string | null>;
  needsRotation: Generated<boolean>;
}

export interface CloudComputerBackupNamespaceTable {
  endpoint: string;
  bucket: string;
  prefix: string;
  principalFingerprint: string;
}
