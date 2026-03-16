import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import type {
  ComputerUseBridge,
  ComputerUseBridgeInput,
} from "../../packages/protocol/src/index.js";
import { OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL } from "../../packages/protocol/src/index.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import {
  bodyPayloadFromUtf8,
  createPoint,
  type DomSnapshotNode,
} from "../../packages/browser-core/src/index.js";
import { defineBrowserCoreConformanceSuite } from "../browser-core/conformance-suite.js";
import { readPngSize } from "../helpers/png.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

interface ComputerUseBridgeResult {
  readonly pageRef: string;
  readonly screenshot: {
    readonly size: {
      readonly width: number;
      readonly height: number;
    };
    readonly payload: {
      readonly bytes: Uint8Array;
    };
  };
  readonly viewport: {
    readonly layoutViewport: {
      readonly size: {
        readonly width: number;
        readonly height: number;
      };
    };
    readonly visualViewport: {
      readonly origin: {
        readonly x: number;
        readonly y: number;
      };
      readonly size: {
        readonly width: number;
        readonly height: number;
      };
    };
  };
  readonly events: readonly {
    readonly kind: string;
  }[];
}

interface BrowserCoreComputerUseBridge {
  execute(input: ComputerUseBridgeInput): Promise<ComputerUseBridgeResult>;
}

const headedChromiumTest =
  process.platform === "linux" && process.env.DISPLAY === undefined ? test.skip : test;

