import {
  ControlPlaneAccountIdSchema,
  HostedOAuthAttemptIdSchema,
} from "@opensteer/control-plane-protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedOAuthBrokerRefusal } from "./hosted-oauth-broker-service.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  hostedOAuthLaunchReturnTo,
  registerHostedOAuthBrokerRoutes,
} from "./hosted-oauth-broker-routes.js";
import { createControlPlaneServer } from "../server/server.js";

const publicOrigin = new URL("https://accounts.opensteer.test");
const attemptId = HostedOAuthAttemptIdSchema.parse("hoa_00000000-0000-4000-8000-000000000001");
const launchTicket = "T".repeat(43);
const launchPath = `/v1/oauth-broker/launch/${attemptId}?ticket=${launchTicket}`;

describe("hosted OAuth metadata compatibility", () => {
  it("only emits installation metadata to a version 2 caller", async () => {
    const metadata = vi.fn((includeInstallationUrls: boolean) => ({
      ...(includeInstallationUrls
        ? { installationUrls: { github: "https://github.com/apps/opensteer/installations/new" } }
        : {}),
      encryptionPublicKey: "A".repeat(43),
      issuer: publicOrigin.toString(),
      providerRevisions: { github: 1 },
    }));
    const server = Fastify();
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      broker: { metadata } as never,
      store: {} as never,
    });
    const legacy = await server.inject({ method: "GET", url: "/v1/oauth-broker/metadata" });
    const current = await server.inject({
      method: "GET",
      url: "/v1/oauth-broker/metadata?version=2",
    });
    await server.close();

    expect(legacy.json()).not.toHaveProperty("installationUrls");
    expect(current.json()).toHaveProperty(
      "installationUrls.github",
      "https://github.com/apps/opensteer/installations/new",
    );
    expect(metadata.mock.calls).toEqual([[false], [true]]);
  });
});

