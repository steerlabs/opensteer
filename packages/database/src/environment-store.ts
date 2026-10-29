import { withDatabaseTransaction } from "./connection.js";
import {
  type EnvironmentId,
  type RunnerId,
  createId,
  type UserId,
  OpensteerError,
} from "@opensteer/core";
import { type Kysely } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { jsonValue, boundedLimit } from "./store-primitives.js";
import {
  deploymentOwnedExecutionIsAvailableToUser,
  managedEnvironmentBindingAllowsUser,
  executionEnvironmentIsAvailableToUser,
} from "./execution-authority.js";

export interface ExecutionEnvironmentRecord {
  readonly capabilities: readonly string[];
  readonly id: EnvironmentId;
  readonly kind: "main" | "local" | "managed";
  readonly name: string;
  readonly runnerId: RunnerId | null;
}

export async function createEnvironment(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly capabilities?: readonly string[];
    readonly id?: EnvironmentId;
    readonly kind: "main" | "local" | "managed";
    readonly name: string;
    readonly runnerId?: RunnerId | null;
  },
): Promise<EnvironmentId> {
  const id = input.id ?? createId("environment");
  await database
    .insertInto("executionEnvironments")
    .values({
      capabilities: jsonValue(input.capabilities ?? []),
      id,
      kind: input.kind,
      name: input.name,
      runnerId: input.runnerId ?? null,
    })
    .executeTakeFirstOrThrow();
  return id;
}

export async function listEnvironments(
  database: Kysely<DatabaseSchema>,
  limit = 1_000,
): Promise<readonly ExecutionEnvironmentRecord[]> {
  return database
    .selectFrom("executionEnvironments")
    .select(["capabilities", "id", "kind", "name", "runnerId"])
    .orderBy("createdAt", "asc")
    .limit(boundedLimit(limit, 1_000))
    .execute();
}

export async function listEnvironmentsForUser(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  limit = 1_000,
  page?: { readonly afterId?: EnvironmentId; readonly id?: EnvironmentId },
): Promise<readonly ExecutionEnvironmentRecord[]> {
  const deploymentOwnedAvailable = await deploymentOwnedExecutionIsAvailableToUser(
    database,
    userId,
  );
  let query = database
    .selectFrom("executionEnvironments")
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .select([
      "executionEnvironments.capabilities",
      "executionEnvironments.id",
      "executionEnvironments.kind",
      "executionEnvironments.name",
      "executionEnvironments.runnerId",
    ])
    .where((expression) =>
      expression.or([
        ...(deploymentOwnedAvailable ? [expression("runners.ownerKind", "=", "deployment")] : []),
        expression("runners.ownerUserId", "=", userId),
      ]),
    )
    .where((expression) => managedEnvironmentBindingAllowsUser(expression, userId))
    .where("runners.revokedAt", "is", null)
    .orderBy(page ? "executionEnvironments.id" : "executionEnvironments.createdAt", "asc")
    .limit(boundedLimit(limit, 1_000));
  if (page?.afterId) query = query.where("executionEnvironments.id", ">", page.afterId);
  if (page?.id) query = query.where("executionEnvironments.id", "=", page.id);
  return query.execute();
}

export async function environmentIsAvailableToUser(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  userId: UserId,
): Promise<boolean> {
  return executionEnvironmentIsAvailableToUser(database, environmentId, userId);
}

export async function getEnvironment(
  database: Kysely<DatabaseSchema>,
  id: EnvironmentId,
): Promise<ExecutionEnvironmentRecord | null> {
  const row = await database
    .selectFrom("executionEnvironments")
    .select(["capabilities", "id", "kind", "name", "runnerId"])
    .where("id", "=", id)
    .executeTakeFirst();
  return row ?? null;
}

export async function assignEnvironmentRunner(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  runnerId: RunnerId,
): Promise<void> {
  await withDatabaseTransaction(database, async (transaction) => {
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("runnerId")
      .where("id", "=", environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Execution environment not found" });
    }
    if (environment.runnerId === runnerId) return;
    const boundThread = await transaction
      .selectFrom("threads")
      .select("id")
      .where("environmentId", "=", environmentId)
      .executeTakeFirst();
    if (boundThread) {
      throw new OpensteerError({
        code: "conflict",
        message: "A Thread-bound execution environment cannot change Runners",
      });
    }
    await transaction
      .updateTable("executionEnvironments")
      .set({ runnerId })
      .where("id", "=", environmentId)
      .executeTakeFirstOrThrow();
  });
}