function html(body: string, title: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input, a { font: inherit; }
      #continue { position: absolute; left: 20px; top: 20px; width: 160px; height: 48px; }
      #name { position: absolute; left: 20px; top: 96px; width: 220px; height: 36px; }
      #mirror { position: absolute; left: 20px; top: 150px; }
      .action { position: absolute; left: 20px; width: 220px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #111; background: #f6f6f6; color: #111; text-decoration: none; }
      #popup { top: 20px; }
      #dialog { top: 80px; }
      #fetch { top: 140px; }
      #console { top: 200px; }
      #error { top: 260px; }
      #download { top: 320px; }
      #upload { position: absolute; left: 20px; top: 380px; width: 220px; height: 36px; }
      iframe { position: absolute; left: 280px; top: 20px; width: 280px; height: 120px; border: 1px solid #ccc; }
    </style>
    ${extraHead}
  </head>
  <body>${body}</body>
</html>`;
}

function updatedDomDocument(): string {
  return html(
    `
      <button id="continue" type="button" data-state="updated">Updated</button>
      <input id="name" type="text" autofocus oninput="document.getElementById('mirror').textContent = this.value" />
      <div id="mirror"></div>
    `,
    "DOM page",
  );
}

function domDocument(): string {
  const rewrittenDocument = JSON.stringify(updatedDomDocument());
  return html(
    `
      <button id="continue" type="button">Continue</button>
      <input id="name" type="text" autofocus oninput="document.getElementById('mirror').textContent = this.value" />
      <div id="mirror"></div>
      <script>
        document.getElementById("continue").addEventListener("click", () => {
          document.open();
          document.write(${rewrittenDocument});
          document.close();
        });
      </script>
    `,
    "DOM page",
  );
}

function domFractionalHitDocument(): string {
  return html(
    `
      <button id="fractional-hit" type="button" style="position:absolute;left:20px;top:200px;width:96.75px;height:21px">
        Fractional Hit
      </button>
    `,
    "Fractional hit page",
  );
}

function domDocumentWithChild(): string {
  const rewrittenDocument = JSON.stringify(
    html(
      `
        <button id="rewrite" type="button" data-state="updated">Updated main</button>
        <iframe id="child-frame" src="/dom-child"></iframe>
      `,
      "DOM page with child",
    ),
  );
  return html(
    `
      <button id="rewrite" type="button">Rewrite main</button>
      <iframe id="child-frame" src="/dom-child"></iframe>
      <script>
        document.getElementById("rewrite").addEventListener("click", () => {
          document.open();
          document.write(${rewrittenDocument});
          document.close();
        });
      </script>
    `,
    "DOM page with child",
  );
}

function tallScrollDocument(): string {
  return html(
    `
      <div id="top-band"></div>
      <div id="middle-band"></div>
      <div id="bottom-band"></div>
    `,
    "Tall scroll page",
    `
      <style>
        #top-band, #middle-band, #bottom-band {
          width: 100%;
        }
        #top-band { height: 720px; background: rgb(220, 40, 40); }
        #middle-band { height: 960px; background: rgb(245, 245, 245); }
        #bottom-band { height: 720px; background: rgb(40, 80, 220); }
      </style>
    `,
  );
}

function findNodeById(nodes: readonly DomSnapshotNode[], id: string) {
  return nodes.find((node) =>
    node.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
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

  if (url.pathname === "/dom") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(domDocument());
    return;
  }

  if (url.pathname === "/dom-fractional-hit") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(domFractionalHitDocument());
    return;
  }

  if (url.pathname === "/dom-with-child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(domDocumentWithChild());
    return;
  }

  if (url.pathname === "/dom-child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html('<div id="child-text">Child stable</div>', "Child DOM page"));
    return;
  }

  if (url.pathname === "/tall-scroll") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(tallScrollDocument());
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
          <button id="console" class="action" type="button">Console</button>
          <button id="error" class="action" type="button">Error</button>
          <a id="download" class="action" href="/download" download="sample.txt">Download</a>
          <input id="upload" type="file" multiple />
          <iframe id="storage-child" src="/storage-child"></iframe>
          <script>
            const openDb = () => new Promise((resolve, reject) => {
              const request = indexedDB.open("app-db", 1);
              request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("messages")) {
                  db.createObjectStore("messages", { keyPath: "id" });
                }
              };
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction("messages", "readwrite");
                tx.objectStore("messages").put({ id: "1", text: "hello" });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
              };
            });
            window.addEventListener("load", async () => {
              localStorage.setItem("theme", "dark");
              sessionStorage.setItem("main", "session-main");
              await openDb();
              document.body.dataset.storageReady = "true";
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
            document.getElementById("console").addEventListener("click", () => {
              setTimeout(() => console.warn("warn-event"), 0);
            });
            document.getElementById("error").addEventListener("click", () => {
              setTimeout(() => {
                throw new Error("page boom");
              }, 0);
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

  if (url.pathname === "/download") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-disposition", 'attachment; filename="sample.txt"');
    response.end("download payload");
    return;
  }

  if (url.pathname === "/api/echo") {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("set-cookie", [
      "server-session=abc; Path=/; SameSite=Lax",
      "theme=light; Path=/; SameSite=Lax",
    ]);
    const payload = JSON.stringify({
      echoed: body.toString("utf8"),
      large: "x".repeat(1_100_000),
    });
    response.end(payload);
    return;
  }

  if (url.pathname === "/api/session-transport") {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        method: request.method,
        cookie: request.headers.cookie ?? "",
        body: body.toString("utf8"),
      }),
    );
    return;
  }

  if (url.pathname === "/same-url-history") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <button id="push" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:48px">Push state</button>
          <script>
            let count = 0;
            const render = (value) => {
              document.title = "count:" + value;
              document.getElementById("push").textContent = "count:" + value;
            };
            document.getElementById("push").addEventListener("click", () => {
              count += 1;
              history.pushState({ count }, "", window.location.href);
              render(count);
            });
            window.addEventListener("popstate", (event) => {
              render((event.state && event.state.count) || 0);
            });
            render(0);
          </script>
        `,
        "count:0",
      ),
    );
    return;
  }

  if (url.pathname === "/network-on-close") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <button id="fetch" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:48px">Fetch and close</button>
          <script>
            document.getElementById("fetch").addEventListener("click", () => {
              void fetch("/slow-echo", {
                method: "POST",
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: "close-body"
              });
            });
          </script>
        `,
        "Network close page",
      ),
    );
    return;
  }

  if (url.pathname === "/slow-echo") {
    const body = await readRequestBody(request);
    await wait(300);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ echoed: body.toString("utf8") }));
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
    throw new Error("failed to start test server");
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
  const started = await startServer();
  baseUrl = started.url;
  closeServer = started.close;
}, 30_000);

afterAll(async () => {
  if (closeServer) {
    await closeServer();
  }
});

defineBrowserCoreConformanceSuite({
  name: "PlaywrightBrowserCoreEngine conformance",
  createHarness: async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: {
        headless: true,
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

test(
  "captures DOM snapshots, stale nodes, hit-testing, text input, screenshots, and freeze state",
  { timeout: 60_000 },
  async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });
    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/dom`,
      });

      const initialSnapshot = await engine.getDomSnapshot({
        frameRef: created.frameRef!,
      });
      const continueNode = findNodeById(initialSnapshot.nodes, "continue");
      const continueLocator = {
        documentRef: initialSnapshot.documentRef,
        documentEpoch: initialSnapshot.documentEpoch,
        nodeRef: continueNode?.nodeRef!,
      };

      expect(await engine.readText(continueLocator)).toBe("Continue");

      const initialHit = await engine.hitTest({
        pageRef: created.data.pageRef,
        point: createPoint(40, 40),
        coordinateSpace: "layout-viewport-css",
      });
      const initialHitAttributes = await engine.readAttributes({
        documentRef: initialHit.documentRef,
        documentEpoch: initialHit.documentEpoch,
        nodeRef: initialHit.nodeRef!,
      });
      expect(initialHitAttributes).toContainEqual({ name: "id", value: "continue" });

      await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(40, 40),
        coordinateSpace: "layout-viewport-css",
      });

      await wait(100);
      await expect(engine.readText(continueLocator)).rejects.toMatchObject({
        code: "stale-node-ref",
      });

      const updatedSnapshot = await engine.getDomSnapshot({
        frameRef: created.frameRef!,
      });
      const updatedContinueNode = findNodeById(updatedSnapshot.nodes, "continue");
      expect(updatedSnapshot.documentRef).toBe(initialSnapshot.documentRef);
      expect(updatedSnapshot.documentEpoch).not.toBe(initialSnapshot.documentEpoch);
      expect(updatedContinueNode?.nodeRef).not.toBe(continueLocator.nodeRef);
      expect(updatedContinueNode?.attributes).toContainEqual({
        name: "data-state",
        value: "updated",
      });

      const focusedInput = await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(40, 110),
        coordinateSpace: "layout-viewport-css",
      });
      const inputAttributes = await engine.readAttributes({
        documentRef: focusedInput.data!.documentRef,
        documentEpoch: focusedInput.data!.documentEpoch,
        nodeRef: focusedInput.data!.nodeRef!,
      });
      expect(inputAttributes).toContainEqual({ name: "id", value: "name" });

      await engine.textInput({
        pageRef: created.data.pageRef,
        text: "Tim",
      });
      await wait(100);

      const typedSnapshot = await engine.getDomSnapshot({
        frameRef: created.frameRef!,
      });
      const mirrorNode = findNodeById(typedSnapshot.nodes, "mirror");
      expect(
        await engine.readText({
          documentRef: typedSnapshot.documentRef,
          documentEpoch: typedSnapshot.documentEpoch,
          nodeRef: mirrorNode?.nodeRef!,
        }),
      ).toBe("Tim");

      const screenshot = await engine.captureScreenshot({
        pageRef: created.data.pageRef,
        format: "webp",
      });
      expect(screenshot.data.format).toBe("webp");
      expect(screenshot.data.payload.bytes.byteLength).toBeGreaterThan(0);

      const frozen = await engine.setExecutionState({
        pageRef: created.data.pageRef,
        frozen: true,
      });
      const unfrozen = await engine.setExecutionState({
        pageRef: created.data.pageRef,
        frozen: false,
      });

      expect(frozen.data.frozen).toBe(true);
      expect(unfrozen.data.frozen).toBe(false);
    } finally {
      await engine.dispose();
    }
  },
);

