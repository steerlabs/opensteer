import {
  DesktopChooseUsbDeviceInputSchema,
  DesktopAgentPhoneAdbOpenSchema,
  DesktopAgentPhoneAdbCallSchema,
  DesktopAgentPhoneAdbSessionSchema,
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

export const handleAgentPhoneAdbOpen =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const frame = event.senderFrame;
    if (!frame || !context.options.agentPhone.adb) throw new Error("Phone setup is unavailable.");
    return context.options.agentPhone.adb.open(
      DesktopAgentPhoneAdbOpenSchema.parse(envelope.input),
      frame,
      event.sender,
    );
  };
export const handleAgentPhoneAdbCall =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const frame = event.senderFrame;
    if (!frame || !context.options.agentPhone.adb) throw new Error("Phone setup is unavailable.");
    return context.options.agentPhone.adb.call(
      DesktopAgentPhoneAdbCallSchema.parse(envelope.input),
      frame,
    );
  };
export const handleAgentPhoneAdbClose =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const frame = event.senderFrame;
    if (!frame) return;
    context.options.agentPhone.adb?.close(
      DesktopAgentPhoneAdbSessionSchema.parse(envelope.input).sessionId,
      frame,
    );
  };
