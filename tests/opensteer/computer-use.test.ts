import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  createBodyPayload,
  createDocumentRef,
  createDevicePixelRatio,
  createPageRef,
  createPageScaleFactor,
  createPageZoomFactor,
  createScrollOffset,
  createSize,
} from "../../packages/browser-core/src/index.js";
import {
  Opensteer,
  OpensteerSessionRuntime,
  defaultPolicy,
  runWithPolicyTimeout,
} from "../../packages/opensteer/src/index.js";
import {
  OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL,
  createComputerUseRuntime,
} from "../../packages/opensteer/src/runtimes/computer-use/index.js";
import { enrichComputerUseTrace } from "../../packages/opensteer/src/runtimes/computer-use/trace-enrichment.js";
import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
} from "./phase6-fixture.js";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const started = await startServer();
  baseUrl = started.url;
  closeServer = started.close;
}, 30_000);

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

afterAll(async () => {
  await closeServer?.();
});

describe("Phase 9 computer-use runtime", () => {
  test("executes computer-use actions, persists screenshot artifacts, and enriches traces", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "phase9-computer-runtime",
      rootDir,
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
      await runtime.open({
        url: `${baseUrl}/computer/main`,
      });
      const clickResult = await runtime.computerExecute({
        action: {
          type: "click",
          x: 90,
          y: 42,
        },
        screenshot: {
          disableAnnotations: ["scrollable", "selected", "typeable"],
        },
      });
      expect(clickResult.trace?.points[0]?.point).toEqual({ x: 90, y: 42 });
      expect(clickResult.screenshot.format).toBe("webp");
      expect(clickResult.screenshot.coordinateSpace).toBe("computer-display-css");
      expect(clickResult.screenshot.size).toEqual(clickResult.displayViewport.visualViewport.size);
      expect(clickResult.screenshot.payload.delivery).toBe("external");
      expect(clickResult.screenshot.payload.mimeType).toBe("image/webp");
      const persistedScreenshotPath = fileURLToPath(clickResult.screenshot.payload.uri);
      expect(persistedScreenshotPath).toContain("/artifacts/objects/sha256/");
      const persistedScreenshot = await readFile(persistedScreenshotPath);
      const persistedMetadata = await sharp(persistedScreenshot).metadata();
      expect(persistedScreenshot.byteLength).toBe(clickResult.screenshot.payload.byteLength);
      expect(persistedMetadata.width).toBe(clickResult.screenshot.size.width);
      expect(persistedMetadata.height).toBe(clickResult.screenshot.size.height);
      expect(clickResult.displayScale).toEqual({ x: 1, y: 1 });
      expect(await extractStatus(runtime)).toBe("clicked");

      await runtime.computerExecute({
        action: {
          type: "click",
          x: 130,
          y: 108,
        },
      });
      await runtime.computerExecute({
        action: {
          type: "type",
          text: "phase9",
        },
      });
      expect(await extractMirror(runtime)).toBe("phase9");

      await runtime.computerExecute({
        action: {
          type: "key",
          key: "Enter",
        },
      });
      expect(await extractStatus(runtime)).toBe("enter");

      await runtime.computerExecute({
        action: {
          type: "scroll",
          x: 130,
          y: 280,
          deltaX: 0,
          deltaY: 180,
        },
      });
      expect(await extractStatus(runtime)).toMatch(/^scrolled \d+/);

      await runtime.computerExecute({
        action: {
          type: "drag",
          start: { x: 32, y: 398 },
          end: { x: 250, y: 398 },
          steps: 12,
        },
      });
      expect(await extractDragValue(runtime)).not.toBe("0");

      await runtime.computerExecute({
        action: {
          type: "click",
          x: 460,
          y: 42,
        },
      });
      expect(await extractStatus(runtime)).toBe("delayed settled");
      await runtime.computerExecute({
        action: {
          type: "wait",
          durationMs: 90,
        },
      });
      expect(await extractStatus(runtime)).toBe("delayed settled");

      const plainScreenshot = await runtime.computerExecute({
        action: {
          type: "screenshot",
        },
      });
      const annotatedScreenshot = await runtime.computerExecute({
        action: {
          type: "screenshot",
        },
        screenshot: {
          disableAnnotations: ["clickable", "grid", "scrollable", "selected", "typeable"],
        },
      });
      expect(annotatedScreenshot.screenshot.payload.sha256).not.toBe(
        plainScreenshot.screenshot.payload.sha256,
      );
      expect(plainScreenshot.screenshot.format).toBe("webp");
      expect(plainScreenshot.displayViewport.visualViewport.size).toEqual(
        plainScreenshot.screenshot.size,
      );
      expect(plainScreenshot.nativeViewport.visualViewport.size).toEqual({
        width: 800,
        height: 600,
      });

      const manifests = await readArtifactManifests(rootDir);
      expect(manifests.some((manifest) => manifest.kind === "screenshot")).toBe(true);

      const traceEntries = await readTraceEntries(rootDir);
      const computerEntries = traceEntries.filter(
        (entry) => entry.operation === "computer.execute",
      );
      expect(computerEntries.length).toBeGreaterThan(0);
      expect(computerEntries.some((entry) => (entry.artifacts?.length ?? 0) > 0)).toBe(true);
      expect(computerEntries.every((entry) => Array.isArray(entry.events))).toBe(true);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }, 60_000);

  test("exposes computerExecute through the public Opensteer SDK wrapper", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const opensteer = new Opensteer({
      name: "phase9-opensteer-wrapper",
      rootDir,
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
      await opensteer.open(`${baseUrl}/computer/main`);
      const output = await opensteer.computerExecute({
        action: {
          type: "click",
          x: 90,
          y: 42,
        },
      });
      expect(output.action.type).toBe("click");

      const extracted = await opensteer.extract({
        persist: "computer status through sdk wrapper",
        schema: {
          status: {
            selector: "#status",
          },
        },
      });
      expect(extracted).toEqual({
        status: "clicked",
      });
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("invalidates prior action snapshots after computer-use actions", async () => {
    const fixtureServer = await startPhase6FixtureServer();
    const rootDir = await createPhase6TemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "phase9-computer-snapshot-invalidation",
      rootDir,
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
      await runtime.open({
        url: `${fixtureServer.url}/phase6/main`,
      });

      const snapshot = await runtime.snapshot({
        mode: "action",
      });
      const counter = snapshot.counters.find((candidate) =>
        candidate.pathHint.includes("#main-action"),
      );
      if (!counter) {
        throw new Error("expected a stable action counter on the Phase 6 fixture");
      }

      await runtime.computerExecute({
        action: {
          type: "click",
          x: 100,
          y: 40,
        },
      });

      await expect(
        runtime.click({
          target: {
            kind: "element",
            element: counter.element,
          },
        }),
      ).rejects.toThrow(/no counter|did not match any elements/i);
    } finally {
      await runtime.close().catch(() => undefined);
      await fixtureServer.close();
    }
  }, 60_000);

  test("hands off the current page to popup results", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "phase9-computer-popup",
      rootDir,
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
      const opened = await runtime.open({
        url: `${baseUrl}/computer/main`,
      });
      const popup = await runtime.computerExecute({
        action: {
          type: "click",
          x: 270,
          y: 42,
        },
      });
      expect(popup.pageRef).not.toBe(opened.pageRef);

      const currentUrl = await runtime.extract({
        persist: "popup current url",
        schema: {
          currentUrl: { source: "current_url" },
        },
      });
      expect(currentUrl.data).toEqual({
        currentUrl: `${baseUrl}/computer/popup`,
      });
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }, 60_000);

  test("trace enrichment failures stay non-blocking", async () => {
    const trace = await enrichComputerUseTrace({
      action: {
        type: "click",
        x: 10,
        y: 20,
      },
      pageRef: createPageRef("trace-page"),
      engine: {
        hitTest: async () => {
          throw new Error("boom");
        },
      } as never,
      dom: {} as never,
    });

    expect(trace).toEqual({
      points: [
        {
          role: "point",
          point: { x: 10, y: 20 },
        },
      ],
    });
  });

  test("routes wait timing through the shared timeout controller instead of a preflight budget check", async () => {
    let bridgeInvoked = false;
    let abortedBySignal = false;
    const viewport = createViewportMetrics(32, 24);
    const runtime = createComputerUseRuntime({
      engine: {
        async getViewportMetrics() {
          return viewport;
        },
        async getActionBoundarySnapshot(input: { readonly pageRef: string }) {
          return createActionBoundarySnapshot(input.pageRef);
        },
        [OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL]() {
          return {
            async execute(input: { readonly pageRef: string; readonly signal: AbortSignal }) {
              bridgeInvoked = true;
              try {
                await waitForAbortableDelay(100, input.signal);
              } catch (error) {
                abortedBySignal = input.signal.aborted;
                throw error;
              }

              return {
                pageRef: input.pageRef,
                screenshot: {
                  pageRef: input.pageRef,
                  payload: createBodyPayload(new Uint8Array([1, 2, 3]), {
                    mimeType: "image/png",
                  }),
                  format: "png",
                  size: createSize(32, 24),
                  coordinateSpace: "layout-viewport-css",
                },
                viewport,
                events: [],
                timing: {
                  actionMs: 100,
                  waitMs: 0,
                  totalMs: 100,
                },
              };
            },
          };
        },
      } as never,
      dom: {} as never,
      policy: defaultPolicy(),
    });

    await expect(
      runWithPolicyTimeout(
        {
          resolveTimeoutMs() {
            return 25;
          },
        },
        {
          operation: "computer.execute",
        },
        (timeout) =>
          runtime.execute({
            pageRef: createPageRef("wait-timeout"),
            input: {
              action: {
                type: "wait",
                durationMs: 100,
              },
            },
            timeout,
          }),
      ),
    ).rejects.toMatchObject({
      code: "timeout",
    });

    expect(bridgeInvoked).toBe(true);
    expect(abortedBySignal).toBe(true);
  });

  test("normalizes oversized computer screenshots and translates display clicks back to native space", async () => {
    const nativeViewport = createViewportMetrics(1920, 1200);
    const screenshotBytes = await sharp({
      create: {
        width: 1920,
        height: 1200,
        channels: 3,
        background: "#d0e4ff",
      },
    })
      .png()
      .toBuffer();

    let receivedAction:
      | {
          readonly type: string;
          readonly x: number;
          readonly y: number;
        }
      | undefined;

    const runtime = createComputerUseRuntime({
      engine: {
        async getViewportMetrics() {
          return nativeViewport;
        },
        async getActionBoundarySnapshot(input: { readonly pageRef: string }) {
          return createActionBoundarySnapshot(input.pageRef);
        },
        [OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL]() {
          return {
            async execute(input: {
              readonly pageRef: string;
              readonly action: {
                readonly type: string;
                readonly x: number;
                readonly y: number;
              };
            }) {
              receivedAction = input.action;
              return {
                pageRef: input.pageRef,
                screenshot: {
                  pageRef: input.pageRef,
                  payload: createBodyPayload(new Uint8Array(screenshotBytes), {
                    mimeType: "image/png",
                  }),
                  format: "png",
                  size: createSize(1920, 1200),
                  coordinateSpace: "layout-viewport-css",
                },
                viewport: nativeViewport,
                events: [],
                timing: {
                  actionMs: 10,
                  waitMs: 0,
                  totalMs: 10,
                },
              };
            },
          };
        },
      } as never,
      dom: {} as never,
      policy: defaultPolicy(),
    });

    const output = await runWithPolicyTimeout(
      {
        resolveTimeoutMs() {
          return 30_000;
        },
      },
      {
        operation: "computer.execute",
      },
      (timeout) =>
        runtime.execute({
          pageRef: createPageRef("scaled"),
          input: {
            action: {
              type: "click",
              x: 200,
              y: 100,
            },
          },
          timeout,
        }),
    );

    expect(output.screenshot.format).toBe("webp");
    expect(output.screenshot.coordinateSpace).toBe("computer-display-css");
    expect(output.screenshot.size).toEqual(output.displayViewport.visualViewport.size);
    expect(output.nativeViewport).toEqual(nativeViewport);
    expect(output.displayScale.x).toBeLessThan(1);
    expect(output.displayScale.y).toBeLessThan(1);
    expect(receivedAction?.x).toBeCloseTo(200 / output.displayScale.x, 3);
    expect(receivedAction?.y).toBeCloseTo(100 / output.displayScale.y, 3);
    expect(output.trace?.points[0]?.point.x).toBeCloseTo(200, 3);
    expect(output.trace?.points[0]?.point.y).toBeCloseTo(100, 3);

    const metadata = await sharp(Buffer.from(output.screenshot.payload.bytes)).metadata();
    expect(metadata.width).toBe(output.screenshot.size.width);
    expect(metadata.height).toBe(output.screenshot.size.height);
  });
});

