import { createId, OpensteerError } from "@opensteer/core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import { registerTriggerRoutes } from "./trigger-routes.js";
import type { TriggerService } from "./trigger-service.js";
import { WebhookRateLimiter } from "./webhook-rate-limiter.js";

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe("Trigger HTTP routes (T7 / Y3 / Y11)", () => {
  it("accepts key-in-path webhooks for any method with exact raw bytes, query params, and filtered headers", async () => {
    const occurrenceId = createId("triggerOccurrence");
    const acceptWebhook = vi.fn(async (_input: Parameters<TriggerService["acceptWebhook"]>[0]) => ({
      occurrence: { id: occurrenceId },
      wasDuplicate: false,
    }));
    const app = Fastify();
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
    );

    const routeKey = "whk_1234567890123456789012345678901234567890123";
    const binaryBody = Buffer.from([0x00, 0xff, 0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0x31, 0x7d]);
    const response = await app.inject({
      headers: {
        authorization: "CustomScheme third-party-auth",
        "content-type": "application/octet-stream",
        cookie: "must-not-reach-script=true",
        "stripe-signature": "t=1700000000,v1=abcdef",
        "x-forwarded-for": "1.2.3.4",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-opensteer-internal": "secret-internal",
      },
      method: "PUT",
      payload: binaryBody,
      url: `/hooks/v1/${routeKey}?env=prod&tag=a&tag=b`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ occurrenceId, wasDuplicate: false });
    expect(acceptWebhook).toHaveBeenCalledTimes(1);
    const call = acceptWebhook.mock.calls[0]?.[0];
    if (!call) throw new Error("Expected acceptWebhook call");
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/hooks/v1");
    expect(call.routeKey).toBe(routeKey);
    expect(call.query).toEqual({ env: "prod", tag: ["a", "b"] });
    expect(Buffer.isBuffer(call.rawBody)).toBe(true);
    expect(call.rawBody?.equals(binaryBody)).toBe(true);
    // Signature & third-party authorization headers survive; cookies and proxy/internal headers are stripped.
    expect(call.headers["stripe-signature"]).toBe("t=1700000000,v1=abcdef");
    expect(call.headers["x-hub-signature-256"]).toBe("sha256=deadbeef");
    expect(call.headers.authorization).toBe("CustomScheme third-party-auth");
    expect(call.headers).not.toHaveProperty("cookie");
    expect(call.headers).not.toHaveProperty("x-forwarded-for");
    expect(call.headers).not.toHaveProperty("x-opensteer-internal");
    expect(call.headers).not.toHaveProperty("host");

    // GET requests work too without a bearer header.
    const getResponse = await app.inject({
      method: "GET",
      url: `/hooks/v1/${routeKey}?challenge=xyz`,
    });
    expect(getResponse.statusCode).toBe(202);
    expect(acceptWebhook).toHaveBeenCalledTimes(2);
  });

  it("rate-limits flooded or unknown hits in memory BEFORE touching the database", async () => {
    const acceptWebhook = vi.fn(async () => {
      throw new OpensteerError({ code: "not_found", message: "Webhook not found" });
    });
    const app = Fastify();
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
      new WebhookRateLimiter({ perIpLimit: 2, perRouteLimit: 10, windowMs: 60_000 }),
    );

    const routeKey = "whk_1234567890123456789012345678901234567890123";
    expect((await app.inject({ method: "POST", url: `/hooks/v1/${routeKey}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "POST", url: `/hooks/v1/${routeKey}` })).statusCode).toBe(
      404,
    );
    expect(acceptWebhook).toHaveBeenCalledTimes(2);

    // Third hit is rejected in memory with 429 and NEVER calls acceptWebhook / PostgreSQL.
    const throttled = await app.inject({ method: "POST", url: `/hooks/v1/${routeKey}` });
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(acceptWebhook).toHaveBeenCalledTimes(2);

    // Malformed route key from a fresh IP returns identical 404 before touching acceptWebhook.
    const malformed = await app.inject({
      method: "POST",
      remoteAddress: "198.51.100.7",
      url: "/hooks/v1/not-a-valid-key",
    });
    expect(malformed.statusCode).toBe(404);
    expect(acceptWebhook).toHaveBeenCalledTimes(2);
  });

  it("returns 413 for bodies larger than 256 KiB and 429 when the 100-item pending queue is full", async () => {
    const acceptWebhook = vi.fn(async () => {
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Automation already has 100 pending occurrences, its durable limit",
      });
    });
    const app = Fastify();
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
    );

    const routeKey = "whk_1234567890123456789012345678901234567890123";
    const oversized = await app.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: Buffer.alloc(256 * 1_024 + 1, 0x61),
      url: `/hooks/v1/${routeKey}`,
    });
    expect(oversized.statusCode).toBe(413);
    expect(acceptWebhook).not.toHaveBeenCalled();

    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: Buffer.from('{"ref":"refs/heads/main"}', "utf8"),
      url: `/hooks/v1/${routeKey}`,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("300");
    expect(response.json()).toEqual({
      error: {
        code: "resource_exhausted",
        message: "Automation already has 100 pending occurrences, its durable limit",
        retryable: true,
      },
    });
  });

  it("accepts OPTIONS webhooks and never logs the webhook route key on unexpected errors (AA14.4 / AA14.5)", async () => {
    const occurrenceId = createId("triggerOccurrence");
    const routeKey = "whk_secret_route_key_99999999999999999999999";
    const logged: string[] = [];
    const acceptWebhook = vi
      .fn<TriggerService["acceptWebhook"]>()
      .mockResolvedValueOnce({
        occurrence: { id: occurrenceId } as never,
        wasDuplicate: false,
      })
      .mockRejectedValueOnce(new Error("unexpected database outage"));
    const app = Fastify({
      logger: {
        level: "info",
        stream: {
          write(chunk: string) {
            logged.push(chunk);
          },
        },
      },
    });
    applications.push(app);
    registerTriggerRoutes(
      app,
      {} as HostAuthenticator,
      { acceptWebhook } as unknown as TriggerService,
    );

    const optionsResponse = await app.inject({
      method: "OPTIONS",
      url: `/hooks/v1/${routeKey}`,
    });
    expect(optionsResponse.statusCode).toBe(202);
    expect(acceptWebhook.mock.calls[0]?.[0]?.method).toBe("OPTIONS");

    const errorResponse = await app.inject({
      method: "POST",
      url: `/hooks/v1/${routeKey}`,
    });
    expect(errorResponse.statusCode).toBe(500);
    expect(logged.join("\n")).not.toContain(routeKey);
  });
});
