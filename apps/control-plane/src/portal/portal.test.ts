import { runInNewContext } from "node:vm";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  AccountDeploymentDirectoryEntrySchema,
  AccountDeploymentSchema,
  type AccountDeployment,
  type AccountDeploymentDirectoryEntry,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createPortalRouter,
  portalCallbackUri,
  deploymentCard,
  portalPersonalConnectPath,
  portalRemoveDeploymentPath,
} from "./portal.js";

describe("public portal routes", () => {
  it("guards routes, renders safe links, and validates fragments against DeploymentId", async () => {
    const router = createPortalRouter({
      accountDeletion: {} as never,
      portalOrigin: new URL("https://portal.test"),
      publicOrigin: new URL("https://accounts.test"),
      auth: {} as never,
      store: {} as never,
      portalSessions: { read: vi.fn() } as never,
      desktopDownloadUrl: "https://download.test/app",
      iosAppUrl: "https://store.test/?a=1&b=2",
      androidAppUrl: 'https://android.test/?q="hello"',
    });
    const app = Fastify();
    router.register(app);
    app.get("/", (request, reply) => router.home(request, reply));
    for (const url of ["/open", "/mac"]) {
      expect((await app.inject({ url, headers: { host: "other.test" } })).statusCode).toBe(404);
    }
    const headers = { host: "portal.test" };
    const page = await app.inject({ url: "/open?d=server-content", headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.body).not.toContain("server-content");
    expect(page.body).toContain("https://store.test/?a=1&amp;b=2");
    expect(page.body).toContain("&quot;hello&quot;");
    const script = page.body.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/u);
    expect(script).not.toBeNull();
    expect(page.headers["content-security-policy"]).toContain(`script-src 'nonce-${script![1]}'`);
    expect(page.headers["content-security-policy"]).not.toContain("script-src 'unsafe-inline'");
    for (const fragment of [
      `#d=${createId("deployment")}`,
      "",
      "#d=dep_invalid",
      `#d=${createId("deployment")}&x=1`,
      "#d=DEP_00000000-0000-4000-8000-000000000001",
      "#d=dep_00000000-0000-0000-8000-000000000001",
    ]) {
      const button = { href: "", hidden: true };
      const incomplete = { hidden: true };
      const location = { hash: fragment, href: "" };
      runInNewContext(script![2]!, {
        location,
        document: { getElementById: (id: string) => (id === "open-app" ? button : incomplete) },
      });
      const valid =
        fragment.startsWith("#d=") && DeploymentIdSchema.safeParse(fragment.slice(3)).success;
      expect(button.hidden).toBe(!valid);
      expect(incomplete.hidden).toBe(valid);
      expect(location.href).toBe(valid ? `com.opensteer.mobile:/open?d=${fragment.slice(3)}` : "");
    }
    expect((await app.inject({ url: "/mac", headers })).headers.location).toBe(
      "https://download.test/app",
    );
    const home = await app.inject({ url: "/", headers });
    expect(home.body).toContain("Get the desktop app");
    expect(home.headers["content-security-policy"]).not.toContain("script-src");
    await app.close();

    const bare = Fastify();
    createPortalRouter({
      accountDeletion: {} as never,
      portalOrigin: new URL("https://portal.test"),
      publicOrigin: new URL("https://accounts.test"),
      auth: {} as never,
      store: {} as never,
      portalSessions: {} as never,
    }).register(bare);
    const noStores = await bare.inject({ url: "/open", headers });
    expect(noStores.body).not.toContain("Get it for iPhone");
    expect(noStores.body).not.toContain("Get it for Android");
    expect((await bare.inject({ url: "/mac", headers })).headers.location).toBe("/");
    await bare.close();
  });
});

describe("portal vhost identity", () => {
  it("uses the explicit portal callback origin", () => {
    expect(portalCallbackUri(new URL("https://app.opensteer.com"))).toBe(
      "https://app.opensteer.com/auth/callback",
    );
  });
  it("accepts only the configured portal host and guards portal routes", async () => {
    const router = createPortalRouter({
      accountDeletion: {} as never,
      portalOrigin: new URL("https://app.opensteer.com"),
      publicOrigin: new URL("https://accounts.opensteer.com"),
      portalSessions: { read: vi.fn() } as never,
      store: {} as never,
      auth: {} as never,
    });
    const app = Fastify();
    router.register(app);
    for (const host of [
      "accounts.opensteer.com",
      "app.opensteer.com.evil.test",
      "evilapp.opensteer.com",
      "other.opensteer.com",
    ]) {
      const response = await app.inject({ url: "/auth/sign-in", headers: { host } });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Route was not found");
    }
    const response = await app.inject({
      url: "/auth/sign-in",
      headers: { host: "app.opensteer.com" },
    });
    expect(response.statusCode).toBe(302);
    await app.close();
  });
});

