import {
  createId,
  type DeploymentId,
  type NativeOAuthApplication,
  type PersonalRemoteSessionDelivery,
} from "@opensteer/core";
import {
  AccountHostSessionGrantSchema,
  IssueAccountHostSessionGrantResponseSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteEnvelopeSchema,
  type AccountHostSessionGrant,
  type IssuePersonalAccountHostSessionGrantRequest,
  type PersonalHostAccessAuthority,
} from "@opensteer/control-plane-protocol";
import { sessionExchangePath } from "@opensteer/protocol";
import {
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConnectionSchema,
  type AttachmentConnection,
  type DeploymentConnection,
} from "../connections/deployment-catalog.js";
import { resolveConnection, type ResolvedConnection } from "../connections/connection-resolver.js";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
  type TestHostAuthorityKeys,
} from "../test-support/index.js";
import {
  credentialKindFor,
  HostSessionExchange,
  type HostSessionExchangeError,
} from "./host-session-exchange.js";

const pairingCode = `osp_${"p".repeat(43)}`;

describe("credentialKindFor", () => {
  it("derives the arm from the resolved access, never from a caller's choice", () => {
    expect(credentialKindFor("connect", ["connect-grant"])).toBe("account-connect-grant");
    expect(credentialKindFor("private", ["pairing-code"])).toBe("personal-pairing-code");
    // A Host that signs its own users in, and a Personal Host running on this
    // computer, exchange nothing.
    expect(credentialKindFor("native", ["password"])).toBeNull();
    expect(credentialKindFor("owner", [])).toBeNull();
    // The Host has to offer the arm the route reaches it through.
    expect(credentialKindFor("connect", ["pairing-code"])).toBeNull();
    expect(credentialKindFor("private", ["connect-grant"])).toBeNull();
  });
});