async function extractStatus(runtime: OpensteerSessionRuntime): Promise<string> {
  const result = await runtime.extract({
    persist: "computer status",
    schema: {
      status: {
        selector: "#status",
      },
    },
  });
  return (result.data as { readonly status: string }).status;
}

async function extractMirror(runtime: OpensteerSessionRuntime): Promise<string> {
  const result = await runtime.extract({
    persist: "computer mirror",
    schema: {
      mirror: {
        selector: "#mirror",
      },
    },
  });
  return (result.data as { readonly mirror: string }).mirror;
}

async function extractDragValue(runtime: OpensteerSessionRuntime): Promise<string> {
  const result = await runtime.extract({
    persist: "computer drag value",
    schema: {
      dragValue: {
        selector: "#drag-value",
      },
    },
  });
  return (result.data as { readonly dragValue: string }).dragValue;
}

async function readArtifactManifests(rootDir: string): Promise<readonly Record<string, unknown>[]> {
  const manifestsDir = path.join(rootDir, "artifacts", "manifests");
  const fileNames = await readdir(manifestsDir);
  return Promise.all(
    fileNames.map(
      async (fileName) =>
        JSON.parse(await readFile(path.join(manifestsDir, fileName), "utf8")) as Record<
          string,
          unknown
        >,
    ),
  );
}

