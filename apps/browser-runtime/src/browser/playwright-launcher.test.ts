import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import { assertImportedCookies } from "./native-profile-storage.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { browserPagePolicyScript } from "@opensteer/browser-runtime-core/page-policy";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type Page,
} from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import {
  createChromiumChildEnvironment,
  PlaywrightChromiumLauncher,
} from "./playwright-launcher.js";

vi.mock("./chromium-clipboard.js", () => ({
  ChromiumClipboard: {
    lazy: () => ({
      machineClipboardShared: false,
      open: async () => ({ close: async () => null }),
      close: async () => {},
    }),
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
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
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
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":9",
      HOME: "/home/runtime",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
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

describe("native Chromium profiles", () => {
  it("launches the default context with explicit contained arguments and releases only after orderly close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "os-native-options-"));
    const sessions = join(directory, "Default", "Sessions");
    await mkdir(sessions, { recursive: true });
    for (const name of [
      "Session_151",
      "Tabs_151",
      "Current Session",
      "Last Session",
      "Current Tabs",
      "Last Tabs",
      "retained",
    ])
      await writeFile(join(sessions, name), "sentinel");
    await writeFile(join(directory, "Default", "Cookies"), "untouched");
    const close = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const processHandle = () => {
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 12345 });
      return child;
    };
    let ownedProcess = processHandle();
    const exit = () => {
      Object.defineProperty(ownedProcess, "exitCode", { value: 0 });
      ownedProcess.emit("exit", 0, null);
    };
    const cdp = {
      send: vi
        .fn()
        .mockImplementation((method: string) =>
          Promise.resolve(
            method === "Target.createTarget" ? { targetId: "private-helper" } : { cookies: [] },
          ),
        ),
      on: vi.fn(),
      off: vi.fn(),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const helper = { on: vi.fn(), isClosed: () => false };
    const pages: Page[] = [];
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue(cdp),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      process: () => ownedProcess,
      browser: () => browser,
      pages: () => pages,
      newPage: vi.fn().mockImplementation(async () => {
        pages.push(helper as unknown as Page);
        return helper;
      }),
      newCDPSession: vi.fn().mockResolvedValue(cdp),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      close: vi.fn().mockImplementation(() => {
        closing.resolve();
        return close.promise;
      }),
    };
    const persistent = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue(context as unknown as BrowserContext);
    const disposable = vi.spyOn(chromium, "launchServer");
    const launcher = new PlaywrightChromiumLauncher({
      executablePath: process.execPath,
      headless: true,
      chromiumSandbox: true,
      proxyUrl: "http://127.0.0.1:8123",
    });
    try {
      const cancellation = new AbortController();
      const launched = await launcher.launch(nativeProfileRequest(directory), cancellation.signal);
      expect(ownedProcess.listenerCount("exit")).toBe(1);
      cancellation.abort();
      expect(
        context.close,
        "Ending the originating attachment must preserve the warm native host",
      ).not.toHaveBeenCalled();
      expect(launcher.localProfiles.engine).toBe("chromium");
      expect(await readdir(sessions)).toEqual(["retained"]);
      expect(await readFile(join(directory, "Default", "Cookies"), "utf8")).toBe("untouched");
      expect(disposable).not.toHaveBeenCalled();
      const options = persistent.mock.calls[0]![1]!;
      expect(persistent.mock.calls[0]![0]).toBe(directory);
      expect(options).toMatchObject({
        ignoreDefaultArgs: true,
        executablePath: process.execPath,
        viewport: null,
        chromiumSandbox: true,
      });
      expect(options.args).toEqual(
        expect.arrayContaining([
          `--user-data-dir=${directory}`,
          "--remote-debugging-pipe",
          "--disable-extensions",
          "--disable-component-extensions-with-background-pages",
          "--restore-last-session",
          "--no-startup-window",
          "--headless=new",
          "--proxy-server=http://127.0.0.1:8123",
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ]),
      );
      expect(options.args).not.toEqual(expect.arrayContaining(["--password-store=basic"]));
      expect(options.args).not.toEqual(expect.arrayContaining(["--use-mock-keychain"]));
      expect(options.args).not.toContain("--no-sandbox");
      expect(JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8"))).toEqual(
        { session: { restore_on_startup: 1 } },
      );
      expect(context.newPage).toHaveBeenCalledOnce();
      expect(launcher.localProfiles.preparation).toBe("conversion");
      expect(launched).not.toHaveProperty("profile");
      expect(context.newPage).toHaveBeenCalledOnce();
      expect(context.newCDPSession).not.toHaveBeenCalled();
      expect(launched.context.pages()).toEqual([]);
      await expect(launched.cdp.send("Target.getBrowserContexts")).resolves.toEqual({
        browserContextIds: [],
      });
      await launched.cdp.send("Storage.getCookies");
      expect(cdp.send).toHaveBeenCalledWith("Storage.getCookies", {});
      await expect(
        launched.cdp.send("Storage.clearCookies", { browserContextId: "other" }),
      ).rejects.toThrow(/another browser context/);
      pages.push(helper as unknown as Page);
      await launched.replaceSiteCookies(
        "https://site.test",
        [
          {
            name: "sid",
            value: "committed",
            domain: "site.test",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
          },
        ],
        new AbortController().signal,
      );
      expect(context.newCDPSession).toHaveBeenCalledExactlyOnceWith(helper);
      expect(cdp.send).toHaveBeenCalledWith("Storage.clearDataForOrigin", {
        origin: expect.stringMatching(/^https:\/\/[a-f0-9-]+\.invalid$/u),
        storageTypes: "cookies",
      });
      expect(cdp.detach).toHaveBeenCalledOnce();
      pages.length = 0;
      let released = false;
      const releasing = launcher.localProfiles.release(directory).then(() => {
        released = true;
      });
      await withTimeout(closing.promise, 1000, {
        timeoutError: () => new Error("Native context never began orderly close"),
      });
      expect(released).toBe(false);
      expect(context.close).toHaveBeenCalledOnce();
      close.resolve();
      await vi.waitFor(() => expect(browser.close).toHaveBeenCalledOnce(), { timeout: 1000 });
      expect(released, "Protocol close must not release a still-running native process").toBe(
        false,
      );
      exit();
      await releasing;
      expect(browser.close).toHaveBeenCalledOnce();
      await launched.close();
      expect(context.close).toHaveBeenCalledOnce();
      // Existing preferences belong to Chromium and cannot be replaced on reopen.
      await writeFile(join(directory, "Default", "Preferences"), '{"retained":true}');
      pages.length = 0;
      ownedProcess = processHandle();
      const reopened = await launcher.launch(nativeProfileRequest(directory));
      expect(await readFile(join(directory, "Default", "Preferences"), "utf8")).toBe(
        '{"retained":true}',
      );
      const reopenedClose = reopened.close();
      exit();
      await reopenedClose;
    } finally {
      close.resolve();
      exit();
      await launcher.localProfiles.release(directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unpatched persistent context and fences release without clearing native storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "os-native-unowned-"));
    await writeFile(join(directory, "retained"), "sentinel");
    const context = {
      browser: () => ({}),
      close: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      newPage: vi.fn(),
    };
    const persistent = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValueOnce(context as unknown as BrowserContext);
    const launcher = new PlaywrightChromiumLauncher({
      executablePath: process.execPath,
      headless: true,
      chromiumSandbox: true,
    });
    try {
      await expect(launcher.launch(nativeProfileRequest(directory))).rejects.toThrow(
        "Native Chromium process ownership is unavailable",
      );
      expect(context.close).toHaveBeenCalledOnce();
      expect(context.newPage).not.toHaveBeenCalled();
      await expect(launcher.localProfiles.release(directory)).rejects.toThrow(
        "Native Chromium process ownership is unavailable",
      );
      expect(await readFile(join(directory, "retained"), "utf8")).toBe("sentinel");
    } finally {
      persistent.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["--password-store=basic", "--use-mock-keychain", "--profile-directory=Other"])(
    "refuses native launches with %s",
    async (arg) => {
      const launch = vi.spyOn(chromium, "launchPersistentContext");
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: process.execPath,
        chromiumSandbox: true,
        headless: true,
        args: [arg],
      });
      await expect(launcher.launch(nativeProfileRequest("/unused-native-profile"))).rejects.toThrow(
        /full Chromium/,
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("detects silently rejected imports, preserving partition identities and ignoring legitimate expiry", () => {
    const cookie = {
      name: "session",
      value: "secret",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: -1,
      partitionKey: "https://top.example",
      partitionKeyHasCrossSiteAncestor: false,
    };
    const live = {
      ...cookie,
      partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false },
    };
    expect(() => assertImportedCookies([cookie], [live])).not.toThrow();
    expect(() => assertImportedCookies([cookie], [{ ...live, value: "rejected" }])).toThrow(
      /rejected an imported profile cookie/,
    );
    expect(() =>
      assertImportedCookies(
        [cookie],
        [
          {
            ...live,
            partitionKey: { topLevelSite: "https://other.example", hasCrossSiteAncestor: false },
          },
        ],
      ),
    ).toThrow(/rejected/);
    expect(() => assertImportedCookies([{ ...cookie, expires: 1 }], [])).not.toThrow();
  });
});
