export { lockDeploymentEvents } from "./personal-transaction.js";
import { latestRunCompletion } from "./thread-visits.js";
import { markThreadStatePending } from "./thread-state-pending.js";
import { recordPersonWaited } from "./run-visibility.js";
import { MessageAuthorSchema, type RunId } from "@opensteer/core";
import {
  AgentEventSchema,
  OpensteerError,
  SequenceSchema,
  createId,
  nodeDetailEventNodeId,
  type AgentEvent,
  type DeploymentId,
  type Sequence,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { lockDeploymentEvents } from "./personal-transaction.js";
import type { DatabaseSchema, DeploymentEventRow } from "./schema.js";

export type HostDeploymentEventInput = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, "createdAt" | "eventId" | "sequence" | "data"> & {
        readonly data: Omit<Event["data"], "startedBy" | "startedAt" | "personWaiting"> &
          Partial<Event["data"]>;
      }
    : never
  : never;

export async function appendHostDeploymentEvent(
  transaction: Transaction<DatabaseSchema>,
  input: HostDeploymentEventInput,
): Promise<AgentEvent> {
  await lockDeploymentEvents(transaction);
  const state = await transaction
    .updateTable("deploymentEventState")
    .set({ sequence: sql<string>`sequence + 1` })
    .returningAll()
    .executeTakeFirstOrThrow();
  const createdAt = new Date();
  if (input.type === "thread.state-changed") {
    const row = await transaction
      .selectNoFrom(latestRunCompletion(sql`${input.threadId}`).as("completedAt"))
      .executeTakeFirstOrThrow();
    input = {
      ...input,
      data: { ...input.data, latestRunCompletedAt: row.completedAt?.toISOString() ?? null },
    };
  }
  const event = AgentEventSchema.parse({
    ...input,
    data: await stampRunContext(transaction, input.type, input.runId, input.data),
    createdAt: createdAt.toISOString(),
    eventId: createId("event"),
    sequence: state.sequence,
  });
  await transaction
    .insertInto("deploymentEvents")
    .values({
      deploymentId: state.deploymentId,
      sequence: state.sequence,
      eventId: event.eventId,
      nodeDetailId: nodeDetailEventNodeId(event) ?? null,
      threadId: event.threadId,
      runId: event.runId,
      environmentId: event.environmentId,
      type: event.type,
      data: sql`${JSON.stringify(event.data)}::jsonb`,
      runnerId: null,
      runnerBootId: null,
      runnerBindingGeneration: null,
      runnerOrdinal: null,
      createdAt,
    })
    .executeTakeFirstOrThrow();
  if (event.type.startsWith("request.")) await markThreadStatePending(transaction, event.threadId);
  return event;
}

export function eventFromRow(row: DeploymentEventRow): AgentEvent {
  return AgentEventSchema.parse({
    createdAt: row.createdAt.toISOString(),
    data: row.data,
    environmentId: row.environmentId,
    eventId: row.eventId,
    runId: row.runId,
    sequence: row.sequence,
    threadId: row.threadId,
    type: row.type,
  });
}

export async function deploymentHead(database: Kysely<DatabaseSchema>): Promise<Sequence> {
  const row = await database
    .selectFrom("deploymentEventState")
    .select("sequence")
    .executeTakeFirstOrThrow();
  return SequenceSchema.parse(row.sequence);
}

export async function deploymentEventsAfter(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly deploymentId: DeploymentId;
    readonly afterSequence: Sequence;
    readonly maxItems?: number;
    readonly maxBytes?: number;
    readonly throughSequence?: Sequence;
  },
) {
  const maxItems = Math.min(500, input.maxItems ?? 500);
  const maxBytes = Math.min(8 * 1024 * 1024, input.maxBytes ?? 256 * 1024);
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new OpensteerError({ code: "bad_request", message: "Invalid event replay bounds." });
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (transaction) => {
      const state = await transaction
        .selectFrom("deploymentEventState")
        .selectAll()
        .executeTakeFirstOrThrow();
      const after = BigInt(SequenceSchema.parse(input.afterSequence));
      const through = input.throughSequence ?? SequenceSchema.parse(state.sequence);
      if (
        state.deploymentId !== input.deploymentId ||
        after > BigInt(through) ||
        BigInt(through) > BigInt(state.sequence)
      )
        return {
          resync: true as const,
          events: [],
          byteCount: 2,
          throughSequence: SequenceSchema.parse(state.sequence),
          hasMore: false,
        };
      const first = await transaction
        .selectFrom("deploymentEvents")
        .select("sequence")
        .orderBy("sequence")
        .limit(1)
        .executeTakeFirst();
      if (first ? after < BigInt(first.sequence) - 1n : after < BigInt(through))
        return {
          resync: true as const,
          events: [],
          byteCount: 2,
          throughSequence: SequenceSchema.parse(state.sequence),
          hasMore: false,
        };
      const rows = await transaction
        .selectFrom("deploymentEvents")
        .selectAll()
        .where("deploymentId", "=", input.deploymentId)
        .where("sequence", ">", input.afterSequence)
        .where("sequence", "<=", through)
        .orderBy("sequence")
        .limit(maxItems + 1)
        .execute();
      const events: AgentEvent[] = [];
      let bytes = 2;
      for (const row of rows.slice(0, maxItems)) {
        const event = eventFromRow(row);
        const nextBytes =
          bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + (events.length ? 1 : 0);
        if (nextBytes > maxBytes) break;
        bytes = nextBytes;
        events.push(event);
      }
      if (rows.length && !events.length)
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "A durable event exceeds the requested replay byte limit.",
        });
      const hasMore = events.length < rows.length;
      return {
        resync: false as const,
        events,
        byteCount: bytes,
        throughSequence: events.at(-1)?.sequence ?? input.afterSequence,
        hasMore,
      };
    });
}

export async function stampRunContext(
  transaction: Transaction<DatabaseSchema>,
  type: string,
  runId: RunId | null,
  data: object,
): Promise<object> {
  if (
    ![
      "run.started",
      "run.status",
      "run.restarted",
      "run.phase",
      "run.completed",
      "run.failed",
      "run.interrupted",
    ].includes(type)
  )
    return data;
  if (runId === null) throw new Error("Run lifecycle event has no Run");
  await recordPersonWaited(transaction, runId);
  const seed = await transaction
    .selectFrom("runs")
    .innerJoin("messages", "messages.id", "runs.seedInputId")
    .select(["messages.author", "runs.createdAt", "runs.personWaited"])
    .select(
      sql<boolean>`exists (
      select 1 from messages input where input.run_id = runs.id
      and input.kind = 'input' and input.author->>'kind' = 'human'
    )`.as("personWaiting"),
    )
    .where("runs.id", "=", runId)
    .executeTakeFirstOrThrow();
  const startedBy = MessageAuthorSchema.parse(seed.author);
  return {
    ...data,
    startedBy,
    startedAt: seed.createdAt.toISOString(),
    personWaiting: startedBy.kind === "human" || seed.personWaiting || seed.personWaited,
  };
}
