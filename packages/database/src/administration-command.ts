import { withDatabaseTransaction } from "./connection.js";
import { createId, OpensteerError, type UserId } from "@opensteer/core";
import { commandFace, type Command } from "@opensteer/protocol/command-table";
import {
  assertCommandAdmitted,
  commandSubject,
  type CommandStoredFace,
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

/**
 * Who sent a command and how it is admitted where it commits. Optional: the person's own writes
 * and reconciliation keep their behaviour. An agent's identity rechecks its live authority under
 * the command's fence, before any write, and is the record of who sent it.
 */
export interface CommandIdentity {
  readonly output?: (result: unknown) => unknown | Promise<unknown>;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly authoritySource: Readonly<Record<string, unknown>>;
  /** Rechecks the agent's live authority under this command's fence, before any write. */
  readonly admit?: (transaction: Transaction<DatabaseSchema>) => Promise<void>;
  /**
   * For a command with two faces: the store reports what the command does against what it
   * stores, inside the same transaction, and the agent must still be admitted on that face.
   */
  readonly face?: (
    transaction: Transaction<DatabaseSchema>,
    stored: CommandStoredFace,
  ) => Promise<void>;
  /**
   * Whether the store reported the face in this transaction. Set for a command only the stored
   * state can tell: such a command that reaches its commit without a reported face refuses.
   */
  readonly faced?: (transaction: Transaction<DatabaseSchema>) => boolean;
}
/** The earlier name, kept for the stores that take it. */
export type AdministrationCommandIdentity = CommandIdentity;

/**
 * How an agent's command is admitted where it commits: `admitCommand` under the connection's
 * lock, on the face it was admitted on, and again on the face the store reports. A command only
 * the stored state can tell is held to its strictest face until the store reports one, and fails
 * closed if it reaches its commit without one.
 */
export function commandAdmission(input: {
  readonly ownerUserId: UserId;
  readonly callerKey: string;
  readonly command: Command;
  readonly face?: number | undefined;
}): Pick<CommandIdentity, "admit" | "face" | "faced"> &
  Required<Pick<CommandIdentity, "admit" | "face">> {
  const subject = commandSubject(input.callerKey);
  const admitted = {
    ownerUserId: input.ownerUserId,
    subject,
    command: input.command,
    face: input.face,
  };
  let reportedIn: Transaction<DatabaseSchema> | null = null;
  return {
    admit: (transaction) => assertCommandAdmitted(transaction, admitted),
    face: async (transaction, stored) => {
      await assertCommandAdmitted(transaction, { ...admitted, stored });
      reportedIn = transaction;
    },
    ...(commandFace(input.command) === undefined
      ? { faced: (transaction: Transaction<DatabaseSchema>) => reportedIn === transaction }
      : {}),
  };
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
  if (identity.faced && !identity.faced(transaction))
    throw new OpensteerError({
      code: "forbidden",
      reason: "access-changed",
      message: "This change can't be made until the Home has checked what it does.",
    });
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
