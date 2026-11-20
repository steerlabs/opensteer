import { refused } from "@opensteer/core";
import type {
  CloudComputerDesired,
  CloudComputerId,
  CloudComputerIdentity,
  CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { accountRefused, type AccountApi } from "./account.js";
import { renderUserData } from "./boot.js";
import type { DiscoverHome } from "./discovery.js";
import type { DnsProvider, VmProvider, VmServer } from "./provider.js";

type Failure = NonNullable<CloudComputerReport["lastError"]>;

interface ReconcilerOptions {
  readonly account: AccountApi;
  readonly provider: VmProvider;
  readonly dns: DnsProvider;
  readonly discover: DiscoverHome;
  readonly accountOrigin: URL;
  readonly image: string | number;
  readonly defaultRegion: string;
  readonly defaultServerType: string;
  readonly readinessTimeoutMs: number;
  readonly concurrency: number;
  readonly now?: () => number;
}

interface Observation {
  readonly generation: number;
  readonly readinessStartedAt: string | undefined;
  unreadySince: number | undefined;
  identity: CloudComputerIdentity | undefined;
  reported: string | undefined;
}

export class Reconciler {
  readonly #options: ReconcilerOptions;
  readonly #observations = new Map<CloudComputerId, Observation>();
  readonly #now: () => number;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async pass(shutdown: AbortSignal): Promise<void> {
    const { account, provider, concurrency } = this.#options;
    const abort = new AbortController();
    const signal = AbortSignal.any([shutdown, abort.signal]);
    const desired = await account.desired(signal);
    const ids = new Set(desired.map(({ id }) => id));
    for (const id of this.#observations.keys()) {
      if (!ids.has(id)) this.#observations.delete(id);
    }

    let firewall: Promise<number> | undefined;
    const ensureFirewall = () => (firewall ??= provider.ensureFirewall(signal));
    let reportFailed = false;
    const queue = desired.values();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, desired.length) }, async () => {
        while (!signal.aborted) {
          const next = queue.next();
          if (next.done) return;
          try {
            await this.#reconcile(next.value, ensureFirewall, signal);
          } catch (error) {
            if (accountRefused(error)) abort.abort(error);
            reportFailed = true;
          }
        }
      }),
    );
    signal.throwIfAborted();
    if (reportFailed) {
      throw refused("internal", "Could not report one or more Cloud Computers to Account");
    }
  }

  async #reconcile(
    computer: CloudComputerDesired,
    ensureFirewall: () => Promise<number>,
    signal: AbortSignal,
  ) {
    const { id, generation } = computer;
    let observation = this.#observations.get(id);
    if (observation && observation.generation > generation) return;
    if (
      !observation ||
      observation.generation !== generation ||
      observation.readinessStartedAt !== computer.readinessStartedAt
    ) {
      observation = {
        generation,
        readinessStartedAt: computer.readinessStartedAt,
        identity: observation?.generation === generation ? observation.identity : undefined,
        unreadySince: undefined,
        reported: undefined,
      };
      this.#observations.set(id, observation);
    }
    if (computer.observedIdentity) observation.identity = computer.observedIdentity;

    const report = await this.#apply(computer, observation, ensureFirewall, signal);
    signal.throwIfAborted();
    const key = JSON.stringify(report);
    if (observation.reported === key) return;
    observation.reported = undefined;
    await this.#options.account.report(report, signal);
    observation.reported = key;
  }

  async #apply(
    computer: CloudComputerDesired,
    observation: Observation,
    ensureFirewall: () => Promise<number>,
    signal: AbortSignal,
  ): Promise<CloudComputerReport> {
    const { provider, dns, discover } = this.#options;
    const { id, generation, state, hostname } = computer;
    let current: VmServer | undefined;
    const report = (
      phase: CloudComputerReport["phase"],
      lastError: Failure | null = null,
    ): CloudComputerReport => ({
      id,
      generation,
      phase,
      lastError,
      providerServerId: phase === "deleted" ? null : (current?.id ?? null),
      ipv4: phase === "deleted" ? null : (current?.ipv4 ?? null),
      ipv6: phase === "deleted" ? null : (current?.ipv6 ?? null),
      observedIdentity: phase === "deleted" ? null : (observation.identity ?? null),
    });
    const unready = (phase: "provisioning" | "booting") =>
      this.#now() - (observation.unreadySince ?? this.#now()) >= this.#options.readinessTimeoutMs
        ? report("failed", "The Cloud Computer did not become ready before its deadline.")
        : report(phase);
    let failure: Failure = "The Cloud Computer provider operation failed.";

    try {
      const servers = await provider.find(id, signal);
      if (servers.some((server) => server.generation > generation)) {
        return report("failed", "The provider has a newer Cloud Computer generation.");
      }
      const matching = servers.filter((server) => server.generation === generation);
      current = matching[0];

      if (state !== "active") {
        observation.unreadySince = undefined;
        if (state === "suspended") {
          let off = true;
          for (const server of servers) {
            if (server.status === "off") continue;
            if (server.status === "running") await provider.powerOff(server.id, signal);
            const observed = await provider.describe(server.id, signal);
            if (current?.id === server.id) current = observed;
            if (observed && observed.status !== "off") off = false;
          }
          return report(off ? "suspended" : "provisioning");
        }

        failure = "The Cloud Computer DNS operation failed.";
        await dns.removeRecords(hostname, signal);
        failure = "The Cloud Computer provider operation failed.";
        let gone = true;
        for (const server of servers) {
          await provider.delete(server.id, signal);
          const observed = await provider.describe(server.id, signal);
          if (current?.id === server.id) current = observed;
          if (observed) gone = false;
        }
        return report(gone ? "deleted" : "deleting");
      }

      if (matching.length > 1) {
        return report("failed", "The Cloud Computer has more than one server for this generation.");
      }

      if (!current && !computer.bootstrapToken) {
        return report("failed", "A bootstrap token is required to create this Cloud Computer.");
      }

      const now = this.#now();
      const initialStart =
        !observation.identity && computer.readinessStartedAt
          ? Math.min(now, Date.parse(computer.readinessStartedAt))
          : now;
      observation.unreadySince ??= initialStart;
      const firewallId = await ensureFirewall();
      if (!current && computer.bootstrapToken) {
        current = await provider.create(
          {
            id,
            generation,
            region: computer.region ?? this.#options.defaultRegion,
            serverType: computer.serverType ?? this.#options.defaultServerType,
            image: this.#options.image,
            firewallId,
            userData: renderUserData({
              cloudComputerId: id,
              hostname,
              accountOrigin: this.#options.accountOrigin.origin,
              installerUrl: computer.release.installerUrl,
              installerSha256: computer.release.installerSha256,
              bootstrapToken: computer.bootstrapToken,
            }),
          },
          signal,
        );
      }
      if (!current) return unready("provisioning");

      if (!(await provider.ensureFirewallAttached(current, firewallId, signal))) {
        return unready("provisioning");
      }
      // Creation leaves the replacement off until every previous generation is confirmed gone.
      for (const old of servers.filter((server) => server.generation < generation)) {
        await provider.delete(old.id, signal);
        if (await provider.describe(old.id, signal)) return unready("provisioning");
      }

      if (current.status === "off") {
        await provider.powerOn(current.id, signal);
        current = await provider.describe(current.id, signal);
      }
      if (current?.status !== "running" || (!current.ipv4 && !current.ipv6)) {
        return unready("provisioning");
      }

      failure = "The Cloud Computer DNS operation failed.";
      await dns.ensureRecords(hostname, { ipv4: current.ipv4, ipv6: current.ipv6 }, signal);
    } catch {
      signal.throwIfAborted();
      return report("failed", failure);
    }

    const identity = await discover(hostname, signal);
    if (!identity) return unready("booting");
    const first = (observation.identity ??= identity);
    if (
      first.deploymentId !== identity.deploymentId ||
      first.hostKeyFingerprint !== identity.hostKeyFingerprint
    ) {
      return report(
        "failed",
        "The Cloud Computer reported a different Home identity for this generation.",
      );
    }
    observation.unreadySince = undefined;
    return report("ready");
  }
}
