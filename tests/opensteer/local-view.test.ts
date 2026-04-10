import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OpensteerSessionRuntime } from "../../packages/opensteer/src/index.js";
import { bestEffortRegisterLocalViewSession } from "../../packages/opensteer/src/local-view/registration.js";
import {
  resolveLocalViewMode,
  setLocalViewMode,
} from "../../packages/opensteer/src/local-view/preferences.js";
import { stopLocalViewService } from "../../packages/opensteer/src/local-view/service.js";
import { readLocalViewServiceState } from "../../packages/opensteer/src/local-view/service-state.js";
import { startLocalViewServer } from "../../packages/opensteer/src/local-view/server.js";
import { isProcessRunning } from "../../packages/opensteer/src/local-browser/process-owner.js";

let fixtureUrl = "";
let closeFixtureServer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const started = await startFixtureServer();
  fixtureUrl = started.url;
  closeFixtureServer = started.close;
});

afterAll(async () => {
  await closeFixtureServer?.();
});

describe("local browser view", () => {
  test("renders the brand logo without an external image request", async () => {
    const localViewServer = await startLocalViewServer({
      token: "local-view-logo-test-token",
    });

    try {
      const htmlResponse = await fetch(localViewServer.url);
      expect(htmlResponse.ok).toBe(true);
      expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
      const html = await htmlResponse.text();
      expect(html).toContain('class="brand-icon"');
      expect(html).toContain('id="opensteer-brand-fill"');
      expect(html).toContain('data-testid="stop-view-button"');
      expect(html).not.toContain('class="brand-icon" src=');
      expect(html).not.toContain("opensteer-logo.png");
      expect(html).not.toContain("opensteer-logo.svg");
      expect(html).not.toContain("data:image/png;base64");
    } finally {
      await localViewServer.close().catch(() => undefined);
    }
  });

  test("manual mode registers sessions without starting the service", async () => {
    const priorOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-manual-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("manual");

      const manifest = await bestEffortRegisterLocalViewSession({
        rootPath: path.join(stateHome, "workspace-manual"),
        workspace: "workspace-manual",
        ownership: "owned",
        live: {
          layout: "opensteer-session",
          version: 1,
          provider: "local",
          engine: "playwright",
          pid: process.pid,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          userDataDir: path.join(stateHome, "user-data"),
        },
      });

      expect(manifest?.workspace).toBe("workspace-manual");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await readLocalViewServiceState()).toBeUndefined();
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (priorOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = priorOpensteerHome;
      }
    }
  });

  test("auto mode starts the service when a browser session is registered", async () => {
    const priorOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-auto-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("auto");

      const manifest = await bestEffortRegisterLocalViewSession({
        rootPath: path.join(stateHome, "workspace-auto"),
        workspace: "workspace-auto",
        ownership: "owned",
        live: {
          layout: "opensteer-session",
          version: 1,
          provider: "local",
          engine: "playwright",
          pid: process.pid,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          userDataDir: path.join(stateHome, "user-data"),
        },
      });

      expect(manifest?.workspace).toBe("workspace-auto");
      const service = await waitFor(async () => {
        const current = await readLocalViewServiceState();
        if (!current) {
          return null;
        }
        const health = await fetch(new URL("/api/health", current.url), {
          headers: {
            "x-opensteer-local-token": current.token,
          },
        }).catch(() => null);
        return health?.ok === true ? current : null;
      }, 10_000);
      expect(service.url).toContain("127.0.0.1");
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (priorOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = priorOpensteerHome;
      }
    }
  });

  test("stops local view without changing preferences", async () => {
    const priorOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-state-"));
    process.env.OPENSTEER_HOME = stateHome;
    await setLocalViewMode("manual");
    const localViewServer = await startLocalViewServer({
      token: "local-view-stop-test-token",
    });

    try {
      const response = await fetch(new URL("/api/service/stop", localViewServer.url), {
        method: "POST",
        headers: {
          "x-opensteer-local-token": localViewServer.token,
        },
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ stopped: true });
      expect(await resolveLocalViewMode()).toBe("manual");
      await waitFor(async () => {
        const health = await fetch(new URL("/api/health", localViewServer.url), {
          headers: {
            "x-opensteer-local-token": localViewServer.token,
          },
        }).catch(() => null);
        return health === null ? true : null;
      }, 5_000);
    } finally {
      await localViewServer.close().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (priorOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = priorOpensteerHome;
      }
    }
  });

  test("stops the service from the UI without changing preferences", async () => {
    const priorOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-ui-stop-"));
    process.env.OPENSTEER_HOME = stateHome;
    await setLocalViewMode("manual");
    const localViewServer = await startLocalViewServer({
      token: "local-view-ui-stop-test-token",
    });
    const viewerBrowser = await chromium.launch({ headless: true });

    try {
      const page = await viewerBrowser.newPage();
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(localViewServer.url, { waitUntil: "domcontentloaded" });
      await page.getByTestId("stop-view-button").click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-testid='status-text']")?.textContent ===
          "Service stopped. Run `opensteer view` to restart.",
      );

      expect(await resolveLocalViewMode()).toBe("manual");
      await waitFor(async () => {
        const health = await fetch(new URL("/api/health", localViewServer.url), {
          headers: {
            "x-opensteer-local-token": localViewServer.token,
          },
        }).catch(() => null);
        return health === null ? true : null;
      }, 5_000);
    } finally {
      await viewerBrowser.close().catch(() => undefined);
      await localViewServer.close().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (priorOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = priorOpensteerHome;
      }
    }
  });

  test(
    "streams a temporary local browser and forwards click and text input through the viewer",
    { timeout: 90_000 },
    async () => {
      const priorOpensteerHome = process.env.OPENSTEER_HOME;
      const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-manual-ui-"));
      process.env.OPENSTEER_HOME = stateHome;
      await setLocalViewMode("manual");
      const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-local-view-"));
      const runtime = new OpensteerSessionRuntime({
        name: "local-view-runtime",
        rootPath,
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

      const viewerBrowser = await chromium.launch({ headless: true });
      let localViewServer: Awaited<ReturnType<typeof startLocalViewServer>> | undefined;

      try {
        await runtime.open({ url: `${fixtureUrl}/viewer` });
        localViewServer = await startLocalViewServer({
          token: "local-view-test-token",
        });

        const session = await waitFor(async () => {
          const response = await fetch(new URL("/api/sessions", localViewServer.url), {
            headers: {
              "x-opensteer-local-token": localViewServer.token,
            },
          });
          if (!response.ok) {
            return null;
          }
          const payload = await response.json();
          const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
          return sessions.find((candidate) => candidate.rootPath === rootPath) ?? null;
        });

        const page = await viewerBrowser.newPage({
          viewport: {
            width: 1800,
            height: 900,
          },
        });
        await page.goto(`${localViewServer.url}#session=${encodeURIComponent(session.sessionId)}`, {
          waitUntil: "networkidle",
        });

        await page.waitForFunction(() => {
          const image = document.querySelector("[data-testid='viewer-image']");
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        });
        const browserLayout = await waitFor(async () => {
          const layout = await readBrowserFrameLayout(page);
          return layout.viewportWidth > 100 && layout.viewportHeight > 100 ? layout : null;
        });
        expect(browserLayout.frameWidth).toBeLessThanOrEqual(browserLayout.areaWidth + 1);
        expect(browserLayout.frameHeight).toBeLessThanOrEqual(browserLayout.areaHeight + 1);
        expect(browserLayout.areaHeight).toBeLessThanOrEqual(browserLayout.windowHeight + 1);
        expect(browserLayout.frameBottom).toBeLessThanOrEqual(browserLayout.windowHeight + 1);
        expect(browserLayout.viewportWidth / browserLayout.viewportHeight).toBeCloseTo(
          800 / 600,
          1,
        );
        expect(browserLayout.frameHeight).toBeCloseTo(
          browserLayout.chromeHeight + browserLayout.viewportHeight + 2,
          0,
        );
        await page.waitForFunction(
          ({ sessionId, label }) => {
            const status = document.querySelector("[data-testid='status-text']");
            return (
              typeof status?.textContent === "string" &&
              status.textContent.includes(label) &&
              status.textContent.includes("stream live") &&
              status.textContent.includes("cdp connected") &&
              window.location.hash.includes(encodeURIComponent(sessionId))
            );
          },
          {
            sessionId: session.sessionId,
            label: session.label,
          },
        );

        const frameStateBeforeMetadataUpdate = await readViewerFrameState(page);
        expect(frameStateBeforeMetadataUpdate.imageVisible).toBe(true);
        expect(frameStateBeforeMetadataUpdate.emptyVisible).toBe(false);
        await runtime.evaluate({
          script: `() => {
            document.title = "OpenSteer Local Fixture Metadata Updated";
          }`,
        });
        await waitFor(async () => {
          const activeTabText = await readActiveTabText(page);
          return activeTabText.includes("Metadata Updated") ? activeTabText : null;
        }, 5_000);
        const frameStateAfterMetadataUpdate = await readViewerFrameState(page);
        expect(frameStateAfterMetadataUpdate.imageVisible).toBe(true);
        expect(frameStateAfterMetadataUpdate.emptyVisible).toBe(false);

        const clickTarget = await readRemoteElementCenterRatio(runtime, "#action");
        const clickPosition = await readViewerPosition(
          page,
          clickTarget.xRatio,
          clickTarget.yRatio,
        );
        await page.mouse.click(clickPosition.x, clickPosition.y);

        await waitFor(async () => {
          const result = await runtime.evaluate({
            script: "() => document.getElementById('status')?.textContent ?? ''",
          });
          const status =
            result && typeof result === "object" && "value" in result ? result.value : undefined;
          return status === "clicked" ? status : null;
        });

        const inputTarget = await readRemoteElementCenterRatio(runtime, "#entry");
        const inputPosition = await readViewerPosition(
          page,
          inputTarget.xRatio,
          inputTarget.yRatio,
        );
        await page.mouse.click(inputPosition.x, inputPosition.y);
        await page.keyboard.type("Phase9");

        const mirroredText = await waitFor(async () => {
          const result = await runtime.evaluate({
            script: "() => document.getElementById('mirror')?.textContent ?? ''",
          });
          const value =
            result && typeof result === "object" && "value" in result ? result.value : undefined;
          return value === "Phase9" ? value : null;
        });
        expect(mirroredText).toBe("Phase9");

        const tabs = page.locator("#tab-strip .tab-button");
        expect(await tabs.count()).toBe(1);
        await page.locator("[data-testid='new-tab-button']").click();
        const tabCount = await waitFor(async () => {
          const count = await tabs.count();
          return count === 2 ? count : null;
        });
        expect(tabCount).toBe(2);
        const tabCloseLayouts = await readTabCloseLayouts(page);
        expect(tabCloseLayouts.length).toBeGreaterThanOrEqual(2);
        for (const layout of tabCloseLayouts) {
          expect(layout.closeLeft).toBeGreaterThanOrEqual(layout.chipLeft);
          expect(layout.closeRight).toBeLessThanOrEqual(layout.chipRight);
          expect(layout.closeTop).toBeGreaterThanOrEqual(layout.chipTop);
          expect(layout.closeBottom).toBeLessThanOrEqual(layout.chipBottom);
        }
        await waitFor(async () => {
          const activeTabText = await readActiveTabText(page);
          return activeTabText.includes("about:blank") || activeTabText.includes("Untitled")
            ? activeTabText
            : null;
        });

        const frameBeforeNavigation = await readViewerImageSrc(page);
        await page.locator("[data-testid='address-input']").fill(`${fixtureUrl}/destination`);
        await page.locator("[data-testid='address-input']").press("Enter");
        await waitFor(async () => {
          const activeTabText = await readActiveTabText(page);
          return activeTabText.includes("Destination") ? activeTabText : null;
        });
        await waitFor(async () => {
          const value = await page.locator("[data-testid='address-input']").inputValue();
          return value === `${fixtureUrl}/destination` ? value : null;
        }, 10_000);
        await waitFor(async () => {
          const nextFrame = await readViewerImageSrc(page);
          return nextFrame && nextFrame !== frameBeforeNavigation ? nextFrame : null;
        }, 10_000);

        const destinationButton = await readViewerPosition(page, 150 / 800, 100 / 600);
        await page.mouse.click(destinationButton.x, destinationButton.y);
        await waitFor(async () => {
          const activeTabText = await readActiveTabText(page);
          return activeTabText.includes("Clicked") ? activeTabText : null;
        });

        const closeButton = page.locator("[data-testid='close-browser-button']");
        expect(await closeButton.isEnabled()).toBe(true);
        page.once("dialog", async (dialog) => {
          expect(dialog.type()).toBe("confirm");
          expect(dialog.message()).toContain(session.label);
          await dialog.dismiss();
        });
        await closeButton.click();
        expect(isProcessRunning(session.pid)).toBe(true);

        page.once("dialog", async (dialog) => {
          expect(dialog.type()).toBe("confirm");
          await dialog.accept();
        });
        await closeButton.click();

        await waitFor(async () => (isProcessRunning(session.pid) ? null : true), 20_000);
        const sessionsAfterClose = await waitFor(async () => {
          const response = await fetch(new URL("/api/sessions", localViewServer.url), {
            headers: {
              "x-opensteer-local-token": localViewServer.token,
            },
          });
          if (!response.ok) {
            return null;
          }
          const payload = await response.json();
          const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
          return sessions.some((candidate) => candidate.sessionId === session.sessionId)
            ? null
            : sessions;
        }, 20_000);
        expect(
          sessionsAfterClose.some((candidate) => candidate.sessionId === session.sessionId),
        ).toBe(false);
        await page.waitForFunction(
          (sessionId) => !window.location.hash.includes(encodeURIComponent(sessionId)),
          session.sessionId,
        );
      } finally {
        await viewerBrowser.close().catch(() => undefined);
        await localViewServer?.close().catch(() => undefined);
        await runtime.close().catch(() => undefined);
        await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
        await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
        if (priorOpensteerHome === undefined) {
          delete process.env.OPENSTEER_HOME;
        } else {
          process.env.OPENSTEER_HOME = priorOpensteerHome;
        }
      }
    },
  );
});

