import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";

type Frame = Extract<
  ScopedHostMessage,
  { type: "host.snapshot" | "host.changes" | "host.synchronized" }
>;
type ShellSnapshot = Extract<
  Extract<Frame, { type: "host.snapshot" }>["snapshot"],
  { tasks: unknown }
>;
type Task = ShellSnapshot["tasks"][number];
type TaskChange = Task | { readonly id: string; readonly removed: true };
type Visit = ShellSnapshot["visits"][number];
type Attention = ShellSnapshot["attention"][number];

/**
 * The shell is the latest snapshot's rows plus every upsert since. Lists are sorted locally from
 * fields the rows carry; nothing here asks the Host to resend the shell.
 */
interface ShellState {
  readonly history: number;
  readonly generation: number;
  readonly through: string | null;
  readonly teamReplyRevision: string | null;
  readonly synchronized: boolean;
  readonly snapshot: ShellSnapshot | null;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly taskChanges: readonly TaskChange[];
  readonly visits: ReadonlyMap<string, Visit>;
  readonly attention: ReadonlyMap<string, Attention>;
}

const emptyShell: ShellState = {
  history: 0,
  generation: 0,
  through: null,
  teamReplyRevision: null,
  synchronized: false,
  snapshot: null,
  tasks: new Map(),
  taskChanges: [],
  visits: new Map(),
  attention: new Map(),
};

function newer(prior: { readonly revision: string } | undefined, revision: string) {
  return !prior || BigInt(prior.revision) < BigInt(revision);
}

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
    this.#replace({
      ...(retain ? this.#state : emptyShell),
      taskChanges: emptyShell.taskChanges,
      generation,
      history: this.#state.history,
      synchronized: false,
    });
  }

  /** Starts a new history for the same viewer, as when the Host's sequence moved back. */
  resetHistory() {
    this.#replace({ ...this.#state, history: this.#state.history + 1, through: null });
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
      case "host.synchronized": {
        if (old.through !== frame.throughSequence) return false;
        const snapshot =
          old.snapshot && frame.shellProgress
            ? { ...old.snapshot, ...frame.shellProgress }
            : old.snapshot;
        if (!old.synchronized || snapshot !== old.snapshot)
          this.#replace({ ...old, snapshot, synchronized: true });
        return true;
      }
      case "host.snapshot": {
        // After `host.synchronized` a snapshot is the Host's inline repair of this scope.
        if (!("tasks" in frame.snapshot)) return false;
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
        this.#replace({
          ...old,
          through: frame.throughSequence,
          teamReplyRevision: frame.throughSequence,
          snapshot,
          tasks,
          taskChanges: emptyShell.taskChanges,
          visits: new Map(snapshot.visits.map((visit) => [visit.threadId, visit])),
          attention: new Map(snapshot.attention.map((item) => [item.id, item])),
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
        const taskChanges: TaskChange[] = [];
        let visits: Map<string, Visit> | undefined;
        let attention: Map<string, Attention> | undefined;
        let teamReplyRevision = old.teamReplyRevision;
        for (const change of frame.changes) {
          const id = change.entityId;
          switch (change.entityKind) {
            case "task": {
              const prior = (tasks ?? old.tasks).get(id);
              if (change.operation === "remove") {
                taskChanges.push({ id, removed: true });
                if (prior) (tasks ??= new Map(old.tasks)).delete(id);
              } else if (newer(prior, change.value.revision)) {
                taskChanges.push(change.value);
                (tasks ??= new Map(old.tasks)).set(id, change.value);
              }
              break;
            }
            case "visit": {
              const prior = (visits ?? old.visits).get(id);
              if (change.operation === "remove") {
                if (prior) (visits ??= new Map(old.visits)).delete(id);
              } else if (newer(prior, change.value.revision))
                (visits ??= new Map(old.visits)).set(id, change.value);
              break;
            }
            case "attention": {
              const prior = (attention ?? old.attention).get(id);
              if (change.operation === "remove") {
                if (prior) (attention ??= new Map(old.attention)).delete(id);
              } else if (newer(prior, change.value.revision))
                (attention ??= new Map(old.attention)).set(id, change.value);
              break;
            }
            case "signal":
              if (id === "team-replies") teamReplyRevision = frame.throughSequence;
              break;
          }
        }
        this.#replace({
          ...old,
          through: frame.throughSequence,
          teamReplyRevision,
          snapshot:
            old.snapshot && frame.shellProgress
              ? { ...old.snapshot, ...frame.shellProgress }
              : old.snapshot,
          tasks: tasks ?? old.tasks,
          taskChanges: taskChanges.length ? taskChanges : emptyShell.taskChanges,
          visits: visits ?? old.visits,
          attention: attention ?? old.attention,
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
      taskChanges: [{ id: threadId, removed: true }],
    });
  }

  checkpoint(state = this.#state): ShellSnapshot | undefined {
    const { snapshot, tasks, visits, attention } = state;
    if (!snapshot) return;
    const rows = [...tasks.values()].slice(-256);
    const listed = new Set(rows.map(({ id }) => id));
    return {
      ...snapshot,
      tasks: rows,
      activeTaskIds: snapshot.activeTaskIds.filter((id) => listed.has(id)),
      recentTaskIds: snapshot.recentTaskIds.filter((id) => listed.has(id)),
      visits: [...visits.values()].slice(-256),
      attention: [...attention.values()].slice(0, 200),
    };
  }

  #replace(state: ShellState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
