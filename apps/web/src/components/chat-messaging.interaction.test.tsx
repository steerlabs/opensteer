// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestSchema,
  RunIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
  createId,
  type Request,
} from "@opensteer/core";
import {
  conversationTurnRevealing,
  groupTranscriptEntries,
  type HostSnapshot,
  type MessageEntry,
  type ReasoningEntry,
  type RunEntry,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AgentTranscript, ConversationActivity } from "./agent-activity.js";
import { AppShell } from "./app-shell.js";
import { HomeRoute } from "./home-view.js";
import { ThreadRoute } from "./thread-view.js";
import { ToastProvider } from "./toast.js";

/*
 * Chat is a conversation: a message sent while Opensteer is replying joins the
 * reply, and what a reply did opens on request. A work Thread keeps its queue.
 *
 * What can go wrong, in the app as a person uses it:
 *   G1  Chat while busy shows queued messages, Steer, Edit, Remove, Paused or
 *       Resume, or calls Send "Queue message"; the person's message is not
 *       drawn as a sent bubble at the foot of the conversation.
 *   G2  A work Thread's waiting message is not drawn unsent at the foot of the
 *       conversation, or loses Steer, Edit, Remove, the pause a Stop leaves,
 *       Resume, or its "Queue message" label; a steered message is not marked.
 *   G4  With an approval docked, typing answers or declines the approval
 *       instead of sending a message, or the approval's buttons disappear.
 *   G7  Waiting shows anything but the typing bubble: a steps toggle, counters
 *       or durations.
 *   G8  Activity cannot be opened from the typing or a reply, does not take
 *       focus, will not close on Escape, outside or a second press, does not
 *       give focus back, or is not a sheet on a narrow screen; the reply
 *       menu's keys fail.
 *   G9  A link to something said on the way to a reply finds nothing to open.
 *   G11 Chat's Stop says it pauses a task or stops a run.
 *   Stop in Chat pauses it, so the next Send waits for a Resume nobody offers.
 *   F1  A message joins the reply under way, and the reply's next step renames
 *       it: its typing starts over, and the Activity open on it shows nothing.
 *   F3  A conversation's header is anything but its name — Chat's, or a direct
 *       message's — or poses as a control; the way into Activity is announced
 *       by anything but what it opens.
 */

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

const homeId = "thr_00000000-0000-4000-8000-000000000001";
const homeRunId = "run_00000000-0000-4000-8000-000000000001";
// Said by the seeded Chat's Run on the way to a reply it has not given yet.
const saidOnTheWay = "msg_00000000-0000-4000-8000-000000000002";
const liveWorkThreadId = "thr_00000000-0000-4000-8000-000000000006";

function stubLayout({ narrow = false }: { readonly narrow?: boolean } = {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    Object.assign(new EventTarget(), {
      addListener() {},
      matches: narrow && query.includes("max-width: 620px"),
      media: query,
      onchange: null,
      removeListener() {},
    }),
  );
}

async function mount(client: MockHostClient, path = "/"): Promise<HTMLDivElement> {
  clients.push(client);
  await client.load();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
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
  return node;
}

function buttons(scope: ParentNode): HTMLButtonElement[] {
  return [...scope.querySelectorAll("button")];
}

function named(scope: ParentNode, name: string): HTMLButtonElement | undefined {
  return buttons(scope).find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
}

/** A docked Request's option, by the label it shows beside its shortcut number. */
function option(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return buttons(scope).find(
    (item) =>
      item.classList.contains("action-row") &&
      item.querySelector(".action-row__label")?.textContent === label,
  );
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = named(scope, name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function type(node: ParentNode, text: string) {
  const field = node.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!field) throw new Error("Missing composer");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...init }));
  });
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.click();
  });
}

/** What the conversation shows, top to bottom: the reader's bubbles, replies and typing. */
function conversationOrder(node: ParentNode): string[] {
  return [
    ...node.querySelectorAll(".transcript .msg--user, .transcript .reply, .transcript .typing"),
  ].map((element) =>
    element.classList.contains("typing")
      ? "typing"
      : element.classList.contains("reply")
        ? "reply"
        : `you:${element.textContent?.trim()}`,
  );
}

/** Activity, as a popover beside the conversation or as a sheet over it. */
function activityDialog(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (dialog) =>
        dialog.getAttribute("aria-label") === "Run details" ||
        dialog.querySelector(".dialog__title")?.textContent === "Run details",
    ) ?? null
  );
}

// A Thread of the seeded Deployment, read here as a person's direct message:
// a conversation that is not their Chat.
const directThreadId = "thr_00000000-0000-4000-8000-000000000002";

