import { afterEach, describe, expect, test, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  existsSync: vi.fn((value: string) => value === "/custom/chrome"),
}));

const chromeDiscoveryState = vi.hoisted(() => ({
  expandHome: vi.fn((value: string) => value.replace(/^~(?=\/|\\|$)/, "/Users/test")),
  firstExistingPath: vi.fn(
    (candidates: readonly (string | null | undefined)[]) =>
      candidates.find((candidate) => candidate?.includes("Brave Browser")) ?? null,
  ),
  resolveBinaryFromPath: vi.fn((_name: string) => null),
}));

vi.mock("node:fs", () => ({
  existsSync: fsState.existsSync,
}));

vi.mock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
  expandHome: chromeDiscoveryState.expandHome,
  firstExistingPath: chromeDiscoveryState.firstExistingPath,
  resolveBinaryFromPath: chromeDiscoveryState.resolveBinaryFromPath,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  fsState.existsSync.mockReset();
  fsState.existsSync.mockImplementation((value: string) => value === "/custom/chrome");
  chromeDiscoveryState.expandHome.mockReset();
  chromeDiscoveryState.expandHome.mockImplementation((value: string) =>
    value.replace(/^~(?=\/|\\|$)/, "/Users/test"),
  );
  chromeDiscoveryState.firstExistingPath.mockReset();
  chromeDiscoveryState.firstExistingPath.mockImplementation(
    (candidates: readonly (string | null | undefined)[]) =>
      candidates.find((candidate) => candidate?.includes("Brave Browser")) ?? null,
  );
  chromeDiscoveryState.resolveBinaryFromPath.mockReset();
  chromeDiscoveryState.resolveBinaryFromPath.mockReturnValue(null);
});

describe("browser brand registry", () => {
  test("getAllBrowserBrands returns the expected priority-ordered brands", async () => {
    const { getAllBrowserBrands } =
      await import("../../packages/opensteer/src/local-browser/browser-brands.js");

    expect(getAllBrowserBrands().map((brand) => brand.id)).toEqual([
      "chrome",
      "chrome-canary",
      "edge",
      "brave",
      "vivaldi",
      "helium",
      "chromium",
    ]);
  });

  test("getBrowserBrand resolves known brands and rejects unknown ids", async () => {
    const { getBrowserBrand } =
      await import("../../packages/opensteer/src/local-browser/browser-brands.js");

    expect(getBrowserBrand("chrome")).toMatchObject({
      id: "chrome",
      displayName: "Google Chrome",
    });
    expect(() => getBrowserBrand("invalid" as never)).toThrow('Unknown browser brand "invalid".');
  });

  test("isBrandProcess matches known Chromium-family main process command lines", async () => {
    const { getBrowserBrand, isBrandProcess } =
      await import("../../packages/opensteer/src/local-browser/browser-brands.js");

    expect(
      isBrandProcess(
        getBrowserBrand("chrome"),
        '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --profile-directory=Default',
      ),
    ).toBe(true);
    expect(
      isBrandProcess(
        getBrowserBrand("brave"),
        '"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --no-first-run',
      ),
    ).toBe(true);
    expect(
      isBrandProcess(
        getBrowserBrand("edge"),
        '"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --type=renderer',
      ),
    ).toBe(false);
  });

  test("resolveBrandExecutablePath honors explicit paths and brand defaults", async () => {
    const { getBrowserBrand, resolveBrandExecutablePath, resolveBrandUserDataDir } =
      await import("../../packages/opensteer/src/local-browser/browser-brands.js");

    expect(resolveBrandExecutablePath(getBrowserBrand("chrome"), "/custom/chrome")).toBe(
      "/custom/chrome",
    );
    expect(resolveBrandExecutablePath(getBrowserBrand("brave"))).toContain("Brave Browser");
    expect(resolveBrandUserDataDir(getBrowserBrand("helium"))).toBe(
      "/Users/test/Library/Application Support/net.imput.helium",
    );

    expect(() => resolveBrandExecutablePath(getBrowserBrand("chrome"), "/missing/chrome")).toThrow(
      'Google Chrome executable was not found at "/missing/chrome".',
    );
  });

  test("detectInstalledBrowserBrands returns resolved installed brands", async () => {
    chromeDiscoveryState.firstExistingPath
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")
      .mockReturnValue(null);

    const { detectInstalledBrowserBrands } =
      await import("../../packages/opensteer/src/local-browser/browser-brands.js");

    expect(detectInstalledBrowserBrands()).toEqual([
      {
        brand: expect.objectContaining({
          id: "brave",
          displayName: "Brave Browser",
        }),
        brandId: "brave",
        displayName: "Brave Browser",
        executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
      },
    ]);
  });
});
