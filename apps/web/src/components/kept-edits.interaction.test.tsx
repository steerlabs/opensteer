// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { MockHostClient } from "@opensteer/client/mock";
import {
  createMessageOutboxStorage,
  initializeMessageOutbox,
  type UnsentEdit,
} from "@opensteer/client/host";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { KeptEdits } from "./kept-edits.js";
import { unsentEditScope, unsentEdits } from "./unsent-edits.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  client = null;
  localStorage.clear();
  unsentEdits.resetForTests();
  vi.restoreAllMocks();
});

/** A task whose kept words belong to a message no longer waiting. */
async function kept() {
  client = new MockHostClient({ latencyMs: 0 });
  const threadId = client.getSnapshot().threads[0]!.id;
  const scope = unsentEditScope(client)!;
  const edit: UnsentEdit = {
    base: { parts: 0, text: "Old words" },
    baseRevision: 0,
    messageId: "gone",
    parts: [],
    text: "Words I meant to save",
    threadId,
    updatedAt: 1,
  };
  await unsentEdits.ready();
  await unsentEdits.put(scope, edit);
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(<KeptEdits client={client!} threadId={threadId} waitingIds={[]} />),
  );
  const button = (name: string) =>
    [...node.querySelectorAll("button")].find((candidate) => candidate.textContent === name)!;
  const held = () => unsentEdits.get(scope, threadId, "gone")?.text ?? null;
  const draftKey = composerDraftKeyFor(
    client.getSnapshot().deploymentId,
    client.getSnapshot().user?.id,
    { kind: "thread", threadId },
  )!;
  return { node, button, held, threadId, draftKey };
}

it("keeps the words when the message box refuses them, says why, and ends them once it takes them", async () => {
  const { node, button, held, draftKey } = await kept();
  expect(node.textContent).toContain("Words I meant to save");
  const handBack = vi.spyOn(composerDrafts, "handBack").mockResolvedValueOnce(false);
  await act(async () => button("Move to message box").click());
  expect(held(), "a refused move lost the words").toBe("Words I meant to save");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("couldn’t take these words");
  handBack.mockRestore();
  // Clicked twice before the first lands: one move.
  const once = vi.spyOn(composerDrafts, "handBack");
  await act(async () => {
    button("Move to message box").click();
    button("Move to message box").click();
  });
  expect(once).toHaveBeenCalledOnce();
  expect(await once.mock.results[0]!.value, "the message box refused").toBe(true);
  await vi.waitFor(() => expect(held()).toBeNull());
  expect(composerDrafts.read(draftKey)?.text).toBe("Words I meant to save");
});

it("sends the words as a new message once, and ends them only when the outbox holds it", async () => {
  const records = new Map<string, string>();
  const { button, held, threadId } = await kept();
  vi.spyOn(client!, "dispatch").mockRejectedValue(new TypeError("The connection was lost."));
  const outbox = initializeMessageOutbox(client!, {
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
  // The process dies after the outbox took the message but before the words were ended: the
  // words are still kept, and sending them again is the same message.
  const remove = vi.spyOn(unsentEdits, "remove").mockRejectedValueOnce(new Error("killed"));
  await act(async () => button("Send as new message").click());
  expect(held()).toBe("Words I meant to save");
  remove.mockRestore();
  await act(async () => button("Send as new message").click());
  await vi.waitFor(() => expect(held()).toBeNull());
  expect(outbox.getSnapshot().messages).toHaveLength(1);
  expect(outbox.getSnapshot().messages[0]).toMatchObject({
    command: { threadId, content: [{ type: "text", text: "Words I meant to save" }] },
  });
});

it("Discard ends the words", async () => {
  const { button, held } = await kept();
  await act(async () => button("Discard").click());
  await vi.waitFor(() => expect(held()).toBeNull());
});
