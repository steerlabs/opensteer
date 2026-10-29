import { z } from "zod";
import { editingClipboardMaxBytes } from "@opensteer/protocol/editing";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";

const itemsSchema = z
  .array(
    z.strictObject({
      type: z.enum(["text/plain", "text/html", "image/png"]),
      bytes: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength <= editingClipboardMaxBytes),
    }),
  )
  .min(1)
  .max(3)
  .refine(
    (items) =>
      items.reduce((sum, item) => sum + item.bytes.byteLength, 0) <= editingClipboardMaxBytes &&
      new Set(items.map((item) => item.type)).size === items.length,
  );

export function viewerClipboardHandlers(
  context: DesktopBridgeContext,
): readonly (readonly [string, DesktopBridgeHandler])[] {
  return [
    [
      desktopBridgeChannels.pasteViewerClipboard,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        event.sender.paste();
      },
    ],
    [
      desktopBridgeChannels.writeViewerClipboard,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        const items = itemsSchema.parse(envelope.input);
        const { clipboard, ClipboardItem } = await import("electron");
        const output: Record<string, Blob> = {};
        for (const item of items)
          output[item.type] = new Blob([new Uint8Array(item.bytes)], { type: item.type });
        await clipboard.write([new ClipboardItem(output)]);
        context.options.log?.("viewer.clipboard", { outcome: "written", items: items.length });
      },
    ],
    [
      desktopBridgeChannels.setViewerKeyboardActive,
      (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        event.sender.setIgnoreMenuShortcuts(z.boolean().parse(envelope.input));
      },
    ],
  ];
}
