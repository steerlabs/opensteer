import { HostClientRequestError } from "@opensteer/client/host";

export const externalAgentsFootnote =
  "Agents reach your computer through Remote access while it’s on and awake.";
export const externalAgentsNeedsRemote =
  "Turn on Remote access first — these agents run in the cloud and reach your computer through it.";

export const agentConnectionExpired =
  "This connection request expired. Start again from the agent.";

/** The words for a consent read or decision that failed. */
export function agentConnectionFailure(error: unknown, fallback: string): string {
  return error instanceof HostClientRequestError && error.code === "not_found"
    ? agentConnectionExpired
    : fallback;
}
