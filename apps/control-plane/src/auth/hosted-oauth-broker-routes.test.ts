import {
  ControlPlaneAccountIdSchema,
  HostedOAuthAttemptIdSchema,
} from "@opensteer/control-plane-protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      broker: { launchAuthorization } as never,
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
      broker: { launchAuthorization } as never,
      store: {} as never,
    });

    const response = await server.inject({ method: "GET", url: launchPath });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("https://provider.test/authorize");
    expect(launchAuthorization).toHaveBeenCalledWith(accountId, attemptId, launchTicket);
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
      managedDeploymentDomain: "managed.opensteer.test",
      publicOrigin,
      store: {} as never,
    });
    servers.push(server);
    const signInPath = `/sign-in?return_to=${encodeURIComponent(launchPath)}`;

    const page = await server.inject({ method: "GET", url: signInPath });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="return_to"');
    expect(page.body).not.toContain('name="oauth_query"');

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
    expect(response.body).toContain("Authorization received");
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
    expect(response.body).toContain("Authorization not completed");
    expect(response.body).not.toContain("secret-code");
    expect(response.body).not.toContain("secret marker");
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
