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

  return {
    page,
    context,
    browser,
    engine,
    engineDispose,
    connectPlaywrightChromiumBrowser: vi.fn(async () => browser),
    createPlaywrightBrowserCoreEngine: vi.fn(async () => engine),
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
});
