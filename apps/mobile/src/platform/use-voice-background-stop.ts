import { useEffect } from "react";
import { AppState } from "react-native";

/** Mount once beside the runtime's voice controller; stop also fences a pending start. */
export function useVoiceBackgroundStop(controller: { stop(): void | Promise<void> }): void {
  useEffect(() => {
    const stop = () => {
      void Promise.resolve(controller.stop()).catch(() => {});
    };
    if (AppState.currentState === "background") stop();
    const subscription = AppState.addEventListener("change", (state) => {
      // The first microphone prompt makes iOS inactive without backgrounding.
      if (state === "background") stop();
    });
    return () => subscription.remove();
  }, [controller]);
}
