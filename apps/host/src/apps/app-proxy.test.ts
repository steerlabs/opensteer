import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { appOriginResponseHeaders, appRequestBodyMaxBytes, requestAppHttp } from "./app-proxy.js";

it.each([
  [undefined, "private, no-cache"],
  ["public, max-age=60, s-maxage=600", "private, max-age=60"],
  ["no-store", "private, no-store"],
])("keeps app files out of the shared Connect cache: %s", (cacheControl, expected) => {
  const headers = appOriginResponseHeaders(
    {
      "content-type": "text/javascript",
      ...(cacheControl ? { "cache-control": cacheControl } : {}),
    },
    { origin: "https://app.test", parents: [] },
  );
  expect(headers["cache-control"]).toBe(expected);
});

it("injects HTML with exact lengths, strips connection and credential headers, rewrites redirects and streams SSE and binary responses", async () => {
  let seen: import("node:http").IncomingHttpHeaders = {};
  let endSse!: () => void;
  let finishBinary!: () => void;
  let closedSse!: () => void;
  const closed = new Promise<void>((r) => {
    closedSse = r;
  });
  const server = createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      endSse = () => res.end("data: last\n\n");
      req.socket.once("close", closedSse);
      return;
    }
    if (req.url === "/binary") {
      res.write(Buffer.alloc(256 * 1_024, 7));
      finishBinary = () => res.end(Buffer.alloc(768 * 1_024, 7));
      return;
    }
    if (req.url === "/redirect-loopback") {
      res.writeHead(307, { location: `http://${req.headers.host}/settings?q=1#details` });
      res.end();
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/settings", "set-cookie": "secret=x" });
      res.end();
      return;
    }
    if (req.url === "/post") {
      req.resume();
      req.once("end", () => res.end("posted"));
      return;
    }
    if (req.url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.once("end", () => res.end(`${req.method}:${Buffer.concat(chunks).toString()}`));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "content-length": "18",
      connection: "close, x-private",
      "x-private": "secret",
    });
    res.end("<h1>Hello app</h1>");
  });
  const listening = once(server, "listening", { signal: AbortSignal.timeout(3_000) });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const options = {
    connect: async () => ({
      stream: connect({ host: "127.0.0.1", port: address.port }),
      port: address.port,
    }),
    method: "GET",
    prefix: "/v1/apps/app_test/dark/token",
    theme: "dark" as const,
    headers: {
      Cookie: "session=secret",
      Authorization: "Bearer secret",
      Connection: "x-private",
      "X-Private": "secret",
    },
    signal: AbortSignal.timeout(5_000),
  };
  try {
    const html = await requestAppHttp({ ...options, path: "/" });
    const text = await new Response(Readable.toWeb(html.body) as ReadableStream<Uint8Array>).text();
    expect(text).toContain("opensteer-app:ready");
    expect(Number(html.headers["content-length"])).toBe(Buffer.byteLength(text));
    expect(html.headers["x-private"]).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-private"]).toBeUndefined();
    expect(seen["x-forwarded-prefix"]).toBe(options.prefix);
    const redirect = await requestAppHttp({ ...options, path: "/redirect" });
    expect(redirect.headers.location).toBe(options.prefix + "/settings");
    expect(redirect.headers["set-cookie"]).toBeUndefined();
    redirect.body.resume();
    const loopback = await requestAppHttp({ ...options, path: "/redirect-loopback" });
    expect(loopback.headers.location).toBe(options.prefix + "/settings?q=1#details");
    loopback.body.resume();
    const abort = new AbortController();
    const events = await requestAppHttp({ ...options, path: "/events", signal: abort.signal });
    const first = await events.body[Symbol.asyncIterator]().next();
    expect(String(first.value)).toContain("first");
    abort.abort();
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Upstream SSE socket did not close")),
          2_000,
        );
        timer.unref();
      }),
    ]);
    endSse();
    const binary = await requestAppHttp({ ...options, path: "/binary" });
    expect(binary.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-popups",
    );
    const binaryReader = binary.body[Symbol.asyncIterator]();
    const binaryFirst = await binaryReader.next();
    let size = Buffer.byteLength(binaryFirst.value);
    expect(size).toBeGreaterThan(0);
    finishBinary();
    for await (const bytes of { [Symbol.asyncIterator]: () => binaryReader }) size += bytes.length;
    expect(size).toBe(1_024 * 1_024);
    const getWithBody = await requestAppHttp({
      ...options,
      path: "/echo",
      headers: { "content-length": "3" },
      body: Readable.from(["get"]),
      signal: AbortSignal.timeout(1_000),
    });
    expect(
      await new Response(Readable.toWeb(getWithBody.body) as ReadableStream<Uint8Array>).text(),
    ).toBe("GET:get");
    await expect(
      requestAppHttp({
        ...options,
        method: "POST",
        path: "/post",
        body: Readable.from([Buffer.alloc(appRequestBodyMaxBytes + 1)]),
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  } finally {
    await closeHttpServerNow(server);
  }
});

