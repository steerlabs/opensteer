import { listWorkspaceSkillInventory } from "./workspace-skill-inventory-store.js";
import { PluginStore } from "./plugin-store.js";
import {
  writeIntegrationGrantInTransaction,
  validateIntegrationGrantInTransaction,
} from "./integration-grant-write.js";
import type { IntegrationProviderAuthorization } from "@opensteer/integration-core";
import { isDeepStrictEqual } from "node:util";
import {
  findCommandByIdempotency,
  lockCommandIdempotency,
  principalIdForUser,
  idempotencyConflict,
  jsonValue,
} from "./store-primitives.js";
import {
  SettingsPluginEnableCommandSchema,
  SettingsPluginPlacementCommandSchema,
  PluginPlacementSummarySchema,
} from "@opensteer/protocol";
import { createId, OpensteerError, type UserId } from "@opensteer/core";
import {
  PluginTargetSchema,
  PluginsOverviewViewSchema,
  PluginDetailViewSchema,
  type PluginTarget,
  type PluginRow,
} from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export function pluginTargetKey(input: PluginTarget): string {
  const target = PluginTargetSchema.parse(input);
  switch (target.kind) {
    case "service":
    case "device-app":
      return JSON.stringify([target.kind, target.definitionId]);
    case "plugin":
      return JSON.stringify([target.kind, target.pluginId]);
    case "specialist":
      return JSON.stringify([target.kind, target.pluginId, target.ownerUserId]);
    case "skill":
      return JSON.stringify([target.kind, target.workspaceId, target.fullName]);
  }
}

/** Owner settings are admission ceilings, never a replacement for grants. */
export async function pluginPolicyAllows(
  database: Kysely<DatabaseSchema>,
  owner: UserId,
  target: PluginTarget,
  main: boolean,
) {
  const setting = await database
    .selectFrom("pluginOwnerSettings")
    .select(["enabled", "mainIncluded"])
    .where("ownerUserId", "=", owner)
    .where("targetKey", "=", pluginTargetKey(target))
    .executeTakeFirst();
  return !setting || (setting.enabled && (!main || setting.mainIncluded));
}

