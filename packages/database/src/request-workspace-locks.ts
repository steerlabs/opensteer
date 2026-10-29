import type { RequestId, RunId, UserId, WorkspaceId } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { IntegrationInstallationId } from "@opensteer/integration-core";
import { retryDatabaseTransaction, TransactionScopeChanged } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";

export class RequestLockSetChanged extends TransactionScopeChanged {
  readonly workspaceIds: readonly WorkspaceId[];
  constructor(workspaceIds: readonly WorkspaceId[] = []) {
    super("Request Workspace lock set expanded");
    this.workspaceIds = workspaceIds;
  }
}

const lockedWorkspaces = new WeakMap<Transaction<DatabaseSchema>, ReadonlySet<WorkspaceId>>();
type Discover = (transaction: Transaction<DatabaseSchema>) => Promise<readonly WorkspaceId[]>;

/**
 * Acquire the Request's complete Workspace set according to ./lock-order.ts.
 * Include authority scopes and every event origin, including covered Requests.
 * `prepare` may acquire only prefix locks. Discovery uses unlocked reads; growth
 * after fencing restarts the transaction with the union. Callbacks are database-only.
 */
export async function withRequestWorkspaceLocks<Result>(
  database: Kysely<DatabaseSchema>,
  discover: Discover,
  mutate: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
  prepare?: (transaction: Transaction<DatabaseSchema>) => Promise<unknown>,
): Promise<Result> {
  const workspaceIds = new Set<WorkspaceId>();
  return retryDatabaseTransaction(
    () =>
      database.transaction().execute(async (transaction) => {
        await prepare?.(transaction);
        for (const id of await discover(transaction)) workspaceIds.add(id);
        await lockRequestWorkspaces(transaction, [...workspaceIds]);
        lockedWorkspaces.set(transaction, new Set(workspaceIds));
        await lockRequestWorkspaces(transaction, await discover(transaction));
        return mutate(transaction);
      }),
    (error) => {
      if (!(error instanceof RequestLockSetChanged)) return false;
      for (const id of error.workspaceIds) workspaceIds.add(id);
      return true;
    },
  );
}

/** Event and shared row-lock paths cannot silently extend a Request transaction's set. */
export function assertRequestWorkspacesLocked(
  transaction: Transaction<DatabaseSchema>,
  workspaceIds: readonly WorkspaceId[],
): void {
  const held = lockedWorkspaces.get(transaction);
  if (held && workspaceIds.some((id) => !held.has(id)))
    throw new RequestLockSetChanged(workspaceIds);
}

/** Reuses the complete set; nested mutations may request a retry, never extend it. */
export async function lockRequestWorkspaces(
  transaction: Transaction<DatabaseSchema>,
  workspaceIds: readonly WorkspaceId[],
): Promise<void> {
  const held = lockedWorkspaces.get(transaction);
  if (held) {
    assertRequestWorkspacesLocked(transaction, workspaceIds);
    return;
  }
  if (workspaceIds.length === 0) return;
  await transaction
    .selectFrom("workspaces")
    .select("id")
    .where("id", "in", [...new Set(workspaceIds)])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
}

/** Immutable Request scopes, read without locking Requests or authority rows. */
export async function discoverRequestWorkspaces(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly requestId?: RequestId;
    readonly workspaceId?: WorkspaceId;
    readonly requestedBy?: UserId;
    readonly runId?: RunId;
    readonly pending?: boolean;
    readonly kinds?: readonly DatabaseSchema["requests"]["kind"][];
  } = {},
): Promise<readonly WorkspaceId[]> {
  let query = database
    .selectFrom("requests")
    .select(["originatingWorkspaceId", "targetWorkspaceId"])
    .distinct();
  if (input.requestId) query = query.where("id", "=", input.requestId);
  if (input.pending) query = query.where("status", "=", "pending");
  if (input.workspaceId)
    query = query.where((eb) =>
      eb.or([
        eb("originatingWorkspaceId", "=", input.workspaceId!),
        eb("targetWorkspaceId", "=", input.workspaceId!),
      ]),
    );
  if (input.requestedBy) query = query.where("requestedBy", "=", input.requestedBy);
  if (input.runId) query = query.where("originatingRunId", "=", input.runId);
  if (input.kinds) query = query.where("kind", "in", [...input.kinds]);
  return (await query.execute()).flatMap((row) => [
    row.originatingWorkspaceId,
    row.targetWorkspaceId,
  ]);
}

/** Installation updates may cancel its access cards and approvals for its definition. */
export async function discoverInstallationRequestWorkspaces(
  database: Kysely<DatabaseSchema>,
  input: { readonly id: IntegrationInstallationId; readonly name?: string },
): Promise<readonly WorkspaceId[]> {
  const installations = await database
    .selectFrom("integrationInstallations")
    .select(["id", "manifest"])
    .where((eb) =>
      eb.or([
        eb("id", "=", input.id),
        ...(input.name === undefined ? [] : [eb("name", "=", input.name)]),
      ]),
    )
    .execute();
  const ids = [...new Set([input.id, ...installations.map(({ id }) => id)])];
  const rows = await database
    .selectFrom("requests")
    .leftJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .select(["requests.originatingWorkspaceId", "requests.targetWorkspaceId"])
    .distinct()
    .where("requests.status", "=", "pending")
    .where((eb) =>
      eb.or([
        eb("integrationRequestDetails.installationId", "in", ids),
        eb.and([
          eb("requests.kind", "=", "computer.app.access"),
          eb(
            sql<string>`requests.payload->>'definitionId'`,
            "in",
            database
              .selectFrom("integrationInstallations")
              .select(sql<string>`manifest->'definition'->>'id'`.as("definitionId"))
              .where("id", "in", ids),
          ),
        ]),
      ]),
    )
    .execute();
  return rows.flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]);
}
