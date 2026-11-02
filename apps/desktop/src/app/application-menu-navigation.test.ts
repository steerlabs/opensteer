import { describe, expect, it, vi } from "vitest";
import type {
  BaseWindow,
  Input,
  MenuItem,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import {
  workspaceTabCommand,
  desktopBrowserAppShortcut,
  createDesktopApplicationMenu,
  showDesktopUpdateMenuItem,
} from "./application-menu.js";

const { build } = vi.hoisted(() => ({ build: vi.fn((template: unknown) => template) }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: build } }));

describe("browser navigation menu", () => {
  it("workspace commands ignore auxiliary, destroyed and absent windows", () => {
    const send = vi.fn();
    const workspace = { isDestroyed: () => false } as unknown as BaseWindow;
    const auxiliary = { isDestroyed: () => false } as unknown as BaseWindow;
    const destroyed = { isDestroyed: () => true } as unknown as BaseWindow;
    const contents = { isDestroyed: () => false, send } as unknown as WebContents;
    createDesktopApplicationMenu({
      workspaceContents: (window) => (window === workspace ? contents : null),
    });
    const template = build.mock.calls.at(-1)![0] as MenuItemConstructorOptions[];
    const file = template.find((item) => item.label === "File")!
      .submenu as MenuItemConstructorOptions[];
    for (const label of ["Close Tab", "New Tab"]) {
      const click = file.find((item) => item.label === label)!.click!;
      for (const window of [undefined, auxiliary, destroyed])
        click({} as MenuItem, window, {} as KeyboardEvent);
      expect(send).not.toHaveBeenCalled();
      click({} as MenuItem, workspace, {} as KeyboardEvent);
      expect(send).toHaveBeenCalledOnce();
      send.mockClear();
    }
  });
  it("starts hard reload disabled until the selected session is known", () => {
    createDesktopApplicationMenu({ workspaceContents: () => null, browserKey: vi.fn() });
    const template = build.mock.calls.at(-1)![0] as {
      label?: string;
      submenu?: { id?: string; label?: string; enabled?: boolean }[];
    }[];
    expect(
      template
        .find((item) => item.label === "Browser")!
        .submenu!.find((item) => item.label === "Reload Without Cache"),
    ).toMatchObject({ id: "browser-hard-reload", enabled: false });
  });
  it.each([
    ["ArrowLeft", true, false, "previous-tab"],
    ["ArrowRight", true, false, "next-tab"],
    ["{", false, true, "previous-tab"],
    ["}", false, true, "next-tab"],
    ["[", false, true, "previous-tab"],
    ["]", false, true, "next-tab"],
  ])("takes tab switch %s before a native page", (key, alt, shift, type) => {
    const input = {
      type: "keyDown",
      key,
      alt,
      shift,
      meta: process.platform === "darwin",
      control: process.platform !== "darwin",
    } as Input;
    expect(workspaceTabCommand(input)).toEqual({ type });
    expect(desktopBrowserAppShortcut(input)).toBe(true);
  });
});

describe("update menu", () => {
  it("shows the one update item the state allows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const updates = { check: vi.fn(), download: vi.fn(), restart: vi.fn() };
    createDesktopApplicationMenu({ updates, workspaceContents: () => null });
    const template = build.mock.calls.at(-1)![0] as MenuItemConstructorOptions[];
    const items = (template[0]!.submenu as MenuItemConstructorOptions[]).filter((item) =>
      item.id?.includes("update"),
    );
    const menu = {
      getMenuItemById: (id: string) => items.find((item) => item.id === id) ?? null,
    } as unknown as Parameters<typeof showDesktopUpdateMenuItem>[0];
    const shown = (state: Partial<DesktopUpdateState>) => {
      showDesktopUpdateMenuItem(menu, {
        status: "idle",
        currentVersion: "0.1.396",
        availableVersion: null,
        downloadPercent: null,
        failed: null,
        ...state,
      });
      return items
        .filter((item) => item.visible !== false)
        .map((item) => `${item.label}${item.enabled === false ? " (disabled)" : ""}`);
    };
    expect(shown({ status: "up-to-date" })).toEqual(["Check for Updates…"]);
    expect(shown({ status: "checking" })).toEqual(["Check for Updates… (disabled)"]);
    expect(shown({ status: "error", failed: "check" })).toEqual(["Check for Updates…"]);
    expect(shown({ status: "available" })).toEqual(["Download Update…"]);
    expect(shown({ status: "downloading" })).toEqual(["Downloading Update… (disabled)"]);
    expect(shown({ status: "error", failed: "download" })).toEqual(["Download Update…"]);
    expect(shown({ status: "downloaded" })).toEqual(["Restart to Update"]);
    expect(shown({ status: "unavailable" })).toEqual(["Check for Updates…"]);
    for (const item of items) (item.click as (() => void) | undefined)?.();
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updates.download).toHaveBeenCalledOnce();
    expect(updates.restart).toHaveBeenCalledOnce();
  });
});
