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
  expect(activate).toHaveBeenCalledExactlyOnceWith(tabId, { wake: true });
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
    [tabId, tabId, other.key, tabId].map((id) => [id, { wake: true }]),
  );
  expect(document.querySelector(".place-state .btn")).toBeNull();
});
