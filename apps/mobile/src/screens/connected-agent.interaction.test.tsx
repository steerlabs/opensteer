// @vitest-environment happy-dom

import { createId } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { agentWords, HostClientRequestError, mutationIdempotencyKey } from "@opensteer/client/host";
import { MockHostClient, mockAgentWorkThreads, mockConnectedAgents } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativeSettingsPageProps,
  NativeSettingsRow,
  NativeSettingsSection,
} from "./native-settings-page.types.js";

interface AlertButton {
  readonly text: string;
  readonly onPress?: () => void;
}
const state = vi.hoisted(() => ({
  page: null as NativeSettingsPageProps | null,
  sheet: null as NativeSettingsPageProps | null,
  alerts: [] as { title: string; body: string; buttons: readonly AlertButton[] }[],
  goBack: vi.fn(),
  navigate: vi.fn(),
  setOptions: vi.fn(),
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, body: string, buttons: readonly AlertButton[]) =>
      state.alerts.push({ title, body, buttons }),
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: state.goBack,
    navigate: state.navigate,
    setOptions: state.setOptions,
  }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => null,
}));
vi.mock("./native-settings-page.js", async () => {
  const { useEffect } = await import("react");
  return {
    NativeSettingsPage: (props: NativeSettingsPageProps) => {
      const sheet = props.sheet !== undefined;
      if (sheet) state.sheet = props;
      else state.page = props;
      useEffect(
        () => () => {
          if (sheet) state.sheet = null;
        },
        [sheet],
      );
      return null;
    },
  };
});

const { ConnectedAgentController } = await import("./connected-agent.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  state.page = null;
  state.sheet = null;
  state.alerts = [];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const grok = "mcn_00000000-0000-4000-8000-000000000001";
const claude = "mcn_00000000-0000-4000-8000-000000000002";
const trips = "mcn_00000000-0000-4000-8000-000000000003";
const shopHelper = "mcn_00000000-0000-4000-8000-000000000004";
const oldNotes = "mcn_00000000-0000-4000-8000-000000000005";
const shopping = "bpr_00000000-0000-4000-8000-000000000003";

async function open(
  connectionId: string,
  client = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  }),
) {
  host = client;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <ConnectedAgentController
        connectionId={connectionId}
        deploymentId="deployment-a"
        host={client}
      />,
    ),
  );
  await vi.waitFor(() => expect(section("status")).toBeDefined());
  return client;
}
function section(key: string, page = state.page): NativeSettingsSection | undefined {
  return page?.sections.find((candidate) => candidate.key === key);
}
function row(sectionKey: string, key: string, page = state.page): NativeSettingsRow {
  const found = section(sectionKey, page)?.rows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no row ${sectionKey}/${key}`);
  return found;
}
async function press(target: NativeSettingsRow) {
  if (target.kind !== "button" && target.kind !== "choice")
    throw new Error(`${target.kind} can't be pressed`);
  await act(async () => target.onPress());
}
async function answer(text: string) {
  const alert = state.alerts.at(-1);
  const button = alert?.buttons.find((candidate) => candidate.text === text);
  if (!button?.onPress) throw new Error(`no ${text} in ${alert?.title}`);
  await act(async () => button.onPress!());
}
const status = () => section("status")!.rows[0] as Extract<NativeSettingsRow, { kind: "status" }>;

