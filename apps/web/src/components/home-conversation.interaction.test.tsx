// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type {
  MessageEntry,
  RunEntry,
  TranscriptEntry,
  WorkspaceSummary,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { withAccountPreparing } from "@opensteer/client/test-support";
import { AgentTranscript, ConversationActivity } from "./agent-activity.js";
import { AppShell } from "./app-shell.js";
import { Composer } from "./composer.js";
import { HomeRoute } from "./home-view.js";
import { ThreadRoute } from "./thread-view.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reportWorkspaceId = createId("workspace");
const report: MessageEntry = {
  author: {
    displayName: "Mattress research",
    kind: "agent",
    runId: createId("run"),
    threadId: createId("thread"),
    workspaceId: reportWorkspaceId,
    workspaceName: "Main",
  },
  body: `Three options meet your criteria. ${"Evidence, prices and return terms. ".repeat(90)}FINAL SOURCE`,
  createdAt: "2026-09-26T15:00:00.000Z",
  id: "worker-report",
  kind: "message",
  messageKind: "input",
  policy: "report",
  runId: null,
};
const answer: MessageEntry = {
  ...report,
  body: "Here is the shortlist, with the main trade-offs.",
  id: "home-answer",
  messageKind: "assistant",
  runId: "home-run",
};

const preamble: MessageEntry = {
  ...answer,
  body: "I will use the research workflow.",
  id: "preamble",
};
const researchStep: TranscriptEntry = {
  arguments: { command: "research" },
  callId: "research-call",
  completedAt: report.createdAt,
  createdAt: report.createdAt,
  id: "research-tool",
  integration: null,
  isError: false,
  kind: "tool",
  output: { text: "evidence" },
  runId: "home-run",
  state: "done",
  streamText: "",
  tool: { name: "shell", namespace: "codex" },
};
const homeRun: RunEntry = {
  createdAt: report.createdAt,
  error: null,
  id: "run:home-run",
  kind: "run",
  replyMessageId: null,
  runId: "home-run",
  status: "completed",
};
// The recorded Run that showed only these counters under its reply.
const runUsage = {
  cachedInputTokens: 115_456,
  inputTokens: 1_565,
  outputTokens: 1_424,
  reasoningTokens: 1_022,
};

