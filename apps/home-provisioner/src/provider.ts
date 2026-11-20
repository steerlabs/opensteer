import type {
  CloudComputerId,
  CloudComputerProviderWrite,
} from "@opensteer/control-plane-protocol";

export interface Addresses {
  readonly ipv4: string | null;
  readonly ipv6: string | null;
}

export interface VmServer extends Addresses {
  readonly id: number;
  readonly generation: number;
  readonly status: "running" | "off" | "transitioning" | "deleting";
  readonly firewalls: readonly { id: number; status: "applied" | "pending" }[];
}

export interface CreateVm {
  readonly id: CloudComputerId;
  readonly generation: number;
  readonly region: string;
  readonly serverType: string;
  readonly image: string | number;
  readonly userData: string;
  readonly firewallId: number;
}

export interface VmProvider {
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
    expected?: {
      generation: number;
      providerServerId?: number | undefined;
      previousProviderServerId?: number | undefined;
      pendingProviderWrites?: CloudComputerProviderWrite[] | undefined;
    },
  ): Promise<readonly VmServer[]>;
  listManaged(signal: AbortSignal): Promise<readonly { id: CloudComputerId; server: VmServer }[]>;
  create(input: CreateVm, signal: AbortSignal, check?: () => Promise<void>): Promise<VmServer>;
  describe(
    id: number,
    signal: AbortSignal,
    knownGeneration?: number,
  ): Promise<VmServer | undefined>;
  powerOn(id: number, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
  powerOff(id: number, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
  delete(id: number, signal: AbortSignal, check?: () => Promise<void>): Promise<void>;
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
