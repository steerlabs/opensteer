import type { HostClient, HostSnapshot, TranscriptEntry } from "./client.js";

type ReplyProjection = Pick<HostSnapshot, "transcripts" | "publishedReplyAt">;

function newestPublishedReply(entries: readonly TranscriptEntry[]): string | undefined {
  let latest: string | undefined;
  for (const entry of entries)
    if (
      entry.kind === "message" &&
      entry.messageKind === "assistant" &&
      entry.published === true &&
      entry.streaming !== true &&
      (latest === undefined || entry.createdAt > latest)
    )
      latest = entry.createdAt;
  return latest;
}

/**
 * Carries each Thread's reply watermark forward and rescans only transcripts that
 * changed. `liveThreadId` names a transcript changed only by live progress, which
 * never publishes a reply.
 */
export function withPublishedReplies<T extends ReplyProjection>(
  previous: ReplyProjection | null,
  next: T,
  liveThreadId?: string,
): T {
  const before = previous?.publishedReplyAt ?? {};
  if (previous && next.transcripts === previous.transcripts)
    return next.publishedReplyAt === before ? next : { ...next, publishedReplyAt: before };
  const after: Record<string, string> = {};
  let changed = false;
  for (const [threadId, entries] of Object.entries(next.transcripts)) {
    const reply =
      previous && (entries === previous.transcripts[threadId] || threadId === liveThreadId)
        ? before[threadId]
        : newestPublishedReply(entries);
    if (reply !== undefined) after[threadId] = reply;
    if (reply !== before[threadId]) changed = true;
  }
  if (!changed && Object.keys(after).length !== Object.keys(before).length) changed = true;
  const publishedReplyAt = changed ? after : before;
  return next.publishedReplyAt === publishedReplyAt ? next : { ...next, publishedReplyAt };
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
  let threads: HostSnapshot["threads"] | null = null;
  let thread: HostSnapshot["threads"][number] | undefined;
  let completion: string | null | undefined;
  let reply: string | undefined;
  let visit: string | null | undefined;
  let target: string | null = null;
  // Token deltas change none of these inputs, so they stop at the comparisons.
  const presentedVisitTime = (): string | null => {
    const snapshot = client.getSnapshot();
    if (snapshot.threads !== threads) {
      threads = snapshot.threads;
      thread = threads.find((candidate) => candidate.id === threadId);
    }
    const nextCompletion = thread?.latestRunCompletedAt ?? null;
    const nextReply = snapshot.publishedReplyAt[threadId];
    const nextVisit = snapshot.threadVisits[threadId] ?? thread?.lastVisitedAt;
    if (nextCompletion === completion && nextReply === reply && nextVisit === visit) return target;
    completion = nextCompletion;
    reply = nextReply;
    visit = nextVisit;
    const latest =
      reply !== undefined && (completion === null || reply > completion) ? reply : completion;
    target = latest !== null && (visit == null || latest > visit) ? latest : null;
    return target;
  };
  const changed = () => {
    if (!active || scheduled !== null) return;
    const target = presentedVisitTime();
    if (!target || (acknowledged !== null && target <= acknowledged)) return;
    if (pending !== null) {
      again = true;
      return;
    }
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!active) return;
      const visitedAt = presentedVisitTime();
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
