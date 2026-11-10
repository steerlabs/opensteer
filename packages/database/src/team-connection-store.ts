import { createHash } from "node:crypto";
import { createId, type AuthenticatedHuman } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requireTeamHuman, teamRefusal } from "./team-administration-authority.js";
import { RequestLockSetChanged, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import type { AccessWorkRevocationPort, AccessWorkRevocationRoot } from "./access-store.js";
import { nonTerminalRunStatuses } from "@opensteer/core";
import type { Transaction } from "kysely";
import { jsonValue, safeGeneration } from "./store-primitives.js";

export async function revokeTeamConnection(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  input: { connectionId: string; expectedRevision: number; idempotencyKey: string },
  work?: AccessWorkRevocationPort,
) {
  await requireTeamHuman(database, actor);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const plans = new WeakMap<
    Transaction<DatabaseSchema>,
    {
      connection: Awaited<ReturnType<typeof readConnection>>;
      revision: number;
      replay: boolean;
      roots: readonly AccessWorkRevocationRoot[];
      scope: Awaited<ReturnType<typeof discover>>;
    }
  >();
  async function readConnection(transaction: Transaction<DatabaseSchema>) {
    const human = await requireTeamHuman(transaction, actor);
    const connection = await transaction
      .selectFrom("agentConnections")
      .selectAll()
      .where("id", "=", input.connectionId)
      .$if(human.instanceRole !== "administrator", (query) => query.where("userId", "=", human.id))
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!connection) teamRefusal("team-object-unavailable", "not_found");
    return connection;
  }
  async function discover(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly AccessWorkRevocationRoot[],
  ) {
    const runs = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "threads.workspaceId"])
      .where("runs.originConnectionId", "=", input.connectionId)
      .where("runs.status", "in", nonTerminalRunStatuses)
      .execute();
    const requests = runs.length
      ? await transaction
          .selectFrom("requests")
          .select(["originatingWorkspaceId", "targetWorkspaceId"])
          .where(
            "originatingRunId",
            "in",
            runs.map((run) => run.id),
          )
          .where("status", "=", "pending")
          .execute()
      : [];
    const extra = roots.length ? await work?.discover(transaction, roots) : undefined;
    return {
      runIds: [...new Set([...runs.map((row) => row.id), ...(extra?.runIds ?? [])])],
      workspaceIds: [
        ...new Set([
          ...runs.map((row) => row.workspaceId),
          ...requests.flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]),
          ...(extra?.workspaceIds ?? []),
        ]),
      ],
    };
  }
  return withRequestWorkspaceLocks(
    database,
    async (transaction) => {
      const plan = plans.get(transaction)!;
      const scope = await discover(transaction, plan.roots);
      if (scope.runIds.some((id) => !plan.scope.runIds.includes(id)))
        throw new RequestLockSetChanged(scope.workspaceIds);
      return [
        ...scope.workspaceIds,
        ...(plan.connection.workspaceId ? [plan.connection.workspaceId] : []),
      ];
    },
    async (transaction) => {
      const plan = plans.get(transaction)!;
      if (plan.roots.length) await work?.cancel(transaction, plan.roots);
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", actor.userId)
        .forShare()
        .executeTakeFirstOrThrow();
      if (actor.sessionId)
        await transaction
          .selectFrom("authSessions")
          .select("id")
          .where("id", "=", actor.sessionId)
          .forShare()
          .executeTakeFirst();
      await requireTeamHuman(transaction, actor);
      if (plan.replay) return { accessRevision: plan.revision, revoked: true as const };
      await transaction
        .updateTable("agentConnections")
        .set({ revokedAt: sql`clock_timestamp()`, tokenHash: null })
        .where("id", "=", plan.connection.id)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("securityAudit")
        .values({
          id: createId("securityAudit"),
          action: "team.connection.revoke",
          actorUserId: actor.userId,
          actorSessionId: actor.sessionId ?? null,
          workspaceId: null,
          requestId: input.idempotencyKey,
          targetType: "connection",
          targetId: plan.connection.id,
          metadata: jsonValue({ fingerprint }),
        })
        .execute();
      return { accessRevision: plan.revision, revoked: true as const };
    },
    async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:access-writer', 0))`.execute(
        transaction,
      );
      const state = await transaction
        .selectFrom("accessState")
        .select("revision")
        .where("singletonKey", "=", "primary")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const connection = await readConnection(transaction);
      const receipt = await transaction
        .selectFrom("securityAudit")
        .select("metadata")
        .where("action", "=", "team.connection.revoke")
        .where("actorUserId", "=", actor.userId)
        .where("requestId", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (receipt && receipt.metadata.fingerprint !== fingerprint)
        teamRefusal("idempotency-conflict", "conflict");
      if (!receipt && safeGeneration(state.revision) !== input.expectedRevision)
        teamRefusal("access-revision-changed", "conflict");
      const roots: AccessWorkRevocationRoot[] =
        !receipt &&
        !connection.revokedAt &&
        connection.workspaceId &&
        connection.memberGeneration !== null &&
        connection.membershipGeneration !== null
          ? [
              {
                kind: "connection",
                connectionId: connection.id,
                userId: connection.userId,
                workspaceId: connection.workspaceId,
                memberGenerationCutoff: safeGeneration(connection.memberGeneration),
                membershipGenerationCutoff: safeGeneration(connection.membershipGeneration),
              },
            ]
          : [];
      const scope = await discover(transaction, roots);
      if (scope.runIds.length)
        await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "in", scope.runIds)
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
      plans.set(transaction, {
        connection,
        revision: safeGeneration(state.revision),
        replay: !!receipt,
        roots,
        scope,
      });
    },
  );
}
