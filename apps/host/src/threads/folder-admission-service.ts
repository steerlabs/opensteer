import { realpath, stat } from "node:fs/promises";
import {
  OpensteerError,
  TaskFolderSchema,
  type RunnerId,
  type UserId,
  type EnvironmentId,
  type TaskFolder,
} from "@opensteer/core";

export class FolderAdmissionService {
  readonly options: {
    readonly hostingComputerId: RunnerId;
    readonly ownerId: UserId;
    readonly environmentId: EnvironmentId;
    readonly agentHome: TaskFolder;
    readonly assertOwner: (ownerId: UserId) => Promise<void>;
  };
  constructor(options: FolderAdmissionService["options"]) {
    this.options = options;
  }

  canExecute(environmentId: EnvironmentId): boolean {
    return environmentId === this.options.environmentId;
  }

  async resolve(ownerId: UserId, folder?: TaskFolder) {
    await this.options.assertOwner(ownerId);
    if (ownerId !== this.options.ownerId)
      throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
    return {
      folder: await this.admit(folder ?? this.options.agentHome),
      environmentId: this.options.environmentId,
    };
  }

  can(computerId: RunnerId) {
    return { executeTasks: computerId === this.options.hostingComputerId };
  }

  async assertAvailable(folder: TaskFolder): Promise<void> {
    const resolved = await this.admit(folder);
    if (resolved.path !== folder.path)
      throw new OpensteerError({
        code: "folder_unavailable",
        message: "This task's folder changed on disk. Restore that folder or start a new task.",
      });
  }

  async admit(folder: TaskFolder): Promise<TaskFolder> {
    const chosen = TaskFolderSchema.parse(folder);
    if (!this.can(chosen.computerId).executeTasks)
      throw new OpensteerError({
        code: "bad_request",
        message: "Tasks can run only on the hosting computer. Choose a folder on that computer.",
      });
    try {
      const path = await realpath(chosen.path);
      if (!(await stat(path)).isDirectory())
        throw new OpensteerError({ code: "bad_request", message: "Choose an existing folder." });
      return { computerId: chosen.computerId, path };
    } catch (cause) {
      if (cause instanceof OpensteerError) throw cause;
      throw new OpensteerError({
        cause,
        code: "bad_request",
        message:
          "The chosen folder is missing or unavailable on the hosting computer. Choose another folder.",
      });
    }
  }
}
