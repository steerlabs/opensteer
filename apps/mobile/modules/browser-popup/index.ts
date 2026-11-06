import { requireOptionalNativeModule } from "expo";
import type { BrowserPopupAnswer, BrowserPopupState } from "@opensteer/protocol";
export interface BrowserPopupNativeAction {
  presentationId: string;
  revision: string;
  action: "commit" | "cancel";
  answer?: BrowserPopupAnswer;
}
export interface BrowserPopupNative {
  readonly popupPresentationVersion: number;
  present(
    presentationId: string,
    revision: string,
    state: BrowserPopupState & { notice?: string },
  ): Promise<boolean>;
  update(
    presentationId: string,
    revision: string,
    state: BrowserPopupState & { notice?: string },
  ): Promise<boolean>;
  dismiss(presentationId: string): Promise<void>;
  addListener(
    name: "onAction",
    listener: (event: BrowserPopupNativeAction) => void,
  ): { remove(): void };
}
let module: BrowserPopupNative | null | undefined;
export function browserPopupNative(): BrowserPopupNative | null {
  if (module === undefined) {
    try {
      module = requireOptionalNativeModule<BrowserPopupNative>("BrowserPopup");
    } catch {
      module = null;
    }
  }
  return module?.popupPresentationVersion === 1 ? module : null;
}