headedChromiumTest(
  "captures computer-use screenshots in the same layout-viewport CSS space as the returned viewport",
  { timeout: 60_000 },
  async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: false },
    });
    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/tall-scroll`,
      });
      const bridge = requireComputerUseBridge(engine);

      const top = await bridge.execute({
        pageRef: created.data.pageRef,
        action: {
          type: "screenshot",
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
      const topRaster = readPngSize(top.screenshot.payload.bytes);

      expect(topRaster).toEqual(top.screenshot.size);
      expect(top.screenshot.size).toEqual(top.viewport.visualViewport.size);
      expect(top.viewport.layoutViewport.size).toEqual(top.viewport.visualViewport.size);

      const scrolled = await bridge.execute({
        pageRef: created.data.pageRef,
        action: {
          type: "scroll",
          x: 40,
          y: 40,
          deltaX: 0,
          deltaY: 1_400,
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
      const scrolledRaster = readPngSize(scrolled.screenshot.payload.bytes);

      expect(scrolledRaster).toEqual(scrolled.screenshot.size);
      expect(scrolled.screenshot.size).toEqual(scrolled.viewport.visualViewport.size);
      expect(scrolled.viewport.layoutViewport.size).toEqual(scrolled.viewport.visualViewport.size);
      expect(scrolled.viewport.visualViewport.origin.y).toBeGreaterThan(
        top.viewport.visualViewport.origin.y,
      );
      expect(
        Buffer.compare(
          Buffer.from(top.screenshot.payload.bytes),
          Buffer.from(scrolled.screenshot.payload.bytes),
        ),
      ).not.toBe(0);
    } finally {
      await engine.dispose();
    }
  },
);

headedChromiumTest(
  "captures viewport screenshots with raster dimensions that match the current visual viewport while leaving full-page capture unchanged",
  { timeout: 60_000 },
  async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: false },
    });
    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/tall-scroll`,
      });

      const viewportScreenshot = await engine.captureScreenshot({
        pageRef: created.data.pageRef,
        format: "png",
      });
      const viewportMetrics = await engine.getViewportMetrics({
        pageRef: created.data.pageRef,
      });
      const viewportRaster = readPngSize(viewportScreenshot.data.payload.bytes);

      expect(viewportRaster).toEqual(viewportScreenshot.data.size);
      expect(viewportScreenshot.data.size).toEqual(viewportMetrics.visualViewport.size);
      expect(viewportMetrics.layoutViewport.size).toEqual(viewportMetrics.visualViewport.size);

      await engine.mouseScroll({
        pageRef: created.data.pageRef,
        point: createPoint(40, 40),
        coordinateSpace: "layout-viewport-css",
        delta: createPoint(0, 1_400),
      });

      const scrolledScreenshot = await engine.captureScreenshot({
        pageRef: created.data.pageRef,
        format: "png",
      });
      const scrolledMetrics = await engine.getViewportMetrics({
        pageRef: created.data.pageRef,
      });
      const scrolledRaster = readPngSize(scrolledScreenshot.data.payload.bytes);

      expect(scrolledRaster).toEqual(scrolledScreenshot.data.size);
      expect(scrolledScreenshot.data.size).toEqual(scrolledMetrics.visualViewport.size);
      expect(scrolledMetrics.layoutViewport.size).toEqual(scrolledMetrics.visualViewport.size);
      expect(scrolledMetrics.visualViewport.origin.y).toBeGreaterThan(
        viewportMetrics.visualViewport.origin.y,
      );
      expect(
        Buffer.compare(
          Buffer.from(viewportScreenshot.data.payload.bytes),
          Buffer.from(scrolledScreenshot.data.payload.bytes),
        ),
      ).not.toBe(0);

      const fullPageScreenshot = await engine.captureScreenshot({
        pageRef: created.data.pageRef,
        format: "png",
        fullPage: true,
      });
      const fullPageRaster = readPngSize(fullPageScreenshot.data.payload.bytes);

      expect(fullPageScreenshot.data.coordinateSpace).toBe("document-css");
      expect(fullPageRaster).toEqual(fullPageScreenshot.data.size);
      expect(fullPageScreenshot.data.size.height).toBeGreaterThan(
        scrolledMetrics.visualViewport.size.height,
      );
    } finally {
      await engine.dispose();
    }
  },
);

