import { createId } from "@opensteer/core";
import {
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { DeploymentConnectionSchema, type DeploymentConnection } from "./deployment-catalog.js";
import {
  describeConnectionAccess,
  resolveConnection,
  type LocalHostRuntime,
} from "./connection-resolver.js";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "../test-support/index.js";

const keys = testHostAuthorityKeys();
const loopbackOrigin = "http://127.0.0.1:4310";
const directOrigin = "https://studio.tailnet.example";
const routeOrigin = "https://studio.connect.opensteer.example";
const now = "2026-08-11T10:00:00.000Z";

describe("describeConnectionAccess", () => {
  it("prefers the supervised loopback Host over a verified direct endpoint", () => {
    const connection = personalConnection({
      endpoints: [canonicalEndpoint(), directEndpoint()],
      preferredEndpointOrigin: directOrigin,
    });

    const facts = describeConnectionAccess(connection, runtimeFor(connection));

    expect(facts).toMatchObject({
      access: "owner",
      hasSignedRoute: false,
      hasVerifiedRoute: false,
      origin: loopbackOrigin,
      route: null,
    });
  });

  it("prefers the supervised loopback Host over its own signed Connect route", () => {
    const connection = routedConnection("connect", 3);

    expect(describeConnectionAccess(connection, runtimeFor(connection))).toMatchObject({
      access: "owner",
      // The route is still signed and still listed; it is simply not the way
      // to reach a Host running on this very computer.
      hasSignedRoute: true,
      hasVerifiedRoute: false,
      origin: loopbackOrigin,
      route: null,
    });
  });

  it("gives an offline remote Personal computer an address but no attachment identity", () => {
    const connection = offlineRoutedConnection();

    expect(describeConnectionAccess(connection, null)).toMatchObject({
      access: null,
      hasSignedRoute: true,
      hasVerifiedRoute: false,
      key: null,
      origin: loopbackOrigin,
    });
    expect(() => resolveConnection(connection, null, { authorization: null })).toThrow(
      "no live remote access route",
    );
  });

  it("takes a routed arm from the signed route, not from where the entry came from", () => {
    const connection = routedConnection("private", 4, {
      issuer: "https://accounts.opensteer.example",
      kind: "account",
      subject: "acct_00000000-0000-4000-8000-000000000000",
    });

    expect(describeConnectionAccess(connection, null)).toMatchObject({
      access: "private",
      hasVerifiedRoute: true,
      origin: routeOrigin,
    });
  });

  it("fails closed on a preferred endpoint that is no longer verified", () => {
    const connection = {
      ...personalConnection({ endpoints: [canonicalEndpoint()] }),
      preferredEndpointOrigin: directOrigin,
    } as DeploymentConnection;

    expect(() => describeConnectionAccess(connection, null)).toThrow(
      "direct route is no longer verified",
    );
  });

  it("fails closed on a canonical connection with no verified canonical endpoint", () => {
    const connection = {
      ...personalConnection({ endpoints: [canonicalEndpoint()] }),
      endpoints: [{ kind: "direct", origin: directOrigin, verifiedAt: now }],
    } as DeploymentConnection;

    expect(() => describeConnectionAccess(connection, null)).toThrow(
      "no verified canonical Host endpoint",
    );
  });

  it("is native for a Personal Host this computer does not currently run", () => {
    const connection = personalConnection({ endpoints: [canonicalEndpoint()] });

    // Nothing supervised at all.
    expect(describeConnectionAccess(connection, null)).toMatchObject({
      access: "native",
      origin: loopbackOrigin,
    });
    // A restarted Host is a different Host.
    expect(
      describeConnectionAccess(connection, {
        authority: envelope({
          ...connection.authority.document,
          hostInstanceId: createId("hostInstance"),
        }),
        localOrigin: loopbackOrigin,
      }),
    ).toMatchObject({ access: "native" });
    // Same identity, different signing key: keeping that row out of the
    // catalog is the advance rule's job, and it is never an owner here.
    expect(
      describeConnectionAccess(connection, {
        authority: {
          ...connection.authority,
          publicKey: { algorithm: "Ed25519", spki: `${"B".repeat(58)}A` },
        },
        localOrigin: loopbackOrigin,
      }),
    ).toMatchObject({ access: "native" });
  });
});

describe("the one attachment key", () => {
  it("is stable for the same attachment and rotates on everything that can change it", () => {
    const connection = personalConnection({
      endpoints: [canonicalEndpoint(), directEndpoint()],
    });
    const runtime = runtimeFor(connection);
    const owner = describeConnectionAccess(connection, runtime).key;

    expect(describeConnectionAccess(connection, runtime).key).toBe(owner);

    // A different route to the same Host is a different attachment.
    const direct = describeConnectionAccess(
      { ...connection, preferredEndpointOrigin: directOrigin } as DeploymentConnection,
      null,
    ).key;
    expect(direct).not.toBe(owner);

    // A restarted Host, and a rotated Connect generation, each rotate it.
    const restarted = describeConnectionAccess(
      DeploymentConnectionSchema.parse({
        ...connection,
        authority: envelope({
          ...connection.authority.document,
          hostInstanceId: createId("hostInstance"),
        }),
      }),
      null,
    ).key;
    expect(restarted).not.toBe(describeConnectionAccess(connection, null).key);
    expect(describeConnectionAccess(routedConnection("connect", 1), null).key).not.toBe(
      describeConnectionAccess(routedConnection("connect", 2), null).key,
    );
  });
});

function personalConnection(overrides: {
  readonly endpoints: readonly { readonly kind: string; readonly origin: string }[];
  readonly preferredEndpointOrigin?: string;
}): DeploymentConnection {
  return DeploymentConnectionSchema.parse({
    authority: envelope(discoveryDocument()),
    bootstrapMethods: [],
    createdAt: now,
    endpoints: overrides.endpoints,
    kind: "personal",
    lastUsedAt: null,
    name: "Studio Mac",
    ...(overrides.preferredEndpointOrigin === undefined
      ? {}
      : { preferredEndpointOrigin: overrides.preferredEndpointOrigin }),
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function routedConnection(
  kind: "connect" | "private",
  generation: number,
  source: unknown = { kind: "manual" },
): DeploymentConnection {
  const authority = envelope(discoveryDocument());
  return DeploymentConnectionSchema.parse({
    accountLivenessExpiresAt: null,
    authority,
    bootstrapMethods: [kind === "connect" ? "connect-grant" : "pairing-code"],
    createdAt: now,
    endpoints: [{ kind: "direct", origin: routeOrigin, verifiedAt: now }],
    kind: "personal",
    lastUsedAt: null,
    name: "Studio Mac",
    personalAccessRoute: accessRoute(authority.document, kind, generation),
    preferredEndpointOrigin: routeOrigin,
    reachability: "routed",
    source,
    updatedAt: now,
  });
}

/** The Account directory's projection of a Personal computer that is off. */
function offlineRoutedConnection(): DeploymentConnection {
  const authority = envelope(discoveryDocument());
  return DeploymentConnectionSchema.parse({
    accountLivenessExpiresAt: null,
    authority,
    bootstrapMethods: ["connect-grant"],
    createdAt: now,
    endpoints: [canonicalEndpoint()],
    kind: "personal",
    lastUsedAt: null,
    name: "Studio Mac",
    personalAccessRoute: accessRoute(authority.document, "connect", 9),
    preferredEndpointOrigin: null,
    reachability: "routed",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function runtimeFor(connection: DeploymentConnection): LocalHostRuntime {
  return { authority: connection.authority, localOrigin: loopbackOrigin };
}

function discoveryDocument(): HostDiscoveryDocument {
  return {
    canonicalOrigin: loopbackOrigin,
    deploymentId: createId("deployment"),
    deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
  };
}

function envelope(document: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return signTestDiscoveryEnvelope(document, keys);
}

function accessRoute(
  authority: HostDiscoveryDocument,
  kind: "connect" | "private",
  generation: number,
): PersonalHostAccessRouteEnvelope {
  const document = {
    authority,
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation, kind, origin: routeOrigin },
  };
  return signTestPersonalAccessRoute(document, keys);
}

function canonicalEndpoint() {
  return { kind: "canonical", origin: loopbackOrigin, verifiedAt: now };
}

function directEndpoint() {
  return { kind: "direct", origin: directOrigin, verifiedAt: now };
}
