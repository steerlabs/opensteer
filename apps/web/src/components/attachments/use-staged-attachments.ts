import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  attachmentMaxBytes,
  attachmentMessageMaxBytes,
  attachmentMessageMaxCount,
  type ArtifactContentPart,
  type Attachment,
} from "@opensteer/core";
import {
  HostClientRequestError,
  mutationIdempotencyKey,
  stageAttachment,
  type HostClient,
} from "@opensteer/client/host";
import { formatBytes } from "../../app-model.js";
import { composerDrafts, type DraftFile } from "../composer-drafts.js";
import { artifactPart, isInlineImage } from "./attachment-parts.js";
import { prepareUploadFile, UploadPreparationError } from "./upload-file.js";

/** Where staged files go: one Workspace, reached through one signed-in client. */
export interface AttachmentTarget {
  readonly client: HostClient;
  /** The draft these files belong to; its key names the Thread, user and deployment. */
  readonly scope: string;
  readonly workspaceId: string;
}

export interface StagedAttachment {
  readonly error: string | null;
  readonly localId: string;
  readonly mediaType: string;
  readonly name: string;
  /** What the message carries once the Host holds every byte; null until then. */
  readonly part: ArtifactContentPart | null;
  readonly previewUrl: string | null;
  /** False when the Host refused the file itself, so trying again cannot help. */
  readonly retryable: boolean;
  readonly sizeBytes: number;
  readonly status: "checking" | "failed" | "ready" | "uploading";
}

export interface StagedAttachments {
  readonly items: readonly StagedAttachment[];
  /** Why files the person chose were not added, until they add or dismiss. */
  readonly notice: string | null;
  add(files: readonly File[]): void;
  dismissNotice(): void;
  /** Forgets files a sent message now carries. They are the message's now, so nothing is discarded. */
  release(localIds: readonly string[]): void;
  /** Forgets files a message held for sending already carries, wherever the tray found them. */
  releaseSent(parts: readonly ArtifactContentPart[]): void;
  remove(localId: string): void;
  /** Hands a message's attachments back, checked against the Host before they can be sent again. */
  restore(parts: readonly ArtifactContentPart[]): void;
  retry(localId: string): void;
}

/** What a staged file needs that the page never draws. */
interface StagedRecord {
  attachmentId: string | null;
  controller: AbortController | null;
  mediaType: string;
  name: string;
  /** What the draft saves for it, known before a reload's check against the Host confirms it. */
  part: ArtifactContentPart | null;
  /** Whether `source` is already what the Host receives (see `prepareUploadFile`). */
  prepared: boolean;
  previewUrl: string | null;
  reservationKey: string;
  sizeBytes: number;
  /** The person's own bytes; null for a file handed back from a message, which has none here. */
  source: Blob | null;
}

interface State {
  readonly items: readonly StagedAttachment[];
  readonly notice: string | null;
}

const noItems: readonly StagedAttachment[] = [];
const noState: State = { items: noItems, notice: null };
const fallbackMediaType = "application/octet-stream";
const addAgain = "This file has to be added again.";

/**
 * The files one draft holds before they are sent. Each one is reserved and
 * uploaded the moment it is chosen, so a message only waits on bytes still in
 * flight. A retry continues the same reservation with the same bytes (see
 * `stageAttachment`).
 *
 * They belong to the draft rather than to a composer, so leaving does not stop
 * an upload and coming back finds it. What the draft saves survives a reload;
 * a file still uploading then has no bytes left and asks to be added again.
 */
class StagedFiles {
  readonly client: HostClient;
  readonly #scope: string;
  #workspaceId: string;
  #state: State = noState;
  #unchecked: string[] = [];
  readonly #records = new Map<string, StagedRecord>();
  readonly #listeners = new Set<() => void>();

  constructor(target: AttachmentTarget) {
    this.client = target.client;
    this.#scope = target.scope;
    this.#workspaceId = target.workspaceId;
    const saved = composerDrafts.read(target.scope)?.files ?? [];
    if (saved.length > 0)
      this.#state = { items: saved.map((file) => this.#saved(file)), notice: null };
  }

