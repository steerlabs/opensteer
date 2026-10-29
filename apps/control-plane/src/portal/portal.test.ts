import {
  AccountDeploymentDirectoryEntrySchema,
  AccountDeploymentSchema,
  type AccountDeployment,
  type AccountDeploymentDirectoryEntry,
  type CloudDeploymentOperation,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createPortalRouter,
  cloudDeletePath,
  cloudOperationPath,
  deploymentCard,
  portalHintCookieDomain,
  portalOrigin,
  portalPersonalConnectPath,
  portalRemoveDeploymentPath,
} from "./portal.js";

describe("portal vhost identity", () => {
  it("derives the portal origin from the managed Deployment apex", () => {
    expect(
      portalOrigin(new URL("https://accounts.beta.opensteer.com"), "beta.opensteer.com").origin,
    ).toBe("https://beta.opensteer.com");
    expect(
      portalOrigin(new URL("https://accounts.beta.opensteer.com"), "Beta.Opensteer.com.").origin,
    ).toBe("https://beta.opensteer.com");
    // Loopback development keeps the scheme and the port it is reachable on.
    expect(portalOrigin(new URL("http://localhost:4142"), "localhost").origin).toBe(
      "http://localhost:4142",
    );
  });

  it("offers the presence hint only where the Account host may set it", () => {
    expect(
      portalHintCookieDomain(new URL("https://accounts.beta.opensteer.com"), "beta.opensteer.com"),
    ).toBe("beta.opensteer.com");
    expect(
      portalHintCookieDomain(new URL("https://beta.opensteer.com"), "beta.opensteer.com"),
    ).toBe("beta.opensteer.com");
    // A browser rejects a Domain the Account host does not belong to, so the
    // portal goes without a hint rather than emitting a cookie nobody keeps.
    expect(
      portalHintCookieDomain(new URL("https://accounts.example.test"), "beta.opensteer.com"),
    ).toBeUndefined();
    expect(
      portalHintCookieDomain(new URL("https://evil-beta.opensteer.com"), "beta.opensteer.com"),
    ).toBeUndefined();
  });
});

