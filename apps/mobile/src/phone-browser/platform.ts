import type { PhoneBrowserNativePort } from "./native-port.js";

export interface PhoneBrowserPlatform {
  getEnrollment(): { readonly deploymentId: string; readonly runnerId: string } | null;
  subscribeEnrollment(listener: () => void): () => void;
  loadNativePort(): Promise<PhoneBrowserNativePort>;
  subscribeErasure(listener: (deploymentId: string) => Promise<void>): () => void;
  retryErasure(): Promise<void>;
}
