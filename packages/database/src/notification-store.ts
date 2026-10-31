import { isPlaceContentPart } from "@opensteer/core";
import { withDatabaseTransaction } from "./connection.js";
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
  RequestSchema,
  requestTitleText,
  type AgentEvent,
  type ContentPart,
  type EventId,
  type MessageId,
  type NotificationId,
  type NotificationKind,
  type NotificationView,
  type Request,
  type RequestId,
  type RequestPayload,
  type RequestRequiredActor,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { type Kysely, type Transaction } from "kysely";
import { runWasStopped } from "./run-grants.js";
import type { DatabaseSchema } from "./schema.js";

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
  readonly threadId: ThreadId;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/** A notification as it was decided, for the recipient's connected clients. */
export interface DecidedNotification {
  readonly userId: UserId;
  readonly view: NotificationView;
}

/** One active member of the Workspace an event happened in. */
export interface NotificationAudienceMember {
  readonly instanceRole: "administrator" | "user";
  readonly role: "collaborator" | "owner";
  readonly userId: UserId;
}

export interface NotificationStoreOptions {
  readonly now?: () => Date;
}

/**
 * Who may answer this Request, restricted to people who can actually open the
 * Thread it belongs to. The rules are the ones `request.respond` enforces:
 * a `requester` Request is that person's alone, a `workspace-owner` Request is
 * any active owner's, and an `administrator` Request is any instance
 * administrator's. A preinstall integration access Request is still the
 * requester's consent decision, but it also reaches Workspace administrators
 * because one of them must perform the installation before consent can finish.
 *
 * Active Workspace membership bounds all three. An administrator who is not a
 * member cannot read the Thread — `listWorkspaceMembers` answers "Workspace not
 * found" — so notifying them would deliver a link that opens onto nothing.
 */
export function requestNotificationAudience(input: {
  readonly members: readonly NotificationAudienceMember[];
  readonly payload: RequestPayload;
  readonly requestedBy: UserId;
  readonly requiredActor: RequestRequiredActor;
}): readonly UserId[] {
  switch (input.requiredActor) {
    case "requester": {
      const requester = input.members.some((member) => member.userId === input.requestedBy)
        ? [input.requestedBy]
        : [];
      if (input.payload.kind !== "integration.access" || input.payload.installationId !== null) {
        return requester;
      }
      return [
        ...new Set([
          ...requester,
          ...input.members
            .filter((member) => member.instanceRole === "administrator")
            .map(({ userId }) => userId),
        ]),
      ];
    }
    case "workspace-owner":
      return input.members.filter((member) => member.role === "owner").map(({ userId }) => userId);
    case "administrator":
      return input.members
        .filter((member) => member.instanceRole === "administrator")
        .map(({ userId }) => userId);
  }
}

/**
 * Whether an event can become a notification. It reads only what the event
 * carries; the current Workspace facts decide the rest.
 */
export function mayNotify(event: AgentEvent): boolean {
  switch (event.type) {
    case "request.opened":
    case "run.failed":
    case "run.interrupted":
      return true;
    case "run.completed":
    case "run.phase":
      return replyMessageIdOf(event) !== null;
    default:
      return false;
  }
}

/**
 * How long a reply waits before push. A person reading the Thread on another
 * screen marks it read within this window, and the publisher rereads that
 * before sending, so their phone does not buzz about what they just saw.
 * Requests are not held: they wait on the person until answered.
 */
export const replyPushGraceMilliseconds = 5_000;

