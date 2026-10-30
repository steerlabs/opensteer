import type {
  DesktopUseComputerViewInput,
  DesktopUseComputerViewResult,
} from "@opensteer/protocol/desktop";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  ComputerViewHelperRequestSchema,
  ComputerUseHelperRequestSchema,
  computerUseMaxInstalledApps,
  computerUseMaxTimeoutMs,
  computerUseOutOfTimeSentence,
  type LoginReceiverKey,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalKeyProof,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcomeFrame,
  type ComputerUseHelperEvent,
  type ComputerUseHelperMethod,
  type ComputerUseDataGrant,
  type ComputerUseDataGrants,
  type ComputerUsePermissions,
  type ComputerUsePermissionPane,
  type ComputerUseResolvedApp,
} from "@opensteer/protocol";
import {
  ComputerUseBridgeServer,
  ComputerUseSessionOwnership,
  type ComputerUseBridgeHelperPort,
  type ComputerUseBridgeServerOptions,
  type PasswordsAuthorityPort,
} from "./computer-use-bridge-server.js";
import {
  ComputerUseHelperClient,
  ComputerUseHelperFailure,
  untilComputerUseDeadline,
  type ComputerUseHelperRequestOptions,
  type ComputerUseHelperResult,
} from "./helper-client.js";
import {
  ComputerUseLifecycleLockBusy,
  ensureHelperInstalled,
  installedComputerUseHelperVersion,
  verifyBundledComputerUseHelper,
  type ComputerUseHelperProcess,
} from "./helper-install.js";
import { computerUseHelperLockPath, computerUseHelperSocketPath } from "./helper-paths.js";

/**
 * How long the helper connection may sit with no session and no request
 * before this app lets it go. The helper quits after fifteen minutes with no
 * connection, and a connection kept for a status probe every thirty seconds
 * would keep it running for as long as this app does.
 */
const defaultIdleDisconnectMs = 60_000;
/**
 * The deadline of work somebody at this Mac asked for — the permissions panel,
 * an approval's app lookup — which names none of its own.
 */
const defaultRequestTimeoutMs = 30_000;

/** A Mac whose helper was never installed has neither grant, and was never asked for one. */
const notSetUpPermissions: ComputerUsePermissions = {
  accessibility: "denied",
  screenRecording: "denied",
};

/**
 * A Mac whose helper was never installed has never been asked for a data
 * grant, so each is one the person can allow from here.
 */
/**
 * A Mac with no helper installed. Full Disk Access is never requestable: only
 * System Settings grants it, where the helper's first refused probe lists it.
 */
const notSetUpDataGrants: ComputerUseDataGrants = {
  automation: "requestable",
  calendars: "requestable",
  contacts: "requestable",
  "full-disk-access": "denied",
  reminders: "requestable",
};

export interface ComputerUseBridgeHandle {
  readonly token: string;
  readonly url: URL;
}

/** Where every slot's Runner hands the Host's approval frames, by slot. */
export interface ComputerUseApprovalsPort {
  disconnected(deploymentId: DeploymentId): void;
  list(deploymentId: DeploymentId, list: ComputerAppApprovalList): void;
  outcome(deploymentId: DeploymentId, frame: ComputerAppApprovalOutcomeFrame): void;
  proveKeyChallenge(
    deploymentId: DeploymentId,
    challenge: ComputerAppApprovalKeyChallenge,
  ): Promise<ComputerAppApprovalKeyProof>;
}

/** An app call on this Mac that found one of the helper's grants missing. */
export type ComputerUseDataPermissionPort = NonNullable<
  ComputerUseBridgeServerOptions["onDataPermissionRequired"]
>;

export interface ComputerUseServiceOptions {
  readonly appBundleId: string;
  readonly appVersion: string;
  /** The helper this build ships, already resolved for packaged/development. */
  readonly bundledHelperPath: () => string;
  readonly homeDirectory?: string;
  readonly idleDisconnectMs?: number;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  /** The one clock every deadline on this Mac is read against. */
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly run?: ComputerUseHelperProcess;
  readonly teamId: string | null;
}