async function startFixtureServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (url.pathname === "/destination") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Destination</title>
    <style>
      body {
        margin: 0;
        background: #fff7ed;
        color: #172554;
        font-family: Inter, system-ui, sans-serif;
      }
      main {
        width: 800px;
        min-height: 600px;
        padding: 40px;
        box-sizing: border-box;
      }
      #dest-action {
        width: 220px;
        height: 120px;
        border: 0;
        border-radius: 8px;
        background: #2563eb;
        color: #fff;
        font-size: 28px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <button id="dest-action" type="button">Destination</button>
    </main>
    <script>
      document.getElementById("dest-action").addEventListener("click", () => {
        window.location.href = "/clicked";
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (url.pathname === "/clicked") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Clicked</title>
  </head>
  <body>
    <main>Clicked</main>
  </body>
</html>`);
      return;
    }

    if (url.pathname !== "/viewer") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenSteer Local Fixture</title>
    <style>
      body {
        margin: 0;
        background: #f4f7fb;
        color: #132033;
        font-family: Inter, system-ui, sans-serif;
      }
      main {
        width: 800px;
        min-height: 600px;
        padding: 40px;
        box-sizing: border-box;
      }
      #action {
        width: 220px;
        height: 120px;
        border: 0;
        border-radius: 8px;
        background: #0f8d5f;
        color: #fff;
        font-size: 28px;
        font-weight: 600;
      }
      #status,
      #mirror {
        margin-top: 24px;
        font-size: 24px;
      }
      label {
        display: block;
        margin-top: 44px;
        font-size: 18px;
        font-weight: 600;
      }
      #entry {
        margin-top: 12px;
        width: 280px;
        padding: 14px 16px;
        font-size: 20px;
        border: 2px solid #b9c7d8;
        border-radius: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <button id="action" type="button">Launch</button>
      <div id="status">ready</div>

      <label for="entry">Input</label>
      <input id="entry" type="text" autocomplete="off" />
      <div id="mirror"></div>
    </main>
    <script>
      document.getElementById("action").addEventListener("click", () => {
        document.getElementById("status").textContent = "clicked";
      });

      document.getElementById("entry").addEventListener("input", (event) => {
        document.getElementById("mirror").textContent = event.target.value;
      });
    </script>
  </body>
</html>`);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local-view fixture server address.");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function readActiveTabText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const activeTab = document.querySelector('#tab-strip .tab-button[data-active="true"]');
    return activeTab?.textContent ?? "";
  });
}

