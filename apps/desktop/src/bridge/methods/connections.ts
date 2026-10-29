import {
  DeploymentAccessSnapshotSchema,
  DesktopAddDirectRouteInputSchema,
  DesktopConnectPrivateDeploymentInputSchema,
  DesktopRemoveAccountDeploymentInputSchema,
  DesktopSelectDeploymentInputSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
  trackRenderer,
} from "../context.js";

export function handleGetDeploymentAccessSnapshot(
  context: DesktopBridgeContext,
): DesktopBridgeHandler {
  return (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(context.accessSenders, event.sender);
    return DeploymentAccessSnapshotSchema.parse(context.options.access.snapshot());
  };
}

function accessOperation(
  context: DesktopBridgeContext,
  operation: (input: unknown) => Promise<void>,
): DesktopBridgeHandler {
  return async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(context.accessSenders, event.sender);
    await operation(envelope.input);
  };
}

export const handleSignIn = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.signIn());

export const handleReauthorize = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.reauthorize());

export const handleSignOut = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.signOut());

export const handleCreatePersonalDeployment = (
  context: DesktopBridgeContext,
): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.createPersonalDeployment());

export const handleLinkPersonal = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.linkPersonal());

export const handleUnlinkPersonal = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.unlinkPersonal());

export const handleCheckDeployments = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.checkDeployments());

export const handleRefreshDirectory = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.refreshDirectory());

export const handleRemoveFromAccount = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, (input) =>
    context.options.access.removeFromAccount(
      DesktopRemoveAccountDeploymentInputSchema.parse(input).deploymentId,
    ),
  );

export const handleRetry = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.retry());

export const handleCancel = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, () => context.options.access.cancel());

export const handleSelect = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, (input) =>
    context.options.access.select(DesktopSelectDeploymentInputSchema.parse(input).deploymentId),
  );

export const handleAddDirect = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, (input) =>
    context.options.access.addDirect(DesktopAddDirectRouteInputSchema.parse(input)),
  );

export const handleConnectPrivate = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  accessOperation(context, (input) =>
    context.options.access.connectPrivate(DesktopConnectPrivateDeploymentInputSchema.parse(input)),
  );
