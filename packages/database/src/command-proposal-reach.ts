import {
  CommandRequestPartSchema,
  OpensteerError,
  type RequestId,
  type UserId,
} from "@opensteer/core";
import { parseCommandArguments, type HostApiCommand } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { admitCommand, type AuthoritySubject } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * Losing reach ends an ask (D5): a command an agent proposed is closed in the transaction that
 * takes its proposer's reach away (a Disconnect, a grant narrowed below it, its automation paused
 * or archived, the person's Stop of the Run, the task marked Done), with the plumbing every other
 * closed Request uses. Widening again, or resuming, brings no closed ask back. A Run or an
 * automation's firing that ends on its own ends nothing: its ask waits for the person, and
 * approving it continues the task.
 */

/** The subject a proposal is admitted as when it is written: where it asks from, never a bare fallback. */
export function proposalSubject(row: {
  readonly originatingAgentSessionId?: string | null | undefined;
  readonly originatingRunId?: string | null | undefined;
  readonly originatingOccurrenceId?: string | null | undefined;
  readonly originatingWatchActivationId?: string | null | undefined;
  readonly connectionId?: string | null | undefined;
}): AuthoritySubject | null {
  if (row.originatingAgentSessionId)
    return { kind: "binding", bindingId: `session:${row.originatingAgentSessionId}` };
  if (row.originatingRunId) return { kind: "binding", bindingId: `run:${row.originatingRunId}` };
  if (row.originatingOccurrenceId)
    return { kind: "binding", bindingId: `trigger:${row.originatingOccurrenceId}` };
  if (row.originatingWatchActivationId)
    return { kind: "binding", bindingId: `watch:${row.originatingWatchActivationId}` };
  return row.connectionId ? { kind: "connection", agentConnectionId: row.connectionId } : null;
}

/**
 * Who stands behind a proposal after it was written, by the lineage of its proposer: what the
 * approval, its attempt and a later change to a connection's grant admit it as.
 * - A connection's lineage (its direct session, or a Run or automation working under it): that
 *   connection as it stands now: its live grant, and for a task's work its Tasks switch. Never
 *   the task's own origin, which is the person's when a connection with `everything` works in
 *   the person's own task. The end of the session, Run or firing that sent it ends nothing.
 * - The person's own agents (no connection in the lineage): the task it came from
 *   (`thread:<id>`), so the end of the Run or firing that sent it does not end the ask.
 */
export function standingSubject(row: {
  readonly originatingAgentSessionId?: string | null | undefined;
  readonly originatingThreadId?: string | null | undefined;
  readonly connectionId?: string | null | undefined;
}): AuthoritySubject | null {
  if (row.connectionId)
    return row.originatingAgentSessionId
      ? { kind: "connection", agentConnectionId: row.connectionId }
      : { kind: "connection", agentConnectionId: row.connectionId, delegated: true };
  if (row.originatingThreadId)
    return { kind: "binding", bindingId: `thread:${row.originatingThreadId}` };
  return null;
}

/**
 * The stored proposal as the command it is, or null when it no longer reads as one. Read by the
 * door's own argument rules: a value only the person types was never stored, and its absence is
 * how the agent was told to ask, so it reads as the command without it.
 */
export function storedProposal(part: { readonly type: string; readonly command: unknown }) {
  const parsed = parseCommandArguments({
    ...(part.command as Record<string, unknown>),
    type: part.type,
    idempotencyKey: "proposal",
  });
  return parsed.success ? (parsed.data as HostApiCommand) : null;
}

const pendingProposals = (transaction: Kysely<DatabaseSchema>) =>
  transaction
    .selectFrom("requests")
    .select([
      "id",
      "requestedBy",
      "command",
      "originatingAgentSessionId",
      "originatingThreadId",
      "originatingRunId",
      "originatingOccurrenceId",
      "originatingWatchActivationId",
    ])
    .where("status", "=", "pending")
    .where("command", "is not", null);

async function close(
  transaction: Transaction<DatabaseSchema>,
  ids: readonly RequestId[],
  options: { readonly withoutContinuation?: true } = {},
) {
  if (ids.length)
    await cancelPending(transaction, {
      reason: "authority-revoked",
      resolvedAt: new Date(),
      requestIds: [...ids],
      ...options,
    });
}

/**
 * A connection's grant or mode changed, or it was disconnected (`all`): its pending proposals it
 * may no longer ask for, read by the one admission as they were asked, close now.
 */
