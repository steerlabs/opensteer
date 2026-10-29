import { describe, expect, it } from "vitest";
import { ChannelRuntimeServer } from "./server.js";

describe("ChannelRuntimeServer", () => {
  it("exposes health without accepting public provider ingress", async () => {
    const server = new ChannelRuntimeServer({ providers: () => ["slack"], ready: () => true });
    const health = await server.app.inject({ method: "GET", url: "/healthz" });
    const webhook = await server.app.inject({
      method: "POST",
      payload: {},
      url: "/v1/webhooks/slack/con_123",
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, providers: ["slack"] });
    expect((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(webhook.statusCode).toBe(404);
    await server.app.close();
  });

  it("reports readiness only after the Host connection authenticates", async () => {
    let authenticated = false;
    const server = new ChannelRuntimeServer({
      providers: () => ["slack"],
      ready: () => authenticated,
    });

    const waiting = await server.app.inject({ method: "GET", url: "/readyz" });
    authenticated = true;
    const ready = await server.app.inject({ method: "GET", url: "/readyz" });

    expect(waiting.statusCode).toBe(503);
    expect(waiting.json()).toEqual({ hostAuthenticated: false, ok: false });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ hostAuthenticated: true, ok: true });
    await server.app.close();
  });
});
