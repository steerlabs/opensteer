// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { placeList } from "@opensteer/client/host";
import {
  click,
  client,
  element,
  history,
  mount,
} from "../workspace/workspace.interaction.test-support.js";

/** The seeded browser whose second tab a running task acts in and whose third it opened. */
function taskBrowser() {
  const session = client
    .getSnapshot()
    .browserSessions.find((candidate) =>
      candidate.tabCatalog?.tabs.some((tab) => tab.title === "Le Petit Jardin"),
    )!;
  const [reading, acting, confirm] = session.tabCatalog!.tabs;
  const threadId = acting!.occupants[0]!.threadId;
  const placeKey = (tabId: string) =>
    placeList(client.getSnapshot()).find(
      (place) => place.destination.kind === "browser" && place.destination.tabId === tabId,
    )!.key;
  return { session, threadId, reading: reading!, acting: acting!, confirm: confirm!, placeKey };
}

const shownTab = () => element<HTMLElement>(".browser-view").dataset.browserTab;
const following = () => document.querySelector('[aria-label="Following the agent"]');
const band = () => document.querySelector(".browser-follow-band");

it("follows the docked task's agent in place, pauses for the person's tab and resumes on Follow", async () => {
  await mount(() => {
    const { session, threadId, acting } = taskBrowser();
    return `/threads/${threadId}?panel=browser&browser=${session.id}&browserTab=${acting.id}`;
  });
  const { threadId, reading, acting, confirm, placeKey } = taskBrowser();
  expect(following(), "The agent's own tab never started following").not.toBeNull();
  const stage = element(".browser-view");
  const composer = element("[data-composer-input]");
  const entries = history.length;

  await act(async () => client.actInPlace(threadId, placeKey(reading.id)));
  await vi.waitFor(
    () => expect(shownTab(), "The stage never followed the agent").toBe(reading.id),
    {
      timeout: 3_000,
    },
  );
  expect(element(".browser-view")).toBe(stage);
  expect(element("[data-composer-input]")).toBe(composer);
  expect(history).toHaveLength(entries + 1);
  expect(history.at(-1)!.type).toBe("REPLACE");
  expect(following()).not.toBeNull();
  expect(band()).toBeNull();

  await click(element(`.side-tab[data-place-key="${placeKey(confirm.id)}"] .side-tab__main`));
  expect(shownTab()).toBe(confirm.id);
  expect(following()).toBeNull();
  expect(band()?.textContent).toContain(`Agent is on ${reading.title}`);

  await act(async () => client.actInPlace(threadId, placeKey(acting.id)));
  expect(shownTab(), "A paused stage followed the agent").toBe(confirm.id);
  expect(band()?.textContent).toContain(`Agent is on ${acting.title}`);

  await click(element('button[aria-label="Follow the agent"]'));
  expect(shownTab()).toBe(acting.id);
  expect(following()).not.toBeNull();
  expect(band()).toBeNull();
});

it("leaves the stage alone with the conversation put away", async () => {
  await mount(() => {
    const { session, threadId, acting } = taskBrowser();
    return `/threads/${threadId}?panel=browser&browser=${session.id}&browserTab=${acting.id}`;
  });
  const { threadId, reading, placeKey } = taskBrowser();
  await click(element('button[aria-label="Hide the conversation"]'));
  expect(following()).toBeNull();
  await act(async () => client.actInPlace(threadId, placeKey(reading.id)));
  expect(band()).toBeNull();
});
