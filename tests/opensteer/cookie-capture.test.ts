import { afterEach, describe, expect, test, vi } from "vitest";

const brand = {
  id: "chrome" as const,
  displayName: "Google Chrome",
  darwin: {
    executableCandidates: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    userDataDir: "~/Library/Application Support/Google/Chrome",
    bundleId: "com.google.Chrome",
    processNames: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  },
};

const browserBrandsState = vi.hoisted(() => ({
  detectInstalledBrowserBrands: vi.fn(() => [
    {
      brand,
      brandId: "chrome" as const,
      displayName: "Google Chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
    },
  ]),
  findBrandProcess: vi.fn(() => null),
  getAllBrowserBrands: vi.fn(() => [brand]),
  getBrowserBrand: vi.fn((_id: "chrome") => brand),
  resolveBrandExecutablePath: vi.fn(
    (_brand, explicitPath?: string) =>
      explicitPath ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ),
  resolveBrandPlatformConfig: vi.fn((_brand) => brand.darwin),
  resolveBrandUserDataDir: vi.fn(
    (_brand, explicitDir?: string) =>
      explicitDir ?? "/Users/test/Library/Application Support/Google/Chrome",
  ),
}));

const chromeDiscoveryState = vi.hoisted(() => ({
  readDevToolsActivePort: vi.fn(() => null),
}));

const cdpDiscoveryState = vi.hoisted(() => ({
  inspectCdpEndpoint: vi.fn(async ({ endpoint }: { readonly endpoint: string }) => ({ endpoint })),
}));

vi.mock("../../packages/opensteer/src/local-browser/browser-brands.js", () => ({
  detectInstalledBrowserBrands: browserBrandsState.detectInstalledBrowserBrands,
  findBrandProcess: browserBrandsState.findBrandProcess,
  getAllBrowserBrands: browserBrandsState.getAllBrowserBrands,
  getBrowserBrand: browserBrandsState.getBrowserBrand,
  resolveBrandExecutablePath: browserBrandsState.resolveBrandExecutablePath,
  resolveBrandPlatformConfig: browserBrandsState.resolveBrandPlatformConfig,
  resolveBrandUserDataDir: browserBrandsState.resolveBrandUserDataDir,
}));

vi.mock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
  expandHome: (value: string) => value.replace(/^~(?=\/|\\|$)/, "/Users/test"),
  readDevToolsActivePort: chromeDiscoveryState.readDevToolsActivePort,
}));

vi.mock("../../packages/opensteer/src/local-browser/cdp-discovery.js", () => ({
  inspectCdpEndpoint: cdpDiscoveryState.inspectCdpEndpoint,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  browserBrandsState.detectInstalledBrowserBrands.mockReset();
  browserBrandsState.detectInstalledBrowserBrands.mockReturnValue([
    {
      brand,
      brandId: "chrome",
      displayName: "Google Chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
    },
  ]);
  browserBrandsState.findBrandProcess.mockReset();
  browserBrandsState.findBrandProcess.mockReturnValue(null);
  browserBrandsState.getAllBrowserBrands.mockReset();
  browserBrandsState.getAllBrowserBrands.mockReturnValue([brand]);
  browserBrandsState.getBrowserBrand.mockReset();
  browserBrandsState.getBrowserBrand.mockImplementation((_id: "chrome") => brand);
  browserBrandsState.resolveBrandExecutablePath.mockReset();
  browserBrandsState.resolveBrandExecutablePath.mockImplementation(
    (_brand, explicitPath?: string) =>
      explicitPath ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  browserBrandsState.resolveBrandPlatformConfig.mockReset();
  browserBrandsState.resolveBrandPlatformConfig.mockImplementation((_brand) => brand.darwin);
  browserBrandsState.resolveBrandUserDataDir.mockReset();
  browserBrandsState.resolveBrandUserDataDir.mockImplementation(
    (_brand, explicitDir?: string) =>
      explicitDir ?? "/Users/test/Library/Application Support/Google/Chrome",
  );
  chromeDiscoveryState.readDevToolsActivePort.mockReset();
  chromeDiscoveryState.readDevToolsActivePort.mockReturnValue(null);
  cdpDiscoveryState.inspectCdpEndpoint.mockReset();
  cdpDiscoveryState.inspectCdpEndpoint.mockImplementation(async ({ endpoint }) => ({ endpoint }));
});

describe("cookie capture strategy resolution", () => {
  test("uses attach when an explicit attach endpoint is provided", async () => {
    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(
      resolveCookieCaptureStrategy({
        attachEndpoint: "9222",
      }),
    ).resolves.toEqual({
      strategy: "attach",
      attachEndpoint: "9222",
      timeoutMs: 30_000,
    });
  });

  test("resolves headless when the browser is installed but not running", async () => {
    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(
      resolveCookieCaptureStrategy({
        brandId: "chrome",
      }),
    ).resolves.toMatchObject({
      strategy: "headless",
      brandId: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
    });
  });

  test("resolves managed-relaunch when the browser is running without a reachable CDP endpoint", async () => {
    browserBrandsState.findBrandProcess.mockReturnValue({ pid: 4321 });

    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(
      resolveCookieCaptureStrategy({
        brandId: "chrome",
      }),
    ).resolves.toMatchObject({
      strategy: "managed-relaunch",
      runningPid: 4321,
    });
  });

  test("resolves attach when the browser already exposes DevToolsActivePort", async () => {
    chromeDiscoveryState.readDevToolsActivePort.mockReturnValue({
      port: 9222,
      webSocketPath: "/devtools/browser/root",
    });
    cdpDiscoveryState.inspectCdpEndpoint.mockResolvedValue({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
    });
    browserBrandsState.findBrandProcess.mockReturnValue({ pid: 4321 });

    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(
      resolveCookieCaptureStrategy({
        brandId: "chrome",
      }),
    ).resolves.toMatchObject({
      strategy: "attach",
      attachEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
    });
  });

  test("honors explicit strategy overrides when they are valid", async () => {
    browserBrandsState.findBrandProcess.mockReturnValue({ pid: 4321 });

    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(
      resolveCookieCaptureStrategy({
        brandId: "chrome",
        strategy: "managed-relaunch",
      }),
    ).resolves.toMatchObject({
      strategy: "managed-relaunch",
      runningPid: 4321,
    });
  });

  test("auto-detects the first installed browser brand when no explicit source is provided", async () => {
    const { resolveCookieCaptureStrategy } =
      await import("../../packages/opensteer/src/local-browser/cookie-capture.js");

    await expect(resolveCookieCaptureStrategy()).resolves.toMatchObject({
      strategy: "headless",
      brandId: "chrome",
      brandDisplayName: "Google Chrome",
    });
  });
});
