import { describe, expect, it } from "vitest";
import type { ContentPart } from "@opensteer/core";
import {
  followWaitingDraft,
  hydrateWaitingDraft,
  openWaitingDraft,
  reloadWaitingDraft,
  removeWaitingDraftPart,
  setWaitingDraftText,
  waitingDraftSave,
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
    const preview = openWaitingDraft({ content: words("Ship the fi", photo), revision: 2 }, true);
    expect(setWaitingDraftText(preview, "Ship the fi now")).toBe(preview);
    expect(removeWaitingDraftPart(preview, 0)).toBe(preview);
    expect(waitingDraftSave(preview)).toBeNull();
    const full = hydrateWaitingDraft(preview, {
      content: words("Ship the fix after the review lands", photo, page),
      revision: 2,
    });
    expect(full).toMatchObject({
      loading: false,
      dirty: false,
      text: "Ship the fix after the review lands",
      parts: [photo, page],
    });
    const edited = setWaitingDraftText(full, "Ship the fix after the review lands, today");
    expect(waitingDraftSave(edited)).toEqual({
      kind: "edit",
      expectedRevision: 2,
      content: words("Ship the fix after the review lands, today", photo, page),
    });
  });

  it("an untouched draft becomes the newer version, so Save and Answer name what is shown", () => {
    const draft = openWaitingDraft({ content: words("Old words", photo), revision: 0 });
    expect(waitingDraftSave(draft)).toEqual({ kind: "unchanged", revision: 0 });

    const followed = followWaitingDraft(draft, {
      content: words("New words on iPad"),
      revision: 1,
    });
    expect(followed).toMatchObject({
      baseRevision: 1,
      conflict: null,
      dirty: false,
      parts: [],
      text: "New words on iPad",
    });
    expect(waitingDraftSave(followed)).toEqual({ kind: "unchanged", revision: 1 });
    // The version it already holds, or an older report arriving late, changes nothing.
    expect(followWaitingDraft(followed, { content: words("Old words"), revision: 0 })).toBe(
      followed,
    );
  });

  it("keeps changed words over a newer version as a conflict that neither saves nor approves", () => {
    const typed = setWaitingDraftText(
      openWaitingDraft({ content: words("Old words"), revision: 0 }),
      "My words",
    );
    expect(waitingDraftSave(typed)).toEqual({
      content: words("My words"),
      expectedRevision: 0,
      kind: "edit",
    });

    const newer = { content: words("New words on iPad"), revision: 1 };
    const conflicted = followWaitingDraft(typed, newer);
    expect(conflicted).toMatchObject({ baseRevision: 0, conflict: newer, text: "My words" });
    expect(waitingDraftSave(conflicted)).toBeNull();
    expect(followWaitingDraft(conflicted, newer)).toBe(conflicted);
    // Still typing keeps it bound to the version it was written against.
    expect(setWaitingDraftText(conflicted, "My words, more")).toMatchObject({
      baseRevision: 0,
      conflict: newer,
    });

    expect(reloadWaitingDraft(conflicted)).toMatchObject({
      baseRevision: 1,
      conflict: null,
      dirty: false,
      text: "New words on iPad",
    });
  });

  it("saves trimmed words and the parts kept against the base version; nothing left saves nothing", () => {
    const draft = openWaitingDraft({ content: words("Check it", photo), revision: 3 });
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
