import { classifyClientFailure } from "@opensteer/client/connections";
import {
  attachmentMaxBytes,
  attachmentMessageMaxBytes,
  attachmentMessageMaxCount,
  type ArtifactContentPart,
  type Attachment,
} from "@opensteer/core";
import { stageAttachment, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  DraftEditTargetSchema,
  type CompleteDraftEdit,
  type DraftAttachment,
  type ThreadDraftStore,
} from "../client/thread-drafts.js";
import type { PastedImages } from "../../modules/composer-editor/index.js";
import type { DraftPaste } from "../../modules/composer-editor/paste-events.js";
import {
  discardPastedImage,
  importPastedImage,
  openChatDraftFile,
  pickChatFile,
  pickChatPhoto,
  removeChatDraftFile,
  type LocalAttachmentDraftScope,
  type PickedAttachmentSource,
} from "../platform/attachment-draft-files.js";
import { failureWords } from "../ui/client-feedback.js";
import { useConnectionReady } from "../ui/connection-live.js";

/**
 * One file on the draft. `localUri` names this phone's private copy; it is
 * null for a file the Host already holds that this phone has no copy of, such
 * as one in a queued message taken back to edit. Such a file is sent by
 * reference once the Host confirms it is still ready.
 */
export interface ComposerAttachment extends DraftAttachment {
  /** Why the last upload or check did not finish, in words; null otherwise. */
  readonly error: string | null;
  /** False when the Host refused the file itself, so trying again cannot help. */
  readonly retryable: boolean;
}

export interface DraftAttachments {
  readonly items: readonly ComposerAttachment[];
  /** Out of reach: files not yet uploaded wait, and go by themselves once it is back. */
  readonly waiting: boolean;
  /** Why a file was not added, until the next pick. */
  readonly notice: string | null;
  pick(kind: "file" | "photo"): Promise<void>;
  /** Adds images pasted into the message field, as temporary files the paste wrote. */
  paste(pasted: PastedImages): Promise<void>;
  readonly pasteTarget?: string | undefined;
  /** Takes files a claimed message now carries off the strip; nothing is discarded. */
  release(keys: readonly string[]): void;
  remove(key: string): void;
  /**
   * Puts files back on the strip, ahead of anything added since: a refused
   * message's, or a queued message's taken back to edit. Each is checked with
   * the Host before it can be sent again.
   */
  restore(returned: readonly RestoredAttachment[]): void;
  retry(key: string): void;
}

export interface RestoredAttachment {
  readonly localUri: string | null;
  readonly part: ArtifactContentPart;
}

/** Identifies a file on the strip, with or without a copy on this phone. */
export function attachmentKey(item: Pick<DraftAttachment, "attachmentId" | "localUri">): string {
  return item.localUri ?? `host:${item.attachmentId ?? ""}`;
}

export function sameDraftAttachmentKeys(
  saved: readonly DraftAttachment[],
  shown: readonly DraftAttachment[],
): boolean {
  return (
    saved.length === shown.length &&
    saved.every((item, index) => attachmentKey(item) === attachmentKey(shown[index]!))
  );
}

const PasteTargetSchema = DraftEditTargetSchema.extend({ draftId: z.string().optional() });
const nativePasteStores = new WeakSet<ThreadDraftStore>();
const pasteNotices = new WeakMap<
  ThreadDraftStore,
  Set<(target: string, notice: string | null) => void>
>();

async function keepPickedAttachment(
  files: LocalAttachmentDraftScope,
  picked: PickedAttachmentSource,
  complete: CompleteDraftEdit,
): Promise<{ kept: boolean; notice: string | null }> {
  const item: DraftAttachment = {
    attachmentId: null,
    localUri: picked.localUri,
    mediaType: picked.mediaType,
    name: picked.name,
    sizeBytes: picked.sizeBytes,
    status: "staged",
  };
  let notice: string | null = null;
  try {
    const kept = await complete((draft) => {
      const attached = draft?.attachments ?? [];
      if (attached.length >= attachmentMessageMaxCount)
        notice = `A message holds at most ${attachmentMessageMaxCount} files.`;
      else if (
        attached.reduce((sum, file) => sum + file.sizeBytes, item.sizeBytes) >
        attachmentMessageMaxBytes
      )
        notice = `${item.name} would take this message past ${attachmentMessageMaxBytes / 1_048_576} MB. Send what is here first.`;
      return notice ? null : { attachments: [...attached, item] };
    });
    if (!kept) forgetCopy(files, picked.localUri);
    return { kept, notice };
  } catch {
    return { kept: false, notice: "This file could not be saved on this phone." };
  }
}

