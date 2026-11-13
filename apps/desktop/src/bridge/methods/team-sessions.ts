import { TeamEntryRefusedError, TeamIdentityGrantUnsupportedError } from "@opensteer/client/auth";
import {
  DesktopTeamSessionsCallSchema,
  type DesktopTeamSessionsResult,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

/** Entering teams for the application window; main keeps the grant and the team's tokens. */
export const handleTeamSessions =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope): Promise<DesktopTeamSessionsResult> => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!context.options.isWorkspaceContents?.(event.sender))
      throw new Error("Only the application window may enter teams.");
    const call = DesktopTeamSessionsCallSchema.parse(envelope.input);
    const sessions = context.options.teamSessions;
    if (!sessions)
      return {
        ok: false,
        error: { status: 503, reason: null, message: "This app has no Opensteer Account service." },
      };
    try {
      return { ok: true, data: await sessions.run(call) };
    } catch (error) {
      if (error instanceof TeamEntryRefusedError)
        return { ok: false, error: { status: 403, reason: error.reason, message: error.message } };
      if (error instanceof TeamIdentityGrantUnsupportedError)
        return { ok: false, error: { status: 404, reason: error.reason, message: error.message } };
      return {
        ok: false,
        error: {
          status: 0,
          reason: null,
          message:
            error instanceof Error && error.message.trim()
              ? error.message.slice(0, 2_000)
              : "The team can’t be reached. Check your connection and try again.",
        },
      };
    }
  };
