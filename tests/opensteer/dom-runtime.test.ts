import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type BrowserCoreEngine,
  createNodeLocator,
  createPoint,
  type DomSnapshot,
  type DomSnapshotNode,
} from "../../packages/browser-core/src/index.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import {
  buildArrayFieldPathCandidates,
  buildPathSelectorHint,
  createDomRuntime,
  createFilesystemOpensteerRoot,
  defaultPolicy,
  normalizeExtractedValue,
  resolveExtractedValueInContext,
  sanitizeElementPath,
  type ElementPath,
} from "../../packages/opensteer/src/index.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const temporaryRoots: string[] = [];

function html(body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; height: 2400px; }
      button, input, a, div { font: inherit; }
      #main-action, #hover-target, #rewrite, #descriptor-button {
        position: absolute;
        left: 20px;
        width: 180px;
        height: 42px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #111;
        background: #f5f5f5;
      }
      #main-action { top: 20px; }
      #hover-target { top: 80px; }
      #rewrite { top: 140px; }
      #descriptor-slot { position: absolute; left: 20px; top: 200px; }
      #status { position: absolute; left: 20px; top: 260px; min-width: 220px; }
      #shadow-host { position: absolute; left: 260px; top: 20px; }
      iframe { position: absolute; left: 520px; top: 20px; width: 420px; height: 360px; border: 0; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function mainDocument(): string {
  return html(
    `
      <button id="main-action" type="button">Main Action</button>
      <div id="hover-target" role="button" tabindex="0">Hover Target</div>
      <button id="rewrite" type="button">Rewrite Descriptor</button>
      <div id="descriptor-slot">
        <button id="descriptor-button" data-testid="descriptor-button" type="button">Descriptor V1</button>
      </div>
      <div id="status">ready</div>
      <div id="shadow-host"></div>
      <div id="closed-shadow-host" style="position:absolute;left:260px;top:120px"></div>
      <iframe id="child-frame" src="/runtime/child"></iframe>
      <script>
        const status = document.getElementById("status");
        document.getElementById("main-action").addEventListener("click", () => {
          status.textContent = "main clicked";
        });
        document.getElementById("hover-target").addEventListener("mouseenter", () => {
          status.textContent = "hovered";
        });
        const wireDescriptorButton = (label) => {
          document.getElementById("descriptor-button").addEventListener("click", () => {
            status.textContent = "descriptor clicked " + label;
          });
        };
        wireDescriptorButton("v1");
        document.getElementById("rewrite").addEventListener("click", () => {
          document.getElementById("descriptor-slot").innerHTML =
            '<div class="wrapper"><button id="descriptor-button" data-testid="descriptor-button" type="button">Descriptor V2</button></div>';
          wireDescriptorButton("v2");
        });

        const shadowHost = document.getElementById("shadow-host");
        const shadowRoot = shadowHost.attachShadow({ mode: "open" });
        shadowRoot.innerHTML =
          '<button id="shadow-action" data-testid="shadow-action" type="button" style="width:180px;height:42px">Shadow Action</button><div id="nested-shadow-host"></div>';
        shadowRoot.getElementById("shadow-action").addEventListener("click", () => {
          status.textContent = "shadow clicked";
        });
        const nestedHost = shadowRoot.getElementById("nested-shadow-host");
        const nestedRoot = nestedHost.attachShadow({ mode: "open" });
        nestedRoot.innerHTML =
          '<button id="nested-shadow-action" type="button" style="width:180px;height:42px">Nested Shadow</button>';
        nestedRoot.getElementById("nested-shadow-action").addEventListener("click", () => {
          status.textContent = "nested shadow clicked";
        });

        const closedHost = document.getElementById("closed-shadow-host");
        const closedRoot = closedHost.attachShadow({ mode: "closed" });
        const closedButton = document.createElement("button");
        closedButton.id = "closed-shadow-action";
        closedButton.type = "button";
        closedButton.textContent = "Closed Shadow";
        closedButton.style.width = "180px";
        closedButton.style.height = "42px";
        closedButton.addEventListener("click", () => {
          status.textContent = "closed shadow clicked";
        });
        closedRoot.append(closedButton);
      </script>
    `,
    "DOM runtime main",
  );
}

function childDocument(): string {
  return html(
    `
      <button id="child-action" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Child Action</button>
      <input id="child-input" type="text" style="position:absolute;left:20px;top:80px;width:220px;height:36px" />
      <div id="mirror" style="position:absolute;left:20px;top:130px"></div>
      <a id="child-link" href="/child-relative" style="position:absolute;left:20px;top:170px">Child Link</a>
      <img id="child-image" srcset="/small.png 320w, /large.png 1280w" alt="image" style="position:absolute;left:20px;top:210px;width:120px;height:80px" />
      <a id="child-ping" href="#noop" ping="/ping-one /ping-two" style="position:absolute;left:20px;top:310px">Ping</a>
      <ul id="child-list" style="position:absolute;left:220px;top:20px;margin:0;padding:0;list-style:none">
        <li class="card"><a class="title" href="/item-1">One</a></li>
        <li class="card"><a class="title" href="/item-2">Two</a></li>
      </ul>
      <div id="child-status" style="position:absolute;left:20px;top:340px">child ready</div>
      <div id="child-shadow-host" style="position:absolute;left:220px;top:120px"></div>
      <script>
        const childStatus = document.getElementById("child-status");
        document.getElementById("child-action").addEventListener("click", () => {
          childStatus.textContent = "child clicked";
        });
        document.getElementById("child-input").addEventListener("input", (event) => {
          document.getElementById("mirror").textContent = event.target.value;
        });
        const childHost = document.getElementById("child-shadow-host");
        const childRoot = childHost.attachShadow({ mode: "open" });
        childRoot.innerHTML =
          '<button id="child-shadow-action" type="button" style="width:180px;height:42px">Child Shadow</button>';
        childRoot.getElementById("child-shadow-action").addEventListener("click", () => {
          childStatus.textContent = "child shadow clicked";
        });
      </script>
    `,
    "DOM runtime child",
  );
}

function findNodeById(nodes: readonly DomSnapshotNode[], id: string): DomSnapshotNode | undefined {
  return nodes.find((node) =>
    node.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
  );
}

function createLocator(snapshot: DomSnapshot, node: DomSnapshotNode) {
  return createNodeLocator(
    snapshot.documentRef,
    snapshot.documentEpoch,
    requireValue(node.nodeRef, `node ${String(node.snapshotNodeId)} is missing a live node ref`),
  );
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/runtime/main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocument());
    return;
  }

  if (url.pathname === "/runtime/child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(childDocument());
    return;
  }

  if (
    url.pathname === "/child-relative" ||
    url.pathname === "/item-1" ||
    url.pathname === "/item-2" ||
    url.pathname === "/ping-one" ||
    url.pathname === "/ping-two"
  ) {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(url.pathname);
    return;
  }

  if (url.pathname === "/small.png" || url.pathname === "/large.png") {
    response.setHeader("content-type", "image/png");
    response.end(Buffer.from([137, 80, 78, 71]));
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

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-phase5-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataUrl(document: string): string {
  return `data:text/html,${encodeURIComponent(document)}`;
}

async function createDelayedDomSnapshotEngine(delayMs: number) {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });

  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "getDomSnapshot" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        await wait(delayMs);
        return value.apply(target, args);
      };
    },
  }) as BrowserCoreEngine & {
    dispose?: () => Promise<void>;
  };
}

