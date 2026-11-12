import type { TeamScope, TeamSessionClient } from "@opensteer/client/team";

type SendInput = Parameters<TeamSessionClient["send"]>[0];

/**
 * Sends what a team composer holds. The composer clears only once the session
 * has durably admitted the message as a pending send; anything refused before
 * that (too long, too many unsent) leaves the words, files and draft as they were.
 */
export async function sendFromComposer(
  session: Pick<TeamSessionClient, "send" | "setDraft">,
  scope: TeamScope,
  input: SendInput,
  clear: () => void,
): Promise<void> {
  await session.send(input);
  clear();
  await session.setDraft(scope, "").catch(() => undefined);
}
