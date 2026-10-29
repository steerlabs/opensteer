import {
  DesktopChooseUsbDeviceInputSchema,
  DesktopReadAgentPhoneArtifactResultSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleReadAgentPhoneArtifact =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopReadAgentPhoneArtifactResultSchema.parse(
      await context.options.agentPhone.readArtifact(),
    );
  };

export const handleChooseUsbDevice =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    // Only the frame that was asked may answer, which `choose` checks.
    context.options.agentPhone.chooseUsbDevice(
      DesktopChooseUsbDeviceInputSchema.parse(envelope.input),
      event.senderFrame,
    );
  };
