import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { createId, OpensteerError, type AppId } from "@opensteer/core";
import type { AppStore, PublishedApp } from "@opensteer/database";
import type { RunnerConnectionId } from "@opensteer/protocol";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { expect, it, vi } from "vitest";
import { AppService } from "./app-service.js";

function fixture(app: PublishedApp) {
  let current = app;
  const apps = {
    get: vi.fn(async () => current),
    record: async () => current,
    setLastError: async () => false,
    runtimeSet: async () => [],
    deleting: async () => [],
  };
  const connectionId = `rcn_${crypto.randomUUID()}` as RunnerConnectionId;
  const sync = vi.fn(async () => ({ ok: true }));
  const connectApp = vi.fn();
  const tunnels = {
    connection: vi.fn(() => ({ connectionId, signal: new AbortController().signal })),
    sync,
    connect: connectApp,
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    accept: vi.fn(),
  };
  const service = new AppService({
    dataDirectory: tmpdir(),
    apps: apps as unknown as AppStore,
    files: { list: vi.fn(), download: vi.fn() },
    agentHome: async () => ({ computerId: app.computerId, path: "/fixture/home" }),
    tokens: { reauthorize: async (scope) => scope },
    tunnels: tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
    tabs: { removeTabs: async () => [] },
    changed: vi.fn(),
  });
  return {
    service,
    apps,
    tunnels,
    connectionId,
    connectApp,
    sync,
    replace: (next: PublishedApp) => {
      current = next;
    },
  };
}

function serverApp(desiredState: "running" | "stopped" = "running"): PublishedApp {
  const computerId = createId("runner");
  return {
    id: `app_${crypto.randomUUID()}` as AppId,
    ownerId: createId("user"),
    computerId,
    threadId: null,
    runId: null,
    name: "Notes",
    deleting: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: {
      version: 1,
      sha256: null,
      sizeBytes: null,
      server: { folder: { computerId, path: "/fixture/home/notes" }, command: "node s.js" },
    },
    server: { port: 51_000, desiredState, generation: 1, lastError: null },
  };
}

async function text(body: Readable) {
  let result = "";
  for await (const chunk of body) result += String(chunk);
  return result;
}

it("connects a viewer only to a reconciled running server, never starting a stopped, failed or offline one", async () => {
  const html =
    "<!DOCTYPE HTML>\n<html><head><title>Exact</title></head><body>original</body></html>";
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  const listening = once(upstream, "listening", { signal: AbortSignal.timeout(2_000) });
  upstream.listen(0, "127.0.0.1");
  await listening;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing app listener");
  const app = serverApp();
  const f = fixture(app);
  f.connectApp.mockImplementation(async (_spec, signal: AbortSignal) => ({
    stream: connect({ host: "127.0.0.1", port: address.port, signal }),
    port: address.port,
  }));
  const { path } = await f.service.view(app.ownerId, app.id, "dark");
  const view = () =>
    f.service.response({
      appId: app.id,
      token: path.split("/").at(-2)!,
      theme: "dark",
      method: "GET",
      path: "/",
      prefix: path.slice(0, -1),
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(2_000),
    });
  try {
    const offline = await view();
    expect(offline.status).toBe(503);
    expect(await text(offline.body)).toContain("computer is offline");

    f.sync.mockResolvedValueOnce({ ok: false });
    await f.service.onRunnerConnected(app.computerId);
    await f.service.onAppState(app.computerId, f.connectionId, {
      appId: app.id,
      generation: 1,
      state: "running",
    });
    // A failed reconciliation keeps connects unavailable until the next one.
    await expect(
      f.service.connect(app.id, app.ownerId, AbortSignal.timeout(1_000)),
    ).rejects.toThrow("could not reconcile");
    await f.service.onRunnerConnected(app.computerId);
    const running = await view();
    expect(running.status).toBe(200);
    expect(await text(running.body)).toContain("opensteer-app:ready");
    expect(running.headers["content-security-policy"]).toContain("sandbox");

    // A report from a replaced connection changes nothing.
    await f.service.onAppState(app.computerId, `rcn_${crypto.randomUUID()}` as RunnerConnectionId, {
      appId: app.id,
      generation: 1,
      state: "failed",
    });
    expect((await f.service.get(app.ownerId, app.id)).state).toBe("running");
    await f.service.onAppState(app.computerId, f.connectionId, {
      appId: app.id,
      generation: 1,
      state: "failed",
      error: "App server exited",
    });
    const failed = await view();
    expect(failed.status).toBe(503);
    expect(await text(failed.body)).toContain("failed");

    f.replace({ ...app, server: { ...app.server!, desiredState: "stopped", generation: 2 } });
    const stopped = await view();
    expect(stopped.status).toBe(503);
    expect(await text(stopped.body)).toContain("stopped");
    expect(f.connectApp).toHaveBeenCalledTimes(1);
    expect(f.tunnels.start).not.toHaveBeenCalled();
  } finally {
    await closeHttpServerNow(upstream);
  }
});

