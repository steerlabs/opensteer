import type { DeploymentId } from "@opensteer/core";
import {
  hostKeyFingerprint,
  isSameHost,
  type HostBootstrapMethod,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import type { DesktopAccess } from "@opensteer/protocol/desktop";
import type { AttachmentConnection, ConnectionOrigin } from "./deployment-catalog.js";

export type { DesktopAccess } from "@opensteer/protocol/desktop";

/**
 * The live Personal Host this Desktop supervises. Never the manifest file: a
 * manifest describes a Deployment that may not be running, and only a running
 * Host can own a session.
 */
export interface LocalHostRuntime {
  readonly authority: HostDiscoveryEnvelope;
  readonly localOrigin: ConnectionOrigin;
}

/**
 * Total. Every catalog row has one of these, including a row with no usable
 * route, whose `access` and `key` are null.
 */
export interface ConnectionAccess {
  readonly access: DesktopAccess | null;
  /** Account Connect liveness, for presentation only. */
  readonly accountLivenessExpiresAt: string | null;
  readonly canonicalOrigin: ConnectionOrigin;
  readonly deploymentId: DeploymentId;
  /** A signed route exists, whether or not it was reachable at sync time. */
  readonly hasSignedRoute: boolean;
  /** The signed route was verified live and selected. */
  readonly hasVerifiedRoute: boolean;
  /** The single attachment/fence key. Null exactly when `access` is null. */
  readonly key: string | null;
  /**
   * Where to talk to it, or — when `access` is null — what to show as its
   * address. Never manufactured: a routed row falls back to the verified
   * canonical endpoint it was listed with.
   */
  readonly origin: ConnectionOrigin;
  readonly route: PersonalHostAccessRouteEnvelope | null;
}

export interface ResolvedConnection {
  readonly access: DesktopAccess;
  readonly authorization: string | null;
  readonly bootstrapMethods: readonly HostBootstrapMethod[];
  readonly canonicalOrigin: ConnectionOrigin;
  readonly deploymentId: DeploymentId;
  readonly key: string;
  readonly origin: ConnectionOrigin;
  readonly route: PersonalHostAccessRouteEnvelope | null;
}

/**
 * The one reader of `reachability`, `personalAccessRoute` and
 * `preferredEndpointOrigin`, and the one place a connection is compared to the
 * live local Personal Host. Precedence is owner, then routed, then native, and
 * it is evaluated in that order unconditionally: at the keyboard you use
 * loopback even when a preferred endpoint or a signed Connect route is set.
 */
export function describeConnectionAccess(
  connection: AttachmentConnection,
  localRuntime: LocalHostRuntime | null,
): ConnectionAccess {
  const document = connection.authority.document;
  const canonicalOrigin = document.canonicalOrigin;
  const route = connection.reachability === "routed" ? connection.personalAccessRoute : null;
  const preferredEndpointOrigin = connection.preferredEndpointOrigin ?? null;
  const common = {
    accountLivenessExpiresAt:
      connection.reachability === "routed" ? (connection.accountLivenessExpiresAt ?? null) : null,
    canonicalOrigin,
    deploymentId: document.deploymentId,
    hasSignedRoute: route !== null,
  };

  if (
    connection.kind === "personal" &&
    localRuntime !== null &&
    isSameHost(connection.authority, localRuntime.authority)
  ) {
    return {
      ...common,
      access: "owner",
      hasVerifiedRoute: false,
      key: attachmentKey(connection, localRuntime.localOrigin, "owner", null),
      origin: localRuntime.localOrigin,
      route: null,
    };
  }

  if (connection.reachability === "routed") {
    if (route === null || preferredEndpointOrigin !== route.document.route.origin) {
      // The Account directory's projection of a Personal computer that is
      // switched off: signed authority, no live route, and therefore no
      // attachment identity to manufacture from its unreachable loopback.
      return {
        ...common,
        access: null,
        hasVerifiedRoute: false,
        key: null,
        origin: verifiedCanonicalOrigin(connection),
        route,
      };
    }
    const access = route.document.route.kind;
    const origin = route.document.route.origin;
    return {
      ...common,
      access,
      hasVerifiedRoute: true,
      key: attachmentKey(connection, origin, access, route.document.route.generation),
      origin,
      route,
    };
  }

  const origin = nativeOrigin(connection, preferredEndpointOrigin);
  return {
    ...common,
    access: "native",
    hasVerifiedRoute: false,
    key: attachmentKey(connection, origin, "native", null),
    origin,
    route: null,
  };
}

/**
 * Every origin a connection names, whichever one is selected: its canonical
 * origin, each verified endpoint, the preferred one, and its signed route. For
 * recognizing a Deployment's own sites, never for choosing where to connect.
 */
export function connectionOrigins(connection: AttachmentConnection): readonly ConnectionOrigin[] {
  const origins = new Set<ConnectionOrigin>([connection.authority.document.canonicalOrigin]);
  for (const endpoint of connection.endpoints) origins.add(endpoint.origin);
  if (connection.preferredEndpointOrigin) origins.add(connection.preferredEndpointOrigin);
  if (connection.reachability === "routed" && connection.personalAccessRoute) {
    origins.add(connection.personalAccessRoute.document.route.origin);
  }
  return [...origins];
}

/**
 * Attachment. Throws where `describeConnectionAccess` returns a null access:
 * an attachment to a Deployment with no live route is a fault, not a state.
 */
export function resolveConnection(
  connection: AttachmentConnection,
  localRuntime: LocalHostRuntime | null,
  credential: { readonly authorization: string | null },
): ResolvedConnection {
  const facts = describeConnectionAccess(connection, localRuntime);
  if (facts.access === null || facts.key === null) {
    throw new Error("That computer has no live remote access route right now.");
  }
  return {
    access: facts.access,
    authorization: credential.authorization,
    bootstrapMethods: connection.bootstrapMethods,
    canonicalOrigin: facts.canonicalOrigin,
    deploymentId: facts.deploymentId,
    key: facts.key,
    origin: facts.origin,
    route: facts.route,
  };
}

/**
 * One attachment key and one transport fence. The local Runner keeps its own
 * durable Deployment target and resolves it through this authority; the same
 * key then proves that resolved target is still current. Route generation is a
 * separate term from Host identity so a rotated route invalidates in-flight
 * work without ever reading as a new Host.
 */
function attachmentKey(
  connection: AttachmentConnection,
  origin: ConnectionOrigin,
  access: DesktopAccess,
  routeGeneration: number | null,
): string {
  return JSON.stringify([
    connection.authority.document.deploymentId,
    connection.authority.document.hostInstanceId,
    hostKeyFingerprint(connection.authority.publicKey.spki),
    origin,
    access,
    routeGeneration,
  ]);
}

function nativeOrigin(
  connection: AttachmentConnection,
  preferredEndpointOrigin: ConnectionOrigin | null,
): ConnectionOrigin {
  if (preferredEndpointOrigin === null) return verifiedCanonicalOrigin(connection);
  const direct = connection.endpoints.find(
    (endpoint) => endpoint.kind === "direct" && endpoint.origin === preferredEndpointOrigin,
  );
  // Both this and the canonical case below are catalog invariants the
  // connection schema already rejects at write time. They stay as fail-closed
  // reads of a file another release could have written.
  if (!direct) throw new Error("The Deployment direct route is no longer verified.");
  return direct.origin;
}

function verifiedCanonicalOrigin(connection: AttachmentConnection): ConnectionOrigin {
  const canonical = connection.endpoints.find(
    (endpoint) =>
      endpoint.kind === "canonical" &&
      endpoint.origin === connection.authority.document.canonicalOrigin,
  );
  if (!canonical) throw new Error("The Deployment has no verified canonical Host endpoint.");
  return canonical.origin;
}
