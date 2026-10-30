import Fastify from "fastify";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hostApi } from "@opensteer/protocol";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { compressedReads, registerResponseCompression } from "./response-compression.js";

const data = {
  ok: true,
  data: {
    tasks: [],
    readStates: [],
    window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
  },
  padding: "x".repeat(2048),
};

async function server() {
  const app = Fastify();
  await registerResponseCompression(app);
  for (const [name, declaration] of Object.entries(hostApi)) {
    app.route({
      method: declaration.method,
      url: `/v1/rpc/${name}`,
      handler: () => data,
    });
  }
  app.get("/oauth/token", () => data);
  app.get("/v1/shell", () => data);
  return app;
}

describe("Host response compression", () => {
  it.each(["gzip", "br"])("negotiates %s for large JSON reads", async (encoding) => {
    const app = await server();
    try {
      for (const name of compressedReads) {
        const response = await app.inject({
          method: hostApi[name].method,
          url: `/v1/rpc/${name}`,
          headers: { "accept-encoding": encoding },
        });
        expect(response.headers["content-encoding"]).toBe(encoding);
        expect(String(response.headers.vary).toLowerCase()).toContain("accept-encoding");
        expect(
          JSON.parse(
            (encoding === "gzip" ? gunzipSync : brotliDecompressSync)(
              response.rawPayload,
            ).toString(),
          ),
        ).toEqual(data);
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    ["gzip, br", "br"],
    ["br;q=0, gzip", "gzip"],
    ["deflate", "deflate"],
    ["identity", undefined],
  ])("honors negotiation %s", async (accepted, expected) => {
    const app = await server();
    try {
      const response = await app.inject({
        url: "/v1/rpc/tasks.list",
        headers: { "accept-encoding": accepted! },
      });
      expect(response.headers["content-encoding"]).toBe(expected);
    } finally {
      await app.close();
    }
  });

  it("keeps identity and small JSON responses varied", async () => {
    const app = await server();
    try {
      const response = await app.inject("/v1/rpc/tasks.list");
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.json()).toEqual(data);
      expect(String(response.headers.vary).toLowerCase()).toContain("accept-encoding");
    } finally {
      await app.close();
    }
    const small = Fastify();
    await registerResponseCompression(small);
    small.get("/v1/rpc/tasks.list", () => ({ ok: true }));
    try {
      const response = await small.inject({
        url: "/v1/rpc/tasks.list",
        headers: { "accept-encoding": "gzip" },
      });
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(String(response.headers.vary).toLowerCase()).toContain("accept-encoding");
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await small.close();
    }
  });

  it("leaves every other RPC and machine/auth route uncompressed", async () => {
    const app = await server();
    try {
      for (const [name, declaration] of Object.entries(hostApi)) {
        if (compressedReads.has(name as keyof typeof hostApi)) continue;
        const response = await app.inject({
          method: declaration.method,
          url: `/v1/rpc/${name}`,
          headers: { "accept-encoding": "br, gzip" },
        });
        expect(response.headers["content-encoding"], name).toBeUndefined();
        expect(response.json()).toEqual(data);
      }
      for (const url of ["/oauth/token", "/v1/shell"]) {
        const response = await app.inject({ url, headers: { "accept-encoding": "gzip" } });
        expect(response.headers["content-encoding"]).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it.each(["range", "length", "partial", "cookie", "stream", "sse", "binary", "upgrade"])(
    "does not compress %s responses even on an allowed route",
    async (kind) => {
      const app = Fastify();
      await registerResponseCompression(app);
      app.get("/v1/rpc/tasks.list", (_request, reply) => {
        if (kind === "length")
          void reply.header("content-length", Buffer.byteLength(JSON.stringify(data)));
        if (kind === "cookie") void reply.header("set-cookie", "session=secret");
        if (kind === "partial") void reply.code(206).header("content-range", "bytes 0-2047/4096");
        if (kind === "sse") return reply.type("text/event-stream").send(JSON.stringify(data));
        if (kind === "stream")
          return reply.type("application/json").send(Readable.from([JSON.stringify(data)]));
        if (kind === "binary")
          return reply.type("application/json").send(Buffer.from(JSON.stringify(data)));
        return data;
      });
      try {
        const response = await app.inject({
          url: "/v1/rpc/tasks.list",
          headers: {
            "accept-encoding": "gzip",
            ...(kind === "range" ? { range: "bytes=0-2047" } : {}),
            ...(kind === "upgrade" ? { upgrade: "websocket" } : {}),
          },
        });
        expect(response.headers["content-encoding"]).toBeUndefined();
        expect(response.body).toBe(JSON.stringify(data));
      } finally {
        await app.close();
      }
    },
  );

  it.each(["gzip", "br"])("decodes %s with the shared client with real fetch", async (encoding) => {
    const app = await server();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const client = createHttpHostApiClient({
        baseUrl: new URL(app.listeningOrigin),
        fetch: async (url, init) => {
          const response = await fetch(url, {
            ...init,
            headers: { ...init?.headers, "accept-encoding": encoding },
          });
          expect(response.headers.get("content-encoding")).toBe(encoding);
          return response;
        },
        onAuthenticationRequired: () => {},
      });
      expect(await client["tasks.list"]({})).toEqual({ ok: true, data: data.data });
    } finally {
      await app.close();
    }
  });
});
