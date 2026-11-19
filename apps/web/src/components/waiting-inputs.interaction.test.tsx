import { mockInputQueue } from "@opensteer/client/mock";
import { MockHostClient } from "@opensteer/client/mock";
import { controlledClientSession } from "@opensteer/client/test-support";
import { initializeMessageOutbox, createMessageOutboxStorage } from "@opensteer/client/host";
import { createId } from "@opensteer/core";
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostClientRequestError,
  HttpHostClient,
  waitingInputs,
  type HostClient,
  type MessageEntry,
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import type { ContentPart, ThreadInputQueue } from "@opensteer/core";
import { TranscriptHostClientContext } from "./attachments/message-attachments.js";
import { TranscriptMessage } from "./agent-activity.js";
import { WaitingInputs } from "./waiting-inputs.js";
import { rewrite, textareaView } from "./composer-editor.test-support.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

type Item = ThreadInputQueue["items"][number];

function item(
  id: string,
  text: string,
  flags: Partial<Pick<Item, "canCancel" | "canEdit" | "canSteer" | "lease">> = {},
  options: { userId?: string; content?: ContentPart[] } = {},
): Item {
  const userId = options.userId ?? "me";
  return {
    canCancel: false,
    canEdit: false,
    canMove: false,
    canSteer: false,
    lease: null,
    ...flags,
    input: { policy: "queue", state: "pending", teamRequestId: null, teamSource: null },
    message: {
      author: { displayName: userId === "me" ? "Me" : "Sam", kind: "human", userId },
      content: options.content ?? [{ text, type: "text" }],
      createdAt: "2026-10-31T12:00:00.000Z",
      id,
      kind: "input",
      runId: null,
      sequence: "1",
    },
  } as unknown as Item;
}

const audience = {
  channelKind: "public",
  channelName: "general",
  memberCount: 3,
  peopleOnly: false,
  teamName: "Acme",
} as const;

/** A teammate's ask, admitted into the task and awaiting the person's answer. */
function ask(id: string, text: string, flags: Partial<Item> = {}): Item {
  const teamId = "dep_00000000-0000-4000-8000-000000000001";
  return {
    canCancel: false,
    canEdit: true,
    canMove: false,
    canSteer: false,
    lease: null,
    ...flags,
    input: {
      policy: "queue",
      state: "awaiting-approval",
      teamRequestId: "tar_ask",
      teamSource: { audience, channelId: "tch_1", messageId: null, teamId, threadRootId: "1" },
    },
    message: {
      author: {
        actor: "human",
        displayName: "Maya Chen",
        kind: "team-member",
        teamId,
        teamUserId: "usr_maya",
      },
      content: [{ text, type: "text" }],
      createdAt: "2026-10-31T12:00:00.000Z",
      id,
      kind: "input",
      runId: null,
      sequence: "2",
    },
  } as unknown as Item;
}

function inputsOf(
  items: Item[],
  options: { paused?: boolean; threadId?: string } = {},
): WaitingInput[] {
  return waitingInputs(
    mockInputQueue(
      {
        items,
        paused: options.paused ?? false,
        steerRunId: null,
        threadId: options.threadId ?? "thread",
      } as unknown as ThreadInputQueue,
      "0",
      () => false,
    ),
    {},
  );
}

/** An editor whose lease read returned `body`, the full message the edit opens from. */
function fakeEditor(
  body: string | ContentPart[],
  overrides: Partial<WaitingMessageEditor> = {},
): WaitingMessageEditor {
  return {
    cancel: vi.fn(async () => undefined),
    content: typeof body === "string" ? [{ text: body, type: "text" }] : body,
    leaseId: "lease",
    read: vi.fn(
      async (): Promise<readonly ContentPart[]> =>
        typeof body === "string" ? [{ text: body, type: "text" }] : body,
    ),
    revision: 0,
    save: vi.fn(async () => ({ editedAt: "2026-10-31T12:01:00.000Z", revision: 1 })),
    touch: vi.fn(),
    ...overrides,
  };
}

