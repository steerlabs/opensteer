import { browserPagePolicyScript } from "@opensteer/browser-runtime-core/page-policy";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import type { BrowserSurfaceId } from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { gate } from "@opensteer/shared/test-support/observation";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type Page,
  type Frame,
} from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  assertImportedCookies,
  initializeNativePreferences,
  matchRestoredTabs,
  readTabRestoreSidecar,
  writeTabRestoreSidecar,
} from "./native-profile-storage.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";
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

it.each(["ready", "acquiring"] as const)(
  "retires a %s private CDP before awaiting native close and fences new attachments",
  async (state) => {
    const f = await nativeCloseFixture();
    const retired = Promise.withResolvers<void>();
    const nativeClose = Promise.withResolvers<void>();
    const events = new EventEmitter();
    let physicallyClosed = false;
    const page = Object.assign(events, {
      isClosed: () => physicallyClosed,
      close: vi.fn(async () => {
        await retired.promise;
        await nativeClose.promise;
        physicallyClosed = true;
        events.emit("close");
      }),
    });
    const session = Object.assign(new EventEmitter(), {
      send: vi.fn(async () => ({})),
      detach: vi.fn(async () => retired.resolve()),
    });
    const acquired = Promise.withResolvers<typeof session>();
    let attaching: Promise<import("@opensteer/browser-runtime-core").CdpSession> | undefined;
    let closing: Promise<void> | undefined;
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      vi.spyOn(f.context, "pages").mockReturnValue([page as unknown as Page]);
      f.context.newCDPSession.mockReturnValue(acquired.promise);
      if (state === "ready") acquired.resolve(session);
      const handle = launched.context.pages()[0]!;
      attaching = handle.cdp();
      void attaching.catch(() => undefined);
      const channel = state === "ready" ? await attaching : undefined;
      vi.useFakeTimers();
      closing = handle.close();
      await vi.advanceTimersByTimeAsync(0);
      if (state === "acquiring") {
        expect(
          page.close,
          "Native close must not join an unready CDP acquisition",
        ).toHaveBeenCalledOnce();
        acquired.resolve(session);
        await vi.advanceTimersByTimeAsync(0);
        await expect(attaching).rejects.toThrow(/clos/i);
      }
      expect(
        session.detach,
        "Native close cannot finish until its private CDP is retired",
      ).toHaveBeenCalledOnce();
      expect(handle.isClosed(), "Only the native close event ends the page").toBe(false);
      await expect(handle.cdp()).rejects.toThrow(/clos/i);
      await expect(handle.agentCdp()).rejects.toThrow(/clos/i);
      if (channel) await expect(channel.send("Runtime.evaluate")).rejects.toThrow(/closed/i);
      const duplicate = handle.close();
      nativeClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      await duplicate;
      expect(handle.isClosed()).toBe(true);
      expect(page.close).toHaveBeenCalledOnce();
      expect(f.context.newCDPSession).toHaveBeenCalledOnce();
    } finally {
      acquired.resolve(session);
      retired.resolve();
      nativeClose.resolve();
      await closing;
      vi.useRealTimers();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

describe("Chromium proxy launch", () => {
  it("keeps implicit loopback bypass for a native profile", async () => {
    const f = await nativeCloseFixture({
      preserveLoopbackBypass: true,
      proxyUrl: "http://127.0.0.1:4313",
    });
    const launch = vi.mocked(chromium.launchPersistentContext);
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const options = launch.mock.lastCall?.[1];
      expect(options?.args?.slice(-3)).toEqual([
        "--proxy-server=http://127.0.0.1:4313",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ]);
      expect(options?.args).not.toContain("--proxy-bypass-list=<-loopback>");
      expect(options?.chromiumSandbox).toBe(true);
    } finally {
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])("handles guest loopback bypass (preserve=%s)", async (preserve) => {
    const launch = vi
      .spyOn(chromium, "launchServer")
      .mockRejectedValue(new Error("launch fixture"));
    try {
      const launcher = new PlaywrightChromiumLauncher({
        chromiumSandbox: true,
        executablePath: process.execPath,
        headless: true,
        preserveLoopbackBypass: preserve,
        proxyUrl: "http://127.0.0.1:4313",
      });
      await expect(
        launcher.launch({
          initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
          partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000001",
          sessionId: validClaims().sessionId,
          storage: { kind: "guest" },
        }),
      ).rejects.toThrow("launch fixture");
      expect(launch).toHaveBeenCalledOnce();
      const options = launch.mock.calls[0]![0]!;
      expect(options.chromiumSandbox).toBe(true);
      expect(options.proxy).toEqual(preserve ? undefined : { server: "http://127.0.0.1:4313" });
      expect(options.args?.slice(-4)).toEqual([
        "--disable-background-networking",
        ...(preserve ? ["--proxy-server=http://127.0.0.1:4313"] : []),
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(preserve ? [] : ["--proxy-bypass-list=<-loopback>"]),
      ]);
    } finally {
      launch.mockRestore();
    }
  });
});

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
        newPage: vi.fn().mockImplementation(async () => ({ ...page })),
        on: vi.fn(),
        pages: () => [page],
      } as unknown as BrowserContext;
      const browser = {
        close: vi.fn().mockResolvedValue(undefined),
        newBrowserCDPSession: vi.fn().mockResolvedValue(browserCdp),
        newContext: vi.fn().mockResolvedValue(context),
        version: () => "151.0.7922.34",
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
        storage: { kind: "guest" },
      });

      expect(
        diagnostic.mock.calls.filter(([line]) =>
          String(line).includes('"event":"browser-runtime.passkeys-unavailable"'),
        ),
      ).toHaveLength(provider && !supportsSecurity ? 1 : 0);
      expect(launcher.passkeys).toBe(provider && supportsSecurity ? 1 : undefined);
      expect(context.addInitScript).toHaveBeenCalledWith({
        content:
          provider && supportsSecurity ? expect.stringContaining("b_") : browserPagePolicyScript,
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
          userAgent: expect.stringContaining("Chrome/151.0.0.0"),
          // The Runtime's ledger alone sizes pages.
          viewport: null,
        }),
      );
      // Playwright derives metadata from the UA string (frozen platform
      // version, wrong architecture); each page is overridden with metadata
      // built from the real system.
      const pageHandler = (context.on as ReturnType<typeof vi.fn>).mock.calls.find(
        ([event]) => event === "page",
      )?.[1] as ((page: unknown) => void) | undefined;
      expect(pageHandler).toBeDefined();
      pageHandler!({ on: vi.fn() });
      await vi.waitFor(() =>
        expect(tabSession.send).toHaveBeenCalledWith(
          "Emulation.setUserAgentOverride",
          expect.objectContaining({
            userAgent: expect.stringContaining("Chrome/151.0.0.0"),
            userAgentMetadata: expect.objectContaining({
              brands: [
                { brand: "Chromium", version: "151" },
                { brand: "Not=A?Brand", version: "99" },
              ],
            }),
          }),
        ),
      );

      await expect(
        launched.cdp.send("Target.createTarget", { url: "https://example.com/" }),
      ).resolves.toEqual({ targetId: "agent-tab" });
      // One extra page is the throwaway context that reads the engine's own
      // high-entropy identity before the Guest context is created.
      expect(context.newPage).toHaveBeenCalledTimes(provider ? 4 : 3);
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

