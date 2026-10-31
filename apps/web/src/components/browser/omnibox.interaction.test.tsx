// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { startPageIndex } from "@opensteer/client/host";
import { OmniboxResults, useOmnibox } from "./omnibox.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  client = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["keyboard", "pointer"])(
  "refreshes late icons while %s selection keeps its order and action",
  async (selection) => {
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
    const host = new MockHostClient({ latencyMs: 0 });
    client = host;
    await host.load();
    host.browserPreferences.showSearchSuggestions = false;
    const snapshot = host.getSnapshot();
    const session = snapshot.browserSessions.find((session) => session.profileId)!;
    const choice = { kind: "profile", profileId: session.profileId! } as const;
    const iconRef = "a".repeat(64);
    let finish!: (value: { icons: { iconRef: string; favicon: string }[] }) => void;
    vi.spyOn(host.browserHistory.ports, "get").mockResolvedValue({
      entries: ["alpha", "beta"].map((path) => ({
        url: `https://favicons.example/${path}`,
        title: path,
        typedCount: 1,
        visitCount: 1,
        lastVisitAt: new Date().toISOString(),
      })),
      icons: [{ origin: "https://favicons.example", iconRef }],
    });
    vi.spyOn(host.browserHistory.ports, "icons").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await host.browserHistory.load(choice.profileId);
    const index = startPageIndex({ snapshot, places: [] });
    const choose = vi.fn();
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      const controller = useOmnibox({
        hostClient: host,
        index,
        choice,
        inputRef,
        initialValue: "favicons",
        onChoose: choose,
        onFocusPage: () => undefined,
      });
      return (
        <>
          <input {...controller.inputProps} ref={inputRef} />
          <OmniboxResults controller={controller} hostClient={host} />
        </>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const input = container.querySelector("input")!;
    await act(async () => input.focus());
    const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    const order = () => rows().map((row) => row.id);
    const historyRows = () => rows().filter((row) => row.dataset.historyUrl);
    expect(historyRows()).toHaveLength(2);
    expect(historyRows().map((row) => row.querySelector(".site-mark")?.textContent)).toEqual([
      "",
      "",
    ]);
    await act(async () => {
      if (selection === "keyboard")
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      else historyRows()[0]!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    const active = container.querySelector<HTMLElement>('[aria-selected="true"]')!;
    const before = {
      order: order(),
      selected: active.id,
      value: input.value,
      url: active.dataset.historyUrl,
    };
    expect(before.url).toBeDefined();
    await vi.waitFor(() => expect(host.browserHistory.ports.icons).toHaveBeenCalledOnce());
    const icon = "data:image/png;base64,Ymx1ZQ==";
    await act(async () => {
      finish({ icons: [{ iconRef, favicon: icon }] });
    });
    expect(historyRows().map((row) => row.querySelector("img")?.getAttribute("src"))).toEqual([
      icon,
      icon,
    ]);
    expect(order()).toEqual(before.order);
    expect(container.querySelector('[aria-selected="true"]')?.id).toBe(before.selected);
    expect(input.value).toBe(before.value);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ historyUrl: before.url }));
  },
);