async function readViewerImageSrc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const image = document.querySelector("[data-testid='viewer-image']");
    return image instanceof HTMLImageElement ? image.src : "";
  });
}

async function readViewerFrameState(page: Page): Promise<{
  readonly imageVisible: boolean;
  readonly emptyVisible: boolean;
}> {
  return page.evaluate(() => {
    const image = document.querySelector("[data-testid='viewer-image']");
    const empty = document.getElementById("viewer-empty");
    if (!(image instanceof HTMLImageElement) || !(empty instanceof HTMLElement)) {
      throw new Error("Viewer frame elements are unavailable.");
    }
    return {
      imageVisible: isRendered(image) && image.naturalWidth > 0 && image.naturalHeight > 0,
      emptyVisible: isRendered(empty),
    };

    function isRendered(element: HTMLElement): boolean {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }
  });
}

async function readTabCloseLayouts(page: Page): Promise<
  Array<{
    readonly chipLeft: number;
    readonly chipRight: number;
    readonly chipTop: number;
    readonly chipBottom: number;
    readonly closeLeft: number;
    readonly closeRight: number;
    readonly closeTop: number;
    readonly closeBottom: number;
  }>
> {
  return page.evaluate(() => {
    const layouts = [];
    for (const chip of document.querySelectorAll(".chrome-tab-chip")) {
      const close = chip.querySelector(".chrome-tab-close");
      if (!(chip instanceof HTMLElement) || !(close instanceof HTMLElement)) {
        continue;
      }
      const chipRect = chip.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      layouts.push({
        chipLeft: chipRect.left,
        chipRight: chipRect.right,
        chipTop: chipRect.top,
        chipBottom: chipRect.bottom,
        closeLeft: closeRect.left,
        closeRight: closeRect.right,
        closeTop: closeRect.top,
        closeBottom: closeRect.bottom,
      });
    }
    return layouts;
  });
}

