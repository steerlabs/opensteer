import { hostApi } from "@opensteer/protocol";
import type { MessageOutboxOptions } from "@opensteer/client/host";
import {
  assertDraftReplyLogin,
  changedTaskDraft,
  draftReplySendKey,
  messageDraftParts,
  messageStorageFingerprint,
  type StoredMessage,
} from "@opensteer/client/host";
import { clientScopeKey, type ClientScope } from "@opensteer/client/connections";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import {
  CompactionSendChoiceSchema,
  ContentPartSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  type BrowserPageContentPart,
} from "@opensteer/core";
import { homeDraftId } from "../home/home-draft.js";
import type { FirstMessageAttachmentDraftScope } from "../platform/attachment-draft-scope.js";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";

/**
 * A first-message claim atomically consumes one draft revision and holds a
 * frozen creation and message for its sign-in. After restart it replays those
 * keys until the outbox owns the message, or restores after a definite refusal.
 * A reply leaves its revision in the draft until the outbox records the send.
 */

const maxTaskStartRecords = 48;
const maxDraftCharacters = 16_000;
const maxDraftAttachments = 10;
// A hard file cap covers escaped text, keys and metadata, and is the only bound
// on how many drafts a phone keeps. Drafts and messages share it: a write past
// it is refused and the composer says so, rather than dropping an older draft.
const maxDraftFileBytes = 10 * 1_024 * 1_024;

const DraftAttachmentsSchema = z
  .array(
    z
      .strictObject({
        attachmentId: z.string().min(1).max(200).nullable(),
        localUri: z.string().min(1).max(2_048).nullable(),
        mediaType: z.string().min(1).max(255),
        name: z.string().min(1).max(255),
        sizeBytes: z.number().int().nonnegative(),
        status: z.enum(["staged", "uploading", "ready", "error"]),
      })
      .refine((attachment) => attachment.localUri !== null || attachment.attachmentId !== null),
  )
  .max(maxDraftAttachments);
const LegacyDraftSchema = z.strictObject({
  attachments: DraftAttachmentsSchema.optional(),
  text: z.string().max(maxDraftCharacters),
  updatedAt: z.string().min(1).max(40),
});
/**
 * The update a draft answers. Only `messageId` is ever sent: the Host resolves
 * the quote under this reader's own authority, and the excerpt is here so the
 * chip survives a restart without the phone asserting anything about it.
 */
const DraftQuoteSchema = z.strictObject({
  attribution: z.string().min(1).max(200),
  excerpt: z.string().max(400),
  messageId: z.string().min(1).max(200),
});
/**
 * A page a message includes: the message's own content part, under the limits
 * the Host holds it to. On a draft it is the page Ask put there; on a message
 * in flight it is frozen with the message, so a retry includes the same page
 * even after the browser has moved on.
 */
const BrowserPageSchema = ContentPartSchema.refine(
  (part): part is BrowserPageContentPart => part.type === "browser-page",
  "A message keeps only a browser page here.",
);
// Fields a draft gained later are optional under the same schema version: a
// file written before them still parses, and an older release, which refuses
// fields it does not know, loses the file only once a draft uses one.
const DraftSchema = LegacyDraftSchema.extend({
  revision: z.string().optional(),
  replyScope: z.string().min(1).max(2048).optional(),
  recoveredSendKeys: z.array(z.string().max(255)).max(40).optional(),
  page: BrowserPageSchema.optional(),
  quote: DraftQuoteSchema.optional(),
  userId: z.string().min(1).max(200),
});

/**
 * One message in flight. Every field is part of what was sent: replaying it
 * with anything else changed would be a different message under a key the Host
 * has already accounted for.
 */
const PendingArtifactSchema = z.strictObject({
  type: z.literal("artifact"),
  artifactId: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0).optional(),
});
const LegacyTaskStartRecordSchema = z.strictObject({
  attachments: z.array(PendingArtifactSchema).max(20).optional(),
  createdAt: z.string().min(1).max(40),
  idempotencyKey: z.string().min(1).max(200),
  /** App-private copies paired by index with attachments; never sent to Host. */
  localUris: z.array(z.string().min(1).max(2_048).nullable()).max(10).optional(),
  text: z.string().max(maxDraftCharacters),
  threadId: z.string().min(1).max(200),
});
/**
 * The Thread a first message starts, when it was written before that Thread
 * existed: the whole creation command, under its own key. A retry repeats it
 * exactly, so a creation whose answer was lost is answered with the Thread the
 * Host already made rather than making a second one.
 */