describe("portal Deployment cards", () => {
  it("links self-hosted Deployments to their canonical origins and reports status honestly", () => {
    const deployment = selfHostedDeployment();
    expect(deploymentCard(directoryDeployment(deployment), true)).toContain(
      'href="https://server.opensteer.test"',
    );
    // The owner made this row and unmakes it where it runs; a hide is a member's move.
    expect(deploymentCard(directoryDeployment(deployment), true)).not.toContain("from your list");
    const shared = directoryDeployment({ ...deployment, access: "member" });
    expect(deploymentCard(shared, true)).toContain(
      `action="${portalRemoveDeploymentPath(deployment.id)}"`,
    );
    expect(deploymentCard(shared, true)).toContain("from your list");
    for (const present of [true, false]) {
      const card = deploymentCard(directoryDeployment(deployment), present);
      expect(card).not.toContain('class="dot');
      expect(card).not.toContain('class="place__note');
      expect(card).toContain('class="place__go');
    }
    expect(deploymentCard(directoryDeployment(deployment), false)).toContain(
      'href="https://server.opensteer.test"',
    );
  });

  it("keeps removed member access unavailable even without a Host health observation", () => {
    const deployment = directoryDeployment({ ...selfHostedDeployment(), access: "member" });
    const card = deploymentCard(deployment, false);
    expect(card).toContain("Offline");
    expect(card).toContain("You no longer have access to this deployment.");
    expect(card).not.toContain('href="https://server.opensteer.test"');
    expect(card).not.toContain('class="place__go');
  });

  it("mints the browser grant only after the portal card is posted", async () => {
    const deployment = personalDeployment("ready");
    const issueSessionGrant = vi.fn(async () => ({
      expiresAt: "2026-08-21T12:02:00.000Z",
      grant: `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`,
    }));
    const removeDeploymentFromDirectory = vi.fn(async () => undefined);
    const accountId = deployment.reachability === "routed" ? deployment.accountLink.subject : null;
    if (!accountId) throw new Error("Personal fixture is not linked");
    const router = createPortalRouter({
      accountDeletion: {} as never,
      auth: {} as never,
      portalOrigin: new URL("https://portal.test"),
      personalRemoteAccount: { issueSessionGrant } as never,
      portalSessions: {
        read: async () => ({
          accountId,
          accountSessionId: "session-1",
          displayName: "Portal Owner",
          email: "owner@example.test",
          expiresAt: new Date("2099-08-21T12:00:00.000Z"),
        }),
      } as never,
      publicOrigin: new URL("https://accounts.portal.test"),
      store: {
        deploymentForAccount: async () => deployment,
        isDeploymentPresentForAccount: async () => true,
        listDeployments: async () => [directoryDeployment(deployment)],
        removeDeploymentFromDirectory,
      } as never,
    });
    const app = Fastify();
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    router.register(app);
    app.get("/", (request, reply) => router.home(request, reply));
    const headers = { cookie: "__Host-opensteer.portal=fixture", host: "portal.test" };

    const directory = await app.inject({ headers, method: "GET", url: "/" });
    expect(directory.statusCode).toBe(200);
    expect(directory.body).toContain(portalPersonalConnectPath(deployment.id));
    expect(issueSessionGrant).not.toHaveBeenCalled();

    const handoff = await app.inject({
      headers: { ...headers, origin: "https://portal.test" },
      method: "POST",
      url: portalPersonalConnectPath(deployment.id),
    });
    expect(handoff.statusCode, handoff.body).toBe(200);
    expect(issueSessionGrant).toHaveBeenCalledOnce();
    expect(issueSessionGrant).toHaveBeenCalledWith(
      accountId,
      deployment.id,
      expect.objectContaining({
        clientSurface: "browser",
        portalOrigin: "https://portal.test",
        targetKind: "personal-connect",
      }),
    );
    expect(handoff.headers["cache-control"]).toBe("no-store");
    expect(handoff.headers["referrer-policy"]).toBe("no-referrer");
    expect(handoff.body).toContain('method="post"');
    expect(handoff.body).toContain('name="grant"');
    expect(handoff.body).not.toContain("?grant=");

    const removed = await app.inject({
      headers: { ...headers, origin: "https://portal.test" },
      method: "POST",
      url: portalRemoveDeploymentPath(deployment.id),
    });
    expect(removed.statusCode).toBe(303);
    expect(removed.headers.location).toBe("/");
    expect(removeDeploymentFromDirectory).toHaveBeenCalledWith(accountId, deployment.id);
    await app.close();
  });

  it("renders a ready Personal Host as a portal POST without exposing its route", () => {
    const deployment = personalDeployment("ready");
    const card = deploymentCard(directoryDeployment(deployment), true);
    expect(card).toContain('method="post"');
    expect(card).toContain(`action="${portalPersonalConnectPath(deployment.id)}"`);
    expect(card).toContain("Ready");
    expect(card).not.toContain("connect-home.opensteer.test");
    expect(card).not.toContain("127.0.0.1");
  });

  it("renders obsolete signed authority as an explicit non-actionable compatibility problem", () => {
    const deployment = directoryDeployment(selfHostedDeployment());
    const obsolete = AccountDeploymentDirectoryEntrySchema.parse({
      ...deployment,
      authorityEnvelope: { documentVersion: 0 },
    });
    const card = deploymentCard(obsolete, true);
    expect(card).toContain("Needs attention");
    expect(card).toContain(
      "Update Opensteer to use this deployment’s published connection details.",
    );
    expect(card).not.toContain("href=");
    expect(card).not.toContain("place__go");
  });

  it("does not trust routed liveness carried by an invalid route envelope", () => {
    const deployment = directoryDeployment(personalDeployment("ready"));
    const malformed = AccountDeploymentDirectoryEntrySchema.parse({
      ...deployment,
      connectRoute: { schemaVersion: 999 },
    });
    const card = deploymentCard(malformed, true);
    expect(card).toContain("Needs attention");
    expect(card).not.toContain("Ready");
    expect(card).not.toContain(portalPersonalConnectPath(deployment.id));
  });
});

