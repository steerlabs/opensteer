import { CreateCloudDeploymentRequestSchema } from "@opensteer/control-plane-protocol";
import {
  DesktopCloudDeploymentOperationInputSchema,
  DesktopDeleteCloudDeploymentInputSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

function requireCloud(context: DesktopBridgeContext) {
  if (!context.options.cloud) throw new Error("Opensteer Cloud is unavailable.");
  return context.options.cloud;
}

export const handleListCloudDeployments =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return requireCloud(context).listCloudDeployments();
  };

export const handleCreateCloudDeployment =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return requireCloud(context).createCloudDeployment(
      CreateCloudDeploymentRequestSchema.parse(envelope.input),
    );
  };

export const handleRetryCloudDeployment =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return requireCloud(context).retryCloudDeployment(
      DesktopCloudDeploymentOperationInputSchema.parse(envelope.input).operationId,
    );
  };

export const handleDeleteCloudDeployment =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopDeleteCloudDeploymentInputSchema.parse(envelope.input);
    return requireCloud(context).deleteCloudDeployment(input.operationId, input.name);
  };
