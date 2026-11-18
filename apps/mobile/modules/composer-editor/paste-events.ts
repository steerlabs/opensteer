import { type NativeModule, requireOptionalNativeModule } from "expo";
import type { PastedImages } from "./index.js";

export interface DraftPaste {
  readonly target: string;
  readonly pasted: PastedImages;
}
type DraftPasteModule = InstanceType<
  typeof NativeModule<{ onDraftPaste: (event: DraftPaste) => void }>
> & { readonly draftPasteVersion?: number };
let pasteModule: DraftPasteModule | null | undefined;

function draftPasteModule(): DraftPasteModule | null {
  if (pasteModule === undefined) {
    try {
      const native = requireOptionalNativeModule<DraftPasteModule>("OpensteerComposerEditor");
      pasteModule = native?.draftPasteVersion === 1 ? native : null;
    } catch {
      pasteModule = null;
    }
  }
  return pasteModule;
}

export function supportsDraftPastes(): boolean {
  return draftPasteModule() !== null;
}

export function subscribeToDraftPastes(listener: (event: DraftPaste) => void): () => void {
  const subscription = draftPasteModule()?.addListener("onDraftPaste", listener);
  return () => subscription?.remove();
}
