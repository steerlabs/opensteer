import { requireOptionalNativeModule } from "expo";
export interface PreviewKey {
  readonly keyId: string;
  readonly key: string;
}
export interface NotificationPreviewNative {
  readonly notificationPreviewVersion: number;
  deployments(): Promise<readonly string[]>;
  prepare(): Promise<void>;
  existing(deploymentId: string): Promise<PreviewKey | null>;
  key(deploymentId: string): Promise<PreviewKey>;
  erase(deploymentId: string | null): Promise<void>;
}
export const notificationPreviewNative = requireOptionalNativeModule<NotificationPreviewNative>(
  "OpensteerNotificationPreview",
);
