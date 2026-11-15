import {
  AttachmentIdSchema,
  parseLegacyReferenceHref,
  requestTitleText,
  RequestPresentationSchema,
  type LegacyReference as Reference,
  type ReferenceId,
  type UserId,
} from "@opensteer/core";
import { ReferenceResolveInputSchema, type ReferenceResolution } from "@opensteer/protocol";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import type { Kysely } from "kysely";
import { attachmentUserAdmission } from "./attachment-store.js";
import { publishedMessagePredicate } from "./message-visibility.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { executionDate, withPersonalReadTransaction } from "./personal-transaction.js";
import type { LegacyDatabaseSchema as DatabaseSchema } from "./schema.js";

export async function resolvePersonalReferences(
  database: Kysely<DatabaseSchema>,
  input: { readonly ownerId: UserId; readonly ids: readonly ReferenceId[] },
): Promise<readonly ReferenceResolution[]> {
  const ids = [...new Set(ReferenceResolveInputSchema.parse({ ids: input.ids }).ids)];
  const references = ids.map((id) => parseLegacyReferenceHref(`opensteer:${id}`)!);
  const ofKind = <Kind extends Reference["kind"]>(kind: Kind) =>
    references
      .filter((reference) => reference.kind === kind)
      .map((reference) => reference.id) as Extract<Reference, { kind: Kind }>["id"][];
  const title = (text: string, fallback: string) => plainTextExcerpt(text, 256) || fallback;
  return withPersonalReadTransaction(database, async (tx) => {
    await requirePersonalOwner(tx, input.ownerId);
    const found = new Map<ReferenceId, ReferenceResolution>();
    const tasks = ofKind("task");
    if (tasks.length)
      for (const row of await tx
        .selectFrom("threads")
        .select(["id", "title"])
        .where("id", "in", tasks)
        .where("createdBy", "=", input.ownerId)
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "task",
          id: row.id,
          title: title(row.title, "Task"),
        });
    const runs = ofKind("run");
    if (runs.length)
      for (const row of await tx
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .innerJoin("messages as anchor", (join) =>
          join
            .onRef("anchor.id", "=", "runs.activationInputId")
            .onRef("anchor.threadId", "=", "runs.threadId"),
        )
        .select([
          "runs.id",
          "runs.threadId",
          "runs.activationInputId",
          "runs.runOrdinal",
          "threads.title",
        ])
        .where("runs.id", "in", runs)
        .where("threads.createdBy", "=", input.ownerId)
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "run",
          id: row.id,
          threadId: row.threadId,
          anchorMessageId: row.activationInputId,
          title: title(`Run ${row.runOrdinal} · ${row.title}`, "Run"),
        });
    const messages = ofKind("message");
    if (messages.length)
      for (const row of await tx
        .selectFrom("messages")
        .innerJoin("threads", "threads.id", "messages.threadId")
        .leftJoin("threadInputs as input", (join) =>
          join
            .onRef("input.messageId", "=", "messages.id")
            .onRef("input.threadId", "=", "messages.threadId"),
        )
        .select([
          "messages.id",
          "messages.threadId",
          "threads.title",
          publishedMessagePredicate("input").as("published"),
        ])
        .where("messages.id", "in", messages)
        .where("threads.createdBy", "=", input.ownerId)
        .where((eb) =>
          eb.or([
            publishedMessagePredicate("input"),
            eb("input.state", "in", ["awaiting-approval", "pending", "claimed", "unknown"]),
          ]),
        )
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "message",
          id: row.id,
          threadId: row.threadId,
          location: row.published ? "transcript" : "input-queue",
          title: title(`Message · ${row.title}`, "Message"),
        });
    const requests = ofKind("request");
    if (requests.length)
      for (const row of await tx
        .selectFrom("requests")
        .innerJoin("threads", "threads.id", "requests.originatingThreadId")
        .select([
          "requests.id",
          "requests.presentation",
          "requests.status",
          "requests.originatingThreadId",
        ])
        .where("requests.id", "in", requests)
        .where("threads.createdBy", "=", input.ownerId)
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "request",
          id: row.id,
          threadId: row.originatingThreadId,
          requestStatus: row.status,
          title: title(
            requestTitleText(RequestPresentationSchema.parse(row.presentation)),
            "Request",
          ),
        });
    const automations = ofKind("automation");
    if (automations.length)
      for (const row of await tx
        .selectFrom("triggers")
        .select(["id", "name"])
        .where("id", "in", automations)
        .where("createdBy", "=", input.ownerId)
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "automation",
          id: row.id,
          title: title(row.name, "Automation"),
        });
    const computers = ofKind("computer");
    if (computers.length)
      for (const row of await tx
        .selectFrom("runners")
        .select(["id", "name"])
        .where("id", "in", computers)
        .where("revokedAt", "is", null)
        .execute())
        found.set(row.id, {
          status: "available",
          kind: "computer",
          id: row.id,
          title: title(row.name, "Computer"),
        });
    const attachments = ofKind("attachment");
    if (attachments.length)
      for (const row of await tx
        .selectFrom("attachments")
        .select(["id", "name", "threadId", "messageId"])
        .where("id", "in", attachments)
        .where(attachmentUserAdmission("attachments", input.ownerId))
        .where("state", "=", "ready")
        .where((eb) =>
          eb.or([eb("messageId", "is not", null), eb("expiresAt", ">", executionDate(tx))]),
        )
        .execute()) {
        const id = AttachmentIdSchema.parse(row.id);
        found.set(id, {
          status: "available",
          kind: "attachment",
          id,
          threadId: row.threadId,
          messageId: row.messageId,
          title: title(row.name, "Attachment"),
        });
      }
    return ids.map((id) => found.get(id) ?? { status: "unavailable", id });
  });
}
