import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { barHeight, color, radius, space, touchTarget } from "../theme.js";
import { GlassSurface, useLiquidGlass } from "../ui/glass.js";
import { appear, exit } from "../ui/motion.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import type { ComposerShape } from "./composer-model.js";

/**
 * The bar itself: one capsule at the bottom of the thread, and nothing else.
 *
 * It is glass because it floats over the transcript and the transcript keeps
 * moving under it — the navigation layer is the one place the material belongs.
 * On a near-black ground glass samples almost nothing, so it is given a floor
 * (a tint of the elevated surface) and a findable edge (a full point of the
 * control line), and on every platform without Liquid Glass the same geometry
 * is drawn in the opaque surface instead. Only the material differs.
 *
 * The corner is 22 in both states, which is a capsule at the 44-point rest
 * height and stays concentric with the 16-point pills when the bar grows: a
 * pill's radius plus the six points of padding around it is the bar's own.
 *
 * Nothing here decides anything. The bar is handed its slots already filled, so
 * the question of which control exists lives in `composer-model.ts` and the
 * question of what each control does lives in `composer.tsx`.
 */

/** A control drawn at 34 points inside the 44 its finger needs. */
export const composerControlStyle: ViewStyle = { marginVertical: -space[4] };

/**
 * The height of the row's line inside the bar's padding. A control's 44-point
 * box overhangs it equally above and below, so the middle of this lane is the
 * middle of every control — and a field centred in it is level with them.
 */
export const composerLaneHeight = barHeight - space[4] * 2;

export function ComposerBar(props: {
  /** The settings row, when the bar is open. Animated on its first arrival. */
  readonly accessory?: ReactNode;
  /** The one round control: send, or stop. */
  readonly action?: ReactNode;
  /** A line above the field: what sending will decide, or why it cannot. */
  readonly caption?: ReactNode;
  readonly field: ReactNode;
  /** The `+` and its menu. */
  readonly leading?: ReactNode;
  readonly shape: ComposerShape;
}): ReactNode {
  const glass = useLiquidGlass();
  const reduceMotion = useReducedMotion();
  return (
    <GlassSurface
      radius={props.shape === "capsule" ? radius.full : composerBarRadius}
      shape={props.shape}
      style={[styles.bar, glass ? styles.glassEdge : null]}
      tint={glassTint}
    >
      <View>
        {props.caption === undefined ? null : <View style={styles.caption}>{props.caption}</View>}
        <View style={styles.row}>
          {props.leading}
          {props.field}
          {props.action}
        </View>
        {props.accessory === undefined ? null : (
          <Animated.View
            style={styles.accessory}
            {...(reduceMotion ? {} : { entering: appear, exiting: exit })}
          >
            {props.accessory}
          </Animated.View>
        )}
      </View>
    </GlassSurface>
  );
}

/** The `+`: a 34-point circle in the 44 points a thumb is allowed. */
export function ComposerCircleFace(props: {
  readonly icon: SFSymbolName;
  readonly muted?: boolean;
}): ReactNode {
  return (
    <View style={styles.controlBox}>
      <View style={[styles.circle, props.muted === true && styles.circleMuted]}>
        <Symbol name={props.icon} size={17} tint={color.textSoft} weight="medium" />
      </View>
    </View>
  );
}

/**
 * 22 = the pill's 16-point radius plus the 6 points of bar around it, which is
 * also half the bar's rest height — so one number is both the capsule and the
 * concentric corner.
 */
const composerBarRadius = 22;

/** The elevated surface at 60%: a floor under glass that would sample #080808. */
const glassTint = "rgba(23, 23, 23, 0.6)";

const styles = StyleSheet.create({
  accessory: { paddingHorizontal: space[6] },
  bar: { minHeight: barHeight, overflow: "hidden" },
  // The same left edge as the settings row: the bar's two quiet lines line up
  // with each other rather than each with a different thing.
  caption: { paddingHorizontal: space[6], paddingTop: space[8] },
  circle: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: radius.full,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  circleMuted: { opacity: 0.45 },
  controlBox: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  glassEdge: { borderColor: color.lineStrong, borderWidth: 1 },
  // Bottom-aligned, the way every composer that grows upward is: the controls
  // stay on the last line of what is being typed rather than drifting up with
  // the field's middle.
  row: {
    alignItems: "flex-end",
    flexDirection: "row",
    minHeight: barHeight,
    paddingHorizontal: space[4],
    paddingVertical: space[4],
  },
});
