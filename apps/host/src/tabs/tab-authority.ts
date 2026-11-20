import {
  OpensteerError,
  isPhoneDisplayDefinitionId,
  type ResourceAccessLevel,
  type DeviceId,
  DeviceTabTargetSchema,
  ThreadIdSchema,
  type TabTarget,
  type UserId,
} from "@opensteer/core";
import {
  OpensteerStore,
  integrationConnectionGrantTarget,
  resolveResourceAccess,
  type AuthorityLineage,
  requirePersonalOwner,
  runAllowsPersonalContext,
  type TabDatabase,
  type TabRecord,
  type TabWrite,
} from "@opensteer/database";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core/computer-app";
import { requireDeviceAccess } from "../administration/device-access.js";
import type { TabActor } from "./ports.js";

export function tabOwner(actor: TabActor): UserId {
  return actor.kind === "person"
    ? actor.ownerId
    : actor.kind === "run"
      ? actor.claims.requestedBy
      : actor.caller.userId;
}
export async function tabComputers(ownerId: UserId, ids: DeviceId[], database: TabDatabase) {
  const [rows, owners] = await Promise.all([
    ids.length
      ? database
          .selectFrom("devices")
          .leftJoin("deviceDrivers as self", (join) =>
            join
              .onRef("self.deviceId", "=", "devices.id")
              .on("self.role", "=", "self")
              .on("self.detachedAt", "is", null),
          )
          .select(["devices.id", "name", "removedAt", "self.runnerId as selfRunnerId"])
          .where("devices.id", "in", ids)
          .execute()
      : [],
    new OpensteerStore(database).effectiveDeviceOwners(ids),
  ]);
  return new Map(
    ids.map((id) => {
      const row = rows.find((row) => row.id === id);
      return [
        id,
        {
          name: row?.name ?? "Computer",
          selfRunnerId: row?.selfRunnerId ?? null,
          removed: !row || row.removedAt !== null || owners.get(id)?.effectiveOwner !== ownerId,
        },
      ];
    }),
  );
}
export async function tabComputer(ownerId: UserId, computerId: DeviceId, database: TabDatabase) {
  return (await tabComputers(ownerId, [computerId], database)).get(computerId)!;
}
function scope(actor: TabActor) {
  return actor.kind === "run"
    ? { agentBindingId: `run:${actor.claims.runId}` }
    : actor.kind === "connection"
      ? { connectionId: actor.caller.connectionId }
      : {};
}
function deny(): never {
  throw new OpensteerError({ code: "not_found", message: "Tab not found." });
}
function requireAccess(access: ResourceAccessLevel | null, required: ResourceAccessLevel) {
  if (!access) deny();
  if (required === "read-write" && access !== "read-write")
    throw new OpensteerError({
      code: "forbidden",
      message: "Changing tabs requires read-write access.",
    });
}
export async function authorizeTabActor(
  actor: TabActor,
  database: TabDatabase,
  required: ResourceAccessLevel = "read-write",
): Promise<void> {
  await admitTabActor(actor, database, required);
}
/** The actor's live authority, and the connection lineage it works for, if any. */
async function admitTabActor(
  actor: TabActor,
  database: TabDatabase,
  required: ResourceAccessLevel,
): Promise<AuthorityLineage | null> {
  if (actor.kind === "person") {
    await requirePersonalOwner(database, actor.ownerId);
    return null;
  }
  if (actor.kind === "run") {
    await new OpensteerStore(database).assertActiveGrant(actor.claims);
    if (!(await runAllowsPersonalContext(database, actor.claims.runId))) deny();
  }
  const access = await resolveResourceAccess(database, {
    ownerUserId: tabOwner(actor),
    explicitAccess: "read-write",
    grantTarget: "actor",
    ...scope(actor),
  });
  requireAccess(access.access, required);
  return access.authority.lineage;
}

