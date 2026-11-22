import { sql, type RawBuilder } from "kysely";
import type { ThreadId } from "@opensteer/core";
import { lineageHasPersonalContext } from "./resource-access.js";

/**
 * Who reads a task. The person, and a connected agent, read what their own rules allow. Work
 * running in a task (a Run, or an automation's program anchored there) reads as that task: in a
 * memory worker's own task tree, it reads only tasks that ran with the person's personal context.
 */
export type TaskReader =
  | { readonly kind: "person" }
  | { readonly kind: "connection" }
  | { readonly kind: "work"; readonly threadId: ThreadId };

export const personTaskReader: TaskReader = { kind: "person" };

/**
 * The reader is a memory worker's own task tree: its task's lineage root is the task a memory
 * automation is anchored to (the pass itself, and the workers it delegates to). A task the pass
 * creates for the person (opensteer_task_create) is an ordinary task of theirs, and reads as one.
 */
function memoryLineage(threadId: ThreadId): RawBuilder<boolean> {
  return sql<boolean>`exists (
      select 1 from threads memory_reader
      join triggers memory_role
        on memory_role.anchor_thread_id = memory_reader.lineage_root_thread_id
      where memory_reader.id = ${threadId} and memory_role.system_role is not null)`;
}

/**
 * The one rule for what a reader may see of something derived from a task, in the statement
 * that reads it: everything, unless the reader is a memory worker's own task tree, which sees
 * only what every named lineage (the task's, and an automation's own) gives personal context.
 * What it may not see reads exactly like what does not exist: callers filter by this, never
 * refuse differently.
 *
 * What it is for: a memory pass reads tasks as the person's own conversations, and a chat that
 * other people can speak in is not that, so their words are not taken as the person's. It is
 * not a wall: a pass still reads the person's mail and messages, which other people write, and
 * its tab list may name a task it cannot read.
 */
export function readerSees(
  reader: TaskReader,
  ...lineages: readonly RawBuilder<unknown>[]
): RawBuilder<boolean> {
  if (reader.kind !== "work" || lineages.length === 0) return sql<boolean>`true`;
  return sql<boolean>`(not ${memoryLineage(reader.threadId)} or (${sql.join(
    lineages.map((lineage) => lineageHasPersonalContext(lineage)),
    sql` and `,
  )}))`;
}
