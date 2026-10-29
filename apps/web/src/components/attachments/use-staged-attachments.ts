import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { artifactPart, isInlineImage } from "./attachment-parts.js";
import { prepareUploadFile, UploadPreparationError } from "./upload-file.js";

/** Where staged files go: one Workspace, reached through one signed-in client. */
export interface AttachmentTarget {
  readonly client: HostClient;
  /** Changes whenever the files could land somewhere else: another Thread, user or deployment. */
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
  remove(localId: string): void;
  /** Hands a message's attachments back, checked against the Host before they can be sent again. */
  restore(parts: readonly ArtifactContentPart[]): void;
  retry(localId: string): void;
}

interface Fence {
  readonly client: HostClient | null;
  readonly scope: string | null;
  readonly workspaceId: string | null;
}

/** What a staged file needs that the page never draws. */
interface StagedRecord {
  attachmentId: string | null;
  controller: AbortController | null;
  mediaType: string;
  name: string;
  /** Whether `source` is already what the Host receives (see `prepareUploadFile`). */
  prepared: boolean;
  previewUrl: string | null;
  readonly reservationKey: string;
  sizeBytes: number;
  /** The person's own bytes; null for a file handed back from a message, which has none here. */
  source: Blob | null;
}

interface State {
  readonly fence: Fence;
  readonly items: readonly StagedAttachment[];
  readonly notice: string | null;
}

const noItems: readonly StagedAttachment[] = [];
const fallbackMediaType = "application/octet-stream";

/**
 * The files a composer holds before they are sent. Each one is reserved and
 * uploaded the moment it is chosen, so a message only waits on bytes still in
 * flight. A retry continues the same reservation with the same bytes (see
 * `stageAttachment`).
 *
 * Everything here belongs to one target. Moving to another Thread, Workspace,
 * user or deployment abandons the uploads in flight, releases the previews,
 * and lets no late answer land in the new composer.
 */