describe("hosted OAuth browser launch", () => {
  const servers: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("sends a signed-out browser through Account sign-in with only the exact launch URL", async () => {
    const authenticate = vi.fn(async () => {
      throw new ControlPlaneError("unauthorized", "Sign in is required");
    });
    const launchAuthorization = vi.fn();
    const server = Fastify();
    servers.push(server);
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: { authenticate } as never,
      broker: {
        inspectLaunch: vi.fn(async () => ({ status: "ready" })),
        launchAuthorization,
      } as never,
      store: {} as never,
    });

    const response = await server.inject({ method: "GET", url: launchPath });

    expect(response.statusCode).toBe(302);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const signIn = new URL(response.headers.location ?? "", publicOrigin);
    expect(signIn.pathname).toBe("/sign-in");
    expect(signIn.searchParams.get("return_to")).toBe(launchPath);
    expect(launchAuthorization).not.toHaveBeenCalled();
  });

  it("launches the provider only after the browser has the matching Account session", async () => {
    const accountId = ControlPlaneAccountIdSchema.parse(
      "acct_00000000-0000-4000-8000-000000000001",
    );
    const launchAuthorization = vi.fn(async () => "https://provider.test/authorize");
    const server = Fastify();
    servers.push(server);
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {
        authenticate: vi.fn(async () => ({ accountId, kind: "session" as const })),
      } as never,
      broker: {
        inspectLaunch: vi.fn(async () => ({ status: "ready" })),
        launchAuthorization,
      } as never,
      store: {} as never,
    });

    const response = await server.inject({ method: "GET", url: launchPath });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("https://provider.test/authorize");
    expect(response.headers["set-cookie"]).toContain(
      `__Secure-opensteer.oauth.${attemptId}=${launchTicket};`,
    );
    expect(launchAuthorization).toHaveBeenCalledWith(accountId, attemptId, launchTicket);
  });

  it("launches an app-finish attempt without authenticating the browser", async () => {
    const authenticate = vi.fn();
    const launchAuthorization = vi.fn(async () => "https://provider.test/authorize");
    const server = Fastify();
    servers.push(server);
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: { authenticate } as never,
      broker: {
        inspectLaunch: vi.fn(async () => ({ status: "ready", finish: "app" })),
        launchAuthorization,
      } as never,
      store: {} as never,
    });
    const response = await server.inject({ method: "GET", url: launchPath });
    expect(response.statusCode).toBe(303);
    expect(authenticate).not.toHaveBeenCalled();
    expect(launchAuthorization).toHaveBeenCalledWith(null, attemptId, launchTicket);
  });

  it.each(["expired", "used", "invalid"] as const)(
    "explains a %s link before authentication",
    async (status) => {
      const authenticate = vi.fn();
      const server = Fastify();
      servers.push(server);
      registerHostedOAuthBrokerRoutes(server, {
        authenticator: { authenticate } as never,
        broker: { inspectLaunch: vi.fn(async () => ({ status })) } as never,
        store: {} as never,
      });
      const response = await server.inject({ method: "GET", url: launchPath });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(status === "used" ? "already used" : "expired");
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it("shows only the browser's own Account on mismatch and preserves the launch", async () => {
    const browserAccount = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const launchAuthorization = vi.fn(async () => {
      throw new HostedOAuthBrokerRefusal(attemptId, "account-mismatch");
    });
    const log = vi.fn();
    const server = Fastify({ disableRequestLogging: true });
    servers.push(server);
    server.addHook("onRequest", async (request) => {
      request.log.warn = log;
    });
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {
        authenticate: vi.fn(async () => ({ accountId: browserAccount, kind: "session" })),
      } as never,
      auth: {
        api: { getSession: vi.fn(async () => ({ user: { email: "browser@example.test" } })) },
      } as never,
      broker: {
        inspectLaunch: vi.fn(async () => ({ status: "ready" })),
        launchAuthorization,
      } as never,
      store: {} as never,
    });
    const response = await server.inject({ method: "GET", url: launchPath });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("browser@example.test");
    expect(response.body).toContain("Switch account");
    expect(response.body).toContain('name="switch_account"');
    expect(response.body).not.toContain("loginHint");
    expect(log.mock.calls).toEqual([
      [{ attemptId, reason: "account-mismatch" }, "Hosted OAuth launch refused"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(launchTicket);
    expect(JSON.stringify(log.mock.calls)).not.toContain("browser@example.test");
  });

  it("switches accounts through an exact-origin POST with a preserved ticket and Google chooser", async () => {
    const authHandler = vi.fn(async (request: Request) =>
      new URL(request.url).pathname.endsWith("/sign-out")
        ? new Response(null, { headers: { "set-cookie": "account=; Max-Age=0; Path=/" } })
        : Response.json(
            { url: "https://google.test/chooser" },
            { headers: { "set-cookie": "state=synthetic; Path=/" } },
          ),
    );
    const inspectLaunch = vi.fn<() => Promise<{ status: string }>>(async () => ({
      status: "ready",
    }));
    const server = await createControlPlaneServer({
      auth: {
        $context: Promise.resolve({ authCookies: { sessionToken: { name: "account" } } }),
        handler: authHandler,
      } as never,
      authenticator: {} as never,
      connectLifecycle: {} as never,
      hostedOAuthBroker: { inspectLaunch } as never,
      portalOrigin: new URL("https://managed.opensteer.test"),
      publicOrigin,
      store: {} as never,
    });
    servers.push(server);
    const payload = new URLSearchParams({ return_to: launchPath, switch_account: "1" }).toString();
    const post = (origin: string) =>
      server.inject({
        method: "POST",
        url: "/sign-in/google",
        payload,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: "account=old-session",
          origin,
        },
      });
    expect((await post("https://attacker.test")).statusCode).toBe(403);
    expect(authHandler).not.toHaveBeenCalled();
    const response = await post(publicOrigin.origin);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://google.test/chooser");
    expect(response.headers["set-cookie"]).toEqual([
      "account=; Max-Age=0; Path=/",
      "state=synthetic; Path=/",
    ]);
    const [signOut, signIn] = authHandler.mock.calls.map((call) => call[0]);
    expect(new URL(signOut!.url).pathname).toBe("/api/auth/sign-out");
    expect(signOut!.headers.get("cookie")).toBe("account=old-session");
    expect(signIn!.headers.has("cookie")).toBe(false);
    expect(await signIn!.json()).toEqual({
      provider: "google",
      callbackURL: `${publicOrigin.origin}${launchPath}`,
      additionalParams: { prompt: "select_account" },
    });
    expect(inspectLaunch).toHaveBeenCalledWith(attemptId, launchTicket);
    inspectLaunch.mockResolvedValueOnce({ status: "expired" });
    expect((await post(publicOrigin.origin)).statusCode).toBe(400);
    expect(authHandler).toHaveBeenCalledTimes(2);
  });

  it("returns to the exact broker launch after Account sign-in", async () => {
    const authHandler = vi.fn(async (_request: Request) =>
      Response.json({ url: "https://google.test/account-sign-in" }),
    );
    const server = await createControlPlaneServer({
      auth: {
        $context: Promise.resolve({
          authCookies: { sessionToken: { name: "__Host-opensteer.account" } },
        }),
        handler: authHandler,
      } as never,
      authenticator: {} as never,
      connectLifecycle: {} as never,
      portalOrigin: new URL("https://managed.opensteer.test"),
      publicOrigin,
      store: {} as never,
    });
    servers.push(server);
    const signInPath = `/sign-in?return_to=${encodeURIComponent(launchPath)}`;

    const page = await server.inject({ method: "GET", url: signInPath });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="return_to"');
    expect(page.body).not.toContain('name="oauth_query"');
    expect(page.body).toContain("Account linked to that Opensteer");
    expect(page.body).not.toContain("loginHint");

    const response = await server.inject({
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: publicOrigin.origin,
      },
      method: "POST",
      payload: new URLSearchParams({ return_to: launchPath }).toString(),
      url: "/sign-in/google",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://google.test/account-sign-in");
    const authRequest = authHandler.mock.calls.at(-1)?.[0];
    expect(authRequest).toBeInstanceOf(Request);
    expect(new URL((authRequest as Request).url).pathname).toBe("/api/auth/sign-in/social");
    expect(await (authRequest as Request).json()).toEqual({
      callbackURL: `${publicOrigin.origin}${launchPath}`,
      provider: "google",
    });
  });
});

describe("hosted OAuth provider callback", () => {
  const servers: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("passes the complete extensible Google response to the broker", async () => {
    const completeAuthorization = vi.fn(async (_input: unknown) => ({
      attemptId,
      status: "sealed" as const,
    }));
    const server = Fastify();
    servers.push(server);
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      broker: { completeAuthorization } as never,
      store: {} as never,
    });
    const query = new URLSearchParams({
      authuser: "0",
      code: "authorization-code",
      future_google_parameter: "future-value",
      iss: "https://accounts.google.com",
      prompt: "consent",
      scope: "openid email",
      state: "S".repeat(43),
    });

    const response = await server.inject({
      method: "GET",
      url: `/v1/oauth-broker/callback/google?${query.toString()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("You’re signed in");
    expect(response.body).not.toContain("Connection ready");
    const parameters = (
      completeAuthorization.mock.calls[0]![0] as {
        parameters: URLSearchParams;
      }
    ).parameters;
    expect(Object.fromEntries(parameters)).toMatchObject({
      authuser: "0",
      code: "authorization-code",
      future_google_parameter: "future-value",
      iss: "https://accounts.google.com",
      scope: "openid email",
      state: "S".repeat(43),
    });
  });

  it.each(["held", "denied", "failed"] as const)(
    "offers desktop app return for %s without releasing a redirect",
    async (status) => {
      const appReturn = `com.opensteer.opensteer:/oauth/integration-callback?deployment_id=dep_test&attempt_id=ioa_test${status === "held" ? `&return=${"P".repeat(43)}` : ""}`;
      const server = Fastify();
      servers.push(server);
      const log = vi.fn();
      server.addHook("onRequest", async (request) => {
        request.log.warn = log;
      });
      registerHostedOAuthBrokerRoutes(server, {
        authenticator: {} as never,
        store: {} as never,
        broker: {
          completeAuthorization: vi.fn(async () => ({
            attemptId,
            status,
            returnKind: "open-app",
            returnUrl: appReturn,
          })),
        } as never,
      });
      const response = await server.inject({
        method: "GET",
        url: "/v1/oauth-broker/callback/google?code=secret-code",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["content-security-policy"]).not.toContain("sandbox");
      expect(response.headers["content-security-policy"]).not.toContain("navigate-to");
      expect(response.body).toContain('http-equiv="refresh"');
      expect(response.body).toContain('class="btn btn--primary"');
      expect(response.body).toContain("Open Opensteer");
      expect(response.body).toContain(
        status === "held"
          ? "Finishing in Opensteer"
          : status === "denied"
            ? "Sign-in was declined"
            : "Sign-in didn’t finish",
      );
      if (status !== "held") expect(response.body).not.toContain("return=");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-code");
      expect(JSON.stringify(log.mock.calls)).not.toContain("P".repeat(43));
    },
  );

  it("redirects the native auth session to its app return with a 303", async () => {
    const server = Fastify();
    servers.push(server);
    const returnUrl = `com.opensteer.mobile:/oauth/integration-callback?return=${"P".repeat(43)}`;
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      store: {} as never,
      broker: {
        completeAuthorization: vi.fn(async () => ({ attemptId, status: "held", returnUrl })),
      } as never,
    });
    const response = await server.inject({
      method: "GET",
      url: "/v1/oauth-broker/callback/google",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(returnUrl);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("logs only the callback refusal code and correlated attempt", async () => {
    const server = Fastify();
    servers.push(server);
    const log = vi.fn();
    server.addHook("onRequest", async (request) => {
      request.log.warn = log;
    });
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      store: {} as never,
      broker: {
        completeAuthorization: vi.fn(async () => {
          throw new HostedOAuthBrokerRefusal(attemptId, "callback-claim-refused");
        }),
      } as never,
    });
    await server.inject({
      method: "GET",
      url: `/v1/oauth-broker/callback/google?code=secret-code&state=${"S".repeat(43)}`,
      headers: { cookie: "binding=secret-cookie" },
    });
    expect(log.mock.calls).toEqual([
      [
        { attemptId, reason: "callback-claim-refused" },
        "Hosted OAuth authorization callback was rejected",
      ],
    ]);
  });

  it("renders a safe failure page when the broker rejects the callback", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      broker: {
        completeAuthorization: vi.fn(async () => {
          throw new Error("provider response contained a secret marker");
        }),
      } as never,
      store: {} as never,
    });

    const response = await server.inject({
      method: "GET",
      url: `/v1/oauth-broker/callback/google?code=secret-code&state=${"S".repeat(43)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Sign-in didn’t finish");
    expect(response.body).not.toContain("secret-code");
    expect(response.body).not.toContain("secret marker");
  });
});

describe("hosted OAuth app return", () => {
  it("requires Host credentials and matching path/body, and logs no proof", async () => {
    const log = vi.fn();
    const authority = { deploymentId: "dep_synthetic" };
    const authenticateHostCredential = vi.fn(async () => authority);
    const returnAttempt = vi.fn(async () => ({ attemptId, status: "sealed" }));
    const server = Fastify({ disableRequestLogging: true });
    server.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof ControlPlaneError ? error.status : 400)
        .send({ error: "refused" }),
    );
    registerHostedOAuthBrokerRoutes(server, {
      authenticator: {} as never,
      broker: { returnAttempt } as never,
      store: { authenticateHostCredential } as never,
    });
    try {
      server.addHook("onRequest", async (request) => {
        request.log.warn = log;
      });
      const proof = "P".repeat(43);
      const send = (bodyAttempt = attemptId) =>
        server.inject({
          method: "POST",
          url: `/v1/host/oauth-broker/attempts/${attemptId}/return`,
          headers: { authorization: "Bearer osc_synthetic" },
          payload: { attemptId: bodyAttempt, returnProof: proof },
        });
      expect((await send()).json()).toEqual({ attemptId, status: "sealed" });
      expect(returnAttempt).toHaveBeenCalledWith(authority, attemptId, proof);
      expect(authenticateHostCredential).toHaveBeenCalledWith("Bearer osc_synthetic");
      expect(
        (await send(HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`))).statusCode,
      ).toBe(400);
      returnAttempt.mockRejectedValueOnce(
        new HostedOAuthBrokerRefusal(attemptId, "return-proof-mismatch"),
      );
      expect((await send()).statusCode).toBe(403);
      expect(log.mock.calls.at(-1)).toEqual([
        { attemptId, reason: "return-proof-mismatch" },
        "Hosted OAuth return refused",
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(proof);
      expect(JSON.stringify(log.mock.calls)).not.toContain("osc_synthetic");
      authenticateHostCredential.mockRejectedValueOnce(
        new ControlPlaneError("unauthorized", "Host credential required"),
      );
      expect((await send()).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("hostedOAuthLaunchReturnTo", () => {
  it("accepts only a same-origin one-time broker launch", () => {
    expect(hostedOAuthLaunchReturnTo(launchPath, publicOrigin)?.toString()).toBe(
      `${publicOrigin.origin}${launchPath}`,
    );
    expect(
      hostedOAuthLaunchReturnTo(`${publicOrigin.origin}${launchPath}`, publicOrigin)?.toString(),
    ).toBe(`${publicOrigin.origin}${launchPath}`);
  });

  it.each([
    `https://attacker.test/v1/oauth-broker/launch/hoa_00000000-0000-4000-8000-000000000001?ticket=${launchTicket}`,
    `/v1/oauth-broker/launch/not-an-attempt?ticket=${launchTicket}`,
    `/v1/oauth-broker/launch/${attemptId}`,
    `/v1/oauth-broker/launch/${attemptId}?ticket=${launchTicket}&ticket=${launchTicket}`,
    `/v1/oauth-broker/launch/${attemptId}?ticket=${launchTicket}&next=https://attacker.test`,
    `/v1/oauth-broker/launch/${attemptId}?ticket=${launchTicket}#fragment`,
    "/",
  ])("rejects an unsafe sign-in return: %s", (value) => {
    expect(() => hostedOAuthLaunchReturnTo(value, publicOrigin)).toThrow();
  });
});