function directMessage(client: MockHostClient, threadId: string, title: string): MockHostClient {
  const read = client.getSnapshot;
  let source: HostSnapshot | null = null;
  let shown: HostSnapshot | null = null;
  Object.defineProperty(client, "getSnapshot", {
    value: (): HostSnapshot => {
      const next = read();
      if (next !== source || shown === null) {
        source = next;
        shown = {
          ...next,
          threads: next.threads.map((thread) =>
            thread.id === threadId ? { ...thread, role: "conversation" as const, title } : thread,
          ),
        };
      }
      return shown;
    },
  });
  return client;
}

function chatApproval(): Request {
  return RequestSchema.parse({
    callId: "send-email",
    cancellationReason: null,
    createdAt: "2026-10-09T10:00:00.000Z",
    id: createId("request"),
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: homeRunId,
    originatingThreadId: homeId,
    originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
    payload: { kind: "harness.approval" },
    presentation: {
      detail: "From your Gmail · Moving Thursday’s review",
      kind: "choice",
      options: [
        { hint: "allow-once", id: "allow", label: "Allow once" },
        { hint: "reject-once", id: "reject", label: "Not now" },
      ],
      risk: "medium",
      title: "Send email to Maya Chen?",
    },
    requestedBy: "usr_0192f4a1-0000-4000-8000-000000000001",
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  });
}

describe("Chat while Opensteer is replying", () => {
  it("sends into the reply in progress: an ordinary bubble at the foot, no queue and no Steer (G1, G7, G11)", async () => {
    stubLayout();
    const node = await mount(new MockHostClient({ latencyMs: 0 }));

    // Waiting is the typing bubble alone: a status whose one control opens Activity.
    const typing = node.querySelector(".transcript .typing");
    expect(typing?.getAttribute("role")).toBe("status");
    expect(typing?.querySelectorAll("button")).toHaveLength(1);
    expect(typing?.querySelector("button")?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(typing?.textContent).toBe("");
    expect(
      node.querySelector(".steps-toggle, .conversation-steps, .work__clock, .work__meta"),
    ).toBeNull();
    expect(node.querySelector(".transcript")?.textContent).not.toMatch(
      /Show steps|Hide steps|Worked for|Thought for|\d+(\.\d+)?k (in|out)/,
    );
    expect(named(node, "Stop the reply")).toBeDefined();
    expect(named(node, "Pause this task")).toBeUndefined();
    expect(named(node, "Stop the run")).toBeUndefined();

    await type(node, "Keep it short");
    expect(named(node, "Queue message")).toBeUndefined();
    await click(button(node, "Send message"));

    expect(node.querySelector(".queued")).toBeNull();
    for (const absent of [
      "Steer the current run with this message",
      "Edit this message",
      "Remove this message from the queue",
      "Resume",
    ]) {
      expect(named(node, absent), absent).toBeUndefined();
    }
    expect(node.textContent).not.toContain("Paused");
    // Its bubble stands at the foot, and Opensteer types after it: the reply takes it in.
    expect(conversationOrder(node).slice(-2)).toEqual(["you:Keep it short", "typing"]);
    expect(node.querySelectorAll(".transcript .typing")).toHaveLength(1);
  });

  it("keeps the approval's own buttons, and sends typed words as a message that never answers it (G4)", async () => {
    stubLayout();
    const approval = chatApproval();
    const client = new MockHostClient({ latencyMs: 0, pendingRequests: [approval] });
    const dispatch = vi.spyOn(client, "dispatch");
    const node = await mount(client);
    const panels = [...node.querySelectorAll('[aria-label="Opensteer needs your input"]')];
    expect(panels.map((panel) => panel.textContent).join(" ")).toContain(
      "Send email to Maya Chen?",
    );
    expect(option(node, "Allow once")).toBeDefined();
    expect(
      node.querySelector<HTMLTextAreaElement>(".composer textarea")?.placeholder,
    ).not.toContain("instead");

    await type(node, "Make it friendlier");
    await click(button(node, "Send message"));
    const sent = dispatch.mock.calls.map(([command]) => command.type);
    expect(sent).toContain("thread.sendMessage");
    expect(sent).not.toContain("request.respond");
    // The approval still waits for its answer, and the words wait at the foot.
    expect(option(node, "Allow once")).toBeDefined();
    expect(option(node, "Not now")).toBeDefined();
    expect(conversationOrder(node).at(-1)).toBe("you:Make it friendlier");
    expect(node.querySelector(".queued")).toBeNull();

    // Answered with its button, the reply goes on and takes the message in.
    await click(option(node, "Allow once")!);
    await vi.waitFor(() => expect(conversationOrder(node).at(-1)).toBe("reply"));
    expect(conversationOrder(node).slice(-2)).toEqual(["you:Make it friendlier", "reply"]);
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "request.respond"),
    ).toHaveLength(1);
  });

  it("stops the reply without pausing Chat: what was not sent says so, and the next Send replies", async () => {
    stubLayout();
    const node = await mount(new MockHostClient({ latencyMs: 0 }));
    await type(node, "Also check Friday");
    await click(button(node, "Send message"));
    await click(button(node, "Stop the reply"));

    expect(named(node, "Resume")).toBeUndefined();
    expect(node.textContent).not.toContain("Paused");
    expect(node.querySelector(".transcript")?.textContent).toContain(
      "Not sent: you stopped the reply.",
    );
    expect(node.querySelector(".transcript .typing")).toBeNull();
    expect(named(node, "Stop the reply")).toBeUndefined();

    await type(node, "Just Thursday then");
    await click(button(node, "Send message"));
    await vi.waitFor(() => expect(conversationOrder(node).at(-1)).toBe("reply"));
    expect(conversationOrder(node).slice(-2)).toEqual(["you:Just Thursday then", "reply"]);
    expect(node.querySelector(".queued")).toBeNull();
  });
});

