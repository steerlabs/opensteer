import type { HostSnapshot, ThreadSummary } from "./client.js";

export function sameAppGateSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return previous.session === next.session && previous.identityConfig === next.identityConfig;
}

export function sameStableHostSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    previous === next ||
    (previous.browserProfileDeletions === next.browserProfileDeletions &&
      previous.browserProfiles === next.browserProfiles &&
      previous.browserProfileHomes === next.browserProfileHomes &&
      previous.connection === next.connection &&
      previous.network === next.network &&
      previous.deploymentShape === next.deploymentShape &&
      previous.environments === next.environments &&
      // What the person chose last drives every composer's opening choice,
      // Recent, and the options a model comes back with.
      previous.executionPreferences === next.executionPreferences &&
      previous.harnesses === next.harnesses &&
      previous.identityConfig === next.identityConfig &&
      previous.machines === next.machines &&
      previous.machineRevision === next.machineRevision &&
      previous.ownerName === next.ownerName &&
      previous.runQueue === next.runQueue &&
      previous.session === next.session &&
      previous.sessionSurface === next.sessionSurface &&
      previous.personalSettings === next.personalSettings &&
      previous.can === next.can &&
      previous.needsYou === next.needsYou &&
      previous.triggerRevision === next.triggerRevision &&
      previous.user === next.user &&
      previous.threadRenameAvailable === next.threadRenameAvailable &&
      previous.taskMarksAvailable === next.taskMarksAvailable &&
      previous.harnessUpdateAvailable === next.harnessUpdateAvailable &&
      previous.iphoneAppsAvailable === next.iphoneAppsAvailable &&
      previous.devicesAvailable === next.devicesAvailable &&
      sameThreadsIgnoringActivityTime(previous.threads, next.threads))
  );
}

function sameThreadsIgnoringActivityTime(
  previous: readonly ThreadSummary[],
  next: readonly ThreadSummary[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) return false;
    if (left === right) continue;
    if (
      left.continuationIdentity !== right.continuationIdentity ||
      left.environmentId !== right.environmentId ||
      left.harnessInstanceId !== right.harnessInstanceId ||
      left.harnessLabel !== right.harnessLabel ||
      left.id !== right.id ||
      left.modelLabel !== right.modelLabel ||
      left.modelSelection !== right.modelSelection ||
      left.parentThreadId !== right.parentThreadId ||
      left.purpose !== right.purpose ||
      left.listed !== right.listed ||
      left.doneAt !== right.doneAt ||
      left.teamOrigin?.teamId !== right.teamOrigin?.teamId ||
      left.teamOrigin?.channelId !== right.teamOrigin?.channelId ||
      left.teamOrigin?.threadRootId !== right.teamOrigin?.threadRootId ||
      left.runnerLabel !== right.runnerLabel ||
      left.status !== right.status ||
      left.title !== right.title ||
      left.icon !== right.icon ||
      left.color !== right.color ||
      left.unread !== right.unread
    ) {
      return false;
    }
  }
  return true;
}

/** The held Thread takes precedence over copies in the reader's task directory. */
export function threadInDirectory(
  threadId: string,
  snapshot: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks">,
): ThreadSummary | null {
  return (
    snapshot.threads.find(({ id }) => id === threadId) ??
    snapshot.tasks?.entries.find(({ thread }) => thread.id === threadId)?.thread ??
    snapshot.activeTasks.find(({ thread }) => thread.id === threadId)?.thread ??
    null
  );
}