  /** A file a saved draft holds: checked against the Host before it can be sent. */
  #saved(file: DraftFile): StagedAttachment {
    const localId = globalThis.crypto.randomUUID();
    const part = file.part;
    this.#records.set(localId, {
      attachmentId: part?.artifactId ?? null,
      controller: null,
      mediaType: file.mediaType,
      name: file.name,
      part,
      prepared: true,
      previewUrl: null,
      reservationKey: mutationIdempotencyKey("attachment"),
      sizeBytes: file.sizeBytes,
      source: null,
    });
    if (part) this.#unchecked.push(localId);
    return {
      error: part ? null : addAgain,
      localId,
      mediaType: file.mediaType,
      name: file.name,
      part: null,
      previewUrl: null,
      retryable: false,
      sizeBytes: file.sizeBytes,
      status: part ? "checking" : "failed",
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.#dropIfIdle();
    };
  };

  readonly snapshot = (): State => this.#state;

  /** Starts the checks a saved draft's files are waiting on. */
  begin(): void {
    const waiting = this.#unchecked;
    this.#unchecked = [];
    for (const localId of waiting) this.#check(localId);
  }

  /**
   * The draft's task now starts in another Workspace, and the Host only sends
   * files held there: those with their bytes go up again, the rest are added
   * again. What was reserved in the old one is left to expire, since a message
   * may already be carrying it.
   */
  moveTo(workspaceId: string): void {
    if (workspaceId === this.#workspaceId) return;
    this.#workspaceId = workspaceId;
    this.#unchecked = [];
    for (const [localId, record] of this.#records) {
      record.controller?.abort();
      record.controller = null;
      record.attachmentId = null;
      record.part = null;
      record.reservationKey = mutationIdempotencyKey("attachment");
      if (record.source) this.#upload(localId);
      else
        this.#patch(localId, { error: addAgain, part: null, retryable: false, status: "failed" });
    }
  }

  dispose(): void {
    for (const record of this.#records.values()) forget(record);
    this.#records.clear();
    this.#unchecked = [];
    if (sessions.get(this.#scope) === this) sessions.delete(this.#scope);
  }

  #dropIfIdle(): void {
    if (this.#listeners.size > 0 || this.#records.size > 0) return;
    if (sessions.get(this.#scope) === this) sessions.delete(this.#scope);
  }

  #set(state: State): void {
    const filesChanged = state.items !== this.#state.items;
    this.#state = state;
    for (const listener of this.#listeners) listener();
    if (!filesChanged) return;
    composerDrafts.update(this.#scope, {
      files: state.items.map((item) => ({
        mediaType: item.mediaType,
        name: item.name,
        part: item.part ?? this.#records.get(item.localId)?.part ?? null,
        sizeBytes: item.sizeBytes,
      })),
    });
  }

  #patch(localId: string, change: Partial<StagedAttachment>): void {
    this.#set({
      ...this.#state,
      items: this.#state.items.map((item) =>
        item.localId === localId ? { ...item, ...change } : item,
      ),
    });
  }

  /**
   * Turns the chosen file into what the Host receives, once: named by its
   * bytes, HEIC converted to JPEG, and checked again against the limits with
   * its final size.
   */
  async #prepare(
    localId: string,
    record: StagedRecord,
    source: Blob,
    signal: AbortSignal,
  ): Promise<void> {
    if (record.prepared) return;
    const prepared = await prepareUploadFile(source, record.name, record.mediaType);
    signal.throwIfAborted();
    if (prepared.file !== source) {
      if (record.previewUrl) URL.revokeObjectURL(record.previewUrl);
      record.previewUrl = null;
    }
    record.source = prepared.file;
    record.mediaType = prepared.mediaType;
    record.name = prepared.name;
    record.sizeBytes = prepared.file.size;
    record.prepared = true;
    if (!record.previewUrl && isInlineImage(record.mediaType))
      record.previewUrl = URL.createObjectURL(prepared.file);
    this.#patch(localId, {
      mediaType: record.mediaType,
      name: record.name,
      previewUrl: record.previewUrl,
      sizeBytes: record.sizeBytes,
    });
    if (record.sizeBytes > attachmentMaxBytes)
      throw new UploadPreparationError(
        `${record.name} is larger than ${formatBytes(attachmentMaxBytes)}.`,
      );
    const total = [...this.#records.values()].reduce((sum, each) => sum + each.sizeBytes, 0);
    if (total > attachmentMessageMaxBytes)
      throw new UploadPreparationError(
        `${record.name} would take this message past ${formatBytes(attachmentMessageMaxBytes)}.`,
      );
  }

  #upload(localId: string): void {
    const record = this.#records.get(localId);
    const source = record?.source;
    if (!record || !source) return;
    record.controller?.abort();
    const controller = new AbortController();
    record.controller = controller;
    const workspaceId = this.#workspaceId;
    this.#patch(localId, { error: null, part: null, retryable: false, status: "uploading" });
    void this.#prepare(localId, record, source, controller.signal)
      .then(() =>
        stageAttachment(this.client, {
          attachmentId: record.attachmentId,
          mediaType: record.mediaType,
          name: record.name,
          // A retry continues this reservation rather than making a second one.
          onReserved: (attachmentId) => {
            record.attachmentId = attachmentId;
          },
          reservationKey: record.reservationKey,
          signal: controller.signal,
          sizeBytes: record.sizeBytes,
          source: record.source ?? source,
          workspaceId,
        }),
      )
      .then(
        (attachment) => {
          if (controller.signal.aborted) return;
          record.controller = null;
          record.part = artifactPart(attachment);
          this.#patch(localId, { part: record.part, status: "ready" });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          record.controller = null;
          this.#patch(localId, {
            error: uploadFailure(error),
            retryable: retryable(error),
            status: "failed",
          });
        },
      );
  }

  #check(localId: string): void {
    const record = this.#records.get(localId);
    if (!record?.attachmentId) return;
    const controller = new AbortController();
    record.controller = controller;
    this.#patch(localId, { error: null, retryable: false, status: "checking" });
    void recheck(this.client, record.attachmentId, record.mediaType, controller.signal).then(
      ({ attachment, previewUrl }) => {
        if (controller.signal.aborted) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          return;
        }
        record.controller = null;
        record.previewUrl = previewUrl;
        record.part = artifactPart(attachment);
        this.#patch(localId, { part: record.part, previewUrl, status: "ready" });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        record.controller = null;
        const unreachable = retryable(error) && !isNotFound(error);
        this.#patch(localId, {
          error: unreachable
            ? "This file could not be checked. Check your connection and try again."
            : "This file is no longer available. Remove it and attach it again.",
          retryable: unreachable,
          status: "failed",
        });
      },
    );
  }

  readonly add = (files: readonly File[]): void => {
    if (files.length === 0) return;
    // The records mirror what the tray holds, and are current between two adds in one event.
    const held = [...this.#records.values()];
    let count = held.length;
    let total = held.reduce((sum, record) => sum + record.sizeBytes, 0);
    const refused: string[] = [];
    const added: StagedAttachment[] = [];
    for (const file of files) {
      const name = AttachmentNameSchema.safeParse(file.name || defaultName(file.type));
      const label = name.success ? name.data : file.name || "A pasted file";
      if (!name.success) {
        refused.push(`${label} has a name the Host cannot store.`);
      } else if (count >= attachmentMessageMaxCount) {
        refused.push(`A message holds at most ${attachmentMessageMaxCount} files.`);
        break;
      } else if (file.size > attachmentMaxBytes) {
        refused.push(`${label} is larger than ${formatBytes(attachmentMaxBytes)}.`);
      } else if (total + file.size > attachmentMessageMaxBytes) {
        refused.push(
          `${label} would take this message past ${formatBytes(attachmentMessageMaxBytes)}.`,
        );
      } else {
        const mediaType = AttachmentMediaTypeSchema.safeParse(file.type.toLowerCase());
        const record: StagedRecord = {
          attachmentId: null,
          controller: null,
          mediaType: mediaType.success ? mediaType.data : fallbackMediaType,
          name: name.data,
          part: null,
          prepared: false,
          previewUrl: null,
          reservationKey: mutationIdempotencyKey("attachment"),
          sizeBytes: file.size,
          source: file,
        };
        if (isInlineImage(record.mediaType)) record.previewUrl = URL.createObjectURL(file);
        const localId = globalThis.crypto.randomUUID();
        this.#records.set(localId, record);
        added.push({
          error: null,
          localId,
          mediaType: record.mediaType,
          name: record.name,
          part: null,
          previewUrl: record.previewUrl,
          retryable: false,
          sizeBytes: record.sizeBytes,
          status: "uploading",
        });
        count += 1;
        total += file.size;
      }
    }
    this.#set({
      items: added.length > 0 ? [...this.#state.items, ...added] : this.#state.items,
      notice: refused.length > 0 ? `Not added: ${refused.join(" ")}` : null,
    });
    for (const item of added) this.#upload(item.localId);
  };

  readonly restore = (parts: readonly ArtifactContentPart[]): void => {
    if (parts.length === 0) return;
    const added = parts.map((part) =>
      this.#saved({
        mediaType: part.mediaType,
        name: part.name,
        part,
        sizeBytes: part.sizeBytes ?? 0,
      }),
    );
    this.#set({ items: [...added, ...this.#state.items], notice: null });
    this.begin();
  };

  readonly remove = (localId: string): void => {
    const record = this.#records.get(localId);
    this.#records.delete(localId);
    this.#set({
      ...this.#state,
      items: this.#state.items.filter((item) => item.localId !== localId),
    });
    if (!record) return;
    forget(record);
    // Taken out before sending, so nothing will ever reference it. A refusal
    // (already bound, already gone) leaves it to the Host's own expiry.
    if (record.attachmentId)
      void this.client.discardAttachment(record.attachmentId).catch(() => undefined);
  };

  readonly release = (localIds: readonly string[]): void => {
    const leaving = new Set(localIds);
    for (const localId of leaving) {
      const record = this.#records.get(localId);
      if (record) forget(record);
      this.#records.delete(localId);
    }
    this.#set({
      ...this.#state,
      items: this.#state.items.filter((item) => !leaving.has(item.localId)),
    });
    this.#dropIfIdle();
  };

  readonly releaseSent = (parts: readonly ArtifactContentPart[]): void => {
    const sent = new Set(parts.map((part) => part.artifactId));
    const held = [...this.#records].flatMap(([localId, record]) =>
      record.part && sent.has(record.part.artifactId) ? [localId] : [],
    );
    if (held.length > 0) this.release(held);
  };

  readonly dismissNotice = (): void => this.#set({ ...this.#state, notice: null });

  /** Another try: up again with its bytes, or back to the Host for a saved file with none here. */
  readonly retry = (localId: string): void => {
    if (this.#records.get(localId)?.source) this.#upload(localId);
    else this.#check(localId);
  };
}