it.each(["page close", "page close after the browser died", "context end"] as const)(
  "owns a page until its %s confirms it, asking again with real attempts",
  async (signal) => {
    const f = await nativeCloseFixture();
    const events = new EventEmitter();
    let physicallyClosed = false;
    const page = Object.assign(events, {
      isClosed: () => physicallyClosed,
      close: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("Protocol error: Target.closeTarget"))
        .mockResolvedValue(undefined),
    });
    f.context.newCDPSession.mockResolvedValue(
      Object.assign(new EventEmitter(), {
        detach: vi.fn(async () => undefined),
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-9" } } : {},
        ),
      }),
    );
    try {
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      vi.spyOn(f.context, "pages").mockReturnValue([page as unknown as Page]);
      const handle = launched.context.pages()[0]!;
      const gone = vi.fn();
      const crashed = vi.fn();
      handle.onClose(gone);
      handle.onRendererGone?.(crashed);
      await expect(handle.close()).rejects.toThrow("Protocol error");
      expect(handle.isClosed(), "A refused close leaves the page open").toBe(false);
      await handle.close();
      expect(handle.isClosed(), "A close that settles proves nothing").toBe(false);
      await handle.close();
      expect(page.close, "Later attempts go around Playwright's own close").toHaveBeenCalledOnce();
      expect(
        f.cdp.send.mock.calls.filter(([method]) => method === "Target.closeTarget"),
        "Each later attempt closes this page's own target, named through its own debugger",
      ).toEqual([
        ["Target.closeTarget", { targetId: "target-9" }],
        ["Target.closeTarget", { targetId: "target-9" }],
      ]);
      events.emit("crash");
      expect(crashed).toHaveBeenCalledOnce();
      expect(handle.isClosed(), "A crashed renderer is not a closed page").toBe(false);
      expect(gone).not.toHaveBeenCalled();
      if (signal === "context end") {
        for (const [event, listener] of f.context.on.mock.calls as [string, () => void][])
          if (event === "close") listener();
      } else {
        // Chromium dying reports each page's close before its context's.
        if (signal === "page close after the browser died")
          f.cdp.send.mockRejectedValue(new Error("Browser has been closed"));
        physicallyClosed = true;
        events.emit("close");
      }
      await vi.waitFor(() => expect(gone, "The end was never confirmed").toHaveBeenCalledOnce(), {
        timeout: 1_000,
      });
      expect(gone).toHaveBeenCalledWith(signal === "page close" ? "page" : "context");
      expect(handle.isClosed()).toBe(true);
      events.emit("close");
      await Promise.resolve();
      expect(gone).toHaveBeenCalledOnce();
      await launched.close();
    } finally {
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

it("hands a popup off with its opener, and finds a target past a page asked to close", async () => {
  const f = await nativeCloseFixture();
  const fakePage = () =>
    Object.assign(new EventEmitter(), {
      isClosed: () => false,
      close: vi.fn(() => new Promise<void>(() => {})),
    });
  const opener = fakePage();
  const popup = fakePage();
  const closing = fakePage();
  const sibling = fakePage();
  f.context.newCDPSession.mockImplementation(async (target) => {
    const page: unknown = target;
    if (page === closing) return new Promise(() => {});
    return Object.assign(new EventEmitter(), {
      detach: vi.fn(async () => undefined),
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo"
          ? { targetInfo: { targetId: page === sibling ? "sibling" : "other" } }
          : {},
      ),
    });
  });
  try {
    const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
    const handed: [unknown, unknown][] = [];
    launched.context.handOff((page, from) => handed.push([page, from]));
    const announce = (page: unknown) => {
      for (const [event, listener] of f.context.on.mock.calls as [
        string,
        (page: unknown) => void,
      ][])
        if (event === "page") listener(page);
    };
    announce(opener);
    announce(popup);
    opener.emit("popup", popup);
    await Promise.resolve();
    const handles = launched.context as unknown as {
      wrap(page: unknown): unknown;
      pageByTargetId(targetId: string): Promise<unknown>;
    };
    expect(handed).toEqual([
      [handles.wrap(opener), null],
      [handles.wrap(popup), handles.wrap(opener)],
    ]);
    vi.spyOn(f.context, "pages").mockReturnValue([closing, sibling] as unknown as Page[]);
    void (handles.wrap(closing) as { close(): Promise<void> }).close();
    await expect(handles.pageByTargetId("sibling")).resolves.toBe(handles.wrap(sibling));
    await launched.close();
  } finally {
    f.exit();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it("makes every close a new attempt, and goes around a hung first close to the browser", async () => {
  const f = await nativeCloseFixture();
  const events = new EventEmitter();
  let physicallyClosed = false;
  const page = Object.assign(events, {
    isClosed: () => physicallyClosed,
    close: vi.fn(() => new Promise<void>(() => {})),
  });
  f.context.newCDPSession.mockResolvedValue(
    Object.assign(new EventEmitter(), {
      detach: vi.fn(async () => undefined),
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-1" } } : {},
      ),
    }),
  );
  try {
    const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
    vi.spyOn(f.context, "pages").mockReturnValue([page as unknown as Page]);
    const handle = launched.context.pages()[0]!;
    await handle.targetId();
    void handle.close();
    await vi.waitFor(
      () => expect(page.close, "First close never reached Playwright").toHaveBeenCalledOnce(),
      {
        timeout: 1_000,
      },
    );
    const closeTarget = () =>
      f.cdp.send.mock.calls.filter(([method]) => method === "Target.closeTarget");
    await expect(handle.close(), "A hung first close never stalls the next").resolves.toBe(
      undefined,
    );
    await handle.close();
    expect(closeTarget()).toEqual([
      ["Target.closeTarget", { targetId: "target-1" }],
      ["Target.closeTarget", { targetId: "target-1" }],
    ]);
    expect(handle.isClosed(), "Only the native end closes it").toBe(false);
    await expect(
      handle.agentCdp(),
      "A page asked to close never returns to service",
    ).rejects.toThrow(/clos/i);
    physicallyClosed = true;
    events.emit("close");
    await vi.waitFor(() => expect(handle.isClosed(), "The end was never confirmed").toBe(true), {
      timeout: 1_000,
    });
    await launched.close();
  } finally {
    f.exit();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it("reports a page it cannot name to close, instead of rejoining a hung close", async () => {
  const f = await nativeCloseFixture();
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    close: vi.fn(() => new Promise<void>(() => {})),
  });
  f.context.newCDPSession.mockRejectedValue(new Error("Target page has been closed"));
  try {
    const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
    vi.spyOn(f.context, "pages").mockReturnValue([page as unknown as Page]);
    const handle = launched.context.pages()[0]!;
    void handle.close();
    await expect(handle.close()).rejects.toMatchObject({ reason: "page-unnameable" });
    expect(page.close, "The hung close is never joined again").toHaveBeenCalledOnce();
    await launched.close();
  } finally {
    f.exit();
    await rm(f.directory, { recursive: true, force: true });
  }
});

describe("native Chromium profiles", () => {
  it.each(["iframe media", "iframe Web Audio", "top Web Audio"])(
    "protects %s using native media state, including existing playback",
    async (kind) => {
      const f = await nativeCloseFixture();
      const main = { evaluate: async () => false } as unknown as Frame;
      const child = { evaluate: async () => false } as unknown as Frame;
      const page = {
        on: vi.fn(),
        once: vi.fn(),
        frames: () => [main, child],
        mainFrame: () => main,
      } as unknown as Page;
      let playing = true;
      const sessions: { detach: ReturnType<typeof vi.fn> }[] = [];
      f.context.newCDPSession.mockImplementation(async (frame) => {
        const events = new EventEmitter();
        const active = frame === (kind === "top Web Audio" ? main : child);
        const session = {
          on: events.on.bind(events),
          detach: vi.fn().mockResolvedValue(undefined),
          send: vi.fn(async (method: string) => {
            if (active && method === "Media.enable" && kind === "iframe media") {
              events.emit("Media.playerCreated", { player: { playerId: "player" } });
              events.emit("Media.playerEventsAdded", {
                playerId: "player",
                events: [{ value: JSON.stringify({ event: playing ? "kPlay" : "kPause" }) }],
              });
            }
            if (active && method === "WebAudio.enable" && kind !== "iframe media")
              events.emit("WebAudio.contextCreated", {
                context: {
                  contextId: "audio",
                  contextType: "realtime",
                  contextState: playing ? "running" : "suspended",
                },
              });
            return method === "Page.getFrameTree"
              ? { frameTree: { frame: { id: "main" } } }
              : method === "Page.createIsolatedWorld"
                ? { executionContextId: 1 }
                : method === "Runtime.evaluate"
                  ? { result: { value: false } }
                  : {};
          }),
        };
        sessions.push(session);
        return session;
      });
      try {
        const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
        vi.spyOn(f.context, "pages").mockReturnValue([page]);
        const handle = launched.context.pages()[0]!;
        expect(await handle.keepAwake?.()).toBe("media");
        playing = false;
        expect(await handle.keepAwake?.()).toBeNull();
        expect(sessions.every((session) => session.detach.mock.calls.length === 1)).toBe(true);
        await launched.close();
      } finally {
        f.exit();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );
  it("reads a navigated document's media and skips a detached frame", async () => {
    const f = await nativeCloseFixture();
    const destroyed = new Error(
      "frame.evaluate: Execution context was destroyed, most likely because of a navigation",
    );
    const main = {
      evaluate: vi.fn().mockRejectedValueOnce(destroyed).mockResolvedValue(true),
      isDetached: () => false,
    } as unknown as Frame;
    const child = {
      evaluate: vi.fn().mockRejectedValue(new Error("Frame was detached")),
      isDetached: () => true,
    } as unknown as Frame;
    const page = {
      on: vi.fn(),
      once: vi.fn(),
      frames: () => [child, main],
      mainFrame: () => main,
    } as unknown as Page;
    try {
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      vi.spyOn(f.context, "pages").mockReturnValue([page]);
      expect(await launched.context.pages()[0]!.keepAwake?.()).toBe("media");
      expect(main.evaluate).toHaveBeenCalledTimes(2);
      expect(f.context.newCDPSession).not.toHaveBeenCalledWith(child);
      await launched.close();
    } finally {
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it.each(["context", "browser"] as const)(
    "releases proven ownership after a %s protocol close failure",
    async (stage) => {
      const f = await nativeCloseFixture();
      const failure = new Error("protocol close failed");
      const protocolClose =
        stage === "browser"
          ? gate({ label: "protocol close after process exit", deadlineMs: 1000 })
          : undefined;
      if (stage === "context") f.context.close.mockRejectedValueOnce(failure);
      f.browser.close.mockImplementationOnce(async () => {
        f.exit();
        if (protocolClose) {
          await protocolClose.enter();
          throw failure;
        }
      });
      try {
        const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
        const closing = launched.close();
        const failed = expect(closing).rejects.toThrow("protocol close failed");
        if (protocolClose) {
          await protocolClose.entered;
          protocolClose.release();
        }
        await failed;
        await expect(f.launcher.localProfiles.release(f.directory)).resolves.toBe("released");
        const next = await f.launcher.launch(nativeProfileRequest(f.directory));
        await next.close();
      } finally {
        protocolClose?.release();
        f.exit();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

  it("fences an unproven exit until its captured child exits, then reopens", async () => {
    const f = await nativeCloseFixture();
    f.browser.close.mockResolvedValueOnce(undefined);
    try {
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      vi.useFakeTimers();
      const stopped = launched.close();
      const failed = expect(stopped).rejects.toThrow("Native Chromium did not exit");
      await vi.advanceTimersByTimeAsync(1800);
      await failed;
      await expect(f.launcher.localProfiles.release(f.directory)).rejects.toThrow();
      await expect(f.launcher.launch(nativeProfileRequest(f.directory))).rejects.toThrow(
        /already owned/,
      );
      f.exit();
      await expect(launched.close()).rejects.toThrow("Native Chromium did not exit");
      await vi.advanceTimersByTimeAsync(0);
      await expect(f.launcher.localProfiles.release(f.directory)).resolves.toBe("released");
      const reopened = await f.launcher.launch(nativeProfileRequest(f.directory));
      await reopened.close();
    } finally {
      vi.useRealTimers();
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("detaches the browser CDP before starting native protocol shutdown", async () => {
    const f = await nativeCloseFixture();
    const detached = Promise.withResolvers<void>();
    try {
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const closingCdp = vi
        .spyOn(launched.cdp as typeof launched.cdp & { close(): Promise<void> }, "close")
        .mockImplementationOnce(() => detached.promise);
      const closing = launched.close();
      await vi.waitFor(() => expect(closingCdp).toHaveBeenCalledOnce());
      expect(f.context.close).not.toHaveBeenCalled();
      detached.resolve();
      await closing;
      expect(f.context.close).toHaveBeenCalledOnce();
    } finally {
      detached.resolve();
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("bounds a hung CDP detach and still joins the owner's close", async () => {
    const f = await nativeCloseFixture();
    const detached = Promise.withResolvers<void>();
    try {
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      vi.spyOn(
        launched.cdp as typeof launched.cdp & { close(): Promise<void> },
        "close",
      ).mockImplementationOnce(() => detached.promise);
      vi.useFakeTimers();
      const stopped = launched.close();
      const settled = vi.fn();
      void stopped.then(settled, settled);
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled, "hung CDP detach prevented wrapper close from settling").toHaveBeenCalled();
      await expect(stopped).rejects.toThrow(/CDP.*detach/);
      expect(f.context.close).toHaveBeenCalledOnce();
      expect(f.browser.close).toHaveBeenCalledOnce();
      await expect(f.launcher.localProfiles.release(f.directory)).resolves.toBe("released");
    } finally {
      detached.resolve();
      vi.useRealTimers();
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("launches the default context with explicit contained arguments and releases only after orderly close", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
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
      child.kill = vi.fn(() => true);
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
      expect((await readdir(sessions)).sort()).toEqual([
        "Current Session",
        "Current Tabs",
        "Last Session",
        "Last Tabs",
        "Session_151",
        "Tabs_151",
        "retained",
      ]);
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
          "--disable-field-trial-config",
          `--disable-extensions-except=${join(directory, ".opensteer-tab-lifecycle-extension")}`,
          `--load-extension=${join(directory, ".opensteer-tab-lifecycle-extension")}`,
          "--disable-component-extensions-with-background-pages",
          "--disable-component-update",
          "--disable-background-networking",
          "--restore-last-session",
          "--headless=new",
          "--proxy-server=http://127.0.0.1:8123",
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ]),
      );
      expect(options.args).not.toContain("--no-startup-window");
      expect(options.args).not.toEqual(expect.arrayContaining(["--password-store=basic"]));
      expect(options.args).not.toEqual(expect.arrayContaining(["--use-mock-keychain"]));
      expect(options.args).not.toContain("--no-sandbox");
      expect(JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8"))).toEqual(
        { session: { restore_on_startup: 1 } },
      );
      expect(context.newPage).toHaveBeenCalledOnce();
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
      vi.useFakeTimers();
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
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      if (process.platform === "win32") expect(ownedProcess.kill).toHaveBeenCalledWith("SIGKILL");
      else expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(released).toBe(false);
      exit();
      await releasing;
      vi.useRealTimers();
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
      vi.useRealTimers();
      kill.mockRestore();
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

  it("exposes Linux rendererUsage tracked by owned native process lifetime and omits it on darwin", async () => {
    const procFiles: Record<string, string> = {
      "/proc/12345/stat": "12345 (chrome) S 1 12345 12345",
      "/proc/12346/stat": "12346 (chrome) S 12345 12345 12345",
      "/proc/12346/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/12346/smaps_rollup": "Rss: 64000 kB\nPss: 32000 kB\n",
      "/proc/12346/status": "Name:\tchrome\nVmRSS:\t64000 kB\nRssAnon:\t40000 kB\n",
    };
    const f = await nativeCloseFixture({
      platform: "linux",
      linuxProcFs: {
        listPids: () => [12345, 12346],
        readText: (filePath) => procFiles[filePath] ?? null,
      },
    });
    const darwinLauncher = new PlaywrightChromiumLauncher({
      executablePath: process.execPath,
      headless: true,
      chromiumSandbox: true,
      platform: "darwin",
    });
    expect(darwinLauncher.rendererUsage).toBeUndefined();
    expect(f.launcher.rendererUsage).toBeTypeOf("function");
    expect(await f.launcher.rendererUsage?.()).toEqual({ processes: 0, bytes: 0 });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      expect(await f.launcher.rendererUsage?.()).toEqual({
        processes: 1,
        bytes: 32000 * 1024,
      });
      f.exit();
      expect(await f.launcher.rendererUsage?.()).toEqual({ processes: 0, bytes: 0 });
    } finally {
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("normalizes unclean Preferences exit_type, writes atomic tab sidecar, and matches duplicate URLs by strip order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "os-sidecar-unit-"));
    try {
      await mkdir(join(directory, "Default"), { recursive: true });
      await writeFile(
        join(directory, "Default", "Preferences"),
        JSON.stringify({
          profile: { exit_type: "Crashed", exited_cleanly: false, name: "Default" },
          other: 42,
        }),
      );
      await initializeNativePreferences(directory);
      expect(JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8"))).toEqual(
        {
          profile: { exit_type: "Normal", exited_cleanly: true, name: "Default" },
          session: { restore_on_startup: 1 },
          other: 42,
        },
      );

      await writeTabRestoreSidecar(directory, [
        {
          index: 1,
          surfaceId: "surface_b",
          url: "https://example.test/doc",
        },
        {
          index: 0,
          surfaceId: "surface_a",
          url: "https://example.test/doc",
        },
      ]);
      const sidecar = await readTabRestoreSidecar(directory);
      expect(sidecar).toEqual([
        {
          index: 0,
          surfaceId: "surface_a",
          url: "https://example.test/doc",
        },
        {
          index: 1,
          surfaceId: "surface_b",
          url: "https://example.test/doc",
        },
      ]);

      const tab = (tabId: number, index: number, url: string) => ({
        tabId,
        windowId: 1,
        index,
        url,
        title: "",
        active: false,
        discarded: true,
        status: "unloaded",
        targetId: `target_${tabId}`,
      });
      const result = matchRestoredTabs(
        [tab(10, 0, "https://example.test/doc"), tab(11, 1, "https://example.test/doc")],
        sidecar,
        {
          savedTabIds: new Set(["surface_a", "surface_b", "surface_missing"]),
        },
      );
      expect(result.matched.get("surface_a")?.tab.tabId).toBe(10);
      expect(result.matched.get("surface_b")?.tab.tabId).toBe(11);
      expect(result.orphans).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries failed launch orphan removal with evidence and refuses launch if an orphan survives (R2)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    let removeCalls = 0;
    let orphanPresent = true;
    const orphanTab = {
      tabId: 77,
      windowId: 1,
      index: 0,
      url: "https://person-secret.test/",
      title: "Secret",
      active: false,
      discarded: false,
      status: "complete",
      targetId: "target-orphan-77",
    };
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
    });
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => (orphanPresent ? [orphanTab] : []));
    const remSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
      .mockImplementation(async (tabId) => {
        removeCalls++;
        if (tabId === 77 && removeCalls >= 2) {
          orphanPresent = false;
          return true;
        }
        return false;
      });
    try {
      // Case 1: removeByTabId fails once, then succeeds on retry -> launch succeeds with 0 orphans!
      const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      expect(removeCalls).toBeGreaterThanOrEqual(2);
      expect(orphanPresent).toBe(false);
      await launched.close();

      // Case 2: orphan keeps refusing removal and Target.closeTarget fails -> launch MUST be refused!
      orphanPresent = true;
      remSpy.mockResolvedValue(false);
      f.cdp.send.mockImplementation(async (method: string) => {
        if (method === "Target.closeTarget") throw new Error("closeTarget failed");
        return {};
      });
      await expect(f.launcher.launch(nativeProfileRequest(f.directory))).rejects.toThrow(
        /could not be removed/i,
      );
    } finally {
      invSpy.mockRestore();
      remSpy.mockRestore();
      f.exit();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("refuses reconcile when an unclaimed tab cannot be confirmed removed and never hands off its late page (R2)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const sidecarUrl = "https://person-private.test/";
    await writeTabRestoreSidecar(f.directory, [
      {
        index: 0,
        surfaceId: "surface_00000000-0000-4000-8000-00000000r201",
        url: sidecarUrl,
      },
    ]);
    const restoredTab = {
      tabId: 88,
      windowId: 1,
      index: 0,
      url: sidecarUrl,
      title: "Private",
      active: false,
      discarded: false,
      status: "complete",
      targetId: "target-restored-88",
    };
    const pageHandlers: Array<(page: Page) => void> = [];
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
    });
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockResolvedValue([restoredTab]);
    const remSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
      .mockResolvedValue(false);
    f.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Target.closeTarget") throw new Error("closeTarget failed");
      return {};
    });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      // Reconcile with empty saved set (e.g. agent session first) MUST fail closed!
      await expect(launched.context.sessionRestore!.reconcile(new Set())).rejects.toThrow(
        /could not be removed/i,
      );
      // Even if a late Playwright page event arrives for target-restored-88, handOff MUST NEVER see it!
      const handedOff: unknown[] = [];
      launched.context.handOff((page) => handedOff.push(page));
      const closeLate = vi.fn().mockResolvedValue(undefined);
      const latePage = {
        url: () => sidecarUrl,
        isClosed: () => false,
        close: closeLate,
        on: vi.fn(),
        once: vi.fn(),
        _connection: {
          toImpl: () => ({ delegate: { _targetId: "target-restored-88" } }),
        },
      } as unknown as Page;
      for (const handler of pageHandlers) handler(latePage);
      await vi.waitFor(() => expect(closeLate).toHaveBeenCalled());
      expect(handedOff).toHaveLength(0);
    } finally {
      invSpy.mockRestore();
      remSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("serializes reconcile behind an in-flight fallback reconcile so callers never pass while removals run (R5)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const sidecarUrl = "https://stale-tab.test/";
    await writeTabRestoreSidecar(f.directory, [
      {
        index: 0,
        surfaceId: "surface_00000000-0000-4000-8000-00000000r501",
        url: sidecarUrl,
      },
    ]);
    let tabPresent = true;
    const restoredTab = {
      tabId: 91,
      windowId: 1,
      index: 0,
      url: sidecarUrl,
      title: "Stale",
      active: false,
      discarded: true,
      status: "unloaded",
      targetId: "target-r5-91",
    };
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
    });
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => (tabPresent ? [restoredTab] : []));
    let releaseRemoval: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      vi.spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId").mockImplementation(
        async () => {
          resolve();
          await new Promise<void>((done) => {
            releaseRemoval = done;
          });
          tabPresent = false;
          return true;
        },
      );
    });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      // Fallback timer triggers a reconcile first.
      launched.context.sessionRestore!.armFallbackReconcile!(new Set(), 10);
      await removalStarted;

      // Now Home's session.saved arrives while the fallback removal is STILL in flight.
      let secondResolved = false;
      const second = launched.context.sessionRestore!.reconcile(new Set()).then(() => {
        secondResolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      // Once the in-flight removal finishes, the second reconcile resolves cleanly.
      releaseRemoval!();
      await second;
      expect(secondResolved).toBe(true);
      expect(tabPresent).toBe(false);
    } finally {
      await launched?.context.sessionRestore?.flush?.().catch(() => undefined);
      invSpy.mockRestore();
      vi.restoreAllMocks();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("retries failed releaseRestore in the background until confirmed removed (R6) and retains unknown-outcome discards (R7)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const makeRawPage = () => {
      let closed = false;
      return {
        markClosed: () => {
          closed = true;
        },
        page: {
          url: () => "https://sleeping.test/page",
          isClosed: () => closed,
          close: vi.fn(async () => {
            closed = true;
          }),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
          frames: () => [],
          mainFrame: () => ({}),
          _connection: {
            toImpl: () => ({ delegate: { _targetId: "target-sleep-1" } }),
          },
        } as unknown as Page,
      };
    };
    const raw1 = makeRawPage();
    const raw2 = makeRawPage();
    const helperPage = {
      url: () => "about:blank",
      isClosed: () => false,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      _connection: { toImpl: () => ({ delegate: { _targetId: "target-helper" } }) },
    } as unknown as Page;
    let newPageCalls = 0;
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
      newPage: vi.fn(async () => {
        newPageCalls++;
        if (newPageCalls === 1) return helperPage;
        return newPageCalls === 2 ? raw1.page : raw2.page;
      }),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-sleep-1" } } : {},
        ),
        on: vi.fn(),
        off: vi.fn(),
        detach: vi.fn().mockResolvedValue(undefined),
      })),
    });

    // Scenario A (R6): discard succeeds -> first releaseRestore fails -> returns false -> background retry confirms gone.
    let tabs: Array<{
      tabId: number;
      windowId: number;
      index: number;
      url: string;
      title: string;
      active: boolean;
      discarded: boolean;
      status: string;
      targetId: string | null;
    }> = [];
    let removeAttempts = 0;
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => [...tabs]);
    const discSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabId")
      .mockImplementation(async () => {
        raw1.markClosed();
        tabs = [{ ...tabs[0]!, tabId: 202, discarded: true, status: "unloaded", targetId: null }];
        return 202;
      });
    const remSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
      .mockImplementation(async (tabId) => {
        removeAttempts++;
        // Fail the first 2 attempts (initial releaseRestore call), succeed on background retry!
        if (tabId === 202 && removeAttempts >= 3) {
          tabs = [];
          return true;
        }
        return false;
      });

    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      tabs = [
        {
          tabId: 101,
          windowId: 1,
          index: 0,
          url: "https://sleeping.test/page",
          title: "Sleep",
          active: false,
          discarded: false,
          status: "complete",
          targetId: "target-sleep-1",
        },
      ];
      const page = await launched.context.createPage();
      const token = await page.captureRestore!();
      await page.close({ reason: "slept" });

      // First releaseRestore fails and returns false so Stop/Disconnect stays "still closing".
      expect(await launched.context.releaseRestore!(token)).toBe(false);
      expect(tabs).toHaveLength(1);

      // Background retry loop keeps trying and confirms the tab gone!
      await vi.waitFor(
        () => {
          expect(tabs).toHaveLength(0);
          expect(removeAttempts).toBeGreaterThanOrEqual(3);
        },
        { timeout: 3_000, interval: 25 },
      );

      // Scenario B (R7): discardByTabId throws AND follow-up inventory fails while page closes ->
      // unknown-outcome token is retained, and subsequent releaseRestore locates and removes it!
      tabs = [
        {
          tabId: 303,
          windowId: 1,
          index: 1,
          url: "https://sleeping.test/page",
          title: "Unknown",
          active: false,
          discarded: false,
          status: "complete",
          targetId: "target-sleep-1",
        },
      ];
      let invCallCount = 0;
      invSpy.mockImplementation(async () => {
        invCallCount++;
        // Call 1: pre-discard inventory succeeds; Call 2: immediate post-throw inventory FAILS!
        if (invCallCount === 2) throw new Error("Helper worker temporarily dead");
        return [...tabs];
      });
      discSpy.mockImplementationOnce(async () => {
        // Chromium committed the discard (closing the page and creating discarded tab 404) before helper threw!
        raw2.markClosed();
        tabs = [{ ...tabs[0]!, tabId: 404, discarded: true, status: "unloaded", targetId: null }];
        throw new Error("Helper call timed out");
      });
      remSpy.mockImplementation(async (tabId) => {
        if (tabId === 404) {
          tabs = [];
          return true;
        }
        return false;
      });

      const page2 = await launched.context.createPage();
      const token2 = await page2.captureRestore!();
      await page2.close({ reason: "slept" });
      expect(tabs.map((t) => t.tabId)).toEqual([404]);

      // releaseRestore MUST NOT have dropped token2: it re-queries inventory, finds 404, and removes it!
      expect(await launched.context.releaseRestore!(token2)).toBe(true);
      expect(tabs).toHaveLength(0);
    } finally {
      await launched?.context.sessionRestore?.flush?.().catch(() => undefined);
      invSpy.mockRestore();
      discSpy.mockRestore();
      remSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("matches woken tabs strictly by targetId without stealing unrelated pages and clears closed tab URLs from sidecar (R9)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const pageHandlers: Array<(page: Page) => void> = [];
    const closeListeners = new Map<string, Array<() => void>>();
    const makePage = (id: string, url: string) => {
      let closed = false;
      closeListeners.set(id, []);
      return {
        emitClose: () => {
          closed = true;
          for (const fn of closeListeners.get(id) ?? []) fn();
        },
        page: {
          url: () => url,
          isClosed: () => closed,
          close: vi.fn(async () => {
            closed = true;
            for (const fn of closeListeners.get(id) ?? []) fn();
          }),
          on: vi.fn((event: string, fn: () => void) => {
            if (event === "close") closeListeners.get(id)!.push(fn);
          }),
          once: vi.fn((event: string, fn: () => void) => {
            if (event === "close") closeListeners.get(id)!.push(fn);
          }),
          off: vi.fn(),
          frames: () => [],
          mainFrame: () => ({}),
          _connection: {
            toImpl: () => ({ delegate: { _targetId: id } }),
          },
        } as unknown as Page,
      };
    };
    const helper = makePage("target-helper", "about:blank");
    const unrelated = makePage("target-unrelated", "https://unrelated.test/");
    const realWoken = makePage("target-woken-55", "https://woken.test/");
    let tabs: Array<{
      tabId: number;
      windowId: number;
      index: number;
      url: string;
      title: string;
      active: boolean;
      discarded: boolean;
      status: string;
      targetId: string | null;
    }> = [];
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
      newPage: vi.fn(async () => helper.page),
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
    });
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => [...tabs]);
    const actSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "activateByTabId")
      .mockImplementation(async (tabId) => {
        // First emit an unrelated concurrent page (must NOT be stolen by activeWake!),
        // then populate targetId for tabId 55 and emit the actual woken page!
        tabs = [
          {
            tabId,
            windowId: 1,
            index: 0,
            url: "https://woken.test/",
            title: "Woken",
            active: true,
            discarded: false,
            status: "complete",
            targetId: "target-woken-55",
          },
          {
            tabId: 56,
            windowId: 1,
            index: 1,
            url: "https://unrelated.test/",
            title: "Unrelated",
            active: false,
            discarded: false,
            status: "complete",
            targetId: "target-unrelated",
          },
        ];
        queueMicrotask(() => {
          for (const h of pageHandlers) h(unrelated.page);
          setTimeout(() => {
            for (const h of pageHandlers) h(realWoken.page);
          }, 15);
        });
        return true;
      });

    // Seed sidecar so tab 55 is matched with targetId === null (unloaded at launch).
    await writeTabRestoreSidecar(f.directory, [
      {
        index: 0,
        surfaceId: "surface_00000000-0000-4000-8000-00000000r901",
        url: "https://woken.test/",
      },
    ]);
    tabs = [
      {
        tabId: 55,
        windowId: 1,
        index: 0,
        url: "https://woken.test/",
        title: "Woken",
        active: false,
        discarded: true,
        status: "unloaded",
        targetId: null,
      },
    ];

    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const handedOff: string[] = [];
      launched.context.handOff((p) => handedOff.push(p.url()));

      const claimed = await launched.context.sessionRestore!.claim(
        "surface_00000000-0000-4000-8000-00000000r901" as never,
        "https://woken.test/",
        undefined,
      );
      expect(claimed?.url()).toBe("https://woken.test/");
      await vi.waitFor(() => expect(handedOff).toContain("https://unrelated.test/"));

      // Close the claimed tab -> its URL must leave opensteer-tabs.json immediately!
      tabs = tabs.filter((t) => t.tabId !== 55);
      realWoken.emitClose();
      await launched.context.sessionRestore!.flush!();
      const sidecarAfterClose = await readTabRestoreSidecar(f.directory);
      expect(sidecarAfterClose.some((e) => e.url === "https://woken.test/")).toBe(false);
    } finally {
      await launched?.context.sessionRestore?.flush?.().catch(() => undefined);
      invSpy.mockRestore();
      actSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("leaves never-loaded parked tabs untouched on reconcile and auto-discards them if Chromium loads them later (R1)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const { writeTabRestoreSidecar } = await import("./native-profile-storage.js");
    const pageHandlers: Array<(page: Page) => void> = [];
    const makePage = (id: string, url: string) => {
      let closed = false;
      return {
        markClosed: () => {
          closed = true;
        },
        page: {
          url: () => url,
          isClosed: () => closed,
          close: vi.fn(async () => {
            closed = true;
          }),
          waitForLoadState: vi.fn(async () => undefined),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
          frames: () => [],
          mainFrame: () => ({}),
          _connection: {
            toImpl: () => ({ delegate: { _targetId: id } }),
          },
        } as unknown as Page,
      };
    };
    const helper = makePage("target-helper", "about:blank");
    const loadedParked = makePage("target-loaded", "https://loaded.test/");
    const lateBgPage = makePage("target-unloaded", "https://unloaded.test/");

    const surfLoaded = "srf_00000000-0000-4000-8000-00000000a101" as BrowserSurfaceId;
    const surfUnloaded = "srf_00000000-0000-4000-8000-00000000a102" as BrowserSurfaceId;
    await writeTabRestoreSidecar(f.directory, [
      { index: 0, surfaceId: surfLoaded, url: "https://loaded.test/" },
      { index: 1, surfaceId: surfUnloaded, url: "https://unloaded.test/" },
    ]);

    let tabs: Array<{
      tabId: number;
      windowId: number;
      index: number;
      url: string;
      title: string;
      active: boolean;
      discarded: boolean;
      status: string;
      targetId: string | null;
    }> = [
      {
        tabId: 10,
        windowId: 1,
        index: 0,
        url: "https://loaded.test/",
        title: "Loaded",
        active: false,
        discarded: false,
        status: "complete",
        targetId: "target-loaded",
      },
      {
        tabId: 11,
        windowId: 1,
        index: 1,
        url: "https://unloaded.test/",
        title: "Unloaded",
        active: false,
        discarded: false,
        status: "unloaded",
        targetId: "target-unloaded",
      },
    ];
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [loadedParked.page],
      newPage: vi.fn(async () => helper.page),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({})),
        detach: vi.fn(async () => undefined),
      })),
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
    });

    const discardedIds: number[] = [];
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => [...tabs]);
    const discSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabIdDetailed")
      .mockImplementation(async (tabId) => {
        discardedIds.push(tabId);
        const nextId = tabId + 100;
        const nextTargetId = `target-discarded-${nextId}`;
        tabs = tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                tabId: nextId,
                discarded: true,
                status: "unloaded",
                targetId: nextTargetId,
              }
            : t,
        );
        if (tabId === 10) loadedParked.markClosed();
        if (tabId === 11) lateBgPage.markClosed();
        return { newTabId: nextId, newTargetId: nextTargetId };
      });
    const actSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "activateByTabId")
      .mockImplementation(async (tabId) => {
        const entry = tabs.find((t) => t.tabId === tabId);
        const targetId = entry?.targetId ?? "target-woke-later";
        tabs = tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                active: true,
                discarded: false,
                status: "complete",
                targetId,
              }
            : t,
        );
        const woken = makePage(targetId, "https://unloaded.test/");
        for (const handler of pageHandlers) handler(woken.page);
        return true;
      });

    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const handedOff: string[] = [];
      launched.context.handOff((p) => handedOff.push(p.url()));

      // Reconcile keeps both saved tabs: ONLY tab 10 (complete) is discarded; tab 11 (unloaded) is untouched!
      await launched.context.sessionRestore!.reconcile(new Set([surfLoaded, surfUnloaded]));
      expect(discardedIds).toEqual([10]);
      expect(tabs.find((t) => t.tabId === 11)).toMatchObject({
        discarded: false,
        status: "unloaded",
      });

      // Later, Chromium's background loader brings tab 11 alive without any session claiming it.
      tabs = tabs.map((t) => (t.tabId === 11 ? { ...t, status: "complete" } : t));
      for (const handler of pageHandlers) handler(lateBgPage.page);

      // Launcher hides it from handOff and automatically discards tab 11 -> 111!
      await vi.waitFor(
        () => {
          expect(discardedIds).toEqual([10, 11]);
          expect(tabs.find((t) => t.tabId === 111)).toMatchObject({
            discarded: true,
            status: "unloaded",
          });
        },
        { timeout: 3_000, interval: 25 },
      );
      expect(handedOff).toEqual([]);

      // Even if Chromium reloads the already-discarded tab (111) with its new targetId,
      // the launcher still hides it from handOff and re-discards 111 -> 211!
      tabs = tabs.map((t) =>
        t.tabId === 111 ? { ...t, discarded: false, status: "complete" } : t,
      );
      const secondBgPage = makePage("target-discarded-111", "https://unloaded.test/");
      for (const handler of pageHandlers) handler(secondBgPage.page);
      await vi.waitFor(
        () => {
          expect(discardedIds).toEqual([10, 11, 111]);
          expect(tabs.find((t) => t.tabId === 211)).toMatchObject({
            discarded: true,
            status: "unloaded",
          });
        },
        { timeout: 3_000, interval: 25 },
      );
      expect(handedOff).toEqual([]);

      // Later, a session claims surfUnloaded -> wakes auto-discarded tab 211 cleanly!
      const claimed = await launched.context.sessionRestore!.claim(
        surfUnloaded,
        "https://unloaded.test/",
        undefined,
        "lin-1",
      );
      expect(claimed?.url()).toBe("https://unloaded.test/");
      expect(actSpy).toHaveBeenCalledWith(211);
    } finally {
      await launched?.context.sessionRestore?.flush?.().catch(() => undefined);
      invSpy.mockRestore();
      discSpy.mockRestore();
      actSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

async function nativeCloseFixture(
  options: Pick<
    ConstructorParameters<typeof PlaywrightChromiumLauncher>[0],
    "linuxProcFs" | "platform" | "preserveLoopbackBypass" | "proxyUrl"
  > = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "native-close-"));
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345 });
  child.kill = vi.fn(() => true);
  vi.spyOn(process, "kill").mockImplementation(() => true);
  const exit = () => {
    Object.defineProperty(child, "exitCode", { value: 0 });
    child.emit("exit", 0, null);
  };
  const cdp = {
    send: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
    detach: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const browser = {
    newBrowserCDPSession: vi.fn().mockResolvedValue(cdp),
    close: vi.fn(async () => exit()),
  };
  const context = {
    process: () => child,
    browser: () => browser,
    pages: (): Page[] => [],
    newCDPSession: vi.fn<(frame: Frame | Page) => Promise<unknown>>(),
    newPage: vi.fn().mockResolvedValue({ on: vi.fn(), isClosed: () => false }),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(
    context as unknown as BrowserContext,
  );
  const launcher = new PlaywrightChromiumLauncher({
    executablePath: process.execPath,
    headless: true,
    chromiumSandbox: true,
    ...options,
  });
  return { directory, launcher, context, browser, cdp, exit };
}
