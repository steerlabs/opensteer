import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { pluginPolicyAllows } from "./plugin-settings-store.js";
import { randomUUID } from "node:crypto";
import { OpensteerError, SpecialistManifestSchema, type UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";

/** A registration adds a model and instructions within its caller's access limits. */
export class SpecialistStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  private async authorize(actorUserId: UserId) {
    await requirePersonalOwner(this.database, actorUserId);
  }
  async add(input: { pluginId: string; actorUserId: UserId }) {
    return withPersonalTransaction(this.database, (tx) => this.addIn(tx, input));
  }
  async addIn(
    tx: Kysely<DatabaseSchema>,
    input: {
      pluginId: string;
      actorUserId: UserId;
    },
  ) {
    await new SpecialistStore(tx).authorize(input.actorUserId);
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
        pluginId: input.pluginId,
        pluginVersionId: plugin.id,
        ownerUserId: input.actorUserId,
        createdBy: input.actorUserId,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((c) =>
        c.columns(["pluginId", "ownerUserId"]).doUpdateSet({
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
  async summaries(actorUserId: UserId) {
    await this.authorize(actorUserId);
    return this.database
      .selectFrom("specialists")
      .innerJoin("plugins", "plugins.id", "specialists.pluginId")
      .select([
        "specialists.id",
        "specialists.pluginId",
        "specialists.status",
        "plugins.name as plugin",
      ])
      .orderBy("specialists.createdAt")
      .execute();
  }
  async list(actorUserId: UserId) {
    await this.authorize(actorUserId);
    const rows = await this.database
      .selectFrom("specialists")
      .select("id")
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
  private removalHandler?: (input: { specialistId: string; actorUserId: UserId }) => Promise<void>;
  setRemovalHandler(handler: NonNullable<SpecialistStore["removalHandler"]>) {
    this.removalHandler = handler;
  }
  async remove(input: {
    administration?: AdministrationCommandIdentity | undefined;
    specialistId: string;
    actorUserId: UserId;
  }) {
    await this.authorize(input.actorUserId);
    await this.cleanup(input);
  }
  private async cleanup(input: {
    administration?: AdministrationCommandIdentity | undefined;
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
        await withPersonalTransaction(this.database, (transaction) =>
          administrationCommand(transaction, input.administration, async () => {}),
        );
      return;
    }
    const removed = await this.database
      .updateTable("specialists")
      .set({
        removedAt: new Date(),
        status: "removing",
      })
      .where("id", "=", input.specialistId)
      .where("ownerUserId", "=", input.actorUserId)
      .returning("id")
      .executeTakeFirst();
    if (!removed)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the personal owner may remove this specialist",
      });
    try {
      if (!this.removalHandler)
        throw new OpensteerError({
          code: "conflict",
          message: "Specialist removal is unavailable",
        });
      await this.removalHandler(input);
    } catch (error) {
      await this.database
        .updateTable("specialists")
        .set({
          status: "removal-failed",
        })
        .where("id", "=", input.specialistId)
        .execute();
      throw error;
    }
    await withPersonalTransaction(this.database, (tx) =>
      administrationCommand(tx, input.administration, async () => {
        await tx
          .deleteFrom("specialists")
          .where("id", "=", input.specialistId)
          .where("ownerUserId", "=", input.actorUserId)
          .execute();
      }),
    );
  }
  async assertRunnable(id: string, requester: UserId) {
    await this.authorize(requester);
    const exists = await this.database
      .selectFrom("specialists")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!exists)
      throw new OpensteerError({
        code: "conflict",
        message: "Specialist registration was removed",
      });
    const registration = await this.registration(id);
    if (
      !(await pluginPolicyAllows(this.database, requester, {
        kind: "specialist",
        pluginId: registration.pluginId,
        ownerUserId: requester,
      })) ||
      !(await pluginPolicyAllows(this.database, requester, {
        kind: "plugin",
        pluginId: registration.pluginId,
      }))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Specialist is turned off",
      });
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
        specialistId: row.id,
        actorUserId: row.ownerUserId,
      });
  }
  async finishRemovals(pluginId: string, owner: UserId) {
    const rows = await this.database
      .selectFrom("specialists")
      .select(["id"])
      .where("pluginId", "=", pluginId)
      .where("ownerUserId", "=", owner)
      .where("removedAt", "is not", null)
      .execute();
    for (const row of rows)
      await this.cleanup({
        specialistId: row.id,
        actorUserId: owner,
      });
  }
  async resumeRemovals() {
    const rows = await this.database
      .selectFrom("specialists")
      .selectAll("specialists")
      .where("specialists.removedAt", "is not", null)
      .execute();
    for (const row of rows) {
      {
        try {
          await this.cleanup({
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
