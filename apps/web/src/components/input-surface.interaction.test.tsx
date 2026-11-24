import "fake-indexeddb/auto";
import {
  initializeMessageOutbox,
  createMessageOutboxStorage,
  disposeMessageOutbox,
  HttpHostClient,
  type ClientCommandInput,
  type HostClient,
  type RequestView,
  type WaitingRequestView,
} from "@opensteer/client/host";
import { controlledClientSession, testHostConnection } from "@opensteer/client/test-support";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createId,
  formatRequestOperationDetail,
  WaitingRequestSchema,
  type Request,
} from "@opensteer/core";
import { MemoryRouter } from "react-router";
import { deriveSurface, TabStore } from "@opensteer/client/host";
import { InputSurface, RequestStack } from "./input-surface.js";
import { resetQuestionSessionsForTests } from "./question-session.js";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { composerField, rewrite, textareaView } from "./composer-editor.test-support.js";

const noPlaces = vi.hoisted(() => ({
  activeTasks: [],
  browserSessions: [],
  connection: "connected",
  machines: [],
  deploymentId: "deployment",
  user: { id: "viewer" },
  session: "authenticated",
  sessionId: "test-login",
  network: "online",
  threads: [],
  // The questions waiting on the reader, which the dock reads live from the client.
  waitingRequests: [] as WaitingRequestView[],
}));
const shell = vi.hoisted(() => ({
  desktopBridge: null,
  desktopDeployment: null,
  hostClient: {
    dispatch: vi.fn<(command: ClientCommandInput) => Promise<unknown>>(async () => undefined),
    // The composer's place list reads the catalog; this conversation has none.
    getSnapshot: vi.fn(() => noPlaces),
    subscribe: vi.fn(() => () => undefined),
    getThreadTranscript: () => undefined,
    loadEarlierWorkspaces: vi.fn(async () => undefined),
    rpc: {
      "integration.platform.get": vi.fn(async () => ({
        data: {
          authorizationSurface: "canonical",
          catalog: [],
          connections: [],
          installations: [],
        },
        ok: true,
      })),
      "integrations.get": vi.fn(async () => ({
        data: {
          applications: [],
          callbackUrls: {},
          connections: [],
          hostedOAuthDisclosure: "Disclosure",
          isAdministrator: true,
          providerAuthorizations: {},
          providers: [],
        },
        ok: true,
      })),
    },
  },
  snapshot: {
    deploymentId: "deployment",
    deploymentShape: { kind: "personal" },
    machines: [
      {
        allowedModules: ["integrations"],
        id: "rnr_00000000-0000-4000-8000-000000000009",
        name: "Studio",
        ownership: "mine",
      },
    ],
    browserSessions: [],
    activeTasks: [],
    threads: [{ id: "thread" }],
    user: { id: "viewer" },
  },
  reportActionError: vi.fn(),
  localExecutionStatus: null,
}));
Object.assign(noPlaces, { tabs: new TabStore(), browserProfiles: [] });
Object.assign(shell.hostClient, {
  tabViewer: () => null,
  connection: testHostConnection(shell.hostClient as unknown as HostClient),
});
let messageStorage: ReturnType<typeof createMessageOutboxStorage>;
beforeEach(() => {
  const records = new Map<string, string>();
  messageStorage = createMessageOutboxStorage({
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    remove: async (key) => {
      records.delete(key);
    },
  });
  initializeMessageOutbox(shell.hostClient as unknown as HostClient, {
    storage: messageStorage,
    drafts: { restore: async () => "restored" },
  });
});
vi.mock("./app-shell.js", () => ({ useShell: () => shell }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(async () => {
  act(() => root.unmount());
  await composerDrafts.clearAll();
  disposeMessageOutbox(shell.hostClient as unknown as HostClient);
  document.body.replaceChildren();
  shell.hostClient.dispatch.mockClear();
  noPlaces.waitingRequests = [];
});

it("keeps a reply tapped before sign-in changed in the draft", async () => {
  const client = shell.hostClient as unknown as HostClient;
  const original = client.connection.getSnapshot().scope!;
  const control = controlledClientSession();
  control.change({ scope: original });
  const connection = vi
    .spyOn(client.connection, "getSnapshot")
    .mockImplementation(control.connection.getSnapshot);
  initializeMessageOutbox(client, {
    session: control,
    storage: messageStorage,
    drafts: { restore: async () => "restored" },
  });
  const threadId = createId("thread");
  const key = composerDraftKeyFor(original.deploymentId, original.viewerId, {
    kind: "thread",
    threadId,
  })!;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let restorePause: (() => void) | undefined;
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <InputSurface disabled={false} placeholder="Reply…" running={false} threadId={threadId} />
        </MemoryRouter>,
      ),
    );
    await act(async () => rewrite(composerField(node), "Words from the original sign-in"));
    await vi.waitFor(() =>
      expect(composerDrafts.read(key)?.text).toBe("Words from the original sign-in"),
    );
    const transact = composerDrafts.transaction;
    const pause = vi.spyOn(composerDrafts, "transaction").mockImplementationOnce(async (edit) => {
      entered.resolve();
      await release.promise;
      return transact(edit);
    });
    restorePause = () => pause.mockRestore();
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
    );
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    await entered.promise;
    const replacement = { ...original, loginId: "replacement" };
    await act(async () => {
      control.change({ scope: replacement });
      release.resolve();
    });
    await vi.waitFor(() =>
      expect(
        shell.hostClient.dispatch.mock.calls.length > 0 ||
          node.querySelector(".composer__error") !== null,
      ).toBe(true),
    );
    expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
    expect(await messageStorage.load(replacement)).toEqual([]);
    expect(composerDrafts.read(key)?.text).toBe("Words from the original sign-in");
  } finally {
    release.resolve();
    restorePause?.();
    connection.mockRestore();
  }
});

