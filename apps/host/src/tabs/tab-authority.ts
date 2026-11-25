import {
  OpensteerError,
  isAllowedConnectionPageUrl,
  isPhoneDisplayDefinitionId,
  type ResourceAccessLevel,
  type DeviceId,
  DeviceTabTargetSchema,
  ThreadIdSchema,
  type ThreadId,
  type TabTarget,
  type UserId,
} from "@opensteer/core";
import {
  OpensteerStore,
  integrationConnectionGrantTarget,
  resolveResourceAccess,
  admitExecution,
  authoritySubject,
  bindingAgentConnectionId,
  standingGrant,
  executionAccess,
  authorizePageAddress,
  type AgentConnectionAuthority,
  requirePersonalOwner,
  lineageAllowsPersonalContext,
  type TabDatabase,
  type TabRecord,
  type TabWrite,
} from "@opensteer/database";
import type { ThisHomeAddressSet } from "@opensteer/shared/homeAddress";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core/computer-app";
import { requireDeviceAccess } from "../administration/device-access.js";
import type { TabActor } from "./ports.js";

export function tabOwner(actor: TabActor): UserId {
  if (actor.kind === "browser-binding") return actor.authority.ownerId;
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
  if (actor.kind === "browser-binding") return { agentBindingId: actor.authority.agentBindingId };
  return actor.kind === "run"
    ? { agentBindingId: `run:${actor.claims.runId}` }
    : actor.kind === "connection"
      ? { agentConnectionId: actor.caller.connectionId }
      : { kind: "person" as const };
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
/** The actor's live authority, and the connection it works for, if any. */
async function admitTabActor(
  actor: TabActor,
  database: TabDatabase,
  required: ResourceAccessLevel,
): Promise<AgentConnectionAuthority | null> {
  if (actor.kind === "person") {
    await requirePersonalOwner(database, actor.ownerId);
    return null;
  }
  if (actor.kind === "run") {
    await new OpensteerStore(database).assertActiveGrant(actor.claims);
  }
  const execution = await admitExecution(database, {
    ownerUserId: tabOwner(actor),
    subject: authoritySubject(scope(actor)),
    ...(actor.kind === "browser-binding" ? { threadId: actor.threadId } : {}),
  });
  // Work from a bridge anyone may speak to never sees the person's tabs; it is read from the
  // connection row this admission already read, and the person's own Run reads nothing more.
  if (actor.kind === "run" && !lineageAllowsPersonalContext(execution.agentConnection)) deny();
  requireAccess(executionAccess(execution), required);
  return execution.agentConnection;
}

/** One authority view for a projection; mutations build it again under the personal commit fence. */
export async function tabReadAuthority(
  actor: TabActor,
  database: TabDatabase,
  home: ThisHomeAddressSet,
) {
  const lineage = await admitTabActor(actor, database, "read");
  return tabTargetAuthority(actor, database, lineage, home);
}

function tabTargetAuthority(
  actor: TabActor,
  database: TabDatabase,
  lineage: AgentConnectionAuthority | null,
  home: ThisHomeAddressSet,
) {
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
        .then((row) => row?.originConnectionId === selected?.agentConnectionId);
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
    // Rule 1's page rule: to a connection's work a page on an extension's address does not exist,
    // and to any agent's work a page on an address of this Home does not.
    if (
      target.kind === "page" &&
      "url" in target &&
      !authorizePageAddress(pageExecution(actor, lineage), target.url, home)
    )
      return false;
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
    if (
      actor.kind === "browser-binding" &&
      "id" in target &&
      target.openedBy !== "person" &&
      target.openedBy?.taskId !== actor.threadId
    )
      return false;
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
  home: ThisHomeAddressSet,
): Promise<void> {
  if (actor.kind === "person") {
    await authorizeTabActor(actor, database, "read-write");
    if (!(await (await tabReadAuthority(actor, database, home))(target, "read-write"))) deny();
    return;
  }
  const lineage = await admitTabActor(actor, database, "read-write");
  // A tab an agent opens may not be on an address of this Home (rule 1): it is refused exactly as
  // an address a connection may not open, naming nothing of the Home.
  if (
    "kind" in target &&
    target.kind === "page" &&
    "url" in target &&
    ((lineage !== null && !isAllowedConnectionPageUrl(target.url)) ||
      !authorizePageAddress(pageExecution(actor, lineage), target.url, home))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Use about:blank or an HTTP(S) URL without credentials.",
    });
  if (!(await tabTargetAuthority(actor, database, lineage, home)(target, "read-write"))) deny();
}

/** Whose work a tab check is for, as rule 1's page rule reads it. */
function pageExecution(actor: TabActor, lineage: AgentConnectionAuthority | null) {
  return { agentConnection: lineage, actor: actor.kind === "person" ? "person" : "agent" } as const;
}
export async function canReadTab(
  actor: TabActor,
  row: TabRecord,
  database: TabDatabase,
  home: ThisHomeAddressSet,
): Promise<boolean> {
  try {
    return await (
      await tabReadAuthority(actor, database, home)
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
 * The tabs an edit affects that work for a selected connection may not change. The person's own
 * work keeps membership authority over the whole strip and pays one indexed read for it.
 */
export async function deniedTabRows(
  actor: TabActor,
  rows: readonly TabRecord[],
  database: TabDatabase,
  home: ThisHomeAddressSet,
): Promise<ReadonlySet<TabRecord["id"]>> {
  if (actor.kind === "person" || !rows.length) return new Set();
  const agentConnectionId =
    actor.kind === "connection"
      ? actor.caller.connectionId
      : await bindingAgentConnectionId(database, scope(actor).agentBindingId!);
  if (!agentConnectionId) return new Set();
  const connection = await admitTabActor(actor, database, "read-write");
  if (connection?.grant.scope !== "selected") return new Set();
  const check = tabTargetAuthority(actor, database, connection, home);
  const denied = new Set<TabRecord["id"]>();
  for (const row of rows) if (!(await check(row, "read-write"))) denied.add(row.id);
  return denied;
}

/**
 * The tasks an actor may see as a tab's opener or user: the person's own, and for work in a
 * selected connection's lineage only that lineage's.
 */
export async function readableTabTasks(
  actor: TabActor,
  ids: readonly ThreadId[],
  database: TabDatabase,
): Promise<Set<ThreadId>> {
  if (!ids.length) return new Set();
  const agentConnectionId =
    actor.kind === "person"
      ? null
      : actor.kind === "connection"
        ? actor.caller.connectionId
        : await bindingAgentConnectionId(database, scope(actor).agentBindingId!);
  const rows = await database
    .selectFrom("threads")
    .select(["id", "originConnectionId"])
    .where("id", "in", [...ids])
    .where("createdBy", "=", tabOwner(actor))
    .execute();
  if (!agentConnectionId) return new Set(rows.map((row) => row.id));
  // What it may see is authority: read through the one standing statement, as the last read
  // before it is used. A connection with no standing sees no task at all; a selected grant sees
  // its own lineage's.
  const grant = await standingGrant(database, tabOwner(actor), agentConnectionId);
  if (grant === null) return new Set();
  return new Set(
    rows
      .filter((row) => grant.scope !== "selected" || row.originConnectionId === agentConnectionId)
      .map((row) => row.id),
  );
}
