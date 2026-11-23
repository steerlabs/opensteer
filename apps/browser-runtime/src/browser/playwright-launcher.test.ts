import { browserPagePolicyScript } from "@opensteer/browser-runtime-core/page-policy";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import type { BrowserPage } from "@opensteer/browser-runtime-core";
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
import { assertImportedCookies } from "./native-profile-storage.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import { ChromiumTabLifecycleBridge, type ChromiumTabEntry } from "./tab-lifecycle-extension.js";
import {
  chromiumLinkOpenDisposition,
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
      const handle = await ownPage(launched, f.context, page);
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
      const handle = await ownPage(launched, f.context, page);
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
    // The opener is the runtime's own new page; its popup is published by its opener (K3).
    await ownPage(launched, f.context, opener);
    Object.assign(popup, { _opener: opener });
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
    await ownPage(launched, f.context, closing);
    await ownPage(launched, f.context, sibling);
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
    const handle = await ownPage(launched, f.context, page);
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
    const handle = await ownPage(launched, f.context, page);
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
        const handle = await ownPage(launched, f.context, page);
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
      expect(await (await ownPage(launched, f.context, page)).keepAwake?.()).toBe("media");
      // The protections' read (V1) meets the destroyed context and reads the new document again;
      // then the media read.
      expect(main.evaluate).toHaveBeenCalledTimes(3);
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
      // L1: Chromium's session records go before launch; nothing else in the profile is touched.
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
          "--disable-field-trial-config",
          `--disable-extensions-except=${join(directory, ".opensteer-tab-lifecycle-extension")}`,
          `--load-extension=${join(directory, ".opensteer-tab-lifecycle-extension")}`,
          "--disable-component-extensions-with-background-pages",
          "--disable-component-update",
          "--disable-background-networking",
          "--no-startup-window",
          "--restore-last-session",
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

  it("finds a sleeping tab again by its name whatever Chromium did to its id, retries a failed release in the background (R6), and removes a tab whose discard outcome is unknown (R7, L2)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const makeRawPage = (targetId: string) => {
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
          _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) },
        } as unknown as Page,
      };
    };
    const raw1 = makeRawPage("target-sleep-1");
    const raw2 = makeRawPage("target-sleep-2");
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
      newPage: vi.fn(async () =>
        ++newPageCalls === 1 ? helperPage : [raw1, raw2][newPageCalls - 2]!.page,
      ),
      newCDPSession: vi.fn(async (page: Page) => ({
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo"
            ? { targetInfo: { targetId: page === raw1.page ? "target-sleep-1" : "target-sleep-2" } }
            : {},
        ),
        on: vi.fn(),
        off: vi.fn(),
        detach: vi.fn().mockResolvedValue(undefined),
      })),
    });
    const row = (tabId: number, targetId: string): ChromiumTabEntry => ({
      tabId,
      windowId: 1,
      index: 0,
      url: "https://sleeping.test/page",
      title: "Sleep",
      active: false,
      discarded: false,
      status: "complete",
      targetId,
    });
    let tabs: ChromiumTabEntry[] = [];
    let failInventory = 0;
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => {
        if (failInventory > 0) {
          failInventory--;
          throw new Error("Helper worker temporarily dead");
        }
        return [...tabs];
      });
    const nameSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "nameTab")
      .mockImplementation(async (tabId, name) => {
        tabs = tabs.map((t) => (t.tabId === tabId ? { ...t, identity: name } : t));
        return true;
      });
    // A replacing discard: the page closes and the tab comes back under a new id with the same
    // target, as on real Chromium; the helper names it afterwards (L2).
    const replace = (from: number, to: number, page: { markClosed(): void }) => {
      page.markClosed();
      tabs = tabs.map((t) =>
        t.tabId === from ? { ...t, tabId: to, discarded: true, status: "unloaded" } : t,
      );
    };
    const discSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabId")
      .mockImplementationOnce(async () => {
        replace(101, 202, raw1);
        return 202;
      });
    let removeAttempts = 0;
    const remSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
      .mockImplementation(async (tabId) => {
        removeAttempts++;
        // The first release's attempts fail; the background retry succeeds.
        if (tabId === 202 && removeAttempts >= 4) {
          tabs = tabs.filter((t) => t.tabId !== tabId);
          return true;
        }
        return false;
      });

    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      // Scenario A (R6): the discard succeeds and the first release cannot remove the tab.
      tabs = [row(101, "target-sleep-1")];
      const page = await launched.context.createPage();
      const token = await page.captureRestore!();
      await page.close({ reason: "slept" });
      expect(tabs).toMatchObject([{ tabId: 202, discarded: true }]);
      expect(tabs[0]!.identity).toMatch(/^opensteer-sleep:/);
      expect(await launched.context.releaseRestore!(token)).toBe(false);
      expect(tabs).toHaveLength(1);
      await vi.waitFor(() => expect(tabs).toHaveLength(0), { timeout: 3_000, interval: 25 });

      // Scenario B (R7): the discard commits (replacing 303 with 404) and then the helper throws,
      // and the inventory right after cannot be read. The tab is not asleep under its name, so it
      // is removed with evidence and wakes by address (L2); its release then has nothing to do.
      tabs = [row(303, "target-sleep-2")];
      discSpy.mockImplementationOnce(async () => {
        replace(303, 404, raw2);
        failInventory = 1;
        throw new Error("Helper call timed out");
      });
      remSpy.mockImplementation(async (tabId) => {
        const before = tabs.length;
        tabs = tabs.filter((t) => t.tabId !== tabId);
        return tabs.length < before;
      });
      const page2 = await launched.context.createPage();
      const token2 = await page2.captureRestore!();
      await page2.close({ reason: "slept" });
      tabs = tabs.map((t) => (t.tabId === 404 ? { ...t, tabId: 505 } : t));
      expect(await launched.context.releaseRestore!(token2)).toBe(true);
      expect(tabs).toHaveLength(0);
    } finally {
      invSpy.mockRestore();
      nameSpy.mockRestore();
      discSpy.mockRestore();
      remSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("finds an unknown-outcome sleeping tab by its own name only and never removes another owner's same-address discarded tab (F2)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const sharedUrl = "https://shared-f2.test/page";
    let closed1 = false;
    const helperPage = {
      url: () => "about:blank",
      isClosed: () => false,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      _connection: { toImpl: () => ({ delegate: { _targetId: "target-f2-helper" } }) },
    } as unknown as Page;
    const rawPage1 = {
      url: () => sharedUrl,
      isClosed: () => closed1,
      close: vi.fn(async () => {
        closed1 = true;
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      frames: () => [],
      mainFrame: () => ({}),
      _connection: { toImpl: () => ({ delegate: { _targetId: "target-f2-s1" } }) },
    } as unknown as Page;
    let newPageCalls = 0;
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
      newPage: vi.fn(async () => (++newPageCalls === 1 ? helperPage : rawPage1)),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-f2-s1" } } : {},
        ),
        on: vi.fn(),
        off: vi.fn(),
        detach: vi.fn(async () => undefined),
      })),
    });

    // Tab 501 belongs to session S1; tab 999 belongs to another owner (e.g. a parked tab or S2)
    // that gets discarded at the same URL while S1's discard throws and S1's tab 501 vanishes.
    let tabs: ChromiumTabEntry[] = [];
    const nameSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "nameTab")
      .mockImplementation(async (tabId, name) => {
        tabs = tabs.map((t) => (t.tabId === tabId ? { ...t, identity: name } : t));
        return true;
      });
    let invCalls = 0;
    const invSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
      .mockImplementation(async () => {
        invCalls++;
        // Call 1: launch inventory (empty); Call 2: pre-discard inventory (tab 501 live);
        // Call 3: post-throw inventory fails so token enters "unknown" state;
        // Call 4+: inventory shows ONLY other owner's newly discarded tab 999 at sharedUrl!
        if (invCalls === 3) throw new Error("transient helper outage");
        return [...tabs];
      });
    const discSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabId")
      .mockImplementationOnce(async () => {
        closed1 = true;
        tabs = [
          {
            tabId: 999,
            windowId: 1,
            index: 0,
            url: sharedUrl,
            title: "Other Owner",
            active: false,
            discarded: true,
            status: "unloaded",
            targetId: "target-f2-other",
            identity: "srf_00000000-0000-4000-8000-00000000f299",
          },
        ];
        throw new Error("discard failed");
      });
    const removedIds: number[] = [];
    const remSpy = vi
      .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
      .mockImplementation(async (tabId) => {
        removedIds.push(tabId);
        tabs = tabs.filter((t) => t.tabId !== tabId);
        return true;
      });

    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      tabs = [
        {
          tabId: 501,
          windowId: 1,
          index: 0,
          url: sharedUrl,
          title: "S1",
          active: false,
          discarded: false,
          status: "complete",
          targetId: "target-f2-s1",
        },
      ];
      const page1 = await launched.context.createPage();
      const token1 = await page1.captureRestore!();
      await page1.close({ reason: "slept" });

      // Release token1 -> MUST NOT match or remove tab 999 (other owner's tab at same URL)!
      await launched.context.releaseRestore!(token1);
      expect(removedIds).not.toContain(999);
      expect(tabs.some((t) => t.tabId === 999)).toBe(true);
    } finally {
      invSpy.mockRestore();
      nameSpy.mockRestore();
      discSpy.mockRestore();
      remSpy.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("bounds background removal retries of a sleeping tab, reports it as not removed, and keeps its page from ever being handed off (H)", async () => {
    const f = await nativeCloseFixture();
    const { ChromiumTabLifecycleBridge } = await import("./tab-lifecycle-extension.js");
    const pageHandlers: Array<(page: Page) => void> = [];
    const fake = (targetId: string, url: string) => {
      let closed = false;
      return {
        url: () => url,
        isClosed: () => closed,
        close: vi.fn(async () => {
          closed = true;
        }),
        markClosed: () => {
          closed = true;
        },
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        frames: () => [],
        mainFrame: () => ({}),
        _opener: null,
        _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) },
      };
    };
    const helper = fake("target-h-helper", "about:blank");
    const sleeper = fake("target-h", "https://stuck.test/");
    const late = fake("target-h", "https://stuck.test/");
    let newPages = 0;
    Object.assign(f.context, {
      serviceWorkers: () => [],
      pages: () => [],
      newPage: vi.fn(async () => (++newPages === 1 ? helper : sleeper)),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-h" } } : {},
        ),
        on: vi.fn(),
        off: vi.fn(),
        detach: vi.fn(async () => undefined),
      })),
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
    });
    let tabs: ChromiumTabEntry[] = [
      {
        tabId: 801,
        windowId: 1,
        index: 0,
        url: "https://stuck.test/",
        title: "Stuck",
        active: false,
        discarded: false,
        status: "complete",
        targetId: "target-h",
      },
    ];
    const spies = [
      vi
        .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
        .mockImplementation(async () => [...tabs]),
      // Chromium discards the tab (a new id, the same target), then the helper names it.
      vi
        .spyOn(ChromiumTabLifecycleBridge.prototype, "discardByTabId")
        .mockImplementation(async () => {
          sleeper.markClosed();
          tabs = tabs.map((t) => ({ ...t, tabId: 802, discarded: true, status: "unloaded" }));
          return 802;
        }),
      vi
        .spyOn(ChromiumTabLifecycleBridge.prototype, "nameTab")
        .mockImplementation(async (tabId, name) => {
          tabs = tabs.map((t) => (t.tabId === tabId ? { ...t, identity: name } : t));
          return true;
        }),
    ];
    // Removal never takes: the tab stays listed whatever is asked.
    let removeCalls = 0;
    spies.push(
      vi
        .spyOn(ChromiumTabLifecycleBridge.prototype, "removeByTabId")
        .mockImplementation(async () => {
          removeCalls++;
          return false;
        }),
    );
    f.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Target.closeTarget") throw new Error("close refused");
      return {};
    });
    const diagnostic = vi.spyOn(process.stderr, "write");
    const unconfirmed = () =>
      diagnostic.mock.calls.filter(([line]) =>
        String(line).includes('"event":"browser-runtime.tab-removal-unconfirmed"'),
      );
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const handedOff: string[] = [];
      launched.context.handOff((p) => handedOff.push(p.url()));
      const page = await launched.context.createPage();
      const token = await page.captureRestore!();
      await page.close({ reason: "slept" });
      expect(tabs).toMatchObject([{ tabId: 802, discarded: true }]);
      expect(tabs[0]!.identity).toMatch(/^opensteer-sleep:/);
      handedOff.length = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const releasing = launched.context.releaseRestore!(token);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await releasing).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unconfirmed()).toHaveLength(1);
      const callsAtBound = removeCalls;
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      // Not retried silently forever.
      expect(removeCalls).toBe(callsAtBound);
      // Still guarded: a page the tab loads later is closed and never handed off.
      tabs = tabs.map((t) => ({ ...t, discarded: false, status: "complete" }));
      for (const handler of pageHandlers) handler(late as unknown as Page);
      await vi.waitFor(() => expect(late.close).toHaveBeenCalled(), { timeout: 3_000 });
      expect(handedOff).toEqual([]);
    } finally {
      vi.useRealTimers();
      for (const spy of spies) spy.mockRestore();
      diagnostic.mockRestore();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("hands off a popup whose opener is gone as the base does, bounds closeTarget and bringToFront, and takes no closeTarget answer of success: false as a close (F4, M1)", async () => {
    const f = await nativeCloseFixture();
    const pageHandlers: Array<(page: Page) => void> = [];
    Object.assign(f.context, {
      newPage: vi.fn(async () => ({
        on: vi.fn(),
        isClosed: () => false,
        bringToFront: () => new Promise(() => {}),
      })),
      on: vi.fn((event: string, listener: (page: Page) => void) => {
        if (event === "page") pageHandlers.push(listener);
      }),
    });
    f.cdp.send.mockImplementation(async (method: string) => {
      if (method === "Target.closeTarget") return await new Promise(() => {});
      return {};
    });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const handedOff: string[] = [];
      launched.context.handOff((p) => handedOff.push(p.url()));
      const hiddenOpener = Object.assign(new EventEmitter(), {
        url: () => "https://gone-opener.test/",
        isClosed: () => true,
      }) as unknown as Page;
      const popup = {
        url: () => "https://popup-f4.test/",
        isClosed: () => false,
        close: vi.fn(async () => undefined),
        on: vi.fn(),
        once: vi.fn(),
        _opener: hiddenOpener,
        _connection: { toImpl: () => ({ delegate: { _targetId: "target-f4-popup" } }) },
      } as unknown as Page;
      for (const handler of pageHandlers) handler(popup);
      await vi.waitFor(() => expect(handedOff).toEqual(["https://popup-f4.test/"]), {
        timeout: 2_000,
      });
      expect(popup.close).not.toHaveBeenCalled();
      const handle = (
        launched as unknown as {
          contextHandle: {
            closeTarget?: (id: string) => Promise<void>;
            activatePrivateAnchor(): Promise<void>;
          };
        }
      ).contextHandle;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const closeRejected = expect(handle.closeTarget!("target-hung")).rejects.toThrow(
        /timed out/i,
      );
      const anchorDone = handle.activatePrivateAnchor();
      await vi.advanceTimersByTimeAsync(2_100);
      vi.useRealTimers();
      await closeRejected;
      await anchorDone;
      // A resolved answer that says it did not close is no evidence of a close.
      f.cdp.send.mockImplementation(async (method: string) =>
        method === "Target.closeTarget" ? { success: false } : {},
      );
      await expect(handle.closeTarget!("target-refused")).rejects.toThrow(/did not close/);
    } finally {
      vi.useRealTimers();
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("classifies Chromium OpenURLFromTab link-open gestures across platforms", () => {
    // Bitmask: alt=1, control=2, meta=4, shift=8
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 4 },
        "darwin",
      ),
    ).toBe("background-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 2 },
        "darwin",
      ),
    ).toBeNull();
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 2 },
        "linux",
      ),
    ).toBe("background-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 4 | 8 },
        "darwin",
      ),
    ).toBe("foreground-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "middle", modifiers: 0 },
        "linux",
      ),
    ).toBe("background-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "middle", modifiers: 8 },
        "win32",
      ),
    ).toBe("foreground-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 8 },
        "darwin",
      ),
    ).toBe("new-window");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 1 },
        "darwin",
      ),
    ).toBeNull();
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", modifiers: 1 | 4 },
        "darwin",
      ),
    ).toBe("background-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Enter", modifiers: 4 },
        "darwin",
      ),
    ).toBe("background-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchKeyEvent",
        { type: "rawKeyDown", key: "Enter", modifiers: 2 | 8 },
        "linux",
      ),
    ).toBe("foreground-tab");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Enter", modifiers: 8 },
        "linux",
      ),
    ).toBe("new-window");
    expect(
      chromiumLinkOpenDisposition(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Enter", modifiers: 0 },
        "darwin",
      ),
    ).toBeNull();
  });

  it("attributes OpenURLFromTab pages to the clicking opener and leaves explicit createPage unattributed", async () => {
    const f = await nativeCloseFixture();
    const contextEvents = new EventEmitter();
    const createMockPage = (url: string) => {
      const events = new EventEmitter();
      return Object.assign(events, {
        url: () => url,
        opener: async () => null,
        isClosed: () => false,
        close: vi.fn(async () => undefined),
      });
    };
    const pages: Page[] = [];
    f.context.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      contextEvents.on(event, listener);
    });
    f.context.pages = () => pages;
    const cdpSession = Object.assign(new EventEmitter(), {
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { canAccessOpener: false } } : {},
      ),
      detach: vi.fn().mockResolvedValue(undefined),
    });
    f.context.newCDPSession.mockResolvedValue(cdpSession);
    f.context.newPage.mockImplementation(async () => {
      const created = createMockPage("about:blank");
      pages.push(created as unknown as Page);
      contextEvents.emit("page", created);
      return created;
    });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const rootHandle = await launched.context.createPage();
      await Promise.resolve();
      const handOffs: Array<{ page: unknown; opener: unknown; background: boolean | undefined }> =
        [];
      const announced: unknown[] = [];
      launched.context.handOff!((page, opener) => {
        if (page !== rootHandle)
          handOffs.push({ page, opener, background: page.openedInBackground });
      });
      launched.context.onPage((page) => announced.push(page));

      const platformCdp = await rootHandle.cdp();
      const primaryBit = process.platform === "darwin" ? 4 : 2;
      await platformCdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        modifiers: primaryBit,
      });
      await platformCdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        modifiers: primaryBit,
      });

      // An explicit createPage() while a pending gesture exists must NOT steal attribution.
      const explicitHandle = await launched.context.createPage();
      await vi.waitFor(() => expect(handOffs).toHaveLength(1));
      expect(handOffs[0]).toEqual({ page: explicitHandle, opener: null, background: false });

      // Now the OpenURLFromTab page arrives with its target URL and no page.on("popup").
      const openedPage = createMockPage("https://example.test/tab");
      pages.push(openedPage as unknown as Page);
      contextEvents.emit("page", openedPage);
      await Promise.resolve();

      expect(handOffs[1]).toMatchObject({ opener: rootHandle, background: true });
      expect(await (handOffs[1]!.page as { opener: () => Promise<unknown> }).opener()).toBe(
        rootHandle,
      );
      expect(
        await (handOffs[1]!.page as { hasOpenerAccess: () => Promise<boolean> }).hasOpenerAccess(),
      ).toBe(false);
      expect(announced.at(-1)).toBe(handOffs[1]!.page);
    } finally {
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("never assigns cross-session ownership from unconfirmed gestures and resolves explicit createPage by identity", async () => {
    const { PageOwnership } = await import("@opensteer/browser-runtime-core");
    const f = await nativeCloseFixture();
    const contextEvents = new EventEmitter();
    const createMockPage = (url: string) => {
      const events = new EventEmitter();
      return Object.assign(events, {
        url: () => url,
        opener: async () => null,
        isClosed: () => false,
        close: vi.fn(async () => undefined),
      });
    };
    const pages: Page[] = [];
    f.context.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      contextEvents.on(event, listener);
    });
    f.context.pages = () => pages;
    const cdpSession = Object.assign(new EventEmitter(), {
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { canAccessOpener: false } } : {},
      ),
      detach: vi.fn().mockResolvedValue(undefined),
    });
    f.context.newCDPSession.mockResolvedValue(cdpSession);
    let releaseSlowCreate: ((page: Page) => void) | null = null;
    let slowNext = false;
    f.context.newPage.mockImplementation(async () => {
      if (slowNext) {
        slowNext = false;
        const created = createMockPage("about:blank") as unknown as Page;
        pages.push(created);
        contextEvents.emit("page", created);
        return await new Promise<Page>((resolve) => {
          releaseSlowCreate = resolve;
        });
      }
      const created = createMockPage("about:blank");
      pages.push(created as unknown as Page);
      contextEvents.emit("page", created);
      return created;
    });
    let launched: Awaited<ReturnType<typeof f.launcher.launch>> | undefined;
    try {
      launched = await f.launcher.launch(nativeProfileRequest(f.directory));
      const ownership = new PageOwnership();
      ownership.adopt(launched.context);
      const pageA = await launched.context.createPage();
      ownership.claim(pageA, "session-a");
      const pageB = await launched.context.createPage();
      ownership.claim(pageB, "session-b");
      await Promise.resolve();

      // 1. Plain-space primary+click in Session A must NOT steal an openerless target in a two-session context.
      const primaryBit = process.platform === "darwin" ? 4 : 2;
      const cdpA = await pageA.cdp();
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        modifiers: primaryBit,
      });
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        modifiers: primaryBit,
      });
      const sessionBTarget = createMockPage("https://session-b.test/target");
      pages.push(sessionBTarget as unknown as Page);
      contextEvents.emit("page", sessionBTarget);
      await Promise.resolve();
      const targetHandle = launched.context.pages().at(-1)!;
      expect(ownership.sessionOf(targetHandle)).toBeNull();

      // 2. Interleaved gestures across distinct openers (A and B) fail closed without guessing FIFO.
      const cdpB = await pageB.cdp();
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        modifiers: primaryBit,
      });
      await cdpB.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        modifiers: primaryBit,
      });
      const ambiguousTarget = createMockPage("https://ambiguous.test/");
      pages.push(ambiguousTarget as unknown as Page);
      contextEvents.emit("page", ambiguousTarget);
      await Promise.resolve();
      const ambiguousHandle = launched.context.pages().at(-1)!;
      expect(await ambiguousHandle.opener()).toBeNull();
      expect(ownership.sessionOf(ambiguousHandle)).toBeNull();

      // 3. Explicit createPage() in flight does not swallow a concurrent openerless about:blank child.
      const singleOwnership = new PageOwnership();
      const singleF = await nativeCloseFixture();
      const singleEvents = new EventEmitter();
      const singlePages: Page[] = [];
      singleF.context.on.mockImplementation(
        (event: string, listener: (...args: unknown[]) => void) => {
          singleEvents.on(event, listener);
        },
      );
      singleF.context.pages = () => singlePages;
      singleF.context.newCDPSession.mockResolvedValue(cdpSession);
      let resolveExplicit!: (page: Page) => void;
      let holdExplicit = false;
      singleF.context.newPage.mockImplementation(async () => {
        const created = createMockPage("about:blank") as unknown as Page;
        singlePages.push(created);
        singleEvents.emit("page", created);
        if (holdExplicit) {
          holdExplicit = false;
          return await new Promise<Page>((resolve) => {
            resolveExplicit = () => resolve(created);
          });
        }
        return created;
      });
      const singleLaunched = await singleF.launcher.launch(nativeProfileRequest(singleF.directory));
      try {
        singleOwnership.adopt(singleLaunched.context);
        const opener = await singleLaunched.context.createPage();
        singleOwnership.claim(opener, "only-session");
        await Promise.resolve();
        const openerCdp = await opener.cdp();
        await openerCdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          modifiers: primaryBit,
        });
        holdExplicit = true;
        const explicitPromise = singleLaunched.context.createPage();
        // An open is admitted first (TS13), so Playwright is asked a few turns later: the child
        // arrives while the runtime's own open is in flight.
        await vi.waitFor(() => expect(resolveExplicit).toBeTypeOf("function"));
        const blankChild = createMockPage("about:blank");
        singlePages.push(blankChild as unknown as Page);
        singleEvents.emit("page", blankChild);
        resolveExplicit(undefined as never);
        const explicitHandle = await explicitPromise;
        await Promise.resolve();
        await Promise.resolve();
        const childHandle = singleLaunched.context.pages().at(-1)!;
        expect(await explicitHandle.opener()).toBeNull();
        expect(await childHandle.opener()).toBe(opener);
        expect(singleOwnership.sessionOf(childHandle)).toBe("only-session");

        // 4. Even when a second session has zero live pages (all tabs asleep),
        // attaching that session to the context prevents inferred cross-session claims.
        singleOwnership.attachSession(singleLaunched.context, "sleeping-session");
        await openerCdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          modifiers: primaryBit,
        });
        const sleeperTarget = createMockPage("https://sleeping-session.test/target");
        singlePages.push(sleeperTarget as unknown as Page);
        singleEvents.emit("page", sleeperTarget);
        await Promise.resolve();
        const sleeperHandle = singleLaunched.context.pages().at(-1)!;
        expect(singleOwnership.sessionOf(sleeperHandle)).toBeNull();
      } finally {
        singleF.exit();
        await singleLaunched.close();
        await rm(singleF.directory, { recursive: true, force: true });
      }
      expect(releaseSlowCreate).toBeNull();
    } finally {
      f.exit();
      await launched?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

/*
 * Z3: a page the runtime asked for is the runtime's from the ask until it is handed out or closed.
 * An open it gave up on (timed out, or abandoned when its session ended) whose page Chromium still
 * makes is closed when it arrives, with evidence: never handed out as the page a person's link
 * opened, and never left open with no owner. The old open kept no hold on Playwright's answer.
 */
describe("a page whose open was given up (Z3)", () => {
  async function fixture() {
    const { PageOwnership } = await import("@opensteer/browser-runtime-core");
    const f = await nativeCloseFixture();
    const events = new EventEmitter();
    const pages: Page[] = [];
    const mockPage = (url: string) =>
      Object.assign(new EventEmitter(), {
        url: () => url,
        opener: async () => null,
        isClosed: () => false,
        close: vi.fn(async () => undefined),
      });
    f.context.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
    });
    f.context.pages = () => pages;
    f.context.newCDPSession.mockResolvedValue(
      Object.assign(new EventEmitter(), {
        send: vi.fn(async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { canAccessOpener: false } } : {},
        ),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    );
    let late: PromiseWithResolvers<Page> | null = null;
    f.context.newPage.mockImplementation(async () => {
      if (late) return await late.promise;
      const created = mockPage("about:blank") as unknown as Page;
      pages.push(created);
      events.emit("page", created);
      return created;
    });
    const launched = await f.launcher.launch(nativeProfileRequest(f.directory));
    const ownership = new PageOwnership();
    ownership.adopt(launched.context);
    const opener = await launched.context.createPage();
    ownership.claim(opener, "only-session");
    await Promise.resolve();
    // The next open hangs in Chromium; the runtime gives it up (its session ended).
    late = Promise.withResolvers<Page>();
    const giveUp = new AbortController();
    const asked = launched.context.createPage({ signal: giveUp.signal });
    await vi.waitFor(() => expect(f.context.newPage).toHaveBeenCalledTimes(2));
    giveUp.abort();
    await expect(asked).rejects.toThrow();
    // Chromium makes the page after all: Playwright announces it, then answers the open.
    const arrive = (url: string) => {
      const page = mockPage(url);
      pages.push(page as unknown as Page);
      events.emit("page", page);
      return page;
    };
    const pendingLate = late;
    const handleOf = (page: unknown) =>
      launched.context
        .pages()
        .find((handle) => (handle as unknown as { rawPage?: unknown }).rawPage === page);
    return { f, launched, ownership, opener, arrive, late: () => pendingLate, handleOf };
  }

  const primaryBit = process.platform === "darwin" ? 4 : 2;
  const click = async (opener: BrowserPage) =>
    (await opener.cdp()).send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      modifiers: primaryBit,
    });
  const turns = async (count = 4) => {
    for (let turn = 0; turn < count; turn++) await Promise.resolve();
  };

  it("shows a link's page at once while the given-up open is still pending, and closes only that open's page when it comes (Z5)", async () => {
    const { f, launched, ownership, opener, arrive, late, handleOf } = await fixture();
    try {
      await click(opener);
      // The given-up open never answers while the link's page arrives at its address.
      const linked = arrive("https://link.test/");
      await turns();
      const handle = handleOf(linked);
      expect(handle).toBeDefined();
      expect(await handle!.opener()).toBe(opener);
      expect(ownership.sessionOf(handle!)).toBe("only-session");
      // Then the given-up open answers: its page, and only it, is closed.
      const stray = arrive("about:blank");
      late().resolve(stray as unknown as Page);
      await vi.waitFor(() => expect(stray.close).toHaveBeenCalled());
      expect(handleOf(stray)).toBeUndefined();
      expect(linked.close).not.toHaveBeenCalled();
      expect(handleOf(linked)).toBe(handle);
    } finally {
      f.exit();
      await launched.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("shows a link's blank page within a moment while the given-up open is pending, still its link's (Z5)", async () => {
    const { f, launched, ownership, opener, arrive, handleOf } = await fixture();
    try {
      await click(opener);
      const blank = arrive("about:blank");
      const asked = performance.now();
      await vi.waitFor(() => expect(handleOf(blank)).toBeDefined(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(performance.now() - asked).toBeLessThan(800);
      const handle = handleOf(blank)!;
      expect(await handle.opener()).toBe(opener);
      expect(ownership.sessionOf(handle)).toBe("only-session");
    } finally {
      f.exit();
      await launched.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("closes the late page of an open abandoned when its session ended, and hands it to no one", async () => {
    const { f, launched, arrive, late, handleOf } = await fixture();
    try {
      const stray = arrive("about:blank");
      late().resolve(stray as unknown as Page);
      await vi.waitFor(() => expect(stray.close).toHaveBeenCalled());
      await turns();
      expect(handleOf(stray)).toBeUndefined();
    } finally {
      f.exit();
      await launched.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

/** A page published as the runtime's own new page (K3 (a)), as every open of a native page is. */
async function ownPage(
  launched: { context: { createPage(): Promise<BrowserPage> } },
  context: { newPage: { mockResolvedValueOnce(value: unknown): unknown } },
  page: unknown,
): Promise<BrowserPage> {
  const raw = page as { isClosed?: () => boolean };
  raw.isClosed ??= () => false;
  context.newPage.mockResolvedValueOnce(page);
  return launched.context.createPage();
}

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
  // The helper's one sleep call, made of the two it is built from (mocked separately here):
  // named first, discarded second (Q2).
  vi.spyOn(ChromiumTabLifecycleBridge.prototype, "nameAndDiscard").mockImplementation(
    async function (this: ChromiumTabLifecycleBridge, tabId: number, title: string) {
      if (!(await this.nameTab(tabId, title))) return null;
      return this.discardByTabId(tabId);
    },
  );
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
