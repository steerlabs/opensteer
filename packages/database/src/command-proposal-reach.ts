import {
  CommandRequestPartSchema,
  OpensteerError,
  type RequestId,
  type UserId,
} from "@opensteer/core";
import { hostApi, type HostApiCommand } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { admitCommand, type AuthoritySubject } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * Losing reach ends an ask (D5): a command an agent proposed is closed in the transaction that
 * takes its proposer's reach away (a Disconnect, a grant narrowed below it, its automation paused
 * or archived), with the plumbing every other closed Request uses. Widening again, or resuming,
 * brings no closed ask back.
 */

/** The subject a proposal was admitted as: where it asked from, never a bare fallback. */
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

/** The stored proposal as the command it is, or null when it no longer reads as one. */
export function storedProposal(part: { readonly type: string; readonly command: unknown }) {
  const parsed = hostApi["commands.dispatch"].payload.safeParse({
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
      "originatingRunId",
      "originatingOccurrenceId",
      "originatingWatchActivationId",
    ])
    .where("status", "=", "pending")
    .where("command", "is not", null);

async function close(transaction: Transaction<DatabaseSchema>, ids: readonly RequestId[]) {
  if (ids.length)
    await cancelPending(transaction, {
      reason: "authority-revoked",
      resolvedAt: new Date(),
      requestIds: [...ids],
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
    const subject = proposalSubject({ ...row, connectionId: input.connectionId });
    if (
      !command ||
      !subject ||
      !(await stillReaches(transaction, input.ownerUserId, subject, command))
    )
      lost.push(row.id);
  }
  await close(transaction, lost);
}

/** An automation was paused or archived: what its runs proposed closes. */
export async function closeAutomationProposals(
  transaction: Transaction<DatabaseSchema>,
  triggerId: string,
): Promise<void> {
  const rows = await pendingProposals(transaction)
    .where(
      sql<boolean>`(originating_occurrence_id in (select id from trigger_occurrences where trigger_id = ${triggerId})
        or originating_watch_activation_id in (select id from trigger_watch_activations where trigger_id = ${triggerId}))`,
    )
    .orderBy("id")
    .execute();
  await close(
    transaction,
    rows.map(({ id }) => id),
  );
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
