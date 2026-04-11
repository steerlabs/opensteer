import { afterEach, describe, expect, test, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  existsSync: vi.fn((_value: string) => false),
}));

const childProcessState = vi.hoisted(() => ({
  execFileSync: vi.fn(() => {
    throw new Error("which failed");
  }),
}));

const browserBrandsState = vi.hoisted(() => ({
  detectInstalledBrowserBrands: vi.fn(() => []),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: fsState.existsSync,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: childProcessState.execFileSync,
  };
});

vi.mock("../../packages/opensteer/src/local-browser/browser-brands.js", () => ({
  detectInstalledBrowserBrands: browserBrandsState.detectInstalledBrowserBrands,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  fsState.existsSync.mockReset();
  fsState.existsSync.mockReturnValue(false);
  childProcessState.execFileSync.mockReset();
  childProcessState.execFileSync.mockImplementation(() => {
    throw new Error("which failed");
  });
  browserBrandsState.detectInstalledBrowserBrands.mockReset();
  browserBrandsState.detectInstalledBrowserBrands.mockReturnValue([]);
});

describe("chrome executable discovery", () => {
  test("honors an explicit executable path without consulting browser brand discovery", async () => {
    const explicitPath = getExplicitExecutablePath();
    fsState.existsSync.mockImplementation((value: string) => value === explicitPath);

    const { resolveChromeExecutablePath } =
      await import("../../packages/opensteer/src/local-browser/chrome-discovery.js");

    expect(resolveChromeExecutablePath(explicitPath)).toBe(explicitPath);
    expect(browserBrandsState.detectInstalledBrowserBrands).not.toHaveBeenCalled();
  });

  test("keeps the existing Chrome-first resolution before consulting the brand registry", async () => {
    const chromePath = getLegacyChromeExecutablePath();
    fsState.existsSync.mockImplementation((value: string) => value === chromePath);
    browserBrandsState.detectInstalledBrowserBrands.mockReturnValue([
      createInstalledBrand("edge", getBrandExecutablePath("edge")),
    ]);

    const { resolveChromeExecutablePath } =
      await import("../../packages/opensteer/src/local-browser/chrome-discovery.js");

    expect(resolveChromeExecutablePath(undefined)).toBe(chromePath);
    expect(browserBrandsState.detectInstalledBrowserBrands).not.toHaveBeenCalled();
  });

  test("prefers branded Chromium-family browsers before raw Chromium when Chrome is absent", async () => {
    const chromiumPath = getLegacyChromiumExecutablePath();
    const edgePath = getBrandExecutablePath("edge");
    const bravePath = getBrandExecutablePath("brave");
    fsState.existsSync.mockImplementation((value: string) => value === chromiumPath);
    browserBrandsState.detectInstalledBrowserBrands.mockReturnValue([
      createInstalledBrand("edge", edgePath),
      createInstalledBrand("brave", bravePath),
      createInstalledBrand("chromium", chromiumPath),
    ]);

    const { resolveChromeExecutablePath } =
      await import("../../packages/opensteer/src/local-browser/chrome-discovery.js");

    expect(resolveChromeExecutablePath(undefined)).toBe(edgePath);
    expect(browserBrandsState.detectInstalledBrowserBrands).toHaveBeenCalledTimes(1);
  });

  test("preserves the existing error when no executable can be resolved", async () => {
    const { resolveChromeExecutablePath } =
      await import("../../packages/opensteer/src/local-browser/chrome-discovery.js");

    expect(() => resolveChromeExecutablePath(undefined)).toThrow(
      "Could not find a Chrome or Chromium executable. Pass browser.executablePath or --executable-path.",
    );
  });
});

function createInstalledBrand(brandId: string, executablePath: string) {
  return {
    brand: {
      id: brandId,
      displayName: brandId,
    },
    brandId,
    displayName: brandId,
    executablePath,
    userDataDir: "/tmp/browser-profile",
  };
}

function getExplicitExecutablePath(): string {
  return process.platform === "win32" ? "C:\\custom\\chrome.exe" : "/custom/chrome";
}

function getLegacyChromeExecutablePath(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  return "/usr/bin/google-chrome";
}

function getLegacyChromiumExecutablePath(): string {
  if (process.platform === "darwin") {
    return "/Applications/Chromium.app/Contents/MacOS/Chromium";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\Chromium\\Application\\chrome.exe";
  }
  return "/usr/bin/chromium";
}

function getBrandExecutablePath(brand: "edge" | "brave"): string {
  if (brand === "edge") {
    if (process.platform === "darwin") {
      return "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    }
    if (process.platform === "win32") {
      return "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
    }
    return "/usr/bin/microsoft-edge";
  }

  if (process.platform === "darwin") {
    return "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
  }
  return "/usr/bin/brave-browser";
}
