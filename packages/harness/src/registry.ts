import {
  OpensteerError,
  type HarnessId,
  type HarnessInstanceId,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { profileHarnessProviderStoreScope } from "./types.js";
import type {
  HarnessAdapter,
  HarnessAuthenticationStart,
  HarnessAuthenticationSelection,
  HarnessCapabilities,
  HarnessDriver,
  HarnessDriverReadiness,
  HarnessDriverState,
  HarnessInspectionResult,
  HarnessInstalledEngine,
  HarnessInstanceDefinition,
  HarnessInstanceState,
  HarnessProviderState,
  HarnessProviderStoreScope,
  HarnessModelCommandContext,
  HarnessProcessLaunchWrapper,
  HarnessRuntimeBoundary,
  HarnessSourceDescriptor,
} from "./types.js";

interface RegisteredDriver {
  readonly driver: HarnessDriver;
  readonly environmentVariables: readonly string[];
  readonly installed?: HarnessInstalledEngine;
  /** One driver per executable the person's CLI was found at. */
  readonly installedDrivers: Map<string, HarnessDriver>;
  readonly readiness: HarnessDriverReadiness;
}

interface RegistryEntry {
  definition: HarnessInstanceDefinition;
  state: HarnessInstanceState;
  adapterPromise?: Promise<HarnessAdapter>;
  preparationKey?: string;
}

interface PreparationEntry {
  readonly controller: AbortController;
  readonly instanceId: HarnessInstanceId;
  readonly key: string;
  promise: Promise<void>;
  error?: unknown;
  status: "pending" | "ready" | "failed";
}

export class HarnessRegistry {
  readonly #drivers = new Map<HarnessId, RegisteredDriver>();
  readonly #instances = new Map<HarnessInstanceId, RegistryEntry>();
  readonly #preparations = new Map<string, PreparationEntry>();
  readonly #preparationListeners = new Set<(instanceId: HarnessInstanceId) => void>();
  #closed = false;
  /**
   * Every instance mutation and adapter creation runs on this one chain, so a
   * reconciliation can never interleave with itself or with a run that is
   * materializing an adapter for the entry it is about to replace.
   */
  #mutations: Promise<unknown> = Promise.resolve();

  /**
   * `installed` is the person's own install of this engine. Accounts using the
   * person's own sign-in run it; every other account runs `driver`.
   */
  registerDriver(
    driver: HarnessDriver,
    readiness: HarnessDriverReadiness = { status: "runtime-check" },
    installed?: HarnessInstalledEngine,
  ): void {
    if (this.#drivers.has(driver.kind)) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness driver ${driver.kind} is already registered`,
      });
    }
    this.#drivers.set(driver.kind, {
      driver,
      environmentVariables: normalizeEnvironmentVariables(driver.environmentVariables ?? []),
      ...(installed ? { installed } : {}),
      installedDrivers: new Map(),
      readiness: normalizeReadiness(readiness),
    });
  }

  /**
   * The driver an account runs on, or why it cannot run on this computer. The
   * person's CLI is looked up on every use, so one installed after the Runner
   * started is found, and there is no shipped engine to fall back to: an
   * account using the person's own sign-in runs their CLI or nothing.
   */
  #runningDriver(
    registered: RegisteredDriver,
    stateKind: HarnessProviderState["kind"],
  ): HarnessDriver | { readonly unavailable: string } {
    if (stateKind !== "ambient" || !registered.installed) return registered.driver;
    const executable = registered.installed.locate();
    if (!executable) return { unavailable: registered.installed.missing };
    let driver = registered.installedDrivers.get(executable);
    if (!driver) {
      driver = registered.installed.create(executable);
      registered.installedDrivers.set(executable, driver);
    }
    return driver;
  }

  environmentVariables(kind: HarnessId): readonly string[] {
    return this.#drivers.get(kind)?.environmentVariables ?? [];
  }

  subscribePreparations(listener: (instanceId: HarnessInstanceId) => void): () => void {
    this.#assertOpen();
    this.#preparationListeners.add(listener);
    return () => {
      this.#preparationListeners.delete(listener);
    };
  }

  /**
   * The store scope the Runner must resolve for this driver. An unregistered or
   * unavailable driver answers `profile`, the scope that can never let two
   * profiles reach each other's provider conversations.
   */
  providerStoreScope(kind: HarnessId): HarnessProviderStoreScope {
    return this.#drivers.get(kind)?.driver.providerStoreScope ?? profileHarnessProviderStoreScope;
  }

  /**
   * The launch wrapper that puts one command where this driver's model
   * commands run. A driver that cannot replay its command sandbox, and a driver
   * that is not registered, leave the launch as it is.
   */
  async modelCommandLaunch(
    kind: HarnessId,
    context: HarnessModelCommandContext,
  ): Promise<HarnessProcessLaunchWrapper> {
    const registered = this.#drivers.get(kind);
    const driver = registered && this.#runningDriver(registered, context.providerState.kind);
    if (driver && "unavailable" in driver) {
      throw new OpensteerError({ code: "not_found", message: driver.unavailable });
    }
    return driver?.modelCommandLaunch ? driver.modelCommandLaunch(context) : (launch) => launch;
  }

  /**
   * The capabilities every adapter of this driver runs with. Reading them from
   * the driver keeps inspection free of throwaway adapters.
   */
  driverCapabilities(kind: HarnessId): HarnessCapabilities | undefined {
    const registered = this.#drivers.get(kind);
    if (!registered || registered.readiness.status === "unavailable") return undefined;
    return registered.driver.capabilities;
  }

  /**
   * The sources every account of this driver may name. They are a property of
   * the driver, so the Runner advertises them from the driver's own declaration
   * rather than from any profile that happens to exist. An engine that runs
   * the person's own install offers their sign-in only while that install is
   * on this computer.
   */
  driverSources(kind: HarnessId): readonly HarnessSourceDescriptor[] | undefined {
    const registered = this.#drivers.get(kind);
    if (!registered || registered.readiness.status === "unavailable") return undefined;
    if (!registered.installed || registered.installed.locate()) return registered.driver.sources;
    return registered.driver.sources.flatMap((source) => {
      const stateKinds = source.stateKinds.filter((stateKind) => stateKind !== "ambient");
      return stateKinds.length > 0 ? [{ ...source, stateKinds }] : [];
    });
  }

  /**
   * The Thread access modes every Run of this driver can be held to. Like its
   * sources they are a static declaration, so the Runner advertises them from
   * the driver rather than from any profile.
   */
  driverAccessModes(kind: HarnessId): readonly ThreadAccessMode[] | undefined {
    const registered = this.#drivers.get(kind);
    if (!registered || registered.readiness.status === "unavailable") return undefined;
    return registered.driver.accessModes;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    // The tail deliberately swallows outcomes: one caller's failure must not
    // cancel or reject the next mutation waiting behind it.
    const result = this.#mutations.then(operation);
    this.#mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  listDrivers(): readonly HarnessDriverState[] {
    return [...this.#drivers.entries()].map(([kind, entry]) => ({
      kind,
      readiness: entry.readiness,
    }));
  }

  canRunDriver(kind: HarnessId): boolean {
    const driver = this.#drivers.get(kind);
    return driver !== undefined && driver.readiness.status !== "unavailable";
  }

  async inspectDefinition(
    definition: HarnessInstanceDefinition,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<HarnessInspectionResult> {
    this.#assertOpen();
    const registered = this.#drivers.get(definition.driverKind);
    if (!registered || registered.readiness.status === "unavailable") {
      return {
        detail:
          registered?.readiness.status === "unavailable"
            ? registered.readiness.reason
            : `Harness driver ${definition.driverKind} is not installed`,
        status: "unavailable",
      };
    }
    const parsed = registered.driver.configSchema.safeParse(definition.config);
    if (!parsed.success) {
      return {
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")
          .slice(0, 500),
        status: "unavailable",
      };
    }
    const driver = this.#runningDriver(registered, definition.stateKind);
    if ("unavailable" in driver) return { detail: driver.unavailable, status: "unavailable" };
    if (!driver.inspect) {
      return {
        detail: `Harness driver ${definition.driverKind} does not expose a model catalog`,
        status: "unavailable",
      };
    }
    const preparation = await this.#prepareDefinition(
      definition,
      parsed.data,
      environment,
      runtimeBoundary,
      providerState,
      workingDirectory,
      driver,
    );
    if (preparation) {
      if (preparation.status === "failed") {
        this.#preparations.delete(preparation.key);
        throw preparation.error;
      }
      if (preparation.status === "pending") {
        return { detail: `Preparing ${definition.name}…`, status: "preparing" };
      }
    }
    const result = await driver.inspect({
      config: parsed.data,
      environment,
      providerState,
      runtimeBoundary,
      signal,
      sourceId: definition.sourceId,
      workingDirectory,
    });
    // Sign-in may belong to the person's CLI or cloud identity. Only a
    // managed setup method promises an authentication action from this driver.
    if ((result.setupMethods?.length ?? 0) > 0 && !driver.authenticate) {
      throw new OpensteerError({
        code: "harness_error",
        message: `Harness driver ${definition.driverKind} advertised setup methods without implementing authentication`,
      });
    }
    if (result.status === "ready" && result.models.length === 0) {
      return {
        detail: `Harness ${definition.name} did not report any available models`,
        status: "unavailable",
      };
    }
    return result;
  }

  async authenticateDefinition(
    definition: HarnessInstanceDefinition,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    signal: AbortSignal,
    selection: HarnessAuthenticationSelection,
  ): Promise<HarnessAuthenticationStart> {
    this.#assertOpen();
    const registered = this.#drivers.get(definition.driverKind);
    if (!registered || registered.readiness.status === "unavailable") {
      throw new OpensteerError({
        code: "harness_error",
        message:
          registered?.readiness.status === "unavailable"
            ? registered.readiness.reason
            : `Harness driver ${definition.driverKind} is not installed`,
      });
    }
    const driver = this.#runningDriver(registered, definition.stateKind);
    if ("unavailable" in driver) {
      throw new OpensteerError({ code: "not_found", message: driver.unavailable });
    }
    if (!driver.authenticate) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness driver ${definition.driverKind} does not support managed sign-in`,
      });
    }
    const parsedConfig = driver.configSchema.parse(definition.config);
    const preparation = await this.#prepareDefinition(
      definition,
      parsedConfig,
      environment,
      runtimeBoundary,
      providerState,
      workingDirectory,
      driver,
    );
    if (preparation?.status === "failed") {
      this.#preparations.delete(preparation.key);
      throw preparation.error;
    }
    if (preparation?.status === "pending") {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness ${definition.name} is still preparing`,
        retryable: true,
      });
    }
    return driver.authenticate(
      {
        config: parsedConfig,
        environment,
        providerState,
        runtimeBoundary,
        signal,
        sourceId: definition.sourceId,
        workingDirectory,
      },
      selection,
    );
  }

  async logoutDefinition(
    definition: HarnessInstanceDefinition,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    signal: AbortSignal,
    connectionSlot?: string,
  ): Promise<void> {
    await this.closeInstance(definition.id);
    const registered = this.#drivers.get(definition.driverKind);
    if (!registered || registered.readiness.status === "unavailable") {
      throw new OpensteerError({
        code: "harness_error",
        message:
          registered?.readiness.status === "unavailable"
            ? registered.readiness.reason
            : `Harness driver ${definition.driverKind} is not installed`,
      });
    }
    const driver = this.#runningDriver(registered, definition.stateKind);
    if ("unavailable" in driver) {
      throw new OpensteerError({ code: "not_found", message: driver.unavailable });
    }
    if (!driver.logout) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness driver ${definition.driverKind} does not support sign out`,
      });
    }
    await driver.logout(
      {
        config: driver.configSchema.parse(definition.config),
        environment,
        providerState,
        runtimeBoundary,
        signal,
        sourceId: definition.sourceId,
        workingDirectory,
      },
      connectionSlot ? { connectionSlot } : {},
    );
  }

  /**
   * Releases the provider-owned half of one profile. Provider cleanup is
   * best-effort on purpose: a missing driver or a configuration this Runner can
   * no longer parse must never block the caller from deleting the Runner-owned
   * state directory, the Host record, and any stored credential.
   */
  async removeDefinition(
    definition: HarnessInstanceDefinition,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.closeInstance(definition.id);
    const registered = this.#drivers.get(definition.driverKind);
    if (!registered || registered.readiness.status === "unavailable") return;
    const driver = this.#runningDriver(registered, definition.stateKind);
    if ("unavailable" in driver) return;
    const removeProfile = driver.removeProfile;
    if (!removeProfile) return;
    const parsed = driver.configSchema.safeParse(definition.config);
    if (!parsed.success) return;
    await removeProfile.call(driver, {
      config: parsed.data,
      environment,
      providerState,
      runtimeBoundary,
      signal,
      sourceId: definition.sourceId,
      workingDirectory,
    });
  }

  closeInstance(instanceId: HarnessInstanceId): Promise<void> {
    return this.#serialize(() => this.#closeInstance(instanceId));
  }

  async #closeInstance(instanceId: HarnessInstanceId): Promise<void> {
    const entry = this.#instances.get(instanceId);
    this.#instances.delete(instanceId);
    await this.#cancelPreparations(instanceId);
    if (entry) await closeRegistryEntry(entry);
  }

  configureInstance(definition: HarnessInstanceDefinition): HarnessInstanceState {
    if (this.#instances.has(definition.id)) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness instance ${definition.id} is already configured`,
      });
    }
    const registered = this.#drivers.get(definition.driverKind);
    let state: HarnessInstanceState;
    if (!registered) {
      state = {
        definition,
        reason: `Driver ${definition.driverKind} is not installed`,
        status: "unavailable",
      };
    } else if (registered.readiness.status === "unavailable") {
      state = {
        definition,
        reason: registered.readiness.reason,
        status: "unavailable",
      };
    } else {
      const parsed = registered.driver.configSchema.safeParse(definition.config);
      state = parsed.success
        ? { definition: { ...definition, config: parsed.data }, status: "available" }
        : {
            definition,
            reason: parsed.error.issues.map((issue) => issue.message).join("; "),
            status: "unavailable",
          };
    }
    this.#instances.set(definition.id, { definition: state.definition, state });
    return state;
  }

  /**
   * Reconciles one desired instance without disturbing unrelated instances.
   * Presentation-only changes retain the live adapter; every runtime-relevant
   * change closes the old adapter before installing the replacement.
   */
  upsertInstance(definition: HarnessInstanceDefinition): Promise<HarnessInstanceState> {
    return this.#serialize(() => this.#upsertInstance(definition));
  }

  async #upsertInstance(definition: HarnessInstanceDefinition): Promise<HarnessInstanceState> {
    const existing = this.#instances.get(definition.id);
    if (!existing) return this.configureInstance(definition);
    const registered = this.#drivers.get(definition.driverKind);
    const parsed = registered?.driver.configSchema.safeParse(definition.config);
    const candidate = parsed?.success ? { ...definition, config: parsed.data } : definition;

    if (candidate.runtimeRevision < existing.definition.runtimeRevision) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness instance ${candidate.id} received stale runtime revision ${candidate.runtimeRevision}`,
      });
    }
    if (candidate.runtimeRevision === existing.definition.runtimeRevision) {
      if (
        runtimeDefinitionFingerprint(existing.definition) !==
        runtimeDefinitionFingerprint(candidate)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: `Harness instance ${candidate.id} changed runtime definition without advancing its revision`,
        });
      }
      const nextDefinition = { ...existing.state.definition, name: candidate.name };
      existing.definition = nextDefinition;
      existing.state =
        existing.state.status === "available"
          ? { definition: nextDefinition, status: "available" }
          : { definition: nextDefinition, reason: existing.state.reason, status: "unavailable" };
      return existing.state;
    }

    // The doomed entry leaves the lookup table before its adapter is awaited,
    // so nothing can reach it and re-create an adapter on a superseded
    // definition while the close is in flight.
    this.#instances.delete(candidate.id);
    await this.#cancelPreparations(candidate.id);
    await closeRegistryEntry(existing);
    return this.configureInstance(candidate);
  }

  /** Removes exactly one instance and releases only resources it owns. */
  removeInstance(instanceId: HarnessInstanceId): Promise<boolean> {
    return this.#serialize(() => this.#removeInstance(instanceId));
  }

  async #removeInstance(instanceId: HarnessInstanceId): Promise<boolean> {
    const existing = this.#instances.get(instanceId);
    if (!existing) return false;
    this.#instances.delete(instanceId);
    await this.#cancelPreparations(instanceId);
    await closeRegistryEntry(existing);
    return true;
  }

  /**
   * Applies a complete desired instance set. Removed and replaced entries close
   * before additions are made, so one id never maps to two live adapters at
   * once, and a definition this Runner cannot accept becomes instance state
   * rather than an exception: one broken profile must not poison the registry.
   */
  reconcileInstances(
    definitions: readonly HarnessInstanceDefinition[],
  ): Promise<readonly HarnessInstanceState[]> {
    return this.#serialize(async () => {
      const desiredIds = new Set(definitions.map(({ id }) => id));
      for (const instanceId of this.#instances.keys()) {
        if (!desiredIds.has(instanceId)) await this.#removeInstance(instanceId);
      }
      for (const definition of definitions) {
        try {
          await this.#upsertInstance(definition);
        } catch (error) {
          await this.#rejectDefinition(definition, error);
        }
      }
      return this.listInstances();
    });
  }

  /**
   * Records a desired definition this Runner refused. The old adapter is
   * released because the Host no longer describes what it was running.
   */
  async #rejectDefinition(definition: HarnessInstanceDefinition, error: unknown): Promise<void> {
    await this.#removeInstance(definition.id);
    const reason = (
      error instanceof Error ? error.message : `Harness instance ${definition.id} was refused`
    ).slice(0, 500);
    this.#instances.set(definition.id, {
      definition,
      state: { definition, reason, status: "unavailable" },
    });
  }

  listInstances(): readonly HarnessInstanceState[] {
    return [...this.#instances.values()].map((entry) => entry.state);
  }

  state(instanceId: HarnessInstanceId): HarnessInstanceState | undefined {
    return this.#instances.get(instanceId)?.state;
  }

  adapter(instanceId: HarnessInstanceId): Promise<HarnessAdapter> {
    return this.#serialize(() => this.#adapter(instanceId));
  }

  async #adapter(instanceId: HarnessInstanceId): Promise<HarnessAdapter> {
    const entry = this.#instances.get(instanceId);
    if (!entry) {
      throw new OpensteerError({
        code: "not_found",
        message: `Harness instance ${instanceId} is not configured`,
      });
    }
    if (entry.state.status === "unavailable") {
      throw new OpensteerError({ code: "harness_error", message: entry.state.reason });
    }
    if (entry.adapterPromise) return entry.adapterPromise;
    const registered = this.#drivers.get(entry.definition.driverKind);
    if (!registered || registered.readiness.status === "unavailable") {
      throw new OpensteerError({
        code: "harness_error",
        message: `Harness driver ${entry.definition.driverKind} is unavailable`,
      });
    }
    const driver = this.#runningDriver(registered, entry.definition.stateKind);
    if ("unavailable" in driver) {
      throw new OpensteerError({ code: "harness_error", message: driver.unavailable });
    }
    if (driver.prepare) {
      const preparation = entry.preparationKey
        ? this.#preparations.get(entry.preparationKey)
        : undefined;
      if (!preparation || preparation.status === "pending") {
        throw new OpensteerError({
          code: "conflict",
          message: `Harness ${entry.definition.name} is still preparing`,
          retryable: true,
        });
      }
      if (preparation.status === "failed") {
        throw new OpensteerError({
          cause: preparation.error,
          code: "harness_error",
          message:
            preparation.error instanceof Error
              ? preparation.error.message
              : `Harness ${entry.definition.name} preparation failed`,
        });
      }
    }
    const promise = driver.create({
      config: entry.state.definition.config,
      instanceId,
      sourceId: entry.state.definition.sourceId,
    });
    entry.adapterPromise = promise;
    try {
      return await promise;
    } catch (error) {
      delete entry.adapterPromise;
      throw new OpensteerError({
        cause: error,
        code: "harness_error",
        message: error instanceof Error ? error.message : "Harness instance failed to start",
      });
    }
  }

  async #prepareDefinition(
    definition: HarnessInstanceDefinition,
    config: unknown,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    driver: HarnessDriver,
  ): Promise<PreparationEntry | undefined> {
    return this.#serialize(() =>
      this.#prepareDefinitionLocked(
        definition,
        config,
        environment,
        runtimeBoundary,
        providerState,
        workingDirectory,
        driver,
      ),
    );
  }

  async #prepareDefinitionLocked(
    definition: HarnessInstanceDefinition,
    config: unknown,
    environment: Readonly<Record<string, string>>,
    runtimeBoundary: HarnessRuntimeBoundary,
    providerState: HarnessProviderState,
    workingDirectory: string,
    driver: HarnessDriver,
  ): Promise<PreparationEntry | undefined> {
    const prepare = driver.prepare;
    if (!prepare) return undefined;
    this.#assertOpen();
    this.#assertConfiguredDefinitionMatches(definition, config);
    const key = preparationFingerprint(
      definition,
      config,
      environment,
      runtimeBoundary,
      providerState,
      workingDirectory,
    );
    const configured = this.#instances.get(definition.id);
    const existing = this.#preparations.get(key);
    if (existing) {
      if (configured) configured.preparationKey = key;
      return existing;
    }

    const superseded = [...this.#preparations.values()].filter(
      (preparation) => preparation.instanceId === definition.id,
    );
    for (const preparation of superseded) {
      this.#preparations.delete(preparation.key);
      preparation.controller.abort(new Error("Harness preparation inputs changed"));
    }
    await Promise.allSettled(superseded.map(({ promise }) => promise));
    this.#assertOpen();
    this.#assertConfiguredDefinitionMatches(definition, config);
    if (configured && this.#instances.get(definition.id) !== configured) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness instance ${definition.id} changed while preparation was retiring`,
        retryable: true,
      });
    }
    if (configured) configured.preparationKey = key;

    const controller = new AbortController();
    const entry: PreparationEntry = {
      controller,
      instanceId: definition.id,
      key,
      promise: Promise.resolve(),
      status: "pending",
    };
    entry.promise = Promise.resolve()
      .then(() =>
        prepare.call(driver, {
          config,
          environment,
          providerState,
          runtimeBoundary,
          signal: controller.signal,
          sourceId: definition.sourceId,
          workingDirectory,
        }),
      )
      .then(
        () => {
          if (this.#preparations.get(key) !== entry) return;
          entry.status = "ready";
          this.#notifyPreparationSettled(entry.instanceId);
        },
        (error: unknown) => {
          if (this.#preparations.get(key) !== entry) return;
          entry.error = error;
          entry.status = "failed";
          this.#notifyPreparationSettled(entry.instanceId);
        },
      );
    this.#preparations.set(key, entry);
    return entry;
  }

  async #cancelPreparations(instanceId: HarnessInstanceId): Promise<void> {
    const preparations = [...this.#preparations.values()].filter(
      (preparation) => preparation.instanceId === instanceId,
    );
    for (const preparation of preparations) {
      this.#preparations.delete(preparation.key);
      preparation.controller.abort(new Error("Harness instance preparation was canceled"));
    }
    await Promise.allSettled(preparations.map(({ promise }) => promise));
    // Work held for the account waits on its preparation settling, and a
    // cancelled one has settled too.
    if (preparations.length > 0) this.#notifyPreparationSettled(instanceId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#preparationListeners.clear();
    const preparations = [...this.#preparations.values()];
    this.#preparations.clear();
    for (const preparation of preparations) {
      preparation.controller.abort(new Error("Harness registry is closing"));
    }
    await Promise.allSettled(preparations.map(({ promise }) => promise));
    const adapters = [...this.#instances.values()].flatMap((entry) =>
      entry.adapterPromise ? [entry.adapterPromise] : [],
    );
    await Promise.allSettled(adapters.map(async (adapter) => (await adapter).close()));
  }

  #assertConfiguredDefinitionMatches(definition: HarnessInstanceDefinition, config: unknown): void {
    const configured = this.#instances.get(definition.id);
    if (
      configured &&
      (configured.definition.runtimeRevision !== definition.runtimeRevision ||
        runtimeDefinitionFingerprint(configured.definition) !==
          runtimeDefinitionFingerprint({ ...definition, config }))
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: `Harness instance ${definition.id} inspection does not match its configured runtime definition`,
        retryable: true,
      });
    }
  }

  #notifyPreparationSettled(instanceId: HarnessInstanceId): void {
    for (const listener of this.#preparationListeners) {
      try {
        listener(instanceId);
      } catch {
        // A broken observer cannot prevent other runtime connections from
        // learning that preparation settled.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new OpensteerError({
        code: "conflict",
        message: "Harness registry is closed",
      });
    }
  }
}

