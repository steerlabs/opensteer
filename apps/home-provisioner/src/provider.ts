import type {
  CloudComputerId,
  CloudComputerProviderWrite,
  GoogleComputeServerRef,
} from "@opensteer/control-plane-protocol";

export interface Addresses {
  readonly ipv4: string | null;
  readonly ipv6: string | null;
}

export type VmServerId = number | GoogleComputeServerRef;

export interface VmAddress {
  readonly id: CloudComputerId;
  readonly generation: number;
}

export interface VmServer<Id extends VmServerId = VmServerId> extends Addresses {
  readonly id: Id;
  readonly generation: number;
  readonly status: "running" | "off" | "transitioning" | "deleting";
  readonly firewalls: readonly { id: number; status: "applied" | "pending" }[];
  readonly bootstrapMetadata?: "pending" | "enabled" | "absent";
}

export interface CreateVm {
  readonly id: CloudComputerId;
  readonly generation: number;
  readonly region: string;
  readonly serverType: string;
  readonly image: string | number;
  readonly userData: string;
  readonly firewallId: number;
  readonly requestId?: string;
}

export interface ExpectedVm {
  generation: number;
  providerServerId?: number | undefined;
  previousProviderServerId?: number | undefined;
  providerServerRef?: GoogleComputeServerRef | undefined;
  previousProviderServerRef?: GoogleComputeServerRef | undefined;
  pendingProviderWrites?: CloudComputerProviderWrite[] | undefined;
}

export interface VmProvider {
  validatePlacement?(signal: AbortSignal): Promise<void>;
  ensureFirewall(signal: AbortSignal, check?: () => Promise<void>): Promise<number>;
  ensureFirewallAttached(
    server: VmServer,
    firewallId: number,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<boolean>;
  find(
    id: CloudComputerId,
    signal: AbortSignal,
    expected?: ExpectedVm,
  ): Promise<readonly VmServer[]>;
  listManaged(signal: AbortSignal): Promise<readonly { id: CloudComputerId; server: VmServer }[]>;
  create(input: CreateVm, signal: AbortSignal, check?: () => Promise<void>): Promise<VmServer>;
  describe(
    id: VmServerId,
    signal: AbortSignal,
    knownGeneration?: number,
  ): Promise<VmServer | undefined>;
  powerOn(
    id: VmServerId,
    signal: AbortSignal,
    check?: () => Promise<void>,
    requestId?: string,
  ): Promise<void>;
  powerOff(id: VmServerId, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
  delete(id: VmServerId, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
  listManagedAddresses?(signal: AbortSignal): Promise<readonly VmAddress[]>;
  releaseAddress?(
    address: VmAddress,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<boolean>;
  canRecoverWrite?(write: CloudComputerProviderWrite, signal: AbortSignal): Promise<boolean>;
  updateBootstrap?(
    id: VmServerId,
    receiptRecorded: boolean,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<boolean>;
}

export type PublishDnsWrite = (
  type: "A" | "AAAA",
  send: (token: string) => Promise<void>,
) => Promise<void>;

export interface DnsProvider {
  ensureRecords(
    hostname: string,
    addresses: Addresses,
    signal: AbortSignal,
    check?: () => Promise<void>,
    publish?: PublishDnsWrite,
  ): Promise<void>;
  removeRecords(
    hostname: string,
    signal: AbortSignal,
    check?: () => Promise<void>,
    observed?: (token: string) => Promise<void>,
  ): Promise<void>;
  observeWrites?(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  listManaged(signal: AbortSignal): Promise<readonly { id: CloudComputerId; hostname: string }[]>;
}
