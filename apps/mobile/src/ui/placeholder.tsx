import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme.js";
import { AppText } from "./primitives.js";

/**
 * A section whose content never arrived, drawn still in its real shape: never
 * a fake empty list and never connection words. Nothing shimmers, because a
 * shimmer redraws forever and reads as loading forever.
 */
const bars = [
  [60, 35],
  [55, 30],
  [62, 38],
] as const;

export function PlaceholderRows(props: {
  readonly count?: number;
  /** The real row's height, so the content lands without moving anything. */
  readonly rowHeight?: number;
  readonly accessibilityLabel?: string;
}): ReactNode {
  const count = props.count ?? 3;
  return (
    <View accessibilityLabel={props.accessibilityLabel ?? "Not loaded yet"} accessible>
      {Array.from({ length: count }, (_, index) => {
        const [first, second] = bars[index % bars.length] ?? bars[0];
        return (
          <View
            key={index}
            style={[
              styles.row,
              { minHeight: props.rowHeight ?? defaultRowHeight },
              index > 0 && styles.separated,
            ]}
          >
            <View style={styles.square} />
            <View style={styles.lines}>
              <View style={[styles.bar, { width: `${first}%` }]} />
              <View style={[styles.bar, { width: `${second}%` }]} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A setting's value that was never loaded. */
export function PlaceholderValue(props: { readonly accessibilityLabel?: string }): ReactNode {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel ?? "Not loaded yet"}
      accessible
      style={[styles.bar, styles.value]}
    />
  );
}

/** A switch whose state was never loaded: a track with no knob, never "off". */
export function UnknownToggle(props: { readonly accessibilityLabel: string }): ReactNode {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="switch"
      accessibilityState={{ disabled: true }}
      accessibilityValue={{ text: "Not loaded yet" }}
      accessible
      style={styles.track}
    />
  );
}

/** A detail value, such as a count, that was never loaded. */
export function UnknownValue(props: { readonly accessibilityLabel?: string }): ReactNode {
  return (
    <AppText accessibilityLabel={props.accessibilityLabel ?? "Not loaded yet"} tone="muted">
      –
    </AppText>
  );
}

const defaultRowHeight = 52;

const styles = StyleSheet.create({
  bar: { backgroundColor: color.surfaceRaised, borderRadius: radius.full, height: 10 },
  lines: { flex: 1, gap: space[8] },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  separated: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  square: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xs,
    height: 26,
    width: 26,
  },
  // The platform switch's own track, so the row does not change when the value arrives.
  track: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: Platform.OS === "ios" ? 31 : 20,
    opacity: 0.4,
    width: Platform.OS === "ios" ? 51 : 36,
  },
  value: { width: 56 },
});
