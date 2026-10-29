import {
  DesktopOpenIntegrationAuthorizationInputSchema,
  DesktopOpenIntegrationAuthorizationResultSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleOpenIntegrationAuthorization =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopOpenIntegrationAuthorizationInputSchema.parse(envelope.input);
    const origin = await context.options.hostTransport.integrationAuthorizationOrigin();
    const target = new URL(
      `/v1/integration-authorizations/${encodeURIComponent(input.attemptId)}/launch`,
      origin,
    );
    target.searchParams.set("ticket", input.launchTicket);
    await context.options.portal.openExternal(target.toString());
    return DesktopOpenIntegrationAuthorizationResultSchema.parse({ opened: true });
  };
