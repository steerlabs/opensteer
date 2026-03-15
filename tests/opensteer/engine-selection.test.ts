import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

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

  test("creates the Playwright engine factory with browser and context options", async () => {
    const createPlaywrightBrowserCoreEngine = vi.fn(async () => ({
      dispose: vi.fn(),
    }));

    const { createOpensteerEngineFactory } =
      await import("../../packages/opensteer/src/internal/engine-selection.js");
    const factory = createOpensteerEngineFactory("playwright", {
      importPlaywrightModule: async () => ({
        createPlaywrightBrowserCoreEngine,
      }),
      importAbpModule: async () => {
        throw new Error("unexpected ABP import");
      },
    });

    await factory({
      browser: {
        headless: true,
        executablePath: "/tmp/chromium",
      },
      context: {
        locale: "en-US",
      },
    });

    expect(createPlaywrightBrowserCoreEngine).toHaveBeenCalledWith({
      launch: {
        headless: true,
        executablePath: "/tmp/chromium",
      },
      context: {
        locale: "en-US",
      },
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
        args: ["--foo=bar"],
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
      "ABP engine does not support browser.channel, context.locale. Supported ABP open options: browser.headless, browser.args, browser.executablePath.",
    );
  });
});
