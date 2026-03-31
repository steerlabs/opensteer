import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type BrowserCoreEngine,
  createNodeLocator,
  createPoint,
  type DomSnapshot,
  type DomSnapshotNode,
  type FrameInfo,
  type PageRef,
} from "../../packages/browser-core/src/index.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import {
  OpensteerProtocolError,
  resolveDomActionBridge,
} from "../../packages/protocol/src/index.js";
import {
  createDomRuntime,
  createFilesystemOpensteerWorkspace,
  defaultPolicy,
  Opensteer,
  type OpensteerPolicy,
  type SettleObserver,
} from "../../packages/opensteer/src/index.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

describe.sequential("cross-document action boundary", () => {
  beforeAll(async () => {
    const server = createServer((request, response) => {
      void handleRequest(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start action-boundary fixture server");
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    closeServer = async () => {
      server.close();
      await once(server, "close");
    };
  });

  afterAll(async () => {
    await closeServer?.();
  });

  test("waits for Enter-submit navigations before finalizing DOM actions", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/engine/hydration-enter`,
      });
      const bridge = resolveDomActionBridge(engine)!;

      const mainFrame = requireMainFrame(
        await engine.listFrames({ pageRef: created.data.pageRef }),
      );
      const initialSnapshot = await engine.getDomSnapshot({
        frameRef: mainFrame.frameRef,
      });
      const inputLocator = createLocator(
        initialSnapshot,
        requireNodeById(initialSnapshot.nodes, "search-input"),
      );

      await bridge.pressKey(inputLocator, { key: "Enter" });
      await bridge.finalizeDomAction(created.data.pageRef, {
        operation: "dom.input",
        snapshot: {
          pageRef: created.data.pageRef,
          documentRef: initialSnapshot.documentRef,
        },
        signal: new AbortController().signal,
        remainingMs: () => 10_000,
        policySettle: async () => undefined,
      });

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/engine/api/hydration"))?.status,
      ).toBe(200);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("waits for click navigations before finalizing DOM actions", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/engine/hydration-click`,
      });
      const bridge = resolveDomActionBridge(engine)!;

      const mainFrame = requireMainFrame(
        await engine.listFrames({ pageRef: created.data.pageRef }),
      );
      const initialSnapshot = await engine.getDomSnapshot({
        frameRef: mainFrame.frameRef,
      });

      await engine.mouseClick({
        pageRef: created.data.pageRef,
        point: createPoint(110, 41),
        coordinateSpace: "layout-viewport-css",
      });
      await bridge.finalizeDomAction(created.data.pageRef, {
        operation: "dom.click",
        snapshot: {
          pageRef: created.data.pageRef,
          documentRef: initialSnapshot.documentRef,
        },
        signal: new AbortController().signal,
        remainingMs: () => 10_000,
        policySettle: async () => undefined,
      });

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/engine/api/hydration"))?.status,
      ).toBe(200);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("waits for cross-document Enter navigations in the DOM runtime", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/runtime/hydration-enter`,
      });

      await dom.input({
        pageRef: created.data.pageRef,
        target: {
          kind: "selector",
          selector: "#search-input",
        },
        text: "airpods",
        pressEnter: true,
      });

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/runtime/api/hydration"))?.status,
      ).toBe(200);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("waits for cross-document click navigations in the DOM runtime", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/runtime/hydration-click`,
      });

      await dom.click({
        pageRef: created.data.pageRef,
        target: {
          kind: "selector",
          selector: "#continue",
        },
      });

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/runtime/api/hydration"))?.status,
      ).toBe(200);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("captures named hydration requests after pressEnter navigation", async () => {
    const opensteer = new Opensteer({
      name: "navigation-network-capture",
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hydration-enter`);
      await opensteer.input({
        selector: "#search-input",
        text: "airpods",
        pressEnter: true,
        captureNetwork: "hydration-enter",
      });

      await expect(
        opensteer.extract({
          description: "hydration status",
          schema: {
            status: {
              selector: "#hydration-status",
            },
          },
        }),
      ).resolves.toEqual({
        status: "hydrated",
      });

      const { records } = await opensteer.queryNetwork({
        capture: "hydration-enter",
        limit: 20,
      });
      expect(
        records.find((entry) => entry.record.url.includes("/sdk/api/hydration"))?.record.status,
      ).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("does not persist action-triggered network without captureNetwork", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-no-capture-"));
    const opensteer = new Opensteer({
      name: "navigation-network-no-capture",
      rootPath,
      cleanupRootOnClose: false,
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hydration-enter`);
      await opensteer.input({
        selector: "#search-input",
        text: "airpods",
        pressEnter: true,
      });

      await expect(
        opensteer.extract({
          description: "hydration status without capture",
          schema: {
            status: {
              selector: "#hydration-status",
            },
          },
        }),
      ).resolves.toEqual({
        status: "hydrated",
      });

      const root = await createFilesystemOpensteerWorkspace({
        rootPath,
      });
      expect(
        await root.registry.savedNetwork.query({
          url: `${baseUrl}/sdk/api/hydration`,
        }),
      ).toEqual([]);
    } finally {
      await opensteer.close().catch(() => undefined);
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 60_000);

  test("waits for same-tab navigation hydration before returning computer-use clicks", async () => {
    const opensteer = new Opensteer({
      name: "computer-action-boundary",
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

    try {
      await opensteer.open(`${baseUrl}/computer/hydration-click`);
      await opensteer.computerExecute({
        action: {
          type: "click",
          x: 110,
          y: 41,
        },
      });

      await expect(
        opensteer.extract({
          description: "computer hydration status",
          schema: {
            status: {
              selector: "#hydration-status",
            },
          },
        }),
      ).resolves.toEqual({
        status: "hydrated",
      });

      const snapshot = await opensteer.snapshot("action");
      expect(snapshot.url).toBe(`${baseUrl}/computer/hydration-results?mode=click`);
      expect(
        (
          await opensteer.queryNetwork({
            limit: 20,
          })
        ).records.find((entry) => entry.record.url.includes("/computer/api/hydration"))?.record
          .status,
      ).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("returns success and records degraded visual settle traces", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-soft-settle-"));
    const opensteer = new Opensteer({
      name: "soft-settle-boundary",
      rootPath,
      cleanupRootOnClose: false,
      browser: "temporary",
      launch: {
        headless: true,
      },
      policy: createPolicyWithOverrides({
        settleObserver: {
          async settle(input) {
            if (input.operation === "dom.click" && input.trigger === "navigation") {
              throw new OpensteerProtocolError(
                "timeout",
                "forced visual settle timeout for test coverage",
              );
            }
            return false;
          },
        },
      }),
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hydration-click`);
      await opensteer.click({
        selector: "#continue",
        captureNetwork: "soft-settle",
      });

      const { records } = await opensteer.queryNetwork({
        capture: "soft-settle",
        limit: 20,
      });
      expect(
        records.find((entry) => entry.record.url.includes("/sdk/api/hydration"))?.record.status,
      ).toBe(200);

      const traces = await readTraceEntries(rootPath);
      const clickTrace = [...traces]
        .reverse()
        .find((entry) => entry.operation === "dom.click" && entry.outcome === "ok") as
        | {
            readonly data?: {
              readonly settle?: unknown;
            };
          }
        | undefined;
      expect(clickTrace?.data?.settle).toMatchObject({
        trigger: "navigation",
        crossDocument: true,
        bootstrapSettled: true,
        visualSettled: false,
        timedOutPhase: "visual",
      });
    } finally {
      await opensteer.close().catch(() => undefined);
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 60_000);

  test("throws when DOMContentLoaded is missed before the hard interaction deadline", async () => {
    const opensteer = new Opensteer({
      name: "hard-boundary-timeout",
      browser: "temporary",
      launch: {
        headless: true,
      },
      policy: createPolicyWithOverrides({
        timeoutOverrides: {
          "dom.click": 500,
        },
      }),
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hard-timeout-click`);
      await expect(
        opensteer.click({
          selector: "#continue",
        }),
      ).rejects.toThrow(/timeout/i);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("persists observed network deltas when a captureNetwork operation times out", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-timeout-persist-"));
    const opensteer = new Opensteer({
      name: "timeout-persist",
      rootPath,
      cleanupRootOnClose: false,
      browser: "temporary",
      launch: {
        headless: true,
      },
      policy: createPolicyWithOverrides({
        timeoutOverrides: {
          "dom.click": 500,
        },
      }),
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hard-timeout-click`);
      await expect(
        opensteer.click({
          selector: "#continue",
          captureNetwork: "timeout-persist",
        }),
      ).rejects.toThrow(/timed out|timeout/i);

      const root = await createFilesystemOpensteerWorkspace({
        rootPath,
      });
      const records = await root.registry.savedNetwork.query({
        capture: "timeout-persist",
      });
      expect(records.length).toBeGreaterThan(0);
      expect(records.some((record) => record.record.url.includes("/sdk/slow-results"))).toBe(true);
    } finally {
      await opensteer.close().catch(() => undefined);
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 60_000);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const [scope, route] = url.pathname.split("/").filter(Boolean);

  if (scope !== "engine" && scope !== "runtime" && scope !== "sdk" && scope !== "computer") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  if (route === "hydration-enter") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(hydrationEnterDocument(scope));
    return;
  }

  if (route === "hydration-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(hydrationClickDocument(scope));
    return;
  }

  if (route === "hard-timeout-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(hardTimeoutClickDocument(scope));
    return;
  }

  if (route === "hydration-results") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(hydrationResultsDocument(scope, url.searchParams.get("mode") ?? "unknown"));
    return;
  }

  if (route === "slow-results") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(slowResultsDocument(scope));
    return;
  }

  if (route === "api" && url.pathname.endsWith("/api/hydration")) {
    await wait(150);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ status: "hydrated", mode: url.searchParams.get("mode") }));
    return;
  }

  if (route === "slow-script.js") {
    await wait(1_500);
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(
      `
        document.addEventListener("DOMContentLoaded", () => {
          const status = document.getElementById("hydration-status");
          if (status) {
            status.textContent = "slow-script-loaded";
          }
        });
      `,
    );
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

function html(body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input, a { font: inherit; }
      #search-input { position: absolute; left: 20px; top: 20px; width: 220px; height: 36px; }
      #search-submit { position: absolute; left: 260px; top: 20px; width: 120px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #111; background: #f5f5f5; color: #111; text-decoration: none; }
      #continue { position: absolute; left: 20px; top: 20px; width: 180px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #111; background: #f5f5f5; color: #111; text-decoration: none; }
      #products { position: absolute; left: 20px; top: 20px; }
      #hydration-status { position: absolute; left: 20px; top: 70px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function hydrationEnterDocument(scope: string): string {
  return html(
    `
      <form id="search-form" action="/${scope}/hydration-results?mode=enter" method="GET">
        <input id="search-input" name="q" type="text" value="" />
        <button id="search-submit" type="submit">Search</button>
      </form>
    `,
    `${scope} enter`,
  );
}

function hydrationClickDocument(scope: string): string {
  return html(
    `
      <a id="continue" href="/${scope}/hydration-results?mode=click">Open results</a>
    `,
    `${scope} click`,
  );
}

function hardTimeoutClickDocument(scope: string): string {
  return html(
    `
      <a id="continue" href="/${scope}/slow-results">Open slow results</a>
    `,
    `${scope} hard timeout click`,
  );
}

function hydrationResultsDocument(scope: string, mode: string): string {
  return html(
    `
      <div id="products">SSR results ${mode}</div>
      <div id="hydration-status">ssr</div>
      <script>
        document.addEventListener("DOMContentLoaded", () => {
          setTimeout(() => {
            void fetch("/${scope}/api/hydration?mode=" + encodeURIComponent(${JSON.stringify(mode)}))
              .then((result) => result.json())
              .then((payload) => {
                document.getElementById("hydration-status").textContent = payload.status;
              });
          }, 50);
        });
      </script>
    `,
    `${scope} results`,
  );
}

function slowResultsDocument(scope: string): string {
  return html(
    `
      <div id="products">Slow results ${scope}</div>
      <div id="hydration-status">ssr</div>
      <script src="/${scope}/slow-script.js"></script>
    `,
    `${scope} slow results`,
  );
}

async function readHydrationStatus(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<string | null> {
  const mainFrame = requireMainFrame(await engine.listFrames({ pageRef }));
  const snapshot = await engine.getDomSnapshot({
    frameRef: mainFrame.frameRef,
  });
  return engine.readText(
    createLocator(snapshot, requireNodeById(snapshot.nodes, "hydration-status")),
  );
}

function requireMainFrame(frames: readonly FrameInfo[]) {
  const mainFrame = frames.find((frame) => frame.isMainFrame);
  if (mainFrame === undefined) {
    throw new Error("main frame not found");
  }
  return mainFrame;
}

function requireNodeById(nodes: readonly DomSnapshotNode[], id: string): DomSnapshotNode {
  const node = nodes.find((candidate) =>
    candidate.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
  );
  if (!node) {
    throw new Error(`node with id ${id} not found`);
  }
  return node;
}

function createLocator(snapshot: DomSnapshot, node: DomSnapshotNode) {
  if (!node.nodeRef) {
    throw new Error(`node ${String(node.snapshotNodeId)} is missing a live node ref`);
  }
  return createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPolicyWithOverrides(input: {
  readonly timeoutOverrides?: Partial<Record<string, number>>;
  readonly settleObserver?: SettleObserver;
}): OpensteerPolicy {
  const base = defaultPolicy();
  const observers =
    input.settleObserver === undefined
      ? base.settle.observers
      : [input.settleObserver, ...(base.settle.observers ?? [])];

  return {
    ...base,
    timeout: {
      resolveTimeoutMs(timeoutInput) {
        return (
          input.timeoutOverrides?.[timeoutInput.operation] ??
          base.timeout.resolveTimeoutMs(timeoutInput)
        );
      },
    },
    settle: {
      observers,
      resolveDelayMs(settleInput) {
        return base.settle.resolveDelayMs(settleInput);
      },
    },
  };
}

async function readTraceEntries(rootPath: string): Promise<readonly Record<string, unknown>[]> {
  const runsDir = path.join(rootPath, "traces", "runs");
  const runIds = await readdir(runsDir);
  const entries: Record<string, unknown>[] = [];
  for (const runId of runIds) {
    const entriesDir = path.join(runsDir, runId, "entries");
    const fileNames = (await readdir(entriesDir)).filter((fileName) => fileName.endsWith(".json"));
    for (const fileName of fileNames) {
      entries.push(
        JSON.parse(await readFile(path.join(entriesDir, fileName), "utf8")) as Record<
          string,
          unknown
        >,
      );
    }
  }
  return entries;
}