it("revalidates on focus and profile changes, dedupes start-page focus, and fetches only visible icons", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  client = host;
  host.browserPreferences.showSearchSuggestions = false;
  const profiles = host.getSnapshot().browserProfiles;
  const first = profiles[0]!.id;
  const second = profiles[1]!.id;
  const get = vi.spyOn(host.browserHistory.ports, "get").mockResolvedValue({
    entries: Array.from({ length: 30 }, (_, i) => ({
      url: `https://visible${i}.example/`,
      title: "visible",
      typedCount: 1,
      visitCount: 1,
      lastVisitAt: new Date().toISOString(),
    })),
    icons: Array.from({ length: 30 }, (_, i) => ({
      origin: `https://visible${i}.example`,
      iconRef: String(i).padStart(64, "0"),
    })),
  });
  const icons = vi.spyOn(host.browserHistory.ports, "icons").mockResolvedValue({ icons: [] });
  const index = startPageIndex({ snapshot: host.getSnapshot(), places: [] });
  function Harness({
    profileId,
    startPage = false,
  }: {
    profileId: string | null;
    startPage?: boolean;
  }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const controller = useOmnibox({
      hostClient: host,
      index,
      choice: profileId ? { kind: "profile", profileId } : { kind: "guest" },
      inputRef,
      historyActive: startPage,
      initialValue: "visible",
      onChoose: () => undefined,
      onFocusPage: () => undefined,
    });
    return (
      <>
        <input {...controller.inputProps} ref={inputRef} />
        <OmniboxResults controller={controller} hostClient={host} />
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness profileId={first} startPage />));
  expect(get).toHaveBeenCalledExactlyOnceWith(first);
  const input = container.querySelector("input")!;
  await act(async () => input.focus());
  await vi.waitFor(() => expect(icons).toHaveBeenCalledOnce());
  expect(get).toHaveBeenCalledOnce();
  expect(icons.mock.calls[0]![1]).toHaveLength(7);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "visible2",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(get).toHaveBeenCalledOnce();
  await act(async () => root?.render(<Harness profileId={second} startPage />));
  expect(get.mock.calls.map(([profileId]) => profileId)).toEqual([first, second]);
  await act(async () => root?.render(<Harness profileId={null} startPage />));
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => root?.render(<Harness profileId={first} />));
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => input.blur());
  await act(async () => input.focus());
  expect(get).toHaveBeenCalledTimes(4);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  await act(async () => {
    await host.rpc["auth.signOut"]({});
  });
  expect(container.querySelector("[data-history-url]")).toBeNull();
  expect(input.value).toBe("visible2");
});

it.each(["keyboard", "pointer", "completion"])(
  "discards remotely removed history during %s selection",
  async (selection) => {
    const host = new MockHostClient({ latencyMs: 0 });
    client = host;
    await host.load();
    host.browserPreferences.showSearchSuggestions = false;
    const snapshot = host.getSnapshot();
    const profileId = snapshot.browserProfiles[0]!.id;
    const entries = ["alpha", "beta", "gamma"].map((path) => ({
      url: `https://favicons.example/${path}`,
      title: path,
      typedCount: 1,
      visitCount: 1,
      lastVisitAt: new Date().toISOString(),
    }));
    const get = vi
      .spyOn(host.browserHistory.ports, "get")
      .mockResolvedValue({ entries, icons: [] });
    await host.browserHistory.load(profileId);
    const index = startPageIndex({ snapshot, places: [] });
    const choose = vi.fn();
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      const controller = useOmnibox({
        hostClient: host,
        index,
        choice: { kind: "profile", profileId },
        inputRef,
        initialValue: "fav",
        onChoose: choose,
        onFocusPage: () => undefined,
      });
      return (
        <>
          <input {...controller.inputProps} ref={inputRef} />
          <OmniboxResults controller={controller} hostClient={host} />
        </>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const input = container.querySelector("input")!;
    await act(async () => input.focus());
    const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    await act(async () => {
      if (selection === "keyboard")
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      else if (selection === "pointer")
        rows()
          .find((row) => row.dataset.historyUrl === entries[0]!.url)!
          .dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      else {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "favi",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(input.value).toBe("favicons.example/alpha");
    const order = rows()
      .filter((row) => row.dataset.historyUrl !== entries[0]!.url)
      .map((row) => row.id);
    get.mockResolvedValue({ entries: [entries[2]!, entries[1]!], icons: [] });
    await act(async () => {
      host.browserHistory.changed(profileId);
      await host.browserHistory.load(profileId);
    });
    expect(rows().some((row) => row.dataset.historyUrl === entries[0]!.url)).toBe(false);
    expect(input.value).toBe(selection === "completion" ? "favi" : "fav");
    if (selection !== "completion") expect(rows().map((row) => row.id)).toEqual(order);
    get.mockResolvedValue({ entries: [], icons: [] });
    await act(async () => {
      host.browserHistory.changed(profileId);
      await host.browserHistory.load(profileId);
    });
    expect(container.querySelector("[data-history-url]")).toBeNull();
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          kind: "search-web",
          query: selection === "completion" ? "favi" : "fav",
        }),
      }),
    );
  },
);
