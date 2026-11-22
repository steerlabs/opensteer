import type {
  BrowserPoolHostError,
  BrowserPoolHostId,
  BrowserPoolHostPhase,
  BrowserPoolHostProviderWrite,
  BrowserPoolHostRelease,
  BrowserPoolHostState,
  BrowserPoolSlotAgentWrite,
  BrowserPoolSlotError,
  BrowserPoolSlotId,
  BrowserPoolSlotPhase,
  BrowserPoolSlotState,
  CloudComputerId,
} from "@opensteer/control-plane-protocol";
import type { ColumnType, Generated } from "kysely";

export interface BrowserPoolHostTable {
  readonly id: BrowserPoolHostId;
  readonly generation: number;
  readonly revision: Generated<number>;
  readonly state: BrowserPoolHostState;
  readonly phase: BrowserPoolHostPhase;
  readonly machineType: string;
  readonly slotsCapacity: number;
  readonly profileDiskName: string;
  readonly profileDiskSizeGb: number;
  readonly profileDiskRef: string | null;
  readonly release: ColumnType<BrowserPoolHostRelease, string, string>;
  readonly providerServerRef: string | null;
  readonly previousProviderServerRef: string | null;
  readonly internalIp: string | null;
  readonly bootstrapDigest: string | null;
  readonly sealedBootstrapToken: string | null;
  readonly bootstrapExpiresAt: Date | null;
  readonly completedBootDigest: string | null;
  readonly enrolledAt: Date | null;
  readonly everEnrolled: boolean;
  readonly autoReplaceCount: number;
  readonly hostPublicKey: string | null;
  readonly relayPublicKey: string | null;
  readonly pendingProviderWrites: ColumnType<
    readonly BrowserPoolHostProviderWrite[],
    string,
    string
  >;
  readonly readinessStartedAt: Date | null;
  readonly lastError: BrowserPoolHostError | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly tombstonedAt: Date | null;
}

export interface BrowserPoolSlotTable {
  readonly slotId: BrowserPoolSlotId;
  readonly computerId: CloudComputerId;
  readonly hostId: BrowserPoolHostId | null;
  readonly term: number;
  readonly appliedTerm: number | null;
  readonly appliedHostGeneration: number | null;
  readonly revision: Generated<number>;
  readonly state: BrowserPoolSlotState;
  readonly phase: BrowserPoolSlotPhase;
  readonly homeKey: string | null;
  readonly relayKey: string | null;
  readonly ticketKeyId: string | null;
  readonly ticketKeySpki: string | null;
  readonly keysRegisteredAt: Date | null;
  readonly keysIssuedAt: Date | null;
  readonly controlKey: string | null;
  readonly guestVcpus: number;
  readonly guestMemoryMib: number;
  readonly profileMib: number;
  readonly pendingAgentWrites: ColumnType<readonly BrowserPoolSlotAgentWrite[], string, string>;
  readonly slotErasedAt: Date | null;
  readonly profileErasedAt: Date | null;
  readonly credentialsErasedAt: Date | null;
  readonly failedAt: Date | null;
  readonly lastError: BrowserPoolSlotError | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly tombstonedAt: Date | null;
}
