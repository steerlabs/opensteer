import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Whether the app is in front of the person: `AppState` is `active`. A picture
 * reads only while it is, so the system's switcher or a slid-down
 * notification pauses nothing it should not, and backgrounding stops it.
 */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return foreground;
}