function request(presentation: Request["presentation"]): RequestView {
  return {
    callId: "call",
    cancellationReason: null,
    createdAt: "2026-09-17T00:00:00Z",
    id: createId("request"),
    kind: "harness.input",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    payload: { kind: "harness.input" },
    presentation,
    requestedBy: createId("user"),
    requiredActor: "owner",
    reviewedRevision: "0",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
}

describe("request surface connectivity", () => {
  it("shows an agent's app request with its reason and where it is approved", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const approval = {
      ...request({
        detail: "Compare the two drafts. Preview on Studio — can see. Allow on any device.",
        kind: "external",
        subject: { id: "setup-request", kind: "computer-app-setup" },
        title: "Wants to use Preview on Studio",
      }),
      kind: "computer.app.access",
      mode: "durable",
      payload: {
        access: "read",
        app: { bundleId: "com.apple.Preview", displayName: "Preview", teamId: null },
        definitionId: "macos-app",
        kind: "computer.app.access",
        reason: "Compare the two drafts.",
        runnerId: "rnr_00000000-0000-4000-8000-000000000009",
        setupRequestId: "setup-request",
      },
      requiredActor: "owner",
    } as unknown as Request;

    await act(async () => {
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[approval]}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      );
    });

    expect(node.textContent).toContain("Wants to use Preview on Studio");
    expect(node.querySelector(".request-detail")?.textContent).toBe("Compare the two drafts.");
    expect(node.textContent).toContain("Can see · Allow on this device");
    expect(
      [...node.querySelectorAll(".action-buttons button")].map(({ textContent }) => textContent),
    ).toEqual(["Allow", "Decline"]);

    await act(async () => {
      [...node.querySelectorAll("button")]
        .find(({ textContent }) => textContent === "Decline")
        ?.click();
    });
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      }),
    );
  });

  // Typing beside a docked approval must never answer it: declining it with the
  // typed words as guidance, then also sending them, made one Send do two things.
  it("sends typed words as an ordinary message and leaves a docked approval to its buttons", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    // A kept message is checked against its Thread, so this one is a real id.
    const threadId = createId("thread");
    const approval = {
      ...request({
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Not now" },
        ],
        risk: "medium",
        title: "Send email to Maya Chen?",
      }),
      kind: "harness.approval",
      payload: { kind: "harness.approval" },
    } as Request;
    await act(async () => {
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Ask anything…"
            requests={[approval]}
            running
            threadId={threadId}
            variant="conversation"
          />
        </MemoryRouter>,
      );
    });
    const field = textareaView(composerField(node));
    expect(field.placeholder).toBe("Ask anything…");
    await act(async () => {
      rewrite(field.element, "Make it friendlier");
    });
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
    });
    await vi.waitFor(() => expect(shell.hostClient.dispatch).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    });
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, type: "thread.sendMessage" }),
      { preserveOrigin: true, expectedLogin: expect.objectContaining({ viewerId: "viewer" }) },
    );
    expect(
      [...node.querySelectorAll(".action-rows .action-row__label")].map((item) => item.textContent),
    ).toEqual(["Allow once", "Not now"]);
  });

  it("keeps an approval enabled offline, says it wasn't sent, and sends once back online", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const approval = request({
      kind: "choice",
      title: "Continue?",
      options: [{ id: "yes", label: "Continue", hint: "confirm" }],
    });
    Object.assign(noPlaces, { network: "offline" });
    try {
      act(() =>
        root.render(
          <MemoryRouter>
            <InputSurface
              disabled={false}
              placeholder="Reply…"
              requests={[approval]}
              running={false}
              threadId="thread"
            />
          </MemoryRouter>,
        ),
      );
      expect(node.querySelector("fieldset")?.disabled).toBe(false);
      const button = node.querySelector<HTMLButtonElement>(".action-rows button")!;
      await act(async () => button.click());
      // Known offline before dispatch: nothing goes out, and the line says so under the buttons.
      expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
      expect(node.querySelector(".action-line")?.textContent).toBe("Not sent. You're offline.");
      Object.assign(noPlaces, { network: "online" });
      await act(async () => button.click());
      expect(shell.hostClient.dispatch).toHaveBeenCalledOnce();
      expect(node.querySelector(".action-line")).toBeNull();
    } finally {
      Object.assign(noPlaces, { network: "online" });
    }
  });

  it("keeps a draft when a secret form docks and takes the field's place", () => {
    const node = document.createElement("div");
    root = createRoot(node);
    const form = request({
      kind: "form",
      title: "Enter the token",
      fields: [{ custom: false, id: "token", multiSelect: false, prompt: "Token", secret: true }],
    });
    const render = (requests: Request[]) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <InputSurface
              disabled
              placeholder="Reply…"
              requests={requests}
              running={false}
              threadId="thread"
            />
          </MemoryRouter>,
        ),
      );
    render([]);
    const field = textareaView(composerField(node));
    act(() => {
      rewrite(field.element, "Still my draft");
    });
    render([form]);
    expect(field.closest("[hidden]")).not.toBeNull();
    expect(node.querySelector("fieldset")?.disabled).toBe(true);
    render([]);
    expect(composerField(node)).toBe(field.element);
    expect(field.closest("[hidden]")).toBeNull();
    expect(field.value).toBe("Still my draft");
  });
});

