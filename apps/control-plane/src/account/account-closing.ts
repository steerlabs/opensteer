/**
 * Whether an Account is closing: a deletion attempt holds its fence, or its person asked to
 * delete it (`deletion_requested_at`), which lasts until it is gone however long that takes.
 * A closing Account is admitted to nothing new that bills or binds it, so nothing started
 * after the decision can keep its deletion from finishing.
 */
export function accountClosing(
  user: {
    readonly deletionFencedUntil: Date | null;
    readonly deletionRequestedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    user.deletionRequestedAt !== null ||
    (user.deletionFencedUntil !== null && user.deletionFencedUntil > now)
  );
}
