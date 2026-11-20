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
  computerId: CloudComputerId | null;
}

export interface CloudComputerStripeEventTable {
  id: string;
  type: string;
  receivedAt: Timestamp;
}
