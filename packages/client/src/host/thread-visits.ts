import type { HostClient, HostSnapshot } from "./client.js";

export function presentedVisitTime(snapshot: HostSnapshot, threadId: string): string | null {
  const thread = snapshot.threads.find((thread) => thread.id === threadId);
  let latest = thread?.latestRunCompletedAt ?? null;
  for (const entry of snapshot.transcripts[threadId] ?? []) {
    if (
      entry.kind !== "message" ||
      entry.messageKind !== "assistant" ||
      entry.published !== true ||
      entry.streaming === true
    )
      continue;
    if (latest === null || entry.createdAt > latest) latest = entry.createdAt;
  }
  const visited = snapshot.threadVisits[threadId] ?? thread?.lastVisitedAt;
  return latest !== null && (visited == null || latest > visited) ? latest : null;
}

/** The caller owns presentation; background observers never start this tracker. */
export function trackThreadVisits(
  client: Pick<HostClient, "subscribe" | "getSnapshot" | "visitThread">,
  threadId: string,
): () => void {
  let active = true;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let acknowledged: string | null = null;
  let again = false;
  const changed = () => {
    if (!active || scheduled !== null) return;
    const target = presentedVisitTime(client.getSnapshot(), threadId);
    if (!target || (acknowledged !== null && target <= acknowledged)) return;
    if (pending !== null) {
      again = true;
      return;
    }
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!active) return;
      const visitedAt = presentedVisitTime(client.getSnapshot(), threadId);
      if (
        !visitedAt ||
        visitedAt === pending ||
        (acknowledged !== null && visitedAt <= acknowledged)
      )
        return;
      pending = visitedAt;
      void client
        .visitThread(threadId, visitedAt)
        .then(
          () => {
            if (acknowledged === null || visitedAt > acknowledged) acknowledged = visitedAt;
          },
          () => undefined,
        )
        .finally(() => {
          pending = null;
          if (again) {
            again = false;
            changed();
          }
        });
    }, 0);
  };
  const unsubscribe = client.subscribe(changed);
  changed();
  return () => {
    active = false;
    unsubscribe();
    if (scheduled !== null) clearTimeout(scheduled);
  };
}