test("hitTest rounds fractional CSS coordinates before calling CDP", async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/dom-fractional-hit`,
    });

    const hit = await engine.hitTest({
      pageRef: created.data.pageRef,
      point: createPoint(68.375, 210.5),
      coordinateSpace: "layout-viewport-css",
    });
    const hitAttributes = await engine.readAttributes({
      documentRef: hit.documentRef,
      documentEpoch: hit.documentEpoch,
      nodeRef: hit.nodeRef!,
    });

    expect(hitAttributes).toContainEqual({
      name: "id",
      value: "fractional-hit",
    });
  } finally {
    await engine.dispose();
  }
});

test(
  "keeps iframe locators live when only the main document is rewritten",
  { timeout: 60_000 },
  async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });
    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/dom-with-child`,
      });

      await wait(300);

      const frames = await engine.listFrames({ pageRef: created.data.pageRef });
      const childFrame = frames.find((frame) => !frame.isMainFrame)!;
      const childSnapshot = await engine.getDomSnapshot({
        frameRef: childFrame.frameRef,
      });
      const childNode = findNodeById(childSnapshot.nodes, "child-text");
      const childLocator = {
        documentRef: childSnapshot.documentRef,
        documentEpoch: childSnapshot.documentEpoch,
        nodeRef: childNode?.nodeRef!,
      };

      await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(40, 40),
        coordinateSpace: "layout-viewport-css",
      });
      await wait(150);

      const updatedChildFrame = await engine.getFrameInfo({
        frameRef: childFrame.frameRef,
      });

      expect(updatedChildFrame.documentEpoch).toBe(childSnapshot.documentEpoch);
      expect(await engine.readText(childLocator)).toBe("Child stable");
    } finally {
      await engine.dispose();
    }
  },
);

