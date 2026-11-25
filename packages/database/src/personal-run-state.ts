import {
  OpensteerError,
  RunFailureSchema,
  utf8Prefix,
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

import { recordFinishedRunnerStatement } from "./personal-runner-receipts.js";
import { storableText } from "./storable-json.js";
import { publishTranscriptRun } from "./execution-changes.js";
import { publishRunQueue, publishThreadSummary } from "./thread-status.js";

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

export async function readFinishChildren(
  tx: Tx,
  runId: RunId,
  steer?: Pick<FinishIntent, "attemptId" | "bindingGeneration">,
) {
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
  const requests: RequestId[] = steer
    ? []
    : await pick((limit) =>
        tx
          .selectFrom("requests")
          .select("id")
          .where("originatingRunId", "=", runId)
          .where("status", "=", "pending")
          .where((eb) =>
            eb.or([
              eb("mode", "=", "live"),
              // A command the Run proposed ends with it: its proposer no longer stands (D5).
              eb("command", "is not", null),
              eb.and([
                eb("kind", "in", ["plugin.approval", "plugin.input"]),
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom("pluginExecutions")
                      .select("id")
                      .whereRef("pluginExecutions.requestId", "=", "requests.id")
                      .where("handoff", "=", true),
                  ),
                ),
              ]),
            ]),
          )
          .orderBy("id")
          .limit(limit)
          .execute(),
      );
  const steers: MessageId[] = steer
    ? []
    : await pick((limit) =>
        tx
          .selectFrom("threadInputs")
          .select("messageId as id")
          .where("runId", "=", runId)
          .where(sql<boolean>`state='claimed' and steer_command_id is not null`)
          .orderBy("messageId")
          .limit(limit)
          .execute(),
      );
  const commands: CommandId[] = steer
    ? []
    : await pick((limit) =>
        tx
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", runId)
          .where(sql<boolean>`status in ('pending','dispatched','unknown')`)
          .orderBy("id")
          .limit(limit)
          .execute(),
      );
  const nodes: ExecutionNodeId[] = await pick((limit) =>
    tx
      .selectFrom("executionNodes")
      .select("id")
      .where("runId", "=", runId)
      .where(sql<boolean>`status='running'`)
      .$if(steer !== undefined, (query) => query.where("attemptId", "=", steer!.attemptId))
      .orderBy("id")
      .limit(limit)
      .execute(),
  );
  const grants: GrantId[] = steer
    ? []
    : await pick((limit) =>
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
      .$if(steer !== undefined, (query) =>
        query.where("bindingGeneration", "=", steer!.bindingGeneration),
      )
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
    .select(["id", "threadId", "finishIntent", "bindingGeneration", "providerRetry"])
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
      run.finishIntent.outcome !== input.intent.outcome ||
      previous?.runnerId !== submitted?.runnerId ||
      previous?.runnerBootId !== submitted?.runnerBootId ||
      previous?.ordinal !== submitted?.ordinal ||
      previous?.digest !== submitted?.digest
    )
      throw new OpensteerError({
        code: "conflict",
        message: "Run already has a terminal statement",
      });
    return run.finishIntent;
  }
  if (
    input.intent.replyMessageId &&
    (input.intent.outcome !== "completed" ||
      !(await tx
        .selectFrom("messages")
        .select("id")
        .where("id", "=", input.intent.replyMessageId)
        .where("runId", "=", run.id)
        .where("threadId", "=", run.threadId)
        .where("kind", "=", "assistant")
        .where("addressedToUserId", "is", null)
        .executeTakeFirst()))
  )
    throw new OpensteerError({
      code: "conflict",
      message: "The completion reply no longer belongs to this Run",
    });
  const failure =
    input.intent.outcome === "failed" ? RunFailureSchema.parse(input.intent.failure) : null;
  const intent = {
    ...input.intent,
    ...(failure
      ? {
          failure: {
            ...failure,
            code: utf8Prefix(storableText(failure.code), 128),
            message: utf8Prefix(storableText(failure.message), 768),
          },
        }
      : {}),
  };
  await tx
    .updateTable("runs")
    .set({ finishIntent: intent, providerRetry: null, revision: mutation.sequence })
    .where("id", "=", input.runId)
    .execute();
  if (run.providerRetry !== null) {
    await publishTranscriptRun(tx, mutation, input.runId);
    await publishThreadSummary(tx, run.threadId);
  }
  // A finish that spans commits is not a revocation: viewers keep their sockets and see it finish.
  mutation.react({
    type: "runLiveClosed",
    runId: input.runId,
    threadId: run.threadId,
    attemptId: intent.attemptId,
    bindingGeneration: intent.bindingGeneration,
  });
  await publishRunQueue(tx, run.threadId);
  return intent;
}

export async function advancePersonalRunFinish(
  tx: Tx,
  mutation: PersonalMutation,
  runId: RunId,
  actions: {
    readonly settle: (
      children: Awaited<ReturnType<typeof readFinishChildren>>,
      intent: FinishIntent,
    ) => Promise<void>;
    readonly finalize: (intent: FinishIntent) => Promise<void>;
  },
) {
  const run = await tx
    .selectFrom("runs")
    .select(["finishIntent", "threadId"])
    .where("id", "=", runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run?.finishIntent) return "settled" as const;
  await tx
    .selectFrom("threads")
    .select("id")
    .where("id", "=", run.threadId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const steer = run.finishIntent.mode === "steer" ? run.finishIntent : undefined;
  const children = await readFinishChildren(tx, runId, steer);
  await actions.settle(children, run.finishIntent);
  if (children.hasMore) return "more" as const;
  const remaining = await readFinishChildren(tx, runId, steer);
  if (
    remaining.requests.length ||
    remaining.commands.length ||
    remaining.steers.length ||
    remaining.nodes.length ||
    remaining.grants.length ||
    remaining.tools.length
  )
    throw new Error("The finishing Run still has unsettled children");
  await actions.finalize(run.finishIntent);
  await recordFinishedRunnerStatement(tx, mutation, runId, run.finishIntent);
  mutation.react({
    type: "runFinished",
    ...(run.finishIntent.mode === "recovery" || run.finishIntent.mode === "steer"
      ? { attemptOnly: true }
      : {}),
    runId,
    threadId: run.threadId,
    attemptId: run.finishIntent.attemptId,
    bindingGeneration: run.finishIntent.bindingGeneration,
    outcome: run.finishIntent.outcome,
  });
  await tx
    .updateTable("runs")
    .set({ finishIntent: null, revision: mutation.sequence })
    .where("id", "=", runId)
    .execute();
  await publishRunQueue(tx, run.threadId);
  return "settled" as const;
}
