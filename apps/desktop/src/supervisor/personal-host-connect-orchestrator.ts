import { randomUUID } from "node:crypto";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  ConnectCredentialResponseSchema,
  ConnectOperationIdSchema,
  connectLivenessRefreshIntervalMilliseconds,
  type ConnectCredentialResponse,
  type ConnectOperationId,
} from "@opensteer/control-plane-protocol";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import type { PersonalHostConnectControlPlane } from "@opensteer/client/connections";
import type {
  CloudflaredConnectorConfiguration,
  CloudflaredConnectorStatus,
} from "./cloudflared-connector-supervisor.js";
import type {
  DesktopConnectCredentialState,
  DesktopConnectCredentialStore,
} from "../secrets/connect-credential-store.js";
import {
  PersonalHostConnectProjectionSchema,
  PersonalHostRuntimeRecordSchema,
  assertSamePersonalHostAuthority,
  type PersonalHostConnectProjectionSink,
  type PersonalHostConnectProjection,
  type PersonalHostRuntimeRecord,
  type PersonalHostRuntimeSource,
  type PersonalHostConnectRouteSource,
} from "./personal-host-runtime.js";

export type PersonalHostConnectState =
  "disabled" | "enabled" | "error" | "fenced" | "reconciling" | "stopped" | "unavailable";

export interface PersonalHostConnectStatus {
  readonly deploymentId: DeploymentId;
  readonly detail: string | null;
  readonly generation: number | null;
  readonly state: PersonalHostConnectState;
}

export interface PersonalHostConnectorSupervisor {
  readonly status: CloudflaredConnectorStatus;
  rotateToken(configuration: CloudflaredConnectorConfiguration): Promise<void>;
  start(configuration: CloudflaredConnectorConfiguration): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
}

export interface PersonalHostConnectResourceRevoker {
  revokeConnectResource(operationId: ConnectOperationId): Promise<void>;
}

type ConnectStore = Pick<DesktopConnectCredentialStore, "clear" | "load" | "save">;

/**
 * Always-available, authority-reducing half of Connect. It deliberately has no
 * Account bearer dependency: an exact linked Host can stop and revoke its own
 * reachability even when this Desktop build cannot provision Connect.
 */
export class PersonalHostConnectTeardownCoordinator {
  readonly #deploymentId: DeploymentId;
  readonly #newOperationId: () => ConnectOperationId;
  readonly #projection: PersonalHostConnectProjectionSink;
  readonly #revocation: PersonalHostConnectResourceRevoker;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #store: ConnectStore;
  readonly #supervisor: PersonalHostConnectorSupervisor;
  readonly #mutations = new MutationQueue();

  constructor(options: {
    readonly deploymentId: DeploymentId | string;
    readonly newOperationId?: () => ConnectOperationId;
    readonly projection: PersonalHostConnectProjectionSink;
    readonly revocation: PersonalHostConnectResourceRevoker;
    readonly runtime: PersonalHostRuntimeSource;
    readonly store: ConnectStore;
    readonly supervisor: PersonalHostConnectorSupervisor;
  }) {
    this.#deploymentId = DeploymentIdSchema.parse(options.deploymentId);
    this.#newOperationId =
      options.newOperationId ?? (() => ConnectOperationIdSchema.parse(`cop_${randomUUID()}`));
    this.#projection = options.projection;
    this.#revocation = options.revocation;
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#supervisor = options.supervisor;
  }

  /** Stops the connector, revokes the external resource, and publishes the
   * disabled projection. Identical whether an owner asked for it or a
   * reconcile pass found enabled Host state with no Desktop intent behind it. */
  async disable(): Promise<void> {
    await this.#execute(null, false);
  }

  async revokeResourceForUnlink(operationId: ConnectOperationId): Promise<void> {
    await this.#execute(ConnectOperationIdSchema.parse(operationId), false);
  }

  /** Removes stale Connect state only when Desktop actually has durable work.
   * This lets Off/Private startup stay a no-op when no resource ever existed. */
  reconcileIfPresent(): Promise<boolean> {
    return this.#execute(null, true);
  }

  stopConnector(signal?: AbortSignal): Promise<void> {
    return this.#supervisor.stop(signal);
  }

