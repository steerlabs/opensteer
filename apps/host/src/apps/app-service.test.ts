import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { createId, OpensteerError } from "@opensteer/core";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import type { AppStore } from "@opensteer/database";
import { hostApi } from "@opensteer/protocol";
import { AppService } from "./app-service.js";
import { AppTunnelError } from "./app-tunnel-hub.js";

function fixture(
  connectApp: NonNullable<ConstructorParameters<typeof AppService>[0]["tunnels"]>["connect"],
) {
  const workspaceId = createId("workspace");
  const userId = createId("user");
  const environmentId = createId("environment");
  const app = {
    id: `app_${crypto.randomUUID()}`,
    workspaceId,
    threadId: createId("thread"),
    runId: createId("run"),
    title: "App",
    latestVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const server = { environmentId, folder: ".", command: "node server.js" };
  const apps = {
    authorize: vi.fn(async () => undefined),
    get: async () => app,
    latest: async () => ({ app, version: { version: 1, server } }),
  } as unknown as AppStore;
  const scope = {
    workspaceId,
    requestedBy: userId,
    environmentId,
    threadId: app.threadId,
    runId: app.runId,
  };
  const options = {
    dataDirectory: tmpdir(),
    apps,
    files: { list: vi.fn(), download: vi.fn() },
    tokens: {
      authenticate: async () => scope,
      reauthorize: async () => scope,
    } as unknown as ConstructorParameters<typeof AppService>[0]["tokens"],
    store: {
      admitWorkspaceFiles: async () => ({
        workspace: {
          id: workspaceId,
          backing: {
            kind: "local-directory",
            bindingId: createId("workspaceBinding"),
            generation: 1,
            ownerEnvironmentId: environmentId,
            storageAuthorityId: createId("storageAuthority"),
          },
        },
      }),
    } as unknown as ConstructorParameters<typeof AppService>[0]["store"],
    tunnels: {
      connect: connectApp,
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      accept: vi.fn(),
    },
    publishEvent: () => undefined,
  };
  return {
    service: new AppService(options),
    app,
    userId,
    options,
    scope: scope as RunToolScope,
  };
}

it.each(["timeout", "bytes"] as const)(
  "cancels an endless app_fetch upstream on %s",
  async (mode) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      req.socket.once("close", closed.resolve);
      res.writeHead(409, { "content-type": "text/event-stream" });
      res.write(mode === "bytes" ? "x".repeat(300_000) : "data: first\n\n");
      received.resolve();
    });
    try {
      const listening = once(server, "listening", { signal: AbortSignal.timeout(2_000) });
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing app server listener");
      const { service, app, scope } = fixture(async (_spec, signal) => ({
        stream: connect({ host: "127.0.0.1", port: address.port, signal }),
        port: address.port,
      }));
      const timeout = new AbortController();
      const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const result = service.fetch(scope, { appId: app.id, method: "GET", path: "/events" });
      await withTimeout(received.promise, 2_000, {
        timeoutError: () => new Error("app_fetch never reached its server"),
      });
      if (mode === "timeout") timeout.abort(new Error("App fetch deadline"));
      const response = await withTimeout(result, 2_000, {
        timeoutError: () => new Error("app_fetch did not stop at its bound"),
      });
      expect(deadline).toHaveBeenCalledWith(30_000);
      deadline.mockRestore();
      if (mode === "bytes")
        expect(response).toMatchObject({
          status: 409,
          truncated: true,
          body: expect.stringContaining("Response truncated"),
        });
      else expect(response.status).toBe(503);
      await withTimeout(closed.promise, 2_000, {
        timeoutError: () => new Error("Bounded app_fetch left its upstream socket open"),
      });
    } finally {
      await closeHttpServerNow(server);
    }
  },
);

it("keeps failure log tails in agent results and excludes them from prepared viewer error pages", async () => {
  const { service, app, userId, scope } = fixture(async () => {
    throw new AppTunnelError("App startup failed", "private server log tail");
  });
  const view = await service.view(app.id, userId, "dark");
  // Clients parse this answer with the wire schema; a mismatch blanks every viewer.
  expect(hostApi["apps.view"].success.safeParse(view).success).toBe(true);
  const { path } = view;
  const token = path.split("/").at(-2)!;
  const response = await service.response({
    appId: app.id,
    token,
    theme: "dark",
    method: "GET",
    path: "/",
    prefix: path.slice(0, -1),
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(2_000),
  });
  let html = "";
  for await (const chunk of response.body) html += String(chunk);
  expect(response.status).toBe(503);
  expect(html).toContain("opensteer-app:ready");
  expect(html).not.toContain("private server log tail");
  expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(html));
  expect(await service.fetch(scope, { appId: app.id, method: "GET", path: "/api/" })).toMatchObject(
    { status: 503, body: expect.stringContaining("private server log tail") },
  );
});

