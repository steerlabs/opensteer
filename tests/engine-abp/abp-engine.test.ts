import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  bodyPayloadFromUtf8,
  createBodyPayload,
  createPoint,
} from "../../packages/browser-core/src/index.js";
import { createAbpBrowserCoreEngine } from "../../packages/engine-abp/src/index.js";
import { resolveDefaultAbpExecutablePath } from "../../packages/engine-abp/src/launcher.js";
import { createDomRuntime } from "../../packages/opensteer/src/index.js";
import {
  OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL,
  type ComputerUseBridge as BrowserCoreComputerUseBridge,
} from "../../packages/protocol/src/index.js";
import { defineBrowserCoreConformanceSuite } from "../browser-core/conformance-suite.js";

const configuredAbpExecutablePath = process.env.OPENSTEER_ABP_EXECUTABLE;
const configuredBrowserExecutablePath = process.env.OPENSTEER_ABP_BROWSER_EXECUTABLE;
const defaultAbpExecutablePath = resolveDefaultAbpExecutablePath();
const runAbp =
  process.env.OPENSTEER_ABP_E2E !== "0" &&
  (configuredAbpExecutablePath !== undefined ||
    configuredBrowserExecutablePath !== undefined ||
    defaultAbpExecutablePath !== undefined);

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

function basicDocument(): string {
  return html(
    `
      <button id="continue" type="button">Continue</button>
      <h1 id="snapshot-title" style="position:absolute;left:20px;top:96px">Snapshot Heading</h1>
      <div id="hidden-panel" style="display:none">Hidden panel</div>
      <div id="shadow-host" style="position:absolute;left:20px;top:180px"></div>
      <script>
        const host = document.getElementById("shadow-host");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML =
          '<button id="shadow-action" type="button">Shadow Action</button><div id="nested-shadow-host"></div>';
        const nestedHost = root.getElementById("nested-shadow-host");
        const nestedRoot = nestedHost.attachShadow({ mode: "open" });
        nestedRoot.innerHTML = '<button id="nested-shadow-action" type="button">Nested Shadow</button>';
      </script>
    `,
    "Basic page",
  );
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
    response.end(basicDocument());
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

  if (url.pathname === "/timer-ready") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <div id="status">Loading...</div>
          <script>
            setTimeout(() => {
              document.getElementById("status").textContent = "Ready";
            }, 600);
          </script>
        `,
        "Timer ready page",
      ),
    );
    return;
  }

  if (url.pathname === "/delayed-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <button id="continue" type="button">Continue</button>
          <div id="status">Idle</div>
          <script>
            document.getElementById("continue").addEventListener("click", () => {
              document.getElementById("status").textContent = "Working...";
              setTimeout(() => {
                document.getElementById("status").textContent = "Done";
              }, 600);
            });
          </script>
        `,
        "Delayed click page",
      ),
    );
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
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        method: request.method,
        cookie: request.headers.cookie ?? "",
        bodyUtf8: body.toString("utf8"),
        bodyBase64: body.toString("base64"),
      }),
    );
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

function createAbpTestEngine() {
  return createAbpBrowserCoreEngine({
    launch: {
      headless: true,
      ...(configuredAbpExecutablePath === undefined
        ? {}
        : { abpExecutablePath: configuredAbpExecutablePath }),
      ...(configuredBrowserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: configuredBrowserExecutablePath }),
    },
  });
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

