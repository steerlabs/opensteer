import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { createId } from "@opensteer/core";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import type { AppStore } from "@opensteer/database";
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
    tunnels: { connect: connectApp, start: vi.fn(), stop: vi.fn(), accept: vi.fn() },
    publishEvent: () => undefined,
  };
  return { service: new AppService(options), app, userId };
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
      const { service, app } = fixture(async (_spec, signal) => ({
        stream: connect({ host: "127.0.0.1", port: address.port, signal }),
        port: address.port,
      }));
      const timeout = new AbortController();
      const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const result = service.fetch("token", { appId: app.id, method: "GET", path: "/events" });
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
  const { service, app, userId } = fixture(async () => {
    throw new AppTunnelError("App startup failed", "private server log tail");
  });
  const { path } = await service.view(app.id, userId, "dark");
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
  expect(
    await service.fetch("token", { appId: app.id, method: "GET", path: "/api/" }),
  ).toMatchObject({ status: 503, body: expect.stringContaining("private server log tail") });
});
