import {
  DesktopConfigurePersonalRemoteAccessInputSchema,
  DesktopPersonalPairingCodeSchema,
  DesktopPersonalRemoteAccessStatusSchema,
  type DesktopConfigurePersonalRemoteAccessInput,
  type DesktopPersonalPairingCode,
  type DesktopPersonalRemoteAccessStatus,
  type PersonalRemoteAccessStatus,
} from "@opensteer/protocol";
import type { ConnectOperationId } from "@opensteer/control-plane-protocol";
import { DesktopPersonalAccountMutationCoordinator } from "../account/personal-account-mutation.js";
import type { DesktopPersonalHostRemoteAdapter } from "../supervisor/personal-host-remote-adapter.js";
import type {
  PersonalHostConnectOrchestrator,
  PersonalHostConnectTeardownCoordinator,
} from "../supervisor/personal-host-connect-orchestrator.js";
import {
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
  type PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";
import type {
  DesktopTailscaleShareResult,
  DesktopTailscaleStatus,
} from "@opensteer/protocol/desktop";
import { tailscaleHandoffMilliseconds, type TailscaleShare } from "./tailscale.js";

type Listener = (status: DesktopPersonalRemoteAccessStatus) => void;

export interface PersonalHostConnectComponents {
  readonly management: PersonalHostConnectOrchestrator | null;
  readonly teardown: PersonalHostConnectTeardownCoordinator;
}

/** Desktop-owned policy coordinator for Off, Connect, and Private network.
 * Host revocation always commits before external connector work. */
export class DesktopPersonalRemoteAccessService {
  readonly #connectFactory: (runtime: PersonalHostRuntimeRecord) => PersonalHostConnectComponents;
  #connectInstance: {
    readonly authority: string;
    readonly value: PersonalHostConnectComponents;
  } | null = null;
  readonly #connectUnavailableDetail: string | null;
  readonly #host: Pick<
    DesktopPersonalHostRemoteAdapter,
    | "configureConnect"
    | "configureConnectPrivate"
    | "disableConnect"
    | "issuePairingCode"
    | "status"
  >;
  readonly #listeners = new Set<Listener>();
  readonly #log: ((event: string, error: unknown) => void) | undefined;
  readonly #mutations: DesktopPersonalAccountMutationCoordinator;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #tailscale: Pick<TailscaleShare, "reconcile" | "share" | "status" | "stop"> | undefined;
  #shutdown = false;
  #shutdownPromise: Promise<void> | undefined;
  #status: DesktopPersonalRemoteAccessStatus = emptyStatus();
  /** The check that takes down a shared handler whose route never came. */
  #handoffCheck: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly connectFactory: (runtime: PersonalHostRuntimeRecord) => PersonalHostConnectComponents;
    readonly connectUnavailableDetail?: string | null;
    readonly host: Pick<
      DesktopPersonalHostRemoteAdapter,
      | "configureConnect"
      | "configureConnectPrivate"
      | "disableConnect"
      | "issuePairingCode"
      | "status"
    >;
    readonly log?: (event: string, error: unknown) => void;
    readonly mutations?: DesktopPersonalAccountMutationCoordinator;
    readonly runtime: PersonalHostRuntimeSource;
    /** Private mode at this computer's tailnet name, kept in step with the Host's route. */
    readonly tailscale?: Pick<TailscaleShare, "reconcile" | "share" | "status" | "stop">;
  }) {
    this.#connectFactory = options.connectFactory;
    this.#connectUnavailableDetail = options.connectUnavailableDetail ?? null;
    this.#host = options.host;
    this.#log = options.log;
    this.#mutations = options.mutations ?? new DesktopPersonalAccountMutationCoordinator();
    this.#runtime = options.runtime;
    this.#tailscale = options.tailscale;
  }

  get status(): DesktopPersonalRemoteAccessStatus {
    return this.#status;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  initialize(): Promise<DesktopPersonalRemoteAccessStatus> {
    if (this.#shutdown) return Promise.resolve(this.#status);
    return this.#serialize(() => this.#withTailscale(false, () => this.#initialize()));
  }

  async #initialize(): Promise<DesktopPersonalRemoteAccessStatus> {
    const runtime = await this.#runtime.current();
    if (!runtime) return this.#set(emptyStatus());
    const parsedRuntime = PersonalHostRuntimeRecordSchema.parse(runtime);
    const hostStatus = await this.#host.status();
    const components = this.#connectFor(parsedRuntime);
    if (hostStatus.mode === "private") {
      // Private is an independent Host-owned route. Any stale Connect intent
      // is authority-reducing cleanup only and must never replace it.
      await components.teardown.reconcileIfPresent();
      return this.#set(fromHost(parsedRuntime, await this.#host.status()));
    }
    if (!components.management) {
      // A build without Account management cannot resurrect enabled intent.
      // It still owns exact Host teardown for state left by an earlier build.
      if (hostStatus.mode === "connect") {
        this.#set(fromHost(parsedRuntime, hostStatus, "revoking", null, true));
        await this.#host.disableConnect();
        await components.teardown.disable();
      } else {
        await components.teardown.reconcileIfPresent();
      }
      return this.#set(fromHost(parsedRuntime, await this.#host.status()));
    }

    this.#set(fromHost(parsedRuntime, hostStatus, "provisioning", null, true));
    const result = await components.management.reconcile();
    const reconciledHost = await this.#host.status();
    if (result.state === "disabled" && reconciledHost.mode === "connect") {
      // Host Connect with no matching Desktop intent is inconsistent. Revoke
      // the route first, then delete any deterministic central resource.
      await this.#host.disableConnect();
      await components.teardown.disable();
    } else if (result.state !== "disabled" && result.state !== "enabled") {
      throw new Error(result.detail ?? "Opensteer Connect could not be reconciled.");
    }
    return this.#set(fromHost(parsedRuntime, await this.#host.status()));
  }

  configure(
    input: DesktopConfigurePersonalRemoteAccessInput,
  ): Promise<DesktopPersonalRemoteAccessStatus> {
    const request = DesktopConfigurePersonalRemoteAccessInputSchema.parse(input);
    return this.#serialize(() =>
      this.#withTailscale(true, async () => {
        const runtime = await this.#requireRuntime();
        const current = await this.#host.status();
        if (request.mode === "connect") return this.#startConnect(runtime, current);
        if (current.mode === "connect") {
          this.#set(fromHost(runtime, current, "revoking", null, true));
          const components = this.#connectFor(runtime);
          await this.#quiesceConnect(components);
          await this.#host.disableConnect();
          await components.teardown.disable();
        }
        if (request.mode === "off") {
          if (current.mode !== "connect") {
            const components = this.#connectFor(runtime);
            await this.#quiesceConnect(components);
            await this.#host.disableConnect();
            await components.teardown.reconcileIfPresent();
          }
          return this.#set(fromHost(runtime, await this.#host.status()));
        }
        const configured = await this.#host.configureConnectPrivate(request.privateOrigin!);
        return this.#set(fromHost(runtime, configured));
      }),
    );
  }

  tailscaleStatus(): Promise<DesktopTailscaleStatus> {
    if (!this.#tailscale) return Promise.resolve({ state: "not-installed" });
    return this.#tailscale.status();
  }

  /**
   * Serves the Host on this computer's tailnet name. Turning Private mode on at
   * the address it answers is the page's next step, through the Host, so any
   * device sees the same mode.
   */
  shareOverTailscale(): Promise<DesktopTailscaleShareResult> {
    const tailscale = this.#tailscale;
    if (!tailscale)
      return Promise.resolve({
        message: "Tailscale sharing isn't available in this build.",
        ok: false,
        reason: "failed",
      });
    return this.#mutations.run("remote-access", async () => {
      const runtime = await this.#requireRuntime();
      const result = await tailscale.share(runtime.localOrigin);
      if (result.ok) this.#scheduleHandoffCheck();
      return result;
    });
  }

  /**
   * A page that shares and then never asks the Host for the route — it was
   * closed, the person chose another way, the request failed — would leave
   * the handler up for this whole run. Once the hand-off can no longer be in
   * flight, reconcile with whatever route the Host has.
   */
  #scheduleHandoffCheck(): void {
    if (this.#handoffCheck) clearTimeout(this.#handoffCheck);
    this.#handoffCheck = setTimeout(() => {
      this.#handoffCheck = undefined;
      if (this.#shutdown) return;
      void this.#mutations
        .run("remote-access", () => this.#reconcileTailscale(false))
        .catch((error: unknown) =>
          this.#log?.("desktop.personal.tailscale.reconcile-failed", error),
        );
    }, tailscaleHandoffMilliseconds + 1_000);
    this.#handoffCheck.unref?.();
  }

  issuePairingCode(): Promise<DesktopPersonalPairingCode> {
    return this.#serialize(async () => {
      await this.#requireRuntime();
      const status = await this.#host.status();
      if (status.mode !== "private" || !status.route) {
        throw new Error("Enable Private network access before creating a pairing code.");
      }
      const code = await this.#host.issuePairingCode();
      if (code.generation !== status.generation) {
        throw new Error("The Private network route changed while creating its pairing code.");
      }
      return DesktopPersonalPairingCodeSchema.parse({
        ...code,
        routeOrigin: status.route.document.route.origin,
      });
    });
  }

  rotate(operationId: ConnectOperationId): Promise<DesktopPersonalRemoteAccessStatus> {
    return this.#serialize(async () => {
      const runtime = await this.#requireRuntime();
      const management = this.#connectFor(runtime).management;
      if (!management) throw new Error("Connect is unavailable in this build.");
      const result = await management.rotate(operationId);
      if (result.state !== "enabled")
        throw new Error(result.detail ?? "Connect credential rotation failed.");
      return this.#set(fromHost(runtime, await this.#host.status()));
    });
  }

  resumeDesiredConnect(): Promise<DesktopPersonalRemoteAccessStatus> {
    return this.initialize();
  }

  shutdown(signal?: AbortSignal): Promise<void> {
    this.#shutdown = true;
    if (this.#handoffCheck) clearTimeout(this.#handoffCheck);
    this.#shutdownPromise ??= (async () => {
      if (this.#connectInstance) {
        const { management, teardown } = this.#connectInstance.value;
        if (management) await management.shutdown(signal);
        else await teardown.stopConnector(signal);
      }
      // The Host stops with this app; the next start restores the handler
      // once the Host's route says it is still wanted.
      await this.#tailscale
        ?.stop()
        .catch((error: unknown) => this.#log?.("desktop.personal.tailscale.stop-failed", error));
    })();
    return this.#shutdownPromise;
  }

  disableConnectForUnlink(): Promise<DesktopPersonalRemoteAccessStatus> {
    return this.#runWithStatus(async () => {
      const runtime = await this.#requireRuntime();
      const components = this.#connectFor(runtime);
      await this.#quiesceConnect(components);
      const current = await this.#host.status();
      if (current.mode === "connect") await this.#host.disableConnect();
      return this.#set(fromHost(runtime, await this.#host.status()));
    });
  }

  revokeConnectResourceForUnlink(operationId: ConnectOperationId): Promise<void> {
    return this.#runWithStatus(async () => {
      const runtime = await this.#requireRuntime();
      await this.#connectFor(runtime).teardown.revokeResourceForUnlink(operationId);
    });
  }

  async #startConnect(
    runtime: PersonalHostRuntimeRecord,
    current: PersonalRemoteAccessStatus,
  ): Promise<DesktopPersonalRemoteAccessStatus> {
    if (current.accountLink?.state !== "active")
      throw new Error(
        "Link an Opensteer Account from the device signing in before enabling Connect.",
      );
    return this.#enableConnect(runtime);
  }

  async #enableConnect(
    runtime: PersonalHostRuntimeRecord,
  ): Promise<DesktopPersonalRemoteAccessStatus> {
    const connect = this.#connectFor(runtime).management;
    if (!connect) {
      throw new Error(this.#connectUnavailableDetail ?? "Opensteer Connect is unavailable.");
    }
    this.#set(fromHost(runtime, await this.#host.status(), "linking-account", null, true));
    if ((await this.#host.status()).accountLink?.state !== "active")
      throw new Error("Link an Opensteer Account before enabling Connect.");
    const current = await this.#host.status();
    if (current.mode === "private") await this.#host.disableConnect();
    this.#set(fromHost(runtime, await this.#host.status(), "provisioning", null, true));
    const result = await connect.enable();
    if (result.state !== "enabled") {
      throw new Error(result.detail ?? "Opensteer Connect could not be enabled.");
    }
    return this.#set(fromHost(runtime, await this.#host.status()));
  }

  async #requireRuntime(): Promise<PersonalHostRuntimeRecord> {
    const runtime = await this.#runtime.current();
    if (!runtime) throw new Error("Start This Computer before configuring remote access.");
    return PersonalHostRuntimeRecordSchema.parse(runtime);
  }

  #connectFor(runtime: PersonalHostRuntimeRecord): PersonalHostConnectComponents {
    if (this.#shutdown) throw new Error("Personal remote access is stopping.");
    const authority = JSON.stringify(runtime);
    if (this.#connectInstance?.authority === authority) return this.#connectInstance.value;
    const value = this.#connectFactory(runtime);
    this.#connectInstance = { authority, value };
    return value;
  }

  async #quiesceConnect(components: PersonalHostConnectComponents): Promise<void> {
    if (components.management) await components.management.quiesce();
    else await components.teardown.stopConnector();
  }

  /**
   * Runs a mode change and then brings Opensteer's Tailscale handler in line
   * with the route the Host reports afterwards, whether or not the change
   * succeeded. `authoritative` is true when someone chose the mode.
   */
  async #withTailscale<T>(authoritative: boolean, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      await this.#reconcileTailscale(authoritative);
    }
  }

  async #reconcileTailscale(authoritative: boolean): Promise<void> {
    const tailscale = this.#tailscale;
    if (!tailscale) return;
    try {
      const runtime = await this.#runtime.current();
      // Without a Host there is no route to agree with, so nothing changes.
      if (!runtime) return;
      const host = await this.#host.status();
      await tailscale.reconcile({
        authoritative,
        hostOrigin: PersonalHostRuntimeRecordSchema.parse(runtime).localOrigin,
        routeOrigin: host.mode === "private" ? (host.route?.document.route.origin ?? null) : null,
      });
    } catch (error) {
      this.#log?.("desktop.personal.tailscale.reconcile-failed", error);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutations.run("remote-access", () => {
      if (this.#shutdown) throw new Error("Personal remote access is stopping.");
      return this.#runWithStatus(operation);
    });
  }

  async #runWithStatus<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      try {
        return await operation();
      } catch (error) {
        if (this.#shutdown) throw error;
        const runtime = await this.#runtime.current().catch(() => null);
        const hostStatus = runtime ? await this.#host.status().catch(() => null) : null;
        const message = publicError(error);
        this.#set(
          runtime && hostStatus
            ? fromHost(runtime, hostStatus, "error", message, true)
            : { ...emptyStatus(), detail: message, phase: "error", retryable: true },
        );
        throw error;
      }
    };
    return run();
  }

  #set(status: DesktopPersonalRemoteAccessStatus): DesktopPersonalRemoteAccessStatus {
    this.#status = DesktopPersonalRemoteAccessStatusSchema.parse(status);
    for (const listener of this.#listeners) listener(this.#status);
    return this.#status;
  }
}

function fromHost(
  runtime: PersonalHostRuntimeRecord,
  host: PersonalRemoteAccessStatus,
  phase?: DesktopPersonalRemoteAccessStatus["phase"],
  detail: string | null = null,
  retryable = false,
): DesktopPersonalRemoteAccessStatus {
  return DesktopPersonalRemoteAccessStatusSchema.parse({
    deploymentId: runtime.discovery.deploymentId,
    detail,
    generation: host.generation,
    mode: host.mode,
    phase: phase ?? (host.mode === "off" ? "off" : host.mode === "connect" ? "ready" : "ready"),
    retryable,
    routeOrigin: host.route?.document.route.origin ?? null,
    schemaVersion: 1,
  });
}

function emptyStatus(): DesktopPersonalRemoteAccessStatus {
  return DesktopPersonalRemoteAccessStatusSchema.parse({
    deploymentId: null,
    detail: null,
    generation: 0,
    mode: "off",
    phase: "unavailable",
    retryable: false,
    routeOrigin: null,
    schemaVersion: 1,
  });
}

function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Personal remote access failed.";
  return value.replace(/[\r\n]+/gu, " ").slice(0, 1_000) || "Personal remote access failed.";
}