/**
 * Whether work for an AI account that is not ready should wait for it. An
 * account finishes preparing on its own and a failed inspection is asked
 * again; one that is signed out or unavailable waits on a person.
 */
export function isRetryableHarnessCatalogStatus(
  status: Exclude<HarnessInstanceCatalog["status"], "ready">,
): boolean {
  switch (status) {
    case "preparing":
    case "error":
      return true;
    case "authentication-required":
    case "unavailable":
      return false;
  }
}

async function closeRegistryEntry(entry: RegistryEntry): Promise<void> {
  const adapter = await entry.adapterPromise?.catch(() => undefined);
  delete entry.adapterPromise;
  await adapter?.close();
}

function runtimeDefinitionFingerprint(definition: HarnessInstanceDefinition): string {
  const { name: _name, runtimeRevision: _runtimeRevision, ...runtimeDefinition } = definition;
  return canonicalJson(runtimeDefinition);
}

function preparationFingerprint(
  definition: HarnessInstanceDefinition,
  config: unknown,
  environment: Readonly<Record<string, string>>,
  runtimeBoundary: HarnessRuntimeBoundary,
  providerState: HarnessProviderState,
  workingDirectory: string,
): string {
  const { name: _name, ...runtimeDefinition } = definition;
  return canonicalJson({
    definition: { ...runtimeDefinition, config },
    environment,
    providerState,
    runtimeBoundary,
    workingDirectory,
  });
}

function normalizeReadiness(readiness: HarnessDriverReadiness): HarnessDriverReadiness {
  if (readiness.status === "unavailable") {
    const reason = readiness.reason.trim();
    if (!reason) throw new TypeError("Unavailable harness drivers require a reason");
    return { reason: reason.slice(0, 500), status: "unavailable" };
  }
  const note = readiness.note?.trim();
  return note
    ? { note: note.slice(0, 500), status: readiness.status }
    : { status: readiness.status };
}

function normalizeEnvironmentVariables(names: readonly string[]): readonly string[] {
  const normalized = [...new Set(names)];
  const invalid = normalized.find((name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name));
  if (invalid) throw new TypeError(`Harness environment variable name ${invalid} is invalid`);
  return Object.freeze(normalized);
}
