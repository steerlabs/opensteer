import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { randomUUID } from "node:crypto";
import { type Kysely, type Transaction } from "kysely";
import {
  SpecialistManifestSchema,
  type SpecialistManifest,
  OpensteerError,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

export class PluginStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async list(workspaceId?: WorkspaceId) {
    const plugins = await this.database.selectFrom("plugins").selectAll().execute();
    return Promise.all(
      plugins
        .filter((p) => !workspaceId || p.scope === "deployment" || p.workspaceId === workspaceId)
        .map(async (plugin) => ({
          ...plugin,
          versions: await this.database
            .selectFrom("pluginVersions")
            .selectAll()
            .where("pluginId", "=", plugin.id)
            .execute(),
          activations: await this.database
            .selectFrom("pluginActivations")
            .selectAll()
            .where("pluginId", "=", plugin.id)
            .execute(),
          servers: await this.database
            .selectFrom("integrationServers")
            .innerJoin(
              "integrationInstallations",
              "integrationInstallations.id",
              "integrationServers.installationId",
            )
            .selectAll("integrationServers")
            .where("integrationInstallations.pluginId", "=", plugin.id)
            .execute(),
        })),
    );
  }

  async listForUser(actorUserId: UserId, workspaceId?: WorkspaceId) {
    const actor = await this.database
      .selectFrom("users")
      .select("instanceRole")
      .where("id", "=", actorUserId)
      .executeTakeFirst();
    if (actor?.instanceRole === "administrator") return this.list(workspaceId);
    const member = workspaceId
      ? await this.database
          .selectFrom("workspaceMemberships")
          .select("state")
          .where("workspaceId", "=", workspaceId)
          .where("userId", "=", actorUserId)
          .executeTakeFirst()
      : null;
    if (member?.state !== "active")
      throw new OpensteerError({
        code: "forbidden",
        message: "Active Workspace membership is required",
      });
    return (await this.list(workspaceId)).map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      scope: plugin.scope,
      workspaceId: plugin.workspaceId,
      currentVersionId: plugin.currentVersionId,
      updatedAt: plugin.updatedAt,
      versions: plugin.versions.map((version) => ({
        id: version.id,
        digest: version.digest,
        manifest: {
          description: version.manifest.description,
          version: version.manifest.version,
          skills: Array.isArray(version.manifest.skills)
            ? version.manifest.skills.map(() => ({}))
            : [],
        },
        specialistManifest: version.specialistManifest ? {} : null,
      })),
      activations: plugin.activations
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => ({ workspaceId: a.workspaceId })),
      servers: plugin.servers.map((server) => ({ id: server.id })),
    }));
  }

  async current(workspaceId: WorkspaceId) {
    return this.database
      .selectFrom("pluginActivations")
      .innerJoin("plugins", "plugins.id", "pluginActivations.pluginId")
      .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
      .select(["plugins.id", "plugins.name", "pluginVersions.digest", "pluginVersions.manifest"])
      .where("pluginActivations.workspaceId", "=", workspaceId)
      .execute();
  }

  async install(
    input: {
      id: string;
      name: string;
      workspaceId?: WorkspaceId;
      source: Readonly<Record<string, unknown>>;
      actorUserId: UserId;
      specialistManifest?: SpecialistManifest | null;
      digest: string;
      manifest: Readonly<Record<string, unknown>>;
    },
    transaction?: Transaction<DatabaseSchema>,
  ) {
    if (input.name === "opensteer")
      throw new OpensteerError({
        code: "bad_request",
        message: "The plugin name opensteer is reserved",
      });
    const versionId = randomUUID();
    const now = new Date();
    const persist = async (tx: Transaction<DatabaseSchema>) => {
      await tx
        .insertInto("plugins")
        .values({
          id: input.id,
          name: input.name,
          scope: input.workspaceId ? "workspace" : "deployment",
          workspaceId: input.workspaceId ?? null,
          source: jsonValue(input.source),
          installedBy: input.actorUserId,
          currentVersionId: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await tx
        .insertInto("pluginVersions")
        .values({
          id: versionId,
          pluginId: input.id,
          digest: input.digest,
          manifest: jsonValue(input.manifest),
          specialistManifest: input.specialistManifest
            ? jsonValue(SpecialistManifestSchema.parse(input.specialistManifest))
            : null,
          createdAt: now,
        })
        .execute();
      await tx
        .updateTable("plugins")
        .set({ currentVersionId: versionId })
        .where("id", "=", input.id)
        .execute();
      if (input.workspaceId)
        await this.activateIn(tx, input.id, input.workspaceId, input.actorUserId);
    };
    return transaction ? persist(transaction) : this.database.transaction().execute(persist);
  }

  async update(
    input: {
      pluginId: string;
      specialistManifest?: SpecialistManifest | null;
      digest: string;
      manifest: Readonly<Record<string, unknown>>;
    },
    transaction?: Transaction<DatabaseSchema>,
  ) {
    const persist = async (tx: Transaction<DatabaseSchema>) => {
      const plugin = await tx
        .selectFrom("plugins")
        .selectAll()
        .where("id", "=", input.pluginId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (input.manifest.name !== plugin.name)
        throw new OpensteerError({
          code: "bad_request",
          message: "A plugin update must keep its name",
        });
      const id = randomUUID();
      await tx
        .insertInto("pluginVersions")
        .values({
          id,
          pluginId: plugin.id,
          digest: input.digest,
          manifest: jsonValue(input.manifest),
          specialistManifest: input.specialistManifest
            ? jsonValue(SpecialistManifestSchema.parse(input.specialistManifest))
            : null,
          createdAt: new Date(),
        })
        .execute();
      await tx
        .updateTable("plugins")
        .set({ currentVersionId: id, updatedAt: new Date() })
        .where("id", "=", plugin.id)
        .execute();
    };
    return transaction ? persist(transaction) : this.database.transaction().execute(persist);
  }

  async activateIn(
    tx: Kysely<DatabaseSchema>,
    pluginId: string,
    workspaceId: WorkspaceId,
    actorUserId: UserId,
  ) {
    // Serializing on the Workspace also covers two different plugins with the same name.
    await tx
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const plugin = await tx
      .selectFrom("plugins")
      .selectAll()
      .where("id", "=", pluginId)
      .executeTakeFirstOrThrow();
    if (plugin.scope === "workspace" && plugin.workspaceId !== workspaceId)
      throw new OpensteerError({
        code: "forbidden",
        message: "This plugin belongs to another Workspace",
      });
    const clash = await tx
      .selectFrom("pluginActivations")
      .innerJoin("plugins", "plugins.id", "pluginActivations.pluginId")
      .select("plugins.id")
      .where("pluginActivations.workspaceId", "=", workspaceId)
      .where("plugins.name", "=", plugin.name)
      .where("plugins.id", "!=", pluginId)
      .executeTakeFirst();
    if (clash)
      throw new OpensteerError({
        code: "conflict",
        message: "A plugin with that name is already active here",
      });
    await tx
      .insertInto("pluginActivations")
      .values({ workspaceId, pluginId, createdBy: actorUserId, createdAt: new Date() })
      .onConflict((c) => c.columns(["workspaceId", "pluginId"]).doNothing())
      .execute();
  }

  async setActivation(input: {
    administration?: AdministrationCommandIdentity | undefined;
    pluginId: string;
    workspaceId: WorkspaceId;
    actorUserId: UserId;
    active: boolean;
  }) {
    await this.database.transaction().execute(async (tx) =>
      administrationCommand(tx, input.administration, async () => {
        const workspace = await tx
          .selectFrom("workspaces")
          .selectAll()
          .where("id", "=", input.workspaceId)
          .executeTakeFirstOrThrow();
        const member = await tx
          .selectFrom("workspaceMemberships")
          .select(["role", "state"])
          .where("workspaceId", "=", input.workspaceId)
          .where("userId", "=", input.actorUserId)
          .executeTakeFirst();
        const actor = await tx
          .selectFrom("users")
          .select("instanceRole")
          .where("id", "=", input.actorUserId)
          .executeTakeFirst();
        if (
          workspace.createdBy !== input.actorUserId &&
          (workspace.kind === "main" ||
            !member ||
            member.state !== "active" ||
            (member.role !== "owner" && actor?.instanceRole !== "administrator"))
        )
          throw new OpensteerError({
            code: "forbidden",
            message: "Only the Workspace owner or administrator can change plugins",
          });
        if (input.active)
          await this.activateIn(tx, input.pluginId, input.workspaceId, input.actorUserId);
        else
          await tx
            .deleteFrom("pluginActivations")
            .where("workspaceId", "=", input.workspaceId)
            .where("pluginId", "=", input.pluginId)
            .execute();
      }),
    );
  }

  async remove(pluginId: string, administration?: AdministrationCommandIdentity | undefined) {
    await this.database.transaction().execute(async (tx) =>
      administrationCommand(tx, administration, async () => {
        const registration = await tx
          .selectFrom("specialists")
          .select("id")
          .where("pluginId", "=", pluginId)
          .executeTakeFirst();
        if (registration)
          throw new OpensteerError({
            code: "conflict",
            message: "Remove plugin specialist registrations before uninstalling",
          });
        await tx
          .updateTable("plugins")
          .set({ currentVersionId: null })
          .where("id", "=", pluginId)
          .execute();
        await tx.deleteFrom("plugins").where("id", "=", pluginId).execute();
      }),
    );
  }
}
