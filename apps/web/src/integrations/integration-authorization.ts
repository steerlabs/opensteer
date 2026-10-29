import type { IntegrationAuthorizationStart } from "@opensteer/integration-core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
export {
  integrationAuthorizationError,
  waitForIntegrationAuthorization,
} from "@opensteer/client/integrations";

export const integrationAuthorizationCompletionPath = "/integration-authorization";

export function integrationAuthorizationSurface(
  bridge: OpensteerDesktopBridge | null,
): "desktop" | "web" {
  return bridge ? "desktop" : "web";
}

/** Open while the click still has browser activation, before any asynchronous work. */
export async function beginIntegrationAuthorization(input: {
  readonly bridge: Pick<OpensteerDesktopBridge, "openIntegrationAuthorization"> | null;
  readonly begin: (returnPath: string) => Promise<IntegrationAuthorizationStart>;
  readonly onStarted?: (attemptId: IntegrationAuthorizationStart["attemptId"]) => void;
  readonly returnPath: string;
}): Promise<IntegrationAuthorizationStart> {
  const tab = input.bridge ? null : window.open(integrationAuthorizationCompletionPath, "_blank");
  if (!input.bridge && !tab) {
    throw new Error("Allow Opensteer to open a new tab, then click Connect again.");
  }
  // Sever access before the tab visits any provider. Completion uses Host status, never opener messages.
  try {
    if (tab) tab.opener = null;
    const started = await input.begin(
      input.bridge ? input.returnPath : integrationAuthorizationCompletionPath,
    );
    if (input.bridge) {
      await input.bridge.openIntegrationAuthorization({
        attemptId: started.attemptId,
        launchTicket: started.launchTicket,
      });
    } else {
      input.onStarted?.(started.attemptId);
      const target = new URL(
        `/v1/integration-authorizations/${encodeURIComponent(started.attemptId)}/launch`,
        window.location.origin,
      );
      target.searchParams.set("ticket", started.launchTicket);
      // Closing the tab is not cancellation: the original page still observes the durable attempt.
      if (tab && !tab.closed) tab.location.replace(target.toString());
    }
    return started;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