it("returns server HTML unchanged to app_fetch while preparing viewer frames", async () => {
  const html =
    "<!DOCTYPE HTML>\n<html><head><title>Exact</title></head><body>  original &amp; text\n</body></html>";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(2_000) });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing app listener");
    const { service, app, userId, scope } = fixture(async (_spec, signal) => ({
      stream: connect({ host: "127.0.0.1", port: address.port, signal }),
      port: address.port,
    }));
    expect(await service.fetch(scope, { appId: app.id, method: "GET", path: "/" })).toMatchObject({
      status: 200,
      body: html,
      truncated: false,
    });
    const { path } = await service.view(app.id, userId, "dark");
    const response = await service.response({
      appId: app.id,
      token: path.split("/").at(-2)!,
      theme: "dark",
      method: "GET",
      path: "/",
      prefix: path.slice(0, -1),
      headers: {},
      signal: AbortSignal.timeout(2_000),
    });
    let frame = "";
    for await (const chunk of response.body) frame += String(chunk);
    expect(frame).toContain("opensteer-app:ready");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
  } finally {
    await closeHttpServerNow(server);
  }
});

it("rechecks Workspace deletion after waiting for an app's publication lock", async () => {
  vi.useFakeTimers();
  const { service, app, options, scope } = fixture(vi.fn());
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let deleting = false;
  const admission = options.store.admitWorkspaceFiles.bind(options.store);
  vi.spyOn(options.store, "admitWorkspaceFiles").mockImplementation(async (...args) => {
    if (deleting)
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "Workspace is awaiting deletion",
        reason: "workspace-deleting",
      });
    return admission(...args);
  });
  vi.spyOn(options.apps, "authorize").mockResolvedValue({ app } as Awaited<
    ReturnType<AppStore["authorize"]>
  >);
  Object.assign(options.apps, {
    publication: async () => undefined,
    publish: async () => {
      throw new Error("Publication cancelled");
    },
  });
  options.tunnels.start.mockImplementation(async () => {
    started.resolve();
    await withTimeout(release.promise, 1_000, {
      timeoutError: () => new Error("Publication start was not released"),
    });
  });
  const input = { appId: app.id, title: "Server", path: ".", start: "node server.js" };
  const first = service.publish(scope, "first", input).catch((error: unknown) => error);
  try {
    await withTimeout(started.promise, 1_000, {
      timeoutError: () => new Error("Publication never started"),
    });
    const queued = service.publish(scope, "queued", input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    deleting = true;
    release.resolve();
    await first;
    const refused = await queued;
    expect(options.tunnels.start).toHaveBeenCalledTimes(1);
    expect(refused).toMatchObject({ code: "workspace_unavailable" });
  } finally {
    release.resolve();
    await first;
    vi.useRealTimers();
  }
});

it.each(["deleted", "deleting"])(
  "explains an app's %s Workspace instead of suggesting reconnect",
  async (state) => {
    const connectApp = vi.fn();
    const { service, app, userId, options } = fixture(connectApp);
    const { path } = await service.view(app.id, userId, "dark");
    vi.spyOn(options.store, "admitWorkspaceFiles").mockImplementation(async () => {
      if (state === "deleting")
        throw new OpensteerError({
          code: "workspace_unavailable",
          message: "Workspace is awaiting deletion",
          reason: "workspace-deleting",
        });
      return null;
    });
    const response = await service.response({
      appId: app.id,
      token: path.split("/").at(-2)!,
      theme: "dark",
      method: "GET",
      path: "/",
      prefix: path.slice(0, -1),
      headers: {},
      signal: AbortSignal.timeout(2_000),
    });
    let body = "";
    for await (const chunk of response.body) body += String(chunk);
    expect(response.status).toBe(404);
    expect(body).toContain("This app is no longer available");
    expect(body).not.toContain("reconnect");
    expect(connectApp).not.toHaveBeenCalled();
  },
);
