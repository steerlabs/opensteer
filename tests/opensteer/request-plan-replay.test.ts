import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Opensteer } from "../../packages/opensteer/src/index.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

describe.sequential("network replay", () => {
  beforeAll(async () => {
    const server = createServer((request, response) => {
      void handleRequest(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start request-plan replay fixture server");
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    closeServer = async () => {
      server.close();
      await once(server, "close");
    };
  });

  afterAll(async () => {
    await closeServer?.();
  });

  test("replays captured POST bodies even when the content-type is misleading", async () => {
    const opensteer = new Opensteer({
      workspace: "network-replay-local",
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/request-plan`);
      await opensteer.evaluate("async () => window.runReplayablePost()");

      const { records } = await opensteer.queryNetwork({
        limit: 20,
        includeBodies: true,
      });
      const target = records.find((entry) => entry.url.includes("/api/replayable"));
      if (target === undefined) {
        throw new Error("expected to capture the replayable POST request");
      }

      const detail = await opensteer.network.detail(target.recordId);
      const replay = await opensteer.network.replay(target.recordId);
      expect(replay.response.status).toBe(200);
      expect(replay.data).toMatchObject({
        ok: true,
        echoedQuery: "opensteer",
        echoedLimit: 10,
      });
      expect(detail.summary.method).toBe("POST");
      expect(detail.requestBody?.contentType).toBe("application/x-www-form-urlencoded");
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/request-plan") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html lang="en">
  <body>
    <script>
      window.runReplayablePost = () =>
        fetch("/api/replayable", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: JSON.stringify({
            query: "opensteer",
            limit: 10,
          }),
        }).then((result) => result.json());
    </script>
  </body>
</html>`);
    return;
  }

  if (url.pathname === "/api/replayable") {
    const body = await readBody(request);
    const parsed = JSON.parse(body) as {
      readonly query?: string;
      readonly limit?: number;
    };
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        ok: true,
        echoedQuery: parsed.query ?? null,
        echoedLimit: parsed.limit ?? null,
        contentType: request.headers["content-type"] ?? null,
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