export function useStagedAttachments(target: AttachmentTarget | null): StagedAttachments {
  const client = target?.client ?? null;
  const scope = target?.scope ?? null;
  const workspaceId = target?.workspaceId ?? null;
  const fence = useMemo<Fence>(
    () => ({ client, scope, workspaceId }),
    [client, scope, workspaceId],
  );
  const [state, setState] = useState<State>(() => ({ fence, items: noItems, notice: null }));
  const records = useRef(new Map<string, StagedRecord>());
  const current = state.fence === fence ? state : { fence, items: noItems, notice: null };

  useEffect(() => {
    const owned = records.current;
    return () => {
      for (const record of owned.values()) forget(record);
      owned.clear();
    };
  }, [fence]);

  const patch = useCallback(
    (localId: string, change: Partial<StagedAttachment>) =>
      setState((previous) =>
        previous.fence !== fence
          ? previous
          : {
              ...previous,
              items: previous.items.map((item) =>
                item.localId === localId ? { ...item, ...change } : item,
              ),
            },
      ),
    [fence],
  );

  /**
   * Turns the chosen file into what the Host receives, once: named by its
   * bytes, HEIC converted to JPEG, and checked again against the limits with
   * its final size.
   */
  const prepare = useCallback(
    async (localId: string, record: StagedRecord, source: Blob, signal: AbortSignal) => {
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
      patch(localId, {
        mediaType: record.mediaType,
        name: record.name,
        previewUrl: record.previewUrl,
        sizeBytes: record.sizeBytes,
      });
      if (record.sizeBytes > attachmentMaxBytes)
        throw new UploadPreparationError(
          `${record.name} is larger than ${formatBytes(attachmentMaxBytes)}.`,
        );
      const total = [...records.current.values()].reduce((sum, each) => sum + each.sizeBytes, 0);
      if (total > attachmentMessageMaxBytes)
        throw new UploadPreparationError(
          `${record.name} would take this message past ${formatBytes(attachmentMessageMaxBytes)}.`,
        );
    },
    [patch],
  );

  const upload = useCallback(
    (localId: string) => {
      const record = records.current.get(localId);
      const { client: host, workspaceId: workspace } = fence;
      const source = record?.source;
      if (!record || !host || !workspace || !source) return;
      record.controller?.abort();
      const controller = new AbortController();
      record.controller = controller;
      patch(localId, { error: null, retryable: false, status: "uploading" });
      void prepare(localId, record, source, controller.signal)
        .then(() =>
          stageAttachment(host, {
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
            workspaceId: workspace,
          }),
        )
        .then(
          (attachment) => {
            if (controller.signal.aborted) return;
            record.controller = null;
            patch(localId, { part: artifactPart(attachment), status: "ready" });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            record.controller = null;
            patch(localId, {
              error: uploadFailure(error),
              retryable: retryable(error),
              status: "failed",
            });
          },
        );
    },
    [fence, patch, prepare],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      if (!fence.client || !fence.workspaceId || files.length === 0) return;
      // The records mirror what the tray holds, and unlike state they are
      // current between two adds in the same event.
      const held = [...records.current.values()];
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
            prepared: false,
            previewUrl: null,
            reservationKey: mutationIdempotencyKey("attachment"),
            sizeBytes: file.size,
            source: file,
          };
          if (isInlineImage(record.mediaType)) record.previewUrl = URL.createObjectURL(file);
          const localId = globalThis.crypto.randomUUID();
          records.current.set(localId, record);
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
      setState((previous) => ({
        fence,
        items: [...(previous.fence === fence ? previous.items : noItems), ...added],
        notice: refused.length > 0 ? `Not added: ${refused.join(" ")}` : null,
      }));
      for (const item of added) upload(item.localId);
    },
    [fence, upload],
  );

  const restore = useCallback(
    (parts: readonly ArtifactContentPart[]) => {
      const host = fence.client;
      if (!host || parts.length === 0) return;
      const added = parts.map((part): StagedAttachment => {
        const localId = globalThis.crypto.randomUUID();
        records.current.set(localId, {
          attachmentId: part.artifactId,
          controller: null,
          mediaType: part.mediaType,
          name: part.name,
          prepared: true,
          previewUrl: null,
          reservationKey: mutationIdempotencyKey("attachment"),
          sizeBytes: part.sizeBytes ?? 0,
          source: null,
        });
        return {
          error: null,
          localId,
          mediaType: part.mediaType,
          name: part.name,
          part: null,
          previewUrl: null,
          retryable: false,
          sizeBytes: part.sizeBytes ?? 0,
          status: "checking",
        };
      });
      setState((previous) => ({
        fence,
        items: [...added, ...(previous.fence === fence ? previous.items : noItems)],
        notice: null,
      }));
      for (const item of added) {
        const record = records.current.get(item.localId);
        if (!record?.attachmentId) continue;
        const controller = new AbortController();
        record.controller = controller;
        void recheck(host, record.attachmentId, record.mediaType, controller.signal).then(
          ({ attachment, previewUrl }) => {
            if (controller.signal.aborted) {
              if (previewUrl) URL.revokeObjectURL(previewUrl);
              return;
            }
            record.controller = null;
            record.previewUrl = previewUrl;
            patch(item.localId, { part: artifactPart(attachment), previewUrl, status: "ready" });
          },
          () => {
            if (controller.signal.aborted) return;
            record.controller = null;
            patch(item.localId, {
              error: "This file is no longer available. Remove it and attach it again.",
              status: "failed",
            });
          },
        );
      }
    },
    [fence, patch],
  );

  const remove = useCallback(
    (localId: string) => {
      const record = records.current.get(localId);
      records.current.delete(localId);
      setState((previous) =>
        previous.fence !== fence
          ? previous
          : { ...previous, items: previous.items.filter((item) => item.localId !== localId) },
      );
      if (!record) return;
      forget(record);
      // Taken out before sending, so nothing will ever reference it. A refusal
      // (already bound, already gone) leaves it to the Host's own expiry.
      if (record.attachmentId && fence.client) {
        void fence.client.discardAttachment(record.attachmentId).catch(() => undefined);
      }
    },
    [fence],
  );

  const release = useCallback(
    (localIds: readonly string[]) => {
      const leaving = new Set(localIds);
      for (const localId of leaving) {
        const record = records.current.get(localId);
        if (record) forget(record);
        records.current.delete(localId);
      }
      setState((previous) =>
        previous.fence !== fence
          ? previous
          : { ...previous, items: previous.items.filter((item) => !leaving.has(item.localId)) },
      );
    },
    [fence],
  );

  const dismissNotice = useCallback(
    () =>
      setState((previous) => (previous.fence !== fence ? previous : { ...previous, notice: null })),
    [fence],
  );

  return {
    add,
    dismissNotice,
    items: current.items,
    notice: current.notice,
    release,
    remove,
    restore,
    retry: upload,
  };
}

async function recheck(
  client: HostClient,
  attachmentId: string,
  mediaType: string,
  signal: AbortSignal,
): Promise<{ readonly attachment: Attachment; readonly previewUrl: string | null }> {
  const attachment = await client.getAttachment(attachmentId);
  if (attachment.state !== "ready") throw new Error("Attachment is not ready.");
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

function retryable(error: unknown): boolean {
  if (error instanceof UploadPreparationError) return false;
  if (!(error instanceof HostClientRequestError)) return true;
  return (
    error.status >= 500 || error.status === 404 || error.status === 408 || error.status === 429
  );
}