it("returns 413 for an oversized chunked upload without destroying the client's error response", async () => {
  const { request } = await import("node:http");
  const upstream = createServer((req, res) => {
    req.resume();
    req.once("end", () => res.end("accepted"));
  });
  let upstreamPort = 0;
  const host = createServer((req, res) => {
    void requestAppHttp({
      method: "POST",
      path: "/",
      prefix: "/app",
      theme: "dark",
      headers: req.headers,
      body: req,
      signal: AbortSignal.timeout(3_000),
      connect: async () => ({
        stream: connect({ host: "127.0.0.1", port: upstreamPort }),
        port: upstreamPort,
      }),
    }).then(
      (result) => {
        res.writeHead(result.status, result.headers);
        result.body.pipe(res);
      },
      (error) => {
        res.writeHead(error.statusCode ?? 503, { connection: "close" });
        res.end("Rejected upload");
      },
    );
  });
  try {
    const up = once(upstream, "listening", { signal: AbortSignal.timeout(2_000) });
    upstream.listen(0, "127.0.0.1");
    await up;
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No app server port");
    upstreamPort = address.port;
    const listening = once(host, "listening", { signal: AbortSignal.timeout(2_000) });
    host.listen(0, "127.0.0.1");
    await listening;
    const hostAddress = host.address();
    if (!hostAddress || typeof hostAddress === "string") throw new Error("No Host port");
    const outcome = new Promise<number>((resolve, reject) => {
      const upload = request(
        {
          hostname: "127.0.0.1",
          port: hostAddress.port,
          path: "/",
          method: "POST",
          signal: AbortSignal.timeout(3_000),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      upload.once("error", reject);
      const chunk = Buffer.alloc(64 * 1_024);
      let chunks = appRequestBodyMaxBytes / chunk.length + 1;
      const source = new Readable({
        read() {
          if (chunks-- > 0) this.push(chunk);
        },
      });
      source.pipe(upload);
      upload.once("close", () => source.destroy());
    });
    expect(await outcome).toBe(413);
  } finally {
    await closeHttpServerNow(host);
    await closeHttpServerNow(upstream);
  }
});

it("preserves the public app authority for framework Origin and Referer checks", async () => {
  const origin = "https://app.example.test";
  const server = createServer((request, response) => {
    const valid =
      request.headers.origin === `https://${request.headers.host}` &&
      request.headers.referer === `${origin}/form`;
    response.writeHead(valid ? 200 : 403);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(3_000) });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  try {
    const result = await requestAppHttp({
      connect: async () => ({
        stream: connect({ host: "127.0.0.1", port: address.port }),
        port: address.port,
      }),
      method: "POST",
      path: "/submit",
      prefix: "",
      theme: "dark",
      originMode: { origin, parents: [] },
      headers: { origin, referer: `${origin}/form` },
      body: Readable.from(["form=value"]),
      signal: AbortSignal.timeout(3_000),
    });
    result.body.resume();
    expect(result.status).toBe(200);
  } finally {
    await closeHttpServerNow(server);
  }
});