/** Reads current facts after an event commits; no notification state is persisted. */
export class NotificationStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #now: () => Date;

  constructor(database: Kysely<DatabaseSchema>, options: NotificationStoreOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async decide(event: AgentEvent): Promise<readonly DecidedNotification[]> {
    if (
      !mayNotify(event) ||
      Date.parse(event.createdAt) + notificationPushWindowMilliseconds <= this.#now().getTime()
    )
      return [];
    return withDatabaseTransaction(this.#database, async (transaction) =>
      (await candidatesFor(transaction, event)).map((candidate) => {
        const subjectId =
          candidate.kind === "reply-published"
            ? candidate.messageId
            : candidate.kind === "request-opened"
              ? candidate.requestId
              : candidate.runId;
        if (!subjectId)
          throw new OpensteerError({ code: "internal", message: "Notification lacks a subject" });
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
          view: NotificationViewSchema.parse({
            ...candidate,
            id,
            occurredAt: event.createdAt,
            threadId: event.threadId,
            workspaceId: event.workspaceId,
          }),
        };
      }),
    );
  }

  /**
   * Why a notification is no longer worth waking a phone for, or `null` while
   * it still is. The same facts the event decision used are read again,
   * because a reply can be read, a Request answered, a Workspace muted or a
   * membership ended while the publication waited.
   */
  async publicationSkipReason(entry: NotificationPublication): Promise<string | null> {
    if (entry.expiresAt.getTime() <= this.#now().getTime()) {
      return "Notification expired before it could be published";
    }
    const recipient = await this.#database
      .selectFrom("workspaceMemberships")
      .innerJoin("users", "users.id", "workspaceMemberships.userId")
      .leftJoin("agentNotificationMutes", (join) =>
        join
          .onRef("agentNotificationMutes.workspaceId", "=", "workspaceMemberships.workspaceId")
          .onRef("agentNotificationMutes.userId", "=", "workspaceMemberships.userId"),
      )
      .select("agentNotificationMutes.muted")
      .where("workspaceMemberships.workspaceId", "=", entry.workspaceId)
      .where("workspaceMemberships.userId", "=", entry.userId)
      .where("workspaceMemberships.state", "=", "active")
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
        if (recipient.muted) return "Workspace was muted before publication";
        if (!entry.messageId) return "Notification names no reply";
        const read = await this.#database
          .selectFrom("messages")
          .innerJoin("threadReadMarkers", (join) =>
            join
              .onRef("threadReadMarkers.threadId", "=", "messages.threadId")
              .on("threadReadMarkers.userId", "=", entry.userId),
          )
          .select("messages.id")
          .where("messages.id", "=", entry.messageId)
          .whereRef("threadReadMarkers.sequence", ">=", "messages.sequence")
          .executeTakeFirst();
        return read ? "Reply was read before publication" : null;
      }
      case "run-failed":
        return recipient.muted ? "Workspace was muted before publication" : null;
    }
  }

  /**
   * Host users are reached through their Opensteer Account, read at the moment
   * of publication because a person can link or lose one at any time.
   */
  async accountSubjects(userId: UserId): Promise<readonly string[]> {
    return withDatabaseTransaction(this.#database, (transaction) =>
      accountSubjectsForUsers(transaction, [userId]),
    );
  }
}

interface NotificationCandidate {
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
  event: AgentEvent,
): Promise<readonly NotificationCandidate[]> {
  switch (event.type) {
    case "request.opened":
      return requestCandidates(transaction, event);
    case "run.completed":
    case "run.phase": {
      const replyMessageId = replyMessageIdOf(event);
      return replyMessageId ? replyCandidates(transaction, event, replyMessageId) : [];
    }
    case "run.failed":
      // An engine that errors while winding down a stop somebody asked for
      // reports a failure the person did not wait on.
      return event.runId && (await runWasStopped(transaction, event.runId))
        ? []
        : failureCandidates(transaction, event, failureBody(event.data.message));
    case "run.interrupted":
      return interruptionCandidates(transaction, event);
    default:
      return [];
  }
}

