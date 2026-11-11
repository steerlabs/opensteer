import { createId, ProjectRunBindingSchema } from "@opensteer/core";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import type { StoreFixture } from "./store.integration.test-support.js";
import type { ProjectRequestControlPort } from "./project-execution-store.js";
import type { ProjectRunControl } from "@opensteer/protocol";

export async function projectRequestFixture(fixture: StoreFixture, suffix: string) {
  const run = await fixture.startRunFixture(suffix, "project");
  const database = fixture.database;
  await database
    .updateTable("users")
    .set({ admittedAt: new Date(), memberState: "active" })
    .where("id", "=", run.userId)
    .execute();
  await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
  const principalId = PrincipalIdSchema.parse(`pri_${randomUUID()}`);
  await database
    .insertInto("principals")
    .values({
      id: principalId,
      kind: "project",
      userId: null,
      workspaceId: run.workspace.id,
      displayName: "Project",
    })
    .execute();
  await database
    .updateTable("runs")
    .set({ actorPrincipalId: principalId, initiatorGeneration: 1 })
    .where("id", "=", run.run.id)
    .execute();
  const grant = await database
    .selectFrom("grants")
    .selectAll()
    .where("runId", "=", run.run.id)
    .executeTakeFirstOrThrow();
  const binding = ProjectRunBindingSchema.parse({
    authority: {
      version: 1,
      principal: { kind: "project", principalId, workspaceId: run.workspace.id },
      origin: {
        userId: run.userId,
        initiatorGeneration: 1,
        membershipGeneration: 1,
        originConnectionId: null,
      },
    },
    bindingGeneration: grant.bindingGeneration,
    environmentId: run.environmentId,
    grantId: grant.id,
    runId: run.run.id,
    runnerBootId: grant.runnerBootId,
    runnerId: grant.runnerId,
    threadId: run.thread.id,
    workspaceId: run.workspace.id,
  });
  const connectionId = `mcn_${randomUUID()}`;
  await database
    .insertInto("agentConnections")
    .values({
      id: connectionId,
      userId: run.userId,
      label: "Root",
      clientName: "Test",
      accessMode: "full-access",
      workspaceId: run.workspace.id,
      resource: "https://team.test/mcp",
      tokenHash: null,
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      memberGeneration: "1",
      membershipGeneration: "1",
    })
    .execute();
  const sessionId = createId("authSession");
  await sql`insert into auth_sessions (id, user_id, token, expires_at, absolute_expires_at,
    device_label, last_seen_at, created_at, updated_at, member_generation)
    values (${sessionId}, ${run.userId}, ${sessionId}, now() + interval '1 hour', now() + interval '1 hour',
      'Test', now(), now(), now(), 1)`.execute(database);
  return { ...run, binding, grant, sessionId, connectionId };
}

export function recordingProjectControls() {
  const records = new Map<string, ProjectRunControl>();
  const staged = new WeakMap<Transaction<DatabaseSchema>, Map<string, ProjectRunControl>>();
  const port: ProjectRequestControlPort = {
    async find(transaction, input) {
      const id = JSON.stringify([input.binding.grantId, input.idempotencyKey]);
      return staged.get(transaction)?.get(id) ?? records.get(id) ?? null;
    },
    async enqueue(transaction, input) {
      const id = JSON.stringify([input.binding.grantId, input.idempotencyKey]);
      const changes = staged.get(transaction) ?? new Map<string, ProjectRunControl>();
      staged.set(transaction, changes);
      const previous = changes.get(id) ?? records.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(input.control))
        throw new Error("Control identity collision");
      if (previous) return { created: false };
      changes.set(id, input.control);
      return { created: true };
    },
  };
  async function transact<Result>(
    database: Kysely<DatabaseSchema>,
    operation: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
  ): Promise<Result> {
    let changes: Map<string, ProjectRunControl> | undefined;
    const result = await database.transaction().execute(async (transaction) => {
      const value = await operation(transaction);
      changes = staged.get(transaction);
      return value;
    });
    for (const [id, control] of changes ?? []) records.set(id, control);
    return result;
  }
  return { port, records, transact };
}
