import { describe, expect, it } from "vitest";
import type { ContentPart } from "@opensteer/core";
import {
  followWaitingDraft,
  hydrateWaitingDraft,
  openWaitingDraft,
  reloadWaitingDraft,
  removeWaitingDraftPart,
  setWaitingDraftText,
  waitingDraftAwaits,
  waitingDraftOutgoing,
  waitingDraftSave,
  type WaitingDraft,
  type WaitingDraftSource,
} from "./waiting-draft.js";

const photo: ContentPart = {
  artifactId: "a1",
  mediaType: "image/png",
  name: "photo.png",
  sizeBytes: 1,
  type: "artifact",
};
const words = (text: string, ...parts: ContentPart[]): ContentPart[] => [
  { text, type: "text" },
  ...parts,
];
/** The full body at `revision`, as the lease read returns it. */
const full = (revision: number, content: ContentPart[]) =>
  ({ content, revision, full: true }) as const;

/**
 * The invariant: whatever reports arrive, in whatever order, a draft Save accepts was built from
 * the full body at exactly the revision it names, and nothing typed into a preview is ever kept.
 */
function savedFromFullBody(draft: WaitingDraft, bodies: ReadonlyMap<number, WaitingDraftSource>) {
  const plan = waitingDraftSave(draft);
  if (plan === null) return true;
  const revision = plan.kind === "edit" ? plan.expectedRevision : plan.revision;
  const body = bodies.get(revision);
  return body !== undefined && revision === draft.baseRevision && !draft.loading;
}

