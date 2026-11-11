import { withPersonalTransaction } from "./personal-transaction.js";
import {
  OpensteerError,
  TaskFolderSchema,
  type BrowserProfileId,
  type BrowserSessionId,
  type TaskFolder,
} from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationInstallationIdSchema,
} from "@opensteer/integration-core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { listEligibleBrowserRunners } from "./browser-home-store.js";
import { assertPersonalOwner } from "./private-resource-owner.js";
import type {
  PrivateResourceActor,
  PrivateResourceStorePort,
  PrivateIntegrationGrant,
} from "./private-resources-port.js";
import { writeIntegrationGrantInTransaction } from "./integration-grant-write.js";
import type { IntegrationProviderAuthorization } from "@opensteer/integration-core";

export interface PrivatePasswordsGrants {
  get(
    actor: PrivateResourceActor,
    site: string,
  ): Promise<{ readonly loginId: string; readonly revision: number } | null>;
  revoke(actor: PrivateResourceActor, site: string): Promise<void>;
}

export class PrivateResourceStore implements PrivateResourceStorePort {
  private readonly database: Kysely<DatabaseSchema>;
  private readonly passwords: PrivatePasswordsGrants;
  private readonly providerAuthorizations: () => Readonly<
    Record<string, IntegrationProviderAuthorization>
  >;
  constructor(
    database: Kysely<DatabaseSchema>,
    passwords: PrivatePasswordsGrants,
    providerAuthorizations: () => Readonly<Record<string, IntegrationProviderAuthorization>>,
  ) {
    this.database = database;
    this.passwords = passwords;
    this.providerAuthorizations = providerAuthorizations;
  }

