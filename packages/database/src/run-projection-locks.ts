import type { AssignmentId, CausalChainId, RunId, ThreadId, RequestId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

type ProjectionScope = {
  /**
   * The caller may delete the task: every input and its message, retired ones included,
   * is locked for deletion here, in rank order, rather than upgraded later.
   */
  readonly forRemoval?: boolean;
  readonly runIds: readonly RunId[];
  readonly requestIds?: readonly RequestId[];
  readonly threadIds: readonly ThreadId[];
  readonly assignmentIds?: readonly AssignmentId[];
  readonly causalChainIds?: readonly CausalChainId[];
};

function projectionInputs(transaction: Transaction<DatabaseSchema>, input: ProjectionScope) {
  return transaction
    .selectFrom("threadInputs")
    .where("threadId", "in", [...input.threadIds])
    .$if(!input.forRemoval, (q) =>
      q.where((eb) =>
        eb.or([
          eb("state", "in", ["awaiting-approval", "pending", "claimed", "unknown"]),
          eb("editLeaseId", "is not", null),
        ]),
      ),
    );
}

/**
 * A Thread can hold several provider sessions (fresh context, engine switches), and projection
 * locks take them all in ID order; lock them together before reading the Run's own.
 */
export function lockThreadProviderSessions(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
) {
  return transaction
    .selectFrom("providerSessions")
    .selectAll()
    .where("threadId", "=", threadId)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
}

/** Fence projection parents before Assignment/input mutations; see ./lock-order.ts.
 * Callers already own the complete Run, Workspace and Thread sets.
 */
export async function lockThreadProjectionParents(
  transaction: Transaction<DatabaseSchema>,
  input: ProjectionScope,
): Promise<readonly RunId[]> {
  if (!input.threadIds.length) return [];
  if (
    input.runIds.length &&
    (await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "in", [...input.runIds])
      .where("doneWhenFinished", "=", true)
      .limit(1)
      .executeTakeFirst())
  ) {
    await reserveThreadTriggers(transaction, input.threadIds);
  }
  const runIds = [...new Set(input.runIds)];
  const assignmentIds = [...new Set(input.assignmentIds ?? [])];
  if (assignmentIds.length) {
    for (const { id } of await transaction
      .selectFrom("runs")
      .select("id")
      .where("assignmentId", "in", assignmentIds)
      .execute())
      if (!runIds.includes(id)) runIds.push(id);
  }
  await transaction
    .selectFrom("providerSessions")
    .select("id")
    .where("threadId", "in", [...input.threadIds])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .selectFrom("causalChains")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("id", "in", projectionInputs(transaction, input).select("causalChainId")),
        ...(runIds.length
          ? [
              eb(
                "id",
                "in",
                eb.selectFrom("runs").select("causalChainId").where("id", "in", runIds),
              ),
            ]
          : []),
        ...(input.causalChainIds?.length ? [eb("id", "in", [...input.causalChainIds])] : []),
        // A removed task takes the chains rooted at its messages with it.
        ...(input.forRemoval
          ? [
              eb(
                "rootMessageId",
                "in",
                eb
                  .selectFrom("messages")
                  .select("messages.id")
                  .where("messages.threadId", "in", [...input.threadIds]),
              ),
            ]
          : []),
      ]),
    )
    .orderBy("id", "asc")
    .$call((query) => (input.forRemoval ? query.forUpdate() : query.forNoKeyUpdate()))
    .execute();
  {
    await transaction
      .selectFrom("requests")
      .select("id")
      .where((eb) =>
        eb.or([
          eb(
            "id",
            "in",
            eb
              .selectFrom("threadInputs")
              .select(sql<RequestId>`authority_source->>'referenceId'`.as("requestId"))
              .where("threadId", "in", [...input.threadIds])
              .where(sql<boolean>`authority_source->>'cause' = 'task-question'`)
              .where("state", "in", ["pending", "claimed"]),
          ),
          ...(runIds.length ? [eb("originatingRunId", "in", runIds)] : []),
          ...(input.requestIds?.length ? [eb("id", "in", [...input.requestIds])] : []),
        ]),
      )
      .where("status", "=", "pending")
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  }
  await transaction
    .selectFrom("delegations")
    .select("id")
    .where((eb) =>
      eb.or([
        eb.and([eb("childThreadId", "in", [...input.threadIds]), eb("status", "=", "open")]),
        eb("id", "in", projectionInputs(transaction, input).select("assignmentId")),
        ...(runIds.length
          ? [eb("id", "in", eb.selectFrom("runs").select("assignmentId").where("id", "in", runIds))]
          : []),
        ...(assignmentIds.length ? [eb("id", "in", assignmentIds)] : []),
      ]),
    )
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  return runIds;
}

/** Fence the complete receipt batch before any finalization projection mutates. */
export async function lockRunProjectionRows(
  transaction: Transaction<DatabaseSchema>,
  input: ProjectionScope,
): Promise<void> {
  if (!input.threadIds.length) return;
  const runIds = await lockThreadProjectionParents(transaction, input);
  if (runIds.length || input.forRemoval) {
    await transaction
      .selectFrom("commands")
      .select("id")
      .where((eb) =>
        input.forRemoval
          ? eb("threadId", "in", [...input.threadIds])
          : eb("runId", "in", [...runIds]),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  }
  await projectionInputs(transaction, input)
    .select("messageId")
    .orderBy("messageId", "asc")
    .$call((query) => (input.forRemoval ? query.forUpdate() : query.forNoKeyUpdate()))
    .execute();
  await transaction
    .selectFrom("messages")
    .select("id")
    .where("id", "in", projectionInputs(transaction, input).select("messageId"))
    .orderBy("id", "asc")
    .$call((query) => (input.forRemoval ? query.forUpdate() : query.forNoKeyUpdate()))
    .execute();
  await transaction
    .selectFrom("personalTeamRequests")
    .select("requestId")
    .where("localTaskId", "in", [...input.threadIds])
    .where("localInputId", "in", projectionInputs(transaction, input).select("messageId"))
    .orderBy("teamDeploymentId")
    .orderBy("requestId")
    .forNoKeyUpdate()
    .execute();
}

/** Finalization can apply a self-Done intent after Assignment settlement. */
export async function reserveThreadTriggers(
  transaction: Transaction<DatabaseSchema>,
  threadIds: readonly ThreadId[],
) {
  if (!threadIds.length) return;
  const triggers = await transaction
    .selectFrom("triggers")
    .select("id")
    .where("anchorThreadId", "in", [...threadIds])
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (triggers.length)
    await transaction
      .selectFrom("triggerWatchActivations")
      .select("id")
      .where(
        "triggerId",
        "in",
        triggers.map(({ id }) => id),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
}
