import { EventEmitter } from "node:events";
import { browserPagePolicyScript } from "@opensteer/browser-runtime-core/page-policy";
import { chromium, type Browser, type BrowserContext, type BrowserServer } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import {
  createChromiumChildEnvironment,
  PlaywrightChromiumLauncher,
} from "./playwright-launcher.js";

vi.mock("./chromium-clipboard.js", () => ({
  ChromiumClipboard: {
    create: async () => ({
      machineClipboardShared: false,
      open: async () => ({ close: async () => null }),
      close: async () => {},
    }),
  },
}));

describe("Chromium child environment", () => {
  it("keeps only required headless Linux variables", () => {
    const environment = createChromiumChildEnvironment(
      hostileEnvironment({
        DISPLAY: ":9",
        HOME: "/home/runtime",
        LANG: "en_US.UTF-8",
        LANGUAGE: "en_US:en",
        TMPDIR: "/runtime-tmp",
        WAYLAND_DISPLAY: "wayland-1",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
      "linux",
      true,
    );

    expect(environment).toEqual({
      HOME: "/home/runtime",
      LANG: "en_US.UTF-8",
      LANGUAGE: "en_US:en",
      TMPDIR: "/runtime-tmp",
    });
  });

  it("adds display selectors for headed Linux without forwarding display credentials", () => {
    const environment = createChromiumChildEnvironment(
      hostileEnvironment({
        DISPLAY: ":9",
        HOME: "/home/runtime",
        WAYLAND_DISPLAY: "wayland-1",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
      "linux",
      false,
    );

    expect(environment).toEqual({
      DISPLAY: ":9",
      HOME: "/home/runtime",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(environment).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
    expect(environment).not.toHaveProperty("XAUTHORITY");
  });

  it("keeps the narrow macOS environment without loader or service configuration", () => {
    const environment = createChromiumChildEnvironment(
      hostileEnvironment({
        __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
        DYLD_LIBRARY_PATH: "/untrusted-libraries",
        HOME: "/Users/runtime",
        LC_CTYPE: "UTF-8",
        TMPDIR: "/private/runtime-tmp",
      }),
      "darwin",
      false,
    );

    expect(environment).toEqual({
      __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
      HOME: "/Users/runtime",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/private/runtime-tmp",
    });
    expect(environment).not.toHaveProperty("DYLD_LIBRARY_PATH");
  });

  it("handles Windows variable names case-insensitively without PATH or credentials", () => {
    const environment = createChromiumChildEnvironment(
      hostileEnvironment({
        homedrive: "C:",
        homepath: "\\Users\\runtime",
        systemroot: "C:\\Windows",
        temp: "C:\\Temp",
        userprofile: "C:\\Users\\runtime",
        windir: "C:\\Windows",
      }),
      "win32",
      false,
    );

    expect(environment).toEqual({
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\runtime",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\runtime",
      WINDIR: "C:\\Windows",
    });
    expect(environment).not.toHaveProperty("Path");
  });

  it.each([
    ["off", false, false],
    ["provider", true, true],
    ["unsupported", true, false],
  ] as const)(
    "passes the sanitized environment explicitly to Playwright (%s)",
    async (_label, provider, supportsSecurity) => {
      const diagnostic = vi.spyOn(process.stderr, "write");
      const sourceEnvironment = hostileEnvironment({
        HOME: "/home/runtime",
        LANG: "en_US.UTF-8",
        SystemRoot: "C:\\Windows",
        TEMP: "/runtime-tmp",
        USERPROFILE: "C:\\Users\\runtime",
      });
      const browserCdp = {
        detach: vi.fn().mockResolvedValue(undefined),
        off: vi.fn(),
        on: vi.fn(),
        send: vi
          .fn()
          .mockImplementation((method: string) =>
            Promise.resolve(
              method === "Target.getBrowserContexts"
                ? { browserContextIds: ["profile-context"] }
                : {},
            ),
          ),
      };
      const tabListeners = new EventEmitter();
      const tabSession = {
        detach: vi.fn().mockResolvedValue(undefined),
        off: vi.fn(tabListeners.off.bind(tabListeners)),
        on: vi.fn(tabListeners.on.bind(tabListeners)),
        send: vi.fn().mockImplementation((method: string) => {
          if (method === "Security.enable" && supportsSecurity)
            tabListeners.emit("Security.visibleSecurityStateChanged", {
              visibleSecurityState: { securityState: "neutral" },
            });
          return Promise.resolve(
            method === "Target.getTargetInfo" ? { targetInfo: { targetId: "agent-tab" } } : {},
          );
        }),
      };
      const page = {
        on: vi.fn(),
        once: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
      };
      const context = {
        addInitScript: vi.fn().mockResolvedValue(undefined),
        newCDPSession: vi.fn().mockResolvedValue(tabSession),
        newPage: vi.fn().mockResolvedValue(page),
        on: vi.fn(),
        pages: () => [page],
      } as unknown as BrowserContext;
      const browser = {
        close: vi.fn().mockResolvedValue(undefined),
        newBrowserCDPSession: vi.fn().mockResolvedValue(browserCdp),
        newContext: vi.fn().mockResolvedValue(context),
      } as unknown as Browser;
      const browserServer = {
        kill: vi.fn().mockResolvedValue(undefined),
        wsEndpoint: () => "ws://127.0.0.1/owned-chromium",
      } as unknown as BrowserServer;
      const launch = vi.spyOn(chromium, "launchServer").mockResolvedValue(browserServer);
      vi.spyOn(chromium, "connect").mockResolvedValue(browser);
      const launcher = new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        environment: sourceEnvironment,
        ...(provider
          ? {
              authenticator: {
                ceremony: async () => ({
                  kind: "refused" as const,
                  error: "NotAllowedError" as const,
                }),
              },
            }
          : {}),
        executablePath: process.execPath,
        headless: true,
      });
      const claims = validClaims();

      await launcher.prepare();
      await launcher.prepare();
      const launched = await launcher.launch({
        initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
        partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000001",
        sessionId: claims.sessionId,
        storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
      });

      expect(
        diagnostic.mock.calls.filter(([line]) =>
          String(line).includes('"event":"browser-runtime.passkeys-unavailable"'),
        ),
      ).toHaveLength(provider && !supportsSecurity ? 1 : 0);
      expect(launcher.passkeys).toBe(provider && supportsSecurity ? 1 : undefined);
      expect(context.addInitScript).toHaveBeenCalledWith({
        content:
          provider && supportsSecurity
            ? expect.stringContaining("opensteerPasskey_")
            : browserPagePolicyScript,
      });
      if (provider && supportsSecurity) {
        const platform = await launched.context.pages()[0]!.cdp();
        await platform.send("Network.disable");
        await platform.send("Security.disable");
        expect(
          tabSession.send.mock.calls.filter(
            ([method]) => method === "Network.disable" || method === "Security.disable",
          ),
        ).toEqual([]);
      }
      expect(launch).toHaveBeenCalledTimes(provider ? 2 : 1);
      const launchOptions = launch.mock.calls[0]?.[0];
      expect(launchOptions?.env).toEqual(
        createChromiumChildEnvironment(sourceEnvironment, process.platform, true),
      );
      expect(launchOptions?.env).not.toHaveProperty("OPENSTEER_BROWSER_DEVICE_BRIDGE_TOKEN");
      expect(launchOptions?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          // The Runtime's ledger alone sizes pages.
          viewport: null,
        }),
      );

      await expect(
        launched.cdp.send("Target.createTarget", { url: "https://example.com/" }),
      ).resolves.toEqual({ targetId: "agent-tab" });
      expect(context.newPage).toHaveBeenCalledTimes(provider ? 2 : 1);
      await vi.waitFor(() =>
        expect(tabSession.send).toHaveBeenCalledWith("Page.navigate", {
          url: "https://example.com/",
        }),
      );
      await expect(
        launched.cdp.send("Target.createTarget", {
          browserContextId: "another-profile",
          url: "about:blank",
        }),
      ).rejects.toThrow(/another browser context/i);
      await expect(launched.cdp.send("Target.getBrowserContexts")).resolves.toEqual({
        browserContextIds: ["profile-context"],
      });
      await launched.cdp.send("Storage.getCookies");
      expect(browserCdp.send).toHaveBeenCalledWith("Storage.getCookies", {
        browserContextId: "profile-context",
      });
      await expect(
        launched.cdp.send("Storage.clearCookies", { browserContextId: "another-profile" }),
      ).rejects.toThrow(/another browser context/i);
    },
  );
});

function hostileEnvironment(
  safeValues: Readonly<Record<string, string>>,
): Readonly<NodeJS.ProcessEnv> {
  return {
    API_KEY: "api-secret",
    AWS_ACCESS_KEY_ID: "access-key",
    AWS_SECRET_ACCESS_KEY: "secret-key",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    GITHUB_TOKEN: "github-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google.json",
    LD_PRELOAD: "/untrusted.so",
    OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: "public-key-material",
    OPENSTEER_BROWSER_DEVICE_BRIDGE_TOKEN: "bridge-secret",
    OPENSTEER_HOST_URL: "https://host.internal",
    PASSWORD: "password-secret",
    Path: "C:\\Tools",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
    XAUTHORITY: "/home/runtime/.Xauthority",
    ...safeValues,
  };
}
