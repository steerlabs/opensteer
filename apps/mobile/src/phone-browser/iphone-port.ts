import { BrowserActionErrorCodeSchema } from "@opensteer/protocol/browser-actions";
import type { PhoneBrowserNativePort as WebViewPort } from "../../modules/phone-browser/types.js";
import type { IphoneBrowserConnectionPort } from "../iphone-apps/browser-transport.js";
import { phoneBrowserDescriptor } from "./descriptor.js";
import {
  PhoneBrowserError,
  type PhoneBrowserNativeEvent,
  type PhoneBrowserNativePort,
} from "./native-port.js";

export function composeIphoneBrowserPort(
  views: Omit<WebViewPort, "onEvent"> & Pick<PhoneBrowserNativePort, "onEvent">,
  connection: IphoneBrowserConnectionPort,
): PhoneBrowserNativePort {
  const unsupported = async (): Promise<never> => {
    throw new PhoneBrowserError(
      "unsupported-operation",
      "This browser uses typed actions, not CDP.",
    );
  };
  const invoke = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try {
      return await operation();
    } catch (error) {
      const code = BrowserActionErrorCodeSchema.safeParse(
        error instanceof Error && "code" in error ? error.code : undefined,
      );
      if (code.success)
        throw new PhoneBrowserError(code.data, "The native browser refused the operation.");
      throw error;
    }
  };
  return {
    ...views,
    async initialize(input) {
      const qualification = await invoke(() => views.initialize(input));
      const descriptor = phoneBrowserDescriptor(qualification);
      if (descriptor) await connection.configure({ ...input, descriptor });
      return qualification;
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
          if (
            event.type === "relayCommand" &&
            event.message.type === "browser.client-message" &&
            event.message.message.type === "agent.action"
          ) {
            void operation.catch(() => undefined);
          } else await operation;
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
    attachAgent: (input) => invoke(() => connection.attachAgent(input)),
    detachAgent: (input) => invoke(() => connection.detachAgent(input)),
    performAction: (input) => invoke(() => views.performAction(input)),
    applyViewerInput: (input) => invoke(() => views.applyViewerInput(input)),
    authorizeCdp: unsupported,
    openCdpPipe: unsupported,
    sendCdp: unsupported,
    closeCdpPipe: unsupported,
    releaseCdp: unsupported,
  };
}