describe("one connected agent on the phone", () => {
  it("shows the working task, opens it from Watch, and hides Watch when work stops", async () => {
    const client = await open(claude);
    expect(status().label).toBe("Not doing anything");
    expect(section("status")?.rows.some(({ key }) => key === "watch")).toBe(false);
    await act(async () => client.mockAgentWork());
    expect(status().label).toBe("Working now");
    expect(section("status")?.footer?.text).toBe("Find flights to Lisbon");
    const threadId = mockAgentWorkThreads.working;
    await press(row("status", "watch"));
    expect(state.navigate).toHaveBeenCalledWith("Thread", {
      deploymentId: "deployment-a",
      threadId,
    });
    const sessionId = client.getSnapshot().activeTasks.find(({ thread }) => thread.id === threadId)
      ?.thread.agentSessionId;
    expect(sessionId).toBeTruthy();
    await act(async () => expect(client.stopAgentSession(threadId, sessionId!)).toBe(true));
    expect(status().label).toBe("Not doing anything");
    expect(section("status")?.rows.some(({ key }) => key === "watch")).toBe(false);
  });

  it.each([390, 1440])(
    "saves a paired Chrome on an active connection after verification is withdrawn at %d px",
    async (width) => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
      const sourceId = createId("browserSource");
      const connections = mockConnectedAgents("seeded").connections;
      const connection = connections.find(({ label }) => label === "ChatGPT")!;
      const client = new MockHostClient({
        latencyMs: 0,
        connections: [{ ...connection, verificationWithdrawnAt: "2026-11-20T11:00:00.000Z" }],
      });
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
      Object.defineProperty(client.rpc, "browser.sources.get", { value: read, configurable: true });
      const dispatch = vi.spyOn(client, "dispatch");
      await open(connection.id, client);
      expect(row("withdrawn", "withdrawn").label).toMatch(/^No longer verified since /u);
      // Its name is the title; the who rows add only where its access goes.
      expect(section("who")?.rows.map(({ label }) => label)).toEqual([
        "Holds the access: ChatGPT · https://chatgpt.com",
      ]);
      expect(section("withdrawn")?.footer?.text).toBe("Check its last action or disconnect it.");
      expect(row("withdrawn", "disconnect").label).toBe("Disconnect ChatGPT");
      const option = row("resources", sourceId);
      expect(option.label).toBe("Tabs you share from Chrome on Work Mac");
      expect(section("chrome-pairing")?.footer?.text).toBe(
        "To share tabs from Chrome on Home Mac, pair it again.",
      );
      if (option.kind !== "toggle") throw new Error("Expected a Chrome toggle");
      await act(async () => option.onChange(true));
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "connection.update",
          grant: {
            scope: "selected",
            tasks: false,
            resources: [{ kind: "chrome-tabs", sourceId }],
          },
        }),
      );
    },
  );

  it("shows its state, what it can use, its mode, who it says it is, and honest empty activity", async () => {
    await open(trips);
    expect(state.setOptions).toHaveBeenCalledWith({ title: "Trip planner" });
    expect(status()).toMatchObject({ tone: "neutral", label: "Not doing anything" });
    expect(section("status")?.footer?.text).toBe("Not used yet.");
    expect(state.page?.sections.map(({ key }) => key)).toEqual([
      "who",
      "status",
      "scope",
      "resources",
      "tasks",
      "mode",
      "activity",
      "about",
      "end",
    ]);
    expect(row("tasks", "tasks")).toMatchObject({ value: true });
    expect(row("mode", "auto")).toMatchObject({ selected: true });
    expect(row("activity", "unavailable").label).toBe(
      "This Opensteer doesn’t keep a list of what connected agents did yet.",
    );
    expect(
      section("about")?.rows.map((candidate) => [
        candidate.label,
        "detail" in candidate ? candidate.detail : null,
      ]),
    ).toEqual([
      ["Calls itself", "TravelBot Agent"],
      ["Address it uses", "trips.example"],
      // The day it was added, never read as where it stands now.
      ["Added", expect.any(String)],
      ["Expires", expect.any(String)],
    ]);
    expect(row("end", "disconnect")).toMatchObject({
      label: "Disconnect Trip planner",
      destructive: true,
    });
  });

  it("saves each change against the revision it was made on", async () => {
    const client = await open(grok);
    const dispatch = vi.spyOn(client, "dispatch");
    const tasks = row("tasks", "tasks");
    if (tasks.kind !== "toggle") throw new Error("Tasks is a switch");
    await act(async () => tasks.onChange(true));
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "connection.update",
        connectionId: grok,
        expectedRevision: 1,
        grant: {
          scope: "selected",
          tasks: true,
          resources: [{ kind: "browser-profile", profileId: shopping }],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(section("note")?.footer?.text).toBe("Saved. Grok uses this from its next action."),
    );
    await press(row("mode", "full-access"));
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "connection.update",
        expectedRevision: 2,
        accessMode: "full-access",
      }),
    );
    expect(dispatch.mock.lastCall![0]).not.toHaveProperty("grant");
  });

  it("shows what is set now when another device changed it first", async () => {
    const client = await open(grok);
    const real = client.dispatch.bind(client);
    vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "connection.update")
        throw new HostClientRequestError({ code: "conflict", message: "changed", status: 409 });
      return real(command);
    });
    await press(row("mode", "auto"));
    await vi.waitFor(() =>
      expect(section("conflict")?.footer?.text).toBe(
        "This changed on another device. Showing what’s set now.",
      ),
    );
    expect(row("mode", "approval-required")).toMatchObject({ selected: true });
    expect(section("error")).toBeUndefined();
  });

  it("asks before limiting an agent that could do everything", async () => {
    const client = await open(claude);
    const dispatch = vi.spyOn(client, "dispatch");
    await press(row("scope", "selected"));
    expect(state.alerts.at(-1)).toMatchObject({
      title: "Limit Claude to what you choose?",
      body: "It stops being able to use anything you don’t pick.",
    });
    expect(dispatch).not.toHaveBeenCalled();
    await answer("Limit");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    );
  });

  it("edits a list in its sheet and saves it when the sheet closes, creating a new profile first", async () => {
    const client = await open(grok);
    const real = client.dispatch.bind(client);
    const created = "bpr_00000000-0000-4000-8000-0000000000aa";
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: null },
        } as never;
      return real(command);
    });
    await press(row("resources", "browser"));
    expect(state.sheet?.sheet?.title).toBe("Browser");
    await press(row("new", "new", state.sheet));
    await press(row("profiles", shopping, state.sheet));
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => state.sheet!.sheet!.onClose());
    expect(state.sheet).toBeNull();
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "browser.profile.create",
      "connection.update",
    ]);
    expect(dispatch.mock.calls[1]![0]).toMatchObject({
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: created }],
      },
    });
  });

  it("disconnects after confirming: Revoked at once, then the outcome the Home reports, then removes it", async () => {
    const client = await open(grok);
    const list = client.rpc["connections.list"];
    const held: (() => void)[] = [];
    Object.defineProperty(client.rpc, "connections.list", {
      value: vi.fn(
        (...args: Parameters<typeof list>) =>
          new Promise((done) => held.push(() => done(list(...args)))),
      ),
      configurable: true,
    });
    const dispatch = vi.spyOn(client, "dispatch");
    await press(row("end", "disconnect"));
    expect(state.alerts.at(-1)).toMatchObject({
      title: "Disconnect Grok?",
      body: "It stops right away and can’t use anything again unless you connect it again. Tabs it was using stay open so you can check them.",
    });
    expect(dispatch).not.toHaveBeenCalled();
    await answer("Disconnect");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: grok }),
    );
    await vi.waitFor(() => expect(status().label).toBe("Grok can’t do anything now"));
    expect(status().steps?.map((step) => step.state)).toEqual(["done", "current", "pending"]);
    expect(section("scope")).toBeUndefined();
    Object.defineProperty(client.rpc, "connections.list", { value: list, configurable: true });
    await act(async () => {
      for (const release of held) release();
    });
    await vi.waitFor(() => expect(status()).toMatchObject({ label: "Disconnected", tone: "good" }));
    expect(section("status")?.footer?.text).toContain("everything it was doing has stopped");
    await press(row("end", "remove"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.remove", connectionId: grok }),
    );
    expect(state.goBack).toHaveBeenCalledOnce();
  });

  it("keeps Stopping and a lost last action apart, with nothing to disconnect or remove", async () => {
    await open(shopHelper);
    expect(status()).toMatchObject({ label: "Stopping its work" });
    expect(section("status")?.footer?.text).toContain("Shop helper already can’t use anything");
    expect(section("uncertain")?.rows[0]).toMatchObject({
      tone: "attention",
      label: "Check its last action",
    });
    expect(section("end")).toBeUndefined();
  });

  it("offers Remove from list for a stopped agent", async () => {
    await open(oldNotes);
    expect(status()).toMatchObject({ label: "Disconnected", tone: "good" });
    expect(row("end", "remove").label).toBe("Remove from list");
  });

  it("stays on the page, saying why, when Remove from list was not confirmed", async () => {
    const client = await open(oldNotes);
    vi.spyOn(client, "dispatch").mockRejectedValue(
      new HostClientRequestError({ code: "unavailable", message: "down", status: 503 }),
    );
    await press(row("end", "remove"));
    await vi.waitFor(() => expect(section("error")?.footer?.tone).toBe("danger"));
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("says when an agent isn't connected anymore", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root!.render(
        <ConnectedAgentController connectionId={grok} deploymentId="deployment-a" host={host!} />,
      ),
    );
    await vi.waitFor(() =>
      expect(row("gone", "gone").label).toBe("This agent isn’t connected anymore."),
    );
  });

  it("can't edit an agent on a Home without grants, and says why", async () => {
    await open(
      grok,
      new MockHostClient({
        latencyMs: 0,
        grantsAvailable: false,
        connections: mockConnectedAgents("seeded").connections.map(
          ({ grant: _grant, ...connection }) => connection,
        ),
      }),
    );
    expect(section("legacy")?.footer?.text).toBe(
      "Update Opensteer on your Home to choose what this agent can use. Until then it can do everything your own agents can.",
    );
    expect(section("scope")).toBeUndefined();
    expect(row("end", "disconnect").label).toBe("Disconnect Grok");
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

describe("a chat on the phone", () => {
  const chat = (n: number) => `mcn_00000000-0000-4000-8000-0000000000c${n}`;
  const chats = () => new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });

  it("shows where a live chat listens, who can give it work, its work with Stop, and Disconnect", async () => {
    const client = await open(chat(1), chats());
    expect(row("chat-where", "where").label).toBe("Direct messages to Workshop on Slack");
    expect(row("chat-speakers", "speakers")).toMatchObject({
      label: "You, as Tim",
      detail:
        "Only messages you send as Tim give this agent work. To use another account, link it on Messaging: the new one replaces this one.",
    });
    expect(section("chat-speakers")?.footer?.text).toBe(
      "This is chosen when the chat is added and can’t be changed. To change it, disconnect this chat and add it again.",
    );
    const stop = vi.spyOn(client, "stopRun").mockResolvedValue(undefined);
    await press(row("chat-tasks", "thr_00000000-0000-4000-8000-0000000000c1-stop"));
    expect(stop).toHaveBeenCalledWith("thr_00000000-0000-4000-8000-0000000000c1");
    expect(row("end", "disconnect").label).toBe("Disconnect Slack");
  });

  it("shows a Stop in flight as Stopping and sends no second one", async () => {
    const client = await open(chat(1), chats());
    let finish = () => {};
    const stop = vi
      .spyOn(client, "stopRun")
      .mockImplementation(() => new Promise<void>((done) => (finish = done)));
    const key = "thr_00000000-0000-4000-8000-0000000000c1-stop";
    await press(row("chat-tasks", key));
    expect(row("chat-tasks", key)).toMatchObject({ label: "Stopping…", disabled: true });
    await press(row("chat-tasks", key));
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(row("chat-tasks", key)).toMatchObject({ label: "Stop", disabled: false });
  });

  it("keeps what a paused chat holds on screen when an edit met a newer one", async () => {
    const client = await open(chat(3), chats());
    const real = client.dispatch.bind(client);
    vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "connection.update")
        throw new HostClientRequestError({ code: "conflict", message: "changed", status: 409 });
      return real(command);
    });
    await press(row("mode", "auto"));
    await vi.waitFor(() =>
      expect(section("conflict")?.footer?.text).toBe(
        "This changed on another device. Showing what’s set now.",
      ),
    );
    expect(section("status")?.footer?.text).toContain(
      "Messages sent while this is paused arrive when it’s back;",
    );
  });

  it.each([
    [2, "Messages sent while this is paused are not delivered."],
    [
      3,
      "Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late.",
    ],
    [4, "It says: Slack says the token was revoked."],
  ])(
    "says what a paused chat holds and what becomes of what is sent to it (chat %i)",
    async (n, sentence) => {
      const client = chats();
      // #team speaks through Workshop: paused only once Workshop is.
      if (n === 2) await pauseWorkshop(client);
      await open(chat(n), client);
      expect(status()).toMatchObject({ label: "Paused", tone: "attention" });
      expect(section("status")?.footer?.text).toContain(sentence);
      expect(section("end")?.rows[0]?.label).toMatch(/^Disconnect /u);
    },
  );

  it("offers an anyone chat only what it may hold, keeps Tasks on, and limits a chat with Tasks kept", async () => {
    await open(chat(2), chats());
    const labels = (state.page?.sections ?? []).flatMap((s) => s.rows.map((r) => r.label));
    for (const id of [
      "consent.scope.everything.label",
      "consent.browser.title",
      "consent.apps.title",
    ] as const)
      expect(labels, id).not.toContain(agentWords(id));
    expect(labels).toContain(agentWords("consent.plugins.title"));
    expect(row("tasks", "tasks")).toMatchObject({ value: true, disabled: true });
    // A chat for you alone that can do everything is limited with Tasks kept, never refused.
    const scene = mockConnectedAgents("chats");
    const everything = scene.connections.map((row) =>
      row.id === chat(1) ? { ...row, grant: { scope: "everything" as const } } : row,
    );
    const owner = new MockHostClient({ latencyMs: 0, ...scene, connections: everything });
    host?.dispose();
    act(() => root?.unmount());
    await open(chat(1), owner);
    const dispatch = vi.spyOn(owner, "dispatch");
    await press(row("scope", "selected"));
    await answer(agentWords("agent.narrow.confirm"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: { scope: "selected", tasks: true, resources: [] },
      }),
    );
  });

  it("says a chat's page could not be read when the read failed, never that it is gone", async () => {
    const client = chats();
    Object.defineProperty(client.rpc, "connections.list", {
      value: vi.fn(async () => {
        throw new HostClientRequestError({ code: "internal", message: "down", status: 503 });
      }),
      configurable: true,
    });
    host = client;
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root!.render(
        <ConnectedAgentController
          connectionId={chat(1)}
          deploymentId="deployment-a"
          host={client}
        />,
      ),
    );
    await vi.waitFor(() => expect(section("unreadable")).toBeDefined());
    expect(row("unreadable", "unreadable").label).toBe("Couldn’t read your connected agents.");
    expect(section("gone")).toBeUndefined();
  });

  it("shows a chat none of a signed-in agent's identity lines", async () => {
    await open(chat(2), chats());
    expect(section("who")).toBeUndefined();
    const labels = (state.page?.sections ?? []).flatMap((s) => s.rows.map((r) => r.label));
    for (const id of ["agent.about.says", "agent.about.origin"] as const)
      expect(labels, id).not.toContain(agentWords(id));
    expect(labels.join(" ")).not.toMatch(/Says it is|an app on this computer/u);
  });

  it("says a reply may have been sent, never that it failed", async () => {
    await open(chat(4), chats());
    expect(row("chat-unknown", "unknown").label).toBe(
      "1 reply may have been sent. Opensteer couldn’t confirm it arrived, so it won’t send it again.",
    );
  });

  it("says why an ended chat ended, and offers no Stop, Disconnect or resume", async () => {
    await open(chat(5), chats());
    expect(row("chat-ended", "ended").label).toBe(
      "You disconnected it. To use it again, add the chat again on Messaging.",
    );
    const buttons = (state.page?.sections ?? []).flatMap((s) =>
      s.rows.filter((r) => r.kind === "button").map((r) => r.label),
    );
    expect(buttons.filter((label) => /^(Stop|Disconnect|Resume)/u.test(label))).toEqual([]);
  });

  it("says who can give a chat work when nobody is linked as you yet", async () => {
    await open(chat(4), chats());
    expect(row("chat-speakers", "speakers")).toMatchObject({
      label: "You, once you link your account",
      detail:
        "No Slack account is linked as you yet. Link yours on Messaging; until then, nothing sent here gives this agent work.",
    });
  });

  it("says a chat ended with its account", async () => {
    const client = chats();
    const dashboard = await client.rpc["channels.get"]({});
    if (!dashboard.ok) throw new Error("No messaging accounts");
    await client.dispatch({
      type: "channel.connection.status.set",
      connectionId: dashboard.data.connections.find(({ displayName }) => displayName === "On-call")!
        .id,
      status: "revoked",
      idempotencyKey: mutationIdempotencyKey("channel-remove"),
    });
    await open(chat(4), client);
    await vi.waitFor(() =>
      expect(row("chat-ended", "ended").label).toBe(
        "Its messaging account was disconnected. To use it again, add the chat again on Messaging.",
      ),
    );
  });

  it("says why a task could not be stopped, in words, never the raw error", async () => {
    const client = await open(chat(1), chats());
    vi.spyOn(client, "stopRun").mockRejectedValue(
      new HostClientRequestError({ code: "unavailable", message: "down", status: 503 }),
    );
    await press(row("chat-tasks", "thr_00000000-0000-4000-8000-0000000000c1-stop"));
    await vi.waitFor(() => expect(state.alerts.at(-1)?.title).toBe("Stop"));
    expect(state.alerts.at(-1)?.body).toBeTruthy();
    expect(state.alerts.at(-1)?.body).not.toContain("down");
    expect(row("chat-tasks", "thr_00000000-0000-4000-8000-0000000000c1-stop")).toMatchObject({
      label: "Stop",
      disabled: false,
    });
  });

  it("saves an anyone chat's safety mode and then a plugin, refusing neither", async () => {
    const client = await open(chat(2), chats());
    const dispatch = vi.spyOn(client, "dispatch");
    await press(row("mode", "auto"));
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "connection.update", accessMode: "auto" }),
      ),
    );
    expect(state.alerts).toEqual([]);
    await vi.waitFor(() => expect(section("status")).toBeDefined());
    await press(row("resources", "plugins"));
    await vi.waitFor(() => expect(section("plugins", state.sheet)?.rows.length).toBeGreaterThan(0));
    const plugin = section("plugins", state.sheet)!.rows[0]!;
    if (plugin.kind !== "chips") throw new Error("Not a plugin choice");
    await act(async () => plugin.onChange("read"));
    await act(async () => state.sheet!.sheet!.onClose());
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
    expect(state.alerts).toEqual([]);
  });

  it("offers no Chrome pairing note and no Plugins where the chat's shape does not", async () => {
    const scene = mockConnectedAgents("chats");
    const client = new MockHostClient({
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
    await open(chat(2), client);
    const texts = () =>
      (state.page?.sections ?? []).flatMap((s) => [
        ...s.rows.map((r) => r.label),
        s.footer?.text ?? "",
      ]);
    await vi.waitFor(() => expect(texts()).toContain(agentWords("consent.plugins.title")));
    expect(texts()).not.toContain(agentWords("consent.chromeTabs.repair"));
    act(() => root?.unmount());
    await open(chat(3), client);
    expect(texts()).not.toContain(agentWords("consent.plugins.title"));
  });

  it("warns about Tasks only where Tasks is the person's choice, never on a chat", async () => {
    const warning = agentWords("consent.tasks.warning", { home: "" }).slice(0, 30);
    const footers = () => (state.page?.sections ?? []).map((s) => s.footer?.text ?? "");
    await open(chat(2), chats());
    expect(footers().some((text) => text.startsWith(warning))).toBe(false);
    act(() => root?.unmount());
    await open("mcn_00000000-0000-4000-8000-000000000003");
    expect(footers().some((text) => text.startsWith(warning))).toBe(true);
  });

  it("offers Remove from list on an ended chat only, never on a live or paused one", async () => {
    for (const [n, removable] of [
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ] as const) {
      await open(chat(n), chats());
      const labels = (state.page?.sections ?? []).flatMap((s) => s.rows.map((r) => r.label));
      expect(labels.includes("Remove from list"), `chat ${n}`).toBe(removable);
      act(() => root?.unmount());
    }
  });

  it("says a chat is at work when its page lists a task running, from that one list", async () => {
    await open(chat(1), chats());
    expect(status().label).not.toBe("Not doing anything");
    expect(section("status")?.footer?.text).toContain("Summarize my week");
  });
});
