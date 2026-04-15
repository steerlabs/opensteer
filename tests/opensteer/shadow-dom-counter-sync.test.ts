import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { compileOpensteerSnapshot } from "../../packages/runtime-core/src/sdk/snapshot/compiler.js";

type SnapshotResult = Awaited<ReturnType<typeof compileOpensteerSnapshot>>;
type PlaywrightEngine = Awaited<ReturnType<typeof createPlaywrightBrowserCoreEngine>>;
type SnapshotSetup = {
  readonly engine: PlaywrightEngine;
  readonly pageRef: string;
};

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const SHADOW_BUTTON_TEXTS = ["Add a note", "Send without a note"] as const;

function html(body: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

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

function findButtonCounters(counters: SnapshotResult["counters"], texts: readonly string[]) {
  return counters.filter(
    (c) => c.tagName === "BUTTON" && c.shadowDepth > 0 && texts.some((t) => c.text?.includes(t)),
  );
}

function expectShadowButtons(
  snapshot: SnapshotResult,
  options: {
    readonly requireNodeRef?: boolean;
    readonly requireShadowDepth?: boolean;
  } = {},
): void {
  for (const text of SHADOW_BUTTON_TEXTS) {
    expect(snapshot.html).toContain(text);
  }

  const buttons = findButtonCounters(snapshot.counters, SHADOW_BUTTON_TEXTS);
  expect(buttons).toHaveLength(2);

  for (const button of buttons) {
    if (options.requireNodeRef) {
      expect(button.nodeRef).toBeDefined();
    }
    if (options.requireShadowDepth) {
      expect(button.shadowDepth).toBeGreaterThan(0);
    }
  }
}

async function clickTrigger({ engine, pageRef }: SnapshotSetup): Promise<void> {
  const frames = await engine.listFrames({ pageRef });
  const mainFrame = frames.find((frame) => frame.parentFrameRef === undefined);
  if (mainFrame === undefined) {
    throw new Error("main frame not found");
  }

  await engine.evaluateFrame({
    frameRef: mainFrame.frameRef,
    script: `(() => { document.getElementById("trigger").click(); })`,
    args: [],
  });
}

async function captureSnapshot(
  pathname: string,
  options: {
    readonly settleMs?: number;
    readonly prepare?: (setup: SnapshotSetup) => Promise<void>;
    readonly prepareSettleMs?: number;
  } = {},
): Promise<SnapshotResult> {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });

  try {
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}${pathname}`,
    });
    await wait(options.settleMs ?? 300);

    if (options.prepare) {
      await options.prepare({ engine, pageRef: created.data.pageRef });
      const prepareSettleMs = options.prepareSettleMs ?? 0;
      if (prepareSettleMs > 0) {
        await wait(prepareSettleMs);
      }
    }

    return await compileOpensteerSnapshot({
      engine,
      pageRef: created.data.pageRef,
      mode: "action",
    });
  } finally {
    await engine.dispose();
  }
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
      const snapshot = await captureSnapshot("/counter-sync/static-shadow", {
        settleMs: 300,
      });
      expectShadowButtons(snapshot, {
        requireNodeRef: true,
        requireShadowDepth: true,
      });
    },
  );

  test(
    "assigns counters to dynamically injected shadow DOM elements",
    { timeout: 60_000 },
    async () => {
      const snapshot = await captureSnapshot("/counter-sync/dynamic-shadow-dialog", {
        settleMs: 300,
        prepare: clickTrigger,
        prepareSettleMs: 200,
      });
      expectShadowButtons(snapshot, {
        requireNodeRef: true,
      });
    },
  );

  test("assigns counters under framework re-rendering", { timeout: 60_000 }, async () => {
    const snapshot = await captureSnapshot("/counter-sync/framework-rerender", {
      settleMs: 500,
    });
    expectShadowButtons(snapshot);
  });
});
