import type {
  BrowserPoolHostId,
  BrowserPoolHostProviderWrite,
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
  readonly internalIpv4?: string | null;
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
  /** Called once at the start of every reconciler pass, before any other provider call. */
  beginPass?(signal: AbortSignal): Promise<void>;
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
  /**
   * Acquires what a new machine needs that the provider may refuse (a reserved address), before
   * the reconciler stops the machine it replaces.
   */
  prepareCreate?(input: VmAddress, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
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

export interface PoolFirewallConfig {
  readonly provisionerCidr: string;
  readonly agentPort: number;
  readonly adminPort: number;
  readonly relayPort: number;
}

export interface PoolProfileDisk {
  readonly name: string;
  readonly ref: string;
  readonly hostId: BrowserPoolHostId;
  readonly inUse: boolean;
}

export interface EnsurePoolProfileDisk {
  readonly hostId: BrowserPoolHostId;
  readonly diskName: string;
  readonly sizeGb: number;
  readonly diskType: string;
  readonly requestId?: string;
}

export interface PoolHostVm {
  readonly id: GoogleComputeServerRef;
  readonly generation: number;
  readonly status: "running" | "off" | "transitioning" | "deleting";
  readonly internalIpv4: string | null;
  readonly firewallApplied: boolean;
  readonly bootstrapMetadata?: "pending" | "enabled" | "absent";
}

export interface CreatePoolHostVm {
  readonly id: BrowserPoolHostId;
  readonly generation: number;
  readonly region: string;
  readonly machineType: string;
  readonly image: string;
  readonly bootDiskSizeGb: number;
  readonly profileDiskName: string;
  readonly localSsdCount: number;
  readonly userData: string;
  readonly requestId?: string;
}

export interface ExpectedPoolHostVm {
  readonly generation: number;
  readonly providerServerRef?: GoogleComputeServerRef | undefined;
  readonly previousProviderServerRef?: GoogleComputeServerRef | undefined;
  readonly pendingProviderWrites?: readonly BrowserPoolHostProviderWrite[] | undefined;
}

export interface PoolHostProvider {
  beginPass?(signal: AbortSignal): Promise<void>;
  ensurePoolFirewalls(
    config: PoolFirewallConfig,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<void>;
  ensurePoolProfileDisk(
    input: EnsurePoolProfileDisk,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<PoolProfileDisk>;
  findPoolProfileDisk(diskName: string, signal: AbortSignal): Promise<PoolProfileDisk | undefined>;
  deletePoolProfileDisk(
    diskName: string,
    hostId: BrowserPoolHostId,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<boolean>;
  listManagedPoolDisks(signal: AbortSignal): Promise<readonly PoolProfileDisk[]>;
  findPoolHost(
    id: BrowserPoolHostId,
    signal: AbortSignal,
    expected?: ExpectedPoolHostVm,
  ): Promise<readonly PoolHostVm[]>;
  listManagedPoolHosts(
    signal: AbortSignal,
  ): Promise<readonly { id: BrowserPoolHostId; server: PoolHostVm }[]>;
  createPoolHost(
    input: CreatePoolHostVm,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<PoolHostVm>;
  describePoolHost(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    knownGeneration?: number,
  ): Promise<PoolHostVm | undefined>;
  powerOnPoolHost(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    check?: () => Promise<void>,
    requestId?: string,
  ): Promise<void>;
  deletePoolHost(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<void>;
  updatePoolHostBootstrap?(
    id: GoogleComputeServerRef,
    enrolled: boolean,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<boolean>;
  canRecoverPoolHostWrite?(
    write: BrowserPoolHostProviderWrite,
    signal: AbortSignal,
  ): Promise<boolean>;
}
