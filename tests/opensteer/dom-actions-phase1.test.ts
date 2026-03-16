import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  createNodeLocator,
  type BrowserCoreEngine,
  type DomSnapshot,
  type DomSnapshotNode,
} from "../../packages/browser-core/src/index.js";
import { createAbpBrowserCoreEngine } from "../../packages/engine-abp/src/index.js";
import { resolveDefaultAbpExecutablePath } from "../../packages/engine-abp/src/launcher.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { createDomRuntime } from "../../packages/opensteer/src/index.js";

const configuredAbpExecutablePath = process.env.OPENSTEER_ABP_EXECUTABLE;
const configuredBrowserExecutablePath = process.env.OPENSTEER_ABP_BROWSER_EXECUTABLE;
const defaultAbpExecutablePath = resolveDefaultAbpExecutablePath();
const runAbp =
  process.env.OPENSTEER_ABP_E2E !== "0" &&
  (configuredAbpExecutablePath !== undefined ||
    configuredBrowserExecutablePath !== undefined ||
    defaultAbpExecutablePath !== undefined);

let iframeBaseUrl = "";
let closeIframeServer: (() => Promise<void>) | undefined;

interface EngineHarness {
  readonly name: string;
  create(): Promise<BrowserCoreEngine & { dispose(): Promise<void> }>;
}

const harnesses: EngineHarness[] = [
  {
    name: "Playwright",
    create: () =>
      createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      }),
  },
  ...(runAbp
    ? [
        {
          name: "ABP",
          create: () =>
            createAbpBrowserCoreEngine({
              launch: {
                headless: true,
                ...(configuredAbpExecutablePath === undefined
                  ? {}
                  : { abpExecutablePath: configuredAbpExecutablePath }),
                ...(configuredBrowserExecutablePath === undefined
                  ? {}
                  : { browserExecutablePath: configuredBrowserExecutablePath }),
              },
            }),
        } satisfies EngineHarness,
      ]
    : []),
];

