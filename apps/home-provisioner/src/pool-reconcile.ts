import { randomUUID } from "node:crypto";
import type { BrowserPoolAgentSlotSummary } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type {
  BrowserPoolHostCheck,
  BrowserPoolHostDesired,
  BrowserPoolHostId,
  BrowserPoolHostProviderWrite,
  BrowserPoolHostReport,
  BrowserPoolSlotAgentWrite,
  BrowserPoolSlotCheck,
  BrowserPoolSlotDesired,
  BrowserPoolSlotId,
  BrowserPoolSlotReport,
} from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import { accountRefused, type PoolAccountApi } from "./account.js";
import type { PoolProvisionerConfig } from "./config.js";
import {
  BootstrapScrubFailure,
  ProviderOutcomeUnknown,
  ProviderRateLimited,
  ProviderWriteRejected,
  UntrackedPoolProfileDiskError,
} from "./http.js";
import {
  isDefiniteAgentRefusal,
  type PoolAgentClient,
  type PoolAgentTarget,
} from "./pool-agent-client.js";
import { poolProfileDiskDevicePath, renderPoolHostUserData } from "./pool-boot.js";
import type { PoolHostProvider, PoolHostVm, PoolProfileDisk } from "./provider.js";

type HostFailure = NonNullable<BrowserPoolHostReport["lastError"]>;
class Superseded extends Error {}

const maxAutoReplacements = 2;
export const failedSlotRetryDelayMs = 10 * 60_000;

export interface PoolReconcilerOptions {
  readonly account: PoolAccountApi;
  readonly provider: PoolHostProvider;
  readonly agent: PoolAgentClient;
  readonly accountOrigin: URL;
  readonly image: string;
  readonly pool: PoolProvisionerConfig;
  readonly readinessTimeoutMs: number;
  readonly concurrency: number;
  readonly orphanGraceMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

export class PoolReconciler {
  readonly #options: PoolReconcilerOptions;
  readonly #hostReports = new Map<BrowserPoolHostId, string>();
  readonly #slotReports = new Map<BrowserPoolSlotId, string>();
  readonly #orphanSeen = new Map<string, number>();
  readonly #now: () => number;
  #nextSweep = 0;

