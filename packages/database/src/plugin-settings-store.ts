import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import {
  agentHomeSkillInventory,
  type AgentHomeSkillInventory,
} from "./agent-home-skill-inventory-store.js";
import { createId, OpensteerError, type UserId, RunnerIdSchema } from "@opensteer/core";
import { pluginDeviceFromManifest } from "@opensteer/integration-core/models";
import {
  PluginTargetSchema,
  PluginsOverviewViewSchema,
  SettingsPluginEnableCommandSchema,
  PluginPlacementSummarySchema,
  type PluginTarget,
  type PluginRow,
} from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSchema } from "./schema.js";
import { getSelfDeviceId } from "./device-inventory-store.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  findCommandByIdempotency,
  lockCommandIdempotency,
  principalIdForUser,
  idempotencyConflict,
  jsonValue,
} from "./store-primitives.js";

export function pluginTargetKey(input: PluginTarget): string {
  const target = PluginTargetSchema.parse(input);
  switch (target.kind) {
    case "device-app":
      return JSON.stringify([target.kind, target.definitionId]);
    case "plugin":
      return JSON.stringify([target.kind, target.pluginId]);
    case "skill":
      return JSON.stringify([target.kind, target.fullName]);
  }
}

export type { AgentHomeSkillInventory } from "./agent-home-skill-inventory-store.js";

export class PluginSettingsStore {
  private readonly database: Kysely<DatabaseSchema>;
  private readonly inventory:
    ((owner: UserId) => Promise<AgentHomeSkillInventory | null>) | undefined;
  constructor(
    database: Kysely<DatabaseSchema>,
    inventory?: (owner: UserId) => Promise<AgentHomeSkillInventory | null>,
  ) {
    this.database = database;
    this.inventory = inventory ?? ((owner) => agentHomeSkillInventory(database, owner));
  }

  async affectedViewers(_input: {
    runnerId?: string;
    installationId?: string;
    pluginId?: string;
    requestId?: string;
  }): Promise<UserId[]> {
    return (await this.database.selectFrom("personalSettings").select("ownerId").execute()).map(
      (row) => row.ownerId,
    );
  }

  async skillPolicy(owner: UserId) {
    await requirePersonalOwner(this.database, owner);
    const settings = await this.database
      .selectFrom("pluginOwnerSettings")
      .selectAll()
      .where("ownerUserId", "=", owner)
      .execute();
    const skills = settings.filter((setting) => setting.target.kind === "skill");
    if (!skills.length) return undefined;
    return {
      revision: skills.reduce((sum, setting) => sum + setting.revision, 0),
      disabledFullNames: skills
        .flatMap((setting) =>
          setting.target.kind === "skill" && !setting.enabled ? [setting.target.fullName] : [],
        )
        .sort(),
    };
  }

