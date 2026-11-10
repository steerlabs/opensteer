import { type NativeModule, requireNativeModule, requireNativeView } from "expo";
import type * as Browser from "./types";

export type * from "./types";

type PhoneBrowserModule = InstanceType<
  typeof NativeModule<{
    event: (event: Browser.PhoneBrowserNativeEvent) => void;
  }>
> &
  Omit<Browser.PhoneBrowserNativePort, "onEvent">;

const native = requireNativeModule<PhoneBrowserModule>("PhoneBrowser");
export const phoneBrowser: Browser.PhoneBrowserNativePort = {
  initialize: (input) => native.initialize(input),
  fence: (reason) => native.fence(reason),
  setForeground: (input) => native.setForeground(input),
  ensureProfile: (input) => native.ensureProfile(input),
  listProfiles: (input) => native.listProfiles(input),
  eraseProfile: (input) => native.eraseProfile(input),
  eraseDeployment: (input) => native.eraseDeployment(input),
  createTab: (input) => native.createTab(input),
  destroyTab: (input) => native.destroyTab(input),
  suspendTab: (input) => native.suspendTab(input),
  resumeTab: (input) => native.resumeTab(input),
  mountTab: (input) => native.mountTab(input),
  unmountTab: (input) => native.unmountTab(input),
  resizeTab: (input) => native.resizeTab(input),
  navigate: (input) => native.navigate(input),
  respondDialog: (input) => native.respondDialog(input),
  respondUpload: (input) => native.respondUpload(input),
  performAction: (input) => native.performAction(input),
  applyViewerInput: (input) => native.applyViewerInput(input),
  setCaptureDemand: (input) => native.setCaptureDemand(input),
  ackFrame: (input) => native.ackFrame(input),
  captureOnce: (input) => native.captureOnce(input),
  stageChunk: (input) => native.stageChunk(input),
  finishSessionFiles: (input) => native.finishSessionFiles(input),
  cancelDownload: (input) => native.cancelDownload(input),
  onEvent(listener) {
    let pending = Promise.resolve();
    let active = true;
    const subscription = native.addListener("event", (event) => {
      pending = pending
        .then(async () => {
          if (active) await listener(event);
        })
        .catch((error: unknown) => {
          console.error(
            "Phone browser event handler failed",
            error instanceof Error ? error.name : "unknown",
          );
        });
    });
    return () => {
      active = false;
      subscription.remove();
    };
  },
};
export const PhoneBrowserHost = requireNativeView<Browser.PhoneBrowserHostProps>(
  "PhoneBrowser",
  "PhoneBrowserHost",
);
export const PhoneBrowserPicture = requireNativeView<Browser.PhoneBrowserPictureProps>(
  "PhoneBrowser",
  "PhoneBrowserPicture",
);
export const PhoneBrowserDownload = requireNativeView<Browser.PhoneBrowserDownloadProps>(
  "PhoneBrowser",
  "PhoneBrowserDownload",
);
