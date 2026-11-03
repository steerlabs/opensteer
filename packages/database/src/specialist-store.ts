import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  SpecialistManifestSchema,
  type SpecialistAccessRequirement,
  type SpecialistBinding,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { PluginStore } from "./plugin-store.js";
import { resolveResourceAccess } from "./resource-access.js";
import { jsonValue } from "./store-primitives.js";

/** Registration never creates consent: bindings name only resources already authorized here. */
export class SpecialistStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  private async authorize(workspaceId: WorkspaceId, actorUserId: UserId) {
    const member = await this.database
      .selectFrom("workspaceMemberships")
      .select("state")
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", actorUserId)
      .executeTakeFirst();
    if (member?.state !== "active")
      throw new OpensteerError({
        code: "forbidden",
        message: "Active Workspace membership is required",
      });
  }

  async add(input: { workspaceId: WorkspaceId; pluginId: string; actorUserId: UserId }) {
    await this.authorize(input.workspaceId, input.actorUserId);
    return this.database.transaction().execute(async (tx) => {
      await new PluginStore(tx).activateIn(
        tx,
        input.pluginId,
        input.workspaceId,
        input.actorUserId,
      );
      const plugin = await tx
        .selectFrom("plugins")
        .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
        .select(["pluginVersions.id", "pluginVersions.specialistManifest"])
        .where("plugins.id", "=", input.pluginId)
        .executeTakeFirstOrThrow();
      if (!plugin.specialistManifest)
        throw new OpensteerError({
          code: "bad_request",
          message: "This plugin is not a specialist",
        });
      SpecialistManifestSchema.parse(plugin.specialistManifest);
      const previous = await tx
        .selectFrom("specialists")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("pluginId", "=", input.pluginId)
        .executeTakeFirst();
      // A collaborator must explicitly remove their own registration before another consent owner replaces it.
      if (previous && previous.ownerUserId !== input.actorUserId)
        throw new OpensteerError({
          code: "forbidden",
          message: "Only this specialist's consent owner may re-add it",
        });
      const now = new Date();
      const id = previous?.id ?? randomUUID();
      await tx
        .insertInto("specialists")
        .values({
          id,
          workspaceId: input.workspaceId,
          pluginId: input.pluginId,
          pluginVersionId: plugin.id,
          ownerUserId: input.actorUserId,
          createdBy: input.actorUserId,
          status: "pending",
          bindings: jsonValue([]),
          createdAt: now,
          updatedAt: now,
        })
        .onConflict((c) =>
          c.columns(["workspaceId", "pluginId"]).doUpdateSet({
            pluginVersionId: plugin.id,
            status: "pending",
            bindings: jsonValue([]),
            updatedAt: now,
          }),
        )
        .execute();
      return new SpecialistStore(tx).refresh(id);
    });
  }

  async bind(input: {
    workspaceId: WorkspaceId;
    specialistId: string;
    actorUserId: UserId;
    requirement: number;
    resourceId: string;
  }) {
    await this.authorize(input.workspaceId, input.actorUserId);
    const owned = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("id", "=", input.specialistId)
      .where("workspaceId", "=", input.workspaceId)
      .where("ownerUserId", "=", input.actorUserId)
      .executeTakeFirst();
    if (!owned)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the consent owner may bind this specialist",
      });
    const current = await this.refresh(input.specialistId);
    if (current.workspaceId !== input.workspaceId || current.ownerUserId !== input.actorUserId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the consent owner may bind this specialist",
      });
    const requirement = current.access[input.requirement];
    if (!requirement?.candidates.some((c) => c.resourceId === input.resourceId))
      throw new OpensteerError({
        code: "bad_request",
        message: "Choose a currently allowed candidate",
      });
    const updated = await this.database
      .updateTable("specialists")
      .set({
        bindings: jsonValue([
          ...current.access.flatMap((a, i) =>
            i !== input.requirement && a.binding ? [a.binding] : [],
          ),
          {
            requirement: input.requirement,
            resourceId: input.resourceId,
            level: requirement.level,
          },
        ]),
      })
      .where("id", "=", input.specialistId)
      .where("pluginVersionId", "=", current.pluginVersionId)
      .where(
        "bindings",
        "=",
        jsonValue(current.access.flatMap((a) => (a.binding ? [a.binding] : []))),
      )
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n)
      throw new OpensteerError({
        code: "conflict",
        message: "Specialist changed while choosing access; list again",
      });
    return this.refresh(input.specialistId);
  }

  async refresh(id: string) {
    const row = await this.database
      .selectFrom("specialists")
      .innerJoin("pluginVersions", "pluginVersions.id", "specialists.pluginVersionId")
      .innerJoin("plugins", "plugins.id", "specialists.pluginId")
      .selectAll("specialists")
      .select(["pluginVersions.specialistManifest", "plugins.name", "pluginVersions.digest"])
      .where("specialists.id", "=", id)
      .executeTakeFirstOrThrow();
    const manifest = SpecialistManifestSchema.parse(row.specialistManifest);
    const bindings: SpecialistBinding[] = [];
    const states = [];
    for (const [index, requirement] of (manifest.access ?? []).entries()) {
      const previous = row.bindings.find((binding) => binding.requirement === index);
      const candidates = await this.candidates(row.workspaceId, row.ownerUserId, requirement);
      const resourceId =
        previous && candidates.some((c) => c.resourceId === previous.resourceId)
          ? previous.resourceId
          : candidates.length === 1
            ? candidates[0]!.resourceId
            : null;
      const binding = resourceId
        ? { requirement: index, resourceId, level: requirement.level }
        : null;
      if (binding) bindings.push(binding);
      states.push({
        ...requirement,
        binding,
        state: binding
          ? ("bound" as const)
          : candidates.length
            ? ("choose" as const)
            : ("needs-access" as const),
        candidates,
      });
    }
    const status =
      bindings.length === (manifest.access ?? []).length
        ? ("ready" as const)
        : ("pending" as const);
    const update = await this.database
      .updateTable("specialists")
      .set({ bindings: jsonValue(bindings), status, updatedAt: new Date() })
      .where("id", "=", id)
      .where("pluginVersionId", "=", row.pluginVersionId)
      .where("bindings", "=", jsonValue(row.bindings))
      .executeTakeFirst();
    if (update.numUpdatedRows !== 1n)
      throw new OpensteerError({
        code: "conflict",
        message: "Specialist changed while checking access; list again",
      });
    return {
      id,
      workspaceId: row.workspaceId,
      pluginId: row.pluginId,
      pluginVersionId: row.pluginVersionId,
      ownerUserId: row.ownerUserId,
      plugin: row.name,
      version: row.digest,
      status,
      models: manifest.models,
      fallback: manifest.fallback,
      access: states,
    };
  }

  async list(workspaceId: WorkspaceId, actorUserId: UserId) {
    await this.authorize(workspaceId, actorUserId);
    const rows = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .orderBy("createdAt")
      .execute();
    return Promise.all(rows.map(({ id }) => this.refresh(id)));
  }

  async remove(input: { workspaceId: WorkspaceId; specialistId: string; actorUserId: UserId }) {
    await this.authorize(input.workspaceId, input.actorUserId);
    await this.database
      .deleteFrom("specialists")
      .where("id", "=", input.specialistId)
      .where("workspaceId", "=", input.workspaceId)
      .where("ownerUserId", "=", input.actorUserId)
      .execute();
    // Invocation lifecycle attaches cancellation and .specialists/<id> cleanup here.
  }

  private async candidates(
    workspaceId: WorkspaceId,
    ownerUserId: UserId,
    requirement: SpecialistAccessRequirement,
  ) {
    const membership = await this.database
      .selectFrom("workspaceMemberships")
      .select("state")
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", ownerUserId)
      .executeTakeFirst();
    const candidates: { resourceId: string; name: string }[] = [];
    if (membership?.state !== "active") return candidates;
    if (requirement.type === "browser-profile") {
      const profiles = await this.database
        .selectFrom("browserProfiles")
        .select(["id", "name"])
        .where("ownerId", "=", ownerUserId)
        .where("archivedAt", "is", null)
        .orderBy("id")
        .execute();
      for (const profile of profiles) {
        const grants = await this.database
          .selectFrom("browserProfileGrants")
          .select("access")
          .where("workspaceId", "=", workspaceId)
          .where("createdBy", "=", ownerUserId)
          .where("profileId", "=", profile.id)
          .where("revokedAt", "is", null)
          .execute();
        const explicitAccess = grants.some((g) => g.access === "read-write")
          ? "read-write"
          : (grants[0]?.access ?? null);
        const decision = await resolveResourceAccess(this.database, {
          workspaceId,
          ownerUserId,
          explicitAccess,
        });
        if (decision.access === "read-write" || decision.access === requirement.level)
          candidates.push({ resourceId: profile.id, name: profile.name });
      }
      return candidates;
    }
    const connections = await this.database
      .selectFrom("integrationConnections")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("status", "=", "connected")
      .orderBy("id")
      .execute();
    for (const connection of connections) {
      if (
        requirement.type === "integration" &&
        connection.provider !== requirement.service &&
        connection.integrationDefinitionId !== requirement.service
      )
        continue;
      if (requirement.type === "phone" && connection.integrationDefinitionId !== "android-phone")
        continue;
      if (
        requirement.type === "computer-app" &&
        (connection.integrationDefinitionId !== "macos-app" ||
          connection.computerAppKey !== requirement.app.toLowerCase())
      )
        continue;
      if (connection.computerBlockedAt) continue;
      const grants = await this.database
        .selectFrom("integrationGrants")
        .select("access")
        .where("workspaceId", "=", workspaceId)
        .where("ownerUserId", "=", ownerUserId)
        .where("connectionId", "=", connection.id)
        .where("status", "=", "active")
        .where("revokedAt", "is", null)
        .execute();
      const explicitAccess = grants.some((g) => g.access === "read-write")
        ? "read-write"
        : (grants[0]?.access ?? null);
      const decision = await resolveResourceAccess(this.database, {
        workspaceId,
        ownerUserId,
        explicitAccess,
        ...(connection.connectionKind === "computer"
          ? { connectionCeiling: connection.computerAccess }
          : {}),
      });
      if (decision.access === "read-write" || decision.access === requirement.level)
        candidates.push({
          resourceId: connection.id,
          name: connection.displayName ?? connection.id,
        });
    }
    return candidates;
  }
}
