import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { sanitizeChromeProfile } from "../../packages/opensteer/src/local-browser/chrome-singletons.js";
import { injectBrowserStealthScripts } from "../../packages/opensteer/src/local-browser/stealth.js";
import type { StealthProfile } from "../../packages/opensteer/src/local-browser/stealth-profiles.js";
import type {
  ConnectedCdpBrowserContext,
  ConnectedCdpPage,
} from "../../packages/opensteer/src/local-browser/types.js";

function createStealthProfile(overrides: Partial<StealthProfile> = {}): StealthProfile {
  return {
    id: "stealth:test-profile",
    platform: "macos",
    browserBrand: "chrome",
    browserVersion: "136.0.7103.93",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    screenResolution: { width: 1512, height: 982 },
    devicePixelRatio: 2,
    maxTouchPoints: 0,
    webglVendor: "Apple",
    webglRenderer: "Apple M2",
    fonts: ["SF Pro Text"],
    canvasNoiseSeed: 1,
    audioNoiseSeed: 2,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    ...overrides,
  };
}

function createCdpSession() {
  return {
    send: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
  };
}

type TestCdpSession = ReturnType<typeof createCdpSession>;
type TestContext = ConnectedCdpBrowserContext & {
  readonly newCDPSession: (page: unknown) => Promise<TestCdpSession>;
};
type PageListener = Parameters<NonNullable<ConnectedCdpBrowserContext["on"]>>[1];

describe("local browser stealth", () => {
  test("applies CDP stealth to current and future pages in the same context", async () => {
    const existingPage: ConnectedCdpPage = { close: vi.fn(async () => undefined) };
    const popupPage: ConnectedCdpPage = { close: vi.fn(async () => undefined) };
    const existingSession = createCdpSession();
    const popupSession = createCdpSession();
    let pageListener: PageListener | undefined;

    const context: TestContext = {
      pages: vi.fn(() => [existingPage]),
      newPage: vi.fn(async () => popupPage),
      addInitScript: vi.fn(async () => undefined),
      setExtraHTTPHeaders: vi.fn(async () => undefined),
      on: vi.fn((event, listener) => {
        expect(event).toBe("page");
        pageListener = listener;
        return context;
      }),
      newCDPSession: vi.fn(async (page: unknown) => {
        if (page === existingPage) {
          return existingSession;
        }
        if (page === popupPage) {
          return popupSession;
        }
        throw new Error("Unexpected page target.");
      }),
    };
    const profile = createStealthProfile();

    await injectBrowserStealthScripts(context, {
      profile,
      page: existingPage,
    });

    expect(context.on).toHaveBeenCalledTimes(1);
    expect(context.newCDPSession).toHaveBeenCalledTimes(1);
    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
      "User-Agent": profile.userAgent,
    });
    expect(existingSession.send).toHaveBeenNthCalledWith(
      1,
      "Network.setUserAgentOverride",
      expect.objectContaining({
        userAgent: profile.userAgent,
        platform: "MacIntel",
        userAgentMetadata: expect.objectContaining({
          architecture: "arm",
          platform: "macOS",
          platformVersion: "14.4.0",
        }),
      }),
    );
    expect(existingSession.send).toHaveBeenNthCalledWith(
      2,
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({
        width: profile.viewport.width,
        height: profile.viewport.height,
        deviceScaleFactor: profile.devicePixelRatio,
        screenWidth: profile.screenResolution.width,
        screenHeight: profile.screenResolution.height,
      }),
    );
    expect(existingSession.detach).toHaveBeenCalledTimes(1);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);

    expect(pageListener).toBeDefined();
    await pageListener?.(popupPage);

    await vi.waitFor(() => {
      expect(context.newCDPSession).toHaveBeenCalledTimes(2);
      expect(popupSession.detach).toHaveBeenCalledTimes(1);
    });
    expect(popupSession.send).toHaveBeenCalledWith(
      "Network.setUserAgentOverride",
      expect.objectContaining({
        userAgent: profile.userAgent,
      }),
    );
  });

  test("detaches the CDP session even when a protocol command fails", async () => {
    const page: ConnectedCdpPage = { close: vi.fn(async () => undefined) };
    const cdp = {
      send: vi.fn(async (method: string) => {
        if (method === "Network.setUserAgentOverride") {
          throw new Error("CDP domain unavailable");
        }
        return undefined;
      }),
      detach: vi.fn(async () => undefined),
    };
    const context: TestContext = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      addInitScript: vi.fn(async () => undefined),
      setExtraHTTPHeaders: vi.fn(async () => undefined),
      newCDPSession: vi.fn(async () => cdp),
    };

    await injectBrowserStealthScripts(context, {
      profile: createStealthProfile(),
      page,
    });

    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeChromeProfile", () => {
  test("is a no-op when the Chrome user data directory does not exist", async () => {
    const missingDir = path.join(
      os.tmpdir(),
      `opensteer-missing-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    await expect(sanitizeChromeProfile(missingDir)).resolves.toBeUndefined();
  });

  test("normalizes Preferences and removes Secure Preferences", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-profile-"));
    const defaultProfileDir = path.join(userDataDir, "Default");
    const prefsPath = path.join(defaultProfileDir, "Preferences");
    const securePrefsPath = path.join(defaultProfileDir, "Secure Preferences");

    await mkdir(defaultProfileDir, { recursive: true });
    await writeFile(
      prefsPath,
      JSON.stringify({
        profile: {
          exit_type: "Crashed",
          exited_cleanly: false,
        },
        untouched: true,
      }),
      "utf8",
    );
    await writeFile(securePrefsPath, "signed", "utf8");

    try {
      await sanitizeChromeProfile(userDataDir);

      const sanitized = JSON.parse(await readFile(prefsPath, "utf8")) as {
        readonly profile: {
          readonly exit_type: string;
          readonly exited_cleanly: boolean;
        };
        readonly untouched: boolean;
      };

      expect(sanitized).toEqual({
        profile: {
          exit_type: "Normal",
          exited_cleanly: true,
        },
        untouched: true,
      });
      await expect(access(securePrefsPath)).rejects.toThrow();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