beforeAll(async () => {
  const server = createServer((request, response) => {
    void handleIframeRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start iframe fixture server");
  }
  iframeBaseUrl = `http://127.0.0.1:${String(address.port)}`;
  closeIframeServer = async () => {
    server.close();
    await once(server, "close");
  };
});

afterAll(async () => {
  await closeIframeServer?.();
});

for (const harness of harnesses) {
  describe.sequential(`${harness.name} phase-1 DOM actions`, () => {
    test(
      "auto-scrolls to offscreen targets before clicking",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, offscreenClickDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          await runtime.click({
            pageRef,
            target: { kind: "selector", selector: "#offscreen-action" },
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("clicked");
        });
      },
    );

    test(
      "scrolls nested containers before clicking",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, nestedScrollDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          await runtime.click({
            pageRef,
            target: { kind: "selector", selector: "#nested-target" },
          });

          const status = await readTextById(engine, frameRef, "status");
          expect(status).toMatch(/^clicked:/);
          expect(Number(status.split(":")[1])).toBeGreaterThan(0);
        });
      },
    );

    test(
      "retries transient post-scroll obstructions instead of probing a click grid",
      { timeout: 60_000 },
      async () => {
        await withPage(
          harness,
          transientObstructionDocument(),
          async ({ engine, runtime, pageRef, frameRef }) => {
            await runtime.click({
              pageRef,
              target: { kind: "selector", selector: "#obstructed-target" },
            });

            expect(await readTextById(engine, frameRef, "status")).toBe("clicked");
          },
        );
      },
    );

    test(
      "retries after layout shifts replace the live node between resolve and click",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, layoutShiftDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          await runtime.click({
            pageRef,
            target: { kind: "selector", selector: "#shift-target" },
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("clicked");
        });
      },
    );

    test(
      "clicks iframe-contained offscreen targets through the existing locator context hops",
      { timeout: 60_000 },
      async () => {
        await withUrl(harness, `${iframeBaseUrl}/iframe-main`, async ({ engine, runtime, pageRef }) => {
          const childFrame = await waitForChildFrame(engine, pageRef, "/iframe-child");
          const childSnapshot = await waitForNodeInFrame(engine, childFrame, "child-target");
          const childNode = expectValue(findNodeById(childSnapshot, "child-target"), "child target was not found");
          const locator = createLocator(childSnapshot, childNode);
          const anchor = await runtime.buildAnchor({ locator });

          await runtime.click({
            pageRef,
            target: {
              kind: "live",
              locator,
              anchor,
            },
          });

          expect(await readTextById(engine, childFrame, "child-status")).toBe("clicked");
        });
      },
    );

    test(
      "handles open-shadow click and input targets without changing selector/path replay",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, openShadowDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          await runtime.click({
            pageRef,
            target: { kind: "selector", selector: "#shadow-button" },
          });
          await runtime.input({
            pageRef,
            target: { kind: "selector", selector: "#shadow-input" },
            text: "shadow",
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("shadow clicked");
          expect(await readTextById(engine, frameRef, "mirror")).toBe("shadow");
        });
      },
    );

    test(
      "replays closed-shadow paths for action execution",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, closedShadowDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          const snapshot = await engine.getDomSnapshot({ frameRef });
          const targetNode = expectValue(
            findNodeById(snapshot, "closed-shadow-button"),
            "closed shadow button was not found",
          );
          const path = await runtime.buildPath({
            locator: createLocator(snapshot, targetNode),
          });

          expect(path.context.map((hop) => hop.kind)).toEqual(["shadow"]);

          await runtime.click({
            pageRef,
            target: { kind: "path", path },
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("closed shadow clicked");
        });
      },
    );

    test(
      "focuses inputs after scrolling before using keyboard input",
      { timeout: 60_000 },
      async () => {
        await withPage(harness, focusAfterScrollDocument(), async ({ engine, runtime, pageRef, frameRef }) => {
          await runtime.input({
            pageRef,
            target: { kind: "selector", selector: "#focus-input" },
            text: "Opensteer",
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("focused:Opensteer");
          expect(await readTextById(engine, frameRef, "mirror")).toBe("Opensteer");
        });
      },
    );
  });
}

async function withPage(
  harness: EngineHarness,
  document: string,
  callback: (input: {
    readonly engine: BrowserCoreEngine & { dispose(): Promise<void> };
    readonly runtime: ReturnType<typeof createDomRuntime>;
    readonly pageRef: string;
    readonly frameRef: string;
  }) => Promise<void>,
): Promise<void> {
  return withUrl(harness, dataUrl(document), callback);
}

async function withUrl(
  harness: EngineHarness,
  url: string,
  callback: (input: {
    readonly engine: BrowserCoreEngine & { dispose(): Promise<void> };
    readonly runtime: ReturnType<typeof createDomRuntime>;
    readonly pageRef: string;
    readonly frameRef: string;
  }) => Promise<void>,
): Promise<void> {
  const engine = await harness.create();
  try {
    const runtime = createDomRuntime({ engine });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url,
    });

    await wait(300);

    await callback({
      engine,
      runtime,
      pageRef: created.data.pageRef,
      frameRef: expectValue(created.frameRef, "main frame ref missing"),
    });
  } finally {
    await engine.dispose();
  }
}

async function waitForChildFrame(
  engine: BrowserCoreEngine,
  pageRef: string,
  urlSubstring: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const child = (await engine.listFrames({ pageRef })).find(
      (frame) => !frame.isMainFrame && frame.url.includes(urlSubstring),
    );
    if (child) {
      return child.frameRef;
    }
    await wait(100);
  }

  throw new Error("child frame did not appear");
}

async function waitForFrameSnapshot(engine: BrowserCoreEngine, frameRef: string): Promise<DomSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await engine.getDomSnapshot({ frameRef });
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("frame snapshot did not become available");
}