beforeAll(async () => {
  const started = await startServer();
  baseUrl = started.url;
  closeServer = started.close;
}, 30_000);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (closeServer) {
    await closeServer();
  }
});

describe("Phase 5 DOM runtime utilities", () => {
  test("normalizes extracted values and relaxed array candidates with old semantics", () => {
    expect(normalizeExtractedValue(" /one 320w, /two 1280w ", "srcset")).toBe("/two");
    expect(normalizeExtractedValue(" /ping-one /ping-two ", "ping")).toBe("/ping-one");
    expect(
      resolveExtractedValueInContext("/child-relative", {
        attribute: "href",
        baseURI: `${baseUrl}/runtime/child`,
        insideIframe: true,
      }),
    ).toBe(`${baseUrl}/child-relative`);

    const fieldPath: ElementPath = {
      resolution: "deterministic",
      context: [],
      nodes: [
        {
          tag: "a",
          attrs: { class: "title" },
          position: { nthChild: 3, nthOfType: 1 },
          match: [
            { kind: "attr", key: "class", op: "exact", value: "title" },
            { kind: "position", axis: "nthChild" },
          ],
        },
      ],
    };

    expect(buildArrayFieldPathCandidates(fieldPath)).toEqual([
      'a[class~="title"]:nth-child(3)',
      'a[class~="title"]',
    ]);
  });

  test("sanitizes element paths with stable deferred id clauses preserved", () => {
    const sanitized = sanitizeElementPath({
      resolution: "deterministic",
      context: [],
      nodes: [
        {
          tag: "button",
          attrs: {
            class: "primary action",
            id: "main-button",
            style: "display:none",
          },
          position: {
            nthChild: 0,
            nthOfType: 0,
          },
        },
      ],
    });

    expect(sanitized.nodes[0]).toEqual({
      tag: "button",
      attrs: {
        class: "primary action",
        id: "main-button",
      },
      position: {
        nthChild: 1,
        nthOfType: 1,
      },
      match: [
        { kind: "attr", key: "class", op: "exact", value: "primary action" },
        { kind: "position", axis: "nthOfType" },
        { kind: "position", axis: "nthChild" },
        { kind: "attr", key: "id", op: "exact" },
      ],
    });
  });
});

