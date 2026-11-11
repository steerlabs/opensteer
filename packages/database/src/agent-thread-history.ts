import { assertActiveProjectBinding } from "./execution-authority.js";
import type { ProjectRunBinding, RunnerId } from "@opensteer/core";
import {
  MessageIdSchema,
  OpensteerError,
  SequenceSchema,
  compareSequence,
  type MessageId,
  type RunId,
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

type MessageMarker = "message.created" | "message.placed";
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
      | "thread.execution-updated"
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
// Every message has a `message.created`, assistant replies included.
const markers: readonly MessageMarker[] = ["message.created", "message.placed"];
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

const emptyActivity = {
  items: [],
  starts: [],
  requesters: new Map<RunId, UserId>(),
  nodeTitles: new Map<string, string>(),
  hasMore: false,
  nextBefore: null,
};

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

type ThreadActivityQuery = {
  readonly threadId: ThreadId;
  readonly limit: number;
  readonly before?: string;
  readonly itemId?: string;
};

export async function readAgentThreadActivity(
  database: Kysely<DatabaseSchema>,
  input: ThreadActivityQuery & { readonly ownerId: UserId },
) {
  return readThreadActivity(database, input, (tx) => canRead(tx, input.threadId, input.ownerId));
}

export async function readProjectThreadActivity(
  database: Kysely<DatabaseSchema>,
  input: ThreadActivityQuery & { readonly binding: ProjectRunBinding },
  runnerIsAttached: (runnerId: RunnerId, bootId: string) => boolean,
) {
  if (input.binding.workspaceId !== input.binding.authority.principal.workspaceId)
    throw new OpensteerError({ code: "forbidden", message: "Thread is outside this Project" });
  await assertActiveProjectBinding(database, input.binding, { runnerIsAttached });
  return readThreadActivity(
    database,
    input,
    async (tx) => {
      await assertActiveProjectBinding(tx, input.binding, { runnerIsAttached });
      return tx
        .selectFrom("threads")
        .select("id")
        .where("id", "=", input.threadId)
        .where("workspaceId", "=", input.binding.workspaceId)
        .executeTakeFirst();
    },
    true,
  );
}

async function readThreadActivity(
  database: Kysely<DatabaseSchema>,
  input: ThreadActivityQuery,
  authorize: (tx: Transaction<DatabaseSchema>) => Promise<{ readonly id: ThreadId } | undefined>,
  projectRequestFacts = false,
) {
  const before = input.before === undefined ? null : SequenceSchema.safeParse(input.before);
  if (before && (!before.success || BigInt(before.data) > maximumEventSequence))
    throw new OpensteerError({ code: "bad_request", message: "Activity cursor is invalid" });
  return withDatabaseTransaction(
    database,
    async (tx) => {
      if (!(await authorize(tx))) return null;
      const messageId = input.itemId ? MessageIdSchema.safeParse(input.itemId) : null;
      const sequence = input.itemId ? SequenceSchema.safeParse(input.itemId) : null;
      const markerId = sql<MessageId>`e.data->'message'->>'id'`;
      let candidates = tx
        .selectFrom("workspaceEvents as e")
        .where("e.threadId", "=", input.threadId)
        .where("e.type", "in", projectRequestFacts ? [...types, "thread.execution-updated"] : types)
        .$if(projectRequestFacts, (query) =>
          query.where(sql<boolean>`
          (e.type <> 'thread.execution-updated' or e.data ? 'requestFact') and
          (e.type not in ('request.opened','request.resolved') or not exists (
            select 1 from workspace_events marker where marker.thread_id = e.thread_id
              and marker.type = 'thread.execution-updated'
              and marker.data->'requestFact'->>'requestId' = e.data->'request'->>'id'
              and marker.data->'requestFact'->>'type' = case when e.type = 'request.opened' then 'opened' else 'resolved' end))`),
        )
        .where((eb) =>
          eb.or([
            eb("e.type", "not in", markers),
            eb.exists(
              eb
                .selectFrom("messages as m")
                .leftJoin("threadInputs as i", "i.messageId", "m.id")
                .select("m.id")
                .where("m.threadId", "=", input.threadId)
                .where("m.id", "=", markerId)
                .where(publishedMessagePredicate("i")),
            ),
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
        else return emptyActivity;
      }
      // Message markers carry copies of content; only the published message row is read.
      const projected = sql<unknown>`case
      when e.type in ('message.created','message.placed') then jsonb_build_object('messageId',${markerId})
      when e.type = 'tool.started' and ${!input.itemId} then e.data - 'arguments' || '{"arguments":null}'::jsonb
      else e.data end`;
      const metadata = await candidates
        .select([
          "e.sequence",
          sql<number>`octet_length((${projected})::text) + case when e.type in ('message.created','message.placed') then coalesce((select octet_length(m.content::text) from messages m where m.id = ${markerId} and m.thread_id = ${input.threadId}),0) else 0 end`.as(
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
      if (!selected.length) return emptyActivity;
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
      // A queued message is placed again later, and sits where it was last placed.
      const placed = ids.length
        ? await tx
            .selectFrom("workspaceEvents as e")
            .select([markerId.as("id"), sql<Sequence>`max(e.sequence)`.as("sequence")])
            .where("e.threadId", "=", input.threadId)
            .where("e.type", "=", "message.placed")
            .where(markerId, "in", ids)
            .groupBy(markerId)
            .execute()
        : [];
      const lastPlaced = new Map(placed.map((row) => [row.id, row.sequence]));
      const items: AgentThreadActivityItem[] = rows.flatMap<AgentThreadActivityItem>((row) => {
        if (markers.includes(row.type as MessageMarker)) {
          const id = MessageIdSchema.parse((row.data as { messageId: unknown }).messageId);
          const message = byId.get(id);
          const sequence = SequenceSchema.parse(row.sequence);
          const moved = lastPlaced.get(id);
          return message && (!moved || compareSequence(moved, sequence) <= 0)
            ? [{ type: "message" as const, sequence, message }]
            : [];
        }
        return [eventFromRow(row) as ActivityEvent];
      });
      const runIds = [...new Set(rows.flatMap((r) => (r.runId ? [r.runId] : [])))];
      const nodeIds = items.flatMap((item) =>
        item.type === "node.completed" ? [item.data.nodeId] : [],
      );
      const [requesters, nodes] = await Promise.all([
        runIds.length
          ? tx.selectFrom("runs").select(["id", "requestedBy"]).where("id", "in", runIds).execute()
          : [],
        nodeIds.length
          ? tx
              .selectFrom("executionNodes")
              .select(["id", "title"])
              .where("id", "in", nodeIds)
              .execute()
          : [],
      ]);
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
        requesters: new Map(requesters.map((run) => [run.id, run.requestedBy])),
        nodeTitles: new Map(nodes.map((node) => [node.id, node.title])),
        hasMore: metadata.length > selected.length,
        nextBefore: metadata.length > selected.length ? selected.at(-1)! : null,
      };
    },
    "repeatable read",
  );
}
