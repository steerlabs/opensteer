import { withDatabaseTransaction } from "./connection.js";
import { createId, OpensteerError, type UserId } from "@opensteer/core";
import {
  admitExecution,
  bindingAgentConnectionId,
  type AuthoritySubject,
} from "./resource-access.js";
import type { Kysely, Transaction } from "kysely";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
} from "./store-primitives.js";

/** Optional for agent administration; ordinary person and reconciliation writes keep their behavior. */
export interface AdministrationCommandIdentity {
  readonly output?: (result: unknown) => unknown | Promise<unknown>;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly authoritySource: Readonly<Record<string, unknown>>;
  /** Rechecks the agent's live authority under this command's fence, before any write. */
  readonly admit?: (transaction: Transaction<DatabaseSchema>) => Promise<void>;
}

const payloadSchema = z.object({
  request: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  output: z.unknown().optional(),
});

export async function replayAdministrationCommand(
  database: Kysely<DatabaseSchema>,
  identity: AdministrationCommandIdentity,
): Promise<{ readonly result: unknown; readonly output?: unknown } | undefined> {
  if (!identity.admit) return readAdministrationCommand(database, identity);
  return withDatabaseTransaction(database, async (transaction) => {
    await lockAdministrationCommand(transaction, identity);
    return readAdministrationCommand(transaction, identity);
  });
}

async function readAdministrationCommand(
  database: Kysely<DatabaseSchema>,
  identity: AdministrationCommandIdentity,
): Promise<{ readonly result: unknown; readonly output?: unknown } | undefined> {
  const existing = await findCommandByIdempotency(
    database,
    identity.requestedBy,
    identity.idempotencyKey,
  );
  if (!existing) return undefined;
  const payload = payloadSchema.safeParse(existing.payload);
  if (
    existing.type !== identity.type ||
    !payload.success ||
    !isDeepStrictEqual(payload.data.request, identity.request)
  )
    throw idempotencyConflict(identity.idempotencyKey);
  return payload.data;
}

/** The result and domain write share the domain's transaction and existing command ledger. */
export async function administrationCommand<Result>(
  transaction: Transaction<DatabaseSchema>,
  identity: AdministrationCommandIdentity | undefined,
  mutate: () => Promise<Result>,
): Promise<Result> {
  if (!identity) return mutate();
  await lockCommandIdempotency(transaction, identity.requestedBy, identity.idempotencyKey);
  await identity.admit?.(transaction);
  const replay = await readAdministrationCommand(transaction, identity);
  if (replay) return replay.result as Result;
  const result = await mutate();
  await transaction
    .insertInto("commands")
    .values({
      id: createId("command"),
      requestedBy: identity.requestedBy,
      actorPrincipalId: await principalIdForUser(transaction, identity.requestedBy),
      authoritySource: jsonValue(identity.authoritySource),
      idempotencyKey: identity.idempotencyKey,
      type: identity.type,
      payload: jsonValue({
        request: identity.request,
        result: result ?? null,
        ...(identity.output ? { output: await identity.output(result) } : {}),
      }),
      status: "succeeded",
      environmentId: null,
      threadId: null,
      runId: null,
      dispatcherId: null,
      lastError: null,
    })
    .execute();
  return result;
}

export async function lockAdministrationCommand(
  transaction: Transaction<DatabaseSchema>,
  identity: AdministrationCommandIdentity | undefined,
): Promise<void> {
  if (!identity) return;
  await lockCommandIdempotency(transaction, identity.requestedBy, identity.idempotencyKey);
  await identity.admit?.(transaction);
}

export function withAdministrationTransaction<Result>(
  database: Kysely<DatabaseSchema>,
  identity: AdministrationCommandIdentity | undefined,
  mutate: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  return withDatabaseTransaction(database, (transaction) =>
    administrationCommand(transaction, identity, () => mutate(transaction)),
  );
}

/**
 * Settings are the person's: an agent changes them only while its execution is live at
 * `full-access` and, for a connection, its grant is `everything`. Read under the caller's fence.
 */
export async function admitSettingsCaller(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly ownerUserId: UserId; readonly callerKey: string },
): Promise<void> {
  const subject: AuthoritySubject = input.callerKey.startsWith("connection:")
    ? { kind: "connection", agentConnectionId: input.callerKey.slice("connection:".length) }
    : { kind: "binding", bindingId: input.callerKey };
  const connectionId =
    subject.kind === "connection"
      ? subject.agentConnectionId
      : await bindingAgentConnectionId(transaction, subject.bindingId);
  if (connectionId)
    await transaction
      .selectFrom("agentConnections")
      .select("id")
      .where("id", "=", connectionId)
      .forShare()
      .executeTakeFirst();
  const execution = await admitExecution(transaction, { ownerUserId: input.ownerUserId, subject });
  if (
    execution.mode !== "full-access" ||
    (execution.agentConnection && execution.agentConnection.grant.scope !== "everything")
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Changing settings requires full-access",
    });
}