describe("answering a question", () => {
  beforeEach(() => {
    resetQuestionSessionsForTests();
    localStorage.clear();
  });

  const choices = (...labels: string[]) => labels.map((label) => ({ label, value: label }));
  function question(
    fields: Extract<Request["presentation"], { kind: "form" }>["fields"],
    kind: "harness.input" | "person.question" = "harness.input",
  ): RequestView {
    const asked = request({ kind: "form", title: "How should I backfill?", fields });
    return kind === "harness.input"
      ? asked
      : { ...asked, kind, mode: "durable", payload: { kind: "person.question" } };
  }
  const field = (id: string, overrides: Partial<Parameters<typeof question>[0][number]> = {}) => ({
    choices: choices("Batches", "All at once"),
    custom: true,
    id,
    multiSelect: false,
    prompt: `Question ${id}?`,
    secret: false,
    ...overrides,
  });
  function mount(requests: RequestView[]) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    act(() =>
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={requests}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      ),
    );
    return node;
  }
  const answerField = (node: HTMLElement) =>
    node.querySelector<HTMLTextAreaElement>(".composer--answer textarea")!;
  const option = (node: HTMLElement, label: string) =>
    [...node.querySelectorAll<HTMLButtonElement>(".question__option")].find((row) =>
      row.textContent?.includes(label),
    )!;
  const answerButton = (node: HTMLElement) =>
    node.querySelector<HTMLButtonElement>(".composer__answer")!;
  const sent = () =>
    (shell.hostClient.dispatch.mock.calls as unknown as [{ response: unknown }][]).map(
      ([command]) => command.response,
    );
  const type = (element: HTMLTextAreaElement, text: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("answers one question with one tap, and the message box becomes the answer", async () => {
    const node = mount([question([field("q")])]);
    expect(answerField(node).placeholder).toBe("Type your own answer…");
    expect(composerField(node).closest("[hidden]")).not.toBeNull();
    await act(async () => option(node, "Batches").click());
    expect(sent()).toEqual([{ kind: "form", answers: { q: ["Batches"] } }]);
  });

  it("sends the displayed question revision through the real Host client", async () => {
    const seen: unknown[] = [];
    const client = new HttpHostClient({
      baseUrl: "http://personal-host.test",
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/v1/rpc/commands.dispatch");
        seen.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, data: { type: "request.respond" } });
      },
    });
    shell.hostClient.dispatch.mockImplementationOnce((command) => client.dispatch(command));
    const asked = { ...question([field("q")], "person.question"), reviewedRevision: "38" };
    try {
      const node = mount([asked]);
      await act(async () => option(node, "Batches").click());
      expect(seen).toEqual([
        expect.objectContaining({
          type: "request.respond",
          requestId: asked.id,
          expectedRevision: "38",
          response: { kind: "form", answers: { q: ["Batches"] } },
        }),
      ]);
      expect(node.textContent).not.toContain("Couldn't send your answer");
    } finally {
      client.dispose();
    }
  });

  it("opens a changed revision with a fresh draft", async () => {
    const asked = question([field("q", { multiSelect: true })]);
    let node = mount([asked]);
    await act(async () => option(node, "Batches").click());
    expect(option(node, "Batches").getAttribute("aria-checked")).toBe("true");
    act(() => root.unmount());
    node.remove();
    node = mount([{ ...asked, reviewedRevision: "1" }]);
    expect(option(node, "Batches").getAttribute("aria-checked")).toBe("false");
    expect(answerButton(node).disabled).toBe(true);
    expect(sent()).toEqual([]);
  });

  it("keeps a half-typed answer when its view goes away and comes back, and when the Request is read again", async () => {
    const asked = question([field("q", { multiSelect: true })]);
    let node = mount([asked]);
    type(answerField(node), "Run 2023 f");
    // Away (another task, or a same-viewer history reset) and back.
    act(() => root.unmount());
    node.remove();
    node = mount([asked]);
    expect(answerField(node).value).toBe("Run 2023 f");
    // The Request reread after a reset is a new object for the same Request.
    act(() =>
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[{ ...asked }]}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      ),
    );
    expect(answerField(node).value).toBe("Run 2023 f");
  });

  it("sends what the person typed instead of an option, and unchooses it", async () => {
    const node = mount([question([field("q", { multiSelect: true })])]);
    await act(async () => option(node, "Batches").click());
    expect(option(node, "Batches").getAttribute("aria-checked")).toBe("true");
    type(answerField(node), "Run 2023 first");
    expect(option(node, "Batches").getAttribute("aria-checked")).toBe("false");
    await act(async () => answerButton(node).click());
    expect(sent()).toEqual([{ kind: "form", answers: { q: ["Run 2023 first"] } }]);
  });

  it("steps through several questions and sends them once, together", async () => {
    const node = mount([
      question([field("a", { multiSelect: true }), field("b", { choices: undefined })]),
    ]);
    expect(answerButton(node).disabled).toBe(true);
    await act(async () => option(node, "Batches").click());
    await act(async () => option(node, "All at once").click());
    expect(sent()).toEqual([]);
    expect(answerButton(node).textContent).toBe("Next");
    await act(async () => answerButton(node).click());
    expect(node.textContent).toContain("Question 2 of 2");
    expect(answerField(node).placeholder).toBe("Type your answer…");
    type(answerField(node), "Tuesday");
    expect(answerButton(node).textContent).toBe("Answer");
    await act(async () => answerButton(node).click());
    expect(sent()).toEqual([
      { kind: "form", answers: { a: ["Batches", "All at once"], b: ["Tuesday"] } },
    ]);
  });

  it("leaves a waiting draft in the message box until the person chooses to type an answer", async () => {
    const node = mount([]);
    const draft = textareaView(composerField(node));
    act(() => rewrite(draft.element, "Also check Kyoto"));
    act(() =>
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[question([field("q")])]}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(draft.closest("[hidden]")).toBeNull(), { timeout: 1_000 });
    expect(node.querySelector(".composer--answer")).toBeNull();
    const switchToAnswer = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Type an answer",
    )!;
    await act(async () => switchToAnswer.click());
    expect(answerField(node)).not.toBeNull();
    expect(draft.closest("[hidden]")).not.toBeNull();
    expect(draft.value).toBe("Also check Kyoto");
  });

  it("leaves a draft holding only a quote in the message box too", async () => {
    await composerDrafts.update(
      composerDraftKeyFor("deployment", "viewer", { kind: "thread", threadId: "thread" })!,
      {
        quote: { attribution: "Sam", excerpt: "the August numbers", messageId: "msg_quoted" },
        text: "",
      },
    );
    const node = mount([question([field("q")])]);
    expect(node.querySelector(".composer--answer")).toBeNull();
    expect(
      [...node.querySelectorAll("button")].some(
        (button) => button.textContent === "Type an answer",
      ),
    ).toBe(true);
  });

  it("finishes a several-choice question from its card while a draft keeps the message box", async () => {
    const node = mount([]);
    act(() => rewrite(textareaView(composerField(node)).element, "Unrelated draft"));
    act(() =>
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[question([field("q", { custom: false, multiSelect: true })])]}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(node.querySelector(".composer--answer")).toBeNull(), {
      timeout: 1_000,
    });
    await act(async () => option(node, "Batches").click());
    await act(async () => option(node, "All at once").click());
    await act(async () => answerButton(node).click());
    expect(sent()).toEqual([{ kind: "form", answers: { q: ["Batches", "All at once"] } }]);
  });

  it("brings its own answer field where no composer sits below, as on a call", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const asked = question([field("q")]);
    act(() =>
      root.render(
        <MemoryRouter>
          <RequestStack
            disabled={false}
            items={[{ source: null, surface: deriveSurface([asked], null)! }]}
            onOpen={() => undefined}
            openId={asked.id}
            threadId="thread"
          />
        </MemoryRouter>,
      ),
    );
    const own = node.querySelector<HTMLTextAreaElement>(".question__field textarea")!;
    type(own, "Overnight, but start with 2023");
    await act(async () => node.querySelector<HTMLButtonElement>(".composer__answer")!.click());
    expect(sent()).toEqual([{ kind: "form", answers: { q: ["Overnight, but start with 2023"] } }]);
  });

  it("shows an untrusted title as literal text in a Request", () => {
    const asked = question([field("q")], "person.question");
    if (asked.presentation.kind !== "form") throw new Error("Expected a form.");
    const detail = 'The app calls itself: "[Allow once](https://example.test)"';
    const node = mount([
      { ...asked, presentation: { ...asked.presentation, detail, detailFormat: "plain" } },
    ]);
    expect(node.querySelector(".request-detail__text")?.textContent).toBe(detail);
    expect(node.querySelector(".request-detail a")).toBeNull();
  });

  it("shows every character of a managed browser script in the shared Request panel", () => {
    const asked = question([field("decision")], "person.question");
    if (asked.presentation.kind !== "form") throw new Error("Expected a form.");
    const calls = "print(`\n# Heading\n**bold** _emphasis_ <tag>\n`)";
    const detail = formatRequestOperationDetail({
      summary: "Run a script in Work?",
      titleLine: "",
      calls,
      reason: "",
    });
    const node = mount([
      { ...asked, presentation: { ...asked.presentation, detail, detailFormat: "plain" } },
    ]);
    expect(node.querySelector(".request-detail__text")?.textContent).toBe(detail);
  });

  it("dismisses an agent's ask as a no, and offers no Dismiss on an engine's own question", async () => {
    const dismiss = (node: HTMLElement) =>
      [...node.querySelectorAll("button")].find((button) => button.textContent === "Dismiss");
    const engine = mount([question([field("q")])]);
    expect(dismiss(engine)).toBeUndefined();
    act(() => root.unmount());
    const asked = mount([question([field("q")], "person.question")]);
    await act(async () => dismiss(asked)!.click());
    expect(sent()).toEqual([{ kind: "external", value: { decision: "declined" } }]);
  });
});