  private async rows(owner: UserId): Promise<PluginRow[]> {
    await requirePersonalOwner(this.database, owner);
    const [settings, packages, tools, inventory] = await Promise.all([
      this.database
        .selectFrom("pluginOwnerSettings")
        .selectAll()
        .where("ownerUserId", "=", owner)
        .execute(),
      this.database
        .selectFrom("plugins")
        .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
        .selectAll("plugins")
        .select("pluginVersions.manifest")
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("integrationInstallations")
                .innerJoin(
                  "integrationServers",
                  "integrationServers.installationId",
                  "integrationInstallations.id",
                )
                .select("integrationServers.id")
                .whereRef("integrationInstallations.pluginId", "=", "plugins.id")
                .where(sql<string>`integration_servers.transport->>'type'`, "=", "runner"),
            ),
          ),
        )
        .execute(),
      this.database
        .selectFrom("integrationTools")
        .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
        .innerJoin(
          "integrationInstallations",
          "integrationInstallations.id",
          "integrationServers.installationId",
        )
        .select("integrationInstallations.pluginId")
        .execute(),
      this.inventory?.(owner) ?? Promise.resolve(null),
    ]);
    const placement = (target: PluginTarget) => {
      const setting = settings.find((row) => row.targetKey === pluginTargetKey(target));
      return { enabled: setting?.enabled ?? true, revision: setting?.revision ?? 0 };
    };
    const rows: PluginRow[] = [];
    for (const plugin of packages) {
      const target: PluginTarget = { kind: "plugin", pluginId: plugin.id };
      const skills = Array.isArray(plugin.manifest.skills) ? plugin.manifest.skills.length : 0;
      const row: PluginRow = {
        target,
        title: plugin.name,
        description:
          typeof plugin.manifest.description === "string"
            ? plugin.manifest.description.slice(0, 320)
            : null,
        source: {
          kind: "plugin",
          version: typeof plugin.manifest.version === "string" ? plugin.manifest.version : null,
        },
        tags: ["skills"],
        placement: placement(target),
        accountCount: 0,
        issues: [],
        contents: {
          skills,
          tools: tools.filter((tool) => tool.pluginId === plugin.id).length,
        },
        permissions: {
          canEnable: true,
          canPlace: false,
          canRemove: true,
          canUpdate: typeof plugin.source.directory === "string",
        },
        device: pluginDeviceFromManifest(plugin.manifest),
      };
      rows.push(row);
    }
    rows.push(...projectLooseSkillRows(inventory, settings));
    return rows;
  }

  async setEnabled(
    owner: UserId,
    input: import("zod").infer<typeof SettingsPluginEnableCommandSchema>,
    administration?: AdministrationCommandIdentity,
  ) {
    const command = SettingsPluginEnableCommandSchema.parse(input);
    const { target } = command;
    return commitPersonalMutation(this.database, async (tx, mutation) => {
      mutation.bumpResource("plugin");
      await requirePersonalOwner(tx, owner);
      if (target.kind === "device-app")
        throw new OpensteerError({
          code: "not_found",
          message: "Manage data app access in Plugins",
        });
      return administrationCommand(tx, administration, async () => {
        if (!administration) {
          await lockCommandIdempotency(tx, owner, command.idempotencyKey);
          const receipt = await findCommandByIdempotency(tx, owner, command.idempotencyKey);
          if (receipt) {
            const payload = receipt.payload;
            if (
              receipt.type !== command.type ||
              typeof payload !== "object" ||
              payload === null ||
              !("request" in payload) ||
              !isDeepStrictEqual(payload.request, command) ||
              !("placement" in payload)
            )
              throw idempotencyConflict(command.idempotencyKey);
            return {
              type: command.type,
              placement: PluginPlacementSummarySchema.parse(payload.placement),
            };
          }
        }
        const row = await new PluginSettingsStore(tx, this.inventory).row(owner, target);
        if (row.placement.revision !== command.expectedRevision)
          throw new OpensteerError({
            code: "conflict",
            message: "Plugin setting changed; read it again",
          });
        const saved = await tx
          .insertInto("pluginOwnerSettings")
          .values({
            ownerUserId: owner,
            targetKey: pluginTargetKey(target),
            target,
            enabled: command.enabled,
            revision: command.expectedRevision + 1,
          })
          .onConflict((conflict) =>
            conflict.columns(["ownerUserId", "targetKey"]).doUpdateSet({
              enabled: command.enabled,
              revision: sql<number>`plugin_owner_settings.revision + 1`,
            }),
          )
          .returning(["enabled", "revision"])
          .executeTakeFirstOrThrow();
        if (!administration)
          await tx
            .insertInto("commands")
            .values({
              id: createId("command"),
              actorPrincipalId: await principalIdForUser(tx, owner),
              authoritySource: jsonValue({ kind: "user-session", userId: owner }),
              requestedBy: owner,
              idempotencyKey: command.idempotencyKey,
              type: command.type,
              payload: jsonValue({ request: command, placement: saved }),
              status: "succeeded",
              environmentId: null,
              threadId: null,
              runId: null,
              dispatcherId: null,
              lastError: null,
            })
            .execute();
        return { type: command.type, placement: saved };
      });
    });
  }

  async overview(owner: UserId) {
    return PluginsOverviewViewSchema.parse({ rows: await this.rows(owner) });
  }

  async row(owner: UserId, target: PluginTarget): Promise<PluginRow> {
    const key = pluginTargetKey(target);
    const row = (await this.rows(owner)).find((row) => pluginTargetKey(row.target) === key);
    if (!row) throw new OpensteerError({ code: "not_found", message: "Plugin is unavailable" });
    return row;
  }

  async otherDevices(
    owner: UserId,
    machines: readonly {
      id: string;
      name: string;
      status: import("@opensteer/protocol").MachineSummary["status"];
    }[],
  ) {
    await requirePersonalOwner(this.database, owner);
    const packages = await this.database
      .selectFrom("plugins")
      .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
      .select(["plugins.id", "plugins.setupThreadId", "pluginVersions.manifest"])
      .execute();
    const devices = packages.filter((plugin) => pluginDeviceFromManifest(plugin.manifest));
    if (!devices.length) return [];
    const servers = await this.database
      .selectFrom("integrationServers")
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .select([
        "integrationInstallations.pluginId",
        "integrationServers.transport",
        "integrationServers.status",
        "integrationServers.statusDetail",
        "integrationServers.updatedAt",
        "integrationInstallations.updatedAt as installationUpdatedAt",
      ])
      .where(
        "integrationInstallations.pluginId",
        "in",
        devices.map((plugin) => plugin.id),
      )
      .execute();
    return Promise.all(
      devices.map(async (plugin) => {
        const own = servers.filter(
          (row) =>
            row.pluginId === plugin.id &&
            (row.status !== "disabled" || row.updatedAt > row.installationUpdatedAt),
        );
        const transport = own.find((row) => row.transport.type === "runner")?.transport;
        const runner =
          transport?.type === "runner" && typeof transport.runnerId === "string"
            ? RunnerIdSchema.parse(transport.runnerId)
            : null;
        const selfDevice = runner ? await getSelfDeviceId(this.database, runner) : null;
        const machine = machines.find((row) => row.id === selfDevice);
        return {
          pluginId: plugin.id,
          ...pluginDeviceFromManifest(plugin.manifest)!,
          computer: machine
            ? {
                id: runner!,
                name: machine.name.slice(0, 120),
                status: machine.status,
              }
            : null,
          issue: own.find((row) => row.status !== "active")?.statusDetail?.slice(0, 1000) ?? null,
          setupThreadId: plugin.setupThreadId,
        };
      }),
    );
  }
}

export function projectLooseSkillRows(
  inventory: AgentHomeSkillInventory | null,
  settings: readonly {
    readonly target: PluginTarget;
    readonly enabled: boolean;
    readonly revision: number;
  }[],
): PluginRow[] {
  if (!inventory) return [];
  return inventory.skills.map((skill) => {
    const target: PluginTarget = { kind: "skill", fullName: skill.fullName };
    const setting = settings.find((row) => pluginTargetKey(row.target) === pluginTargetKey(target));
    return {
      target,
      title: skill.fullName,
      description: skill.description || null,
      source: { kind: "folder", version: null },
      tags: ["skills"],
      placement: { enabled: setting?.enabled ?? true, revision: setting?.revision ?? 0 },
      accountCount: 0,
      issues:
        inventory.scanStatus === "failed"
          ? ["waiting-setup"]
          : inventory.stale
            ? ["waiting-device"]
            : [],
      contents: { skills: 1, tools: 0 },
      permissions: { canEnable: true, canPlace: false, canRemove: false, canUpdate: false },
    };
  });
}