test(
  "preserves shadow and iframe boundary metadata in DOM snapshots",
  { timeout: 60_000 },
  async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });
    try {
      const sessionRef = await engine.createSession();
      const html = `<!doctype html>
<html>
  <body>
    <div id="host"></div>
    <iframe id="child-frame" src="${baseUrl}/dom-child"></iframe>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="shadow-action" type="button">Shadow</button><div id="nested-host"></div>';
      const nestedHost = root.getElementById("nested-host");
      const nestedRoot = nestedHost.attachShadow({ mode: "open" });
      nestedRoot.innerHTML = '<button id="nested-leaf" type="button">Leaf</button>';
    </script>
  </body>
</html>`;
      const created = await engine.createPage({
        sessionRef,
        url: `data:text/html,${encodeURIComponent(html)}`,
      });

      await wait(400);

      const mainSnapshot = await engine.getDomSnapshot({
        frameRef: created.frameRef!,
      });
      const hostNode = findNodeById(mainSnapshot.nodes, "host")!;
      const shadowNode = findNodeById(mainSnapshot.nodes, "shadow-action")!;
      const nestedHostNode = findNodeById(mainSnapshot.nodes, "nested-host")!;
      const nestedLeafNode = findNodeById(mainSnapshot.nodes, "nested-leaf")!;
      const iframeNode = findNodeById(mainSnapshot.nodes, "child-frame")!;

      expect(mainSnapshot.shadowDomMode).toBe("preserved");
      expect(shadowNode.shadowRootType).toBe("open");
      expect(shadowNode.shadowHostNodeRef).toBe(hostNode.nodeRef);
      expect(nestedHostNode.shadowHostNodeRef).toBe(hostNode.nodeRef);
      expect(nestedLeafNode.shadowHostNodeRef).toBe(nestedHostNode.nodeRef);
      expect(iframeNode.contentDocumentRef).toBeDefined();

      const childSnapshot = await engine.getDomSnapshot({
        documentRef: iframeNode.contentDocumentRef!,
      });
      expect(childSnapshot.parentDocumentRef).toBe(mainSnapshot.documentRef);
    } finally {
      await engine.dispose();
    }
  },
);

