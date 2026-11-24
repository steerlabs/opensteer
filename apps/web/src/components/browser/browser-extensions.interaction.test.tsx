// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopBrowserPresentationIdSchema,
  type DesktopBrowserExtension,
  type DesktopBrowserExtensions,
  type DesktopBrowserPresentationBridge,
  type DesktopBrowserPresentationEvent,
  type DesktopBrowserPresentationTarget,
} from "@opensteer/protocol/desktop";
import { nativeBrowserPresented } from "../native-browser-overlays.js";
import { BrowserExtensions, chromeWebStoreUrl, sameExtensions } from "./browser-extensions.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ids = {
  a: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  b: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  c: "cccccccccccccccccccccccccccccccc",
  d: "dddddddddddddddddddddddddddddddd",
  e: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  f: "ffffffffffffffffffffffffffffffff",
} as const;
const ownIcon = "data:image/png;base64,T1dO";
const actionIcon = "data:image/png;base64,QUNUSU9O";
const optionsUrl = `chrome-extension://${ids.a}/options.html`;

function extension(
  id: string,
  name: string,
  overrides: Partial<DesktopBrowserExtension> = {},
): DesktopBrowserExtension {
  return {
    id,
    name,
    version: "1.0.0",
    icon: null,
    action: { title: "", badgeText: "", badgeColor: null, icon: null, hasPopup: true },
    optionsUrl: null,
    unpacked: false,
    ...overrides,
  };
}

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

