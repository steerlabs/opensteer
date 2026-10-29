import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { isPersonalHost } from "@opensteer/deployment-authority";
import { resolveConnection } from "./connection-resolver.js";
import {
  deploymentConnectionFromVerifiedEndpoints,
  deploymentConnectionFromVerifiedPersonalRoute,
  verifyAccessEndpoint,
  verifyPersonalAccessEndpoint,
  type DeploymentCatalogStore,
} from "./deployment-catalog.js";
import type { HostSessionExchange } from "../auth/host-session-exchange.js";

/**
 * Establishes first trust in a private Host without sending a cookie, OAuth
 * token, or caller-provided identity metadata. The caller explicitly chooses
 * one of two non-interchangeable trust paths: a Personal Host's separately
 * signed HTTPS route and one-use pairing code, or a self-hosted Host's signed
 * canonical discovery followed by that Host's configured native sign-in.
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
    if (parsed.kind === "self-hosted") {
      const verified = await verifyAccessEndpoint({
        fetch: this.#fetch,
        kind: "canonical",
        origin: parsed.origin,
      });
      if (isPersonalHost(verified.discovery)) {
        throw new Error(
          "This address is a computer, not a server. Choose Another computer of yours and use a pairing code.",
        );
      }
      await this.#catalog.upsertAndSelect(
        deploymentConnectionFromVerifiedEndpoints({
          accountAccess: null,
          endpoints: [verified],
          kind: "self-hosted",
          name: selfHostedDeploymentName(parsed.origin),
          source: { kind: "manual" },
        }),
      );
      return;
    }

    const discoveredRoute = await verifyPersonalAccessEndpoint({
      fetch: this.#fetch,
      origin: parsed.origin,
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

function selfHostedDeploymentName(origin: string): string {
  const hostname = new URL(origin).hostname;
  return hostname.length <= 120 ? hostname : "Server";
}
