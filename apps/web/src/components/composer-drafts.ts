import {
  assertDraftReplyLogin,
  changedTaskDraft,
  messageStorageFingerprint,
} from "@opensteer/client/host";
import {
  browserDraftHandoffKey,
  mutateBrowserMessageRecord,
  storageUnavailable,
} from "../host/message-outbox-records.js";
import { SavedTaskStartSchema, retireTaskStarts } from "./home/task-start.js";
import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  ContentPartSchema,
  PlaceContentPartSchema,
  type ArtifactContentPart,
  type ContentPart,
  type PlaceContentPart,
} from "@opensteer/core";

/**
 * What a person has written and not sent, kept on this device so leaving a
 * composer never costs it. Each draft is its own storage entry, read straight
 * from storage, so windows share drafts without overwriting each other's.
 *
 * A composer owns its live draft and writes it through here on every change;
 * while it is open, its row in the sidebar holds still (see `open`).
 * Deferred input reserves the draft's edit ID, even while empty. Closing an
 * editor leaves that ID current. Discard and send cleanup retire it in the
 * same commit order as edits. A completion can only merge into its own ID.
 */

const prefix = "opensteer:composer-draft:v2:";
const legacyPrefix = "opensteer:composer-draft:v1:";

const QuoteSchema = z.object({
  attribution: z.string(),
  excerpt: z.string(),
  messageId: z.string(),
});

const FileSchema = z.object({
  mediaType: z.string(),
  name: z.string(),
  /** Null until the Host holds every byte; such a file has to be added again after a reload. */
  part: ContentPartSchema.refine(
    (part: ContentPart): part is ArtifactContentPart => part.type === "artifact",
  ).nullable(),
  sizeBytes: z.number(),
});

/**
 * What surrounds the words may stop parsing as those shapes change, and costs
 * only itself: a person's words are never lost to a release reading them.
 */
const DraftSchema = z.object({
  files: z.array(FileSchema).catch([]),
  editId: z.string().optional(),
  editReserved: z.literal(true).optional(),
  importedRevision: z.string().optional(),
  revision: z.string().optional(),
  replyScope: z.string().optional(),
  /** Absent while an untouched draft still follows the place in front. */
  places: z.array(PlaceContentPartSchema).optional().catch(undefined),
  quote: QuoteSchema.nullable().catch(null),
  /** Why a send was refused after its composer closed, until the draft is opened. */
  refusal: z.string().optional(),
  recoveredSendKeys: z.array(z.string().max(255)).max(40).optional(),
  startGeneration: z.string().optional(),
  startPending: z.boolean().optional(),
  startScope: z.string().optional(),
  start: SavedTaskStartSchema.optional().catch(undefined),
  text: z.string(),
  updatedAt: z.number(),
});

export type DraftFile = z.infer<typeof FileSchema>;
export type ComposerDraft = Omit<z.infer<typeof DraftSchema>, "files" | "places"> & {
  readonly files: readonly DraftFile[];
  readonly places?: readonly PlaceContentPart[] | undefined;
};

/** Home's own unsent draft: the one new task it keeps until sent. */
export const homeDraftId = "home";

