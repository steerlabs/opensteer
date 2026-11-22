import {
  AttachmentIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
  requestTitleText,
} from "@opensteer/core";
import type { AvailableReference } from "@opensteer/protocol";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import type { HostSnapshot, TranscriptFixtureSnapshot } from "../host/client.js";
import type { IdReference as Reference } from "./links.js";
import { heldThread } from "../host/task-list.js";

export function referenceTitle(title: string, fallback: string): string {
  return plainTextExcerpt(title, 256) || fallback;
}

export function localReference(
  snapshot: HostSnapshot &
    Partial<Pick<TranscriptFixtureSnapshot, "transcripts" | "inputQueues" | "requests">>,
  ref: Reference,
): AvailableReference | null {
  const common = { status: "available" as const, id: ref.id };
  switch (ref.kind) {
    case "task": {
      const thread = heldThread(snapshot, ref.id);
      return thread
        ? { ...common, kind: ref.kind, id: ref.id, title: referenceTitle(thread.title, "Task") }
        : null;
    }
    case "run":
      // RunEntry has neither the activation input nor an authoritative ordinal.
      return null;
    case "message": {
      for (const [parent, entries] of Object.entries(snapshot.transcripts ?? {})) {
        const message = entries.find(
          (entry) =>
            entry.kind === "message" &&
            entry.id === ref.id &&
            !entry.streaming &&
            entry.published !== false,
        );
        const threadId = ThreadIdSchema.safeParse(parent);
        const thread = heldThread(snapshot, parent);
        if (message && threadId.success && thread)
          return {
            ...common,
            kind: ref.kind,
            id: ref.id,
            threadId: threadId.data,
            location: "transcript",
            title: referenceTitle(`Message · ${thread.title}`, "Message"),
          };
      }
      for (const queue of Object.values(snapshot.inputQueues ?? {})) {
        if (
          !queue.items.some(
            ({ message, input }) => message.id === ref.id && input.state !== "cancelled",
          )
        )
          continue;
        const thread = heldThread(snapshot, queue.threadId);
        if (thread)
          return {
            ...common,
            kind: ref.kind,
            id: ref.id,
            threadId: queue.threadId,
            location: "input-queue",
            title: referenceTitle(`Message · ${thread.title}`, "Message"),
          };
      }
      return null;
    }
    case "request": {
      const request =
        Object.values(snapshot.requests ?? {})
          .flat()
          .find(({ id }) => id === ref.id) ??
        snapshot.waitingRequests.find(({ request }) => request.id === ref.id)?.request;
      return request
        ? {
            ...common,
            kind: ref.kind,
            id: ref.id,
            threadId: request.originatingThreadId,
            requestStatus: request.status,
            title: referenceTitle(requestTitleText(request.presentation), "Request"),
          }
        : null;
    }
    case "automation": {
      const automation = Object.values(snapshot.threadAutomations)
        .flat()
        .find(({ id }) => id === ref.id);
      return automation
        ? {
            ...common,
            kind: ref.kind,
            id: ref.id,
            title: referenceTitle(automation.name, "Automation"),
          }
        : null;
    }
    case "computer": {
      const machine = snapshot.machines.find(({ id }) => id === ref.id);
      return machine
        ? { ...common, kind: ref.kind, id: ref.id, title: referenceTitle(machine.name, "Computer") }
        : null;
    }
    case "attachment": {
      for (const [parent, entries] of Object.entries(snapshot.transcripts ?? {})) {
        for (const entry of entries) {
          if (entry.kind !== "message") continue;
          const part = entry.attachments?.find((part) => part.artifactId === ref.id);
          const id = AttachmentIdSchema.safeParse(part?.artifactId);
          const threadId = ThreadIdSchema.safeParse(parent);
          const messageId = MessageIdSchema.safeParse(entry.id);
          if (part && id.success && threadId.success && messageId.success)
            return {
              ...common,
              kind: ref.kind,
              id: ref.id,
              threadId: threadId.data,
              messageId: messageId.data,
              title: referenceTitle(part.name, "Attachment"),
            };
        }
      }
      return null;
    }
  }
}
