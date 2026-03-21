import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  createNodeLocator,
  createPoint,
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

let fixtureBaseUrl = "";
let closeFixtureServer: (() => Promise<void>) | undefined;

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
    void handleFixtureRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start path parity fixture server");
  }
  fixtureBaseUrl = `http://127.0.0.1:${String(address.port)}`;
  closeFixtureServer = async () => {
    server.close();
    await once(server, "close");
  };
});

afterAll(async () => {
  await closeFixtureServer?.();
});

for (const harness of harnesses) {
  describe.sequential(`${harness.name} DOM path parity`, () => {
    test(
      "builds and replays offscreen main-document paths for click",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(harness, async ({ engine, runtime, pageRef, frameRef }) => {
          const snapshot = await engine.getDomSnapshot({ frameRef });
          const targetNode = expectValue(
            findNodeById(snapshot, "offscreen-button"),
            "offscreen button was not found",
          );
          const path = await runtime.buildPath({
            locator: createLocator(snapshot, targetNode),
          });

          const resolved = await runtime.resolveTarget({
            pageRef,
            method: "click",
            target: { kind: "path", path },
          });
          expect(readIdAttribute(resolved.node)).toBe("offscreen-button");

          await runtime.click({
            pageRef,
            target: { kind: "path", path },
          });

          expect(await readTextById(engine, frameRef, "status")).toBe("offscreen clicked");
        });
      },
    );

    test(
      "builds and replays iframe plus shadow paths for offscreen clicks",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(harness, async ({ engine, runtime, pageRef }) => {
          const childFrame = await waitForChildFrame(engine, pageRef, "/path-parity-child");
          const childSnapshot = await waitForNodeInFrame(engine, childFrame, "child-shadow-button");
          const targetNode = expectValue(
            findNodeById(childSnapshot, "child-shadow-button"),
            "child shadow button was not found",
          );
          const path = await runtime.buildPath({
            locator: createLocator(childSnapshot, targetNode),
          });

          expect(path.context.map((hop) => hop.kind)).toEqual(["iframe", "shadow"]);

          const resolved = await runtime.resolveTarget({
            pageRef,
            method: "click",
            target: { kind: "path", path },
          });
          expect(readIdAttribute(resolved.node)).toBe("child-shadow-button");

          await runtime.click({
            pageRef,
            target: { kind: "path", path },
          });

          expect(await readTextById(engine, childFrame, "child-status")).toBe(
            "child shadow clicked",
          );
        });
      },
    );

    test(
      "builds and replays open-shadow plus iframe paths for clicks",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(
          harness,
          async ({ engine, runtime, pageRef }) => {
            const childFrame = await waitForChildFrame(
              engine,
              pageRef,
              "/path-parity-shadow-host-child?kind=open",
            );
            const childSnapshot = await waitForNodeInFrame(
              engine,
              childFrame,
              "shadow-hosted-button",
            );
            const targetNode = expectValue(
              findNodeById(childSnapshot, "shadow-hosted-button"),
              "shadow-hosted button was not found",
            );
            const path = await runtime.buildPath({
              locator: createLocator(childSnapshot, targetNode),
            });

            expect(path.context.map((hop) => hop.kind)).toEqual(["shadow", "iframe"]);

            const resolved = await runtime.resolveTarget({
              pageRef,
              method: "click",
              target: { kind: "path", path },
            });
            expect(readIdAttribute(resolved.node)).toBe("shadow-hosted-button");

            await runtime.click({
              pageRef,
              target: { kind: "path", path },
            });

            expect(await readTextById(engine, childFrame, "shadow-hosted-status")).toBe(
              "clicked:open",
            );
          },
          "/path-parity-shadow-host-open-main",
        );
      },
    );

    test(
      "replays descendant paths inside shadow-hosted buttons without changing path semantics",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(
          harness,
          async ({ engine, runtime, pageRef }) => {
            const childFrame = await waitForChildFrame(
              engine,
              pageRef,
              "/path-parity-shadow-host-child?kind=open",
            );
            const childSnapshot = await waitForNodeInFrame(
              engine,
              childFrame,
              "shadow-hosted-slot",
            );
            const targetNode = expectValue(
              findNodeById(childSnapshot, "shadow-hosted-slot"),
              "shadow-hosted slot was not found",
            );
            const path = await runtime.buildPath({
              locator: createLocator(childSnapshot, targetNode),
            });

            expect(path.context.map((hop) => hop.kind)).toEqual(["shadow", "iframe"]);

            const resolved = await runtime.resolveTarget({
              pageRef,
              method: "click",
              target: { kind: "path", path },
            });
            expect(readIdAttribute(resolved.node)).toBe("shadow-hosted-slot");

            await runtime.click({
              pageRef,
              target: { kind: "path", path },
            });

            expect(await readTextById(engine, childFrame, "shadow-hosted-status")).toBe(
              "clicked:open",
            );
          },
          "/path-parity-shadow-host-open-main",
        );
      },
    );

    test(
      "builds and replays closed-shadow plus iframe paths for clicks",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(
          harness,
          async ({ engine, runtime, pageRef }) => {
            const childFrame = await waitForChildFrame(
              engine,
              pageRef,
              "/path-parity-shadow-host-child?kind=closed",
            );
            const childSnapshot = await waitForNodeInFrame(
              engine,
              childFrame,
              "shadow-hosted-button",
            );
            const targetNode = expectValue(
              findNodeById(childSnapshot, "shadow-hosted-button"),
              "shadow-hosted button was not found",
            );
            const path = await runtime.buildPath({
              locator: createLocator(childSnapshot, targetNode),
            });

            expect(path.context.map((hop) => hop.kind)).toEqual(["shadow", "iframe"]);

            const resolved = await runtime.resolveTarget({
              pageRef,
              method: "click",
              target: { kind: "path", path },
            });
            expect(readIdAttribute(resolved.node)).toBe("shadow-hosted-button");

            await runtime.click({
              pageRef,
              target: { kind: "path", path },
            });

            expect(await readTextById(engine, childFrame, "shadow-hosted-status")).toBe(
              "clicked:closed",
            );
          },
          "/path-parity-shadow-host-closed-main",
        );
      },
    );

    test(
      "builds and replays open-shadow offscreen paths for input",
      { timeout: 60_000 },
      async () => {
        await withFixturePage(harness, async ({ engine, runtime, pageRef, frameRef }) => {
          const snapshot = await engine.getDomSnapshot({ frameRef });
          const targetNode = expectValue(
            findNodeById(snapshot, "shadow-input"),
            "shadow input was not found",
          );
          const path = await runtime.buildPath({
            locator: createLocator(snapshot, targetNode),
          });

          expect(path.context.map((hop) => hop.kind)).toEqual(["shadow"]);

          const resolved = await runtime.resolveTarget({
            pageRef,
            method: "input",
            target: { kind: "path", path },
          });
          expect(readIdAttribute(resolved.node)).toBe("shadow-input");

          await runtime.input({
            pageRef,
            target: { kind: "path", path },
            text: "path input",
          });

          expect(await readTextById(engine, frameRef, "mirror")).toBe("path input");
          expect(await readTextById(engine, frameRef, "status")).toBe("focused:path input");
        });
      },
    );

    test("builds and replays closed-shadow paths for click", { timeout: 60_000 }, async () => {
      await withFixturePage(harness, async ({ engine, runtime, pageRef, frameRef }) => {
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
    });

    test("builds and replays paths for hover actions", { timeout: 60_000 }, async () => {
      await withFixturePage(harness, async ({ engine, runtime, pageRef, frameRef }) => {
        const snapshot = await engine.getDomSnapshot({ frameRef });
        const targetNode = expectValue(
          findNodeById(snapshot, "hover-target"),
          "hover target was not found",
        );
        const path = await runtime.buildPath({
          locator: createLocator(snapshot, targetNode),
        });

        await runtime.hover({
          pageRef,
          target: { kind: "path", path },
        });

        expect(await readTextById(engine, frameRef, "status")).toBe("hovered");
      });
    });

    test("builds and replays offscreen paths for scroll actions", { timeout: 60_000 }, async () => {
      await withFixturePage(harness, async ({ engine, runtime, pageRef, frameRef }) => {
        const snapshot = await engine.getDomSnapshot({ frameRef });
        const targetNode = expectValue(
          findNodeById(snapshot, "scroll-box"),
          "scroll box was not found",
        );
        const path = await runtime.buildPath({
          locator: createLocator(snapshot, targetNode),
        });

        await runtime.scroll({
          pageRef,
          target: { kind: "path", path },
          delta: createPoint(0, 320),
        });

        await wait(150);

        const status = await readTextById(engine, frameRef, "status");
        expect(status).toMatch(/^scrolled:/);
        expect(Number(status.split(":")[1])).toBeGreaterThan(0);
      });
    });
  });
}

