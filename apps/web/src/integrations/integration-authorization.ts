import { DeploymentIdSchema } from "@opensteer/core";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  integrationAuthorizationStatusReturned,
  integrationAuthorizationTerminalStatuses,
  waitForIntegrationAuthorization,
} from "@opensteer/client/integrations";
import type { DesktopIntegrationAuthorizationReturn } from "@opensteer/protocol/desktop";
import type {
  IntegrationAuthorizationStatus,
  IntegrationAuthorizationStart,
} from "@opensteer/integration-core";
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
  readonly client?: Pick<HostClient, "getSnapshot">;
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
    const initiating = input.bridge ? input.client?.getSnapshot() : undefined;
    const started = await input.begin(
      input.bridge ? input.returnPath : integrationAuthorizationCompletionPath,
    );
    if (input.bridge) {
      const snapshot = input.client?.getSnapshot();
      if (
        !snapshot?.deploymentId ||
        !snapshot.user ||
        initiating?.deploymentId !== snapshot.deploymentId ||
        initiating.user?.id !== snapshot.user.id
      )
        throw new Error("Reconnect to this deployment before connecting an integration.");
      input.onStarted?.(started.attemptId);
      await input.bridge.openIntegrationAuthorization({
        attemptId: started.attemptId,
        launchTicket: started.launchTicket,
        deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
        userId: snapshot.user.id,
        expiresAt: started.expiresAt,
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

export function integrationAuthorizationFinish(
  bridge: object | null,
  client: Pick<HostClient, "getSnapshot">,
): { readonly finish?: "app" } {
  return bridge && client.getSnapshot().integrationAppFinishAvailable ? { finish: "app" } : {};
}

type ReturnBridge = Pick<
  OpensteerDesktopBridge,
  "onIntegrationAuthorizationReturn" | "finishIntegrationAuthorization"
>;
const deliveries = new WeakMap<HostClient, Map<string, Promise<void>>>();

export function subscribeIntegrationAuthorizationReturns(
  bridge: ReturnBridge,
  client: HostClient,
): () => void {
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
      let status: IntegrationAuthorizationStatus;
      if (callback.returnProof === null)
        status = await waitForIntegrationAuthorization({ attemptId: callback.attemptId, client });
      else {
        const returned = await client.dispatch({
          type: "integration.authorization.return",
          attemptId: callback.attemptId,
          returnProof: callback.returnProof,
          idempotencyKey: mutationIdempotencyKey(`integration-auth-return:${callback.attemptId}`),
        });
        if (returned.type !== "integration.authorization.return")
          throw new Error("Integration authorization command mismatch.");
        status = returned;
      }
      integrationAuthorizationStatusReturned(client, callback.attemptId, status);
      if (integrationAuthorizationTerminalStatuses.has(status.status))
        await bridge.finishIntegrationAuthorization({
          deploymentId: callback.deploymentId,
          attemptId: callback.attemptId,
        });
    })()
      .catch(() => {
        // Retain main's registry entry so another delivery can recover a transient failure.
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

export async function finishDesktopIntegrationAuthorization(
  bridge: OpensteerDesktopBridge | null,
  client: Pick<HostClient, "getSnapshot">,
  attemptId: IntegrationAuthorizationStart["attemptId"],
): Promise<void> {
  const deploymentId = client.getSnapshot().deploymentId;
  if (bridge && deploymentId)
    await bridge.finishIntegrationAuthorization({
      deploymentId: DeploymentIdSchema.parse(deploymentId),
      attemptId,
    });
}
