import { DesktopUpdateStateSchema } from "@opensteer/protocol/desktop";
import { z } from "zod";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  trackRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export function updatesHandlers(
  context: DesktopBridgeContext,
): ReadonlyArray<readonly [string, DesktopBridgeHandler]> {
  const updates = context.options.updates;
  if (!updates) return [];
  return [
    [
      desktopBridgeChannels.getUpdate,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        // Changes reach a window from its first read on, so a read never trails one.
        trackRenderer(context.updatesSenders, event.sender);
        return DesktopUpdateStateSchema.parse(updates.state());
      },
    ],
    [
      desktopBridgeChannels.downloadUpdate,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        void updates.download();
      },
    ],
    [
      desktopBridgeChannels.restartToUpdate,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        updates.restart();
      },
    ],
  ];
}
