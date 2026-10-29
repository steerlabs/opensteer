import type { DeploymentId } from "@opensteer/core";
import type { DeploymentCatalogStore, DeploymentConnection } from "./deployment-catalog.js";
import { resolveConnection, type LocalHostRuntime } from "./connection-resolver.js";
import type { SelectedAttachment } from "../auth/host-session.js";

export interface HostCredentialProvider {
  authorizationHeader(connection: DeploymentConnection): Promise<string | null>;
}

/**
 * The live Personal Host this client supervises, when it supervises one. A
 * phone always answers `null`; only the computer that runs a Personal Host can
 * be its owner.
 */
export interface LocalHostRuntimeSource {
  current(): Promise<LocalHostRuntime | null>;
}

/**
 * The one attachment fence every Opensteer client shares.
 *
 * It resolves the selected catalog row through the one resolver, asks the
 * platform for that Deployment's credential, and keeps a single monotone
 * generation that is bumped exactly when the resolver's attachment key changes
 * — a rotated Connect route, a restarted Host, a different Deployment, an
 * authority that went away. Anything a client opened against the old key is
 * released through `onInvalidated` at that moment, and anything that captured
 * `generation` before the bump refuses to continue by comparing it again.
 *
 * There is deliberately no transport here. What a request or a socket *is*
 * belongs to the platform — Electron's `net`, a phone's `fetch` — and this
 * decides only which route and which credential either may use, and for how
 * long they remain the right ones.
 */
export class HostAttachmentFence {
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
  readonly #credentials: HostCredentialProvider;
  readonly #deploymentId: DeploymentId | null;
  readonly #localRuntime: LocalHostRuntimeSource;
  readonly #listeners = new Set<() => void>();
  readonly #releases = new Set<(reason: string) => void>();
  /** `undefined` until the first resolution, so startup never bumps the fence. */
  #selectedKey: string | null | undefined;
  #generation = 0;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
    readonly credentials?: HostCredentialProvider;
    /**
     * The one Deployment this fence resolves, for work that belongs to a
     * Deployment rather than to whatever the person has selected. Absent, it
     * follows the catalog's selection.
     */
    readonly deploymentId?: DeploymentId;
    readonly localRuntime: LocalHostRuntimeSource;
  }) {
    this.#catalog = options.catalog;
    this.#credentials = options.credentials ?? noHostCredentials;
    this.#deploymentId = options.deploymentId ?? null;
    this.#localRuntime = options.localRuntime;
  }

  /**
   * Monotone, and the only thing worth capturing across an `await`: a value
   * that still equals this after the wait means the attachment did not move.
   */
  get generation(): number {
    return this.#generation;
  }

  /** The current attachment key, without touching the catalog file. */
  currentKey(): string | null {
    return this.#selectedKey ?? null;
  }

  /** Observers of the catalog and of every attachment change. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    const unsubscribeCatalog = this.#catalog.subscribe(listener);
    return () => {
      this.#listeners.delete(listener);
      unsubscribeCatalog();
    };
  }

  /**
   * Registers a release for everything held against the current attachment.
   * It runs before the subscribers, so nothing that observes the change can
   * still be handed a request or a socket bound to the route that is gone.
   */
  onInvalidated(release: (reason: string) => void): () => void {
    this.#releases.add(release);
    return () => this.#releases.delete(release);
  }

  /**
   * The resolution every caller works from. A client with nothing selected has
   * no attachment at all, which is a fault here rather than a null to carry.
   */
  async current(): Promise<SelectedAttachment> {
    const selected = await this.refresh();
    if (selected) return selected;
    throw new Error(
      this.#deploymentId === null
        ? "Select an Opensteer deployment before contacting it."
        : "This Opensteer deployment is no longer on this computer.",
    );
  }

  /**
   * Recomputes the fence. Exposed because a platform surface that publishes its
   * own projection of the same catalog read has to refresh both together.
   */
  async refresh(): Promise<SelectedAttachment | null> {
    const [catalog, localRuntime] = await Promise.all([
      this.#catalog.load(),
      this.#localRuntime.current(),
    ]);
    const deploymentId = this.#deploymentId ?? catalog.selectedDeploymentId;
    const connection = catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === deploymentId,
    );
    if (!connection) {
      this.#applySelection(null);
      return null;
    }
    let selected: SelectedAttachment;
    try {
      selected = {
        connection,
        resolved: resolveConnection(connection, localRuntime, {
          authorization: await this.#authorization(connection),
        }),
      };
    } catch (error) {
      // Invalidation happens once. Notifying observers is what brings the next
      // caller back through here, so re-notifying on an authority that is
      // already unavailable would feed itself and abort every passing request.
      if (this.#selectedKey) {
        this.#selectedKey = null;
        this.#invalidate("The selected deployment’s authority is unavailable.");
      }
      throw error;
    }
    this.#applySelection(selected.resolved.key);
    return selected;
  }

  #applySelection(key: string | null): void {
    const changed = this.#selectedKey !== undefined && key !== this.#selectedKey;
    this.#selectedKey = key;
    if (changed) this.#invalidate("The selected deployment’s authority changed.");
  }

  #invalidate(reason: string): void {
    this.#generation += 1;
    for (const release of this.#releases) release(reason);
    for (const listener of this.#listeners) listener();
  }

  async #authorization(connection: DeploymentConnection): Promise<string | null> {
    const value = await this.#credentials.authorizationHeader(connection);
    if (value === null) return null;
    if (value.length < 8 || value.length > 16_384 || /[\r\n]/u.test(value)) {
      throw new Error("The Host credential provider returned an invalid header.");
    }
    return value;
  }
}

const noHostCredentials: HostCredentialProvider = {
  authorizationHeader: async () => null,
};
