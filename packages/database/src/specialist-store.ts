import { effectiveMembershipState } from "./effective-membership.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { pluginPolicyAllows } from "./plugin-settings-store.js";
import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  SpecialistManifestSchema,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { PluginStore } from "./plugin-store.js";

/** A registration adds a model and instructions; its access is its caller's in that Workspace. */
export class SpecialistStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  private async authorize(workspaceId: WorkspaceId, actorUserId: UserId) {
    const member = await this.database
      .selectFrom("workspaceMemberships")
      .select(effectiveMembershipState())
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", actorUserId)
      .executeTakeFirst();
    if (member?.state !== "active")
      throw new OpensteerError({
        code: "forbidden",
        message: "Active Workspace membership is required",
      });
  }

  async add(input: {
    workspaceId: WorkspaceId;
    pluginId: string;
    actorUserId: UserId;
    activate?: boolean;
  }) {
    return this.database.transaction().execute((tx) => this.addIn(tx, input));
  }

  async addIn(
    tx: Kysely<DatabaseSchema>,
    input: {
      workspaceId: WorkspaceId;
      pluginId: string;
      actorUserId: UserId;
      activate?: boolean;
    },
  ) {
    await new SpecialistStore(tx).authorize(input.workspaceId, input.actorUserId);
    if (input.activate !== false)
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
      .where("ownerUserId", "=", input.actorUserId)
      .executeTakeFirst();
    if (previous?.removedAt)
      throw new OpensteerError({
        code: "conflict",
        message: "Specialist cleanup is pending; retry removal before adding it again",
      });
    if (previous?.pluginVersionId === plugin.id)
      return new SpecialistStore(tx).registration(previous.id);
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
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((c) =>
        c.columns(["workspaceId", "pluginId", "ownerUserId"]).doUpdateSet({
          pluginVersionId: plugin.id,
          status: "ready",
          updatedAt: now,
        }),
      )
      .execute();
    return new SpecialistStore(tx).registration(id);
  }

  private async registration(id: string) {
    const row = await this.database
      .selectFrom("specialists")
      .innerJoin("pluginVersions", "pluginVersions.id", "specialists.pluginVersionId")
      .innerJoin("plugins", "plugins.id", "specialists.pluginId")
      .innerJoin("users", "users.id", "specialists.ownerUserId")
      .selectAll("specialists")
      .select([
        "pluginVersions.specialistManifest",
        "plugins.name",
        "pluginVersions.digest",
        "users.displayName as ownerName",
      ])
      .where("specialists.id", "=", id)
      .executeTakeFirstOrThrow();
    const manifest = SpecialistManifestSchema.parse(row.specialistManifest);
    return {
      id,
      workspaceId: row.workspaceId,
      pluginId: row.pluginId,
      pluginVersionId: row.pluginVersionId,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
      plugin: row.name,
      version: row.digest,
      status: row.status,
      models: manifest.models,
      fallback: manifest.fallback,
      access: [],
    };
  }

  async summaries(workspaceId: WorkspaceId, actorUserId: UserId) {
    await this.authorize(workspaceId, actorUserId);
    return this.database
      .selectFrom("specialists")
      .innerJoin("plugins", "plugins.id", "specialists.pluginId")
      .select([
        "specialists.id",
        "specialists.workspaceId",
        "specialists.pluginId",
        "specialists.status",
        "plugins.name as plugin",
      ])
      .where("specialists.workspaceId", "=", workspaceId)
      .orderBy("specialists.createdAt")
      .execute();
  }

  async list(workspaceId: WorkspaceId, actorUserId: UserId) {
    await this.authorize(workspaceId, actorUserId);
    const rows = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .orderBy("createdAt")
      .execute();
    return Promise.all(
      rows.map(async ({ id }) => {
        const registration = await this.registration(id);
        return {
          ...registration,
          canUse: registration.ownerUserId === actorUserId && registration.status === "ready",
        };
      }),
    );
  }

  private removalHandler?: (input: {
    workspaceId: WorkspaceId;
    specialistId: string;
    actorUserId: UserId;
  }) => Promise<void>;

  setRemovalHandler(handler: NonNullable<SpecialistStore["removalHandler"]>) {
    this.removalHandler = handler;
  }

  async remove(input: {
    administration?: AdministrationCommandIdentity | undefined;
    workspaceId: WorkspaceId;
    specialistId: string;
    actorUserId: UserId;
  }) {
    await this.authorize(input.workspaceId, input.actorUserId);
    await this.cleanup(input);
  }

  private async cleanup(input: {
    administration?: AdministrationCommandIdentity | undefined;
    workspaceId: WorkspaceId;
    specialistId: string;
    actorUserId: UserId;
  }) {
    const exists = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("id", "=", input.specialistId)
      .executeTakeFirst();
    if (!exists) {
      if (input.administration)
        await this.database
          .transaction()
          .execute((transaction) =>
            administrationCommand(transaction, input.administration, async () => {}),
          );
      return;
    }
    const removed = await this.database
      .updateTable("specialists")
      .set({ removedAt: new Date(), status: "removing" })
      .where("id", "=", input.specialistId)
      .where("workspaceId", "=", input.workspaceId)
      .where("ownerUserId", "=", input.actorUserId)
      .returning("id")
      .executeTakeFirst();
    if (!removed)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the consent owner may remove this specialist",
      });
    try {
      const workspace = await this.database
        .selectFrom("workspaces")
        .select("status")
        .where("id", "=", input.workspaceId)
        .executeTakeFirstOrThrow();
      if (workspace.status !== "deleted") {
        if (!this.removalHandler)
          throw new OpensteerError({
            code: "conflict",
            message: "Specialist removal is unavailable",
          });
        await this.removalHandler(input);
      }
    } catch (error) {
      await this.database
        .updateTable("specialists")
        .set({ status: "removal-failed" })
        .where("id", "=", input.specialistId)
        .execute();
      throw error;
    }
    await this.database.transaction().execute((tx) =>
      administrationCommand(tx, input.administration, async () => {
        await tx
          .deleteFrom("specialists")
          .where("id", "=", input.specialistId)
          .where("workspaceId", "=", input.workspaceId)
          .where("ownerUserId", "=", input.actorUserId)
          .execute();
      }),
    );
  }

  async assertRunnable(id: string, workspaceId: WorkspaceId, requester: UserId) {
    await this.authorize(workspaceId, requester);
    const exists = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("id", "=", id)
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirst();
    if (!exists)
      throw new OpensteerError({
        code: "conflict",
        message: "Specialist registration was removed",
      });
    const registration = await this.registration(id);
    const workspace = await this.database
      .selectFrom("workspaces")
      .select("kind")
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    const main = workspace.kind === "main";
    if (
      !(await pluginPolicyAllows(
        this.database,
        requester,
        { kind: "specialist", pluginId: registration.pluginId, ownerUserId: requester },
        main,
      )) ||
      !(await pluginPolicyAllows(
        this.database,
        requester,
        { kind: "plugin", pluginId: registration.pluginId },
        main,
      ))
    )
      throw new OpensteerError({ code: "forbidden", message: "Specialist is turned off here" });
    if (registration.ownerUserId !== requester)
      throw new OpensteerError({
        code: "forbidden",
        message: `${registration.plugin} uses ${registration.ownerName}'s accounts; add it for yourself to use your own`,
      });
    if (registration.status !== "ready")
      throw new OpensteerError({
        code: "conflict",
        message: `Specialist is ${registration.status}`,
      });
    return registration;
  }

  async retirePlugin(pluginId: string) {
    const rows = await this.database
      .selectFrom("specialists")
      .selectAll()
      .where("pluginId", "=", pluginId)
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    for (const row of rows)
      await this.cleanup({
        workspaceId: row.workspaceId,
        specialistId: row.id,
        actorUserId: row.ownerUserId,
      });
  }

  async finishPlacementRemovals(pluginId: string, owner: UserId) {
    const rows = await this.database
      .selectFrom("specialists")
      .select(["id", "workspaceId"])
      .where("pluginId", "=", pluginId)
      .where("ownerUserId", "=", owner)
      .where("removedAt", "is not", null)
      .execute();
    for (const row of rows)
      await this.cleanup({
        workspaceId: row.workspaceId,
        specialistId: row.id,
        actorUserId: owner,
      });
  }

  async resumeRemovals(environmentIds: readonly string[]) {
    const rows = await this.database
      .selectFrom("specialists")
      .innerJoin("workspaces", "workspaces.id", "specialists.workspaceId")
      .selectAll("specialists")
      .select("workspaces.backing")
      .where("specialists.removedAt", "is not", null)
      .execute();
    for (const row of rows) {
      if (
        row.backing.kind === "local-directory" &&
        environmentIds.includes(row.backing.ownerEnvironmentId)
      ) {
        try {
          await this.cleanup({
            workspaceId: row.workspaceId,
            specialistId: row.id,
            actorUserId: row.ownerUserId,
          });
        } catch {
          /* The visible failed state remains retryable. */
        }
      }
    }
  }
}