test("reports history traversal even when the URL string stays the same", async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/same-url-history`,
    });

    const initialFrame = await engine.getFrameInfo({
      frameRef: created.frameRef!,
    });

    await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(40, 40),
      coordinateSpace: "layout-viewport-css",
    });

    const back = await engine.goBack({ pageRef: created.data.pageRef });
    const afterBackSnapshot = await engine.getDomSnapshot({
      frameRef: created.frameRef!,
    });
    const afterBackNode = findNodeById(afterBackSnapshot.nodes, "push");
    const afterBackText = await engine.readText({
      documentRef: afterBackSnapshot.documentRef,
      documentEpoch: afterBackSnapshot.documentEpoch,
      nodeRef: afterBackNode?.nodeRef!,
    });

    const forward = await engine.goForward({ pageRef: created.data.pageRef });
    const afterForwardSnapshot = await engine.getDomSnapshot({
      frameRef: created.frameRef!,
    });
    const afterForwardNode = findNodeById(afterForwardSnapshot.nodes, "push");
    const afterForwardText = await engine.readText({
      documentRef: afterForwardSnapshot.documentRef,
      documentEpoch: afterForwardSnapshot.documentEpoch,
      nodeRef: afterForwardNode?.nodeRef!,
    });

    expect(back.data).toBe(true);
    expect(forward.data).toBe(true);
    expect(afterBackText).toBe("count:0");
    expect(afterForwardText).toBe("count:1");
    expect(back.documentRef).toBe(initialFrame.documentRef);
    expect(forward.documentRef).toBe(initialFrame.documentRef);
  } finally {
    await engine.dispose();
  }
});

test("captures network, cookies, storage, and async page events", { timeout: 60_000 }, async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/integration`,
    });

    await wait(400);

    const frames = await engine.listFrames({ pageRef: created.data.pageRef });
    const mainFrame = frames.find((frame) => frame.isMainFrame)!;
    const childFrame = frames.find((frame) => !frame.isMainFrame)!;

    await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(50, 40),
      coordinateSpace: "layout-viewport-css",
    });
    await wait(150);
    const popupDrain = await engine.activatePage({ pageRef: created.data.pageRef });
    expect(popupDrain.events.map((event) => event.kind)).toContain("popup-opened");
    expect((await engine.listPages({ sessionRef })).length).toBe(2);

    const dialog = await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(50, 100),
      coordinateSpace: "layout-viewport-css",
    });
    expect(dialog.events.map((event) => event.kind)).toContain("dialog-opened");

    await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(50, 160),
      coordinateSpace: "layout-viewport-css",
    });
    await wait(200);

    const records = await engine.getNetworkRecords({
      sessionRef,
      pageRef: created.data.pageRef,
      includeBodies: true,
    });
    const fetchRecord = records.find((record) => record.url.endsWith("/api/echo"));
    expect(fetchRecord?.status).toBe(200);
    const responseHeaderNames = fetchRecord?.responseHeaders.map((header) =>
      header.name.toLowerCase(),
    );
    expect(responseHeaderNames).toContain("content-type");
    expect(responseHeaderNames?.filter((name) => name === "set-cookie")).toHaveLength(2);
    expect(new TextDecoder().decode(fetchRecord?.requestBody?.bytes)).toBe("hello-network");
    expect(fetchRecord?.responseBody?.truncated).toBe(true);

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
      body: "transport-body",
    });
    expect(JSON.parse(new TextDecoder().decode(transport.data.body!.bytes)).cookie).toContain(
      "server-session=abc",
    );

    const transportRecords = await engine.getNetworkRecords({
      sessionRef,
      pageRef: created.data.pageRef,
      includeBodies: true,
    });
    expect(transportRecords.some((record) => record.url.endsWith("/api/session-transport"))).toBe(
      true,
    );

    const storage = await engine.getStorageSnapshot({
      sessionRef,
    });
    expect(storage.origins[0]?.localStorage).toContainEqual({
      key: "theme",
      value: "dark",
    });
    expect(storage.origins[0]?.indexedDb?.[0]).toMatchObject({
      name: "app-db",
      objectStores: [
        {
          name: "messages",
          records: [{ value: { id: "1", text: "hello" } }],
        },
      ],
    });
    expect(
      storage.sessionStorage?.find((snapshot) => snapshot.frameRef === mainFrame.frameRef)?.entries,
    ).toContainEqual({ key: "main", value: "session-main" });
    expect(
      storage.sessionStorage?.find((snapshot) => snapshot.frameRef === childFrame.frameRef)
        ?.entries,
    ).toContainEqual({ key: "child", value: "session-child" });

    const chooser = await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(60, 390),
      coordinateSpace: "layout-viewport-css",
    });

    const download = await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(60, 340),
      coordinateSpace: "layout-viewport-css",
    });

    const consoleStep = await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(60, 220),
      coordinateSpace: "layout-viewport-css",
    });
    const errorStep = await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(60, 280),
      coordinateSpace: "layout-viewport-css",
    });

    await wait(400);
    const drained = await engine.activatePage({ pageRef: created.data.pageRef });
    const eventKinds = [chooser, download, consoleStep, errorStep, drained].flatMap((step) =>
      step.events.map((event) => event.kind),
    );
    expect(eventKinds).toEqual(
      expect.arrayContaining([
        "chooser-opened",
        "download-started",
        "download-finished",
        "console",
        "page-error",
      ]),
    );
  } finally {
    await engine.dispose();
  }
});