async function readTraceEntries(rootDir: string): Promise<readonly Record<string, any>[]> {
  const runsDir = path.join(rootDir, "traces", "runs");
  const runIds = await readdir(runsDir);
  const entries: Record<string, any>[] = [];
  for (const runId of runIds) {
    const entriesDir = path.join(runsDir, runId, "entries");
    const fileNames = (await readdir(entriesDir)).filter((fileName) => fileName.endsWith(".json"));
    for (const fileName of fileNames) {
      entries.push(
        JSON.parse(await readFile(path.join(entriesDir, fileName), "utf8")) as Record<string, any>,
      );
    }
  }
  return entries;
}

async function startServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start computer-use fixture server");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/computer/main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocumentHtml());
    return;
  }

  if (url.pathname === "/computer/popup") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <main id="popup-main">Popup page</main>
        `,
        "Computer Popup",
      ),
    );
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

function mainDocumentHtml(): string {
  return html(
    `
      <button id="click-button" type="button">Click</button>
      <button id="popup-button" type="button">Popup</button>
      <button id="delayed-button" type="button">Delayed</button>
      <input id="main-input" type="text" />
      <div id="mirror"></div>
      <div id="status">ready</div>
      <div id="scroll-box">
        <div id="scroll-anchor">Scroll anchor</div>
        <div style="height: 900px;"></div>
      </div>
      <div id="track">
        <div id="handle"></div>
      </div>
      <div id="drag-value">0</div>
      <script>
        const status = document.getElementById("status");
        const input = document.getElementById("main-input");
        const mirror = document.getElementById("mirror");
        const scrollBox = document.getElementById("scroll-box");
        const popupButton = document.getElementById("popup-button");
        const delayedButton = document.getElementById("delayed-button");
        const clickButton = document.getElementById("click-button");
        const track = document.getElementById("track");
        const handle = document.getElementById("handle");
        const dragValue = document.getElementById("drag-value");

        clickButton.addEventListener("click", () => {
          status.textContent = "clicked";
        });
        popupButton.addEventListener("click", () => {
          window.open("/computer/popup", "_blank");
        });
        delayedButton.addEventListener("click", () => {
          status.textContent = "delayed pending";
          setTimeout(() => {
            status.textContent = "delayed settled";
          }, 50);
        });
        input.addEventListener("input", (event) => {
          mirror.textContent = event.target.value;
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            status.textContent = "enter";
          }
        });
        scrollBox.addEventListener("scroll", () => {
          status.textContent = "scrolled " + String(scrollBox.scrollTop);
        });

        let dragging = false;
        const maxLeft = track.clientWidth - handle.clientWidth;
        const updateHandle = (clientX) => {
          const rect = track.getBoundingClientRect();
          const left = Math.max(0, Math.min(maxLeft, clientX - rect.left - handle.clientWidth / 2));
          handle.style.left = left + "px";
          dragValue.textContent = String(Math.round((left / maxLeft) * 100));
        };
        handle.addEventListener("mousedown", (event) => {
          dragging = true;
          event.preventDefault();
          updateHandle(event.clientX);
        });
        window.addEventListener("mousemove", (event) => {
          if (dragging) {
            updateHandle(event.clientX);
          }
        });
        window.addEventListener("mouseup", () => {
          if (!dragging) {
            return;
          }
          dragging = false;
          status.textContent = "dragged " + dragValue.textContent;
        });
      </script>
    `,
    "Computer Main",
  );
}

function html(body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      button, input { font: inherit; }
      #click-button, #popup-button, #delayed-button, #main-input, #mirror, #status, #scroll-box, #track, #drag-value {
        position: absolute;
      }
      #click-button { left: 20px; top: 20px; width: 140px; height: 44px; }
      #popup-button { left: 200px; top: 20px; width: 140px; height: 44px; }
      #delayed-button { left: 380px; top: 20px; width: 160px; height: 44px; }
      #main-input { left: 20px; top: 90px; width: 220px; height: 36px; }
      #mirror { left: 20px; top: 136px; width: 220px; min-height: 20px; }
      #status { left: 20px; top: 170px; width: 320px; min-height: 20px; }
      #scroll-box { left: 20px; top: 220px; width: 220px; height: 120px; overflow: auto; border: 1px solid #222; }
      #scroll-anchor { height: 40px; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #ccc; }
      #track { left: 20px; top: 380px; width: 300px; height: 36px; background: #e9e9e9; border-radius: 999px; }
      #handle { position: absolute; left: 0; top: 0; width: 24px; height: 36px; border-radius: 999px; background: #1a73e8; }
      #drag-value { left: 340px; top: 388px; min-width: 40px; }
      #popup-main { padding: 24px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function waitForAbortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createViewportMetrics(width: number, height: number) {
  return {
    layoutViewport: {
      origin: { x: 0, y: 0 },
      size: createSize(width, height),
    },
    visualViewport: {
      origin: { x: 0, y: 0 },
      offsetWithinLayoutViewport: createScrollOffset(0, 0),
      size: createSize(width, height),
    },
    scrollOffset: createScrollOffset(0, 0),
    contentSize: createSize(width, height),
    devicePixelRatio: createDevicePixelRatio(1),
    pageScaleFactor: createPageScaleFactor(1),
    pageZoomFactor: createPageZoomFactor(1),
  };
}

function createActionBoundarySnapshot(pageRef: string) {
  const pageId = pageRef.replace(/^page:/u, "");
  return {
    pageRef: createPageRef(pageRef),
    documentRef: createDocumentRef(`${pageId}-document`),
  };
}
