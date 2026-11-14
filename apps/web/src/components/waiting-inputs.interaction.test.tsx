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
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import type { ContentPart, ThreadInputQueue } from "@opensteer/core";
import { TranscriptHostClientContext } from "./attachments/message-attachments.js";
import { TranscriptMessage } from "./agent-activity.js";
import type { PendingSends, PendingSubmission } from "./composer.js";
import { WaitingInputs } from "./waiting-inputs.js";

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

function inputsOf(items: Item[], options: { paused?: boolean } = {}): WaitingInput[] {
  return waitingInputs(
    {
      items,
      paused: options.paused ?? false,
      steerRunId: null,
      threadId: "thread",
    } as unknown as ThreadInputQueue,
    { ownsLease: () => false },
  );
}

function fakeEditor(overrides: Partial<WaitingMessageEditor> = {}): WaitingMessageEditor {
  return {
    cancel: vi.fn(async () => undefined),
    leaseId: "lease",
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

/** The browser's kept-send record for this Thread, in memory. */
function memorySends(): PendingSends & { readonly kept: () => PendingSubmission | null } {
  let kept: PendingSubmission | null = null;
  return {
    claim: (submission) => {
      if (kept && kept.idempotencyKey !== submission.idempotencyKey)
        throw new Error("This thread already has a message awaiting acknowledgement.");
      kept = submission;
    },
    clear: (key) => {
      if (kept?.idempotencyKey === key) kept = null;
    },
    discard: () => {
      kept = null;
    },
    kept: () => kept,
    read: () => kept,
  };
}

function render(
  client: HostClient,
  inputs: WaitingInput[],
  options: {
    disabled?: boolean;
    paused?: boolean;
    onError?: (error: unknown) => void;
    sends?: PendingSends;
  } = {},
) {
  return (
    <MemoryRouter>
      <WaitingInputs
        client={client}
        disabled={options.disabled ?? false}
        inputs={inputs}
        onError={options.onError ?? vi.fn()}
        paused={options.paused ?? false}
        pendingSends={{ sends: options.sends ?? memorySends() }}
        resumable
        threadId="thread"
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

const field = (container: HTMLElement) => container.querySelector("textarea");

async function write(target: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      target,
      text,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
}

describe("WaitingInputs", () => {
  it("keeps one image read when a queued message is taken before download finishes", async () => {
    const client = new HttpHostClient({ baseUrl: "http://127.0.0.1", refreshIntervalMs: 0 });
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
    const editor = fakeEditor();
    const editWaitingMessage = vi.fn(async () => editor);
    const client = { editWaitingMessage } as unknown as HostClient;
    const photo = { artifactId: "a1", mediaType: "image/png", name: "photo.png", type: "artifact" };
    const notes = {
      artifactId: "a2",
      mediaType: "text/plain",
      name: "notes.txt",
      type: "artifact",
    };
    const container = mount(
      render(
        client,
        inputsOf([
          item(
            "mine",
            "Check the shard",
            { canEdit: true },
            { content: [{ text: "Check the shard", type: "text" }, photo, notes] as ContentPart[] },
          ),
        ]),
      ),
    );
    await clickWords(container, "mine");
    expect(editWaitingMessage).toHaveBeenCalledWith("thread", "mine");
    expect(field(container)?.value).toBe("Check the shard");

    await write(field(container)!, "Check the integration shard");
    expect(editor.touch).toHaveBeenCalled();
    await act(async () => button(container, "Don’t include photo.png").click());
    await press(field(container)!, "Enter");

    expect(editor.save).toHaveBeenCalledWith(
      [{ text: "Check the integration shard", type: "text" }, notes],
      0,
    );
    expect(field(container)).toBeNull();
    expect(editor.cancel).not.toHaveBeenCalled();
  });

  it("Escape ends the edit unsaved and lets the message go on", async () => {
    const editor = fakeEditor();
    const client = { editWaitingMessage: vi.fn(async () => editor) } as unknown as HostClient;
    const container = mount(render(client, inputsOf([item("mine", "Draft", { canEdit: true })])));
    await clickWords(container, "mine");
    await write(field(container)!, "Draft, reworded");
    await press(field(container)!, "Escape");

    expect(field(container)).toBeNull();
    expect(editor.cancel).toHaveBeenCalledTimes(1);
    expect(editor.save).not.toHaveBeenCalled();
  });

  it("keeps the words when the save is refused or the message is taken, and can send them as new", async () => {
    const editor = fakeEditor({
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

    await act(async () => button(container, "Send as new message").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ text: "Open a draft PR", type: "text" }],
        delivery: "queue",
        threadId: "thread",
        type: "thread.sendMessage",
      }),
    );
    expect(field(container)).toBeNull();
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
    const editor = fakeEditor({
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
      opened(fakeEditor({ revision: 1 }));
    });
    expect(field(container)?.value).toBe("New words on iPad");
    await act(async () => button(container, "Answer").click());
    expect(decideTeamAsk).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
  });

  it("keeps words typed over a newer version: nothing saves or approves them until reloaded", async () => {
    const editor = fakeEditor({
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
    expect(field(container)?.value).toBe("New words on iPad");
    await write(field(container)!, "New words, then mine");
    await act(async () => button(container, "Save and answer").click());
    expect(editor.save).toHaveBeenCalledWith([{ text: "New words, then mine", type: "text" }], 1);
    expect(decideTeamAsk).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }));
  });

  it("sends kept words as a new message once: an unconfirmed send is retried under its key", async () => {
    const editor = fakeEditor({
      save: vi.fn(async () => {
        throw new HostClientRequestError({ code: "conflict", message: "taken", status: 409 });
      }),
    });
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("The connection was lost."))
      .mockResolvedValue({});
    const client = {
      dispatch,
      editWaitingMessage: vi.fn(async () => editor),
    } as unknown as HostClient;
    const sends = memorySends();
    const container = mount(
      render(client, inputsOf([item("mine", "Old", { canEdit: true })]), { sends }),
    );
    await clickWords(container, "mine");
    await write(field(container)!, "Keep my edit");
    await press(field(container)!, "Enter");
    await act(async () => button(container, "Send as new message").click());

    // Kept before it left, and still kept: the Host may have it.
    expect(sends.kept()?.idempotencyKey).toBe(dispatch.mock.calls[0]![0].idempotencyKey);
    expect(field(container)?.value).toBe("Keep my edit");
    await act(async () => button(container, "Send again").click());
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0]).toEqual(dispatch.mock.calls[0]![0]);
    expect(sends.kept()).toBeNull();
    expect(field(container)).toBeNull();
  });

  it("a save under way holds its editor: Escape waits, and only that save closes it", async () => {
    let saved!: (edit: { revision: number; editedAt: string }) => void;
    const first = fakeEditor({
      save: vi.fn(
        () =>
          new Promise<{ revision: number; editedAt: string }>((resolve) => {
            saved = resolve;
          }),
      ),
    });
    const second = fakeEditor({ leaseId: "second" });
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
    const editor = fakeEditor();
    const client = { editWaitingMessage: vi.fn(async () => editor) } as unknown as HostClient;
    const container = mount(render(client, inputsOf([ask("asked", "Is CI green?")])));
    const trigger = () => button(container, "Edit Maya Chen’s ask");
    trigger().focus();
    await act(async () => trigger().click());
    expect(document.activeElement).toBe(field(container));

    await press(field(container)!, "Escape");
    expect(field(container)).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
