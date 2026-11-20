import type { CloudComputerId } from "@opensteer/control-plane-protocol";

export interface Addresses {
  readonly ipv4: string | null;
  readonly ipv6: string | null;
}

export interface VmServer extends Addresses {
  readonly id: number;
  readonly generation: number;
  readonly status: "running" | "off" | "transitioning";
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
  ensureFirewall(signal: AbortSignal): Promise<number>;
  ensureFirewallAttached(
    server: VmServer,
    firewallId: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  find(id: CloudComputerId, signal: AbortSignal): Promise<readonly VmServer[]>;
  create(input: CreateVm, signal: AbortSignal): Promise<VmServer>;
  describe(id: number, signal: AbortSignal): Promise<VmServer | undefined>;
  powerOn(id: number, signal: AbortSignal): Promise<void>;
  powerOff(id: number, signal: AbortSignal): Promise<void>;
  delete(id: number, signal: AbortSignal): Promise<void>;
}

export interface DnsProvider {
  ensureRecords(hostname: string, addresses: Addresses, signal: AbortSignal): Promise<void>;
  removeRecords(hostname: string, signal: AbortSignal): Promise<void>;
}
