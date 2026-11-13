import {
  DesktopLocalExecutionInputSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopStartLocalRunnerInputSchema,
} from "@opensteer/protocol/desktop";
import { AuthSessionIdSchema, DeploymentIdSchema } from "@opensteer/core";
import { DeviceSessionBindingProofSchema } from "@opensteer/protocol";
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

export const handleStartLocalRunner = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  localExecution(context, (input) =>
    context.options.runner.start(DesktopStartLocalRunnerInputSchema.parse(input)),
  );

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

/** `stopLocalRunner` is the removal call: the web sends it when a person takes
 * this Mac out of the Deployment, so the slot and its identity go with it. */
export const handleStopLocalRunner = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  localExecution(context, (input) =>
    context.options.runner.remove(DesktopLocalExecutionInputSchema.parse(input).deploymentId),
  );

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
