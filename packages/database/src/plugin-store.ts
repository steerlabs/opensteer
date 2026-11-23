import { requirePersonalOwner } from "./personal-settings-store.js";
import { isRecord } from "@opensteer/shared/isRecord";
import { outsideName } from "@opensteer/shared/outsideName";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { OpensteerError, type UserId, type RunnerId, type ThreadId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { nearestListedThread } from "./thread-lineage.js";

/** Keep a manifest's display label clean without changing its package or server keys. */
export function cleanPluginDeviceName(manifest: Readonly<Record<string, unknown>>) {
  const extensions = manifest.extensions;
  if (!isRecord(extensions)) return manifest;
  const opensteer = extensions["com.opensteer"];
  if (!isRecord(opensteer)) return manifest;
  const device = opensteer.device;
  if (!isRecord(device) || typeof device.name !== "string") return manifest;
  return {
    ...manifest,
    extensions: {
      ...extensions,
      "com.opensteer": {
        ...opensteer,
        device: { ...device, name: outsideName(device.name, 80) || "Device" },
      },
    },
  };
}

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
      digest: string;
      /** The definition `digest` follows. */
      packageFormat: string;
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
      // One plugin per person and name: a registration of the same name that committed first,
      // even one still committing, is the plugin, and this one is refused rather than a second.
      const inserted = await tx
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
        .onConflict((conflict) => conflict.columns(["installedBy", "name"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted)
        throw new OpensteerError({
          code: "conflict",
          message: `${input.name} was registered by another call at the same time.`,
          next: "Register it again to update that one.",
        });
      await tx
        .insertInto("pluginVersions")
        .values({
          id: versionId,
          pluginId: input.id,
          digest: input.digest,
          manifest: jsonValue(cleanPluginDeviceName(input.manifest)),
          packageFormat: input.packageFormat,
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
    return transaction ? persist(transaction) : commitPersonalMutation(this.database, persist);
  }
  async update(
    input: {
      pluginId: string;
      source?: Readonly<Record<string, unknown>>;
      digest: string;
      /** The definition `digest` follows. */
      packageFormat: string;
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
          manifest: jsonValue(cleanPluginDeviceName(input.manifest)),
          packageFormat: input.packageFormat,
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
    return transaction ? persist(transaction) : commitPersonalMutation(this.database, persist);
  }

  /**
   * A plugin's current package, stored again under the digest its files make in `packageFormat`:
   * a new version with the same manifest, which its installation and its servers' launches then
   * name. Each server keeps the approval it had, which was for its earlier launch, so its
   * computer's owner is asked again. Nothing changes if the plugin moved past `fromVersionId`.
   */
  async upgradePackage(input: {
    readonly pluginId: string;
    readonly fromVersionId: string;
    readonly digest: string;
    readonly packageFormat: string;
  }) {
    // The single personal write path: the new version, installations and launches
    // reach clients as one plugin change.
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const plugin = await tx
        .selectFrom("plugins")
        .select(["id", "currentVersionId"])
        .where("id", "=", input.pluginId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (plugin?.currentVersionId !== input.fromVersionId) return;
      const from = await tx
        .selectFrom("pluginVersions")
        .selectAll()
        .where("id", "=", input.fromVersionId)
        .executeTakeFirstOrThrow();
      const now = new Date();
      const id = randomUUID();
      await tx
        .insertInto("pluginVersions")
        .values({
          id,
          pluginId: plugin.id,
          digest: input.digest,
          manifest: jsonValue(from.manifest),
          packageFormat: input.packageFormat,
          createdAt: now,
        })
        .execute();
      await tx
        .updateTable("plugins")
        .set({ currentVersionId: id, updatedAt: now })
        .where("id", "=", plugin.id)
        .execute();
      mutation.bumpResource("plugin");
      // Plugin writes precede installation locks, as they do on install and update.
      const installations = await tx
        .selectFrom("integrationInstallations")
        .select(["id", "provenance"])
        .where("pluginId", "=", plugin.id)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      for (const installation of installations)
        if (installation.provenance.snapshotDigest === from.digest)
          await tx
            .updateTable("integrationInstallations")
            .set({
              provenance: jsonValue({ ...installation.provenance, snapshotDigest: input.digest }),
              updatedAt: now,
            })
            .where("id", "=", installation.id)
            .execute();
      if (installations.length === 0) return;
      const servers = await tx
        .selectFrom("integrationServers")
        .select(["id", "transport"])
        .where(
          "installationId",
          "in",
          installations.map(({ id }) => id),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      for (const server of servers) {
        const transport = server.transport as {
          readonly type?: unknown;
          readonly launch?: { readonly packageDigest?: unknown };
        };
        if (transport.type !== "runner" || transport.launch?.packageDigest !== from.digest)
          continue;
        await tx
          .updateTable("integrationServers")
          .set({
            transport: jsonValue({
              ...transport,
              launch: { ...transport.launch, packageDigest: input.digest },
            }),
            updatedAt: now,
          })
          .where("id", "=", server.id)
          .execute();
      }
    });
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
    await commitPersonalMutation(this.database, async (tx) =>
      administrationCommand(tx, administration, async () => {
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
