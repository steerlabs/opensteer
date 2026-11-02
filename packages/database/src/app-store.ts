import { randomUUID } from "node:crypto";
import {
  AppIdSchema,
  AppSchema,
  AppTitleSchema,
  OpensteerError,
  appMaxBytes,
  nonTerminalRunStatuses,
  threadInReach,
  type AgentEvent,
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
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

  async referencedDigests(): Promise<readonly string[]> {
    return (
      await this.#database.selectFrom("appVersions").select("sha256").distinct().execute()
    ).map((row) => row.sha256);
  }

  async get(appId: string, userId: UserId) {
    const row = await this.#database
      .selectFrom("apps")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "apps.workspaceId")
      .selectAll("apps")
      .where("apps.id", "=", AppIdSchema.parse(appId))
      .where("workspaceMemberships.userId", "=", userId)
      .where("workspaceMemberships.state", "=", "active")
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

  async publish(input: {
    readonly appId?: string;
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly environmentId: EnvironmentId;
    readonly userId: UserId;
    readonly title: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly publishKey: string;
  }): Promise<{
    readonly appId: string;
    readonly version: number;
    readonly event: AgentEvent | null;
  }> {
    const title = AppTitleSchema.parse(input.title);
    if (input.sizeBytes < 1 || input.sizeBytes > appMaxBytes)
      throw new OpensteerError({
        code: "bad_request",
        message: "App HTML exceeds the 5 MiB limit",
      });
    return withRequestWorkspaceLocks(
      this.#database,
      async () => [input.workspaceId],
      async (transaction) => {
        await requireActiveWorkspaceMembership(transaction, input.workspaceId, input.userId);
        const run = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.id", "runs.status"])
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
        const replay = await transaction
          .selectFrom("appVersions")
          .select(["appId", "version"])
          .where("createdByRun", "=", input.runId)
          .where("publishKey", "=", input.publishKey)
          .executeTakeFirst();
        if (replay) return { ...replay, event: null };
        const now = new Date();
        const appId = input.appId ? AppIdSchema.parse(input.appId) : `app_${randomUUID()}`;
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
            .select(["id", "capabilityProfileId", "lineageRootThreadId", "workspaceId"])
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
        await transaction
          .insertInto("appVersions")
          .values({
            appId,
            version,
            sha256: input.sha256,
            sizeBytes: input.sizeBytes,
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
