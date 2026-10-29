import type { EditingClipboardPayloadItem } from "./types.js";

/** Optional desktop platform capabilities; browser and Expo adapters need no Node APIs. */
export interface ViewerClipboardBridge {
  writeViewerClipboard(items: readonly EditingClipboardPayloadItem[]): Promise<void>;
  setViewerKeyboardActive(active: boolean): Promise<void>;
  pasteViewerClipboard(): Promise<void>;
}
