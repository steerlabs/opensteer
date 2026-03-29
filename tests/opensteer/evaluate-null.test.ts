import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { Opensteer } from "../../packages/opensteer/src/index.js";

const temporaryRoots: string[] = [];

describe.sequential("page.evaluate null normalization", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryRoots.map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  test(
    "returns null for side-effect-only scripts and preserves later reads",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-evaluate-null-"));
      temporaryRoots.push(rootDir);

      const server = createServer((request, response) => {
        void handleRequest(request.url ?? "/", response);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to resolve evaluate fixture server address");
      }

      const opensteer = new Opensteer({
        name: "evaluate-null-local",
        rootDir,
        browser: "temporary",
        launch: {
          headless: true,
        },
      });

      try {
        await opensteer.open(`http://127.0.0.1:${String(address.port)}/`);

        const sideEffectOnly = await opensteer.evaluate(
          "() => { window.__opensteerEvaluateSideEffect = 'done'; }",
        );
        expect(sideEffectOnly).toBeNull();

        const readback = await opensteer.evaluate(
          "() => ({ sideEffect: window.__opensteerEvaluateSideEffect ?? null })",
        );
        expect(readback).toMatchObject({
          sideEffect: "done",
        });
      } finally {
        await opensteer.close().catch(() => undefined);
        server.close();
        await once(server, "close").catch(() => undefined);
      }
    },
    60_000,
  );
});

async function handleRequest(pathname: string, response: import("node:http").ServerResponse) {
  const url = new URL(pathname, "http://127.0.0.1");
  if (url.pathname === "/") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html lang="en">
  <body>
    <div>evaluate fixture</div>
  </body>
</html>`);
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}