async function keepPastedImages(
  drafts: ThreadDraftStore,
  files: LocalAttachmentDraftScope,
  draftKey: string,
  pasted: PastedImages,
  complete: CompleteDraftEdit,
): Promise<string | null> {
  const { deploymentId, userId } = files;
  const waiting = [...pasted.images];
  let problem: string | null = null;
  for (let image = waiting.shift(); image !== undefined; image = waiting.shift()) {
    if (
      (drafts.readDraft(deploymentId, userId, draftKey)?.attachments?.length ?? 0) >=
      attachmentMessageMaxCount
    ) {
      for (const rest of [image, ...waiting]) discardPastedImage(rest.uri);
      return `A message holds at most ${attachmentMessageMaxCount} files.`;
    }
    let picked: PickedAttachmentSource;
    try {
      picked = await importPastedImage(files, image);
    } catch (error) {
      problem = failureWords(error, attachWords, "A pasted image could not be attached.");
      continue;
    }
    const result = await keepPickedAttachment(files, picked, complete);
    if (!result.kept) {
      for (const rest of waiting) discardPastedImage(rest.uri);
      return result.notice;
    }
  }
  if (problem !== null) return problem;
  if (pasted.tooLarge > 0)
    return `A pasted image is over ${attachmentMaxBytes / 1_048_576} MB, which a message cannot carry.`;
  if (pasted.failed === 1) return "A pasted image could not be read.";
  if (pasted.failed > 1) return `${pasted.failed} pasted images could not be read.`;
  return null;
}

/** The native loader can finish after its editor has left the view hierarchy. */
export function receiveNativeDraftPastes(
  drafts: ThreadDraftStore,
  subscribe: (listener: (event: DraftPaste) => void) => () => void,
): () => void {
  nativePasteStores.add(drafts);
  const unsubscribe = subscribe(({ target, pasted }) => {
    let parsed: ReturnType<typeof PasteTargetSchema.safeParse>;
    try {
      parsed = PasteTargetSchema.safeParse(JSON.parse(target));
    } catch {
      for (const image of pasted.images) discardPastedImage(image.uri);
      return;
    }
    if (!parsed.success) {
      for (const image of pasted.images) discardPastedImage(image.uri);
      return;
    }
    const { draftId, deploymentId, threadId, userId, editId } = parsed.data;
    const files: LocalAttachmentDraftScope =
      draftId === undefined
        ? { deploymentId, threadId, userId }
        : { kind: "new-task", deploymentId, draftId, userId };
    void keepPastedImages(drafts, files, threadId, pasted, (change) =>
      drafts.completeEdit({ deploymentId, threadId, userId, editId }, change),
    ).then(
      (notice) => {
        for (const receive of pasteNotices.get(drafts) ?? []) receive(target, notice);
      },
      () => {},
    );
  });
  return () => {
    nativePasteStores.delete(drafts);
    unsubscribe();
  };
}

// A native stack may keep two copies of the same draft mounted. Only one copy
// uploads a file at a time; when that copy leaves, the surviving one can take
// over the same reservation instead of leaving it stuck as "uploading".
const uploadOwners = new WeakMap<ThreadDraftStore, Map<string, AbortController>>();
const uploadObservers = new WeakMap<ThreadDraftStore, Set<() => void>>();

function uploadScopeKey(scope: {
  readonly deploymentId: string;
  readonly userId: string;
  readonly draftKey: string;
  readonly attachment: string;
}): string {
  return JSON.stringify([scope.deploymentId, scope.userId, scope.draftKey, scope.attachment]);
}

