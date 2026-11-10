import type { HostCapability } from "@opensteer/deployment-authority";
import type { DeploymentId } from "@opensteer/core";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import { describeConnectionAccess, type LocalHostRuntime } from "@opensteer/client/connections";
import type { DeploymentCatalogStore } from "@opensteer/client/connections";
import type {
  PersonalHostRuntimeRecord,
  PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";

/**
 * One catalog row as the Desktop presents it, plus the facts the access service
 * needs that the renderer mostly never sees. `accountAccess` is the exception:
 * it reaches the renderer, because the Account relation decides which listing
 * this person may drop.
 */
export interface DeploymentAccessCatalogDeployment extends DesktopDeploymentSummary {
  readonly capabilities?: readonly HostCapability[] | null;
  readonly accountAccess: "owner" | "member" | null;
  readonly accountLivenessExpiresAt: string | null;
  readonly hasAccountConnectRoute: boolean;
  readonly hasVerifiedAccountRoute: boolean;
  /** The attachment key, or null for a row with no live route. */
  readonly key: string | null;
  readonly source: "account" | "manual" | "this-device";
}

export interface CatalogProjection {
  readonly deployments: readonly DeploymentAccessCatalogDeployment[];
  readonly revision: number;
  readonly selectedDeploymentId: string | null;
}

/**
 * The one projection of the connection catalog: one catalog load, one runtime
 * read, and one `describeConnectionAccess` per row. Nothing downstream reads a
 * connection's routing fields again.
 */
export class DesktopAccessProjection {
  readonly #catalog: Pick<DeploymentCatalogStore, "load">;
  readonly #localRuntime: PersonalHostRuntimeSource;
  readonly #supervisedDeploymentId: () => Promise<DeploymentId | null>;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load">;
    readonly localRuntime: PersonalHostRuntimeSource;
    readonly supervisedDeploymentId: () => Promise<DeploymentId | null>;
  }) {
    this.#catalog = options.catalog;
    this.#localRuntime = options.localRuntime;
    this.#supervisedDeploymentId = options.supervisedDeploymentId;
  }

  async read(): Promise<CatalogProjection> {
    const [catalog, runtime, supervisedDeploymentId] = await Promise.all([
      this.#catalog.load(),
      this.#localRuntime.current(),
      this.#supervisedDeploymentId(),
    ]);
    const localRuntime = desktopLocalHostRuntime(runtime);
    return {
      deployments: catalog.deployments.map((connection) => {
        const facts = describeConnectionAccess(connection, localRuntime);
        const document = connection.authority.document;
        // Supervision is durable and routing is live: a stopped local Personal
        // stack is still the one this computer keeps, so this stays deployment
        // identity rather than becoming `access === "owner"`.
        const onThisComputer = document.deploymentId === supervisedDeploymentId;
        const fromAccount = connection.source.kind === "account";
        return {
          access: facts.access,
          capabilities: facts.key === null ? null : (connection.capabilities ?? null),
          // The Account relation, not a route: it says what this Account may do
          // with the listing, which the live access kind never answers.
          accountAccess: fromAccount ? connection.accountAccess : null,
          accountLivenessExpiresAt: facts.accountLivenessExpiresAt,
          activeOrigin: facts.origin,
          canonicalOrigin: document.canonicalOrigin,
          hasAccountConnectRoute: fromAccount && facts.hasSignedRoute,
          hasVerifiedAccountRoute: fromAccount && facts.hasVerifiedRoute,
          id: document.deploymentId,
          key: facts.key,
          kind: connection.kind,
          lastUsedAt: connection.lastUsedAt,
          name: connection.name,
          onThisComputer,
          routes: connection.endpoints.map(({ kind, origin }) => ({
            kind,
            origin,
            selected: origin === facts.origin,
          })),
          source: onThisComputer ? "this-device" : fromAccount ? "account" : "manual",
        };
      }),
      revision: catalog.revision,
      selectedDeploymentId: catalog.selectedDeploymentId,
    };
  }
}

/**
 * Only a running Host can own a session, so the owner arm is fed by the
 * supervisor's live runtime record and never by the manifest on disk.
 */
export function desktopLocalHostRuntime(
  runtime: PersonalHostRuntimeRecord | null,
): LocalHostRuntime | null {
  return runtime === null
    ? null
    : { authority: runtime.discoveryEnvelope, localOrigin: runtime.localOrigin };
}