/** The item as the Host reports it once another device saved `text` as `revision`. */
function edited(at: Item, text: string, revision: number): Item {
  return {
    ...at,
    message: {
      ...at.message,
      content: [{ text, type: "text" }],
      edit: { editedAt: "2026-10-31T12:01:00.000Z", revision },
    },
  } as Item;
}

function render(
  client: HostClient,
  inputs: WaitingInput[],
  options: {
    disabled?: boolean;
    paused?: boolean;
    onError?: (error: unknown) => void;
    local?: readonly MessageEntry[];
  } = {},
) {
  const host = client.connection
    ? client
    : { ...client, connection: controlledClientSession().connection };
  return (
    <MemoryRouter>
      <WaitingInputs
        client={host}
        disabled={options.disabled ?? false}
        inputs={inputs}
        {...(options.local ? { local: options.local } : {})}
        onError={options.onError ?? vi.fn()}
        paused={options.paused ?? false}
        resumable
        threadId={inputs[0]?.threadId ?? "thread"}
        viewerUserId="me"
      />
    </MemoryRouter>
  );
}

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function buttons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent ?? "",
  );
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

/** Clicks a message's words, the way into editing it. */
async function clickWords(container: HTMLElement, messageId: string) {
  const words = container.querySelector(`[data-message-id="${messageId}"] .message-fold`);
  if (!words) throw new Error(`No words for ${messageId}`);
  await act(async () => (words as HTMLElement).click());
}

const field = (container: HTMLElement) => {
  const element = container.querySelector<HTMLElement>(".composer-editor__field");
  return element ? textareaView(element) : null;
};

async function write(target: { readonly element: HTMLElement }, text: string) {
  await act(async () => rewrite(target.element, text));
}

async function press(target: Pick<Element, "dispatchEvent">, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
}

it("keeps the queued row and its bubble mounted as the Host takes over a local send", async () => {
  const [older, confirmed, later] = inputsOf([
    item("older", "Older held"),
    item("confirmed", "First local"),
    item("later", "Second local"),
  ]);
  if (!older || !confirmed || !later) throw new Error("Expected three message rows.");
  const local = (entry: MessageEntry, key: string): MessageEntry => ({
    ...entry,
    id: key,
    clientSendKey: key,
    localDelivery: { phase: "waiting", attempted: false },
  });
  const first = local(confirmed.entry, "first-send");
  const second = local(later.entry, "second-send");
  const host = {} as HostClient;
  const container = mount(render(host, [older], { local: [first, second] }));
  const bubble = container.querySelector('[data-message-id="first-send"] .message-fold');
  expect(bubble).not.toBeNull();
  await act(async () =>
    root?.render(
      render(
        host,
        [older, { ...confirmed, entry: { ...confirmed.entry, clientSendKey: "first-send" } }],
        { local: [first, second] },
      ),
    ),
  );
  expect(container.querySelector('[data-message-id="confirmed"] .message-fold')).toBe(bubble);
  expect(
    [...container.querySelectorAll(".queued__item .message-fold")].map((node) => node.textContent),
  ).toEqual(["Older held", "First local", "Second local"]);
});

it("draws older Host-held inputs before refused and waiting offline sends", () => {
  const [older, refused, waiting] = inputsOf([
    ask("ask-older", "Older Host input"),
    item("refused", "First offline send"),
    item("waiting", "Second offline send"),
  ]);
  const locals: MessageEntry[] = [
    { ...refused!.entry, localDelivery: { phase: "rejected", attempted: true } },
    { ...waiting!.entry, localDelivery: { phase: "waiting", attempted: false } },
  ];
  const container = mount(render({} as HostClient, [older!], { local: locals }));
  expect(
    [...container.querySelectorAll(".queued__item .message-fold")].map((node) => node.textContent),
  ).toEqual(["Older Host input", "First offline send", "Second offline send"]);
});

