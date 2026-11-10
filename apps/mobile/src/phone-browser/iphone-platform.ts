import { Platform } from "react-native";
import type { IphoneAppsBridge } from "../platform/iphone-apps.js";
import { createIphoneBrowserConnection } from "../iphone-apps/browser-transport.js";
import { composeIphoneBrowserPort } from "./iphone-port.js";
import type { PhoneBrowserPlatform } from "./platform.js";

export function createIphoneBrowserPlatform(bridge: IphoneAppsBridge): PhoneBrowserPlatform | null {
  if (Platform.OS !== "ios") return null;
  const connection = createIphoneBrowserConnection();
  if (!connection) return null;
  const loadNativePort = async () => {
    const { phoneBrowser } = await import("../../modules/phone-browser/index.js");
    return composeIphoneBrowserPort(phoneBrowser, connection);
  };
  return {
    getEnrollment() {
      const snapshot = bridge.getSnapshot();
      return snapshot.supported && snapshot.enrollment?.state === "enrolled"
        ? snapshot.enrollment
        : null;
    },
    subscribeEnrollment: (listener) => bridge.subscribe(listener),
    loadNativePort,
    subscribeErasure: (listener) => connection.onErasure((event) => listener(event.deploymentId)),
    async retryErasure() {
      await loadNativePort();
      await connection.retryErasure();
    },
  };
}
