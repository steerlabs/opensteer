import Fastify from "fastify";
import { Readable, Writable } from "node:stream";
import { createId } from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import type { AppService } from "./app-service.js";
import { createAppHandlers, registerAppRoutes } from "./app-routes.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const appId = "app_11111111-1111-4111-8111-111111111111";
it("declares authenticated app reads and passes only the signed-in reader to the service", async () => {
  const get = vi.fn(async () => ({ id: appId }));
  const view = vi.fn(async () => ({ path: "/view" }));
  const handlers = createAppHandlers({ get, view } as unknown as AppService);
  const userId = createId("user");
  const context = testHostApiContext(userId);
  await handlers["apps.get"]({ appId }, context);
  await handlers["apps.view"]({ appId, theme: "dark" }, context);
  expect(get).toHaveBeenCalledWith(appId, userId);
  expect(view).toHaveBeenCalledWith(appId, userId, "dark");
  await expect(
    handlers["apps.get"]({ appId }, { ...context, session: null }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  for (const name of ["apps.get", "apps.view"] as const) {
    expect(hostApi[name].payload.safeParse({ appId: "wrong" }).success).toBe(false);
    expect(hostApi[name].payload.safeParse({}).success).toBe(false);
  }
});
it("serves only capability-addressed HTML, with the same opaque-origin sandbox on success and failure", async () => {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const server = Fastify({ logger: { level: "info", stream } });
  const content = vi.fn(async () => "<!doctype html><html>Chart</html>");
  const serve = vi.fn(async () => ({
    status: 200,
    headers: {},
    body: Readable.from([await content()]),
  }));
  registerAppRoutes(server, { response: serve } as unknown as AppService);
  try {
    const response = await server.inject({
      method: "GET",
      url: `/v1/apps/${appId}/dark/${"a".repeat(43)}/`,
    });
    expect(response.statusCode).toBe(200);
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ appId, token: "a".repeat(43), theme: "dark", path: "/" }),
    );
    expect(response.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-popups",
    );
    expect(response.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' https:",
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    content.mockClear();
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/v1/apps/${appId}/content`,
          headers: { cookie: "opensteer=ambient-session" },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(content).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("a".repeat(43));
  } finally {
    await server.close();
  }
});

it("authorizes CORS preflight without starting a server and supports opaque-origin JSON requests", async () => {
  const server = Fastify();
  const authorizeView = vi.fn(async () => ({ version: { server: {} } }));
  const response = vi.fn(async () => ({
    status: 201,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: (await import("node:stream")).Readable.from(['{"ok":true}']),
  }));
  registerAppRoutes(server, { authorizeView, response } as unknown as AppService);
  const url = `/v1/apps/${appId}/dark/${"a".repeat(43)}/api/`;
  try {
    const preflight = await server.inject({
      method: "OPTIONS",
      url,
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type");
    expect(response).not.toHaveBeenCalled();
    const custom = await server.inject({
      method: "OPTIONS",
      url,
      headers: { origin: "null", "access-control-request-method": "PROPFIND" },
    });
    expect(custom.headers["access-control-allow-methods"]).toBe("PROPFIND");

    const post = await server.inject({
      method: "POST",
      url,
      headers: { origin: "null", "content-type": "application/json" },
      payload: '{"value":42}',
    });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toEqual({ ok: true });
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/api/", body: expect.anything() }),
    );
  } finally {
    await server.close();
  }
});
