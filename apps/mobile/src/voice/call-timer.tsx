import { callClock } from "@opensteer/client/voice";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { controlFontScaleLimit } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { useVoiceValue } from "./use-voice-value.js";

/** The live call's clock. It owns its own tick, so only these digits redraw each second. */
export function CallTimer(props: { readonly tone?: "ember" | "muted" }): ReactNode {
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
      tone={props.tone ?? "ember"}
    >
      {callClock(now - since)}
    </AppText>
  );
}

const styles = StyleSheet.create({ clock: { fontVariant: ["tabular-nums"] } });
