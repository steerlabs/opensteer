import { requireOptionalNativeModule } from "expo";
import type { NotificationPreviewNative } from "./types.js";
export type { NotificationPreviewNative, PreviewKey } from "./types.js";
export const notificationPreviewNative = requireOptionalNativeModule<NotificationPreviewNative>(
  "OpensteerNotificationPreview",
);
