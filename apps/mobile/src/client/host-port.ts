import {
  HostSession,
  type HostSessionExchange,
  type NativeOAuthManager,
} from "@opensteer/client/auth";
import {
  DesktopUpdatesService,
  HostVersionMismatchError,
  verifyAccessEndpoint,
  type DeploymentCatalogStore,
  type DeploymentConnection,
  type DesktopUpdates,
  type ResolvedConnection,
} from "@opensteer/client/connections";
import {
  HttpHostClient,
  type ClientLifecycle,
  type HostClient,
  type HostCapabilityReader,
  type BrowserPreferencesStorage,
} from "@opensteer/client/host";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { HostCapability } from "@opensteer/deployment-authority";
import { isSameHost } from "@opensteer/deployment-authority";
import {
  createHostNetwork,
  createMaintenanceNetwork,
  type HostAuthorization,
  type HostFetch,
} from "../platform/host-network.js";
import type { WebSocketClient } from "@opensteer/client/host";
import {
  createDeploymentCredentials,
  type DeploymentCredentials,
} from "./deployment-credentials.js";
import type { HostVerification } from "./deployment-rows.js";
import { personalSessionFrom, type PersonalSessionStore } from "./personal-session-store.js";
import { registerPhoneEnrollmentHost } from "../platform/phone-enrollment-host.js";

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
    readonly capabilities: readonly HostCapability[] | null | HostCapabilityReader;
    readonly connection: DeploymentConnection;
    readonly origin: string;
  }): HostClient;
  /** Below attachment: it must reach a Host on the other side of a protocol epoch. */
  desktopUpdates(input: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
    readonly deploymentId: DeploymentId;
  }): DesktopUpdates;
  verifyEpoch(
    resolved: ResolvedConnection,
    connection: DeploymentConnection,
  ): Promise<HostEpochAgreement>;
}

export type MobileHostPortFactory = (input: {
  readonly oauth: NativeOAuthManager;
  readonly sessions: PersonalSessionStore;
  readonly sessionExchange: HostSessionExchange;
}) => MobileHostPort;

export function createNetworkHostPort(options: {
  readonly browserPreferencesStorage?: BrowserPreferencesStorage;
  readonly fetch: HostFetch;
  readonly lifecycle: ClientLifecycle;
  readonly now: () => Date;
  readonly openWebSocket: (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) => WebSocketClient;
}): MobileHostPortFactory {
  const maintenanceNetwork = createMaintenanceNetwork(options);
  return ({ oauth, sessions, sessionExchange }) => ({
    credentials: createDeploymentCredentials({ now: options.now, oauth, sessions }),

    desktopUpdates: ({ catalog, deploymentId }) => {
      const credentials = createDeploymentCredentials({ now: options.now, oauth, sessions });
      return new DesktopUpdatesService({
        catalog,
        credentials: {
          teamEntryLease: (id) => oauth.teamEntryLease(id),
          authorizationHeader: (connection) => credentials.authorization(connection),
        },
        deploymentId,
        localRuntime: { current: async () => null },
        network: maintenanceNetwork,
        sessions: (attachment) =>
          new HostSession({
            attachment,
            clearDeploymentSession: (id) => sessions.clear(DeploymentIdSchema.parse(id)),
            exchange: {
              supports: (resolved) => sessionExchange.supports(resolved),
              probe: (resolved) => sessionExchange.probe(resolved),
              establish: async (resolved) => {
                const established = await sessionExchange.establish(resolved);
                if ((await attachment.current()).resolved.key !== resolved.key)
                  throw new Error("This computer's route changed during sign-in.");
                await sessions.save(personalSessionFrom(resolved.deploymentId, established));
                return established;
              },
            },
            localOwner: { ownsHostSession: () => false, recoverOwnerSession: async () => false },
            oauth,
          }),
      });
    },

    attach({ authorization, capabilities, connection, origin }): HostClient {
      const network = createHostNetwork({
        authorization,
        fetch: options.fetch,
        // The resolver's origin, not the client's base URL: the transport
        // decides for itself where this Deployment's credential may go.
        origin,
        openWebSocket: options.openWebSocket,
      });
      const client = new HttpHostClient({
        deviceAccessRequests: "include",
        baseUrl: origin,
        ...(options.browserPreferencesStorage
          ? { browserPreferencesStorage: options.browserPreferencesStorage }
          : {}),
        capabilities,
        fetch: network.fetch,
        lifecycle: options.lifecycle,
        webSocketFactory: network.webSocketFactory,
      });
      registerPhoneEnrollmentHost(client, {
        authorization,
        deploymentId: connection.authority.document.deploymentId,
        hostInstanceId: connection.authority.document.hostInstanceId,
        origin,
      });
      return client;
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
