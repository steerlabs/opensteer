import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";

type Frame = Extract<
  ScopedHostMessage,
  { type: "host.snapshot" | "host.changes" | "host.snapshot-required" | "host.synchronized" }
>;
type ShellSnapshot = Extract<
  Extract<Frame, { type: "host.snapshot" }>["snapshot"],
  { tasks: unknown }
>;
type Task = ShellSnapshot["tasks"][number];
type Visit = ShellSnapshot["visits"][number];
type Attention = ShellSnapshot["attention"][number];

interface ShellState {
  readonly generation: number;
  readonly through: string | null;
  readonly synchronized: boolean;
  readonly snapshot: ShellSnapshot | null;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly visits: ReadonlyMap<string, Visit>;
  readonly attention: ReadonlyMap<string, Attention>;
  readonly taskIds: readonly string[];
  readonly invalidated: ReadonlySet<string>;
}

const emptyShell: ShellState = {
  generation: 0,
  through: null,
  synchronized: false,
  snapshot: null,
  tasks: new Map(),
  visits: new Map(),
  attention: new Map(),
  taskIds: [],
  invalidated: new Set(),
};

export class PersonalShellStore {
  readonly #listeners = new Set<() => void>();
  #state = emptyShell;

  getSnapshot = () => this.#state;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  begin(generation: number, retain: boolean) {
    if (generation <= this.#state.generation) return;
    this.#replace({ ...(retain ? this.#state : emptyShell), generation, synchronized: false });
  }

  apply(frame: Frame) {
    const old = this.#state;
    if (
      frame.subscriptionId !== "shell" ||
      frame.scope.kind !== "shell" ||
      frame.generation !== old.generation
    )
      return false;
    switch (frame.type) {
      case "host.snapshot-required":
        this.#replace({ ...old, through: null, synchronized: false });
        return true;
      case "host.synchronized":
        if (old.through !== frame.throughSequence) return false;
        const snapshot =
          old.snapshot && frame.shellProgress
            ? { ...old.snapshot, ...frame.shellProgress }
            : old.snapshot;
        if (!old.synchronized || snapshot !== old.snapshot)
          this.#replace({ ...old, snapshot, synchronized: true });
        return true;
      case "host.snapshot": {
        if (!("tasks" in frame.snapshot) || old.synchronized) return false;
        const snapshot = frame.snapshot;
        const sameViewer =
          old.snapshot?.epoch === snapshot.epoch &&
          old.snapshot.viewerId === snapshot.viewerId &&
          old.snapshot.deploymentId === snapshot.deploymentId &&
          old.snapshot.session?.sessionId === snapshot.session?.sessionId;
        const tasks = new Map(
          snapshot.tasks.map((task) => {
            const prior = sameViewer ? old.tasks.get(task.id) : undefined;
            return [task.id, prior?.revision === task.revision ? prior : task];
          }),
        );
        const taskIds = snapshot.tasks.map(({ id }) => id);
        this.#replace({
          ...old,
          through: frame.throughSequence,
          snapshot,
          tasks,
          synchronized: false,
          visits: new Map(snapshot.visits.map((visit) => [visit.threadId, visit])),
          attention: new Map(snapshot.attention.map((item) => [item.id, item])),
          taskIds:
            taskIds.length === old.taskIds.length &&
            taskIds.every((id, index) => id === old.taskIds[index])
              ? old.taskIds
              : taskIds,
          invalidated: new Set(),
        });
        return true;
      }
      case "host.changes": {
        if (
          frame.fromSequence !== old.through ||
          BigInt(frame.throughSequence) <= BigInt(frame.fromSequence)
        )
          return false;
        let tasks: Map<string, Task> | undefined;
        let visits: Map<string, Visit> | undefined;
        let attention: Map<string, Attention> | undefined;
        let invalidated: Set<string> | undefined;
        let ids = old.taskIds;
        function invalidate(id: string) {
          (invalidated ??= new Set(old.invalidated)).add(id);
        }
        for (const change of frame.changes) {
          if (change.operation === "invalidate") {
            invalidate(change.entityId);
            continue;
          }
          const id = change.entityId;
          switch (change.entityKind) {
            case "task": {
              const prior = (tasks ?? old.tasks).get(id);
              if (change.operation === "remove") {
                if (!prior) break;
                (tasks ??= new Map(old.tasks)).delete(id);
                ids = ids.filter((taskId) => taskId !== id);
                invalidate("tasks");
              } else if (!prior || BigInt(prior.revision) < BigInt(change.value.revision)) {
                if (prior) (tasks ??= new Map(old.tasks)).set(id, change.value);
                if (
                  !prior ||
                  prior.askedAt !== change.value.askedAt ||
                  prior.doneAt !== change.value.doneAt ||
                  prior.status !== change.value.status
                )
                  invalidate("tasks");
              }
              break;
            }
            case "visit": {
              const prior = (visits ?? old.visits).get(id);
              if (change.operation === "remove") {
                if (prior) (visits ??= new Map(old.visits)).delete(id);
              } else if (!prior || BigInt(prior.revision) < BigInt(change.value.revision)) {
                if ((tasks ?? old.tasks).has(id))
                  (visits ??= new Map(old.visits)).set(id, change.value);
              }
              break;
            }
            case "attention": {
              const prior = (attention ?? old.attention).get(id);
              if (change.operation === "remove") {
                if (prior) (attention ??= new Map(old.attention)).delete(id);
                invalidate("needs-you");
              } else if (!prior || BigInt(prior.revision) < BigInt(change.value.revision)) {
                if (prior) (attention ??= new Map(old.attention)).set(id, change.value);
                else invalidate("needs-you");
              }
            }
          }
        }
        this.#replace({
          ...old,
          through: frame.throughSequence,
          taskIds: ids,
          snapshot:
            old.snapshot && frame.shellProgress
              ? { ...old.snapshot, ...frame.shellProgress }
              : old.snapshot,
          tasks: tasks ?? old.tasks,
          visits: visits ?? old.visits,
          attention: attention ?? old.attention,
          invalidated: invalidated ?? old.invalidated,
        });
        return true;
      }
    }
  }

  removeTask(threadId: string) {
    const old = this.#state;
    const attention = new Map([...old.attention].filter(([, row]) => row.threadId !== threadId));
    if (!old.tasks.has(threadId) && attention.size === old.attention.size) return;
    const tasks = new Map(old.tasks);
    const visits = new Map(old.visits);
    tasks.delete(threadId);
    visits.delete(threadId);
    this.#replace({
      ...old,
      tasks,
      visits,
      attention,
      taskIds: old.taskIds.filter((id) => id !== threadId),
      invalidated: new Set([...old.invalidated, "tasks"]),
    });
  }

  checkpoint(state = this.#state): ShellSnapshot | undefined {
    const { snapshot, tasks, taskIds, visits, attention, invalidated } = state;
    if (!snapshot || invalidated.size) return;
    return {
      ...snapshot,
      tasks: taskIds.flatMap((id) => tasks.get(id) ?? []),
      visits: [...visits.values()],
      attention: [...attention.values()],
    };
  }

  #replace(state: ShellState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
