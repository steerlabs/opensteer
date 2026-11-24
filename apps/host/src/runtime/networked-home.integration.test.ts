import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseHostConfig, type HostConfig } from "@opensteer/config";
import { PersonalHostAccountLinkProofEnvelopeSchema } from "@opensteer/control-plane-protocol";
import {
  createId,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import {
  HostDescriptorSchema,
  apiVersionHeaders,
  verifyHostIdentityProof,
} from "@opensteer/deployment-authority";
import {
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runEventsCapability,
  runnerIntegrationsProtocolVersion,
} from "@opensteer/protocol";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { closed, connectPrimary } from "./private-machine-host.test-support.js";
import { requireDeviceAccess } from "../administration/device-access.js";
import { createHostRuntime, type PersonalHostRuntime } from "./runtime.js";

const home = "https://home.example.test";
const setupCode = randomBytes(32).toString("base64url");
const mainToken = randomBytes(32).toString("base64url");
const password = "correct horse battery staple";
const accountIssuer = "https://accounts.opensteer.test";

function homeConfig(input: {
  readonly databaseUrl: string;
  readonly directory: string;
  readonly port: number;
  readonly environmentId: string;
  readonly mainToken: string;
}): HostConfig {
  return parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: input.databaseUrl,
    OPENSTEER_AUTH_SECRET: "networked-home-auth-secret".padEnd(48, "s"),
    OPENSTEER_HOST_DATA_DIR: join(input.directory, "host"),
    OPENSTEER_PORT: String(input.port),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: home,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: input.environmentId,
    OPENSTEER_AGENT_HOME: join(input.directory, "agent-home"),
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
    OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: input.mainToken,
    OPENSTEER_PERSONAL_ACCOUNT_ISSUER: accountIssuer,
  });
}

/** What the reverse proxy on the Home's own loopback interface forwards. */
const throughProxy = {
  host: "home.example.test",
  origin: home,
  "x-forwarded-proto": "https",
  "x-forwarded-for": "203.0.113.20",
  ...apiVersionHeaders(),
};

function cookies(response: { readonly cookies: readonly { name: string; value: string }[] }) {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function rpc(
  host: PersonalHostRuntime,
  name: string,
  payload: object,
  cookie = "",
): Promise<Awaited<ReturnType<PersonalHostRuntime["app"]["inject"]>>> {
  return host.app.inject({
    method: "POST",
    url: `/v1/rpc/${name}`,
    headers: { ...throughProxy, ...(cookie ? { cookie } : {}) },
    payload,
  });
}

function mainDescriptor(environmentId: string) {
  return RunnerDescriptorSchema.parse({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    capabilities: [runEventsCapability],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],
        maxConcurrentRuns: 1,
      },
    },
    name: "Hosting computer",
    runnerId: createId("runner"),
    runnerKind: "main",
    runtimeVersion: "integration",
  });
}

