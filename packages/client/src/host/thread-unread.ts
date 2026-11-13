export function isThreadUnread(
  thread:
    | { readonly latestRunCompletedAt?: string | null; readonly lastVisitedAt?: string | null }
    | null
    | undefined,
): boolean {
  return (
    thread?.latestRunCompletedAt != null &&
    (thread.lastVisitedAt == null || thread.latestRunCompletedAt > thread.lastVisitedAt)
  );
}
