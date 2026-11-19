import type { ContentPart } from "@opensteer/core";
import { messageDraftParts } from "./pending-send.js";

/** A waiting message as the Host last reported it: its version and what that version holds. */
export interface WaitingDraftSource {
  readonly revision: number;
  readonly content: readonly ContentPart[];
  /**
   * The full body at `revision`, read under the edit lease. Anything else (the queue's clipped
   * preview) only shows: a draft opened from it is locked until the full body is read.
   */
  readonly full?: boolean;
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
  /**
   * Shown from the queue's clipped preview while the full body at `baseRevision` is read. Nothing
   * edits or saves it: that full body replaces it whole (`hydrateWaitingDraft`). Every move to a
   * new revision locks the field this way again, so a draft that can be saved was always built
   * from the full body at the revision it names.
   */
  readonly loading: boolean;
}

/** A draft of `source` exactly as it stands; `loading` unless `source` is the full body. */
export function openWaitingDraft(source: WaitingDraftSource): WaitingDraft {
  const loading = source.full !== true;
  const text = messageDraftParts(source.content).body;
  const parts = source.content.filter((part) => part.type !== "text");
  return {
    base: { parts: parts.length, text },
    baseRevision: source.revision,
    conflict: null,
    dirty: false,
    loading,
    parts,
    text,
  };
}

/** The person typed. */
export function setWaitingDraftText(draft: WaitingDraft, text: string): WaitingDraft {
  return draft.loading ? draft : measured({ ...draft, text });
}

/** The person took a file, page or place off the message. */
export function removeWaitingDraftPart(draft: WaitingDraft, index: number): WaitingDraft {
  if (draft.loading) return draft;
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
  // Untouched words move to the new version, locked until its full body is read.
  if (!draft.dirty) return openWaitingDraft(current);
  return draft.conflict?.revision === current.revision ? draft : { ...draft, conflict: current };
}

/**
 * Installs a full body read under the lease. A locked draft is replaced whole by the body at its
 * revision or a newer one: no words are ever kept from a preview, and an older body leaves it
 * locked. An open draft (a lease taken again) follows it as `followWaitingDraft` does.
 */
export function hydrateWaitingDraft(
  draft: WaitingDraft,
  current: WaitingDraftSource & { readonly full: true },
): WaitingDraft {
  if (draft.loading)
    return current.revision >= draft.baseRevision ? openWaitingDraft(current) : draft;
  return followWaitingDraft(draft, current);
}

/** The revision whose full body a locked draft waits for; null when it can be edited. */
export function waitingDraftAwaits(draft: WaitingDraft): number | null {
  return draft.loading ? draft.baseRevision : null;
}

/**
 * Lets the person's words go for the newer version that arrived under them; locked until that
 * version's full body is read, unless the conflict carried it.
 */
export function reloadWaitingDraft(draft: WaitingDraft): WaitingDraft {
  return draft.conflict ? openWaitingDraft(draft.conflict) : draft;
}

/** What the draft sends: its trimmed words, then the parts it kept. Empty when nothing is left. */
function waitingDraftContent(draft: WaitingDraft): ContentPart[] {
  const text = draft.text.trim();
  return [...(text ? [{ text, type: "text" as const }] : []), ...draft.parts];
}

/**
 * The one way a waiting message's words leave its editor, for every action that does so: Save,
 * saving before an approval, Send as new, a move to the composer. Only a draft built from the full
 * body at its revision gives anything; a locked one (still the queue's clipped preview) gives null,
 * as does a draft with nothing left in it.
 */
export function waitingDraftOutgoing(draft: WaitingDraft): {
  readonly content: readonly ContentPart[];
  readonly text: string;
  readonly parts: readonly ContentPart[];
  readonly revision: number;
} | null {
  if (draft.loading) return null;
  const content = waitingDraftContent(draft);
  if (content.length === 0) return null;
  return { content, parts: draft.parts, revision: draft.baseRevision, text: draft.text.trim() };
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
  const outgoing = waitingDraftOutgoing(draft);
  if (outgoing === null) return null;
  if (!draft.dirty) return { kind: "unchanged", revision: outgoing.revision };
  return { content: outgoing.content, expectedRevision: outgoing.revision, kind: "edit" };
}

function measured(draft: WaitingDraft): WaitingDraft {
  return {
    ...draft,
    dirty: draft.text.trim() !== draft.base.text.trim() || draft.parts.length !== draft.base.parts,
  };
}