describe("WaitingInputs", () => {
  it("keeps one image read when a queued message is taken before download finishes", async () => {
    const client = new HttpHostClient({ baseUrl: "http://127.0.0.1" });
    const bytes = {
      ok: true as const,
      data: {
        bytes: new Uint8Array([1]),
        metadata: {
          contentType: "image/png",
          etag: "image",
          modifiedAt: null,
          sizeBytes: 1,
          truncated: false as const,
        },
      },
    };
    let complete!: (value: typeof bytes) => void;
    const rpc = vi.fn<(typeof client.rpc)["attachment.content"]>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    Object.defineProperty(client.rpc, "attachment.content", { value: rpc });
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const inputs = inputsOf([
        item(
          "image-message",
          "Photo",
          {},
          {
            content: [
              {
                artifactId: "image",
                mediaType: "image/png",
                name: "photo.png",
                sizeBytes: 1,
                type: "artifact",
              },
            ],
          },
        ),
      ]);
      const container = mount(
        <TranscriptHostClientContext value={client}>
          {render(client, inputs)}
        </TranscriptHostClientContext>,
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      act(() =>
        root?.render(
          <TranscriptHostClientContext value={client}>
            <TranscriptMessage message={inputs[0]!.entry} reveal={null} viewerUserId="me" />
          </TranscriptHostClientContext>,
        ),
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      await act(async () => complete(bytes));
      expect(container.querySelector('img[src="blob:preview"]')).not.toBeNull();
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root?.unmount());
      root = null;
      client.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("offers Steer, Edit and Remove only where the Host said it would honour them", async () => {
    const steerThreadInput = vi.fn(async () => undefined);
    const cancelThreadInput = vi.fn(async () => undefined);
    const client = { cancelThreadInput, steerThreadInput } as unknown as HostClient;
    const container = mount(
      render(
        client,
        inputsOf([
          item("mine", "Use the new direction", { canCancel: true, canEdit: true, canSteer: true }),
          item("theirs", "Someone else's message", {}, { userId: "sam" }),
        ]),
      ),
    );
    expect(
      [...container.querySelectorAll(".queued__status")].map((node) => node.textContent),
    ).toEqual(["Up next", "Queued"]);
    expect(buttons(container)).toEqual([
      "Steer the current run with this message",
      "Edit this message",
      "Remove this message from the queue",
    ]);
    await act(async () => button(container, "Steer the current run with this message").click());
    expect(steerThreadInput).toHaveBeenCalledWith("thread", "mine");
    await act(async () => button(container, "Remove this message from the queue").click());
    expect(cancelThreadInput).toHaveBeenCalledWith("thread", "mine");
  });

  it("reports a refused action and frees the row for another try", async () => {
    const onError = vi.fn();
    const steerThreadInput = vi
      .fn()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const client = { steerThreadInput } as unknown as HostClient;
    const container = mount(
      render(client, inputsOf([item("mine", "Course correct", { canSteer: true })]), { onError }),
    );
    const steer = () => container.querySelector("button")!;
    await act(async () => steer().click());
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(steer().disabled).toBe(false);
    await act(async () => steer().click());
    expect(steerThreadInput).toHaveBeenCalledTimes(2);
  });

  it("holds a paused queue behind Resume, and disables every action when the reader cannot respond", async () => {
    const resumeThreadInputQueue = vi.fn(async () => undefined);
    const client = { resumeThreadInputQueue } as unknown as HostClient;
    const inputs = inputsOf([item("mine", "Waiting", { canCancel: true, canSteer: true })], {
      paused: true,
    });
    const container = mount(render(client, inputs, { paused: true }));
    expect(container.querySelector(".queued__paused")?.textContent).toContain("Paused");
    // Paused, no message is the one the next Run takes.
    expect(container.querySelector(".queued__status")?.textContent).toBe("Queued");
    await act(async () => button(container, "Resume").click());
    expect(resumeThreadInputQueue).toHaveBeenCalledWith("thread");

    act(() => root?.render(render(client, inputs, { disabled: true, paused: true })));
    expect([...container.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
  });

  it("folds a long queue behind the messages next in line", () => {
    const container = mount(
      render(
        {} as HostClient,
        inputsOf(["a", "b", "c", "d", "e"].map((id) => item(id, `Message ${id}`))),
      ),
    );
    const shown = () =>
      [...container.querySelectorAll(".queued__item")].map((node) =>
        node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
      );
    expect(shown()).toEqual(["a", "b"]);
    const more = container.querySelector<HTMLButtonElement>(".queued__more")!;
    expect(more.textContent).toBe("Show 3 more");
    act(() => more.click());
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    expect(more.textContent).toBe("Show fewer");
  });

  it("edits a message in place: Enter saves the new words with the files still kept", async () => {
    const photo = { artifactId: "a1", mediaType: "image/png", name: "photo.png", type: "artifact" };
    const notes = {
      artifactId: "a2",
      mediaType: "text/plain",
      name: "notes.txt",
      type: "artifact",
    };
    const content: ContentPart[] = [
      { text: "Check the shard", type: "text" },
      { ...photo, type: "artifact" },
      { ...notes, type: "artifact" },
    ];
    const editor = fakeEditor(content);
    const editWaitingMessage = vi.fn(async () => editor);
    const client = { editWaitingMessage } as unknown as HostClient;
    const container = mount(
      render(client, inputsOf([item("mine", "Check the shard", { canEdit: true }, { content })])),
    );
    await clickWords(container, "mine");
    expect(editWaitingMessage).toHaveBeenCalledWith("thread", "mine");
    expect(field(container)?.value).toBe("Check the shard");

    // A reference is words: it saves as its exact Markdown, never as another part.
    const words =
      "Check the [integration shard](opensteer:thr_12345678-1234-4234-8234-123456789abc)";
    await write(field(container)!, words);
    expect(editor.touch).toHaveBeenCalled();
    await act(async () => button(container, "Don’t include photo.png").click());
    await press(field(container)!, "Enter");

    expect(editor.save).toHaveBeenCalledWith([{ text: words, type: "text" }, notes], 0);
    expect(field(container)).toBeNull();
    expect(editor.cancel).not.toHaveBeenCalled();
  });

  it("opens an edit from the full body only: the preview stays locked until the lease read returns", async () => {
    const page = {
      type: "browser-page",
      sessionId: `bsn_${crypto.randomUUID()}`,
      tabId: "tab-1",
      title: "Docs",
      url: "https://example.com",
    } as ContentPart;
    const full: ContentPart[] = [
      { text: "Check the shard and then the whole integration suite", type: "text" },
      page,
    ];
    const editor = fakeEditor(full);
    let opened!: (editor: WaitingMessageEditor) => void;
    const editWaitingMessage = vi
      .fn<() => Promise<WaitingMessageEditor>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            opened = resolve;
          }),
      );
    const client = { editWaitingMessage } as unknown as HostClient;
    // The queue's preview is clipped and carries no page.
    const container = mount(
      render(client, inputsOf([item("mine", "Check the shard", { canEdit: true })])),
    );
    await clickWords(container, "mine");
    expect(field(container)?.value).toBe("Check the shard");
    expect(field(container)?.readOnly).toBe(true);
    expect(container.textContent).toContain("Couldn’t save your edit.");

    // Try again takes the lease again; the field stays locked until the full body arrives.
    await act(async () => button(container, "Try again").click());
    expect(editWaitingMessage).toHaveBeenCalledTimes(2);
    expect(field(container)?.readOnly).toBe(true);
    await act(async () => opened(editor));
    expect(field(container)?.readOnly).toBe(false);
    expect(field(container)?.value).toBe("Check the shard and then the whole integration suite");
    await write(field(container)!, "Check the shard and then the whole integration suite, twice");
    await press(field(container)!, "Enter");
    expect(editor.save).toHaveBeenCalledWith(
      [{ text: "Check the shard and then the whole integration suite, twice", type: "text" }, page],
      0,
    );
  });

  it("Escape ends the edit unsaved and lets the message go on", async () => {
    const editor = fakeEditor("Draft");
    const client = { editWaitingMessage: vi.fn(async () => editor) } as unknown as HostClient;
    const container = mount(render(client, inputsOf([item("mine", "Draft", { canEdit: true })])));
    await clickWords(container, "mine");
    await write(field(container)!, "Draft, reworded");
    await press(field(container)!, "Escape");

    expect(field(container)).toBeNull();
    expect(editor.cancel).toHaveBeenCalledTimes(1);
    expect(editor.save).not.toHaveBeenCalled();
  });

  it("keeps the words when the save is refused or the message is taken", async () => {
    const editor = fakeEditor("Open a PR", {
      save: vi.fn(async () => {
        throw new HostClientRequestError({ code: "conflict", message: "changed", status: 409 });
      }),
    });
    const dispatch = vi.fn(async () => ({}));
    const client = {
      dispatch,
      editWaitingMessage: vi.fn(async () => editor),
    } as unknown as HostClient;
    const container = mount(
      render(client, inputsOf([item("mine", "Open a PR", { canEdit: true })])),
    );
    await clickWords(container, "mine");
    await write(field(container)!, "Open a draft PR");
    await press(field(container)!, "Enter");

    expect(field(container)?.value).toBe("Open a draft PR");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    // A Run takes the message meanwhile: the open edit stays, with its words.
    act(() => root?.render(render(client, [])));
    expect(field(container)?.value).toBe("Open a draft PR");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("took this message");
  });

  it("another device's edit holds the message here: no editing, Answer waits, Release frees it", async () => {
    const lease = {
      deviceLabel: "Tim’s iPad",
      expiresAt: "2026-10-31T12:02:00.000Z",
      leaseId: "x",
    };
    const editWaitingMessage = vi.fn();
    const releaseWaitingMessage = vi.fn(async () => undefined);
    const client = { editWaitingMessage, releaseWaitingMessage } as unknown as HostClient;
    const container = mount(
      render(
        client,
        inputsOf([
          item("mine", "Held elsewhere", { canCancel: true, canEdit: true, lease }),
          ask("asked", "Is CI green?", { lease }),
        ]),
      ),
    );
    await clickWords(container, "mine");
    await clickWords(container, "asked");
    expect(editWaitingMessage).not.toHaveBeenCalled();
    expect(buttons(container)).not.toContain("Edit this message");
    expect(container.textContent).toContain("Being edited on Tim’s iPad");
    expect(button(container, "Answer").disabled).toBe(true);

    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-message-id="mine"]')!
        .closest("li")!
        .querySelector<HTMLButtonElement>("button")!
        .click(),
    );
    expect(releaseWaitingMessage).toHaveBeenCalledWith("thread", "mine");
  });

  it("answering an ask mid-edit saves the edit first and approves the version saved", async () => {
    const calls: string[] = [];
    const editor = fakeEditor("Is CI green?", {
      save: vi.fn(async () => {
        calls.push("save");
        return { editedAt: "2026-10-31T12:01:00.000Z", ownerEdited: true as const, revision: 3 };
      }),
    });
    const decideTeamAsk = vi.fn(async () => {
      calls.push("decide");
    });
    const client = {
      decideTeamAsk,
      editWaitingMessage: vi.fn(async () => editor),
    } as unknown as HostClient;
    const container = mount(render(client, inputsOf([ask("asked", "Is CI green?")])));
    expect(button(container, "Answer")).toBeDefined();

    await clickWords(container, "asked");
    await write(field(container)!, "Is CI green on main?");
    await act(async () => button(container, "Save and answer").click());

    expect(calls).toEqual(["save", "decide"]);
    expect(editor.save).toHaveBeenCalledWith([{ text: "Is CI green on main?", type: "text" }], 0);
    expect(decideTeamAsk).toHaveBeenCalledWith({
      decision: "approve",
      expectedRevision: 3,
      requestId: "tar_ask",
      teamId: "dep_00000000-0000-4000-8000-000000000001",
    });
  });

  it("Answer on a long ask waits until its whole text is read and shown", async () => {
    const whole =
      "Is CI green on main, and if not, revert the last three merges and page the on-call";
    let read!: (value: unknown) => void;
    const revisions = vi.fn(() => new Promise((resolve) => (read = resolve)));
    const decideTeamAsk = vi.fn(async () => undefined);
    const client = {
      decideTeamAsk,
      rpc: { "thread.message.revisions.list": revisions },
    } as unknown as HostClient;
    const [clipped] = inputsOf([ask("asked", whole)]).map((input) => ({
      ...input,
      entry: { ...input.entry, body: "Is CI green on main, and if not", previewTruncated: true },
    }));
    const container = mount(render(client, [clipped!]));
    expect(button(container, "Answer").disabled).toBe(true);
    expect(container.textContent).not.toContain("page the on-call");
    expect(revisions).toHaveBeenCalledWith({
      threadId: "thread",
      messageId: "asked",
      expectedRevision: 0,
    });
    await act(async () =>
      read({
        ok: true,
        data: {
          hasMore: false,
          revisions: [
            {
              revision: 0,
              content: [{ type: "text", text: whole }],
              author: clipped!.entry.author,
              deviceLabel: null,
              createdAt: "2026-10-31T12:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(container.textContent).toContain("page the on-call");
    await act(async () => button(container, "Answer").click());
    expect(decideTeamAsk).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  });

  it("binds an open edit to the version it shows: untouched words follow a save made elsewhere", async () => {
    let opened!: (editor: WaitingMessageEditor) => void;
    const opening = new Promise<WaitingMessageEditor>((resolve) => {
      opened = resolve;
    });
    const decideTeamAsk = vi.fn(async () => undefined);
    const client = {
      decideTeamAsk,
      editWaitingMessage: vi.fn(() => opening),
    } as unknown as HostClient;
    const old = ask("asked", "Old words");
    const container = mount(render(client, inputsOf([old])));
    await clickWords(container, "asked");
    // Another device saved before this one held the ask.
    await act(async () => {
      root?.render(render(client, inputsOf([edited(old, "New words on iPad", 1)])));
      opened(fakeEditor("New words on iPad", { revision: 1 }));
    });
    expect(field(container)?.value).toBe("New words on iPad");
    await act(async () => button(container, "Answer").click());
    expect(decideTeamAsk).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
  });

  it("a newer version under untouched words locks the field until its full body is read under the lease", async () => {
    let body!: (content: readonly ContentPart[]) => void;
    const editor = fakeEditor("Old words", {
      read: vi.fn(
        () =>
          new Promise<readonly ContentPart[]>((resolve) => {
            body = resolve;
          }),
      ),
    });
    const client = { editWaitingMessage: vi.fn(async () => editor) } as unknown as HostClient;
    const old = ask("asked", "Old words");
    const container = mount(render(client, inputsOf([old])));
    await clickWords(container, "asked");
    expect(field(container)?.value).toBe("Old words");
    // Another device saved; the queue reports only a clipped preview of it.
    await act(async () =>
      root?.render(render(client, inputsOf([edited(old, "New words on i", 1)]))),
    );
    expect(editor.read).toHaveBeenCalledWith(1);
    await press(field(container)!, "Enter");
    expect(editor.save).not.toHaveBeenCalled();
    expect(button(container, "Answer").disabled, "Answer approved a preview").toBe(true);
    await act(async () => body([{ text: "New words on iPad, in full", type: "text" }]));
    expect(field(container)?.value).toBe("New words on iPad, in full");
    expect(button(container, "Answer").disabled).toBe(false);
  });

  it("keeps words typed over a newer version: nothing saves or approves them until reloaded", async () => {
    const editor = fakeEditor("Old words", {
      // The version reloaded is read whole under the lease before it can be edited.
      read: vi.fn(async () => [{ text: "New words on iPad", type: "text" as const }]),
      save: vi.fn(async () => ({ editedAt: "2026-10-31T12:02:00.000Z", revision: 2 })),
    });
    const decideTeamAsk = vi.fn(async () => undefined);
    const client = {
      decideTeamAsk,
      editWaitingMessage: vi.fn(async () => editor),
    } as unknown as HostClient;
    const old = ask("asked", "Old words");
    const container = mount(render(client, inputsOf([old])));
    await clickWords(container, "asked");
    await write(field(container)!, "My words");
    act(() => root?.render(render(client, inputsOf([edited(old, "New words on iPad", 1)]))));

    expect(field(container)?.value).toBe("My words");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(button(container, "Save and answer").disabled).toBe(true);
    await press(field(container)!, "Enter");
    expect(editor.save).not.toHaveBeenCalled();

    await act(async () => button(container, "Reload").click());
    expect(editor.read).toHaveBeenCalledWith(1);
    expect(field(container)?.value).toBe("New words on iPad");
    await write(field(container)!, "New words, then mine");
    await act(async () => button(container, "Save and answer").click());
    expect(editor.save).toHaveBeenCalledWith([{ text: "New words, then mine", type: "text" }], 1);
    expect(decideTeamAsk).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }));
  });

  it("hands an edit to the app outbox before closing its editor", async () => {
    const editor = fakeEditor("Old", {
      save: vi.fn(async () => {
        throw new HostClientRequestError({ code: "conflict", message: "taken", status: 409 });
      }),
    });
    const client = new MockHostClient({ latencyMs: 0 });
    const dispatch = vi
      .spyOn(client, "dispatch")
      .mockRejectedValue(new TypeError("The connection was lost."));
    client.editWaitingMessage = async () => editor;
    const records = new Map<string, string>();
    const outbox = initializeMessageOutbox(client, {
      storage: createMessageOutboxStorage({
        read: async (key) => records.get(key) ?? null,
        write: async (key, value) => {
          records.set(key, value);
        },
        remove: async (key) => {
          records.delete(key);
        },
      }),
      drafts: { restore: async () => "restored" },
    });
    try {
      const container = mount(
        render(
          client,
          inputsOf([item("mine", "Old", { canEdit: true })], { threadId: createId("thread") }),
        ),
      );
      await clickWords(container, "mine");
      await write(field(container)!, "Keep my edit");
      await press(field(container)!, "Enter");
      await act(async () => button(container, "Send as new message").click());
      expect(field(container)).toBeNull();
      expect(records.size).toBe(1);
      expect(outbox.getSnapshot().messages).toMatchObject([
        { command: { content: [{ type: "text", text: "Keep my edit" }] } },
      ]);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });

  it("a save under way holds its editor: Escape waits, and only that save closes it", async () => {
    let saved!: (edit: { revision: number; editedAt: string }) => void;
    const first = fakeEditor("Old", {
      save: vi.fn(
        () =>
          new Promise<{ revision: number; editedAt: string }>((resolve) => {
            saved = resolve;
          }),
      ),
    });
    const second = fakeEditor("Old", { leaseId: "second" });
    const editWaitingMessage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = { editWaitingMessage } as unknown as HostClient;
    const container = mount(render(client, inputsOf([item("mine", "Old", { canEdit: true })])));
    await clickWords(container, "mine");
    await write(field(container)!, "First save");
    await press(field(container)!, "Enter");
    await press(field(container)!, "Escape");
    expect(field(container)?.value).toBe("First save");
    expect(first.cancel).not.toHaveBeenCalled();

    await act(async () => saved({ editedAt: "2026-10-31T12:01:00.000Z", revision: 1 }));
    expect(field(container)).toBeNull();
    await clickWords(container, "mine");
    await write(field(container)!, "Replacement draft");
    expect(field(container)?.value).toBe("Replacement draft");
    expect(first.cancel).not.toHaveBeenCalled();
  });

  it("opens an ask's editor from its labelled Edit button and hands focus back on the way out", async () => {
    const editor = fakeEditor("Is CI green?");
    const client = { editWaitingMessage: vi.fn(async () => editor) } as unknown as HostClient;
    const container = mount(render(client, inputsOf([ask("asked", "Is CI green?")])));
    const trigger = () => button(container, "Edit Maya Chen’s ask");
    trigger().focus();
    await act(async () => trigger().click());
    expect(document.activeElement).toBe(field(container)?.element);

    await press(field(container)!, "Escape");
    expect(field(container)).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
