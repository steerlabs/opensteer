import { generateKeyPairSync, sign } from "node:crypto";
import {
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
} from "@opensteer/control-plane-protocol";
import {
  AuthenticatedSessionSchema,
  createId,
  OpensteerError,
  type PersonalRemoteSessionDelivery,
} from "@opensteer/core";
import {
  SessionExchangeResponseSchema,
  sessionExchangeDeliveryForClientSurface,
  sessionExchangePath,
} from "@opensteer/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { advertisedBootstrapMethods } from "../server.js";
import {
  availableSessionExchangeArms,
  jsonExchangeSurfaces,
  registerSessionExchangeRoute,
} from "./session-exchange-routes.js";

const accountGrant = `${"a".repeat(30)}.${"b".repeat(32)}.${"c".repeat(32)}`;
const pairingCode = `osp_${"p".repeat(43)}`;
const signedRoute = personalAccessRoute();

const connectCredential = {
  expectedRoute: signedRoute,
  grant: accountGrant,
  kind: "account-connect-grant",
} as const;
const pairingCredential = {
  code: pairingCode,
  expectedRoute: signedRoute.document,
  kind: "personal-pairing-code",
} as const;

describe("registerSessionExchangeRoute", () => {
  it("advertises exactly the session-exchange methods its handler accepts", async () => {
    const fixture = await routeFixture({ personal: true });
    const dependencies = { personalRemoteAccess: fixture.personal as never };
    const advertised = await advertisedBootstrapMethods({
      authenticator: {
        identity: {
          configuration: async () => ({ localPasswordEnabled: false, oidcProviders: [] }),
        },
      } as never,
      personalRemoteAccess: { service: dependencies.personalRemoteAccess },
    });
    const handled = [...availableSessionExchangeArms(dependencies).keys()].map((kind) =>
      kind === "account-connect-grant" ? "connect-grant" : "pairing-code",
    );

    expect(advertised).toEqual(handled);
    await fixture.app.close();
  });

  it("lands every cookie arm in the same session shape and the same partition cookie", async () => {
    const fixture = await routeFixture({ personal: true });

    for (const credential of [connectCredential, pairingCredential]) {
      const response = await fixture.exchange(credential);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(String(response.headers["set-cookie"])).toContain("__Host-opensteer.session=");
      const body = SessionExchangeResponseSchema.parse(response.json());
      expect(body.schemaVersion).toBe(2);
      expect(body.credentialDelivery).toBe("cookie");
      // The body carries the session and nothing that could be replayed.
      expect(Object.keys(response.json() as object).sort()).toEqual([
        "credentialDelivery",
        "schemaVersion",
        "session",
      ]);
    }

    expect(fixture.personal.exchangeAccountSessionGrant).toHaveBeenCalledOnce();
    expect(fixture.personal.exchangePairingCode).toHaveBeenCalledOnce();
    await fixture.app.close();
  });

  it("returns the credential in the body, and no cookie, for header delivery", async () => {
    const fixture = await routeFixture({ delivery: "header", personal: true });

    for (const credential of [connectCredential, pairingCredential]) {
      const response = await fixture.exchange(credential, { delivery: "header" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      const body = SessionExchangeResponseSchema.parse(response.json());
      if (body.credentialDelivery !== "header") throw new Error("Expected header delivery");
      expect(body.credential.token).toBe(headerCredential);
    }
    await fixture.app.close();
  });

  it("names the client surface the requested delivery implies, and nothing the caller said", async () => {
    const fixture = await routeFixture({ personal: true });

    await fixture.exchange(connectCredential);
    expect(fixture.personal.exchangeAccountSessionGrant).toHaveBeenCalledWith({
      clientAddress: expect.any(String),
      expectedRoute: connectCredential.expectedRoute,
      grant: connectCredential.grant,
      portalOrigin: undefined,
      routeOrigin: "https://home.connect.test",
      surface: "desktop",
      userAgent: clientUserAgent,
    });

    const native = await routeFixture({ delivery: "header", personal: true });
    await native.exchange(connectCredential, { delivery: "header" });
    expect(native.personal.exchangeAccountSessionGrant).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "native" }),
    );
    await native.app.close();

    await fixture.exchange(pairingCredential);
    expect(fixture.personal.exchangePairingCode).toHaveBeenCalledWith(pairingCredential, {
      delivery: "cookie",
      routeOrigin: "https://home.connect.test",
      userAgent: clientUserAgent,
    });
    await fixture.app.close();
  });

  it("derives the route origin from the trusted ingress, never from a client Origin", async () => {
    const fixture = await routeFixture({ personal: true });

    // A native client sends no Origin at all, and one that lies about it is
    // still measured against the authority the request actually arrived on.
    await fixture.exchange(connectCredential, { origin: "https://attacker.test" });

    expect(fixture.personal.exchangeAccountSessionGrant).toHaveBeenCalledWith(
      expect.objectContaining({ routeOrigin: "https://home.connect.test" }),
    );
    await fixture.app.close();
  });

  it("keeps the delivery rule and the surface it implies exact inverses", () => {
    for (const [delivery, surface] of Object.entries(jsonExchangeSurfaces)) {
      expect(sessionExchangeDeliveryForClientSurface(surface)).toBe(delivery);
    }
    // The portal's own redirect is the third surface, and it is a cookie too.
    expect(sessionExchangeDeliveryForClientSurface("browser")).toBe("cookie");
  });

  it("accepts the portal form on the same route and redirects after setting the session", async () => {
    const fixture = await routeFixture({ personal: true });

    const response = await fixture.form(new URLSearchParams({ grant: accountGrant }).toString());

    expect(response.statusCode, response.body).toBe(303);
    expect(response.headers.location).toBe("/");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(String(response.headers["set-cookie"])).toContain("__Host-opensteer.session=");
    expect(response.body).toBe("");
    expect(fixture.personal.exchangeAccountSessionGrant).toHaveBeenCalledWith({
      clientAddress: expect.any(String),
      expectedRoute: undefined,
      grant: accountGrant,
      portalOrigin: "https://portal.test",
      routeOrigin: "https://home.connect.test",
      surface: "browser",
      userAgent: clientUserAgent,
    });
    await fixture.app.close();
  });

  it("rejects ambiguous or malformed portal forms", async () => {
    const fixture = await routeFixture({ personal: true });

    for (const payload of [
      `grant=${accountGrant}&extra=value`,
      `grant=${accountGrant}&grant=${accountGrant}`,
      Buffer.from([0xff]),
    ]) {
      const response = await fixture.form(payload);
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(fixture.personal.exchangeAccountSessionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("rejects every content type outside the two declared arms", async () => {
    const fixture = await routeFixture({ personal: true });

    for (const headers of [{ "content-type": "text/plain" }, {}]) {
      const response = await fixture.app.inject({
        headers,
        method: "POST",
        payload: "grant=unparsed",
        url: sessionExchangePath,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(fixture.personal.exchangeAccountSessionGrant).not.toHaveBeenCalled();
    expect(fixture.personal.exchangePairingCode).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("returns not found when a form reaches a Deployment with only the pairing arm", async () => {
    const fixture = await routeFixture({ personal: true, personalAccountLinked: false });

    const response = await fixture.form(new URLSearchParams({ grant: accountGrant }).toString());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(fixture.personal.exchangeAccountSessionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("rejects a credential that is not exactly one arm", async () => {
    const fixture = await routeFixture({ personal: true });

    for (const credential of [
      { grant: accountGrant },
      { grant: accountGrant, kind: "invented-arm" },
      { ...pairingCredential, grant: accountGrant },
    ]) {
      const response = await fixture.exchange(credential);
      expect(response.statusCode, JSON.stringify(credential)).toBe(400);
    }
    await fixture.app.close();
  });

  it("rejects a body that is not exactly this schema version and delivery", async () => {
    const fixture = await routeFixture({ personal: true });

    for (const payload of [
      { credential: connectCredential, credentialDelivery: "cookie", schemaVersion: 1 },
      { credential: connectCredential, schemaVersion: 2 },
      { credential: connectCredential, credentialDelivery: "bearer", schemaVersion: 2 },
    ]) {
      const response = await fixture.app.inject({
        headers: {
          "content-type": "application/json",
          host: "home.connect.test",
          "x-forwarded-proto": "https",
        },
        method: "POST",
        payload,
        url: sessionExchangePath,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(fixture.personal.exchangeAccountSessionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });
});

async function routeFixture(options: {
  readonly delivery?: PersonalRemoteSessionDelivery;
  readonly personal: boolean;
  readonly personalAccountLinked?: boolean;
}) {
  const issue = () => ({
    headers: options.delivery === "header" ? noStoreHeaders() : sessionCookieHeaders(),
    issued:
      options.delivery === "header"
        ? ({
            credential: {
              absoluteExpiresAt: "2026-08-24T10:00:00.000Z",
              expiresAt: "2026-08-18T10:00:00.000Z",
              token: headerCredential,
            },
            delivery: "header",
            session: testSession(),
          } as const)
        : ({ delivery: "cookie", session: testSession() } as const),
  });
  const personal = {
    accountSessionExchangeEnabled: vi.fn(() => options.personalAccountLinked ?? true),
    exchangeAccountSessionGrant: vi.fn(async () => issue()),
    exchangePairingCode: vi.fn(async () => issue()),
  };
  const app = Fastify();
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerSessionExchangeRoute(app, {
    personalRemoteAccess: options.personal ? (personal as never) : undefined,
  });
  installOpensteerErrorHandler(app);
  await app.ready();
  return {
    app,
    exchange: (
      credential: unknown,
      request: {
        readonly delivery?: PersonalRemoteSessionDelivery;
        readonly origin?: string;
      } = {},
    ) =>
      app.inject({
        headers: {
          "content-type": "application/json",
          host: "home.connect.test",
          "user-agent": clientUserAgent,
          "x-forwarded-proto": "https",
          ...(request.origin ? { origin: request.origin } : {}),
        },
        method: "POST",
        payload: {
          credential,
          credentialDelivery: request.delivery ?? "cookie",
          schemaVersion: 2,
        },
        url: sessionExchangePath,
      }),
    form: (payload: string | Buffer) =>
      app.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "home.connect.test",
          origin: "https://portal.test",
          "user-agent": clientUserAgent,
          "x-forwarded-proto": "https",
        },
        method: "POST",
        payload,
        url: sessionExchangePath,
      }),
    personal,
  };
}

/** Carried through only so the device list can name the client. */
const clientUserAgent = "Opensteer/42 CFNetwork/1568.100.1 Darwin/24.0.0";

/** The shape `issuePersonalRemoteSession` returns for header delivery. */
const headerCredential = `${"t".repeat(43)}.${"s".repeat(43)}=`;

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set("cache-control", "no-store");
  return headers;
}

function sessionCookieHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `__Host-opensteer.session=${"t".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return headers;
}

function testSession() {
  return AuthenticatedSessionSchema.parse({
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
  });
}

function personalAccessRoute() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const document = {
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
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation: 7, kind: "connect" as const, origin: "https://home.connect.test" },
  };
  return PersonalHostAccessRouteEnvelopeSchema.parse({
    document,
    publicKey: { algorithm: "Ed25519", spki: spki.toString("base64url") },
    schemaVersion: 1,
    signature: sign(null, personalHostAccessRouteSigningBytes(document), keys.privateKey).toString(
      "base64url",
    ),
  });
}

function installOpensteerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OpensteerError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "forbidden"
            ? 403
            : error.code === "bad_request"
              ? 400
              : 500;
      return reply.status(status).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(400).send({ error: { code: "bad_request", message: "Request failed" } });
  });
}
