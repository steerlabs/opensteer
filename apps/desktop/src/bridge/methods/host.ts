import type { WebContents } from "electron";
import {
  DesktopCancelHostRequestInputSchema,
  DesktopCloseHostWebSocketInputSchema,
  DesktopHostWebSocketCommandSchema,
  DesktopOpenHostWebSocketInputSchema,
  DesktopOpenHostWebSocketResultSchema,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleCancelHostRequest =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    context.options.hostTransport.cancelRequest(
      DesktopCancelHostRequestInputSchema.parse(envelope.input),
    );
  };

export const handleOpenHostWebSocket =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackHostSender(context, event.sender);
    const result = await context.options.hostTransport.openWebSocket(
      event.sender.id,
      DesktopOpenHostWebSocketInputSchema.parse(envelope.input),
      (message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(desktopBridgeChannels.hostWebSocketEvent, message);
        }
      },
    );
    return DesktopOpenHostWebSocketResultSchema.parse(result);
  };

export const handleSendHostWebSocket =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    context.options.hostTransport.sendWebSocket(
      event.sender.id,
      DesktopHostWebSocketCommandSchema.parse(envelope.input),
    );
  };

export const handleCloseHostWebSocket =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    context.options.hostTransport.closeWebSocket(
      event.sender.id,
      DesktopCloseHostWebSocketInputSchema.parse(envelope.input),
    );
  };

function trackHostSender(context: DesktopBridgeContext, sender: WebContents): void {
  if (context.trackedHostSenders.has(sender.id)) return;
  context.trackedHostSenders.add(sender.id);
  sender.once("destroyed", () => {
    context.trackedHostSenders.delete(sender.id);
    context.options.hostTransport.closeSocketsForOwner(sender.id);
  });
}
