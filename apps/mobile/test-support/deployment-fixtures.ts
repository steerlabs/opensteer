import {
  DeploymentConnectionSchema,
  type DeploymentConnection,
} from "@opensteer/client/connections";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  type DeploymentDisplayKind,
} from "@opensteer/core";
import {
  HostDiscoveryDocumentSchema,
  type HostDiscoveryDocument,
} from "@opensteer/deployment-authority";

/**
 * Catalog rows for this app's own tests.
 *
 * It lives outside `src/` because it reaches for `@opensteer/client/test-support`,
 * and nothing Metro could follow from the app's entry point may touch a module
 * that exists to fake things.
 *
 * The envelopes are really signed, with one key for the whole fixture set,
 * because the catalog schema verifies a Personal access route against the Host
 * authority it claims to belong to. Nothing here is a second copy of that
 * verification: the signing helpers come from the package that owns it.
 */
const keys = testHostAuthorityKeys();

const personalCanonicalOrigin = "http://127.0.0.1:4173";
const personalRouteOrigin = "https://route.example.com";
const serverCanonicalOrigin = "https://host.example.com";
const verifiedAt = "2026-09-01T00:00:00.000Z";

export function testDeploymentConnection(input: {
  readonly deploymentId?: string;
  readonly kind?: DeploymentDisplayKind;
  readonly name?: string;
  /** A Personal computer whose signed route is live. Off means asleep. */
  readonly reachable?: boolean;
  /**
   * The signed route a Personal computer is reached on. `connect` is the arm
   * the Account signs a grant for; `private` is the one that wants a pairing
   * code. The generation is what a rotation changes.
   */
  readonly route?: { readonly generation?: number; readonly kind?: "connect" | "private" };
  readonly source?: DeploymentConnection["source"];
}): DeploymentConnection {
  const kind = input.kind ?? "self-hosted";
  const personal = kind === "personal";
  const document = testDiscoveryDocument({
    canonicalOrigin: personal ? personalCanonicalOrigin : serverCanonicalOrigin,
    deploymentId: input.deploymentId ?? "dep_0192f4a1-1111-4000-8000-000000000001",
    personal,
  });
  const authority = signTestDiscoveryEnvelope(document, keys);
  const timestamps = { createdAt: verifiedAt, lastUsedAt: null, updatedAt: verifiedAt };
  const common = {
    ...timestamps,
    accountAccess: null,
    authority,
    kind,
    name: input.name ?? (personal ? "Alex's Mac mini" : "host.example.com"),
    source: input.source ?? { kind: "manual" },
  };

  if (!personal) {
    return DeploymentConnectionSchema.parse({
      ...common,
      bootstrapMethods: ["oidc"],
      endpoints: [{ kind: "canonical", origin: serverCanonicalOrigin, verifiedAt }],
      preferredEndpointOrigin: null,
      reachability: "canonical",
    });
  }

  // A Personal computer that is switched off keeps its Account listing and
  // loses its route, which is exactly the state the resolver calls unavailable.
  if (input.reachable === false) {
    return DeploymentConnectionSchema.parse({
      ...common,
      accountLivenessExpiresAt: null,
      bootstrapMethods: ["pairing-code"],
      endpoints: [{ kind: "canonical", origin: personalCanonicalOrigin, verifiedAt }],
      personalAccessRoute: null,
      preferredEndpointOrigin: null,
      reachability: "routed",
    });
  }

  const routeKind = input.route?.kind ?? "private";
  const route = signTestPersonalAccessRoute(
    {
      authority: document,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: {
        generation: input.route?.generation ?? 1,
        kind: routeKind,
        origin: personalRouteOrigin,
      },
    },
    keys,
  );
  return DeploymentConnectionSchema.parse({
    ...common,
    accountLivenessExpiresAt: null,
    bootstrapMethods: [routeKind === "connect" ? "connect-grant" : "pairing-code"],
    endpoints: [{ kind: "direct", origin: personalRouteOrigin, verifiedAt }],
    personalAccessRoute: route,
    preferredEndpointOrigin: personalRouteOrigin,
    reachability: "routed",
  });
}

function testDiscoveryDocument(input: {
  readonly canonicalOrigin: string;
  readonly deploymentId: string;
  readonly personal: boolean;
}): HostDiscoveryDocument {
  return HostDiscoveryDocumentSchema.parse({
    canonicalOrigin: input.canonicalOrigin,
    deploymentId: DeploymentIdSchema.parse(input.deploymentId),
    deploymentShape: {
      defaultWorkspaceBacking: input.personal ? "local-directory" : "portablefs",
      kind: input.personal ? "personal" : "server",
    },
    hostInstanceId: HostInstanceIdSchema.parse("hst_0192f4a1-2222-4000-8000-000000000002"),
    hostKey: { algorithm: "Ed25519" },
  });
}