export type ComposerDraftTarget =
  | { readonly kind: "task"; readonly draftId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export interface ComposerDraftScope {
  readonly deploymentId: string;
  readonly userId: string;
}

/** Something a closed composer still owed its draft, such as a send refused after it left. */
export interface ReturnedToDraft {
  readonly files?: readonly DraftFile[];
  readonly edit: (text: string) => string;
  readonly places?: readonly PlaceContentPart[];
  readonly quote?: z.infer<typeof QuoteSchema> | null;
  /** Why it came back, shown when the draft is read. */
  readonly reason?: string;
}

export interface TaskDraftRow {
  readonly draftId: string;
  readonly refused: boolean;
  readonly title: string;
}

/** What the sidebar shows of the drafts in one Deployment, for one person. */
export interface ComposerDraftIndex {
  readonly replies: ReadonlySet<string>;
  readonly tasks: readonly TaskDraftRow[];
  readonly legacy: readonly LegacyDraftRow[];
}

export interface LegacyDraftRow {
  readonly target: ComposerDraftTarget;
  readonly key: string;
  readonly revision: string;
  readonly title: string;
}

const emptyIndex: ComposerDraftIndex = { replies: new Set(), tasks: [], legacy: [] };

function scopePrefix({ deploymentId, userId }: ComposerDraftScope): string {
  return `${prefix}${encodeURIComponent(deploymentId)}:${encodeURIComponent(userId)}:`;
}

export function composerDraftKey(scope: ComposerDraftScope, target: ComposerDraftTarget): string {
  const name =
    target.kind === "task"
      ? `task:${encodeURIComponent(target.draftId)}`
      : `thread:${encodeURIComponent(target.threadId)}`;
  return `${scopePrefix(scope)}${name}`;
}

/** The key for a signed-in composer, or null before the Host has confirmed who that is. */
export function composerDraftKeyFor(
  deploymentId: string | null | undefined,
  userId: string | null | undefined,
  target: ComposerDraftTarget,
): string | null {
  return deploymentId && userId ? composerDraftKey({ deploymentId, userId }, target) : null;
}

function blank(): ComposerDraft {
  return { files: [], quote: null, text: "", updatedAt: 0 };
}

/** Whether a draft holds anything the person put there: words, a file, a quote or a place. */
export function holdsContent(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length > 0 ||
    draft.quote !== null ||
    draft.files.length > 0 ||
    (draft.places ?? []).some((place) => !isAutomatic(place))
  );
}

export function composerPlaceKey(part: PlaceContentPart): string {
  switch (part.type) {
    case "browser-page":
      return part.tabId;
    case "phone":
      return `phone:${part.machineId}:${part.display}`;
    case "computer-app":
      return `app:${part.machineId}:${part.app.bundleId.toLowerCase()}`;
  }
}

/** Updates a place in its existing position or adds a new one at the end. */
export function addComposerPlace(places: readonly PlaceContentPart[], part: PlaceContentPart) {
  const key = composerPlaceKey(part);
  return places.some((item) => composerPlaceKey(item) === key)
    ? places.map((item) => (composerPlaceKey(item) === key ? part : item))
    : [...places, part];
}

function holdsTaskStart(draft: ComposerDraft): boolean {
  // An older draft can have a journal without an explicit pending flag.
  return Boolean(draft.start || (draft.startGeneration && draft.startPending !== false));
}

/** Whether two drafts say the same thing; being looked at is not an edit. */
function sameDraft(first: ComposerDraft, second: ComposerDraft): boolean {
  const content = ({ updatedAt: _updatedAt, revision: _revision, ...draft }: ComposerDraft) =>
    JSON.stringify(Object.entries(draft).sort(([a], [b]) => a.localeCompare(b)));
  return content(first) === content(second);
}

function isAutomatic(place: PlaceContentPart): boolean {
  return place.type === "browser-page" && place.auto === true;
}

function rowTitle(draft: ComposerDraft): string {
  const line = draft.text.trim().split("\n", 1)[0]?.trim();
  if (line) return line;
  if (draft.files.length > 0)
    return draft.files.length === 1 ? draft.files[0]!.name : `${draft.files.length} files`;
  if (draft.quote) return `Reply to ${draft.quote.attribution}`;
  return "Draft";
}

export type DraftStorage = Pick<Storage, "getItem" | "key" | "removeItem" | "setItem"> & {
  readonly length: number;
};

