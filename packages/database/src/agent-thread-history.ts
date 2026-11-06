import {
  MessageIdSchema,
  OpensteerError,
  SequenceSchema,
  type MessageId,
  type AgentEvent,
  type Message,
  type Sequence,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema, WorkspaceEventRow } from "./schema.js";
import { eventFromRow } from "./store-primitives.js";
import { messageFromRow } from "./thread-row-mappers.js";
import { publishedMessagePredicate } from "./message-visibility.js";
import { databaseOperationOptions } from "./operation-budget.js";

type MessageMarker = "message.created" | "message.placed" | "assistant.message";
type ActivityEvent = Extract<
  AgentEvent,
  {
    type:
      | "tool.started"
      | "tool.completed"
      | "place.entered"
      | "app.published"
      | "request.opened"
      | "request.resolved"
      | "request.cancelled"
      | "node.started"
      | "node.completed";
  }
>;
export type AgentThreadActivityItem =
  | ActivityEvent
  | {
      readonly type: "message";
      readonly sequence: Sequence;
      readonly message: Message;
    };
const maximumEventSequence = 9_223_372_036_854_775_807n;
const markers: readonly MessageMarker[] = [
  "message.created",
  "message.placed",
  "assistant.message",
];
const types = [
  ...markers,
  "tool.started",
  "tool.completed",
  "place.entered",
  "app.published",
  "request.opened",
  "request.resolved",
  "request.cancelled",
  "node.started",
  "node.completed",
] as const;

async function canRead(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
) {
  return transaction
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .select("threads.id")
    .where("threads.id", "=", threadId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst();
}

export async function readAgentThreadRecent(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly ownerId: UserId;
    readonly runLimit: number;
  },
) {
  return withDatabaseTransaction(
    database,
    async (tx) => {
      if (!(await canRead(tx, input.threadId, input.ownerId))) return null;
      const runs = await tx
        .selectFrom("runs")
        .select([
          "id as runId",
          "status",
          "assignmentId",
          "modelSelection",
          "createdAt",
          "startedAt",
          "completedAt",
        ])
        .where("threadId", "=", input.threadId)
        .orderBy("runOrdinal", "desc")
        .limit(Math.min(50, Math.max(1, input.runLimit)))
        .execute();
      const places = await tx
        .selectFrom((eb) =>
          eb
            .selectFrom("runs")
            .select("id")
            .where("threadId", "=", input.threadId)
            .orderBy("runOrdinal", "desc")
            .limit(25)
            .as("recent"),
        )
        .innerJoinLateral(
          (eb) =>
            eb
              .selectFrom("workspaceEvents")
              .selectAll()
              .whereRef("workspaceEvents.runId", "=", "recent.id")
              .where("type", "=", "place.entered")
              .orderBy("sequence", "desc")
              .limit(8)
              .as("places"),
          (join) => join.onTrue(),
        )
        .selectAll("places")
        .orderBy("places.sequence", "desc")
        .execute();
      return {
        runs: runs.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          completedAt: r.completedAt?.toISOString() ?? null,
        })),
        places: places
          .map(eventFromRow)
          .filter(
            (e): e is Extract<AgentEvent, { type: "place.entered" }> => e.type === "place.entered",
          ),
      };
    },
    "repeatable read",
  );
}

