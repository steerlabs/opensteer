import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustedProxy } from "@opensteer/config";
import { exchangeRouteOrigin } from "../access/session-exchange-routes.js";
import { anonymousClientAddress, installTrustedProxy } from "./anonymous-client-address.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function observe(
  proxy: TrustedProxy | undefined,
  request: { readonly peer: string; readonly headers: Record<string, string> },
) {
  const app = Fastify();
  apps.push(app);
  if (proxy) installTrustedProxy(app, proxy);
  app.get("/", async (incoming) => {
    let origin: string;
    try {
      origin = exchangeRouteOrigin(incoming);
    } catch {
      origin = "refused";
    }
    return { address: anonymousClientAddress(incoming), origin };
  });
  const response = await app.inject({
    method: "GET",
    url: "/",
    remoteAddress: request.peer,
    headers: { host: "home.example.com", ...request.headers },
  });
  return response.json<{ address: string; origin: string }>();
}

const forwarded = {
  "cf-connecting-ip": "198.51.100.7",
  "x-forwarded-for": "192.0.2.1, 203.0.113.50",
  "x-forwarded-proto": "https",
};

describe("forwarding headers", () => {
  it("believes the reverse proxy on loopback, taking the address it appended", async () => {
    expect(await observe("loopback", { peer: "127.0.0.1", headers: forwarded })).toEqual({
      address: "203.0.113.50",
      origin: "https://home.example.com",
    });
    expect(await observe("loopback", { peer: "::1", headers: forwarded })).toMatchObject({
      address: "203.0.113.50",
    });
  });

  it("believes nothing a peer off this computer says, whatever proxy is configured", async () => {
    for (const proxy of ["loopback", "loopback-cloudflared", undefined] as const)
      expect(await observe(proxy, { peer: "203.0.113.9", headers: forwarded })).toEqual({
        address: "203.0.113.9",
        origin: "http://home.example.com",
      });
  });

  it("reads CF-Connecting-IP only when the tunnel connector is the configured proxy", async () => {
    expect(
      await observe("loopback-cloudflared", { peer: "127.0.0.1", headers: forwarded }),
    ).toEqual({ address: "198.51.100.7", origin: "https://home.example.com" });
    // A loopback Personal Host keeps that reading by default.
    expect(await observe(undefined, { peer: "127.0.0.1", headers: forwarded })).toMatchObject({
      address: "198.51.100.7",
    });
    expect(
      await observe("loopback", {
        peer: "127.0.0.1",
        headers: { "cf-connecting-ip": "198.51.100.7" },
      }),
    ).toMatchObject({ address: "127.0.0.1" });
  });

  it("believes no header at all when told no proxy stands in front", async () => {
    expect(await observe("none", { peer: "127.0.0.1", headers: forwarded })).toEqual({
      address: "127.0.0.1",
      origin: "http://home.example.com",
    });
  });

  it("refuses a trusted proxy that says the route was not HTTPS", async () => {
    expect(
      await observe("loopback", { peer: "127.0.0.1", headers: { "x-forwarded-proto": "http" } }),
    ).toMatchObject({ origin: "refused" });
  });
});