const TaskStartParametersSchema = z.strictObject({
  accessMode: ThreadAccessModeSchema,
  environmentId: z.string().min(1).max(200),
  harnessInstanceId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
  modelSelection: ModelSelectionSchema,
  generateTitle: z.literal(true).optional(),
  title: z.string().min(1).max(200),
});
const TaskStartRecordSchema = LegacyTaskStartRecordSchema.extend({
  compaction: CompactionSendChoiceSchema.optional(),
  browserPage: BrowserPageSchema.optional(),
  // Every message is sent to be queued. A `steer` record is one an earlier
  // release saved, and it is replayed exactly as it was first sent.
  delivery: z.enum(["queue", "steer"]).default("queue"),
  // Part of what was sent: a replay under the same key must quote the same
  // source, or it is a different message.
  quotedMessageId: z.string().min(1).max(200).optional(),
  start: TaskStartParametersSchema.optional(),
  ownerScope: z.string().min(1).max(2048).optional(),
  /** The task the Host confirmed making, so the handoff is retried without making it again. */
  startedThreadId: z.string().min(1).max(200).optional(),
  replayed: z.literal(true).optional(),
  userId: z.string().min(1).max(200),
})
  .refine((command) => command.text.trim().length > 0 || (command.attachments?.length ?? 0) > 0)
  .refine(
    (command) =>
      command.localUris === undefined ||
      command.localUris.length === (command.attachments?.length ?? 0),
    "Saved file copies must match the attachments in their original order.",
  );

const DraftFileSchema = z.strictObject({
  drafts: z.record(z.string().min(1).max(200), DraftSchema),
  pending: z.record(z.string().min(1).max(200), TaskStartRecordSchema),
  schemaVersion: z.literal(4),
});

/**
 * Schema 3 could also hold a steering decision: an answer to an approval and
 * the message that followed it, both fixed before either was sent. The record
 * lived only until that message was claimed, and the message is dispatched
 * only after its claim, so its key is one the Host has never seen. Its words
 * were what was about to be sent: trimmed, never blank.
 */
const HeldSteerSchema = z.strictObject({
  createdAt: z.string().min(1).max(40),
  draftText: z.string().min(1).max(maxDraftCharacters),
  idempotencyKey: z.string().min(1).max(200),
  messageIdempotencyKey: z.string().min(1).max(200),
  optionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  text: z
    .string()
    .min(1)
    .max(maxDraftCharacters)
    .refine((text) => text.trim() === text),
  threadId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
});
const SteeringDraftFileSchema = z.strictObject({
  drafts: z.record(z.string().min(1).max(200), DraftSchema),
  pending: z.record(z.string().min(1).max(200), TaskStartRecordSchema),
  pendingSteers: z.record(z.string().min(1).max(200), HeldSteerSchema),
  schemaVersion: z.literal(3),
});

export type ThreadDraft = z.infer<typeof DraftSchema>;
export type ThreadDraftQuote = z.infer<typeof DraftQuoteSchema>;
export function threadDraftRevision(draft: ThreadDraft | null): string | null {
  return draft ? (draft.revision ?? messageStorageFingerprint(JSON.stringify(draft))) : null;
}
export type DraftAttachment = NonNullable<ThreadDraft["attachments"]>[number];
export type TaskStartRecord = z.infer<typeof TaskStartRecordSchema>;
export type TaskStartParameters = z.infer<typeof TaskStartParametersSchema>;

const newTaskKeyPrefix = "new-task:";

/** The key of a new task's draft, under an id made on this phone. */
export function newTaskDraftKey(draftId: string): string {
  return `${newTaskKeyPrefix}${draftId}`;
}

/** Threads with an unsent reply on one reader's Deployment. */
export interface DraftSummary {
  readonly threadIds: ReadonlySet<string>;
}

export const noDrafts: DraftSummary = { threadIds: new Set() };

export function sameDraftSummary(left: DraftSummary, right: DraftSummary): boolean {
  return (
    left.threadIds.size === right.threadIds.size &&
    [...left.threadIds].every((id) => right.threadIds.has(id))
  );
}

/** What a composer knows; the store stamps the time it was claimed. */
export type TaskStartInput = Omit<
  TaskStartRecord,
  "createdAt" | "delivery" | "startedThreadId" | "userId"
>;

/**
 * A schema 3 file without its steering decisions. Typing no longer answers an
 * approval, so a held decision is dropped rather than replayed: one the Host
 * already took stands, and one it never saw is left to the approval's own
 * buttons. The held words become the ordinary message they were about to be,
 * under the key fixed for them. Files and a quote were still on the draft,
 * to be taken when that message was claimed, so words saved beside them stay
 * there with them for the person to send. The release that wrote the file
 * claimed a Thread's message only by removing its decision, and saved a
 * decision only while no message was owed, so the two never meet here.
 */
function withoutSteeringDecisions(file: z.infer<typeof SteeringDraftFileSchema>): {
  readonly drafts: Map<string, ThreadDraft>;
  readonly pending: Map<string, TaskStartRecord>;
} {
  const drafts = new Map(Object.entries(file.drafts));
  const pending = new Map(Object.entries(file.pending));
  for (const [entryKey, held] of Object.entries(file.pendingSteers)) {
    const draft = drafts.get(entryKey);
    const together = draft?.text === held.draftText;
    if (together && ((draft.attachments?.length ?? 0) > 0 || draft.quote !== undefined)) continue;
    pending.set(
      entryKey,
      TaskStartRecordSchema.parse({
        createdAt: held.createdAt,
        delivery: "queue",
        idempotencyKey: held.messageIdempotencyKey,
        text: held.text,
        threadId: held.threadId,
        userId: held.userId,
      }),
    );
    if (together) drafts.delete(entryKey);
  }
  return { drafts, pending };
}

