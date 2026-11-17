import { DeploymentIdSchema } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import { authorizationLaunchUrl } from "@opensteer/client/host";
import type { PluginSignInSurface } from "@opensteer/client/plugins";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { integrationAuthorizationFinish } from "./integration-authorization.js";

/** Where a plugin sign-in's browser lands when it comes back to this origin. */
export const pluginAuthorizationCompletionPath = "/plugin-authorization";

/**
 * A plugin sign-in from this page. In a browser the provider opens in a new tab,
 * opened during the click and severed from this page, and the Account session or
 * this Host proves who consented. In the desktop app the main process opens the
 * system browser and takes the app return, through the loopback or the app link.
 */
export function pluginSignInSurface(
  bridge: Pick<
    OpensteerDesktopBridge,
    "openIntegrationAuthorization" | "prepareIntegrationAuthorizationReturn"
  > | null,
  client: Pick<HostClient, "getSnapshot">,
): PluginSignInSurface {
  if (bridge)
    return {
      surface: "desktop",
      open: () => {
        const initiating = client.getSnapshot();
        let preparation: string | undefined;
        return {
          route: async () => {
            const prepared = await integrationAuthorizationFinish(bridge, client);
            preparation = prepared.preparation;
            return { returnPath: pluginAuthorizationCompletionPath, ...prepared.finish };
          },
          launch: async (started) => {
            const snapshot = client.getSnapshot();
            if (
              !snapshot.deploymentId ||
              !snapshot.user ||
              initiating.deploymentId !== snapshot.deploymentId ||
              initiating.user?.id !== snapshot.user.id
            )
              throw new Error("Reconnect to this computer before signing in.");
            await bridge.openIntegrationAuthorization({
              kind: "plugin",
              attemptId: started.attemptId,
              launchTicket: started.launchTicket,
              deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
              userId: snapshot.user.id,
              expiresAt: started.expiresAt,
              ...(preparation === undefined ? {} : { returnPreparation: preparation }),
            });
          },
          abandon: () => {},
        };
      },
    };
  return {
    surface: "web",
    open: () => {
      const tab = window.open(pluginAuthorizationCompletionPath, "_blank");
      if (!tab) throw new Error("Allow Opensteer to open a new tab, then sign in again.");
      // Completion reads the Host's status, never messages from this page.
      tab.opener = null;
      return {
        route: async () => ({ returnPath: pluginAuthorizationCompletionPath }),
        launch: async (started) => {
          // Closing the tab is not cancelling: this page keeps reading the attempt.
          if (!tab.closed)
            tab.location.replace(authorizationLaunchUrl(window.location.origin, started));
        },
        abandon: () => tab.close(),
      };
    },
  };
}
