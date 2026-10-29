// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type {
  DesktopWorkspaceTabCommand,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { placeList } from "@opensteer/client/host";
import {
  client,
  history,
  mount,
  element,
  click,
  pageTab,
  tabSearch,
  settle,
} from "./workspace.interaction.test-support.js";
import { tabOrder } from "./tab-order.js";

let execute: ((command: DesktopWorkspaceTabCommand) => void) | undefined;
const bridge = {
  onWorkspaceTabCommand: (listener: typeof execute) => {
    execute = listener;
    return () => {
      execute = undefined;
    };
  },
  setBadgeCount: async () => undefined,
  onLocalVisibilityChanged: () => () => undefined,
  getLocalVisibility: async () => true,
  browserIsLocal: async () => false,
  browserWindowFocused: async () => true,
} as unknown as OpensteerDesktopBridge;
vi.mock("../../desktop/desktop-bridge.js", async (original) => ({
  ...(await original<typeof import("../../desktop/desktop-bridge.js")>()),
  desktopBridge: () => bridge,
}));
async function command(value: DesktopWorkspaceTabCommand) {
  expect(execute).toBeDefined();
  await act(async () => execute!(value));
  await settle();
}
const selected = () => document.querySelector(".place")?.getAttribute("data-place-key");

it("new and close commands across composer, address and sidebar preserve the draft and never create threads", async () => {
  await mount((source) => `/${tabSearch(pageTab(source))}`);
  const initial = tabOrder(placeList(client.getSnapshot()));
  const quiet = initial.filter(
    (place) =>
      place.closable &&
      place.destination.kind === "browser" &&
      client
        .getSnapshot()
        .browserSessions.find(
          (session) =>
            place.destination.kind === "browser" && session.id === place.destination.sessionId,
        )?.attachedRunIds.length === 0,
  );
  expect(quiet.length).toBeGreaterThanOrEqual(2);
  const threads = client.getSnapshot().threads.map((thread) => thread.id);
  const close = vi.spyOn(client, "closeBrowserTab");
  const field = element<HTMLTextAreaElement>("[data-composer-input]");
  field.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      "Keep this draft",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(element(`.side-tab[data-place-key="${quiet[0]!.key}"] .side-tab__main`));
  await command({ type: "new-tab" });
  expect(document.activeElement).toBe(element(".start-page__input"));
  await command({ type: "close-tab" });
  expect(document.querySelector(".side-tab--start")).toBeNull();
  expect(selected()).toBe(quiet[0]!.key);
  expect(close).not.toHaveBeenCalled();
  field.focus();
  await command({ type: "close-tab" });
  expect(close).toHaveBeenCalledTimes(1);
  expect(selected()).toBe(
    initial[initial.findIndex((place) => place.key === quiet[0]!.key) + 1]!.key,
  );
  expect(field.value).toBe("Keep this draft");
  await click(element(`.side-tab[data-place-key="${quiet[1]!.key}"] .side-tab__main`));
  const send = vi.spyOn(client, "sendBrowserCommand");
  element<HTMLElement>("[data-live-page] textarea").focus();
  await command({ type: "close-tab" });
  expect(close).toHaveBeenCalledTimes(2);
  expect(
    send.mock.calls.some(
      ([, command]) => command.type === "input.key" && command.key.toLowerCase() === "w",
    ),
  ).toBe(false);
  expect(client.getSnapshot().threads.map((thread) => thread.id)).toEqual(threads);
  expect(field.value).toBe("Keep this draft");
});

it("number and cycle commands select exactly their tab while editing chords leave navigation, tabs and threads alone", async () => {
  await mount((source) => `/${tabSearch(pageTab(source))}`);
  const field = element<HTMLTextAreaElement>("[data-composer-input]");
  field.focus();
  const places = tabOrder(placeList(client.getSnapshot()));
  const threads = client.getSnapshot().threads.map((thread) => thread.id);
  for (let index = 1; index <= 9; index++) {
    if (index === 5) element<HTMLElement>(".side-tab__main").focus();
    await command({ type: "select-tab", index });
    const expected = index === 9 ? places.at(-1) : places[index - 1];
    if (expected) expect(selected()).toBe(expected.key);
  }
  await command({ type: "next-tab" });
  expect(selected()).toBe(places[0]!.key);
  await command({ type: "previous-tab" });
  expect(selected()).toBe(places.at(-1)!.key);
  const before = [...history];
  for (const key of ["a", "c", "v", "z", "l", "t", "w"]) {
    await act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, metaKey: true }),
      ),
    );
  }
  expect(history).toEqual(before);
  expect(tabOrder(placeList(client.getSnapshot())).map((place) => place.key)).toEqual(
    places.map((place) => place.key),
  );
  expect(client.getSnapshot().threads.map((thread) => thread.id)).toEqual(threads);
});
