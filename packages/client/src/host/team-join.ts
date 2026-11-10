import type { InvitePreviewView, TeamAccess } from "./team-access.js";
import { teamReasonOf } from "./team-presentation.js";

type JoinPort = Pick<TeamAccess, "invitationExchange" | "invitationPreview" | "invitationAccept">;
type OpenPreview = Exclude<InvitePreviewView, { state: "unavailable" }>;

export type TeamJoinState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "used"; readonly preview: OpenPreview }
  /** The link was proved here; sign in to finish. */
  | { readonly kind: "sign-in"; readonly preview: OpenPreview }
  /** The link was proved and someone is signed in: ask them to join. */
  | { readonly kind: "ready"; readonly preview: OpenPreview }
  | { readonly kind: "joined" }
  /** No proof on this browser: the link was opened without its last part. */
  | { readonly kind: "missing-link"; readonly preview: OpenPreview };

/**
 * Where an invite page stands when it opens. With the link's verifier, it is
 * exchanged for the Host's admission proof (an HttpOnly cookie) and then
 * forgotten. Coming back signed in from a sign-in round trip, the page has no
 * verifier any more and needs none: the proof is the cookie, so it asks the
 * Host to accept and never asks for the secret again.
 */
export async function openTeamJoin(
  team: JoinPort,
  input: {
    readonly selector: string;
    readonly verifier: string | null;
    readonly authenticated: boolean;
  },
): Promise<TeamJoinState> {
  if (input.verifier) {
    const { preview } = await team.invitationExchange({
      selector: input.selector,
      verifier: input.verifier,
    });
    if (preview.state === "unavailable") return { kind: "unavailable" };
    if (preview.state === "used") return { kind: "used", preview };
    return input.authenticated ? { kind: "ready", preview } : { kind: "sign-in", preview };
  }
  const preview = await team.invitationPreview(input.selector);
  if (preview.state === "unavailable") return { kind: "unavailable" };
  if (preview.state === "used") return { kind: "used", preview };
  if (!input.authenticated) return { kind: "missing-link", preview };
  try {
    await team.invitationAccept();
    return { kind: "joined" };
  } catch (error) {
    if (teamReasonOf(error) === "invite-unavailable") return { kind: "missing-link", preview };
    throw error;
  }
}
