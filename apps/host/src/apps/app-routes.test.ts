import Fastify from "fastify";
import { Writable } from "node:stream";
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
  registerAppRoutes(server, { content } as unknown as AppService);
  try {
    const response = await server.inject({
      method: "GET",
      url: `/v1/apps/${appId}/content?token=${"a".repeat(43)}&theme=dark`,
    });
    expect(response.statusCode).toBe(200);
    expect(content).toHaveBeenCalledWith(appId, "a".repeat(43), "dark");
    expect(response.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-popups",
    );
    expect(response.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'unsafe-inline' https:",
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