export class PluginSettingsStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async workspaceSkillPolicy(workspaceId: import("@opensteer/core").WorkspaceId, owner: UserId) {
    const settings = await this.database
      .selectFrom("pluginOwnerSettings")
      .selectAll()
      .where("ownerUserId", "=", owner)
      .execute();
    const overrides = settings.filter(
      (s) => s.target.kind === "skill" && s.target.workspaceId === workspaceId,
    );
    if (!overrides.length) return undefined;
    const workspace = await this.database
      .selectFrom("workspaces")
      .select("kind")
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    return {
      revision: overrides.reduce((total, s) => total + s.revision, 0),
      disabledFullNames: overrides
        .flatMap((s) =>
          s.target.kind === "skill" &&
          (!s.enabled || (workspace.kind === "main" && !s.mainIncluded))
            ? [s.target.fullName]
            : [],
        )
        .sort(),
    };
  }

  private async snapshot(owner: UserId, availableRunnerIds?: ReadonlySet<string>) {
    const memberWorkspaces = this.database
      .selectFrom("workspaceMemberships")
      .select("workspaceId")
      .where("userId", "=", owner)
      .where("state", "=", "active");
    const [
      viewer,
      places,
      settings,
      connections,
      installations,
      grants,
      packages,
      activations,
      specialists,
      tools,
    ] = await Promise.all([
      this.database
        .selectFrom("users")
        .select("instanceRole")
        .where("id", "=", owner)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("workspaces")
        .select(["id", "name", "kind", "createdBy"])
        .where("id", "in", memberWorkspaces)
        .execute(),
      this.database
        .selectFrom("pluginOwnerSettings")
        .selectAll()
        .where("ownerUserId", "=", owner)
        .execute(),
      this.database
        .selectFrom("integrationConnections")
        .select([
          "id",
          "integrationDefinitionId",
          "connectionKind",
          "displayName",
          "status",
          "statusReason",
          "runnerId",
          "computerAccess",
          "computerBlockedAt",
          "grantedScopes",
        ])
        .where("ownerUserId", "=", owner)
        .where("status", "!=", "revoked")
        .execute(),
      this.database
        .selectFrom("integrationInstallations")
        .select([
          "id",
          "name",
          "title",
          "description",
          "version",
          "sourceKind",
          "manifest",
          "pluginId",
        ])
        .execute(),
      this.database
        .selectFrom("integrationGrants")
        .selectAll()
        .where("ownerUserId", "=", owner)
        .where("workspaceId", "in", memberWorkspaces)
        .where("revokedAt", "is", null)
        .execute(),
      this.database
        .selectFrom("plugins")
        .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
        .select([
          "plugins.id",
          "plugins.name",
          "plugins.scope",
          "plugins.workspaceId",
          "plugins.installedBy",
          "plugins.source",
          "pluginVersions.manifest",
          "pluginVersions.specialistManifest",
        ])
        .where((eb) =>
          eb.or([
            eb.and([eb("plugins.installedBy", "=", owner), eb("plugins.scope", "=", "deployment")]),
            eb("plugins.workspaceId", "in", memberWorkspaces),
            eb.exists(
              eb
                .selectFrom("pluginActivations")
                .select("pluginId")
                .whereRef("pluginActivations.pluginId", "=", "plugins.id")
                .where("pluginActivations.workspaceId", "in", memberWorkspaces),
            ),
          ]),
        )
        .execute(),
      this.database
        .selectFrom("pluginActivations")
        .selectAll()
        .where("workspaceId", "in", memberWorkspaces)
        .execute(),
      this.database
        .selectFrom("specialists")
        .select(["id", "workspaceId", "pluginId", "ownerUserId", "status"])
        .where("workspaceId", "in", memberWorkspaces)
        .where("removedAt", "is", null)
        .execute(),
      this.database
        .selectFrom("integrationTools")
        .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
        .select(["integrationTools.name", "integrationServers.installationId"])
        .where((eb) =>
          eb.or([
            eb("integrationTools.connectionId", "is", null),
            eb(
              "integrationTools.connectionId",
              "in",
              eb
                .selectFrom("integrationConnections")
                .select("integrationConnections.id")
                .where("integrationConnections.ownerUserId", "=", owner)
                .where("integrationConnections.status", "!=", "revoked"),
            ),
          ]),
        )
        .execute(),
    ]);
    const rows: PluginRow[] = [];
    const placement = (target: PluginTarget, selected: readonly string[]) => {
      const setting = settings.find((s) => s.targetKey === pluginTargetKey(target));
      return {
        enabled: setting?.enabled ?? true,
        mainIncluded: setting?.mainIncluded ?? true,
        projectCount: places.filter((p) => p.kind === "project" && selected.includes(p.id)).length,
        personalEverywhere:
          setting?.personalEverywhereAccounts !== null &&
          setting?.personalEverywhereAccounts !== undefined,
        revision: setting?.revision ?? 0,
      };
    };
    for (const installation of installations) {
      if (installation.pluginId) continue;
      const definition = installation.manifest.definition;
      const definitionId =
        typeof definition === "object" &&
        definition !== null &&
        "id" in definition &&
        typeof definition.id === "string"
          ? definition.id
          : installation.name;
      const accounts = connections.filter((c) => c.integrationDefinitionId === definitionId);
      const ownGrants = grants.filter((g) => g.installationId === installation.id);
      const saved = settings.find(
        (s) =>
          (s.target.kind === "service" || s.target.kind === "device-app") &&
          s.target.definitionId === definitionId,
      );
      if (!accounts.length && !ownGrants.length && !saved) continue;
      const device =
        accounts.some((c) => c.connectionKind === "computer") ||
        saved?.target.kind === "device-app";
      const target: PluginTarget = { kind: device ? "device-app" : "service", definitionId };
      rows.push({
        target,
        title: installation.title.slice(0, 120),
        description: installation.description.slice(0, 320) || null,
        source: { kind: installation.sourceKind, version: installation.version },
        tags: [device ? "devices" : "accounts"],
        placement: placement(
          target,
          ownGrants.map((g) => g.workspaceId),
        ),
        accountCount: accounts.length,
        issues:
          accounts.some((c) => c.status === "needs-attention") ||
          saved?.personalEverywhereAccounts?.some(
            (a) => !accounts.some((c) => c.id === a.connectionId),
          )
            ? ["needs-sign-in"]
            : [],
        contents: {
          skills: 0,
          tools: tools.filter((t) => t.installationId === installation.id).length,
          specialists: 0,
        },
        permissions: { canEnable: true, canPlace: true, canRemove: true, canUpdate: false },
      });
    }
    for (const plugin of packages) {
      const own = plugin.installedBy === owner;
      const manage = own || viewer.instanceRole === "administrator";
      const target: PluginTarget = { kind: "plugin", pluginId: plugin.id };
      const skills = Array.isArray(plugin.manifest.skills) ? plugin.manifest.skills.length : 0;
      rows.push({
        target,
        title: plugin.name.slice(0, 120),
        description:
          typeof plugin.manifest.description === "string"
            ? plugin.manifest.description.slice(0, 320)
            : null,
        source: {
          kind: plugin.scope === "workspace" ? "workspace" : "plugin",
          version: typeof plugin.manifest.version === "string" ? plugin.manifest.version : null,
        },
        tags: ["skills"],
        placement: placement(
          target,
          activations.filter((a) => a.pluginId === plugin.id).map((a) => a.workspaceId),
        ),
        accountCount: 0,
        issues: [],
        contents: {
          skills,
          tools: tools.filter((t) =>
            installations.some((i) => i.pluginId === plugin.id && i.id === t.installationId),
          ).length,
          specialists: plugin.specialistManifest ? 1 : 0,
        },
        permissions: {
          canEnable: true,
          canPlace: manage,
          canRemove: manage,
          canUpdate: manage && typeof plugin.source.directory === "string",
        },
      });
      const packageRow = rows[rows.length - 1]!;
      const owners = new Set(
        specialists.filter((s) => s.pluginId === plugin.id).map((s) => s.ownerUserId),
      );
      for (const registrationOwner of owners) {
        const target: PluginTarget = {
          kind: "specialist",
          pluginId: plugin.id,
          ownerUserId: registrationOwner,
        };
        const registrations = specialists.filter(
          (s) => s.pluginId === plugin.id && s.ownerUserId === registrationOwner,
        );
        const canManage = registrationOwner === owner;
        rows.push({
          ...packageRow,
          target,
          tags: ["specialists"],
          placement: placement(
            target,
            registrations.map((s) => s.workspaceId),
          ),
          permissions: {
            canEnable: canManage,
            canPlace: canManage,
            canRemove: canManage,
            canUpdate: false,
          },
          issues: registrations.some((s) => s.status === "pending") ? ["choose-resource"] : [],
        });
      }
    }
    const inventory = await listWorkspaceSkillInventory(
      this.database,
      owner,
      places.map((p) => p.id),
    );
    rows.push(
      ...projectLooseSkillRows(
        inventory.map((scan) => ({
          ...scan,
          stale:
            scan.stale ||
            (availableRunnerIds !== undefined &&
              (!scan.ownerRunnerId || !availableRunnerIds.has(scan.ownerRunnerId))),
        })),
        settings,
      ),
    );
    return {
      inventory,
      rows,
      places,
      settings,
      connections,
      installations,
      grants,
      packages,
      activations,
      specialists,
      tools,
      viewer,
    };
  }

  async setEnabled(
    owner: UserId,
    input: import("zod").infer<typeof SettingsPluginEnableCommandSchema>,
  ) {
    return this.mutate(owner, SettingsPluginEnableCommandSchema.parse(input), {});
  }

  async setPlacement(
    owner: UserId,
    input: import("zod").infer<typeof SettingsPluginPlacementCommandSchema>,
    authorizations: Readonly<Record<string, IntegrationProviderAuthorization>>,
  ) {
    return this.mutate(owner, SettingsPluginPlacementCommandSchema.parse(input), authorizations);
  }

  private async mutate(
    owner: UserId,
    command:
      | import("zod").infer<typeof SettingsPluginEnableCommandSchema>
      | import("zod").infer<typeof SettingsPluginPlacementCommandSchema>,
    authorizations: Readonly<Record<string, IntegrationProviderAuthorization>>,
  ) {
    return this.database.transaction().execute(async (tx) => {
      await lockCommandIdempotency(tx, owner, command.idempotencyKey);
      // Project creation holds this same owner lock before reading consent.
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", owner)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const store = new PluginSettingsStore(tx);
      const detail = await store.detail(owner, command.target);
      if (!detail.row.permissions.canEnable)
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the consent owner may change this setting",
        });
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
      if (detail.row.placement.revision !== command.expectedRevision)
        throw new OpensteerError({
          code: "conflict",
          message: "Plugin placement changed; read it again",
        });
      const key = pluginTargetKey(command.target);
      let placement = { ...detail.row.placement, revision: command.expectedRevision + 1 };
      let template = detail.personalEverywhere?.accounts ?? null;
      if (command.type === "settings.plugin.enabled.set") placement.enabled = command.enabled;
      else {
        if (!detail.row.permissions.canPlace || command.target.kind === "skill")
          throw new OpensteerError({
            code: "forbidden",
            message: "Placement cannot be changed for this target",
          });
        const deployment = await tx
          .selectFrom("deployments")
          .select("deploymentShape")
          .executeTakeFirstOrThrow();
        if (command.personalEverywhere && deployment.deploymentShape.kind !== "personal")
          throw new OpensteerError({
            code: "forbidden",
            message: "Server Projects require explicit consent",
          });
        if (
          command.personalEverywhere &&
          (!command.mainIncluded ||
            detail.places
              .filter((p) => p.kind === "project" && p.canSelect)
              .some((p) => !command.projects.some((s) => s.workspaceId === p.workspaceId)))
        )
          throw new OpensteerError({
            code: "bad_request",
            message: "Everywhere must include Main and every current Project",
          });
        if (new Set(command.projects.map((p) => p.workspaceId)).size !== command.projects.length)
          throw new OpensteerError({ code: "bad_request", message: "Duplicate Project selection" });
        for (const project of command.projects) {
          const place = detail.places.find((p) => p.workspaceId === project.workspaceId);
          if (!place || place.kind !== "project" || !place.canSelect)
            throw new OpensteerError({
              code: "forbidden",
              message: "Project selection is unavailable",
            });
          if (
            new Set(project.accounts.map((a) => a.connectionId)).size !== project.accounts.length ||
            project.accounts.some(
              (a) => !detail.accounts.some((c) => c.connectionId === a.connectionId),
            )
          )
            throw new OpensteerError({
              code: "forbidden",
              message: "Select only your exact accounts",
            });
        }
        if (
          (command.target.kind === "service" || command.target.kind === "device-app") &&
          command.projects.some((p) => p.accounts.length === 0)
        )
          throw new OpensteerError({
            code: "bad_request",
            message: "Each selected Project needs an exact account grant",
          });
        if (
          command.target.kind === "plugin" &&
          (command.projects.some((p) => p.accounts.length > 0) ||
            command.personalEverywhere?.accounts.length)
        )
          throw new OpensteerError({
            code: "bad_request",
            message: "Package placement does not grant accounts",
          });
        const target = command.target;
        if (target.kind === "specialist")
          throw new OpensteerError({
            code: "conflict",
            message: "Use the specialist registration editor to change places",
          });
        if (target.kind === "plugin") {
          const plugin = await tx
            .selectFrom("plugins")
            .select(["scope", "workspaceId"])
            .where("id", "=", target.pluginId)
            .executeTakeFirstOrThrow();
          if (
            plugin.scope === "workspace" &&
            (command.personalEverywhere ||
              command.projects.some((p) => p.workspaceId !== plugin.workspaceId))
          )
            throw new OpensteerError({
              code: "forbidden",
              message: "This package belongs to its source Workspace",
            });
          for (const place of detail.places.filter((p) => p.canSelect)) {
            const selected =
              place.kind === "main"
                ? command.mainIncluded
                : command.projects.some((p) => p.workspaceId === place.workspaceId);
            if (selected)
              await new PluginStore(tx).activateIn(tx, target.pluginId, place.workspaceId, owner);
            else if (place.kind !== "main")
              await tx
                .deleteFrom("pluginActivations")
                .where("pluginId", "=", target.pluginId)
                .where("workspaceId", "=", place.workspaceId)
                .execute();
          }
        } else {
          if (command.personalEverywhere) {
            const accounts = command.personalEverywhere.accounts;
            if (
              !accounts.length ||
              new Set(accounts.map((a) => a.connectionId)).size !== accounts.length ||
              accounts.some((a) => !detail.accounts.some((c) => c.connectionId === a.connectionId))
            )
              throw new OpensteerError({
                code: "forbidden",
                message: "Future consent needs exact owned accounts",
              });
          }
          const installationId = detail.installationIds[0];
          if (!installationId)
            throw new OpensteerError({ code: "conflict", message: "Installation is unavailable" });
          const main = detail.places.find((p) => p.kind === "main");
          if (command.personalEverywhere) {
            if (!main)
              throw new OpensteerError({
                code: "forbidden",
                message: "Main membership is required for future consent",
              });
            for (const account of command.personalEverywhere.accounts)
              await validateIntegrationGrantInTransaction(tx, {
                ...account,
                installationId,
                ownerUserId: owner,
                createdBy: owner,
                workspaceId: main.workspaceId,
                alias: account.connectionId,
                isDefault: false,
                providerAuthorizations: authorizations,
              });
          }
          for (const place of detail.places.filter((p) => p.kind === "project" && p.canSelect)) {
            const selection = command.projects.find((p) => p.workspaceId === place.workspaceId);
            for (const grant of detail.grants.filter((g) => g.workspaceId === place.workspaceId)) {
              if (!selection?.accounts.some((a) => a.connectionId === grant.connectionId))
                await tx
                  .updateTable("integrationGrants")
                  .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
                  .where("id", "=", grant.id)
                  .where("ownerUserId", "=", owner)
                  .execute();
            }
            for (const account of selection?.accounts ?? [])
              await writeIntegrationGrantInTransaction(tx, {
                ...account,
                installationId,
                ownerUserId: owner,
                createdBy: owner,
                workspaceId: place.workspaceId,
                alias: account.connectionId,
                isDefault: false,
                providerAuthorizations: authorizations,
              });
          }
        }
        template = command.personalEverywhere?.accounts ?? null;
        placement = {
          ...placement,
          mainIncluded: command.mainIncluded,
          projectCount: command.projects.length,
          personalEverywhere: template !== null,
        };
      }
      await tx
        .insertInto("pluginOwnerSettings")
        .values({
          ownerUserId: owner,
          targetKey: key,
          target: jsonValue(command.target),
          enabled: placement.enabled,
          mainIncluded: placement.mainIncluded,
          revision: placement.revision,
          personalEverywhereAccounts: template ? jsonValue(template) : null,
        })
        .onConflict((c) =>
          c.columns(["ownerUserId", "targetKey"]).doUpdateSet({
            enabled: placement.enabled,
            mainIncluded: placement.mainIncluded,
            revision: placement.revision,
            personalEverywhereAccounts: template ? jsonValue(template) : null,
          }),
        )
        .execute();
      await tx
        .insertInto("commands")
        .values({
          id: createId("command"),
          actorPrincipalId: await principalIdForUser(tx, owner),
          authoritySource: jsonValue({ kind: "user-session", userId: owner }),
          requestedBy: owner,
          idempotencyKey: command.idempotencyKey,
          type: command.type,
          payload: jsonValue({ request: command, placement }),
          status: "succeeded",
          environmentId: null,
          threadId: null,
          runId: null,
          dispatcherId: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
      return { type: command.type, placement };
    });
  }

  async overview(owner: UserId, availableRunnerIds?: ReadonlySet<string>) {
    return PluginsOverviewViewSchema.parse({
      rows: (await this.snapshot(owner, availableRunnerIds)).rows,
    });
  }

  async detail(owner: UserId, target: PluginTarget) {
    const snapshot = await this.snapshot(owner);
    const {
      rows,
      places,
      settings,
      connections,
      installations,
      grants,
      packages,
      activations,
      specialists,
      tools,
      viewer,
    } = snapshot;
    const key = pluginTargetKey(target);
    const row = rows.find((r) => pluginTargetKey(r.target) === key);
    if (!row)
      throw new OpensteerError({
        code: "forbidden",
        message: "Plugin is unavailable to this viewer",
      });
    const service = target.kind === "service" || target.kind === "device-app";
    const accounts = service
      ? connections.filter((c) => c.integrationDefinitionId === target.definitionId)
      : [];
    const accountIds = new Set(accounts.map((c) => c.id));
    const publicGrants = grants.filter((g) => g.connectionId && accountIds.has(g.connectionId));
    const plugin =
      target.kind === "plugin" || target.kind === "specialist"
        ? packages.find((p) => p.id === target.pluginId)
        : undefined;
    const registrations =
      target.kind === "specialist"
        ? specialists.filter(
            (s) => s.pluginId === target.pluginId && s.ownerUserId === target.ownerUserId,
          )
        : [];
    const setting = settings.find((s) => s.targetKey === key);
    const contents: { name: string; kind: "skill" | "tool" | "specialist" }[] = [];
    for (const skill of Array.isArray(plugin?.manifest.skills) ? plugin.manifest.skills : []) {
      const name =
        typeof skill === "string"
          ? skill
          : typeof skill === "object" &&
              skill !== null &&
              "name" in skill &&
              typeof skill.name === "string"
            ? skill.name
            : null;
      if (name) contents.push({ name: name.slice(0, 120), kind: "skill" });
    }
    if (plugin?.specialistManifest)
      contents.push({ name: plugin.name.slice(0, 120), kind: "specialist" });
    const installationIds = installations
      .filter((i) =>
        plugin
          ? i.pluginId === plugin.id
          : service &&
            (i.name === target.definitionId ||
              accounts.some((c) => {
                const definition = i.manifest.definition;
                return (
                  typeof definition === "object" &&
                  definition !== null &&
                  "id" in definition &&
                  definition.id === c.integrationDefinitionId
                );
              })),
      )
      .map((i) => i.id);
    for (const tool of tools.filter((t) => installationIds.includes(t.installationId)))
      contents.push({ name: tool.name.slice(0, 120), kind: "tool" });
    return PluginDetailViewSchema.parse({
      row,
      installationIds: service
        ? installations
            .filter((i) => {
              const d = i.manifest.definition;
              return (
                publicGrants.some((g) => g.installationId === i.id) ||
                i.name === target.definitionId ||
                (typeof d === "object" && d !== null && "id" in d && d.id === target.definitionId)
              );
            })
            .map((i) => i.id)
        : [],
      grants: publicGrants.map((g) => ({
        ...g,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        revokedAt: g.revokedAt?.toISOString() ?? null,
      })),
      registrations: registrations.map(({ id, workspaceId, ownerUserId }) => ({
        id,
        workspaceId,
        ownerUserId,
      })),
      accounts: accounts.map((c) => ({
        connectionId: c.id,
        displayName: c.displayName,
        status: c.status,
        statusReason: c.statusReason,
        access: c.computerAccess,
        runnerId: c.runnerId,
      })),
      places: places.map((p) => ({
        workspaceId: p.id,
        name: p.name,
        kind: p.kind,
        selected:
          p.kind === "main"
            ? row.placement.mainIncluded
            : service
              ? publicGrants.some((g) => g.workspaceId === p.id)
              : target.kind === "specialist"
                ? registrations.some((r) => r.workspaceId === p.id)
                : activations.some((a) => a.pluginId === plugin?.id && a.workspaceId === p.id),
        canSelect:
          service ||
          p.createdBy === owner ||
          (p.kind !== "main" && viewer.instanceRole === "administrator"),
        accounts: publicGrants
          .filter((g) => g.workspaceId === p.id && g.connectionId)
          .map((g) => ({ connectionId: g.connectionId!, access: g.access })),
      })),
      personalEverywhere: setting?.personalEverywhereAccounts
        ? { accounts: setting.personalEverywhereAccounts }
        : null,
      devices: [],
      permissions: [
        ...accounts.flatMap((c) =>
          c.grantedScopes.map((scope) => ({
            label: `${c.displayName}: ${scope}`.slice(0, 120),
            layer: "account-scope",
            state: "allowed",
          })),
        ),
        ...accounts
          .filter((c) => c.connectionKind === "computer")
          .map((c) => ({
            label: c.displayName.slice(0, 120),
            layer: "app-policy",
            state: c.computerBlockedAt ? "denied" : c.computerAccess ? "allowed" : "unknown",
          })),
        ...publicGrants.map((g) => ({
          label:
            `${places.find((p) => p.id === g.workspaceId)?.name ?? "Workspace"}: ${g.access}`.slice(
              0,
              120,
            ),
          layer: "workspace-grant",
          state: g.status === "active" ? "allowed" : "denied",
        })),
      ],
      contents: target.kind === "skill" ? [{ name: target.fullName, kind: "skill" }] : contents,
      sourceFolder:
        plugin?.installedBy === owner && typeof plugin.source.directory === "string"
          ? plugin.source.directory
          : null,
    });
  }
}

