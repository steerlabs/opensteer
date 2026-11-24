// @vitest-environment happy-dom
import {
  mockAgentWorkThreads,
  mockConnectedAgents,
  type MockAgentWorkLiveScene,
} from "@opensteer/client/mock";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { client, history, mount, resize } from "./workspace/workspace.interaction.test-support.js";

const options = (livePanel?: MockAgentWorkLiveScene) => ({
  mock: mockConnectedAgents("seeded"),
  hostClient: (source: typeof client) => {
    if (livePanel) source.mockAgentWork({ livePanel });
    return source;
  },
});
const button = (label: string, parent: ParentNode = document) =>
  [...parent.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );
const panel = () => document.querySelector<HTMLElement>('[role="dialog"].agents-now-panel');
const trigger = () => document.querySelector<HTMLButtonElement>(".agents-now__trigger");
async function openPanel() {
  const opener = trigger()!;
  vi.spyOn(opener, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  await act(async () => opener.click());
  expect(panel()).not.toBeNull();
  return panel()!;
}
const stopCommands = (calls: readonly Parameters<typeof client.dispatch>[]) =>
  calls.map(([command]) => command).filter((command) => command.type === "agent.session.stop");

it("reserves no row, panel or pill when connected agents are idle", async () => {
  await mount("/", options());
  expect(document.querySelector(".agents-now")).toBeNull();
  expect(panel()).toBeNull();
  await act(async () => button("Collapse sidebar")!.click());
  expect(document.querySelector(".agents-now")).toBeNull();
});

it("names one agent’s place above Tasks and stops the session shown in the panel", async () => {
  await mount("/", options("one"));
  await vi.waitFor(() =>
    expect(trigger()?.getAttribute("aria-label")).toBe("ChatGPT is working in Shopping"),
  );
  expect(trigger()?.closest("#app-sidebar")).not.toBeNull();
  const dialog = await openPanel();
  expect(dialog.textContent).toContain("Studio Mac");
  expect(dialog.textContent).toContain("Run a script on Shopping");
  const threadId = mockAgentWorkThreads.shopping;
  const sessionId = client.getSnapshot().threads.find(({ id }) => id === threadId)!.agentSessionId;
  const dispatch = vi.spyOn(client, "dispatch");
  await act(async () => button("Stop ChatGPT", dialog)!.click());
  expect(stopCommands(dispatch.mock.calls)).toEqual([
    {
      type: "agent.session.stop",
      threadId,
      agentSessionId: sessionId,
      idempotencyKey: expect.stringMatching(new RegExp(`^agent-session-stop:${sessionId}`)),
    },
  ]);
  await vi.waitFor(() => expect(trigger()).toBeNull());
});

it("lists each active agent and sends Stop all once per session", async () => {
  await mount("/", options("three"));
  expect(trigger()?.getAttribute("aria-label")).toBe("3 agents working");
  const dialog = await openPanel();
  for (const name of ["ChatGPT", "Claude", "Grok"]) {
    expect(button(`Watch ${name}`, dialog)).toBeDefined();
    expect(button(`Stop ${name}`, dialog)).toBeDefined();
  }
  expect(dialog.querySelector("a")?.getAttribute("href")).toBe("/settings/external-agents");
  const dispatch = vi.spyOn(client, "dispatch");
  await act(async () => button("Stop all", dialog)!.click());
  expect(
    stopCommands(dispatch.mock.calls)
      .map(({ threadId }) => threadId)
      .sort(),
  ).toEqual(
    [
      mockAgentWorkThreads.working,
      mockAgentWorkThreads.waiting,
      mockAgentWorkThreads.shopping,
    ].sort(),
  );
  await vi.waitFor(() => expect(panel()).toBeNull());
});

it("names only the agent whose Stop was not confirmed in a batch", async () => {
  await mount("/", options("three"));
  const dialog = await openPanel();
  const send = client.dispatch.bind(client);
  vi.spyOn(client, "dispatch").mockImplementation((command) =>
    command.type === "agent.session.stop" && command.threadId === mockAgentWorkThreads.working
      ? Promise.reject(new Error("Test command failure"))
      : send(command),
  );
  await act(async () => button("Stop all", dialog)!.click());
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain(
    "Couldn’t confirm Stop for Claude.",
  );
  expect(dialog.querySelectorAll("li")).toHaveLength(1);
});

it("opens the existing task activity when the person watches an agent", async () => {
  await mount("/", options("three"));
  const dialog = await openPanel();
  await act(async () => button("Watch ChatGPT", dialog)!.click());
  expect(history.at(-1)?.path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  await vi.waitFor(() =>
    expect(document.querySelector(".session-activity")?.textContent).toContain(
      "Run a script on Shopping",
    ),
  );
});

it("shows Review for the waiting agent and opens that Request", async () => {
  await mount("/", options("needs-you"));
  expect(trigger()?.getAttribute("aria-label")).toBe("Claude needs you · 2 working");
  const dialog = await openPanel();
  expect(button("Watch Claude", dialog)).toBeUndefined();
  expect(dialog.textContent).toContain("Run a script in Travel?");
  await act(async () => button("Review Claude", dialog)!.click());
  expect(panel()).toBeNull();
  await vi.waitFor(() =>
    expect(document.querySelector(".operation-request")?.textContent).toContain(
      "Run a script in Travel?",
    ),
  );
});

it("returns focus from the panel to the trigger on Escape", async () => {
  await mount("/", options("three"));
  const dialog = await openPanel();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("puts a single compact control in the header while the sidebar is closed", async () => {
  await mount("/", options("three"));
  const compact = () => document.querySelector(".agents-now--compact");
  expect(compact()).toBeNull();
  await act(async () => button("Collapse sidebar")!.click());
  expect(compact()?.parentElement?.closest("header")).not.toBeNull();
  expect(document.querySelectorAll(".agents-now")).toHaveLength(1);
  await openPanel();
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button.sidebar__restore")!.click(),
  );
  expect(compact()).toBeNull();
  expect(panel()).toBeNull();
  await resize(728);
  expect(compact()).not.toBeNull();
  const drawerButton = document.querySelector<HTMLButtonElement>(
    'button[aria-controls="app-sidebar"].drawer-btn',
  )!;
  await act(async () => drawerButton.click());
  await vi.waitFor(() => expect(compact()).toBeNull());
  expect(trigger()?.closest("#app-sidebar")).not.toBeNull();
});
