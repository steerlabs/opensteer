import {
  requestTitleText,
  type AuthenticatedUser,
  type RequestView as Request,
} from "@opensteer/core";

/**
 * What the one input surface at the bottom of a Thread is for, right now.
 *
 * Idle, it is the message composer. When the agent asks for something, the
 * focused pending Request docks into the same surface above it. A Request is
 * answered only with its own controls: the text field stays an ordinary
 * message beside it, and is hidden only while a form collects its own answers.
 * Both applications dock the same Request the same way, so this decision is
 * made once here rather than in each of their composers.
 */

export type SurfaceTextRole = "hidden" | "message";

export interface SurfaceModel {
  request: Request;
  /** Who may answer instead of this reader; `manager` and `other` come only from the Host's `answer`. */
  denied: "administrator" | "requester" | "manager" | "other" | null;
  /** Pending Requests waiting behind the focused one. */
  queued: number;
  /** Title of the oldest waiting Request, so a preempted card is still named. */
  queuedTitle: string | null;
  textRole: SurfaceTextRole;
}

export function deriveSurface(
  requests: readonly Request[],
  user: Pick<AuthenticatedUser, "id" | "instanceRole"> | null,
  /** The Request a person asked to see, when it is still waiting. */
  focusRequestId: string | null = null,
): SurfaceModel | null {
  const pending = requests
    .filter((request) => request.status === "pending")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const request =
    pending.find(({ id }) => id === focusRequestId) ??
    pending.find((candidate) => candidate.mode === "live") ??
    pending[0];
  if (!request) return null;

  const administratorMayInstall =
    request.payload.kind === "integration.access" &&
    request.payload.installationId === null &&
    user?.instanceRole === "administrator";
  const denied = request.answer
    ? request.answer.allowed
      ? null
      : request.answer.reason === "requester-only"
        ? ("requester" as const)
        : request.answer.reason === "manager-only"
          ? ("manager" as const)
          : ("other" as const)
    : request.requiredActor === "requester" &&
        request.requestedBy !== user?.id &&
        !administratorMayInstall
      ? ("requester" as const)
      : request.requiredActor === "administrator" && user?.instanceRole !== "administrator"
        ? ("administrator" as const)
        : null;

  const textRole: SurfaceTextRole =
    request.mode === "live" && !denied && request.presentation.kind === "form"
      ? "hidden"
      : "message";

  const waiting = pending.filter((candidate) => candidate.id !== request.id);
  return {
    denied,
    queued: waiting.length,
    queuedTitle: waiting[0] ? requestTitleText(waiting[0].presentation) : null,
    request,
    textRole,
  };
}

/** Connection and execution state belong outside the editable message field. */
export function threadComposerPlaceholder(empty: boolean): string {
  return empty ? "Message…" : "Reply…";
}