function createFakeBridge(
  initial: DesktopBrowserExtensions | null,
  options: { readonly activate?: boolean; readonly remove?: boolean } = {},
) {
  let current = initial;
  const listeners = new Set<(event: DesktopBrowserPresentationEvent) => void>();
  const extensions = vi.fn(async (_input: DesktopBrowserPresentationTarget) => current);
  const activateExtension = vi.fn(async () => undefined);
  const removeExtension = vi.fn(async () => undefined);
  const bridge = {
    isLocal: vi.fn(async () => true),
    present: vi.fn(),
    update: vi.fn(),
    release: vi.fn(async () => undefined),
    onEvent: (listener: (event: DesktopBrowserPresentationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    windowFocused: vi.fn(async () => true),
    acquireOverlay: vi.fn(async () => undefined),
    releaseOverlay: vi.fn(async () => undefined),
    find: vi.fn(async () => undefined),
    stopFind: vi.fn(async () => undefined),
    exitFullscreen: vi.fn(async () => undefined),
    setGlass: vi.fn(),
    setAutofill: vi.fn(),
    focusPage: vi.fn(async () => undefined),
    extensions,
    ...(options.activate === false ? {} : { activateExtension }),
    ...(options.remove === false ? {} : { removeExtension }),
  } as unknown as DesktopBrowserPresentationBridge;

  return {
    bridge,
    extensions,
    activateExtension,
    removeExtension,
    listenerCount: () => listeners.size,
    setExtensions(next: DesktopBrowserExtensions | null) {
      current = next;
    },
    emit(event: DesktopBrowserPresentationEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

let container: HTMLDivElement;
let root: Root | undefined;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rect = this.getBoundingClientRect();
    return {
      0: rect,
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
      [Symbol.iterator]: function* () {
        yield rect;
      },
    } as DOMRectList;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  nativeBrowserPresented(null);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function makeTarget(revision = 1): DesktopBrowserPresentationTarget {
  return {
    presentationId: DesktopBrowserPresentationIdSchema.parse(crypto.randomUUID()),
    revision,
  };
}

function render(
  fake: ReturnType<typeof createFakeBridge>,
  target: DesktopBrowserPresentationTarget | null,
  props: {
    readonly appZoomFactor?: number;
    readonly onOpenTab?: (url: string) => void;
    readonly onReportError?: (error: unknown) => void;
  } = {},
) {
  act(() => {
    root!.render(
      <BrowserExtensions
        appZoomFactor={props.appZoomFactor ?? 1}
        bridge={fake.bridge}
        onOpenTab={props.onOpenTab ?? vi.fn()}
        onReportError={props.onReportError}
        target={target}
      />,
    );
  });
}

const inlineButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>(".browser-extension-btn"),
];
const trigger = () => container.querySelector<HTMLButtonElement>(".browser-extensions-trigger");
const menu = () => document.querySelector<HTMLElement>(".popover--extensions");
const submenu = () => document.querySelector<HTMLElement>(".popover--extension-actions");
const rows = () => [...document.querySelectorAll<HTMLElement>(".browser-extension-row")];
const menuItem = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );

function openMenu() {
  act(() => trigger()!.click());
  expect(menu()).not.toBeNull();
}

function keyDown(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
}

describe("BrowserExtensions", () => {
  it("renders nothing for a profile without extensions (Guest), or without a target", async () => {
    const target = makeTarget();
    const fake = createFakeBridge(null);
    render(fake, target);
    await flush();
    expect(fake.extensions).toHaveBeenCalledWith(target);
    expect(container.innerHTML).toBe("");

    const none = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] });
    render(none, null);
    await flush();
    expect(none.extensions).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("shows the page's actions with tooltips, badges and icons, and activates them zoom-scaled", async () => {
    const target = makeTarget(3);
    const fake = createFakeBridge({
      extensions: [
        extension(ids.a, "Alpha Guard", {
          icon: ownIcon,
          action: {
            title: "Alpha on this page",
            badgeText: "12",
            badgeColor: "#1a73e8",
            icon: actionIcon,
            hasPopup: true,
          },
        }),
        extension(ids.b, "Beta Tools", {
          icon: ownIcon,
          action: { title: "", badgeText: "ON", badgeColor: null, icon: null, hasPopup: false },
        }),
        extension(ids.c, "Gamma", { action: null }),
        extension(ids.d, "delta notes"),
      ],
    });
    render(fake, target, { appZoomFactor: 1.25 });
    await flush();

    const buttons = inlineButtons();
    // Only extensions with an action get a toolbar button, in profile order.
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Alpha on this page",
      "Beta Tools",
      "delta notes",
    ]);
    expect(buttons.map((button) => button.title)).toEqual([
      "Alpha on this page",
      "Beta Tools",
      "delta notes",
    ]);
    // The page's action icon wins over the extension's own; the extension's own is next.
    expect(buttons[0]!.querySelector("img")?.getAttribute("src")).toBe(actionIcon);
    expect(buttons[1]!.querySelector("img")?.getAttribute("src")).toBe(ownIcon);
    // Without either, its initial on a tile.
    expect(buttons[2]!.querySelector("img")).toBeNull();
    expect(buttons[2]!.querySelector(".browser-extension-mark")?.textContent).toBe("D");

    const coloured = buttons[0]!.querySelector<HTMLElement>(".browser-extension-btn__badge");
    expect(coloured?.textContent).toBe("12");
    expect(coloured?.style.backgroundColor).toBe("#1a73e8");
    expect(coloured?.classList.contains("has-color")).toBe(true);
    const neutral = buttons[1]!.querySelector<HTMLElement>(".browser-extension-btn__badge");
    expect(neutral?.textContent).toBe("ON");
    expect(neutral?.style.backgroundColor).toBe("");
    expect(buttons[2]!.querySelector(".browser-extension-btn__badge")).toBeNull();

    vi.spyOn(buttons[0]!, "getBoundingClientRect").mockReturnValue(makeRect(100, 20, 32, 32));
    act(() => buttons[0]!.click());
    expect(fake.activateExtension).toHaveBeenLastCalledWith({
      presentationId: target.presentationId,
      revision: 3,
      extensionId: ids.a,
      eventType: "click",
      anchorRect: { x: 125, y: 25, width: 40, height: 40 },
    });

    const contextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      buttons[0]!.dispatchEvent(contextEvent);
    });
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(fake.activateExtension).toHaveBeenLastCalledWith({
      presentationId: target.presentationId,
      revision: 3,
      extensionId: ids.a,
      eventType: "contextmenu",
      anchorRect: { x: 125, y: 25, width: 40, height: 40 },
    });
  });

  it("caps the toolbar at four actions and keeps the rest in the menu", async () => {
    const all = [ids.a, ids.b, ids.c, ids.d, ids.e, ids.f].map((id, index) =>
      extension(id, `Extension ${index + 1}`),
    );
    const fake = createFakeBridge({ extensions: all });
    render(fake, makeTarget());
    await flush();

    expect(inlineButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Extension 1",
      "Extension 2",
      "Extension 3",
      "Extension 4",
    ]);
    openMenu();
    expect(rows()).toHaveLength(6);
  });

  it("hides the toolbar actions when the bridge cannot activate them", async () => {
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] }, { activate: false });
    render(fake, makeTarget());
    await flush();
    expect(inlineButtons()).toHaveLength(0);
    expect(trigger()).not.toBeNull();
    openMenu();
    // The row is listed but static: there is nothing to press.
    expect(rows()[0]!.querySelector("button.browser-extension-row__main")).toBeNull();
    expect(rows()[0]!.querySelector(".browser-extension-row__main--static")).not.toBeNull();
  });

  it("reports a failed activation", async () => {
    const onReportError = vi.fn();
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] });
    const failure = new Error("no popup");
    fake.activateExtension.mockRejectedValueOnce(failure);
    render(fake, makeTarget(), { onReportError });
    await flush();
    act(() => inlineButtons()[0]!.click());
    await flush();
    expect(onReportError).toHaveBeenCalledWith(failure);
  });

  it("lists every extension, marks unpacked ones quietly, and activates from the puzzle", async () => {
    const target = makeTarget(2);
    const fake = createFakeBridge({
      extensions: [
        extension(ids.a, "Alpha Guard", { icon: ownIcon, optionsUrl }),
        extension(ids.b, "Local Helper", { unpacked: true }),
        extension(ids.c, "Theme Only", { action: null }),
      ],
    });
    render(fake, target, { appZoomFactor: 2 });
    await flush();
    vi.spyOn(trigger()!, "getBoundingClientRect").mockReturnValue(makeRect(400, 10, 28, 28));

    expect(trigger()!.getAttribute("aria-expanded")).toBe("false");
    openMenu();
    expect(trigger()!.getAttribute("aria-expanded")).toBe("true");
    expect(trigger()!.getAttribute("aria-controls")).toBe(menu()!.id);
    expect(menu()!.getAttribute("role")).toBe("menu");

    const [alpha, local, theme] = rows();
    expect(alpha!.querySelector(".picker__label")?.textContent).toBe("Alpha Guard");
    expect(alpha!.querySelector(".picker__label")?.getAttribute("title")).toBe("Alpha Guard");
    expect(alpha!.querySelector("img")?.getAttribute("src")).toBe(ownIcon);
    expect(alpha!.querySelector(".browser-extension-row__source")).toBeNull();
    expect(local!.querySelector(".browser-extension-row__source")?.textContent).toBe(
      "Not from Chrome Web Store",
    );
    expect(document.body.textContent).not.toMatch(/developer mode|warning/i);
    // No action: listed, but not a button.
    expect(theme!.querySelector("button.browser-extension-row__main")).toBeNull();

    act(() => alpha!.querySelector<HTMLButtonElement>(".browser-extension-row__main")!.click());
    expect(menu()).toBeNull();
    expect(fake.activateExtension).toHaveBeenCalledWith({
      presentationId: target.presentationId,
      revision: 2,
      extensionId: ids.a,
      eventType: "click",
      anchorRect: { x: 800, y: 20, width: 56, height: 56 },
    });
  });

  it("opens an extension's actions with the keyboard, offers Options only when it has them, and removes", async () => {
    const target = makeTarget(4);
    const onOpenTab = vi.fn();
    const fake = createFakeBridge({
      extensions: [extension(ids.a, "Alpha", { optionsUrl }), extension(ids.b, "Beta")],
    });
    render(fake, target, { onOpenTab });
    await flush();
    openMenu();

    const alphaMain = rows()[0]!.querySelector<HTMLButtonElement>(".browser-extension-row__main")!;
    const alphaMore = rows()[0]!.querySelector<HTMLButtonElement>(".browser-extension-row__more")!;
    expect(alphaMore.getAttribute("role")).toBe("menuitem");
    expect(alphaMore.getAttribute("aria-haspopup")).toBe("menu");
    expect(alphaMore.getAttribute("aria-label")).toBe("More actions for Alpha");
    expect(alphaMore.getAttribute("aria-expanded")).toBe("false");

    // → opens the submenu with focus on its first item; ← closes it back to ⋯.
    act(() => alphaMore.focus());
    keyDown(alphaMore, "ArrowRight");
    expect(submenu()).not.toBeNull();
    expect(alphaMore.getAttribute("aria-expanded")).toBe("true");
    expect(alphaMore.getAttribute("aria-controls")).toBe(submenu()!.id);
    expect(rows()[0]!.classList.contains("is-open")).toBe(true);
    const options = menuItem(submenu()!, "Options")!;
    expect(document.activeElement).toBe(options);
    expect(menuItem(submenu()!, "Remove")?.className).toContain("picker__row--danger");

    keyDown(options, "ArrowLeft");
    expect(submenu()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(alphaMore);

    // ← on ⋯ goes back to the row; → on the row opens its actions too.
    keyDown(alphaMore, "ArrowLeft");
    expect(document.activeElement).toBe(alphaMain);
    keyDown(alphaMain, "ArrowRight");
    expect(submenu()).not.toBeNull();

    act(() => menuItem(submenu()!, "Options")!.click());
    expect(onOpenTab).toHaveBeenCalledWith(optionsUrl);
    expect(menu()).toBeNull();
    expect(submenu()).toBeNull();

    // Beta has no options page: Remove alone.
    openMenu();
    act(() => rows()[1]!.querySelector<HTMLButtonElement>(".browser-extension-row__more")!.click());
    expect(menuItem(submenu()!, "Options")).toBeUndefined();
    act(() => menuItem(submenu()!, "Remove")!.click());
    expect(fake.removeExtension).toHaveBeenCalledWith({
      presentationId: target.presentationId,
      revision: 4,
      extensionId: ids.b,
    });
    expect(menu()).toBeNull();
  });

  it("keeps one extension's actions open at a time", async () => {
    const fake = createFakeBridge({
      extensions: [extension(ids.a, "Alpha", { optionsUrl }), extension(ids.b, "Beta")],
    });
    render(fake, makeTarget());
    await flush();
    openMenu();
    const [alpha, beta] = rows();
    act(() => alpha!.querySelector<HTMLButtonElement>(".browser-extension-row__more")!.click());
    expect(submenu()?.getAttribute("aria-label")).toBe("Alpha actions");
    act(() => beta!.querySelector<HTMLButtonElement>(".browser-extension-row__more")!.click());
    expect(document.querySelectorAll(".popover--extension-actions")).toHaveLength(1);
    expect(submenu()?.getAttribute("aria-label")).toBe("Beta actions");
  });

  it("drops the ⋯ when an extension has no options and the bridge cannot remove", async () => {
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] }, { remove: false });
    render(fake, makeTarget());
    await flush();
    openMenu();
    expect(rows()[0]!.querySelector(".browser-extension-row__more")).toBeNull();
  });

  it("welcomes an empty profile and opens the Chrome Web Store", async () => {
    const onOpenTab = vi.fn();
    const fake = createFakeBridge({ extensions: [] });
    render(fake, makeTarget(), { onOpenTab });
    await flush();
    expect(inlineButtons()).toHaveLength(0);
    openMenu();
    expect(menu()!.querySelector(".browser-extensions__empty-title")?.textContent).toBe(
      "No extensions yet",
    );
    expect(rows()).toHaveLength(0);
    // The store is the first and only item, so it takes focus.
    const store = menuItem(menu()!, "Chrome Web Store")!;
    expect(document.activeElement).toBe(store);
    act(() => store.click());
    expect(onOpenTab).toHaveBeenCalledWith(chromeWebStoreUrl);
    expect(menu()).toBeNull();
  });

  it("opens the Chrome Web Store from a populated menu", async () => {
    const onOpenTab = vi.fn();
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] });
    render(fake, makeTarget(), { onOpenTab });
    await flush();
    openMenu();
    act(() => menuItem(menu()!, "Chrome Web Store")!.click());
    expect(onOpenTab).toHaveBeenCalledWith("https://chromewebstore.google.com/");
  });

  it("moves through the menu with the arrow keys and closes on Escape", async () => {
    const fake = createFakeBridge({
      extensions: [extension(ids.a, "Alpha", { optionsUrl }), extension(ids.b, "Beta")],
    });
    render(fake, makeTarget());
    await flush();
    openMenu();
    const items = [...menu()!.querySelectorAll<HTMLButtonElement>("button")];
    expect(document.activeElement).toBe(items[0]);
    keyDown(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    keyDown(items[1]!, "End");
    expect(document.activeElement).toBe(menuItem(menu()!, "Chrome Web Store"));
    keyDown(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("reads again on its page's extensions event, ignoring other pages' and keeping equal replies", async () => {
    const target = makeTarget();
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] });
    render(fake, target);
    await flush();
    expect(fake.extensions).toHaveBeenCalledTimes(1);
    const before = inlineButtons()[0];

    act(() =>
      fake.emit({
        type: "extensions",
        presentationId: DesktopBrowserPresentationIdSchema.parse(crypto.randomUUID()),
      }),
    );
    await flush();
    expect(fake.extensions).toHaveBeenCalledTimes(1);

    // An equal reply keeps the very same button.
    fake.setExtensions({ extensions: [extension(ids.a, "Alpha")] });
    act(() => fake.emit({ type: "extensions", presentationId: target.presentationId }));
    await flush();
    expect(fake.extensions).toHaveBeenCalledTimes(2);
    expect(inlineButtons()[0]).toBe(before);

    fake.setExtensions({
      extensions: [
        extension(ids.a, "Alpha", {
          action: { title: "Alpha", badgeText: "3", badgeColor: null, icon: null, hasPopup: true },
        }),
        extension(ids.b, "Beta"),
      ],
    });
    act(() => fake.emit({ type: "extensions", presentationId: target.presentationId }));
    await flush();
    expect(inlineButtons()).toHaveLength(2);
    expect(inlineButtons()[0]!.querySelector(".browser-extension-btn__badge")?.textContent).toBe(
      "3",
    );

    // Guest after all: the strip leaves.
    fake.setExtensions(null);
    act(() => fake.emit({ type: "extensions", presentationId: target.presentationId }));
    await flush();
    expect(container.innerHTML).toBe("");

    act(() => root!.unmount());
    root = undefined;
    expect(fake.listenerCount()).toBe(0);
  });

  it("never lets a stale reply replace the current page's or revision's", async () => {
    const first = makeTarget(1);
    const second = makeTarget(1);
    const fake = createFakeBridge(null);
    const pending = new Map<string, (value: DesktopBrowserExtensions | null) => void>();
    fake.extensions.mockImplementation(
      (input: DesktopBrowserPresentationTarget) =>
        new Promise((resolve) => {
          pending.set(`${input.presentationId}:${input.revision}`, resolve);
        }),
    );

    render(fake, first);
    await flush();
    render(fake, second);
    await flush();
    expect(fake.extensions).toHaveBeenCalledTimes(2);

    // The second page's reply lands first; the first page's late reply is dropped.
    await act(async () => {
      pending.get(`${second.presentationId}:1`)!({ extensions: [extension(ids.b, "Second")] });
      await Promise.resolve();
    });
    await act(async () => {
      pending.get(`${first.presentationId}:1`)!({ extensions: [extension(ids.a, "First")] });
      await Promise.resolve();
    });
    expect(inlineButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["Second"]);

    // A read of revision 1 is in flight when revision 2 arrives: its late reply never lands.
    act(() => fake.emit({ type: "extensions", presentationId: second.presentationId }));
    const staleRevision = pending.get(`${second.presentationId}:1`)!;
    render(fake, { ...second, revision: 2 });
    await flush();
    expect(fake.extensions).toHaveBeenCalledTimes(4);
    await act(async () => {
      pending.get(`${second.presentationId}:2`)!({ extensions: [extension(ids.c, "Current")] });
      await Promise.resolve();
    });
    await act(async () => {
      staleRevision({ extensions: [extension(ids.d, "Stale")] });
      await Promise.resolve();
    });
    expect(inlineButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["Current"]);
  });

  it("drops an earlier overlapping read of the same revision", async () => {
    const target = makeTarget();
    const fake = createFakeBridge(null);
    const resolvers: ((value: DesktopBrowserExtensions | null) => void)[] = [];
    fake.extensions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(fake, target);
    await flush();
    act(() => fake.emit({ type: "extensions", presentationId: target.presentationId }));
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1]!({ extensions: [extension(ids.b, "Newer")] });
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]!({ extensions: [extension(ids.a, "Older")] });
      await Promise.resolve();
    });
    expect(inlineButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["Newer"]);
  });

  it("closes the menu and shows nothing of the old page when the page changes", async () => {
    const fake = createFakeBridge({ extensions: [extension(ids.a, "Alpha")] });
    render(fake, makeTarget());
    await flush();
    openMenu();

    let resolveNext!: (value: DesktopBrowserExtensions | null) => void;
    fake.extensions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );
    render(fake, makeTarget());
    await flush();
    expect(menu()).toBeNull();
    expect(container.innerHTML).toBe("");

    await act(async () => {
      resolveNext({ extensions: [extension(ids.b, "Beta")] });
      await Promise.resolve();
    });
    expect(inlineButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["Beta"]);
  });
});

describe("sameExtensions", () => {
  it("compares the list and each resolved action structurally", () => {
    const base = { extensions: [extension(ids.a, "Alpha", { optionsUrl })] };
    expect(sameExtensions(base, { extensions: [extension(ids.a, "Alpha", { optionsUrl })] })).toBe(
      true,
    );
    expect(sameExtensions(base, null)).toBe(false);
    expect(sameExtensions(null, null)).toBe(true);
    expect(sameExtensions(base, { extensions: [] })).toBe(false);
    expect(
      sameExtensions(base, {
        extensions: [
          extension(ids.a, "Alpha", {
            optionsUrl,
            action: { title: "", badgeText: "1", badgeColor: null, icon: null, hasPopup: true },
          }),
        ],
      }),
    ).toBe(false);
    expect(
      sameExtensions(base, {
        extensions: [extension(ids.a, "Alpha", { optionsUrl, unpacked: true })],
      }),
    ).toBe(false);
    expect(
      sameExtensions(base, {
        extensions: [extension(ids.a, "Alpha", { optionsUrl, action: null })],
      }),
    ).toBe(false);
  });
});
