import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import {
  OpensteerStore,
  resolveResourceAccess,
  runAllowsPersonalContext,
  type TabDatabase,
  type TabRecord,
} from "@opensteer/database";
import type { TabActor } from "./ports.js";

export function tabOwner(actor: TabActor): UserId {
  return actor.kind === "person"
    ? actor.ownerId
    : actor.kind === "run"
      ? actor.claims.requestedBy
      : actor.caller.userId;
}

export async function tabComputer(ownerId: UserId, computerId: RunnerId, database: TabDatabase) {
  const store = new OpensteerStore(database);
  const row = await database
    .selectFrom("runners")
    .select(["name", "revokedAt"])
    .where("id", "=", computerId)
    .executeTakeFirst();
  const owners = await store.effectiveMachineOwners([computerId]);
  return {
    name: row?.name ?? "Computer",
    removed: !row || row.revokedAt !== null || owners.get(computerId)?.effectiveOwner !== ownerId,
  };
}

export async function authorizeTabActor(actor: TabActor, database: TabDatabase): Promise<void> {
  if (actor.kind === "run") {
    await new OpensteerStore(database).assertActiveGrant(actor.claims);
    if (!(await runAllowsPersonalContext(database, actor.claims.runId)))
      throw new OpensteerError({ code: "forbidden", message: "This Run has no personal context." });
  }
  const access = await resolveResourceAccess(database, {
    ownerUserId: tabOwner(actor),
    explicitAccess: "read-write",
    ...(actor.kind === "run"
      ? { agentBindingId: `run:${actor.claims.runId}` }
      : actor.kind === "connection"
        ? { connectionId: actor.caller.connectionId }
        : {}),
  });
  if (!access.access) throw new OpensteerError({ code: "not_found", message: "Tab not found." });
}

export async function canReadTab(
  actor: TabActor,
  row: TabRecord,
  database: TabDatabase,
): Promise<boolean> {
  try {
    await authorizeTabActor(actor, database);
    if (row.ownerId !== tabOwner(actor)) return false;
    return true;
  } catch {
    return false;
  }
}
