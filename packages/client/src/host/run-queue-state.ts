import { compareSequence, type AgentEvent, type Run, type Sequence } from "@opensteer/core";
import type { RunQueueEntry } from "./client.js";

/** Ended Runs remembered, oldest forgotten first, so a late read cannot restore one. */
const endedRunMemory = 4_096;

type ActiveRunStatus = RunQueueEntry["status"];

interface RunRecord {
  /** The Run as the queue shows it, once a source has named its ordinal. */
  readonly entry: RunQueueEntry | null;
  /** Null for a Run only a command answer has named: it carries no sequence. */
  readonly sequence: Sequence | null;
  readonly status: ActiveRunStatus;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** One absolute read of some Threads' non-terminal Runs. */
export interface RunQueueRead {
  readonly runQueue: readonly RunQueueEntry[];
  /** Each Thread the read covers, with the Workspace sequence it was read at. */
  readonly threads: ReadonlyMap<string, Sequence>;
  /**
   * A Workspace snapshot replaces the stream it interrupted, so a Run of that
   * Workspace on a Thread it does not cover is no longer known either way.
   */
  readonly wholeWorkspace: boolean;
  readonly workspaceId: string;
}

/**
 * The Run queue, reconciled the way Thread state is: every source is an
 * absolute word about a Run at a Workspace sequence, and the newer word wins.
 * An event says what became of the Run it names; a snapshot or Thread page
 * says which Runs of the Threads it covers were not terminal when it was read.
 * An ended Run stays ended, so a read that was in flight when it ended can
 * never show it executing again.
 */
export class RunQueueProjection {
  readonly #active = new Map<string, RunRecord>();
  readonly #ended = new Set<string>();

  /** Whether the event changed what the queue shows. */
  record(event: AgentEvent): boolean {
    const { runId, sequence, threadId, workspaceId } = event;
    switch (event.type) {
      case "run.queued": {
        const entry = toRunQueueEntry(event.data.run);
        if (!entry) return this.#end(event.data.run.id);
        return this.#accept(entry.id, { entry, sequence, status: entry.status, workspaceId });
      }
      case "run.started":
        return (
          runId !== null &&
          this.#accept(runId, { sequence, status: "running", threadId, workspaceId })
        );
      case "run.status":
        if (runId === null) return false;
        return isActiveRunStatus(event.data.status)
          ? this.#accept(runId, { sequence, status: event.data.status, threadId, workspaceId })
          : this.#end(runId);
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        return runId !== null && this.#end(runId);
      case "request.opened":
        return (
          runId !== null &&
          event.data.request.mode === "live" &&
          this.#accept(runId, { sequence, status: "waiting", threadId, workspaceId })
        );
      default:
        return false;
    }
  }

  /** Whether the read changed what the queue shows. */
  reconcile(read: RunQueueRead): boolean {
    let changed = false;
    const listed = new Set<string>();
    for (const entry of read.runQueue) {
      const sequence = read.threads.get(entry.threadId);
      if (sequence === undefined) continue;
      listed.add(entry.id);
      changed =
        this.#accept(entry.id, {
          entry,
          sequence,
          status: entry.status,
          workspaceId: read.workspaceId,
        }) || changed;
    }
    for (const [runId, record] of this.#active) {
      if (record.workspaceId !== read.workspaceId || listed.has(runId)) continue;
      const asOf = read.threads.get(record.threadId);
      if (asOf === undefined && !read.wholeWorkspace) continue;
      // A Run the read leaves out had ended by then, unless something newer
      // than the read said otherwise. One only an answer named may postdate
      // the read, and a Thread a snapshot does not cover is unknown, so those
      // are forgotten rather than ended: their own events bring them back.
      if (asOf === undefined || record.sequence === null) {
        this.#active.delete(runId);
        changed = record.entry !== null || changed;
      } else if (compareSequence(record.sequence, asOf) < 0) {
        changed = this.#end(runId) || changed;
      }
    }
    return changed;
  }

  /**
   * A Run a command answer names. The answer carries no sequence, so it only
   * introduces a Run nothing else has spoken about.
   */
  acknowledge(entry: RunQueueEntry, workspaceId: string): boolean {
    if (this.#ended.has(entry.id) || this.#active.has(entry.id)) return false;
    this.#active.set(entry.id, {
      entry,
      sequence: null,
      status: entry.status,
      threadId: entry.threadId,
      workspaceId,
    });
    return true;
  }

  entries(): RunQueueEntry[] {
    return [...this.#active.values()]
      .flatMap(({ entry }) => (entry ? [entry] : []))
      .sort(
        (left, right) =>
          left.threadId.localeCompare(right.threadId) || left.runOrdinal - right.runOrdinal,
      );
  }

  clear(): void {
    this.#active.clear();
    this.#ended.clear();
  }

  #accept(
    runId: string,
    word: {
      readonly entry?: RunQueueEntry;
      readonly sequence: Sequence;
      readonly status: ActiveRunStatus;
      readonly threadId?: string;
      readonly workspaceId: string;
    },
  ): boolean {
    const threadId = word.entry?.threadId ?? word.threadId;
    if (this.#ended.has(runId) || threadId === undefined) return false;
    const previous = this.#active.get(runId);
    const shape = word.entry ?? previous?.entry ?? null;
    const newer =
      previous === undefined ||
      previous.sequence === null ||
      compareSequence(word.sequence, previous.sequence) > 0;
    // An older source may still be the only one to name the Run's ordinal; it
    // fills that in without taking back a newer status.
    if (!newer && (previous.entry !== null || shape === null)) return false;
    const sequence = newer ? word.sequence : previous.sequence;
    const status = newer ? word.status : previous.status;
    const entry = shape === null || shape.status === status ? shape : { ...shape, status };
    this.#active.set(runId, { entry, sequence, status, threadId, workspaceId: word.workspaceId });
    return entry !== null && entry !== previous?.entry;
  }

  #end(runId: string): boolean {
    const previous = this.#active.get(runId);
    this.#active.delete(runId);
    this.#ended.delete(runId);
    this.#ended.add(runId);
    if (this.#ended.size > endedRunMemory) {
      const oldest = this.#ended.values().next();
      if (!oldest.done) this.#ended.delete(oldest.value);
    }
    return previous !== undefined && previous.entry !== null;
  }
}

export function isActiveRunStatus(status: Run["status"]): status is ActiveRunStatus {
  return (
    status === "queued" || status === "starting" || status === "running" || status === "waiting"
  );
}

export function toRunQueueEntry(
  run: Pick<Run, "createdAt" | "id" | "runOrdinal" | "status" | "threadId">,
): RunQueueEntry | null {
  if (!isActiveRunStatus(run.status)) return null;
  return {
    createdAt: run.createdAt,
    id: run.id,
    status: run.status,
    threadId: run.threadId,
    runOrdinal: run.runOrdinal,
  };
}
