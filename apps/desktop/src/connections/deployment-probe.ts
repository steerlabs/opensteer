import {
  HostVersionMismatchError,
  describeConnectionAccess,
  verifyAccessEndpoint,
  type DeploymentCatalogStore,
} from "@opensteer/client/connections";
import { isSameHost } from "@opensteer/deployment-authority";
import type { PersonalHostRuntimeSource } from "../supervisor/personal-host-runtime.js";
import { desktopLocalHostRuntime } from "./access-projection.js";
import type { DeploymentProbeOutcome } from "./deployment-access-service.js";

/** Short enough that a place list never waits long on a place that is gone. */
const probeTimeoutMilliseconds = 6_000;

/**
 * Checks a place added by hand the way opening it would: the route the
 * resolver picks, its signed discovery document, and the same Host identity the
 * catalog pinned. "Something answered" is never enough — a different place at
 * the same address is a mismatch, and a Host on the other side of a protocol
 * epoch says which side needs the update. Nothing is sent but an anonymous GET.
 */
export class DesktopDeploymentProbe {
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "recordVerifiedCapabilities">;
  readonly #fetch: typeof globalThis.fetch;
  readonly #localRuntime: PersonalHostRuntimeSource;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "recordVerifiedCapabilities">;
    readonly fetch: typeof globalThis.fetch;
    readonly localRuntime: PersonalHostRuntimeSource;
  }) {
    this.#catalog = options.catalog;
    this.#fetch = options.fetch;
    this.#localRuntime = options.localRuntime;
  }

  async probe(deploymentId: string, signal: AbortSignal): Promise<DeploymentProbeOutcome> {
    const [catalog, runtime] = await Promise.all([
      this.#catalog.load(),
      this.#localRuntime.current(),
    ]);
    const connection = catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === deploymentId,
    );
    if (!connection) return "unreachable";
    const access = describeConnectionAccess(connection, desktopLocalHostRuntime(runtime));
    if (access.key === null) return "unreachable";
    try {
      const verified = await verifyAccessEndpoint({
        fetch: this.#fetch,
        kind: access.origin === access.canonicalOrigin ? "canonical" : "direct",
        origin: access.origin,
        signal,
        timeoutMs: probeTimeoutMilliseconds,
      });
      if (!isSameHost(verified.discoveryEnvelope, connection.authority)) return "identity-mismatch";
      await this.#catalog.recordVerifiedCapabilities(verified);
      return "reachable";
    } catch (error) {
      if (error instanceof HostVersionMismatchError) return error.code;
      return "unreachable";
    }
  }
}
