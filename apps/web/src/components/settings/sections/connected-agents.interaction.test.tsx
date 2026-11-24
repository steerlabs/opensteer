// @vitest-environment happy-dom
import { createId, ThreadIdSchema } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { agentWords, HostClientRequestError, mutationIdempotencyKey } from "@opensteer/client/host";
import { HostTransportError } from "@opensteer/client/connections";
import {
  MockHostClient,
  mockAgentOperationRequestId,
  mockAgentWorkThreads,
  mockConnectedAgents,
} from "@opensteer/client/mock";
import type { AgentConnection } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import type { SettingsView } from "../primitives.js";
import { ExternalAgentsSection } from "./external-agents.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const view = {
  administrator: true,
  name: "Mac mini",
  facts: { desktop: true, onThisComputer: true, remote: false },
} as unknown as SettingsView;
const chatgpt = "mcn_00000000-0000-4000-8000-000000000008";
const claude = "mcn_00000000-0000-4000-8000-000000000002";
const grok = "mcn_00000000-0000-4000-8000-000000000001";
const shopHelper = "mcn_00000000-0000-4000-8000-000000000004";
const oldNotes = "mcn_00000000-0000-4000-8000-000000000005";
const oldSearch = "mcn_00000000-0000-4000-8000-000000000009";
const base = "/settings/external-agents";
let path = "";

function Where() {
  path = useLocation().pathname;
  return null;
}

function seeded(connections?: readonly AgentConnection[]) {
  const scene = mockConnectedAgents("seeded");
  return new MockHostClient({ latencyMs: 0, connections: connections ?? scene.connections });
}

async function mount(client: MockHostClient, at = base) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = { hostClient: client, snapshot: client.getSnapshot() } as unknown as ShellContext;
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <ShellContext value={context}>
          <Routes>
            <Route
              path={`${base}/*`}
              element={
                <>
                  <Where />
                  <ExternalAgentsSection client={client} view={view} />
                </>
              }
            />
            <Route path="/tasks/:threadId" element={<Where />} />
          </Routes>
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  return container;
}