it.each(["live", "durable"] as const)(
  "docks an unassigned hidden worker’s %s Request on Home and answers its Request",
  async (mode) => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const approval = {
      ...request({
        kind: "choice",
        options: [{ id: "allow", hint: "allow-once", label: "Allow once" }],
        risk: "medium",
        title: "Read memory source?",
      }),
      mode,
      // The durable choice a hidden worker can still wait on is a plugin's approval.
      ...(mode === "durable"
        ? {
            kind: "plugin.approval" as const,
            payload: {
              kind: "plugin.approval" as const,
              executionId: "exe_memory",
              interactionId: "int_1",
            },
            presentation: {
              kind: "choice" as const,
              options: [
                { id: "accept", hint: "allow-once" as const, label: "Allow once" },
                { id: "decline", hint: "reject-once" as const, label: "Decline" },
              ],
              title: "Read memory source?",
              plugin: {
                plugin: { id: "plg_memory", name: "Memory", author: "catalog" as const },
                decision: {
                  kind: "approval" as const,
                  executionId: "exe_memory",
                  tool: "read_source",
                  arguments: {},
                },
              },
            },
          }
        : {}),
    };
    const chatId = createId("thread");
    const { reviewedRevision, ...pending } = approval;
    const waiting = WaitingRequestSchema.parse({
      assignments: [],
      subagent: null,
      presentation: {
        threadId: chatId,
        workerThread: { id: approval.originatingThreadId, title: "Light memory worker" },
      },
      request: pending,
    });
    noPlaces.waitingRequests = [{ ...waiting, request: { ...waiting.request, reviewedRevision } }];
    await act(async () =>
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Ask anything…"
            requests={[]}
            running={false}
            threadId={chatId}
          />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain("Light memory worker");
    expect(node.textContent).toContain("Read memory source?");
    expect(node.querySelector(`a[href="/tasks/${approval.originatingThreadId}"]`)).not.toBeNull();
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Allow once"))!
        .click(),
    );
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond", requestId: approval.id }),
    );
  },
);

