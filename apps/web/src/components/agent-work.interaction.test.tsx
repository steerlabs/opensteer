// @vitest-environment happy-dom
import {
  MockHostClient,
  mockAgentOperationRequestId,
  mockAgentWorkThreads,
  mockConnectedAgents,
} from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "./app-shell.js";
import type { SettingsView } from "./settings/primitives.js";
import { ExternalAgentsSection } from "./settings/sections/external-agents.js";
import { placeList } from "@opensteer/client/host";
import { client, goTo, mount, tabSearch } from "./workspace/workspace.interaction.test-support.js";

const withAgentWork = (source: MockHostClient) => {
  source.mockAgentWork();
  return source;
};
const options = { mock: mockConnectedAgents("seeded"), hostClient: withAgentWork };
const task = (id: string) => `/tasks/${encodeURIComponent(id)}`;
const button = (name: string | RegExp) =>
  [...document.querySelectorAll("button")].find((entry) =>
    typeof name === "string"
      ? entry.textContent?.trim() === name
      : name.test(entry.textContent ?? ""),
  );

describe("a task a connected agent works itself", () => {
  it("shows its activity, has no composer, and Stop ends that agent's session", async () => {
    await mount(task(mockAgentWorkThreads.working), options);
    await vi.waitFor(() => expect(document.querySelector(".session-bar")).not.toBeNull());
    const bar = document.querySelector(".session-bar")!;
    expect(bar.textContent).toContain("Claude is working");
    expect(bar.textContent).toContain("Claude works this task itself. You can’t write to it here.");
    expect(
      document.querySelector(
        ".thread .composer-dock [contenteditable], .thread .composer-dock textarea",
      ),
    ).toBeNull();
    const activity = document.querySelector(".session-activity")!;
    expect(activity.textContent).toContain("Connected agent · https://claude.ai");
    expect(activity.textContent).toContain("Listed tabs in Travel on Studio Mac");
    expect(activity.textContent).toContain("Reading only");
    expect(activity.textContent).toContain("Allowed by Auto");
    expect(activity.textContent).toContain("Uncertain");
    expect(activity.textContent).toContain("can’t say whether this happened");
    const dispatch = vi.spyOn(client, "dispatch");
    await act(async () => button("Stop Claude")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.session.stop",
        threadId: mockAgentWorkThreads.working,
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".session-bar")?.textContent).toContain("Stopped by you"),
    );
    expect(button("Stop Claude")).toBeUndefined();
  });

  it("stays stopped, and says when its agent was disconnected", async () => {
    await mount(task(mockAgentWorkThreads.stopped), options);
    await vi.waitFor(() =>
      expect(document.querySelector(".session-bar")?.textContent).toContain("Stopped by you"),
    );
    expect(document.querySelector(".session-activity")?.textContent).toContain(
      "You didn’t allow it",
    );
    expect(button(/^Stop /u)).toBeUndefined();
    await act(async () => goTo!(task(mockAgentWorkThreads.ended)));
    await vi.waitFor(() =>
      expect(document.querySelector(".session-bar")?.textContent).toContain(
        "Ended: Shop helper was disconnected",
      ),
    );
  });

  it("wears the agent's mark and says what it is using in Tasks", async () => {
    await mount("/", options);
    await vi.waitFor(() =>
      expect(
        document.querySelector(`[data-thread-id="${mockAgentWorkThreads.working}"]`),
      ).not.toBeNull(),
    );
    const row = document.querySelector(`[data-thread-id="${mockAgentWorkThreads.working}"]`)!;
    expect(row.querySelector(".agent-mark")).not.toBeNull();
    expect(row.textContent).toContain("Claude is working");
  });
});

describe("a tab a connected agent uses", () => {
  const tabOf = (threadId: string) => {
    const place = placeList(client.getSnapshot()).find(
      (item) => item.kind === "page" && item.occupants.some((o) => o.threadId === threadId),
    );
    if (!place) throw new Error("No tab for this task");
    return place;
  };

  it("says who uses it and for which task, with Stop; and both of you on a tab you share", async () => {
    await mount("/", options);
    await act(async () => goTo!(`/${tabSearch(tabOf(mockAgentWorkThreads.working))}`));
    await vi.waitFor(() =>
      expect(document.querySelector(".tab-agent-status")?.textContent).toContain(
        "Claude is using this page for “Find flights to Lisbon”",
      ),
    );
    expect(document.querySelector(".tab-agent-status button")?.textContent).toContain("Stop");
    await act(async () => goTo!(`/${tabSearch(tabOf(mockAgentWorkThreads.waiting))}`));
    await vi.waitFor(() =>
      expect(document.querySelector(".tab-agent-status")?.textContent).toContain(
        "You and Grok are using this page, for “Buy the phone case”",
      ),
    );
    // Grok waits on the person's Allow once: Answer back to the Request, and Stop beside it.
    expect(button("Answer")?.getAttribute("aria-label")).toBe("Grok needs you. Answer");
    const dispatch = vi.spyOn(client, "dispatch");
    await act(async () => button("Stop")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.session.stop",
        threadId: mockAgentWorkThreads.waiting,
      }),
    );
  });
});

