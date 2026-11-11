import { assertActiveProjectBinding } from "./execution-authority.js";
import {
  OpensteerError,
  type ProjectRunBinding,
  type RunnerId,
  RunThreadStateSchema,
  runThreadStateFailureMaxChars,
  type RunId,
  type RunThreadState,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * What a Run's engine cannot see in its own history: whether the Run before it
 * in this Thread failed or was stopped, and how the Thread's previous task
 * ended. Read at dispatch, so a retried dispatch states the Thread as it is
 * then.
 */
export async function readRunThreadState(
  database: Kysely<DatabaseSchema>,
  input: { readonly runId: RunId; readonly viewerId: UserId },
): Promise<RunThreadState> {
  return readThreadState(database, input.runId, async (parentThreadId) =>
    database
      .selectFrom("threads")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
      .select("threads.id")
      .where("threads.id", "=", parentThreadId)
      .where("workspaceMemberships.userId", "=", input.viewerId)
      .where("workspaceMemberships.state", "=", "active")
      .executeTakeFirst(),
  );
}

export async function readProjectRunThreadState(
  database: Kysely<DatabaseSchema>,
  binding: ProjectRunBinding,
  runnerIsAttached: (runnerId: RunnerId, runnerBootId: string) => boolean,
): Promise<RunThreadState> {
  await assertActiveProjectBinding(database, binding, { runnerIsAttached });
  return readThreadState(database, binding.runId, async (parentThreadId) =>
    database
      .selectFrom("threads")
      .select("id")
      .where("id", "=", parentThreadId)
      .where("workspaceId", "=", binding.workspaceId)
      .executeTakeFirst(),
  );
}

async function readThreadState(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
  visibleParent: (parentId: import("@opensteer/core").ThreadId) => Promise<unknown>,
): Promise<RunThreadState> {
  const run = await database
    .selectFrom("runs")
    .select(["assignmentId", "runOrdinal", "threadId"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const [previous, earlierTask] = await Promise.all([
    database
      .selectFrom("runs")
      .select(["completedAt", "failure", "seedInputId", "status", "voiceSessionId"])
      .where("threadId", "=", run.threadId)
      .where("runOrdinal", "<", run.runOrdinal)
      .orderBy("runOrdinal", "desc")
      .limit(1)
      .executeTakeFirst(),
    database
      .selectFrom("runs")
      .innerJoin("delegations", "delegations.id", "runs.assignmentId")
      .select([
        "delegations.finishedAt",
        "delegations.id",
        "delegations.origin",
        "delegations.parentThreadId",
        "delegations.resultStatus",
        "delegations.status",
      ])
      .where("runs.threadId", "=", run.threadId)
      .where("runs.runOrdinal", "<", run.runOrdinal)
      .where("delegations.status", "!=", "open")
      .where("runs.assignmentId", "is distinct from", run.assignmentId)
      .orderBy("runs.runOrdinal", "desc")
      .limit(1)
      .executeTakeFirst(),
  ]);
  const parentVisible = earlierTask ? await visibleParent(earlierTask.parentThreadId) : undefined;
  return RunThreadStateSchema.parse({
    previousAssignment: earlierTask
      ? {
          finishedAt: required(earlierTask.finishedAt, "task").toISOString(),
          id: earlierTask.id,
          origin: earlierTask.origin,
          parentThreadId: parentVisible ? earlierTask.parentThreadId : null,
          returnStatus: earlierTask.resultStatus,
          status: earlierTask.status,
        }
      : null,
    previousRun:
      previous &&
      previous.voiceSessionId === null &&
      (previous.status === "failed" || previous.status === "interrupted")
        ? {
            endedAt: required(previous.completedAt, "Run").toISOString(),
            failure: previous.failure
              ? {
                  code: previous.failure.code,
                  message: bounded(previous.failure.message),
                }
              : null,
            seedMessageId: previous.seedInputId,
            status: previous.status,
          }
        : null,
  });
}

function bounded(text: string): string {
  return text.length > runThreadStateFailureMaxChars
    ? `${text.slice(0, runThreadStateFailureMaxChars - 1)}…`
    : text;
}

function required(value: Date | null, subject: "Run" | "task"): Date {
  if (value === null) {
    throw new OpensteerError({
      code: "internal",
      message: `A finished ${subject} has no finish time`,
    });
  }
  return value;
}