export interface ThreadDraftStore {
  readonly legacyMessages: NonNullable<MessageOutboxOptions["legacy"]>;
  restoreMessage(
    scope: ClientScope,
    entry: StoredMessage,
    isCurrent?: () => boolean,
  ): Promise<"restored" | "occupied">;
  /** A stable external-store snapshot for every mounted view of these drafts. */
  getVersion(): number;
  subscribe(listener: () => void): () => void;
  /** Everything on disk, read once. Safe to call again; later calls are cheap. */
  load(): Promise<void>;
  /**
   * Records the command and clears that Thread's draft in one write. The
   * caller awaits it before dispatching: a command that is not on disk has not
   * been sent.
   */
  claimTaskStart(
    deploymentId: string,
    userId: string,
    threadId: string,
    command: TaskStartInput,
    expectedRevision?: string | null,
  ): Promise<void>;
  bindTaskStartLogin(
    deploymentId: string,
    userId: string,
    threadId: string,
    expectedIdempotencyKey: string,
    ownerScope: string,
  ): Promise<TaskStartRecord | null>;
  /** Clears only the command that was acknowledged or definitively refused. */
  clearTaskStart(
    deploymentId: string,
    userId: string,
    threadId: string,
    expectedIdempotencyKey?: string,
  ): Promise<boolean>;
  replayTaskStart(scope: ClientScope, threadId: string, id: string): Promise<boolean>;
  restoreRefusedTaskStart(
    scope: ClientScope,
    threadId: string,
    id: string,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  /** Notes the task the Host made for this start, for the record under that key only. */
  recordTaskStarted(
    deploymentId: string,
    userId: string,
    threadId: string,
    expectedIdempotencyKey: string,
    startedThreadId: string,
  ): Promise<void>;
  /** Forgets a draft's content. A message in flight under the same key is left alone. */
  discardDraft(deploymentId: string, userId: string, threadId: string): Promise<void>;
  readDraft(deploymentId: string, userId: string, threadId: string): ThreadDraft | null;
  readSavedDraft(
    deploymentId: string,
    userId: string,
    threadId: string,
  ): Promise<ThreadDraft | null>;
  bindReply(scope: ClientScope, threadId: string, revision: string): Promise<void>;
  consumeReply(
    deploymentId: string,
    userId: string,
    threadId: string,
    revision: string,
  ): Promise<boolean>;
  readDraftSummary(deploymentId: string, userId: string): DraftSummary;
  readTaskStart(deploymentId: string, userId: string, threadId: string): TaskStartRecord | null;
  /** True while words, a quote or a page shown in this draft could not be written to disk. */
  readDraftUnsaved(deploymentId: string, userId: string, threadId: string): boolean;
  writeDraft(deploymentId: string, userId: string, threadId: string, text: string): Promise<void>;
  /** Attaches or removes the update this draft answers. Null clears it. */
  writeDraftQuote(
    deploymentId: string,
    userId: string,
    threadId: string,
    quote: ThreadDraftQuote | null,
  ): Promise<void>;
  /** Puts the page Ask handed over on this draft, replacing any other. Null takes it off. */
  writeDraftPage(
    deploymentId: string,
    userId: string,
    threadId: string,
    page: BrowserPageContentPart | null,
  ): Promise<void>;
  writeDraftAttachments(
    deploymentId: string,
    userId: string,
    threadId: string,
    attachments: readonly DraftAttachment[],
    /** The caller's prior strip. When supplied, only its changed keys are written. */
    previous?: readonly DraftAttachment[],
  ): Promise<void>;
}

export function createThreadDraftStore(options: {
  readonly filePath: string;
  readonly now: () => Date;
  readonly privateFiles: PrivateFilesystem;
  /** Waits before each retry of a refused draft edit; tests pass shorter ones. */
  readonly saveRetryDelaysMs?: readonly number[];
  readonly forgetDraftFiles?: (
    scope: FirstMessageAttachmentDraftScope,
    localUris: readonly (string | null)[],
  ) => void | Promise<void>;
}): ThreadDraftStore {
  let drafts = new Map<string, ThreadDraft>();
  let pending = new Map<string, TaskStartRecord>();
  let loaded: Promise<void> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    version += 1;
    for (const listener of listeners) listener();
  };
  // Text, quote and page edits stay visible while their writes are queued.
  // Keep overlays per field so a newly saved attachment remains visible too.
  const textEdits = new Map<string, { readonly text: string }>();
  const quoteEdits = new Map<string, { readonly quote: ThreadDraftQuote | null }>();
  const pageEdits = new Map<string, { readonly page: BrowserPageContentPart | null }>();
  const overlays = { page: pageEdits, quote: quoteEdits, text: textEdits } as const;
  // Fields whose latest edit was refused by disk. Shown until an edit of that
  // field saves or the overlay goes, so a still-failing disk doesn't flicker.
  const unsaved = new Map<string, Set<keyof typeof overlays>>();
  const retryDelays = options.saveRetryDelaysMs ?? [150, 600];
  const writes = new MutationQueue();