function acquireUpload(
  drafts: ThreadDraftStore,
  key: string,
  controller: AbortController,
): boolean {
  let owners = uploadOwners.get(drafts);
  if (owners === undefined) {
    owners = new Map();
    uploadOwners.set(drafts, owners);
  }
  if (owners.has(key)) return false;
  owners.set(key, controller);
  return true;
}

function releaseUpload(
  drafts: ThreadDraftStore,
  key: string,
  controller: AbortController,
  notify: boolean,
): void {
  const owners = uploadOwners.get(drafts);
  if (owners?.get(key) !== controller) return;
  owners.delete(key);
  if (notify) for (const observer of uploadObservers.get(drafts) ?? []) observer();
}

/**
 * The files on a draft. A picked file is copied into the app's own storage
 * first, then reserved and uploaded from that copy, so a relaunch can finish an
 * upload the picker's short-lived file could not. The strip is saved with the
 * draft; work the app was closed during resumes on the next mount, asking the
 * Host first what it already holds.
 *
 * Where the strip is saved and where its copies live are given separately: a
 * new task's first message is filed under a reserved key on
 * this phone and its files belong to no Thread at all, until the Thread it
 * starts exists to own them.
 */
export function useDraftAttachments(options: {
  readonly client: HostClient;
  readonly drafts: ThreadDraftStore;
  /** The draft-store key: a Thread id, or a first message's reserved local key. */
  readonly draftKey: string;
  /** Where this phone's private copies of these files live. */
  readonly files: LocalAttachmentDraftScope;
}): DraftAttachments {
  const { client, draftKey, drafts } = options;
  const { deploymentId, userId } = options.files;
  // Out of reach, a file waits to upload rather than failing; it goes once the connection is back.
  const ready = useConnectionReady(client.connection);
  const readyNow = useRef(ready);
  readyNow.current = ready;
  const readyRevision = useSyncExternalStore(
    client.connection.subscribe,
    () => client.connection.getSnapshot().readyRevision,
  );
  const draftVersion = useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  // The scope is held by its own parts so that a caller's fresh object each
  // render does not restart uploads. A local scope is never a Thread scope.
  const fileThreadId = "kind" in options.files ? null : options.files.threadId;
  const newTaskDraftId =
    "kind" in options.files && options.files.kind === "new-task" ? options.files.draftId : null;
  const files = useMemo<LocalAttachmentDraftScope>(
    () =>
      fileThreadId !== null
        ? { deploymentId, threadId: fileThreadId, userId }
        : newTaskDraftId !== null
          ? { deploymentId, draftId: newTaskDraftId, kind: "new-task", userId }
          : { deploymentId, kind: "home-intro", userId },
    [deploymentId, fileThreadId, newTaskDraftId, userId],
  );
  const pasteTarget =
    nativePasteStores.has(drafts) && (fileThreadId !== null || newTaskDraftId !== null)
      ? JSON.stringify({
          ...drafts.captureEdit(deploymentId, userId, draftKey),
          ...(newTaskDraftId === null ? {} : { draftId: newTaskDraftId }),
        })
      : undefined;
  const [items, setItems] = useState<readonly ComposerAttachment[]>(() =>
    (drafts.readDraft(deploymentId, userId, draftKey)?.attachments ?? []).map((item) => ({
      ...item,
      error: item.status === "error" ? "This file did not finish uploading." : null,
      retryable: true,
    })),
  );
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (pasteTarget === undefined) return;
    const listeners = pasteNotices.get(drafts) ?? new Set();
    pasteNotices.set(drafts, listeners);
    const receive = (target: string, notice: string | null) => {
      if (target === pasteTarget) setNotice(notice);
    };
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  }, [drafts, pasteTarget]);
  const saved = useRef(items);
  const latest = useRef(items);
  const localDirty = useRef(false);
  const localRevision = useRef(0);
  const pendingWrites = useRef(0);
  const controllers = useRef(new Map<string, AbortController>());
  // Files the connection interrupted, by the ready revision they failed under:
  // they go again by themselves once the connection is back, not on a tap.
  const interrupted = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const ownerKey = useCallback(
    (attachment: string) => uploadScopeKey({ attachment, deploymentId, draftKey, userId }),
    [deploymentId, draftKey, userId],
  );

  const update = useCallback((key: string, change: Partial<ComposerAttachment>) => {
    localDirty.current = true;
    localRevision.current += 1;
    setItems((current) =>
      current.map((item) => (attachmentKey(item) === key ? { ...item, ...change } : item)),
    );
  }, []);

  const syncFromStore = useCallback(() => {
    if (localDirty.current || pendingWrites.current > 0) return;
    const stored = drafts.readDraft(deploymentId, userId, draftKey)?.attachments ?? [];
    const current = saved.current.map(({ error: _error, retryable: _retryable, ...item }) => item);
    if (JSON.stringify(stored) === JSON.stringify(current)) return;
    const keys = new Set(stored.map(attachmentKey));
    for (const [key, controller] of controllers.current) {
      if (!keys.has(key)) {
        controller.abort();
        controllers.current.delete(key);
        releaseUpload(drafts, ownerKey(key), controller, false);
      }
    }
    const next = stored.map((item) => ({
      ...item,
      error: item.status === "error" ? "This file did not finish uploading." : null,
      retryable: true,
    }));
    saved.current = next;
    latest.current = next;
    setItems(next);
  }, [deploymentId, draftKey, drafts, ownerKey, userId]);

  useEffect(() => {
    syncFromStore();
  }, [draftVersion, syncFromStore]);

  const upload = useCallback(
    (item: ComposerAttachment) => {
      if (!mounted.current) return;
      const key = attachmentKey(item);
      if (controllers.current.has(key) || !readyNow.current) return;
      const controller = new AbortController();
      const revision = client.connection.getSnapshot().readyRevision;
      if (!acquireUpload(drafts, ownerKey(key), controller)) return;
      controllers.current.set(key, controller);
      interrupted.current.delete(key);
      update(key, { error: null, status: "uploading" });
      const complete = drafts.reserveEdit(deploymentId, userId, draftKey);
      const remember = (change: Partial<DraftAttachment>) => {
        void complete((draft) => {
          const attachments = draft?.attachments;
          if (!attachments?.some((file) => attachmentKey(file) === key)) return null;
          return {
            attachments: attachments.map((file) =>
              attachmentKey(file) === key ? { ...file, ...change } : file,
            ),
          };
        }).catch(() => {
          if (mounted.current) setNotice("These attachments could not be saved on this phone.");
        });
      };
      void stage(client, files, item, controller.signal, (attachmentId) => {
        if (controller.signal.aborted) return;
        remember({ attachmentId });
        update(key, { attachmentId });
      }).then(
        (attachment) => {
          if (controller.signal.aborted) return;
          const ready = {
            attachmentId: attachment.id,
            mediaType: attachment.mediaType,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            status: "ready" as const,
          };
          remember(ready);
          update(key, ready);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (classifyClientFailure(error).kind === "transport") {
            const connection = client.connection.getSnapshot();
            interrupted.current.set(key, revision);
            if (connection.phase !== "ready" || connection.readyRevision !== revision) {
              // Back to waiting, holding its reservation; this copy no longer
              // owns an upload, so the next ready connection starts one.
              controllers.current.delete(key);
              releaseUpload(drafts, ownerKey(key), controller, false);
              update(key, { error: null, status: "staged" });
              return;
            }
          }
          update(key, {
            error:
              failureWords(error, uploadWords, "This file could not be uploaded.") ??
              "This file could not be uploaded.",
            retryable: retryable(error),
            status: "error",
          });
        },
      );
    },
    [client, deploymentId, draftKey, drafts, files, ownerKey, update, userId],
  );

  const resume = useCallback(() => {
    if (!mounted.current) return;
    const revision = client.connection.getSnapshot().readyRevision;
    for (const item of latest.current) {
      const failedUnder = interrupted.current.get(attachmentKey(item));
      if (
        item.status === "staged" ||
        item.status === "uploading" ||
        (item.status === "error" && failedUnder !== undefined && failedUnder < revision)
      )
        upload(item);
    }
  }, [client, upload]);

  // What the strip holds is saved with the draft, so a relaunch shows it again.
  useEffect(() => {
    latest.current = items;
    if (items === saved.current) return;
    const previous = saved.current.map(({ error: _error, retryable: _retryable, ...item }) => item);
    saved.current = items;
    const savedRevision = localRevision.current;
    pendingWrites.current += 1;
    let savedSuccessfully = true;
    void drafts
      .writeDraftAttachments(
        deploymentId,
        userId,
        draftKey,
        items.map(({ error: _error, retryable: _retryable, ...kept }) => kept),
        previous,
      )
      .then(() => {
        for (const item of items) {
          if (item.status !== "ready" && item.status !== "error") continue;
          const key = attachmentKey(item);
          const controller = controllers.current.get(key);
          if (controller === undefined) continue;
          controllers.current.delete(key);
          const durable = drafts
            .readDraft(deploymentId, userId, draftKey)
            ?.attachments?.find((entry) => attachmentKey(entry) === key);
          releaseUpload(
            drafts,
            ownerKey(key),
            controller,
            durable?.status === "staged" || durable?.status === "uploading",
          );
        }
      })
      .catch(() => {
        savedSuccessfully = false;
        if (mounted.current) setNotice("These attachments could not be saved on this phone.");
        for (const item of items) {
          if (item.status !== "ready" && item.status !== "error") continue;
          const key = attachmentKey(item);
          const controller = controllers.current.get(key);
          if (controller === undefined) continue;
          controllers.current.delete(key);
          releaseUpload(drafts, ownerKey(key), controller, false);
        }
      })
      .finally(() => {
        pendingWrites.current -= 1;
        if (
          savedSuccessfully &&
          pendingWrites.current === 0 &&
          localRevision.current === savedRevision
        ) {
          localDirty.current = false;
          syncFromStore();
        }
        resume();
      });
  }, [deploymentId, draftKey, drafts, items, ownerKey, resume, syncFromStore, userId]);

  // Work the app was closed during picks up where the Host left it.
  useEffect(() => {
    mounted.current = true;
    resume();
    const owned = controllers.current;
    return () => {
      mounted.current = false;
      for (const [key, controller] of owned) {
        controller.abort();
        releaseUpload(drafts, ownerKey(key), controller, true);
      }
      owned.clear();
    };
  }, [drafts, ownerKey, resume]);

  useEffect(() => {
    let observers = uploadObservers.get(drafts);
    if (observers === undefined) {
      observers = new Set();
      uploadObservers.set(drafts, observers);
    }
    observers.add(resume);
    return () => {
      observers?.delete(resume);
    };
  }, [drafts, resume]);

  useEffect(() => {
    resume();
  }, [items, ready, readyRevision, resume]);

  const pick = async (kind: "file" | "photo"): Promise<void> => {
    setNotice(null);
    if (latest.current.length >= attachmentMessageMaxCount) {
      setNotice(`A message holds at most ${attachmentMessageMaxCount} files.`);
      return;
    }
    const complete = drafts.reserveEdit(deploymentId, userId, draftKey);
    let picked: PickedAttachmentSource | null;
    try {
      picked = kind === "photo" ? await pickChatPhoto(files) : await pickChatFile(files);
    } catch (error) {
      if (mounted.current)
        setNotice(failureWords(error, attachWords, "That file could not be attached."));
      return;
    }
    if (picked !== null) {
      const result = await keepPickedAttachment(files, picked, complete);
      if (mounted.current) {
        setNotice(result.notice);
        if (result.kept) syncFromStore();
      }
    }
  };

  const paste = async (pasted: PastedImages): Promise<void> => {
    setNotice(null);
    const complete = drafts.reserveEdit(deploymentId, userId, draftKey);
    const notice = await keepPastedImages(drafts, files, draftKey, pasted, complete);
    if (mounted.current) {
      setNotice(notice);
      syncFromStore();
    }
  };

  const remove = (key: string): void => {
    const item = latest.current.find((candidate) => attachmentKey(candidate) === key);
    const controller = controllers.current.get(key);
    controller?.abort();
    controllers.current.delete(key);
    if (controller !== undefined) releaseUpload(drafts, ownerKey(key), controller, false);
    localDirty.current = true;
    localRevision.current += 1;
    setItems((current) => current.filter((candidate) => attachmentKey(candidate) !== key));
    if (item?.localUri) forgetCopy(files, item.localUri);
    // Taken out before sending, so nothing will reference it. A refusal (it is
    // bound to a message, or already gone) leaves it to the Host.
    if (item?.attachmentId) void client.discardAttachment(item.attachmentId).catch(() => undefined);
  };

  const retry = (key: string): void => {
    const item = latest.current.find((candidate) => attachmentKey(candidate) === key);
    if (item) upload(item);
  };

  const release = (keys: readonly string[]): void => {
    const leaving = new Set(keys);
    localDirty.current = true;
    localRevision.current += 1;
    setItems((current) => current.filter((item) => !leaving.has(attachmentKey(item))));
  };

  const restore = (returned: readonly RestoredAttachment[]): void => {
    const held = new Set(latest.current.map(attachmentKey));
    const added = returned
      .map(({ localUri, part }): ComposerAttachment => ({
        attachmentId: part.artifactId,
        error: null,
        localUri,
        mediaType: part.mediaType,
        name: part.name,
        retryable: true,
        sizeBytes: part.sizeBytes ?? 0,
        status: "uploading",
      }))
      .filter((item) => !held.has(attachmentKey(item)));
    localDirty.current = true;
    localRevision.current += 1;
    setItems((current) => [...added, ...current]);
    for (const item of added) upload(item);
  };

  return {
    items,
    notice,
    paste,
    pasteTarget,
    pick,
    release,
    remove,
    restore,
    retry,
    waiting: !ready,
  };
}