describe("what a connected agent asks the person itself", () => {
  const asking = {
    mock: mockConnectedAgents("seeded"),
    hostClient: (source: MockHostClient) => {
      source.mockAgentWork({ question: true });
      return source;
    },
  };

  it("shows the question with its own choices, one click to its page and one click back", async () => {
    await mount(task(mockAgentWorkThreads.working), asking);
    await vi.waitFor(() =>
      expect(document.querySelector(".request-card")?.textContent).toContain(
        "Enter passwords and codes only in the page.",
      ),
    );
    const card = document.querySelector(".request-card")!;
    expect(card.textContent).toContain("Done");
    expect(card.textContent).toContain("Unable to do it");
    expect(card.textContent).not.toContain("Allow once");
    await act(async () => button("Open the page")!.click());
    await vi.waitFor(() =>
      expect(document.querySelector(".tab-agent-status")?.textContent).toContain(
        "Claude is using this page for “Find flights to Lisbon”",
      ),
    );
    expect(button("Answer")?.getAttribute("aria-label")).toBe("Claude needs you. Answer");
    // Stop stays beside Answer while the question waits.
    expect(document.querySelector(".tab-agent-status")?.textContent).toContain("Stop");
    await act(async () => button("Answer")!.click());
    await vi.waitFor(() =>
      expect(document.querySelector(".request-card")?.textContent).toContain(
        "Enter passwords and codes only in the page.",
      ),
    );
  });
});

describe("a direct operation that needs the person", () => {
  it("keeps the Home's words, the agent's words and the calls apart, and answers once", async () => {
    await mount(task(mockAgentWorkThreads.waiting), options);
    await vi.waitFor(() => expect(document.querySelector(".operation-request")).not.toBeNull());
    const card = document.querySelector(".operation-request")!;
    expect(card.querySelector(".action-panel__title")?.textContent).toBe(
      "Run a script in Shopping?",
    );
    expect(card.querySelector(".operation-request__summary")?.textContent).toBe(
      "Shopping · Studio Mac",
    );
    expect(card.querySelector(".operation-request__says")?.textContent).toContain("Grok says:");
    expect(card.querySelector(".operation-request__code")).toBeNull();
    await act(async () => button("Show exactly what it will run")!.click());
    expect(card.querySelector(".operation-request__code")?.textContent).toContain("Place order");
    expect(card.textContent).toContain("Allowing this once doesn’t give it any more access.");
    const dispatch = vi.spyOn(client, "dispatch");
    await act(async () => button("Allow once")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request.respond",
        requestId: mockAgentOperationRequestId,
        response: { kind: "form", answers: { "operation-decision": ["allow"] } },
      }),
    );
  });

  it("is named by its agent and the Home's question in Tasks and in Needs you", async () => {
    await mount("/", options);
    await vi.waitFor(() =>
      expect(
        document.querySelector(`[data-thread-id="${mockAgentWorkThreads.waiting}"]`),
      ).not.toBeNull(),
    );
    const taskRow = document.querySelector(`[data-thread-id="${mockAgentWorkThreads.waiting}"]`)!;
    expect(taskRow.querySelector(".agent-mark")).not.toBeNull();
    expect(taskRow.textContent).toContain("Run a script in Shopping?");
    await act(async () =>
      (document.querySelector('[title="Open Needs you"]') as HTMLButtonElement).click(),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Grok: Run a script in Shopping?"),
    );
    const row = [...document.querySelectorAll(".side-task--needs-you")].find((entry) =>
      entry.textContent?.includes("Grok: Run a script"),
    )!;
    expect(row.querySelector(".agent-mark")).not.toBeNull();
  });
});

describe("who a connected agent is", () => {
  const view = {
    administrator: true,
    name: "Mac mini",
    facts: { desktop: true, onThisComputer: true, remote: false },
  } as unknown as SettingsView;
  const base = "/settings/external-agents";
  let page: Root | undefined;
  afterEach(() => act(() => page?.unmount()));

  async function agentPage(n: number) {
    const host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("seeded") });
    host.mockAgentWork();
    const container = document.createElement("div");
    document.body.append(container);
    page = createRoot(container);
    const context = { hostClient: host, snapshot: host.getSnapshot() } as unknown as ShellContext;
    await act(async () =>
      page!.render(
        <MemoryRouter initialEntries={[`${base}/mcn_00000000-0000-4000-8000-00000000000${n}`]}>
          <ShellContext value={context}>
            <Routes>
              <Route
                path={`${base}/*`}
                element={<ExternalAgentsSection client={host} view={view} />}
              />
            </Routes>
          </ShellContext>
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(container.querySelector(".agent-who")).not.toBeNull());
    return container;
  }

  it("names a verified agent, a self-given name as self-given, and an app on this computer", async () => {
    expect((await agentPage(6)).querySelector(".agent-who--verified")?.textContent).toContain(
      "Verified: AgentPay",
    );
    act(() => page?.unmount());
    const grok = await agentPage(1);
    expect(grok.querySelector(".agent-who--verified")).toBeNull();
    expect(grok.querySelector(".agent-who")?.textContent).toContain("Says it is Grok");
    expect(grok.querySelector(".agent-who")?.textContent).toContain("https://grok.com");
    act(() => page?.unmount());
    expect((await agentPage(7)).querySelector(".agent-who")?.textContent).toContain(
      "an app on this computer",
    );
  });

  it("says when verification was withdrawn and offers Disconnect once", async () => {
    const container = await agentPage(8);
    expect(container.querySelector(".agent-who__notice")?.textContent).toMatch(
      /^No longer verified since /u,
    );
    expect(container.querySelector(".agent-who--verified")).toBeNull();
    expect(container.querySelector(".agent-mark .provider-logo")).toBeNull();
    const disconnects = [...container.querySelectorAll("button")].filter((entry) =>
      (entry.textContent?.trim() ?? "").startsWith("Disconnect"),
    );
    expect(disconnects).toHaveLength(1);
  });
});
