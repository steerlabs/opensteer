import { DesktopUpdatesError } from "@opensteer/client/connections";
import {
  DesktopDeploymentUpdateRequestInputSchema,
  DesktopDeploymentUpdateRequestResultSchema,
  DesktopDeploymentUpdateStatusInputSchema,
  DesktopDeploymentUpdateStatusResultSchema,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

function refusal(error: unknown) {
  return {
    ok: false,
    failure: error instanceof DesktopUpdatesError ? error.reason : "unavailable",
  } as const;
}

export function deploymentUpdatesHandlers(
  context: DesktopBridgeContext,
): ReadonlyArray<readonly [string, DesktopBridgeHandler]> {
  const updates = context.options.deploymentUpdates;
  if (!updates) return [];
  const waits = new Map<string, AbortController>();
  return [
    [
      desktopBridgeChannels.deploymentUpdateStatus,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        const { after, deploymentId, waitId } = DesktopDeploymentUpdateStatusInputSchema.parse(
          envelope.input,
        );
        const wait = new AbortController();
        waits.set(waitId, wait);
        try {
          const data = await updates(deploymentId).status({
            ...(after === undefined ? {} : { after }),
            signal: wait.signal,
          });
          return DesktopDeploymentUpdateStatusResultSchema.parse({ ok: true, data });
        } catch (error) {
          return refusal(error);
        } finally {
          waits.delete(waitId);
        }
      },
    ],
    [
      desktopBridgeChannels.deploymentUpdateRequest,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        const { deploymentId, request } = DesktopDeploymentUpdateRequestInputSchema.parse(
          envelope.input,
        );
        try {
          const data = await updates(deploymentId).request(request);
          return DesktopDeploymentUpdateRequestResultSchema.parse({ ok: true, data });
        } catch (error) {
          return refusal(error);
        }
      },
    ],
    [
      desktopBridgeChannels.deploymentUpdateCancel,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        waits.get(z.uuid().parse(envelope.input))?.abort(new Error("Updates view closed"));
      },
    ],
  ];
}
