import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import {
  AppIdSchema,
  AppNameSchema,
  OpensteerError,
  appMaxBytes,
  nonTerminalRunStatuses,
  type AgentEvent,
  type AppId,
  type AppServerSpec,
  type ComputerFolder,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type TabId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { withPersonalReadTransaction, withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";

export const appPortFirst = 49_152;
export const appPortCount = 16_384;
export const appListLimit = 500;

export interface AppServerRecord {
  readonly port: number;
  readonly desiredState: "running" | "stopped";
  readonly generation: number;
  readonly lastError: string | null;
}
export interface AppVersionRecord {
  readonly version: number;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly server: AppServerSpec | null;
}
export interface AppRecord {
  readonly id: AppId;
  readonly ownerId: UserId;
  readonly computerId: RunnerId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  readonly name: string;
  readonly deleting: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The current publication; null only while a first server publication is reserved. */
  readonly version: AppVersionRecord | null;
  /** Kept after conversion to HTML, where it only reserves the app's port. */
  readonly server: AppServerRecord | null;
}
/** A published, live app; reservations and apps being deleted never leave the store as this. */
export type PublishedApp = AppRecord & { readonly version: AppVersionRecord };
export interface AppReservation {
  readonly appId: AppId;
  readonly computerId: RunnerId;
  readonly port: number;
  readonly generation: number;
  readonly published: boolean;
}
export type AppAuthorization = (database: Kysely<DatabaseSchema>) => Promise<void>;

export interface AppRunScope {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly userId: UserId;
}

const missing = () => new OpensteerError({ code: "not_found", message: "App not found" });
const runEnded = () =>
  new OpensteerError({ code: "conflict", message: "The publishing Run is no longer active" });

export class AppStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async referencedDigests(): Promise<readonly string[]> {
    return (
      await this.database.selectFrom("appVersions").select("sha256").distinct().execute()
    ).flatMap((row) => (row.sha256 ? [row.sha256] : []));
  }

  /** A published app the owner can see; deleting apps and reservations are missing. */
  async get(ownerId: UserId, appId: string): Promise<PublishedApp> {
    const parsed = AppIdSchema.safeParse(appId);
    if (!parsed.success) throw missing();
    await requireOwner(this.database, ownerId);
    const [app] = await this.#records(this.database, (query) =>
      query.where("apps.id", "=", parsed.data).where("apps.ownerId", "=", ownerId),
    );
    if (!app?.version || app.deleting) throw missing();
    return { ...app, version: app.version };
  }

  /** Includes apps being deleted, for lifecycle work that must finish them. */
  async record(appId: AppId): Promise<AppRecord | undefined> {
    const [app] = await this.#records(this.database, (query) => query.where("apps.id", "=", appId));
    return app;
  }

  async list(
    ownerId: UserId,
    query?: string,
    authorize?: AppAuthorization,
  ): Promise<PublishedApp[]> {
    return withPersonalReadTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      await requireOwner(tx, ownerId);
      const pattern = query ? `%${query.replace(/[\\%_]/gu, (c) => `\\${c}`)}%` : undefined;
      const apps = await this.#records(tx, (select) => {
        let filtered = select
          .where("apps.ownerId", "=", ownerId)
          .where("apps.deleting", "=", false)
          .where("apps.latestVersion", ">", 0);
        if (pattern)
          filtered = filtered.where((eb) =>
            eb.or([
              eb("apps.name", "ilike", pattern),
              eb(sql<string>`app_versions.server->'folder'->>'path'`, "ilike", pattern),
            ]),
          );
        return filtered
          .orderBy("apps.updatedAt", "desc")
          .orderBy("apps.id")
          .limit(appListLimit + 1);
      });
      if (apps.length > appListLimit)
        throw new OpensteerError({
          code: "resource_exhausted",
          message: `More than ${appListLimit} apps match. Narrow the query or delete apps you no longer need.`,
        });
      return apps.flatMap((app) => (app.version ? [{ ...app, version: app.version }] : []));
    });
  }

  /** Server specs to reconcile on one computer, including stopped ones so the Runner fences them. */
  async runtimeSet(
    computerId: RunnerId,
  ): Promise<Array<PublishedApp & { server: AppServerRecord }>> {
    const apps = await this.#records(this.database, (query) =>
      query
        .where("apps.computerId", "=", computerId)
        .where("apps.deleting", "=", false)
        .where("apps.latestVersion", ">", 0)
        .where("appVersions.server", "is not", null)
        .orderBy("apps.id"),
    );
    return apps.flatMap((app) =>
      app.version?.server && app.server
        ? [{ ...app, version: app.version, server: app.server }]
        : [],
    );
  }

  /** Deletions whose termination was not proven, to finish when their computer reconnects. */
  async deleting(computerId?: RunnerId): Promise<AppRecord[]> {
    return this.#records(this.database, (query) => {
      const deleting = query.where("apps.deleting", "=", true);
      return computerId ? deleting.where("apps.computerId", "=", computerId) : deleting;
    });
  }

  /** Unpublished reservations whose admitting Run has ended or was deleted. */
  async abandonedReservations(): Promise<AppRecord[]> {
    return this.#records(this.database, (query) =>
      query
        .where("apps.latestVersion", "=", 0)
        .leftJoin("runs", "runs.id", "apps.runId")
        .where((eb) =>
          eb.or([eb("runs.id", "is", null), eb("runs.status", "not in", nonTerminalRunStatuses)]),
        ),
    );
  }

  publication(runId: RunId, publishKey: string) {
    return this.database
      .selectFrom("appVersions")
      .select(["appId", "version"])
      .where("createdByRun", "=", runId)
      .where("publishKey", "=", publishKey)
      .executeTakeFirst();
  }

  /** The publishing Run must still be active and belong to the personal owner. */
  async authorizeRun(
    scope: AppRunScope,
    fullAccess: boolean,
    database: Kysely<DatabaseSchema> = this.database,
  ): Promise<{ readonly agentHome: ComputerFolder }> {
    return authorizeRun(database, scope, fullAccess);
  }

  /**
   * Reserves an unpublished app and its fixed port for a first server publication. The
   * creation key makes an interrupted call recover the same reservation.
   */
  async reserve(
    input: {
      readonly scope: AppRunScope;
      readonly creationKey: string;
      readonly name: string;
      readonly computerId: RunnerId;
    },
    authorize?: AppAuthorization,
  ): Promise<AppReservation> {
    const name = AppNameSchema.parse(input.name);
    return withPersonalTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      await authorizeRun(tx, input.scope, true);
      const existing = await tx
        .selectFrom("apps")
        .leftJoin("appServers", "appServers.appId", "apps.id")
        .select([
          "apps.id",
          "apps.computerId",
          "apps.latestVersion",
          "appServers.port",
          "appServers.generation",
        ])
        .where("apps.ownerId", "=", input.scope.userId)
        .where("apps.creationKey", "=", input.creationKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.port === null || existing.generation === null) throw missing();
        return {
          appId: existing.id,
          computerId: existing.computerId,
          port: existing.port,
          generation: Number(existing.generation),
          published: existing.latestVersion > 0,
        };
      }
      const appId = await createApp(tx, { ...input, name });
      const port = await allocatePort(tx, appId, input.computerId);
      await tx
        .insertInto("appServers")
        .values({ appId, computerId: input.computerId, port, desiredState: "stopped" })
        .execute();
      return { appId, computerId: input.computerId, port, generation: 1, published: false };
    });
  }

  /**
   * Prepares an existing app for a server publication on its saved computer: its port is
   * allocated once, then kept, and the new generation fences every older start.
   */
  async prepareServer(
    input: {
      readonly scope: AppRunScope;
      readonly appId: AppId;
      readonly computerId: RunnerId;
    },
    authorize?: AppAuthorization,
  ): Promise<AppReservation> {
    return withPersonalTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      await authorizeRun(tx, input.scope, true);
      const app = await lockApp(tx, input.scope.userId, input.appId);
      if (app.computerId !== input.computerId)
        throw new OpensteerError({
          code: "conflict",
          message: "This app lives on another computer. Publish it as a new app instead.",
        });
      const server = await tx
        .selectFrom("appServers")
        .select(["port", "generation"])
        .where("appId", "=", app.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!server) {
        const port = await allocatePort(tx, app.id, app.computerId);
        await tx
          .insertInto("appServers")
          .values({ appId: app.id, computerId: app.computerId, port, desiredState: "stopped" })
          .execute();
        return { appId: app.id, computerId: app.computerId, port, generation: 1, published: true };
      }
      const generation = Number(server.generation) + 1;
      await tx
        .updateTable("appServers")
        .set({ desiredState: "stopped", generation, lastError: null })
        .where("appId", "=", app.id)
        .execute();
      return {
        appId: app.id,
        computerId: app.computerId,
        port: server.port,
        generation,
        published: app.latestVersion > 0,
      };
    });
  }

  /**
   * Commits one version after its content or server was verified. Without an appId it
   * creates an HTML app. HTML retires a server by moving it to a new stopped generation,
   * which the caller then stops.
   */
  async commit(
    input: {
      readonly scope: AppRunScope & { readonly environmentId: EnvironmentId };
      readonly appId?: AppId;
      readonly name: string;
      readonly publishKey: string;
      readonly expectedVersion?: number;
      readonly html?: { readonly sha256: string; readonly sizeBytes: number };
      readonly server?: AppServerSpec;
      readonly serverGeneration?: number;
    },
    authorize?: AppAuthorization,
  ): Promise<{
    readonly appId: AppId;
    readonly version: number;
    readonly event: AgentEvent;
    readonly retiredServer: { readonly generation: number } | null;
  }> {
    const name = AppNameSchema.parse(input.name);
    if (
      input.html &&
      (input.html.sizeBytes < 1 || input.html.sizeBytes > appMaxBytes || input.server)
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "App HTML exceeds the 5 MiB limit",
      });
    return withPersonalTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      const { agentHome } = await authorizeRun(tx, input.scope, Boolean(input.server));
      if (!input.appId && !input.html)
        throw new OpensteerError({
          code: "bad_request",
          message: "A server app is reserved before it is published",
        });
      const appId =
        input.appId ??
        (await createApp(tx, {
          scope: input.scope,
          name,
          creationKey: `${input.scope.runId}:${input.publishKey}`,
          computerId: agentHome.computerId,
        }));
      const app = await lockApp(tx, input.scope.userId, appId, true);
      if (input.server) {
        const inside = relative(agentHome.path, input.server.folder.path);
        if (
          input.server.folder.computerId !== agentHome.computerId ||
          input.server.folder.computerId !== app.computerId ||
          inside.startsWith("..") ||
          isAbsolute(inside)
        )
          throw new OpensteerError({
            code: "bad_request",
            message: "App servers run in a folder inside Agent home",
          });
        const server = await tx
          .selectFrom("appServers")
          .select("generation")
          .where("appId", "=", app.id)
          .executeTakeFirst();
        // A newer Start, Stop or publication replaced the server this call verified.
        if (!server || Number(server.generation) !== input.serverGeneration)
          throw new OpensteerError({
            code: "conflict",
            message: "The app changed while its server was starting. Check app_list and retry.",
          });
      }
      if (input.server)
        await tx
          .updateTable("appServers")
          .set({ desiredState: "running" })
          .where("appId", "=", app.id)
          .execute();
      const version = app.latestVersion + 1;
      if (input.expectedVersion !== undefined && input.expectedVersion !== version)
        throw new OpensteerError({
          code: "conflict",
          message: "App version changed during publication",
        });
      const now = new Date();
      await tx
        .updateTable("apps")
        .set({ name, latestVersion: version, updatedAt: now })
        .where("id", "=", app.id)
        .execute();
      await tx
        .insertInto("appVersions")
        .values({
          appId: app.id,
          version,
          sha256: input.html?.sha256 ?? null,
          sizeBytes: input.html?.sizeBytes ?? null,
          server: input.server ?? null,
          createdByRun: input.scope.runId,
          publishKey: input.publishKey,
          createdAt: now,
        })
        .execute();
      let retiredServer: { generation: number } | null = null;
      if (!input.server) {
        const retired = await tx
          .updateTable("appServers")
          .set((eb) => ({
            desiredState: "stopped",
            generation: eb("generation", "+", 1),
            lastError: null,
          }))
          .where("appId", "=", app.id)
          .returning("generation")
          .executeTakeFirst();
        if (retired) retiredServer = { generation: Number(retired.generation) };
      }
      const event = await appendHostDeploymentEvent(tx, {
        type: "app.published",
        threadId: input.scope.threadId,
        runId: input.scope.runId,
        environmentId: input.scope.environmentId,
        data: { appId: app.id, version, title: name },
      });
      return { appId: app.id, version, event, retiredServer };
    });
  }

  async rename(ownerId: UserId, appId: AppId, name: string): Promise<void> {
    const parsed = AppNameSchema.parse(name);
    await withPersonalTransaction(this.database, async (tx) => {
      const app = await lockApp(tx, ownerId, appId);
      await tx
        .updateTable("apps")
        .set({ name: parsed, updatedAt: new Date() })
        .where("id", "=", app.id)
        .execute();
    });
  }

  /** Persists server intent with a new generation, before any Runner I/O. */
  async setDesiredState(
    ownerId: UserId,
    appId: AppId,
    desiredState: "running" | "stopped",
    authorize?: AppAuthorization,
  ): Promise<PublishedApp & { readonly server: AppServerRecord }> {
    return withPersonalTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      const app = await lockApp(tx, ownerId, appId);
      const [record] = await this.#records(tx, (query) => query.where("apps.id", "=", app.id));
      if (!record?.version) throw missing();
      if (!record.version.server || !record.server)
        throw new OpensteerError({
          code: "bad_request",
          message: "This app is HTML and has no server to start or stop.",
        });
      const generation = record.server.generation + 1;
      await tx
        .updateTable("appServers")
        .set({ desiredState, generation, lastError: null })
        .where("appId", "=", app.id)
        .execute();
      return {
        ...record,
        version: record.version,
        server: { ...record.server, desiredState, generation, lastError: null },
      };
    });
  }

  /** Records the outcome of one generation; a newer generation's intent is never overwritten. */
  async setLastError(appId: AppId, generation: number, lastError: string | null): Promise<boolean> {
    const result = await this.database
      .updateTable("appServers")
      .set({ lastError: lastError?.slice(0, 2_000) ?? null })
      .where("appId", "=", appId)
      .where("generation", "=", generation)
      .where((eb) =>
        lastError === null
          ? eb("lastError", "is not", null)
          : eb("lastError", "is distinct from", lastError),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Withdraws only the failed generation's intent; newer lifecycle work keeps its authority. */
  async cancelStart(appId: AppId, generation: number): Promise<void> {
    await withPersonalTransaction(this.database, async (tx) => {
      await tx
        .updateTable("appServers")
        .set({ desiredState: "stopped", generation: generation + 1, lastError: null })
        .where("appId", "=", appId)
        .where("generation", "=", generation)
        .execute();
    });
  }

  /** Refuses new publication, start and viewing while atomically withdrawing tab membership. */
  async markDeleting(
    ownerId: UserId,
    appId: AppId,
    removeTabs: (tx: Transaction<DatabaseSchema>, appId: AppId) => Promise<TabId[]>,
    authorize?: AppAuthorization,
  ): Promise<AppRecord> {
    return withPersonalTransaction(this.database, async (tx) => {
      await authorize?.(tx);
      const app = await lockApp(tx, ownerId, appId, true);
      await tx.updateTable("apps").set({ deleting: true }).where("id", "=", app.id).execute();
      await tx
        .updateTable("appServers")
        .set((eb) => ({ desiredState: "stopped", generation: eb("generation", "+", 1) }))
        .where("appId", "=", app.id)
        .execute();
      await removeTabs(tx, app.id);
      const [record] = await this.#records(tx, (query) => query.where("apps.id", "=", app.id));
      if (!record) throw missing();
      return record;
    });
  }

  /** Removes the app's tabs and records in one personal transaction; its folder stays. */
  async remove(
    appId: AppId,
    removeTabs: (tx: Transaction<DatabaseSchema>, appId: AppId) => Promise<TabId[]>,
  ): Promise<TabId[]> {
    return withPersonalTransaction(this.database, async (tx) => {
      const app = await tx
        .selectFrom("apps")
        .select(["id", "deleting"])
        .where("id", "=", appId)
        // FOR UPDATE: Deletes this app row after removing its tab membership.
        .forUpdate()
        .executeTakeFirst();
      if (!app) return [];
      const tabs = app.deleting ? [] : await removeTabs(tx, appId);
      await tx.deleteFrom("apps").where("id", "=", appId).execute();
      return tabs;
    });
  }

  async #records(
    database: Kysely<DatabaseSchema>,
    filter: (query: AppQuery) => AppQuery,
  ): Promise<AppRecord[]> {
    const rows = await filter(appQuery(database)).execute();
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      computerId: row.computerId,
      threadId: row.threadId,
      runId: row.runId,
      name: row.name,
      deleting: row.deleting,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version:
        row.latestVersion > 0
          ? {
              version: row.latestVersion,
              sha256: row.sha256,
              sizeBytes: row.sizeBytes,
              server: row.server,
            }
          : null,
      server:
        row.port !== null && row.desiredState !== null && row.generation !== null
          ? {
              port: row.port,
              desiredState: row.desiredState,
              generation: Number(row.generation),
              lastError: row.lastError,
            }
          : null,
    }));
  }
}

