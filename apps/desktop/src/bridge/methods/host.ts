import { HostTransportError } from "@opensteer/client/connections";
import type { DesktopHostResult } from "@opensteer/protocol/desktop";
import type { WebContents } from "electron";
import {
  DesktopCloseHostWebSocketInputSchema,
  DesktopHostHttpRequestSchema,
  DesktopHostHttpResponseSchema,
  DesktopHostTransportFailureSchema,
  DesktopHostBinaryOpenInputSchema,
  DesktopHostBinaryOpenResultSchema,
  DesktopHostBinaryWriteInputSchema,
  DesktopHostBinaryTransferInputSchema,
  DesktopHostBinaryReadResultSchema,
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

export const handleHostRequest =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      return DesktopHostHttpResponseSchema.parse(
        await context.options.hostTransport.request(
          DesktopHostHttpRequestSchema.parse(envelope.input),
        ),
      );
    });
  };

export const handleHostBinaryOpen =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      trackHostSender(context, event.sender);
      return DesktopHostBinaryOpenResultSchema.parse(
        await context.options.hostTransport.openBinary(
          event.sender.id,
          DesktopHostBinaryOpenInputSchema.parse(envelope.input),
        ),
      );
    });
  };

export const handleHostBinaryWrite =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      await context.options.hostTransport.writeBinary(
        event.sender.id,
        DesktopHostBinaryWriteInputSchema.parse(envelope.input),
      );
      return null;
    });
  };

export const handleHostBinaryFinish =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      return DesktopHostHttpResponseSchema.parse(
        await context.options.hostTransport.finishBinary(
          event.sender.id,
          DesktopHostBinaryTransferInputSchema.parse(envelope.input),
        ),
      );
    });
  };

export const handleHostBinaryRead =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      return DesktopHostBinaryReadResultSchema.parse(
        await context.options.hostTransport.readBinary(
          event.sender.id,
          DesktopHostBinaryTransferInputSchema.parse(envelope.input),
        ),
      );
    });
  };

export const handleHostBinaryClose =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return hostResult(async () => {
      await context.options.hostTransport.closeBinary(
        event.sender.id,
        DesktopHostBinaryTransferInputSchema.parse(envelope.input),
      );
      return null;
    });
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
    void context.options.hostTransport.closeBinaryForOwner(sender.id);
  });
}

async function hostResult<Data>(operation: () => Promise<Data>): Promise<DesktopHostResult<Data>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    // Electron serializes thrown errors as strings and loses their classification.
    if (!(error instanceof HostTransportError)) throw error;
    return DesktopHostTransportFailureSchema.parse({ ok: false, error: { code: error.code } });
  }
}