test("does not crash when a page closes with network capture work still in flight", async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/network-on-close`,
    });

    await engine.mouseClick({
      pageRef: created.data.pageRef,
      point: createPoint(40, 40),
      coordinateSpace: "layout-viewport-css",
    });
    await wait(150);
    await engine.closePage({ pageRef: created.data.pageRef });
    await wait(500);

    const records = await engine.getNetworkRecords({
      sessionRef,
      includeBodies: true,
    });
    expect(records.some((record) => record.url.endsWith("/slow-echo"))).toBe(true);
  } finally {
    await engine.dispose();
  }
});

test("computer-use bridge renders annotation and cursor overlays", async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/integration`,
    });
    const bridge = requireComputerUseBridge(engine);

    await bridge.execute({
      pageRef: created.data.pageRef,
      action: {
        type: "move",
        x: 60,
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

    const plain = await bridge.execute({
      pageRef: created.data.pageRef,
      action: {
        type: "screenshot",
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

    const decorated = await bridge.execute({
      pageRef: created.data.pageRef,
      action: {
        type: "screenshot",
      },
      screenshot: {
        format: "png",
        includeCursor: true,
        annotations: ["clickable", "grid"],
      },
      signal: new AbortController().signal,
      remainingMs: () => 10_000,
      policySettle: async () => {},
    });

    expect(
      Buffer.compare(
        Buffer.from(plain.screenshot.payload.bytes),
        Buffer.from(decorated.screenshot.payload.bytes),
      ),
    ).not.toBe(0);
  } finally {
    await engine.dispose();
  }
});

test("computer-use bridge hands off popup pages", async () => {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });
  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}/integration`,
    });
    const bridge = requireComputerUseBridge(engine);

    const popup = await bridge.execute({
      pageRef: created.data.pageRef,
      action: {
        type: "click",
        x: 60,
        y: 40,
      },
      screenshot: {
        format: "png",
        includeCursor: false,
        annotations: [],
      },
      signal: new AbortController().signal,
      remainingMs: () => 10_000,
      policySettle: async () => {
        await wait(150);
      },
    });

    expect(popup.pageRef).not.toBe(created.data.pageRef);
    expect(popup.events.map((event) => event.kind)).toContain("popup-opened");
    expect((await engine.getPageInfo({ pageRef: popup.pageRef })).url).toBe(`${baseUrl}/popup`);
  } finally {
    await engine.dispose();
  }
});

function requireComputerUseBridge(engine: object): BrowserCoreComputerUseBridge {
  const factory = Reflect.get(engine, OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL);
  if (typeof factory !== "function") {
    throw new Error("engine does not expose a computer-use bridge");
  }
  return factory.call(engine) as ComputerUseBridge;
}