describe("a work Thread keeps its queue (G2, G11)", () => {
  it("queues unsent at the foot with Steer, Edit and Remove, and Stop pauses until Resume", async () => {
    stubLayout();
    const client = new MockHostClient({ latencyMs: 0 });
    const node = await mount(client, `/threads/${liveWorkThreadId}`);
    expect(named(node, "Stop the run")).toBeDefined();
    expect(named(node, "Stop the reply")).toBeUndefined();
    // A task's title is only its title.
    expect(node.querySelector(".thread__header h1 button")).toBeNull();

    await type(node, "Then rename the branch");
    expect(named(node, "Queue message")).toBeDefined();
    await click(button(node, "Queue message"));
    await type(node, "And tag the release");
    await click(button(node, "Queue message"));

    // Waiting work stands unsent at the conversation's foot, after the turn under way.
    const queued = node.querySelector<HTMLElement>(".transcript .queued");
    expect(queued?.previousElementSibling?.classList.contains("queued")).toBe(false);
    expect(node.querySelector(".transcript")?.lastElementChild).toBe(queued);
    const bubbles = [...queued!.querySelectorAll(".msg--queued .msg--user")];
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
      "Then rename the branch",
      "And tag the release",
    ]);
    for (const name of [
      "Steer the current run with this message",
      "Edit this message",
      "Remove this message from the queue",
    ]) {
      expect(named(queued!, name), name).toBeDefined();
    }

    // Steered, it joins the turn under way: sent where it stands, and marked.
    await click(button(queued!, "Steer the current run with this message"));
    await vi.waitFor(() => {
      const sent = [...node.querySelectorAll(".transcript .msg--user-row:not(.msg--queued)")].find(
        (row) => row.textContent?.includes("Then rename the branch"),
      );
      expect(sent?.querySelector(".msg__steer")?.textContent).toBe("Steer");
    });
    expect(
      [...node.querySelectorAll(".queued .msg--user")].map((bubble) => bubble.textContent),
    ).toEqual(["And tag the release"]);

    await click(button(node, "Stop the run"));
    await vi.waitFor(() =>
      expect(node.querySelector(".transcript .queued__paused")?.textContent).toContain("Paused"),
    );
    expect(named(node, "Resume")).toBeDefined();
  });
});