  #execute(operationId: ConnectOperationId | null, requireStoredState: boolean): Promise<boolean> {
    return this.#mutations.run(async () => {
      const authority = await this.#requireCurrentRuntime();
      let state = await this.#store.load(this.#deploymentId);
      if (!state && requireStoredState) return false;
      await this.#supervisor.stop();
      if (state) {
        this.#assertStoredAuthority(state, authority);
        state = await this.#store.load(this.#deploymentId, authority);
      }

      const revokeOperationId =
        state?.pendingOperation?.kind === "revoke"
          ? state.pendingOperation.operationId
          : (operationId ?? this.#newOperationId());
      if (
        !state ||
        state.pendingOperation?.kind !== "revoke" ||
        state.desiredState !== "disabled"
      ) {
        state = await this.#store.save(this.#deploymentId, {
          authority,
          credential: state?.credential ?? null,
          desiredState: "disabled",
          pendingOperation: { kind: "revoke", operationId: revokeOperationId },
          schemaVersion: 2,
        });
      }

      // Revoking wins over any interrupted provision/rotate intent. The new
      // revoke operation is durable before the first authority-reducing side
      // effect, so a crash can only replay this same operation.
      await this.#revocation.revokeConnectResource(revokeOperationId);
      await this.#publish(authority);
      await this.#store.clear(this.#deploymentId);
      return true;
    });
  }

  async #publish(authority: PersonalHostRuntimeRecord): Promise<void> {
    await this.#assertCurrentAuthority(authority);
    await this.#projection.publish(
      PersonalHostConnectProjectionSchema.parse({
        accessRoute: null,
        authority,
        state: "disabled",
      }),
    );
    await this.#assertCurrentAuthority(authority);
  }

  async #requireCurrentRuntime(): Promise<PersonalHostRuntimeRecord> {
    const runtime = await this.#runtime.current();
    if (!runtime) {
      throw authorityFence("A ready Desktop-owned Personal Host is required for Connect teardown.");
    }
    const parsed = PersonalHostRuntimeRecordSchema.parse(runtime);
    if (parsed.discovery.deploymentId !== this.#deploymentId) {
      throw authorityFence("The Personal Host runtime belongs to another Deployment.");
    }
    return parsed;
  }

  async #assertCurrentAuthority(
    expected: PersonalHostRuntimeRecord,
  ): Promise<PersonalHostRuntimeRecord> {
    const current = await this.#requireCurrentRuntime();
    try {
      assertSamePersonalHostAuthority(expected, current);
    } catch (error) {
      throw authorityFence("The Personal Host authority changed during Connect teardown.", error);
    }
    return current;
  }

  #assertStoredAuthority(
    state: DesktopConnectCredentialState,
    runtime: PersonalHostRuntimeRecord,
  ): void {
    try {
      assertSamePersonalHostAuthority(state.authority, runtime);
    } catch (error) {
      throw authorityFence(
        "Stored Connect credentials belong to an earlier Personal Host authority.",
        error,
      );
    }
  }
}

/**
 * Durable intent and retry coordinator between one Desktop-owned Host, the
 * Account Connect API, protected credential storage, and cloudflared.
 */
export class PersonalHostConnectOrchestrator {
  readonly #controlPlane: Pick<PersonalHostConnectControlPlane, "provision" | "rotate">;
  readonly #deploymentId: DeploymentId;
  readonly #newOperationId: () => ConnectOperationId;
  readonly #projection: PersonalHostConnectProjectionSink;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #routes: PersonalHostConnectRouteSource;
  readonly #store: ConnectStore;
  readonly #supervisor: PersonalHostConnectorSupervisor;
  readonly #teardown: PersonalHostConnectTeardownCoordinator;
  #stopping = false;
  #activeConfiguration: string | null = null;
  #activeIdentity: string | null = null;
  #livenessTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #mutations = new MutationQueue();
  #status: PersonalHostConnectStatus;

