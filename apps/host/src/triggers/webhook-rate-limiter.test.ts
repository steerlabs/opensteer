import { describe, expect, it } from "vitest";
import { WebhookRateLimiter } from "./webhook-rate-limiter.js";

describe("WebhookRateLimiter", () => {
  it("enforces per-IP and per-route sliding limits in memory and recovers after the window", () => {
    let now = 1_000_000;
    const limiter = new WebhookRateLimiter({
      now: () => now,
      perIpLimit: 3,
      perRouteLimit: 4,
      windowMs: 60_000,
    });

    expect(limiter.consume("10.0.0.1", "route-a")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.1", "route-b")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.1", "route-c")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.1", "route-d")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    // Different IPs hitting the same route hit the per-route limit independently.
    expect(limiter.consume("10.0.0.2", "route-a")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.3", "route-a")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.4", "route-a")).toEqual({ allowed: true });
    expect(limiter.consume("10.0.0.5", "route-a")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    // After the window elapses, both IP and route are admitted again.
    now += 60_001;
    expect(limiter.consume("10.0.0.1", "route-a")).toEqual({ allowed: true });
  });

  it("evicts oldest keys when maxBuckets is reached so random spraying stays bounded", () => {
    const limiter = new WebhookRateLimiter({
      maxBuckets: 2,
      perIpLimit: 1,
      perRouteLimit: 10,
      windowMs: 60_000,
    });

    expect(limiter.consume("ip-1", "r")).toEqual({ allowed: true });
    expect(limiter.consume("ip-1", "r").allowed).toBe(false);
    expect(limiter.consume("ip-2", "r")).toEqual({ allowed: true });
    expect(limiter.consume("ip-3", "r")).toEqual({ allowed: true });
    // ip-1 was evicted by LRU cap; bucket map stayed bounded at 2.
    expect(limiter.consume("ip-1", "r")).toEqual({ allowed: true });
  });
});
