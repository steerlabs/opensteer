import { sql, type RawBuilder } from "kysely";
import type { ThreadId } from "@opensteer/core";
import { lineageHasPersonalContext } from "./resource-access.js";

/**
 * Who reads a task. The person, and a connected agent, read what their own rules allow. Work
 * running in a task (a Run, or an automation's program anchored there) reads as that task: if the
 * task is in a managed memory pass's lineage, it reads only tasks that ran with the person's
 * personal context.
 */
export type TaskReader =
  | { readonly kind: "person" }
  | { readonly kind: "connection" }
  | { readonly kind: "work"; readonly threadId: ThreadId };

export const personTaskReader: TaskReader = { kind: "person" };

/**
 * The reader works in a managed memory pass's lineage: its task sits under a task a memory
 * automation is anchored to, or a Run in its task was started by a memory pass (a task the pass
 * created, a worker it delegated to, a task it sent work into). What the pass starts carries its
 * causal chain, so nothing it makes reads wider than it does.
 */
function memoryLineage(threadId: ThreadId): RawBuilder<boolean> {
  return sql<boolean>`(exists (
      select 1 from threads memory_reader
      join triggers memory_role
        on memory_role.anchor_thread_id = memory_reader.lineage_root_thread_id
      where memory_reader.id = ${threadId} and memory_role.system_role is not null)
    or exists (
      select 1 from runs memory_run
      join causal_chains memory_chain on memory_chain.id = memory_run.causal_chain_id
      join trigger_occurrences memory_occurrence
        on memory_occurrence.id = memory_chain.root_occurrence_id
      join triggers memory_role on memory_role.id = memory_occurrence.trigger_id
      where memory_run.thread_id = ${threadId} and memory_role.system_role is not null))`;
}

/**
 * The one rule for what a reader may see of something derived from a task, in the statement
 * that reads it: everything, unless the reader is in a memory pass's lineage, which sees only
 * what every named lineage (the task's, and an automation's own) gives personal context. What it
 * may not see reads exactly like what does not exist: callers filter by this, never refuse
 * differently.
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
