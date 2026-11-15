import {
  taskMark,
  threadInDirectory,
  type LegacyHostSnapshot,
  type PlaceAgent,
  type PlaceAgents,
} from "@opensteer/client/host";
import type { Tab } from "@opensteer/core";

/**
 * The agents using a tab that this reader can open, working ones first. A
 * holder whose task this reader's directory does not hold is not named.
 * (Replace with the shared client's selector once it lands.)
 */
export function tabAgents(
  usedBy: Tab["usedBy"],
  snapshot: Pick<LegacyHostSnapshot, "activeTasks" | "tasks" | "threads">,
): PlaceAgents {
  const agents: PlaceAgent[] = [];
  for (const { taskId } of usedBy) {
    const thread = threadInDirectory(taskId, snapshot);
    if (thread === null) continue;
    agents.push({
      acting: thread.status === "running",
      lastActiveAt: thread.updatedAt,
      mark: taskMark(thread),
      threadId: taskId,
      title: thread.title.trim() || "Task",
    });
  }
  agents.sort(
    (a, b) =>
      Number(b.acting) - Number(a.acting) ||
      b.lastActiveAt.localeCompare(a.lastActiveAt) ||
      a.threadId.localeCompare(b.threadId),
  );
  return { agents, unnamedActing: false };
}
