import { Host, Slider } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityValue,
  disabled,
  opacity,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useRef, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { color } from "../../theme.js";
import type { ReasoningSliderProps } from "./reasoning-slider.types.js";

/**
 * The system's own stepped slider: on iOS 26 its thumb turns to Liquid Glass
 * while held, it draws a tick for every step, and it plays its own haptic at
 * each one, so this adds none.
 */
export function ReasoningSlider(props: ReasoningSliderProps): ReactNode {
  const editing = useRef(false);
  // The step under the finger, applied when the finger lifts.
  const moved = useRef<number | null>(null);
  return (
    <Host colorScheme="dark" matchContents={{ vertical: true }} style={styles.host}>
      <Slider
        max={props.steps.length - 1}
        min={0}
        modifiers={[
          tint(color.textSoft),
          accessibilityLabel(props.label),
          accessibilityValue(props.valueText),
          disabled(props.disabled),
          // While the engine chooses there is no step to point at.
          opacity(props.step === null ? 0.45 : 1),
        ]}
        onEditingChanged={(isEditing) => {
          editing.current = isEditing;
          if (isEditing) return;
          const step = moved.current;
          moved.current = null;
          if (step === null) props.onPreview(null);
          else props.onSettle(step);
        }}
        onValueChange={(value) => {
          const step = Math.round(value);
          if (!editing.current) {
            // VoiceOver adjusts without a drag: each adjustment is final.
            props.onSettle(step);
            return;
          }
          moved.current = step;
          props.onPreview(step);
        }}
        step={1}
        value={props.step ?? 0}
      />
    </Host>
  );
}

const styles = StyleSheet.create({ host: { alignSelf: "stretch" } });
