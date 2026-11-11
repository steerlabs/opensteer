import { withPersonalTransaction } from "./personal-transaction.js";
import { randomUUID } from "node:crypto";
import {
  AppIdSchema,
  AppSchema,
  AppTitleSchema,
  OpensteerError,
  appMaxBytes,
  nonTerminalRunStatuses,
  type AppServerSpec,
  type AgentEvent,
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { assertPersonalOwner } from "./private-resource-owner.js";

import { appendHostDeploymentEvent } from "./deployment-events.js";

const missing = () => new OpensteerError({ code: "not_found", message: "App not found" });
export class AppStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  openTab(appId: string, userId: UserId) {
    return this.setTabOpen(appId, userId, true);
  }
  closeTab(appId: string, userId: UserId) {
    return this.setTabOpen(appId, userId, false);
  }
  async tabIsOpen(appId: string) {
    return Boolean(
      await this.database
        .selectFrom("apps")
        .select("id")
        .where("id", "=", AppIdSchema.parse(appId))
        .where("tabOpenedAt", "is not", null)
        .executeTakeFirst(),
    );
  }
  async listTabs(userId: UserId) {
    await assertPersonalOwner(this.database, userId);
    const rows = await this.database
      .selectFrom("apps")
      .select(["id as appId", "title", "threadId", "latestVersion", "tabOpenedAt"])
      .where("tabOpenedAt", "is not", null)
      .orderBy("tabOpenedAt", "desc")
      .orderBy("id", "asc")
      .limit(500)
      .execute();
    return rows.map(({ tabOpenedAt, ...row }) => ({
      ...row,
      openedAt: tabOpenedAt!.toISOString(),
    }));
  }
  async setTabOpen(appId: string, userId: UserId, open: boolean) {
    const id = AppIdSchema.parse(appId);
    await withPersonalTransaction(this.database, async (tx) => {
      await assertPersonalOwner(tx, userId);
      const row = await tx
        .selectFrom("apps")
        .select("tabOpenedAt")
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) throw missing();
      if (open && !row.tabOpenedAt) {
        const count = await tx
          .selectFrom("apps")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("tabOpenedAt", "is not", null)
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 50)
          throw new OpensteerError({
            code: "conflict",
            message: "You can have at most 50 open app tabs",
          });
      }
      if (open !== (row.tabOpenedAt !== null))
        await tx
          .updateTable("apps")
          .set({ tabOpenedAt: open ? new Date() : null })
          .where("id", "=", id)
          .execute();
    });
    return { appTabs: await this.listTabs(userId) };
  }
  async referencedDigests(): Promise<readonly string[]> {
    return (
      await this.database.selectFrom("appVersions").select("sha256").distinct().execute()
    ).flatMap((row) => (row.sha256 ? [row.sha256] : []));
  }
  async get(appId: string, userId: UserId) {
    await assertPersonalOwner(this.database, userId);
    const row = await this.database
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", AppIdSchema.parse(appId))
      .executeTakeFirst();
    if (!row) throw missing();
    return AppSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  async latest(appId: string, userId: UserId) {
    const app = await this.get(appId, userId);
    const version = await this.database
      .selectFrom("appVersions")
      .selectAll()
      .where("appId", "=", app.id)
      .where("version", "=", app.latestVersion)
      .executeTakeFirstOrThrow();
    return { app, version };
  }
  publication(runId: RunId, publishKey: string) {
    return this.database
      .selectFrom("appVersions")
      .select(["appId", "version"])
      .where("createdByRun", "=", runId)
      .where("publishKey", "=", publishKey)
      .executeTakeFirst();
  }
  async authorize(input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly userId: UserId;
    readonly appId?: string;
    readonly fullAccess?: boolean;
  }) {
    await assertPersonalOwner(this.database, input.userId);
    const publisher = await this.database
      .selectFrom("threads")
      .innerJoin("runs", "runs.threadId", "threads.id")
      .select([
        "threads.id",
        "threads.folderComputerId",
        "threads.folderPath",
        "runs.accessMode",
        "runs.status",
      ])
      .where("runs.id", "=", input.runId)
      .where("threads.id", "=", input.threadId)
      .where("runs.requestedBy", "=", input.userId)
      .where("threads.createdBy", "=", input.userId)
      .executeTakeFirst();
    if (!publisher || !nonTerminalRunStatuses.some((status) => status === publisher.status))
      throw new OpensteerError({
        code: "conflict",
        message: "The publishing Run is no longer active",
      });
    if (input.fullAccess && publisher.accessMode !== "full-access")
      throw new OpensteerError({
        code: "forbidden",
        message: "App servers require a full-access Run",
      });
    const app = input.appId ? await this.get(input.appId, input.userId) : undefined;
    return { publisher, app };
  }
  async list(input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly userId: UserId;
  }) {
    await this.authorize({ ...input, fullAccess: true });
    return this.listOwned(input.userId);
  }
  async listOwned(userId: UserId) {
    await assertPersonalOwner(this.database, userId);
    const rows = await this.database
      .selectFrom("apps")
      .innerJoin("appVersions", (join) =>
        join
          .onRef("appVersions.appId", "=", "apps.id")
          .onRef("appVersions.version", "=", "apps.latestVersion"),
      )
      .selectAll("apps")
      .select("appVersions.server")
      .orderBy("apps.updatedAt", "desc")
      .limit(500)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.server ? ("server" as const) : ("html" as const),
      ...(row.server ? { folder: row.server.folder, start: row.server.command } : {}),
      threadId: row.threadId,
      latestVersion: row.latestVersion,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
  async publish(input: {
    readonly appId?: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly environmentId: EnvironmentId;
    readonly userId: UserId;
    readonly title: string;
    readonly sha256?: string;
    readonly sizeBytes?: number;
    readonly server?: AppServerSpec;
    readonly id?: string;
    readonly expectedVersion?: number;
    readonly publishKey: string;
  }): Promise<{
    readonly appId: string;
    readonly version: number;
    readonly event: AgentEvent | null;
  }> {
    const title = AppTitleSchema.parse(input.title);
    if (
      !input.server &&
      (input.sizeBytes === undefined || input.sizeBytes < 1 || input.sizeBytes > appMaxBytes)
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "App HTML exceeds the 5 MiB limit",
      });
    return withPersonalTransaction(this.database, async (tx) => {
      const scoped = new AppStore(tx);
      const { publisher } = await scoped.authorize({ ...input, fullAccess: Boolean(input.server) });
      const run = await tx
        .selectFrom("runs")
        .select("status")
        .where("id", "=", input.runId)
        .forShare()
        .executeTakeFirst();
      if (!run || !nonTerminalRunStatuses.some((status) => status === run.status))
        throw new OpensteerError({
          code: "conflict",
          message: "The publishing Run is no longer active",
        });
      const replay = await scoped.publication(input.runId, input.publishKey);
      if (replay) return { ...replay, event: null };
      const owner = await assertPersonalOwner(tx, input.userId);
      if (input.server && input.server.folder.computerId !== owner.hostingComputerId)
        throw new OpensteerError({
          code: "bad_request",
          message: "App servers run on the hosting computer",
        });
      const appId = AppIdSchema.parse(input.appId ?? input.id ?? `app_${randomUUID()}`);
      let version = 1;
      const now = new Date();
      if (input.appId) {
        const app = await tx
          .selectFrom("apps")
          .select("latestVersion")
          .where("id", "=", appId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!app) throw missing();
        version = app.latestVersion + 1;
        await tx
          .updateTable("apps")
          .set({ title, latestVersion: version, updatedAt: now })
          .where("id", "=", appId)
          .execute();
      } else
        await tx
          .insertInto("apps")
          .values({
            id: appId,
            threadId: input.threadId,
            runId: input.runId,
            title,
            latestVersion: version,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      if (input.expectedVersion !== undefined && input.expectedVersion !== version)
        throw new OpensteerError({
          code: "conflict",
          message: "App version changed during publication",
        });
      await tx
        .insertInto("appVersions")
        .values({
          appId,
          version,
          sha256: input.sha256 ?? null,
          sizeBytes: input.sizeBytes ?? null,
          server: input.server ?? null,
          createdByRun: input.runId,
          folderComputerId: input.server?.folder.computerId ?? publisher.folderComputerId,
          folderPath: input.server?.folder.path ?? publisher.folderPath,
          publishKey: input.publishKey,
          createdAt: now,
        })
        .execute();
      const event = await appendHostDeploymentEvent(tx, {
        type: "app.published",
        threadId: input.threadId,
        runId: input.runId,
        environmentId: input.environmentId,
        data: { appId, version, title },
      });
      return { appId, version, event };
    });
  }
}
