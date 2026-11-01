import type { HostSnapshot, ThreadSummary, WorkspaceSummary } from "./client.js";

/**
 * Main: the Workspace Chat and its tasks live in, named by the Host or by its
 * own kind. No other Workspace stands in for it — a specialist turned into
 * Chat would put a person's conversation in somebody else's files.
 */
export function mainWorkspace(
  snapshot: Pick<HostSnapshot, "homeWorkspaceId" | "workspaces">,
): WorkspaceSummary | null {
  return (
    snapshot.workspaces.find((workspace) => workspace.id === snapshot.homeWorkspaceId) ??
    snapshot.workspaces.find((workspace) => workspace.kind === "main") ??
    null
  );
}

/** App only owns session admission and the first-Workspace readiness gate. */
export function sameAppGateSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    previous.session === next.session &&
    previous.identityConfig === next.identityConfig &&
    (previous.workspaces.length === 0) === (next.workspaces.length === 0)
  );
}

/**
 * Snapshot equality for chrome and non-Thread routes.
 *
 * Agent streaming intentionally updates Thread and Workspace activity times on
 * every event. Those timestamps are useful to the active Thread but should not
 * repaint navigation, settings, or dialogs for every token. All durable fields
 * those surfaces render remain part of this comparison.
 */
export function sameStableHostSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    previous === next ||
    (previous.browserProfileDeletions === next.browserProfileDeletions &&
      previous.connection === next.connection &&
      previous.network === next.network &&
      previous.deploymentShape === next.deploymentShape &&
      previous.environments === next.environments &&
      // What the person chose last drives every composer's opening choice,
      // Recent, and the options a model comes back with.
      previous.executionPreferences === next.executionPreferences &&
      previous.harnesses === next.harnesses &&
      previous.homeWorkspaceId === next.homeWorkspaceId &&
      previous.identityConfig === next.identityConfig &&
      previous.machines === next.machines &&
      previous.machineRevision === next.machineRevision &&
      previous.ownerName === next.ownerName &&
      previous.runQueue === next.runQueue &&
      previous.session === next.session &&
      previous.sessionSurface === next.sessionSurface &&
      previous.triggerRevision === next.triggerRevision &&
      previous.user === next.user &&
      previous.workspaceSharingAvailable === next.workspaceSharingAvailable &&
      previous.threadRenameAvailable === next.threadRenameAvailable &&
      previous.taskMarksAvailable === next.taskMarksAvailable &&
      previous.sharedTaskDoneAvailable === next.sharedTaskDoneAvailable &&
      previous.harnessUpdateAvailable === next.harnessUpdateAvailable &&
      previous.iphoneAppsAvailable === next.iphoneAppsAvailable &&
      previous.workspaceWindow === next.workspaceWindow &&
      sameThreadsIgnoringActivityTime(previous.threads, next.threads) &&
      sameWorkspacesIgnoringActivityTime(previous.workspaces, next.workspaces))
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
      left.runnerLabel !== right.runnerLabel ||
      left.status !== right.status ||
      left.title !== right.title ||
      left.icon !== right.icon ||
      left.color !== right.color ||
      left.unread !== right.unread ||
      left.workspaceId !== right.workspaceId
    ) {
      return false;
    }
  }
  return true;
}

function sameWorkspacesIgnoringActivityTime(
  previous: readonly WorkspaceSummary[],
  next: readonly WorkspaceSummary[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) return false;
    if (left === right) continue;
    if (
      left.description !== right.description ||
      left.fileCount !== right.fileCount ||
      left.harnessLabel !== right.harnessLabel ||
      left.icon !== right.icon ||
      left.id !== right.id ||
      left.kind !== right.kind ||
      left.machineName !== right.machineName ||
      left.name !== right.name ||
      left.runnerLabel !== right.runnerLabel ||
      left.status !== right.status ||
      left.storageIssue !== right.storageIssue ||
      left.color !== right.color
    ) {
      return false;
    }
  }
  return true;
}

/** The held Thread takes precedence over copies in the reader's task directory. */
export function threadInDirectory(
  threadId: string,
  snapshot: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks" | "workspaceTasks">,
): ThreadSummary | null {
  return (
    snapshot.threads.find(({ id }) => id === threadId) ??
    snapshot.tasks?.entries.find(({ thread }) => thread.id === threadId)?.thread ??
    snapshot.activeTasks.find(({ thread }) => thread.id === threadId)?.thread ??
    Object.values(snapshot.workspaceTasks)
      .flatMap(({ entries }) => entries)
      .find(({ thread }) => thread.id === threadId)?.thread ??
    null
  );
}
