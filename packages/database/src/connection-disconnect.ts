import {
  nonTerminalRunStatuses,
  type MessageId,
  type RequestId,
  type RunId,
  type ThreadId,
  type TriggerId,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

/** Everything in a connection's lineage that could still act, read after its decision committed. */
export interface ConnectionLineageWork {
  readonly runs: readonly {
    readonly id: RunId;
    readonly threadId: ThreadId;
    /** The task itself is in the lineage; otherwise it is the person's, and keeps its queue. */
    readonly lineageTask: boolean;
  }[];
  readonly inputs: readonly { readonly messageId: MessageId; readonly threadId: ThreadId }[];
  readonly requests: readonly RequestId[];
  readonly triggers: readonly TriggerId[];
}

export async function connectionLineageWork(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  connectionId: string,
): Promise<ConnectionLineageWork> {
  const inLineage = (thread: "threads") =>
    database
      .selectFrom(thread)
      .select("id")
      .where("createdBy", "=", userId)
      .where("originConnectionId", "=", connectionId);
  const [runs, inputs, requests, triggers] = await Promise.all([
    database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "runs.threadId", "threads.originConnectionId"])
      .where("runs.requestedBy", "=", userId)
      .where("runs.status", "in", nonTerminalRunStatuses)
      .where((eb) =>
        eb.or([
          eb("runs.connectionId", "=", connectionId),
          eb("threads.originConnectionId", "=", connectionId),
        ]),
      )
      .orderBy("runs.id")
      .execute(),
    database
      .selectFrom("threadInputs")
      .select(["messageId", "threadId"])
      .where("requestedBy", "=", userId)
      .where("state", "in", ["pending", "awaiting-approval"])
      .where("runId", "is", null)
      .where((eb) =>
        eb.or([eb("connectionId", "=", connectionId), eb("threadId", "in", inLineage("threads"))]),
      )
      .orderBy("messageId")
      .execute(),
    database
      .selectFrom("requests")
      .select("id")
      .where("requestedBy", "=", userId)
      .where("status", "=", "pending")
      .where((eb) =>
        eb.or([
          eb("originatingThreadId", "in", inLineage("threads")),
          eb(
            "originatingRunId",
            "in",
            database.selectFrom("runs").select("runs.id").where("connectionId", "=", connectionId),
          ),
        ]),
      )
      .orderBy("id")
      .execute(),
    database
      .selectFrom("triggers")
      .select("id")
      .where("createdBy", "=", userId)
      .where("originConnectionId", "=", connectionId)
      .where("status", "=", "active")
      .orderBy("id")
      .execute(),
  ]);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      threadId: run.threadId,
      lineageTask: run.originConnectionId === connectionId,
    })),
    inputs,
    requests: requests.map(({ id }) => id),
    triggers: triggers.map(({ id }) => id),
  };
}

/** Settles a lineage's pending Requests by id: nothing it asked for can be answered any more. */
export async function settleLineageRequests(
  database: Kysely<DatabaseSchema>,
  requestIds: readonly RequestId[],
): Promise<void> {
  if (!requestIds.length) return;
  await commitPersonalMutation(database, (tx) =>
    cancelPending(tx, {
      reason: "authority-revoked",
      resolvedAt: new Date(),
      requestIds,
      cancelHandedOffPlugins: true,
    }),
  );
}
