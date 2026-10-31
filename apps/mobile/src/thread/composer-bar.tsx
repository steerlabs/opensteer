import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { LinearTransition, useReducedMotion } from "react-native-reanimated";
import { color, space, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { appear, duration, exit } from "../ui/motion.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import type { ComposerShape } from "./composer-model.js";

/**
 * The bar itself: one piece of glass at the bottom of the thread.
 *
 * At rest it is a capsule — `+`, the words, the trailing controls on one
 * line. Focused, or holding a draft, it opens into two: the words take the
 * whole width on top and the controls move to a toolbar underneath, with the
 * settings between them. The corner is the same 24 points in both shapes —
 * half the capsule's height, and the send circle's radius plus the gap around
 * it — so the bar grows without its corners ever changing.
 *
 * The field is never remounted between the two shapes: a TextInput that
 * remounts drops the keyboard mid-word. So the tree is fixed — the field's
 * line, then the toolbar — and only the toolbar's position changes. At rest it
 * lies over the field's line and the line leaves room at either end for what
 * the toolbar holds there; open, it sits below.
 *
 * It is glass because it floats over the transcript and the transcript keeps
 * moving under it. Where there is no Liquid Glass the same shape is the opaque
 * float material, and only the material differs.
 *
 * Nothing here decides anything. The bar is handed its slots already filled, so
 * the question of which control exists lives in `composer-model.ts` and the
 * question of what each control does lives in `composer.tsx`.
 */

/** The capsule's height: a 44-point control with two points of glass around it. */
const restHeight = 48;
const inset = (restHeight - touchTarget) / 2;
const composerBarRadius = restHeight / 2;

/** The height of the field's line at rest: a control's, so words and controls share a centre. */
export const composerLaneHeight = touchTarget;

/** One spring for the bar changing shape, quick enough never to be waited on. */
const reshape = LinearTransition.springify().damping(26).stiffness(320).mass(0.9);

export function ComposerBar(props: {
  /** The settings row, when the bar is open. Animated on its first arrival. */
  readonly accessory?: ReactNode;
  /** The trailing controls: the microphone, then send or stop. */
  readonly action?: ReactNode;
  /** A line above the field: what sending will decide, or why it cannot. */
  readonly caption?: ReactNode;
  readonly field: ReactNode;
  /** The `+` and its menu. */
  readonly leading?: ReactNode;
  readonly shape: ComposerShape;
}): ReactNode {
  const reduceMotion = useReducedMotion();
  // Anything in the toolbar's middle — the settings, or dictation's live bar —
  // needs the toolbar on its own line, or it would sit over the words.
  const open = props.shape === "rounded" || props.accessory !== undefined;
  // At rest the field's line keeps clear of what the toolbar holds at each end;
  // their widths change with the controls present (a microphone, stop or send).
  const [leadingWidth, setLeadingWidth] = useState(0);
  const [actionWidth, setActionWidth] = useState(0);
  const motion = reduceMotion ? {} : { layout: reshape };
  return (
    <Animated.View {...motion} style={styles.frame}>
      <GlassSurface radius={composerBarRadius} style={styles.bar} tint={color.floatTint}>
        {props.caption === undefined ? null : <View style={styles.caption}>{props.caption}</View>}
        <Animated.View
          {...motion}
          style={
            open
              ? styles.fieldOpen
              : [styles.fieldRest, { paddingLeft: leadingWidth, paddingRight: actionWidth }]
          }
        >
          {props.field}
        </Animated.View>
        <Animated.View
          {...motion}
          pointerEvents="box-none"
          style={[styles.toolbar, !open && styles.toolbarRest]}
        >
          <View onLayout={(event) => setLeadingWidth(event.nativeEvent.layout.width)}>
            {props.leading}
          </View>
          <View pointerEvents="box-none" style={styles.middle}>
            {props.accessory === undefined ? null : (
              <Animated.View
                {...(reduceMotion ? {} : { entering: appear.delay(duration.exit), exiting: exit })}
              >
                {props.accessory}
              </Animated.View>
            )}
          </View>
          <View onLayout={(event) => setActionWidth(event.nativeEvent.layout.width)}>
            {props.action}
          </View>
        </Animated.View>
      </GlassSurface>
    </Animated.View>
  );
}

/**
 * A control's glyph, bare in its 44-point target the way the system draws a
 * toolbar's: the glass around it is already the button's ground.
 */
export function ComposerGlyph(props: {
  readonly icon: SFSymbolName;
  readonly muted?: boolean;
}): ReactNode {
  return (
    <View style={[styles.glyph, props.muted === true && styles.glyphMuted]}>
      <Symbol name={props.icon} size={21} tint={color.text} weight="medium" />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderColor: color.lineStrong,
    borderRadius: composerBarRadius,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: restHeight,
    overflow: "hidden",
  },
  caption: { paddingHorizontal: space[14], paddingTop: space[10] },
  fieldOpen: { paddingHorizontal: space[14], paddingTop: space[10] },
  fieldRest: { minHeight: restHeight, paddingVertical: inset },
  frame: { borderRadius: composerBarRadius },
  glyph: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  glyphMuted: { opacity: 0.45 },
  // Between the ends at rest nothing is drawn, and a touch there reaches the field.
  middle: { flex: 1, justifyContent: "center", minWidth: 0 },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: touchTarget,
    paddingBottom: inset,
    paddingHorizontal: inset,
  },
  toolbarRest: {
    bottom: 0,
    left: 0,
    paddingTop: inset,
    position: "absolute",
    right: 0,
  },
});
