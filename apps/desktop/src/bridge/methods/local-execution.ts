import {
  DesktopLocalExecutionInputSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopStartLocalRunnerInputSchema,
} from "@opensteer/protocol/desktop";
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

/** `stopLocalRunner` is the removal call: the web sends it when a person takes
 * this Mac out of the Deployment, so the slot and its identity go with it. */
export const handleStopLocalRunner = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  localExecution(context, (input) =>
    context.options.runner.remove(DesktopLocalExecutionInputSchema.parse(input).deploymentId),
  );
