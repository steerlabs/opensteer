// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import { placeList } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { click, client, element, mount } from "./workspace.interaction.test-support.js";

/*
 * Ways selecting a tab can fail: activation repeats on every republished row,
 * a failure leaves the middle blank with no way back, or Retry and choosing
 * the tab again do nothing.
 */
it("activates a selected tab once across republished rows, then again on Try again and re-selection", async () => {
  let activate!: MockInstance<MockHostClient["activateTab"]>;
  let tabId = "";
  await mount((source) => {
    const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
    tabId = page.key;
    activate = vi
      .spyOn(source, "activateTab")
      .mockRejectedValueOnce(new Error("The browser could not start."))
      .mockRejectedValueOnce(new Error("Still unavailable."));
    return `/?panel=browser&tab=${tabId}`;
  });
  // Selecting a tab is the person's Open: only it, Try again and choosing it again may wake a phone.
  expect(activate).toHaveBeenCalledExactlyOnceWith(tabId, asked(true));
  // The tab's own fact, never the exception's text.
  expect(element(".place-state").textContent).toContain("This tab could not open.");
  expect(element(".place-state").textContent).not.toContain("The browser could not start.");
  for (let revision = 0; revision < 10; revision++)
    await act(async () => client.setBrowserLoading(tabId, revision % 2 === 0));
  expect(activate).toHaveBeenCalledTimes(1);

  await click(element(".place-state .btn"));
  expect(activate).toHaveBeenCalledTimes(2);
  expect(element(".place-state").textContent).toContain("This tab could not open.");

  const other = placeList(client.getSnapshot()).find(
    (place) => place.key !== tabId && place.kind === "window",
  )!;
  await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
  await click(element(`.side-tab[data-place-key="${tabId}"] .side-tab__main`));
  expect(activate.mock.calls).toEqual(
    [tabId, tabId, other.key, tabId].map((id) => [id, asked(true)]),
  );
  expect(document.querySelector(".place-state .btn")).toBeNull();
});

it("asks again for a tab it shows that is not open, so a sleep under the Home's answer never leaves it unopened (TS10)", async () => {
  let activate!: MockInstance<MockHostClient["activateTab"]>;
  let tabId = "";
  await mount((source) => {
    const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
    tabId = page.key;
    activate = vi.spyOn(source, "activateTab");
    return `/?panel=browser&tab=${tabId}`;
  });
  await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  // The Home answered with the page; the runtime had just put the tab to sleep.
  await act(async () => client.setBrowserTabState(tabId, "suspended"));
  await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
  // Asking again spends no Open: it wakes the tab, not a phone.
  expect(activate).toHaveBeenLastCalledWith(tabId, asked(false));
  await act(async () => client.setBrowserTabState(tabId, "live"));
  expect(activate).toHaveBeenCalledTimes(2);
});

/** An ask as the place stage sends it: the person's Open or not, and its answer's reader (V8). */
const asked = (wake: boolean) => ({ wake, answered: expect.any(Function) });

/*
 * V8: an ask has an identity, and what follows it is decided by its answer and the tab's row,
 * never by timing. The old rule asked again whenever the row said asleep under a shown page: an
 * answer that beat the row's own news asked twice, and a tab that slept under the answer itself
 * was left on a dead page with nothing to press.
 */
function answering(state: "open" | "asleep") {
  let tabId = "";
  let activate!: MockInstance<MockHostClient["activateTab"]>;
  return {
    mount: () =>
      mount((source) => {
        const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
        tabId = page.key;
        const real = source.activateTab.bind(source);
        activate = vi.spyOn(source, "activateTab").mockImplementation(async (id, options) => {
          const viewer = await real(id, { wake: options?.wake ?? false });
          // The row this device holds still says asleep when the answer lands.
          source.setBrowserTabState(id, "suspended");
          options?.answered?.({ ...source.getSnapshot().tabs.get(id)!, state });
          return viewer;
        });
        return `/?panel=browser&tab=${tabId}`;
      }),
    get tabId() {
      return tabId;
    },
    get activate() {
      return activate;
    },
  };
}

it("asks once when its answer beats the row's own news that the tab is open (V8)", async () => {
  const run = answering("open");
  await run.mount();
  await vi.waitFor(() => expect(run.activate).toHaveBeenCalledTimes(1));
  // The answer found the tab open; the row has said nothing since: the answer is the newer word.
  await act(async () => {});
  expect(run.activate).toHaveBeenCalledTimes(1);
  await act(async () => client.setBrowserTabState(run.tabId, "live"));
  expect(run.activate).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("went back to sleep");
});

it("shows a tab its answer found asleep with Try again, and asks nothing by itself (V8)", async () => {
  const run = answering("asleep");
  await run.mount();
  await vi.waitFor(() => expect(run.activate).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("This tab went back to sleep before it opened."),
  );
  for (let turn = 0; turn < 4; turn++) await act(async () => {});
  expect(run.activate).toHaveBeenCalledTimes(1);
  // Try again is the person's Open: it wakes, and asks once.
  run.activate.mockRestore();
  const again = vi.spyOn(client, "activateTab");
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Try again",
  )!;
  await click(button);
  await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1));
  expect(again).toHaveBeenCalledWith(run.tabId, asked(true));
  await act(async () => client.setBrowserTabState(run.tabId, "live"));
  await vi.waitFor(() =>
    expect(document.body.textContent).not.toContain("went back to sleep before it opened"),
  );
  expect(again).toHaveBeenCalledTimes(1);
});

it("never wakes a tab while the page is hidden, and asks for it the moment the page is seen", async () => {
  let activate!: MockInstance<MockHostClient["activateTab"]>;
  let tabId = "";
  await mount((source) => {
    const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
    tabId = page.key;
    activate = vi.spyOn(source, "activateTab");
    return `/?panel=browser&tab=${tabId}`;
  });
  await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    // Left in a background tab, the client lets its viewer go and the Home puts the tab to sleep.
    await act(async () => client.setBrowserTabState(tabId, "suspended"));
    for (let turn = 0; turn < 4; turn++) await act(async () => {});
    expect(activate, "a hidden page woke the tab nobody can see").toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenLastCalledWith(tabId, asked(false));
  } finally {
    visibility.mockRestore();
    document.dispatchEvent(new Event("visibilitychange"));
  }
});