async function readBrowserFrameLayout(page: Page): Promise<{
  readonly areaWidth: number;
  readonly areaHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameBottom: number;
  readonly chromeHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly windowHeight: number;
}> {
  return page.evaluate(() => {
    const area = document.querySelector(".viewer-area");
    const frame = document.querySelector(".browser-frame");
    const chrome = document.querySelector(".browser-chrome");
    const viewport = document.querySelector(".browser-viewport");
    if (!(area instanceof HTMLElement) || !(frame instanceof HTMLElement)) {
      throw new Error("Browser layout elements are unavailable.");
    }
    if (!(chrome instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      throw new Error("Browser viewport elements are unavailable.");
    }

    const areaRect = area.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const chromeRect = chrome.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return {
      areaWidth: areaRect.width,
      areaHeight: areaRect.height,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
      frameBottom: frameRect.bottom,
      chromeHeight: chromeRect.height,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
      windowHeight: window.innerHeight,
    };
  });
}

async function readViewerPosition(
  page: Page,
  xRatio: number,
  yRatio: number,
): Promise<{
  readonly x: number;
  readonly y: number;
}> {
  const result = await page.evaluate(
    ({ xRatio: nextXRatio, yRatio: nextYRatio }) => {
      const image = document.querySelector("[data-testid='viewer-image']");
      if (!(image instanceof HTMLImageElement)) {
        return null;
      }

      const imageRect = image.getBoundingClientRect();
      return {
        x: imageRect.left + imageRect.width * nextXRatio,
        y: imageRect.top + imageRect.height * nextYRatio,
      };
    },
    { xRatio, yRatio },
  );

  if (!result) {
    throw new Error("Failed to resolve a viewer click position.");
  }

  return result;
}

async function readRemoteElementCenterRatio(
  runtime: OpensteerSessionRuntime,
  selector: string,
): Promise<{
  readonly xRatio: number;
  readonly yRatio: number;
}> {
  const result = await runtime.evaluate({
    script: `() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
        yRatio: (rect.top + rect.height / 2) / window.innerHeight,
      };
    }`,
  });
  const value = result && typeof result === "object" && "value" in result ? result.value : null;
  if (
    !value ||
    typeof value !== "object" ||
    !("xRatio" in value) ||
    !("yRatio" in value) ||
    typeof value.xRatio !== "number" ||
    typeof value.yRatio !== "number"
  ) {
    throw new Error(`Failed to resolve remote element center for ${selector}.`);
  }
  return {
    xRatio: value.xRatio,
    yRatio: value.yRatio,
  };
}

async function waitFor<T>(
  callback: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
  pollMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result !== null && result !== undefined) {
      return result;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  throw new Error("Timed out while waiting for expected local-view state.");
}