async function waitForNodeInFrame(
  engine: BrowserCoreEngine,
  frameRef: string,
  id: string,
): Promise<DomSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const snapshot = await waitForFrameSnapshot(engine, frameRef);
      if (findNodeById(snapshot, id)) {
        return snapshot;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }

  throw lastError instanceof Error ? lastError : new Error(`node #${id} did not appear in ${frameRef}`);
}

async function readTextById(
  engine: BrowserCoreEngine,
  frameRef: string,
  id: string,
): Promise<string | null> {
  const snapshot = await engine.getDomSnapshot({ frameRef });
  const node = expectValue(findNodeById(snapshot, id), `node #${id} was not found`);
  return engine.readText(createLocator(snapshot, node));
}

function createLocator(snapshot: DomSnapshot, node: DomSnapshotNode) {
  return createNodeLocator(
    snapshot.documentRef,
    snapshot.documentEpoch,
    expectValue(node.nodeRef, `node ${String(node.snapshotNodeId)} is missing a live node ref`),
  );
}

function findNodeById(snapshot: DomSnapshot, id: string): DomSnapshotNode | undefined {
  return snapshot.nodes.find((node) =>
    node.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
  );
}

function expectValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataUrl(document: string): string {
  return `data:text/html,${encodeURIComponent(document)}`;
}

function html(body: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input, div, iframe { font: inherit; }
      #status, #mirror {
        position: fixed;
        left: 20px;
        z-index: 1000;
        background: rgba(255, 255, 255, 0.96);
      }
      #status { top: 20px; }
      #mirror { top: 52px; }
      ${extraStyle}
    </style>
  </head>
  <body>
    <div id="status">ready</div>
    <div id="mirror"></div>
    ${body}
  </body>
