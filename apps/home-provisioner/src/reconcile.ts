import { randomUUID } from "node:crypto";
import {
  BootstrapScrubFailure,
  ProviderOutcomeUnknown,
  ProviderRateLimited,
  ProviderWriteRejected,
} from "./http.js";
import { refused } from "@opensteer/core";
import type {
  CloudComputerCheck,
  CloudComputerDesired,
  CloudComputerId,
  CloudComputerReport,
  CloudComputerProviderWrite,
} from "@opensteer/control-plane-protocol";
import { accountRefused, type AccountApi } from "./account.js";
import { renderUserData } from "./boot.js";
import type { DiscoverHome } from "./discovery.js";
import type { DnsProvider, VmProvider, VmServer, VmServerId } from "./provider.js";

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
    await provider.beginPass?.(signal);
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
            if (error instanceof ProviderRateLimited) {
              // Later, not failed: end the pass without reporting the computers it did not reach.
              abort.abort(error);
              return;
            }
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
    const [servers, records, addresses] = await Promise.all([
      provider.listManaged(signal),
      dns.listManaged(signal),
      provider.listManagedAddresses?.(signal) ?? [],
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
        const limited = rateLimited(error);
        if (limited) throw limited;
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
    for (const address of addresses) {
      const { id, generation } = address;
      await clean(`address:${id}/${generation}`, id, async (job) => {
        await provider.releaseAddress?.(address, job, () =>
          this.#check(id, { operation: "orphan" }, job),
        );
      });
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
      providerServerId: phase !== "deleted" && typeof current?.id === "number" ? current.id : null,
      ...(phase !== "deleted" && typeof current?.id === "string"
        ? { providerServerRef: current.id }
        : {}),
      ipv4: phase === "deleted" ? null : (current?.ipv4 ?? null),
      ipv6: phase === "deleted" || !computer.ipv6Enabled ? null : (current?.ipv6 ?? null),
      observedIdentity: phase === "deleted" ? null : (computer.observedIdentity ?? null),
    });
    const unready = (phase: "provisioning" | "booting") =>
      computer.readinessStartedAt &&
      this.#now() - Date.parse(computer.readinessStartedAt) >= this.#options.readinessTimeoutMs
        ? report("failed", "The Cloud Computer did not become ready before its deadline.")
        : report(phase);
    const pending = new Map(
      (computer.pendingProviderWrites ?? []).map((write) => [write.token, write]),
    );
    const finish = async (token: string) => {
      await this.#check(id, { operation: "finish-provider-write", token }, signal);
      pending.delete(token);
    };
    const recover = async (write: CloudComputerProviderWrite) => {
      if (!write.recoverAfter || Date.parse(write.recoverAfter) > this.#now()) return;
      if (
        (write.kind === "create" || write.kind === "power-on") &&
        provider.canRecoverWrite &&
        !(await provider.canRecoverWrite(write, signal))
      )
        return;
      await this.#check(
        id,
        {
          operation: "recover-provider-write",
          revision,
          token: write.token,
        },
        signal,
      );
      pending.delete(write.token);
    };
    const observe = async (token: string) => {
      if (pending.has(token)) await finish(token);
    };
    const journal = async <T>(
      kind: CloudComputerProviderWrite["kind"],
      action: (token: string, send: (job: AbortSignal) => Promise<void>) => Promise<T>,
      serverId?: VmServerId,
    ): Promise<T> => {
      const token = randomUUID();
      const write = {
        kind,
        token,
        generation,
        ...(typeof serverId === "number" ? { serverId } : {}),
        ...(typeof serverId === "string" ? { serverRef: serverId } : {}),
      };
      await this.#check(id, { operation: "begin-provider-write", revision, write }, signal);
      pending.set(token, write);
      let result: T;
      try {
        result = await action(token, (job) =>
          this.#check(id, { operation: "send-provider-write", revision, token }, job),
        );
      } catch (error) {
        if (error instanceof ProviderWriteRejected) {
          await finish(token);
          throw error.original;
        }
        if (error instanceof Superseded) await finish(token);
        throw error;
      }
      await finish(token);
      return result;
    };
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
    const withdraw = () => act((job, check) => dns.removeRecords(hostname, job, check, observe));
    const releaseAddresses = async (beforeGeneration?: number) => {
      if (!provider.listManagedAddresses || !provider.releaseAddress) return true;
      let settled = true;
      for (const address of await provider.listManagedAddresses(signal)) {
        if (
          address.id !== id ||
          (beforeGeneration !== undefined && address.generation >= beforeGeneration)
        )
          continue;
        if (!(await act((job, check) => provider.releaseAddress!(address, job, check))))
          settled = false;
      }
      return settled;
    };
    const receiptRecorded = computer.bootstrapReceiptRecorded === true;
    const scrubBootstrap = async (server: VmServer | undefined) => {
      if (
        !receiptRecorded ||
        !server ||
        server.bootstrapMetadata === "absent" ||
        !provider.updateBootstrap
      )
        return;
      try {
        if (!(await act((job, check) => provider.updateBootstrap!(server.id, true, job, check))))
          throw new BootstrapScrubFailure();
      } catch (error) {
        // Only the scrub's own failure is deferred; a stale lease or a refused Account is not.
        if (error instanceof Superseded || accountRefused(error)) throw error;
        const limited = rateLimited(error);
        if (limited) throw limited;
        this.#options.onError?.(
          error instanceof BootstrapScrubFailure ? error : new BootstrapScrubFailure(error),
        );
      }
    };
    let failure: Failure = "The Cloud Computer provider operation failed.";

    try {
      const servers = await provider.find(id, signal, computer);
      if (servers.some((server) => server.generation > generation)) {
        return report("failed", "The provider has a newer Cloud Computer generation.");
      }
      const matching = servers.filter((server) => server.generation === generation);
      const previous = servers.filter((server) => server.generation < generation);
      current = matching[0];

      for (const write of pending.values()) {
        if (
          (write.kind === "create" &&
            servers.some(
              (server) =>
                server.generation === write.generation &&
                (!provider.canRecoverWrite ||
                  server.status === "running" ||
                  server.status === "off"),
            )) ||
          (write.kind === "power-on" &&
            servers.some(
              (server) =>
                server.id === (write.serverRef ?? write.serverId) && server.status === "running",
            ))
        ) {
          await finish(write.token);
        }
      }
      if (state !== "active") {
        const network = withdraw();
        const power = (async () => {
          let settled = true;
          for (const server of servers) {
            if (
              provider.canRecoverWrite &&
              server.status === "transitioning" &&
              [...pending.values()].some(
                (write) =>
                  (write.kind === "create" && write.generation === server.generation) ||
                  (write.kind === "power-on" && write.serverRef === server.id),
              )
            ) {
              settled = false;
              continue;
            }
            if (state === "suspended" && server.status === "off") continue;
            if (server.status !== "deleting") {
              if (state === "deleted")
                await act((job, check) => provider.delete(server.id, job, check));
              else await act((job, check) => provider.powerOff(server.id, job, check));
            }
            const observed = await provider.describe(server.id, signal, server.generation);
            if (current?.id === server.id) current = observed;
            if (observed && (state === "deleted" || observed.status !== "off")) settled = false;
          }
          return settled;
        })();
        const [dnsResult, vmResult] = await Promise.allSettled([network, power]);
        for (const result of [dnsResult, vmResult]) {
          if (
            result.status === "rejected" &&
            (accountRefused(result.reason) || result.reason instanceof Superseded)
          )
            throw result.reason;
        }
        if (vmResult.status === "rejected") throw vmResult.reason;
        if (dnsResult.status === "rejected") {
          failure = "The Cloud Computer DNS operation failed.";
          throw dnsResult.reason;
        }
        if (vmResult.value) {
          for (const write of pending.values()) await recover(write);
        }
        let settled = vmResult.value && !pending.size;
        if (settled && state === "deleted") settled = await releaseAddresses();
        if (state === "deleted") return report(settled ? "deleted" : "deleting");
        await scrubBootstrap(current);
        return report(settled ? "suspended" : "provisioning");
      }

      if ([...pending.values()].some(({ kind }) => kind === "dns-a" || kind === "dns-aaaa")) {
        failure = "The Cloud Computer DNS operation failed.";
        if (dns.observeWrites) {
          for (const token of await dns.observeWrites(hostname, signal)) await observe(token);
          for (const write of pending.values()) {
            if (write.kind === "dns-a" || write.kind === "dns-aaaa") await recover(write);
          }
        }
        failure = "The Cloud Computer provider operation failed.";
      }
      for (const write of pending.values()) {
        if (write.kind === "create" || write.kind === "power-on") await recover(write);
      }
      if ([...pending.values()].some(({ kind }) => kind === "create"))
        return unready("provisioning");
      if (matching.length > 1)
        return report("failed", "The Cloud Computer has more than one server for this generation.");
      if (current?.status === "deleting") return unready("provisioning");
      if (!current && !computer.bootstrapToken)
        return report("failed", "A bootstrap token is required to create this Cloud Computer.");
      if (!current && computer.bootstrapToken && provider.prepareCreate) {
        // Before anything happens to the machine being replaced.
        await act((job, check) => provider.prepareCreate!({ id, generation }, job, check), true);
      }
      if (previous.some((server) => server.status !== "off")) {
        for (const old of previous) {
          if (old.status === "deleting") return unready("provisioning");
          if (old.status !== "off") {
            await act((job, check) => provider.powerOff(old.id, job, check));
            const observed = await provider.describe(old.id, signal, old.generation);
            if (observed && observed.status !== "off") return unready("provisioning");
          }
        }
        failure = "The Cloud Computer DNS operation failed.";
        await withdraw();
      }

      const firewallId = await act((job, check) => ensureFirewall(job, check));
      if (!current && computer.bootstrapToken) {
        const userData = renderUserData(
          {
            cloudComputerId: id,
            hostname,
            accountOrigin: this.#options.accountOrigin.origin,
            installerUrl: computer.release.installerUrl,
            installerSha256: computer.release.installerSha256,
            bootstrapToken: computer.bootstrapToken,
          },
          provider.updateBootstrap !== undefined,
        );
        current = await act(
          (job) =>
            journal("create", (token, send) =>
              provider.create(
                {
                  id,
                  generation,
                  region: computer.region ?? this.#options.defaultRegion,
                  serverType: computer.serverType ?? this.#options.defaultServerType,
                  image: this.#options.image,
                  firewallId,
                  userData,
                  requestId: token,
                },
                job,
                () => send(job),
              ),
            ),
          true,
        );
      }
      if (!current) return unready("provisioning");
      if ((computer.providerServerRef ?? computer.providerServerId) !== current.id) {
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
      if (
        !receiptRecorded &&
        server.bootstrapMetadata === "pending" &&
        provider.updateBootstrap &&
        !(await act((job, check) => provider.updateBootstrap!(server.id, false, job, check)))
      )
        return unready("provisioning");
      if (current.status === "off") {
        if ([...pending.values()].some(({ kind }) => kind === "power-on"))
          return unready("provisioning");
        await act((job) =>
          journal(
            "power-on",
            (token, send) => provider.powerOn(server.id, job, () => send(job), token),
            server.id,
          ),
        );
        current = await provider.describe(server.id, signal, server.generation);
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
      const invalid =
        pinned &&
        replies.some(
          (identity) =>
            identity === "invalid" ||
            (identity &&
              (identity.deploymentId !== pinned.deploymentId ||
                identity.hostKeyFingerprint !== pinned.hostKeyFingerprint)),
        );
      if (
        invalid ||
        (computer.dnsQuarantined && (!replies.length || replies.some((identity) => !identity)))
      ) {
        try {
          await withdraw();
        } catch (error) {
          if (error instanceof Superseded || accountRefused(error)) throw error;
          this.#options.onError?.(error);
        }
        return report(
          "failed",
          "The Cloud Computer reported a different Home identity for this generation.",
        );
      }
      failure = "The Cloud Computer DNS operation failed.";
      await act((job, check) =>
        dns.ensureRecords(hostname, addresses, job, check, (type, publish) =>
          journal(type === "A" ? "dns-a" : "dns-aaaa", async (token, send) => {
            await send(job);
            return publish(token);
          }),
        ),
      );
      if (!replies.length || replies.some((identity) => !identity)) return unready("booting");

      failure = "The Cloud Computer provider operation failed.";
      if (!computer.restoreSnapshot || computer.replacementVerified) {
        for (const old of previous) {
          if (old.status !== "deleting")
            await act((job, check) => provider.delete(old.id, job, check));
          if (await provider.describe(old.id, signal, old.generation)) return unready("booting");
        }
        // Old generations' addresses are released once their machines are gone. This is
        // cleanup of a verified Home: it is retried on the next pass and never holds it back.
        if (generation > 1) {
          try {
            await releaseAddresses(generation);
          } catch (error) {
            if (error instanceof Superseded || accountRefused(error)) throw error;
            const limited = rateLimited(error);
            if (limited) throw limited;
            this.#options.onError?.(error);
          }
        }
      }
      await scrubBootstrap(current);
      return report("ready");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Superseded || accountRefused(error)) throw error;
      const limited = rateLimited(error);
      if (limited) throw limited;
      this.#options.onError?.(error);
      if (error instanceof ProviderOutcomeUnknown) {
        if (state !== "active") return report(state === "deleted" ? "deleting" : "provisioning");
        // An unobserved create or power-on, or a Home that has not booted: still provisioning,
        // and the readiness deadline applies.
        if (
          !computer.bootCompleted ||
          !computer.observedIdentity ||
          [...pending.values()].some(({ kind }) => kind === "create" || kind === "power-on")
        )
          return unready("provisioning");
        // This generation's Home booted; only a later write is unobserved. Report it as not
        // confirmed this pass, never as a Home that missed its deadline.
        return report("booting");
      }
      return report("failed", failure);
    }
  }
}

/** A provider rate limit, whether a read met it or it refused a write before carrying it out. */
function rateLimited(error: unknown): ProviderRateLimited | undefined {
  if (error instanceof ProviderRateLimited) return error;
  if (error instanceof ProviderWriteRejected && error.original instanceof ProviderRateLimited)
    return error.original;
  return undefined;
}
