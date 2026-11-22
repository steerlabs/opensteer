// @vitest-environment happy-dom
import { createId } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { agentWords, HostClientRequestError } from "@opensteer/client/host";
import { MockHostClient, mockAgentWorkThreads, mockConnectedAgents } from "@opensteer/client/mock";
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
const claude = "mcn_00000000-0000-4000-8000-000000000002";
const grok = "mcn_00000000-0000-4000-8000-000000000001";
const shopHelper = "mcn_00000000-0000-4000-8000-000000000004";
const oldNotes = "mcn_00000000-0000-4000-8000-000000000005";
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
    ]);
    expect(page.querySelector(`a[href="${base}/${grok}"]`)).not.toBeNull();
    // A logo only for a platform the Home verified: Claude and ChatGPT, never Grok's domain.
    expect(page.querySelectorAll(".agent-mark .provider-logo")).toHaveLength(2);
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
    expect(page.textContent).toContain(
      "This Opensteer doesn’t keep a list of what connected agents did yet.",
    );
    expect(
      page.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[value="auto"]')!.checked).toBe(true);
  });

  it("saves an edit against the revision it was made on", async () => {
    host = seeded();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
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
      expect(page.textContent).toContain("Saved. Grok uses this from its next action."),
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
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Claude"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="selected"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Limit Claude to what you choose?",
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
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
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
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(
        (...args: Parameters<typeof list>) =>
          new Promise((done) => held.push(() => done(list(...args)))),
      ),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => buttonNamed(page, "Disconnect Grok").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "It stops right away and can’t use anything again unless you connect it again.",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => buttonNamed(page, "Disconnect").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: grok }),
    );
    await vi.waitFor(() => expect(status(page)).toContain("Grok can’t do anything now"));
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
    expect(status(page)).toContain("Shop helper already can’t use anything");
    expect(page.querySelector(".connected-agent__uncertain")?.textContent).toContain(
      "Check its last action",
    );
    expect(page.textContent).not.toContain("Remove from list");
    expect(page.textContent).not.toContain("Disconnect Shop helper");
  });

  it("offers Remove from list for a stopped agent", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${oldNotes}`);
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    expect(page.querySelector(".connected-agent__uncertain")).toBeNull();
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
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    expect(page.textContent).toContain(
      "Update Opensteer on your Home to choose what this agent can use.",
    );
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
  });
});

describe("a chat, as a connected agent", () => {
  const chat = (n: number) => `mcn_00000000-0000-4000-8000-0000000000c${n}`;
  const chats = () => new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });

  it("lists chats with the connected agents: where each listens, paused ones as paused, ended ones apart", async () => {
    host = chats();
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Slack · #team"));
    expect(rows(page, "Connected")).toEqual([
      ["Slack", "Direct messages to Workshop on Slack · Tasks · Supervised"],
      ["Slack · #team", "Paused · its replies are held until it’s back"],
      ["iMessage", "Paused · its replies are held until it’s back"],
      ["Slack · On-call", "Paused · its replies are held until it’s back"],
    ]);
    expect(rows(page, "Disconnected")).toEqual([["Slack · #standup", "Disconnected"]]);
  });

  it("shows a live chat's place, who can give it work and how to change that, its work with Stop, and Disconnect", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(1)}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Direct messages to Workshop on Slack"),
    );
    const text = page.textContent ?? "";
    expect(text).toContain("You, as Tim");
    expect(text).toContain(
      "Only messages you send as Tim give this agent work. To use another account, link it on Messaging: the new one replaces this one.",
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
    const stopRun = vi.spyOn(host, "stopRun").mockResolvedValue(undefined);
    await act(async () => buttonNamed(page, "Stop").click());
    expect(stopRun).toHaveBeenCalledWith("thr_00000000-0000-4000-8000-0000000000c1");
    expect(buttonNamed(page, "Disconnect Slack")).toBeTruthy();
    // What it can use is edited with the same grant editor as any connected agent.
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).not.toBeNull();
    expect(text).not.toMatch(/bridge|lineage|ingress|route|binding|waiting/iu);
  });

  it.each([
    [
      2,
      "You paused this chat. Its replies are held, and are sent in order when it’s back. Messages sent while this is paused are not delivered. Resume its account in Messaging to go on.",
    ],
    [
      3,
      "You paused this chat. Its replies are held, and are sent in order when it’s back. Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late. Resume its account in Messaging to go on.",
    ],
    [
      4,
      "Paused because On-call needs attention. Its replies are held, and are sent in order when it’s back. Messages sent while this is paused are not delivered. It says: Slack says the token was revoked. Fix that on its messaging account, then check it again.",
    ],
  ])(
    "says what a paused chat holds and what becomes of what is sent to it (chat %i)",
    async (n, sentence) => {
      host = chats();
      const page = await mount(host, `${base}/${chat(n)}`);
      await vi.waitFor(() => expect(status(page)).toContain("Paused"));
      expect(status(page)).toContain(sentence);
      // Still connected: it can be disconnected; nothing claims it is active.
      expect(
        buttonNamed(
          page,
          `Disconnect ${n === 2 ? "Slack · #team" : n === 3 ? "iMessage" : "Slack · On-call"}`,
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
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in #team"));
    expect(page.textContent).toContain(
      "Anyone who can write there can give this agent work. Tasks they start run without your personal context.",
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

  it("shows a chat none of a signed-in agent's identity lines", async () => {
    host = chats();
    const page = await mount(host, `${base}/${chat(2)}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in #team"));
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
    await vi.waitFor(() => expect(page.textContent).toContain("Anyone who can write in #team"));
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
    await vi.waitFor(() => expect(page.textContent).toContain("You, as Tim"));
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
});