</html>`;
}

function offscreenClickDocument(): string {
  return html(
    `
      <button
        id="offscreen-action"
        type="button"
        style="position:absolute;left:20px;top:1700px;width:180px;height:48px"
      >
        Offscreen
      </button>
      <script>
        document.getElementById("offscreen-action").addEventListener("click", () => {
          document.getElementById("status").textContent = "clicked";
        });
      </script>
    `,
    "body { height: 2400px; }",
  );
}

function nestedScrollDocument(): string {
  return html(
    `
      <div
        id="scroller"
        style="position:absolute;left:20px;top:120px;width:260px;height:140px;overflow:auto;border:1px solid #111"
      >
        <div style="height:760px;position:relative">
          <button
            id="nested-target"
            type="button"
            style="position:absolute;left:20px;top:640px;width:180px;height:42px"
          >
            Nested
          </button>
        </div>
      </div>
      <script>
        const scroller = document.getElementById("scroller");
        document.getElementById("nested-target").addEventListener("click", () => {
          document.getElementById("status").textContent = "clicked:" + scroller.scrollTop;
        });
      </script>
    `,
  );
}

function transientObstructionDocument(): string {
  return html(
    `
      <div
        id="overlay"
        style="display:none;position:fixed;left:50%;top:50%;width:240px;height:90px;transform:translate(-50%, -50%);background:#111;opacity:0.75;z-index:999"
      ></div>
      <button
        id="obstructed-target"
        type="button"
        style="position:absolute;left:20px;top:1700px;width:220px;height:46px"
      >
        Retry Me
      </button>
      <script>
        let shown = false;
        const overlay = document.getElementById("overlay");
        window.addEventListener("scroll", () => {
          if (shown) {
            return;
          }
          shown = true;
          overlay.style.display = "block";
          setTimeout(() => {
            overlay.style.display = "none";
          }, 80);
        }, { passive: true });
        document.getElementById("obstructed-target").addEventListener("click", () => {
          document.getElementById("status").textContent = "clicked";
        });
      </script>
    `,
    "body { height: 2400px; }",
  );
}

function layoutShiftDocument(): string {
  return html(
    `
      <div
        id="shift-slot"
        style="position:absolute;left:20px;top:1650px;width:520px;height:100px"
      >
        <button
          id="shift-target"
          type="button"
          style="position:absolute;left:0;top:0;width:180px;height:44px"
        >
          Shift
        </button>
      </div>
      <script>
        let rewritten = false;
        const slot = document.getElementById("shift-slot");
        const wire = () => {
          document.getElementById("shift-target").addEventListener("click", () => {
            document.getElementById("status").textContent = "clicked";
          });
        };
        wire();
        window.addEventListener("scroll", () => {
          if (rewritten) {
            return;
          }
          rewritten = true;
          slot.innerHTML =
            '<button id="shift-target" type="button" style="position:absolute;left:0;top:0;width:180px;height:44px">Shift</button>';
          wire();
        }, { passive: true });
      </script>
    `,
    "body { height: 2400px; }",
  );
}

function openShadowDocument(): string {
  return html(
    `
      <div id="shadow-host" style="position:absolute;left:20px;top:140px"></div>
      <script>
        const host = document.getElementById("shadow-host");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML =
          '<button id="shadow-button" type="button" style="width:180px;height:42px">Shadow Button</button>' +
          '<input id="shadow-input" type="text" style="display:block;margin-top:16px;width:220px;height:36px" />';
        root.getElementById("shadow-button").addEventListener("click", () => {
          document.getElementById("status").textContent = "shadow clicked";
        });
        root.getElementById("shadow-input").addEventListener("input", (event) => {
          document.getElementById("mirror").textContent = event.target.value;
        });
      </script>
    `,
  );
}

function closedShadowDocument(): string {
  return html(
    `
      <div id="closed-shadow-host" style="position:absolute;left:20px;top:140px"></div>
      <script>
        const host = document.getElementById("closed-shadow-host");
        const root = host.attachShadow({ mode: "closed" });
        const button = document.createElement("button");
        button.id = "closed-shadow-button";
        button.type = "button";
        button.textContent = "Closed Shadow Button";
        button.style.width = "220px";
        button.style.height = "42px";
        button.addEventListener("click", () => {
          document.getElementById("status").textContent = "closed shadow clicked";
        });
        root.append(button);
      </script>
    `,
  );
}

function focusAfterScrollDocument(): string {
  return html(
    `
      <input
        id="focus-input"
        type="text"
        style="position:absolute;left:20px;top:1700px;width:240px;height:40px"
      />
      <script>
        const input = document.getElementById("focus-input");
        input.addEventListener("focus", () => {
          document.getElementById("status").textContent = "focused";
        });
        input.addEventListener("input", (event) => {
          const value = event.target.value;
          document.getElementById("mirror").textContent = value;
          document.getElementById("status").textContent =
            (document.activeElement === input ? "focused:" : "unfocused:") + value;
        });
      </script>
    `,
    "body { height: 2400px; }",
  );
}

async function handleIframeRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/iframe-main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <iframe
            id="child-frame"
            src=${JSON.stringify(`${iframeBaseUrl}/iframe-child`)}
            style="position:absolute;left:20px;top:120px;width:420px;height:360px;border:0"
          ></iframe>
        `,
        "body { height: 1200px; }",
      ),
    );
    return;
  }

  if (url.pathname !== "/iframe-child") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; height: 2200px; }
      #child-status {
        position: fixed;
        left: 16px;
        top: 16px;
        background: rgba(255, 255, 255, 0.96);
      }
      #child-target {
        position: absolute;
        left: 20px;
        top: 1500px;
        width: 180px;
        height: 42px;
      }
    </style>
  </head>
  <body>
    <div id="child-status">ready</div>
    <button id="child-target" type="button">Child</button>
    <script>
      document.getElementById("child-target").addEventListener("click", () => {
        document.getElementById("child-status").textContent = "clicked";
      });
    </script>
  </body>
</html>`);
}