export async function closeLostConnectionProposals(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly ownerUserId: UserId; readonly connectionId: string; readonly all: boolean },
): Promise<void> {
  const rows = await pendingProposals(transaction)
    .where("requestedBy", "=", input.ownerUserId)
    .where(sql<boolean>`command->'proposer'->>'connectionId' = ${input.connectionId}`)
    .orderBy("id")
    .execute();
  const lost: RequestId[] = [];
  for (const row of rows) {
    const part = CommandRequestPartSchema.parse(row.command);
    if (part.proposer.connectionId !== input.connectionId) continue;
    if (input.all) {
      lost.push(row.id);
      continue;
    }
    const command = storedProposal(part);
    const subject = standingSubject({ ...row, connectionId: input.connectionId });
    if (
      !command ||
      !subject ||
      !(await stillReaches(transaction, input.ownerUserId, subject, command))
    )
      lost.push(row.id);
  }
  // Nothing is said to the connection's Runs or automations about an ask its lost reach closed:
  // that would tell them their access changed (rule 5). Its own reads find nothing there.
  await close(transaction, lost, { withoutContinuation: true });
}

/**
 * An automation was paused or archived: a paused automation acts no more, so what its lineage
 * proposed closes: its firings' and watches' own asks, and those of the Runs its firings started
 * or steered (joined to them by their causal chain, as the automation's own run list is).
 */
export async function closeAutomationProposals(
  transaction: Transaction<DatabaseSchema>,
  triggerId: string,
): Promise<void> {
  const rows = await automationLineage(transaction, triggerId).select("id").orderBy("id").execute();
  await close(
    transaction,
    rows.map(({ id }) => id),
  );
}

/** The tasks the automation's lineage asked from: locked, as every task is, before the trigger. */
export async function automationProposalThreads(
  transaction: Kysely<DatabaseSchema>,
  triggerId: string,
): Promise<readonly string[]> {
  return (
    await automationLineage(transaction, triggerId)
      .select("originatingThreadId")
      .distinct()
      .execute()
  ).map(({ originatingThreadId }) => originatingThreadId);
}

function automationLineage(transaction: Kysely<DatabaseSchema>, triggerId: string) {
  return transaction
    .selectFrom("requests")
    .where("status", "=", "pending")
    .where("command", "is not", null)
    .where(
      sql<boolean>`(originating_occurrence_id in (select id from trigger_occurrences where trigger_id = ${triggerId})
        or originating_watch_activation_id in (select id from trigger_watch_activations where trigger_id = ${triggerId})
        or originating_run_id in (
          select runs.id from runs
            join trigger_occurrences on trigger_occurrences.causal_chain_id = runs.causal_chain_id
            where trigger_occurrences.trigger_id = ${triggerId}
          union
          select thread_inputs.run_id from thread_inputs
            join trigger_occurrences on trigger_occurrences.causal_chain_id = thread_inputs.causal_chain_id
            where trigger_occurrences.trigger_id = ${triggerId} and thread_inputs.run_id is not null))`,
    );
}

/**
 * Whether the automation an ask came from still stands for it, decided when the person approves:
 * an ask in an automation's lineage (its firing's or watch's own, or a Run its firings started
 * or steered, joined by their causal chain as `closeAutomationProposals` joins them) is refused
 * when the person (or an agent) paused or archived the automation, or it was paused for lost
 * standing. A one-shot that archived itself because its one firing completed (`pausedBy:
 * "system"` on an archived automation) still stands: that is bookkeeping, not a decision. An ask
 * in no automation's lineage stands here.
 */
export async function automationLineageStands(
  database: Kysely<DatabaseSchema>,
  request: {
    readonly originatingOccurrenceId?: string | null | undefined;
    readonly originatingWatchActivationId?: string | null | undefined;
    readonly originatingRunId?: string | null | undefined;
  },
): Promise<boolean> {
  const occurrence = request.originatingOccurrenceId ?? null;
  const watch = request.originatingWatchActivationId ?? null;
  const run = request.originatingRunId ?? null;
  if (!occurrence && !watch && !run) return true;
  const ended = await sql<{ readonly id: string }>`
    select t.id from triggers t
    where t.id in (
      select trigger_id from trigger_occurrences where id = ${occurrence}
      union select trigger_id from trigger_watch_activations where id = ${watch}
      union select o.trigger_id from trigger_occurrences o
        join runs r on r.causal_chain_id = o.causal_chain_id where r.id = ${run}
      union select o.trigger_id from trigger_occurrences o
        join thread_inputs i on i.causal_chain_id = o.causal_chain_id where i.run_id = ${run}
    )
    and (t.status = 'paused'
      or (t.status = 'archived' and t.paused_by is distinct from 'system'))
    limit 1`.execute(database);
  return ended.rows.length === 0;
}

/** Whether a proposer, as it asked, could still ask for this command now. */
export async function stillReaches(
  database: Kysely<DatabaseSchema>,
  owner: UserId,
  subject: AuthoritySubject,
  command: HostApiCommand,
): Promise<boolean> {
  try {
    return (
      (await admitCommand(database, { ownerUserId: owner, subject, command: command as never }))
        .answer !== "not_found"
    );
  } catch (error) {
    if (error instanceof OpensteerError && ["forbidden", "not_found"].includes(error.code))
      return false;
    throw error;
  }
}
