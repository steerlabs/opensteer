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
    const host = new MockHostClient({ latencyMs: 0 });
    client = host;
    await host.load();
    host.browserPreferences.showSearchSuggestions = false;
    const snapshot = host.getSnapshot();
    const session = snapshot.browserSessions.find((session) => session.profileId)!;
    const choice = { kind: "profile", profileId: session.profileId! } as const;
    const tab = session.tabCatalog!.tabs.find((tab) => tab.iconRef)!;
    let finish!: (icon: string) => void;
    vi.spyOn(host, "readBrowserTabIcon").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    host.recentSites.record(choice, "https://favicons.example/alpha", host.recentSites.epoch, {
      tab: { sessionId: session.id, tabId: tab.id },
    });
    host.recentSites.record(choice, "https://favicons.example/beta", host.recentSites.epoch);
    expect(host.readBrowserTabIcon).toHaveBeenCalledOnce();
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
    const icon = "data:image/png;base64,Ymx1ZQ==";
    await act(async () => {
      host.recentSites.record(choice, "https://favicons-new.example/", host.recentSites.epoch);
      finish(icon);
    });
    expect(host.recentSites.history(choice).map((entry) => entry.favicon)).toEqual([
      undefined,
      icon,
      icon,
    ]);
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
