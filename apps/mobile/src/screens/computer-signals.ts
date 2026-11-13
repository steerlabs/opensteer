import type { DeploymentStatus } from "../client/deployment-rows.js";

/** What a computer's own work asks of the reader, as its Host counts it. */
export interface ComputerAttention {
  readonly needsYou: number;
  readonly unread: boolean;
  /** The Mac a personal Opensteer lives on; older Hosts omit it. */
  readonly homeName?: string | null | undefined;
}

export const sameAttention = (left: ComputerAttention, right: ComputerAttention): boolean =>
  left.needsYou === right.needsYou &&
  left.unread === right.unread &&
  (left.homeName ?? null) === (right.homeName ?? null);

/** Names Home only when that says more than the row's own name, as the desktop chooser does. */
export function homeLine(
  attention: ComputerAttention | null | undefined,
  deploymentName: string,
): string | null {
  const home = attention?.homeName;
  return home && home !== deploymentName ? `Home: ${home}` : null;
}

/** The drawer's two signals: the amber Needs you count, else the ember unread dot. */
export type AttentionBadge =
  { readonly kind: "needs-you"; readonly count: number } | { readonly kind: "unread" } | null;

/** A computer that can't answer for itself: nothing is asked of it. */
const unanswerable: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "needs-sign-in",
  "unavailable",
  "unverified",
  "update-required",
]);

/**
 * The computers read once when the list opens: every other row that holds a
 * credential, never the one on screen, whose live snapshot already says.
 */
export function attentionReads(
  rows: readonly { readonly deploymentId: string; readonly status: DeploymentStatus }[],
  shown: string | null,
): readonly string[] {
  return rows
    .filter((row) => row.deploymentId !== shown && !unanswerable.has(row.status))
    .map((row) => row.deploymentId);
}

/**
 * What one computer row shows: the shown computer from its live snapshot,
 * another from its one read. A read that failed or has not answered shows
 * nothing, never an error.
 */
export function computerBadge(input: {
  readonly current: boolean;
  readonly shown: ComputerAttention | null;
  readonly read: ComputerAttention | null | undefined;
}): AttentionBadge {
  const attention = input.current ? input.shown : input.read;
  if (attention === null || attention === undefined) return null;
  if (attention.needsYou > 0) return { kind: "needs-you", count: attention.needsYou };
  return attention.unread ? { kind: "unread" } : null;
}
