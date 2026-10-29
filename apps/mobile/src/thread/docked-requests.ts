import {
  browserSiteLabel,
  deriveSurface,
  requestsWaitingOn,
  type SurfaceModel,
} from "@opensteer/client/host";
import {
  requestTitleText,
  type AuthenticatedUser,
  type Request,
  type WaitingRequest,
} from "@opensteer/core";

/** What a Request is called on its card: a sign-in by its site, anything else by its own title. */
export function requestTitle(request: Request): string {
  const site =
    request.payload.kind === "browser.sign-in" ||
    request.payload.kind === "browser.password-sign-in"
      ? request.payload.site
      : null;
  return site === null ? request.presentation.title : `Sign in to ${browserSiteLabel(site)}`;
}

/** The card's title as one line of plain text, saying in words what the card shows beside it. */
export function requestTitleLine(request: Request): string {
  return requestTitleText({
    agentProposed: request.presentation.agentProposed,
    title: requestTitle(request),
  });
}

/**
 * The one question the work a Thread handed out docks above its composer, and
 * the task it arrived through. Questions asked in the Thread itself are the
 * composer's own.
 */
export function waitingQuestion(
  waitingRequests: readonly WaitingRequest[],
  threadId: string,
  user: Pick<AuthenticatedUser, "id" | "instanceRole">,
): { readonly surface: SurfaceModel; readonly waiting: WaitingRequest | null } | null {
  const waiting = requestsWaitingOn(waitingRequests, threadId).filter(
    ({ request }) => request.originatingThreadId !== threadId,
  );
  const surface = deriveSurface(
    waiting.map(({ request }) => request),
    user,
  );
  return surface === null
    ? null
    : {
        surface,
        waiting: waiting.find(({ request }) => request.id === surface.request.id) ?? null,
      };
}
