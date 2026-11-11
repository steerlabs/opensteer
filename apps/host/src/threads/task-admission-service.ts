import {
  OpensteerError,
  TeamSourceSchema,
  type AgentEvent,
  type ExecutionSelection,
} from "@opensteer/core";
import {
  admitTeamTaskRequest,
  cancelTeamTaskRequest,
  findTeamTaskAdmission,
} from "@opensteer/database/task-admission-store";
import {
  personalSettings,
  requirePersonalOwner,
} from "@opensteer/database/personal-settings-store";
import type { DatabaseSchema, RevokedRunGrant } from "@opensteer/database";
import type { Kysely } from "kysely";
import type {
  TaskAdmissionPort,
  TeamTaskAdmission,
  TeamTaskAdmissionReceipt,
} from "./task-admission.js";
import type { FolderAdmissionService } from "./folder-admission-service.js";

export class TaskAdmissionService implements TaskAdmissionPort {
  readonly options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly folders: FolderAdmissionService;
    readonly execution: () => Promise<ExecutionSelection>;
    readonly publish: (events: readonly AgentEvent[]) => void;
    readonly revokeGrants: (grants: readonly RevokedRunGrant[]) => void;
  };
  constructor(options: TaskAdmissionService["options"]) {
    this.options = options;
  }

  async admitTeamRequest(input: TeamTaskAdmission): Promise<TeamTaskAdmissionReceipt> {
    const source = TeamSourceSchema.parse(input.source);
    if (
      source.teamId !== input.origin.teamId ||
      source.channelId !== input.origin.channelId ||
      source.threadRootId !== input.origin.threadRootId ||
      (source.messageId !== null && source.messageId !== input.triggerMessageId)
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Team request source does not match its task binding.",
      });
    const settings = await personalSettings(this.options.database);
    await requirePersonalOwner(this.options.database, settings.ownerId);
    const prior = await findTeamTaskAdmission(this.options.database, input);
    if (prior) return prior;
    const bound = await this.options.database
      .selectFrom("threads")
      .select(["folderComputerId", "folderPath"])
      .where("teamId", "=", input.origin.teamId)
      .where("channelId", "=", input.origin.channelId)
      .where("threadRootId", "=", input.origin.threadRootId)
      .executeTakeFirst();
    const folder = await this.options.folders.admit(
      bound ? { computerId: bound.folderComputerId, path: bound.folderPath } : input.folder,
    );
    const admitted = await admitTeamTaskRequest(this.options.database, {
      ...input,
      source,
      folder,
      ownerId: settings.ownerId,
      execution: await this.options.execution(),
    });
    this.options.publish(admitted.events);
    return admitted.receipt;
  }

  async cancelTeamRequest(
    input: Parameters<TaskAdmissionPort["cancelTeamRequest"]>[0],
  ): Promise<void> {
    const cancelled = await cancelTeamTaskRequest(this.options.database, input);
    this.options.revokeGrants(cancelled.revokedGrants);
    this.options.publish(cancelled.events);
  }
}