describe("HostSessionExchange", () => {
  it("binds each one-use Connect grant to the exact signed route and spends it on that origin", async () => {
    const fixture = exchangeFixture();
    const connection = remoteConnection("connect", 7);

    await fixture.exchange.establish(resolve(connection));
    await fixture.exchange.establish(resolve(connection));

    expect(fixture.account.personalGrantCalls).toEqual([
      {
        deploymentId: connection.authority.document.deploymentId,
        request: {
          clientSurface: "desktop",
          expectedAuthority: connection.authority.document,
          expectedRoute: connection.personalAccessRoute,
          targetKind: "personal-connect",
        },
      },
      {
        deploymentId: connection.authority.document.deploymentId,
        request: {
          clientSurface: "desktop",
          expectedAuthority: connection.authority.document,
          expectedRoute: connection.personalAccessRoute,
          targetKind: "personal-connect",
        },
      },
    ]);
    expect(new Set(fixture.account.issued).size).toBe(2);
    expect(fixture.requests.map(({ url }) => url)).toEqual([
      `${connection.personalAccessRoute!.document.route.origin}${sessionExchangePath}`,
      `${connection.personalAccessRoute!.document.route.origin}${sessionExchangePath}`,
    ]);
    expect(JSON.parse(String(fixture.requests[0]?.init.body))).toEqual({
      credential: {
        expectedRoute: connection.personalAccessRoute,
        grant: fixture.account.issued[0],
        kind: "account-connect-grant",
      },
      credentialDelivery: "cookie",
      schemaVersion: 2,
    });
  });

  it("asks for the delivery its own application can hold, and nothing else", async () => {
    const phone = exchangeFixture("mobile");
    const connection = remoteConnection("connect", 7);

    const established = await phone.exchange.establish(resolve(connection));

    expect(phone.account.personalGrantCalls[0]?.request.clientSurface).toBe("native");
    expect(JSON.parse(String(phone.requests[0]?.init.body))).toMatchObject({
      credentialDelivery: "header",
      schemaVersion: 2,
    });
    // The credential is handed to the caller rather than kept: only the
    // application knows where a native build may store one.
    expect(established.credentialDelivery).toBe("header");
    if (established.credentialDelivery !== "header") throw new Error("Expected header delivery");
    expect(established.credential.token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9+/]{43}=$/u);
  });

  it("refuses a session returned in a delivery it did not ask for", async () => {
    const fixture = exchangeFixture();
    fixture.deliveryOverride.current = "header";

    await expect(
      fixture.exchange.establish(resolve(remoteConnection("connect", 7))),
    ).rejects.toMatchObject({ outcome: "unavailable" });
  });

  it("pairs a Private route without any Account involvement", async () => {
    const fixture = exchangeFixture();
    const connection = remoteConnection("private", 11);

    await fixture.exchange.establish(resolve(connection), { pairingCode });

    expect(fixture.account.deploymentGrantCalls).toEqual([]);
    expect(fixture.account.personalGrantCalls).toEqual([]);
    expect(JSON.parse(String(fixture.requests[0]?.init.body))).toEqual({
      credential: {
        code: pairingCode,
        expectedRoute: connection.personalAccessRoute!.document,
        kind: "personal-pairing-code",
      },
      credentialDelivery: "cookie",
      schemaVersion: 2,
    });
  });

  it("never invents a pairing code the operator did not supply", async () => {
    const fixture = exchangeFixture();

    await expect(
      fixture.exchange.establish(resolve(remoteConnection("private", 11))),
    ).rejects.toMatchObject(
      expect.objectContaining<Partial<HostSessionExchangeError>>({
        outcome: "pairing-required",
      }),
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("leaves an attachment with no exchangeable credential to its own authorization", async () => {
    const fixture = exchangeFixture();
    const selfHosted = selfHostedConnection();

    expect(fixture.exchange.supports(resolve(selfHosted))).toBe(false);
    await expect(fixture.exchange.probe(resolve(selfHosted))).rejects.toThrow(
      /does not open a session/u,
    );
    await expect(fixture.exchange.establish(resolve(selfHosted))).rejects.toThrow(
      /does not open a session/u,
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("reports only an actual 401 as unauthenticated and throttles that negative probe", async () => {
    const fixture = exchangeFixture();
    const connection = remoteConnection("connect", 7);
    fixture.probeStatus.current = 401;

    await expect(fixture.exchange.probe(resolve(connection))).resolves.toBe("unauthenticated");
    await expect(fixture.exchange.probe(resolve(connection))).resolves.toBe("unauthenticated");

    expect(fixture.requests).toHaveLength(1);
  });

  it("answers Host admission the same way for every arm and never hides an unreachable Host", async () => {
    for (const connection of [remoteConnection("connect", 7), remoteConnection("private", 8)]) {
      const blocked = exchangeFixture();
      blocked.probeStatus.current = 403;
      await expect(blocked.exchange.probe(resolve(connection))).resolves.toBe("blocked");

      const unavailable = exchangeFixture();
      unavailable.probeStatus.current = 503;
      await expect(unavailable.exchange.probe(resolve(connection))).rejects.toMatchObject({
        outcome: "unavailable",
      });

      const offline = exchangeFixture();
      offline.probeFailure.current = new TypeError("network offline");
      await expect(offline.exchange.probe(resolve(connection))).rejects.toThrow(/network offline/u);
      await expect(offline.exchange.probe(resolve(connection))).rejects.toThrow(/network offline/u);
      expect(offline.requests).toHaveLength(2);
    }
  });

  it("classifies a refused exchange by what the operator would have to change", async () => {
    const account = exchangeFixture();
    account.exchangeStatus.current = 403;
    await expect(
      account.exchange.establish(resolve(remoteConnection("connect", 7))),
    ).rejects.toMatchObject(
      expect.objectContaining<Partial<HostSessionExchangeError>>({ outcome: "blocked" }),
    );

    const pairing = exchangeFixture();
    pairing.exchangeStatus.current = 403;
    await expect(
      pairing.exchange.establish(resolve(remoteConnection("private", 11)), { pairingCode }),
    ).rejects.toMatchObject(
      expect.objectContaining<Partial<HostSessionExchangeError>>({
        outcome: "pairing-required",
      }),
    );

    const offline = exchangeFixture();
    offline.exchangeStatus.current = 503;
    await expect(
      offline.exchange.establish(resolve(remoteConnection("connect", 7))),
    ).rejects.toMatchObject(
      expect.objectContaining<Partial<HostSessionExchangeError>>({
        outcome: "unavailable",
      }),
    );
  });

  it("never spends a grant after its Account authorization is invalidated", async () => {
    const fixture = exchangeFixture();
    const gate = deferred<void>();
    fixture.exchangeGate.current = gate.promise;

    const establishment = fixture.exchange.establish(resolve(remoteConnection("connect", 7)));
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    fixture.account.authorization.abort(new Error("Account signed out."));
    gate.resolve();

    await expect(establishment).rejects.toMatchObject({ outcome: "unavailable" });
    expect(fixture.requests[0]?.init.signal?.aborted).toBe(true);
  });

  it("refuses to spend a Connect grant that its Account already invalidated", async () => {
    const fixture = exchangeFixture();
    fixture.account.authorization.abort(new Error("Account signed out."));

    await expect(
      fixture.exchange.establish(resolve(remoteConnection("connect", 7))),
    ).rejects.toMatchObject(
      expect.objectContaining<Partial<HostSessionExchangeError>>({
        outcome: "unavailable",
      }),
    );
    expect(fixture.requests).toHaveLength(0);
  });
});

function exchangeFixture(application: NativeOAuthApplication = "desktop") {
  const account = new OneUseGrantAccount();
  const requests: { deploymentId: string; init: RequestInit; url: string }[] = [];
  const probeFailure: { current: Error | null } = { current: null };
  const probeStatus = { current: 204 };
  const exchangeStatus = { current: 200 };
  const exchangeGate: { current: Promise<void> | null } = { current: null };
  const deliveryOverride: { current: PersonalRemoteSessionDelivery | null } = { current: null };
  const delivery = application === "mobile" ? "header" : "cookie";
  const exchange = new HostSessionExchange({
    account,
    application,
    fetch: vi.fn(async (deploymentId, input, init) => {
      const url = String(input);
      requests.push({ deploymentId, init, url });
      if (url.endsWith("/v1/auth/session")) {
        if (probeFailure.current) throw probeFailure.current;
        return new Response(null, { status: probeStatus.current });
      }
      await exchangeGate.current;
      if (exchangeStatus.current !== 200) {
        return Response.json({}, { status: exchangeStatus.current });
      }
      return Response.json(sessionExchangeResponse(deliveryOverride.current ?? delivery));
    }),
  });
  return {
    account,
    deliveryOverride,
    exchange,
    exchangeGate,
    exchangeStatus,
    probeFailure,
    probeStatus,
    requests,
  };
}

class OneUseGrantAccount {
  readonly authorization = new AbortController();
  readonly deploymentGrantCalls: DeploymentId[] = [];
  readonly issued: AccountHostSessionGrant[] = [];
  readonly personalGrantCalls: Array<{
    readonly deploymentId: DeploymentId;
    readonly request: IssuePersonalAccountHostSessionGrantRequest;
  }> = [];

  async issueDeploymentSessionBootstrapGrant(deploymentId: DeploymentId) {
    this.deploymentGrantCalls.push(deploymentId);
    return this.#lease();
  }

  async issuePersonalHostSessionGrant(
    deploymentId: DeploymentId,
    request: IssuePersonalAccountHostSessionGrantRequest,
  ) {
    this.personalGrantCalls.push({ deploymentId, request: structuredClone(request) });
    return this.#lease();
  }

  #lease() {
    const grant = sessionGrant(this.issued.length + 1);
    this.issued.push(grant);
    return {
      response: IssueAccountHostSessionGrantResponseSchema.parse({
        expiresAt: "2026-08-12T12:02:00.000Z",
        grant,
      }),
      signal: this.authorization.signal,
    };
  }
}

function sessionGrant(generation: number): AccountHostSessionGrant {
  return AccountHostSessionGrantSchema.parse(
    `${"a".repeat(30)}${generation}.${"b".repeat(32)}.${"c".repeat(32)}`,
  );
}

function sessionExchangeResponse(delivery: PersonalRemoteSessionDelivery) {
  return {
    ...(delivery === "header"
      ? {
          credential: {
            absoluteExpiresAt: "2026-08-24T10:00:00.000Z",
            expiresAt: "2026-08-18T10:00:00.000Z",
            token: `${"t".repeat(43)}.${"s".repeat(43)}=`,
          },
        }
      : {}),
    credentialDelivery: delivery,
    schemaVersion: 2,
    session: {
      absoluteExpiresAt: "2026-08-24T10:00:00.000Z",
      createdAt: "2026-08-17T10:00:00.000Z",
      expiresAt: "2026-08-18T10:00:00.000Z",
      id: createId("authSession"),
      user: {
        disabledAt: null,
        displayName: "Operator",
        email: "operator@opensteer.test",
        emailVerified: true,
        id: createId("user"),
        image: null,
        instanceRole: "administrator",
      },
    },
  };
}

function cloudConnection(): DeploymentConnection {
  return DeploymentConnectionSchema.parse({
    authority: signDiscovery({
      canonicalOrigin: "https://cloud.opensteer.test",
      deploymentId: cloudDeploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    }),
    bootstrapMethods: ["password"],
    createdAt: "2026-08-17T09:00:00.000Z",
    endpoints: [
      {
        kind: "canonical",
        origin: "https://cloud.opensteer.test",
        verifiedAt: "2026-08-17T09:00:00.000Z",
      },
    ],
    kind: "self-hosted",
    lastUsedAt: null,
    name: "My Opensteer",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: "2026-08-17T09:00:00.000Z",
  });
}

function selfHostedConnection(): DeploymentConnection {
  return cloudConnection();
}

/** Every attachment here is remote, so no local runtime can be its owner. */
function resolve(connection: AttachmentConnection): ResolvedConnection {
  return resolveConnection(connection, null, { authorization: null });
}

function signDiscovery(document: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return signTestDiscoveryEnvelope(document, remoteAuthorityFixture.keys);
}

function remoteConnection(
  kind: "connect" | "private",
  generation: number,
): Extract<DeploymentConnection, { readonly reachability: "routed" }> {
  const origin = `https://home.${kind}.test`;
  const document = {
    authority: remoteAuthorityFixture.authority,
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation, kind, origin },
  };
  const route = PersonalHostAccessRouteEnvelopeSchema.parse(
    signTestPersonalAccessRoute(document, remoteAuthorityFixture.keys),
  );
  const now = "2026-08-12T12:00:00.000Z";
  const connection = DeploymentConnectionSchema.parse({
    accountLivenessExpiresAt: null,
    authority: signDiscovery(remoteAuthorityFixture.authority),
    bootstrapMethods: [kind === "connect" ? "connect-grant" : "pairing-code"],
    createdAt: now,
    endpoints: [{ kind: "direct", origin, verifiedAt: now }],
    kind: "personal" as const,
    lastUsedAt: null,
    name: "Home Mac",
    personalAccessRoute: route,
    preferredEndpointOrigin: origin,
    reachability: "routed",
    source: { kind: "manual" },
    updatedAt: now,
  });
  if (connection.reachability !== "routed") throw new Error("Expected routed fixture");
  return connection;
}

interface RemoteAuthorityFixture {
  readonly authority: PersonalHostAccessAuthority;
  readonly keys: TestHostAuthorityKeys;
}

function remoteAuthority(): RemoteAuthorityFixture {
  return {
    authority: PersonalHostAccessAuthoritySchema.parse({
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: {
        algorithm: "Ed25519",
      },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    }),
    keys: testHostAuthorityKeys(),
  };
}

const cloudDeploymentId = createId("deployment");
const remoteAuthorityFixture = remoteAuthority();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
