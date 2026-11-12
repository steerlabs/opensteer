import { EventEmitter } from "node:events";
import type { OnBeforeRequestListenerDetails, Session, WebContents } from "electron";
import { shell } from "electron";
import type { DesktopConfiguration } from "../config.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";
import { expect, it, vi } from "vitest";
import {
  configureDesktopSession,
  configureDesktopWindowNavigation,
  createElectronAppWindow,
  ElectronWindowFactory,
} from "./electron-window.js";

const pageLoad = vi.hoisted(() => ({ next: Promise.resolve() }));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  shell: { openExternal: vi.fn(async () => undefined) },
  BaseWindow: class extends EventEmitter {
    contentView = { addChildView: vi.fn(), setBackgroundColor: vi.fn() };
    getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
    show = vi.fn();
  },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      loadURL: vi.fn(() => pageLoad.next),
      setWindowOpenHandler: vi.fn(),
    });
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  },
}));

it("paints the window ground inside the compositor beneath the transparent app view", () => {
  const window = createElectronAppWindow({ backgroundColor: "#080808" }, {});
  const ground = vi.mocked(window.contentView.setBackgroundColor);
  const attach = vi.mocked(window.contentView.addChildView);
  expect(ground).toHaveBeenCalledWith("#080808");
  expect(vi.mocked(window.appView.setBackgroundColor)).toHaveBeenCalledWith("#00000000");
  expect(ground.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]!);
});

it("shows a foreground window before its page loads and keeps a login launch hidden", async () => {
  let finishLoading!: () => void;
  pageLoad.next = new Promise((resolve) => {
    finishLoading = resolve;
  });
  const factory = new ElectronWindowFactory(
    { mode: "production" } as unknown as DesktopConfiguration,
    { bridgeToken: "token", preloadPath: "/preload.cjs", quit: vi.fn() },
  );
  const foreground = factory.create(() => undefined, { show: true });
  const login = factory.create(() => undefined, { show: false });
  expect(vi.mocked(foreground.window.show)).toHaveBeenCalledOnce();
  expect(vi.mocked(login.window.show)).not.toHaveBeenCalled();
  finishLoading();
  await Promise.all([foreground.loaded, login.loaded]);
  expect(vi.mocked(login.window.show)).not.toHaveBeenCalled();
});

it("opens only HTTP(S) links from the focused published-app frame in the system browser", () => {
  const appUrl = `opensteer-app://view/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/#chart`;
  const contents = { focusedFrame: { url: appUrl }, setWindowOpenHandler: vi.fn(), on: vi.fn() };
  configureDesktopWindowNavigation(
    contents as unknown as WebContents,
    new DesktopAppOriginPolicy(),
  );
  const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as Parameters<
    WebContents["setWindowOpenHandler"]
  >[0];
  const open = (url: string) =>
    handler({
      url,
      frameName: "",
      features: "",
      disposition: "foreground-tab",
      referrer: { url: "", policy: "no-referrer" },
    });
  for (const url of ["https://example.com", "http://example.com"]) {
    expect(open(url)).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenLastCalledWith(url);
  }
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "app://opensteer",
    "opensteer-app://view",
  ])
    open(url);
  contents.focusedFrame.url = "app://opensteer";
  open("https://example.com/untrusted-source");
  expect(shell.openExternal).toHaveBeenCalledTimes(2);
});

