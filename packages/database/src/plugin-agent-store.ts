import { OpensteerError, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Insertable } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requirePersonalOwner } from "./personal-settings-store.js";

export type PluginAgentAccess = "all" | "read-only" | "off";
export type PluginExecutionRecord = Selectable<DatabaseSchema["pluginExecutions"]>;
export class PluginAgentStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  /** Every plugin's access, read on each authorization; per-version provenance stays out of it. */
  async settings(owner: UserId) {
    await requirePersonalOwner(this.database, owner);
    return this.database
      .selectFrom("pluginAgentSettings")
      .select(["pluginId", "access", "author"])
      .where("ownerUserId", "=", owner)
      .execute();
  }
  /** Who wrote each named version, keyed `plugin\u0000version`; unnamed versions are not read. */
  async versionAuthors(
    owner: UserId,
    versions: readonly { pluginId: string; version: string }[],
  ): Promise<ReadonlyMap<string, "catalog" | "agent">> {
    await requirePersonalOwner(this.database, owner);
    if (!versions.length) return new Map();
    const { rows } = await sql<{ pluginId: string; version: string; author: string | null }>`
      select v."pluginId", v.version, s.version_authors ->> v.version as author
      from jsonb_to_recordset(${JSON.stringify(versions)}::jsonb) as v("pluginId" text, version text)
      join plugin_agent_settings s on s.plugin_id = v."pluginId" and s.owner_user_id = ${owner}`.execute(
      this.database,
    );
    return new Map(
      rows.flatMap((row) =>
        row.author === "catalog" || row.author === "agent"
          ? [[`${row.pluginId}\u0000${row.version}`, row.author] as const]
          : [],
      ),
    );
  }
  async setAccess(owner: UserId, plugin: string, access: PluginAgentAccess) {
    await requirePersonalOwner(this.database, owner);
    if (!["all", "read-only", "off"].includes(access))
      throw new OpensteerError({ code: "bad_request", message: "Choose all, read-only or off." });
    await this.database
      .insertInto("pluginAgentSettings")
      .values({
        ownerUserId: owner,
        pluginId: plugin,
        access,
        author: "agent",
        versionAuthors: {},
      })
      .onConflict((c) => c.columns(["ownerUserId", "pluginId"]).doUpdateSet({ access }))
      .execute();
  }
  async recordInstall(owner: UserId, plugin: string, version: string, author: "catalog" | "agent") {
    await requirePersonalOwner(this.database, owner);
    await this.database
      .insertInto("pluginAgentSettings")
      .values({
        ownerUserId: owner,
        pluginId: plugin,
        access: "all",
        author,
        versionAuthors: { [version]: author },
      })
      .onConflict((c) =>
        c.columns(["ownerUserId", "pluginId"]).doUpdateSet({
          author,
          versionAuthors: sql`plugin_agent_settings.version_authors || ${JSON.stringify({ [version]: author })}::jsonb`,
        }),
      )
      .execute();
  }
  async recordActivation(owner: UserId, plugin: string, version: string) {
    const authors = await this.versionAuthors(owner, [{ pluginId: plugin, version }]);
    await this.recordInstall(
      owner,
      plugin,
      version,
      authors.get(`${plugin}\u0000${version}`) ?? "agent",
    );
  }
  execution(id: string) {
    return this.database
      .selectFrom("pluginExecutions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }
  takeForRun(row: PluginExecutionRecord, runId: import("@opensteer/core").RunId) {
    return this.database
      .updateTable("pluginExecutions")
      .set({ runId, handoff: false, updatedAt: new Date() })
      .where("id", "=", row.id)
      .where("runId", "=", row.runId!)
      .where("state", "=", "answered")
      .where((eb) => eb.or([eb("handoff", "=", true), eb("runId", "=", runId)]))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("runs")
            .select("id")
            .where("id", "=", runId)
            .where("status", "in", ["starting", "running", "waiting"]),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("commands")
              .select("id")
              .whereRef("commands.runId", "=", "pluginExecutions.runId")
              .where("type", "=", "run.interrupt")
              .where(sql<boolean>`authority_source ->> 'kind' <> 'request-hold'`),
          ),
        ),
      )
      .returningAll()
      .executeTakeFirst();
  }
  async insert(input: Insertable<DatabaseSchema["pluginExecutions"]>) {
    await this.database
      .insertInto("pluginExecutions")
      .values(input)
      .onConflict((c) => c.column("id").doNothing())
      .execute();
  }
  updateLive(
    id: string,
    input: Partial<
      Pick<
        PluginExecutionRecord,
        "state" | "requestId" | "interactionId" | "handoff" | "result" | "reason"
      >
    >,
    runId?: import("@opensteer/core").RunId | null,
  ) {
    return this.database
      .updateTable("pluginExecutions")
      .set({ ...input, updatedAt: new Date() })
      .where("id", "=", id)
      .where("state", "in", ["running", "waiting", "answered"])
      .$if(runId !== undefined, (query) =>
        query.where("runId", runId === null ? "is" : "=", runId ?? null),
      )
      .returningAll()
      .executeTakeFirst();
  }
  async update(id: string, input: Parameters<PluginAgentStore["updateLive"]>[1]) {
    return (await this.updateLive(id, input)) ?? (await this.execution(id))!;
  }
  unfinished() {
    return this.database
      .selectFrom("pluginExecutions")
      .selectAll()
      .where("state", "in", ["running", "waiting", "answered"])
      .execute();
  }
}