it("boots unclaimed, is claimed once through its setup link, and enrolls its computers", async () => {
  const database = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-networked-home-"));
  const environmentId = createId("environment");
  const port = await freePort();
  const configFor = (token: string) =>
    homeConfig({ databaseUrl: database.url, directory, port, environmentId, mainToken: token });
  const start = async (config: HostConfig) => {
    let closing: Promise<void> | undefined;
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await createHostRuntime(config);
      if (runtime.kind !== "personal") throw new Error("Expected a Personal Home");
      return { runtime, close: () => (closing ??= runtime.close()) };
    });
    await owned.runtime.listen();
    return { host: owned.runtime, close: owned.close };
  };
  let current: Awaited<ReturnType<typeof start>> | undefined;
  const sockets: import("ws").WebSocket[] = [];
  try {
    current = await start(configFor(mainToken));
    let host = current.host;

    const descriptor = await host.app.inject({ method: "GET", url: "/.well-known/opensteer" });
    expect(descriptor.json()).toMatchObject({
      kind: "personal",
      authority: { document: { canonicalOrigin: home, deploymentShape: { kind: "personal" } } },
      bootstrapMethods: ["password"],
    });
    expect(descriptor.json<{ capabilities: string[] }>().capabilities).toContain("native-oauth");
    // A client that saved this Home asks it to sign a fresh nonce before trusting the address.
    const nonce = randomBytes(32).toString("base64url");
    const proven = HostDescriptorSchema.parse(
      (
        await host.app.inject({ method: "GET", url: `/.well-known/opensteer?proof=${nonce}` })
      ).json(),
    );
    expect(proven.identityProof?.nonce).toBe(nonce);
    expect(
      verifyHostIdentityProof({
        saved: proven.authority,
        nonce,
        signature: proven.identityProof!.signature,
      }),
    ).toBe(true);
    expect(
      verifyHostIdentityProof({
        saved: proven.authority,
        nonce: randomBytes(32).toString("base64url"),
        signature: proven.identityProof!.signature,
      }),
    ).toBe(false);
    expect(descriptor.json<{ capabilities: string[] }>().capabilities).not.toContain(
      "personal-session-header",
    );
    expect(
      (await host.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" }))
        .statusCode,
    ).toBe(200);

    const config = await host.app.inject({
      method: "GET",
      url: "/v1/rpc/auth.config?input=%7B%7D",
      headers: throughProxy,
    });
    expect(config.json()).toMatchObject({
      data: {
        exposure: "networked",
        localPasswordEnabled: true,
        machineOwner: false,
        publicOrigin: home,
        setupState: "required",
      },
    });

    // A bring-your-own Home has no Account-bound claim.
    expect(
      (
        await host.app.inject({
          method: "POST",
          url: "/v1/managed-home/claim",
          headers: throughProxy,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);

    // Nothing of the desktop's same-machine supervision answers on a networked Home.
    for (const url of ["/v1/local-bootstrap", "/v1/personal-remote-access"])
      expect(
        (
          await host.app.inject({
            method: "GET",
            url,
            headers: { ...throughProxy, authorization: `Bearer ${setupCode}` },
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (await rpc(host, "auth.setup.claim", { kind: "local-machine-owner", token: setupCode }))
        .statusCode,
    ).toBe(404);

    expect(
      (await rpc(host, "auth.setup.exchange", { token: randomBytes(32).toString("base64url") }))
        .statusCode,
    ).toBe(403);

    // An expired setup code admits nobody.
    const enrollment = await host.store.database
      .selectFrom("ownerEnrollments")
      .select(["id", "expiresAt"])
      .where("kind", "=", "initial")
      .executeTakeFirstOrThrow();
    await host.store.database
      .updateTable("ownerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", enrollment.id)
      .execute();
    expect((await rpc(host, "auth.setup.exchange", { token: setupCode })).statusCode).toBe(403);
    await host.store.database
      .updateTable("ownerEnrollments")
      .set({ expiresAt: enrollment.expiresAt })
      .where("id", "=", enrollment.id)
      .execute();

    // The setup admission is no sign-up: it creates nobody outside the claim.
    const admitted = await rpc(host, "auth.setup.exchange", { token: setupCode });
    expect(
      (
        await rpc(
          host,
          "auth.password.signUp",
          { email: "side-door@example.test", password },
          cookies(admitted),
        )
      ).statusCode,
    ).toBe(404);
    expect(await host.store.database.selectFrom("users").select("id").execute()).toEqual([]);

    // Two browsers open the link; three claims race. Exactly one becomes the owner.
    const first = await rpc(host, "auth.setup.exchange", { token: setupCode });
    expect(first.statusCode).toBe(200);
    const second = await rpc(host, "auth.setup.exchange", { token: setupCode });
    expect(second.statusCode).toBe(200);
    const claims = await Promise.all(
      [
        [cookies(first), "first@example.test"],
        [cookies(second), "second@example.test"],
        [cookies(second), "third@example.test"],
      ].map(([cookie, email]) =>
        rpc(host, "auth.setup.claim", { email, kind: "password", password }, cookie),
      ),
    );
    const winners = claims.filter((claim) => claim.statusCode === 200);
    expect(winners).toHaveLength(1);
    for (const loser of claims.filter((claim) => claim.statusCode !== 200))
      expect([403, 409]).toContain(loser.statusCode);
    const users = await host.store.database.selectFrom("users").select(["id", "email"]).execute();
    expect(users).toHaveLength(1);
    const owner = users[0]!;
    const winnerIndex = claims.indexOf(winners[0]!);
    const winnerCookie = winnerIndex === 0 ? cookies(first) : cookies(second);

    // The same completion again answers the first result rather than a second owner.
    const replay = await rpc(
      host,
      "auth.setup.claim",
      { email: owner.email, kind: "password", password },
      winnerCookie,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { session: { user: { id: owner.id } } } });

    // A spent link admits nobody, and the Home reports itself claimed.
    expect((await rpc(host, "auth.setup.exchange", { token: setupCode })).statusCode).toBe(403);
    const claimed = await host.app.inject({
      method: "GET",
      url: "/v1/rpc/auth.config?input=%7B%7D",
      headers: throughProxy,
    });
    // The Home says what it is: on its own server, not a Mac and not a Cloud Computer.
    expect(claimed.json()).toMatchObject({ data: { homeKind: "server", setupState: "complete" } });

    // The sign-in library keys its limits on the address the proxy vetted:
    // never on what the client wrote into forwarding or internal headers.
    await host.store.database.deleteFrom("authRateLimits").execute();
    const spoofed = await host.app.inject({
      method: "POST",
      url: "/v1/rpc/auth.password.signIn",
      headers: {
        ...throughProxy,
        "x-forwarded-for": "198.51.100.66, 203.0.113.21",
        "x-opensteer-client-address": "198.51.100.77",
      },
      payload: { email: owner.email, password: "not-the-owner-password" },
    });
    expect(spoofed.statusCode).not.toBe(200);
    const limited = await host.store.database.selectFrom("authRateLimits").select("key").execute();
    expect(limited.map(({ key }) => key.split("|")[0])).toEqual(["203.0.113.21"]);

    const signedIn = await rpc(host, "auth.password.signIn", { email: owner.email, password });
    expect(signedIn.statusCode).toBe(200);
    const ownerCookie = cookies(signedIn);
    const session = await host.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { ...throughProxy, cookie: ownerCookie },
    });
    expect(session.json()).toMatchObject({ session: { user: { id: owner.id } } });

    // Apps never open on the signed-in Home origin.
    const app = await rpc(
      host,
      "apps.view",
      { appId: `app_${randomUUID()}`, theme: "light" },
      ownerCookie,
    );
    expect(app.statusCode).toBe(409);
    expect(app.json()).toMatchObject({ error: { reason: "app-address-unavailable" } });

    // The hosting Runner enrolls with the operator's token, once.
    const main = await connectPrimary(port, mainDescriptor(environmentId), { token: mainToken });
    sockets.push(main.socket);
    await expect(
      connectPrimary(port, mainDescriptor(environmentId), { token: mainToken }),
    ).rejects.toThrow(/socket closed/u);
    const mains = await host.store.database
      .selectFrom("runners")
      .select("id")
      .where("kind", "=", "main")
      .execute();
    expect(mains).toEqual([{ id: main.fence.runnerId }]);
    // An asleep refusal names the Device, in its detail, by its display name.
    const mainDevice = await host.store.requireSelfDeviceId(main.fence.runnerId);
    const mainName = (
      await host.store.database
        .selectFrom("devices")
        .select("name")
        .where("id", "=", mainDevice)
        .executeTakeFirstOrThrow()
    ).name;
    await expect(
      requireDeviceAccess(host.store.database, mainDevice, "browser", false, { asleep: true }),
    ).rejects.toMatchObject({
      reason: "device-asleep",
      details: { machineId: mainDevice, capability: "browser", machineName: mainName },
    });

    // Another computer joins through the ordinary add-a-computer flow at the canonical origin.
    const issued = await rpc(
      host,
      "commands.dispatch",
      {
        allowedModules: ["integrations"],
        idempotencyKey: randomUUID(),
        name: "Laptop",
        type: "runner.enrollment.createLocal",
      },
      ownerCookie,
    );
    expect(issued.statusCode).toBe(200);
    const laptop = await connectPrimary(
      port,
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: {
          integrations: {
            platform: "darwin",
            protocolVersion: runnerIntegrationsProtocolVersion,
            screenDrivers: 1,
          },
        },
        device: { platform: "macos", form: "desktop", app: "opensteer" },
        name: "Laptop",
        runnerId: createId("runner"),
        runnerKind: "local",
        runtimeVersion: "integration",
      }),
      { token: issued.json<{ data: { token: string } }>().data.token },
    );
    sockets.push(laptop.socket);
    expect(laptop.fence.runnerId).toBeDefined();

    // The phone signs in as it signs in to a team server: the Home's own native OAuth.
    const viaProxy = { host: "home.example.test", "x-forwarded-proto": "https" };
    const verifier = "home-phone-pkce-verifier-with-at-least-forty-three-characters-0123";
    const authorize = new URL("/v1/auth/native/oauth2/authorize", home);
    authorize.searchParams.set("client_id", opensteerMobileOAuthClientId);
    authorize.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("redirect_uri", opensteerMobileHostOAuthCallback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email offline_access host:access");
    authorize.searchParams.set("state", randomUUID());
    authorize.searchParams.set("resource", home);
    // A system browser states no Opensteer version.
    const prompt = await host.app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`,
      headers: { ...viaProxy, accept: "application/json" },
    });
    expect(prompt.statusCode, prompt.body).toBe(200);
    const phoneSignIn = await rpc(host, "auth.password.signIn", {
      email: owner.email,
      oauthQuery: new URL(prompt.json<{ url: string }>().url, home).search.slice(1),
      password,
    });
    expect(phoneSignIn.statusCode, phoneSignIn.body).toBe(200);
    const consentPage = new URL(
      phoneSignIn.json<{ data: { redirectUrl: string } }>().data.redirectUrl,
    );
    expect(consentPage.origin).toBe(home);
    const consent = await rpc(
      host,
      "auth.native.complete",
      { accept: true, oauthQuery: consentPage.search.slice(1) },
      cookies(phoneSignIn),
    );
    expect(consent.statusCode, consent.body).toBe(200);
    const callback = new URL(consent.json<{ data: { url: string } }>().data.url);
    expect(callback.href.startsWith(opensteerMobileHostOAuthCallback)).toBe(true);
    expect(callback.searchParams.get("state")).toBe(authorize.searchParams.get("state"));
    const token = await host.app.inject({
      method: "POST",
      url: "/v1/auth/native/oauth2/token",
      headers: { ...viaProxy, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: opensteerMobileOAuthClientId,
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: opensteerMobileHostOAuthCallback,
        resource: home,
      }).toString(),
    });
    expect(token.statusCode, token.body).toBe(200);
    const bearer = `Bearer ${token.json<{ access_token: string }>().access_token}`;
    // That bearer speaks the personal Host API, as the phone's transport does.
    const shell = await host.app.inject({
      method: "GET",
      url: "/v1/rpc/personal.shell.get?input=%7B%7D",
      headers: { ...viaProxy, authorization: bearer, ...apiVersionHeaders() },
    });
    expect(shell.statusCode, shell.body).toBe(200);
    // Who is signed in, as the Home's session says it: its owner.
    expect(shell.json()).toMatchObject({ data: { session: { role: "owner" } } });
    const bearerSessions = await host.app.inject({
      method: "GET",
      url: "/v1/rpc/sessions.list?input=%7B%7D",
      headers: { ...viaProxy, authorization: bearer, ...apiVersionHeaders() },
    });
    expect(bearerSessions.json()).toMatchObject({
      data: { sessions: expect.arrayContaining([expect.objectContaining({ current: true })]) },
    });

    // The owner links an Opensteer Account with no Remote access: the Home signs the proof
    // for its own HTTPS authority, which the Account accepts as a canonical Home.
    const challengeId = `phc_${randomUUID()}`;
    const linkProof = await rpc(
      host,
      "commands.dispatch",
      {
        challenge: {
          account: { issuer: accountIssuer, subject: `acct_${randomUUID()}` },
          authorityEnvelope: descriptor.json<{ authority: unknown }>().authority,
          challengeCredential: `olc_${"a".repeat(43)}`,
          challengeId,
          completionFormat: "sealed-v1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        idempotencyKey: randomUUID(),
        type: "personal.accountLink.approve",
      },
      ownerCookie,
    );
    expect(linkProof.statusCode, linkProof.body).toBe(200);
    const signedProof = PersonalHostAccountLinkProofEnvelopeSchema.parse(
      linkProof.json<{ data: { proof: unknown } }>().data.proof,
    );
    expect(signedProof.document.authority.canonicalOrigin).toBe(home);
    expect(signedProof.document.challenge.id).toBe(challengeId);

    // Forwarded headers count only from the proxy on this computer's loopback interface.
    const mcp = "/internal/v1/mcp";
    const fromProxy = await host.app.inject({ method: "POST", url: mcp, headers: throughProxy });
    expect(fromProxy.statusCode).toBe(401);
    expect(fromProxy.headers["www-authenticate"]).toContain(home);
    const fromElsewhere = await host.app.inject({
      method: "POST",
      url: mcp,
      headers: throughProxy,
      remoteAddress: "203.0.113.9",
    });
    expect(fromElsewhere.statusCode).toBe(403);

    // Restarting with the token still configured, or replaced, keeps the enrolled Main.
    for (const socket of sockets.splice(0)) {
      socket.close();
      await closed(socket);
    }
    for (const token of [mainToken, randomBytes(32).toString("base64url")]) {
      await current.close();
      current = await start(configFor(token));
      host = current.host;
      expect((await rpc(host, "auth.setup.exchange", { token: setupCode })).statusCode).toBe(403);
    }
    const reconnected = await connectPrimary(
      port,
      { ...mainDescriptor(environmentId), runnerId: main.fence.runnerId },
      { privateKey: main.privateKey },
    );
    sockets.push(reconnected.socket);
  } finally {
    for (const socket of sockets) {
      socket.close();
      await closed(socket);
    }
    await current?.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses to start an unclaimed Home that has no setup code", async () => {
  const database = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-networked-home-"));
  try {
    const { OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: _code, ...environment } = {
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: database.url,
      OPENSTEER_AUTH_SECRET: "networked-home-auth-secret".padEnd(48, "s"),
      OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
      OPENSTEER_PORT: String(await freePort()),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: home,
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
      OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
    };
    const config = parseHostConfig(environment);
    await expect(
      ownTestDatabaseProducer(database.url, async () => {
        const runtime = await createHostRuntime(config);
        return { close: () => runtime.close() };
      }),
    ).rejects.toMatchObject({ code: "home-setup-code-required" });
  } finally {
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
