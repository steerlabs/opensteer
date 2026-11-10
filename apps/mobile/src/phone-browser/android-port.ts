import { BrowserActionErrorCodeSchema } from "@opensteer/protocol/browser-actions";
import type { PhoneBrowserNativePort as WebViewPort } from "../../modules/phone-browser/types.js";
import type { PhoneConnectionPort } from "../platform/phone-connection.js";
import {
  PhoneBrowserError,
  type PhoneBrowserNativeEvent,
  type PhoneBrowserNativePort,
} from "./native-port.js";

export function composeAndroidBrowserPort(
  views: Omit<WebViewPort, "onEvent"> & Pick<PhoneBrowserNativePort, "onEvent">,
  connection: PhoneConnectionPort,
): PhoneBrowserNativePort {
  const invoke = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try {
      return await operation();
    } catch (error) {
      const code = BrowserActionErrorCodeSchema.safeParse(
        error instanceof Error && "code" in error ? error.code : undefined,
      );
      if (code.success && error instanceof Error)
        throw new PhoneBrowserError(code.data, error.message);
      throw error;
    }
  };
  return {
    ...views,
    async initialize(input) {
      await invoke(() => views.initialize(input));
      return invoke(() => connection.initialize(input));
    },
    fence: (reason) => connection.fence(reason),
    async setForeground(input) {
      if (input.active) {
        await views.setForeground(input);
        await connection.setForeground(input);
      } else {
        await connection.setForeground(input);
        await views.setForeground(input);
      }
    },
    onEvent(listener) {
      let active = true;
      let pending = Promise.resolve();
      const receive = (event: PhoneBrowserNativeEvent): Promise<void> => {
        const next = pending.then(async () => {
          if (!active) return;
          const operation = listener(event);
          if (event.type === "relayCommand") void operation.catch(() => undefined);
          else await operation;
        });
        pending = next.catch(() => undefined);
        return next;
      };
      const stopViews = views.onEvent(receive);
      const stopConnection = connection.onEvent(receive);
      return () => {
        active = false;
        stopViews();
        stopConnection();
      };
    },
    verifyAttach: (input) => invoke(() => connection.verifyAttach(input)),
    commitAttach: (input) => invoke(() => connection.commitAttach(input)),
    sendRelay: (input) => invoke(() => connection.sendRelay(input)),
    closeChannel: (input) => invoke(() => connection.closeChannel(input)),
    applyViewerInput: (input) => invoke(() => views.applyViewerInput(input)),
    attachAgent: (input) => invoke(() => views.attachAgent(input)),
    detachAgent: (input) => invoke(() => views.detachAgent(input)),
    authorizeCdp: (input) => invoke(() => views.authorizeCdp(input)),
    openCdpPipe: (input) => invoke(() => views.openCdpPipe(input)),
    sendCdp: (input) => invoke(() => views.sendCdp(input)),
    closeCdpPipe: (input) => invoke(() => views.closeCdpPipe(input)),
    releaseCdp: (input) => invoke(() => views.releaseCdp(input)),
  };
}
