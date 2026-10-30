// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList, type HostSnapshot } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";

import type { DesktopWorkspaceTabCommand } from "@opensteer/protocol/desktop";

import { tabOrder } from "./tab-order.js";

import {
  root,
  client,
  history,
  goTo,
  mount,
  settle,
  element,
  click,
  pageTab,
  tabSearch,
  write,
  setRoot,
} from "./workspace.interaction.test-support.js";
describe("workspace tab commands", () => {
  let receive: ((command: DesktopWorkspaceTabCommand) => void) | null = null;
  function nativeMenu() {
    const unsubscribe = vi.fn(() => {
      receive = null;
    });
    vi.stubGlobal("opensteerDesktop", {
      getLocalVisibility: async () => true,
      onLocalVisibilityChanged: () => () => undefined,
      setBadgeCount: vi.fn(async () => undefined),
      onWorkspaceTabCommand: (listener: typeof receive) => {
        receive = listener;
        return unsubscribe;
      },
    });
    return unsubscribe;
  }
  async function command(value: DesktopWorkspaceTabCommand) {
    expect(receive).not.toBeNull();
    // act flushes the command's React updates; the following assertions observe its result.
    await act(async () => receive?.(value));
  }
  async function chord(init: KeyboardEventInit, target: EventTarget = window) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("the web app leaves browser-reserved chords and field editing to the browser", async () => {
    await mount("/");
    const before = history.length;
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    field.focus();
    for (const init of [
      { key: "1", metaKey: true },
      { key: "9", metaKey: true },
      { ctrlKey: true, key: "Tab" },
      { ctrlKey: true, shiftKey: true, key: "Tab" },
      { key: "t", metaKey: true },
      { key: "w", metaKey: true },
      { key: "t", metaKey: true, shiftKey: true },
      { key: "l", metaKey: true },
      ...["a", "c", "v", "z"].map((key) => ({ key, metaKey: true })),
    ])
      expect((await chord(init, field)).defaultPrevented).toBe(false);
    expect(history.length).toBe(before);
    expect(document.querySelector(".place")).toBeNull();
  });

  it("native commands close the focused New tab, preserve the composer, and use place succession", async () => {
    const unsubscribe = nativeMenu();
    await mount("/");
    const places = tabOrder(placeList(client.getSnapshot()));
    await command({ type: "select-tab", index: 1 });
    expect(element(".place").getAttribute("data-place-key")).toBe(places[0]!.key);
    await command({ type: "next-tab" });
    expect(element(".place").getAttribute("data-place-key")).toBe(places[1]!.key);
    await command({ type: "previous-tab" });
    expect(element(".place").getAttribute("data-place-key")).toBe(places[0]!.key);
    for (let index = 1; index <= 9; index++) {
      await command({ type: "select-tab", index });
      const expected = index === 9 ? places.at(-1) : places[index - 1];
      if (expected) expect(element(".place").getAttribute("data-place-key")).toBe(expected.key);
    }
    await command({ type: "new-tab" });
    await command({ type: "previous-tab" });
    expect(element(".place").getAttribute("data-place-key")).toBe(places.at(-1)!.key);
    await command({ type: "new-tab" });
    await command({ type: "next-tab" });
    expect(element(".place").getAttribute("data-place-key")).toBe(places[0]!.key);
    await command({ type: "select-tab", index: 1 });
    const opens = vi.spyOn(client, "openBrowserTab");
    await command({ type: "new-tab" });
    expect(document.activeElement).toBe(element(".start-page__input"));
    expect(opens).not.toHaveBeenCalled();
    // A DOM event cannot run the native command a second time.
    await chord({ key: "w", metaKey: true }, document.activeElement!);
    expect(element(".place").className).toContain("place--launcher");
    await command({ type: "close-tab" });
    expect(document.querySelector(".side-tab--start")).toBeNull();
    expect(element(".place").getAttribute("data-place-key")).toBe(places[0]!.key);
    const quiet = places.find(
      (place) =>
        place.closable &&
        place.destination.kind === "browser" &&
        client
          .getSnapshot()
          .browserSessions.find(
            (session) =>
              place.destination.kind === "browser" && session.id === place.destination.sessionId,
          )?.attachedRunIds.length === 0,
    )!;
    await click(element(`.side-tab[data-place-key="${quiet.key}"] .side-tab__main`));
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "Keep this draft");
    field.focus();
    const close = vi.spyOn(client, "closeBrowserTab");
    await command({ type: "close-tab" });
    expect(close).toHaveBeenCalledOnce();
    expect(field.value).toBe("Keep this draft");
    expect(element(".place").getAttribute("data-place-key")).toBe(
      places[places.indexOf(quiet) + 1]!.key,
    );
    expect(history.at(-1)!.type).toBe("REPLACE");
    await act(async () => root?.unmount());
    setRoot(null);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("native commands act while the live page holds focus without sending the chord to it", async () => {
    nativeMenu();
    await mount("/");
    const places = tabOrder(placeList(client.getSnapshot()));
    const quiet = places.find(
      (place) =>
        place.closable &&
        place.destination.kind === "browser" &&
        client
          .getSnapshot()
          .browserSessions.find(
            (session) =>
              place.destination.kind === "browser" && session.id === place.destination.sessionId,
          )?.attachedRunIds.length === 0,
    )!;
    await click(element(`.side-tab[data-place-key="${quiet.key}"] .side-tab__main`));
    const page = element<HTMLElement>("[data-live-page]");
    page.focus();
    expect(document.activeElement?.closest("[data-live-page]")).toBe(page);
    const send = vi.spyOn(client, "sendBrowserCommand");
    const close = vi.spyOn(client, "closeBrowserTab");
    await command({ type: "close-tab" });
    expect(close).toHaveBeenCalledOnce();
    expect(
      send.mock.calls.some(
        ([, value]) => value.type === "input.key" && value.key.toLowerCase() === "w",
      ),
    ).toBe(false);
  });
});

describe("tabs that read like a browser's", () => {
  type Place = ReturnType<typeof placeList>[number];
  const browserOf = (place: Place) => {
    if (place.destination.kind !== "browser" || !place.destination.tabId)
      throw new Error("Not a browser tab");
    return { sessionId: place.destination.sessionId, tabId: place.destination.tabId };
  };
  const held = (place: Place) =>
    place.destination.kind === "browser" &&
    (client
      .getSnapshot()
      .browserSessions.find(
        (session) =>
          place.destination.kind === "browser" && session.id === place.destination.sessionId,
      )?.attachedRunIds.length ?? 0) > 0;
  const row = (key: string) => element<HTMLElement>(`.side-tab[data-place-key="${key}"]`);
  const main = (key: string) => element<HTMLButtonElement>(".side-tab__main", row(key));
  const rowKeys = () =>
    [...document.querySelectorAll<HTMLElement>(".side-tab")].map((node) => node.dataset.placeKey);
  const menuLabels = () =>
    [...document.querySelectorAll(".popover [role=menuitem]")].map(
      (item) => item.querySelector(".picker__label")?.textContent,
    );
  const browserMenu = [
    "Reload",
    "Duplicate tab",
    "Open this page in…",
    "Copy link",
    "Add to group",
    "Close tab",
    "Reopen closed tab",
  ];
  async function dispatch(target: EventTarget, event: Event) {
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
    return event;
  }
  const escape = () =>
    dispatch(document, new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  async function choose(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>(".popover [role=menuitem]")].find(
      (node) => node.querySelector(".picker__label")?.textContent === label,
    );
    if (!item) throw new Error(`Missing menu item ${label}`);
    await click(item);
    await settle(60);
  }
  async function hideComputer() {
    await dispatch(
      window,
      new KeyboardEvent("keydown", { bubbles: true, key: ".", metaKey: true }),
    );
    await settle(60);
  }

  it("web tabs first, a hairline, then Mac apps and phones, each in authoritative order, and + New tab last", async () => {
    await mount("/");
    const places = placeList(client.getSnapshot());
    const web = places.filter((place) => place.kind === "browser").map((place) => place.key);
    const native = places.filter((place) => place.kind !== "browser").map((place) => place.key);
    expect(web.length).toBeGreaterThan(1);
    expect(native.length).toBeGreaterThan(0);
    expect(rowKeys()).toEqual([...web, ...native]);
    const items = [...element(".side-section--tabs .side-list").children];
    const lastWeb = items.indexOf(row(web.at(-1)!));
    expect(items[lastWeb + 1]?.classList.contains("side-divider")).toBe(true);
    expect(items[lastWeb + 2]).toBe(row(native[0]!));
    expect(items.at(-1)?.classList.contains("side-new")).toBe(true);
    const webPlaces = places.filter((place) => place.kind === "browser");
    const boundary = webPlaces.findIndex((place, index) => {
      const before = webPlaces[index - 1];
      return (
        before?.browser &&
        place.browser &&
        before.browser.sessionId !== place.browser.sessionId &&
        before.identity?.kind === "profile" &&
        place.identity?.kind === "profile" &&
        before.identity.profileId === place.identity.profileId
      );
    });
    expect(boundary).toBeGreaterThan(0);
    expect(row(webPlaces[boundary - 1]!.key).nextElementSibling).toBe(
      row(webPlaces[boundary]!.key),
    );
    for (const place of webPlaces) {
      const classes = [...row(place.key).classList].filter(
        (name) => !["is-active", "is-match", "is-unavailable"].includes(name),
      );
      expect(classes).toEqual(["side-tab"]);
    }
    // An opened tab sits right after its opener, at the same level as every tab.
    const session = client
      .getSnapshot()
      .browserSessions.find((value) => value.tabCatalog?.tabs.some((tab) => tab.openerId))!;
    const opened = session.tabCatalog!.tabs.find((tab) => tab.openerId)!;
    const openedKey = `browser:${session.id}:${opened.id}`;
    const keys = rowKeys();
    expect(keys[keys.indexOf(openedKey) - 1]).toBe(`browser:${session.id}:${opened.openerId}`);
    expect(row(openedKey).classList.contains("side-tab--popup")).toBe(false);
    // The quiet row opens the start page, and while it is open stands as the active New tab.
    await click(element(".side-new__main"));
    expect(element(".place").className).toContain("place--launcher");
    expect(document.querySelector(".side-new")).toBeNull();
    expect(element(".side-tab--start").classList.contains("is-active")).toBe(true);
  });

  it("the tab in the middle is the active tab, its × always there; in Talk no tab is active", async () => {
    await mount("/");
    expect(document.querySelector(".side-tab.is-active")).toBeNull();
    const place = pageTab();
    await click(main(place.key));
    expect(document.querySelectorAll(".side-tab.is-active")).toHaveLength(1);
    expect(row(place.key).classList.contains("is-active")).toBe(true);
    expect(main(place.key).getAttribute("aria-current")).toBe("true");
    expect(row(place.key).querySelector(".side-tab__close")).not.toBeNull();
    // Its tooltip says the title, profile, computer and site, badge or no badge.
    expect(main(place.key).title).toBe(`${place.title} — Personal · Mac mini\nresy.com`);
    expect(main(place.key).getAttribute("aria-label")).toBe(`${place.title} — Personal · Mac mini`);
    const chip = element<HTMLButtonElement>(".profile-chip");
    expect(chip.title).toBe("");
    expect(chip.getAttribute("aria-label")).toBe("Using Personal. Profile options");
    expect(element(".profile-chip__name", chip).textContent).toBe("Personal");
    expect(chip.textContent).toBe("PPersonal");
    await click(chip);
    expect(element(".chip-menu__where").textContent).toBe("Mac mini");
    await escape();
    await hideComputer();
    expect(document.querySelector(".place")).toBeNull();
    expect(document.querySelector(".side-tab.is-active")).toBeNull();
  });

  it("shows only the profile in the toolbar until its menu names the computer", async () => {
    let busyClient!: MockHostClient;
    await mount("/", {
      hostClient: () => (busyClient = new MockHostClient({ latencyMs: 0, world: "busy" })),
    });
    const guests = placeList(busyClient.getSnapshot()).filter(
      (place) => place.kind === "browser" && place.identity?.kind === "guest",
    );
    for (const computer of ["Mac mini", "Studio Mac"]) {
      const place = guests.find((candidate) => candidate.device?.name === computer);
      expect(place).toBeDefined();
      await click(main(place!.key));
      const chip = element<HTMLButtonElement>(".profile-chip");
      expect(chip.textContent).toBe("Guest");
      expect(chip.title).toBe("");
      expect(element<HTMLElement>(".profile-chip__name", chip).title).toBe("Guest");
      expect(chip.getAttribute("aria-label")).toBe("Using Guest. Profile options");
      expect(chip.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector(".chip-menu__where")).toBeNull();
      await click(chip);
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      expect(element(".chip-menu__where").textContent).toBe(computer);
      await escape();
      expect(document.querySelector(".chip-menu__where")).toBeNull();
    }
  });

  it("middle-click closes a web tab through the Host, asking first when work holds it; app rows ignore it", async () => {
    await mount("/");
    const places = placeList(client.getSnapshot());
    const close = vi.spyOn(client, "closeBrowserTab");
    const quiet = places.find((place) => place.closable && !held(place))!;
    const down = await dispatch(
      main(quiet.key),
      new MouseEvent("mousedown", { bubbles: true, button: 1, cancelable: true }),
    );
    // No autoscroll: the wheel button closes, as on a browser's tab.
    expect(down.defaultPrevented).toBe(true);
    await dispatch(
      main(quiet.key),
      new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
    );
    await settle(100);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]!.slice(0, 2)).toEqual([
      browserOf(quiet).sessionId,
      browserOf(quiet).tabId,
    ]);
    expect(document.querySelector(`.side-tab[data-place-key="${quiet.key}"]`)).toBeNull();
    // Held by live work: the same question as ×, and nothing closes until it is answered.
    const busy = places.find((place) => place.closable && held(place))!;
    await dispatch(
      main(busy.key),
      new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
    );
    expect(element("#tab-close-title").textContent).toBe("Close this tab?");
    expect(element(".dialog .btn--danger").textContent).toBe("Close tab");
    expect(element(".browser-dialog__message").textContent).toBe(
      "An agent is working here. This tab closes for you and for the agent.",
    );
    expect(close).toHaveBeenCalledOnce();
    await click(element(".dialog .btn:not(.btn--danger)"));
    // A Mac app is not closed from here, and nothing else happens either.
    const app = places.find((place) => place.kind === "app")!;
    const before = history.length;
    await dispatch(
      main(app.key),
      new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(history.length).toBe(before);
    expect(row(app.key)).toBeTruthy();

    // The page's own menu asks the shared question and closes only the shown tab.
    await click(main(busy.key));
    await click(element('[aria-label="Browser options"]'));
    expect(menuLabels()).toContain("Close tab");
    expect(menuLabels()).not.toContain("Close browser");
    await choose("Close tab");
    expect(element("#tab-close-title").textContent).toBe("Close this tab?");
    expect(close).toHaveBeenCalledOnce();
    await click(element(".dialog .btn--danger"));
    await settle(150);
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.calls[1]!.slice(0, 2)).toEqual([
      browserOf(busy).sessionId,
      browserOf(busy).tabId,
    ]);
    expect(document.querySelector(`.side-tab[data-place-key="${busy.key}"]`)).toBeNull();
  });

  it("right-click, Shift+F10 and the context-menu key offer Reload · Duplicate tab · Open this page in… · Copy link · Close tab · Reopen closed tab; a task's app gets no menu", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    await mount("/");
    const place = pageTab();
    const before = history.length;
    const opened = await dispatch(
      main(place.key),
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 300 }),
    );
    expect(opened.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(browserMenu);
    expect(history.length).toBe(before);
    await escape();
    expect(document.querySelector(".popover")).toBeNull();
    expect(document.activeElement).toBe(main(place.key));
    for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
      await dispatch(
        main(place.key),
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
      expect(menuLabels()).toEqual(browserMenu);
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      await escape();
      expect(document.activeElement).toBe(main(place.key));
    }
    const app = placeList(client.getSnapshot()).find((value) => value.kind === "app")!;
    await dispatch(
      main(app.key),
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 200 }),
    );
    expect(document.querySelector(".popover")).toBeNull();
  });

  it("Copy link and Duplicate use the candidate read's full address; Duplicate opens it beside and shows it; Reload reaches the row's own tab; Close tab is the Host's", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await mount("/");
    const place = pageTab();
    const { sessionId, tabId } = browserOf(place);
    const full = "https://resy.com/le-petit-jardin?party=4#times";
    const read = client.readBrowserContextCandidate;
    const candidate = vi
      .spyOn(client, "readBrowserContextCandidate")
      .mockImplementation(async (session, tab) => ({ ...(await read(session, tab)), url: full }));
    const openMenu = () =>
      dispatch(
        main(place.key),
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 300,
        }),
      );

    await openMenu();
    await choose("Copy link");
    expect(candidate).toHaveBeenCalledWith(sessionId, tabId);
    expect(writeText).toHaveBeenCalledWith(full);
    expect(document.querySelector(".popover")).toBeNull();
    expect(document.activeElement).toBe(main(place.key));

    const open = vi.spyOn(client, "openBrowserTab");
    const before = history.length;
    await openMenu();
    await choose("Duplicate tab");
    await settle(60);
    expect(open).toHaveBeenCalledWith(sessionId, { url: full });
    const duplicate = await open.mock.results[0]!.value;
    expect(history.length).toBe(before + 1);
    expect(new URLSearchParams(history.at(-1)!.search).get("browserTab")).toBe(duplicate.tabId);
    expect(element(".place").getAttribute("data-place-key")).toBe(
      `browser:${sessionId}:${duplicate.tabId}`,
    );

    // The original is no longer in the middle; Reload still reaches exactly it.
    const send = vi.spyOn(client, "sendBrowserCommand");
    const shown = history.length;
    await openMenu();
    await choose("Reload");
    await settle(60);
    expect(send).toHaveBeenCalledWith(sessionId, { surfaceId: tabId, type: "navigation.reload" });
    expect(history.length).toBe(shown);

    const quiet = placeList(client.getSnapshot()).find(
      (value) => value.closable && !held(value) && value.key !== place.key,
    )!;
    const close = vi.spyOn(client, "closeBrowserTab");
    await dispatch(
      main(quiet.key),
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 300 }),
    );
    await choose("Close tab");
    await settle(150);
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector(`.side-tab[data-place-key="${quiet.key}"]`)).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a long press on touch opens the same menu without opening the tab", async () => {
    await mount("/");
    const place = pageTab();
    const before = history.length;
    const target = main(place.key);
    await dispatch(
      target,
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 60,
        clientY: 300,
        pointerId: 7,
        pointerType: "touch",
      }),
    );
    await settle(650);
    await dispatch(
      target,
      new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "touch" }),
    );
    await click(target);
    expect(menuLabels()).toContain("Close tab");
    expect(history.length).toBe(before);
  });

  it("a loading tab shows a spinner in place of its icon; the toolbar's Reload becomes Stop and stops it", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const { sessionId, tabId } = browserOf(place);
    const spinning = () => row(place.key).querySelector(".place-mark--loading") !== null;
    expect(spinning()).toBe(false);
    expect(element(".browser-controls [aria-label='Reload page']")).toBeTruthy();
    await act(async () => {
      client.sendBrowserCommand(sessionId, {
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
        type: "navigation.reload",
      });
    });
    await settle(60);
    expect(spinning()).toBe(true);
    expect(main(place.key).getAttribute("aria-label")).toContain("loading");
    const send = vi.spyOn(client, "sendBrowserCommand");
    await click(element(".browser-controls [aria-label='Stop loading']"));
    expect(send).toHaveBeenCalledWith(sessionId, { surfaceId: tabId, type: "navigation.stop" });
    await settle(60);
    expect(spinning()).toBe(false);
    expect(element(".browser-controls [aria-label='Reload page']")).toBeTruthy();
    // A load that finishes by itself takes its spinner with it.
    await act(async () => {
      client.sendBrowserCommand(sessionId, {
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
        type: "navigation.reload",
      });
    });
    await settle(60);
    expect(spinning()).toBe(true);
    await settle(1_200);
    expect(spinning()).toBe(false);
  });

  it("the address: a click selects the whole address; Esc restores it and keeps the field; Enter navigates and hands the keyboard on", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const { sessionId, tabId } = browserOf(place);
    const input = element<HTMLInputElement>(".browser-address input");
    expect(element(".browser-address .place-mark")).toBeTruthy();
    expect(element(".browser-address__host").textContent).toBe("resy.com");
    const pageUrl = input.value;
    await dispatch(input, new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await act(async () => input.focus());
    await dispatch(input, new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(".browser-address__display")).toBeNull();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, pageUrl.length]);
    const type = (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("example.org");
    await dispatch(input, new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(input.value).toBe("example.org");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await dispatch(input, new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(input.value).toBe(pageUrl);
    expect(document.activeElement).toBe(input);
    const send = vi.spyOn(client, "sendBrowserCommand");
    await type("example.org");
    await dispatch(
      element(".browser-address"),
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(send).toHaveBeenCalledWith(sessionId, {
      surfaceId: tabId,
      type: "navigation.go",
      url: "https://example.org/",
    });
    // The edit is done: the keyboard goes to the page where it can take it, never to the body.
    expect(document.querySelector(".browser-address__go")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("the window's title follows the place in the middle", async () => {
    await mount("/");
    expect(document.title).toBe("Opensteer");
    const place = pageTab();
    await click(main(place.key));
    expect(document.title).toBe(`${place.title} — Opensteer`);
    await hideComputer();
    expect(document.title).toBe("Opensteer");
  });
});

describe("the place in the middle goes: the tab beside it takes its entry", () => {
  type Place = ReturnType<typeof placeList>[number];
  const order = () => tabOrder(placeList(client.getSnapshot()));
  const tab = (title: string) => {
    const place = order().find((item) => item.title === title);
    if (!place) throw new Error(`Missing tab ${title}`);
    return place;
  };
  const shown = () => document.querySelector<HTMLElement>(".place")?.dataset.placeKey ?? null;
  const row = (key: string) =>
    document.querySelector<HTMLElement>(`.side-tab[data-place-key="${key}"]`);
  const main = (key: string) => element<HTMLButtonElement>(".side-tab__main", row(key)!);
  const session = (place: Place) => {
    if (place.destination.kind !== "browser" || !place.destination.tabId)
      throw new Error("Not a browser tab");
    const { sessionId, tabId } = place.destination;
    const value = client.getSnapshot().browserSessions.find((item) => item.id === sessionId)!;
    return { sessionId, tabId, catalog: value.tabCatalog! };
  };
  async function dispatch(target: EventTarget, event: Event) {
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
  }
  /** A browser ended from outside this window: its own close command, as the Host takes it. */
  const endBrowser = (source: MockHostClient, sessionId: string) =>
    source
      .dispatch({
        type: "browser.session.close",
        sessionId,
        idempotencyKey: `end-browser:${sessionId}`,
      })
      .catch(() => undefined);
  /** Asks, then answers yes when live work holds the browser. */
  async function confirmIfAsked() {
    const confirm = document.querySelector<HTMLButtonElement>(".dialog .btn--danger");
    if (confirm) await click(confirm);
  }
  /** The middle moved on by one replace, the conversation unchanged and no dead page shown. */
  function expectSucceeded(before: number, path: string, next: string | null) {
    if (next === null) expect(element(".place").className).toContain("place--launcher");
    else expect(shown()).toBe(next);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)).toMatchObject({ path, type: "REPLACE" });
    expect(document.querySelector(".place-state")?.textContent ?? "").not.toMatch(/closed/u);
  }

  it("×, middle-click, the tab menu and ⌘W on the tab in the middle each leave it to the tab after it, else before it, as one replace", async () => {
    vi.stubGlobal("opensteerDesktop", {
      getLocalVisibility: async () => true,
      onLocalVisibilityChanged: () => () => undefined,
      setBadgeCount: vi.fn(async () => undefined),
    });
    const threadId = "thr_00000000-0000-4000-8000-000000000903";
    await mount(`/threads/${threadId}`);
    await click(main(tab("Launch brief").key));
    const path = history.at(-1)!.path;
    expect(path).toBe(`/threads/${threadId}`);
    /** × with the keyboard on it: focus goes where the middle goes. */
    const closeButton = async (place: Place) => {
      const close = element<HTMLButtonElement>(".side-tab__close", row(place.key)!);
      close.focus();
      await click(close);
      await confirmIfAsked();
    };
    const closes: readonly (readonly [string, string, (place: Place) => Promise<void>])[] = [
      // The only tab of its browser: the browser closes with it.
      ["Launch brief", "Coffee shortlist", closeButton],
      [
        "Coffee shortlist",
        "Weekend ideas",
        (place) =>
          dispatch(
            main(place.key),
            new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
          ),
      ],
      // Held by live work: asked first, then the same.
      [
        "Weekend ideas",
        "Flight award alerts",
        async (place) => {
          await dispatch(
            main(place.key),
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 40,
              clientY: 300,
            }),
          );
          const item = [...document.querySelectorAll<HTMLElement>(".popover [role=menuitem]")].find(
            (node) => node.querySelector(".picker__label")?.textContent === "Close tab",
          )!;
          await click(item);
          await confirmIfAsked();
        },
      ],
      [
        "Flight award alerts",
        "Q4 roadmap – Linear",
        () =>
          dispatch(
            window,
            new KeyboardEvent("keydown", { bubbles: true, key: "w", metaKey: true }),
          ),
      ],
      // The last web tab: the Mac apps past the hairline are not its neighbours; the tab before it is.
      ["Q4 roadmap – Linear", "PortableFS documentation", closeButton],
    ];
    for (const [closing, next, close] of closes) {
      const place = tab(closing);
      const successor = tab(next).key;
      expect(shown()).toBe(place.key);
      const before = history.length;
      await close(place);
      await settle(60);
      expect(row(place.key)).toBeNull();
      expectSucceeded(before, path, successor);
      if (close === closeButton) expect(document.activeElement).toBe(main(successor));
    }
  });

  it("an agent or another window closing it, or its browser ending, moves the middle the same way; a close elsewhere moves nothing", async () => {
    await mount("/");
    await click(main(tab("Confirm your reservation").key));
    const path = history.at(-1)!.path;
    // Closed by someone else: no control here was used.
    let before = history.length;
    const confirm = session(tab("Confirm your reservation"));
    await act(async () => {
      await client.closeBrowserTab(confirm.sessionId, confirm.tabId, confirm.catalog);
    });
    await settle(60);
    expectSucceeded(before, path, tab("Le Petit Jardin").key);
    // Its whole browser ends: every tab of it goes at once, and the row after all of them takes it.
    const following = tab("Friday dinner").key;
    before = history.length;
    await act(async () => {
      await endBrowser(client, session(tab("Le Petit Jardin")).sessionId);
    });
    await settle(60);
    expect(row(tab("Friday dinner").key)).not.toBeNull();
    expectSucceeded(before, path, following);
    // Another tab closing, by × here or by the Host, leaves the middle and the history alone.
    before = history.length;
    await click(element(".side-tab__close", row(tab("Launch brief").key)!));
    const coffee = session(tab("Coffee shortlist"));
    await act(async () => {
      await client.closeBrowserTab(coffee.sessionId, coffee.tabId, coffee.catalog);
    });
    await settle(60);
    expect(shown()).toBe(following);
    expect(history.length).toBe(before);
  });

  it("passes over a tab that cannot be shown, and with no tab left opens the start page fresh in the entry", async () => {
    const seen = new WeakMap<HostSnapshot, HostSnapshot>();
    let closing = "";
    await mount((source) => {
      const read = source.getSnapshot;
      closing = tabOrder(placeList(read())).find((item) => item.title === "Weekend ideas")!.browser!
        .sessionId;
      // One browser is closing and its saved tabs cannot open: they stay listed, dimmed.
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        let changed = seen.get(snapshot);
        if (!changed) {
          changed = {
            ...snapshot,
            browserSessions: snapshot.browserSessions.map((value) =>
              value.id === closing && value.state === "ready"
                ? { ...value, state: "closing" as const }
                : value,
            ),
            workspaceTabs: snapshot.workspaceTabs?.map((lineage) =>
              lineage.session.id === closing
                ? { ...lineage, unavailableReason: "This browser is closing." }
                : lineage,
            ),
          };
          seen.set(snapshot, changed);
        }
        return changed;
      });
      return "/";
    });
    expect(tab("Weekend ideas").availability).toBe("unavailable");
    await click(main(tab("Coffee shortlist").key));
    let before = history.length;
    await click(element(".side-tab__close", row(tab("Coffee shortlist").key)!));
    await settle(60);
    expectSucceeded(before, "/", tab("Flight award alerts").key);
    // Every other browser ends elsewhere; the middle stays.
    const flight = session(tab("Flight award alerts")).sessionId;
    before = history.length;
    await act(async () => {
      for (const value of client.getSnapshot().browserSessions)
        if (value.state === "ready" && value.id !== flight) await endBrowser(client, value.id);
    });
    await settle(60);
    expect(
      order()
        .filter((place) => place.kind === "browser")
        .map((place) => place.title),
    ).toEqual(["Weekend ideas", "Flight award alerts"]);
    expect(shown()).toBe(tab("Flight award alerts").key);
    expect(history.length).toBe(before);
    // The last tab that can be shown: the start page, though Mac apps are still listed.
    before = history.length;
    await click(element(".side-tab__close", row(tab("Flight award alerts").key)!));
    await settle(80);
    expect(order().some((place) => place.kind === "app")).toBe(true);
    expectSucceeded(before, "/", null);
    expect(new URLSearchParams(history.at(-1)!.search).has("browser")).toBe(false);
    // Opened fresh: nothing to go back to, so Esc leaves the conversation alone.
    await dispatch(
      element(".start-page__input"),
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    await settle(60);
    expect(document.querySelector(".place")).toBeNull();
    expect(new URLSearchParams(history.at(-1)!.search).has("panel")).toBe(false);
  });

  it("an address that names a tab no longer listed — a link or Back — keeps its ended state and moves nowhere", async () => {
    await mount((source) => {
      const place = tabOrder(placeList(source.getSnapshot())).find(
        (item) => item.title === "Launch brief",
      )!;
      if (place.destination.kind !== "browser") throw new Error("Not a browser tab");
      void endBrowser(source, place.destination.sessionId);
      return `/?panel=browser&browser=${place.destination.sessionId}&browserTab=${place.destination.tabId}`;
    });
    await settle(100);
    expect(history).toHaveLength(1);
    expect(element(".place-state").textContent).toContain("This browser was closed");
    // Back to a tab closed while another was shown: the same honest state.
    const coffee = tab("Coffee shortlist");
    await click(main(coffee.key));
    await click(main(tab("Flight award alerts").key));
    await click(element(".side-tab__close", row(coffee.key)!));
    await settle(60);
    const before = history.length;
    await act(async () => {
      void goTo!(-1);
    });
    await settle(100);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.type).toBe("POP");
    expect(shown()).toBe(coffee.key);
    expect(element(".place-state").textContent).toContain("This browser was closed");
  });

  it("a place whose Mac stops being ready stays in the middle saying why, and is there again when it recovers", async () => {
    await mount("/?panel=browser");
    if (!document.querySelector(".start-page"))
      await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    await click(element(".start-tile[aria-label^='Notes on']"));
    await settle(120);
    // Owner and task windows have independent rows and destinations.
    const notes = order().find(
      (place) =>
        place.ownerView?.target.kind === "app" &&
        place.ownerView.target.app.displayName === "Notes",
    )!;
    expect(notes.ownerView).not.toBeNull();
    const taskPlace = order().find(
      (place) =>
        !place.ownerView && place.icon.kind === "app" && place.icon.app.displayName === "Notes",
    )!;
    const task = taskPlace.taskDestination;
    if (task?.kind !== "app" || !task.computerSessionId)
      throw new Error("No task session on Notes");
    const machineId = task.machineId;
    for (const [address, watch] of [
      // The task's own session, as its viewfinder opens it.
      [
        `?panel=browser&computerSession=${task.computerSessionId}&app=${task.appKey}&mac=${machineId}`,
        ".place .computer-watch",
      ],
      // The person's own view of it.
      [
        `?panel=browser&computerView=${notes.ownerView!.viewId}&computerViewGeneration=${notes.ownerView!.generation}&computerWindow=${notes.ownerView!.window!.id}&app=${task.appKey}&mac=${machineId}`,
        ".place .owner-view",
      ],
    ] as const) {
      await act(async () => {
        void goTo!({ pathname: "/", search: address });
      });
      await settle(120);
      expect(shown()).toBe(watch.includes("owner-view") ? notes.key : taskPlace.key);
      expect(document.querySelector(watch)).not.toBeNull();
      const before = { length: history.length, step: history.at(-1) };
      for (const state of ["permission-required", "unavailable"] as const) {
        await act(async () => client.setComputerUseReadiness(machineId, state));
        // Long enough for the task's picture to be asked for again.
        await settle(1_500);
        // The projection drops the task's live address while its Mac is not ready…
        expect(order().find((place) => place.key === notes.key)?.taskDestination).toBeNull();
        // …and the middle keeps it, with its own words for why.
        expect(history.length).toBe(before.length);
        expect(history.at(-1)).toEqual(before.step);
        expect(shown()).toBe(watch.includes("owner-view") ? notes.key : taskPlace.key);
        expect(document.querySelector(watch)).not.toBeNull();
        // The same words in the task's view and the person's own, and no picture behind them.
        expect(element(".place").textContent).toContain(
          state === "permission-required"
            ? `Allow Screen Recording on Mac mini to see ${watch.includes("owner-view") ? notes.title : "Notes"}.`
            : "Mac mini is unavailable.",
        );
        expect(
          document.querySelector(".place .computer-watch__picture, .place .owner-view__image"),
        ).toBeNull();
        await act(async () => client.setComputerUseReadiness(machineId, "ready"));
        await settle(120);
        expect(order().find((place) => place.key === taskPlace.key)?.taskDestination).toEqual(task);
        expect(history.length).toBe(before.length);
        expect(history.at(-1)).toEqual(before.step);
        expect(document.querySelector(watch)).not.toBeNull();
      }
    }
  }, 20_000);
});
