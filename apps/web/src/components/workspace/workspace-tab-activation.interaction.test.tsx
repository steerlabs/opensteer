// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import { placeList } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { click, client, element, mount } from "./workspace.interaction.test-support.js";

it("opens once across failed-restore snapshots, then retries on Retry and re-selection", async () => {
  let activate!: MockInstance<MockHostClient["activateWorkspaceTab"]>;
  let tabId = "";
  await mount((source) => {
    const saved = source.scriptDormantBrowser({ profileName: "Work" });
    tabId = saved.tabId;
    activate = vi.spyOn(source, "activateWorkspaceTab");
    return `/?panel=browser&browser=${saved.sessionId}&browserTab=${saved.tabId}`;
  });
  await act(async () => client.finishBrowserActivation("The browser could not start."));
  for (let revision = 0; revision < 10; revision++)
    await act(async () => client.setDormantBrowserState({ restoring: true }));
  expect(activate).toHaveBeenCalledTimes(1);
  const firstOpening = activate.mock.calls[0]![1]?.opening;
  expect(firstOpening).toEqual(expect.any(String));
  await click(element(".place-state .btn"));
  expect(activate).toHaveBeenCalledTimes(2);
  const retryOpening = activate.mock.calls[1]![1]?.opening;
  expect(retryOpening).not.toBe(firstOpening);
  await act(async () => client.finishBrowserActivation("Still unavailable."));
  const place = placeList(client.getSnapshot()).find((item) => item.workspaceTab?.id === tabId)!;
  await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
  expect(activate).toHaveBeenCalledTimes(3);
  expect(activate.mock.calls[2]![1]?.opening).not.toBe(retryOpening);
});
