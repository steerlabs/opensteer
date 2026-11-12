import { AccountRequestError } from "@opensteer/client/connections";
import type { AccountTeamsClient } from "@opensteer/client/team";
import {
  DesktopAccountTeamsCallSchema,
  type DesktopAccountTeamsCall,
  type DesktopAccountTeamsResult,
} from "@opensteer/protocol/desktop";
import { OpensteerError } from "@opensteer/core";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

function run(client: AccountTeamsClient, call: DesktopAccountTeamsCall): Promise<unknown> {
  switch (call.call) {
    case "availability":
      return client.hostedTeamAvailability(call.slug);
    case "create":
      return client.createHostedTeam(call.request);
    case "list":
      return client.listHostedTeams();
    case "get":
      return client.hostedTeam(call.id);
    case "retry":
      return client.retryHostedTeam(call.id);
    case "delete":
      return client.deleteHostedTeam(call.id);
  }
}

/** Account's hosted-team calls for the application window, with the Account session main holds. */
export const handleAccountTeams =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope): Promise<DesktopAccountTeamsResult> => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!context.options.isWorkspaceContents?.(event.sender))
      throw new Error("Only the application window may manage teams.");
    const call = DesktopAccountTeamsCallSchema.parse(envelope.input);
    const client = context.options.accountTeams;
    if (!client)
      return {
        ok: false,
        error: { status: 503, reason: null, message: "This app has no Opensteer Account service." },
      };
    try {
      return { ok: true, data: await run(client, call) };
    } catch (error) {
      if (error instanceof AccountRequestError)
        return {
          ok: false,
          error: { status: error.status, reason: error.reason, message: error.message },
        };
      if (error instanceof OpensteerError)
        return {
          ok: false,
          error: { status: 400, reason: error.reason ?? null, message: error.message },
        };
      return {
        ok: false,
        error: {
          status: 0,
          reason: null,
          message: "Opensteer Account can’t be reached. Check your connection and try again.",
        },
      };
    }
  };