describe("waiting draft", () => {
  it("a preview draft never edits or saves; the full body replaces it whole", () => {
    const page: ContentPart = {
      type: "browser-page",
      sessionId: `bsn_${crypto.randomUUID()}` as never,
      tabId: "tab-1" as never,
      title: "Docs",
      url: "https://example.com",
    };
    // The queue clipped the words and left the page out of its preview.
    const preview = openWaitingDraft({ content: words("Ship the fi", photo), revision: 2 });
    expect(waitingDraftAwaits(preview)).toBe(2);
    expect(setWaitingDraftText(preview, "Ship the fi now")).toBe(preview);
    expect(removeWaitingDraftPart(preview, 0)).toBe(preview);
    expect(waitingDraftSave(preview)).toBeNull();
    // A body older than the version the field waits for leaves it locked.
    expect(hydrateWaitingDraft(preview, full(1, words("Older")))).toBe(preview);
    const opened = hydrateWaitingDraft(
      preview,
      full(2, words("Ship the fix after the review lands", photo, page)),
    );
    expect(opened).toMatchObject({
      loading: false,
      dirty: false,
      text: "Ship the fix after the review lands",
      parts: [photo, page],
    });
    expect(waitingDraftAwaits(opened)).toBeNull();
    const edited = setWaitingDraftText(opened, "Ship the fix after the review lands, today");
    expect(waitingDraftSave(edited)).toEqual({
      kind: "edit",
      expectedRevision: 2,
      content: words("Ship the fix after the review lands, today", photo, page),
    });
  });

  it("a newer version under untouched words relocks the field until that version's full body is read", () => {
    const draft = openWaitingDraft(full(0, words("Old words", photo)));
    expect(waitingDraftSave(draft)).toEqual({ kind: "unchanged", revision: 0 });

    // The queue reports the newer version as a clipped preview.
    const followed = followWaitingDraft(draft, { content: words("New words on i"), revision: 1 });
    expect(followed).toMatchObject({ baseRevision: 1, conflict: null, loading: true });
    expect(waitingDraftAwaits(followed)).toBe(1);
    expect(waitingDraftSave(followed)).toBeNull();
    expect(setWaitingDraftText(followed, "typed into a preview")).toBe(followed);
    const opened = hydrateWaitingDraft(followed, full(1, words("New words on iPad")));
    expect(opened).toMatchObject({ baseRevision: 1, loading: false, text: "New words on iPad" });
    expect(waitingDraftSave(opened)).toEqual({ kind: "unchanged", revision: 1 });
    // The version it already holds, or an older report arriving late, changes nothing.
    expect(followWaitingDraft(opened, { content: words("Old words"), revision: 0 })).toBe(opened);
  });

  it("keeps changed words over a newer version as a conflict; reloading it relocks until its full body", () => {
    const typed = setWaitingDraftText(openWaitingDraft(full(0, words("Old words"))), "My words");
    expect(waitingDraftSave(typed)).toEqual({
      content: words("My words"),
      expectedRevision: 0,
      kind: "edit",
    });

    const newer = { content: words("New words on i"), revision: 1 };
    const conflicted = followWaitingDraft(typed, newer);
    expect(conflicted).toMatchObject({ baseRevision: 0, conflict: newer, text: "My words" });
    expect(waitingDraftSave(conflicted)).toBeNull();
    expect(followWaitingDraft(conflicted, newer)).toBe(conflicted);
    // Still typing keeps it bound to the version it was written against.
    expect(setWaitingDraftText(conflicted, "My words, more")).toMatchObject({
      baseRevision: 0,
      conflict: newer,
    });

    const reloaded = reloadWaitingDraft(conflicted);
    expect(reloaded).toMatchObject({ baseRevision: 1, conflict: null, loading: true });
    expect(waitingDraftSave(reloaded)).toBeNull();
    expect(hydrateWaitingDraft(reloaded, full(1, words("New words on iPad")))).toMatchObject({
      baseRevision: 1,
      loading: false,
      text: "New words on iPad",
    });
  });

  it("under any order of previews, full bodies and typing, Save only names a full body's revision", () => {
    // Deterministic pseudo-random interleavings of the reports an editor can see.
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % limit;
    };
    for (let run = 0; run < 200; run++) {
      const bodies = new Map<number, WaitingDraftSource>();
      let draft = openWaitingDraft({ content: words("pre"), revision: 0 });
      let head = 0;
      for (let step = 0; step < 30; step++) {
        const action = next(5);
        if (action === 0) head++;
        if (action <= 1)
          draft = followWaitingDraft(draft, { content: words(`preview ${head}`), revision: head });
        else if (action === 2) {
          const revision = next(head + 1);
          const body = full(revision, words(`full ${revision}`));
          bodies.set(revision, body);
          draft = hydrateWaitingDraft(draft, body);
        } else if (action === 3) draft = setWaitingDraftText(draft, `typed ${step}`);
        else draft = reloadWaitingDraft(draft);
        expect(savedFromFullBody(draft, bodies), `run ${run}, step ${step}`).toBe(true);
        if (waitingDraftSave(draft) && !draft.dirty)
          expect(draft.text).toBe(`full ${draft.baseRevision}`);
      }
    }
  });

  it("gives nothing to send or save from any locked draft; a loaded one gives its full body at its revision", () => {
    const preview = openWaitingDraft({ content: words("Ship the fi", photo), revision: 2 });
    const loaded = hydrateWaitingDraft(preview, full(2, words("Ship the fix", photo)));
    const followed = followWaitingDraft(loaded, { content: words("Newer, cli"), revision: 3 });
    const reloaded = reloadWaitingDraft(
      followWaitingDraft(setWaitingDraftText(loaded, "Mine"), {
        content: words("Newer"),
        revision: 3,
      }),
    );
    // Every action that sends or saves goes through these two: Save and saving before an answer
    // (`waitingDraftSave`), Send as new and a move to the composer (`waitingDraftOutgoing`).
    for (const [name, locked] of [
      ["opened from a preview", preview],
      ["followed to a newer preview", followed],
      ["reloaded onto a newer preview", reloaded],
    ] as const) {
      expect(locked.loading, name).toBe(true);
      expect(waitingDraftSave(locked), name).toBeNull();
      expect(waitingDraftOutgoing(locked), name).toBeNull();
    }
    expect(waitingDraftOutgoing(setWaitingDraftText(loaded, "Ship the fix today"))).toEqual({
      content: words("Ship the fix today", photo),
      parts: [photo],
      revision: 2,
      text: "Ship the fix today",
    });
  });

  it("saves trimmed words and the parts kept against the base version; nothing left saves nothing", () => {
    const draft = openWaitingDraft(full(3, words("Check it", photo)));
    expect(setWaitingDraftText(draft, "  Check it ")).toMatchObject({ dirty: false });

    const dropped = removeWaitingDraftPart(draft, 0);
    expect(waitingDraftSave(dropped)).toEqual({
      content: words("Check it"),
      expectedRevision: 3,
      kind: "edit",
    });
    expect(waitingDraftSave(setWaitingDraftText(dropped, " "))).toBeNull();
  });
});
