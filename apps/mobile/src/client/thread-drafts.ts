import type { PrivateFilesystem } from "@opensteer/client/connections";
import {
  ContentPartSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  type BrowserPageContentPart,
} from "@opensteer/core";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";

/**
 * What a person has typed and not yet sent, and what they have sent and not yet
 * heard back about.
 *
 * These are two different things and the phone keeps them apart. A draft is
 * editable: it is whatever is in the composer right now, and losing it costs a
 * few words. A pending command is not editable at all — it is the exact message
 * that was handed to the Host, with the idempotency key it was handed under —
 * because the whole point of a key is that a retry repeats one command. A
 * command is written to disk and the write is awaited before it is dispatched,
 * so a phone that is killed mid-flight comes back holding the same command
 * rather than a second message; it is cleared only when the Host acknowledges.
 *
 * Reads are synchronous because a composer mounts with the text already
 * showing; the file is loaded once at startup and written behind the reads.
 */

const maxThreads = 48;
const maxDraftCharacters = 16_000;
// A hard file cap covers escaped text, keys and metadata. Drafts and messages
// share it, so pathological full-size duplicates fail closed rather than
// growing private storage without bound.
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
  .max(10);
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
const DraftSchema = LegacyDraftSchema.extend({
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
const LegacyPendingCommandSchema = z.strictObject({
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
const PendingThreadStartSchema = z.strictObject({
  accessMode: ThreadAccessModeSchema,
  environmentId: z.string().min(1).max(200),
  harnessInstanceId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
  modelSelection: ModelSelectionSchema,
  generateTitle: z.literal(true).optional(),
  title: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
});
/**
 * The page the person was looking at when they sent, as they saw it. It is
 * frozen with the message, so a retry includes the same page even after the
 * browser has moved on. It is the message's own content part, under the
 * limits the Host holds it to.
 */
const PendingBrowserPageSchema = ContentPartSchema.refine(
  (part): part is BrowserPageContentPart => part.type === "browser-page",
  "A message keeps only a browser page here.",
);
const PendingCommandSchema = LegacyPendingCommandSchema.extend({
  browserPage: PendingBrowserPageSchema.optional(),
  // Every message is sent to be queued. A `steer` record is one an earlier
  // release saved, and it is replayed exactly as it was first sent.
  delivery: z.enum(["queue", "steer"]).default("queue"),
  // Part of what was sent: a replay under the same key must quote the same
  // source, or it is a different message.
  quotedMessageId: z.string().min(1).max(200).optional(),
  start: PendingThreadStartSchema.optional(),
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
  pending: z.record(z.string().min(1).max(200), PendingCommandSchema),
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
  pending: z.record(z.string().min(1).max(200), PendingCommandSchema),
  pendingSteers: z.record(z.string().min(1).max(200), HeldSteerSchema),
  schemaVersion: z.literal(3),
});

export type ThreadDraft = z.infer<typeof DraftSchema>;
export type ThreadDraftQuote = z.infer<typeof DraftQuoteSchema>;
export type DraftAttachment = NonNullable<ThreadDraft["attachments"]>[number];
export type PendingCommand = z.infer<typeof PendingCommandSchema>;
export type PendingThreadStart = z.infer<typeof PendingThreadStartSchema>;

/** What a composer knows; the store stamps the time it was claimed. */
export type PendingCommandInput = Omit<PendingCommand, "createdAt" | "delivery" | "userId">;

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
  readonly pending: Map<string, PendingCommand>;
} {
  const drafts = new Map(Object.entries(file.drafts));
  const pending = new Map(Object.entries(file.pending));
  for (const [entryKey, held] of Object.entries(file.pendingSteers)) {
    const draft = drafts.get(entryKey);
    const together = draft?.text === held.draftText;
    if (together && ((draft.attachments?.length ?? 0) > 0 || draft.quote !== undefined)) continue;
    pending.set(
      entryKey,
      PendingCommandSchema.parse({
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
  claimPending(
    deploymentId: string,
    userId: string,
    threadId: string,
    command: PendingCommandInput,
  ): Promise<void>;
  /** Clears only the command that was acknowledged or definitively refused. */
  clearPending(
    deploymentId: string,
    userId: string,
    threadId: string,
    expectedIdempotencyKey?: string,
  ): Promise<boolean>;
  readDraft(deploymentId: string, userId: string, threadId: string): ThreadDraft | null;
  readPending(deploymentId: string, userId: string, threadId: string): PendingCommand | null;
  writeDraft(deploymentId: string, userId: string, threadId: string, text: string): Promise<void>;
  /** Attaches or removes the update this draft answers. Null clears it. */
  writeDraftQuote(
    deploymentId: string,
    userId: string,
    threadId: string,
    quote: ThreadDraftQuote | null,
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
}): ThreadDraftStore {
  let drafts = new Map<string, ThreadDraft>();
  let pending = new Map<string, PendingCommand>();
  let loaded: Promise<void> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    version += 1;
    for (const listener of listeners) listener();
  };
  // Text and quote edits stay visible while their writes are queued. Keep
  // overlays per field so a newly saved attachment remains visible too.
  const textEdits = new Map<string, { readonly text: string }>();
  const quoteEdits = new Map<string, { readonly quote: ThreadDraftQuote | null }>();
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
    if (textEdit === undefined && quoteEdit === undefined) return entry;
    const text = textEdit?.text ?? entry?.text ?? "";
    const quote = quoteEdit === undefined ? entry?.quote : (quoteEdit.quote ?? undefined);
    if (text === "" && quote === undefined && (entry?.attachments?.length ?? 0) === 0) {
      return null;
    }
    return DraftSchema.parse({
      attachments: entry?.attachments,
      ...(quote === undefined ? {} : { quote }),
      text,
      updatedAt: entry?.updatedAt ?? options.now().toISOString(),
      userId,
    });
  };

  const mutate = (
    change: (
      nextDrafts: Map<string, ThreadDraft>,
      nextPending: Map<string, PendingCommand>,
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

  /** Re-inserting makes insertion order recency, so the bound drops the oldest. */
  const touch = <T>(entries: Map<string, T>, entryKey: string, value: T): void => {
    entries.delete(entryKey);
    entries.set(entryKey, value);
    for (const stale of [...entries.keys()].slice(0, Math.max(0, entries.size - maxThreads))) {
      entries.delete(stale);
    }
  };

  return {
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
          publish();
          return;
        }
        // The upgrade is the same on every load, so a phone closed before its
        // next write comes back to the same messages under the same keys.
        const steering = SteeringDraftFileSchema.safeParse(decoded);
        if (steering.success) {
          ({ drafts, pending } = withoutSteeringDecisions(steering.data));
          publish();
          return;
        }
        // Older files did not record the authenticated user. They therefore
        // cannot safely be shown or replayed after an account change on a
        // shared phone. The production app uses a new filename for this
        // identity-scoped format, leaving the old file untouched.
      })();
      return loaded;
    },

    async claimPending(deploymentId, userId, threadId, command): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const claimedTextEdit = textEdits.get(entryKey);
      const claimedQuoteEdit = quoteEdits.get(entryKey);
      const entry = PendingCommandSchema.parse({
        attachments: command.attachments,
        browserPage: command.browserPage,
        createdAt: options.now().toISOString(),
        delivery: "queue",
        idempotencyKey: command.idempotencyKey,
        localUris: command.localUris,
        quotedMessageId: command.quotedMessageId,
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
            previous.quotedMessageId !== entry.quotedMessageId ||
            JSON.stringify(previous.start ?? null) !== JSON.stringify(entry.start ?? null) ||
            previous.text !== entry.text ||
            previous.threadId !== entry.threadId ||
            previous.userId !== entry.userId
          ) {
            throw new Error("This thread already has a message awaiting acknowledgement.");
          }
          return;
        }
        if (nextPending.size >= maxThreads) {
          throw new Error(
            "Too many messages are awaiting acknowledgement. Retry those messages first.",
          );
        }
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
    },

    async clearPending(deploymentId, userId, threadId, expectedIdempotencyKey): Promise<boolean> {
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

    readDraft(deploymentId, userId, threadId): ThreadDraft | null {
      return readVisibleDraft(deploymentId, userId, threadId);
    },

    readPending(deploymentId, userId, threadId): PendingCommand | null {
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
      textEdits.set(entryKey, edit);
      publish();
      await mutate((nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        const attachments = current?.attachments;
        const quote = current?.quote;
        if (edit.text === "" && (attachments?.length ?? 0) === 0 && quote === undefined) {
          nextDrafts.delete(entryKey);
        } else
          touch(
            nextDrafts,
            entryKey,
            DraftSchema.parse({
              attachments,
              quote,
              text: edit.text,
              updatedAt: options.now().toISOString(),
              userId,
            }),
          );
      });
      if (textEdits.get(entryKey) === edit) {
        textEdits.delete(entryKey);
        publish();
      }
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
        if (nextAttachments.length === 0 && !current?.text && current?.quote === undefined) {
          nextDrafts.delete(entryKey);
        } else
          touch(
            nextDrafts,
            entryKey,
            DraftSchema.parse({
              attachments: nextAttachments,
              quote: current?.quote,
              text: current?.text ?? "",
              updatedAt: options.now().toISOString(),
              userId,
            }),
          );
      });
    },

    async writeDraftQuote(deploymentId, userId, threadId, quote): Promise<void> {
      const entryKey = key(deploymentId, userId, threadId);
      const edit = { quote: quote === null ? null : DraftQuoteSchema.parse(quote) };
      quoteEdits.set(entryKey, edit);
      publish();
      await mutate((nextDrafts) => {
        const current = nextDrafts.get(entryKey);
        const attachments = current?.attachments;
        if (edit.quote === null && !current?.text && (attachments?.length ?? 0) === 0) {
          nextDrafts.delete(entryKey);
          return;
        }
        touch(
          nextDrafts,
          entryKey,
          DraftSchema.parse({
            attachments,
            ...(edit.quote === null ? {} : { quote: edit.quote }),
            text: current?.text ?? "",
            updatedAt: options.now().toISOString(),
            userId,
          }),
        );
      });
      if (quoteEdits.get(entryKey) === edit) {
        quoteEdits.delete(entryKey);
        publish();
      }
    },
  };
}