  constructor(options: {
    readonly controlPlane: Pick<PersonalHostConnectControlPlane, "provision" | "rotate">;
    readonly deploymentId: DeploymentId | string;
    readonly newOperationId?: () => ConnectOperationId;
    readonly projection: PersonalHostConnectProjectionSink;
    readonly runtime: PersonalHostRuntimeSource;
    readonly routes: PersonalHostConnectRouteSource;
    readonly store: ConnectStore;
    readonly supervisor: PersonalHostConnectorSupervisor;
    readonly teardown: PersonalHostConnectTeardownCoordinator;
  }) {
    this.#controlPlane = options.controlPlane;
    this.#deploymentId = DeploymentIdSchema.parse(options.deploymentId);
    this.#newOperationId =
      options.newOperationId ?? (() => ConnectOperationIdSchema.parse(`cop_${randomUUID()}`));
    this.#projection = options.projection;
    this.#runtime = options.runtime;
    this.#routes = options.routes;
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#teardown = options.teardown;
    this.#status = {
      deploymentId: this.#deploymentId,
      detail: null,
      generation: null,
      state: "stopped",
    };
  }

  get status(): PersonalHostConnectStatus {
    return this.#status;
  }

  reconcile(): Promise<PersonalHostConnectStatus> {
    return this.#execute(async () => {
      const runtime = await this.#runtime.current();
      if (!runtime) {
        this.#stopLivenessRefresh();
        await this.#stopConnector();
        return this.#setStatus("unavailable", null, "No Desktop-owned Personal Host is running.");
      }
      const authority = this.#parseRuntime(runtime);
      let state = await this.#store.load(this.#deploymentId);
      if (!state) {
        this.#stopLivenessRefresh();
        await this.#stopConnector();
        return this.#setStatus("disabled", null, null);
      }
      this.#assertStoredAuthority(state, authority);
      state = (await this.#store.load(this.#deploymentId, authority)) ?? state;
      return this.#reconcileState(state);
    });
  }

  enable(): Promise<PersonalHostConnectStatus> {
    return this.#execute(async () => {
      let authority = await this.#requireCurrentRuntime();
      let state = await this.#store.load(this.#deploymentId);
      if (state) {
        this.#assertStoredAuthority(state, authority);
        state = (await this.#store.load(this.#deploymentId, authority)) ?? state;
        if (state.desiredState === "disabled") {
          // A new enable cannot supersede durable authority-reducing work.
          // Drain the exact revoke before recording a fresh provision intent.
          await this.#reconcileState(state);
          authority = await this.#requireCurrentRuntime();
          state = null;
        }
      }
      if (!state) {
        state = await this.#store.save(this.#deploymentId, {
          authority,
          credential: null,
          desiredState: "enabled",
          pendingOperation: { kind: "provision", operationId: this.#newOperationId() },
          schemaVersion: 2,
        });
      }
      return this.#reconcileState(state);
    });
  }

  /** Stop the local process without changing durable enabled intent. */
  async shutdown(signal?: AbortSignal): Promise<PersonalHostConnectStatus> {
    this.#stopping = true;
    this.#stopLivenessRefresh();
    // Quitting preserves enabled intent. It must never configure a route or
    // require a ready Host/Account merely to stop a local connector. Account
    // liveness expires normally when the Host stops refreshing it.
    await this.#supervisor.stop(signal);
    this.#activeConfiguration = null;
    this.#activeIdentity = null;
    return this.#setStatus("stopped", null, null);
  }

  /** Serializes behind any active reconciliation and permanently disarms its
   * liveness timer before an external owner starts authority reduction. */
  quiesce(): Promise<PersonalHostConnectStatus> {
    return this.#execute(async () => {
      this.#stopLivenessRefresh();
      await this.#stopConnector();
      return this.#setStatus("stopped", null, null);
    });
  }

  #execute(
    operation: () => Promise<PersonalHostConnectStatus>,
  ): Promise<PersonalHostConnectStatus> {
    const run = async () => {
      if (this.#stopping) return this.#status;
      this.#setStatus("reconciling", this.#status.generation, null);
      try {
        return await operation();
      } catch (error) {
        const fenced = isAuthorityFence(error);
        if (fenced) this.#stopLivenessRefresh();
        this.#setStatus(
          fenced ? "fenced" : "error",
          this.#status.generation,
          publicConnectError(error),
        );
        throw error;
      }
    };
    return this.#mutations.run(run);
  }

  async #reconcileState(input: DesktopConnectCredentialState): Promise<PersonalHostConnectStatus> {
    if (input.desiredState === "disabled") this.#stopLivenessRefresh();
    if (input.desiredState === "disabled" || input.pendingOperation?.kind === "revoke") {
      await this.#routes.disableConnect();
      await this.#teardown.disable();
      this.#activeConfiguration = null;
      this.#activeIdentity = null;
      return this.#setStatus("disabled", null, null);
    }
    const state = await this.#reconcileStateRecord(input);
    if (this.#stopping) return this.#status;
    if (!state) {
      this.#stopLivenessRefresh();
      return this.#setStatus("disabled", null, null);
    }
    if (state.desiredState === "disabled") {
      this.#stopLivenessRefresh();
      return this.#setStatus("disabled", null, null);
    }
    if (!state.credential) {
      throw new Error("Opensteer Connect has no usable connector credential.");
    }
    await this.#ensureConnector(state);
    if (this.#stopping) return this.#status;
    const route = await this.#routes.configureConnect(state.credential.routeOrigin);
    await this.#publish(state.authority, "ready", route);
    this.#scheduleLivenessRefresh();
    return this.#setStatus("enabled", state.credential.connectorCredentialGeneration, null);
  }

  #scheduleLivenessRefresh(): void {
    if (this.#stopping || this.#livenessTimer !== null) return;
    this.#livenessTimer = setTimeout(() => {
      this.#livenessTimer = null;
      void this.reconcile().catch((error: unknown) => {
        if (!isAuthorityFence(error)) this.#scheduleLivenessRefresh();
      });
    }, connectLivenessRefreshIntervalMilliseconds);
    this.#livenessTimer.unref?.();
  }

  #stopLivenessRefresh(): void {
    if (this.#livenessTimer === null) return;
    clearTimeout(this.#livenessTimer);
    this.#livenessTimer = null;
  }

  async #reconcileStateRecord(
    input: DesktopConnectCredentialState,
  ): Promise<DesktopConnectCredentialState | null> {
    const operation = input.pendingOperation;
    if (!operation) return input;
    const authority = await this.#assertCurrentAuthority(input.authority);
    const discovery = authority.discovery;
    if (operation.kind === "provision") {
      const credential = await this.#controlPlane.provision(this.#deploymentId, {
        hostInstanceId: discovery.hostInstanceId,
        localOrigin: authority.localOrigin,
        operationId: operation.operationId,
      });
      await this.#assertCurrentAuthority(authority);
      this.#assertCredential(credential, authority);
      return this.#store.save(this.#deploymentId, {
        ...input,
        credential,
        desiredState: "enabled",
        pendingOperation: null,
      });
    }
    if (operation.kind === "rotate") {
      const credential = await this.#controlPlane.rotate(this.#deploymentId, {
        hostInstanceId: discovery.hostInstanceId,
        operationId: operation.operationId,
      });
      await this.#assertCurrentAuthority(authority);
      this.#assertCredential(credential, authority);
      return this.#store.save(this.#deploymentId, {
        ...input,
        credential,
        desiredState: "enabled",
        pendingOperation: null,
      });
    }

    throw new Error("Connect revoke intent must be reconciled by the teardown coordinator.");
  }

  async #ensureConnector(state: DesktopConnectCredentialState): Promise<void> {
    const credential = state.credential;
    if (!credential) throw new Error("Opensteer Connect has no connector credential.");
    await this.#assertCurrentAuthority(state.authority);
    if (this.#stopping) return;
    const configuration: CloudflaredConnectorConfiguration = {
      discovery: state.authority.discovery,
      generation: credential.connectorCredentialGeneration,
      hostKeyFingerprint: credential.hostKeyFingerprint,
      localOrigin: state.authority.localOrigin,
      schemaVersion: 1,
      tunnelToken: credential.tunnelToken,
    };
    const identity = connectorIdentity(configuration);
    const exact = `${identity}:${configuration.generation}`;
    const supervisorState = this.#supervisor.status.state;
    if (
      this.#activeConfiguration === exact &&
      supervisorState !== "fenced" &&
      supervisorState !== "stopped" &&
      supervisorState !== "stopping"
    ) {
      return;
    }
    if (
      this.#activeIdentity === identity &&
      this.#activeConfiguration !== null &&
      supervisorState !== "fenced" &&
      supervisorState !== "stopped" &&
      supervisorState !== "stopping"
    ) {
      await this.#supervisor.rotateToken(configuration);
    } else {
      await this.#stopConnector();
      if (this.#stopping) return;
      await this.#supervisor.start(configuration);
    }
    this.#activeIdentity = identity;
    this.#activeConfiguration = exact;
  }

  async #stopConnector(): Promise<void> {
    await this.#supervisor.stop();
    this.#activeConfiguration = null;
    this.#activeIdentity = null;
  }

  async #publish(
    authority: PersonalHostRuntimeRecord,
    state: "disabled" | "offline" | "ready",
    accessRoute: PersonalHostConnectProjection["accessRoute"],
  ): Promise<void> {
    await this.#assertCurrentAuthority(authority);
    await this.#projection.publish(
      PersonalHostConnectProjectionSchema.parse({ accessRoute, authority, state }),
    );
    await this.#assertCurrentAuthority(authority);
  }

  async #requireCurrentRuntime(): Promise<PersonalHostRuntimeRecord> {
    const runtime = await this.#runtime.current();
    if (!runtime) {
      throw authorityFence("A ready Desktop-owned Personal Host is required for Connect.");
    }
    return this.#parseRuntime(runtime);
  }

  #parseRuntime(input: PersonalHostRuntimeRecord): PersonalHostRuntimeRecord {
    const runtime = PersonalHostRuntimeRecordSchema.parse(input);
    if (runtime.discovery.deploymentId !== this.#deploymentId) {
      throw authorityFence("The Personal Host runtime belongs to another Deployment.");
    }
    return runtime;
  }

  async #assertCurrentAuthority(
    expected: PersonalHostRuntimeRecord,
  ): Promise<PersonalHostRuntimeRecord> {
    const current = await this.#requireCurrentRuntime();
    try {
      assertSamePersonalHostAuthority(expected, current);
    } catch (error) {
      throw authorityFence(
        "The Personal Host authority changed during Connect reconciliation.",
        error,
      );
    }
    return current;
  }

  #assertStoredAuthority(
    state: DesktopConnectCredentialState,
    runtime: PersonalHostRuntimeRecord,
  ): void {
    try {
      assertSamePersonalHostAuthority(state.authority, runtime);
    } catch (error) {
      throw authorityFence(
        "Stored Connect credentials belong to an earlier Personal Host authority.",
        error,
      );
    }
  }

  #assertCredential(input: ConnectCredentialResponse, authority: PersonalHostRuntimeRecord): void {
    const credential = ConnectCredentialResponseSchema.parse(input);
    const discovery = authority.discovery;
    if (
      credential.canonicalOrigin !== discovery.canonicalOrigin ||
      credential.deploymentId !== discovery.deploymentId ||
      credential.hostInstanceId !== discovery.hostInstanceId ||
      credential.hostKeyFingerprint !==
        hostKeyFingerprint(authority.discoveryEnvelope.publicKey.spki)
    ) {
      throw authorityFence("The Account returned a credential for another Host authority.");
    }
  }

  #setStatus(
    state: PersonalHostConnectState,
    generation: number | null,
    detail: string | null,
  ): PersonalHostConnectStatus {
    this.#status = { deploymentId: this.#deploymentId, detail, generation, state };
    return this.#status;
  }
}

function connectorIdentity(configuration: CloudflaredConnectorConfiguration): string {
  const discovery = configuration.discovery;
  return [
    discovery.deploymentId,
    discovery.hostInstanceId,
    configuration.hostKeyFingerprint,
    discovery.canonicalOrigin,
    configuration.localOrigin,
  ].join("|");
}

function authorityFence(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "personal_host_authority_fenced",
  });
}

function isAuthorityFence(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "personal_host_authority_fenced"
  );
}

function publicConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Opensteer Connect failed.";
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/((?:tunnel[_ -]?token|token)\s*[:=]\s*)[^\s,}]+/giu, "$1[redacted]")
    .slice(0, 2_000);
}
