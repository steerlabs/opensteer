import { DeploymentIdSchema } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import {
  DesktopAddDirectRouteInputSchema,
  type DesktopAddDirectRouteInput,
} from "@opensteer/protocol/desktop";
import type { DeploymentCatalogStore } from "./deployment-catalog.js";
import { verifyAccessEndpoint } from "./deployment-catalog.js";

/**
 * Adds an explicit LAN, Tailscale, or operator-HTTPS route only after the
 * endpoint proves that it serves the exact Deployment authority already
 * trusted in the local catalog. No Host credential is sent during discovery.
 */
export class DirectHostRouteService {
  readonly #catalog: Pick<DeploymentCatalogStore, "addVerifiedDirectEndpoint" | "load">;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "addVerifiedDirectEndpoint" | "load">;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#catalog = options.catalog;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async add(input: DesktopAddDirectRouteInput | unknown): Promise<void> {
    const parsed = DesktopAddDirectRouteInputSchema.parse(input);
    const catalog = await this.#catalog.load();
    const connection = catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === parsed.deploymentId,
    );
    if (!connection) throw new Error("Cannot add a direct route to an unknown Deployment.");
    const verified = await verifyAccessEndpoint({
      expectedDeploymentId: DeploymentIdSchema.parse(parsed.deploymentId),
      expectedDiscovery: connection.authority.document,
      expectedHostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
      fetch: this.#fetch,
      kind: "direct",
      origin: parsed.origin,
    });
    await this.#catalog.addVerifiedDirectEndpoint({
      deploymentId: parsed.deploymentId,
      verified,
    });
  }
}
