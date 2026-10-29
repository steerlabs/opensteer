import type { NativeOAuthManager } from "@opensteer/client/auth";
import {
  HostVersionMismatchError,
  verifyAccessEndpoint,
  type DeploymentConnection,
  type ResolvedConnection,
} from "@opensteer/client/connections";
import { HttpHostClient, type ClientLifecycle, type HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostCapability } from "@opensteer/deployment-authority";
import { isSameHost } from "@opensteer/deployment-authority";
import type { HostApiCommandInput } from "@opensteer/protocol";
import {
  createHostNetwork,
  type HostAuthorization,
  type HostFetch,
} from "../platform/host-network.js";
import type { WebSocketClient } from "@opensteer/client/host";
import {
  createDeploymentCredentials,
  type DeploymentCredentials,
} from "./deployment-credentials.js";
import type { HostVerification } from "./deployment-rows.js";
import { mockSignedOutDeploymentId } from "./mock-mode.js";
import type { PersonalSessionStore } from "./personal-session-store.js";

/**
 * What this app and one Host agree about, as a live probe of the route this
 * phone actually uses found it.
 *
 * `unreachable` is deliberately not a verdict: a Host that did not answer has
 * said nothing about versions or identity, and a row must not report a repair
 * nobody has established is needed.
 */
export type HostEpochAgreement =
  | { readonly status: "compatible"; readonly capabilities: readonly HostCapability[] }
  | "unreachable"
  | HostVerification;

/**
 * Everything that reaches a Host, behind one port.
 *
 * `MobileClient` owns the catalog, the credentials store and the selection;
 * this is the boundary where those become network traffic. Grouping the three
 * together — what to present, what to attach with, and which protocol epoch the
 * other end speaks — is what lets mock mode replace the Host wholesale, as one
 * object, rather than by threading a development flag through attachment.
 */
export interface MobileHostPort {
  readonly credentials: DeploymentCredentials;
  attach(input: {
    readonly authorization: HostAuthorization;
    readonly capabilities:
      readonly HostCapability[] | null | (() => Promise<readonly HostCapability[]>);
    readonly connection: DeploymentConnection;
    readonly origin: string;
  }): HostClient;
  verifyEpoch(
    resolved: ResolvedConnection,
    connection: DeploymentConnection,
  ): Promise<HostEpochAgreement>;
}

export type MobileHostPortFactory = (input: {
  readonly oauth: NativeOAuthManager;
  readonly sessions: PersonalSessionStore;
}) => MobileHostPort;

export function createNetworkHostPort(options: {
  readonly fetch: HostFetch;
  readonly lifecycle: ClientLifecycle;
  readonly now: () => Date;
  readonly openWebSocket: (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) => WebSocketClient;
}): MobileHostPortFactory {
  return ({ oauth, sessions }) => ({
    credentials: createDeploymentCredentials({ now: options.now, oauth, sessions }),

    attach({ authorization, capabilities, origin }): HostClient {
      const network = createHostNetwork({
        authorization,
        fetch: options.fetch,
        // The resolver's origin, not the client's base URL: the transport
        // decides for itself where this Deployment's credential may go.
        origin,
        openWebSocket: options.openWebSocket,
      });
      return new HttpHostClient({
        baseUrl: origin,
        capabilities,
        fetch: network.fetch,
        lifecycle: options.lifecycle,
        webSocketFactory: network.webSocketFactory,
      });
    },

    /**
     * The epoch is read from a live descriptor, never from the catalog row: a
     * row is a routing cache and a Host's version changes with every upgrade.
     *
     * It is read through the resolved route, which is the address the
     * attachment itself uses. A Personal Deployment's canonical origin is the
     * owner computer's loopback — probing that from a phone tests a machine
     * that is not on this network — so the route the traffic takes is the only
     * one whose answer means anything here. The endpoint kind follows from that
     * route rather than being assumed: only an origin that *is* the canonical
     * one may be verified as canonical.
     */
    async verifyEpoch(resolved, connection): Promise<HostEpochAgreement> {
      let verified;
      try {
        // The expected identity is deliberately not handed to the verification:
        // it refuses a dozen different ways, and "this route did not produce a
        // document" and "this route produced another Host's document" are two
        // different things to tell a person. So the signature and the epoch are
        // checked there, and the identity is compared here, where a mismatch is
        // the only thing this branch can mean.
        verified = await verifyAccessEndpoint({
          fetch: (input, init) => options.fetch(input, init),
          kind: resolved.origin === resolved.canonicalOrigin ? "canonical" : "direct",
          origin: resolved.origin,
        });
      } catch (error) {
        if (error instanceof HostVersionMismatchError) return error.code;
        return "unreachable";
      }
      return isSameHost(verified.discoveryEnvelope, connection.authority)
        ? { status: "compatible", capabilities: verified.capabilities }
        : "identity-mismatch";
    },
  });
}

/**
 * Development entry: the Host is in memory, so there is nothing to present, to
 * dial, or to negotiate a version with. Everything a real Host is asked, this
 * answers locally.
 */
export function createMockHostPort(
  options: {
    /**
     * One in-memory Host per Deployment, kept across attachments, so what a
     * session did there — such as adding this iPhone — is still there after
     * switching away and back. Absent, every attachment starts afresh.
     */
    readonly hosts?: Map<string, MockHostClient>;
    readonly initialHome?: "seeded" | "absent";
    /** Each command a kept Host accepted, as a real Host would push its effects. */
    readonly onCommand?: (command: HostApiCommandInput) => void;
  } = {},
): MobileHostPortFactory {
  const signedIn = (connection: DeploymentConnection): boolean =>
    connection.authority.document.deploymentId !== mockSignedOutDeploymentId;
  const attach = (connection: DeploymentConnection): HostClient => {
    const hosts = options.hosts;
    if (hosts === undefined)
      return new MockHostClient({ initialHome: options.initialHome ?? "seeded" });
    const deploymentId = connection.authority.document.deploymentId;
    let host = hosts.get(deploymentId);
    if (host === undefined) {
      const created = new MockHostClient({ initialHome: options.initialHome ?? "seeded" });
      const dispatch = created.dispatch.bind(created);
      created.dispatch = async (command) => {
        const result = await dispatch(command);
        options.onCommand?.(command);
        return result;
      };
      hosts.set(deploymentId, created);
      host = created;
    }
    // A kept Host outlives the attachment: releasing it must not stop it.
    return new Proxy(host, {
      get(target, property) {
        if (property === "dispose") return () => undefined;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return () => ({
    credentials: {
      // One seeded row is deliberately without a credential, so the row that
      // needs one — and the action that leads out of it — is on screen in mock
      // mode rather than only reachable with a real Host.
      authorization: async (connection) => (signedIn(connection) ? "Bearer mock" : null),
      held: async (connection) => signedIn(connection),
    },
    attach: ({ connection }) => attach(connection),
    verifyEpoch: async () => ({ status: "compatible", capabilities: [] }),
  });
}