function rows(container: HTMLElement, heading: string) {
  const section = [...container.querySelectorAll("section")].find(
    (element) => element.querySelector("h2")?.textContent === heading,
  );
  return [...(section?.querySelectorAll(".connected-agents__row") ?? [])].map((row) => [
    row.querySelector(".card__row-title")?.textContent,
    row.querySelector(".card__row-detail")?.textContent,
  ]);
}
function buttonNamed(container: HTMLElement, text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text} in ${container.textContent}`);
  return found;
}
const status = (container: HTMLElement) =>
  container.querySelector(".connected-agent__status")?.textContent ?? "";

describe("Connected agents list", () => {
  it("says who is connected and what each can use, then the disconnected ones with their outcome", async () => {
    host = seeded();
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Grok"));
    expect(page.querySelector("h1")?.textContent).toBe("Connected agents");
    expect(rows(page, "Connected")).toEqual([
      ["Grok", "Shopping profile · Supervised"],
      ["Claude", "Everything · Full access"],
      ["Trip planner", "Tasks · Auto"],
      ["Errand", "Nothing chosen · Supervised"],
      ["Claude Code", "Tasks · Auto"],
      ["ChatGPT", "Nothing chosen · Supervised"],
    ]);
    expect(rows(page, "Disconnected")).toEqual([
      ["Shop helper", "Check its last action"],
      ["Old notes agent", "Disconnected"],
      ["Old search agent", "Expired"],
    ]);
    expect(page.querySelector(`a[href="${base}/${grok}"]`)).not.toBeNull();
    // A logo only for a platform the Home verified: Claude and ChatGPT, never Grok's domain.
    expect(page.querySelectorAll(".agent-mark .provider-logo")).toHaveLength(2);
  });

  it("marks each active connection by its sessions and clears the mark when work ends", async () => {
    host = seeded();
    const page = await mount(host);
    const mark = (id: string) =>
      page.querySelector(`a[href="${base}/${id}"] .connected-agents__work`)?.textContent;
    await act(async () => host!.mockAgentWork({ livePanel: "needs-you" }));
    expect(mark(chatgpt)).toBe("Working");
    expect(mark(claude)).toBe("Needs you");
    expect(mark(shopHelper)).toBeUndefined();
    const threadId = mockAgentWorkThreads.shopping;
    const sessionId = host.getSnapshot().threads.find(({ id }) => id === threadId)!.agentSessionId!;
    await act(async () => expect(host!.stopAgentSession(threadId, sessionId)).toBe(true));
    expect(mark(chatgpt)).toBeUndefined();
    expect(mark(claude)).toBe("Needs you");
  });

  it("after a refresh of the list fails, says so and starts no setup until it is read again", async () => {
    const client = seeded();
    host = client;
    const changed: (() => void)[] = [];
    const subscribe = client.subscribeConnectionsChanged.bind(client);
    vi.spyOn(client, "subscribeConnectionsChanged").mockImplementation((listener) => {
      changed.push(listener);
      return subscribe(listener);
    });
    const real = client.rpc["connections.list"];
    let failing = false;
    Object.defineProperty(client.rpc, "connections.list", {
      value: async (input: Parameters<typeof real>[0]) => {
        if (failing)
          throw new HostClientRequestError({ code: "internal", message: "down", status: 503 });
        return real(input);
      },
      configurable: true,
    });
    const page = await mount(client);
    await vi.waitFor(() => expect(page.textContent).toContain("Grok"));
    const adds = () =>
      [...page.querySelectorAll<HTMLButtonElement>('button[aria-label^="Add "]')].map(
        (button) => button.disabled || button.closest("fieldset")?.disabled === true,
      );
    await vi.waitFor(() => expect(adds().some((disabled) => !disabled)).toBe(true));
    const offered = adds();
    failing = true;
    await act(async () => {
      for (const listener of changed) listener();
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn’t read your connected agents.",
      ),
    );
    expect(adds().every((disabled) => disabled)).toBe(true);
    failing = false;
    await act(async () => buttonNamed(page, "Try again").click());
    await vi.waitFor(() => expect(adds()).toEqual(offered));
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks for nothing more than the list on open", async () => {
    host = seeded();
    const reads = ["integration.computer.apps.approved", "plugins.installed.list"] as const;
    const spies = reads.map((name) => {
      const spy = vi.fn(host!.rpc[name]);
      Object.defineProperty(host!.rpc, name, { value: spy, configurable: true });
      return spy;
    });
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Grok"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("one connected agent", () => {
  it("shows the working task, hides Watch when it ends, and opens the task from Watch", async () => {
    const client = seeded();
    host = client;
    const activity = vi.fn(client.rpc["connections.activity"]);
    Object.defineProperty(client.rpc, "connections.activity", {
      value: activity,
      configurable: true,
    });
    const page = await mount(client, `${base}/${claude}`);
    const watch = () => page.querySelector<HTMLAnchorElement>(".connected-agent__header a");
    expect(status(page)).toContain("Not doing anything");
    expect(watch()).toBeNull();
    await act(async () => client.mockAgentWork());
    expect(status(page)).toContain("Working now");
    expect(status(page)).toContain("Find flights to Lisbon");
    expect(activity).toHaveBeenCalledWith(
      { connectionId: claude },
      { signal: expect.any(AbortSignal) },
    );
    const threadId = mockAgentWorkThreads.working;
    const sessionId = client.getSnapshot().activeTasks.find(({ thread }) => thread.id === threadId)
      ?.thread.agentSessionId;
    expect(sessionId).toBeTruthy();
    await act(async () => expect(client.stopAgentSession(threadId, sessionId!)).toBe(true));
    expect(status(page)).toContain("Not doing anything");
    expect(watch()).toBeNull();
    await act(async () => client.mockAgentWork());
    expect(watch()?.textContent).toBe("Watch");
    await act(async () => watch()!.click());
    expect(path).toBe(`/tasks/${threadId}`);
  });

  it("shows Now only during this agent's session, with the task's operation rows and Stop", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${chatgpt}`);
    const now = () => page.querySelector<HTMLElement>('[aria-labelledby="connected-agent-now"]');
    expect(now()).toBeNull();
    await act(async () => host!.mockAgentWork({ livePanel: "three" }));
    const section = now()!;
    expect(section.querySelector("h2")?.textContent).toBe("Now");
    expect(section.querySelectorAll(".connected-agent__session")).toHaveLength(1);
    expect(section.querySelector(".connected-agent__session-place")?.textContent).toBe(
      "Shopping · Studio Mac",
    );
    const row = [...section.querySelectorAll(".session-op")].find((item) =>
      item.textContent?.includes("Run a script on Shopping"),
    );
    expect(row?.textContent).toContain("Supervised");
    expect(row?.textContent).toContain("Running…");
    expect(row?.querySelector("time")?.dateTime).toBeTruthy();
    expect(buttonNamed(section, "Watch ChatGPT")).toBeTruthy();

    const threadId = mockAgentWorkThreads.shopping;
    const sessionId = host.getSnapshot().threads.find(({ id }) => id === threadId)!.agentSessionId!;
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => buttonNamed(section, "Stop ChatGPT").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.session.stop",
        threadId,
        agentSessionId: sessionId,
        idempotencyKey: expect.stringMatching(`^agent-session-stop:${sessionId}:`),
      }),
    );
    expect(now()).toBeNull();
  });

  it("opens the session's task from Watch inside Now", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${chatgpt}`);
    await act(async () => host!.mockAgentWork({ livePanel: "one" }));
    const now = page.querySelector<HTMLElement>('[aria-labelledby="connected-agent-now"]')!;
    await act(async () => buttonNamed(now, "Watch ChatGPT").click());
    expect(path).toBe(`/tasks/${mockAgentWorkThreads.shopping}`);
  });

  it("answers the existing task Request card inline in Now", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${claude}`);
    await act(async () => host!.mockAgentWork({ livePanel: "needs-you" }));
    expect(status(page)).toContain("Needs you");
    const now = page.querySelector<HTMLElement>('[aria-labelledby="connected-agent-now"]')!;
    expect(now.querySelector(".chip--warn")?.textContent).toBe("Needs you");
    const card = now.querySelector<HTMLElement>(".request-card .operation-request")!;
    expect(card.dataset.requestId).toBe(mockAgentOperationRequestId);
    expect(card.textContent).toContain("Run a script in Travel?");
    const waiting = host
      .getSnapshot()
      .waitingRequests.find(({ request }) => request.id === mockAgentOperationRequestId)!.request;
    expect(waiting.reviewedRevision).toBeDefined();
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => buttonNamed(card, "Allow once").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request.respond",
        requestId: mockAgentOperationRequestId,
        expectedRevision: waiting.reviewedRevision,
        response: { kind: "form", answers: { "operation-decision": ["allow"] } },
        idempotencyKey: expect.stringMatching(`^request:${mockAgentOperationRequestId}:`),
      }),
    );
    await vi.waitFor(() => expect(page.querySelector(".request-card")).toBeNull());
  });

  it.each([390, 1440])("reads and saves the paired Chrome grant at %d px", async (width) => {
    const sourceId = createId("browserSource");
    host = seeded();
    const read = vi.fn(async () => ({
      ok: true,
      data: {
        extensionDirectory: null,
        sources: [],
        sites: [],
        chromeTabs: [{ paired: true, sourceId, computerName: "Work Mac" }],
        chromeTabsRepairNames: ["Home Mac"],
      },
    }));
    Object.defineProperty(host.rpc, "browser.sources.get", { value: read, configurable: true });
    const dispatch = vi.spyOn(host, "dispatch");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    const page = await mount(host, `${base}/${grok}`);
    page.style.width = `${width}px`;
    const option = page.querySelector<HTMLInputElement>(
      '[aria-label="Tabs you share from Chrome on Work Mac"]',
    )!;
    expect(read).toHaveBeenCalled();
    expect(option.checked).toBe(false);
    expect(page.textContent).toContain("To share tabs from Chrome on Home Mac, pair it again.");
    await act(async () => option.click());
    await act(async () => buttonNamed(page, "Save").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: expect.objectContaining({
          resources: expect.arrayContaining([{ kind: "chrome-tabs", sourceId }]),
        }),
      }),
    );
  });

  it("shows what it can use, who it says it is, and the honest empty activity", async () => {
    host = seeded();
    const page = await mount(host, `${base}/mcn_00000000-0000-4000-8000-000000000003`);
    await vi.waitFor(() => expect(page.textContent).toContain("Trip planner"));
    expect(status(page)).toContain("Not doing anything");
    expect(page.textContent).toContain("Calls itself");
    expect(page.textContent).toContain("TravelBot Agent");
    expect(page.textContent).toContain("trips.example");
    // Its Recent activity is what the Home reports for it (connections.activity): nothing yet.
    expect(page.textContent).toContain("Recent activityNothing yet.");
    expect(page.textContent).not.toContain("doesn’t keep a list");
    expect(
      page.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[value="auto"]')!.checked).toBe(true);
  });

  it("saves an edit against the revision it was made on", async () => {
    host = seeded();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Grok”"));
    expect(page.textContent).not.toContain("Save");
    await act(async () =>
      page.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.click(),
    );
    await act(async () =>
      page.querySelector<HTMLInputElement>('input[value="full-access"]')!.click(),
    );
    await act(async () => buttonNamed(page, "Save").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        connectionId: grok,
        expectedRevision: 1,
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [
            { kind: "browser-profile", profileId: "bpr_00000000-0000-4000-8000-000000000003" },
          ],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Saved. “Grok” uses this from its next action."),
    );
    expect(page.querySelector<HTMLInputElement>('input[value="full-access"]')!.checked).toBe(true);
  });

  it("asks before limiting an agent that could do everything", async () => {
    host = seeded();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/mcn_00000000-0000-4000-8000-000000000002`);
    // Its verified name is the title; the line under it only says so.
    await vi.waitFor(() =>
      expect(page.querySelector(".agent-who__name")?.textContent).toBe("Verified"),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Claude”"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="selected"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Limit “Claude” to what you choose?",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => buttonNamed(page, "Limit").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    );
  });

  it("shows what is set now when another device changed it first", async () => {
    host = seeded();
    const real = host.dispatch.bind(host);
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "connection.update")
        throw new HostClientRequestError({ code: "conflict", message: "changed", status: 409 });
      return real(command);
    });
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Grok”"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="auto"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This changed on another device. Showing what’s set now."),
    );
    expect(page.querySelector<HTMLInputElement>('input[value="approval-required"]')!.checked).toBe(
      true,
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("disconnects after confirming: Revoked at once, then the outcome the Home reports", async () => {
    host = seeded();
    const list = host.rpc["connections.list"];
    const held: (() => void)[] = [];
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Grok”"));
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(
        (...args: Parameters<typeof list>) =>
          new Promise((done) => held.push(() => done(list(...args)))),
      ),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => buttonNamed(page, "Disconnect “Grok”").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "It stops right away and can’t use anything again unless you connect it again.",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => buttonNamed(page, "Disconnect").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: grok }),
    );
    await vi.waitFor(() => expect(status(page)).toContain("“Grok” can’t do anything now"));
    expect(
      [...page.querySelectorAll(".connected-agent__steps li")].map((li) =>
        li.getAttribute("data-state"),
      ),
    ).toEqual(["done", "current", "pending"]);
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
    Object.defineProperty(host.rpc, "connections.list", { value: list, configurable: true });
    await act(async () => {
      for (const release of held) release();
    });
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    expect(status(page)).toContain("everything it was doing has stopped");
    await act(async () => buttonNamed(page, "Remove from list").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.remove", connectionId: grok }),
    );
    await vi.waitFor(() => expect(path).toBe(base));
  });

  it("keeps Stopping and a lost last action apart", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${shopHelper}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Shop helper"));
    expect(status(page)).toContain("Stopping its work");
    expect(status(page)).toContain("“Shop helper” already can’t use anything");
    expect(page.querySelector(".connected-agent__uncertain")?.textContent).toContain(
      "Check its last action",
    );
    expect(page.textContent).not.toContain("Remove from list");
    expect(page.textContent).not.toContain("Disconnect “Shop helper”");
  });

  it("offers Remove from list for a stopped agent", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${oldNotes}`);
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    expect(page.querySelector(".connected-agent__uncertain")).toBeNull();
    expect(buttonNamed(page, "Remove from list")).toBeTruthy();
  });

  it("shows an expired agent with its quoted reconnect sentence and Remove from list", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${oldSearch}`);
    await vi.waitFor(() => expect(status(page)).toContain("Expired"));
    expect(status(page)).toContain("Connect it again from “Old search agent” to use it.");
    expect(buttonNamed(page, "Remove from list")).toBeTruthy();
  });

  it("stays on the page, saying why, when Remove from list was not confirmed", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${oldNotes}`);
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    vi.spyOn(host, "dispatch").mockRejectedValue(
      new HostClientRequestError({ code: "unavailable", message: "down", status: 503 }),
    );
    await act(async () => buttonNamed(page, "Remove from list").click());
    await vi.waitFor(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(path).toBe(`${base}/${oldNotes}`);
    expect(buttonNamed(page, "Remove from list")).toBeTruthy();
  });

  it("says when an agent isn't connected anymore", async () => {
    host = seeded([]);
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This agent isn’t connected anymore."),
    );
  });

  it("can't edit an agent on a Home without grants, and says why", async () => {
    const scene = mockConnectedAgents("seeded");
    host = new MockHostClient({
      latencyMs: 0,
      grantsAvailable: false,
      connections: scene.connections.map(({ grant: _grant, ...row }) => row),
    });
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Grok”"));
    expect(page.textContent).toContain(
      "Update Opensteer on your Home to choose what this agent can use.",
    );
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
  });
});