/** Join seam for A3's already membership-authorized metadata inventory. */
export function projectLooseSkillRows(
  inventory: readonly {
    workspaceId: import("@opensteer/core").WorkspaceId;
    stale: boolean;
    scanStatus?: "complete" | "failed";
    skills: readonly { fullName: string; description: string; digest: string }[];
  }[],
  settings: readonly {
    target: PluginTarget;
    enabled: boolean;
    mainIncluded: boolean;
    revision: number;
  }[],
): PluginRow[] {
  return inventory.flatMap((scan) =>
    scan.skills.map((skill) => {
      const target: PluginTarget = {
        kind: "skill",
        workspaceId: scan.workspaceId,
        fullName: skill.fullName,
      };
      const setting = settings.find((s) => pluginTargetKey(s.target) === pluginTargetKey(target));
      return {
        target,
        title: skill.fullName,
        description: skill.description || null,
        source: { kind: "workspace" as const, version: null },
        tags: ["skills" as const],
        placement: {
          enabled: setting?.enabled ?? true,
          mainIncluded: setting?.mainIncluded ?? true,
          revision: setting?.revision ?? 0,
          projectCount: 1,
          personalEverywhere: false,
        },
        accountCount: 0,
        issues:
          scan.scanStatus === "failed"
            ? ["waiting-setup" as const]
            : scan.stale
              ? ["waiting-device" as const]
              : [],
        contents: { skills: 1, tools: 0, specialists: 0 },
        permissions: { canEnable: true, canPlace: false, canRemove: false, canUpdate: false },
      };
    }),
  );
}
