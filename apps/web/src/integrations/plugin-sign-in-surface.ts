import { DeploymentIdSchema } from "@opensteer/core";
import {
  authorizationLaunchUrl,
  authorizationStatusReturned,
  authorizationTerminalStatuses,
  isHostRefusal,
  type HostClient,
} from "@opensteer/client/host";
import {
  returnPluginAuthorization,
  waitForPluginAuthorization,
  type PluginSignInSurface,
} from "@opensteer/client/plugins";
import type {
  DesktopIntegrationAuthorizationReturn,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";

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
            const prepared = await pluginSignInFinish(bridge, client);
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

/** What an attempt's begin command says about how it finishes. */
export interface PluginSignInFinish {
  readonly appReturnPort?: number;
  readonly finish?: "app";
}

export async function pluginSignInFinish(
  bridge: Pick<OpensteerDesktopBridge, "prepareIntegrationAuthorizationReturn"> | null,
  client: Pick<HostClient, "getSnapshot">,
): Promise<{ readonly finish: PluginSignInFinish; readonly preparation?: string }> {
  const snapshot = client.getSnapshot();
  if (!bridge || !snapshot.integrationAppFinishAvailable) return { finish: {} };
  if (!snapshot.integrationAppReturnPortAvailable || !snapshot.deploymentId)
    return { finish: { finish: "app" } };
  const prepared = await bridge
    .prepareIntegrationAuthorizationReturn({
      deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
    })
    .catch(() => ({ port: null }));
  return prepared.port === null
    ? { finish: { finish: "app" } }
    : {
        finish: { appReturnPort: prepared.port, finish: "app" },
        preparation: prepared.preparation,
      };
}

type ReturnBridge = Pick<
  OpensteerDesktopBridge,
  "onIntegrationAuthorizationReturn" | "finishIntegrationAuthorization"
>;
const deliveries = new WeakMap<HostClient, Map<string, Promise<void>>>();

export function subscribePluginSignInReturns(bridge: ReturnBridge, client: HostClient): () => void {
  let detach = () => {};
  let identity: { deploymentId: string; userId: string } | null = null;
  let pending = deliveries.get(client);
  if (!pending) deliveries.set(client, (pending = new Map()));
  const inFlight = pending;
  const receive = (callback: DesktopIntegrationAuthorizationReturn) => {
    const snapshot = client.getSnapshot();
    if (
      !identity ||
      snapshot.deploymentId !== callback.deploymentId ||
      snapshot.user?.id !== identity.userId ||
      inFlight.has(callback.attemptId)
    )
      return;
    const work = (async () => {
      const status =
        callback.returnProof === null
          ? await waitForPluginAuthorization({ attemptId: callback.attemptId, client })
          : await returnPluginAuthorization(client, callback.attemptId, callback.returnProof);
      if (authorizationTerminalStatuses.has(status.status))
        await bridge.finishIntegrationAuthorization({
          deploymentId: callback.deploymentId,
          attemptId: callback.attemptId,
        });
    })()
      .catch(async (error: unknown) => {
        if (!isHostRefusal(error)) return;
        // A refused proof ends the sign-in for whoever is waiting on it.
        const refused = {
          status: "failed",
          failureCode: "grant-rejected",
          connectionId: null,
          account: null,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        };
        authorizationStatusReturned(client, callback.attemptId, refused);
        await bridge
          .finishIntegrationAuthorization({
            deploymentId: callback.deploymentId,
            attemptId: callback.attemptId,
          })
          .catch(() => undefined);
      })
      .finally(() => {
        inFlight.delete(callback.attemptId);
      });
    inFlight.set(callback.attemptId, work);
  };
  const update = () => {
    const snapshot = client.getSnapshot();
    const next =
      snapshot.deploymentId && snapshot.user
        ? { deploymentId: snapshot.deploymentId, userId: snapshot.user.id }
        : null;
    if (identity?.deploymentId === next?.deploymentId && identity?.userId === next?.userId) return;
    if (
      identity &&
      (!next || (identity.deploymentId === next.deploymentId && identity.userId !== next.userId))
    ) {
      void bridge
        .finishIntegrationAuthorization({
          deploymentId: DeploymentIdSchema.parse(identity.deploymentId),
        })
        .catch(() => undefined);
    }
    detach();
    identity = next;
    detach = next ? bridge.onIntegrationAuthorizationReturn(next, receive) : () => {};
  };
  update();
  const unsubscribe = client.subscribe(update);
  return () => {
    unsubscribe();
    detach();
  };
}