/** Every draft's files, kept here so an upload outlives the composer that started it. */
const sessions = new Map<string, StagedFiles>();

function stagedFiles(target: AttachmentTarget): StagedFiles {
  const session = sessions.get(target.scope);
  if (session?.client === target.client) return session;
  // A new connection's composer takes over; the draft still holds what was saved.
  session?.dispose();
  const created = new StagedFiles(target);
  sessions.set(target.scope, created);
  return created;
}

/** Stops whatever one draft is uploading, for a draft being thrown away. */
export function discardStagedFiles(scope: string): void {
  sessions.get(scope)?.dispose();
}

/** Stops every draft's uploads, for a person signing out. */
export function discardAllStagedFiles(): void {
  for (const session of sessions.values()) session.dispose();
}

const ignoredFiles: StagedAttachments = {
  add: () => undefined,
  dismissNotice: () => undefined,
  items: noItems,
  notice: null,
  release: () => undefined,
  releaseSent: () => undefined,
  remove: () => undefined,
  restore: () => undefined,
  retry: () => undefined,
};
const noSubscription = () => () => undefined;
const noSnapshot = () => noState;

export function useStagedAttachments(target: AttachmentTarget | null): StagedAttachments {
  const session = target ? stagedFiles(target) : null;
  const state = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.snapshot ?? noSnapshot,
    session?.snapshot ?? noSnapshot,
  );
  const workspaceId = target?.workspaceId ?? null;
  useEffect(() => {
    if (workspaceId) session?.moveTo(workspaceId);
    session?.begin();
  }, [session, workspaceId]);
  return useMemo(
    () =>
      session
        ? {
            add: session.add,
            dismissNotice: session.dismissNotice,
            items: state.items,
            notice: state.notice,
            release: session.release,
            releaseSent: session.releaseSent,
            remove: session.remove,
            restore: session.restore,
            retry: session.retry,
          }
        : ignoredFiles,
    [session, state],
  );
}

