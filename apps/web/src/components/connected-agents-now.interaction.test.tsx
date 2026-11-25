// @vitest-environment happy-dom
import { ClientOperationError } from "@opensteer/client/connections";
import { placeList } from "@opensteer/client/host";
import {
  mockAgentWorkThreads,
  mockConnectedAgents,
  type MockAgentWorkLiveScene,
} from "@opensteer/client/mock";
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  client,
  goTo,
  history,
  mount,
  resize,
} from "./workspace/workspace.interaction.test-support.js";

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

it("reserves no row, panel or pill and reads no activity while idle, even with the 728 px drawer closed", async () => {
  const activity = vi.fn();
  await mount("/", {
    ...options(),
    hostClient(source) {
      const read = source.rpc["threads.activity"];
      Object.defineProperty(source.rpc, "threads.activity", {
        value: (...args: Parameters<typeof read>) => {
          activity(...args);
          return read(...args);
        },
        configurable: true,
      });
      return source;
    },
  });
  expect(document.querySelector(".agents-now")).toBeNull();
  expect(panel()).toBeNull();
  await act(async () => button("Collapse sidebar")!.click());
  expect(document.querySelector(".agents-now")).toBeNull();
  await resize(728);
  expect(document.querySelector('button.drawer-btn[aria-controls="app-sidebar"]')).not.toBeNull();
  expect(document.querySelector("#app-sidebar")?.getAttribute("aria-hidden")).toBe("true");
  expect(document.querySelector(".agents-now")).toBeNull();
  expect(panel()).toBeNull();
  expect(activity).not.toHaveBeenCalled();
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
  for (const name of ["ChatGPT", "Claude", "“\u2068Grok\u2069”"]) {
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

it("keeps a server refusal and a lost Stop answer visible without retrying either", async () => {
  await mount("/", options("three"));
  const dialog = await openPanel();
  const send = client.dispatch.bind(client);
  const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
    if (command.type === "agent.session.stop") {
      if (command.threadId === mockAgentWorkThreads.working)
        throw new ClientOperationError("The Home refused Stop", "blocked", {
          code: "forbidden",
          kind: "rejection",
          provenance: "host",
        });
      if (command.threadId === mockAgentWorkThreads.waiting)
        throw new ClientOperationError("Lost the Stop answer", "transient", {
          kind: "transport",
          provenance: "transport",
          retryable: true,
        });
    }
    return send(command);
  });
  await act(async () => button("Stop all", dialog)!.click());
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
    "Couldn’t confirm Stop for “Grok”, Claude.",
  );
  expect(dialog.querySelectorAll("li")).toHaveLength(2);
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
});

it("names a connection only once when two of its sessions have unconfirmed Stops", async () => {
  await mount("/", {
    ...options("three"),
    hostClient: (source) => {
      source.mockAgentWork({ livePanel: "three" });
      const threads = source.getSnapshot().threads;
      const other = threads.find(({ id }) => id === mockAgentWorkThreads.waiting)!.externalWork!;
      const claude = threads.find(({ id }) => id === mockAgentWorkThreads.working)!.externalWork!;
      (other as { connection: typeof other.connection }).connection = claude.connection;
      return source;
    },
  });
  const dialog = await openPanel();
  const send = client.dispatch.bind(client);
  vi.spyOn(client, "dispatch").mockImplementation((command) =>
    command.type === "agent.session.stop" && command.threadId !== mockAgentWorkThreads.shopping
      ? Promise.reject(new Error("Lost the Stop answer"))
      : send(command),
  );
  await act(async () => button("Stop all", dialog)!.click());
  expect(dialog.querySelectorAll("li")).toHaveLength(2);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
    "Couldn’t confirm Stop for Claude.",
  );
});

it("distinguishes matching rows for different connections by their catalog age", async () => {
  const seeded = mockConnectedAgents("seeded");
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000 - 120_000).toISOString();
  await mount("/", {
    mock: {
      ...seeded,
      connections: seeded.connections.map((row) =>
        row.label === "Claude"
          ? { ...row, createdAt: ago(1) }
          : row.label === "Grok"
            ? { ...row, createdAt: ago(2) }
            : row,
      ),
    },
    hostClient(source) {
      source.mockAgentWork({ livePanel: "three" });
      const { threads } = source.getSnapshot();
      const first = threads.find(({ id }) => id === mockAgentWorkThreads.working)!.externalWork!;
      const second = threads.find(({ id }) => id === mockAgentWorkThreads.waiting)!.externalWork!;
      (second as { connection: typeof second.connection }).connection = {
        ...first.connection,
        id: second.connection.id,
      };
      Object.defineProperty(source.rpc, "threads.activity", {
        value: async () => ({ ok: true, data: { operations: [], nextBefore: null } }),
        configurable: true,
      });
      return source;
    },
  });
  const dialog = await openPanel();
  await vi.waitFor(() => {
    expect(button("Stop Claude — Connected 1h ago", dialog)).toBeDefined();
    expect(button("Watch Claude — Connected 2h ago", dialog)).toBeDefined();
    expect(dialog.textContent).toContain("Connected 1h ago");
    expect(dialog.textContent).toContain("Connected 2h ago");
    expect(button("Stop ChatGPT", dialog)).toBeDefined();
  });
});

