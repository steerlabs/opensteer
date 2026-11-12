import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const computerId = createId("runner");
  const userId = createId("user");
  const environmentId = createId("environment");
  const app = {
    id: `app_${crypto.randomUUID()}`,

    threadId: createId("thread"),
    runId: createId("run"),
    title: "App",
    latestVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const server = { folder: { computerId, path: "/fixture/task" }, command: "node server.js" };
  const publisher = {
    id: app.threadId,
    accessMode: "full-access" as const,
    status: "running" as const,
    folderComputerId: computerId,
    folderPath: "/fixture/task",
  };
  const apps = {
    authorize: vi.fn(async () => ({ app, publisher })),
    get: async () => app,
    latest: async () => ({ app, version: { version: 1, server } }),
  } as unknown as AppStore;
  const scope = {
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
    scope: scope as unknown as RunToolScope,
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

it.each([false, true])(
  "keeps failure log tails out of viewer errors with real origin %s",
  async (realOrigin) => {
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
      ...(realOrigin
        ? {
            userId,
            originMode: { origin: "https://app.example.test", parents: ["app://opensteer"] },
          }
        : {}),
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
    expect(html.includes("history.replaceState")).toBe(realOrigin);
    expect(html).not.toContain("private server log tail");
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(html));
    expect(
      await service.fetch(scope, { appId: app.id, method: "GET", path: "/api/" }),
    ).toMatchObject({ status: 503, body: expect.stringContaining("private server log tail") });
  },
);

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

it("rechecks personal authority after waiting for an app's publication lock", async () => {
  vi.useFakeTimers();
  const { service, app, options, scope } = fixture(vi.fn());
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let deleting = false;
  const initial = await options.apps.authorize({ ...scope, userId: scope.requestedBy });
  vi.spyOn(options.apps, "authorize").mockImplementation(async () => {
    if (deleting)
      throw new OpensteerError({ code: "forbidden", message: "Personal owner revoked" });
    return initial;
  });
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
    expect(refused).toMatchObject({ code: "forbidden" });
  } finally {
    release.resolve();
    await first;
    vi.useRealTimers();
  }
});

it("explains an app removed while its tunnel decision waited", async () => {
  const connectApp = vi.fn();
  const { service, app, userId, options } = fixture(connectApp);
  const { path } = await service.view(app.id, userId, "dark");
  const latest = await options.apps.latest(app.id, userId);
  vi.spyOn(options.apps, "latest")
    .mockResolvedValueOnce(latest)
    .mockRejectedValueOnce(new OpensteerError({ code: "not_found", message: "App removed" }));
  const response = await service.response({
    appId: app.id,
    token: path.split("/").at(-2)!,
    theme: "dark",
    method: "GET",
    path: "/",
    prefix: path.slice(0, -1),
    headers: {},
    signal: AbortSignal.timeout(2000),
  });
  let body = "";
  for await (const chunk of response.body) body += String(chunk);
  expect(response.status).toBe(404);
  expect(body).toContain("This app is no longer available");
  expect(body).not.toContain("reconnect");
  expect(connectApp).not.toHaveBeenCalled();
});
it("reports a committed tab change when notifying other devices fails", async () => {
  const appTabs = [{ appId: `app_${crypto.randomUUID()}` }];
  const service = new AppService({
    dataDirectory: tmpdir(),
    apps: { setTabOpen: async () => ({ appTabs }) } as unknown as AppStore,

    files: { list: vi.fn(), download: vi.fn() },
    tokens: { authenticate: vi.fn(), reauthorize: vi.fn() },
    publishEvent: vi.fn(),
    tabsChanged: async () => {
      throw new Error("device notification failed");
    },
  });
  await expect(service.setTabOpen(appTabs[0]!.appId, createId("user"), true)).resolves.toEqual({
    appTabs,
  });
});

it("serves stored HTML with origin bootstrap while keeping the legacy document opaque", async () => {
  const { app, userId, options } = fixture(async () => {
    throw new Error("Stored HTML opened a tunnel");
  });
  const directory = await mkdtemp(join(tmpdir(), "opensteer-stored-app-origin-"));
  const bytes = Buffer.from("<html><head></head><body>Stored app</body></html>");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const service = new AppService({
    ...options,
    dataDirectory: directory,
    apps: {
      ...options.apps,
      latest: async () => ({ app, version: { sha256, sizeBytes: bytes.length, server: null } }),
    } as unknown as AppStore,
  });
  try {
    await mkdir(join(directory, "apps"));
    await writeFile(join(directory, "apps", sha256), bytes);
    const originMode = { origin: "https://app.example.test", parents: ["app://opensteer"] };
    const result = await service.response({
      appId: app.id,
      userId,
      originMode,
      theme: "dark",
      prefix: "",
      path: "/?state=1",
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(2_000),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    const html = Buffer.concat(chunks).toString();
    expect(html).toContain("Stored app");
    expect(html).toContain("Object.defineProperty(document,'cookie'");
    expect(html).toContain("opensteer-app:ready");
    expect(result.headers["content-security-policy"]).toBe("frame-ancestors app://opensteer");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    const legacy = await service.view(app.id, userId, "dark");
    const old = await service.content(app.id, legacy.path.split("/").at(-2)!, "dark");
    expect(old).not.toContain("Object.defineProperty(document,'cookie'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
