import type {
  ConnectOperationId,
  PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import { PersonalRemoteAccessStatusSchema } from "@opensteer/protocol";
import type { NativePersonalRemoteHostControl } from "./personal-host-control.js";
import {
  assertSamePersonalHostAuthority,
  type PersonalHostConnectProjection,
  type PersonalHostConnectProjectionSink,
  type PersonalHostConnectRouteSource,
  type PersonalHostRuntimeRecord,
  type PersonalHostRuntimeSource,
} from "./personal-host-runtime.js";

/** Adapts machine-local owner APIs to the Connect coordinator. Account Host
 * credentials remain private to the Host for projection and revocation. */
export class DesktopPersonalHostRemoteAdapter
  implements PersonalHostConnectRouteSource, PersonalHostConnectProjectionSink
{
  readonly #host: Pick<
    NativePersonalRemoteHostControl,
    | "configure"
    | "issuePairingCode"
    | "publishConnectProjection"
    | "revokeConnectResource"
    | "removeAccountLinkForUnlink"
    | "repairHostedOAuthConnectionsForUnlink"
    | "revokeAccountSessionsForUnlink"
    | "status"
  >;
  readonly #runtime: PersonalHostRuntimeSource;

  constructor(options: {
    readonly host: Pick<
      NativePersonalRemoteHostControl,
      | "configure"
      | "issuePairingCode"
      | "publishConnectProjection"
      | "revokeConnectResource"
      | "removeAccountLinkForUnlink"
      | "repairHostedOAuthConnectionsForUnlink"
      | "revokeAccountSessionsForUnlink"
      | "status"
    >;
    readonly runtime: PersonalHostRuntimeSource;
  }) {
    this.#host = options.host;
    this.#runtime = options.runtime;
  }

  async configureConnect(routeOrigin: string): Promise<PersonalHostAccessRouteEnvelope> {
    const runtime = await this.#requireRuntime();
    const status = PersonalRemoteAccessStatusSchema.parse(
      await this.#host.configure(runtime, { mode: "connect", routeOrigin, schemaVersion: 1 }),
    );
    if (status.mode !== "connect" || !status.route) {
      throw new Error("Personal Host did not commit the signed Connect route.");
    }
    return status.route;
  }

  async disableConnect(): Promise<void> {
    const runtime = await this.#requireRuntime();
    const status = PersonalRemoteAccessStatusSchema.parse(
      await this.#host.configure(runtime, { mode: "off", routeOrigin: null, schemaVersion: 1 }),
    );
    if (status.mode !== "off" || status.route !== null) {
      throw new Error("Personal Host did not revoke its remote route.");
    }
  }

  async configureConnectPrivate(routeOrigin: string) {
    const runtime = await this.#requireRuntime();
    return this.#host.configure(runtime, {
      mode: "private",
      routeOrigin,
      schemaVersion: 1,
    });
  }

  async issuePairingCode() {
    return this.#host.issuePairingCode(await this.#requireRuntime());
  }

  async revokeAccountSessionsForUnlink(): Promise<void> {
    await this.#host.revokeAccountSessionsForUnlink(await this.#requireRuntime());
  }

  async removeAccountLinkForUnlink(): Promise<void> {
    await this.#host.removeAccountLinkForUnlink(await this.#requireRuntime());
  }

  async repairHostedOAuthConnectionsForUnlink(): Promise<void> {
    await this.#host.repairHostedOAuthConnectionsForUnlink(await this.#requireRuntime());
  }

  async publish(projection: PersonalHostConnectProjection): Promise<void> {
    const runtime = await this.#requireRuntime();
    assertSamePersonalHostAuthority(projection.authority, runtime);
    await this.#host.publishConnectProjection(runtime, {
      expectedAccessRoute: projection.accessRoute,
      schemaVersion: 2,
      state: projection.state,
    });
  }

  async revokeConnectResource(operationId: ConnectOperationId): Promise<void> {
    const runtime = await this.#requireRuntime();
    await this.#host.revokeConnectResource(runtime, {
      hostInstanceId: runtime.discovery.hostInstanceId,
      operationId,
    });
  }

  async status() {
    const runtime = await this.#requireRuntime();
    return this.#host.status(runtime);
  }

  async #requireRuntime(): Promise<PersonalHostRuntimeRecord> {
    const runtime = await this.#runtime.current();
    if (!runtime) throw new Error("A ready Desktop-owned Personal Host is required.");
    return runtime;
  }
}
