import { OpensteerError } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import type { ThreadId, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";

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
  const recent = await taskWindow(tx, { viewerId: input.viewerId, window: "recent", limit: 26 });
  const active = await taskWindow(tx, { viewerId: input.viewerId, window: "active", limit: 11 });
  const tasks = new Map<
    ThreadId,
    Awaited<ReturnType<ReturnType<typeof currentTasks>["executeTakeFirstOrThrow"]>>
  >();
  let bytes = 1024;
  function add(rows: readonly (typeof recent)[number][]) {
    const admitted: TaskBoundary[] = [];
    for (const { cursorAt, ...row } of rows) {
      if (!tasks.has(row.id)) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > 36 * 1024) break;
        bytes += size;
        tasks.set(row.id, row);
      }
      admitted.push({ at: cursorAt, id: row.id });
    }
    return admitted;
  }
  if (selected) {
    tasks.set(selected.id, selected);
    bytes += Buffer.byteLength(JSON.stringify(selected)) + 1;
  }
  const activeWindow = add(active.slice(0, 10));
  const recentWindow = add(recent.slice(0, 25));
  const visits = tasks.size
    ? await tx
        .selectFrom("threadVisits")
        .select(["threadId", "lastVisitedAt"])
        .where("userId", "=", input.viewerId)
        .where("threadId", "in", [...tasks.keys()])
        .execute()
    : [];
  return {
    tasks: [...tasks.values()],
    visits,
    active: activeWindow.map(({ id }) => id),
    recent: recentWindow.map(({ id }) => id),
    activeNextBefore: activeWindow.length < active.length ? (activeWindow.at(-1) ?? null) : null,
    recentNextBefore: recentWindow.length < recent.length ? (recentWindow.at(-1) ?? null) : null,
  };
}