it("keeps the last operations for a task whose activity refresh fails", async () => {
  await mount("/", options("one"));
  expect(trigger()?.getAttribute("aria-label")).toBe("ChatGPT is working in Shopping");
  const refresh = vi.fn(async () => {
    throw new Error("Activity read did not answer");
  });
  Object.defineProperty(client.rpc, "threads.activity", { value: refresh, configurable: true });
  const dialog = await openPanel();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(dialog.textContent).toContain("Run a script on Shopping");
  expect(trigger()?.getAttribute("aria-label")).toBe("ChatGPT is working in Shopping");
});

it("quotes and isolates a self-declared product name on the row, its actions and Stop warning", async () => {
  await mount("/", {
    ...options("long-one"),
    hostClient: (source) => {
      source.mockAgentWork({ livePanel: "long-one" });
      const connection = source
        .getSnapshot()
        .threads.find(({ id }) => id === mockAgentWorkThreads.shopping)!.externalWork!.connection;
      (connection as { label: string }).label = "Opensteer";
      return source;
    },
  });
  const name = "“\u2068Opensteer\u2069”";
  expect(trigger()?.getAttribute("aria-label")).toContain(name);
  expect(button(`Stop ${name}`)).toBeDefined();
  const dialog = await openPanel();
  expect(dialog.querySelector("strong")?.textContent).toBe("“Opensteer”");
  expect(dialog.querySelector("strong bdi")?.textContent).toBe("Opensteer");
  expect(button(`Watch ${name}`, dialog)).toBeDefined();
  const send = client.dispatch.bind(client);
  vi.spyOn(client, "dispatch").mockImplementation((command) =>
    command.type === "agent.session.stop"
      ? Promise.reject(new Error("Lost the Stop answer"))
      : send(command),
  );
  await act(async () => button(`Stop ${name}`, dialog)!.click());
  const warning = dialog.querySelector('[role="status"]');
  expect(warning?.textContent).toBe("Couldn’t confirm Stop for “Opensteer”.");
  expect(warning?.querySelector("bdi")?.textContent).toBe("Opensteer");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  const inline = document.querySelector(".agents-now__inline-error");
  expect(inline?.querySelector("bdi")?.textContent).toBe("Opensteer");
});

it("keeps Claude’s unconfirmed Stop while another session’s Stop is confirmed", async () => {
  await mount("/", options("three"));
  let dialog = await openPanel();
  const send = client.dispatch.bind(client);
  const dispatch = vi
    .spyOn(client, "dispatch")
    .mockImplementation((command) =>
      command.type === "agent.session.stop" && command.threadId === mockAgentWorkThreads.working
        ? Promise.reject(new Error("Lost the Stop answer"))
        : send(command),
    );
  const warning = () => dialog.querySelector('[role="status"]')?.textContent;
  await act(async () => button("Stop Claude", dialog)!.click());
  expect(warning()).toBe("Couldn’t confirm Stop for Claude.");
  await act(async () => button("Stop ChatGPT", dialog)!.click());
  expect(warning()).toBe("Couldn’t confirm Stop for Claude.");
  await act(async () => button("Collapse sidebar")!.click());
  dialog = await openPanel();
  expect(warning()).toBe("Couldn’t confirm Stop for Claude.");
  dispatch.mockRestore();
  await act(async () => button("Stop Claude", dialog)!.click());
  expect(warning()).toBeUndefined();
});

it("quotes and isolates a self-declared name on Review", async () => {
  await mount("/", {
    ...options("needs-you"),
    hostClient: (source) => {
      source.mockAgentWork({ livePanel: "needs-you" });
      const threads = source.getSnapshot().threads;
      const waiting = threads.find(({ id }) => id === mockAgentWorkThreads.waiting)!.externalWork!;
      const grok = threads.find(({ id }) => id === mockAgentWorkThreads.working)!.externalWork!;
      (waiting as { connection: typeof waiting.connection }).connection = {
        ...grok.connection,
        label: "Opensteer",
      };
      return source;
    },
  });
  const dialog = await openPanel();
  expect(button("Review “\u2068Opensteer\u2069”", dialog)).toBeDefined();
});

it("dispatches only one Stop while two presses overlap", async () => {
  await mount("/", options("one"));
  const dialog = await openPanel();
  const send = client.dispatch.bind(client);
  const released = Promise.withResolvers<void>();
  const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
    if (command.type === "agent.session.stop") await released.promise;
    return send(command);
  });
  const stop = button("Stop ChatGPT", dialog)!;
  await act(async () => {
    stop.click();
    stop.click();
  });
  const sentWhilePending = stopCommands(dispatch.mock.calls);
  await act(async () => released.resolve());
  expect(sentWhilePending).toHaveLength(1);
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

it("mounts the active-agent pill only in the selected app tab’s header", async () => {
  await mount("/", options("three"));
  const tabs = placeList(client.getSnapshot()).filter(({ kind }) => kind === "app");
  expect(tabs).toHaveLength(2);
  await act(async () => button("Collapse sidebar")!.click());
  for (const { key } of tabs)
    await act(async () => goTo!(`/?panel=browser&tab=${encodeURIComponent(key)}`));
  expect(document.querySelectorAll(".place--opensteer-app")).toHaveLength(2);
  expect(document.querySelectorAll(".agents-now--compact")).toHaveLength(1);
  expect(
    document.querySelector(".place--opensteer-app:not([hidden]) header .agents-now--compact"),
  ).not.toBeNull();
  expect(document.querySelector(".place--opensteer-app[hidden] header")).toBeNull();
});