describe("Run details", () => {
  it("opens from the typing, takes focus, closes on a second press, and gives focus back (G8)", async () => {
    stubLayout();
    const node = await mount(new MockHostClient({ latencyMs: 0 }));
    const opener = node.querySelector<HTMLButtonElement>(".transcript .typing button");
    expect(opener?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(opener?.getAttribute("aria-expanded")).toBe("false");

    await click(opener!);
    const dialog = activityDialog();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBeNull();
    expect(opener?.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.id).toBeTruthy();
    expect(opener?.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(dialog?.textContent).toContain("Run details");
    // The reply in progress: what its Run has said and done so far, as steps.
    expect(dialog?.textContent).toContain("The foundation is taking shape");
    expect(dialog?.textContent).not.toMatch(/\d+(\.\d+)?k (in|out)|Worked for/);

    await press(document.activeElement!, "Escape");
    expect(activityDialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(opener?.getAttribute("aria-expanded")).toBe("false");

    await click(opener!);
    expect(activityDialog()).not.toBeNull();
    await act(async () => {
      node
        .querySelector(".transcript")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(activityDialog()).toBeNull();

    await click(opener!);
    await click(button(activityDialog()!, "Close run details"));
    expect(activityDialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Pressed again, the control that opened it closes it, rather than the
    // press reading as one outside that closes it and reopens it at once.
    await click(opener!);
    expect(activityDialog()).not.toBeNull();
    await act(async () => {
      opener!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(activityDialog()).not.toBeNull();
    await click(opener!);
    expect(activityDialog()).toBeNull();
    expect(opener?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a reply's own Activity from its menu, by pointer or keys, and returns to the menu's button (G8)", async () => {
    stubLayout();
    const node = await mount(new MockHostClient({ latencyMs: 0 }));
    const more = node.querySelector<HTMLButtonElement>(
      '.transcript .reply button[aria-label="More"]',
    );
    expect(more?.getAttribute("aria-haspopup")).toBe("menu");
    // The reply has no separate list icon any more.
    expect(node.querySelector('.transcript [aria-label="Show steps"]')).toBeNull();

    await click(more!);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(more?.getAttribute("aria-controls")).toBe(menu?.id);
    expect(menu?.id).toBeTruthy();
    const items = () =>
      [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map((item) =>
        item.textContent?.trim(),
      );
    expect(items()).toEqual(
      navigator.clipboard ? ["Reply", "Copy", "Run details"] : ["Reply", "Run details"],
    );
    expect(document.activeElement?.textContent?.trim()).toBe("Reply");
    await press(document.activeElement!, "End");
    expect(document.activeElement?.textContent?.trim()).toBe("Run details");
    await press(document.activeElement!, "Home");
    expect(document.activeElement?.textContent?.trim()).toBe("Reply");
    await press(document.activeElement!, "ArrowUp");
    expect(document.activeElement?.textContent?.trim()).toBe("Run details");
    await press(document.activeElement!, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);

    await click(more!);
    await press(document.activeElement!, "Tab");
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await click(more!);
    const activity = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Run details",
    );
    await click(activity!);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const dialog = activityDialog();
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
    // The reply's More owns what it opened; the typing does not claim it.
    const typing = node.querySelector<HTMLButtonElement>(".transcript .typing button");
    expect(typing?.getAttribute("aria-expanded")).toBe("false");
    expect(typing?.hasAttribute("aria-controls")).toBe(false);
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(more?.getAttribute("aria-controls")).toBe(dialog?.id);
    // This reply's Activity: the task it handed out, not the reply in progress.
    expect(dialog?.textContent).not.toContain("The foundation is taking shape");
    await press(document.activeElement!, "Escape");
    expect(activityDialog()).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(more?.hasAttribute("aria-controls")).toBe(false);
  });

  it("leaves the header the conversation's name, and names its way in by what it opens (F3)", async () => {
    stubLayout();
    const chat = await mount(new MockHostClient({ latencyMs: 0 }));
    // The name is Chat's, with Opensteer's orb, and plain: what Chat started
    // is its family's, beside the name, not a menu under it.
    const heading = chat.querySelector(".conv-header h1");
    expect(heading?.querySelector(".conv-header__name")?.textContent).toBe("Chat");
    expect(heading?.querySelector("button")).toBeNull();
    expect(chat.querySelector(".task-family-button")?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chat.querySelector(".conv-header .chat-orb")).not.toBeNull();
    const typing = chat.querySelector<HTMLButtonElement>(".transcript .typing button");
    expect(typing?.getAttribute("aria-label")).toMatch(/what Opensteer is doing/i);

    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    stubLayout({ narrow: true });
    const narrow = await mount(new MockHostClient({ latencyMs: 0 }));
    // Narrow, the same head names the conversation the same way.
    expect(narrow.querySelector(".conv-header .conv-header__name")?.textContent).toBe("Chat");

    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    stubLayout();
    const direct = await mount(
      directMessage(new MockHostClient({ latencyMs: 0 }), directThreadId, "Ana Lopez"),
      `/threads/${directThreadId}`,
    );
    const name = direct.querySelector(".conv-header h1");
    expect(name?.querySelector(".conv-header__name")?.textContent).toBe("Ana Lopez");
  });

  it("is a sheet on a narrow screen (G8)", async () => {
    stubLayout({ narrow: true });
    const node = await mount(new MockHostClient({ latencyMs: 0 }));
    const opener = node.querySelector<HTMLButtonElement>(".transcript .typing button");
    expect(opener).not.toBeNull();
    await click(opener!);
    const sheet = document.querySelector<HTMLElement>('.dialog[role="dialog"]');
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    expect(sheet?.querySelector(".dialog__title")?.textContent).toBe("Run details");
    expect(opener?.getAttribute("aria-expanded")).toBe("true");
    expect(opener?.getAttribute("aria-controls")).toBe(sheet?.id);
    expect(sheet?.textContent).toContain("The foundation is taking shape");
    expect(sheet?.contains(document.activeElement)).toBe(true);
    await press(document.activeElement!, "Escape");
    expect(document.querySelector('.dialog[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens the Activity that holds a linked message said on the way to a reply (G9)", async () => {
    stubLayout();
    const node = await mount(new MockHostClient({ latencyMs: 0 }), `/?messageId=${saidOnTheWay}`);
    await vi.waitFor(() => expect(activityDialog()).not.toBeNull());
    const found = activityDialog()?.querySelector(`[data-message-id="${saidOnTheWay}"]`);
    expect(found).not.toBeNull();
    // Nothing in the conversation itself is forced open to show it.
    expect(node.querySelector(`.transcript [data-message-id="${saidOnTheWay}"]`)).toBeNull();
  });
});

describe("a reply a message joined (F1)", () => {
  const runId = "run_00000000-0000-4000-8000-0000000000f1";
  const person = { displayName: "Alex", kind: "human" as const, principalId: "user:alex" };
  const ask: MessageEntry = {
    author: person,
    body: "Plan the trip to Lisbon",
    createdAt: "2026-10-09T10:00:00.000Z",
    id: "msg_00000000-0000-4000-8000-0000000000a1",
    kind: "message",
    messageKind: "input",
    runId,
  };
  const more: MessageEntry = {
    ...ask,
    body: "Also book the hotel",
    id: "msg_00000000-0000-4000-8000-0000000000a2",
  };
  const run: RunEntry = {
    createdAt: "2026-10-09T10:00:00.000Z",
    error: null,
    id: `run:${runId}`,
    kind: "run",
    replyMessageId: null,
    runId,
    status: "running",
  };
  function thought(block: string, text: string): ReasoningEntry {
    return {
      completedAt: "2026-10-09T10:00:01.000Z",
      createdAt: "2026-10-09T10:00:01.000Z",
      id: `reasoning:${runId}:${block}`,
      kind: "reasoning",
      runId,
      state: "done",
      text,
    };
  }
  const note: MessageEntry = {
    author: {
      displayName: "Opensteer",
      kind: "agent",
      runId: RunIdSchema.parse(runId),
      threadId: ThreadIdSchema.parse(homeId),
      workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001"),
      workspaceName: "Main",
    },
    body: "Checking flights first.",
    createdAt: "2026-10-09T10:00:01.000Z",
    id: "msg_00000000-0000-4000-8000-0000000000b1",
    kind: "message",
    messageKind: "assistant",
    runId,
  };
  const joined: TranscriptEntry[] = [ask, run, note, thought("1", "Looking at flights."), more];
  const stepped: TranscriptEntry[] = [...joined, thought("2", "Comparing hotels.")];

  it("keeps its typing and the Activity a link opened on it as its next step arrives", () => {
    stubLayout();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    roots.push(root);
    // What a link to the note opens, as the conversation works it out.
    const linked = conversationTurnRevealing(groupTranscriptEntries(joined), note.id);
    expect(linked).toBe(`turn:run:${runId}`);
    const draw = (entries: TranscriptEntry[]) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <AgentTranscript activity="working" conversation entries={entries} />
            <ConversationActivity
              anchor={anchor}
              entries={entries}
              live
              onClose={() => undefined}
              reveal={note.id}
              selection={{ key: linked!, kind: "turn" }}
            />
          </MemoryRouter>,
        ),
      );
    draw(joined);
    const typing = node.querySelector(".typing");
    expect(typing).not.toBeNull();
    expect(activityDialog()?.textContent).toContain(note.body);
    expect(activityDialog()?.textContent).toContain("Looking at flights.");

    draw(stepped);
    expect(node.querySelector(".typing")).toBe(typing);
    expect(typing?.isConnected).toBe(true);
    const dialog = activityDialog();
    expect(dialog?.textContent).not.toContain("Nothing to show");
    expect(dialog?.textContent).toContain("Looking at flights.");
    expect(dialog?.textContent).toContain("Comparing hotels.");
  });
});