  async assertOwner(actor: PrivateResourceActor): Promise<void> {
    const owner = await assertPersonalOwner(this.database, actor.ownerId);
    if (owner.deploymentId !== actor.deploymentId) throw unavailable();
    if (actor.threadId) {
      const task = await this.database
        .selectFrom("threads")
        .select("id")
        .where("id", "=", actor.threadId)
        .where("createdBy", "=", actor.ownerId)
        .executeTakeFirst();
      if (!task) throw unavailable();
    }
    if (actor.runId) {
      const run = await this.database
        .selectFrom("runs")
        .select("threadId")
        .where("id", "=", actor.runId)
        .where("requestedBy", "=", actor.ownerId)
        .executeTakeFirst();
      if (!run || !actor.threadId || run.threadId !== actor.threadId) throw unavailable();
    }
  }
  async integrationGrants(actor: PrivateResourceActor) {
    await this.assertOwner(actor);
    const rows = await this.database
      .selectFrom("integrationGrants")
      .select(["connectionId", "installationId", "isDefault", "access", "alias"])
      .where("ownerUserId", "=", actor.ownerId)
      .where("status", "=", "active")
      .where("revokedAt", "is", null)
      .execute();
    return rows;
  }
  async setIntegrationGrant(
    actor: PrivateResourceActor,
    grant: PrivateIntegrationGrant,
  ): Promise<void> {
    await this.assertOwner(actor);
    const connectionId =
      grant.connectionId === null ? null : IntegrationConnectionIdSchema.parse(grant.connectionId);
    await withPersonalTransaction(this.database, async (tx) => {
      await this.assertOwner(actor);
      await writeIntegrationGrantInTransaction(tx, {
        access: grant.access,
        alias: grant.alias ?? "Default",
        connectionId,
        createdBy: actor.ownerId,
        ownerUserId: actor.ownerId,
        installationId: IntegrationInstallationIdSchema.parse(grant.installationId),
        isDefault: grant.isDefault,
        providerAuthorizations: this.providerAuthorizations(),
      });
    });
  }
  async revokeIntegrationGrant(
    actor: PrivateResourceActor,
    grant: Pick<PrivateIntegrationGrant, "installationId" | "connectionId">,
  ): Promise<void> {
    await this.assertOwner(actor);
    await withPersonalTransaction(this.database, async (tx) => {
      await tx
        .updateTable("integrationGrants")
        .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
        .where("ownerUserId", "=", actor.ownerId)
        .where("installationId", "=", IntegrationInstallationIdSchema.parse(grant.installationId))
        .where(
          "connectionId",
          grant.connectionId === null ? "is" : "=",
          grant.connectionId === null
            ? null
            : IntegrationConnectionIdSchema.parse(grant.connectionId),
        )
        .execute();
    });
  }
  async browserProfiles(actor: PrivateResourceActor) {
    await this.assertOwner(actor);
    const rows = await this.database
      .selectFrom("browserProfiles")
      .select(["id", "homeRunnerId", "storageBindingVersion", "archivedAt"])
      .where("ownerId", "=", actor.ownerId)
      .execute();
    return rows.flatMap((row) =>
      row.homeRunnerId
        ? [
            {
              id: row.id,
              homeComputerId: row.homeRunnerId,
              storageBindingVersion: row.storageBindingVersion,
              archived: row.archivedAt !== null,
            },
          ]
        : [],
    );
  }
  async assertBrowserProfile(
    actor: PrivateResourceActor,
    profileId: BrowserProfileId,
    computerId: TaskFolder["computerId"],
  ) {
    await this.assertOwner(actor);
    const eligible = await listEligibleBrowserRunners(this.database, actor.ownerId);
    if (!eligible.some((runner) => runner.id === computerId)) throw unavailable();
    const row = await this.database
      .selectFrom("browserProfiles")
      .innerJoin("runners", "runners.id", "browserProfiles.homeRunnerId")
      .select([
        "browserProfiles.id",
        "browserProfiles.homeRunnerId",
        "browserProfiles.storageBindingVersion",
        "browserProfiles.archivedAt",
        "browserProfiles.storageState",
        "browserProfiles.storageRunnerId",
      ])
      .where("browserProfiles.id", "=", profileId)
      .where("browserProfiles.ownerId", "=", actor.ownerId)
      .where("browserProfiles.homeRunnerId", "=", computerId)
      .where("runners.revokedAt", "is", null)
      .executeTakeFirst();
    if (
      !row ||
      row.archivedAt ||
      (row.storageState === "local" && row.storageRunnerId !== computerId)
    )
      throw unavailable();
    return {
      id: row.id,
      homeComputerId: computerId,
      storageBindingVersion: row.storageBindingVersion,
      archived: false,
    };
  }
  async attachBrowserSession(
    actor: PrivateResourceActor,
    sessionId: BrowserSessionId,
  ): Promise<void> {
    await this.assertOwner(actor);
    if (!actor.threadId) throw unavailable();
    const { attachBrowserSession } = await import("./browser-session-store.js");
    const attached = await attachBrowserSession(this.database, {
      sessionId,
      ownerId: actor.ownerId,
      agentBindingId: actor.runId ? `run:${actor.runId}` : `thread:${actor.threadId}`,
    });
    if (!attached) throw unavailable();
  }
  async detachBrowserSession(
    actor: PrivateResourceActor,
    sessionId: BrowserSessionId,
  ): Promise<void> {
    await this.assertOwner(actor);
    if (!actor.threadId) throw unavailable();
    await this.database
      .deleteFrom("browserSessionAttachments")
      .where("sessionId", "=", sessionId)
      .where("ownerId", "=", actor.ownerId)
      .where("agentBindingId", "=", actor.runId ? `run:${actor.runId}` : `thread:${actor.threadId}`)
      .execute();
  }
  async passwordsGrant(actor: PrivateResourceActor, site: string) {
    await this.assertOwner(actor);
    return this.passwords.get(actor, site);
  }
  async revokePasswordsGrant(actor: PrivateResourceActor, site: string): Promise<void> {
    await this.assertOwner(actor);
    await this.passwords.revoke(actor, site);
  }
  async messagingFolder(actor: PrivateResourceActor, bindingId: string): Promise<TaskFolder> {
    await this.assertOwner(actor);
    const row = await this.database
      .selectFrom("channelBindings")
      .select(["folderComputerId", "folderPath"])
      .where("id", "=", bindingId as DatabaseSchema["channelBindings"]["id"])
      .where("createdBy", "=", actor.ownerId)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    if (!row) throw unavailable();
    return TaskFolderSchema.parse({ computerId: row.folderComputerId, path: row.folderPath });
  }
  async setMessagingFolder(
    actor: PrivateResourceActor,
    bindingId: string,
    folder: TaskFolder,
  ): Promise<void> {
    await this.assertOwner(actor);
    folder = TaskFolderSchema.parse(folder);
    const owner = await assertPersonalOwner(this.database, actor.ownerId);
    if (folder.computerId !== owner.hostingComputerId)
      throw new OpensteerError({
        code: "bad_request",
        message: "Messaging tasks run on the hosting computer",
      });
    const binding = await this.database
      .selectFrom("channelBindings")
      .select("revision")
      .where("id", "=", bindingId as DatabaseSchema["channelBindings"]["id"])
      .where("createdBy", "=", actor.ownerId)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    if (!binding) throw unavailable();
    const { ChannelStore } = await import("./channel-store.js");
    await new ChannelStore(this.database).setFolder({
      bindingId: bindingId as DatabaseSchema["channelBindings"]["id"],
      ownerUserId: actor.ownerId,
      expectedRevision: binding.revision,
      folder,
    });
  }
  async appPublisher(actor: PrivateResourceActor, appId: string) {
    await this.assertOwner(actor);
    const row = await this.database
      .selectFrom("apps")
      .innerJoin("appVersions", (join) =>
        join
          .onRef("apps.id", "=", "appVersions.appId")
          .onRef("apps.latestVersion", "=", "appVersions.version"),
      )
      .select([
        "apps.threadId",
        "apps.runId",
        "appVersions.folderComputerId",
        "appVersions.folderPath",
      ])
      .where("apps.id", "=", appId)
      .executeTakeFirst();
    if (!row) throw unavailable();
    return {
      threadId: row.threadId,
      runId: row.runId,
      folder:
        row.folderComputerId && row.folderPath
          ? { computerId: row.folderComputerId, path: row.folderPath }
          : null,
    };
  }
}
function unavailable() {
  return new OpensteerError({ code: "not_found", message: "Private resource is unavailable" });
}
