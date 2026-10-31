export interface PreviewKey {
  readonly keyId: string;
  readonly key: string;
}
export interface NotificationPreviewNative {
  readonly notificationPreviewVersion: number;
  prepare(): Promise<void>;
  key(deploymentId: string): Promise<PreviewKey>;
  erase(deploymentId: string | null): Promise<void>;
}
