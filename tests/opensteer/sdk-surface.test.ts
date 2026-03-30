import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => {
  const runtimeConfig = {
    provider: {
      kind: "local" as "local" | "cloud",
      source: "default" as const,
    },
  };
  const runtime = {
    open: vi.fn(async (input = {}) => ({
      sessionRef: "session:test",
      pageRef: "page:test",
      url: (input as { readonly url?: string }).url ?? "about:blank",
      title: "Workspace Runtime",
    })),
    snapshot: vi.fn(async (input = {}) => ({
      url: "https://example.com",
      title: "Workspace Runtime",
      mode: (input as { readonly mode?: string }).mode ?? "action",
      html: "<html></html>",
      counters: [],
    })),
    close: vi.fn(async () => ({ closed: true })),
    disconnect: vi.fn(async () => undefined),
  };

  const browserManager = {
    mode: "persistent" as const,
    rootPath: "/tmp/opensteer/workspaces/github-sync",
    cleanupRootOnDisconnect: false,
    status: vi.fn(async () => ({
      mode: "persistent" as const,
      workspace: "github-sync",
      rootPath: "/tmp/opensteer/workspaces/github-sync",
      live: false,
    })),
    clonePersistentBrowser: vi.fn(async () => ({
      mode: "persistent" as const,
      createdAt: 1,
      updatedAt: 1,
      userDataDir: "browser/user-data" as const,
      bootstrap: {
        kind: "empty" as const,
      },
    })),
    reset: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  return {
    runtimeConfig,
    runtime,
    browserManager,
    createRuntime: vi.fn(function MockCreateOpensteerSemanticRuntime() {
      return runtime;
    }),
    browserManagerCtor: vi.fn(function MockOpensteerBrowserManager() {
      return browserManager;
    }),
  };
});

vi.mock("../../packages/opensteer/src/sdk/runtime-resolution.js", () => ({
  createOpensteerSemanticRuntime: state.createRuntime,
  resolveOpensteerRuntimeConfig: vi.fn(() => state.runtimeConfig),
}));

vi.mock("../../packages/opensteer/src/browser-manager.js", () => ({
  OpensteerBrowserManager: state.browserManagerCtor,
}));

import { Opensteer } from "../../packages/opensteer/src/sdk/opensteer.js";

describe("Opensteer v2 SDK surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runtimeConfig.provider = {
      kind: "local",
      source: "default",
    };
  });

  test("constructs the browser manager and runtime around workspace-centric options", async () => {
    const opensteer = new Opensteer({
      workspace: "github-sync",
      browser: "persistent",
      launch: {
        headless: false,
      },
      context: {
        locale: "en-US",
      },
      rootDir: "/tmp/opensteer",
    });

    await opensteer.open("https://example.com");

    expect(state.browserManagerCtor).toHaveBeenCalledWith({
      workspace: "github-sync",
      browser: "persistent",
      launch: {
        headless: false,
      },
      context: {
        locale: "en-US",
      },
      rootDir: "/tmp/opensteer",
    });
    expect(state.createRuntime).toHaveBeenCalledWith({
      runtimeOptions: {
        workspace: "github-sync",
        browser: "persistent",
        launch: {
          headless: false,
        },
        context: {
          locale: "en-US",
        },
        rootDir: "/tmp/opensteer",
        rootPath: "/tmp/opensteer/workspaces/github-sync",
        cleanupRootOnClose: false,
      },
    });
    expect(state.runtime.open).toHaveBeenCalledWith({
      url: "https://example.com",
    });
  });

  test("close is non-destructive at the runtime layer for persistent browsers", async () => {
    const opensteer = new Opensteer({
      workspace: "github-sync",
    });

    await opensteer.close();

    expect(state.runtime.close).toHaveBeenCalledTimes(1);
    expect(state.browserManager.close).toHaveBeenCalledTimes(1);
    expect(state.runtime.disconnect).not.toHaveBeenCalled();
  });

  test("browser admin helpers delegate to the browser manager", async () => {
    const opensteer = new Opensteer({
      workspace: "github-sync",
    });

    await expect(opensteer.browser.status()).resolves.toMatchObject({
      mode: "persistent",
      workspace: "github-sync",
    });
    await opensteer.browser.clone({
      sourceUserDataDir: "/tmp/chrome-profile",
      sourceProfileDirectory: "Default",
    });
    await opensteer.browser.reset();
    await opensteer.browser.delete();

    expect(state.browserManager.clonePersistentBrowser).toHaveBeenCalledWith({
      sourceUserDataDir: "/tmp/chrome-profile",
      sourceProfileDirectory: "Default",
    });
    expect(state.browserManager.reset).toHaveBeenCalledTimes(1);
    expect(state.browserManager.delete).toHaveBeenCalledTimes(1);
  });

  test("snapshot forwards string shorthand modes to the runtime", async () => {
    const opensteer = new Opensteer({
      workspace: "github-sync",
    });

    const snapshot = await opensteer.snapshot("action");

    expect(state.runtime.snapshot).toHaveBeenCalledWith({
      mode: "action",
    });
    expect(snapshot).toMatchObject({
      mode: "action",
    });
  });

  test("cloud mode skips browser-manager ownership and blocks browser admin helpers", async () => {
    state.runtimeConfig.provider = {
      kind: "cloud",
      source: "explicit",
    };

    const opensteer = new Opensteer({
      workspace: "github-sync",
      provider: {
        kind: "cloud",
      },
      rootDir: "/tmp/opensteer",
    });

    await opensteer.open("https://example.com");

    expect(state.browserManagerCtor).not.toHaveBeenCalled();
    expect(state.createRuntime).toHaveBeenCalledWith({
      provider: {
        kind: "cloud",
      },
      runtimeOptions: {
        workspace: "github-sync",
        rootDir: "/tmp/opensteer",
      },
    });
    await expect(opensteer.browser.status()).rejects.toThrow(
      "browser.* helpers are only available in local mode.",
    );
  });
});
