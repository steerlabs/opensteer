import type { ContentPart } from "@opensteer/core";
import { messageDraftParts } from "./pending-send.js";

/** A waiting message as the Host last reported it: its version and what that version holds. */
export interface WaitingDraftSource {
  readonly revision: number;
  readonly content: readonly ContentPart[];
}

/**
 * A person's words for one waiting message, bound to the version they were
 * written against. Every save names `baseRevision`, so words written against
 * an older version can never quietly replace a newer one, and an approval
 * names exactly the version on screen.
 *
 * Built and changed only through this module's functions, which keep `dirty`
 * and `conflict` true to the words.
 */
export interface WaitingDraft {
  /** The version these words were written against: what a save or an approval names. */
  readonly baseRevision: number;
  /** The words in the field. */
  readonly text: string;
  /** The files, pages and places it keeps; an edit can drop them but never add one. */
  readonly parts: readonly ContentPart[];
  /** The words or parts differ from the base version's. */
  readonly dirty: boolean;
  /**
   * A newer version that arrived under changed words. The words stay; the
   * person reloads that version (`reloadWaitingDraft`), discards theirs, or
   * sends them as a new message. Nothing saves or approves meanwhile.
   */
  readonly conflict: WaitingDraftSource | null;
  /** The base version's words and how many parts it had, which `dirty` measures against. */
  readonly base: { readonly text: string; readonly parts: number };
}

/** A draft of `source` exactly as it stands. */
export function openWaitingDraft(source: WaitingDraftSource): WaitingDraft {
  const text = messageDraftParts(source.content).body;
  const parts = source.content.filter((part) => part.type !== "text");
  return {
    base: { parts: parts.length, text },
    baseRevision: source.revision,
    conflict: null,
    dirty: false,
    parts,
    text,
  };
}

/** The person typed. */
export function setWaitingDraftText(draft: WaitingDraft, text: string): WaitingDraft {
  return measured({ ...draft, text });
}

/** The person took a file, page or place off the message. */
export function removeWaitingDraftPart(draft: WaitingDraft, index: number): WaitingDraft {
  return measured({ ...draft, parts: draft.parts.filter((_, at) => at !== index) });
}

/**
 * Keeps an open draft true to the message as the Host now reports it. A newer
 * version replaces untouched words, so the person always edits and approves
 * what is there; under changed words it becomes the draft's conflict instead.
 * Returns `draft` itself when nothing moved.
 *
 * While a save of this draft is out, don't follow: the Host reports the
 * version that save wrote before the save itself answers.
 */
export function followWaitingDraft(draft: WaitingDraft, current: WaitingDraftSource): WaitingDraft {
  if (current.revision <= draft.baseRevision) return draft;
  if (!draft.dirty) return openWaitingDraft(current);
  return draft.conflict?.revision === current.revision ? draft : { ...draft, conflict: current };
}

/** Installs the full body once the lease opens, preserving text typed over its preview. */
export function hydrateWaitingDraft(
  draft: WaitingDraft,
  current: WaitingDraftSource,
): WaitingDraft {
  if (current.revision < draft.baseRevision) return draft;
  if (draft.dirty && current.revision > draft.baseRevision) return { ...draft, conflict: current };
  const full = openWaitingDraft(current);
  if (!draft.dirty) return full;
  return measured({
    ...full,
    text: draft.text,
    parts: full.parts.filter(
      (part) =>
        !draft.base.parts ||
        draft.parts.some((kept) => JSON.stringify(part) === JSON.stringify(kept)),
    ),
  });
}

/** Lets the person's words go for the newer version that arrived under them. */
export function reloadWaitingDraft(draft: WaitingDraft): WaitingDraft {
  return draft.conflict ? openWaitingDraft(draft.conflict) : draft;
}

/** What the draft sends: its trimmed words, then the parts it kept. Empty when nothing is left. */
export function waitingDraftContent(draft: WaitingDraft): ContentPart[] {
  const text = draft.text.trim();
  return [...(text ? [{ text, type: "text" as const }] : []), ...draft.parts];
}

/**
 * What Save asks of the Host. `unchanged`: nothing to write, and
 * `revision` is the version that goes on waiting (and the one Answer
 * approves). `edit`: `WaitingMessageEditor.save(content, expectedRevision)`.
 * Null when it can't be saved: a newer version came in under it, or nothing
 * is left in it.
 */
export function waitingDraftSave(draft: WaitingDraft):
  | { readonly kind: "unchanged"; readonly revision: number }
  | {
      readonly kind: "edit";
      readonly content: readonly ContentPart[];
      readonly expectedRevision: number;
    }
  | null {
  if (draft.conflict) return null;
  if (!draft.dirty) return { kind: "unchanged", revision: draft.baseRevision };
  const content = waitingDraftContent(draft);
  return content.length === 0
    ? null
    : { content, expectedRevision: draft.baseRevision, kind: "edit" };
}

function measured(draft: WaitingDraft): WaitingDraft {
  return {
    ...draft,
    dirty: draft.text.trim() !== draft.base.text.trim() || draft.parts.length !== draft.base.parts,
  };
}
