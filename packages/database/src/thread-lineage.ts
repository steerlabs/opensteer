import { OpensteerError, agentDelegationMaxDepth, type ThreadId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * Where a person finds a Thread by parent link: itself when it is listed (or a
 * root), otherwise its nearest listed ancestor. `via` is the Thread just below
 * that one on the way down, null when the Thread is its own place.
 */
export async function nearestListedThread(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
): Promise<{ readonly threadId: ThreadId; readonly via: ThreadId | null } | null> {
  const result = await sql<{ threadId: ThreadId; via: ThreadId | null }>`
    with recursive lineage as (
      select t.id, t.parent_thread_id, t.listed, 0 as depth, array[t.id::text] as path
      from threads t where t.id = ${threadId}
      union all
      select t.id, t.parent_thread_id, t.listed, l.depth + 1, l.path || t.id::text
      from lineage l join threads t on t.id = l.parent_thread_id
      where l.depth < 64 and not t.id::text = any(l.path)
    )
    select l.id as "threadId", case when l.depth > 0 then l.path[l.depth] end as via
    from lineage l
    where l.listed or l.parent_thread_id is null order by l.depth limit 1
  `.execute(database);
  return result.rows[0] ?? null;
}

/** Whether `ancestorId` is above `threadId` by parent link, never the Thread itself. */
export async function descendsByParentLink(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ancestorId: ThreadId,
): Promise<boolean> {
  if (threadId === ancestorId) return false;
  const result = await sql<{ found: boolean }>`
    with recursive lineage as (
      select t.parent_thread_id as id, 1 as depth from threads t where t.id = ${threadId}
      union all
      select t.parent_thread_id, l.depth + 1
      from lineage l join threads t on t.id = l.id
      where l.depth < 64 and t.parent_thread_id is not null
    )
    select exists (select 1 from lineage where id = ${ancestorId}) as found
  `.execute(database);
  return result.rows[0]?.found === true;
}

/** A new task linked under this one would stay within the delegation depth. */
export async function assertDelegationDepth(
  transaction: Kysely<DatabaseSchema>,
  parentThreadId: ThreadId,
): Promise<void> {
  let currentId: ThreadId | null = parentThreadId;
  const visited = new Set<ThreadId>();
  let childDepth = 0;
  while (currentId) {
    if (visited.has(currentId)) {
      throw new OpensteerError({
        code: "internal",
        message: "Thread lineage contains a cycle",
      });
    }
    visited.add(currentId);
    childDepth += 1;
    if (childDepth > agentDelegationMaxDepth) {
      throw new OpensteerError({
        code: "conflict",
        details: {
          maxDelegationDepth: agentDelegationMaxDepth,
        },
        message: `Agent delegation cannot exceed ${agentDelegationMaxDepth} parent-child levels`,
      });
    }
    const current:
      | {
          readonly parentThreadId: ThreadId | null;
        }
      | undefined = await transaction
      .selectFrom("threads")
      .select("parentThreadId")
      .where("id", "=", currentId)
      .executeTakeFirst();
    if (!current) {
      throw new OpensteerError({
        code: "internal",
        message: "Thread lineage is incomplete",
      });
    }
    currentId = current.parentThreadId;
  }
}
