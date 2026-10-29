import type { AssignmentId, CausalChainId, RunId, ThreadId, RequestId } from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

type ProjectionScope = {
  readonly runIds: readonly RunId[];
  readonly requestIds?: readonly RequestId[];
  readonly threadIds: readonly ThreadId[];
  readonly assignmentIds?: readonly AssignmentId[];
  readonly causalChainIds?: readonly CausalChainId[];
};

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
        eb(
          "id",
          "in",
          eb
            .selectFrom("threadInputs")
            .select("causalChainId")
            .where("threadId", "in", [...input.threadIds])
            .where("state", "in", ["pending", "claimed", "unknown"]),
        ),
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
      ]),
    )
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (runIds.length || input.requestIds?.length) {
    await transaction
      .selectFrom("requests")
      .select("id")
      .where((eb) =>
        eb.or([
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
        eb(
          "id",
          "in",
          eb
            .selectFrom("threadInputs")
            .select("assignmentId")
            .where("threadId", "in", [...input.threadIds])
            .where("state", "in", ["pending", "claimed", "unknown"]),
        ),
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
  if (runIds.length) {
    await transaction
      .selectFrom("commands")
      .select("id")
      .where("runId", "in", [...runIds])
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  }
  await transaction
    .selectFrom("threadInputs")
    .select("messageId")
    .where("threadId", "in", [...input.threadIds])
    .where("state", "in", ["pending", "claimed", "unknown"])
    .orderBy("messageId", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .selectFrom("messages")
    .select("id")
    .where("id", "in", (eb) =>
      eb
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "in", [...input.threadIds])
        .where("state", "in", ["pending", "claimed", "unknown"]),
    )
    .orderBy("id", "asc")
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
