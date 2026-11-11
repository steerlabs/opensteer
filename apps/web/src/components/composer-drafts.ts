import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  ContentPartSchema,
  PlaceContentPartSchema,
  TaskFolderSchema,
  type TaskFolder,
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
 */

const prefix = "opensteer:composer-draft:v1:";

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
  /** Absent while an untouched draft still follows the place in front. */
  places: z.array(PlaceContentPartSchema).optional().catch(undefined),
  quote: QuoteSchema.nullable().catch(null),
  /** Why a send was refused after its composer closed, until the draft is opened. */
  refusal: z.string().optional(),
  text: z.string(),
  updatedAt: z.number(),
  /** The folder a new task would start in. It can change; the draft stays the same draft. */
  folder: TaskFolderSchema.optional().catch(undefined),
});

export type DraftFile = z.infer<typeof FileSchema>;
export type ComposerDraft = Omit<z.infer<typeof DraftSchema>, "files" | "places"> & {
  readonly files: readonly DraftFile[];
  readonly places?: readonly PlaceContentPart[] | undefined;
};

export type ComposerDraftTarget =
  | { readonly kind: "task"; readonly draftId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export interface ComposerDraftScope {
  readonly deploymentId: string;
  readonly userId: string;
}

/** Something a closed composer still owed its draft, such as a send refused after it left. */
export interface ReturnedToDraft {
  readonly edit: (text: string) => string;
  readonly places?: readonly PlaceContentPart[];
  readonly quote?: z.infer<typeof QuoteSchema> | null;
  /** Why it came back, shown when the draft is read. */
  readonly reason?: string;
  /** Where its task was to start: sending may have emptied the draft that knew. */
  readonly folder?: TaskFolder | undefined;
}

export interface TaskDraftRow {
  readonly draftId: string;
  readonly refused: boolean;
  readonly title: string;
  readonly folder: TaskFolder | null;
}

/** What the sidebar shows of the drafts in one Deployment, for one person. */
export interface ComposerDraftIndex {
  readonly replies: ReadonlySet<string>;
  readonly tasks: readonly TaskDraftRow[];
}

const emptyIndex: ComposerDraftIndex = { replies: new Set(), tasks: [] };

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

function holdsContent(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length > 0 ||
    draft.quote !== null ||
    draft.files.length > 0 ||
    (draft.places ?? []).some((place) => !isAutomatic(place))
  );
}

/** Whether two drafts say the same thing; being looked at is not an edit. */
function sameDraft(first: ComposerDraft, second: ComposerDraft): boolean {
  const content = ({ updatedAt: _updatedAt, ...draft }: ComposerDraft) =>
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
      return result.success ? result.data : null;
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

  const remove = (key: string): void => {
    unsaved.delete(key);
    try {
      storage()?.removeItem(key);
    } catch {
      // Nothing was saved, or it cannot be reached; an empty draft reads the same.
    }
  };

  /** False when storage refused it: the draft then lasts only as long as this window. */
  const write = (key: string, draft: ComposerDraft): boolean => {
    const value = JSON.stringify(draft);
    try {
      const store = storage();
      if (!store) throw new Error("No storage.");
      store.setItem(key, value);
      unsaved.delete(key);
      return true;
    } catch {
      unsaved.set(key, value);
      return false;
    }
  };

  const clear = (key: string): void => {
    if (read(key) === null) return;
    remove(key);
    publish();
  };

  const buildIndex = (scope: ComposerDraftScope): ComposerDraftIndex => {
    const start = scopePrefix(scope);
    const tasks: (TaskDraftRow & { readonly updatedAt: number })[] = [];
    const replies = new Set<string>();
    for (const key of keys(start)) {
      const draft = read(key);
      if (!draft || !holdsContent(draft)) continue;
      const name = key.slice(start.length);
      const open = opened.has(key);
      if (name.startsWith("thread:")) {
        if (!open) replies.add(decodeURIComponent(name.slice("thread:".length)));
      } else if (name.startsWith("task:")) {
        tasks.push({
          draftId: decodeURIComponent(name.slice("task:".length)),
          refused: draft.refusal !== undefined,
          title: rowTitle(draft),
          updatedAt: draft.updatedAt,
          folder: draft.folder ?? null,
        });
      }
    }
    tasks.sort((first, second) => second.updatedAt - first.updatedAt);
    return tasks.length === 0 && replies.size === 0 ? emptyIndex : { replies, tasks };
  };

  return {
    clear,

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

    read,

    /** Lays a discarded draft back down, exactly as it was. */
    restore(key: string, draft: ComposerDraft): void {
      write(key, draft);
      publish();
    },

    /**
     * What a closed composer still owed this draft reaches whichever composer
     * has it open now, which would otherwise write over it, or else storage,
     * where the reason waits for the draft to be opened.
     */
    handBack(key: string, returned: ReturnedToDraft): void {
      const receive = receivers.get(key);
      if (receive) {
        receive(returned);
        return;
      }
      const draft = read(key) ?? blank();
      write(key, {
        ...draft,
        ...(returned.places?.length
          ? { places: [...returned.places, ...(draft.places ?? [])] }
          : {}),
        quote: returned.quote ?? draft.quote,
        ...(returned.reason === undefined ? {} : { refusal: returned.reason }),
        text: returned.edit(draft.text),
        updatedAt: now(),
        ...(returned.folder ? { folder: returned.folder } : {}),
      });
      publish();
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
    update(key: string, change: Partial<Omit<ComposerDraft, "refusal" | "updatedAt">>): boolean {
      const current = read(key);
      const open = opened.has(key);
      const { refusal, ...kept } = current ?? blank();
      const draft: ComposerDraft = {
        ...kept,
        ...(refusal !== undefined && !open ? { refusal } : {}),
        ...change,
      };
      if (!holdsContent(draft)) {
        if (current === null) return true;
        remove(key);
        if (!open || refusal !== undefined) publish();
        return true;
      }
      if (current !== null && sameDraft(draft, current) && !unsaved.has(key)) return true;
      const saved = write(key, { ...draft, updatedAt: now() });
      if (!open || refusal !== undefined) publish();
      return saved;
    },
  };
}

function browserStorage(): DraftStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export const composerDrafts = createComposerDraftStore(browserStorage);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(prefix)) composerDrafts.invalidate();
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
