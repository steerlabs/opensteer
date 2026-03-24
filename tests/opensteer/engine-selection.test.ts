import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function createLease() {
  const page = {
    close: vi.fn(async () => undefined),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => [context]),
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    })),
  };

  return {
    browser,
    context,
    page,
    close: vi.fn(async () => undefined),
  };
}

describe("Opensteer engine selection", () => {
  test("resolves the default engine when no CLI flag or env var is provided", async () => {
    const { resolveOpensteerEngineName } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");

    expect(resolveOpensteerEngineName()).toBe("playwright");
  });

  test("resolves the environment engine when no CLI flag is provided", async () => {
    const { resolveOpensteerEngineName } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");

    expect(
      resolveOpensteerEngineName({
        environment: "abp",
      }),
    ).toBe("abp");
  });

  test("prefers the CLI flag over the environment variable", async () => {
    const { resolveOpensteerEngineName } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");

    expect(
      resolveOpensteerEngineName({
        requested: "playwright",
        environment: "abp",
      }),
    ).toBe("playwright");
  });

  test("rejects invalid engine names with the allowed values", async () => {
    const { resolveOpensteerEngineName } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");

    expect(() =>
      resolveOpensteerEngineName({
        requested: "webkit",
      }),
    ).toThrow('--engine must be one of playwright, abp; received "webkit".');
  });

  test("routes managed local browser launches through the local browser lease flow", async () => {
    const lease = createLease();
    const resolveManagedBrowserLaunch = vi.fn(() => ({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      timeoutMs: 45_000,
      args: ["--lang=en-US"],
    }));
    const launchManagedBrowserSession = vi.fn(async () => lease);
    const createPlaywrightBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
    }));

    vi.doMock("../../packages/opensteer/src/local-browser/launch-resolution.js", () => ({
      resolveManagedBrowserLaunch,
      resolveSnapshotSessionBrowserLaunch: vi.fn(),
      resolveSnapshotAuthenticatedBrowserLaunch: vi.fn(),
      resolveAttachLiveBrowserLaunch: vi.fn(),
    }));
    vi.doMock("../../packages/opensteer/src/local-browser/shared-session.js", () => ({
      launchManagedBrowserSession,
      launchSnapshotSessionBrowserSession: vi.fn(),
      launchSnapshotAuthenticatedBrowserSession: vi.fn(),
      connectAttachBrowserSession: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        connectPlaywrightChromiumBrowser: vi.fn(async () => lease.browser),
        createPlaywrightBrowserCoreEngine,
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    const engine = await factory({
      browser: {
        headless: true,
        args: ["--lang=en-US"],
      },
      context: {
        locale: "en-US",
      },
    });

    expect(resolveManagedBrowserLaunch).toHaveBeenCalledWith({
      headless: true,
      args: ["--lang=en-US"],
    });
    expect(launchManagedBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
        timeoutMs: 45_000,
        args: ["--lang=en-US", "--window-size=1280,800"],
        connectBrowser: expect.any(Function),
      }),
    );
    expect(createPlaywrightBrowserCoreEngine).toHaveBeenCalledWith({
      browser: lease.browser,
      attachedContext: lease.context,
      attachedPage: lease.page,
      closeAttachedContextOnSessionClose: false,
      closeBrowserOnDispose: false,
      context: {
        locale: "en-US",
        viewport: {
          width: 1280,
          height: 800,
        },
      },
    });

    await (engine as { readonly dispose: () => Promise<void> }).dispose();
    expect(lease.close).toHaveBeenCalledTimes(1);
  });

  test("routes snapshot-session launches through the snapshot-backed local browser flow", async () => {
    const lease = createLease();
    const resolveSnapshotSessionBrowserLaunch = vi.fn(() => ({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      timeoutMs: 30_000,
      args: [],
      copyMode: "session",
      sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      sourceProfileDirectory: "Profile 1",
    }));
    const launchSnapshotSessionBrowserSession = vi.fn(async () => lease);
    const createPlaywrightBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
    }));

    vi.doMock("../../packages/opensteer/src/local-browser/launch-resolution.js", () => ({
      resolveManagedBrowserLaunch: vi.fn(),
      resolveSnapshotSessionBrowserLaunch,
      resolveSnapshotAuthenticatedBrowserLaunch: vi.fn(),
      resolveAttachLiveBrowserLaunch: vi.fn(),
    }));
    vi.doMock("../../packages/opensteer/src/local-browser/shared-session.js", () => ({
      launchManagedBrowserSession: vi.fn(),
      launchSnapshotSessionBrowserSession,
      launchSnapshotAuthenticatedBrowserSession: vi.fn(),
      connectAttachBrowserSession: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        connectPlaywrightChromiumBrowser: vi.fn(async () => lease.browser),
        createPlaywrightBrowserCoreEngine,
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await factory({
      browser: {
        kind: "snapshot-session",
        sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        sourceProfileDirectory: "Profile 1",
      },
    });

    expect(resolveSnapshotSessionBrowserLaunch).toHaveBeenCalledWith({
      kind: "snapshot-session",
      sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      sourceProfileDirectory: "Profile 1",
    });
    expect(launchSnapshotSessionBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        sourceProfileDirectory: "Profile 1",
      }),
    );
  });

  test("routes snapshot-authenticated launches through the snapshot-backed local browser flow", async () => {
    const lease = createLease();
    const resolveSnapshotAuthenticatedBrowserLaunch = vi.fn(() => ({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      timeoutMs: 30_000,
      args: [],
      copyMode: "authenticated",
      sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      sourceProfileDirectory: "Profile 1",
    }));
    const launchSnapshotAuthenticatedBrowserSession = vi.fn(async () => lease);

    vi.doMock("../../packages/opensteer/src/local-browser/launch-resolution.js", () => ({
      resolveManagedBrowserLaunch: vi.fn(),
      resolveSnapshotSessionBrowserLaunch: vi.fn(),
      resolveSnapshotAuthenticatedBrowserLaunch,
      resolveAttachLiveBrowserLaunch: vi.fn(),
    }));
    vi.doMock("../../packages/opensteer/src/local-browser/shared-session.js", () => ({
      launchManagedBrowserSession: vi.fn(),
      launchSnapshotSessionBrowserSession: vi.fn(),
      launchSnapshotAuthenticatedBrowserSession,
      connectAttachBrowserSession: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        connectPlaywrightChromiumBrowser: vi.fn(async () => lease.browser),
        createPlaywrightBrowserCoreEngine: vi.fn(async () => ({
          dispose: vi.fn(async () => undefined),
        })),
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await factory({
      browser: {
        kind: "snapshot-authenticated",
        sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        sourceProfileDirectory: "Profile 1",
      },
    });

    expect(resolveSnapshotAuthenticatedBrowserLaunch).toHaveBeenCalledWith({
      kind: "snapshot-authenticated",
      sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      sourceProfileDirectory: "Profile 1",
    });
    expect(launchSnapshotAuthenticatedBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUserDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        sourceProfileDirectory: "Profile 1",
      }),
    );
  });

  test("routes explicit attach-live through the local browser attach flow", async () => {
    const lease = createLease();
    const resolveAttachLiveBrowserLaunch = vi.fn(() => ({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      freshTab: true,
      headers: {
        authorization: "Bearer test",
      },
    }));
    const connectAttachBrowserSession = vi.fn(async () => lease);

    vi.doMock("../../packages/opensteer/src/local-browser/launch-resolution.js", () => ({
      resolveManagedBrowserLaunch: vi.fn(),
      resolveSnapshotSessionBrowserLaunch: vi.fn(),
      resolveSnapshotAuthenticatedBrowserLaunch: vi.fn(),
      resolveAttachLiveBrowserLaunch,
    }));
    vi.doMock("../../packages/opensteer/src/local-browser/shared-session.js", () => ({
      launchManagedBrowserSession: vi.fn(),
      launchSnapshotSessionBrowserSession: vi.fn(),
      launchSnapshotAuthenticatedBrowserSession: vi.fn(),
      connectAttachBrowserSession,
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        connectPlaywrightChromiumBrowser: vi.fn(async () => lease.browser),
        createPlaywrightBrowserCoreEngine: vi.fn(async () => ({
          dispose: vi.fn(async () => undefined),
        })),
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await factory({
      browser: {
        kind: "attach-live",
        endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        headers: {
          authorization: "Bearer test",
        },
      },
    });

    expect(connectAttachBrowserSession).toHaveBeenCalledWith({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      freshTab: true,
      headers: {
        authorization: "Bearer test",
      },
      timeoutMs: 15_000,
      connectBrowser: expect.any(Function),
    });
  });

  test("routes auto-discovery attach-live through Chrome discovery and attach flow", async () => {
    const lease = createLease();
    const resolveAttachLiveBrowserLaunch = vi.fn(() => ({
      freshTab: true,
    }));
    const connectAttachBrowserSession = vi.fn(async () => lease);

    vi.doMock("../../packages/opensteer/src/local-browser/launch-resolution.js", () => ({
      resolveManagedBrowserLaunch: vi.fn(),
      resolveSnapshotSessionBrowserLaunch: vi.fn(),
      resolveSnapshotAuthenticatedBrowserLaunch: vi.fn(),
      resolveAttachLiveBrowserLaunch,
    }));
    vi.doMock("../../packages/opensteer/src/local-browser/shared-session.js", () => ({
      launchManagedBrowserSession: vi.fn(),
      launchSnapshotSessionBrowserSession: vi.fn(),
      launchSnapshotAuthenticatedBrowserSession: vi.fn(),
      connectAttachBrowserSession,
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        connectPlaywrightChromiumBrowser: vi.fn(async () => lease.browser),
        createPlaywrightBrowserCoreEngine: vi.fn(async () => ({
          dispose: vi.fn(async () => undefined),
        })),
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await factory({
      browser: {
        kind: "attach-live",
      },
    });

    expect(connectAttachBrowserSession).toHaveBeenCalledWith({
      freshTab: true,
      timeoutMs: 15_000,
      connectBrowser: expect.any(Function),
    });
  });

  test("creates the ABP engine factory with mapped launch options only", async () => {
    const createAbpBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => ({
        createAbpBrowserCoreEngine,
      }),
    });

    await factory({
      browser: {
        headless: true,
        executablePath: "/tmp/abp-browser",
        args: ["--foo=bar"],
      },
    });

    expect(createAbpBrowserCoreEngine).toHaveBeenCalledWith({
      launch: {
        headless: true,
        browserExecutablePath: "/tmp/abp-browser",
        args: ["--foo=bar", "--window-size=1280,800"],
      },
    });
  });

  test("maps explicit viewport context into the ABP window-size launch argument", async () => {
    const createAbpBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => ({
        createAbpBrowserCoreEngine,
      }),
    });

    await factory({
      browser: {
        args: ["--foo=bar", "--window-size=900,700"],
      },
      context: {
        viewport: {
          width: 1440,
          height: 900,
        },
      },
    });

    expect(createAbpBrowserCoreEngine).toHaveBeenCalledWith({
      launch: {
        args: ["--foo=bar", "--window-size=1440,900"],
      },
    });
  });

  test("applies viewport-only context to ABP launch options", async () => {
    const createAbpBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => ({
        createAbpBrowserCoreEngine,
      }),
    });

    await factory({
      context: {
        viewport: {
          width: 1440,
          height: 900,
        },
      },
    });

    expect(createAbpBrowserCoreEngine).toHaveBeenCalledWith({
      launch: {
        args: ["--window-size=1440,900"],
      },
    });
  });

  test("wraps missing ABP module errors with an install hint", async () => {
    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => {
        throw Object.assign(new Error("Cannot find package '@opensteer/engine-abp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });

    await expect(factory({})).rejects.toThrow(
      'ABP engine selected but "@opensteer/engine-abp" is not installed.',
    );
  });

  test("rejects ABP-specific open options that are not supported", async () => {
    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await expect(
      factory({
        browser: {
          channel: "chrome",
          headless: true,
        },
        context: {
          locale: "en-US",
        },
      }),
    ).rejects.toThrow(
      "ABP engine does not support browser.channel, context.locale. Supported ABP open options: browser.kind, browser.headless, browser.args, browser.executablePath, browser.timeoutMs, context.viewport.",
    );
  });

  test.each([
    {
      label: "snapshot-session",
      browser: {
        kind: "snapshot-session" as const,
        sourceUserDataDir: "/tmp/chrome",
      },
    },
    {
      label: "snapshot-authenticated",
      browser: {
        kind: "snapshot-authenticated" as const,
        sourceUserDataDir: "/tmp/chrome",
      },
    },
    {
      label: "attach-live",
      browser: {
        kind: "attach-live" as const,
      },
    },
  ])("rejects ABP when browser.kind is $label", async ({ browser }) => {
    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("abp", {
      importPlaywrightModule: async () => {
        throw new Error("unexpected Playwright import");
      },
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await expect(factory({ browser })).rejects.toThrow(
      'ABP engine only supports managed local browser launches. Use the Playwright engine for browser.kind="snapshot-session", "snapshot-authenticated", or "attach-live".',
    );
  });
});
