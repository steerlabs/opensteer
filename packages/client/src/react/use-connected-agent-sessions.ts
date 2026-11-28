import { readTaskActivity, taskActivityKey } from "../host/agent-work.js";
import { shownOperations } from "../host/approved-app-names.js";
import { useApprovedAppNames } from "./use-approved-app-names.js";
import type { ChatScreenHost } from "../host/chat-screen-host.js";
import type { HostSnapshot, ThreadSummary, WaitingRequestView } from "../host/client.js";
import { connectedAgentsNow } from "../host/connected-agents-now.js";
import { threadInDirectory } from "../host/host-snapshot-selectors.js";
import type { HostSnapshotSource } from "../host/host-snapshot-store.js";
import { useHostSelector } from "./use-host-snapshot.js";
import type { AgentOperationView } from "@opensteer/core";
import { useCallback, useEffect, useMemo, useState } from "react";

function selectTasks(snapshot: HostSnapshot, connectionId: string | undefined) {
  const ids = new Set<string>();
  for (const { thread } of snapshot.activeTasks)
    if (thread.externalWork?.status === "active") ids.add(thread.id);
  for (const thread of snapshot.threads)
    if (thread.externalWork?.status === "active" && thread.status !== "idle") ids.add(thread.id);
  for (const { request } of snapshot.waitingRequests)
    if (request.originatingAgentSessionId) ids.add(request.originatingThreadId);

  const tasks: ThreadSummary[] = [];
  for (const id of ids) {
    const task = threadInDirectory(id, snapshot);
    if (
      task?.externalWork?.status === "active" &&
      (connectionId === undefined || task.externalWork.connection.id === connectionId)
    )
      tasks.push(task);
  }
  return tasks;
}

function sameTasks(a: readonly ThreadSummary[], b: readonly ThreadSummary[]) {
  return (
    a.length === b.length &&
    a.every((task, index) => {
      const next = b[index]!;
      return (
        task.id === next.id &&
        task.externalWork === next.externalWork &&
        taskActivityKey(task) === taskActivityKey(next)
      );
    })
  );
}

function sameWaiting(a: readonly WaitingRequestView[], b: readonly WaitingRequestView[]) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** The directory alone has enough to name and count sessions and show their state. */
export function useActiveConnectedAgentSessions(
  hostClient: HostSnapshotSource,
  connectionId?: string,
) {
  const select = useCallback(
    (snapshot: HostSnapshot) => selectTasks(snapshot, connectionId),
    [connectionId],
  );
  const tasks = useHostSelector(hostClient, select, sameTasks);
  const selectWaiting = useCallback(
    (snapshot: HostSnapshot) =>
      snapshot.waitingRequests.filter(({ request }) =>
        tasks.some(
          ({ externalWork }) => externalWork?.sessionId === request.originatingAgentSessionId,
        ),
      ),
    [tasks],
  );
  const waitingRequests = useHostSelector(hostClient, selectWaiting, sameWaiting);
  const view = useMemo(
    () => connectedAgentsNow({ tasks, waitingRequests }),
    [tasks, waitingRequests],
  );
  return { tasks, waitingRequests, view };
}

/** Reuse the task's existing activity read when a surface also needs places and actions. */
export function useConnectedAgentWork(
  hostClient: HostSnapshotSource & {
    readonly rpc: Pick<
      ChatScreenHost["rpc"],
      "threads.activity" | "integration.computer.apps.approved"
    >;
  },
  connectionId?: string,
  readActivity = true,
) {
  const {
    tasks,
    waitingRequests,
    view: base,
  } = useActiveConnectedAgentSessions(hostClient, connectionId);
  const activeTasks = useMemo(() => {
    const ids = new Set(base.agents.map(({ threadId }) => threadId));
    return tasks.filter(({ id }) => ids.has(id));
  }, [base, tasks]);
  const [activityRead, setActivityRead] = useState(0);
  const refresh = useCallback(() => setActivityRead((revision) => revision + 1), []);
  const [read, setRead] = useState<{
    client: typeof hostClient;
    byTask: ReadonlyMap<string, readonly AgentOperationView[]>;
  }>();
  useEffect(() => {
    if (!readActivity || !activeTasks.length) return;
    const controller = new AbortController();
    void Promise.all(
      activeTasks.map(async ({ id }) => {
        const operations = await readTaskActivity(hostClient, id, controller.signal).catch(
          () => undefined,
        );
        return [id, operations] as const;
      }),
    ).then((pages) => {
      if (controller.signal.aborted) return;
      setRead((previous) => {
        const cached = previous?.client === hostClient ? previous.byTask : undefined;
        const byTask = new Map<string, readonly AgentOperationView[]>();
        for (const [id, operations] of pages) {
          const activity = operations ?? cached?.get(id);
          if (activity) byTask.set(id, activity);
        }
        return { client: hostClient, byTask };
      });
    });
    return () => controller.abort();
  }, [hostClient, activeTasks, activityRead, readActivity]);
  const activity = read?.client === hostClient ? read.byTask : undefined;
  const profiles = useHostSelector(hostClient, (snapshot) => {
    if (!activity) return null;
    const inventory = snapshot.browserProfiles;
    return snapshot.loadedResources.includes("browser-profile") ? inventory : null;
  });
  // What each agent is working in, as the person sees it: a Mac app by the name they approved.
  const names = useApprovedAppNames(
    hostClient,
    activity ? [...activity.values()].flat().map(({ target }) => target) : [],
  );
  const view = useMemo(
    () =>
      activity
        ? connectedAgentsNow({
            tasks,
            waitingRequests,
            operations: shownOperations([...activity.values()].flat(), names),
            profileIds: profiles ? new Set(profiles.map(({ id }) => id)) : undefined,
          })
        : base,
    [activity, base, names, profiles, tasks, waitingRequests],
  );
  return { view, tasks, activity, refresh };
}