function selfHostedDeployment(
  deploymentId: ReturnType<typeof createId> = createId("deployment"),
): AccountDeployment {
  return AccountDeploymentSchema.parse({
    access: "owner",
    authorityEnvelope: authorityEnvelope(deploymentId, "self-hosted"),
    canonicalOrigin: "https://server.opensteer.test",
    generation: 1,
    id: deploymentId,
    lifecycle: "active",
    name: "Primary Server",
    reachability: "canonical",
    updatedAt: "2026-08-21T12:00:00.000Z",
  });
}

function personalDeployment(state: "ready" | "offline" | "off"): AccountDeployment {
  const deploymentId = createId("deployment");
  const authority = authorityEnvelope(deploymentId, "personal");
  const route = {
    document: {
      authority: authority.document,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: {
        generation: 4,
        kind: "connect",
        origin: "https://connect-home.opensteer.test",
      },
    },
    publicKey: authority.publicKey,
    schemaVersion: 1,
    signature: "A".repeat(86),
  };
  return AccountDeploymentSchema.parse({
    access: "owner",
    accountLink: {
      generation: "g".repeat(43),
      issuer: "https://account.opensteer.test",
      subject: `acct_${crypto.randomUUID()}`,
    },
    authorityEnvelope: authority,
    connectResourceState: state === "off" ? "disabled" : "ready",
    connectRoute: state === "off" ? null : route,
    generation: 1,
    id: deploymentId,
    lastSeenAt:
      state === "off"
        ? null
        : {
            expiresAt: state === "ready" ? "2099-08-21T12:05:00.000Z" : "2020-08-21T12:05:00.000Z",
            observedAt: state === "ready" ? "2099-08-21T12:00:00.000Z" : "2020-08-21T12:00:00.000Z",
          },
    lifecycle: "active",
    name: "Home Mac",
    reachability: "routed",
    updatedAt: "2026-08-21T12:00:00.000Z",
  });
}

function authorityEnvelope(
  deploymentId: ReturnType<typeof createId>,
  kind: "personal" | "self-hosted",
) {
  return {
    document: {
      canonicalOrigin:
        kind === "self-hosted" ? "https://server.opensteer.test" : "http://127.0.0.1:4310",
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: kind === "self-hosted" ? { kind: "team" } : { kind: "personal" },
    },
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    signature: "A".repeat(86),
  } as const;
}

function directoryDeployment(deployment: AccountDeployment): AccountDeploymentDirectoryEntry {
  const authority = deployment.authorityEnvelope.document;
  return AccountDeploymentDirectoryEntrySchema.parse({
    ...deployment,
    authority: {
      canonicalOrigin: authority.canonicalOrigin,
      deploymentId: authority.deploymentId,
      hostInstanceId: authority.hostInstanceId,
      hostKeyFingerprint: hostKeyFingerprint(deployment.authorityEnvelope.publicKey.spki),
    },
  });
}
