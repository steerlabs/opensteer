import {
  OpensteerError,
  TaskFolderSchema,
  type DeploymentId,
  type TaskFolder,
  type TeamChannelId,
  type TeamTaskOrigin,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export class PersonalTeamChannelFoldersStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async home(): Promise<TaskFolder> {
    const settings = await this.database
      .selectFrom("personalSettings")
      .select(["agentHomeComputerId", "agentHomePath"])
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    return TaskFolderSchema.parse({
      computerId: settings.agentHomeComputerId,
      path: settings.agentHomePath,
    });
  }

  async get(teamId: DeploymentId, channelId: TeamChannelId): Promise<TaskFolder> {
    const row = await this.database
      .selectFrom("personalTeamChannelFolders")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .where("channelId", "=", channelId)
      .executeTakeFirst();
    return row
      ? TaskFolderSchema.parse({ computerId: row.computerId, path: row.folderPath })
      : this.home();
  }

  async set(teamId: DeploymentId, channelId: TeamChannelId, input: TaskFolder): Promise<void> {
    const folder = TaskFolderSchema.parse(input);
    if (folder.computerId !== (await this.home()).computerId) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Tasks run on the hosting computer",
      });
    }
    await this.database
      .insertInto("personalTeamChannelFolders")
      .values({
        teamDeploymentId: teamId,
        channelId,
        computerId: folder.computerId,
        folderPath: folder.path,
        updatedAt: new Date().toISOString(),
      })
      .onConflict((conflict) =>
        conflict.columns(["teamDeploymentId", "channelId"]).doUpdateSet({
          computerId: folder.computerId,
          folderPath: folder.path,
          updatedAt: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async task(origin: TeamTaskOrigin) {
    const row = await this.database
      .selectFrom("threads")
      .select("id")
      .where("teamId", "=", origin.teamId)
      .where("channelId", "=", origin.channelId)
      .where("threadRootId", "=", origin.threadRootId)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
