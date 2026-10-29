import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  localHostProxyRoutes,
  localWebBindAddress,
  redirectUnclaimedLocalHost,
  rejectSupervisorOnlyRoutes,
} from "./dev-server-boundary.js";

describe("development Web boundary", () => {
  it("binds the browser-visible server to IPv4 loopback", () => {
    expect(localWebBindAddress).toBe("127.0.0.1");
  });

  it("proxies every authenticated runtime capability carried in a Run plan", () => {
    expect(localHostProxyRoutes).toMatchObject({
      "/internal/v1/agent-control": {},
      "/internal/v1/browser-cdp": { ws: true },
      "/internal/v1/computer-use/display": { ws: true },
      "/internal/v1/integration-mcp": {},
      "/internal/v1/integration-skills": {},
      "/internal/v1/mcp": {},
      "/internal/v1/runners": { ws: true },
      "/internal/v1/trigger-cdp": { ws: true },
    });
    expect(localHostProxyRoutes["/v1"]).toMatchObject({ ws: true });
    expect(localHostProxyRoutes).not.toHaveProperty("/internal/v1/channel-runtime");
    expect(localHostProxyRoutes).not.toHaveProperty("/internal/v1/devices/connect");
  });

  it("serves Host discovery from the canonical origin a native client is given", () => {
    expect(localHostProxyRoutes).toMatchObject({ "/.well-known/opensteer": {} });
  });

  it("does not publish the supervisor-only bootstrap document", () => {
    const request = { url: "/v1/local-bootstrap?ignored=true" } as IncomingMessage;
    const response = new TestResponse();
    const next = vi.fn();

    rejectSupervisorOnlyRoutes(request, response as unknown as ServerResponse, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "not_found" } });
  });

  it("redirects an ordinary local navigation to first-owner setup without exposing bootstrap JSON", async () => {
    const request = {
      headers: { accept: "text/html,application/xhtml+xml" },
      method: "GET",
      url: "/",
    } as IncomingMessage;
    const response = new TestResponse();
    const next = vi.fn();
    const setupUrl = `http://localhost:43100/setup#token=${"a".repeat(48)}`;
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            runnerEnrollmentToken: "r".repeat(48),
            setupUrl,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    await redirectUnclaimedLocalHost(request, response as unknown as ServerResponse, next, {
      fetchImplementation,
    });

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(setupUrl);
    expect(response.body).toBe("");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("leaves claimed, preview, and non-navigation requests on their ordinary routes", async () => {
    const claimedFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            runnerEnrollmentToken: "r".repeat(48),
            setupUrl: null,
          }),
        ),
    );
    const claimedNext = vi.fn();
    await redirectUnclaimedLocalHost(
      {
        headers: { accept: "text/html" },
        method: "GET",
        url: "/",
      } as IncomingMessage,
      new TestResponse() as unknown as ServerResponse,
      claimedNext,
      { fetchImplementation: claimedFetch },
    );
    expect(claimedNext).toHaveBeenCalledOnce();

    for (const request of [
      { headers: { accept: "text/html" }, method: "GET", url: "/?desktop-preview=first-run" },
      { headers: { accept: "application/json" }, method: "GET", url: "/" },
      { headers: { accept: "text/html" }, method: "GET", url: "/invite/example" },
    ]) {
      const next = vi.fn();
      await redirectUnclaimedLocalHost(
        request as IncomingMessage,
        new TestResponse() as unknown as ServerResponse,
        next,
        { fetchImplementation: vi.fn() },
      );
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("fails closed to the app when the Host returns a foreign or malformed setup target", async () => {
    for (const setupUrl of [
      `https://attacker.example/setup#token=${"a".repeat(48)}`,
      `http://localhost:43100/wrong#token=${"a".repeat(48)}`,
      `http://localhost:43100/setup#token=${"a".repeat(48)}&next=foreign`,
      "not-a-url",
    ]) {
      const next = vi.fn();
      await redirectUnclaimedLocalHost(
        {
          headers: { accept: "text/html" },
          method: "GET",
          url: "/",
        } as IncomingMessage,
        new TestResponse() as unknown as ServerResponse,
        next,
        {
          fetchImplementation: async () =>
            new Response(
              JSON.stringify({
                runnerEnrollmentToken: null,
                setupUrl,
              }),
            ),
        },
      );
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("leaves ordinary API traffic to the configured proxy", () => {
    const next = vi.fn();
    rejectSupervisorOnlyRoutes(
      { url: "/v1/bootstrap" } as IncomingMessage,
      new TestResponse() as unknown as ServerResponse,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

class TestResponse extends EventEmitter {
  body = "";
  headers = new Map<string, string>();
  statusCode = 200;

  end(value?: string): this {
    this.body = value ?? "";
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
}
