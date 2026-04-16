import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  newPage: vi.fn(),
  activatePage: vi.fn(),
  closePage: vi.fn(),
  goto: vi.fn(),
  info: vi.fn(),
  listPages: vi.fn(),
  readPersistedLocalBrowserSessionRecord: vi.fn(),
  writePersistedSessionRecord: vi.fn(),
  assertSupportedEngineOptions: vi.fn(),
}));

vi.mock("@opensteer/runtime-core", () => {
  class MockSharedOpensteerSessionRuntime {
    readonly rootPath: string;

    constructor(options: { readonly rootPath: string }) {
      this.rootPath = options.rootPath;
    }

    async open(input: unknown, options: unknown): Promise<unknown> {
      return state.open(input, options);
    }

    async newPage(input: unknown, options: unknown): Promise<unknown> {
      return state.newPage(input, options);
    }

    async activatePage(input: unknown, options: unknown): Promise<unknown> {
      return state.activatePage(input, options);
    }

    async closePage(input: unknown, options: unknown): Promise<unknown> {
      return state.closePage(input, options);
    }

    async goto(input: unknown, options: unknown): Promise<unknown> {
      return state.goto(input, options);
    }

    async info(): Promise<unknown> {
      return state.info();
    }

    async listPages(): Promise<unknown> {
      return state.listPages();
    }
  }

  return {
    OpensteerSessionRuntime: MockSharedOpensteerSessionRuntime,
  };
});

vi.mock("../../packages/opensteer/src/browser-manager.js", () => ({
  OpensteerBrowserManager: class MockOpensteerBrowserManager {
    async createEngine(): Promise<never> {
      throw new Error("OpensteerBrowserManager.createEngine should not be called in this test.");
    }
  },
}));

vi.mock("../../packages/opensteer/src/internal/engine-selection.js", () => ({
  DEFAULT_OPENSTEER_ENGINE: "playwright",
  assertSupportedEngineOptions: state.assertSupportedEngineOptions,
}));

vi.mock("../../packages/opensteer/src/live-session.js", () => ({
  readPersistedLocalBrowserSessionRecord: state.readPersistedLocalBrowserSessionRecord,
  writePersistedSessionRecord: state.writePersistedSessionRecord,
}));

import {
  OpensteerRuntime,
  OpensteerSessionRuntime,
} from "../../packages/opensteer/src/sdk/runtime.js";

describe("local active page hint persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    state.open.mockImplementation(async (input: unknown) => ({
      kind: "open",
      input,
    }));
    state.newPage.mockImplementation(async (input: unknown) => ({
      kind: "new-page",
      input,
    }));
    state.activatePage.mockImplementation(async (input: unknown) => ({
      kind: "activate-page",
      input,
    }));
    state.closePage.mockImplementation(async (input: unknown) => ({
      kind: "close-page",
      input,
    }));
    state.goto.mockImplementation(async (input: unknown) => ({
      kind: "goto",
      input,
    }));
    state.info.mockImplementation(async () => ({
      activePageRef: "page-active",
    }));
    state.listPages.mockImplementation(async () => ({
      pages: [
        {
          pageRef: "page-active",
          url: "https://example.com/active",
          title: "Active Page",
        },
      ],
    }));
    state.readPersistedLocalBrowserSessionRecord.mockImplementation(async () => ({
      layout: "opensteer-session",
      version: 1,
      provider: "local",
      engine: "playwright",
      pid: 1,
      startedAt: 10,
      updatedAt: 20,
      userDataDir: "/tmp/opensteer-profile",
    }));
    state.writePersistedSessionRecord.mockImplementation(async () => undefined);
  });

  test("OpensteerRuntime keeps successful open results when hint record lookup fails", async () => {
    state.readPersistedLocalBrowserSessionRecord.mockRejectedValueOnce(
      new Error("permissions changed"),
    );

    const runtime = new OpensteerRuntime({
      rootPath: "/tmp/opensteer-runtime-root",
    });

    await expect(runtime.open({ url: "https://example.com" })).resolves.toEqual({
      kind: "open",
      input: { url: "https://example.com" },
    });
    expect(state.writePersistedSessionRecord).not.toHaveBeenCalled();
    expect(state.info).not.toHaveBeenCalled();
    expect(state.listPages).not.toHaveBeenCalled();
  });

  test("OpensteerSessionRuntime keeps successful goto results when hint persistence writes fail", async () => {
    state.writePersistedSessionRecord.mockRejectedValueOnce(new Error("disk full"));

    const runtime = new OpensteerSessionRuntime({
      name: "session-runtime",
      rootPath: "/tmp/opensteer-session-root",
    });

    await expect(runtime.goto({ url: "https://example.com/next" })).resolves.toEqual({
      kind: "goto",
      input: { url: "https://example.com/next" },
    });
    expect(state.info).toHaveBeenCalledTimes(1);
    expect(state.listPages).toHaveBeenCalledTimes(1);
    expect(state.writePersistedSessionRecord).toHaveBeenCalledWith(
      "/tmp/opensteer-session-root",
      expect.objectContaining({
        provider: "local",
        activePageRef: "page-active",
        activePageUrl: "https://example.com/active",
        activePageTitle: "Active Page",
      }),
    );
  });

  test("still propagates the primary browser operation error", async () => {
    state.open.mockRejectedValueOnce(new Error("open failed"));

    const runtime = new OpensteerRuntime({
      rootPath: "/tmp/opensteer-runtime-root",
    });

    await expect(runtime.open()).rejects.toThrow("open failed");
    expect(state.readPersistedLocalBrowserSessionRecord).not.toHaveBeenCalled();
    expect(state.writePersistedSessionRecord).not.toHaveBeenCalled();
  });
});
