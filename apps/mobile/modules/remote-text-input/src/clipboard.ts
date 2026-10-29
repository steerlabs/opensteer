import type { EditingClipboardPayloadItem } from "@opensteer/client/editing";
import { editingClipboardMaxBytes, editingClipboardMaxItems } from "@opensteer/protocol/editing";
import * as Clipboard from "expo-clipboard";
import { encodeBase64 } from "./events.js";
export type MobileClipboardOutcome = "written" | "empty" | "refused" | "unsupported" | "too-large";
export interface MobileClipboardPort {
  write(items: readonly EditingClipboardPayloadItem[]): Promise<MobileClipboardOutcome>;
}
export function createMobileClipboardPort(): MobileClipboardPort {
  let pending: Promise<unknown> = Promise.resolve();
  const write = async (
    items: readonly EditingClipboardPayloadItem[],
  ): Promise<MobileClipboardOutcome> => {
    if (!items.length) return "empty";
    if (
      items.length > editingClipboardMaxItems ||
      items.reduce((n, item) => n + item.bytes.length, 0) > editingClipboardMaxBytes
    )
      return "too-large";
    const html = items.find((item) => item.type === "text/html");
    const text = items.find((item) => item.type === "text/plain");
    const image = items.find((item) => item.type === "image/png" || item.type === "image/jpeg");
    const formats = new Set(items.map((item) => item.type));
    if (
      formats.size !== items.length ||
      items.some(
        (item) => !["text/plain", "text/html", "image/png", "image/jpeg"].includes(item.type),
      ) ||
      (image !== undefined && items.length !== 1)
    )
      return "unsupported";
    try {
      if (html || text) {
        const selected = html ?? text!;
        return (await Clipboard.setStringAsync(
          new TextDecoder("utf-8", { fatal: true }).decode(selected.bytes),
          { inputFormat: html ? Clipboard.StringFormat.HTML : Clipboard.StringFormat.PLAIN_TEXT },
        ))
          ? "written"
          : "refused";
      }
      if (image) {
        await Clipboard.setImageAsync(encodeBase64(image.bytes));
        return "written";
      }
      return "unsupported";
    } catch {
      return "refused";
    }
  };
  return {
    write(items) {
      const result = pending.then(() => write(items));
      pending = result;
      return result;
    },
  };
}
