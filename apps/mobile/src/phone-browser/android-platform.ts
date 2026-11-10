import { Platform } from "react-native";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  androidPhoneBridge,
  phoneConnection,
  retryPhoneRetirement,
  setPhoneRetirementHandler,
} from "../platform/phone-connection.js";
import { composeAndroidBrowserPort } from "./android-port.js";
import type { PhoneBrowserPlatform } from "./platform.js";

export function createAndroidBrowserPlatform(): PhoneBrowserPlatform | null {
  const bridge = androidPhoneBridge;
  if (Platform.OS !== "android" || !bridge) return null;
  const loadViews = () => import("../../modules/phone-browser/index.js");
  const registered = async () => {
    await loadViews();
    let stop = () => {};
    try {
      await withTimeout(
        new Promise<void>((resolve) => {
          const changed = () => {
            if (bridge.getSnapshot().supported) resolve();
          };
          stop = bridge.subscribe(changed);
          changed();
        }),
        10_000,
        { timeoutError: () => new Error("This phone's browser did not become available.") },
      );
    } finally {
      stop();
    }
  };
  return {
    getEnrollment() {
      return bridge.getSnapshot().enrollment;
    },
    subscribeEnrollment: (listener) => bridge.subscribe(listener),
    async loadNativePort() {
      await registered();
      await retryPhoneRetirement();
      const enrollment = bridge.getSnapshot().enrollment;
      if (!enrollment) throw new Error("This phone is not enrolled.");
      const prepared = await bridge.prepare({ deploymentId: enrollment.deploymentId });
      if (prepared.runnerId !== enrollment.runnerId)
        throw new Error("This phone's enrollment changed.");
      const { phoneBrowser } = await loadViews();
      return composeAndroidBrowserPort(phoneBrowser, phoneConnection);
    },
    subscribeErasure: setPhoneRetirementHandler,
    async retryErasure() {
      await registered();
      await retryPhoneRetirement();
    },
  };
}
