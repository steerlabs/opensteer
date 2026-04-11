import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Opensteer } from "../../packages/opensteer/src/index.js";
import { OpensteerBrowserManager } from "../../packages/opensteer/src/browser-manager.js";
import { readPersistedLocalBrowserSessionRecord } from "../../packages/opensteer/src/live-session.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const temporaryRoots: string[] = [];

const headedSupported = process.platform !== "linux" || process.env.DISPLAY !== undefined;

const interactionModes = [
  { name: "headless", headless: true },
  ...(headedSupported ? [{ name: "headful", headless: false }] : []),
];

function html(body: string, title: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        min-height: 2600px;
        font: 16px/1.4 sans-serif;
      }
      button, input, textarea, a, div {
        font: inherit;
      }
      #status, #text-mirror, #textarea-mirror, #editable-mirror {
        position: absolute;
        left: 20px;
        min-width: 220px;
      }
      #status { top: 20px; font-weight: 700; }
      #main-action, #hover-target, #double-action, #nav-link, #network-trigger {
        position: absolute;
        left: 20px;
        width: 220px;
        height: 42px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #111;
        background: #f6f6f6;
        color: #111;
        text-decoration: none;
      }
      #main-action { top: 70px; }
      #hover-target { top: 130px; }
      #double-action { top: 190px; }
      #nav-link { top: 250px; }
      #network-trigger { top: 310px; }
      #text-input { position: absolute; left: 20px; top: 390px; width: 280px; height: 36px; }
      #text-mirror { top: 435px; }
      #textarea-input {
        position: absolute;
        left: 20px;
        top: 470px;
        width: 280px;
        height: 90px;
      }
      #textarea-mirror { top: 575px; white-space: pre-wrap; }
      #editable {
        position: absolute;
        left: 20px;
        top: 620px;
        width: 280px;
        min-height: 44px;
        border: 1px solid #111;
        padding: 8px;
      }
      #editable-mirror { top: 690px; white-space: pre-wrap; }
      #submit-form {
        position: absolute;
        left: 20px;
        top: 740px;
      }
      #submit-input {
        width: 280px;
        height: 36px;
      }
      #shadow-host {
        position: absolute;
        left: 360px;
        top: 70px;
      }
      #scroll-box {
        position: absolute;
        left: 360px;
        top: 240px;
        width: 260px;
        height: 140px;
        overflow: auto;
        border: 1px solid #111;
      }
      #scroll-content {
        height: 900px;
        background: linear-gradient(#f6f6f6, #dedede);
      }
      iframe {
        position: absolute;
        left: 680px;
        top: 70px;
        width: 420px;
        height: 360px;
        border: 1px solid #111;
      }
      #offscreen-action {
        position: absolute;
        left: 20px;
        top: 1850px;
        width: 260px;
        height: 42px;
      }
    </style>
    ${extraHead}
  </head>
  <body>${body}</body>
