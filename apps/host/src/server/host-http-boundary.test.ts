import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installHostHttpBoundary } from "./host-http-boundary.js";

describe("the Host's HTTP boundary", () => {
  it("renders no response of the Home inside a frame, its API and errors included (D2)", async () => {
    const app = Fastify();
    app.get("/v1/rpc/tasks.page", async () => ({ ok: true }));
    installHostHttpBoundary(app);
    app.get("/v1/realtime-like", async (_request, reply) =>
      reply.header("content-security-policy", "default-src 'none'").send("x"),
    );
    // A page the Home frames itself says by whom it may be framed: that policy stands.
    app.get("/app", async (_request, reply) =>
      reply.header("content-security-policy", "frame-ancestors http://127.0.0.1:4310").send("app"),
    );
    app.get("/boom", async () => {
      throw new Error("failed");
    });
    try {
      for (const url of ["/v1/rpc/tasks.page", "/missing", "/boom"]) {
        const reply = await app.inject({ url });
        expect(reply.headers["x-frame-options"], url).toBe("DENY");
        expect(reply.headers["content-security-policy"], url).toBe("frame-ancestors 'none'");
      }
      const strict = await app.inject({ url: "/v1/realtime-like" });
      expect(strict.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(strict.headers["x-frame-options"]).toBe("DENY");
      const framed = await app.inject({ url: "/app" });
      expect(framed.headers["content-security-policy"]).toBe(
        "frame-ancestors http://127.0.0.1:4310",
      );
      expect(framed.headers["x-frame-options"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
