import {
  DesktopDownloadActionResultSchema,
  DesktopDownloadsSnapshotSchema,
  DesktopDownloadTargetSchema,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  trackRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export function downloadsHandlers(
  context: DesktopBridgeContext,
): ReadonlyArray<readonly [string, DesktopBridgeHandler]> {
  return [
    [
      desktopBridgeChannels.getDownloads,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        // Changes reach a window from its first read on, so a read never trails one.
        trackRenderer(context.downloadsSenders, event.sender);
        return DesktopDownloadsSnapshotSchema.parse(context.options.downloads.snapshot());
      },
    ],
    ...(["open", "show", "cancel"] as const).map(
      (action) =>
        [
          desktopBridgeChannels[`${action}Download`],
          async (event, envelope) => {
            assertAuthorizedRenderer(context, event, envelope);
            const { id } = DesktopDownloadTargetSchema.parse(envelope.input);
            return DesktopDownloadActionResultSchema.parse(
              await context.options.downloads[action](id),
            );
          },
        ] as const satisfies readonly [string, DesktopBridgeHandler],
    ),
  ];
}
