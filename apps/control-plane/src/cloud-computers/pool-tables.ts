import type { ColumnType, Generated } from "kysely";
import type {
  BrowserPoolHostId,
  BrowserPoolHostPhase,
  BrowserPoolHostProviderWrite,
  BrowserPoolHostRelease,
  BrowserPoolHostReport,
  BrowserPoolHostState,
  BrowserPoolSlotAgentWrite,
  BrowserPoolSlotId,
  BrowserPoolSlotPhase,
  BrowserPoolSlotReport,
  BrowserPoolSlotState,
  CloudComputerId,
  GoogleComputeServerRef,
} from "@opensteer/control-plane-protocol";
import type { NullableTimestamp, Timestamp } from "../database/schema.js";

/** S1: browser pool host record. Ports 7310/7311/7312 are configuration, not database columns. */
export interface BrowserPoolHostTable {
  id: BrowserPoolHostId;
  generation: number;
  revision: Generated<number>;
  state: BrowserPoolHostState;
  phase: BrowserPoolHostPhase;
  region: string;
  machineType: string;
  slotsCapacity: number;
  profileDiskName: string;
  profileDiskSizeGb: number;
  profileDiskRef: string | null;
  release: ColumnType<BrowserPoolHostRelease, string, string>;
  providerServerRef: GoogleComputeServerRef | null;
  previousProviderServerRef: GoogleComputeServerRef | null;
  internalIp: string | null;
  bootstrapDigest: string | null;
  sealedBootstrapToken: string | null;
  bootstrapExpiresAt: NullableTimestamp;
  completedBootDigest: string | null;
  enrolledAt: NullableTimestamp;
  hostPublicKey: string | null;
  relayPublicKey: string | null;
  pendingProviderWrites: ColumnType<BrowserPoolHostProviderWrite[], string | undefined, string>;
  readinessStartedAt: Timestamp;
  lastError: BrowserPoolHostReport["lastError"];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  reportedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
  tombstonedAt: NullableTimestamp;
}

/** S1: one browser slot row per pooled Cloud Computer for its entire life (`computer_id` unique). */
export interface BrowserPoolSlotTable {
  slotId: BrowserPoolSlotId;
  computerId: CloudComputerId;
  hostId: BrowserPoolHostId | null;
  term: number;
  appliedTerm: number | null;
  appliedHostGeneration: number | null;
  revision: Generated<number>;
  state: BrowserPoolSlotState;
  phase: BrowserPoolSlotPhase;
  homeKey: string | null;
  relayKey: string | null;
  ticketKeyId: string | null;
  ticketKeySpki: string | null;
  keysRegisteredAt: NullableTimestamp;
  controlKey: string | null;
  guestVcpus: number;
  guestMemoryMib: number;
  profileMib: number;
  pendingAgentWrites: ColumnType<BrowserPoolSlotAgentWrite[], string | undefined, string>;
  deletionRequestedAt: NullableTimestamp;
  slotErasedAt: NullableTimestamp;
  profileErasedAt: NullableTimestamp;
  credentialsErasedAt: NullableTimestamp;
  lastError: BrowserPoolSlotReport["lastError"];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: NullableTimestamp;
  tombstonedAt: NullableTimestamp;
}