/** One authority view for a projection; mutations build it again under the personal commit fence. */
export async function tabReadAuthority(actor: TabActor, database: TabDatabase) {
  const lineage = await admitTabActor(actor, database, "read");
  const selected = lineage?.grant.scope === "selected" ? lineage : null;
  const lineageTasks = new Map<string, Promise<boolean>>();
  // A selected grant sees only tabs its own lineage's tasks opened.
  const inLineage = (taskId: string) => {
    let held = lineageTasks.get(taskId);
    if (!held) {
      held = database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", ThreadIdSchema.parse(taskId))
        .executeTakeFirst()
        .then((row) => row?.originConnectionId === selected?.connectionId);
      lineageTasks.set(taskId, held);
    }
    return held;
  };
  const ownerId = tabOwner(actor);
  const computers = new Map<DeviceId, Promise<boolean>>();
  const resources = new Map<string, Promise<boolean>>();
  const devices = new Map<string, Promise<void>>();
  const connectionRows = database
    .selectFrom("integrationConnections")
    .select(["id", "deviceId", "computerAccess", "computerApp", "integrationDefinitionId"])
    .where("ownerUserId", "=", ownerId)
    .where("connectionKind", "=", "computer")
    .where("status", "!=", "revoked")
    .where("computerBlockedAt", "is", null);
  let native: ReturnType<typeof connectionRows.execute> | undefined;
  const profileRows = database
    .selectFrom("browserProfiles")
    .select(["id", "homeRunnerId"])
    .where("ownerId", "=", ownerId);
  let profiles: ReturnType<typeof profileRows.execute> | undefined;
  const appRows = database
    .selectFrom("apps")
    .select(["id", "computerId", "deleting"])
    .where("ownerId", "=", ownerId);
  let apps: ReturnType<typeof appRows.execute> | undefined;
  const check = async (
    targetInput: TabTarget | TabWrite,
    required: ResourceAccessLevel = "read",
  ): Promise<boolean> => {
    const target =
      "ownerId" in targetInput ? targetInput : DeviceTabTargetSchema.parse(targetInput);
    if ("ownerId" in target && target.ownerId !== ownerId) return false;
    if (actor.kind === "person" && "id" in target && required === "read") return true;
    let computerId = "computerId" in target ? target.computerId : undefined;
    const profileId = target.kind === "page" && "profileId" in target ? target.profileId : null;
    if (target.kind === "app") {
      const app = (await (apps ??= appRows.execute())).find((app) => app.id === target.appId);
      if (!app || app.deleting) return false;
      computerId = await new OpensteerStore(database).requireSelfDeviceId(app.computerId);
    } else if (profileId) {
      const profile = (await (profiles ??= profileRows.execute())).find(
        (profile) => profile.id === profileId,
      );
      if (
        !profile ||
        (computerId &&
          profile.homeRunnerId !==
            (await new OpensteerStore(database).requireDeviceSelfRunnerId(computerId)))
      )
        return false;
      computerId = profile.homeRunnerId
        ? await new OpensteerStore(database).requireSelfDeviceId(profile.homeRunnerId)
        : undefined;
    }
    if (computerId) {
      let allowed = computers.get(computerId);
      if (!allowed) {
        const id = computerId;
        allowed = tabComputer(ownerId, id, database).then((computer) => !computer.removed);
        computers.set(id, allowed);
      }
      if (!(await allowed)) return false;
    }
    if (actor.kind === "person") return true;
    if (selected) {
      if (!("openedBy" in target) || target.openedBy === "person") {
        if ("id" in target) return false;
      } else if (target.openedBy && !(await inLineage(target.openedBy.taskId))) return false;
    }
    if (!computerId && !(target.kind === "page" && "guest" in target)) return false;
    if (computerId) {
      const capability = target.kind === "page" ? "browser" : "apps";
      const key = `${computerId}:${capability}`;
      let admission = devices.get(key);
      if (!admission) {
        admission = requireDeviceAccess(database, computerId, capability, true);
        devices.set(key, admission);
      }
      await admission;
    }
    if (target.kind === "window" || target.kind === "phone") {
      const connections = (await (native ??= connectionRows.execute())).filter(
        (connection) => connection.deviceId === computerId,
      );
      for (const connection of connections) {
        if (
          target.kind === "phone"
            ? !isPhoneDisplayDefinitionId(connection.integrationDefinitionId)
            : connection.integrationDefinitionId !== "macos-app" ||
              !connection.computerApp ||
              ("windowApp" in target
                ? !target.windowApp ||
                  !computerAppIdentitiesEqual(connection.computerApp, target.windowApp)
                : "bundleId" in target && connection.computerApp.bundleId !== target.bundleId)
        )
          continue;
        const access = await resolveResourceAccess(database, {
          ownerUserId: ownerId,
          ...scope(actor),
          explicitAccess: "read-write",
          connectionCeiling: connection.computerAccess,
          grantTarget: integrationConnectionGrantTarget(connection),
        });
        if (access.access && (required === "read" || access.access === "read-write")) return true;
      }
      return false;
    }
    const key = `${target.kind}:${profileId ?? computerId ?? "guest"}:${required}`;
    let allowed = resources.get(key);
    if (!allowed) {
      allowed = resolveResourceAccess(database, {
        ownerUserId: ownerId,
        ...scope(actor),
        explicitAccess: "read-write",
        // Mini-apps and guest pages have no selected resource kind.
        grantTarget: profileId ? { kind: "browser-profile", profileId } : { kind: "device" },
      }).then(({ access }) => Boolean(access && (required === "read" || access === "read-write")));
      resources.set(key, allowed);
    }
    return allowed;
  };
  return async (target: TabTarget | TabWrite, required: ResourceAccessLevel = "read") => {
    try {
      return await check(target, required);
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        ["forbidden", "not_found", "runner_offline"].includes(error.code)
      )
        return false;
      throw error;
    }
  };
}
export async function authorizeTabTarget(
  actor: TabActor,
  target: TabTarget | TabWrite,
  database: TabDatabase,
): Promise<void> {
  await authorizeTabActor(actor, database, "read-write");
  if (!(await (await tabReadAuthority(actor, database))(target, "read-write"))) deny();
}
export async function canReadTab(
  actor: TabActor,
  row: TabRecord,
  database: TabDatabase,
): Promise<boolean> {
  try {
    return await (
      await tabReadAuthority(actor, database)
    )(row);
  } catch (error) {
    if (
      error instanceof OpensteerError &&
      ["forbidden", "not_found", "runner_offline"].includes(error.code)
    )
      return false;
    throw error;
  }
}

/**
 * Work in a selected connection's lineage may change only tabs it may change; the person's own
 * work keeps membership authority over the whole strip.
 */
export async function authorizeTabRows(
  actor: TabActor,
  rows: readonly TabRecord[],
  database: TabDatabase,
): Promise<void> {
  if (actor.kind === "person" || !rows.length) return;
  const lineage = await admitTabActor(actor, database, "read-write");
  if (lineage?.grant.scope !== "selected") return;
  const check = await tabReadAuthority(actor, database);
  for (const row of rows) if (!(await check(row, "read-write"))) deny();
}
