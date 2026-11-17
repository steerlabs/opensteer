import {
  OpensteerError,
  type CommandId,
  type ExecutionNodeId,
  type GrantId,
  type MessageId,
  type ProviderSessionId,
  type RequestId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { sql } from "kysely";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import { uncertainEarlierRun, type FinishIntent } from "./personal-state-schema.js";

type Tx = PersonalMutationTransaction;

export async function hasUncertainEarlierExecution(
  tx: Tx,
  input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly runOrdinal: number;
    readonly stateLayout: "thread" | "session";
    readonly hasNativeReference: boolean;
  },
) {
  const prior = tx
    .selectFrom("runs")
    .select("id")
    .where("runOrdinal", "<", input.runOrdinal)
    .$if(input.stateLayout === "thread", (query) => query.where("threadId", "=", input.threadId))
    .$if(input.stateLayout === "session", (query) =>
      query.where("providerSessionId", "=", input.providerSessionId),
    )
    .limit(1);
  if (await prior.where(sql<boolean>`${sql.raw(uncertainEarlierRun)}`).executeTakeFirst())
    return true;
  if (input.hasNativeReference) return false;
  if (await prior.where("startedAt", "is not", null).executeTakeFirst()) return true;
  return (
    input.stateLayout === "thread" &&
    Boolean(
      await tx
        .selectFrom("providerSessions")
        .select("id")
        .where("threadId", "=", input.threadId)
        .where("id", "!=", input.providerSessionId)
        .where("providerSessionReference", "is not", null)
        .limit(1)
        .executeTakeFirst(),
    )
  );
}

export async function refreshExecuteClaimProof(tx: Tx, runId: RunId) {
  const proof = await tx
    .selectFrom("commands")
    .select("id")
    .where("runId", "=", runId)
    .where("type", "=", "run.execute")
    .limit(1)
    .where("attempts", "=", 0)
    .executeTakeFirst();
  const found =
    proof ||
    (await tx
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .limit(1)
      .executeTakeFirst());
  await tx
    .updateTable("runs")
    .set({ executeClaimState: proof ? "unclaimed" : found ? "claimed" : "not-created" })
    .where("id", "=", runId)
    .execute();
}

export async function readFinishChildren(tx: Tx, runId: RunId) {
  let remaining = 128;
  let hasMore = false;
  async function pick<Id>(seek: (limit: number) => Promise<readonly { id: Id }[]>) {
    if (hasMore) return [];
    const rows = await seek(remaining + 1);
    hasMore = rows.length > remaining;
    const ids = rows.slice(0, remaining).map((row) => row.id);
    remaining -= ids.length;
    return ids;
  }
  const requests: RequestId[] = await pick((limit) =>
    tx
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", runId)
      .where("status", "=", "pending")
      .where((eb) => eb.or([eb("mode", "=", "live"), eb("kind", "=", "integration.input")]))
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  const commands: CommandId[] = await pick((limit) =>
    tx
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where(sql<boolean>`status in ('pending','dispatched')`)
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  const steers: MessageId[] = await pick((limit) =>
    tx
      .selectFrom("threadInputs")
      .select("messageId as id")
      .where("runId", "=", runId)
      .where(sql<boolean>`state='pending' and steer_command_id is not null`)
      .orderBy("messageId")
      .limit(limit)
      .execute(),
  );
  const nodes: ExecutionNodeId[] = await pick((limit) =>
    tx
      .selectFrom("executionNodes")
      .select("id")
      .where("runId", "=", runId)
      .where(sql<boolean>`status='running'`)
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  const grants: GrantId[] = await pick((limit) =>
    tx
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", runId)
      .where(sql<boolean>`status='active'`)
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  const tools = await pick((limit) =>
    tx
      .selectFrom("toolCalls")
      .select("id")
      .where("runId", "=", runId)
      .where(sql<boolean>`status='open'`)
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  return { requests, commands, steers, nodes, grants, tools, hasMore };
}

export async function beginPersonalRunFinish(
  tx: Tx,
  mutation: PersonalMutation,
  input: { readonly runId: RunId; readonly intent: FinishIntent },
) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "threadId", "finishIntent", "bindingGeneration"])
    .where("id", "=", input.runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const bound = run.bindingGeneration === input.intent.bindingGeneration;
  if (!bound)
    throw new OpensteerError({
      code: "conflict",
      message: "Run binding changed before finalization",
    });
  if (run.finishIntent) {
    const previous = run.finishIntent.statement;
    const submitted = input.intent.statement;
    if (
      previous &&
      (!submitted ||
        previous.runnerId !== submitted.runnerId ||
        previous.runnerBootId !== submitted.runnerBootId ||
        previous.ordinal !== submitted.ordinal ||
        previous.digest !== submitted.digest)
    )
      throw new OpensteerError({
        code: "conflict",
        message: "Run already has a terminal statement",
      });
    return run.finishIntent;
  }
  await tx
    .updateTable("runs")
    .set({ finishIntent: input.intent, revision: mutation.sequence })
    .where("id", "=", input.runId)
    .execute();
  mutation.fence(`thread:${run.threadId}`);
  mutation.change(
    {
      scopeKey: `thread:${run.threadId}`,
      entityKind: "collection",
      entityId: "run-queue",
      operation: "invalidate",
    },
    () => ({ revision: mutation.sequence }),
  );
  return input.intent;
}
