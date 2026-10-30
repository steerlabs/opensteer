import { useSyncExternalStore } from "react";
import type { VoiceController, VoiceSnapshot } from "../voice/index.js";

const unavailable: VoiceSnapshot = {
  available: false,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: null,
  notice: null,
};
const subscribe = () => () => {};
const getSnapshot = () => unavailable;

export function useVoiceSnapshot(controller: VoiceController | null): VoiceSnapshot {
  return useSyncExternalStore(
    controller?.subscribe ?? subscribe,
    controller?.getSnapshot ?? getSnapshot,
    controller?.getSnapshot ?? getSnapshot,
  );
}
