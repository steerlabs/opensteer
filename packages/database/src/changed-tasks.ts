import type { ThreadDoneBy, ThreadId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import { publishedMessagePredicate } from "./message-visibility.js";
import type { DatabaseSchema } from "./schema.js";

export interface ChangedTaskSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly count: number;
  readonly first: Date | null;
  readonly questionsAnswered: number;
  readonly questionsDismissed: number;
  readonly doneAt: Date | null;
  readonly doneBy: ThreadDoneBy | null;
  readonly newest: Date;
}

/**
 * Tasks with meaningful new activity after `since`, shared by `opensteer_task_list changedSince`
 * and memory pass wakes:
 * - published non-continuation messages (dated by delivery for queued inputs),
 * - settled `person.question` Requests (`fulfilled` or `declined`), and
 * - non-quiet task-Done transitions.
 *
 * Passive reads (`thread.visit` / `lastVisitedAt`) and quiet auto-Done are intentionally excluded.
 */
export function changedTasksSubquery(
  transaction: Transaction<DatabaseSchema>,
  since: Date,
  options: { readonly excludeSystemWorkers?: boolean } = {},
) {
  const excludeSystemWorkers = options.excludeSystemWorkers === true;
  const changedMessageAt = sql<Date>`coalesce(thread_inputs.updated_at, messages.created_at)`;

  let messageRows = transaction
    .selectFrom("messages")
    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .select(({ fn }) => [
      "messages.threadId",
      fn.countAll<string>().as("newMessages"),
      sql<Date>`min(messages.created_at)`.as("firstNewAt"),
      sql<Date>`max(${changedMessageAt})`.as("lastMessageAt"),
    ])
    .where(
      "messages.id",
      "in",
      transaction
        .selectFrom("messages")
        .select("id")
        .where("createdAt", ">", since)
        .union(
          transaction
            .selectFrom("threadInputs")
            .select("messageId as id")
            .where("updatedAt", ">", since),
        ),
    )
    .where("messages.kind", "!=", "continuation")
    .where(publishedMessagePredicate("threadInputs"))
    .where(changedMessageAt, ">", since);

  if (excludeSystemWorkers) {
    messageRows = messageRows.where(
      sql<boolean>`coalesce(messages.author->>'threadId', '') not in (
        select anchor_thread_id from triggers
        where system_role is not null
      )`,
    );
  }

  const msgSub = messageRows.groupBy("messages.threadId").as("changed_messages");

  const questionSub = transaction
    .selectFrom("requests")
    .select([
      "requests.originatingThreadId as threadId",
      sql<string>`count(*) filter (where requests.status = 'fulfilled')`.as("questionsAnswered"),
      sql<string>`count(*) filter (where requests.status = 'declined')`.as("questionsDismissed"),
      sql<Date>`max(requests.resolved_at)`.as("lastQuestionAt"),
    ])
    .where("requests.kind", "=", "person.question")
    .where("requests.status", "in", ["fulfilled", "declined"])
    .where("requests.resolvedAt", ">", since)
    .groupBy("requests.originatingThreadId")
    .as("changed_questions");

  const doneSince = sql<Date | null>`case when threads.done_at > ${since} and threads.done_reason is distinct from 'quiet' then threads.done_at end`;
  const newest = sql<Date>`greatest(changed_messages.last_message_at, changed_questions.last_question_at, ${doneSince})`;

  let query = transaction
    .selectFrom("threads")
    .leftJoin(msgSub, (join) => join.onRef("changed_messages.threadId", "=", "threads.id"))
    .leftJoin(questionSub, (join) => join.onRef("changed_questions.threadId", "=", "threads.id"))
    .select([
      "threads.id as threadId",
      "threads.title",
      sql<string>`coalesce(changed_messages.new_messages, 0)`.as("newMessages"),
      sql<Date | null>`changed_messages.first_new_at`.as("firstNewAt"),
      sql<string>`coalesce(changed_questions.questions_answered, 0)`.as("questionsAnswered"),
      sql<string>`coalesce(changed_questions.questions_dismissed, 0)`.as("questionsDismissed"),
      doneSince.as("doneSinceAt"),
      sql<ThreadDoneBy | null>`case when threads.done_at > ${since} and threads.done_reason is distinct from 'quiet' then threads.done_by end`.as(
        "doneSinceBy",
      ),
      newest.as("newest"),
      // Milliseconds, as cursors carry; the bound itself compares at full precision.
      sql<Date>`date_trunc('milliseconds', ${newest})`.as("lastNewAt"),
    ])
    .where("threads.removedAt", "is", null)
    .where(
      sql<boolean>`(changed_messages.thread_id is not null or changed_questions.thread_id is not null or (threads.done_at > ${since} and threads.done_reason is distinct from 'quiet'))`,
    );

  if (excludeSystemWorkers) {
    query = query.where(
      "threads.id",
      "not in",
      transaction
        .selectFrom("triggers")
        .select("anchorThreadId")
        .where("systemRole", "is not", null),
    );
  }

  return query;
}