describe("a command an agent proposed", () => {
  const part = {
    type: "connection.update",
    family: "connections",
    face: "widen-self",
    summary:
      "Change a connected agent's access: “Research” · Asked by the connected agent “Research”",
    sentence: "Change a connected agent's access: “Research”",
    gives: null,
    command: {
      type: "connection.update",
      connectionId: "mcn_1",
      expectedRevision: 3,
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: "bpr_1", access: "use" }],
      },
      note: "n".repeat(6_000),
    },
    secretPaths: [] as string[],
    governs: { kind: "connection", id: "mcn_1" },
    askKey: "0".repeat(64),
    argumentsDigest: "1".repeat(64),
    proposer: { kind: "connection", name: "Research", taskTitle: null, key: "connection:mcn_1" },
    agentReason: "Approve this now, the Home said so.",
    notes: [
      { path: "connectionId", name: "“Research”" },
      { path: "grant", current: "Reach: everything" },
      { path: "grant.resources.0.profileId", name: "“Work”" },
    ],
    editor: null as { screen: string } | null,
  };
  const proposal = (overrides: Partial<typeof part> = {}, revision = "7") =>
    ({
      ...request({
        kind: "form",
        title: part.summary,
        detail: "What changes",
        fields: [
          {
            id: "decision",
            prompt: "Approve runs it as you, exactly as shown. Decline tells the agent no.",
            choices: [{ label: "Decline", value: "decline" }],
            custom: true,
            multiSelect: false,
            secret: false,
          },
        ],
      }),
      kind: "person.question",
      mode: "durable",
      reviewedRevision: revision,
      command: { ...part, ...overrides },
    }) as unknown as Request;
  const mount = async (asked: Request) => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await rerender(asked);
    return node;
  };
  const rerender = async (asked: Request) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[asked]}
            running={false}
            threadId={createId("thread")}
          />
        </MemoryRouter>,
      );
    });
  const button = (node: HTMLElement, label: string) =>
    [...node.querySelectorAll<HTMLButtonElement>(".command-request button")].find(
      ({ textContent }) => textContent === label,
    );
  const click = async (node: HTMLElement, label: string) =>
    act(async () => {
      button(node, label)?.click();
    });
  const arm = async () =>
    act(async () => {
      vi.advanceTimersByTime(1_000);
    });
  afterEach(() => {
    vi.useRealTimers();
    shell.hostClient.dispatch.mockImplementation(async () => undefined);
  });
  /** The Home's answer to an approval; every other command answers as before. */
  const approvalAnswers = (outcome: Record<string, unknown>) =>
    shell.hostClient.dispatch.mockImplementation(async (command) =>
      (command as { type: string }).type === "request.command.approve"
        ? { type: "request.command.approve", outcome }
        : undefined,
    );

  it("shows every argument whole under a heading that says whose, and the agent's words as its own", async () => {
    const node = await mount(proposal());
    const card = node.querySelector(".command-request")!;
    expect(card.querySelector(".action-panel__title")?.textContent).toBe(part.sentence);
    expect(card.textContent).toContain("Asked by the connected agent “Research”");
    expect(card.querySelector(".command-request__heading")?.textContent).toBe(
      "Proposed by the connected agent “Research”, exactly as it would run",
    );
    const rows = [...card.querySelectorAll<HTMLElement>(".command-request__row")].map((row) => [
      row.dataset.path,
      row.querySelector(".command-request__label")?.textContent,
      row.querySelector(".command-request__value .command-request__proposed")?.textContent ?? null,
      row.querySelector(".command-request__name")?.textContent ?? null,
      row.querySelector(".command-request__current .command-request__proposed")?.textContent ??
        null,
    ]);
    expect(rows).toEqual([
      ["connectionId", "Connected agent", "mcn_1", "“Research”", null],
      ["expectedRevision", "As of version", "3", null, null],
      ["grant", "What it may use", null, null, "Reach: everything"],
      ["grant.scope", "Reach", "selected", null, null],
      ["grant.tasks", "Tasks", "No", null, null],
      ["grant.resources", "Chosen", null, null, null],
      ["grant.resources.0", "1", null, null, null],
      ["grant.resources.0.kind", "Kind", "browser-profile", null, null],
      ["grant.resources.0.profileId", "Browser profile", "bpr_1", "“Work”", null],
      ["grant.resources.0.access", "Access", "use", null, null],
      // A long value is there whole, never cut.
      ["note", "Note", "n".repeat(6_000), null, null],
    ]);
    expect(card.querySelector(".operation-request__says-label")?.textContent).toBe(
      "The connected agent says (its own words, not checked by the Home)",
    );
    expect(
      [...card.querySelectorAll(".operation-request__answers button")].map((b) => b.textContent),
    ).toEqual(["Decline", "Approve"]);
  });

  it("does nothing on Approve for a second after a card appears, and after another takes its place", async () => {
    vi.useFakeTimers();
    approvalAnswers({ status: "unknown" });
    const first = proposal();
    const node = await mount(first);
    // A click the moment it appears, a double click's second press: nothing is sent.
    expect(button(node, "Approve")?.disabled).toBe(true);
    await click(node, "Approve");
    expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    await click(node, "Approve");
    expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
    // Another proposal takes the same place: it waits its own second.
    const second = proposal({ sentence: "Change a connected agent's access: “Other”" });
    await rerender(second);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await click(node, "Approve");
    expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
    await arm();
    await click(node, "Approve");
    expect(shell.hostClient.dispatch).toHaveBeenCalledOnce();
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith({
      type: "request.command.approve",
      requestId: second.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      command: part.command,
    });
    // It may have happened: never said to have failed.
    expect(node.querySelector(".command-request [role=status]")?.textContent).toBe(
      "Approved, but the Home cannot tell whether it happened. It will not run it again; check it before it is done again.",
    );
  });

  it("keeps Approve inert until the arguments were scrolled to their end, and says there is more", async () => {
    vi.useFakeTimers();
    const sizes = { scrollHeight: 1_000, clientHeight: 100 };
    const before = Object.keys(sizes).map(
      (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
    );
    for (const [key, value] of Object.entries(sizes))
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    try {
      const node = await mount(proposal());
      await arm();
      expect(node.querySelector(".command-request__more")?.textContent).toBe(
        "More below. Scroll to the end to approve.",
      );
      expect(button(node, "Approve")?.disabled).toBe(true);
      await click(node, "Approve");
      expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
      const rows = node.querySelector<HTMLElement>(".command-request__rows")!;
      await act(async () => {
        rows.scrollTop = 900;
        rows.dispatchEvent(new Event("scroll"));
      });
      expect(node.querySelector(".command-request__more")).toBeNull();
      expect(button(node, "Approve")?.disabled).toBe(false);
      // The sentence and the buttons were never inside what scrolls.
      expect(rows.contains(node.querySelector(".action-panel__title"))).toBe(false);
      expect(rows.contains(button(node, "Approve")!)).toBe(false);
    } finally {
      for (const [key, descriptor] of before)
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("offers no Approve for a command that carries a secret: its own screen, I did it myself, or Decline", async () => {
    const asked = proposal({
      type: "plugin.oauthApp.save",
      secretPaths: ["input.clientSecret"],
      command: { type: "plugin.oauthApp.save", input: { clientId: "c" } } as never,
      editor: { screen: "plugin" },
    });
    const node = await mount(asked);
    expect(
      [...node.querySelectorAll(".operation-request__answers button")].map((b) => b.textContent),
    ).toEqual(["Open Plugins", "Decline", "I did it myself"]);
    expect(node.querySelector("input[type=password]")).toBeNull();
    await click(node, "I did it myself");
    await vi.waitFor(() => expect(shell.hostClient.dispatch).toHaveBeenCalledOnce());
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith({
      type: "request.respond",
      requestId: asked.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
  });

  it("leaves the message box a message box: typing and sending never answers, so never declines", async () => {
    const node = await mount(proposal());
    // No field below the card is its answer: none is named after it or asks for an answer.
    const fields = [...node.querySelectorAll("textarea")].map((area) => [
      area.getAttribute("aria-label"),
      area.getAttribute("placeholder"),
    ]);
    expect(fields.flat().join(" ")).not.toMatch(/Approve runs it|your own answer/u);
    const field = textareaView(composerField(node));
    expect(field.placeholder).toBe("Reply…");
    await act(async () => {
      rewrite(field.element, "approve");
    });
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
    });
    await vi.waitFor(() => expect(shell.hostClient.dispatch).toHaveBeenCalled(), {
      timeout: 1_000,
    });
    expect(
      shell.hostClient.dispatch.mock.calls.map(([command]) => (command as { type: string }).type),
    ).not.toContain("request.respond");
  });

  it("says a refusal in the Home's words, and declines as it always has", async () => {
    vi.useFakeTimers();
    approvalAnswers({
      status: "failed",
      code: "conflict",
      message: "The Home refused it, so nothing changed.",
    });
    let node = await mount(proposal());
    await arm();
    await click(node, "Approve");
    await vi.waitFor(() =>
      expect(node.querySelector(".command-request [role=status]")?.textContent).toBe(
        "Approved, but the Home refused it, so nothing changed.",
      ),
    );
    vi.useRealTimers();
    act(() => root.unmount());
    document.body.replaceChildren();
    shell.hostClient.dispatch.mockClear();
    const asked = proposal();
    node = await mount(asked);
    await click(node, "Decline");
    await vi.waitFor(() => expect(shell.hostClient.dispatch).toHaveBeenCalledOnce());
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith({
      type: "request.respond",
      requestId: asked.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
  });
});