async function requestCandidates(
  transaction: Transaction<DatabaseSchema>,
  event: Extract<AgentEvent, { readonly type: "request.opened" }>,
): Promise<readonly NotificationCandidate[]> {
  const parsed = RequestSchema.safeParse(event.data.request);
  if (!parsed.success) return [];
  const request: Request = parsed.data;
  // A Request answered between commit and this decision is no longer news.
  const current = await transaction
    .selectFrom("requests")
    .select("status")
    .where("id", "=", request.id)
    .executeTakeFirst();
  if (current?.status !== "pending") return [];
  const members = await activeMembers(transaction, event.workspaceId);
  const userIds = requestNotificationAudience({
    members,
    payload: request.payload,
    requestedBy: request.requestedBy,
    requiredActor: request.requiredActor,
  });
  if (userIds.length === 0) return [];
  const title = await threadTitle(transaction, event.threadId);
  if (!title) return [];
  const body =
    plainTextExcerpt(requestTitleText(request.presentation), notificationBodyMaxCharacters) ??
    "Opensteer needs your answer";
  return userIds.map((userId) => ({
    body,
    kind: "request-opened",
    messageId: null,
    requestId: request.id,
    runId: null,
    title,
    userId,
  }));
}

/**
 * A reply alerts the person a Run answers: not inside a task, whose reply
 * returns to the agent that assigned it and is relayed from there, and not in
 * a channel conversation, whose reply goes to Slack or iMessage instead.
 * Whoever or whatever started the Run — the person, a reminder, a task
 * result, an answered Request — the reply is Opensteer messaging them.
 */
async function replyCandidates(
  transaction: Transaction<DatabaseSchema>,
  event: AgentEvent,
  replyMessageId: MessageId,
): Promise<readonly NotificationCandidate[]> {
  const recipient = await personAnswered(transaction, event);
  if (!recipient || recipient.muted) return [];
  const reply = await transaction
    .selectFrom("messages")
    .leftJoin("threadReadMarkers", (join) =>
      join
        .onRef("threadReadMarkers.threadId", "=", "messages.threadId")
        .on("threadReadMarkers.userId", "=", recipient.userId),
    )
    .select(["messages.content", "messages.sequence", "threadReadMarkers.sequence as readSequence"])
    .where("messages.id", "=", replyMessageId)
    .where("messages.threadId", "=", event.threadId)
    .executeTakeFirst();
  if (!reply) return [];
  if (reply.readSequence !== null && BigInt(reply.readSequence) >= BigInt(reply.sequence)) {
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
      messageId: replyMessageId,
      requestId: null,
      runId: event.runId,
      title: recipient.title,
      userId: recipient.userId,
    },
  ];
}

async function failureCandidates(
  transaction: Transaction<DatabaseSchema>,
  event: AgentEvent,
  body: string,
): Promise<readonly NotificationCandidate[]> {
  const recipient = await personAnswered(transaction, event);
  if (!recipient || recipient.muted) return [];
  return [
    {
      body,
      kind: "run-failed",
      messageId: null,
      requestId: null,
      runId: event.runId,
      title: recipient.title,
      userId: recipient.userId,
    },
  ];
}

/**
 * A stop somebody asked for — the person, the task that assigned the work, or
 * the deadline on work left running — is not news. An interruption nobody
 * asked for, such as the Runner going away mid-turn, leaves a person waiting
 * on a reply that will not come, which is a failure as far as they can tell.
 */
async function interruptionCandidates(
  transaction: Transaction<DatabaseSchema>,
  event: AgentEvent,
): Promise<readonly NotificationCandidate[]> {
  if (!event.runId) return [];
  const run = await transaction
    .selectFrom("runs")
    .select(["backgroundDeadlineAt", "startedAt"])
    .where("id", "=", event.runId)
    .executeTakeFirst();
  if (!run?.startedAt || (await runWasStopped(transaction, event.runId))) return [];
  // A recovery can end work past its deadline with no stop to record: no
  // Runner held it to be told.
  if (run.backgroundDeadlineAt && run.backgroundDeadlineAt <= new Date(event.createdAt)) return [];
  return failureCandidates(transaction, event, "Opensteer stopped before it finished.");
}

