import type { ColumnType, Generated } from "kysely";
import type {
  CloudComputerDesired,
  CloudComputerId,
  CloudComputerReport,
  ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import type { NullableTimestamp, Timestamp } from "../database/schema.js";
import type { CloudComputerConfig } from "./config.js";

export type BillingStatus =
  "active" | "payment_failed" | "past_due" | "unpaid" | "canceled" | "inactive";

export interface CloudComputerTable {
  id: CloudComputerId;
  accountId: ControlPlaneAccountId | null;
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
  sealedBackupPassword: string | null;
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
  revision: Generated<number>;
  everReady: Generated<boolean>;
  createAttempted: Generated<boolean>;
  bootCompletedAt: NullableTimestamp;
  completedBootDigest: string | null;
  previousProviderServerId: string | null;
  restoreSnapshot: string | null;
  ipv6Enabled: Generated<boolean>;
  deletionRequestedAt: NullableTimestamp;
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
  stripeSessionId: string | null;
  url: string | null;
  stripePriceId: string;
  currency: string;
  status: "open" | "completed" | "expired";
}

export interface CloudComputerEgressEndpointTable {
  id: string;
  url: string;
  username: string;
  sealedPassword: string;
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
  sealedCredentials: string;
  computerId: CloudComputerId | null;
  checkoutKey: string | null;
  needsRotation: Generated<boolean>;
}