async function withFixturePage(
  harness: EngineHarness,
  callback: (input: {
    readonly engine: BrowserCoreEngine & { dispose(): Promise<void> };
    readonly runtime: ReturnType<typeof createDomRuntime>;
    readonly pageRef: string;
    readonly frameRef: string;
  }) => Promise<void>,
  path: string = "/path-parity-main",
): Promise<void> {
  const engine = await harness.create();
  try {
    const runtime = createDomRuntime({ engine });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${fixtureBaseUrl}${path}`,
    });

    await wait(600);

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
  for (let attempt = 0; attempt < 25; attempt += 1) {
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

async function waitForNodeInFrame(
  engine: BrowserCoreEngine,
  frameRef: string,
  id: string,
): Promise<DomSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const snapshot = await engine.getDomSnapshot({ frameRef });
      if (findNodeById(snapshot, id)) {
        return snapshot;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }

  throw lastError instanceof Error ? lastError : new Error(`node #${id} did not appear`);
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

function readIdAttribute(node: DomSnapshotNode): string | undefined {
  return node.attributes.find((attribute) => attribute.name === "id")?.value;
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

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/path-parity-main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocument());
    return;
  }

  if (url.pathname === "/path-parity-child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(childDocument());
    return;
  }

  if (url.pathname === "/path-parity-shadow-host-open-main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(shadowHostedIframeDocument("open"));
    return;
  }

  if (url.pathname === "/path-parity-shadow-host-closed-main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(shadowHostedIframeDocument("closed"));
    return;
  }

  if (url.pathname === "/path-parity-shadow-host-child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      shadowHostedChildDocument(url.searchParams.get("kind") === "closed" ? "closed" : "open"),
    );
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

function mainDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; height: 2400px; }
      button, input, div, iframe { font: inherit; }
      #status, #mirror {
        position: fixed;
        left: 20px;
        z-index: 1000;
        background: rgba(255, 255, 255, 0.96);
      }
      #status { top: 20px; }
      #mirror { top: 52px; }
      #hover-target,
      #offscreen-button {
        position: absolute;
        left: 20px;
        width: 220px;
        height: 42px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #111;
        background: #f5f5f5;
      }
      #hover-target { top: 140px; }
      #offscreen-button { top: 1700px; }
      #open-shadow-host { position: absolute; left: 20px; top: 1500px; }
      #closed-shadow-host { position: absolute; left: 280px; top: 220px; }
      #scroll-box {
        position: absolute;
        left: 280px;
        top: 1450px;
        width: 240px;
        height: 120px;
        overflow: auto;
        border: 1px solid #111;
      }
      #scroll-spacer { position: relative; height: 960px; }
      iframe {
        position: absolute;
        left: 560px;
        top: 20px;
        width: 420px;
        height: 360px;
        border: 0;
      }
    </style>
  </head>
  <body>
    <div id="status">ready</div>
    <div id="mirror"></div>
    <div id="hover-target" role="button" tabindex="0">Hover Target</div>
    <button id="offscreen-button" type="button">Offscreen Button</button>
    <div id="open-shadow-host"></div>
    <div id="closed-shadow-host"></div>
    <div id="scroll-box">
      <div id="scroll-spacer"></div>
    </div>
    <iframe id="child-frame" src="/path-parity-child"></iframe>
    <script>
      const status = document.getElementById("status");
      const mirror = document.getElementById("mirror");

      document.getElementById("hover-target").addEventListener("mouseenter", () => {
        status.textContent = "hovered";
      });
      document.getElementById("offscreen-button").addEventListener("click", () => {
        status.textContent = "offscreen clicked";
      });

      const scrollBox = document.getElementById("scroll-box");
      scrollBox.addEventListener("scroll", () => {
        status.textContent = "scrolled:" + scrollBox.scrollTop;
      });

      const openHost = document.getElementById("open-shadow-host");
      const openRoot = openHost.attachShadow({ mode: "open" });
      openRoot.innerHTML =
        '<button id="shadow-button" type="button" style="display:block;width:220px;height:42px">Shadow Button</button>' +
        '<input id="shadow-input" type="text" style="display:block;margin-top:16px;width:220px;height:36px" />';
      const shadowInput = openRoot.getElementById("shadow-input");
      shadowInput.addEventListener("focus", () => {
        status.textContent = "focused";
      });
      shadowInput.addEventListener("input", (event) => {
        const value = event.target.value;
        mirror.textContent = value;
        status.textContent =
          (openRoot.activeElement === shadowInput || document.activeElement === openHost
            ? "focused:"
            : "unfocused:") + value;
      });

      const closedHost = document.getElementById("closed-shadow-host");
      const closedRoot = closedHost.attachShadow({ mode: "closed" });
      const closedButton = document.createElement("button");
      closedButton.id = "closed-shadow-button";
      closedButton.type = "button";
      closedButton.textContent = "Closed Shadow";
      closedButton.style.width = "220px";
      closedButton.style.height = "42px";
      closedButton.addEventListener("click", () => {
        status.textContent = "closed shadow clicked";
      });
      closedRoot.append(closedButton);
    </script>
  </body>
