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

  const createMockStderr = () => {
    const dataListeners: Array<(chunk: string) => void> = [];
    return {
      setEncoding: vi.fn(),
      on: vi.fn((event: string, listener: (chunk: string) => void) => {
        if (event === "data") {
          dataListeners.push(listener);
        }
      }),
      unref: vi.fn(),
    };
  };

  const createMockChild = () => ({
    pid: 4242,
    exitCode: null as number | null,
    stderr: createMockStderr(),
    unref: vi.fn(),
    kill: vi.fn(() => true),
  });

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
    createMockChild,
    spawn: vi.fn(() => createMockChild()),
    resolveChromeExecutablePath: vi.fn(() => "/mock/chromium"),
    readDevToolsActivePort: vi.fn(() => null),
    inspectCdpEndpoint: vi.fn(async () => {
      throw new Error("inspectCdpEndpoint was not stubbed for this test.");
    }),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: state.spawn,
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

vi.mock("../../packages/opensteer/src/local-browser/chrome-discovery.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../packages/opensteer/src/local-browser/chrome-discovery.js")
  >("../../packages/opensteer/src/local-browser/chrome-discovery.js");
  return {
    ...actual,
    readDevToolsActivePort: state.readDevToolsActivePort,
    resolveChromeExecutablePath: state.resolveChromeExecutablePath,
  };
});

vi.mock("../../packages/opensteer/src/local-browser/cdp-discovery.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../packages/opensteer/src/local-browser/cdp-discovery.js")
  >("../../packages/opensteer/src/local-browser/cdp-discovery.js");
  return {
    ...actual,
    inspectCdpEndpoint: state.inspectCdpEndpoint,
  };
});

import { OpensteerBrowserManager } from "../../packages/opensteer/src/browser-manager.js";

function createInspectedEndpoint(port: number, label: string) {
  return {
    endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/${label}`,
    httpUrl: `http://127.0.0.1:${String(port)}/`,
    port,
  };
}

describe("OpensteerBrowserManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.spawn.mockImplementation(() => state.createMockChild());
    state.resolveChromeExecutablePath.mockReturnValue("/mock/chromium");
    state.readDevToolsActivePort.mockReturnValue(null);
    state.inspectCdpEndpoint.mockImplementation(async () => {
      throw new Error("inspectCdpEndpoint was not stubbed for this test.");
    });
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

  test("launches persistent browsers with a caller-supplied fixed remote debugging port", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-browser-manager-fixed-port-"));

    try {
      state.inspectCdpEndpoint.mockImplementation(async ({ endpoint, timeoutMs }) => {
        expect(timeoutMs).toBe(250);
        if (endpoint === "http://127.0.0.1:9223") {
          return createInspectedEndpoint(9223, "fixed-port");
        }
        throw new Error(`Unexpected CDP endpoint: ${endpoint}`);
      });

      const manager = new OpensteerBrowserManager({
        rootPath,
        workspace: "fixed-port",
        launch: {
          args: ["--remote-debugging-port=9223"],
          timeoutMs: 250,
        },
      });

      const engine = await manager.createEngine();
      await engine.dispose?.();

      const spawnedArgs = state.spawn.mock.calls[0]?.[1] as readonly string[] | undefined;
      expect(spawnedArgs).toContain("--remote-debugging-port=9223");
      expect(spawnedArgs).not.toContain("--remote-debugging-port=0");
      expect(state.inspectCdpEndpoint).toHaveBeenCalledWith({
        endpoint: "http://127.0.0.1:9223",
        timeoutMs: 250,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("launches persistent browsers with split fixed-port launch args", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "opensteer-browser-manager-fixed-port-split-"),
    );

    try {
      state.inspectCdpEndpoint.mockImplementation(async ({ endpoint, timeoutMs }) => {
        expect(timeoutMs).toBe(400);
        if (endpoint === "http://127.0.0.1:9333") {
          return createInspectedEndpoint(9333, "split-port");
        }
        throw new Error(`Unexpected CDP endpoint: ${endpoint}`);
      });

      const manager = new OpensteerBrowserManager({
        rootPath,
        workspace: "split-port",
        launch: {
          args: ["--remote-debugging-port", "9333"],
          timeoutMs: 400,
        },
      });

      const engine = await manager.createEngine();
      await engine.dispose?.();

      const spawnedArgs = state.spawn.mock.calls[0]?.[1] as readonly string[] | undefined;
      expect(spawnedArgs).toContain("--remote-debugging-port");
      expect(spawnedArgs).toContain("9333");
      expect(spawnedArgs).not.toContain("--remote-debugging-port=0");
      expect(state.inspectCdpEndpoint).toHaveBeenCalledWith({
        endpoint: "http://127.0.0.1:9333",
        timeoutMs: 400,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("keeps the existing auto-port flow when no fixed remote debugging port is supplied", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-browser-manager-auto-port-"));

    try {
      state.readDevToolsActivePort.mockReturnValue({
        port: 54513,
        webSocketPath: "/devtools/browser/auto-port",
      });
      state.inspectCdpEndpoint.mockImplementation(async ({ endpoint, timeoutMs }) => {
        expect(timeoutMs).toBe(300);
        if (endpoint === "http://127.0.0.1:54513") {
          return createInspectedEndpoint(54513, "auto-port");
        }
        throw new Error(`Unexpected CDP endpoint: ${endpoint}`);
      });

      const manager = new OpensteerBrowserManager({
        rootPath,
        workspace: "auto-port",
        launch: {
          timeoutMs: 300,
        },
      });

      const engine = await manager.createEngine();
      await engine.dispose?.();

      const spawnedArgs = state.spawn.mock.calls[0]?.[1] as readonly string[] | undefined;
      expect(spawnedArgs).toContain("--remote-debugging-port=0");
      expect(state.inspectCdpEndpoint).toHaveBeenCalledWith({
        endpoint: "http://127.0.0.1:54513",
        timeoutMs: 300,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
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
