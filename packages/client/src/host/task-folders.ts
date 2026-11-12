import type { TaskFolder } from "@opensteer/core";
import type { HostSnapshot, ThreadSummary } from "./client.js";
import { mergeTaskEntries } from "./task-entries.js";
export function taskFolderKey(folder: TaskFolder): string {
  return JSON.stringify([folder.computerId, folder.path]);
}
export interface TaskFolderGroup {
  readonly folder: TaskFolder;
  readonly agentHome: boolean;
  readonly tasks: readonly ThreadSummary[];
}
export function taskFolderGroups(
  snapshot: Pick<HostSnapshot, "personalSettings" | "tasks" | "activeTasks">,
): TaskFolderGroup[] {
  const home = snapshot.personalSettings?.agentHome;
  const groups = new Map<string, TaskFolderGroup>();
  if (home) groups.set(taskFolderKey(home), { folder: home, agentHome: true, tasks: [] });
  for (const { thread } of mergeTaskEntries(snapshot.tasks?.entries ?? [], snapshot.activeTasks)) {
    if (!thread.listed || thread.purpose !== "task") continue;
    const key = taskFolderKey(thread.folder),
      group = groups.get(key);
    groups.set(key, {
      folder: thread.folder,
      agentHome: group?.agentHome ?? false,
      tasks: [...(group?.tasks ?? []), thread],
    });
  }
  return [...groups.values()].sort((a, b) => Number(b.agentHome) - Number(a.agentHome));
}
export function newTaskDefaults(
  snapshot: Pick<HostSnapshot, "personalSettings" | "environments" | "can">,
) {
  return {
    folder: snapshot.personalSettings?.agentHome ?? null,
    canCreate: snapshot.can?.createTasks === true,
    environments: snapshot.environments.filter((environment) => environment.can.executeTasks),
  };
}