/**
 * The person a Run answers, if it answers one directly and they can still
 * open its Thread: none for a task's Run, whose reply is the task's result for
 * its assigner, and none for a channel Run, which answers where it was asked.
 */
async function personAnswered(
  transaction: Transaction<DatabaseSchema>,
  event: AgentEvent,
): Promise<{ readonly muted: boolean; readonly title: string; readonly userId: UserId } | null> {
  if (!event.runId) return null;
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("workspaceMemberships", (join) =>
      join
        .onRef("workspaceMemberships.workspaceId", "=", "threads.workspaceId")
        .onRef("workspaceMemberships.userId", "=", "runs.requestedBy"),
    )
    .innerJoin("users", "users.id", "runs.requestedBy")
    .leftJoin("agentNotificationMutes", (join) =>
      join
        .onRef("agentNotificationMutes.workspaceId", "=", "threads.workspaceId")
        .onRef("agentNotificationMutes.userId", "=", "runs.requestedBy"),
    )
    .select([
      "runs.assignmentId",
      "runs.replyTarget",
      "runs.requestedBy",
      "agentNotificationMutes.muted",
    ])
    .where("runs.id", "=", event.runId)
    .where("runs.threadId", "=", event.threadId)
    .where("threads.workspaceId", "=", event.workspaceId)
    .where("workspaceMemberships.state", "=", "active")
    .where("users.disabledAt", "is", null)
    .executeTakeFirst();
  if (!run || run.assignmentId !== null || run.replyTarget !== null) return null;
  const title = await threadTitle(transaction, event.threadId);
  if (!title) return null;
  return { muted: run.muted === true, title, userId: run.requestedBy };
}

/** "Opensteer" for the person's Chat; the Thread's own title anywhere else. */
async function threadTitle(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<string | null> {
  const thread = await transaction
    .selectFrom("threads")
    .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
    .select(["threads.title", "workspaces.kind", "workspaces.homeThreadId"])
    .where("threads.id", "=", threadId)
    .executeTakeFirst();
  if (!thread) return null;
  if (thread.kind === "main" && thread.homeThreadId === threadId) return "Opensteer";
  return plainTextExcerpt(thread.title, notificationTitleMaxCharacters) ?? "Opensteer";
}

/** The reply a completed Run, or a turn that left work running, ended with. */
function replyMessageIdOf(event: AgentEvent): MessageId | null {
  if (event.type === "run.completed") return event.data.replyMessageId;
  if (event.type === "run.phase" && event.data.phase === "background") {
    return event.data.replyMessageId ?? null;
  }
  return null;
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

async function activeMembers(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<readonly NotificationAudienceMember[]> {
  return transaction
    .selectFrom("workspaceMemberships")
    .innerJoin("users", "users.id", "workspaceMemberships.userId")
    .select([
      "users.instanceRole as instanceRole",
      "workspaceMemberships.role as role",
      "workspaceMemberships.userId as userId",
    ])
    .where("workspaceMemberships.workspaceId", "=", workspaceId)
    .where("workspaceMemberships.state", "=", "active")
    .where("users.disabledAt", "is", null)
    .limit(1_000)
    .execute();
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

/**
 * A Personal Deployment's Account identity, and whose it is.
 *
 * The link belongs to the one person who could make it: linking requires a
 * machine-local owner session, and that owner is the single administrator this
 * Host has. Mapping any other user to the link would hand somebody else's
 * phone a Deployment they merely have membership in, so the administrator is
 * checked rather than assumed even though a Personal Host has one user.
 */
async function personalLinkSubjectForOwner(
  transaction: Transaction<DatabaseSchema>,
  userIds: readonly UserId[],
  issuer?: string,
): Promise<string | null> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (deployment?.deploymentShape.kind !== "personal") return null;
  const owner = await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "in", [...userIds])
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null)
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
