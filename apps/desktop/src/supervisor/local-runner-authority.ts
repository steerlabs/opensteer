import { DeploymentIdSchema, type DeploymentId, type DeploymentShape } from "@opensteer/core";
import { hostDiscoveryDefaultWorkspaceBacking } from "@opensteer/deployment-authority";
import type { DesktopAccessOrigin } from "@opensteer/protocol/desktop";
import type { DeploymentCatalogStore } from "@opensteer/client/connections";
import { resolveConnection } from "@opensteer/client/connections";

/**
 * An immutable, main-process-only binding to one catalog entry's verified
 * route. The renderer may name a Deployment, but it never supplies the network
 * origin used by the local Runner.
 */
export interface DesktopLocalRunnerTarget {
  readonly deploymentId: DeploymentId;
  readonly deploymentShape: DeploymentShape;
  readonly hostUrl: DesktopAccessOrigin;
  /** Signed Host identity, selected route, access mode, and route generation. */
  readonly key: string;
  /** Whether this Deployment's grant lets this computer advertise `agents`. */
  readonly mayRunAgents: boolean;
}

export interface DesktopLocalRunnerTargetAuthority {
  isCurrent(target: DesktopLocalRunnerTarget): Promise<boolean>;
  resolve(deploymentId: DeploymentId | string): Promise<DesktopLocalRunnerTarget>;
  subscribe(listener: () => void): () => void;
}

export type ComputerUseRunnerTargetResult =
  | { readonly local: true }
  | { readonly local: false; readonly reason: "not-local" | "deployment-changed" };

export class LocalRunnerDeploymentUnavailableError extends Error {}

export class DesktopLocalRunnerTargetResolver implements DesktopLocalRunnerTargetAuthority {
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
  readonly #supervisedDeploymentId: () => Promise<DeploymentId | null>;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
    /** Durable supervision, the same fact the catalog projects as `onThisComputer`. */
    readonly supervisedDeploymentId: () => Promise<DeploymentId | null>;
  }) {
    this.#catalog = options.catalog;
    this.#supervisedDeploymentId = options.supervisedDeploymentId;
  }

  async resolve(deploymentId: DeploymentId | string): Promise<DesktopLocalRunnerTarget> {
    const expected = DeploymentIdSchema.parse(deploymentId);
    const catalog = await this.#catalog.load();
    const connection = catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === expected,
    );
    if (!connection) {
      throw new LocalRunnerDeploymentUnavailableError(
        "The local Runner Deployment is no longer available.",
      );
    }
    const kind = connection.authority.document.deploymentShape.kind;
    // A Personal Deployment's own Mac already runs its Main Runner: a second
    // Runner there would be the same computer enrolled twice. Every other Mac
    // joins it over the signed access route, which is why the local Personal
    // runtime is deliberately not offered to `resolveConnection` below.
    if (kind === "personal" && (await this.#supervisedDeploymentId()) === expected) {
      throw new Error("This Mac hosts this Deployment, so it already runs as its Main Runner.");
    }
    const resolved = resolveConnection(connection, null, { authorization: null });
    return {
      deploymentId: resolved.deploymentId,
      deploymentShape: {
        defaultWorkspaceBacking: hostDiscoveryDefaultWorkspaceBacking(
          connection.authority.document.deploymentShape,
        ),
        kind,
      },
      hostUrl: resolved.origin,
      key: resolved.key,
      // Personal grants every computer but the Main exactly `shell`.
      mayRunAgents: kind === "server",
    };
  }

  async isCurrent(target: DesktopLocalRunnerTarget): Promise<boolean> {
    try {
      return (await this.resolve(target.deploymentId)).key === target.key;
    } catch (error) {
      if (error instanceof LocalRunnerDeploymentUnavailableError) return false;
      throw error;
    }
  }

  subscribe(listener: () => void): () => void {
    return this.#catalog.subscribe(listener);
  }
}