  constructor(options: PoolReconcilerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async pass(shutdown: AbortSignal): Promise<void> {
    const { account, provider, concurrency } = this.#options;
    const abort = new AbortController();
    const signal = AbortSignal.any([shutdown, abort.signal]);

    await provider.beginPass?.(signal);

    const [desiredHosts, desiredSlots] = await Promise.all([
      account.desiredHosts(signal),
      account.desiredSlots(signal),
    ]);
    const activeHostIds = new Set(desiredHosts.map(({ id }) => id));
    for (const id of this.#hostReports.keys()) {
      if (!activeHostIds.has(id)) this.#hostReports.delete(id);
    }
    const activeSlotIds = new Set(desiredSlots.map(({ slotId }) => slotId));
    for (const id of this.#slotReports.keys()) {
      if (!activeSlotIds.has(id)) this.#slotReports.delete(id);
    }
    const hostsWithSlots = new Set(desiredSlots.map(({ hostId }) => hostId));

    const firewallsByPorts = new Map<string, Promise<void>>();
    let failed = false;

    // 1. Reconcile pool hosts (durable profile disks + VMs + enrolment metadata scrub).
    const hostQueue = desiredHosts.values();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, desiredHosts.length) }, async () => {
        while (!signal.aborted) {
          const next = hostQueue.next();
          if (next.done) return;
          try {
            const host = next.value;
            const portsKey = `${host.agentPort}:${host.relayPort}`;
            const report = await this.#applyHost(
              host,
              hostsWithSlots.has(host.id),
              (operationSignal, check) => {
                let promise = firewallsByPorts.get(portsKey);
                if (!promise) {
                  promise = provider.ensurePoolFirewalls(
                    {
                      provisionerCidr: this.#options.pool.provisionerCidr,
                      agentPort: host.agentPort,
                      adminPort: this.#options.pool.adminPort,
                      relayPort: host.relayPort,
                    },
                    operationSignal,
                    check,
                  );
                  firewallsByPorts.set(portsKey, promise);
                }
                return promise;
              },
              signal,
            );
            const key = JSON.stringify(report);
            if (this.#hostReports.get(host.id) === key) continue;
            this.#hostReports.delete(host.id);
            if (await account.reportHost(report, signal)) this.#hostReports.set(host.id, key);
          } catch (error) {
            if (error instanceof Superseded) continue;
            const limited = rateLimited(error);
            if (limited) {
              abort.abort(limited);
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

    // 2. Reconcile pool slots grouped by host (one signed `list` per host per pass).
    const slotsByHost = new Map<BrowserPoolHostId, BrowserPoolSlotDesired[]>();
    for (const slot of desiredSlots) {
      const list = slotsByHost.get(slot.hostId) ?? [];
      list.push(slot);
      slotsByHost.set(slot.hostId, list);
    }
    const hostGroups = [...slotsByHost.values()].values();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, slotsByHost.size) }, async () => {
        while (!signal.aborted) {
          const next = hostGroups.next();
          if (next.done) return;
          try {
            await this.#applyHostSlots(next.value, signal);
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

    // 3. Orphan sweep for pool host VMs only. Durable profile disks are NEVER swept (T2).
    if (this.#now() >= this.#nextSweep) {
      await this.#sweep(activeHostIds, signal);
      this.#nextSweep = this.#now() + 60_000;
    }

    if (failed) {
      throw refused("internal", "Could not reconcile one or more browser pool resources");
    }
  }

  async #checkHost(id: BrowserPoolHostId, check: BrowserPoolHostCheck, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!(await this.#options.account.checkHost(id, check, signal))) throw new Superseded();
    signal.throwIfAborted();
  }

  async #checkSlot(slotId: BrowserPoolSlotId, check: BrowserPoolSlotCheck, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!(await this.#options.account.checkSlot(slotId, check, signal))) throw new Superseded();
    signal.throwIfAborted();
  }

  async #sweep(activeHostIds: ReadonlySet<BrowserPoolHostId>, signal: AbortSignal) {
    const { provider, orphanGraceMs = 5 * 60_000 } = this.#options;
    const [servers, disks] = await Promise.all([
      provider.listManagedPoolHosts(signal),
      provider.listManagedPoolDisks(signal),
    ]);
    const present = new Set<string>();
    const clean = async (
      key: string,
      id: BrowserPoolHostId,
      action: (job: AbortSignal) => Promise<void>,
    ) => {
      if (activeHostIds.has(id)) return;
      present.add(key);
      const now = this.#now();
      if (!this.#orphanSeen.has(key)) this.#orphanSeen.set(key, now);
      if (now - this.#orphanSeen.get(key)! < orphanGraceMs) return;
      const job = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      try {
        await this.#checkHost(id, { operation: "orphan" }, job);
        await action(job);
      } catch (error) {
        if (accountRefused(error)) throw error;
        const limited = rateLimited(error);
        if (limited) throw limited;
        if (!(error instanceof Superseded)) this.#options.onError?.(error);
      }
    };
    for (const { id, server } of servers) {
      if (server.status !== "deleting") {
        await clean(`pool-vm:${server.id}`, id, (job) =>
          provider.deletePoolHost(server.id, job, () =>
            this.#checkHost(id, { operation: "orphan" }, job),
          ),
        );
      }
    }
    // T2: Never delete durable profile disks in the sweep. Report any untracked disk to an operator.
    for (const disk of disks) {
      if (activeHostIds.has(disk.hostId)) continue;
      this.#options.onError?.(new UntrackedPoolProfileDiskError(disk.name, disk.hostId));
    }
    for (const key of this.#orphanSeen.keys()) {
      if (!present.has(key)) this.#orphanSeen.delete(key);
    }
  }

  async #applyHost(
    host: BrowserPoolHostDesired,
    hasAccountSlots: boolean,
    ensureFirewalls: (signal: AbortSignal, check: () => Promise<void>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<BrowserPoolHostReport> {
    const { account, provider, agent, pool } = this.#options;
    const { id, generation, revision, state } = host;
    let current: PoolHostVm | undefined;
    let disk: PoolProfileDisk | undefined;

    const report = (
      phase: BrowserPoolHostReport["phase"],
      lastError: HostFailure | null = null,
    ): BrowserPoolHostReport => ({
      id,
      generation,
      revision,
      phase,
      providerServerRef: phase === "deleted" ? null : (current?.id ?? null),
      profileDiskRef: phase === "deleted" ? null : (disk?.ref ?? host.profileDiskRef ?? null),
      internalIp: phase === "deleted" ? null : (current?.internalIpv4 ?? null),
      lastError,
    });
    const pending = new Map(
      (host.pendingProviderWrites ?? []).map((write) => [write.token, write]),
    );
    const deadlineExceeded = () =>
      Boolean(
        host.readinessStartedAt &&
        this.#now() - Date.parse(host.readinessStartedAt) >= this.#options.readinessTimeoutMs,
      );
    const unready = async (phase: "provisioning" | "booting"): Promise<BrowserPoolHostReport> => {
      if (!deadlineExceeded()) return report(phase);
      // T8: An unenrolled host that never enrolled holds no slot: auto-replace in place at most twice.
      // An enrolled host that later fails is never replaced automatically.
      if (!host.enrolled && !host.everEnrolled && pending.size === 0) {
        if (host.autoReplaceCount < maxAutoReplacements) {
          const result = await account.replaceUnenrolledHost(id, { revision, generation }, signal);
          if (result.replaced) throw new Superseded();
        }
        return report(
          "failed",
          "The pool host did not enrol before its deadline after automatic replacement retries.",
        );
      }
      return report("failed", "The pool host did not become ready before its deadline.");
    };

    const finish = async (token: string) => {
      await this.#checkHost(id, { operation: "finish-provider-write", token }, signal);
      pending.delete(token);
    };
    const recover = async (write: BrowserPoolHostProviderWrite) => {
      if (!write.recoverAfter || Date.parse(write.recoverAfter) > this.#now()) return;
      if (
        provider.canRecoverPoolHostWrite &&
        !(await provider.canRecoverPoolHostWrite(write, signal))
      ) {
        return;
      }
      await this.#checkHost(
        id,
        { operation: "recover-provider-write", revision, token: write.token },
        signal,
      );
      pending.delete(write.token);
    };
    const journal = async <T>(
      kind: BrowserPoolHostProviderWrite["kind"],
      action: (token: string, send: (job: AbortSignal) => Promise<void>) => Promise<T>,
      extra: { serverRef?: PoolHostVm["id"]; diskName?: string } = {},
    ): Promise<T> => {
      const token = randomUUID();
      const write: BrowserPoolHostProviderWrite = {
        kind,
        token,
        generation,
        ...(extra.serverRef ? { serverRef: extra.serverRef } : {}),
        ...(extra.diskName ? { diskName: extra.diskName } : {}),
      };
      await this.#checkHost(id, { operation: "begin-provider-write", revision, write }, signal);
      pending.set(token, write);
      let result: T;
      try {
        result = await action(token, (job) =>
          this.#checkHost(id, { operation: "send-provider-write", revision, token }, job),
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
        this.#checkHost(id, { operation: create ? "create" : "mutate", revision }, job);
      await check();
      return action(job, check);
    };
    const scrubBootstrap = async (server: PoolHostVm | undefined) => {
      if (
        !host.enrolled ||
        !server ||
        server.bootstrapMetadata === "absent" ||
        !provider.updatePoolHostBootstrap
      ) {
        return;
      }
      try {
        if (
          !(await act((job, check) =>
            provider.updatePoolHostBootstrap!(server.id, true, job, check),
          ))
        ) {
          throw new BootstrapScrubFailure();
        }
      } catch (error) {
        if (error instanceof Superseded || accountRefused(error)) throw error;
        const limited = rateLimited(error);
        if (limited) throw limited;
        this.#options.onError?.(
          error instanceof BootstrapScrubFailure ? error : new BootstrapScrubFailure(error),
        );
      }
    };

    try {
      const [servers, observedDisk] = await Promise.all([
        provider.findPoolHost(id, signal, host),
        provider.findPoolProfileDisk(host.profileDiskName, signal),
      ]);
      disk = observedDisk;

      if (servers.some((server) => server.generation > generation)) {
        return report("failed", "The provider has a newer pool host generation.");
      }
      const matching = servers.filter((server) => server.generation === generation);
      const previous = servers.filter((server) => server.generation < generation);
      current = matching[0];

      // Reconcile pending writes against observed resources.
      for (const write of pending.values()) {
        if (
          (write.kind === "create-disk" && disk !== undefined) ||
          (write.kind === "create" &&
            servers.some(
              (server) =>
                server.generation === write.generation &&
                (!provider.canRecoverPoolHostWrite ||
                  server.status === "running" ||
                  server.status === "off"),
            )) ||
          (write.kind === "power-on" &&
            servers.some((server) => server.id === write.serverRef && server.status === "running"))
        ) {
          await finish(write.token);
        }
      }

      if (state === "deleted") {
        // W10 + T2: durable disk is deleted ONLY here, with zero slots in Account and host `list`.
        if (hasAccountSlots) return report("deleting");
        if (
          current?.status === "running" &&
          current.internalIpv4 &&
          host.enrolled &&
          host.hostKey
        ) {
          try {
            const liveSlots = await agent.list(
              {
                hostId: id,
                internalIp: current.internalIpv4,
                adminPort: pool.adminPort,
                hostKeySpki: host.hostKey,
              },
              signal,
            );
            if (liveSlots.length > 0) return report("deleting");
          } catch (error) {
            // X3: A running host that does not answer list is unknown; wait rather than delete its disk.
            signal.throwIfAborted();
            this.#options.onError?.(error);
            return report("deleting");
          }
        }
        let vmsGone = true;
        for (const server of servers) {
          if (server.status !== "deleting") {
            await act((job, check) => provider.deletePoolHost(server.id, job, check));
          }
          const observed = await provider.describePoolHost(server.id, signal, server.generation);
          if (current?.id === server.id) current = observed;
          if (observed) vmsGone = false;
        }
        if (vmsGone) {
          for (const write of pending.values()) await recover(write);
        }
        let diskGone = disk === undefined;
        if (vmsGone && pending.size === 0 && disk) {
          diskGone = await act((job, check) =>
            provider.deletePoolProfileDisk(host.profileDiskName, id, job, check),
          );
          if (diskGone) disk = undefined;
        }
        return report(vmsGone && diskGone && pending.size === 0 ? "deleted" : "deleting");
      }

      // Active or draining host.
      for (const write of pending.values()) await recover(write);
      if ([...pending.values()].some(({ kind }) => kind === "create" || kind === "create-disk")) {
        return await unready("provisioning");
      }
      if (matching.length > 1) {
        return report("failed", "The pool host has more than one server for this generation.");
      }
      if (current?.status === "deleting") return await unready("provisioning");

      // Ensure durable profile disk exists (W1: created once, kept across host replacements).
      if (!disk) {
        disk = await act((job) =>
          journal(
            "create-disk",
            (token, send) =>
              provider.ensurePoolProfileDisk(
                {
                  hostId: id,
                  diskName: host.profileDiskName,
                  sizeGb: host.profileDiskSizeGb,
                  diskType: pool.profileDiskType,
                  requestId: token,
                },
                job,
                () => send(job),
              ),
            { diskName: host.profileDiskName },
          ),
        );
      }

      // W1: During host replacement, delete old-generation VM(s) first so the autoDelete:false
      // durable profile disk detaches cleanly before the replacement VM attaches it READ_WRITE.
      if (previous.length > 0 && !current) {
        for (const old of previous) {
          if (old.status !== "deleting") {
            await act((job, check) => provider.deletePoolHost(old.id, job, check));
          }
          const stillThere = await provider.describePoolHost(old.id, signal, old.generation);
          if (stillThere) return await unready("provisioning");
        }
      }

      if (!current && !host.bootstrapToken) {
        return report("failed", "A bootstrap token is required to create this pool host.");
      }
      if (!current && host.bootstrapToken) {
        await act((job, check) => ensureFirewalls(job, check));
        // X1: Disk self-identifies by label; Account supplies only whether this host has ever enrolled.
        const userData = renderPoolHostUserData(
          {
            hostId: id,
            generation,
            accountOrigin: this.#options.accountOrigin.origin,
            installerUrl: host.release.installerUrl,
            installerSha256: host.release.installerSha256,
            bootstrapToken: host.bootstrapToken,
            provisionerKey: pool.provisionerPublicKeySpki,
            homeCidr: pool.homeCidr,
            provisionerCidr: pool.provisionerCidr,
            profileDiskDevice: poolProfileDiskDevicePath,
            everEnrolled: host.everEnrolled,
            agentPort: host.agentPort,
            adminPort: pool.adminPort,
            relayPort: host.relayPort,
          },
          provider.updatePoolHostBootstrap !== undefined,
        );
        current = await act(
          (job) =>
            journal("create", (token, send) =>
              provider.createPoolHost(
                {
                  id,
                  generation,
                  machineType: host.machineType,
                  image: this.#options.image,
                  bootDiskSizeGb: pool.bootDiskSizeGb,
                  profileDiskName: host.profileDiskName,
                  localSsdCount: pool.localSsdCount,
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

      if (!current) return await unready("provisioning");
      if (host.providerServerRef !== current.id || host.profileDiskRef !== disk.ref) {
        // Record server + disk ref in Account so the 20-minute bootstrap window opens before boot.
        if (!(await account.reportHost(report("provisioning"), signal))) throw new Superseded();
      }

      const server = current;
      if (
        !host.enrolled &&
        server.bootstrapMetadata === "pending" &&
        provider.updatePoolHostBootstrap &&
        !(await act((job, check) =>
          provider.updatePoolHostBootstrap!(server.id, false, job, check),
        ))
      ) {
        return await unready("provisioning");
      }

      if (current.status === "off") {
        if ([...pending.values()].some(({ kind }) => kind === "power-on")) {
          return await unready("provisioning");
        }
        await act((job) =>
          journal(
            "power-on",
            (token, send) => provider.powerOnPoolHost(server.id, job, () => send(job), token),
            { serverRef: server.id },
          ),
        );
        current = await provider.describePoolHost(server.id, signal, server.generation);
      }
      if (current?.status !== "running" || !current.internalIpv4) {
        return await unready("provisioning");
      }
      if (!host.enrolled || !host.hostKey) return await unready("booting");

      await scrubBootstrap(current);

      // Verify signed admin reachability before reporting the pool host ready.
      try {
        await agent.list(
          {
            hostId: id,
            internalIp: current.internalIpv4,
            adminPort: pool.adminPort,
            hostKeySpki: host.hostKey,
          },
          signal,
        );
      } catch (error) {
        this.#options.onError?.(error);
        return await unready("booting");
      }

      return report("ready");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Superseded || accountRefused(error)) throw error;
      const limited = rateLimited(error);
      if (limited) throw limited;
      this.#options.onError?.(error);
      if (error instanceof ProviderOutcomeUnknown) {
        if (state === "deleted") return report("deleting");
        if (
          !host.enrolled ||
          [...pending.values()].some(
            ({ kind }) => kind === "create" || kind === "create-disk" || kind === "power-on",
          )
        ) {
          return await unready("provisioning");
        }
        return report("booting");
      }
      return report("failed", "The pool host provider operation failed.");
    }
  }

  async #applyHostSlots(
    slots: readonly BrowserPoolSlotDesired[],
    signal: AbortSignal,
  ): Promise<void> {
    const first = slots[0];
    if (!first) return;
    const target: PoolAgentTarget = {
      hostId: first.hostId,
      internalIp: first.hostInternalIp,
      adminPort: this.#options.pool.adminPort,
      hostKeySpki: first.hostKey,
    };

    let listed: readonly BrowserPoolAgentSlotSummary[];
    try {
      listed = await this.#options.agent.list(target, signal);
    } catch (error) {
      // Unknown stays unknown: never mark slots failed or completed when host list is unavailable/unverified.
      this.#options.onError?.(error);
      return;
    }
    const observedById = new Map(listed.map((summary) => [summary.slotId, summary]));

    for (const slot of slots) {
      if (signal.aborted) return;
      try {
        const report = await this.#applySlot(slot, target, observedById.get(slot.slotId), signal);
        if (!report) continue;
        const key = JSON.stringify(report);
        if (this.#slotReports.get(slot.slotId) === key) continue;
        this.#slotReports.delete(slot.slotId);
        if (await this.#options.account.reportSlot(report, signal)) {
          this.#slotReports.set(slot.slotId, key);
        }
      } catch (error) {
        if (error instanceof Superseded) continue;
        if (accountRefused(error)) throw error;
        this.#options.onError?.(error);
      }
    }
  }

  async #applySlot(
    slot: BrowserPoolSlotDesired,
    target: PoolAgentTarget,
    observed: BrowserPoolAgentSlotSummary | undefined,
    signal: AbortSignal,
  ): Promise<BrowserPoolSlotReport | undefined> {
    const { account, agent } = this.#options;
    const { slotId, hostGeneration } = slot;
    let term = slot.term;
    let revision = slot.revision;

    const pending = new Map((slot.pendingAgentWrites ?? []).map((write) => [write.token, write]));
    const finish = async (token: string) => {
      await this.#checkSlot(slotId, { operation: "finish-agent-write", token }, signal);
      pending.delete(token);
    };
    const recover = async (write: BrowserPoolSlotAgentWrite) => {
      if (!write.recoverAfter || Date.parse(write.recoverAfter) > this.#now()) return;
      await this.#checkSlot(
        slotId,
        { operation: "recover-agent-write", revision, token: write.token },
        signal,
      );
      pending.delete(write.token);
    };
    const journal = async <T>(
      kind: BrowserPoolSlotAgentWrite["kind"],
      action: (job: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const token = randomUUID();
      const write: BrowserPoolSlotAgentWrite = {
        token,
        kind,
        term,
        hostId: slot.hostId,
      };
      await this.#checkSlot(slotId, { operation: "begin-agent-write", revision, write }, signal);
      pending.set(token, write);
      const job = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      try {
        await this.#checkSlot(slotId, { operation: "send-agent-write", revision, token }, job);
        const result = await action(job);
        await finish(token);
        return result;
      } catch (error) {
        // Only definite signed refusals (`conflict`, `unknown-slot`) or Superseded clear the journal.
        // Signed `unavailable`, unsigned refusals, forged signatures, and transport loss stay pending (unknown).
        if (isDefiniteAgentRefusal(error) || error instanceof Superseded) {
          await finish(token);
        }
        throw error;
      }
    };

    // Reconcile pending create / replace-key writes against verified `list` output.
    for (const write of pending.values()) {
      if (
        (write.kind === "create" || write.kind === "replace-key") &&
        observed?.term === write.term
      ) {
        await finish(write.token);
      }
    }
    for (const write of pending.values()) {
      await recover(write);
    }

    try {
      if (slot.state === "deleting") {
        if (pending.size > 0) {
          return {
            slotId,
            hostGeneration,
            revision,
            term,
            phase: "deleting",
            controlKey: null,
            slotErased: slot.slotErased,
            profileErased: slot.profileErased,
            credentialsErased: slot.credentialsErased,
            lastError: null,
          };
        }
        const deleteTerm = observed?.term ?? term;
        const evidence = await journal("delete", (job) =>
          agent.delete(target, { slotId, term: deleteTerm, eraseProfile: true }, job),
        );
        // W10 + T1: Accumulate evidence across passes; settle ONLY once all three are proven.
        const slotErased = slot.slotErased || evidence.erased;
        const profileErased = slot.profileErased || evidence.profileErased;
        const credentialsErased = slot.credentialsErased || evidence.credentialsErased;
        const settled = slotErased && profileErased && credentialsErased;
        return {
          slotId,
          hostGeneration,
          revision,
          term,
          phase: settled ? "deleted" : "deleting",
          controlKey: null,
          slotErased,
          profileErased,
          credentialsErased,
          lastError: null,
        };
      }

      if (!slot.keys) return undefined;
      if (slot.phase === "failed") {
        // X2: Retry failed slots no more often than every 10 minutes (unless reset by replacement or operator).
        const failedAtMs = slot.failedAt ? Date.parse(slot.failedAt) : Number.NaN;
        if (!Number.isFinite(failedAtMs) || this.#now() - failedAtMs < failedSlotRetryDelayMs) {
          return undefined;
        }
      }
      if (pending.size > 0) return undefined;

      if (observed) {
        if (observed.term > term) {
          return {
            slotId,
            hostGeneration,
            revision,
            term,
            phase: "failed",
            controlKey: observed.controlKey,
            slotErased: false,
            profileErased: false,
            credentialsErased: false,
            lastError: "The pool host reported a newer term for this browser slot.",
          };
        }
        if (observed.term === term) {
          return {
            slotId,
            hostGeneration,
            revision,
            term,
            phase: "ready",
            controlKey: observed.controlKey,
            slotErased: false,
            profileErased: false,
            credentialsErased: false,
            lastError: null,
          };
        }
        // observed.term < term: rotate keys on the host (W5).
        const summary = await journal("replace-key", (job) =>
          agent.replaceKey(target, { slotId, term, keys: slot.keys! }, job),
        );
        return {
          slotId,
          hostGeneration,
          revision,
          term,
          phase: "ready",
          controlKey: summary.controlKey,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        };
      }

      // Slot is absent on the host. Per settled S6, if this slot previously ran (e.g. before a host
      // replacement where the new instance starts with no slots), raise term monotonically before creating.
      const needsTermBump =
        slot.appliedTerm !== undefined ||
        (slot.appliedHostGeneration !== undefined &&
          slot.appliedHostGeneration !== slot.hostGeneration);
      if (needsTermBump) {
        const bumped = await account.bumpSlotTerm(slotId, { revision, expectedTerm: term }, signal);
        if (!bumped.bumped || bumped.term === undefined || bumped.revision === undefined) {
          throw new Superseded();
        }
        term = bumped.term;
        revision = bumped.revision;
      }

      const summary = await journal("create", (job) =>
        agent.create(target, { slotId, term, keys: slot.keys!, guest: slot.guest }, job),
      );
      return {
        slotId,
        hostGeneration,
        revision,
        term,
        phase: "ready",
        controlKey: summary.controlKey,
        slotErased: false,
        profileErased: false,
        credentialsErased: false,
        lastError: null,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Superseded || accountRefused(error)) throw error;
      this.#options.onError?.(error);
      if (isDefiniteAgentRefusal(error)) {
        const diskFull =
          error.refusal === "conflict" &&
          /exceed their filesystem|without room to fill in/u.test(error.message);
        return {
          slotId,
          hostGeneration,
          revision,
          term,
          phase: "failed",
          controlKey: observed?.controlKey ?? slot.controlKey ?? null,
          slotErased: slot.slotErased,
          profileErased: slot.profileErased,
          credentialsErased: slot.credentialsErased,
          lastError: diskFull
            ? "This host's profile disk is full."
            : "The pool host rejected the slot administration request.",
        };
      }
      // Unknown stays unknown: leave pending write and current Account phase unchanged.
      return undefined;
    }
  }
}

function rateLimited(error: unknown): ProviderRateLimited | undefined {
  if (error instanceof ProviderRateLimited) return error;
  if (error instanceof ProviderWriteRejected && error.original instanceof ProviderRateLimited) {
    return error.original;
  }
  return undefined;
}
