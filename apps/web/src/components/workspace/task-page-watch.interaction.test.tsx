// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { mockAgentWorkThreads, mockConnectedAgents } from "@opensteer/client/mock";
import { threadAgentPage } from "@opensteer/client/host";
import {
  click,
  client,
  element,
  history,
  mount,
  settle,
} from "./workspace.interaction.test-support.js";

/*
 * Watch on a task whose agent is working in a browser tab: the person's click lands on that tab's
 * live picture, beside the task. Only their click: nothing else moves their tab.
 */
const button = (label: string, parent: ParentNode = document) =>
  [...parent.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );

async function watch(
  scene: "one" | "three" | "cloud-tab" | "two-tabs" | "late-tab",
  name?: string,
  prepare?: (source: typeof client) => void,
) {
  await mount("/", {
    mock: mockConnectedAgents("seeded"),
    hostClient: (source) => {
      source.mockAgentWork({ livePanel: scene });
      prepare?.(source);
      return source;
    },
  });
  const opener = document.querySelector<HTMLButtonElement>(".agents-now__trigger")!;
  vi.spyOn(opener, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  await act(async () => opener.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"].agents-now-panel')!;
  const watching =
    (name && button(name, dialog)) ||
    [...dialog.querySelectorAll("button")].find((entry) =>
      (entry.getAttribute("aria-label") ?? "").startsWith("Watch "),
    )!;
  await act(async () => watching.click());
}

it.each([
  ["a browser on a Mac", "one"],
  ["the Cloud Computer's own pooled browser", "cloud-tab"],
] as const)(
  "lands Watch on the live picture of the browser tab the task's agent is working in, in %s",
  async (_, scene) => {
    await watch(scene);
    const page = threadAgentPage(client.getSnapshot(), mockAgentWorkThreads.shopping);
    expect(page).not.toBeNull();
    expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
    expect(new URLSearchParams(history.at(-1)?.search).get("tab")).toBe(page!.tabId);
    await vi.waitFor(() =>
      expect(document.querySelector(".place--page, .place--launcher")).not.toBeNull(),
    );
    expect(document.querySelector(".place--launcher")).toBeNull();
    // The task's activity stays beside the picture.
    await vi.waitFor(() =>
      expect(document.querySelector(".session-activity")?.textContent).toContain(
        "Run a script on Shopping",
      ),
    );
  },
);

it("opens a task whose agent holds no browser tab as before: the task, its tab list unchanged", async () => {
  await watch("three", "Watch ChatGPT");
  expect(threadAgentPage(client.getSnapshot(), mockAgentWorkThreads.shopping)).toBeNull();
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  expect(new URLSearchParams(history.at(-1)?.search).has("tab")).toBe(false);
});

for (const acting of [false, true])
  it(`lands Watch on ${acting ? "the Mac app the agent is acting in now" : "the page"} when the task's agent holds both a browser page and a Mac app${acting ? "" : " it is not acting in"}`, async () => {
    // The order: a Mac app it is acting in right now (the only "used last" the Home says), then
    // its page, then a Mac app it holds, then the task alone.
    await watch("one", undefined, (source) =>
      source.mockComputerUseSessionTask(mockAgentWorkThreads.shopping, {
        actingAppKeys: acting ? ["com.apple.notes"] : [],
      }),
    );
    const page = threadAgentPage(client.getSnapshot(), mockAgentWorkThreads.shopping)!;
    expect(page).not.toBeNull();
    expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
    const search = new URLSearchParams(history.at(-1)?.search);
    if (acting) {
      expect(search.get("panel")).toBe("browser");
      expect(search.has("tab")).toBe(false);
      await vi.waitFor(() => expect(document.querySelector(".place--watch")).not.toBeNull());
      expect(document.querySelector(".place--watch")?.textContent).toContain("is using Notes");
    } else {
      expect(search.get("tab")).toBe(page.tabId);
      await vi.waitFor(() => expect(document.querySelector(".place")).not.toBeNull());
      expect(document.querySelector(".place--watch")).toBeNull();
    }
  });

/** The tab the address shows now, if any. */
const shownTab = () => new URLSearchParams(history.at(-1)?.search).get("tab");

it("lands Watch on the tab the task's work took up last, of the two it holds", async () => {
  // Tester run 15, trials 2, 4, 6 and 7: an earlier tab, and the one its call works in now.
  await watch("two-tabs");
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  expect(shownTab()).toBe("mock-tab-1-0");
});

it("lands Watch on the task's tab when the row naming it reaches this client after the click", async () => {
  // Run 15, trial 5: the click came before the row; Watch read once and stayed on the launcher.
  await watch("late-tab");
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  expect(shownTab()).toBeNull();
  await vi.waitFor(() => expect(shownTab()).toBe("mock-tab-1-0"), { timeout: 4_000 });
});

it("follows the task's work to its next tab while the person chooses nothing else, and never after they do", async () => {
  await watch("two-tabs");
  expect(shownTab()).toBe("mock-tab-1-0");
  await act(async () => client.mockAgentTakesTab("mock-tab-2-0", mockAgentWorkThreads.shopping));
  await vi.waitFor(() => expect(shownTab()).toBe("mock-tab-2-0"));
  // The person chooses a tab themselves: from now on the agent's work moves nothing.
  await click(element('.side-tab[data-place-key="mock-tab-0-1"] .side-tab__main'));
  const chosen = shownTab();
  expect(chosen).not.toBe("mock-tab-2-0");
  await act(async () => client.mockAgentTakesTab("mock-tab-1-0", mockAgentWorkThreads.shopping));
  await settle();
  expect(shownTab()).toBe(chosen);
});

/** A direct operation's id, as the Home names one. */
const op = (n: number) => `aop_00000000-0000-4000-8000-00000000000${n}`;

/*
 * Watch reads one field: the tab the Home says the task's connected agent is working in now
 * (`workingIn`). Its holder records and their times are only the fallback when it names none.
 */
it("lands Watch on the tab the Home says the agent works in, even one the task holds no record of", async () => {
  // Run 16: a script kept its page handle and the task held no record of the tab it worked in.
  await watch("two-tabs", undefined, (source) =>
    source.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-0-1", op(1)),
  );
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  expect(shownTab()).toBe("mock-tab-0-1");
});

it("lands Watch where the agent works when the Home says so after the click", async () => {
  await watch("late-tab");
  expect(shownTab()).toBeNull();
  await act(async () =>
    client.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-0-1", op(1)),
  );
  await vi.waitFor(() => expect(shownTab()).toBe("mock-tab-0-1"), { timeout: 4_000 });
});

it("follows workingIn from one tab to the next while the person chooses nothing else, and never after they do", async () => {
  await watch("two-tabs", undefined, (source) =>
    source.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-2-0", op(1)),
  );
  expect(shownTab()).toBe("mock-tab-2-0");
  // A later call works on an earlier tab: the field moves, and so does the pane.
  await act(async () =>
    client.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-1-0", op(2)),
  );
  await vi.waitFor(() => expect(shownTab()).toBe("mock-tab-1-0"));
  await click(element('.side-tab[data-place-key="mock-tab-0-1"] .side-tab__main'));
  const chosen = shownTab();
  expect(chosen).not.toBe("mock-tab-1-0");
  await act(async () =>
    client.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-2-0", op(3)),
  );
  await settle();
  expect(shownTab()).toBe(chosen);
});

it("falls back to the page the task holds once the Home says the session's work has ended", async () => {
  await watch("two-tabs", undefined, (source) => {
    source.mockAgentWorksIn(mockAgentWorkThreads.shopping, "mock-tab-0-1", op(1));
    source.mockAgentWorksIn(mockAgentWorkThreads.shopping, null);
  });
  expect(shownTab()).toBe("mock-tab-1-0");
});
