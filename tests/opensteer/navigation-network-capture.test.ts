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
let suiteRootDir = "";

function createLocalOpensteer(options: ConstructorParameters<typeof Opensteer>[0] = {}): Opensteer {
  return new Opensteer({
    provider: {
      mode: "local",
    },
    ...(options.rootDir === undefined && options.rootPath === undefined
      ? { rootDir: suiteRootDir }
      : {}),
    ...options,
  });
}

describe.sequential("cross-document action boundary", () => {
  beforeAll(async () => {
    suiteRootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-navigation-network-"));
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
    if (suiteRootDir.length > 0) {
      await rm(suiteRootDir, { recursive: true, force: true });
    }
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

  test("waits for same-document Enter transitions in the DOM runtime", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/runtime/same-document-enter`,
      });

      const startedAt = Date.now();
      await dom.input({
        pageRef: created.data.pageRef,
        target: {
          kind: "selector",
          selector: "#search-input",
        },
        text: "airpods",
        pressEnter: true,
      });
      const elapsed = Date.now() - startedAt;

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/runtime/api/hydration"))?.status,
      ).toBe(200);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("waits for same-document click transitions in the DOM runtime", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: `${baseUrl}/runtime/same-document-click`,
      });

      const startedAt = Date.now();
      await dom.click({
        pageRef: created.data.pageRef,
        target: {
          kind: "selector",
          selector: "#continue",
        },
      });
      const elapsed = Date.now() - startedAt;

      expect(await readHydrationStatus(engine, created.data.pageRef)).toBe("hydrated");
      expect(
        (
          await engine.getNetworkRecords({
            sessionRef,
            pageRef: created.data.pageRef,
          })
        ).find((record) => record.url.includes("/runtime/api/hydration"))?.status,
      ).toBe(200);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("captures named hydration requests after pressEnter navigation", async () => {
    const opensteer = createLocalOpensteer({
      workspace: "navigation-network-capture",
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
          persist: "hydration status",
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
      expect(records.find((entry) => entry.url.includes("/sdk/api/hydration"))?.status).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("reuses persisted input descriptors through the SDK wrapper", async () => {
    const opensteer = createLocalOpensteer({
      workspace: "navigation-network-persisted-input",
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/same-document-enter`);
      await opensteer.input({
        selector: "#search-input",
        text: "airpods",
        persist: "search input descriptor",
      });
      await opensteer.input({
        persist: "search input descriptor",
        text: "airpods",
        pressEnter: true,
        captureNetwork: "persisted-input",
      });

      await expect(
        opensteer.extract({
          persist: "persisted input hydration status",
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
        capture: "persisted-input",
        limit: 20,
      });
      expect(records.find((entry) => entry.url.includes("/sdk/api/hydration"))?.status).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("pressEnter submits even when typing keeps bootstrap trackers noisy", async () => {
    const opensteer = createLocalOpensteer({
      workspace: "navigation-network-noisy-enter",
      browser: "temporary",
      launch: {
        headless: true,
      },
      policy: createPolicyWithOverrides({
        timeoutOverrides: {
          "dom.input": 5_000,
        },
      }),
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/noisy-enter`);
      await opensteer.input({
        selector: "#search-input",
        text: "airpods",
        pressEnter: true,
        captureNetwork: "noisy-enter",
      });

      await expect(
        opensteer.extract({
          persist: "noisy hydration status",
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
        capture: "noisy-enter",
        limit: 20,
      });
      expect(records.find((entry) => entry.url.includes("/sdk/api/hydration"))?.status).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("click navigations succeed even when the destination page keeps scheduling timers", async () => {
    const opensteer = createLocalOpensteer({
      workspace: "navigation-network-noisy-click",
      browser: "temporary",
      launch: {
        headless: true,
      },
      policy: createPolicyWithOverrides({
        timeoutOverrides: {
          "dom.click": 5_000,
        },
      }),
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/noisy-click`);
      await opensteer.click({
        selector: "#continue",
        captureNetwork: "noisy-click",
      });

      await expect(
        opensteer.extract({
          persist: "noisy click hydration status",
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
        capture: "noisy-click",
        limit: 20,
      });
      expect(records.find((entry) => entry.url.includes("/sdk/api/hydration"))?.status).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("does not persist action-triggered network without captureNetwork", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-no-capture-"));
    const opensteer = createLocalOpensteer({
      workspace: "navigation-network-no-capture",
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
          persist: "hydration status without capture",
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

  test("records session.fetch failures without crashing trace logging when no transport succeeds", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-fetch-trace-"));
    const opensteer = createLocalOpensteer({
      workspace: "session-fetch-trace-failure",
      rootPath,
      cleanupRootOnClose: false,
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/sdk/hydration-enter`);
      await expect(
        opensteer.fetch("http://127.0.0.1:1/unreachable", {
          transport: "direct",
        }),
      ).rejects.toThrow(
        /no transport completed successfully|session\.fetch did not produce a response/i,
      );

      const traces = await readTraceEntries(rootPath);
      const fetchTrace = [...traces]
        .reverse()
        .find((entry) => entry.operation === "session.fetch" && entry.outcome === "ok") as
        | {
            readonly data?: Record<string, unknown>;
          }
        | undefined;
      expect(fetchTrace?.data).toMatchObject({
        attempts: 1,
        url: "http://127.0.0.1:1/unreachable",
      });
      expect(fetchTrace?.data && "transport" in fetchTrace.data).toBe(false);
    } finally {
      await opensteer.close().catch(() => undefined);
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 60_000);

  test("waits for same-tab navigation hydration before returning computer-use clicks", async () => {
    const opensteer = createLocalOpensteer({
      workspace: "computer-action-boundary",
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
          persist: "computer hydration status",
          schema: {
            status: {
              selector: "#hydration-status",
            },
          },
        }),
      ).resolves.toEqual({
        status: "hydrated",
      });

      await expect(
        opensteer.extract({
          persist: "computer current page",
          schema: {
            url: {
              source: "current_url",
            },
          },
        }),
      ).resolves.toEqual({
        url: `${baseUrl}/computer/hydration-results?mode=click`,
      });
      expect(
        (
          await opensteer.queryNetwork({
            limit: 20,
          })
        ).records.find((entry) => entry.url.includes("/computer/api/hydration"))?.status,
      ).toBe(200);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("returns success and records degraded visual settle traces", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-soft-settle-"));
    const opensteer = createLocalOpensteer({
      workspace: "soft-settle-boundary",
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
        url: "/sdk/api/hydration",
        limit: 20,
      });
      expect(records.find((entry) => entry.url.includes("/sdk/api/hydration"))?.status).toBe(200);

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
    const opensteer = createLocalOpensteer({
      workspace: "hard-boundary-timeout",
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
    const opensteer = createLocalOpensteer({
      workspace: "timeout-persist",
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

  if (route === "noisy-enter") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(noisyEnterDocument(scope));
    return;
  }

  if (route === "hydration-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(hydrationClickDocument(scope));
    return;
  }

  if (route === "same-document-enter") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(sameDocumentEnterDocument(scope));
    return;
  }

  if (route === "same-document-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(sameDocumentClickDocument(scope));
    return;
  }

  if (route === "noisy-click") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(noisyClickDocument(scope));
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

  if (route === "api" && url.pathname.endsWith("/api/poll")) {
    await wait(30);
    response.statusCode = 204;
    response.end();
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

function noisyEnterDocument(scope: string): string {
  return html(
    `
      <form id="search-form" action="/${scope}/hydration-results?mode=noisy-enter" method="GET">
        <input id="search-input" name="q" type="text" value="" />
        <button id="search-submit" type="submit">Search</button>
      </form>
      <script>
        const input = document.getElementById("search-input");
        let keepScheduling = false;

        input.addEventListener("input", () => {
          if (keepScheduling) {
            return;
          }
          keepScheduling = true;

          const schedule = () => {
            if (!keepScheduling) {
              return;
            }
            setTimeout(schedule, 0);
          };

          schedule();
        });

        document.getElementById("search-form").addEventListener("submit", () => {
          keepScheduling = false;
        });
      </script>
    `,
    `${scope} noisy enter`,
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

function noisyClickDocument(scope: string): string {
  return html(
    `
      <a id="continue" href="/${scope}/hydration-results?mode=noisy-click">Open results</a>
    `,
    `${scope} noisy click`,
  );
}

function sameDocumentEnterDocument(scope: string): string {
  return html(
    `
      <form id="search-form" action="/${scope}/same-document-enter" method="GET">
        <input id="search-input" name="q" type="text" value="" />
        <button id="search-submit" type="submit">Search</button>
      </form>
      <div id="products"></div>
      <div id="hydration-status">idle</div>
      <script>
        const form = document.getElementById("search-form");
        const input = document.getElementById("search-input");
        const status = document.getElementById("hydration-status");
        const products = document.getElementById("products");

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (status) {
            status.textContent = "loading";
          }
          const query = encodeURIComponent(input.value || "");
          const response = await fetch("/${scope}/api/hydration?mode=same-document-enter&q=" + query);
          const payload = await response.json();
          if (products) {
            products.textContent = "results:" + (payload.mode || "unknown");
          }
          if (status) {
            status.textContent = String(payload.status || "unknown");
          }
          let count = 0;
          window.__sameDocumentPoll = window.setInterval(() => {
            count += 1;
            fetch("/${scope}/api/poll?i=" + count).catch(() => {});
            if (count >= 25) {
              window.clearInterval(window.__sameDocumentPoll);
            }
          }, 100);
        });
      </script>
    `,
    `${scope} same document enter`,
  );
}

function sameDocumentClickDocument(scope: string): string {
  return html(
    `
      <button id="continue" type="button">Load results</button>
      <div id="products"></div>
      <div id="hydration-status">idle</div>
      <script>
        const button = document.getElementById("continue");
        const status = document.getElementById("hydration-status");
        const products = document.getElementById("products");

        button.addEventListener("click", async () => {
          if (status) {
            status.textContent = "loading";
          }
          const response = await fetch("/${scope}/api/hydration?mode=same-document-click");
          const payload = await response.json();
          if (products) {
            products.textContent = "results:" + (payload.mode || "unknown");
          }
          if (status) {
            status.textContent = String(payload.status || "unknown");
          }
          let count = 0;
          window.__sameDocumentPoll = window.setInterval(() => {
            count += 1;
            fetch("/${scope}/api/poll?i=" + count).catch(() => {});
            if (count >= 25) {
              window.clearInterval(window.__sameDocumentPoll);
            }
          }, 100);
        });
      </script>
    `,
    `${scope} same document click`,
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
        if (${JSON.stringify(mode)} === "noisy-click") {
          const schedule = () => {
            setTimeout(schedule, 0);
          };
          schedule();
        }

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
