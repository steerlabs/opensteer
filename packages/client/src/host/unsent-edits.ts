import { ContentPartSchema, type ContentPart } from "@opensteer/core";
import { z } from "zod";
import type { WaitingDraft } from "./waiting-draft.js";

/**
 * A waiting message's words the person changed and has not yet saved, sent or discarded. One
 * record per message, under one identity (the login's scope, the task, the message), written
 * durably as the person types. Nothing but an explicit action ends it: a Save the Host accepted,
 * a move the composer durably accepted, a send the outbox holds, or Discard. Leaving the view,
 * navigating, a repair, a history reset or a restart leave it exactly as it is.
 */
export interface UnsentEdit {
  readonly threadId: string;
  readonly messageId: string;
  /** The version the words were written against: built from its full body, and what Save names. */
  readonly baseRevision: number;
  /** The base version's words and how many parts it had, which `dirty` measures against. */
  readonly base: { readonly text: string; readonly parts: number };
  readonly text: string;
  readonly parts: readonly ContentPart[];
  readonly updatedAt: number;
}

const UnsentEditSchema = z.object({
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  base: z.object({ text: z.string(), parts: z.number().int().nonnegative() }),
  text: z.string(),
  parts: z.array(ContentPartSchema),
  updatedAt: z.number(),
});
const DocumentSchema = z.object({
  version: z.literal(1),
  edits: z.record(z.string(), z.unknown()),
});

/** Where the records live: the store that already keeps this device's composer drafts. */
export interface UnsentEditStorage {
  read(): Promise<string | null> | string | null;
  write(document: string): Promise<void> | void;
}

function key(scope: string, threadId: string, messageId: string) {
  return JSON.stringify([scope, threadId, messageId]);
}

/** The record a dirty, full-body draft keeps; null for a locked preview or untouched words. */
export function unsentEditOf(
  threadId: string,
  messageId: string,
  draft: WaitingDraft,
  now: number,
): UnsentEdit | null {
  if (draft.loading || !draft.dirty) return null;
  return {
    base: draft.base,
    baseRevision: draft.baseRevision,
    messageId,
    parts: draft.parts,
    text: draft.text,
    threadId,
    updatedAt: now,
  };
}

/** The draft a record restores: the person's words, bound to the version they wrote against. */
export function draftOfUnsentEdit(edit: UnsentEdit): WaitingDraft {
  return {
    base: edit.base,
    baseRevision: edit.baseRevision,
    conflict: null,
    dirty: true,
    loading: false,
    parts: edit.parts,
    text: edit.text,
  };
}

export class UnsentEdits {
  readonly #storage: UnsentEditStorage;
  readonly #listeners = new Set<() => void>();
  #edits = new Map<string, UnsentEdit>();
  #loaded: Promise<void> | undefined;
  /** Writes in the order they were made, each the whole document as it then stood. */
  #writing: Promise<void> = Promise.resolve();
  #version = 0;

  constructor(storage: UnsentEditStorage) {
    this.#storage = storage;
  }

  /** Reads what this device kept, once; every other call waits for it. */
  ready(): Promise<void> {
    this.#loaded ??= Promise.resolve(this.#storage.read()).then(
      (raw) => {
        const parsed = raw === null ? null : DocumentSchema.safeParse(JSON.parse(raw));
        if (!parsed?.success) return;
        for (const [entry, value] of Object.entries(parsed.data.edits)) {
          const edit = UnsentEditSchema.safeParse(value);
          if (edit.success) this.#edits.set(entry, edit.data);
        }
        this.#publish();
      },
      () => undefined,
    );
    return this.#loaded;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Changes on every put or remove, for subscribers reading through `useSyncExternalStore`. */
  version = () => this.#version;

  get(scope: string, threadId: string, messageId: string): UnsentEdit | undefined {
    return this.#edits.get(key(scope, threadId, messageId));
  }

  forThread(scope: string, threadId: string): readonly UnsentEdit[] {
    return [...this.#edits.entries()].flatMap(([entry, edit]) => {
      const [heldScope] = JSON.parse(entry) as [string];
      return heldScope === scope && edit.threadId === threadId ? [edit] : [];
    });
  }

  /** Keeps `edit`, durably: resolves once storage has it, rejects when storage refused it. */
  put(scope: string, edit: UnsentEdit): Promise<void> {
    this.#edits.set(key(scope, edit.threadId, edit.messageId), edit);
    return this.#commit();
  }

  /**
   * Ends a record after the action that replaces it completed. `expected` names the record that
   * action was about: words typed since are a newer record, which stays.
   */
  remove(scope: string, threadId: string, messageId: string, expected?: UnsentEdit): Promise<void> {
    const entry = key(scope, threadId, messageId);
    const held = this.#edits.get(entry);
    if (!held || (expected && held.updatedAt !== expected.updatedAt)) return Promise.resolve();
    this.#edits.delete(entry);
    return this.#commit();
  }

  /** Test seam: forget every record held in memory and read storage again on the next ready. */
  resetForTests() {
    this.#edits.clear();
    this.#loaded = undefined;
    this.#publish();
  }

  #commit() {
    this.#publish();
    const document = JSON.stringify({ version: 1, edits: Object.fromEntries(this.#edits) });
    const write = this.#writing.then(() => this.#storage.write(document));
    this.#writing = write.catch(() => undefined);
    return write;
  }

  #publish() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
}
