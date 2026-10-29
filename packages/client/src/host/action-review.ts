import { HostClientRequestError, type HostClient, type HostSnapshot } from "./client.js";
import { assignmentPresentation } from "./assignment-presentation.js";
import { hostSnapshotStore } from "./host-snapshot-store.js";
import { heldThread, taskCanBeDone } from "./task-list.js";
import { threadStopTarget } from "./thread-activity.js";

export type ReviewedAction =
  | { readonly kind: "stop-run"; readonly threadId: string }
  | { readonly kind: "stop-assignment"; readonly assignmentId: string }
  | { readonly kind: "task-done"; readonly threadId: string; readonly done: boolean }
  | { readonly kind: "close-view"; readonly viewId: string; readonly generation: number }
  | { readonly kind: "close-tab"; readonly sessionId: string; readonly tabId: string };

export interface ActionReview {
  readonly action: ReviewedAction;
  readonly current: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly cancel: () => void;
  /** Single use, including a retained callback after dismissal or a state change. */
  readonly confirm: () => Promise<boolean>;
}

/** A review authorizes exactly the consequence shown, never whatever action replaces it. */
export function reviewHostAction(
  client: HostClient,
  action: ReviewedAction,
  perform: () => Promise<unknown> = () => performAction(client, action),
): ActionReview | null {
  const store = hostSnapshotStore(client);
  const expected = actionState(store.getSnapshot(), action);
  if (expected === null) return null;
  let active = true;
  const current = () => {
    if (active && actionState(store.getSnapshot(), action) !== expected) active = false;
    return active;
  };
  return {
    action,
    current,
    cancel: () => {
      active = false;
    },
    subscribe: (listener) =>
      store.subscribe(() => {
        if (!current()) listener();
      }),
    confirm: async () => {
      if (!current()) return false;
      active = false;
      try {
        await perform();
        return true;
      } catch (error) {
        // An obsolete action needs no error panel. Current failures still explain themselves.
        if (actionState(store.getSnapshot(), action) !== expected) return false;
        if (
          error instanceof HostClientRequestError &&
          (error.code === "conflict" || error.code === "not_found")
        ) {
          await client.refresh().catch(() => undefined);
          if (actionState(store.getSnapshot(), action) !== expected) return false;
        }
        throw error;
      }
    },
  };
}

function actionState(snapshot: HostSnapshot, action: ReviewedAction): string | null {
  if (snapshot.connection !== "connected" || snapshot.session !== "authenticated" || !snapshot.user)
    return null;
  const viewer = snapshot.user.id;
  const stopTarget = (threadId: string) => {
    const thread = snapshot.threads.find((item) => item.id === threadId);
    return thread ? (threadStopTarget({ thread, runQueue: snapshot.runQueue })?.id ?? null) : null;
  };
  switch (action.kind) {
    case "stop-run": {
      const runId = stopTarget(action.threadId);
      return runId ? JSON.stringify([viewer, action, runId]) : null;
    }
    case "stop-assignment": {
      const assignment = snapshot.assignments[action.assignmentId];
      if (!assignment) return null;
      const presentation = assignmentPresentation(assignment, snapshot);
      return presentation.open && presentation.stopBlocked === null
        ? JSON.stringify([
            viewer,
            action,
            assignment.workerThread.id,
            assignment.currentRunId,
            assignment.currentRunStatus !== null &&
              ["completed", "failed", "interrupted"].includes(assignment.currentRunStatus),
            stopTarget(assignment.workerThread.id),
          ])
        : null;
    }
    case "task-done": {
      const thread = heldThread(snapshot, action.threadId);
      return thread !== null &&
        taskCanBeDone(snapshot, thread) &&
        (thread.doneAt !== null) !== action.done
        ? JSON.stringify([
            viewer,
            action,
            thread.doneAt,
            thread.status,
            thread.inputQueuePaused,
            thread.pendingRequests,
            stopTarget(action.threadId),
            Object.values(snapshot.assignments)
              .filter(
                (item) =>
                  item.parentThreadId === action.threadId ||
                  item.workerThread.id === action.threadId,
              )
              .map((item) => [item.id, item.status, item.currentRunId])
              .sort(),
          ])
        : null;
    }
    case "close-view": {
      const view = snapshot.machines
        .flatMap((machine) => machine.computerUse?.ownerViews ?? [])
        .find((view) => view.viewId === action.viewId);
      return view && view.generation === action.generation && view.state !== "closed"
        ? JSON.stringify([viewer, action])
        : null;
    }
    case "close-tab": {
      const session = snapshot.browserSessions.find((item) => item.id === action.sessionId);
      if (session?.state !== "ready") return null;
      const catalog = session.tabCatalog;
      if (!catalog?.tabs.some((tab) => tab.id === action.tabId)) return null;
      // The person reviewed this tab, its holders and whether it is the last
      // one; other tabs opening or closing change none of that. Confirming
      // sends the inventory current then.
      return JSON.stringify([
        viewer,
        action,
        session.profileId,
        [...session.attachedRunIds].sort(),
        catalog.generation,
        catalog.tabs.length === 1,
      ]);
    }
  }
}

async function performAction(client: HostClient, action: ReviewedAction): Promise<unknown> {
  switch (action.kind) {
    case "stop-run":
      return client.stopRun(action.threadId);
    case "stop-assignment":
      return client.cancelAssignment(action.assignmentId);
    case "task-done":
      return client.setTaskDone(action.threadId, action.done);
    case "close-view":
      return client.closeComputerView(action.viewId, action.generation);
    case "close-tab": {
      const catalog = client
        .getSnapshot()
        .browserSessions.find((item) => item.id === action.sessionId)?.tabCatalog;
      if (catalog)
        return client.closeBrowserTab(action.sessionId, action.tabId, {
          generation: catalog.generation,
          revision: catalog.revision,
          inventoryRevision: catalog.inventoryRevision ?? catalog.revision,
        });
      return undefined;
    }
  }
}