export async function readAgentThreadActivity(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly ownerId: UserId;
    readonly limit: number;
    readonly before?: string;
    readonly itemId?: string;
  },
) {
  const before = input.before === undefined ? null : SequenceSchema.safeParse(input.before);
  if (before && (!before.success || BigInt(before.data) > maximumEventSequence))
    throw new OpensteerError({ code: "bad_request", message: "Activity cursor is invalid" });
  return withDatabaseTransaction(
    database,
    async (tx) => {
      if (!(await canRead(tx, input.threadId, input.ownerId))) return null;
      const messageId = input.itemId ? MessageIdSchema.safeParse(input.itemId) : null;
      const sequence = input.itemId ? SequenceSchema.safeParse(input.itemId) : null;
      const markerId = sql<MessageId>`coalesce(e.data->>'messageId', e.data->'message'->>'id')`;
      let candidates = tx
        .selectFrom("workspaceEvents as e")
        .where("e.threadId", "=", input.threadId)
        .where("e.type", "in", types)
        .where((eb) =>
          eb.or([
            eb("e.type", "not in", markers),
            eb.and([
              eb.exists(
                eb
                  .selectFrom("messages as m")
                  .leftJoin("threadInputs as i", "i.messageId", "m.id")
                  .select("m.id")
                  .where("m.threadId", "=", input.threadId)
                  .where("m.id", "=", markerId)
                  .where(publishedMessagePredicate("i")),
              ),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("workspaceEvents as newer")
                    .select("newer.sequence")
                    .where("newer.threadId", "=", input.threadId)
                    .where("newer.type", "in", markers)
                    .whereRef("newer.sequence", ">", "e.sequence")
                    .where(
                      sql<boolean>`coalesce(newer.data->>'messageId',newer.data->'message'->>'id') = ${markerId}`,
                    ),
                ),
              ),
            ]),
          ]),
        );
      if (before?.success) candidates = candidates.where("e.sequence", "<", before.data);
      if (input.itemId) {
        if (messageId?.success)
          candidates = candidates
            .where("e.type", "in", markers)
            .where(markerId, "=", messageId.data);
        else if (sequence?.success && BigInt(sequence.data) <= maximumEventSequence)
          candidates = candidates.where("e.sequence", "=", sequence.data);
        else return { items: [], starts: [], hasMore: false, nextBefore: null };
      }
      // Message markers carry copies of content; only the published message row is read.
      const projected = sql<unknown>`case
      when e.type in ('message.created','message.placed','assistant.message') then jsonb_build_object('messageId',${markerId})
      when e.type = 'tool.started' and ${!input.itemId} then e.data - 'arguments' || '{"arguments":null}'::jsonb
      else e.data end`;
      const metadata = await candidates
        .select([
          "e.sequence",
          sql<number>`octet_length((${projected})::text) + case when e.type in ('message.created','message.placed','assistant.message') then coalesce((select octet_length(m.content::text) from messages m where m.id = ${markerId} and m.thread_id = ${input.threadId}),0) else 0 end`.as(
            "bytes",
          ),
        ])
        .orderBy("e.sequence", "desc")
        .limit(Math.min(100, Math.max(1, input.limit)) + 1)
        .execute();
      let bytes = 2;
      const selected = [];
      for (const row of metadata.slice(0, Math.min(100, Math.max(1, input.limit)))) {
        if (selected.length && bytes + Number(row.bytes) > 640 * 1024) break;
        selected.push(row.sequence);
        bytes += Number(row.bytes) + 512;
      }
      if (!selected.length) return { items: [], starts: [], hasMore: false, nextBefore: null };
      const rows = await tx
        .selectFrom("workspaceEvents as e")
        .selectAll("e")
        .select(projected.as("data"))
        .where("e.sequence", "in", selected)
        .where("e.threadId", "=", input.threadId)
        .orderBy("e.sequence", "desc")
        .execute();
      const markerRows = rows.filter((r) => markers.includes(r.type as MessageMarker));
      const ids = markerRows.map((r) =>
        MessageIdSchema.parse((r.data as { messageId: unknown }).messageId),
      );
      const messages = ids.length
        ? await tx
            .selectFrom("messages")
            .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
            .selectAll("messages")
            .where("messages.threadId", "=", input.threadId)
            .where("messages.id", "in", ids)
            .where(publishedMessagePredicate("threadInputs"))
            .execute()
        : [];
      const byId = new Map(messages.map((r) => [r.id, messageFromRow(r)]));
      const items: AgentThreadActivityItem[] = rows.flatMap<AgentThreadActivityItem>((row) => {
        if (markers.includes(row.type as MessageMarker)) {
          const message = byId.get(
            MessageIdSchema.parse((row.data as { messageId: unknown }).messageId),
          );
          return message
            ? [{ type: "message" as const, sequence: SequenceSchema.parse(row.sequence), message }]
            : [];
        }
        return [eventFromRow(row) as ActivityEvent];
      });
      const completions = rows.filter((r) => r.type === "tool.completed").map((r) => r.sequence);
      const starts = completions.length
        ? (
            await sql<WorkspaceEventRow & { completionSequence: Sequence }>`
      select distinct on (c.sequence) c.sequence as completion_sequence, s.*, s.data - 'arguments' || '{"arguments":null}'::jsonb as data
      from workspace_events c join workspace_events s on s.run_id = c.run_id
        and s.type = 'tool.started' and s.sequence < c.sequence
        and s.runner_binding_generation is not distinct from c.runner_binding_generation
        and s.data->>'callId' = c.data->>'callId'
        and coalesce(s.data->>'nodeId','') = coalesce(c.data->>'nodeId','')
      where c.thread_id = ${input.threadId} and c.sequence in (${sql.join(completions)})
      order by c.sequence, s.sequence desc
    `.execute(tx, databaseOperationOptions())
          ).rows.map((row) => ({
            completionSequence: row.completionSequence,
            start: eventFromRow(row) as Extract<AgentEvent, { type: "tool.started" }>,
          }))
        : [];
      return {
        items,
        starts,
        hasMore: metadata.length > selected.length,
        nextBefore: metadata.length > selected.length ? selected.at(-1)! : null,
      };
    },
    "repeatable read",
  );
}
