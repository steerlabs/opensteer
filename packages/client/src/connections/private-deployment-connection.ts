import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { resolveConnection } from "./connection-resolver.js";
import { verifyDeploymentAddress } from "./home-address.js";
import {
  deploymentConnectionFromVerifiedEndpoints,
  deploymentConnectionFromVerifiedPersonalRoute,
  verifyPersonalAccessEndpoint,
  type DeploymentCatalogStore,
} from "./deployment-catalog.js";
import type { HostSessionExchange } from "../auth/host-session-exchange.js";

/**
 * Establishes first trust in a private Host without sending a cookie, OAuth
 * token, or caller-provided identity metadata. The caller explicitly chooses
 * one of two non-interchangeable trust paths: a Mac Home's separately signed
 * HTTPS route and one-use pairing code, or an address — a team server or a
 * Home on its own server — whose signed canonical discovery is pinned and
 * then signed in to with that Host's own native sign-in.
 */
export class PrivateDeploymentConnectionService {
  readonly #catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sessions: Pick<HostSessionExchange, "establish" | "probe">;

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
    readonly fetch?: typeof globalThis.fetch;
    readonly sessions: Pick<HostSessionExchange, "establish" | "probe">;
  }) {
    this.#catalog = options.catalog;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sessions = options.sessions;
  }

  async connect(input: DesktopConnectPrivateDeploymentInput | unknown): Promise<void> {
    const parsed = DesktopConnectPrivateDeploymentInputSchema.parse(input);
    if (parsed.kind === "address") {
      const verified = await verifyDeploymentAddress({ fetch: this.#fetch, origin: parsed.origin });
      await this.#catalog.upsertAndSelect(
        deploymentConnectionFromVerifiedEndpoints({
          accountAccess: null,
          endpoints: [verified],
          kind: verified.kind,
          name: addressDeploymentName(parsed.origin),
          source: { kind: "manual" },
        }),
      );
      return;
    }

    const discoveredRoute = await verifyPersonalAccessEndpoint({
      fetch: this.#fetch,
      origin: parsed.origin,
      protocol: "maintenance-v1",
    });
    const connection = deploymentConnectionFromVerifiedPersonalRoute({
      accountAccess: null,
      name: computerName(parsed.origin),
      source: { kind: "manual" },
      verified: discoveredRoute,
    });
    // The route was just verified and is not in the catalog yet, so the
    // attachment is resolved directly rather than read back through it.
    const resolved = resolveConnection(connection, null, { authorization: null });
    const probe = await this.#sessions.probe(resolved);
    if (probe === "blocked") {
      throw new Error("That computer refused this connection. Check the address and try again.");
    }
    if (probe === "unauthenticated") {
      await this.#sessions.establish(resolved, { pairingCode: parsed.pairingCode });
    }
    await this.#catalog.upsertAndSelect(connection);
  }
}

/** A computer paired by address is named by that address until it says otherwise. */
function computerName(origin: string): string {
  const hostname = new URL(origin).hostname;
  return hostname.length <= 120 ? hostname : "Computer";
}

function addressDeploymentName(origin: string): string {
  const hostname = new URL(origin).hostname;
  return hostname.length <= 120 ? hostname : "Home";
}
