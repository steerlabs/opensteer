import {
  DesktopLocalExecutionInputSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopStartLocalRunnerInputSchema,
} from "@opensteer/protocol/desktop";
import { AuthSessionIdSchema, DeploymentIdSchema } from "@opensteer/core";
import { DevicePreparedIdentitySchema, DeviceSessionBindingProofSchema } from "@opensteer/protocol";
import { z } from "zod";
import {
  assertAuthorizedRenderer,
  trackLocalExecutionRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

function localExecution(
  context: DesktopBridgeContext,
  operation: (input: unknown) => Promise<unknown>,
): DesktopBridgeHandler {
  return async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopLocalExecutionStatusSchema.parse(await operation(envelope.input));
  };
}

export const handleGetLocalExecutionStatus =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { deploymentId } = DesktopLocalExecutionInputSchema.parse(envelope.input);
    trackLocalExecutionRenderer(context.localExecutionSenders, event.sender, deploymentId);
    return DesktopLocalExecutionStatusSchema.parse(
      await context.options.runner.status(deploymentId),
    );
  };

/**
 * Rechecks right away on the Runners this app runs for other Deployments. The
 * Personal Runner is a separate process with no channel for it, and needs
 * none: every Runner compares its engines with its hello on each heartbeat.
 */
export const handleRecheckLocalEngines =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    context.options.runner.recheckEngines();
  };

export const handleSetUpDevice = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  localExecution(context, (input) =>
    context.options.runner.setUpDevice(DesktopStartLocalRunnerInputSchema.parse(input)),
  );

export const handleLeaveDeployment =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.runner.leaveDeployment(
      DesktopLocalExecutionInputSchema.parse(envelope.input),
    );
  };

const bindingInput = z.strictObject({
  deploymentId: DeploymentIdSchema,
  sessionId: AuthSessionIdSchema,
});
export const handleSignDeviceSessionBinding =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DeviceSessionBindingProofSchema.parse(
      await context.options.runner.signDeviceSessionBinding(bindingInput.parse(envelope.input)),
    );
  };

export const handlePrepareDeviceSetup =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DevicePreparedIdentitySchema.parse(
      await context.options.runner.prepareDeviceSetup(
        DesktopStartLocalRunnerInputSchema.parse(envelope.input),
      ),
    );
  };

export const handleAccountSignOutPreview =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return z
      .array(z.strictObject({ deploymentId: DeploymentIdSchema, name: z.string().min(1).max(120) }))
      .parse(await context.options.runner.accountSignOutPreview());
  };

export const handleRetryDeviceConnection =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.runner.retryDeviceConnection(
      DesktopLocalExecutionInputSchema.parse(envelope.input),
    );
  };
