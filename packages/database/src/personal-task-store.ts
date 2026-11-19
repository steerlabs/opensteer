import { OpensteerError } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import type { Thread, ThreadId, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { personalShellSettledTasks } from "@opensteer/protocol/personal-sync";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import { compactionReturnHints } from "./compaction-eligibility.js";
import {
  threadContinuationIdentitySelection,
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadsFromRows,
  threadVisitSelection,
} from "./thread-row-mappers.js";

export type TaskWindow = "recent" | "active" | "done";

type TaskBoundary = {
  readonly at: string;
  readonly id: ThreadId;
};

const taskFields = [
  "id",
  "title",
  "listed",
  "purpose",
  "askedAt",
  "doneAt",
  "status",
  "inputQueuePaused",
  "revision",
  "pendingRequestCount",
  "lastReplyPreview",
  "failurePreview",
  "latestRunCompletedAt",
] as const;

export function currentTasks(tx: PersonalMutationTransaction, viewerId: UserId) {
  return tx
    .selectFrom("threads")
    .select(taskFields)
    .where("createdBy", "=", viewerId)
    .where("removedAt", "is", null);
}

function taskWindow(
  tx: PersonalMutationTransaction,
  input: {
    readonly viewerId: UserId;
    readonly window: TaskWindow;
    readonly limit: number;
    readonly before?: TaskBoundary;
  },
) {
  const key = input.window === "done" ? "done_at" : "asked_at";
  const date = sql.ref(key);
  const query = currentTasks(tx, input.viewerId)
    .where("listed", "=", true)
    .select(
      sql<string>`to_char(${date} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        "cursorAt",
      ),
    )
    .$if(input.window === "done", (part) => part.where("doneAt", "is not", null))
    .$if(input.window !== "done", (part) => part.where("doneAt", "is", null))
    .$if(input.window === "active", (part) =>
      part.where(sql<boolean>`status in ('running','waiting')`),
    )
    .$if(input.window !== "active", (part) => part.where(sql<boolean>`status <> 'archived'`))
    .orderBy(date, "desc")
    .orderBy("id", "desc")
    .limit(input.limit);
  const before = input.before;
  return (
    before
      ? query.where(sql<boolean>`(${date},id)<(${before.at}::timestamptz,${before.id})`)
      : query
  ).execute();
}

export function readPersonalTaskPage(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly viewerId: UserId;
    readonly window: TaskWindow;
    readonly limit?: number;
    readonly before?: TaskBoundary & { readonly window: TaskWindow };
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    const state = await authorizedSyncState(tx, input.viewerId);
    if (input.before && input.before.window !== input.window) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Task cursor belongs to another window",
      });
    }
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const candidates = await taskWindow(tx, { ...input, limit: limit + 1 });
    let bytes = 1024;
    const tasks: typeof candidates = [];
    for (const task of candidates) {
      bytes += Buffer.byteLength(JSON.stringify(task)) + 1;
      if (bytes > 64 * 1024 || tasks.length === limit) break;
      tasks.push(task);
    }
    const last = tasks.at(-1);
    const hasMore = candidates.length > tasks.length;
    return {
      tasks,
      hasMore,
      revision: state.sequence,
      nextBefore: hasMore && last ? { at: last.cursorAt, id: last.id, window: input.window } : null,
    };
  });
}

export async function readTaskPageThreads(
  tx: PersonalMutationTransaction,
  viewerId: UserId,
  ids: readonly ThreadId[],
) {
  if (!ids.length) return new Map<ThreadId, Thread>();
  const rows = await tx
    .selectFrom("threads")
    .selectAll("threads")
    .select(taskPageThreadSelections())
    .where("threads.createdBy", "=", viewerId)
    .where("threads.removedAt", "is", null)
    .where("threads.id", "in", ids)
    .execute();
  return taskPageThreadsFromRows(tx, rows);
}

/** The derived columns a task row needs besides its own, selectable or returnable. */
// A function: this module and thread-status import each other, so a constant can be undefined.
export function taskPageThreadSelections() {
  return [
    threadContinuationIdentitySelection,
    threadPendingRequestsSelection,
    threadProviderSessionSelection,
    threadVisitSelection,
  ] as const;
}

export async function taskPageThreadsFromRows(
  tx: PersonalMutationTransaction,
  rows: Parameters<typeof threadsFromRows>[0],
) {
  const returnHints = await compactionReturnHints(
    tx,
    rows.filter((row) => row.providerSessionId !== null).map((row) => row.id),
  );
  return new Map(
    threadsFromRows(rows).map((thread) => [
      thread.id,
      { ...thread, returnHint: returnHints.get(thread.id) ?? null },
    ]),
  );
}

const activeTaskBytes = 48 * 1024;
const recentTaskBytes = 32 * 1024;
const maxActiveTasks = 200;

/** Every running and waiting task, the newest open ones, and counts for the rest. */
export async function readInitialTaskWindows(
  tx: PersonalMutationTransaction,
  input: {
    readonly viewerId: UserId;
    readonly selectedThreadId?: ThreadId;
  },
) {
  const selected = input.selectedThreadId
    ? await currentTasks(tx, input.viewerId)
        .where("id", "=", input.selectedThreadId)
        .executeTakeFirst()
    : undefined;
  const active = await taskWindow(tx, {
    viewerId: input.viewerId,
    window: "active",
    limit: maxActiveTasks + 1,
  });
  const recent = await taskWindow(tx, {
    viewerId: input.viewerId,
    window: "recent",
    limit: personalShellSettledTasks + 1,
  });
  const tasks = new Map<
    ThreadId,
    Awaited<ReturnType<ReturnType<typeof currentTasks>["executeTakeFirstOrThrow"]>>
  >();
  if (selected) tasks.set(selected.id, selected);
  function add(rows: readonly (typeof recent)[number][], limit: number, budget: number) {
    const admitted: TaskBoundary[] = [];
    let bytes = 0;
    for (const { cursorAt, ...row } of rows.slice(0, limit)) {
      if (!tasks.has(row.id)) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > budget) break;
        bytes += size;
        tasks.set(row.id, row);
      }
      admitted.push({ at: cursorAt, id: row.id });
    }
    return admitted;
  }
  const activeWindow = add(active, maxActiveTasks, activeTaskBytes);
  const recentWindow = add(recent, personalShellSettledTasks, recentTaskBytes);
  const visits = tasks.size
    ? await tx
        .selectFrom("threadVisits")
        .select(["threadId", "lastVisitedAt"])
        .where("userId", "=", input.viewerId)
        .where("threadId", "in", [...tasks.keys()])
        .execute()
    : [];
  const counts = await currentTasks(tx, input.viewerId)
    .clearSelect()
    .where("listed", "=", true)
    .where("doneAt", "is", null)
    .where(sql<boolean>`status <> 'archived'`)
    .select([
      sql<string>`count(*)`.as("open"),
      sql<string>`count(*) filter (where status in ('running','waiting'))`.as("active"),
    ])
    .executeTakeFirstOrThrow();
  return {
    tasks: [...tasks.values()],
    visits,
    active: activeWindow.map(({ id }) => id),
    activeHasMore: activeWindow.length < active.length,
    recent: recentWindow.map(({ id }) => id),
    recentNextBefore: recentWindow.length < recent.length ? (recentWindow.at(-1) ?? null) : null,
    taskCounts: { active: Number(counts.active), open: Number(counts.open) },
  };
}