  const key = (deploymentId: string, userId: string, threadId: string): string =>
    `${deploymentId}:${userId}:${threadId}`;

  const readVisibleDraft = (
    deploymentId: string,
    userId: string,
    threadId: string,
  ): ThreadDraft | null => {
    const entryKey = key(deploymentId, userId, threadId);
    const entry = drafts.get(entryKey) ?? null;
    if (entry !== null && entry.userId !== userId) return null;
    const textEdit = textEdits.get(entryKey);
    const quoteEdit = quoteEdits.get(entryKey);
    const pageEdit = pageEdits.get(entryKey);
    if (textEdit === undefined && quoteEdit === undefined && pageEdit === undefined) return entry;
    const fields = {
      attachments: entry?.attachments,
      page: pageEdit === undefined ? entry?.page : (pageEdit.page ?? undefined),
      quote: quoteEdit === undefined ? entry?.quote : (quoteEdit.quote ?? undefined),
      text: textEdit?.text ?? entry?.text ?? "",
    };
    if (draftEmpty(fields)) return null;
    if (
      entry &&
      JSON.stringify(fields) ===
        JSON.stringify({
          attachments: entry.attachments,
          page: entry.page,
          quote: entry.quote,
          text: entry.text,
        })
    )
      return entry;
    return DraftSchema.parse({
      ...fields,
      updatedAt: entry?.updatedAt ?? options.now().toISOString(),
      userId,
    });
  };

  const draftIntent = (fields: DraftFields) =>
    JSON.stringify([
      fields.text,
      fields.quote?.messageId,
      fields.page,
      (fields.attachments ?? []).map((item) => item.localUri ?? item.attachmentId),
      fields.recoveredSendKeys ?? [],
    ]);

  /** Saves a draft's fields, or forgets the draft once nothing is left in it. */
  const putDraft = (
    nextDrafts: Map<string, ThreadDraft>,
    entryKey: string,
    userId: string,
    fields: DraftFields,
  ): void => {
    if (draftEmpty(fields) && !fields.recoveredSendKeys?.length) nextDrafts.delete(entryKey);
    else {
      const before = nextDrafts.get(entryKey);
      const same = before && draftIntent(draftFields(before)) === draftIntent(fields);
      const revision = same ? threadDraftRevision(before)! : globalThis.crypto.randomUUID();
      nextDrafts.set(
        entryKey,
        DraftSchema.parse({
          ...fields,
          revision,
          ...(same && before?.replyScope ? { replyScope: before.replyScope } : {}),
          updatedAt: options.now().toISOString(),
          userId,
        }),
      );
    }
  };

