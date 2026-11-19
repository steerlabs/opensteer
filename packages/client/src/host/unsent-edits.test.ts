import { describe, expect, it } from "vitest";
import { hydrateWaitingDraft, openWaitingDraft, setWaitingDraftText } from "./waiting-draft.js";
import { draftOfUnsentEdit, unsentEditOf, UnsentEdits } from "./unsent-edits.js";

/** A device's storage: it survives a restart, and can be made to refuse a write. */
function device() {
  let saved: string | null = null;
  let refuse = false;
  return {
    storage: {
      read: () => saved,
      write: async (document: string) => {
        if (refuse) throw new Error("The disk is full.");
        saved = document;
      },
    },
    refuse: (value: boolean) => (refuse = value),
    saved: () => saved,
  };
}

const typed = (text: string) =>
  setWaitingDraftText(
    hydrateWaitingDraft(openWaitingDraft({ content: [], revision: 3 }), {
      content: [{ type: "text", text: "Base words" }],
      revision: 3,
      full: true,
    }),
    text,
  );

describe("unsent waiting edits", () => {
  it("keep a dirty full-body edit across a restart, and restore it bound to its version", async () => {
    const disk = device();
    const edits = new UnsentEdits(disk.storage);
    await edits.ready();
    const edit = unsentEditOf("thread", "message", typed("My words"), 1)!;
    await edits.put("scope", edit);
    // A restart: a new store over the same storage.
    const after = new UnsentEdits(disk.storage);
    await after.ready();
    const kept = after.get("scope", "thread", "message")!;
    expect(kept).toEqual(edit);
    expect(draftOfUnsentEdit(kept)).toMatchObject({
      baseRevision: 3,
      dirty: true,
      loading: false,
      text: "My words",
    });
    expect(after.get("other scope", "thread", "message")).toBeUndefined();
  });

  it("keeps nothing for a locked preview or untouched words", () => {
    expect(unsentEditOf("t", "m", openWaitingDraft({ content: [], revision: 1 }), 1)).toBeNull();
    expect(unsentEditOf("t", "m", typed("Base words"), 1)).toBeNull();
  });

  it("tells the writer when storage refused the words, and keeps them for the session", async () => {
    const disk = device();
    const edits = new UnsentEdits(disk.storage);
    await edits.ready();
    disk.refuse(true);
    const edit = unsentEditOf("thread", "message", typed("My words"), 1)!;
    await expect(edits.put("scope", edit)).rejects.toThrow("disk is full");
    expect(edits.get("scope", "thread", "message")).toEqual(edit);
    disk.refuse(false);
    await edits.put("scope", { ...edit, updatedAt: 2 });
    expect(disk.saved()).toContain("My words");
  });

  it("removes only the record an action was about: words typed since stay", async () => {
    const edits = new UnsentEdits(device().storage);
    await edits.ready();
    const first = unsentEditOf("thread", "message", typed("First"), 1)!;
    await edits.put("scope", first);
    const second = unsentEditOf("thread", "message", typed("First, then more"), 2)!;
    await edits.put("scope", second);
    // The action begun for the first words completes: the newer words are not its to end.
    await edits.remove("scope", "thread", "message", first);
    expect(edits.get("scope", "thread", "message")).toEqual(second);
    await edits.remove("scope", "thread", "message", second);
    expect(edits.get("scope", "thread", "message")).toBeUndefined();
    // Ending it twice is ending it once.
    await edits.remove("scope", "thread", "message", second);
    expect(edits.forThread("scope", "thread")).toEqual([]);
  });
});
