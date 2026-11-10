import type { TaskMark as TaskMarkValue } from "@opensteer/client/host";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { memo, type ReactElement, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { ActingDot } from "../browser/acting-dot.js";
import { color, headerFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { aroundLabel, type AroundGlance } from "./around-model.js";

/** What Android's solid conversation bar is painted with, and so what cut-outs on it show. */
export const conversationBarGround = Platform.OS === "android" ? color.surface : color.background;

/**
 * What keeps a transparent bar's words apart from what scrolls under it — a
 * transcript, or an app. The route table paints every header with the
 * product's ground, so each answer says its own.
 */
export function barOverContentOptions(glass: boolean): NativeStackNavigationOptions {
  if (glass)
    return {
      headerStyle: { backgroundColor: "transparent" },
      // iOS 26's own answer, and it must not be combined with a blur: the two
      // effects stack and the bar doubles its own haze. The bottom edge is the
      // composer's or the content's own, so the system draws none there.
      scrollEdgeEffects: { bottom: "hidden", left: "automatic", right: "automatic", top: "soft" },
    };
  return Platform.OS === "ios"
    ? {
        headerBlurEffect: "systemChromeMaterialDark",
        headerStyle: { backgroundColor: "transparent" },
      }
    : { headerStyle: { backgroundColor: conversationBarGround } };
}

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
            <TaskMarks ground={conversationBarGround} marks={family.marks} />
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

/** Running tasks' marks, overlapped; `ground` is what each cut-out shows. */
export function TaskMarks(props: {
  readonly ground: string;
  readonly marks: readonly TaskMarkValue[];
}): ReactNode {
  return (
    <View style={styles.marks}>
      {props.marks.map((mark, index) => (
        <View
          key={index}
          style={[
            styles.stacked,
            { borderColor: props.ground },
            index === 0 ? null : styles.overlap,
          ]}
        >
          <TaskMark mark={mark} size={16} />
        </View>
      ))}
    </View>
  );
}

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
  stacked: { borderRadius: 7, borderWidth: 2 },
  overlap: { marginLeft: -8 },
  attention: { backgroundColor: color.amber, borderRadius: radius.full, height: 6, width: 6 },
});
