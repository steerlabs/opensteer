import type { AgentEventView } from "@opensteer/core";
import type { HostClient, ThreadSummary } from "./client.js";

export type ScheduleAnchorState = {
  [
    Key in
      | "status"
      | "doneAt"
      | "inputQueuePaused"
      | "environmentId"
      | "harnessInstanceId"
      | "modelSelection"
      | "accessMode"
  ]?: ThreadSummary[Key] | undefined;
};
const readers = new WeakMap<HostClient, Set<ScheduleAnchorInvalidation>>();
const fields = [
  "status",
  "doneAt",
  "inputQueuePaused",
  "environmentId",
  "harnessInstanceId",
  "modelSelection",
  "accessMode",
] as const;

/** Only retained schedule anchors need invalidation, including workers absent from the directory. */
export class ScheduleAnchorInvalidation {
  readonly anchors = new Map<string, ScheduleAnchorState>();
  revision = 0;
  retain(client: HostClient): () => void {
    let set = readers.get(client);
    if (!set) readers.set(client, (set = new Set()));
    set.add(this);
    return () => {
      set.delete(this);
      this.anchors.clear();
    };
  }
  record(threadId: string, patch: ScheduleAnchorState): void {
    const previous = this.anchors.get(threadId);
    if (!previous) return;
    if (
      fields.some(
        (field) =>
          patch[field] !== undefined &&
          JSON.stringify(patch[field]) !== JSON.stringify(previous[field]),
      )
    ) {
      this.anchors.set(threadId, { ...previous, ...patch });
      this.revision++;
    }
  }
}

export function invalidateScheduleAnchor(client: HostClient, event: AgentEventView): void {
  const patch =
    event.type === "thread.state-changed"
      ? event.data
      : event.type === "thread.execution-updated"
        ? event.data.thread
        : event.type === "thread.input-queue-updated"
          ? { inputQueuePaused: event.data.paused }
          : event.type === "thread.access-mode-updated"
            ? { accessMode: event.data.accessMode }
            : null;
  if (!patch) return;
  for (const reader of readers.get(client) ?? []) reader.record(event.threadId, patch);
}