it("keeps only same-prefix app frame navigations inside the renderer", () => {
  const prefix = `opensteer-app://view/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
  const contents = { focusedFrame: { url: prefix }, setWindowOpenHandler: vi.fn(), on: vi.fn() };
  configureDesktopWindowNavigation(
    contents as unknown as WebContents,
    new DesktopAppOriginPolicy(),
  );
  const guard = contents.on.mock.calls.find(
    ([name]) => name === "will-frame-navigate",
  )![1] as (event: { frame: { url: string }; url: string; preventDefault: () => void }) => void;
  for (const [url, denied] of [
    [prefix + "settings", false],
    [prefix + "#details", false],
    ["app://opensteer/", true],
    ["https://host/v1/rpc/bootstrap.get", true],
  ] as const) {
    const preventDefault = vi.fn();
    guard({ frame: { url: prefix }, url, preventDefault });
    expect(preventDefault.mock.calls.length).toBe(denied ? 1 : 0);
  }
});

it("decides the app's own files without waiting on the attached Host", async () => {
  let listener!: (
    details: Pick<OnBeforeRequestListenerDetails, "url" | "resourceType">,
    callback: (response: { cancel: boolean }) => void,
  ) => void;
  const session = new Proxy(
    {
      getPreloadScripts: () => [],
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: typeof listener) => (listener = handler),
      },
    },
    { get: (target, name) => Reflect.get(target, name) ?? vi.fn() },
  );
  let attach!: (host: string) => void;
  const attachedHost = vi.fn(() => new Promise<string>((resolve) => (attach = resolve)));
  configureDesktopSession(
    session as unknown as Session,
    new DesktopAppOriginPolicy(),
    null,
    { accept: vi.fn() } as unknown as DesktopDownloads,
    attachedHost,
  );
  const ownFile = vi.fn();
  listener({ url: "app://opensteer/index.html", resourceType: "mainFrame" }, ownFile);
  expect(ownFile).toHaveBeenCalledExactlyOnceWith({ cancel: false });
  expect(attachedHost).not.toHaveBeenCalled();
  const appFrame = vi.fn();
  listener({ url: `http://${"a".repeat(26)}.localhost:4310/`, resourceType: "subFrame" }, appFrame);
  expect(appFrame).not.toHaveBeenCalled();
  attach("http://127.0.0.1:4310");
  await vi.waitFor(() => expect(appFrame).toHaveBeenCalledExactlyOnceWith({ cancel: false }));
});

it("leaves a frame an app embeds to the network policy", () => {
  const origin = `http://${"a".repeat(26)}.localhost:4310`;
  const policy = new DesktopAppOriginPolicy();
  policy.setAttachedHost("http://127.0.0.1:4310");
  const contents = { focusedFrame: { url: origin }, setWindowOpenHandler: vi.fn(), on: vi.fn() };
  configureDesktopWindowNavigation(contents as unknown as WebContents, policy);
  const redirect = contents.on.mock.calls.find(([name]) => name === "will-redirect")![1] as (
    event: unknown,
  ) => void;
  const preventDefault = vi.fn();
  redirect({
    isMainFrame: false,
    frame: { url: "https://maps.test/", parent: { url: origin } },
    url: "https://maps.test/embed",
    preventDefault,
  });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(
    policy.allowsNetworkRequest("https://maps.test/embed", {
      url: origin,
      resourceType: "subFrame",
      initiatorOrigin: origin,
    }),
  ).toBe(true);
  expect(
    policy.allowsNetworkRequest("https://maps.test/embed", {
      url: "app://opensteer/",
      resourceType: "subFrame",
      initiatorOrigin: "app://opensteer",
    }),
  ).toBe(false);
});

it("keeps real-origin redirects inside the app and opens departures externally", () => {
  const origin = `http://${"a".repeat(26)}.localhost:4310`;
  const policy = new DesktopAppOriginPolicy();
  policy.setAttachedHost("http://127.0.0.1:4310");
  const contents = { focusedFrame: { url: origin }, setWindowOpenHandler: vi.fn(), on: vi.fn() };
  configureDesktopWindowNavigation(contents as unknown as WebContents, policy);
  const redirect = contents.on.mock.calls.find(
    ([name]) => name === "will-redirect",
  )![1] as (event: {
    isMainFrame: boolean;
    frame: { url: string };
    url: string;
    preventDefault: () => void;
  }) => void;
  const start = contents.on.mock.calls.find(
    ([name]) => name === "did-start-navigation",
  )![1] as (event: { isMainFrame: boolean; frame: { url: string }; url: string }) => void;
  const pendingFrame = { url: "about:blank" };
  start({ isMainFrame: false, frame: pendingFrame, url: origin });
  const initialRedirect = vi.fn();
  redirect({
    isMainFrame: false,
    frame: pendingFrame,
    url: origin + "/login",
    preventDefault: initialRedirect,
  });
  expect(initialRedirect).not.toHaveBeenCalled();
  for (const [url, denied] of [
    [origin + "/next", false],
    ["https://external.test", true],
    ["app://opensteer", true],
  ] as const) {
    const preventDefault = vi.fn();
    redirect({ isMainFrame: false, frame: { url: origin }, url, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(denied ? 1 : 0);
  }
  expect(shell.openExternal).toHaveBeenCalledWith("https://external.test");
});