describe.sequential("AbpBrowserCoreEngine", () => {
  if (runAbp) {
    defineBrowserCoreConformanceSuite({
      name: "conformance",
      testTimeoutMs: 60_000,
      createHarness: async () => {
        const engine = await createAbpTestEngine();

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

  describe.skipIf(!runAbp)("integration", () => {
    test.sequential(
      "waits for delayed navigation scripts before freezing the page",
      async () => {
        const engine = await createAbpTestEngine();

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({
            sessionRef,
            url: `${baseUrl}/timer-ready`,
          });
          const frames = await engine.listFrames({ pageRef: created.data.pageRef });
          const mainFrame = frames.find((frame) => frame.isMainFrame);
          expect(mainFrame).toBeDefined();

          const snapshot = await engine.getHtmlSnapshot({
            frameRef: mainFrame!.frameRef,
          });
          expect(snapshot.html).toContain("Ready");
          expect(snapshot.html).not.toContain("Loading...");
        } finally {
          await engine.dispose();
        }
      },
      20_000,
    );

    test.sequential(
      "resumes execution state correctly before settling navigate() from a blank tab",
      async () => {
        const engine = await createAbpTestEngine();

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({
            sessionRef,
          });
          const navigation = await engine.navigate({
            pageRef: created.data.pageRef,
            url: `${baseUrl}/timer-ready`,
            timeoutMs: 10_000,
          });

          const snapshot = await engine.getHtmlSnapshot({
            frameRef: navigation.data.mainFrame.frameRef,
          });
          expect(snapshot.html).toContain("Ready");
          expect(snapshot.html).not.toContain("Loading...");
        } finally {
          await engine.dispose();
        }
      },
      20_000,
    );

    test.sequential(
      "waits for delayed click handlers before freezing the page",
      async () => {
        const engine = await createAbpTestEngine();

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({
            sessionRef,
            url: `${baseUrl}/delayed-click`,
          });

          await engine.mouseClick({
            pageRef: created.data.pageRef,
            point: createPoint(80, 40),
            coordinateSpace: "layout-viewport-css",
          });

          const frames = await engine.listFrames({ pageRef: created.data.pageRef });
          const mainFrame = frames.find((frame) => frame.isMainFrame);
          expect(mainFrame).toBeDefined();

          const snapshot = await engine.getHtmlSnapshot({
            frameRef: mainFrame!.frameRef,
          });
          expect(snapshot.html).toContain('<div id="status">Done</div>');
        } finally {
          await engine.dispose();
        }
      },
      20_000,
    );

    test.sequential(
      "waits for delayed click handlers before freezing computer-use results",
      async () => {
        const engine = await createAbpTestEngine();

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({
            sessionRef,
            url: `${baseUrl}/delayed-click`,
          });
          const bridge = requireComputerUseBridge(engine);

          await bridge.execute({
            pageRef: created.data.pageRef,
            action: {
              type: "click",
              x: 80,
              y: 40,
            },
            screenshot: {
              format: "png",
              includeCursor: false,
              annotations: [],
            },
            signal: new AbortController().signal,
            remainingMs: () => 10_000,
            policySettle: async () => {},
          });

          const frames = await engine.listFrames({ pageRef: created.data.pageRef });
          const mainFrame = frames.find((frame) => frame.isMainFrame);
          expect(mainFrame).toBeDefined();

          const snapshot = await engine.getHtmlSnapshot({
            frameRef: mainFrame!.frameRef,
          });
          expect(snapshot.html).toContain('<div id="status">Done</div>');
        } finally {
          await engine.dispose();
        }
      },
      20_000,
    );

    test.sequential(
      "waits for delayed click handlers before freezing DOM runtime actions",
      async () => {
        const engine = await createAbpTestEngine();

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({
            sessionRef,
            url: `${baseUrl}/delayed-click`,
          });
          const runtime = createDomRuntime({ engine });

          await runtime.click({
            pageRef: created.data.pageRef,
            target: { kind: "selector", selector: "#continue" },
          });

          const frames = await engine.listFrames({ pageRef: created.data.pageRef });
          const mainFrame = frames.find((frame) => frame.isMainFrame);
          expect(mainFrame).toBeDefined();

          const snapshot = await engine.getHtmlSnapshot({
            frameRef: mainFrame!.frameRef,
          });
          expect(snapshot.html).toContain('<div id="status">Done</div>');
        } finally {
          await engine.dispose();
        }
      },
      20_000,
    );

    test.sequential(
      "captures network, popup, dialog, storage, session HTTP, and execution control",
      async () => {
        const engine = await createAbpTestEngine();

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
              method: "POST",
              url: `${baseUrl}/api/session-transport`,
              headers: [{ name: "x-test-header", value: "session-http" }],
              body: bodyPayloadFromUtf8("transport-body", {
                mimeType: "text/plain",
              }),
            },
          });
          expect(transport.data.status).toBe(200);
          expect(JSON.parse(new TextDecoder().decode(transport.data.body!.bytes))).toMatchObject({
            method: "POST",
            bodyUtf8: "transport-body",
          });
          expect(JSON.parse(new TextDecoder().decode(transport.data.body!.bytes)).cookie).toContain(
            "server-session=abc",
          );

          const binaryTransport = await engine.executeRequest({
            sessionRef,
            request: {
              method: "POST",
              url: `${baseUrl}/api/session-transport`,
              body: createBodyPayload(new Uint8Array([0x00, 0xff, 0x7f, 0x41]), {
                mimeType: "application/octet-stream",
              }),
            },
          });
          expect(binaryTransport.data.status).toBe(200);
          expect(
            JSON.parse(new TextDecoder().decode(binaryTransport.data.body!.bytes)),
          ).toMatchObject({
            bodyBase64: "AP9/QQ==",
          });

          const host = new URL(baseUrl).hostname;
          const filteredTransport = await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
            hostname: host,
            path: "/api/session-transport",
            method: "po",
            status: "20",
            resourceType: "fetch",
            includeBodies: true,
          });
          expect(filteredTransport).toHaveLength(2);
          expect(
            filteredTransport.every((record) => record.url.includes("/api/session-transport")),
          ).toBe(true);

          const documentOnly = await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
            method: "GET",
            resourceType: "document",
            includeBodies: false,
          });
          expect(documentOnly.some((record) => record.url.endsWith("/integration"))).toBe(true);

          const mismatched = await engine.getNetworkRecords({
            sessionRef,
            requestIds: [filteredTransport[0]!.requestId],
            path: "/api/echo",
            includeBodies: false,
          });
          expect(mismatched).toEqual([]);

          const storage = await engine.getStorageSnapshot({
            sessionRef,
          });
          expect(storage.origins[0]?.localStorage).toContainEqual({
            key: "theme",
            value: "dark",
          });
          expect(
            storage.sessionStorage?.some((snapshot) =>
              snapshot.entries.some(
                (entry) => entry.key === "main" && entry.value === "session-main",
              ),
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
          expect(paused.events.map((event) => event.kind)).toEqual([]);
          expect(resumed.data).toEqual({ paused: false, frozen: false });
          expect(resumed.events.map((event) => event.kind)).toEqual(["resumed"]);
        } finally {
          await engine.dispose();
        }
      },
      60_000,
    );
  });
});

function requireComputerUseBridge(engine: object): BrowserCoreComputerUseBridge {
  const factory = Reflect.get(engine, OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL);
  if (typeof factory !== "function") {
    throw new Error("engine does not expose a computer-use bridge");
  }
  return factory.call(engine) as BrowserCoreComputerUseBridge;
}
