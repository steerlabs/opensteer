import { withDatabaseTransaction } from "./connection.js";
import {
  type HostInstanceId,
  type Deployment,
  type DeploymentShape,
  DeploymentSchema,
  type DeploymentId,
  OpensteerError,
  createId,
  type UserId,
} from "@opensteer/core";
import { type Kysely, sql } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { isDeepStrictEqual } from "node:util";
import { jsonValue } from "./store-primitives.js";

function deploymentFromRow(row: {
  readonly activeHostInstanceId: HostInstanceId;
  readonly canonicalOrigin: string;
  readonly createdAt: Date;
  readonly id: Deployment["id"];
  readonly lifecycle: Deployment["lifecycle"];
  readonly singletonKey: "primary";
  readonly updatedAt: Date;
  readonly deploymentShape: DeploymentShape;
}): Deployment {
  return DeploymentSchema.parse({
    activeHostInstanceId: row.activeHostInstanceId,
    canonicalOrigin: row.canonicalOrigin,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    lifecycle: row.lifecycle,
    updatedAt: row.updatedAt.toISOString(),
    deploymentShape: row.deploymentShape,
  });
}

export async function getDeployment(database: Kysely<DatabaseSchema>): Promise<Deployment | null> {
  const row = await database.selectFrom("deployments").selectAll().executeTakeFirst();
  return row ? deploymentFromRow(row) : null;
}

export async function ensureDeployment(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly canonicalOrigin: string;
    readonly deploymentId?: DeploymentId;
    readonly hostInstanceId: HostInstanceId;
    readonly deploymentShape: DeploymentShape;
  },
): Promise<Deployment> {
  return withDatabaseTransaction(database, async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('opensteer-deployment-identity', 0))`.execute(
      transaction,
    );
    const existing = await transaction
      .selectFrom("deployments")
      .selectAll()
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (existing) {
      if (input.deploymentId !== undefined && existing.id !== input.deploymentId) {
        throw new OpensteerError({
          code: "conflict",
          details: {
            configuredDeploymentId: input.deploymentId,
            storedDeploymentId: existing.id,
          },
          message: "The managed Deployment identity does not match durable Host state",
        });
      }
      if (existing.activeHostInstanceId !== input.hostInstanceId) {
        throw new OpensteerError({
          code: "conflict",
          details: {
            activeHostInstanceId: existing.activeHostInstanceId,
            deploymentId: existing.id,
            hostInstanceId: input.hostInstanceId,
          },
          message:
            "This Deployment belongs to another Host instance; complete a Deployment transfer before starting it here",
        });
      }
      if (existing.canonicalOrigin !== input.canonicalOrigin) {
        throw new OpensteerError({
          code: "conflict",
          details: {
            configuredCanonicalOrigin: input.canonicalOrigin,
            deploymentId: existing.id,
            storedCanonicalOrigin: existing.canonicalOrigin,
          },
          message:
            "The configured canonical origin does not match this Deployment; rotate it explicitly before startup",
        });
      }
      if (!isDeepStrictEqual(existing.deploymentShape, input.deploymentShape)) {
        throw new OpensteerError({
          code: "conflict",
          details: {
            configuredWorkspaceProfile: input.deploymentShape,
            deploymentId: existing.id,
            storedWorkspaceProfile: existing.deploymentShape,
          },
          message:
            "The configured Workspace backing does not match this Deployment; migrate storage explicitly before changing it",
        });
      }
      if (existing.lifecycle !== "active") {
        throw new OpensteerError({
          code: "conflict",
          details: { deploymentId: existing.id, lifecycle: existing.lifecycle },
          message: `Deployment cannot start while it is ${existing.lifecycle}`,
        });
      }
      return deploymentFromRow(existing);
    }
    const now = new Date();
    const created = await transaction
      .insertInto("deployments")
      .values({
        activeHostInstanceId: input.hostInstanceId,
        canonicalOrigin: input.canonicalOrigin,
        createdAt: now,
        id: input.deploymentId ?? createId("deployment"),
        lifecycle: "active",
        singletonKey: "primary",
        updatedAt: now,
        deploymentShape: jsonValue(input.deploymentShape),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return deploymentFromRow(created);
  });
}

export async function createUser(
  database: Kysely<DatabaseSchema>,
  displayName: string,
  id = createId("user"),
): Promise<UserId> {
  const now = new Date();
  await database
    .insertInto("users")
    .values({
      createdAt: now,
      disabledAt: null,
      displayName,
      email: `${id}@test.invalid`,
      emailVerified: true,
      id,
      image: null,
      instanceRole: "user",
      updatedAt: now,
    })
    .executeTakeFirstOrThrow();
  return id;
}

export async function firstUser(
  database: Kysely<DatabaseSchema>,
): Promise<{ readonly id: UserId; readonly displayName: string } | null> {
  const row = await database
    .selectFrom("users")
    .select(["id", "displayName"])
    .orderBy("createdAt", "asc")
    .executeTakeFirst();
  return row ?? null;
}

export async function userById(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
): Promise<{
  readonly disabledAt: Date | null;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly id: UserId;
  readonly image: string | null;
  readonly instanceRole: "administrator" | "user";
} | null> {
  const row = await database
    .selectFrom("users")
    .select(["disabledAt", "displayName", "email", "emailVerified", "id", "image", "instanceRole"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row ?? null;
}
