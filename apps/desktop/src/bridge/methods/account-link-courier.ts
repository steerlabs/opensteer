import {
  IssuePersonalHostAccountLinkChallengeRequestSchema,
  CompletePersonalHostAccountLinkRequestSchema,
} from "@opensteer/control-plane-protocol";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { OpensteerError } from "@opensteer/core";

export const handleIssuePersonalAccountLinkChallenge =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!context.options.accountLinkCourier)
      throw new OpensteerError({ code: "not_found", message: "Account linking is unavailable" });
    return context.options.accountLinkCourier.issuePersonalHostAccountLinkChallenge(
      IssuePersonalHostAccountLinkChallengeRequestSchema.parse(envelope.input),
    );
  };
export const handleCompletePersonalAccountLink =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!context.options.accountLinkCourier)
      throw new OpensteerError({ code: "not_found", message: "Account linking is unavailable" });
    const input = CompletePersonalHostAccountLinkRequestSchema.parse(envelope.input);
    return context.options.accountLinkCourier.completePersonalHostAccountLink(
      input.proof.document.challenge.id,
      input,
    );
  };
