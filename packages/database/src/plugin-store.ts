import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import {
  SpecialistManifestSchema,
  type SpecialistManifest,
  OpensteerError,
  type UserId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { nearestListedThread } from "./thread-lineage.js";

export class PluginStore {
  private readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  async assertCanRemove(pluginId: string, actor: { readonly userId: UserId }) {
    await requirePersonalOwner(this.database, actor.userId);
    const plugin = await this.database
      .selectFrom("plugins")
      .select("id")
      .where("id", "=", pluginId)
      .executeTakeFirst();
    if (!plugin) throw new OpensteerError({ code: "not_found", message: "Plugin not found" });
  }

  async setupThread(threadId: ThreadId): Promise<ThreadId | null> {
    return (await nearestListedThread(this.database, threadId))?.threadId ?? null;
  }
  async recordSetupThread(pluginId: string, setupThreadId: ThreadId | null) {
    await this.database
      .updateTable("plugins")
      .set({
        setupThreadId,
      })
      .where("id", "=", pluginId)
      .execute();
  }
  async list() {
    const plugins = await this.database.selectFrom("plugins").selectAll().execute();
    if (!plugins.length) return [];
    const ids = plugins.map((row) => row.id);
    const [versions, servers] = await Promise.all([
      this.database.selectFrom("pluginVersions").selectAll().where("pluginId", "in", ids).execute(),
      this.database
        .selectFrom("integrationServers")
        .innerJoin(
          "integrationInstallations",
          "integrationInstallations.id",
          "integrationServers.installationId",
        )
        .selectAll("integrationServers")
        .select("integrationInstallations.pluginId")
        .where("integrationInstallations.pluginId", "in", ids)
        .execute(),
    ]);
    return plugins.map((plugin) => ({
      ...plugin,
      versions: versions.filter((row) => row.pluginId === plugin.id),
      servers: servers
        .filter((row) => row.pluginId === plugin.id)
        .map(({ pluginId: _pluginId, ...server }) => server),
    }));
  }

  async listForUser(actorUserId: UserId) {
    await requirePersonalOwner(this.database, actorUserId);
    return this.list();
  }

  async current(ownerUserId: UserId) {
    await requirePersonalOwner(this.database, ownerUserId);
    const [rows, settings] = await Promise.all([
      this.database
        .selectFrom("plugins")
        .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
        .select(["plugins.id", "plugins.name", "pluginVersions.digest", "pluginVersions.manifest"])
        .execute(),
      this.database
        .selectFrom("pluginOwnerSettings")
        .selectAll()
        .where("ownerUserId", "=", ownerUserId)
        .execute(),
    ]);
    const denied = new Set(
      settings.flatMap((setting) =>
        setting.target.kind === "plugin" && !setting.enabled ? [setting.target.pluginId] : [],
      ),
    );
    return rows.filter((row) => !denied.has(row.id));
  }

  async install(
    input: {
      id: string;
      name: string;
      source: Readonly<Record<string, unknown>>;
      actorUserId: UserId;
      specialistManifest?: SpecialistManifest | null;
      digest: string;
      manifest: Readonly<Record<string, unknown>>;
      setupThreadId?: ThreadId | null;
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
      await requirePersonalOwner(tx, input.actorUserId);
      await tx
        .insertInto("plugins")
        .values({
          id: input.id,
          name: input.name,
          scope: "deployment",
          source: jsonValue(input.source),
          installedBy: input.actorUserId,
          setupThreadId: input.setupThreadId ?? null,
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
        .set({
          currentVersionId: versionId,
        })
        .where("id", "=", input.id)
        .execute();
    };
    return transaction ? persist(transaction) : withPersonalTransaction(this.database, persist);
  }
  async update(
    input: {
      pluginId: string;
      source?: Readonly<Record<string, unknown>>;
      specialistManifest?: SpecialistManifest | null;
      digest: string;
      manifest: Readonly<Record<string, unknown>>;
      setupThreadId?: ThreadId | null;
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
        .set({
          currentVersionId: id,
          ...(input.setupThreadId !== undefined
            ? {
                setupThreadId: input.setupThreadId,
              }
            : {}),
          updatedAt: new Date(),
          ...(input.source
            ? {
                source: jsonValue(input.source),
              }
            : {}),
        })
        .where("id", "=", plugin.id)
        .execute();
    };
    return transaction ? persist(transaction) : withPersonalTransaction(this.database, persist);
  }

  /** Moves the plugin's specialist registrations to its current version; installs call it. */
  async repinSpecialists(tx: Transaction<DatabaseSchema>, pluginId: string): Promise<void> {
    const current = await tx
      .selectFrom("plugins")
      .innerJoin("pluginVersions", "pluginVersions.id", "plugins.currentVersionId")
      .select(["pluginVersions.id", "pluginVersions.specialistManifest"])
      .where("plugins.id", "=", pluginId)
      .executeTakeFirstOrThrow();
    // Registrations being removed keep the version they were removed from.
    const registrations = await tx
      .selectFrom("specialists")
      .innerJoin("pluginVersions", "pluginVersions.id", "specialists.pluginVersionId")
      .select("specialists.id")
      .where("specialists.pluginId", "=", pluginId)
      .where("specialists.removedAt", "is", null)
      .orderBy("specialists.id")
      .forNoKeyUpdate("specialists")
      .execute();
    if (registrations.length === 0) return;
    const next = current.specialistManifest;
    if (!next)
      throw new OpensteerError({
        code: "conflict",
        message: "Remove this plugin's specialist registrations before installing it without one",
      });
    for (const row of registrations)
      await tx
        .updateTable("specialists")
        .set({
          pluginVersionId: current.id,
          updatedAt: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
  }

  async pendingDataRemovals(runnerId?: RunnerId) {
    // Installations share state; delivery waits until the whole plugin is gone.
    let query = this.database
      .selectFrom("runnerPluginDataRemovals")
      .leftJoin("plugins", "plugins.id", "runnerPluginDataRemovals.pluginId")
      .select(["runnerPluginDataRemovals.runnerId", "runnerPluginDataRemovals.pluginId"])
      .where("plugins.id", "is", null);
    if (runnerId) query = query.where("runnerPluginDataRemovals.runnerId", "=", runnerId);
    return query.execute();
  }
  async confirmDataRemoval(runnerId: RunnerId, pluginId: string) {
    await this.database
      .deleteFrom("runnerPluginDataRemovals")
      .where("runnerId", "=", runnerId)
      .where("pluginId", "=", pluginId)
      .execute();
  }
  async remove(pluginId: string, administration?: AdministrationCommandIdentity | undefined) {
    await withPersonalTransaction(this.database, async (tx) =>
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
          .set({
            currentVersionId: null,
          })
          .where("id", "=", pluginId)
          .execute();
        await tx.deleteFrom("plugins").where("id", "=", pluginId).execute();
      }),
    );
  }
}