  const mutate = (
    change: (
      nextDrafts: Map<string, ThreadDraft>,
      nextPending: Map<string, TaskStartRecord>,
    ) => void,
  ): Promise<void> =>
    writes.run(async () => {
      const nextDrafts = new Map(drafts);
      const nextPending = new Map(pending);
      change(nextDrafts, nextPending);
      const content = JSON.stringify(
        DraftFileSchema.parse({
          drafts: Object.fromEntries(nextDrafts),
          pending: Object.fromEntries(nextPending),
          schemaVersion: 4,
        }),
      );
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > maxDraftFileBytes) {
        throw new Error("Saved messages exceed this device’s storage limit.");
      }
      await options.privateFiles.writeFileAtomic(options.filePath, bytes);
      // Publish only durable state. A failed write cannot erase another queued
      // claim or make a retry forget its original idempotency key.
      drafts = nextDrafts;
      pending = nextPending;
      publish();
    });

  /** Shows a field edit at once, then writes it, retrying while it is still the latest. */
  const saveEdit = async <Edit extends object>(
    field: keyof typeof overlays,
    edits: Map<string, Edit>,
    entryKey: string,
    edit: Edit,
    change: (nextDrafts: Map<string, ThreadDraft>) => void,
  ): Promise<void> => {
    if (!edits.has(entryKey)) unsaved.get(entryKey)?.delete(field);
    edits.set(entryKey, edit);
    publish();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mutate((nextDrafts) => {
          if (edits.get(entryKey) === edit) change(nextDrafts);
        });
        break;
      } catch (error) {
        // A newer edit carries the whole field; retrying this one could overwrite it.
        if (edits.get(entryKey) !== edit) return;
        const delay = retryDelays[attempt];
        if (delay === undefined) {
          unsaved.set(entryKey, (unsaved.get(entryKey) ?? new Set()).add(field));
          publish();
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (edits.get(entryKey) !== edit) return;
      }
    }
    if (edits.get(entryKey) === edit) {
      edits.delete(entryKey);
      unsaved.get(entryKey)?.delete(field);
      publish();
    }
  };

  const store: ThreadDraftStore = {
    getVersion: () => version,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(): Promise<void> {
      loaded ??= (async () => {
        const stored = await options.privateFiles.readFile(options.filePath, maxDraftFileBytes);
        if (stored === null) return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(stored));
        } catch {
          // An unreadable drafts file costs the drafts, never the app. The next
          // write replaces it.
          return;
        }
        const parsed = DraftFileSchema.safeParse(decoded);
        if (parsed.success) {
          drafts = new Map(Object.entries(parsed.data.drafts));
          pending = new Map(Object.entries(parsed.data.pending));
        } else {
          const steering = SteeringDraftFileSchema.safeParse(decoded);
          if (!steering.success) return;
          ({ drafts, pending } = withoutSteeringDecisions(steering.data));
        }
        const obsolete = new Map<
          string,
          { scope: FirstMessageAttachmentDraftScope; localUris: (string | null)[] }
        >();
        for (const [entryKey, record] of [...drafts, ...pending]) {
          const match = /^([^:]+):([^:]+):new-task:(.+)$/u.exec(entryKey);
          if (!match || match[3] === homeDraftId) continue;
          const existing = obsolete.get(entryKey) ?? {
            scope: {
              kind: "new-task" as const,
              deploymentId: match[1]!,
              userId: match[2]!,
              draftId: match[3]!,
            },
            localUris: [],
          };
          if (record.userId === match[2])
            existing.localUris.push(
              ...("localUris" in record
                ? (record.localUris ?? [])
                : (record.attachments ?? []).map((item) =>
                    "localUri" in item ? item.localUri : null,
                  )),
            );
          obsolete.set(entryKey, existing);
        }
        if (obsolete.size) {
          await mutate((nextDrafts, nextPending) => {
            for (const entryKey of obsolete.keys()) {
              nextDrafts.delete(entryKey);
              nextPending.delete(entryKey);
            }
          });
          for (const { scope, localUris } of obsolete.values())
            await options.forgetDraftFiles?.(scope, localUris);
        } else publish();
        // Older files did not record the authenticated user. They therefore
        // cannot safely be shown or replayed after an account change on a
        // shared phone. The production app uses a new filename for this
        // identity-scoped format, leaving the old file untouched.
      })();
      return loaded;
    },

    legacyMessages: {
      load: async (scope) => {
        await store.load();
        return [...pending.entries()].flatMap(([entryKey, entry]) => {
          if (
            !entryKey.startsWith(`${scope.deploymentId}:${scope.viewerId}:`) ||
            entry.userId !== scope.viewerId ||
            entry.start ||
            entry.threadId.startsWith(newTaskKeyPrefix)
          )
            return [];
          const command = hostApi["commands.dispatch"].payload.parse({
            type: "thread.sendMessage",
            threadId: entry.threadId,
            idempotencyKey: entry.idempotencyKey,
            delivery: entry.delivery,
            content: [
              ...(entry.text ? [{ type: "text", text: entry.text }] : []),
              ...(entry.browserPage ? [entry.browserPage] : []),
              ...(entry.attachments ?? []),
            ],
            ...(entry.quotedMessageId ? { quotedMessageId: entry.quotedMessageId } : {}),
            ...(entry.compaction ? { compaction: entry.compaction } : {}),
          });
          if (command.type !== "thread.sendMessage") throw new Error("Invalid saved message.");
          return [
            { command, ...(entry.localUris ? { localAttachmentUris: entry.localUris } : {}) },
          ];
        });
      },
      remove: async (scope, id) => {
        const entry = [...pending.values()].find(
          (entry) => entry.userId === scope.viewerId && entry.idempotencyKey === id,
        );
        if (entry)
          await store.clearTaskStart(scope.deploymentId, scope.viewerId, entry.threadId, id);
      },
    },
    async restoreMessage(scope, entry, isCurrent) {
      let outcome: "restored" | "occupied" = "occupied";
      await mutate((nextDrafts) => {
        if (isCurrent?.() === false) return;
        const entryKey = key(scope.deploymentId, scope.viewerId, entry.command.threadId);
        const held = nextDrafts.get(entryKey);
        if (held?.recoveredSendKeys?.includes(entry.localId)) {
          outcome = "restored";
          return;
        }
        const recoveredSendKeys = [...(held?.recoveredSendKeys ?? []), entry.localId].slice(-40);
        const revision = threadDraftRevision(held ?? null);
        if (
          held &&
          revision &&
          draftReplySendKey(scope, entry.command.threadId, revision) === entry.localId
        ) {
          putDraft(nextDrafts, entryKey, scope.viewerId, {
            ...draftFields(held),
            recoveredSendKeys,
          });
          outcome = "restored";
          return;
        }
        // The message goes above the words already there, with its files after
        // theirs; the draft's own quote and page stand, else the message's.
        const parts = messageDraftParts(entry.command.content);
        const current = held && draftHasContent(held) ? held : undefined;
        const text = current?.text.trim() ? `${parts.body}\n\n${current.text}` : parts.body;
        const kept = current?.attachments ?? [];
        const attachments = [
          ...kept,
          ...parts.attachments
            .map((part, index) => ({
              attachmentId: part.artifactId,
              localUri: entry.localAttachmentUris?.[index] ?? null,
              mediaType: part.mediaType,
              name: part.name,
              sizeBytes: part.sizeBytes ?? 0,
              status: "ready" as const,
            }))
            .filter((part) => !kept.some((item) => item.attachmentId === part.attachmentId)),
        ];
        if (text.length > maxDraftCharacters || attachments.length > maxDraftAttachments) return;
        const page = parts.places.find((part) => part.type === "browser-page");
        if (
          (current?.page && page && JSON.stringify(current.page) !== JSON.stringify(page)) ||
          (current?.quote &&
            entry.command.quotedMessageId &&
            current.quote.messageId !== entry.command.quotedMessageId)
        )
          return;
        putDraft(nextDrafts, entryKey, scope.viewerId, {
          text,
          attachments,
          page: current?.page ?? page,
          quote:
            current?.quote ??
            (entry.command.quotedMessageId
              ? {
                  messageId: entry.command.quotedMessageId,
                  attribution: "Quoted message",
                  excerpt: "",
                }
              : undefined),
          recoveredSendKeys,
        });
        outcome = "restored";
      });
      return outcome;
    },

    async claimTaskStart(deploymentId, userId, threadId, command, expectedRevision): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const claimedTextEdit = textEdits.get(entryKey);
      const claimedQuoteEdit = quoteEdits.get(entryKey);
      const claimedPageEdit = pageEdits.get(entryKey);
      const entry = TaskStartRecordSchema.parse({
        compaction: command.compaction,
        attachments: command.attachments,
        browserPage: command.browserPage,
        createdAt: options.now().toISOString(),
        delivery: "queue",
        idempotencyKey: command.idempotencyKey,
        localUris: command.localUris,
        quotedMessageId: command.quotedMessageId,
        ownerScope: command.ownerScope,
        start: command.start,
        text: command.text,
        threadId: command.threadId,
        userId,
      });
      await mutate((nextDrafts, nextPending) => {
        const previous = nextPending.get(entryKey);
        if (previous !== undefined) {
          if (
            previous.idempotencyKey !== entry.idempotencyKey ||
            JSON.stringify(previous.attachments ?? []) !==
              JSON.stringify(entry.attachments ?? []) ||
            JSON.stringify(previous.localUris ?? []) !== JSON.stringify(entry.localUris ?? []) ||
            JSON.stringify(previous.browserPage ?? null) !==
              JSON.stringify(entry.browserPage ?? null) ||
            previous.ownerScope !== entry.ownerScope ||
            previous.quotedMessageId !== entry.quotedMessageId ||
            previous.compaction !== entry.compaction ||
            JSON.stringify(previous.start ?? null) !== JSON.stringify(entry.start ?? null) ||
            previous.text !== entry.text ||
            previous.threadId !== entry.threadId ||
            previous.userId !== entry.userId
          ) {
            throw new Error("This thread already has a message awaiting acknowledgement.");
          }
          return;
        }
        if (nextPending.size >= maxTaskStartRecords) {
          throw new Error(
            "Too many messages are awaiting acknowledgement. Retry those messages first.",
          );
        }
        if (
          expectedRevision !== undefined &&
          threadDraftRevision(readVisibleDraft(deploymentId, userId, threadId)) !== expectedRevision
        )
          throw changedTaskDraft();
        nextPending.set(entryKey, entry);
        nextDrafts.delete(entryKey);
      });
      // A failed draft write remains visible until another edit saves it. A
      // durable pending claim has now taken those exact words and quote; only
      // discard the overlays if no newer edit arrived while it was queued.
      if (
        claimedTextEdit !== undefined &&
        textEdits.get(entryKey) === claimedTextEdit &&
        claimedTextEdit.text.trim() === entry.text
      ) {
        textEdits.delete(entryKey);
        publish();
      }
      if (
        claimedQuoteEdit !== undefined &&
        quoteEdits.get(entryKey) === claimedQuoteEdit &&
        claimedQuoteEdit.quote?.messageId === entry.quotedMessageId
      ) {
        quoteEdits.delete(entryKey);
        publish();
      }
      if (
        claimedPageEdit !== undefined &&
        pageEdits.get(entryKey) === claimedPageEdit &&
        JSON.stringify(claimedPageEdit.page ?? null) === JSON.stringify(entry.browserPage ?? null)
      ) {
        pageEdits.delete(entryKey);
        publish();
      }
    },

    async bindTaskStartLogin(deploymentId, userId, threadId, expectedIdempotencyKey, ownerScope) {
      let bound: TaskStartRecord | null = null;
      await mutate((_nextDrafts, nextPending) => {
        const entryKey = key(deploymentId, userId, threadId);
        const current = nextPending.get(entryKey);
        if (
          current?.idempotencyKey !== expectedIdempotencyKey ||
          (current.ownerScope && current.ownerScope !== ownerScope)
        )
          return;
        bound = { ...current, ownerScope };
        nextPending.set(entryKey, bound);
      });
      return bound;
    },

    async clearTaskStart(deploymentId, userId, threadId, expectedIdempotencyKey): Promise<boolean> {
      let cleared = false;
      await mutate((_nextDrafts, nextPending) => {
        const entryKey = key(deploymentId, userId, threadId);
        const current = nextPending.get(entryKey);
        if (
          current === undefined ||
          (expectedIdempotencyKey !== undefined &&
            current.idempotencyKey !== expectedIdempotencyKey)
        )
          return;
        nextPending.delete(entryKey);
        cleared = true;
      });
      return cleared;
    },

    async replayTaskStart(scope, threadId, id) {
      const entryKey = key(scope.deploymentId, scope.viewerId, threadId);
      let found = false;
      await mutate((_nextDrafts, nextPending) => {
        const current = nextPending.get(entryKey);
        if (current?.idempotencyKey !== id || current.ownerScope !== clientScopeKey(scope)) return;
        nextPending.set(entryKey, { ...current, replayed: true });
        found = true;
      });
      return found;
    },

    async restoreRefusedTaskStart(scope, threadId, id, isCurrent) {
      const entryKey = key(scope.deploymentId, scope.viewerId, threadId);
      let restored = false;
      await mutate((nextDrafts, nextPending) => {
        const held = nextPending.get(entryKey);
        const current = readVisibleDraft(scope.deploymentId, scope.viewerId, threadId);
        if (
          !isCurrent() ||
          held?.idempotencyKey !== id ||
          held.ownerScope !== clientScopeKey(scope) ||
          held.startedThreadId ||
          held.replayed ||
          (current && draftHasContent(current))
        )
          return;
        putDraft(nextDrafts, entryKey, scope.viewerId, {
          text: held.text,
          page: held.browserPage,
          quote: held.quotedMessageId
            ? { attribution: "Quoted message", excerpt: "", messageId: held.quotedMessageId }
            : undefined,
          attachments: held.attachments?.map((part, index) => ({
            attachmentId: part.artifactId,
            localUri: held.localUris?.[index] ?? null,
            mediaType: part.mediaType,
            name: part.name,
            sizeBytes: part.sizeBytes ?? 0,
            status: "ready",
          })),
        });
        nextPending.delete(entryKey);
        restored = true;
      });
      return restored;
    },

    async recordTaskStarted(
      deploymentId,
      userId,
      threadId,
      expectedIdempotencyKey,
      startedThreadId,
    ): Promise<void> {
      await mutate((_nextDrafts, nextPending) => {
        const entryKey = key(deploymentId, userId, threadId);
        const current = nextPending.get(entryKey);
        if (current?.idempotencyKey !== expectedIdempotencyKey) return;
        nextPending.set(entryKey, { ...current, startedThreadId });
      });
    },

    async discardDraft(deploymentId, userId, threadId): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      await mutate((nextDrafts) => {
        nextDrafts.delete(entryKey);
      });
      // An edit whose write failed would otherwise bring the words back.
      textEdits.delete(entryKey);
      quoteEdits.delete(entryKey);
      pageEdits.delete(entryKey);
      publish();
    },

    readDraft(deploymentId, userId, threadId): ThreadDraft | null {
      return readVisibleDraft(deploymentId, userId, threadId);
    },

    readSavedDraft(deploymentId, userId, threadId) {
      return writes.run(async () => drafts.get(key(deploymentId, userId, threadId)) ?? null);
    },

    bindReply(scope, threadId, revision) {
      const { deploymentId, viewerId } = scope;
      const entryKey = key(deploymentId, viewerId, threadId);
      const login = clientScopeKey(scope)!;
      return mutate((nextDrafts) => {
        const draft = nextDrafts.get(entryKey);
        if (
          !draft ||
          threadDraftRevision(readVisibleDraft(deploymentId, viewerId, threadId)) !== revision
        )
          throw changedTaskDraft();
        assertDraftReplyLogin(draft.replyScope, login);
        nextDrafts.set(entryKey, { ...draft, revision, replyScope: login });
      });
    },

    async consumeReply(deploymentId, userId, threadId, revision) {
      const entryKey = key(deploymentId, userId, threadId);
      const claimed = [textEdits.get(entryKey), quoteEdits.get(entryKey), pageEdits.get(entryKey)];
      let consumed = false;
      await mutate((nextDrafts) => {
        if (threadDraftRevision(readVisibleDraft(deploymentId, userId, threadId)) !== revision)
          return;
        nextDrafts.delete(entryKey);
        consumed = true;
      });
      if (consumed) {
        if (textEdits.get(entryKey) === claimed[0]) textEdits.delete(entryKey);
        if (quoteEdits.get(entryKey) === claimed[1]) quoteEdits.delete(entryKey);
        if (pageEdits.get(entryKey) === claimed[2]) pageEdits.delete(entryKey);
        publish();
      }
      return consumed;
    },

    readDraftSummary(deploymentId, userId): DraftSummary {
      const scope = key(deploymentId, userId, "");
      const threadIds = new Set<string>();
      for (const [entryKey, draft] of drafts) {
        if (!entryKey.startsWith(scope) || draft.userId !== userId || !draftHasContent(draft))
          continue;
        const draftKey = entryKey.slice(scope.length);
        if (!draftKey.startsWith(newTaskKeyPrefix)) threadIds.add(draftKey);
      }
      return { threadIds };
    },

    readDraftUnsaved(deploymentId, userId, threadId): boolean {
      const entryKey = key(deploymentId, userId, threadId);
      return [...(unsaved.get(entryKey) ?? [])].some((field) => overlays[field].has(entryKey));
    },

    readTaskStart(deploymentId, userId, threadId): TaskStartRecord | null {
      const entry = pending.get(key(deploymentId, userId, threadId)) ?? null;
      // A record whose Thread does not match the one it is filed under is a
      // file another release or another device wrote; it is not this Thread's
      // message and must never be replayed into it.
      return entry !== null && entry.threadId === threadId && entry.userId === userId
        ? entry
        : null;
    },

    async writeDraft(deploymentId, userId, threadId, text): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const edit = { text: text.slice(0, maxDraftCharacters) };
      await saveEdit("text", textEdits, entryKey, edit, (nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        putDraft(nextDrafts, entryKey, userId, { ...draftFields(current), text: edit.text });
      });
    },

    async writeDraftAttachments(
      deploymentId,
      userId,
      threadId,
      attachments,
      previous,
    ): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const parsed = DraftAttachmentsSchema.parse(attachments);
      const baseline = previous === undefined ? null : DraftAttachmentsSchema.parse(previous);
      const attachmentKey = (item: DraftAttachment): string =>
        item.localUri ?? `host:${item.attachmentId ?? ""}`;
      await mutate((nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        const nextAttachments = (() => {
          if (baseline === null) return parsed;
          const before = new Map(baseline.map((item) => [attachmentKey(item), item]));
          const after = new Map(parsed.map((item) => [attachmentKey(item), item]));
          const merged = new Map(
            (current?.attachments ?? []).map((item) => [attachmentKey(item), item]),
          );
          for (const itemKey of before.keys()) {
            if (!after.has(itemKey)) merged.delete(itemKey);
          }
          for (const [itemKey, item] of after) {
            const old = before.get(itemKey);
            if (old === undefined) {
              if (!merged.has(itemKey)) merged.set(itemKey, item);
            } else if (
              JSON.stringify(old) !== JSON.stringify(item) &&
              JSON.stringify(merged.get(itemKey)) === JSON.stringify(old)
            ) {
              merged.set(itemKey, item);
            }
          }
          return DraftAttachmentsSchema.parse([...merged.values()]);
        })();
        putDraft(nextDrafts, entryKey, userId, {
          ...draftFields(current),
          attachments: nextAttachments,
        });
      });
    },

    async writeDraftQuote(deploymentId, userId, threadId, quote): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const edit = { quote: quote === null ? null : DraftQuoteSchema.parse(quote) };
      await saveEdit("quote", quoteEdits, entryKey, edit, (nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        putDraft(nextDrafts, entryKey, userId, {
          ...draftFields(current),
          quote: edit.quote ?? undefined,
        });
      });
    },

    async writeDraftPage(deploymentId, userId, threadId, page): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const edit = { page: page === null ? null : BrowserPageSchema.parse(page) };
      await saveEdit("page", pageEdits, entryKey, edit, (nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        putDraft(nextDrafts, entryKey, userId, {
          ...draftFields(current),
          page: edit.page ?? undefined,
        });
      });
    },
  };
  return store;
}

/** What a draft holds, apart from whose it is and when it last changed. */
interface DraftFields {
  readonly recoveredSendKeys?: readonly string[];
  readonly attachments: ThreadDraft["attachments"] | undefined;
  readonly page?: ThreadDraft["page"] | undefined;
  readonly quote?: ThreadDraft["quote"] | undefined;
  readonly text: string;
}

function draftFields(draft: ThreadDraft | undefined): DraftFields {
  return {
    ...(draft?.recoveredSendKeys ? { recoveredSendKeys: draft.recoveredSendKeys } : {}),
    attachments: draft?.attachments,
    page: draft?.page,
    quote: draft?.quote,
    text: draft?.text ?? "",
  };
}

function draftEmpty(fields: DraftFields): boolean {
  return (
    fields.text === "" &&
    (fields.attachments?.length ?? 0) === 0 &&
    fields.quote === undefined &&
    fields.page === undefined
  );
}

/** Spaces alone are saved as typed, but they are nothing to come back to. */
function draftHasContent(draft: ThreadDraft): boolean {
  return draft.text.trim() !== "" || !draftEmpty({ ...draftFields(draft), text: "" });
}
