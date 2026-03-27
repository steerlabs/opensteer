import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => {
  const page = {
    bringToFront: vi.fn(async () => undefined),
  };

  const context = {
    addInitScript: vi.fn(async () => undefined),
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
  };

  const browser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => undefined),
  };

  const engineDispose = vi.fn(async () => undefined);
  const engine = {
    dispose: engineDispose,
  };
  const abpEngineDispose = vi.fn(async () => undefined);
  const abpEngine = {
    dispose: abpEngineDispose,
  };

  return {
    page,
    context,
    browser,
    engine,
    engineDispose,
    abpEngine,
    abpEngineDispose,
    connectPlaywrightChromiumBrowser: vi.fn(async () => browser),
    createPlaywrightBrowserCoreEngine: vi.fn(async () => engine),
    allocatePort: vi.fn(async () => 8123),
    launchAbpProcess: vi.fn(async () => ({
      process: { pid: process.pid },
      baseUrl: "http://127.0.0.1:8123/api/v1",
      remoteDebuggingUrl: "http://127.0.0.1:9223",
    })),
    createAbpBrowserCoreEngine: vi.fn(async () => abpEngine),
  };
});

vi.mock("@opensteer/engine-playwright", async () => {
  const actual = await vi.importActual<typeof import("@opensteer/engine-playwright")>(
    "@opensteer/engine-playwright",
  );
  return {
    ...actual,
    connectPlaywrightChromiumBrowser: state.connectPlaywrightChromiumBrowser,
    createPlaywrightBrowserCoreEngine: state.createPlaywrightBrowserCoreEngine,
  };
});

vi.mock("@opensteer/engine-abp", () => ({
  allocatePort: state.allocatePort,
  launchAbpProcess: state.launchAbpProcess,
  createAbpBrowserCoreEngine: state.createAbpBrowserCoreEngine,
}));

import { OpensteerBrowserManager } from "../../packages/opensteer/src/browser-manager.js";

describe("OpensteerBrowserManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("starts Playwright detach on attached CDP browsers during disposal", async () => {
    const manager = new OpensteerBrowserManager({
      browser: {
        mode: "attach",
        endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
        freshTab: false,
      },
    });

    const engine = await manager.createEngine();
    await engine.dispose?.();

    expect(state.connectPlaywrightChromiumBrowser).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:9222/devtools/browser/test",
    });
    expect(state.createPlaywrightBrowserCoreEngine).toHaveBeenCalledTimes(1);
    expect(state.engineDispose).toHaveBeenCalledTimes(1);
    expect(state.browser.close).toHaveBeenCalledTimes(1);
  });

  test("reuses a persistent ABP workspace browser across manager instances", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-abp-manager-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ready: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const firstManager = new OpensteerBrowserManager({
        rootPath,
        workspace: "abp-workspace",
        engineName: "abp",
      });

      await firstManager.createEngine();

      expect(state.launchAbpProcess).toHaveBeenCalledTimes(1);
      expect(state.createAbpBrowserCoreEngine).toHaveBeenCalledWith({
        browser: {
          baseUrl: "http://127.0.0.1:8123/api/v1",
          remoteDebuggingUrl: "http://127.0.0.1:9223",
        },
      });

      const secondManager = new OpensteerBrowserManager({
        rootPath,
        workspace: "abp-workspace",
        engineName: "abp",
      });

      await secondManager.createEngine();

      expect(state.launchAbpProcess).toHaveBeenCalledTimes(1);
      expect(state.createAbpBrowserCoreEngine).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:8123/api/v1/browser/status", {
        signal: expect.any(AbortSignal),
      });
    } finally {
      fetchSpy.mockRestore();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("infers the live ABP engine from workspace state on later manager instances", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-abp-live-engine-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ready: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const firstManager = new OpensteerBrowserManager({
        rootPath,
        workspace: "abp-live-engine",
        engineName: "abp",
      });
      await firstManager.createEngine();

      vi.clearAllMocks();

      const secondManager = new OpensteerBrowserManager({
        rootPath,
        workspace: "abp-live-engine",
      });
      await secondManager.createEngine();

      expect(state.launchAbpProcess).not.toHaveBeenCalled();
      expect(state.connectPlaywrightChromiumBrowser).not.toHaveBeenCalled();
      expect(state.createAbpBrowserCoreEngine).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:8123/api/v1/browser/status", {
        signal: expect.any(AbortSignal),
      });
    } finally {
      fetchSpy.mockRestore();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
