import { describe, expect, it, vi } from "vitest";
import type {
  BaseWindow,
  Input,
  MenuItem,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";
import {
  workspaceTabCommand,
  desktopBrowserAppShortcut,
  createDesktopApplicationMenu,
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
