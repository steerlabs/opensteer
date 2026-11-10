import { effectiveMembershipPredicate } from "./effective-membership.js";
import { randomUUID } from "node:crypto";
import {
  AppIdSchema,
  AppSchema,
  AppTitleSchema,
  OpensteerError,
  appMaxBytes,
  nonTerminalRunStatuses,
  threadInReach,
  threadReachScope,
  type AppServerSpec,
  type AgentEvent,
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
  type ThreadReachScope,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requireActiveWorkspaceMembership } from "./store-primitives.js";
import { withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

const missing = () => new OpensteerError({ code: "not_found", message: "App not found" });
export class AppStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  openTab(appId: string, userId: UserId) {
    return this.setTabOpen(appId, userId, true);
  }
  closeTab(appId: string, userId: UserId) {
    return this.setTabOpen(appId, userId, false);
  }
  async openTabWorkspace(appId: string) {
    return this.#database
      .selectFrom("apps")
      .select("workspaceId")
      .where("id", "=", AppIdSchema.parse(appId))
      .where("tabOpenedAt", "is not", null)
      .executeTakeFirst();
  }
  async listTabs(userId: UserId) {
    const rows = await this.#database
      .selectFrom("apps")
      .innerJoin("workspaces", "workspaces.id", "apps.workspaceId")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "apps.workspaceId")
      .select([
        "apps.id as appId",
        "apps.title",
        "apps.threadId",
        "apps.workspaceId",
        "apps.latestVersion",
        "apps.tabOpenedAt",
      ])
      .where("workspaceMemberships.userId", "=", userId)
      .where(effectiveMembershipPredicate(this.#database))
      .where("workspaces.status", "not in", ["deleting", "deleted"])
      .where("apps.tabOpenedAt", "is not", null)
      .orderBy("apps.tabOpenedAt", "desc")
      .orderBy("apps.id", "asc")
      .limit(500)
      .execute();
    return rows.map(({ tabOpenedAt, ...row }) => ({
      ...row,
      openedAt: tabOpenedAt!.toISOString(),
    }));
  }

  async setTabOpen(appId: string, userId: UserId, open: boolean) {
    const id = AppIdSchema.parse(appId);
    const workspaceId = await withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => {
        const row = await transaction
          .selectFrom("apps")
          .select("workspaceId")
          .where("id", "=", id)
          .executeTakeFirst();
        return row ? [row.workspaceId] : [];
      },
      async (transaction) => {
        const row = await transaction
          .selectFrom("apps")
          .innerJoin("workspaces", "workspaces.id", "apps.workspaceId")
          .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "apps.workspaceId")
          .select(["apps.workspaceId", "apps.tabOpenedAt", "workspaces.status"])
          .where("apps.id", "=", id)
          .where("workspaceMemberships.userId", "=", userId)
          .where(effectiveMembershipPredicate(transaction))
          .executeTakeFirst();
        if (!row) throw missing();
        if (open && (row.status === "deleting" || row.status === "deleted"))
          throw new OpensteerError({
            code: "workspace_unavailable",
            message: "Workspace is awaiting deletion",
            reason: "workspace-deleting",
          });
        if (open && !row.tabOpenedAt) {
          const count = await transaction
            .selectFrom("apps")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("workspaceId", "=", row.workspaceId)
            .where("tabOpenedAt", "is not", null)
            .executeTakeFirstOrThrow();
          if (Number(count.count) >= 50)
            throw new OpensteerError({
              code: "conflict",
              message: "A Workspace can have at most 50 open app tabs",
            });
        }
        if (open !== (row.tabOpenedAt !== null))
          await transaction
            .updateTable("apps")
            .set({ tabOpenedAt: open ? new Date() : null })
            .where("id", "=", id)
            .execute();
        return row.workspaceId;
      },
    );
    return { workspaceId, appTabs: await this.listTabs(userId) };
  }

  async referencedDigests(): Promise<readonly string[]> {
    return (
      await this.#database.selectFrom("appVersions").select("sha256").distinct().execute()
    ).flatMap((row) => (row.sha256 ? [row.sha256] : []));
  }

  async get(appId: string, userId: UserId) {
    const row = await this.#database
      .selectFrom("apps")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "apps.workspaceId")
      .selectAll("apps")
      .where("apps.id", "=", AppIdSchema.parse(appId))
      .where("workspaceMemberships.userId", "=", userId)
      .where(effectiveMembershipPredicate(this.#database))
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
    const version = await this.#database
      .selectFrom("appVersions")
      .selectAll()
      .where("appId", "=", app.id)
      .where("version", "=", app.latestVersion)
      .executeTakeFirstOrThrow();
    return { app, version };
  }

  publication(runId: RunId, publishKey: string) {
    return this.#database
      .selectFrom("appVersions")
      .select(["appId", "version"])
      .where("createdByRun", "=", runId)
      .where("publishKey", "=", publishKey)
      .executeTakeFirst();
  }

  async authorize(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly userId: UserId;
    readonly appId?: string;
    readonly fullAccess?: boolean;
    readonly sameWorkspace?: boolean;
  }) {
    const membership = await this.#database
      .selectFrom("workspaceMemberships")
      .select("workspaceId")
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.userId)
      .where(effectiveMembershipPredicate(this.#database, "state"))
      .executeTakeFirst();
    if (!membership) throw missing();
    const publisher = await this.#database
      .selectFrom("threads")
      .innerJoin("runs", "runs.threadId", "threads.id")
      .select([
        "threads.id",
        "threads.workspaceId",
        "threads.inheritsMain",
        "threads.specialistId",
        "threads.lineageRootThreadId",
        "threads.accessMode",
        "runs.status",
      ])
      .where("runs.id", "=", input.runId)
      .where("threads.id", "=", input.threadId)
      .where("threads.workspaceId", "=", input.workspaceId)
      .where("runs.requestedBy", "=", input.userId)
      .executeTakeFirst();
    if (!publisher || !nonTerminalRunStatuses.some((status) => status === publisher.status))
      throw new OpensteerError({
        code: "conflict",
        message: "The publishing Run is no longer active",
      });
    let app;
    if (input.appId) {
      app = await this.get(input.appId, input.userId);
      if (input.sameWorkspace && app.workspaceId !== input.workspaceId) throw missing();
      const origin = await this.#database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", app.threadId)
        .executeTakeFirst();
      if (!origin || !threadInReach(publisher, origin)) throw missing();
    }
    if (input.fullAccess && publisher.accessMode !== "full-access")
      throw new OpensteerError({
        code: "forbidden",
        message: "App servers require a full-access Run",
      });
    return { publisher, app };
  }

  async list(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly userId: UserId;
  }) {
    const { publisher } = await this.authorize({ ...input, fullAccess: true });
    return this.listReachable({ userId: input.userId, reach: threadReachScope(publisher) });
  }

  async listReachable(input: { userId: UserId; reach: ThreadReachScope }) {
    const rows = await this.#database
      .selectFrom("apps")
      .innerJoin("threads", "threads.id", "apps.threadId")
      .innerJoin("appVersions", (join) =>
        join
          .onRef("appVersions.appId", "=", "apps.id")
          .onRef("appVersions.version", "=", "apps.latestVersion"),
      )
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "apps.workspaceId")
      .selectAll("apps")
      .select([
        "threads.inheritsMain",
        "threads.specialistId",
        "threads.lineageRootThreadId",
        "appVersions.server",
      ])
      .where("workspaceMemberships.userId", "=", input.userId)
      .where(effectiveMembershipPredicate(this.#database))
      .execute();
    return rows
      .filter((row) => threadInReach(input.reach, row))
      .map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.server ? ("server" as const) : ("html" as const),
        ...(row.server ? { folder: row.server.folder, start: row.server.command } : {}),
        threadId: row.threadId,
        latestVersion: row.latestVersion,
        updatedAt: row.updatedAt.toISOString(),
      }));
  }

  serversForWorkspace(workspaceId: WorkspaceId) {
    return this.#database
      .selectFrom("apps")
      .innerJoin("workspaces", "workspaces.id", "apps.workspaceId")
      .innerJoin("appVersions", (join) =>
        join
          .onRef("appVersions.appId", "=", "apps.id")
          .onRef("appVersions.version", "=", "apps.latestVersion"),
      )
      .select([
        "apps.id as appId",
        "apps.latestVersion as version",
        "workspaces.backing",
        "appVersions.server",
      ])
      .where("apps.workspaceId", "=", workspaceId)
      .where("appVersions.server", "is not", null)
      .execute();
  }

  async publish(input: {
    readonly appId?: string;
    readonly workspaceId: WorkspaceId;
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
    return withRequestWorkspaceLocks(
      this.#database,
      async () => [input.workspaceId],
      async (transaction) => {
        await requireActiveWorkspaceMembership(transaction, input.workspaceId, input.userId);
        const workspace = await transaction
          .selectFrom("workspaces")
          .select("status")
          .where("id", "=", input.workspaceId)
          .executeTakeFirst();
        if (!workspace || workspace.status === "deleting" || workspace.status === "deleted")
          throw new OpensteerError({
            code: "workspace_unavailable",
            message: "Workspace is awaiting deletion",
            reason: "workspace-deleting",
          });
        const run = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.id", "runs.status", "threads.accessMode"])
          .where("runs.id", "=", input.runId)
          .where("runs.threadId", "=", input.threadId)
          .where("threads.workspaceId", "=", input.workspaceId)
          .where("runs.requestedBy", "=", input.userId)
          .executeTakeFirst();
        if (!run || !nonTerminalRunStatuses.some((status) => status === run.status))
          throw new OpensteerError({
            code: "conflict",
            message: "The publishing Run is no longer active",
          });
        if (input.server && run.accessMode !== "full-access")
          throw new OpensteerError({
            code: "forbidden",
            message: "App servers require a full-access Run",
          });
        const replay = await transaction
          .selectFrom("appVersions")
          .select(["appId", "version"])
          .where("createdByRun", "=", input.runId)
          .where("publishKey", "=", input.publishKey)
          .executeTakeFirst();
        if (replay) return { ...replay, event: null };
        const now = new Date();
        const appId = input.appId
          ? AppIdSchema.parse(input.appId)
          : (input.id ?? `app_${randomUUID()}`);
        let version = 1;
        if (input.appId) {
          const app = await transaction
            .selectFrom("apps")
            .selectAll()
            .where("id", "=", appId)
            .where("workspaceId", "=", input.workspaceId)
            .forNoKeyUpdate()
            .executeTakeFirst();
          if (!app) throw missing();
          const threads = await transaction
            .selectFrom("threads")
            .select(["id", "inheritsMain", "specialistId", "lineageRootThreadId", "workspaceId"])
            .where("id", "in", [input.threadId, app.threadId])
            .execute();
          const publisher = threads.find((thread) => thread.id === input.threadId);
          const origin = threads.find((thread) => thread.id === app.threadId);
          // Updating changes what the origin Thread shows, so the publisher must reach it.
          if (!publisher || !origin || !threadInReach(publisher, origin)) throw missing();
          version = app.latestVersion + 1;
          await transaction
            .updateTable("apps")
            .set({ title, latestVersion: version, updatedAt: now })
            .where("id", "=", appId)
            .execute();
        } else {
          await transaction
            .insertInto("apps")
            .values({
              id: appId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              runId: input.runId,
              title,
              latestVersion: version,
              createdAt: now,
              updatedAt: now,
            })
            .execute();
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== version)
          throw new OpensteerError({
            code: "conflict",
            message: "App version changed during publication",
          });
        await transaction
          .insertInto("appVersions")
          .values({
            appId,
            version,
            sha256: input.sha256 ?? null,
            sizeBytes: input.sizeBytes ?? null,
            server: input.server ?? null,
            createdByRun: input.runId,
            publishKey: input.publishKey,
            createdAt: now,
          })
          .execute();
        const event = await appendHostWorkspaceEvent(transaction, {
          type: "app.published",
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          runId: input.runId,
          environmentId: input.environmentId,
          data: { appId, version, title },
        });
        return { appId, version, event };
      },
      async (transaction) => {
        await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "=", input.runId)
          .forNoKeyUpdate()
          .execute();
      },
    );
  }
}