/** Pauses Workshop, as a person does on Messaging: its chats pause with it. */
async function pauseWorkshop(client: MockHostClient) {
  const dashboard = await client.rpc["channels.get"]({});
  if (!dashboard.ok) throw new Error("No messaging accounts");
  const workshop = dashboard.data.connections.find(
    ({ displayName }) => displayName === "Workshop",
  )!;
  await client.dispatch({
    type: "channel.connection.status.set",
    connectionId: workshop.id,
    status: "paused",
    idempotencyKey: mutationIdempotencyKey("channel-status"),
  });
}

describe("a chat, as a connected agent", () => {
  const chat = (n: number) => `mcn_00000000-0000-4000-8000-0000000000c${n}`;
  const chats = () => new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });

  it("lists chats with the connected agents: where each listens, paused ones as paused, ended ones apart", async () => {
    host = chats();
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Slack · #team"));
    // Beside an ordinary connected agent; #team speaks through Workshop, which is connected.
    expect(rows(page, "Connected")).toEqual([
      ["Claude", "Everything · Full access"],
      ["Slack", "Direct messages to “Workshop” on Slack · Tasks · Supervised"],
      ["Slack · #team", "“#team” on Slack, through “Workshop” · Tasks · Supervised"],
      ["iMessage", "Paused · its replies are held until it’s back"],
      ["Slack · On-call", "Paused · its replies are held until it’s back"],
    ]);
    expect(rows(page, "Disconnected")).toEqual([["Slack · #standup", "Disconnected"]]);
  });

  it("shows a live chat's place, who can give it work and how to change that, its work with Stop, and Disconnect", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Direct messages to “Workshop” on Slack"),
    );
    const text = page.textContent ?? "";
    expect(text).toContain("You, as “Tim”");
    expect(text).toContain(
      "Only messages you send as “Tim” give this agent work. To use another account, link it on Messaging: the new one replaces this one.",
    );
    expect(text).toContain(
      "This is chosen when the chat is added and can’t be changed. To change it, disconnect this chat and add it again.",
    );
    // No control that looks like it edits who may speak.
    expect(
      page.querySelector(
        '[aria-labelledby="chat-speakers"] input, [aria-labelledby="chat-speakers"] select',
      ),
    ).toBeNull();
    expect(text).toContain("Summarize my week");
    // The Home takes the Stop of the Run at work; that Run ends when its device answers, later.
    const real = host.dispatch.bind(host);
    const dispatch = vi
      .spyOn(host, "dispatch")
      .mockImplementation(async (command) =>
        command.type === "run.interrupt"
          ? { type: "run.interrupt", wasDuplicate: false }
          : real(command),
      );
    await act(async () => buttonNamed(page, "Stop").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.interrupt",
        threadId: "thr_00000000-0000-4000-8000-0000000000c1",
        runId: "run_00000000-0000-4000-8000-0000000000c1",
      }),
    );
    // Taken, and the task still runs until its device answers: it says so, and asks no second time.
    expect(buttonNamed(page, "Stopping…")).toMatchObject({ disabled: true });
    expect(buttonNamed(page, "Disconnect “Slack”")).toBeTruthy();
    // What it can use is edited with the same grant editor as any connected agent.
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).not.toBeNull();
    expect(text).not.toMatch(/bridge|lineage|ingress|route|binding|waiting/iu);
  });

  it("ends Stopping… when the Run ends, as the task's own updates say, and gives its next Run a Stop of its own", async () => {
    const client = chats();
    host = client;
    const task = "thr_00000000-0000-4000-8000-0000000000c1";
    const page = await mount(client, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(buttonNamed(page, "Stop")).toMatchObject({ disabled: false }));
    // The Home takes the Stop; the Run ends when its device answers, later.
    const real = client.dispatch.bind(client);
    const interrupts: Extract<
      Parameters<MockHostClient["dispatch"]>[0],
      { type: "run.interrupt" }
    >[] = [];
    vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type !== "run.interrupt") return real(command);
      interrupts.push(command);
      return { type: "run.interrupt", wasDuplicate: false };
    });
    await act(async () => buttonNamed(page, "Stop").click());
    expect(buttonNamed(page, "Stopping…")).toMatchObject({ disabled: true });
    // It answers: the Run ends, and nothing about the connection changes.
    const changed = vi.fn();
    const unsubscribe = client.subscribeConnectionsChanged(changed);
    await act(async () => void (await real(interrupts[0]!)));
    await vi.waitFor(() => expect(page.textContent).not.toContain("Stopping…"));
    expect(
      [...page.querySelectorAll("button")].map(({ textContent }) => textContent),
    ).not.toContain("Stop");
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
    // The task is given more work: a new Run, which has a Stop of its own. The preview's reply
    // waits on a timer that is held here, so the Run is still at work when it is stopped.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await act(async () => client.resumeThreadInputQueue(task));
    void real({
      type: "thread.sendMessage",
      threadId: ThreadIdSchema.parse(task),
      content: [{ type: "text", text: "One more thing" }],
      delivery: "queue",
      idempotencyKey: "chat-next-run",
    });
    const running = () =>
      client.getSnapshot().threads.find(({ id }) => id === task)?.status === "running";
    for (let step = 0; step < 50 && !(running() && page.textContent?.includes("Running")); step++)
      await act(async () => void (await vi.advanceTimersToNextTimerAsync()));
    expect(buttonNamed(page, "Stop")).toMatchObject({ disabled: false });
    await act(async () => buttonNamed(page, "Stop").click());
    vi.useRealTimers();
    expect(interrupts.map(({ runId }) => runId)).toHaveLength(2);
    expect(new Set(interrupts.map(({ runId }) => runId)).size).toBe(2);
  });

  it.each([
    [
      2,
      "You paused its messaging account. Its replies are held to be sent in order when it’s back. Messages sent while this is paused are not delivered. Resume its account in Messaging to go on.",
    ],
    [
      3,
      "You paused its messaging account. Its replies are held to be sent in order when it’s back. Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late. Resume its account in Messaging to go on.",
    ],
    [
      4,
      "Paused because “On-call” needs attention. Its replies are held to be sent in order when it’s back. Messages sent while this is paused are not delivered. It says: Slack says the token was revoked. Fix that on its messaging account, then check it again.",
    ],
  ])(
    "says what a paused chat holds and what becomes of what is sent to it (chat %i)",
    async (n, sentence) => {
      host = chats();
      // #team speaks through Workshop: paused only once Workshop is.
      if (n === 2) await pauseWorkshop(host);
      const page = await mount(host, `${base}/${chat(n)}`);
      await vi.waitFor(() => expect(status(page)).toContain("Paused"));
      expect(status(page)).toContain(sentence);
      // Still connected: it can be disconnected; nothing claims it is active.
      expect(
        buttonNamed(
          page,
          `Disconnect “${n === 2 ? "Slack · #team" : n === 3 ? "iMessage" : "Slack · On-call"}”`,
        ),
      ).toBeTruthy();
      expect(status(page)).not.toContain("Not doing anything");
    },
  );

  it("says a reply whose delivery is unknown may have been sent, and offers no resend", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(4)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain(
        "1 reply may have been sent. Opensteer couldn’t confirm it arrived, so it won’t send it again.",
      ),
    );
    expect(page.textContent).not.toMatch(/failed/iu);
    expect(
      [...page.querySelectorAll("button")].some((b) =>
        /send again|resend/iu.test(b.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("shows who can give an anyone chat work, without personal context", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in “#team”"));
    expect(page.textContent).toContain(
      "Anyone who can write there can give this agent work. Their tasks run without your personal context, in a folder of their own instead of your Agent home. That folder is not a wall: a task can still reach other files on that computer, as far as its safety mode allows.",
    );
    // Where its mode is chosen, each mode says what the people in #team can have it do.
    expect(page.textContent).toContain(
      "People in “#team” can have it act without asking you whenever the engine’s own safety check allows it. That can reach files outside its folder.",
    );
    expect(page.textContent).toContain(
      "Never asks. People in “#team” can have it do anything on its computer that your user account can.",
    );
    expect(page.textContent).not.toContain("Opensteer checks each action");
  });

  it("quotes a channel name that looks like Opensteer words in Auto and Full access warnings", async () => {
    const scene = mockConnectedAgents("chats");
    host = new MockHostClient({
      latencyMs: 0,
      ...scene,
      connections: scene.connections.map((row) =>
        row.id === chat(2)
          ? {
              ...row,
              bridge: { ...row.bridge!, conversationName: "#Helper Disconnected" },
            }
          : row,
      ),
    });
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain(
        "People in “#Helper Disconnected” can have it act without asking you whenever the engine’s own safety check allows it. That can reach files outside its folder.",
      ),
    );
    expect(page.textContent).toContain(
      "Never asks. People in “#Helper Disconnected” can have it do anything on its computer that your user account can.",
    );
  });

  it("says a chat's page could not be read when the read failed, never that it is gone", async () => {
    host = chats();
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(async () => {
        throw new HostClientRequestError({ code: "internal", message: "down", status: 503 });
      }),
      configurable: true,
    });
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Couldn’t read your connected agents."),
    );
    expect(page.textContent).not.toContain(agentWords("agent.notFound"));
    expect(buttonNamed(page, "Try again")).toBeTruthy();
  });

  it("after a refresh fails on a chat's page read before, offers only Try again", async () => {
    host = chats();
    const changed: (() => void)[] = [];
    const subscribe = host.subscribeConnectionsChanged.bind(host);
    vi.spyOn(host, "subscribeConnectionsChanged").mockImplementation((listener) => {
      changed.push(listener);
      return subscribe(listener);
    });
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Direct messages to"));
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(async () => {
        throw new HostClientRequestError({ code: "internal", message: "down", status: 503 });
      }),
      configurable: true,
    });
    // Something changed on the Home: the page reads its list again, and that read fails.
    await act(async () => {
      for (const listener of changed) listener();
    });
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Couldn’t read your connected agents."),
    );
    const enabled = [
      ...page.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"),
    ]
      .filter((control) => !control.disabled && !control.closest("fieldset[disabled]"))
      .map((control) => control.textContent || control.getAttribute("aria-label"));
    expect(enabled).toEqual(["Try again"]);
  });

  it("shows a chat none of a signed-in agent's identity lines", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in “#team”"));
    for (const id of [
      "agent.about.says",
      "agent.about.origin",
      "agent.about.originUnknown",
    ] as const)
      expect(page.textContent, id).not.toContain(agentWords(id));
    expect(page.textContent).not.toMatch(/Says it is|an app on this computer/u);
  });

  it("offers an anyone chat only what the Home says it may hold, and keeps Tasks on", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in “#team”"));
    const text = page.textContent ?? "";
    for (const id of [
      "consent.scope.everything.label",
      "consent.browser.title",
      "consent.apps.title",
    ] as const)
      expect(text, id).not.toContain(agentWords(id));
    expect(text).toContain(agentWords("consent.plugins.title"));
    const tasks = page.querySelector<HTMLInputElement>(
      'input[aria-labelledby="agent-grant-tasks"]',
    );
    expect(tasks).toMatchObject({ checked: true, disabled: true });
    expect(text).toContain("Always on: a chat can only ask your own agents to work.");
  });

  it("offers a chat for you alone everything a connected agent may hold, with Tasks still on", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("You, as “Tim”"));
    expect(page.textContent).toContain(agentWords("consent.scope.everything.label"));
    expect(page.textContent).toContain(agentWords("consent.browser.title"));
    expect(
      page.querySelector<HTMLInputElement>('input[aria-labelledby="agent-grant-tasks"]'),
    ).toMatchObject({ checked: true, disabled: true });
  });

  it("says why an ended chat ended and offers nothing that pretends to resume it", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(5)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain(
        "You disconnected it. To use it again, add the chat again on Messaging.",
      ),
    );
    const labels = [...page.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((label) => /resume|disconnect|stop$/iu.test(label))).toBe(false);
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
  });

  it("previews a Home that can't be read: a chat's page says so, never that it is gone", async () => {
    host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats-unreadable") });
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Couldn’t read your connected agents."),
    );
    expect(page.textContent).not.toContain("isn’t connected anymore");
    expect(buttonNamed(page, "Try again")).toBeTruthy();
  });

  it("says who can give a chat work when nobody is linked as you yet", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(4)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("You, once you link your account"));
    expect(page.textContent).toContain(
      "No Slack account is linked as you yet. Link yours on Messaging; until then, nothing sent here gives this agent work.",
    );
  });

  it("says a chat ended with its account, and one ended for a reason this app doesn’t know as ended", async () => {
    const scene = mockConnectedAgents("chats");
    host = new MockHostClient({
      latencyMs: 0,
      ...scene,
      connections: scene.connections.map((row) =>
        row.id === chat(5)
          ? { ...row, bridge: { ...row.bridge!, endedBy: "newer" as never } }
          : row,
      ),
    });
    const dashboard = await host.rpc["channels.get"]({});
    if (!dashboard.ok) throw new Error("No messaging accounts");
    await host.dispatch({
      type: "channel.connection.status.set",
      connectionId: dashboard.data.connections.find(({ displayName }) => displayName === "On-call")!
        .id,
      status: "revoked",
      idempotencyKey: mutationIdempotencyKey("channel-remove"),
    });
    const page = await mount(host, `${base}/${chat(4)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain(
        "Its messaging account was disconnected. To use it again, add the chat again on Messaging.",
      ),
    );
    act(() => root?.unmount());
    const other = await mount(host, `${base}/${chat(5)}`);
    await vi.waitFor(() => expect(other.textContent).toContain("This chat has ended."));
    expect(other.textContent).not.toContain("You disconnected it.");
  });

  it("says nothing when the Run had already ended, and reads the chat's list again", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Summarize my week"));
    const real = host.dispatch.bind(host);
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type !== "run.interrupt") return real(command);
      throw new HostClientRequestError({
        code: "conflict",
        message: "Run is already terminal",
        status: 409,
      });
    });
    const reads = vi.fn();
    const read = host.rpc["connections.list"];
    Object.defineProperty(host.rpc, "connections.list", {
      value: (input: Parameters<typeof read>[0]) => {
        reads();
        return read(input);
      },
      configurable: true,
    });
    await act(async () => buttonNamed(page, "Stop").click());
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("says it couldn't confirm the task was stopped when the answer is lost", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Summarize my week"));
    const real = host.dispatch.bind(host);
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type !== "run.interrupt") return real(command);
      throw new HostTransportError("timed-out");
    });
    await act(async () => buttonNamed(page, "Stop").click());
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't confirm the task was stopped.",
      ),
    );
    expect(buttonNamed(page, "Stop").disabled).toBe(false);
  });

  it("says why a task could not be stopped, and keeps its Stop", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Summarize my week"));
    const real = host.dispatch.bind(host);
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type !== "run.interrupt") return real(command);
      throw new HostClientRequestError({ code: "unavailable", message: "down", status: 503 });
    });
    await act(async () => buttonNamed(page, "Stop").click());
    await vi.waitFor(() => expect(page.querySelector('[role="alert"]')?.textContent).toBeTruthy());
    expect(page.querySelector('[role="alert"]')?.textContent).not.toContain("down");
    expect(buttonNamed(page, "Stop")).toBeTruthy();
  });

  it("saves an anyone chat's safety mode and then a plugin, refusing neither", async () => {
    host = chats();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Slack · #team”"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="auto"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "connection.update", accessMode: "auto" }),
      ),
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(page.textContent).toContain("Saved."));
    await act(async () =>
      page.querySelector<HTMLButtonElement>('button[aria-controls="agent-grant-plugins"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(page.querySelector("#agent-grant-plugins .agent-grant__plugin")).not.toBeNull(),
    );
    const plugin = page.querySelector("#agent-grant-plugins .agent-grant__plugin")!;
    const read = [...plugin.querySelectorAll<HTMLElement>("button, input")].find(
      (element) =>
        element.textContent === agentWords("consent.plugins.read") ||
        element.getAttribute("aria-label") === agentWords("consent.plugins.read") ||
        (element as HTMLInputElement).value === "read",
    )!;
    await act(async () => read.click());
    await act(async () => buttonNamed(page, "Save").click());
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "connection.update",
          grant: expect.objectContaining({
            scope: "selected",
            tasks: true,
            resources: [expect.objectContaining({ kind: "plugin" })],
          }),
        }),
      ),
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("narrows a chat that could do everything to what you choose, with Tasks kept on", async () => {
    const scene = mockConnectedAgents("chats");
    host = new MockHostClient({
      latencyMs: 0,
      ...scene,
      connections: scene.connections.map((row) =>
        row.id === chat(1) ? { ...row, grant: { scope: "everything" as const } } : row,
      ),
    });
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect “Slack”"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="selected"]')!.click());
    // What is drawn is what is saved.
    expect(
      page.querySelector<HTMLInputElement>('input[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(true);
    expect(page.textContent).not.toContain("can’t use anything until you choose something");
    await act(async () => buttonNamed(page, "Save").click());
    await act(async () => buttonNamed(page, "Limit").click());
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "connection.update",
          grant: { scope: "selected", tasks: true, resources: [] },
        }),
      ),
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers no Chrome pairing note and no Plugins where the chat's shape does not", async () => {
    const scene = mockConnectedAgents("chats");
    host = new MockHostClient({
      latencyMs: 0,
      ...scene,
      chromeTabs: { chromeTabs: [], chromeTabsNeedPairing: true },
      connections: scene.connections.map((row) =>
        row.id === chat(3)
          ? {
              ...row,
              bridge: {
                ...row.bridge!,
                grantShape: { everything: false, resources: [], tasks: "required" as const },
              },
            }
          : row,
      ),
    });
    const team = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(team.textContent).toContain("Disconnect “Slack · #team”"));
    expect(team.textContent).toContain(agentWords("consent.plugins.title"));
    expect(team.textContent).not.toContain(agentWords("consent.chromeTabs.repair"));
    act(() => root?.unmount());
    const tasksOnly = await mount(host, `${base}/${chat(3)}`);
    await vi.waitFor(() => expect(tasksOnly.textContent).toContain("Disconnect “iMessage”"));
    expect(tasksOnly.textContent).not.toContain(agentWords("consent.plugins.title"));
  });

  it("warns about Tasks only where Tasks is the person's choice, never on a chat", async () => {
    host = chats();
    const warning = agentWords("consent.tasks.warning", { home: "" }).slice(0, 30);
    const team = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(team.textContent).toContain("Disconnect “Slack · #team”"));
    expect(team.textContent).toContain("Only what you pick below.");
    expect(team.textContent).not.toContain(warning);
    act(() => root?.unmount());
    host.dispose();
    host = seeded();
    const trips = await mount(host, `${base}/mcn_00000000-0000-4000-8000-000000000003`);
    await vi.waitFor(() => expect(trips.textContent).toContain("Disconnect “Trip planner”"));
    expect(trips.textContent).toContain(warning);
  });

  it("offers Remove from list on an ended chat only, never on a live or paused one", async () => {
    host = chats();
    for (const [n, removable] of [
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ] as const) {
      const page = await mount(host, `${base}/${chat(n)}`);
      await vi.waitFor(() => expect(page.textContent).toContain("Where"));
      expect(
        [...page.querySelectorAll("button")].some((b) => b.textContent === "Remove from list"),
        `chat ${n}`,
      ).toBe(removable);
      act(() => root?.unmount());
    }
  });

  it("says a chat is at work when its page lists a task running, from that one list", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Summarize my week"));
    expect(status(page)).not.toContain("Not doing anything");
    expect(status(page)).toContain("Summarize my week");
  });
});
