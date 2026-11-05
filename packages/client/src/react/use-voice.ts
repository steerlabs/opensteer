import { createContext, useContext, useSyncExternalStore } from "react";
import { idleVoiceSnapshot, type VoiceControls } from "../voice/contract.js";

export const VoiceContext = createContext<VoiceControls | null>(null);

const noSubscribe = () => () => {};
const idleSnapshot = () => idleVoiceSnapshot;

export function useVoice() {
  const controller = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? idleSnapshot,
  );
  return { controller, snapshot };
}
