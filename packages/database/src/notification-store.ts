import { personalSettings } from "./personal-settings-store.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";

import { isPlaceContentPart } from "@opensteer/core";
import "./connection.js";
import { createHash } from "node:crypto";
import {
  placeContentLabel,
  ContentPartSchema,
  notificationBodyMaxCharacters,
  notificationPushWindowMilliseconds,
  NotificationIdSchema,
  notificationTitleMaxCharacters,
  NotificationViewSchema,
  OpensteerError,
  requestTitleText,
  type ContentPart,
  type EventId,
  type MessageId,
  type NotificationId,
  type NotificationKind,
  type NotificationView,
  type RequestId,
  type RequestRequiredActor,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { sql, type Kysely, type Transaction } from "kysely";
import { runWasStopped } from "./run-grants.js";
import type { DatabaseSchema } from "./schema.js";
import type { PersonalCommitReaction } from "./personal-mutation.js";
import { requestFromRow } from "./request-persistence.js";

/** Process-local decided alert; only sealed text crosses the Account boundary. */
export interface NotificationPublication {
  readonly title: string;
  readonly body: string;
  readonly eventId: EventId;
  readonly expiresAt: Date;
  readonly id: NotificationId;
  readonly kind: NotificationKind;
  readonly messageId: MessageId | null;
  readonly occurredAt: Date;
  readonly requestId: RequestId | null;
  readonly runId: RunId | null;
  readonly sequence: string;
  readonly threadId: ThreadId | null;
  readonly userId: UserId;
}

/** A notification as it was decided, for the recipient's connected clients. */
export interface DecidedNotification {
  readonly userId: UserId;
  readonly view: NotificationView;
}

export interface NotificationStoreOptions {
  readonly now?: () => Date;
}

export function requestNotificationAudience(input: {
  readonly ownerId: UserId;
  readonly requestedBy: UserId;
  readonly requiredActor: RequestRequiredActor;
}): readonly UserId[] {
  return input.requestedBy === input.ownerId ? [input.ownerId] : [];
}

export type NotificationTransition =
  | Extract<PersonalCommitReaction, { type: "requestChanged" | "runFinished" }>
  | {
      readonly type: "replyPublished";
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly addressedToUserId?: UserId;
    };

export function mayNotify(change: NotificationTransition): boolean {
  return change.type !== "requestChanged" || (change.opened && change.status === "pending");
}

/** Reads current facts after an event commits; no notification state is persisted. */
export class NotificationStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, options: NotificationStoreOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }
  async decide(
    change: NotificationTransition,
  ): Promise<readonly (DecidedNotification & { sequence: string })[]> {
    if (!mayNotify(change)) return [];
    return withPersonalReadTransaction(this.#database, async (transaction) =>
      (await candidatesFor(transaction, change))
        .filter(
          (candidate) =>
            Date.parse(candidate.occurredAt) + notificationPushWindowMilliseconds >
            this.#now().getTime(),
        )
        .map((candidate) => {
          const subjectId =
            candidate.kind === "reply-published"
              ? candidate.messageId
              : candidate.kind === "request-opened"
                ? candidate.requestId
                : candidate.runId;
          if (!subjectId)
            throw new OpensteerError({
              code: "internal",
              message: "Notification lacks a subject",
            });
          const digest = createHash("sha256")
            .update(`${candidate.userId}|${candidate.kind}|${subjectId}`)
            .digest();
          // RFC 9562 version 8 reserves the version and variant bits for this
          // application-defined hash; subjects shared by events retain one id.
          digest[6] = (digest[6]! & 0x0f) | 0x80;
          digest[8] = (digest[8]! & 0x3f) | 0x80;
          const hex = digest.subarray(0, 16).toString("hex");
          const id = NotificationIdSchema.parse(
            `ntf_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
          );
          return {
            userId: candidate.userId,
            sequence: candidate.sequence,
            view: NotificationViewSchema.parse({
              ...candidate,
              id,
              threadId: change.threadId,
            }),
          };
        }),
    );
  }

  /**
   * Why a notification is no longer worth waking a phone for, or `null` while
   * it still is. The same facts the event decision used are read again,
   * because a reply can be read or a Request answered while publication waited.
   */
  async publicationSkipReason(entry: NotificationPublication): Promise<string | null> {
    if (entry.expiresAt.getTime() <= this.#now().getTime()) {
      return "Notification expired before it could be published";
    }
    const recipient = await this.#database
      .selectFrom("personalSettings")
      .innerJoin("users", "users.id", "personalSettings.ownerId")
      .select("users.id")
      .where("personalSettings.ownerId", "=", entry.userId)
      .where("users.disabledAt", "is", null)
      .executeTakeFirst();
    if (!recipient) return "Recipient can no longer open this Thread";
    switch (entry.kind) {
      case "request-opened": {
        if (!entry.requestId) return "Notification names no Request";
        const request = await this.#database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", entry.requestId)
          .executeTakeFirst();
        return request?.status === "pending"
          ? null
          : "Request was answered before the notification was published";
      }
      case "reply-published": {
        if (!entry.messageId) return "Notification names no reply";
        const read = await this.#database
          .selectFrom("messages")
          .innerJoin("threadVisits", (join) =>
            join
              .onRef("threadVisits.threadId", "=", "messages.threadId")
              .on("threadVisits.userId", "=", entry.userId),
          )
          .select("messages.id")
          .where("messages.id", "=", entry.messageId)
          // Older rows keep microseconds; visits carry the millisecond times clients see.
          .where(
            sql<boolean>`thread_visits.last_visited_at >= date_trunc('milliseconds', messages.created_at)`,
          )
          .executeTakeFirst();
        return read ? "Reply was read before publication" : null;
      }
      case "run-failed":
        return null;
    }
  }

  /**
   * Host users are reached through their Opensteer Account, read at the moment
   * of publication because a person can link or lose one at any time.
   */
  async accountSubjects(userId: UserId): Promise<readonly string[]> {
    return withPersonalReadTransaction(this.#database, (transaction) =>
      accountSubjectsForUsers(transaction, [userId]),
    );
  }
}
interface NotificationCandidate {
  readonly occurredAt: string;
  readonly sequence: string;
  readonly body: string;
  readonly kind: NotificationKind;
  readonly messageId: MessageId | null;
  readonly requestId: RequestId | null;
  readonly runId: RunId | null;
  readonly title: string;
  readonly userId: UserId;
}

/** The people one event notifies, and what each is told. */
async function candidatesFor(
  transaction: Transaction<DatabaseSchema>,
  change: NotificationTransition,
): Promise<readonly NotificationCandidate[]> {
  if (change.type === "requestChanged") return requestCandidates(transaction, change);
  if (change.type === "replyPublished")
    return replyCandidates(transaction, change, change.messageId, change.addressedToUserId);

  const run = await transaction
    .selectFrom("runs")
    .select([
      "status",
      "revision",
      "terminalReplyMessageId",
      "completedAt",
      "failure",
      "startedAt",
      "backgroundDeadlineAt",
    ])
    .where("id", "=", change.runId)
    .where("threadId", "=", change.threadId)
    .executeTakeFirst();
  if (!run?.completedAt || change.outcome !== run.status) return [];
  if (run.status === "completed") {
    return run.terminalReplyMessageId
      ? replyCandidates(transaction, change, run.terminalReplyMessageId)
      : [];
  }
  if (await runWasStopped(transaction, change.runId)) return [];
  if (
    run.status === "interrupted" &&
    (!run.startedAt || (run.backgroundDeadlineAt && run.backgroundDeadlineAt <= run.completedAt))
  )
    return [];
  return failureCandidates(
    transaction,
    change,
    run.status === "failed"
      ? failureBody(run.failure?.message ?? "")
      : "Opensteer stopped before it finished.",
    run.completedAt.toISOString(),
    run.revision,
  );
}

async function requestCandidates(
  transaction: Transaction<DatabaseSchema>,
  change: Extract<NotificationTransition, { type: "requestChanged" }>,
): Promise<readonly NotificationCandidate[]> {
  const row = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", change.requestId)
    .where("originatingThreadId", "=", change.threadId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!row) return [];
  const request = requestFromRow(row);
  const { ownerId } = await personalSettings(transaction);
  const userIds = requestNotificationAudience({
    ownerId,
    requestedBy: request.requestedBy,
    requiredActor: request.requiredActor,
  });
  if (userIds.length === 0) return [];
  const recipients = await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "in", userIds)
    .where("disabledAt", "is", null)
    .execute();
  const title = await threadTitle(transaction, change.threadId);
  if (!title) return [];
  const body =
    plainTextExcerpt(requestTitleText(request.presentation), notificationBodyMaxCharacters) ??
    "Opensteer needs your answer";
  return recipients.map(({ id: userId }) => ({
    body,
    kind: "request-opened",
    occurredAt: request.createdAt,
    sequence: row.revision,
    messageId: null,
    requestId: request.id,
    runId: null,
    title,
    userId,
  }));
}

/** A reply alerts only the person the Run answers directly. */
async function replyCandidates(
  transaction: Transaction<DatabaseSchema>,
  change: Pick<NotificationTransition, "threadId" | "runId">,
  replyMessageId: MessageId,
  addressed?: UserId,
): Promise<readonly NotificationCandidate[]> {
  const recipient = await personAnswered(transaction, change, addressed);
  if (!recipient) return [];
  const reply = await transaction
    .selectFrom("messages")
    .leftJoin("threadVisits", (join) =>
      join
        .onRef("threadVisits.threadId", "=", "messages.threadId")
        .on("threadVisits.userId", "=", recipient.userId),
    )
    .select([
      "messages.content",
      "messages.createdAt",
      "messages.addressedToUserId",
      "messages.runId",
      "messages.sequence",
      "threadVisits.lastVisitedAt as lastVisitedAt",
    ])
    .where("messages.kind", "=", "assistant")
    .where("messages.id", "=", replyMessageId)
    .where("messages.threadId", "=", change.threadId)
    .where("messages.published", "=", true)
    .executeTakeFirst();
  if (
    !reply ||
    (addressed !== undefined &&
      (reply.addressedToUserId !== addressed || reply.runId !== change.runId))
  )
    return [];
  if (reply.lastVisitedAt !== null && reply.lastVisitedAt >= reply.createdAt) {
    return [];
  }
  const content = ContentPartSchema.array().safeParse(reply.content);
  if (!content.success) return [];
  const body = replyBody(content.data);
  if (!body) return [];
  return [
    {
      body,
      kind: "reply-published",
      occurredAt: reply.createdAt.toISOString(),
      sequence: recipient.revision,
      messageId: replyMessageId,
      requestId: null,
      runId: change.runId,
      title: recipient.title,
      userId: recipient.userId,
    },
  ];
}
async function failureCandidates(
  transaction: Transaction<DatabaseSchema>,
  change: Pick<NotificationTransition, "threadId" | "runId">,
  body: string,
  occurredAt: string,
  sequence: string,
): Promise<readonly NotificationCandidate[]> {
  const recipient = await personAnswered(transaction, change);
  if (!recipient) return [];
  return [
    {
      body,
      kind: "run-failed",
      occurredAt,
      sequence,
      messageId: null,
      requestId: null,
      runId: change.runId,
      title: recipient.title,
      userId: recipient.userId,
    },
  ];
}

/**
 * The person a Run answers, if it answers one directly and they can still
 * open its Thread: work a person started or joined. Assigned results
 * return to the assigner; channel Runs answer where they were asked.
 */
async function personAnswered(
  transaction: Transaction<DatabaseSchema>,
  change: Pick<NotificationTransition, "threadId" | "runId">,
  addressedToUserId?: UserId,
): Promise<{
  readonly title: string;
  readonly userId: UserId;
  readonly revision: string;
} | null> {
  if (!change.runId) return null;
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("users", "users.id", "runs.requestedBy")
    .select([
      "runs.personWaited",
      "runs.revision",
      "runs.assignmentId",
      "runs.replyTarget",
      "runs.requestedBy",
      "threads.parentThreadId",
      "threads.purpose",
    ])
    .select(
      sql<boolean>`exists (select 1 from messages input where
      (input.id = runs.seed_input_id or (input.run_id = runs.id and input.kind = 'input'))
      and input.author->>'kind' = 'human')`.as("personInput"),
    )
    .where("runs.id", "=", change.runId)
    .where("runs.maintenance", "is", null)
    .where("threads.removedAt", "is", null)
    .where("runs.threadId", "=", change.threadId)
    .where("users.disabledAt", "is", null)
    .executeTakeFirst();
  if (
    !run ||
    (!run.personWaited &&
      !run.personInput &&
      (run.parentThreadId !== null || run.purpose === "background-job")) ||
    (addressedToUserId
      ? run.requestedBy !== addressedToUserId
      : run.assignmentId !== null || run.replyTarget !== null)
  )
    return null;
  const title = await threadTitle(transaction, change.threadId);
  if (!title) return null;
  return {
    title,
    userId: run.requestedBy,
    revision: run.revision,
  };
}

/** Voice speaks as Opensteer; task notifications name their task. */
async function threadTitle(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<string | null> {
  const thread = await transaction
    .selectFrom("threads")
    .select(["threads.title", "threads.purpose"])
    .where("threads.id", "=", threadId)
    .where("threads.removedAt", "is", null)
    .executeTakeFirst();
  if (!thread) return null;
  if (thread.purpose === "voice") return "Opensteer";
  return plainTextExcerpt(thread.title, notificationTitleMaxCharacters) ?? "Opensteer";
}

function failureBody(message: string): string {
  const summary = plainTextExcerpt(
    message,
    notificationBodyMaxCharacters - "Opensteer couldn't finish: ".length,
  );
  return summary ? `Opensteer couldn't finish: ${summary}` : "Opensteer couldn't finish this.";
}

/** What a reply says, as one line: its words, the pages it names, or the files it carries. */
function replyBody(content: readonly ContentPart[]): string | null {
  const words = plainTextExcerpt(
    content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    notificationBodyMaxCharacters,
  );
  if (words) return words;
  // Historical references may remain in replies; lock screens show only their labels.
  const pages = plainTextExcerpt(
    content
      .flatMap((part) => (isPlaceContentPart(part) ? [placeContentLabel(part)] : []))
      .join(", "),
    notificationBodyMaxCharacters,
  );
  if (pages) return pages;
  const files = content.filter((part) => part.type === "artifact").length;
  if (files === 0) return null;
  return files === 1 ? "Sent a file" : `Sent ${files} files`;
}

/**
 * Host users are notified through their Opensteer Account, so a user with no
 * Account identity is dropped without comment: there is no phone to reach.
 *
 * The two Deployment shapes carry that identity in different places, and both
 * are read. A server Host holds one Account OIDC account per user, against the
 * same single provider row the Account directory publishes to — an
 * operator-owned OIDC provider's subjects never leave this Host. A Personal
 * Host has no such provider at all: its owner links an Account once, and the
 * link row is the only place that subject exists.
 */
export async function accountSubjectsForUsers(
  transaction: Transaction<DatabaseSchema>,
  userIds: readonly UserId[],
  issuer?: string,
): Promise<readonly string[]> {
  if (userIds.length === 0) return [];
  const rows = await transaction
    .selectFrom("authAccounts")
    .innerJoin(
      "accountDirectoryProvider",
      "accountDirectoryProvider.providerId",
      "authAccounts.providerId",
    )
    .select("authAccounts.accountId as accountId")
    .where("accountDirectoryProvider.singletonKey", "=", "opensteer-account")
    .where("authAccounts.userId", "in", [...userIds])
    .$if(issuer !== undefined, (query) =>
      query.where("accountDirectoryProvider.issuer", "=", issuer!),
    )
    .where("authAccounts.password", "is", null)
    .execute();
  const subjects = new Set(rows.map((row) => row.accountId));
  const linked = await personalLinkSubjectForOwner(transaction, userIds, issuer);
  if (linked) subjects.add(linked);
  return [...subjects];
}

async function personalLinkSubjectForOwner(
  transaction: Transaction<DatabaseSchema>,
  userIds: readonly UserId[],
  issuer?: string,
): Promise<string | null> {
  const owner = await transaction
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .select("ownerId")
    .where("ownerId", "in", [...userIds])
    .where("users.disabledAt", "is", null)
    .executeTakeFirst();
  if (!owner) return null;
  const link = await transaction
    .selectFrom("personalRemoteAccountLink")
    .select("subject")
    .where("singletonKey", "=", "opensteer-account")
    .where("state", "=", "active")
    .$if(issuer !== undefined, (query) => query.where("issuer", "=", issuer!))
    .executeTakeFirst();
  return link?.subject ?? null;
}
