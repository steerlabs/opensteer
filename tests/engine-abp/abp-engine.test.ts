import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { createPoint } from "../../packages/browser-core/src/index.js";
import { createAbpBrowserCoreEngine } from "../../packages/engine-abp/src/index.js";
import { defineBrowserCoreConformanceSuite } from "../browser-core/conformance-suite.js";

const executablePath = process.env.OPENSTEER_ABP_EXECUTABLE;
const runAbp = process.env.OPENSTEER_ABP_E2E === "1" || executablePath !== undefined;

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

function html(body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input, a { font: inherit; }
      #continue { position: absolute; left: 20px; top: 20px; width: 160px; height: 48px; }
      .action { position: absolute; left: 20px; width: 220px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #111; background: #f6f6f6; color: #111; text-decoration: none; }
      #popup { top: 20px; }
      #dialog { top: 80px; }
      #fetch { top: 140px; }
      #picker { top: 200px; }
      iframe { position: absolute; left: 280px; top: 20px; width: 280px; height: 120px; border: 1px solid #ccc; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/basic") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html('<button id="continue" type="button">Continue</button>', "Basic page"));
    return;
  }

  if (url.pathname === "/next") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html('<button id="continue" type="button">Continue</button>', "Next page"));
    return;
  }

  if (url.pathname === "/popup") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html('<button id="continue" type="button">Continue</button>', "Popup page"));
    return;
  }

  if (url.pathname === "/integration") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <button id="popup" class="action" type="button">Popup</button>
          <button id="dialog" class="action" type="button">Dialog</button>
          <button id="fetch" class="action" type="button">Fetch</button>
          <select id="picker" class="action">
            <option value="alpha">Alpha</option>
            <option value="beta" selected>Beta</option>
            <option value="gamma">Gamma</option>
          </select>
          <iframe id="storage-child" src="/storage-child"></iframe>
          <script>
            window.addEventListener("load", () => {
              localStorage.setItem("theme", "dark");
              sessionStorage.setItem("main", "session-main");
            });
            document.getElementById("popup").addEventListener("click", () => {
              window.open("/popup", "_blank");
            });
            document.getElementById("dialog").addEventListener("click", () => {
              alert("hello from dialog");
            });
            document.getElementById("fetch").addEventListener("click", () => {
              void fetch("/api/echo", {
                method: "POST",
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: "hello-network"
              });
            });
          </script>
        `,
        "Integration page",
      ),
    );
    return;
  }

  if (url.pathname === "/storage-child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <div id="child">Child frame</div>
          <script>
            sessionStorage.setItem("child", "session-child");
          </script>
        `,
        "Child storage frame",
      ),
    );
    return;
  }

  if (url.pathname === "/api/echo") {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("set-cookie", [
      "server-session=abc; Path=/; SameSite=Lax",
      "theme=light; Path=/; SameSite=Lax",
    ]);
    response.end(
      JSON.stringify({
        echoed: body.toString("utf8"),
      }),
    );
    return;
  }

  if (url.pathname === "/api/session-transport") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(request.headers.cookie ?? "");
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const nextServer = createServer((request, response) => {
    void handleRequest(request, response);
  });
  nextServer.listen(0, "127.0.0.1");
  await once(nextServer, "listening");
  const address = nextServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start ABP test server");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      nextServer.close();
      await once(nextServer, "close");
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!runAbp) {
    return;
  }
  const started = await startServer();
  baseUrl = started.url;
  closeServer = started.close;
}, 30_000);

afterAll(async () => {
  await closeServer?.();
});

if (runAbp) {
  defineBrowserCoreConformanceSuite({
    name: "AbpBrowserCoreEngine conformance",
    createHarness: async () => {
      const engine = await createAbpBrowserCoreEngine({
        launch: {
          headless: true,
          ...(executablePath === undefined ? {} : { executablePath }),
        },
      });

      return {
        engine,
        urls: {
          initial: `${baseUrl}/basic`,
          sameDocument: `${baseUrl}/basic#details`,
          crossDocument: `${baseUrl}/next`,
          popup: `${baseUrl}/popup`,
        },
        dispose: async () => {
          await engine.dispose();
        },
      };
    },
  });
}

describe.skipIf(!runAbp)("AbpBrowserCoreEngine integration", () => {
  test("captures network, popup, dialog, storage, session HTTP, and execution control", async () => {
    const engine = await createAbpBrowserCoreEngine({
      launch: {
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
      },
    });

    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/integration`,
      });
      await wait(400);

      const popup = await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(60, 40),
        coordinateSpace: "layout-viewport-css",
      });
      expect(popup.events.map((event) => event.kind)).toContain("popup-opened");
      expect((await engine.listPages({ sessionRef })).length).toBe(2);

      const dialog = await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(60, 100),
        coordinateSpace: "layout-viewport-css",
      });
      expect(dialog.events.map((event) => event.kind)).toContain("dialog-opened");

      await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(60, 160),
        coordinateSpace: "layout-viewport-css",
      });
      await wait(1000);

      const network = await engine.getNetworkRecords({
        sessionRef,
        pageRef: created.data.pageRef,
        includeBodies: true,
      });
      const fetchRecord = network.find((record) => record.url.endsWith("/api/echo"));
      expect(fetchRecord?.status).toBe(200);
      expect(new TextDecoder().decode(fetchRecord?.requestBody?.bytes)).toBe("hello-network");

      const cookies = await engine.getCookies({
        sessionRef,
        urls: [`${baseUrl}/integration`],
      });
      expect(cookies.map((cookie) => cookie.name).sort()).toEqual(["server-session", "theme"]);

      const transport = await engine.executeRequest({
        sessionRef,
        request: {
          method: "GET",
          url: `${baseUrl}/api/session-transport`,
        },
      });
      // ABP v0.1.6 curl does not forward cookies from the browser cookie jar.
      expect(transport.data.status).toBe(200);

      const storage = await engine.getStorageSnapshot({
        sessionRef,
      });
      expect(storage.origins[0]?.localStorage).toContainEqual({
        key: "theme",
        value: "dark",
      });
      expect(
        storage.sessionStorage?.some((snapshot) =>
          snapshot.entries.some((entry) => entry.key === "main" && entry.value === "session-main"),
        ),
      ).toBe(true);
      expect(
        storage.sessionStorage?.some((snapshot) =>
          snapshot.entries.some(
            (entry) => entry.key === "child" && entry.value === "session-child",
          ),
        ),
      ).toBe(true);

      const paused = await engine.setExecutionState({
        pageRef: created.data.pageRef,
        paused: true,
      });
      const resumed = await engine.setExecutionState({
        pageRef: created.data.pageRef,
        paused: false,
      });

      expect(paused.data).toEqual({ paused: true, frozen: true });
      expect(paused.events.map((event) => event.kind)).toEqual(["paused", "frozen"]);
      expect(resumed.data).toEqual({ paused: false, frozen: false });
      expect(resumed.events.map((event) => event.kind)).toEqual(["resumed"]);
    } finally {
      await engine.dispose();
    }
  }, 60_000);
});
