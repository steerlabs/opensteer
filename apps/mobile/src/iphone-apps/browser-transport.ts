import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { RunnerBrowserModule } from "@opensteer/protocol";
import type {
  Epoch,
  PhoneBrowserNativeEvent,
  PhoneBrowserNativePort,
} from "../phone-browser/native-port.js";

type ConnectionMethods = Pick<
  PhoneBrowserNativePort,
  "verifyAttach" | "commitAttach" | "sendRelay" | "closeChannel" | "attachAgent" | "detachAgent"
>;

export interface IphoneBrowserConnectionPort extends ConnectionMethods {
  configure(
    input: Epoch & { deploymentId: string; runnerId: string; descriptor: RunnerBrowserModule },
  ): Promise<void>;
  fence(reason: string): number;
  setForeground: PhoneBrowserNativePort["setForeground"];
  onEvent(listener: (event: PhoneBrowserNativeEvent) => Promise<void>): () => void;
  onErasure(
    listener: (event: { deploymentId: string; epoch: number }) => Promise<void>,
  ): () => void;
  retryErasure(): Promise<void>;
}

interface NativeTransport extends ConnectionMethods {
  configureBrowser: IphoneBrowserConnectionPort["configure"];
  fenceBrowser(reason: string): number;
  setBrowserForeground: PhoneBrowserNativePort["setForeground"];
  retryBrowserErasure(): Promise<void>;
  addListener(
    event: "onBrowserEvent",
    listener: (event: PhoneBrowserNativeEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onBrowserErasure",
    listener: (event: { deploymentId: string; epoch: number }) => void,
  ): { remove(): void };
}

export function createIphoneBrowserConnection(): IphoneBrowserConnectionPort | null {
  if (Platform.OS !== "ios") return null;
  const native = requireOptionalNativeModule<NativeTransport>("IphoneApps");
  if (!native?.configureBrowser) return null;
  return {
    configure: (input) => native.configureBrowser(input),
    fence: (reason) => native.fenceBrowser(reason),
    setForeground: (input) => native.setBrowserForeground(input),
    verifyAttach: (input) => native.verifyAttach(input),
    commitAttach: (input) => native.commitAttach(input),
    sendRelay: (input) => native.sendRelay(input),
    closeChannel: (input) => native.closeChannel(input),
    attachAgent: (input) => native.attachAgent(input),
    detachAgent: (input) => native.detachAgent(input),
    onEvent: (listener) => {
      let turn = Promise.resolve();
      const subscription = native.addListener("onBrowserEvent", (event) => {
        turn = turn.then(() => listener(event)).catch(() => undefined);
      });
      return () => subscription.remove();
    },
    onErasure: (listener) => {
      const subscription = native.addListener("onBrowserErasure", (event) => {
        void listener(event)
          .catch(() => undefined)
          .then(() => native.retryBrowserErasure())
          .catch(() => undefined);
      });
      return () => subscription.remove();
    },
    retryErasure: () => native.retryBrowserErasure(),
  };
}