function setup() {
  // Menus and Activity are anchored overlays that follow their anchor's size.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  return { node, root };
}
function button(node: ParentNode, name: string): HTMLButtonElement {
  const found = [...node.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function press(node: ParentNode, name: string) {
  await act(async () => {
    button(node, name).focus();
    button(node, name).click();
  });
}
function menuItems(): string[] {
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
}
async function choose(name: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!item) throw new Error(`Missing menu item: ${name}`);
  await act(async () => item.click());
}
function updateToggle(node: ParentNode): HTMLButtonElement {
  const found = node.querySelector<HTMLButtonElement>(".update-line__toggle");
  if (!found) throw new Error("Missing update line");
  return found;
}

describe("Home conversation", () => {
  it("keeps a worker update to one line naming its sender, opening in place and quotable", async () => {
    const { node, root } = setup();
    const ask = vi.fn();
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript
            conversation
            entries={[report]}
            askAbout={{ label: "Ask about this", quote: ask }}
            // The reader belongs to the Workspace the update came from, so its
            // source is somewhere they can go.
            workspaces={[
              { id: reportWorkspaceId, name: "Research" } as unknown as WorkspaceSummary,
            ]}
          />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain("Mattress research");
    expect(node.textContent).toContain("left a note");
    expect(node.textContent).not.toContain("Three options meet your criteria.");
    expect(node.querySelector(".msg--user")).toBeNull();
    expect(updateToggle(node).getAttribute("aria-expanded")).toBe("false");
    await act(async () => updateToggle(node).click());
    expect(updateToggle(node).getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("FINAL SOURCE");
    await press(node, "Ask about this");
    expect(ask).toHaveBeenCalledWith(report);
    await act(async () => updateToggle(node).click());
    expect(node.textContent).not.toContain("FINAL SOURCE");
    expect(node.querySelector("a")?.getAttribute("href")).toContain("/threads/");
  });

  it("says what woke Opensteer, keeps delivery errors visible, and never truncates Home's own answer", async () => {
    const { node, root } = setup();
    const news: MessageEntry = {
      ...report,
      body: "Your flight moved to 8 pm.",
      delivery: { reason: "Delivery is unconfirmed", status: "unconfirmed" },
      policy: "steer",
    };
    const reminder: MessageEntry = {
      ...report,
      author: {
        displayName: "Morning reminder",
        kind: "trigger",
        occurrenceId: createId("triggerOccurrence"),
        source: "schedule",
        triggerId: createId("trigger"),
      },
      body: "Remind me to call the dentist.",
      id: "trigger-input",
      policy: "queue",
    };
    const fullAnswer = { ...answer, body: report.body };
    const completed: TranscriptEntry = {
      createdAt: report.createdAt,
      error: null,
      id: "run:home-run",
      kind: "run",
      replyMessageId: fullAnswer.id,
      runId: "home-run",
      status: "completed",
    };
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript conversation entries={[reminder, news, completed, fullAnswer]} />
        </MemoryRouter>,
      ),
    );
    const caption = (id: string) =>
      node.querySelector(`[data-message-id="${id}"] .update-line__toggle`)?.firstChild?.textContent;
    expect(caption(reminder.id)).toBe("ran");
    expect(caption(news.id)).toBe("asked Opensteer");
    expect(node.textContent).not.toContain(news.body);
    expect(node.textContent).toContain("Delivery is unconfirmed");
    expect(node.textContent).toContain("FINAL SOURCE");
  });

  it("shows the Run's reply as Opensteer's message, with what it did one menu away", async () => {
    const { node, root } = setup();
    const reply = vi.fn();
    const openActivity = vi.fn();
    const entries: TranscriptEntry[] = [
      {
        createdAt: report.createdAt,
        error: null,
        id: "run:home-run",
        kind: "run",
        replyMessageId: answer.id,
        runId: "home-run",
        status: "completed",
      },
      preamble,
      researchStep,
      answer,
    ];
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript
            conversation
            entries={entries}
            onOpenActivity={openActivity}
            onReply={reply}
          />
        </MemoryRouter>,
      ),
    );
    expect(node.querySelector(".reply__bubble")?.textContent).toContain(answer.body);
    expect(node.textContent).not.toContain(preamble.body);
    expect(node.textContent).not.toContain("Working");
    expect(node.querySelector(".steps-toggle, .conversation-steps")).toBeNull();
    expect(() => button(node, "Show steps")).toThrow();

    await press(node, "More");
    expect(menuItems()).toContain("Run details");
    await choose("Run details");
    expect(openActivity).toHaveBeenCalledWith("turn:run:home-run", button(node, "More"));

    await press(node, "More");
    await choose("Reply");
    expect(reply).toHaveBeenCalledWith(answer);
  });

  it("never shows what a failed Run wrote on the way as its answer", async () => {
    const { node, root } = setup();
    const entries: TranscriptEntry[] = [
      {
        createdAt: report.createdAt,
        error: { code: "failed", message: "One source was unavailable", retryable: false },
        id: "run:home-run",
        kind: "run",
        replyMessageId: null,
        runId: "home-run",
        status: "failed",
        usage: runUsage,
      },
      preamble,
      researchStep,
    ];
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript conversation entries={entries} />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain("One source was unavailable");
    expect(node.querySelector(".reply")).toBeNull();
    expect(node.textContent).not.toContain(preamble.body);
    expect(() => button(node, "Show steps")).toThrow();
  });

  it("shows only Opensteer typing while it answers: no toggle, counter, clock or control", async () => {
    const { node, root } = setup();
    const entries: TranscriptEntry[] = [
      { ...homeRun, status: "running" },
      preamble,
      { ...researchStep, completedAt: null, state: "running" },
    ];
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript activity="working" conversation entries={entries} />
        </MemoryRouter>,
      ),
    );
    const typing = node.querySelector(".typing");
    expect(typing?.getAttribute("role")).toBe("status");
    expect(typing?.closest("button")).toBeNull();
    expect(node.querySelectorAll("button")).toHaveLength(0);
    expect(node.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(node.textContent).not.toContain(preamble.body);
    expect(node.querySelector(".work, .work__clock, .steps-toggle")).toBeNull();
  });

  it("says the AI account is getting ready where typing would stand, and types for an ordinary start", async () => {
    const { node, root } = setup();
    const asked: MessageEntry = { ...report, body: "Plan Friday", id: "asked", policy: "queue" };
    const queuedTurn: TranscriptEntry[] = [asked, { ...homeRun, status: "queued" }];
    const startHold = "Codex 2 is getting ready";
    const draw = (entries: TranscriptEntry[], hold: string | null, conversation = true) =>
      act(async () =>
        root.render(
          <MemoryRouter>
            <AgentTranscript
              activity="queued"
              conversation={conversation}
              entries={entries}
              startHold={hold}
            />
          </MemoryRouter>,
        ),
      );
    // Before the Run has a turn, the line under the conversation says it.
    await draw([asked], startHold);
    expect(node.querySelector(".working__label")?.textContent).toBe(startHold);
    expect(node.querySelector(".typing")).toBeNull();
    // A Run back in its queue has a turn, and the turn says it.
    await draw(queuedTurn, startHold);
    expect(node.querySelector(".working__label")?.textContent).toBe(startHold);
    expect(node.querySelector(".typing")).toBeNull();
    await draw(queuedTurn, startHold, false);
    expect(node.querySelector(".work__label")?.textContent).toBe(startHold);
    // Without a known reason, a start looks as it always has.
    await draw([asked], null);
    expect(node.querySelector(".typing")).not.toBeNull();
    expect(node.querySelector(".working__label")).toBeNull();
    await draw(queuedTurn, null, false);
    expect(node.querySelector(".work__label")?.textContent).toBe("Starting");
  });

  it("keeps a plain answer a message: nothing to open and no usage, while written or after", async () => {
    const { node, root } = setup();
    const draw = (entries: TranscriptEntry[]) =>
      act(async () =>
        root.render(
          <MemoryRouter>
            <AgentTranscript
              activity="working"
              conversation
              entries={entries}
              onOpenActivity={vi.fn()}
              onReply={vi.fn()}
            />
          </MemoryRouter>,
        ),
      );
    const running = { ...homeRun, status: "running" as const, usage: runUsage };
    const writing: MessageEntry = {
      ...answer,
      body: "Here is the short",
      id: "stream:home-run",
      streaming: true,
    };
    for (const entries of [
      [running, writing],
      [running, answer],
    ]) {
      await draw(entries);
      expect(node.querySelector(".typing")?.getAttribute("role")).toBe("status");
      expect(node.querySelectorAll("button")).toHaveLength(0);
      expect(node.textContent).not.toContain("Here is the short");
    }

    await draw([{ ...running, replyMessageId: answer.id, status: "completed" }, answer]);
    expect(node.querySelector(".reply__bubble")?.textContent).toContain(answer.body);
    expect(node.textContent?.split(answer.body)).toHaveLength(2);
    await press(node, "More");
    expect(menuItems()).toContain("Reply");
    expect(menuItems()).not.toContain("Run details");
    expect(node.querySelector(".conversation-steps")).toBeNull();
  });

  it("keeps a reply's Activity to what the turn did, while written and once it answers", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { node, root } = setup();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const draw = (entries: TranscriptEntry[]) =>
      act(async () =>
        root.render(
          <MemoryRouter>
            <ConversationActivity
              anchor={anchor}
              entries={entries}
              live
              onClose={vi.fn()}
              selection={{ kind: "latest" }}
            />
          </MemoryRouter>,
        ),
      );
    const running = { ...homeRun, status: "running" as const, usage: runUsage };
    await draw([
      running,
      preamble,
      researchStep,
      { ...answer, id: "stream:home-run", streaming: true },
    ]);
    // Its steps; the header names the reply by its first words.
    const panel = () =>
      document.querySelector('[role="dialog"][aria-label="Run details"] .activity__body')
        ?.textContent ?? "";
    expect(panel()).toContain(preamble.body);
    expect(panel()).not.toContain(answer.body);

    await draw([
      { ...running, replyMessageId: answer.id, status: "completed" },
      preamble,
      researchStep,
      answer,
    ]);
    expect(panel()).toContain(preamble.body);
    expect(panel()).not.toContain(answer.body);
    // Sentences, not telemetry: no token counts.
    expect(panel()).not.toMatch(/\d+(\.\d+)?k (in|out)|cached/);
    expect(node.textContent).toBe("");
  });

  it("ends a work transcript's answered turn at its reply, with no token counts", async () => {
    const { node, root } = setup();
    const entries: TranscriptEntry[] = [
      { ...homeRun, replyMessageId: answer.id, usage: runUsage },
      researchStep,
      answer,
    ];
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript entries={entries} />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain(answer.body);
    expect(node.textContent).not.toMatch(/\d+(\.\d+)?k (in|out)|cached|Execution details/);
  });

  it("bounds long supporting inputs in work threads without changing their authorship", async () => {
    const { node, root } = setup();
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript entries={[report]} />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain("Mattress research");
    expect(node.textContent).not.toContain("FINAL SOURCE");
    await press(node, "Show more");
    expect(node.textContent).toContain("FINAL SOURCE");
  });

  it("keeps the AI controls in the conversation composer itself, with no settings dialog", async () => {
    const { node, root } = setup();
    const send = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <Composer
          variant="conversation"
          footerExtras={<button type="button">Choose model</button>}
          onSend={send}
          placeholder="Ask anything…"
          restore={{ key: 1, text: "Keep this draft" }}
        />,
      ),
    );
    // One pill in place, as in every composer: no gear, no dialog to open first.
    expect(node.textContent).toContain("Choose model");
    expect(node.querySelector('[aria-label="AI settings"]')).toBeNull();
    expect(node.querySelector("textarea")?.value).toBe("Keep this draft");
    await press(node, "Send message");
    expect(send).toHaveBeenCalledWith(
      "Keep this draft",
      expect.objectContaining({ replay: false }),
    );
  });

  it("offers voice before the first Chat message", async () => {
    stubLayoutApis();
    const client = new MockHostClient({ latencyMs: 0 });
    clients.push(client);
    const base = client.getSnapshot();
    vi.spyOn(client, "getSnapshot").mockReturnValue({ ...base, homeThreadId: null });
    const { node, root } = setup();
    await act(async () =>
      root.render(
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppShell hostClient={client} loadError={null} />}>
                <Route index element={<HomeRoute />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      ),
    );
    expect(node.querySelector('[aria-label="Talk to Opensteer"]')).not.toBeNull();
    expect(node.querySelector(".voice-dock")).not.toBeNull();
  });

  it("uses the routed Home's real settings and opens a task as its own conversation", async () => {
    stubLayoutApis();
    const client = new MockHostClient({ latencyMs: 0 });
    const activate = vi.spyOn(client, "activateThread");
    clients.push(client);
    const { node, root } = setup();
    const initialHome = client.getSnapshot().homeThreadId;
    await act(async () =>
      root.render(
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppShell hostClient={client} loadError={null} />}>
                <Route index element={<HomeRoute />} />
                <Route path="threads/:threadId" element={<ThreadRoute />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      ),
    );
    expect(node.querySelector(".thread--home")).not.toBeNull();
    // Home's composer carries its real execution pill in place.
    expect(node.querySelector(".composer .exec-controls .exec-pill")).not.toBeNull();
    expect(node.querySelector('[aria-label="AI settings"]')).toBeNull();
    const task = node.querySelector<HTMLAnchorElement>("a.task-line__open");
    expect(task).not.toBeNull();
    const workerThreadId = task?.getAttribute("href")?.replace("/threads/", "");
    expect(workerThreadId).not.toBe(initialHome);
    await act(async () => task?.click());
    // The line opens the task itself, whose brief says who asked for it.
    expect(node.querySelector(".input-card__name")?.textContent).toBe("Chat");
    expect(node.querySelector(".assignment-strip")).toBeNull();
    expect(activate).toHaveBeenLastCalledWith(workerThreadId);
  });

  it("keeps successful AI choices in the picker, while retaining errors and fresh-start review", async () => {
    stubLayoutApis();
    // Happy DOM has no layout; the real popover needs an on-screen anchor.
    const rect = new DOMRect(0, 0, 100, 40);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
      Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
    );
    const client = new MockHostClient({ latencyMs: 0 });
    clients.push(client);
    await client.load();
    const home = client
      .getSnapshot()
      .threads.find((item) => item.id === client.getSnapshot().homeThreadId)!;
    const thread = await client.createThread({
      accessMode: home.accessMode,
      environmentId: home.environmentId,
      harnessInstanceId: home.harnessInstanceId,
      modelSelection: home.modelSelection,
      title: "Choose AI quietly",
      workspaceId: home.workspaceId,
    });
    const { node, root } = setup();
    await act(async () =>
      root.render(
        <ToastProvider>
          <MemoryRouter initialEntries={[`/threads/${thread.id}`]}>
            <Routes>
              <Route element={<AppShell hostClient={client} loadError={null} />}>
                <Route path="threads/:threadId" element={<ThreadRoute />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      ),
    );
    const current = () => client.getSnapshot().threads.find((item) => item.id === thread.id)!;
    const openPicker = () =>
      act(async () => node.querySelector<HTMLButtonElement>(".exec-pill")!.click());
    expect(node.querySelector<HTMLButtonElement>(".exec-pill")?.disabled).toBe(false);
    await openPicker();
    expect(node.querySelector(".exec-pill")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("GPT-5.6-Terra");
    await press(document, "GPT-5.6-Terra");
    expect(current().modelSelection.modelId).toBe("gpt-5.6-terra");
    expect(node.querySelector(".exec-pill")?.textContent).toContain("GPT-5.6-Terra");
    expect(node.textContent).not.toContain("Now using");
    expect(node.textContent).not.toContain("Your next message will use");

    await openPicker();
    const changeReasoning = (step: number) =>
      act(async () => {
        const slider = document.querySelector<HTMLInputElement>('input[aria-label="Reasoning"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          slider,
          String(step),
        );
        // A browser fires both as the range settles on a step.
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await changeReasoning(2);
    expect(current().modelSelection.options.effort).toBe("high");
    expect(node.querySelector(".exec-pill")?.textContent).toContain("High");
    expect(node.querySelector(".thread__selection-note")).toBeNull();

    vi.spyOn(client, "updateThreadExecution").mockRejectedValueOnce(
      new Error("The account went offline."),
    );
    await changeReasoning(0);
    expect(current().modelSelection.options.effort).toBe("high");
    expect(node.textContent).toContain("The account went offline.");

    await act(async () =>
      document.querySelector<HTMLButtonElement>(".execution-menu__bottom")!.click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.trim().startsWith("Start fresh with Codex"))!
        .click(),
    );
    expect(document.body.textContent).toContain("Start fresh with Codex?");
    expect(document.body.textContent).toContain("Your messages stay here.");
    await press(document, "Keep this session");
    expect(current().providerSessionId).toBe(thread.providerSessionId);
  });

  it("says a task waits on its worker's own AI account while that account gets ready", async () => {
    stubLayoutApis();
    const client = new MockHostClient({ latencyMs: 0 });
    clients.push(client);
    const base = client.getSnapshot();
    const task = Object.values(base.assignments).find(({ status }) => status === "open");
    // Chat runs on Codex; the task it handed out runs on another account.
    const workerAccount = base.harnesses.find(({ name }) => name === "Codex 2");
    if (!task || !workerAccount) throw new Error("The seeded task or account is missing.");
    vi.spyOn(client, "getSnapshot").mockReturnValue({
      ...base,
      assignments: {
        ...base.assignments,
        [task.id]: {
          ...task,
          currentRunStatus: "queued",
          workerThread: { ...task.workerThread, pendingRequests: 0 },
        },
      },
      connection: "connected",
      environments: withAccountPreparing(base.environments, workerAccount),
      // Nothing is asked of anybody: the task only waits for its account.
      requests: { ...base.requests, [task.workerThread.id]: [] },
      threads: base.threads.map((thread) =>
        thread.id === task.workerThread.id
          ? {
              ...thread,
              harnessInstanceId: workerAccount.id,
              harnessLabel: workerAccount.name,
              pendingRequests: 0,
            }
          : thread,
      ),
      waitingRequests: [],
    });
    const { node, root } = setup();
    await act(async () =>
      root.render(
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppShell hostClient={client} loadError={null} />}>
                <Route index element={<HomeRoute />} />
                <Route path="threads/:threadId" element={<ThreadRoute />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      ),
    );
    // The line keeps its word and says under its title why it has not started.
    expect(node.querySelector(".task-line__state")?.textContent).toBe("Waiting to start");
    expect(node.querySelector(".task-line__note")?.textContent).toBe("Codex 2 is getting ready.");
    await act(async () => node.querySelector<HTMLAnchorElement>("a.task-line__open")?.click());
    // The task's head says why it has not started, under its name.
    expect(node.querySelector(".conv-header__cause")?.textContent).toBe(
      "Codex 2 is getting ready.",
    );
  });

  it("says Chat's spent plan quietly under the composer until that limit is dismissed", async () => {
    stubLayoutApis();
    const client = new MockHostClient({ latencyMs: 0 });
    clients.push(client);
    const snapshot = client.getSnapshot();
    const chat = snapshot.threads.find(({ id }) => id === snapshot.homeThreadId);
    const environment = snapshot.environments.find(({ id }) => id === chat?.environmentId);
    const catalog = environment?.harnessCatalogs.find(
      ({ harnessInstanceId }) => harnessInstanceId === chat?.harnessInstanceId,
    );
    if (!chat || !environment || !catalog) throw new Error("The seeded Chat account is missing.");
    const spend = (resetsAt: Date) =>
      act(() =>
        client.setHarnessCatalog(environment.id, {
          ...catalog,
          connections: catalog.connections.map((connection) => ({
            ...connection,
            usage: {
              limitReached: true,
              observedAt: new Date().toISOString(),
              windows: [{ label: "weekly", resetsAt: resetsAt.toISOString(), usedPercent: 100 }],
            },
          })),
        }),
      );
    const day = 24 * 60 * 60 * 1_000;
    spend(new Date(Date.now() + 2 * day));
    const app = (
      <ToastProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route index element={<HomeRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    );
    let { node, root } = setup();
    await act(async () => root.render(app));
    const notice = () => node.querySelector<HTMLElement>(".usage-notice");
    // Below the composer, outside its surface, and without the account's address.
    expect(notice()?.textContent).toMatch(/^Codex usage limit · Resets /u);
    expect(notice()?.textContent).not.toContain("@");
    expect(node.querySelector(".composer .usage-notice")).toBeNull();
    const composer = node.querySelector(".composer-dock .composer");
    expect(composer?.compareDocumentPosition(notice()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const field = node.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        "Keep this draft",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await press(node, "Dismiss usage notice");
    // Only the notice goes: the draft stays, and the keyboard goes back to it.
    expect(notice()).toBeNull();
    expect(field.value).toBe("Keep this draft");
    expect(document.activeElement).toBe(field);

    // Dismissed for this limit, also once Chat is opened again.
    act(() => root.unmount());
    ({ node, root } = setup());
    await act(async () => root.render(app));
    expect(notice()).toBeNull();
    // The account's next window is another limit, and is said again.
    spend(new Date(Date.now() + 9 * day));
    expect(notice()?.textContent).toMatch(/^Codex usage limit · Resets /u);
  });
});

/** jsdom has neither, and the routed shell measures its layout with both. */
function stubLayoutApis(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    Object.assign(new EventTarget(), {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    }),
  );
}

it("quiet Chat hides non-human work, names its reply source and opens homeRun human Activity", async () => {
  const { node, root } = setup();
  const open = vi.fn();
  const waking = { ...report, runId: homeRun.runId, policy: "queue" as const };
  const automated = { ...homeRun, startedBy: report.author };
  const render = async (entries: TranscriptEntry[]) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript
            conversation
            entries={entries}
            onOpenActivity={open}
            workspaces={[
              {
                id: reportWorkspaceId,
                homeThreadId: null,
                description: "",
                fileCount: 0,
                harnessLabel: "Codex",
                kind: "specialized",
                machineName: null,
                name: "Research",
                icon: null,
                runnerLabel: "",
                storageIssue: null,
                color: null,
                updatedAt: "2026-09-26T15:00:00.000Z",
                status: "ready",
              } satisfies WorkspaceSummary,
            ]}
          />
        </MemoryRouter>,
      ),
    );
  await render([waking, { ...automated, status: "running" }]);
  expect(node.textContent).toBe("");
  await render([waking, automated]);
  expect(node.textContent).toBe("");
  await render([waking, { ...automated, replyMessageId: answer.id }, answer]);
  expect(node.textContent).toContain(answer.body);
  expect(node.querySelector(".update-line")).toBeNull();
  expect(node.querySelector('a[href^="/threads/"]')?.textContent).toContain("Mattress research");
  await render([{ ...homeRun, startedAt: homeRun.createdAt, endedAt: "2026-09-26T15:02:00.000Z" }]);
  await press(node, "Worked for 2m");
  expect(open).toHaveBeenCalled();
  const human = { kind: "human" as const, displayName: "You", principalId: "person" };
  await render([
    {
      ...homeRun,
      personWaiting: true,
      startedBy: human,
      status: "failed",
      error: { code: "failed", message: "Could not finish", retryable: false },
    },
  ]);
  expect(node.textContent).toContain("Could not finish");
  await render([{ ...homeRun, personWaiting: true, startedBy: human, status: "interrupted" }]);
  expect(node.textContent).toContain("Stopped.");
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AgentTranscript
          entries={[
            { ...homeRun, startedAt: homeRun.createdAt, endedAt: "2026-09-26T15:02:00.000Z" },
          ]}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Worked for 2m");
});
