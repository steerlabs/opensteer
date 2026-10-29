import { createId, OpensteerError } from "@opensteer/core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import { registerTriggerRoutes } from "./trigger-routes.js";
import type { TriggerService } from "./trigger-service.js";

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe("Trigger HTTP routes", () => {
  it("commits authenticated webhook ingress and returns 202 without waiting for execution", async () => {
    const occurrenceId = createId("triggerOccurrence");
    const acceptWebhook = vi.fn(
      async (_input: {
        readonly headers: Readonly<Record<string, string>>;
        readonly method: string;
        readonly payload: unknown;
        readonly routeKey: string;
        readonly secret: string;
      }) => ({ occurrence: { id: occurrenceId }, wasDuplicate: true }),
    );
    const app = Fastify();
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
    );

    const response = await app.inject({
      headers: {
        authorization: "Bearer oswh_12345678901234567890123456789012",
        cookie: "must-not-reach-program=true",
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
      },
      method: "POST",
      payload: { ref: "refs/heads/main" },
      url: "/hooks/v1/wh_12345678901234567890123456789012",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ occurrenceId, wasDuplicate: true });
    expect(acceptWebhook).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      headers: expect.objectContaining({
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
      }),
      method: "POST",
      payload: { ref: "refs/heads/main" },
      routeKey: "wh_12345678901234567890123456789012",
      secret: "oswh_12345678901234567890123456789012",
    });
    expect(acceptWebhook.mock.calls[0]?.[0].headers).not.toHaveProperty("authorization");
    expect(acceptWebhook.mock.calls[0]?.[0].headers).not.toHaveProperty("cookie");
  });

  it("answers a full pending queue with 429 and a retry window instead of dropping delivery", async () => {
    const acceptWebhook = vi.fn(async () => {
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Trigger already has 100 pending occurrences",
      });
    });
    const app = Fastify();
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
    );

    const response = await app.inject({
      headers: { authorization: "Bearer oswh_12345678901234567890123456789012" },
      method: "POST",
      payload: { ref: "refs/heads/main" },
      url: "/hooks/v1/wh_12345678901234567890123456789012",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("300");
    expect(response.json()).toEqual({
      error: {
        code: "resource_exhausted",
        message: "Trigger already has 100 pending occurrences",
        retryable: true,
      },
    });
  });
});
