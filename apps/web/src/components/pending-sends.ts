import { useMemo } from "react";
import { z } from "zod";
import {
  createPendingSendStore,
  messageDraftParts,
  type PendingSendCommand,
  type PendingSendScope,
} from "@opensteer/client/host";
import {
  ContentPartSchema,
  MessageContentSchema,
  PlaceContentPartSchema,
  type PlaceContentPart,
} from "@opensteer/core";
import {
  artifactParts,
  messageText,
  type SentContentPart,
} from "./attachments/attachment-parts.js";
import type { PendingSends, PendingSubmission } from "./composer.js";

/** Why nothing can be sent from this browser, in words a person can act on. */
export const pendingStorageUnavailable =
  "This browser is not letting Opensteer save a message before sending it, so nothing is sent. Allow site data for Opensteer in your browser settings, then reload.";

/** Why nothing can be sent yet: the signed-in deployment has not been confirmed. */
export const pendingScopeUnavailable =
  "Opensteer is still confirming which deployment you are signed in to. Sending is available once it has.";

/**
 * The exact command a message is sent as: its words, the places it includes,
 * then its files in the order they were added. An attachments-only message
 * has no text part. The first send and every replay build it here, so they
 * cannot drift apart.
 */
export function sendMessageCommand(
  threadId: string,
  submission: PendingSubmission,
): PendingSendCommand {
  const text = submission.body.trim();
  return {
    // A recovered send is sent as exactly what was accepted.
    content: MessageContentSchema.parse(
      submission.content ?? [
        ...(text ? [{ text, type: "text" as const }] : []),
        ...(submission.places ?? []),
        ...submission.attachments,
      ],
    ),
    delivery: "queue",
    idempotencyKey: submission.idempotencyKey,
    // Only the source id travels: the Host looks the quoted message up under
    // this reader's authority rather than trusting an excerpt a client wrote.
    ...(submission.quotedMessageId ? { quotedMessageId: submission.quotedMessageId } : {}),
    threadId,
    type: "thread.sendMessage",
  };
}

/**
 * This Thread's unacknowledged message, kept in the browser's storage under
 * the deployment and user it is sent as. A message is never sent without being
 * kept first, so where the scope is unknown or storage is refused this says
 * why instead, and nothing is sent.
 */
export function usePendingSends(
  scope: PendingSendScope | null,
): { readonly sends: PendingSends } | { readonly unavailable: string } {
  const deploymentId = scope?.deploymentId ?? "";
  const threadId = scope?.threadId ?? "";
  const userId = scope?.userId ?? "";
  return useMemo(() => {
    if (!deploymentId || !threadId || !userId) return { unavailable: pendingScopeUnavailable };
    const storage = browserStorage();
    if (!storage) return { unavailable: pendingStorageUnavailable };
    const store = createPendingSendStore(storage);
    const at: PendingSendScope = { deploymentId, threadId, userId };
    const sends: PendingSends = {
      claim: (submission) => {
        store.claim(at, sendMessageCommand(threadId, submission));
      },
      clear: (idempotencyKey) => store.clear(at, idempotencyKey),
      discard: () => store.discard(at),
      read: () => {
        const command = store.read(at);
        return command ? pendingSubmission(command) : null;
      },
    };
    return { sends };
  }, [deploymentId, threadId, userId]);
}

/**
 * Keeps the first message of a Thread just created, before anything sends
 * it. The Thread's own composer sends it when it opens, exactly as kept.
 */
export function claimFirstMessage(scope: PendingSendScope, submission: PendingSubmission): void {
  const storage = browserStorage();
  if (!storage) throw new Error(pendingStorageUnavailable);
  createPendingSendStore(storage).claim(scope, sendMessageCommand(scope.threadId, submission));
}

/* ---- Home's first message, written before Home has an id ---- */

/**
 * Where a reader's first message to Home waits while Home is being created.
 * The pending-send store keys on a Thread id and there is no Thread yet, so
 * this record is scoped to the deployment and user until one exists.
 */
export interface HomeMessageScope {
  readonly deploymentId: string;
  readonly userId: string;
}

const StagedHomeMessageSchema = z.object({
  attachments: z.array(ContentPartSchema).max(64),
  body: z.string().max(256 * 1_024),
  /** Written before pages, apps and phones travelled together; read so a kept message still sends. */
  browserPage: ContentPartSchema.optional(),
  places: z.array(PlaceContentPartSchema).max(64).optional(),
  content: MessageContentSchema.optional(),
  idempotencyKey: z.string().min(1).max(200),
  quotedMessageId: z.string().min(1).max(200).optional(),
});