/** What a message carries for a file the Host holds, or null while it does not. */
export function draftAttachmentPart(item: DraftAttachment): ArtifactContentPart | null {
  return item.status === "ready" && item.attachmentId !== null
    ? {
        artifactId: item.attachmentId,
        mediaType: item.mediaType,
        name: item.name,
        sizeBytes: item.sizeBytes,
        type: "artifact",
      }
    : null;
}

/** Deletes this phone's copies of files a message the Host acknowledged carries. */
export function forgetDraftFiles(
  scope: LocalAttachmentDraftScope,
  localUris: readonly (string | null)[],
): void {
  for (const localUri of localUris) if (localUri) forgetCopy(scope, localUri);
}

async function stage(
  client: HostClient,
  scope: LocalAttachmentDraftScope,
  item: DraftAttachment,
  signal: AbortSignal,
  onReserved: (attachmentId: string) => void,
): Promise<Attachment> {
  const { attachmentId } = item;
  if (item.localUri === null) {
    // A file the Host holds and this phone has no copy of: it is sent by
    // reference, so it can only be confirmed, never uploaded again.
    if (attachmentId === null) throw new Error("This file is missing. Remove it.");
    const known = await client.getAttachment(attachmentId);
    if (known.state !== "ready") {
      throw new Error("This file is no longer available. Remove it and attach it again.");
    }
    return known;
  }
  return stageAttachment(client, {
    attachmentId,
    deploymentId: scope.deploymentId,
    mediaType: item.mediaType,
    name: item.name,
    onReserved,
    // Named after the private copy, so a relaunch asks for the same
    // reservation rather than a second one for the same file.
    reservationKey: `attachment:${draftFileId(item.localUri)}`,
    signal,
    sizeBytes: item.sizeBytes,
    source: openChatDraftFile(scope, item.localUri),
  });
}

function draftFileId(localUri: string): string {
  return /([0-9a-f-]{36})\.draft$/u.exec(localUri)?.[1] ?? localUri;
}

function forgetCopy(scope: LocalAttachmentDraftScope, localUri: string): void {
  try {
    removeChatDraftFile(scope, localUri);
  } catch {
    // Already gone, or never this draft's: there is nothing left to delete.
  }
}

const uploadWords = { label: "upload this file", done: "uploaded" } as const;
const attachWords = { label: "attach this file", done: "attached" } as const;

/** Only a refusal of this very file stops it; anything else may go next time. */
function retryable(error: unknown): boolean {
  const failure = classifyClientFailure(error);
  return failure.kind !== "rejection" || failure.code === "not_found";
}