export function createComposerDraftStore(
  resolveStorage: () => DraftStorage | null,
  now: () => number = Date.now,
  onRetire?: (key: string) => void,
) {
  /** Drafts storage refused: they last until this window closes. */
  const unsaved = new Map<string, string>();
  /** Composers open right now; their rows hold still until they close. */
  const opened = new Map<string, number>();
  const receivers = new Map<string, (returned: ReturnedToDraft) => void>();
  const listeners = new Set<() => void>();
  const indexes = new Map<string, ComposerDraftIndex>();

  const storage = (): DraftStorage | null => {
    try {
      return resolveStorage();
    } catch {
      return null;
    }
  };

  const publish = (): void => {
    indexes.clear();
    for (const listener of listeners) listener();
  };

  const parse = (raw: string | null): ComposerDraft | null => {
    if (raw === null) return null;
    try {
      const result = DraftSchema.safeParse(JSON.parse(raw));
      if (!result.success) return null;
      const revision = result.data.revision ?? messageStorageFingerprint(raw);
      return { ...result.data, editId: result.data.editId ?? revision, revision };
    } catch {
      return null;
    }
  };

  const read = (key: string): ComposerDraft | null => {
    const held = unsaved.get(key);
    if (held !== undefined) return parse(held);
    try {
      return parse(storage()?.getItem(key) ?? null);
    } catch {
      return null;
    }
  };

  const legacyDraft = (key: string) => {
    if (!key.startsWith(prefix)) return null;
    const older = read(`${legacyPrefix}${key.slice(prefix.length)}`);
    if (!older || (!holdsContent(older) && !holdsTaskStart(older))) return null;
    const revision = messageStorageFingerprint(
      JSON.stringify([
        older.text,
        older.files,
        older.quote,
        older.places,
        older.start,
        older.startGeneration,
      ]),
    );
    return read(key)?.importedRevision === revision ? null : { draft: older, revision };
  };

  const keys = (start: string): readonly string[] => {
    const found = new Set([...unsaved.keys()].filter((key) => key.startsWith(start)));
    const store = storage();
    try {
      for (let index = 0; store && index < store.length; index += 1) {
        const key = store.key(index);
        if (key?.startsWith(start)) found.add(key);
      }
    } catch {
      // Storage that cannot be listed leaves only what this window holds.
    }
    return [...found];
  };

  const remove = (key: string): boolean => {
    try {
      const store = storage();
      if (!store) return false;
      store.removeItem(key);
      unsaved.delete(key);
      return true;
    } catch {
      return false;
    }
  };

  /** False when storage refused it: the draft then lasts only as long as this window. */
  const write = (
    key: string,
    draft: ComposerDraft,
    keepUnsaved = true,
    preserveRevision = false,
  ): boolean => {
    const previous = read(key);
    const payload = (value: ComposerDraft) =>
      JSON.stringify([
        value.text,
        value.quote?.messageId,
        value.places ?? [],
        value.files,
        value.recoveredSendKeys ?? [],
      ]);
    const revision = preserveRevision
      ? draft.revision
      : previous && previous.editId === draft.editId && payload(previous) === payload(draft)
        ? previous.revision
        : undefined;
    const revised = {
      ...draft,
      importedRevision: draft.importedRevision ?? previous?.importedRevision,
      editId: draft.editId ?? globalThis.crypto.randomUUID(),
      revision: revision ?? globalThis.crypto.randomUUID(),
      replyScope: revision ? draft.replyScope : undefined,
    };
    const value = JSON.stringify(
      key.includes(":task:") && !draft.startGeneration && holdsContent(draft)
        ? { ...revised, startGeneration: globalThis.crypto.randomUUID(), startPending: false }
        : revised,
    );
    try {
      const store = storage();
      if (!store) throw new Error("No storage.");
      store.setItem(key, value);
      unsaved.delete(key);
      return true;
    } catch {
      if (keepUnsaved) unsaved.set(key, value);
      return false;
    }
  };

  const clear = (key: string, retire = true): boolean => {
    const held = read(key);
    const saved =
      held?.recoveredSendKeys?.length || held?.importedRevision
        ? write(
            key,
            {
              ...blank(),
              updatedAt: now(),
              recoveredSendKeys: held.recoveredSendKeys,
              importedRevision: held.importedRevision,
            },
            false,
          )
        : remove(key);
    if (saved) {
      publish();
      if (retire && key.includes(":task:")) onRetire?.(key);
    }
    return saved;
  };

  const buildIndex = (scope: ComposerDraftScope): ComposerDraftIndex => {
    const start = scopePrefix(scope);
    const tasks: (TaskDraftRow & { readonly updatedAt: number })[] = [];
    const replies = new Set<string>();
    for (const key of keys(start)) {
      const draft = read(key);
      const name = key.slice(start.length);
      if (!draft || (!holdsContent(draft) && !(name.startsWith("task:") && holdsTaskStart(draft))))
        continue;
      const open = opened.has(key);
      if (name.startsWith("thread:")) {
        if (!open) replies.add(decodeURIComponent(name.slice("thread:".length)));
      } else if (name.startsWith("task:")) {
        tasks.push({
          draftId: decodeURIComponent(name.slice("task:".length)),
          refused: draft.refusal !== undefined,
          title: rowTitle(draft),
          updatedAt: draft.updatedAt,
        });
      }
    }
    tasks.sort((first, second) => second.updatedAt - first.updatedAt);
    const legacy: LegacyDraftRow[] = [];
    const legacyStart = `${legacyPrefix}${start.slice(prefix.length)}`;
    for (const source of keys(legacyStart)) {
      const key = `${prefix}${source.slice(legacyPrefix.length)}`;
      const available = legacyDraft(key);
      if (!available) continue;
      const name = source.slice(legacyStart.length);
      const encoded = name.slice(name.indexOf(":") + 1);
      let target: ComposerDraftTarget;
      try {
        if (name.startsWith("task:"))
          target = { kind: "task", draftId: decodeURIComponent(encoded) };
        else if (name.startsWith("thread:"))
          target = { kind: "thread", threadId: decodeURIComponent(encoded) };
        else continue;
      } catch {
        continue;
      }
      legacy.push({ key, target, revision: available.revision, title: rowTitle(available.draft) });
    }
    return tasks.length === 0 && replies.size === 0 && legacy.length === 0
      ? emptyIndex
      : { replies, tasks, legacy };
  };

  const matches = (held: ComposerDraft, expected: ComposerDraft): boolean => {
    if (expected.revision && expected.revision !== held.revision) return false;
    if (expected.startGeneration && expected.startGeneration !== held.startGeneration) return false;
    const revision = ({
      startGeneration: _generation,
      startPending: _pending,
      startScope: _scope,
      editReserved: _reserved,
      ...draft
    }: ComposerDraft) => draft;
    return sameDraft(revision(held), revision(expected));
  };

  const durableDraft = (key: string): ComposerDraft | null => {
    const store = storage();
    if (!store) throw storageUnavailable();
    return parse(store.getItem(key));
  };

  return {
    clear,
    durableDraft,
    reserveEdit(key: string, expectedEditId?: string): string | null {
      const held = read(key);
      if (expectedEditId !== undefined && held?.editId !== expectedEditId) return null;
      if (held?.editReserved) return held.editId!;
      const editId = held?.editId ?? globalThis.crypto.randomUUID();
      return write(key, { ...(held ?? blank()), editId, editReserved: true }, true, true)
        ? editId
        : null;
    },
    bindReply(key: string, scope: string, revision: string): void {
      const draft = durableDraft(key);
      if (draft?.revision !== revision) throw changedTaskDraft();
      assertDraftReplyLogin(draft.replyScope, scope);
      if (
        draft.replyScope === undefined &&
        !write(key, { ...draft, replyScope: scope }, false, true)
      )
        throw storageUnavailable();
    },
    durableTaskStartGeneration(key: string): string | undefined {
      const store = storage();
      if (!store) throw new Error("No draft storage.");
      return parse(store.getItem(key))?.startGeneration;
    },
    /** Forgets every draft on this device; signing out leaves nothing behind. */
    clearAll(): void {
      for (const key of keys(prefix)) remove(key);
      publish();
    },

    index(scope: ComposerDraftScope): ComposerDraftIndex {
      const start = scopePrefix(scope);
      const cached = indexes.get(start);
      if (cached) return cached;
      const built = buildIndex(scope);
      indexes.set(start, built);
      return built;
    },

    /**
     * A composer has this draft on screen. While it stays open its edits do not
     * reach the sidebar, so typing never redraws it; the row catches up on leaving.
     */
    open(key: string, receive?: (returned: ReturnedToDraft) => void): () => void {
      opened.set(key, (opened.get(key) ?? 0) + 1);
      if (receive) receivers.set(key, receive);
      publish();
      return () => {
        const count = (opened.get(key) ?? 1) - 1;
        if (count > 0) opened.set(key, count);
        else opened.delete(key);
        if (receive && receivers.get(key) === receive) receivers.delete(key);
        publish();
      };
    },

    taskStartGeneration(key: string, scope?: string, expectedRevision?: string): string | null {
      const source = read(key);
      if (expectedRevision !== undefined && source?.revision !== expectedRevision) return null;
      const current = source ?? blank();
      if (current.startScope !== undefined && current.startScope !== scope) return null;
      if (
        current.startGeneration &&
        current.startPending &&
        current.startScope === scope &&
        !unsaved.has(key)
      )
        return current.startGeneration;
      const startGeneration =
        current.startGeneration ??
        (current.updatedAt ? `legacy:${current.updatedAt}` : globalThis.crypto.randomUUID());
      if (
        !write(
          key,
          { ...current, startGeneration, startPending: true, startScope: scope },
          false,
          true,
        )
      )
        return null;
      publish();
      return startGeneration;
    },

    finishTaskStart(
      key: string,
      generation: string,
      submitted?: ComposerDraft,
      preserveDraft = false,
    ): "cleared" | "kept" | "unavailable" {
      const draft = read(key);
      if (draft?.startGeneration !== generation) return "kept";
      const sameRevision = submitted && matches(draft, submitted);
      if (preserveDraft && !sameRevision) return "kept";
      if (!holdsContent(draft) || (!preserveDraft && sameRevision))
        return clear(key) ? "cleared" : "unavailable";
      if (
        !write(
          key,
          {
            ...draft,
            start: undefined,
            editId: undefined,
            editReserved: undefined,
            startGeneration: undefined,
            startPending: undefined,
            startScope: undefined,
          },
          false,
        )
      )
        return "unavailable";
      publish();
      onRetire?.(key);
      return "kept";
    },

    read,

    importLegacy(key: string, revision: string): "copied" | "occupied" | "changed" | "unavailable" {
      const legacy = legacyDraft(key);
      if (!legacy || legacy.revision !== revision) return "changed";
      const held = read(key);
      if (held && (holdsContent(held) || holdsTaskStart(held) || held.editReserved))
        return "occupied";
      const saved = write(
        key,
        {
          ...legacy.draft,
          editId: held?.editId,
          editReserved: undefined,
          importedRevision: revision,
        },
        false,
        true,
      );
      if (saved) {
        const { draft } = legacy;
        receivers.get(key)?.({
          edit: () => draft.text,
          files: draft.files,
          ...(draft.places ? { places: draft.places } : {}),
          quote: draft.quote,
        });
        publish();
      }
      return saved ? "copied" : "unavailable";
    },

    /**
     * Lays a draft down. An open composer is handed `returned` to merge into what
     * it holds, or else the whole draft, exactly as it was.
     */
    restore(key: string, draft: ComposerDraft, returned?: ReturnedToDraft): boolean {
      const saved = write(key, draft, false, returned === undefined);
      if (saved)
        receivers.get(key)?.(
          returned ?? {
            edit: () => draft.text,
            files: draft.files,
            ...(draft.places ? { places: draft.places } : {}),
            quote: draft.quote,
          },
        );
      publish();
      return saved;
    },

    /**
     * Commit the returned input before refreshing any editor showing it.
     */
    handBack(key: string, returned: ReturnedToDraft, expectedEditId?: string): boolean {
      const held = read(key);
      if (expectedEditId !== undefined && held?.editId !== expectedEditId) return false;
      const draft = held ?? blank();
      const places = returned.places?.reduce(addComposerPlace, draft.places ?? []);
      const saved = write(key, {
        ...draft,
        ...(returned.files?.length ? { files: [...returned.files, ...draft.files] } : {}),
        ...(places ? { places } : {}),
        quote: returned.quote ?? draft.quote,
        ...(returned.reason === undefined ? {} : { refusal: returned.reason }),
        text: returned.edit(draft.text),
        updatedAt: now(),
      });
      if (saved) receivers.get(key)?.(returned);
      publish();
      return saved;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Another window changed a draft: its rows are stale, and nothing else is cached. */
    invalidate: publish,

    /**
     * Merges a change into a draft, removing it once nothing is left to keep.
     * An open draft is being read, so a refusal waiting on it is answered.
     * False when storage refused it.
     */
    update(
      key: string,
      change: Partial<Omit<ComposerDraft, "refusal" | "updatedAt">>,
      expectedEditId?: string,
    ): boolean {
      const current = read(key);
      if (expectedEditId !== undefined && current?.editId !== expectedEditId) return false;
      const open = opened.has(key);
      const { refusal, ...kept } = current ?? blank();
      const draft = DraftSchema.parse({
        ...kept,
        ...(refusal !== undefined && !open ? { refusal } : {}),
        ...change,
      });
      if (!holdsContent(draft)) {
        if (current === null) return true;
        const preserveStart = key.includes(":task:") && holdsTaskStart(draft);
        let saved = true;
        if (
          preserveStart ||
          draft.editReserved ||
          draft.recoveredSendKeys?.length ||
          draft.importedRevision
        ) {
          saved = write(key, {
            ...draft,
            ...(preserveStart
              ? {}
              : {
                  startGeneration: undefined,
                  start: undefined,
                  startPending: undefined,
                  startScope: undefined,
                }),
            text: "",
            files: [],
            places: [],
            quote: null,
            updatedAt: now(),
          });
        } else {
          saved = remove(key);
          if (!saved) unsaved.set(key, JSON.stringify(draft));
        }
        if (!open || refusal !== undefined || (key.includes(":thread:") && holdsContent(current)))
          publish();
        if (saved && !preserveStart && key.includes(":task:")) onRetire?.(key);
        return saved;
      }
      if (current !== null && sameDraft(draft, current) && !unsaved.has(key)) return true;
      const saved = write(key, { ...draft, updatedAt: now() });
      if (
        !open ||
        refusal !== undefined ||
        (key.includes(":thread:") && (!current || !holdsContent(current)))
      )
        publish();
      return saved;
    },
  };
}

function browserStorage(): DraftStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Draft writers hold the same IndexedDB write transaction as the outbox's revision check. */
export function transactionalComposerDrafts(
  drafts: ReturnType<typeof createComposerDraftStore>,
  mutate: (
    key: string,
    edit: (raw: string | null) => string | null,
  ) => Promise<unknown> = mutateBrowserMessageRecord,
) {
  const transaction = async <T>(edit: (store: typeof drafts) => T): Promise<T> => {
    let result!: T;
    await mutate("composer-draft-transaction", (raw) => {
      result = edit(drafts);
      return raw;
    });
    return result;
  };
  const handoff = async <T>(
    key: string,
    edit: (receipt: string | null) => [T, boolean],
  ): Promise<T> => {
    let result!: T;
    await mutate(browserDraftHandoffKey(key), (receipt) => {
      const [value, cleared] = edit(receipt);
      result = value;
      return cleared ? null : receipt;
    });
    return result;
  };
  const write = (edit: (store: typeof drafts) => boolean) => transaction(edit).catch(() => false);
  return {
    ...drafts,
    transaction,
    reserveEdit: (...args: Parameters<typeof drafts.reserveEdit>) =>
      transaction((store) => store.reserveEdit(...args)),
    importLegacy: (...args: Parameters<typeof drafts.importLegacy>) =>
      transaction((store) => store.importLegacy(...args)),
    update: (...args: Parameters<typeof drafts.update>) => write((store) => store.update(...args)),
    clear: (...args: Parameters<typeof drafts.clear>) => write((store) => store.clear(...args)),
    discard: (key: string, revision: string | undefined, retire = true) =>
      handoff<"discarded" | "queued" | "changed" | "unavailable">(key, (receipt) => {
        const draft = drafts.read(key);
        if (draft?.revision !== revision) return ["changed", false];
        if (draft?.revision === receipt) return ["queued", false];
        const cleared = drafts.clear(key, retire);
        return [cleared ? "discarded" : "unavailable", cleared];
      }).catch(() => "unavailable" as const),
    consumeReply: (key: string, revision: string, assertCurrent: () => void) =>
      handoff(key, () => {
        assertCurrent();
        const cleared = drafts.durableDraft(key)?.revision === revision && drafts.clear(key);
        return [cleared, cleared];
      }).catch(() => false),
    clearAll: () => transaction((store) => store.clearAll()),
    restore: (...args: Parameters<typeof drafts.restore>) =>
      write((store) => store.restore(...args)),
    handBack: (key: string, returned: ReturnedToDraft, expectedEditId?: string) =>
      handoff(key, (receipt) => [
        drafts.read(key)?.revision !== receipt && drafts.handBack(key, returned, expectedEditId),
        false,
      ]),
    taskStartGeneration: (...args: Parameters<typeof drafts.taskStartGeneration>) =>
      transaction((store) => store.taskStartGeneration(...args)),
    finishTaskStart: (...args: Parameters<typeof drafts.finishTaskStart>) =>
      handoff(args[0], (receipt) => {
        const outcome = drafts.finishTaskStart(...args);
        return [outcome, drafts.read(args[0])?.revision !== receipt];
      }),
  };
}

export const composerDrafts = transactionalComposerDrafts(
  createComposerDraftStore(
    browserStorage,
    Date.now,
    (key) => void cleanTaskStartJournals(key).catch(() => {}),
  ),
);

export async function reserveComposerTaskStart(
  drafts: typeof composerDrafts,
  key: string,
  scope: string,
  revision: string,
  assertLogin: () => void,
) {
  const generation = await drafts.transaction((store) => {
    assertLogin();
    return store.taskStartGeneration(key, scope, revision);
  });
  if (!generation) throw changedTaskDraft("draft-superseded");
  const assertCurrent = () => {
    assertLogin();
    const draft = drafts.durableDraft(key);
    if (draft?.startGeneration !== generation || draft.revision !== revision)
      throw changedTaskDraft("draft-superseded");
  };
  const beginCreation = async <T>(start: () => Promise<T>): Promise<T> => {
    const launched = await drafts.transaction(() => {
      assertCurrent();
      const pending = start();
      void pending.catch(() => {});
      return { pending };
    });
    return launched.pending;
  };
  return { generation, assertCurrent, beginCreation };
}

export function cleanTaskStartJournals(onlyDraft?: string, discardedGeneration?: string) {
  return retireTaskStarts(
    composerDrafts.durableTaskStartGeneration,
    onlyDraft,
    discardedGeneration,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(prefix) || event.key.startsWith(legacyPrefix))
      composerDrafts.invalidate();
  });
}

/** The drafts the sidebar shows, redrawn only when a row changes. */
export function useComposerDraftIndex(
  deploymentId: string | null | undefined,
  userId: string | null | undefined,
): ComposerDraftIndex {
  const snapshot = useCallback(
    () => (deploymentId && userId ? composerDrafts.index({ deploymentId, userId }) : emptyIndex),
    [deploymentId, userId],
  );
  return useSyncExternalStore(composerDrafts.subscribe, snapshot, snapshot);
}
