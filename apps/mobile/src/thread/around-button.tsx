import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { memo, type ReactElement, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ActingDot } from "../browser/acting-dot.js";
import { color, headerFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { aroundLabel, type AroundGlance } from "./around-model.js";

/**
 * A conversation's one trailing bar control: what is around it, in symbols,
 * marks and counts.
 *
 * iOS gets it as a custom bar item, so on iOS 26 UIKit draws it in the bar's
 * glass capsule; a plain button item could carry one symbol and a badge, not
 * the task marks that say whose work it is. Android gets the same view in
 * the bar's trailing slot. With nothing around, both slots are emptied: the
 * navigator merges options, so a slot left out would keep the last control.
 */
export function aroundHeaderOptions(control: ReactElement | null): NativeStackNavigationOptions {
  return {
    headerRight: () => control,
    unstable_headerRightItems: () =>
      control === null ? [] : [{ element: control, type: "custom" }],
  };
}

export const AroundButton = memo(function AroundButton(props: {
  readonly glance: AroundGlance;
  readonly onPress: () => void;
}): ReactNode {
  const { family, from } = props.glance;
  const earlierOnly = family !== null && family.running === 0 && family.earlier > 0;
  const label = aroundLabel(props.glance);
  return (
    <Pressable
      accessibilityHint="Shows the places, tasks and schedules around this conversation"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {from === null ? null : <Symbol name="arrow.up" size={14} tint={color.textSoft} />}
      {props.glance.places === 0 ? null : (
        <View style={styles.part}>
          <Symbol
            name={props.glance.placeGlyph ?? "rectangle.on.rectangle"}
            size={15}
            tint={color.text}
          />
          <Count>{props.glance.places}</Count>
          {props.glance.placesWorking === 0 ? null : <ActingDot grouped size={6} />}
        </View>
      )}
      {family === null || (family.running === 0 && !earlierOnly) ? null : (
        <View style={styles.part}>
          {earlierOnly ? (
            <Symbol name="checklist" size={15} tint={color.muted} />
          ) : (
            <View style={styles.marks}>
              {family.marks.map((mark, index) => (
                <View key={index} style={[styles.stacked, index === 0 ? null : styles.overlap]}>
                  <TaskMark mark={mark} size={16} />
                </View>
              ))}
            </View>
          )}
          <Count muted={earlierOnly}>{earlierOnly ? family.earlier : family.running}</Count>
          {family.needsYou ? <View style={styles.attention} /> : null}
        </View>
      )}
      {family === null || family.automations === 0 ? null : (
        <View style={styles.part}>
          <Symbol name="clock" size={14} tint={color.muted} />
          <Count muted>{family.automations}</Count>
        </View>
      )}
    </Pressable>
  );
});

function Count(props: { readonly children: number; readonly muted?: boolean }): ReactNode {
  return (
    <AppText
      maxFontSizeMultiplier={headerFontScaleLimit}
      role="caption"
      tone={props.muted === true ? "muted" : "default"}
    >
      {props.children}
    </AppText>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[6],
  },
  pressed: { opacity: 0.6 },
  part: { alignItems: "center", flexDirection: "row", gap: space[4] },
  marks: { alignItems: "center", flexDirection: "row" },
  // The web's cut-out: each tile keeps its edge where the next one overlaps it.
  stacked: { borderColor: color.background, borderRadius: 7, borderWidth: 2 },
  overlap: { marginLeft: -8 },
  attention: { backgroundColor: color.amber, borderRadius: radius.full, height: 6, width: 6 },
});
