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
    const attached = await context.options.hostTransport.current();
    if (attached.connection.authority.document.deploymentId !== input.deploymentId)
      throw new Error("The integration attempt belongs to a different Deployment.");
    const origin = await context.options.hostTransport.integrationAuthorizationOrigin(
      input.deploymentId,
    );
    const target = new URL(
      `/v1/integration-authorizations/${encodeURIComponent(input.attemptId)}/launch`,
      origin,
    );
    target.searchParams.set("ticket", input.launchTicket);
    const authorizations = context.options.integrationAuthorizations;
    if (!authorizations) throw new Error("Integration authorization returns are unavailable.");
    await authorizations.attempts.register({
      deploymentId: input.deploymentId,
      attemptId: input.attemptId,
      expiresAt: input.expiresAt,
      ...(input.userId ? { userId: input.userId } : {}),
    });
    await context.options.portal.openExternal(target.toString());
    return DesktopOpenIntegrationAuthorizationResultSchema.parse({ opened: true });
  };