type AppQuery = ReturnType<typeof appQuery>;
function appQuery(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("apps")
    .leftJoin("appVersions", (join) =>
      join
        .onRef("appVersions.appId", "=", "apps.id")
        .onRef("appVersions.version", "=", "apps.latestVersion"),
    )
    .leftJoin("appServers", "appServers.appId", "apps.id")
    .select([
      "apps.id",
      "apps.ownerId",
      "apps.computerId",
      "apps.threadId",
      "apps.runId",
      "apps.name",
      "apps.latestVersion",
      "apps.deleting",
      "apps.createdAt",
      "apps.updatedAt",
      "appVersions.sha256",
      "appVersions.sizeBytes",
      "appVersions.server",
      "appServers.port",
      "appServers.desiredState",
      "appServers.generation",
      "appServers.lastError",
    ]);
}

async function createApp(
  tx: Transaction<DatabaseSchema>,
  input: {
    readonly scope: AppRunScope;
    readonly name: string;
    readonly creationKey: string;
    readonly computerId: RunnerId;
  },
): Promise<AppId> {
  const { count } = await tx
    .selectFrom("apps")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("ownerId", "=", input.scope.userId)
    .executeTakeFirstOrThrow();
  if (Number(count) >= appListLimit)
    throw new OpensteerError({
      code: "resource_exhausted",
      message: `You can store at most ${appListLimit} apps, including pending deletions. Delete an app and confirm its server stopped before publishing another.`,
    });
  const appId = AppIdSchema.parse(`app_${randomUUID()}`);
  const now = new Date();
  await tx
    .insertInto("apps")
    .values({
      id: appId,
      ownerId: input.scope.userId,
      computerId: input.computerId,
      threadId: input.scope.threadId,
      runId: input.scope.runId,
      name: input.name,
      creationKey: input.creationKey,
      latestVersion: 0,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return appId;
}

async function requireOwner(database: Kysely<DatabaseSchema>, ownerId: UserId): Promise<void> {
  const owner = await database
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .select("personalSettings.ownerId")
    .where("personalSettings.ownerId", "=", ownerId)
    .where("users.disabledAt", "is", null)
    .executeTakeFirst();
  if (!owner) throw missing();
}

async function authorizeRun(
  database: Kysely<DatabaseSchema>,
  scope: AppRunScope,
  fullAccess: boolean,
): Promise<{ readonly agentHome: ComputerFolder }> {
  await requireOwner(database, scope.userId);
  let query = database
    .selectFrom("threads")
    .innerJoin("runs", "runs.threadId", "threads.id")
    .innerJoin("personalSettings", "personalSettings.ownerId", "runs.requestedBy")
    .select([
      "personalSettings.agentHomeComputerId",
      "personalSettings.agentHomePath",
      "runs.accessMode",
      "runs.status",
    ])
    .where("runs.id", "=", scope.runId)
    .where("threads.id", "=", scope.threadId)
    .where("runs.requestedBy", "=", scope.userId)
    .where("threads.createdBy", "=", scope.userId);
  // Inside a publication's transaction the Run cannot end before commit.
  if (database.isTransaction) query = query.forShare("runs");
  const run = await query.executeTakeFirst();
  if (!run || !nonTerminalRunStatuses.some((status) => status === run.status)) throw runEnded();
  if (fullAccess && run.accessMode !== "full-access")
    throw new OpensteerError({
      code: "forbidden",
      message: "App servers require a full-access Run",
      next: "Publish HTML instead, or ask the person to run this task with full access.",
    });
  return { agentHome: { computerId: run.agentHomeComputerId, path: run.agentHomePath } };
}

async function lockApp(
  tx: Transaction<DatabaseSchema>,
  ownerId: UserId,
  appId: AppId,
  allowUnpublished = false,
) {
  await requireOwner(tx, ownerId);
  const app = await tx
    .selectFrom("apps")
    .select(["id", "computerId", "latestVersion", "deleting"])
    .where("id", "=", appId)
    .where("ownerId", "=", ownerId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!app || app.deleting || (!allowUnpublished && app.latestVersion === 0)) throw missing();
  return app;
}

/** Starts at a stable per-app port and scans cyclically past this computer's reservations. */
async function allocatePort(
  tx: Transaction<DatabaseSchema>,
  appId: AppId,
  computerId: RunnerId,
): Promise<number> {
  const taken = new Set(
    (
      await tx
        .selectFrom("appServers")
        .select("port")
        .where("computerId", "=", computerId)
        .execute()
    ).map((row) => row.port),
  );
  const start = createHash("md5").update(appId).digest().readUInt32BE(0) % appPortCount;
  for (let offset = 0; offset < appPortCount; offset++) {
    const port = appPortFirst + ((start + offset) % appPortCount);
    if (!taken.has(port)) return port;
  }
  throw new OpensteerError({
    code: "resource_exhausted",
    message: "This computer has no free app ports left. Delete apps you no longer need.",
  });
}

// Other stores still type the facade on the pre-0026 schema; the event tables are identical.
