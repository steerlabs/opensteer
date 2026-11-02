import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { shell } from "electron";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";
import { expect, it, vi } from "vitest";
import { configureDesktopWindowNavigation, createElectronAppWindow } from "./electron-window.js";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
  BaseWindow: class extends EventEmitter {
    contentView = { addChildView: vi.fn(), setBackgroundColor: vi.fn() };
    getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  },
  WebContentsView: class {
    webContents = {};
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