/**
 * Everything the Runner is not allowed to do itself: installing, verifying and
 * launching the helper, the one IPC client every slot shares, and one loopback
 * bridge per slot.
 *
 * It is wired for **every** supervised slot, whether or not that slot runs
 * agents: computer use reaches a Mac through the `integrations` module, which a
 * reach-only Runner has, so gating it on `runAgents` would make the feature
 * depend on a switch that is about something else entirely.
 *
 * A readiness probe never installs or launches anything it does not have to:
 * a Mac where computer use was never set up reports both grants missing, and a
 * helper that is asleep is answered for by the grants it last reported. Real
 * work — a session, the picker, an approval, the permissions panel — is what
 * installs and launches the helper, and the connection goes again once it has
 * been idle, so the helper's own idle quit can happen.
 *
 * On anything but macOS the service is inert: `startForSlot` answers null and
 * no environment variable is set, which is exactly how the Runner states
 * "Computer use needs the Opensteer desktop app on this Mac."
 */
export class ComputerUseService {
  readonly #bridges = new Map<string, ComputerUseBridgeServer>();
  readonly #now: () => number;
  readonly #options: ComputerUseServiceOptions;
  readonly #ownership = new ComputerUseSessionOwnership();
  readonly #platform: NodeJS.Platform;
  #client: ComputerUseHelperClient | null = null;
  #clientPromise: Promise<ComputerUseHelperClient> | null = null;
  /**
   * What installing works to while it is in flight: the latest deadline of the
   * requests waiting on it, so one that joins late is not refused for an
   * earlier one's lack of time.
   */
  #installing: { at: number } | null = null;
  /**
   * Every bridge connection's interest in the helper, held here rather than on
   * a client: a Runner connects before the helper is reached, and one that
   * connected while the helper could not be installed must still hear a Stop
   * from the helper that a later request brings up.
   */
  readonly #helperEvents = new Set<(event: ComputerUseHelperEvent) => void>();
  readonly #helperDisconnects = new Set<() => void>();
  #approvals: ComputerUseApprovalsPort | null = null;
  #dataPermissionRequired: ComputerUseDataPermissionPort | null = null;
  /** Work this service has started and not finished, connecting included. */
  #active = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The grants the helper last reported since this app started, if it has. */
  #ownerViewVersion: number | undefined;
  #ownerInputVersion: 2 | undefined;
  #computerUseVersion: 2 | undefined;
  #loginReceiver: LoginReceiverKey | null = null;
  readonly #capabilityListeners = new Set<() => void>();
  #lastKnownPermissions: ComputerUsePermissions | null = null;
  #lastKnownDataGrants: ComputerUseDataGrants | null = null;
  #stopped = false;

