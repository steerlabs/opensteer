// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { placeList } from "@opensteer/client/host";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
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
      (candidate.browserTabs?.sessionTabs(candidate?.id) ?? []).some(
        (tab) => tab.title === "Le Petit Jardin",
      ),
    )!;
  const [reading, acting, confirm] = session.browserTabs?.sessionTabs(session?.id) ?? [];
  const threadId = acting!.occupants[0]!.threadId;
  const placeKey = (tabId: string) =>
    placeList(client.getSnapshot()).find(
      (place) => place.destination.kind === "browser" && place.destination.tabId === tabId,
    )!.key;
  return { session, threadId, reading: reading!, acting: acting!, confirm: confirm!, placeKey };
}

const shownTab = () => element<HTMLElement>(".browser-view").dataset.browserTab;
const following = () => document.querySelector('[aria-label="Following the agent"]');
const liveCard = () => document.querySelector(".conv-header .viewfinder");

it("follows the docked task's agent in place, stops for the person's tab and follows again from its live card", async () => {
  await mount(() => {
    const { session, threadId, acting } = taskBrowser();
    return `/threads/${threadId}?panel=browser&browser=${session.id}&browserTab=${acting.id}`;
  });
  const { session, threadId, reading, acting, confirm, placeKey } = taskBrowser();
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
  expect(liveCard(), "The live card repeated the page already in front").toBeNull();

  await click(element(`.side-tab[data-place-key="${placeKey(confirm.id)}"] .side-tab__main`));
  expect(shownTab()).toBe(confirm.id);
  expect(following()).toBeNull();

  // The Run's place reaches the live card before the tab catalog's occupancy does.
  const run = client
    .getSnapshot()
    .runQueue.find((entry) => entry.threadId === threadId && entry.status === "running")!;
  await act(async () =>
    client.enterPlace(run.id, threadId, {
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(session.id),
        surfaceId: BrowserSurfaceIdSchema.parse(acting.id),
      },
      title: acting.title,
      site: null,
    }),
  );
  expect(shownTab(), "A stage the person took over followed the agent").toBe(confirm.id);
  expect(liveCard()?.getAttribute("aria-label")).toBe(`Show ${acting.title}`);

  await click(liveCard()!);
  expect(shownTab()).toBe(acting.id);
  expect(following(), "The live card did not start following").not.toBeNull();
  expect(liveCard()).toBeNull();

  await act(async () => client.actInPlace(threadId, placeKey(acting.id)));
  await act(async () => client.actInPlace(threadId, placeKey(reading.id)));
  await vi.waitFor(
    () => expect(shownTab(), "The live card never started following again").toBe(reading.id),
    { timeout: 3_000 },
  );
});

it("leaves the stage alone with the conversation put away", async () => {
  await mount(() => {
    const { session, threadId, acting } = taskBrowser();
    return `/threads/${threadId}?panel=browser&browser=${session.id}&browserTab=${acting.id}`;
  });
  const { threadId, reading, acting, placeKey } = taskBrowser();
  await click(element('button[aria-label="Hide the conversation"]'));
  expect(following()).toBeNull();
  await act(async () => client.actInPlace(threadId, placeKey(reading.id)));
  expect(shownTab()).toBe(acting.id);
});