describe("portal Deployment cards", () => {
  it("links self-hosted Deployments to their canonical origins and reports status honestly", () => {
    const deployment = selfHostedDeployment();
    expect(deploymentCard(directoryDeployment(deployment), true)).toContain(
      'href="https://server.opensteer.test"',
    );
    // The owner made this row and unmakes it where it runs; a hide is a member's move.
    expect(deploymentCard(directoryDeployment(deployment), true)).not.toContain(
      "Remove from Account list",
    );
    const shared = directoryDeployment({ ...deployment, access: "member" });
    expect(deploymentCard(shared, true)).toContain(
      `action="${portalRemoveDeploymentPath(deployment.id)}"`,
    );
    expect(deploymentCard(shared, true)).toContain("Remove from Account list");
    for (const present of [true, false]) {
      const card = deploymentCard(directoryDeployment(deployment), present);
      expect(card).not.toContain('class="chip');
      expect(card).not.toContain('class="deployment-note');
      expect(card).toContain('class="deployment-go');
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
    expect(card).not.toContain('class="deployment-go');
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
      auth: {} as never,
      managedDeploymentDomain: "portal.test",
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
    expect(card).not.toContain("deployment-go");
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

describe("portal Cloud deployment lifecycle", () => {
  it("keeps create idempotency in the rendered form and protects every mutation", async () => {
    const deploymentId = createId("deployment");
    const publishedDeployment = directoryDeployment(selfHostedDeployment(deploymentId));
    const accountId = `acct_${crypto.randomUUID()}`;
    let operation: CloudDeploymentOperation = {
      canonicalOrigin: "https://cloud.portal.test",
      deploymentId,
      desiredState: "present" as const,
      error: null,
      name: "Cloud One",
      operationId: crypto.randomUUID(),
      progress: "Starting Browser, Messaging",
      status: "creating" as const,
      updatedAt: "2026-08-21T12:00:00.000Z",
    };
    const create = vi.fn(async (_accountId, input) => {
      operation = { ...operation, name: input.name, operationId: input.operationId };
      return operation;
    });
    const retry = vi.fn(async () => operation);
    const remove = vi.fn(async () => ({
      ...operation,
      desiredState: "deleted",
      status: "deleting",
    }));
    const router = createPortalRouter({
      auth: {} as never,
      cloudDeployments: {
        available: true,
        create,
        delete: remove,
        list: vi.fn(async () => [operation]),
        get: vi.fn(async () => operation),
        retry,
      } as never,
      managedDeploymentDomain: "portal.test",
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
        isDeploymentPresentForAccount: vi.fn(async () => true),
        listDeployments: async () => [publishedDeployment],
      } as never,
    });
    const app = Fastify();
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof Error && "status" in error ? error.status : null;
      return reply.code(typeof status === "number" ? status : 500).send();
    });
    router.register(app);
    app.get("/", (request, reply) => router.home(request, reply));
    const headers = { cookie: "__Host-opensteer.portal=fixture", host: "portal.test" };

    const home = await app.inject({ headers, method: "GET", url: "/" });
    expect(home.body).toContain("Create cloud deployment");
    expect(home.body).toContain("Cloud operations");
    expect(home.body).toContain("Creating");
    expect(home.body).not.toContain("Primary Server");
    expect(home.body).not.toContain(`/deployments/${deploymentId}/open`);

    for (const status of ["deleting", "failed"] as const) {
      operation = { ...operation, status };
      const pending = await app.inject({ headers, method: "GET", url: "/" });
      expect(pending.body).toContain(status === "deleting" ? "Deleting" : "Needs attention");
      expect(pending.body).not.toContain("Primary Server");
      expect(pending.body).not.toContain(`/deployments/${deploymentId}/open`);
    }

    operation = { ...operation, status: "ready" };
    const ready = await app.inject({ headers, method: "GET", url: "/" });
    expect(ready.body).not.toContain("Cloud operations");
    expect(ready.body).toContain("Primary Server");
    expect(ready.body).toContain(`/deployments/${deploymentId}/open`);
    expect(ready.body).not.toContain("Needs attention");
    expect(ready.body).not.toContain("Open this deployment to check");
    expect(ready.body).not.toContain(">Ready<");
    operation = { ...operation, status: "creating" };

    const form = await app.inject({ headers, method: "GET", url: "/cloud/new" });
    expect(form.statusCode).toBe(200);
    const operationId = /name="operationId" value="([^"]+)"/u.exec(form.body)?.[1];
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/u);

    const refused = await app.inject({
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      payload: new URLSearchParams({ name: "Cloud One", operationId: operationId! }).toString(),
      url: "/cloud",
    });
    expect(refused.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();

    const created = await app.inject({
      headers: {
        ...headers,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://portal.test",
      },
      method: "POST",
      payload: new URLSearchParams({ name: "Cloud One", operationId: operationId! }).toString(),
      url: "/cloud",
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe(cloudOperationPath(operationId!));
    expect(create).toHaveBeenCalledWith(accountId, { name: "Cloud One", operationId });

    const detail = await app.inject({
      headers,
      method: "GET",
      url: cloudOperationPath(operationId!),
    });
    expect(detail.body).not.toContain('http-equiv="refresh"');
    expect(detail.body).not.toContain('name="operationId"');

    operation = { ...operation, status: "failed", error: "Provisioning was refused." };
    const retried = await app.inject({
      headers: { ...headers, origin: "https://portal.test" },
      method: "POST",
      url: `${cloudOperationPath(operationId!)}/retry`,
    });
    expect(retried.statusCode).toBe(303);
    expect(retry).toHaveBeenCalledWith(accountId, operationId);

    const confirmation = await app.inject({
      headers,
      method: "GET",
      url: cloudDeletePath(operationId!),
    });
    expect(confirmation.body).toContain("Enter <strong>Cloud One</strong>");
    expect(confirmation.body).toContain('name="name"');

    const deleted = await app.inject({
      headers: {
        ...headers,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://portal.test",
      },
      method: "POST",
      payload: new URLSearchParams({ name: "Cloud One" }).toString(),
      url: cloudDeletePath(operationId!),
    });
    expect(deleted.statusCode).toBe(303);
    expect(remove).toHaveBeenCalledWith(accountId, operationId, "Cloud One");
    await app.close();
  });
});

describe("portal live pages", () => {
  it("updates a pending operation in place instead of reloading the document", async () => {
    let operation = cloudOperation({ status: "creating" });
    const app = cloudPortalApp(() => operation);
    const detail = await app.inject({
      headers: portalHeaders,
      method: "GET",
      url: cloudOperationPath(operation.operationId),
    });

    // The flashing full-document refresh is gone for good.
    expect(detail.body).not.toContain('http-equiv="refresh"');
    // One region, marked live by the server, is the script's only source of truth.
    expect(detail.body).toContain('<main id="live-region" data-live>');
    const nonce = /<script nonce="([^"]+)">/u.exec(detail.body)?.[1];
    expect(nonce).toMatch(/^[\w-]{20,}$/u);
    expect(detail.body.match(/<script/gu)).toHaveLength(1);
    // It re-reads this very URL and swaps the region: one rendering path.
    expect(detail.body).toContain("fetch(location.href");
    expect(detail.body).toContain('credentials:"same-origin"');
    expect(detail.body).toContain("DOMParser");
    expect(detail.body).toContain("location.reload()");

    // The policy admits exactly that script and its same-origin read, and keeps
    // scripts off `unsafe-inline`.
    const policy = detail.headers["content-security-policy"];
    expect(policy).toContain(`script-src 'nonce-${nonce}'`);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");

    // Deleting is pending too, and each response mints its own nonce.
    operation = cloudOperation({ status: "deleting", operationId: operation.operationId });
    const deleting = await app.inject({
      headers: portalHeaders,
      method: "GET",
      url: cloudOperationPath(operation.operationId),
    });
    expect(deleting.body).toContain("data-live");
    expect(/<script nonce="([^"]+)">/u.exec(deleting.body)?.[1]).not.toBe(nonce);
    await app.close();
  });
});