  constructor(options: ComputerUseServiceOptions) {
    this.#now = options.now ?? Date.now;
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  get supported(): boolean {
    return this.#platform === "darwin";
  }

  /**
   * The slot's bridge, or null where computer use does not exist.
   *
   * Starting it does not start the helper: the listener and the token are what
   * the Runner needs in its environment, and the helper is launched by the
   * first request that actually needs it.
   */
  async startForSlot(
    deploymentIdInput: string,
    passwords?: PasswordsAuthorityPort,
  ): Promise<ComputerUseBridgeHandle | null> {
    if (!this.supported || this.#stopped) return null;
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const existing = this.#bridges.get(deploymentId);
    if (existing) return { token: existing.token, url: existing.url };
    const server = new ComputerUseBridgeServer({
      helper: this.#helperPort(),
      ...(passwords ? { passwords } : {}),
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
      now: this.#now,
      onDataPermissionRequired: (input) => this.#dataPermissionRequired?.(input),
      ownership: this.#ownership,
      // The slot's Deployment is fixed here, by the supervisor that started
      // it, and never taken from the Runner: a list is that Host's, and an
      // answer goes back to that Host and no other.
      approvals: {
        disconnected: () => this.#approvals?.disconnected(deploymentId),
        list: (list) => this.#approvals?.list(deploymentId, list),
        outcome: (frame) => this.#approvals?.outcome(deploymentId, frame),
        proveKeyChallenge: async (challenge) => {
          if (!this.#approvals) throw new Error("Computer app approvals are unavailable.");
          return this.#approvals.proveKeyChallenge(deploymentId, challenge);
        },
      },
    });
    const url = await server.start();
    if (this.#stopped) {
      await server.close();
      return null;
    }
    this.#bridges.set(deploymentId, server);
    return { token: server.token, url };
  }

  async useComputerViewOnThisMac(
    input: DesktopUseComputerViewInput,
  ): Promise<DesktopUseComputerViewResult> {
    this.#assertSupported();
    const bridge = this.#bridges.get(input.deploymentId);
    if (!bridge) return { activated: false, reason: "unavailable" };
    try {
      await bridge.activateView(input);
      return { activated: true };
    } catch (error) {
      if (error instanceof ComputerUseHelperFailure) {
        switch (error.code) {
          case "no-session":
            return { activated: false, reason: "view-ended" };
          case "app-not-allowed":
          case "app-not-found":
          case "app-not-running":
            return { activated: false, reason: "app-changed" };
          case "permission-required":
            return { activated: false, reason: "permission-required" };
        }
      }
      // The renderer IPC boundary records unexpected activation causes once,
      // then returns its fixed human result. This path bypasses Runner logging.
      throw error;
    }
  }

  /**
   * Receives every slot's approval lists and outcomes. Desktop main holds no
   * Host connection of its own: each Host reaches this Mac through the Runner
   * it supervises, on that Runner's own authenticated stream.
   */
  attachApprovals(port: ComputerUseApprovalsPort): () => void {
    this.#approvals = port;
    return () => {
      if (this.#approvals === port) this.#approvals = null;
    };
  }

  /**
   * Hears every slot's app call that found a macOS grant missing, whichever
   * Deployment it came from: the grant is this Mac's, and so is the person who
   * can give it.
   */
  attachDataPermissionOffers(port: ComputerUseDataPermissionPort): () => void {
    this.#dataPermissionRequired = port;
    return () => {
      if (this.#dataPermissionRequired === port) this.#dataPermissionRequired = null;
    };
  }

  /**
   * The person's answer, to the Runner of the slot the approval came from.
   * False when that Runner is not connected to this desktop right now.
   */
  sendApprovalAnswer(
    deploymentId: DeploymentId,
    frame: ComputerAppApprovalAnswerFrame,
    server: { readonly launchDigest: string; readonly serverId: string } | null,
  ): boolean {
    return this.#bridges.get(deploymentId)?.sendApprovalAnswer(frame, server) ?? false;
  }

  async stopForSlot(deploymentId: string): Promise<void> {
    const server = this.#bridges.get(deploymentId);
    if (!server) return;
    this.#bridges.delete(deploymentId);
    await server.close();
  }

  /**
   * The two grants, read without prompting, for somebody at this Mac. Unlike a
   * Runner's readiness probe it launches the helper, because the permissions
   * panel is where computer use is set up.
   */
  /** Refuses, before any setup panel opens, a helper this build would never launch. */
  async verifyBundledHelper(): Promise<void> {
    this.#assertSupported();
    await verifyBundledComputerUseHelper({
      bundledAppPath: this.#options.bundledHelperPath(),
      ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
      teamId: this.#options.teamId,
    });
  }

  async permissions(): Promise<ComputerUsePermissions> {
    this.#assertSupported();
    return (await this.#request("permissions.get", {})).permissions;
  }

  /**
   * Requests the single grant the person chose. Only somebody at this keyboard
   * reaches it; no Runner does.
   */
  async requestPermissions(pane: ComputerUsePermissionPane): Promise<ComputerUsePermissions> {
    this.#assertSupported();
    return (await this.#request("permissions.request", { pane })).permissions;
  }

  /** The data grants, read without prompting, for somebody at this Mac. */
  async dataGrants(): Promise<ComputerUseDataGrants> {
    this.#assertSupported();
    return (await this.#request("data.status", {})).grants;
  }

  /**
   * Asks macOS for the one data grant the person chose. Only somebody at this
   * keyboard reaches it; the bridge refuses it from every Runner. macOS's
   * question waits for that person, so it has the longest deadline the helper
   * takes rather than the default one.
   */
  async requestDataGrant(grant: ComputerUseDataGrant): Promise<ComputerUseDataGrants> {
    this.#assertSupported();
    const { grants } = await this.#request(
      "data.request",
      { grant },
      { deadline: this.#now() + computerUseMaxTimeoutMs },
    );
    this.announceGrantsChanged();
    return grants;
  }

  /**
   * The person at this Mac may have changed a grant. Forget what the helper
   * last reported so every slot's Runner reads its apps' readiness from the
   * helper again, reconnecting or launching an installed helper if needed,
   * rather than waiting for the Runner's next round.
   */
  announceGrantsChanged(): void {
    this.#lastKnownPermissions = null;
    this.#lastKnownDataGrants = null;
    for (const bridge of this.#bridges.values()) bridge.announceGrantsChanged();
  }

  async resolveApp(app: string): Promise<ComputerUseResolvedApp> {
    this.#assertSupported();
    return (await this.#request("app.resolve", { app })).app;
  }

  /**
   * One app's icon for the approval panel. `app.resolve` carries none — only
   * the picker listing does — so this asks the listing for that bundle id,
   * which the helper matches on the Mac and draws icons for only the matches.
   */
  async appIcon(bundleId: string): Promise<string | null> {
    if (!this.supported) return null;
    const result = await this.#request("apps.installed", {
      icons: true,
      limit: computerUseMaxInstalledApps,
      offset: 0,
      query: bundleId,
    });
    const key = bundleId.toLowerCase();
    return (
      result.apps.find(({ identity }) => identity.bundleId.toLowerCase() === key)?.iconPng ?? null
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelIdleDisconnect();
    const bridges = [...this.#bridges.values()];
    this.#bridges.clear();
    const results = await Promise.allSettled(bridges.map((server) => server.close()));
    const errors: unknown[] = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    const client = this.#client;
    this.#client = null;
    this.#loginReceiver = null;
    this.#clientPromise = null;
    try {
      await client?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Computer-use shutdown failed.");
  }

  #assertSupported(): void {
    if (!this.supported) {
      throw new ComputerUseHelperFailure(
        "unsupported",
        "Computer use runs on macOS only, on the Mac the person is using.",
      );
    }
  }

  /**
   * One helper client for every slot: a second connection would be a second
   * peer for the helper to verify and a second place for a session to be
   * owned, and the helper serializes every action on the Mac either way.
   */
  #helperPort(): ComputerUseBridgeHelperPort {
    return {
      onDisconnect: (listener) => {
        this.#helperDisconnects.add(listener);
        return () => {
          this.#helperDisconnects.delete(listener);
        };
      },
      onEvent: (listener) => {
        this.#helperEvents.add(listener);
        return () => {
          this.#helperEvents.delete(listener);
        };
      },
      ownerViewVersion: () => this.#ownerViewVersion,
      ownerInputVersion: () => this.#ownerInputVersion,
      computerUseVersion: () => this.#computerUseVersion,
      loginReceiver: () => this.#loginReceiver,
      onCapabilitiesChanged: (listener) => {
        this.#capabilityListeners.add(listener);
        return () => this.#capabilityListeners.delete(listener);
      },
      attachDisplay: async (token, onFrame, onLost, options) => {
        const client = await this.#connect(
          options.deadline ?? this.#now() + defaultRequestTimeoutMs,
        );
        return await client.attachDisplay(token, onFrame, onLost, options);
      },
      readinessDataGrants: async (options) => await this.#readinessDataGrants(options),
      readinessPermissions: async (options) => await this.#readinessPermissions(options),
      request: async (method, params, options) => await this.#request(method, params, options),
    };
  }

  /**
   * The grants as a Runner's status probe asks for them: from the helper when
   * it is connected, which is cheap and bypasses its work queue; otherwise
   * from what it last reported. Only when nothing has been reported since this
   * app started or since the person may have changed a grant does a probe
   * launch an installed helper, and a Mac with no helper installed is not set
   * up — it is never installed for a probe.
   */
  async #readinessPermissions(
    options: ComputerUseHelperRequestOptions,
  ): Promise<ComputerUsePermissions> {
    this.#assertSupported();
    const client = this.#client;
    if (client?.connected) {
      const result = await client.request("permissions.get", {}, options);
      this.#lastKnownPermissions = result.permissions;
      return result.permissions;
    }
    if (this.#lastKnownPermissions) return this.#lastKnownPermissions;
    const installed = await installedComputerUseHelperVersion({
      ...(this.#options.homeDirectory === undefined
        ? {}
        : { homeDirectory: this.#options.homeDirectory }),
      ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
    });
    if (installed === null) return notSetUpPermissions;
    return (await this.#request("permissions.get", {}, options)).permissions;
  }

  /** The data grants as a Runner's status probe asks for them, read like `#readinessPermissions`. */
  async #readinessDataGrants(
    options: ComputerUseHelperRequestOptions,
  ): Promise<ComputerUseDataGrants> {
    this.#assertSupported();
    const client = this.#client;
    if (client?.connected) {
      const result = await client.request("data.status", {}, options);
      this.#lastKnownDataGrants = result.grants;
      return result.grants;
    }
    if (this.#lastKnownDataGrants) return this.#lastKnownDataGrants;
    const installed = await installedComputerUseHelperVersion({
      ...(this.#options.homeDirectory === undefined
        ? {}
        : { homeDirectory: this.#options.homeDirectory }),
      ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
    });
    if (installed === null) return notSetUpDataGrants;
    return (await this.#request("data.status", {}, options)).grants;
  }

  /**
   * One piece of real work on the helper, which may install and launch it.
   * While any is in flight the connection is not idle.
   *
   * Its deadline is fixed here, as it arrives, and installing, connecting and
   * the frame itself all work to that one instant: none restarts the count.
   */
  async #request<Method extends ComputerUseHelperMethod>(
    method: Method,
    params: unknown,
    options: ComputerUseHelperRequestOptions = {},
  ): Promise<ComputerUseHelperResult<Method>> {
    const deadline = options.deadline ?? this.#now() + defaultRequestTimeoutMs;
    const receivedAt = performance.now();
    this.#active += 1;
    this.#cancelIdleDisconnect();
    try {
      const client = await this.#connect(deadline);
      if (method === "session.open" || method === "session.act") {
        await client.handshake(deadline);
        const request = ComputerUseHelperRequestSchema.safeParse({ id: 0, method, params });
        if (!request.success)
          throw new ComputerUseHelperFailure(
            "failed",
            "This computer use request could not be read.",
          );
        if (request.data.method === "session.open" && !this.#loginReceiver) {
          const { runId: _runId, ...legacy } = request.data.params;
          params = legacy;
        }
        if (request.data.method === "session.act") {
          const receiver = this.#loginReceiver;
          for (const action of request.data.params.actions) {
            if (action.type !== "type" || typeof action.text === "string") continue;
            const binding = action.text.sealed.binding;
            if (
              !receiver ||
              binding.connectionId !== receiver.connectionId ||
              binding.connectionGeneration !== receiver.connectionGeneration ||
              binding.expiresAt <= this.#now()
            )
              throw new ComputerUseHelperFailure(
                "unsupported",
                "This saved login's connection ended. Request it again.",
              );
          }
        }
      }
      if (method === "view.windows") {
        await client.handshake(deadline);
        if (this.#ownerViewVersion !== 3)
          throw new ComputerUseHelperFailure(
            "unsupported",
            "This Mac's helper does not support owner window selection.",
          );
      } else if (method.startsWith("view.")) {
        await client.handshake(deadline);
        const request = ComputerViewHelperRequestSchema.parse({ id: 0, method, params });
        if (this.#ownerViewVersion !== 3)
          throw new ComputerUseHelperFailure(
            "unsupported",
            "This Mac's helper does not support owner views.",
          );
        const remaining =
          request.params.leaseDurationMs - Math.ceil(performance.now() - receivedAt);
        if (remaining <= 0 && method !== "view.close")
          throw new ComputerUseHelperFailure("no-session", "That owner view lease has expired.");
        params = { ...request.params, leaseDurationMs: Math.max(1, remaining) };
      }
      if (method === "display.input-reset" || method === "display.input") {
        await client.handshake(deadline);
        if (this.#ownerInputVersion !== 2)
          throw new ComputerUseHelperFailure(
            "unsupported",
            "This Mac's helper does not support owner input.",
          );
      }
      const result = await client.request(method, params, { ...options, deadline });
      if (method === "permissions.get" || method === "permissions.request") {
        this.#rememberPermissions(result);
      }
      if (method === "data.status" || method === "data.request") {
        this.#lastKnownDataGrants = (result as { readonly grants: ComputerUseDataGrants }).grants;
      }
      return result;
    } catch (error) {
      // A helper outside this app's protocol range is usually one the other
      // channel installed, or one that would not stop for the last install.
      // Forgetting the client is what retries the install on the next
      // request, which replaces an older one once it can be stopped.
      if (error instanceof ComputerUseHelperFailure && error.code === "incompatible-version") {
        this.#ownerViewVersion = undefined;
        this.#ownerInputVersion = undefined;
        this.#computerUseVersion = undefined;
        this.#forgetClient();
      }
      if (error instanceof ComputerUseLifecycleLockBusy) {
        throw new ComputerUseHelperFailure("failed", error.message, { cause: error });
      }
      throw error;
    } finally {
      this.#active -= 1;
      this.#scheduleIdleDisconnect();
    }
  }

  #rememberPermissions(result: unknown): void {
    if (typeof result !== "object" || result === null || !("permissions" in result)) return;
    const { permissions } = result as { readonly permissions: ComputerUsePermissions };
    this.#lastKnownPermissions = permissions;
  }

  #forgetClient(): void {
    const client = this.#client;
    const hadReceiver = this.#loginReceiver !== null;
    this.#client = null;
    this.#loginReceiver = null;
    if (hadReceiver) for (const listener of this.#capabilityListeners) listener();
    this.#clientPromise = null;
    void client?.close().catch(() => undefined);
  }

  #cancelIdleDisconnect(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #scheduleIdleDisconnect(): void {
    this.#cancelIdleDisconnect();
    if (this.#stopped || !this.#client) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      const client = this.#client;
      if (!client?.connected) return;
      // A session open anywhere, or anything in flight, is a connection in
      // use; it is looked at again once that finishes.
      if (this.#active > 0 || client.pendingRequests > 0 || this.#ownership.size > 0) {
        this.#scheduleIdleDisconnect();
        return;
      }
      this.#options.log?.("desktop.computer-use.helper-idle-disconnect");
      void client.disconnect();
    }, this.#options.idleDisconnectMs ?? defaultIdleDisconnectMs);
    this.#idleTimer.unref();
  }

  async #connect(deadline: number): Promise<ComputerUseHelperClient> {
    this.#assertSupported();
    if (this.#stopped) {
      throw new ComputerUseHelperFailure("failed", "Computer use is shutting down on this Mac.");
    }
    // Nothing is installed or launched for a request that can no longer use it.
    if (deadline <= this.#now()) {
      throw new ComputerUseHelperFailure("failed", computerUseOutOfTimeSentence);
    }
    const existing = this.#clientPromise;
    if (existing) {
      if (this.#installing) this.#installing.at = Math.max(this.#installing.at, deadline);
      return await untilComputerUseDeadline(existing, deadline, this.#now);
    }
    const due = { at: deadline };
    const creating = (async () => {
      const bundledAppPath = this.#options.bundledHelperPath();
      const installed = await ensureHelperInstalled({
        bundledAppPath,
        deadline: due,
        ...(this.#options.homeDirectory === undefined
          ? {}
          : { homeDirectory: this.#options.homeDirectory }),
        ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
        now: this.#now,
        ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
        teamId: this.#options.teamId,
      });
      const client = new ComputerUseHelperClient({
        appBundleId: this.#options.appBundleId,
        appVersion: this.#options.appVersion,
        helperAppPath: installed.path,
        helperLockPath: computerUseHelperLockPath(this.#options.homeDirectory),
        helperProtocolVersion: installed.protocolVersion,
        launchFreshInstance: installed.launchFreshInstance,
        ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
        now: this.#now,
        onHandshake: ({
          permissions,
          ownerViewVersion,
          ownerInputVersion,
          loginText,
          protocolVersion,
        }) => {
          this.#loginReceiver = loginText ?? null;
          this.#ownerViewVersion = ownerViewVersion;
          this.#ownerInputVersion = ownerInputVersion;
          // A Mac whose macOS lacks window groups still speaks this version; the
          // helper refuses each window call with the sentence that says why.
          this.#computerUseVersion = protocolVersion === 10 ? 2 : undefined;
          this.#lastKnownPermissions = permissions;
          for (const listener of this.#capabilityListeners) listener();
        },
        ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
        socketPath: computerUseHelperSocketPath(this.#options.homeDirectory),
        teamId: this.#options.teamId,
        verifierAppPath: bundledAppPath,
      });
      client.onEvent((event) => {
        for (const listener of Array.from(this.#helperEvents)) listener(event);
        // A session the person stopped may have been the last one.
        this.#scheduleIdleDisconnect();
      });
      client.onDisconnect(() => {
        this.#loginReceiver = null;
        for (const listener of Array.from(this.#helperDisconnects)) listener();
      });
      this.#client = client;
      return client;
    })();
    this.#clientPromise = creating;
    this.#installing = due;
    void creating.then(
      () => {
        if (this.#installing === due) this.#installing = null;
      },
      () => {
        if (this.#clientPromise === creating) this.#clientPromise = null;
        if (this.#installing === due) this.#installing = null;
      },
    );
    return await untilComputerUseDeadline(creating, deadline, this.#now);
  }
}
