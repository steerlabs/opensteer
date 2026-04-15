import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { compileOpensteerSnapshot } from "../../packages/runtime-core/src/sdk/snapshot/compiler.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

function html(body: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

/**
 * Control: shadow DOM content present from initial page load, no dynamic changes.
 */
function staticShadow(): string {
  return html(
    `
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<div id="messaging"><button class="msg-btn" type="button">Messaging</button></div>' +
          '<div id="dialog">' +
          '<button class="dialog-btn" type="button">Add a note</button>' +
          '<button class="dialog-btn" type="button">Send without a note</button>' +
          '</div>';
      </script>
    `,
    "counter-sync: static shadow",
  );
}

/**
 * Simulates LinkedIn's connect dialog: shadow DOM host starts with only
 * a messaging overlay. Clicking a trigger dynamically injects dialog
 * buttons into the shadow root.
 */
function dynamicShadowDialog(): string {
  return html(
    `
      <button id="trigger" type="button" style="margin:10px;padding:8px 16px">Open Dialog</button>
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<div id="messaging"><button class="msg-btn" type="button">Messaging</button></div>';

        document.getElementById("trigger").addEventListener("click", () => {
          const dialog = document.createElement("div");
          dialog.id = "dialog";
          dialog.innerHTML =
            '<button class="dialog-btn" type="button">Add a note</button>' +
            '<button class="dialog-btn" type="button">Send without a note</button>';
          shadow.insertBefore(dialog, shadow.firstChild);
        });
      </script>
    `,
    "counter-sync: dynamic shadow dialog",
  );
}

/**
 * Simulates Ember-like framework re-rendering: shadow DOM content is
 * periodically replaced via innerHTML, stripping any data-os-* attributes.
 */
function frameworkRerender(): string {
  return html(
    `
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        const render = () => {
          shadow.innerHTML =
            '<div class="dialog">' +
            '<button class="action" type="button">Add a note</button>' +
            '<button class="action" type="button">Send without a note</button>' +
            '</div>';
        };
        render();
        setInterval(render, 200);
      </script>
    `,
    "counter-sync: framework rerender",
  );
}

async function handleRequest(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(_request.url ?? "/", "http://127.0.0.1");
  const pages: Record<string, () => string> = {
    "/counter-sync/static-shadow": staticShadow,
    "/counter-sync/dynamic-shadow-dialog": dynamicShadowDialog,
    "/counter-sync/framework-rerender": frameworkRerender,
  };

  const factory = pages[url.pathname];
  if (factory) {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(factory());
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Filter counter records for shadow DOM buttons by their text content.
 * Counter records are the authoritative source — they come directly from
 * the snapshot and include nodeRef, shadowDepth, and text.
 */
function findButtonCounters(
  counters: readonly { element: number; text?: string; tagName: string; shadowDepth: number; nodeRef?: string }[],
  texts: readonly string[],
) {
  return counters.filter(
    (c) => c.tagName === "BUTTON" && c.shadowDepth > 0 && texts.some((t) => c.text?.includes(t)),
  );
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

describe.sequential("Shadow DOM counter sync", () => {
  test(
    "assigns counters to static shadow DOM elements in snapshot HTML",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/counter-sync/static-shadow`,
        });
        await wait(300);

        const snapshot = await compileOpensteerSnapshot({
          engine,
          pageRef: created.data.pageRef,
          mode: "action",
        });

        // Snapshot HTML should contain shadow DOM button text
        expect(snapshot.html).toContain("Add a note");
        expect(snapshot.html).toContain("Send without a note");

        // Counter records should include nodeRefs for shadow DOM buttons
        const dialogButtons = findButtonCounters(snapshot.counters, ["Add a note", "Send without a note"]);
        expect(dialogButtons.length).toBe(2);
        for (const record of dialogButtons) {
          expect(record.nodeRef).toBeDefined();
          expect(record.shadowDepth).toBeGreaterThan(0);
        }
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "assigns counters to dynamically injected shadow DOM elements",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/counter-sync/dynamic-shadow-dialog`,
        });
        await wait(300);

        // Click the trigger to inject dialog into shadow DOM
        const frames = await engine.listFrames({ pageRef: created.data.pageRef });
        const mainFrame = (frames as { frameRef: string; parentFrameRef?: string }[]).find(
          (f) => f.parentFrameRef === undefined,
        )!;
        await engine.evaluateFrame({
          frameRef: mainFrame.frameRef,
          script: `(() => { document.getElementById("trigger").click(); })`,
          args: [],
        });
        await wait(200);

        // Snapshot should capture the dynamically injected dialog buttons
        const snapshot = await compileOpensteerSnapshot({
          engine,
          pageRef: created.data.pageRef,
          mode: "action",
        });

        // Snapshot HTML should contain dynamic dialog button text
        expect(snapshot.html).toContain("Add a note");
        expect(snapshot.html).toContain("Send without a note");

        // Counter records should have nodeRefs for dynamically injected buttons
        const dialogButtons = findButtonCounters(snapshot.counters, ["Add a note", "Send without a note"]);
        expect(dialogButtons.length).toBe(2);
        for (const record of dialogButtons) {
          expect(record.nodeRef).toBeDefined();
        }
      } finally {
        await engine.dispose();
      }
    },
  );

  test(
    "assigns counters under framework re-rendering",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: `${baseUrl}/counter-sync/framework-rerender`,
        });
        await wait(500);

        // Snapshot should capture buttons even under constant re-renders.
        // Since counter resolution uses the snapshot (not live DOM c= attrs),
        // re-rendering doesn't affect counter usability.
        const snapshot = await compileOpensteerSnapshot({
          engine,
          pageRef: created.data.pageRef,
          mode: "action",
        });

        expect(snapshot.html).toContain("Add a note");
        expect(snapshot.html).toContain("Send without a note");

        // Counter records should exist for buttons even under re-rendering
        const dialogButtons = findButtonCounters(snapshot.counters, ["Add a note", "Send without a note"]);
        expect(dialogButtons.length).toBe(2);
      } finally {
        await engine.dispose();
      }
    },
  );
});
