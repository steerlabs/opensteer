import { z } from "zod";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
export function passkeyHandlers(
  context: DesktopBridgeContext,
): readonly (readonly [string, DesktopBridgeHandler])[] {
  return [
    [
      desktopBridgeChannels.passkeyAvailable,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        return context.options.passkeys?.available() ?? false;
      },
    ],
    [
      desktopBridgeChannels.passkeyPresent,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        const { requestId } = z.strictObject({ requestId: z.uuid() }).parse(envelope.input);
        if (!context.options.passkeys) throw new Error("Native passkeys are unavailable.");
        await context.options.passkeys.present(event.sender, requestId);
      },
    ],
  ];
}
