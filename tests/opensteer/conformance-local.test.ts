import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  opensteerCoreConformanceCases,
  runOpensteerConformanceCase,
  type OpensteerConformanceHarness,
  type OpensteerConformanceUrls,
} from "../../packages/conformance/src/index.js";
import { Opensteer } from "../../packages/opensteer/src/index.js";

let urls: OpensteerConformanceUrls;
let closeServer: (() => Promise<void>) | undefined;
const temporaryRoots: string[] = [];

describe.sequential("Opensteer local conformance", () => {
  beforeAll(async () => {
    const server = await startFixtureServer();
    urls = {
      baseUrl: server.url,
      main: `${server.url}/conformance/main`,
      secondary: `${server.url}/conformance/secondary`,
      scripted: `${server.url}/conformance/scripted`,
    };
    closeServer = server.close;
  });

  afterAll(async () => {
    await closeServer?.();
    await Promise.all(
      temporaryRoots.map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  for (const testCase of opensteerCoreConformanceCases) {
    test(`${testCase.family}: ${testCase.description}`, async () => {
      const harness = await createHarness();
      try {
        const result = await runOpensteerConformanceCase(testCase, harness);
        if (result.status !== "pass") {
          throw result.error ?? new Error(`${testCase.id} returned ${result.status}`);
        }
        expect(result.status).toBe("pass");
      } finally {
        await harness.target.close().catch(() => undefined);
      }
    }, 60_000);
  }
});

async function createHarness(): Promise<OpensteerConformanceHarness> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-conformance-"));
  temporaryRoots.push(rootDir);
  const target = new Opensteer({
    name: "opensteer-local-conformance",
    rootDir,
    browser: "temporary",
    launch: {
      headless: true,
    },
    context: {
      viewport: {
        width: 800,
        height: 600,
      },
    },
  });

  return {
    target,
    urls,
    supports: () => true,
  };
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; min-height: 2200px; }
      button, input, div { font: inherit; }
      #action-button, #hover-target, #text-input, #status, #mirror, #scroll-anchor {
        position: absolute;
        left: 20px;
      }
      #action-button { top: 20px; width: 140px; height: 40px; }
      #hover-target { top: 80px; width: 160px; height: 40px; border: 1px solid #222; display: flex; align-items: center; justify-content: center; }
      #text-input { top: 140px; width: 220px; height: 36px; }
      #status { top: 190px; min-width: 220px; }
      #mirror { top: 220px; min-width: 220px; }
      #scroll-anchor { top: 1800px; width: 200px; height: 40px; background: #eee; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function mainDocument(): string {
  return htmlDocument(
    "Opensteer Conformance Main",
    `
      <button id="action-button" type="button">Main Action</button>
      <div id="hover-target" role="button" tabindex="0">Hover Target</div>
      <input id="text-input" type="text" />
      <div id="status">ready</div>
      <div id="mirror"></div>
      <div id="scroll-anchor">Scroll Anchor</div>
      <script>
        const status = document.getElementById("status");
        const mirror = document.getElementById("mirror");
        document.getElementById("action-button").addEventListener("click", () => {
          status.textContent = "clicked";
        });
        document.getElementById("hover-target").addEventListener("mouseenter", () => {
          status.textContent = "hovered";
        });
        document.getElementById("text-input").addEventListener("input", (event) => {
          mirror.textContent = event.target.value;
        });
      </script>
    `,
  );
}

function secondaryDocument(): string {
  return htmlDocument(
    "Opensteer Conformance Secondary",
    `<div id="secondary-status" style="position:absolute;left:20px;top:20px">secondary</div>`,
  );
}

function scriptedDocument(): string {
  return htmlDocument(
    "Opensteer Conformance Scripted",
    `
      <div id="script-status" style="position:absolute;left:20px;top:20px">scripted</div>
      <script src="/assets/intercept.js"></script>
    `,
  );
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/conformance/main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocument());
    return;
  }

  if (url.pathname === "/conformance/secondary") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(secondaryDocument());
    return;
  }

  if (url.pathname === "/conformance/scripted") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(scriptedDocument());
    return;
  }

  if (url.pathname === "/assets/intercept.js") {
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(`window.__opensteerInterceptValue = "__INTERCEPT_VALUE__";`);
    return;
  }

  if (url.pathname === "/api/network") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(`network:${url.searchParams.get("kind") ?? "unknown"}`);
    return;
  }

  if (url.pathname === "/api/routed") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("original");
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function startFixtureServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve conformance fixture server address");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
