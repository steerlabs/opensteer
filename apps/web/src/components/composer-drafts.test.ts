import { describe, expect, it, vi } from "vitest";
import {
  composerDraftKey,
  createComposerDraftStore,
  type DraftStorage,
} from "./composer-drafts.js";

function memoryStorage(): DraftStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

const scope = { deploymentId: "deployment", userId: "user" };
const task = (draftId: string) => composerDraftKey(scope, { kind: "task", draftId });
const reply = (threadId: string) => composerDraftKey(scope, { kind: "thread", threadId });

describe("composer drafts", () => {
  it("keeps nothing for a draft with nothing in it, and forgets one emptied", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);

    drafts.update(task("a"), { text: "   " });
    expect(storage.length).toBe(0);

    drafts.update(task("a"), { text: "words" });
    expect(drafts.read(task("a"))?.text).toBe("words");
    drafts.update(task("a"), { text: "" });
    expect(drafts.read(task("a"))).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("never lets one window's write disturb another window's draft", () => {
    const storage = memoryStorage();
    const first = createComposerDraftStore(() => storage);
    const second = createComposerDraftStore(() => storage);

    first.update(task("a"), { text: "from the first window" });
    second.update(task("b"), { text: "from the second window" });
    first.update(task("a"), { text: "still the first window" });

    expect(second.read(task("a"))?.text).toBe("still the first window");
    expect(first.read(task("b"))?.text).toBe("from the second window");
  });

  it("shows one person none of another person's or another Deployment's drafts", () => {
    const drafts = createComposerDraftStore(memoryStorage);
    const storage = memoryStorage();
    const shared = createComposerDraftStore(() => storage);
    shared.update(task("mine"), { text: "mine" });
    shared.update(composerDraftKey({ ...scope, userId: "other" }, { kind: "task", draftId: "x" }), {
      text: "theirs",
    });
    shared.update(
      composerDraftKey({ ...scope, deploymentId: "elsewhere" }, { kind: "task", draftId: "y" }),
      { text: "elsewhere" },
    );

    expect(shared.index(scope).tasks.map((row) => row.title)).toEqual(["mine"]);
    expect(drafts.index(scope).tasks).toEqual([]);
  });

  it("does not stop or disturb a key holding characters a key separator could confuse", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const odd = composerDraftKey(
      { deploymentId: "a:b", userId: "c" },
      { kind: "thread", threadId: "t:1" },
    );
    const near = composerDraftKey(
      { deploymentId: "a", userId: "b:c" },
      { kind: "thread", threadId: "t:1" },
    );
    drafts.update(odd, { text: "one" });

    expect(drafts.read(near)).toBeNull();
    expect([...drafts.index({ deploymentId: "a:b", userId: "c" }).replies]).toEqual(["t:1"]);
    expect(drafts.index({ deploymentId: "a", userId: "b:c" }).replies.size).toBe(0);
  });

  it("holds a row still while its composer types, and catches up on leaving", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const redraw = vi.fn();
    drafts.subscribe(redraw);
    const close = drafts.open(task("a"));
    redraw.mockClear();

    drafts.update(task("a"), { text: "typing" });
    drafts.update(task("a"), { text: "typing more" });
    expect(redraw).not.toHaveBeenCalled();

    close();
    expect(redraw).toHaveBeenCalledOnce();
    expect(drafts.index(scope).tasks[0]?.title).toBe("typing more");
  });

  it("shows a reply's mark only while that conversation is not on screen", () => {
    const drafts = createComposerDraftStore(memoryStorage.bind(null));
    const storage = memoryStorage();
    const shared = createComposerDraftStore(() => storage);
    shared.update(reply("thread"), { text: "unsent" });
    expect(shared.index(scope).replies.has("thread")).toBe(true);

    const close = shared.open(reply("thread"));
    expect(shared.index(scope).replies.has("thread")).toBe(false);
    close();
    expect(shared.index(scope).replies.has("thread")).toBe(true);
    expect(drafts.index(scope).replies.size).toBe(0);
  });

  it("orders drafts by the last edit, and opening one is not an edit", () => {
    let clock = 1;
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(
      () => storage,
      () => clock++,
    );
    drafts.update(task("older"), { text: "older" });
    drafts.update(task("newer"), { text: "newer" });

    const close = drafts.open(task("older"));
    drafts.update(task("older"), { text: "older" });
    close();
    expect(drafts.index(scope).tasks.map((row) => row.draftId)).toEqual(["newer", "older"]);

    drafts.update(task("older"), { text: "older, edited" });
    expect(drafts.index(scope).tasks.map((row) => row.draftId)).toEqual(["older", "newer"]);
  });

  it("names a row by its first line, then by what it holds", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const file = { mediaType: "text/plain", name: "notes.txt", part: null, sizeBytes: 1 };
    drafts.update(task("words"), { text: "\n  First line\nSecond line" });
    drafts.update(task("file"), { files: [file] });
    drafts.update(task("files"), { files: [file, file] });

    const titles = new Map(drafts.index(scope).tasks.map((row) => [row.draftId, row.title]));
    expect(titles.get("words")).toBe("First line");
    expect(titles.get("file")).toBe("notes.txt");
    expect(titles.get("files")).toBe("2 files");
  });

  it("does not count a place the draft only picked up by itself as something to keep", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const page = {
      auto: true,
      sessionId: "bsn_00000000-0000-0000-0000-000000000000",
      tabId: "tab",
      title: "A page",
      type: "browser-page",
      url: "https://example.com/",
    } as const;
    drafts.update(task("a"), { places: [page as never] });
    expect(drafts.read(task("a"))).toBeNull();
    drafts.update(task("a"), { places: [{ ...page, auto: false } as never] });
    expect(drafts.read(task("a"))).not.toBeNull();
  });

  it("returns a refused send ahead of what was written since, until the draft is opened", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(task("a"), { text: "written since" });
    drafts.handBack(task("a"), {
      edit: (text) => `the refused words\n${text}`,
      reason: "The Host said no.",
    });
    expect(drafts.read(task("a"))).toMatchObject({
      refusal: "The Host said no.",
      text: "the refused words\nwritten since",
    });
    expect(drafts.index(scope).tasks[0]?.refused).toBe(true);

    // An upload finishing while it waits is not the person reading it.
    drafts.update(task("a"), { files: [] });
    expect(drafts.read(task("a"))?.refusal).toBe("The Host said no.");

    drafts.open(task("a"));
    drafts.update(task("a"), { text: "the refused words\nwritten since" });
    expect(drafts.read(task("a"))?.refusal).toBeUndefined();
    expect(drafts.index(scope).tasks[0]?.refused).toBe(false);
  });

  it("hands what comes back to the composer open on that draft, not over it", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const receive = vi.fn();
    const close = drafts.open(task("a"), receive);
    const returned = { edit: () => "returned", reason: "Refused." };

    drafts.handBack(task("a"), returned);
    expect(receive).toHaveBeenCalledWith(returned);
    expect(drafts.read(task("a"))).toBeNull();

    close();
    drafts.handBack(task("a"), returned);
    expect(receive).toHaveBeenCalledOnce();
    expect(drafts.read(task("a"))?.text).toBe("returned");
  });

  it("puts a returned task back in the folder it was to start in", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const folder = { computerId: "rnr_00000000-0000-4000-8000-000000000001", path: "/code/app" };
    drafts.handBack(task("a"), { edit: () => "words", folder: folder as never });
    expect(drafts.index(scope).tasks[0]?.folder).toEqual(folder);
  });

  it("lays a discarded draft back exactly as it was", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(task("a"), { text: "keep me" });
    const discarded = drafts.read(task("a"));
    drafts.clear(task("a"));
    expect(drafts.index(scope).tasks).toEqual([]);

    drafts.restore(task("a"), discarded!);
    expect(drafts.read(task("a"))).toEqual(discarded);
  });

  it("keeps a draft for this window when storage refuses it, and says so", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
    const drafts = createComposerDraftStore(() => storage);

    expect(drafts.update(task("a"), { text: "unsaved" })).toBe(false);
    expect(drafts.read(task("a"))?.text).toBe("unsaved");
    expect(drafts.index(scope).tasks.map((row) => row.title)).toEqual(["unsaved"]);
  });

  it("keeps saying a draft is unsaved until storage takes it", () => {
    const storage = memoryStorage();
    const setItem = storage.setItem;
    storage.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(task("a"), { text: "unsaved" });

    expect(drafts.update(task("a"), { text: "unsaved" })).toBe(false);

    storage.setItem = setItem;
    expect(drafts.update(task("a"), { text: "unsaved" })).toBe(true);
    expect(storage.getItem(task("a"))).toContain("unsaved");
  });

  it("works with no storage at all", () => {
    const drafts = createComposerDraftStore(() => {
      throw new Error("Storage is disabled.");
    });
    expect(drafts.update(task("a"), { text: "words" })).toBe(false);
    expect(drafts.read(task("a"))?.text).toBe("words");
    expect(drafts.index(scope).tasks).toHaveLength(1);
  });

  it("reads a damaged entry as no draft, and leaves everything else alone", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(task("good"), { text: "good" });
    storage.setItem(task("bad"), "{not json");
    storage.setItem(task("wrong"), JSON.stringify({ text: 7 }));

    expect(drafts.read(task("bad"))).toBeNull();
    expect(drafts.read(task("wrong"))).toBeNull();
    expect(drafts.index(scope).tasks.map((row) => row.draftId)).toEqual(["good"]);
  });

  it("keeps the words when what surrounds them no longer parses", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    storage.setItem(
      task("old"),
      JSON.stringify({
        files: [{ shape: "from another release" }],
        places: [{ type: "something-new" }],
        quote: { from: "another release" },
        text: "the words",
        updatedAt: 1,
      }),
    );
    expect(drafts.read(task("old"))).toMatchObject({ files: [], quote: null, text: "the words" });
  });

  it("forgets every draft on signing out, and nothing that is not a draft", () => {
    const storage = memoryStorage();
    storage.setItem("opensteer:pending-send:v1:keep", "kept");
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(task("a"), { text: "a" });
    drafts.update(composerDraftKey({ ...scope, userId: "other" }, { kind: "task", draftId: "b" }), {
      text: "b",
    });

    drafts.clearAll();

    expect(storage.length).toBe(1);
    expect(storage.getItem("opensteer:pending-send:v1:keep")).toBe("kept");
  });
});
