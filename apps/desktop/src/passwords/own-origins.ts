import { connectionOrigins, type DeploymentCatalog } from "@opensteer/client/connections";

/** Opensteer origins that must never receive a saved login, kept current from the catalog. */
export class OpensteerOwnOrigins {
  readonly #accountUrl: URL | null;
  readonly #catalog: { load(): Promise<DeploymentCatalog> };
  #current: readonly string[] = [];
  #generation = 0;

  constructor(options: {
    readonly accountUrl: URL | null;
    readonly catalog: { load(): Promise<DeploymentCatalog> };
  }) {
    this.#accountUrl = options.accountUrl;
    this.#catalog = options.catalog;
  }

  readonly current = (): readonly string[] => this.#current;

  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const catalog = await this.#catalog.load();
    if (generation !== this.#generation) return;
    this.#current = ownOrigins(catalog, this.#accountUrl);
  }
}

function ownOrigins(catalog: DeploymentCatalog, accountUrl: URL | null): readonly string[] {
  const origins = new Set<string>(accountUrl ? [accountUrl.origin] : []);
  for (const deployment of catalog.deployments) {
    for (const origin of connectionOrigins(deployment)) origins.add(origin);
  }
  return [...origins];
}