async function recheck(
  client: HostClient,
  attachmentId: string,
  mediaType: string,
  signal: AbortSignal,
): Promise<{ readonly attachment: Attachment; readonly previewUrl: string | null }> {
  const attachment = await client.getAttachment(attachmentId);
  if (attachment.state !== "ready") throw new UploadPreparationError("Attachment is not ready.");
  if (!isInlineImage(mediaType)) return { attachment, previewUrl: null };
  const bytes = await client.readAttachment(attachmentId, signal).catch(() => null);
  return {
    attachment,
    previewUrl: bytes ? URL.createObjectURL(new Blob([bytes], { type: mediaType })) : null,
  };
}

function forget(record: StagedRecord): void {
  record.controller?.abort();
  record.controller = null;
  if (record.previewUrl) URL.revokeObjectURL(record.previewUrl);
  record.previewUrl = null;
}

function defaultName(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split(/[+;]/u)[0];
  return subtype ? `pasted.${subtype}` : "pasted-file";
}

function uploadFailure(error: unknown): string {
  if (error instanceof HostClientRequestError) return error.message;
  if (error instanceof TypeError) {
    return "The upload did not finish. Check your connection and try again.";
  }
  return error instanceof Error && error.message ? error.message : "The upload did not finish.";
}

function isNotFound(error: unknown): boolean {
  return error instanceof HostClientRequestError && error.status === 404;
}

function retryable(error: unknown): boolean {
  if (error instanceof UploadPreparationError) return false;
  if (!(error instanceof HostClientRequestError)) return true;
  return (
    error.status >= 500 || error.status === 404 || error.status === 408 || error.status === 429
  );
}