describe("Phase 5 DOM runtime integration", () => {
  test(
    "builds and resolves iframe plus shadow paths exactly enough for replay",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });
      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(500);

        const frames = await engine.listFrames({ pageRef: created.data.pageRef });
        const childFrame = requireValue(
          frames.find((frame) => !frame.isMainFrame),
          "child frame not found",
        );
        const childSnapshot = await engine.getDomSnapshot({
          frameRef: childFrame.frameRef,
        });
        const childShadowNode = requireValue(
          findNodeById(childSnapshot.nodes, "child-shadow-action"),
          "child shadow action not found",
        );

        const path = await runtime.buildPath({
          locator: createLocator(childSnapshot, childShadowNode),
        });

        expect(path.context.map((hop) => hop.kind)).toEqual(["iframe", "shadow"]);

        const resolved = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "path", path },
        });

        expect(resolved.node.attributes.find((attribute) => attribute.name === "id")?.value).toBe(
          "child-shadow-action",
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "replays closed-shadow paths and actions through the existing shadow context hops",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });
      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(500);

        const snapshot = await engine.getDomSnapshot({
          frameRef: requireValue(created.frameRef, "main frame ref missing"),
        });
        const closedShadowNode = requireValue(
          findNodeById(snapshot.nodes, "closed-shadow-action"),
          "closed shadow action not found",
        );
        const locator = createLocator(snapshot, closedShadowNode);
        const path = await runtime.buildPath({ locator });

        expect(path.context.map((hop) => hop.kind)).toEqual(["shadow"]);

        const resolved = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "path", path },
        });

        expect(resolved.node.attributes.find((attribute) => attribute.name === "id")?.value).toBe(
          "closed-shadow-action",
        );

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "path", path },
        });

        const latestSnapshot = await engine.getDomSnapshot({
          frameRef: requireValue(created.frameRef, "main frame ref missing"),
        });
        const statusNode = requireValue(
          findNodeById(latestSnapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(latestSnapshot, statusNode))).toBe(
          "closed shadow clicked",
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "buildPath falls back to id-like attributes when weaker primary attributes are not unique",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });
      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(400);

        const frames = await engine.listFrames({ pageRef: created.data.pageRef });
        const mainFrame = requireValue(
          frames.find((frame) => frame.isMainFrame),
          "main frame not found",
        );
        const snapshot = await engine.getDomSnapshot({
          frameRef: mainFrame.frameRef,
        });
        const mainAction = requireValue(
          findNodeById(snapshot.nodes, "main-action"),
          "main action not found",
        );

        const path = await runtime.buildPath({
          locator: createLocator(snapshot, mainAction),
        });

        expect(buildPathSelectorHint(path)).toBe("button#main-action");

        const resolved = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "path", path },
        });

        expect(resolved.node.attributes).toContainEqual({
          name: "id",
          value: "main-action",
        });
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "resolves stale live locators through structural anchors when the replacement keeps the same structure",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });
      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="replace" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Replace</button>
                <div id="slot" style="position:absolute;left:20px;top:80px">
                  <button id="target" class="target" type="button" style="width:160px;height:40px">Target V1</button>
                </div>
                <div id="status" style="position:absolute;left:20px;top:140px">ready</div>
                <script>
                  const status = document.getElementById("status");
                  const wire = (label) => {
                    document.getElementById("target").addEventListener("click", () => {
                      status.textContent = "clicked " + label;
                    });
                  };
                  wire("v1");
                  document.getElementById("replace").addEventListener("click", () => {
                    document.getElementById("slot").innerHTML =
                      '<button id="target" class="target" type="button" style="width:160px;height:40px">Target V2</button>';
                    wire("v2");
                    status.textContent = "replaced";
                  });
                </script>
              `,
              "DOM runtime live anchor fallback",
            ),
          ),
        });

        await wait(300);

        const snapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const targetNode = requireValue(
          findNodeById(snapshot.nodes, "target"),
          "target node missing",
        );
        const locator = createLocator(snapshot, targetNode);
        const anchor = await runtime.buildAnchor({ locator });

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#replace" },
        });
        await wait(150);

        await expect(runtime.buildPath({ locator })).rejects.toThrow(/stale|not found/i);

        const resolvedLive = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "live", locator, anchor },
        });
        const resolvedAnchor = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "anchor", anchor },
        });

        expect(
          resolvedLive.node.attributes.find((attribute) => attribute.name === "id")?.value,
        ).toBe("target");
        expect(
          resolvedAnchor.node.attributes.find((attribute) => attribute.name === "id")?.value,
        ).toBe("target");

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "live", locator, anchor },
        });
        await wait(100);

        const latestSnapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const statusNode = requireValue(
          findNodeById(latestSnapshot.nodes, "status"),
          "status missing",
        );
        expect(await engine.readText(createLocator(latestSnapshot, statusNode))).toBe("clicked v2");
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "persists selector descriptors and replays them after a same-document rewrite",
    { timeout: 60_000 },
    async () => {
      const rootPath = await createTemporaryRoot();
      const root = await createFilesystemOpensteerRoot({ rootPath });
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({
          engine,
          root,
          namespace: "phase5-runtime",
        });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(400);

        await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: {
            kind: "selector",
            selector: '[data-testid="descriptor-button"]',
            description: "descriptor button",
          },
        });
        const stored = await runtime.readDescriptor({ description: "descriptor button" });
        expect(stored?.payload.description).toBe("descriptor button");

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#rewrite" },
        });
        await wait(150);

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "descriptor", description: "descriptor button" },
        });

        const snapshot = await engine.getDomSnapshot({
          frameRef: requireValue(created.frameRef, "main frame ref missing"),
        });
        const statusNode = requireValue(
          findNodeById(snapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(snapshot, statusNode))).toBe(
          "descriptor clicked v2",
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "keeps deterministic replay strict after structural drift",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="drift" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Drift</button>
                <div id="slot" style="position:absolute;left:20px;top:80px">
                  <button class="choice" type="button" style="width:160px;height:40px">Only choice</button>
                </div>
                <script>
                  document.getElementById("drift").addEventListener("click", () => {
                    document.getElementById("slot").innerHTML =
                      '<div class="wrapper"><button class="choice" type="button" style="width:160px;height:40px">Wrapped choice A</button></div>' +
                      '<div class="wrapper"><button class="choice" type="button" style="width:160px;height:40px">Wrapped choice B</button></div>';
                  });
                </script>
              `,
              "DOM runtime replay drift",
            ),
          ),
        });

        await wait(300);

        const snapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const targetNode = requireValue(
          snapshot.nodes.find(
            (node) =>
              node.nodeName.toLowerCase() === "button" &&
              node.attributes.some(
                (attribute) => attribute.name === "class" && attribute.value === "choice",
              ),
          ),
          "choice button missing",
        );
        const path = await runtime.buildPath({
          locator: createLocator(snapshot, targetNode),
        });

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#drift" },
        });
        await wait(150);

        await expect(
          runtime.resolveTarget({
            pageRef: created.data.pageRef,
            method: "click",
            target: { kind: "path", path },
          }),
        ).rejects.toMatchObject({
          name: "ElementPathError",
          code: "ERR_PATH_TARGET_NOT_UNIQUE",
        });
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "resolves explicit selectors directly even when a stored descriptor already exists",
    { timeout: 60_000 },
    async () => {
      const rootPath = await createTemporaryRoot();
      const root = await createFilesystemOpensteerRoot({ rootPath });
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({
          engine,
          root,
          namespace: "phase5-precedence",
        });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="old" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Old</button>
                <button id="new" type="button" style="position:absolute;left:20px;top:80px;width:160px;height:40px">New</button>
              `,
              "DOM runtime precedence",
            ),
          ),
        });

        await wait(300);

        const first = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "selector", selector: "#old", description: "shared button" },
        });
        const second = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "selector", selector: "#new", description: "shared button" },
        });
        const replayed = await runtime.resolveTarget({
          pageRef: created.data.pageRef,
          method: "click",
          target: { kind: "descriptor", description: "shared button" },
        });

        expect(first.node.attributes.find((attribute) => attribute.name === "id")?.value).toBe(
          "old",
        );
        expect(second.node.attributes.find((attribute) => attribute.name === "id")?.value).toBe(
          "new",
        );
        expect(replayed.node.attributes.find((attribute) => attribute.name === "id")?.value).toBe(
          "new",
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "rejects ambiguous path replay instead of silently choosing the first match",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button class="dup" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">A</button>
                <button class="dup" type="button" style="position:absolute;left:20px;top:80px;width:160px;height:40px">B</button>
              `,
              "DOM runtime ambiguity",
            ),
          ),
        });

        await wait(300);

        const path: ElementPath = {
          resolution: "deterministic",
          context: [],
          nodes: [
            {
              tag: "button",
              attrs: { class: "dup" },
              position: { nthChild: 1, nthOfType: 1 },
              match: [{ kind: "attr", key: "class", op: "exact", value: "dup" }],
            },
          ],
        };

        await expect(
          runtime.resolveTarget({
            pageRef: created.data.pageRef,
            method: "click",
            target: { kind: "path", path },
          }),
        ).rejects.toMatchObject({
          name: "ElementPathError",
          code: "ERR_PATH_TARGET_NOT_UNIQUE",
        });
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "accepts hit tests that land on descendants inside the target subtree",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="nested-button" type="button" style="position:absolute;left:20px;top:20px;width:220px;height:80px">
                  <span id="nested-label" style="display:inline-block;width:180px;height:60px">Nested</span>
                </button>
                <div id="status" style="position:absolute;left:20px;top:120px">ready</div>
                <script>
                  document.getElementById("nested-button").addEventListener("click", () => {
                    document.getElementById("status").textContent = "clicked";
                  });
                </script>
              `,
              "DOM runtime nested target",
            ),
          ),
        });

        await wait(300);

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#nested-button" },
        });
        await wait(100);

        const snapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const statusNode = findNodeById(snapshot.nodes, "status")!;
        expect(await engine.readText(createLocator(snapshot, statusNode))).toBe("clicked");
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "rejects explicit targets that resolve on a different page than requested",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const pageA = await engine.createPage({
          sessionRef,
          url: dataUrl(html(`<div id="page-a">A</div>`, "DOM runtime page A")),
        });
        const pageB = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `<button id="page-b-action" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">B</button>`,
              "DOM runtime page B",
            ),
          ),
        });

        await wait(300);

        const snapshotB = await engine.getDomSnapshot({
          frameRef: pageB.frameRef!,
        });

        await expect(
          runtime.click({
            pageRef: pageA.data.pageRef,
            target: {
              kind: "selector",
              selector: "#page-b-action",
              documentRef: snapshotB.documentRef,
            },
          }),
        ).rejects.toThrow(
          `DOM target resolved on page ${snapshotB.pageRef} instead of requested page ${pageA.data.pageRef}`,
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "executes click, hover, input, scroll, and extraction with Playwright",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(500);

        await runtime.hover({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#hover-target" },
        });
        await wait(100);

        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#main-action" },
        });
        await wait(100);

        const mainSnapshot = await engine.getDomSnapshot({
          frameRef: requireValue(created.frameRef, "main frame ref missing"),
        });
        const statusNode = requireValue(
          findNodeById(mainSnapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(mainSnapshot, statusNode))).toBe("main clicked");

        const frames = await engine.listFrames({ pageRef: created.data.pageRef });
        const childFrame = requireValue(
          frames.find((frame) => !frame.isMainFrame),
          "child frame not found",
        );
        const childSnapshot = await engine.getDomSnapshot({
          frameRef: childFrame.frameRef,
        });

        await runtime.input({
          pageRef: created.data.pageRef,
          target: {
            kind: "selector",
            selector: "#child-input",
            documentRef: childSnapshot.documentRef,
          },
          text: "Tim",
        });
        await wait(100);

        const afterInputChildSnapshot = await engine.getDomSnapshot({
          frameRef: childFrame.frameRef,
        });
        const mirrorNode = requireValue(
          findNodeById(afterInputChildSnapshot.nodes, "mirror"),
          "mirror node missing",
        );
        expect(await engine.readText(createLocator(afterInputChildSnapshot, mirrorNode))).toBe(
          "Tim",
        );

        const extracted = await runtime.extractFields({
          pageRef: created.data.pageRef,
          fields: [
            {
              key: "link",
              target: {
                kind: "selector",
                selector: "#child-link",
                documentRef: afterInputChildSnapshot.documentRef,
              },
              attribute: "href",
            },
            {
              key: "image",
              target: {
                kind: "selector",
                selector: "#child-image",
                documentRef: afterInputChildSnapshot.documentRef,
              },
              attribute: "srcset",
            },
            {
              key: "ping",
              target: {
                kind: "selector",
                selector: "#child-ping",
                documentRef: afterInputChildSnapshot.documentRef,
              },
              attribute: "ping",
            },
            {
              key: "currentUrl",
              source: "current_url",
            },
          ],
        });

        expect(extracted).toEqual({
          link: `${baseUrl}/child-relative`,
          image: `${baseUrl}/large.png`,
          ping: `${baseUrl}/ping-one`,
          currentUrl: `${baseUrl}/runtime/main`,
        });

        const scrollOutcome = await runtime.scroll({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "body" },
          delta: createPoint(0, 400),
          position: createPoint(400, 500),
        });
        expect(scrollOutcome.resolved.node.nodeName).toBe("BODY");
      } finally {
        await engine.dispose();
      }
    },
  );

  test("inputs through associated label overlays", { timeout: 60_000 }, async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const runtime = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          html(
            `
                <style>
                  #field {
                    position: absolute;
                    left: 20px;
                    top: 20px;
                    width: 260px;
                    height: 56px;
                  }
                  #overlay-input {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    height: 100%;
                    box-sizing: border-box;
                    padding-top: 20px;
                  }
                  label[for="overlay-input"] {
                    position: absolute;
                    inset: 0;
                    display: flex;
                    align-items: flex-start;
                    padding: 8px 12px;
                    background: rgba(255, 0, 0, 0.08);
                  }
                  #overlay-mirror {
                    position: absolute;
                    left: 20px;
                    top: 96px;
                  }
                </style>
                <div id="field">
                  <input id="overlay-input" name="custname" type="text" />
                  <label for="overlay-input">Customer name</label>
                </div>
                <div id="overlay-mirror"></div>
                <script>
                  document.getElementById("overlay-input").addEventListener("input", (event) => {
                    document.getElementById("overlay-mirror").textContent = event.target.value;
                  });
                </script>
              `,
            "DOM runtime label overlay",
          ),
        ),
      });

      await wait(300);

      await runtime.input({
        pageRef: created.data.pageRef,
        target: {
          kind: "selector",
          selector: "#overlay-input",
        },
        text: "Opensteer",
      });
      await wait(100);

      const snapshot = await engine.getDomSnapshot({
        frameRef: requireValue(created.frameRef, "main frame ref missing"),
      });
      const mirrorNode = requireValue(
        findNodeById(snapshot.nodes, "overlay-mirror"),
        "overlay mirror missing",
      );
      expect(await engine.readText(createLocator(snapshot, mirrorNode))).toBe("Opensteer");
    } finally {
      await engine.dispose();
    }
  });

  test(
    "returns structured actionability errors for hidden targets",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="hidden-action" hidden type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Hidden</button>
              `,
              "DOM runtime hidden target",
            ),
          ),
        });

        await wait(300);

        await expect(
          runtime.click({
            pageRef: created.data.pageRef,
            target: { kind: "selector", selector: "#hidden-action" },
          }),
        ).rejects.toMatchObject({
          name: "OpensteerProtocolError",
          code: "operation-failed",
          details: {
            policy: "actionability",
            reason: "not-visible",
            attribute: "hidden",
          },
        });
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "starts DOM action time budgets before target resolution so timed-out actions never dispatch",
    { timeout: 60_000 },
    async () => {
      const engine = await createDelayedDomSnapshotEngine(25);

      try {
        const base = defaultPolicy();
        const runtime = createDomRuntime({
          engine,
          policy: {
            ...base,
            timeout: {
              resolveTimeoutMs(input) {
                if (input.operation === "dom.click") {
                  return 1;
                }
                return base.timeout.resolveTimeoutMs(input);
              },
            },
          },
        });
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/runtime/main`,
        });

        await wait(300);

        await expect(
          runtime.click({
            pageRef: created.data.pageRef,
            target: { kind: "selector", selector: "#main-action" },
          }),
        ).rejects.toMatchObject({
          code: "timeout",
          details: {
            operation: "dom.click",
            policy: "timeout",
          },
        });

        await wait(80);
        const snapshot = await engine.getDomSnapshot({
          frameRef: requireValue(created.frameRef, "main frame ref missing"),
        });
        const statusNode = requireValue(
          findNodeById(snapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(snapshot, statusNode))).toBe("ready");
      } finally {
        await engine.dispose?.();
      }
    },
  );

  test(
    "waits for post-click settle by default and allows overriding settle policy on createDomRuntime",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="delayed-action" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Delayed</button>
                <div id="status" style="position:absolute;left:20px;top:80px">ready</div>
                <script>
                  document.getElementById("delayed-action").addEventListener("click", () => {
                    setTimeout(() => {
                      document.getElementById("status").textContent = "clicked";
                    }, 60);
                  });
                </script>
              `,
              "DOM runtime settle",
            ),
          ),
        });

        await wait(300);

        const runtime = createDomRuntime({ engine });
        await runtime.click({
          pageRef: created.data.pageRef,
          target: { kind: "selector", selector: "#delayed-action" },
        });

        const settledSnapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const settledStatusNode = requireValue(
          findNodeById(settledSnapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(settledSnapshot, settledStatusNode))).toBe(
          "clicked",
        );

        const noSettleRuntime = createDomRuntime({
          engine,
          policy: {
            ...defaultPolicy(),
            settle: {
              observers: [],
              resolveDelayMs() {
                return 0;
              },
            },
          },
        });
        const resetPage = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <button id="delayed-action" type="button" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Delayed</button>
                <div id="status" style="position:absolute;left:20px;top:80px">ready</div>
                <script>
                  document.getElementById("delayed-action").addEventListener("click", () => {
                    setTimeout(() => {
                      document.getElementById("status").textContent = "clicked";
                    }, 60);
                  });
                </script>
              `,
              "DOM runtime no settle",
            ),
          ),
        });

        await wait(300);

        await noSettleRuntime.click({
          pageRef: resetPage.data.pageRef,
          target: { kind: "selector", selector: "#delayed-action" },
        });

        const immediateSnapshot = await engine.getDomSnapshot({
          frameRef: resetPage.frameRef!,
        });
        const immediateStatusNode = requireValue(
          findNodeById(immediateSnapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(immediateSnapshot, immediateStatusNode))).toBe(
          "ready",
        );

        await wait(80);
        const eventualSnapshot = await engine.getDomSnapshot({
          frameRef: resetPage.frameRef!,
        });
        const eventualStatusNode = requireValue(
          findNodeById(eventualSnapshot.nodes, "status"),
          "status node missing",
        );
        expect(await engine.readText(createLocator(eventualSnapshot, eventualStatusNode))).toBe(
          "clicked",
        );
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "snapshot compilation succeeds on pages with many identical repeated siblings that cannot be uniquely finalized",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const runtime = createDomRuntime({ engine });
        const sessionRef = await engine.createSession();

        const repeatedItems = Array.from(
          { length: 20 },
          (_, i) =>
            `<li class="item"><a class="link" href="/item/${i}"><span class="title">Item ${i}</span></a></li>`,
        ).join("\n");
        const repeatedSections = Array.from(
          { length: 5 },
          (_, i) =>
            `<section class="card"><div class="card-body"><h3 class="card-title">Section ${i}</h3><ul class="list">${repeatedItems}</ul></div></section>`,
        ).join("\n");

        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            html(
              `
                <nav class="nav">
                  <a class="nav-link" href="/a">Home</a>
                  <a class="nav-link" href="/b">About</a>
                  <a class="nav-link" href="/c">Contact</a>
                </nav>
                <main id="content">
                  ${repeatedSections}
                </main>
                <div id="status" style="position:absolute;left:20px;top:20px">ready</div>
              `,
              "Snapshot repeated-siblings regression",
            ),
          ),
        });

        await wait(300);

        const snapshot = await engine.getDomSnapshot({
          frameRef: created.frameRef!,
        });
        const index = (
          await import("../../packages/opensteer/src/runtimes/dom/path.js")
        ).createSnapshotIndex(snapshot);
        const { buildLocalStructuralElementAnchor } =
          await import("../../packages/opensteer/src/runtimes/dom/path.js");

        let anchorCount = 0;
        for (const node of snapshot.nodes) {
          if (node.nodeType !== 1 || node.nodeRef === undefined) {
            continue;
          }
          const anchor = buildLocalStructuralElementAnchor(index, node);
          expect(anchor.resolution).toBe("structural");
          expect(anchor.nodes.length).toBeGreaterThan(0);
          anchorCount += 1;
        }

        expect(anchorCount).toBeGreaterThan(100);

        const mainFrame = (await engine.listFrames({ pageRef: created.data.pageRef })).find(
          (frame) => frame.isMainFrame,
        );
        expect(mainFrame).toBeDefined();

        const statusNode = requireValue(
          findNodeById(snapshot.nodes, "status"),
          "status node missing in repeated-siblings page",
        );
        expect(statusNode.nodeRef).toBeDefined();
      } finally {
        await engine.dispose();
      }
    },
  );
});