const portalHeaders = { cookie: "__Host-opensteer.portal=fixture", host: "portal.test" };

function cloudOperation(
  overrides: Partial<CloudDeploymentOperation> = {},
): CloudDeploymentOperation {
  return {
    canonicalOrigin: "https://cloud.portal.test",
    deploymentId: createId("deployment"),
    desiredState: "present",
    error: null,
    name: "Cloud One",
    operationId: crypto.randomUUID(),
    progress: "Starting Browser, Messaging",
    status: "creating",
    updatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

/** A portal whose only deployment is the one cloud operation under test. */
function cloudPortalApp(current: () => CloudDeploymentOperation) {
  const router = createPortalRouter({
    auth: {} as never,
    cloudDeployments: {
      available: true,
      create: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(async () => current()),
      list: vi.fn(async () => [current()]),
      retry: vi.fn(),
    } as never,
    managedDeploymentDomain: "portal.test",
    portalSessions: {
      read: async () => ({
        accountId: `acct_${crypto.randomUUID()}`,
        accountSessionId: "session-1",
        displayName: "Portal Owner",
        email: "owner@example.test",
        expiresAt: new Date("2099-08-21T12:00:00.000Z"),
      }),
    } as never,
    publicOrigin: new URL("https://accounts.portal.test"),
    store: {
      isDeploymentPresentForAccount: vi.fn(async () => true),
      listDeployments: async () => [],
    } as never,
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && "status" in error ? error.status : null;
    return reply.code(typeof status === "number" ? status : 500).send();
  });
  router.register(app);
  app.get("/", (request, reply) => router.home(request, reply));
  return app;
}

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
      deploymentShape:
        kind === "self-hosted"
          ? { defaultWorkspaceBacking: "portablefs", kind: "server" }
          : { defaultWorkspaceBacking: "local-directory", kind: "personal" },
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
