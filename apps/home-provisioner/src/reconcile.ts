import { refused } from "@opensteer/core";
import type {
  CloudComputerCheck,
  CloudComputerDesired,
  CloudComputerId,
  CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { accountRefused, type AccountApi } from "./account.js";
import { renderUserData } from "./boot.js";
import type { DiscoverHome } from "./discovery.js";
import type { DnsProvider, VmProvider, VmServer } from "./provider.js";

type Failure = NonNullable<CloudComputerReport["lastError"]>;
class Superseded extends Error {}

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
  readonly orphanGraceMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

export class Reconciler {
  readonly #options: ReconcilerOptions;
  readonly #reports = new Map<CloudComputerId, string>();
  readonly #orphanSeen = new Map<string, number>();
  readonly #now: () => number;
  #nextSweep = 0;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async pass(shutdown: AbortSignal): Promise<void> {
    const { account, provider, concurrency } = this.#options;
    const abort = new AbortController();
    const signal = AbortSignal.any([shutdown, abort.signal]);
    await account.acquire(signal);
    const desired = await account.desired(signal);
    const ids = new Set(desired.map(({ id }) => id));
    for (const id of this.#reports.keys()) if (!ids.has(id)) this.#reports.delete(id);

    let firewall: Promise<number> | undefined;
    let failed = false;
    const queue = desired.values();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, desired.length) }, async () => {
        while (!signal.aborted) {
          const next = queue.next();
          if (next.done) return;
          try {
            const computer = next.value;
            const report = await this.#apply(
              computer,
              (operationSignal, check) =>
                (firewall ??= provider.ensureFirewall(operationSignal, check)),
              signal,
            );
            const key = JSON.stringify(report);
            if (this.#reports.get(computer.id) === key) continue;
            this.#reports.delete(computer.id);
            if (await account.report(report, signal)) this.#reports.set(computer.id, key);
          } catch (error) {
            if (error instanceof Superseded) continue;
            if (accountRefused(error)) abort.abort(error);
            this.#options.onError?.(error);
            failed = true;
          }
        }
      }),
    );
    signal.throwIfAborted();
    if (this.#now() >= this.#nextSweep) {
      await this.#sweep(ids, signal);
      this.#nextSweep = this.#now() + 60_000;
    }
    if (failed)
      throw refused("internal", "Could not report one or more Cloud Computers to Account");
  }

  async #check(id: CloudComputerId, check: CloudComputerCheck, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!(await this.#options.account.check(id, check, signal))) throw new Superseded();
    signal.throwIfAborted();
  }

  async #sweep(active: ReadonlySet<CloudComputerId>, signal: AbortSignal) {
    const { provider, dns, orphanGraceMs = 5 * 60_000 } = this.#options;
    const [servers, records] = await Promise.all([
      provider.listManaged(signal),
      dns.listManaged(signal),
    ]);
    const present = new Set<string>();
    const clean = async (
      key: string,
      id: CloudComputerId,
      action: (signal: AbortSignal) => Promise<void>,
    ) => {
      if (active.has(id)) return;
      present.add(key);
      const now = this.#now();
      if (!this.#orphanSeen.has(key)) this.#orphanSeen.set(key, now);
      if (now - this.#orphanSeen.get(key)! < orphanGraceMs) return;
      const job = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      try {
        await this.#check(id, { operation: "orphan" }, job);
        await action(job);
      } catch (error) {
        if (accountRefused(error)) throw error;
        if (!(error instanceof Superseded)) this.#options.onError?.(error);
      }
    };
    for (const { id, hostname } of records)
      await clean(`dns:${hostname}`, id, (job) =>
        dns.removeRecords(hostname, job, () => this.#check(id, { operation: "orphan" }, job)),
      );
    for (const { id, server } of servers) {
      if (server.status !== "deleting")
        await clean(`vm:${server.id}`, id, (job) =>
          provider.delete(server.id, job, () => this.#check(id, { operation: "orphan" }, job)),
        );
    }
    for (const key of this.#orphanSeen.keys()) if (!present.has(key)) this.#orphanSeen.delete(key);
  }

  async #apply(
    computer: CloudComputerDesired,
    ensureFirewall: (signal: AbortSignal, check: () => Promise<void>) => Promise<number>,
    signal: AbortSignal,
  ): Promise<CloudComputerReport> {
    const { account, provider, dns, discover } = this.#options;
    const { id, generation, revision, state, hostname } = computer;
    let current: VmServer | undefined;
    const report = (
      phase: CloudComputerReport["phase"],
      lastError: Failure | null = null,
    ): CloudComputerReport => ({
      id,
      generation,
      revision,
      phase,
      lastError,
      providerServerId: phase === "deleted" ? null : (current?.id ?? null),
      ipv4: phase === "deleted" ? null : (current?.ipv4 ?? null),
      ipv6: phase === "deleted" || !computer.ipv6Enabled ? null : (current?.ipv6 ?? null),
      observedIdentity: phase === "deleted" ? null : (computer.observedIdentity ?? null),
    });
    const unready = (phase: "provisioning" | "booting") =>
      computer.readinessStartedAt &&
      this.#now() - Date.parse(computer.readinessStartedAt) >= this.#options.readinessTimeoutMs
        ? report("failed", "The Cloud Computer did not become ready before its deadline.")
        : report(phase);
    const act = async <T>(
      action: (job: AbortSignal, check: () => Promise<void>) => Promise<T>,
      create = false,
    ) => {
      const job = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const check = () =>
        this.#check(id, { operation: create ? "create" : "mutate", revision }, job);
      await check();
      return action(job, check);
    };
    const withdraw = () => act((job, check) => dns.removeRecords(hostname, job, check));
    let failure: Failure = "The Cloud Computer provider operation failed.";

    try {
      const servers = await provider.find(id, signal, computer);
      if (servers.some((server) => server.generation > generation)) {
        return report("failed", "The provider has a newer Cloud Computer generation.");
      }
      const matching = servers.filter((server) => server.generation === generation);
      const previous = servers.filter((server) => server.generation < generation);
      current = matching[0];

      if (state !== "active") {
        failure = "The Cloud Computer DNS operation failed.";
        await withdraw();
        failure = "The Cloud Computer provider operation failed.";
        let settled = true;
        for (const server of servers) {
          if (state === "suspended" && server.status === "off") continue;
          if (server.status !== "deleting") {
            if (state === "deleted")
              await act((job, check) => provider.delete(server.id, job, check));
            else await act((job, check) => provider.powerOff(server.id, job, check));
          }
          const observed = await provider.describe(server.id, signal);
          if (current?.id === server.id) current = observed;
          if (observed && (state === "deleted" || observed.status !== "off")) settled = false;
        }
        if (state === "deleted") return report(settled ? "deleted" : "deleting");
        return report(settled ? "suspended" : "provisioning");
      }

      if (matching.length > 1)
        return report("failed", "The Cloud Computer has more than one server for this generation.");
      if (current?.status === "deleting") return unready("provisioning");
      if (!current && !computer.bootstrapToken)
        return report("failed", "A bootstrap token is required to create this Cloud Computer.");
      if (previous.some((server) => server.status !== "off")) {
        failure = "The Cloud Computer DNS operation failed.";
        await withdraw();
        failure = "The Cloud Computer provider operation failed.";
        for (const old of previous) {
          if (old.status === "deleting") return unready("provisioning");
          if (old.status !== "off") {
            await act((job, check) => provider.powerOff(old.id, job, check));
            const observed = await provider.describe(old.id, signal);
            if (observed && observed.status !== "off") return unready("provisioning");
          }
        }
      }

      const firewallId = await act((job, check) => ensureFirewall(job, check));
      if (!current && computer.bootstrapToken) {
        const userData = renderUserData({
          cloudComputerId: id,
          hostname,
          accountOrigin: this.#options.accountOrigin.origin,
          installerUrl: computer.release.installerUrl,
          installerSha256: computer.release.installerSha256,
          bootstrapToken: computer.bootstrapToken,
        });
        current = await act(
          (job, check) =>
            provider.create(
              {
                id,
                generation,
                region: computer.region ?? this.#options.defaultRegion,
                serverType: computer.serverType ?? this.#options.defaultServerType,
                image: this.#options.image,
                firewallId,
                userData,
              },
              job,
              check,
            ),
          true,
        );
      }
      if (!current) return unready("provisioning");
      if (computer.providerServerId !== current.id) {
        // Start the credential clock durably before the stopped VM can make a boot request.
        if (!(await account.report(report("provisioning"), signal))) throw new Superseded();
      }

      const server = current;
      if (
        !(await act((job, check) =>
          provider.ensureFirewallAttached(server, firewallId, job, check),
        ))
      )
        return unready("provisioning");
      if (current.status === "off") {
        await act((job, check) => provider.powerOn(server.id, job, check));
        current = await provider.describe(server.id, signal);
      }
      if (current?.status !== "running") return unready("provisioning");
      const addresses = { ipv4: current.ipv4, ipv6: computer.ipv6Enabled ? current.ipv6 : null };
      if (!addresses.ipv4 && !addresses.ipv6) return unready("provisioning");

      const pinned = computer.bootCompleted ? computer.observedIdentity : undefined;
      const replies = pinned
        ? await Promise.all(
            [addresses.ipv4, addresses.ipv6]
              .filter((ip) => ip !== null)
              .map((ip) => discover(hostname, ip, signal)),
          )
        : [];
      if (
        pinned &&
        replies.some(
          (identity) =>
            identity &&
            (identity.deploymentId !== pinned.deploymentId ||
              identity.hostKeyFingerprint !== pinned.hostKeyFingerprint),
        )
      ) {
        failure = "The Cloud Computer DNS operation failed.";
        await withdraw();
        return report(
          "failed",
          "The Cloud Computer reported a different Home identity for this generation.",
        );
      }
      failure = "The Cloud Computer DNS operation failed.";
      await act((job, check) => dns.ensureRecords(hostname, addresses, job, check));
      if (!replies.length || replies.some((identity) => !identity)) return unready("booting");

      failure = "The Cloud Computer provider operation failed.";
      for (const old of previous) {
        if (old.status !== "deleting")
          await act((job, check) => provider.delete(old.id, job, check));
        if (await provider.describe(old.id, signal)) return unready("booting");
      }
      return report("ready");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Superseded || accountRefused(error)) throw error;
      this.#options.onError?.(error);
      return report("failed", failure);
    }
  }
}