</html>`;
}

function childDocument(): string {
  return `<!doctype html>
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
      #child-shadow-host {
        position: relative;
        display: block;
        height: 1900px;
      }
    </style>
  </head>
  <body>
    <div id="child-status">ready</div>
    <div id="child-shadow-host"></div>
    <script>
      const host = document.getElementById("child-shadow-host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML =
        '<button id="child-shadow-button" type="button" style="position:absolute;left:20px;top:1500px;width:220px;height:42px">Child Shadow</button>';
      root.getElementById("child-shadow-button").addEventListener("click", () => {
        document.getElementById("child-status").textContent = "child shadow clicked";
      });
    </script>
  </body>
</html>`;
}

function shadowHostedIframeDocument(mode: "open" | "closed"): string {
  const childUrl = `/path-parity-shadow-host-child?kind=${mode}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      #host {
        display: block;
        width: 520px;
        margin: 24px;
      }
    </style>
  </head>
  <body>
    <div id="host"></div>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "${mode}" });
      const frame = document.createElement("iframe");
      frame.id = "shadow-hosted-frame";
      frame.src = "${childUrl}";
      frame.width = "420";
      frame.height = "220";
      frame.style.border = "0";
      root.append(frame);
    </script>
  </body>
</html>`;
}

function shadowHostedChildDocument(mode: "open" | "closed"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      #shadow-hosted-status {
        position: fixed;
        left: 16px;
        top: 16px;
        background: rgba(255, 255, 255, 0.96);
      }
      #shadow-hosted-button {
        position: absolute;
        left: 16px;
        top: 72px;
        width: 220px;
        height: 42px;
      }
    </style>
  </head>
  <body>
    <div id="shadow-hosted-status">ready</div>
    <button id="shadow-hosted-button" type="button">
      <div id="shadow-hosted-shell">
        <span id="shadow-hosted-label">
          <slot id="shadow-hosted-slot">Shadow Hosted Button</slot>
        </span>
      </div>
    </button>
    <script>
      document.getElementById("shadow-hosted-button").addEventListener("click", () => {
        document.getElementById("shadow-hosted-status").textContent = "clicked:${mode}";
      });
    </script>
  </body>
</html>`;
}
