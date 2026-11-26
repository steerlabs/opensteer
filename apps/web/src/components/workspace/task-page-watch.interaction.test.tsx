// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { mockAgentWorkThreads, mockConnectedAgents } from "@opensteer/client/mock";
import { threadAgentPage } from "@opensteer/client/host";
import { client, history, mount } from "./workspace.interaction.test-support.js";

/*
 * Watch on a task whose agent is working in a browser tab: the person's click lands on that tab's
 * live picture, beside the task. Only their click: nothing else moves their tab.
 */
const button = (label: string, parent: ParentNode = document) =>
  [...parent.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );

async function watch(
  scene: "one" | "three" | "cloud-tab",
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
