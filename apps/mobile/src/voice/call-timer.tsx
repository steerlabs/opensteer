import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { controlFontScaleLimit } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { useVoiceValue } from "./use-voice-value.js";

/** A call's length the way a phone shows it: 0:07, 12:40, 1:02:09. */
export function callClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The live call's clock. It owns its own tick, so only these digits redraw each second. */
export function CallTimer(): ReactNode {
  const since = useVoiceValue(({ since }) => since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [since]);
  if (since === null) return null;
  return (
    <AppText
      accessibilityLabel="On a call"
      maxFontSizeMultiplier={controlFontScaleLimit}
      numberOfLines={1}
      role="caption"
      style={styles.clock}
      tone="ember"
    >
      {callClock(now - since)}
    </AppText>
  );
}

const styles = StyleSheet.create({ clock: { fontVariant: ["tabular-nums"] } });