it("explains an app removed while its tunnel decision waited", async () => {
  const app = serverApp();
  const f = fixture(app);
  await f.service.onRunnerConnected(app.computerId);
  await f.service.onAppState(app.computerId, f.connectionId, {
    appId: app.id,
    generation: 1,
    state: "running",
  });
  const { path } = await f.service.view(app.ownerId, app.id, "dark");
  f.apps.get
    .mockResolvedValueOnce(app)
    .mockRejectedValueOnce(new OpensteerError({ code: "not_found", message: "App removed" }));
  const response = await f.service.response({
    appId: app.id,
    token: path.split("/").at(-2)!,
    theme: "dark",
    method: "GET",
    path: "/",
    prefix: path.slice(0, -1),
    headers: {},
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.status).toBe(404);
  expect(await text(response.body)).toContain("This app is no longer available");
  expect(f.connectApp).not.toHaveBeenCalled();
});

it("serves stored HTML with origin bootstrap while keeping the capability document opaque", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-stored-app-origin-"));
  const bytes = Buffer.from("<html><head></head><body>Stored app</body></html>");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const server = serverApp();
  const app: PublishedApp = {
    ...server,
    version: { version: 1, sha256, sizeBytes: bytes.length, server: null },
    server: null,
  };
  const f = fixture(app);
  const service = new AppService({
    dataDirectory: directory,
    apps: f.apps as unknown as AppStore,
    files: { list: vi.fn(), download: vi.fn() },
    agentHome: async () => ({ computerId: app.computerId, path: "/fixture/home" }),
    tokens: { reauthorize: async (scope) => scope },
    tunnels: f.tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
    tabs: { removeTabs: async () => [] },
    changed: vi.fn(),
  });
  try {
    await mkdir(join(directory, "apps"));
    await writeFile(join(directory, "apps", sha256), bytes);
    const originMode = { origin: "https://app.example.test", parents: ["app://opensteer"] };
    const result = await service.response({
      appId: app.id,
      userId: app.ownerId,
      originMode,
      theme: "dark",
      prefix: "",
      path: "/?state=1",
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(2_000),
    });
    const html = await text(result.body);
    expect(html).toContain("Stored app");
    expect(html).toContain("Object.defineProperty(document,'cookie'");
    expect(html).toContain("opensteer-app:ready");
    expect(result.headers["content-security-policy"]).toBe("frame-ancestors app://opensteer");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    const view = await service.view(app.ownerId, app.id, "dark");
    expect(view.app).toMatchObject({ kind: "html", state: "running", server: null });
    const capability = await service.content(app.id, view.path.split("/").at(-2)!, "dark");
    expect(capability).not.toContain("Object.defineProperty(document,'cookie'");
    expect(f.connectApp).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
