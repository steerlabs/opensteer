import * as Haptics from "expo-haptics";
import { useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color } from "../../theme.js";
import type { ReasoningSliderProps } from "./reasoning-slider.types.js";

const rail = 10;
const thumb = { height: 26, width: 40 };
const notch = 4;

/**
 * The web's slider at finger size: a recessed rail, a notch for every step and
 * a capsule thumb. A step is chosen by where the finger is along the row,
 * measured from the thumb's centre, so the ends are as easy to reach as the
 * middle, and applied when the finger lifts.
 */
export function ReasoningSlider(props: ReasoningSliderProps): ReactNode {
  const [width, setWidth] = useState(0);
  const [held, setHeld] = useState(false);
  const moved = useRef<number | null>(null);
  const last = props.steps.length - 1;
  const travel = Math.max(0, width - thumb.width);
  const centre = (step: number) => thumb.width / 2 + (step / last) * travel;
  const stepAt = (x: number) =>
    travel === 0
      ? 0
      : Math.max(0, Math.min(last, Math.round(((x - thumb.width / 2) / travel) * last)));
  const follow = (x: number) => {
    const step = stepAt(x);
    if (step === moved.current) return;
    moved.current = step;
    void Haptics.selectionAsync();
    props.onPreview(step);
  };
  const lift = (settle: boolean) => {
    const step = moved.current;
    moved.current = null;
    setHeld(false);
    if (settle && step !== null) props.onSettle(step);
    else props.onPreview(null);
  };
  return (
    <View
      accessible
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      accessibilityLabel={props.label}
      accessibilityRole="adjustable"
      accessibilityState={{ disabled: props.disabled }}
      accessibilityValue={{ min: 0, max: last, now: props.step ?? 0, text: props.valueText }}
      onAccessibilityAction={(event) => {
        if (props.disabled) return;
        const by = event.nativeEvent.actionName === "increment" ? 1 : -1;
        const step = props.step === null ? 0 : Math.max(0, Math.min(last, props.step + by));
        void Haptics.selectionAsync();
        props.onSettle(step);
      }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onMoveShouldSetResponder={() => !props.disabled}
      onResponderGrant={(event) => {
        moved.current = props.step;
        setHeld(true);
        follow(event.nativeEvent.locationX);
      }}
      onResponderMove={(event) => follow(event.nativeEvent.locationX)}
      onResponderRelease={() => lift(true)}
      onResponderTerminate={() => lift(false)}
      onStartShouldSetResponder={() => !props.disabled}
      style={[styles.slider, props.disabled && styles.disabled]}
    >
      {/* Drawing never takes the touch: a press on the thumb would report its
          position inside the thumb, not along the row. */}
      <View pointerEvents="none" style={styles.rail} />
      {props.step === null ? null : (
        <View
          pointerEvents="none"
          style={[styles.fill, { width: centre(props.step) + thumb.width / 2 }]}
        />
      )}
      {props.steps.map((_, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={[
            styles.notch,
            { left: centre(index) - notch / 2 },
            props.step !== null && index < props.step && styles.notchOn,
          ]}
        />
      ))}
      {props.step === null ? null : (
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            { left: centre(props.step) - thumb.width / 2 },
            held && styles.thumbHeld,
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.45 },
  fill: {
    backgroundColor: color.muted,
    borderRadius: rail / 2,
    height: rail,
    left: 0,
    position: "absolute",
  },
  notch: {
    backgroundColor: color.lineHover,
    borderRadius: notch / 2,
    height: notch,
    position: "absolute",
    width: notch,
  },
  notchOn: { backgroundColor: color.surface },
  rail: { backgroundColor: color.lineStrong, borderRadius: rail / 2, height: rail },
  slider: { justifyContent: "center", minHeight: 44 },
  thumb: {
    backgroundColor: color.text,
    borderRadius: thumb.height / 2,
    boxShadow: [{ blurRadius: 4, color: "rgba(0, 0, 0, 0.45)", offsetX: 0, offsetY: 1 }],
    height: thumb.height,
    position: "absolute",
    width: thumb.width,
  },
  thumbHeld: { transform: [{ scale: 1.12 }] },
});