function homeMessageKey(scope: HomeMessageScope): string {
  if (!scope.deploymentId || !scope.userId) {
    throw new Error("A staged message for Opensteer needs its deployment and user.");
  }
  return `opensteer:home-first-message:v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}`;
}

/**
 * The Home composer's record, before Home exists. It behaves like any other
 * kept message, which is what lets the intro composer use the same
 * unconfirmed-message affordance every conversation has.
 */
export function homeFirstMessageSends(scope: HomeMessageScope | null): PendingSends | null {
  const storage = browserStorage();
  if (!scope || !storage) return null;
  const key = homeMessageKey(scope);
  return {
    claim: (submission) => {
      const held = readStagedHomeMessage(scope);
      const parsed = StagedHomeMessageSchema.parse(submission);
      if (held && JSON.stringify(StagedHomeMessageSchema.parse(held)) !== JSON.stringify(parsed)) {
        throw new Error("Opensteer already has a message awaiting acknowledgement.");
      }
      storage.setItem(key, JSON.stringify(parsed));
    },
    clear: (idempotencyKey) => {
      const held = readStagedHomeMessage(scope);
      if (held !== null && held.idempotencyKey !== idempotencyKey) return;
      storage.removeItem(key);
    },
    discard: () => storage.removeItem(key),
    read: () => readStagedHomeMessage(scope),
  };
}

function readStagedHomeMessage(scope: HomeMessageScope): PendingSubmission | null {
  const storage = browserStorage();
  const raw = storage?.getItem(homeMessageKey(scope)) ?? null;
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The message saved for Opensteer is unreadable.");
  }
  const parsed = StagedHomeMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("The message saved for Opensteer is unreadable.");
  return {
    attachments: artifactParts(parsed.data.attachments),
    body: parsed.data.body,
    ...(parsed.data.places !== undefined
      ? { places: parsed.data.places }
      : placeParts(parsed.data.browserPage ? [parsed.data.browserPage] : [])),
    ...(parsed.data.content ? { content: parsed.data.content } : {}),
    idempotencyKey: parsed.data.idempotencyKey,
    ...(parsed.data.quotedMessageId ? { quotedMessageId: parsed.data.quotedMessageId } : {}),
  };
}

/** Whether a first message for Home is waiting, and whether it can still be read. */
export function stagedHomeMessage(scope: HomeMessageScope): "none" | "staged" | "unreadable" {
  if (!browserStorage()) return "none";
  try {
    return readStagedHomeMessage(scope) === null ? "none" : "staged";
  } catch {
    return "unreadable";
  }
}

/**
 * Hands the staged message to the Home that now exists, under the key it was
 * written with, and lets the staging record go.
 *
 * Nothing here decides to send: it moves one durable record to the Thread whose
 * composer owns it. Called again with the same message it changes nothing.
 * It throws rather than leaving a message nobody will send: the caller shows
 * that, with a way to try again or discard it.
 */
export function promoteHomeFirstMessage(
  scope: HomeMessageScope & { readonly threadId: string },
): void {
  const storage = browserStorage();
  if (!storage) throw new Error(pendingStorageUnavailable);
  const staged = readStagedHomeMessage(scope);
  if (staged === null) return;
  const at: PendingSendScope = { ...scope };
  createPendingSendStore(storage).claim(at, sendMessageCommand(scope.threadId, staged));
  storage.removeItem(homeMessageKey(scope));
}

/** Abandons the staged message, including one that can no longer be read. */
export function discardStagedHomeMessage(scope: HomeMessageScope): void {
  browserStorage()?.removeItem(homeMessageKey(scope));
}

/** Whether a message can be kept here at all; checked before anything is created for one. */
export function pendingStorageAvailable(): boolean {
  return browserStorage() !== null;
}

function pendingSubmission(command: PendingSendCommand): PendingSubmission {
  return {
    attachments: artifactParts(command.content),
    body: messageText(command.content),
    // The accepted content, exactly: a retry after a reload sends the same message.
    content: command.content.map((part) => ContentPartSchema.parse(part)),
    ...placeParts(command.content),
    idempotencyKey: command.idempotencyKey,
    ...(typeof command.quotedMessageId === "string"
      ? { quotedMessageId: command.quotedMessageId }
      : {}),
  };
}

/** The places a kept message includes — every page, app and phone, exactly as kept. */
function placeParts(content: readonly SentContentPart[]): {
  readonly places?: readonly PlaceContentPart[];
} {
  const { places } = messageDraftParts(content.map((part) => ContentPartSchema.parse(part)));
  return places.length > 0 ? { places } : {};
}

function browserStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    // Some browsers hand out storage that refuses every write; a probe is the
    // only way to know before a message depends on it.
    const probe = "opensteer:pending-send:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
