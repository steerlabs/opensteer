import { RowMotion } from "./row-motion.js";
import { useMemo, useRef, useState } from "react";
import { filterThreads, taskAttention, taskTime } from "@opensteer/client/host";
import { useMinuteClock } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { TaskGroup, TaskRowLink } from "../task-rows.js";
import { AreaHeader } from "./conversation-header.js";
import { useTaskDirectory } from "./task-directory.js";

/**
 * Every task, in the conversation area: Working, Ready and Done, with
 * search and the older ones a press away. The place in the middle stays.
 */
export function TasksPage() {
  const { hostClient, reportActionError, setTaskDone, snapshot } = useShell();
  const directory = useTaskDirectory(hostClient);
  const now = useMinuteClock();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const { list } = directory;
  const matches = useMemo(() => {
    if (!query.trim()) return null;
    return new Set(
      filterThreads(
        (snapshot.tasks?.entries ?? []).map((entry) => entry.thread),
        snapshot.workspaces,
        query,
        taskAttention(snapshot),
      ).map((thread) => thread.id),
    );
  }, [query, snapshot]);
  const groups = [
    { done: false, id: "tasks-working", rows: list.working, title: "Working" },
    { done: false, id: "tasks-ready", rows: list.ready, title: "Ready" },
    { done: true, id: "tasks-done", rows: list.done, title: "Done" },
  ]
    .map((group) => ({
      ...group,
      rows: matches ? group.rows.filter((row) => matches.has(row.threadId)) : group.rows,
    }))
    .filter((group) => group.rows.length > 0);
  const motionList = useRef<HTMLDivElement | null>(null);
  return (
    <RowMotion
      list={motionList}
      signature={groups
        .map((group) => group.id + group.rows.map((row) => row.threadId).join(","))
        .join(";")}
      lifted={false}
      snap={false}
      nested
    >
      <div className="thread tasks-page" ref={motionList}>
        <AreaHeader hostClient={hostClient} title="Tasks" />
        <div className="tasks-page__body">
          <input
            aria-label="Search tasks"
            className="text-input tasks-page__search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks…"
            type="search"
            value={query}
          />
          {groups.length === 0 ? (
            <p className="tasks-page__empty">
              {matches ? `No tasks match “${query.trim()}”.` : "No tasks yet."}
            </p>
          ) : (
            groups.map((group) => (
              <TaskGroup
                count={group.done ? null : group.rows.length}
                id={group.id}
                key={group.id}
                title={group.title}
              >
                {group.rows.map((row) => (
                  <li key={row.threadId} data-motion-key={row.threadId}>
                    <TaskRowLink
                      done={group.done}
                      onSetDone={setTaskDone}
                      row={row}
                      time={taskTime(row, now)}
                    />
                  </li>
                ))}
              </TaskGroup>
            ))
          )}
          {list.hasMore ? (
            <button
              className="btn btn--ghost btn--small tasks-page__more"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void hostClient
                  .loadEarlierTasks()
                  .catch(reportActionError)
                  .finally(() => setLoading(false));
              }}
              type="button"
            >
              {loading ? "Loading…" : "Show more"}
            </button>
          ) : null}
        </div>
      </div>
    </RowMotion>
  );
}