</html>`;
}

function mainDocument(): string {
  return html(
    `
      <div id="status">ready</div>
      <button id="main-action" type="button">Main Action</button>
      <div id="hover-target" role="button" tabindex="0">Hover Target</div>
      <button id="double-action" type="button">Double Action</button>
      <a id="nav-link" href="/humanize/navigated">Navigate</a>
      <button id="network-trigger" type="button">Network Trigger</button>
      <input id="text-input" type="text" />
      <div id="text-mirror"></div>
      <textarea id="textarea-input"></textarea>
      <div id="textarea-mirror"></div>
      <div id="editable" contenteditable="true"></div>
      <div id="editable-mirror"></div>
      <form id="submit-form" action="/humanize/submitted" method="get">
        <input id="submit-input" name="value" type="text" />
      </form>
      <div id="shadow-host"></div>
      <div id="scroll-box"><div id="scroll-content"></div></div>
      <iframe id="child-frame" src="/humanize/child"></iframe>
      <button id="offscreen-action" type="button">Offscreen Action</button>
      <script>
        const status = document.getElementById("status");
        window.setStatus = (value) => {
          status.textContent = value;
        };

        document.getElementById("main-action").addEventListener("click", () => {
          window.setStatus("main clicked");
        });
        document.getElementById("hover-target").addEventListener("mouseenter", () => {
          window.setStatus("hovered");
        });
        document.getElementById("double-action").addEventListener("dblclick", () => {
          window.setStatus("double clicked");
        });
        document.getElementById("text-input").addEventListener("input", (event) => {
          document.getElementById("text-mirror").textContent = event.target.value;
        });
        document.getElementById("textarea-input").addEventListener("input", (event) => {
          document.getElementById("textarea-mirror").textContent = event.target.value;
        });
        document.getElementById("editable").addEventListener("input", (event) => {
          document.getElementById("editable-mirror").textContent = event.target.textContent;
        });
        document.getElementById("scroll-box").addEventListener("scroll", (event) => {
          window.setStatus("scroll-box:" + event.target.scrollTop);
        });
        document.getElementById("network-trigger").addEventListener("click", async () => {
          const response = await fetch("/api/replayable", {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: "humanize-audit",
              limit: 7,
            }),
          });
          const payload = await response.json();
          window.setStatus("network:" + payload.query);
        });
        document.getElementById("offscreen-action").addEventListener("click", () => {
          window.setStatus("offscreen:" + Math.round(window.scrollY));
        });

        const shadowHost = document.getElementById("shadow-host");
        const shadowRoot = shadowHost.attachShadow({ mode: "open" });
        shadowRoot.innerHTML =
          '<button id="shadow-action" type="button" style="width:220px;height:42px">Shadow Action</button>' +
          '<div id="nested-shadow-host"></div>';
        shadowRoot.getElementById("shadow-action").addEventListener("click", () => {
          window.setStatus("shadow clicked");
        });
        const nestedHost = shadowRoot.getElementById("nested-shadow-host");
        const nestedRoot = nestedHost.attachShadow({ mode: "open" });
        nestedRoot.innerHTML =
          '<button id="nested-shadow-action" type="button" style="width:220px;height:42px">Nested Shadow</button>';
        nestedRoot.getElementById("nested-shadow-action").addEventListener("click", () => {
          window.setStatus("nested shadow clicked");
        });
      </script>
    `,
    "Humanize Fixture",
  );
}

function childDocument(): string {
  return html(
    `
      <button id="child-action" type="button" style="position:absolute;left:20px;top:20px;width:180px;height:40px">Child Action</button>
      <input id="child-input" type="text" style="position:absolute;left:20px;top:80px;width:220px;height:36px" />
      <div id="child-mirror" style="position:absolute;left:20px;top:130px"></div>
      <div id="child-shadow-host" style="position:absolute;left:20px;top:180px"></div>
      <button id="child-offscreen-action" type="button" style="position:absolute;left:20px;top:980px;width:220px;height:40px">Child Offscreen</button>
      <script>
        const report = (value) => {
          parent.window.setStatus(value);
        };
        document.getElementById("child-action").addEventListener("click", () => {
          report("child clicked");
        });
        document.getElementById("child-input").addEventListener("input", (event) => {
          document.getElementById("child-mirror").textContent = event.target.value;
          report("child input");
        });
        document.getElementById("child-offscreen-action").addEventListener("click", () => {
          report("child offscreen:" + Math.round(window.scrollY));
        });
        const childHost = document.getElementById("child-shadow-host");
        const childRoot = childHost.attachShadow({ mode: "open" });
        childRoot.innerHTML =
          '<button id="child-shadow-action" type="button" style="width:220px;height:42px">Child Shadow</button>';
        childRoot.getElementById("child-shadow-action").addEventListener("click", () => {
          report("child shadow clicked");
        });
      </script>
    `,
    "Humanize Child",
  );
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/humanize/main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocument());
    return;
  }

  if (url.pathname === "/humanize/child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(childDocument());
    return;
  }

  if (url.pathname === "/humanize/navigated") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html('<div id="navigated">navigated</div>', "Navigated"));
    return;
  }

  if (url.pathname === "/humanize/submitted") {
    const submitted = url.searchParams.get("value") ?? "";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html(`<div id="submitted">submitted:${escapeHtml(submitted)}</div>`, "Submitted"));
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
        query: parsed.query ?? "",
        limit: parsed.limit ?? 0,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start humanize audit server");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opensteer-humanize-audit-"));
  temporaryRoots.push(root);
  return root;
}

function createLocalOpensteer(input: {
  readonly headless: boolean;
  readonly browser?: ConstructorParameters<typeof Opensteer>[0]["browser"];
  readonly rootDir?: string;
  readonly workspace?: string;
  readonly launchArgs?: readonly string[];
}): Opensteer {
  return new Opensteer({
    provider: {
      mode: "local",
    },
    ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    launch: {
      headless: input.headless,
      ...(input.launchArgs === undefined ? {} : { args: [...input.launchArgs] }),
    },
    context: {
      humanize: true,
    },
  });
}

async function readMainText(opensteer: Opensteer, selector: string): Promise<string> {
  return String(
    await opensteer.evaluate(
      `() => document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`,
    ),
  );
}

async function readMainValue(opensteer: Opensteer, selector: string): Promise<string> {
  return String(
    await opensteer.evaluate(
      `() => document.querySelector(${JSON.stringify(selector)})?.value ?? ""`,
    ),
  );
}

describe.sequential("humanize interaction audit", () => {
  beforeAll(async () => {
    const started = await startServer();
    baseUrl = started.url;
    closeServer = started.close;
  });

  for (const mode of interactionModes) {
    test(
      `${mode.name}: pointer interactions work across viewport, shadow DOM, iframe, nested iframe+shadow, scrolling, and navigation`,
      { timeout: 120_000 },
      async () => {
        const opensteer = createLocalOpensteer({
          headless: mode.headless,
          browser: "temporary",
        });

        try {
          await opensteer.open(`${baseUrl}/humanize/main`);

          await opensteer.click({ selector: "#main-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("main clicked");

          await opensteer.hover({ selector: "#hover-target" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("hovered");

          await opensteer.click({ selector: "#double-action", clickCount: 2 });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("double clicked");

          await opensteer.click({ selector: "#shadow-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("shadow clicked");

          await opensteer.click({ selector: "#nested-shadow-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("nested shadow clicked");

          await opensteer.click({ selector: "#child-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("child clicked");

          await opensteer.click({ selector: "#child-shadow-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("child shadow clicked");

          await opensteer.click({ selector: "#offscreen-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toMatch(/^offscreen:\d+/);
          await expect(
            opensteer.evaluate("() => Math.round(window.scrollY)"),
          ).resolves.toBeGreaterThan(0);

          await opensteer.click({ selector: "#child-offscreen-action" });
          await expect(readMainText(opensteer, "#status")).resolves.toMatch(/^child offscreen:\d+/);
          await expect(
            opensteer.evaluate(
              `() => {
                const frame = document.getElementById("child-frame");
                const childWindow = frame?.contentWindow;
                return childWindow ? Math.round(childWindow.scrollY) : -1;
              }`,
            ),
          ).resolves.toBeGreaterThan(0);

          await opensteer.scroll({
            selector: "#scroll-box",
            direction: "down",
            amount: 320,
          });
          await expect(readMainText(opensteer, "#status")).resolves.toMatch(/^scroll-box:\d+/);
          await expect(
            opensteer.evaluate(`() => document.getElementById("scroll-box")?.scrollTop ?? 0`),
          ).resolves.toBeGreaterThan(0);

          await opensteer.goto(`${baseUrl}/humanize/main`);
          await opensteer.click({ selector: "#nav-link" });
          await expect(opensteer.evaluate("() => location.pathname")).resolves.toBe(
            "/humanize/navigated",
          );
        } finally {
          await opensteer.close().catch(() => undefined);
        }
      },
    );

    test(
      `${mode.name}: keyboard interactions work for text inputs, textarea newlines, contenteditable, iframe inputs, and pressEnter submit`,
      { timeout: 120_000 },
      async () => {
        const opensteer = createLocalOpensteer({
          headless: mode.headless,
          browser: "temporary",
        });

        try {
          await opensteer.open(`${baseUrl}/humanize/main`);

          await opensteer.click({ selector: "#text-input" });
          await opensteer.input({
            selector: "#text-input",
            text: "Hello, World! 42",
          });
          await expect(readMainValue(opensteer, "#text-input")).resolves.toBe("Hello, World! 42");
          await expect(readMainText(opensteer, "#text-mirror")).resolves.toBe("Hello, World! 42");

          await opensteer.click({ selector: "#textarea-input" });
          await opensteer.input({
            selector: "#textarea-input",
            text: "Line 1\nLine 2",
          });
          await expect(readMainValue(opensteer, "#textarea-input")).resolves.toBe("Line 1\nLine 2");
          await expect(readMainText(opensteer, "#textarea-mirror")).resolves.toBe("Line 1\nLine 2");

          await opensteer.click({ selector: "#editable" });
          await opensteer.input({
            selector: "#editable",
            text: "Editable 123!",
          });
          await expect(readMainText(opensteer, "#editable")).resolves.toBe("Editable 123!");
          await expect(readMainText(opensteer, "#editable-mirror")).resolves.toBe("Editable 123!");

          await opensteer.click({ selector: "#child-input" });
          await opensteer.input({
            selector: "#child-input",
            text: "Iframe text",
          });
          await expect(readMainText(opensteer, "#status")).resolves.toBe("child input");
          await expect(
            opensteer.evaluate(
              `() => {
                const frame = document.getElementById("child-frame");
                return frame?.contentDocument?.getElementById("child-mirror")?.textContent ?? "";
              }`,
            ),
          ).resolves.toBe("Iframe text");

          await opensteer.goto(`${baseUrl}/humanize/main`);
          await opensteer.click({ selector: "#submit-input" });
          await opensteer.input({
            selector: "#submit-input",
            text: "submit value",
            pressEnter: true,
          });
          await expect(opensteer.evaluate("() => location.pathname")).resolves.toBe(
            "/humanize/submitted",
          );
          await expect(readMainText(opensteer, "#submitted")).resolves.toBe(
            "submitted:submit value",
          );
        } finally {
          await opensteer.close().catch(() => undefined);
        }
      },
    );
  }

  test(
    "headless: network capture, detail, and replay still work with humanize enabled",
    { timeout: 120_000 },
    async () => {
      const opensteer = createLocalOpensteer({
        headless: true,
        browser: "temporary",
      });

      try {
        await opensteer.open(`${baseUrl}/humanize/main`);
        await opensteer.click({
          selector: "#network-trigger",
          captureNetwork: "replay",
        });

        await expect(readMainText(opensteer, "#status")).resolves.toBe("network:humanize-audit");

        const { records } = await opensteer.network.query({
          limit: 20,
          includeBodies: true,
        });
        const target = records.find((entry) => entry.url.includes("/api/replayable"));
        expect(target).toBeDefined();

        const detail = await opensteer.network.detail(target!.recordId);
        expect(detail.summary.method).toBe("POST");
        expect(detail.requestBody?.data).toMatchObject({
          query: "humanize-audit",
          limit: 7,
        });

        const replay = await opensteer.fetch(`${baseUrl}/api/replayable`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: {
            json: {
              query: "humanize-audit",
              limit: 9,
            },
            contentType: "application/json",
          },
        });
        await expect(replay.json()).resolves.toMatchObject({
          ok: true,
          query: "humanize-audit",
          limit: 9,
        });
      } finally {
        await opensteer.close().catch(() => undefined);
      }
    },
  );

  test(
    "headless: persistent reuse on a fixed port and attach mode both remain functional",
    { timeout: 120_000 },
    async () => {
      const rootDir = await createTemporaryRoot();
      const workspace = "humanize-persistent-port";
      const port = 9339;

      const manager = new OpensteerBrowserManager({
        rootDir,
        workspace,
      });
      const persistent = createLocalOpensteer({
        headless: true,
        rootDir,
        workspace,
        browser: "persistent",
        launchArgs: [`--remote-debugging-port=${String(port)}`],
      });

      try {
        await persistent.open(`${baseUrl}/humanize/main`);
        await persistent.click({ selector: "#main-action" });
        await persistent.evaluate(
          `() => {
            localStorage.setItem("persistent-key", "persistent-value");
          }`,
        );

        const live = await readPersistedLocalBrowserSessionRecord(manager.rootPath);
        expect(live?.endpoint).toContain(`:${String(port)}/`);

        await persistent.disconnect();

        const reused = createLocalOpensteer({
          headless: true,
          rootDir,
          workspace,
          browser: "persistent",
        });
        try {
          await expect(
            reused.evaluate("() => localStorage.getItem('persistent-key')"),
          ).resolves.toBe("persistent-value");
        } finally {
          await reused.disconnect().catch(() => undefined);
        }

        const attached = createLocalOpensteer({
          headless: true,
          browser: {
            mode: "attach",
            endpoint: live?.endpoint ?? `ws://127.0.0.1:${String(port)}/devtools/browser/unknown`,
            freshTab: false,
          },
        });
        try {
          await attached.click({ selector: "#shadow-action" });
          await expect(
            attached.evaluate("() => document.getElementById('status')?.textContent ?? ''"),
          ).resolves.toBe("shadow clicked");
        } finally {
          await attached.disconnect().catch(() => undefined);
        }
      } finally {
        await persistent.close().catch(() => undefined);
      }
    },
  );

  test(
    "headless: cloned persistent profiles preserve cookie and localStorage state",
    { timeout: 120_000 },
    async () => {
      const rootDir = await createTemporaryRoot();
      const sourceWorkspace = "humanize-clone-source";
      const targetWorkspace = "humanize-clone-target";

      const source = createLocalOpensteer({
        headless: true,
        rootDir,
        workspace: sourceWorkspace,
        browser: "persistent",
      });
      const sourceManager = new OpensteerBrowserManager({
        rootDir,
        workspace: sourceWorkspace,
      });
      const target = createLocalOpensteer({
        headless: true,
        rootDir,
        workspace: targetWorkspace,
        browser: "persistent",
      });

      try {
        await source.open(`${baseUrl}/humanize/main`);
        await source.evaluate(
          `() => {
            localStorage.setItem("clone-key", "clone-value");
            document.cookie = "clone-cookie=1; path=/; max-age=3600";
            return true;
          }`,
        );
        await source.close();

        await target.browser.clone({
          sourceUserDataDir: path.join(sourceManager.rootPath, "browser", "user-data"),
        });

        await target.open(`${baseUrl}/humanize/main`);
        await expect(target.evaluate("() => localStorage.getItem('clone-key')")).resolves.toBe(
          "clone-value",
        );
        await expect(target.evaluate("() => document.cookie")).resolves.toContain("clone-cookie=1");
      } finally {
        await target.close().catch(() => undefined);
      }
    },
  );
});

afterAll(async () => {
  await closeServer?.();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
