import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { color, radius } from "../theme.js";

/**
 * Glass, and the opaque surface that stands in for it.
 *
 * The fallback is not a nicety: Liquid Glass exists on iOS 26 and nowhere
 * else, so iOS 18 and every Android build are half the platforms this app
 * ships to and they need a real answer rather than a degraded one. The
 * fallback is `surfaceElevated` with a hairline — the same shape the rest of
 * the app draws a control's edge with — so a composer or a pill reads as the
 * same object on both.
 *
 * Glass is chrome and never holds primary content. It belongs to a composer's
 * capsule, a header's capsule, a jump-to-latest pill: things that float over
 * the transcript and want to show what is under them. A material that samples
 * whatever is behind it cannot promise a contrast ratio, so anything a person
 * has to read sits on an opaque surface instead.
 */

export type GlassShape = "capsule" | "rounded";

export function GlassSurface(props: {
  readonly children: ReactNode;
  /**
   * The ground to use where there is no glass. `elevated` is the floating
   * chrome's own step above the page; `surface` is the quieter one, for glass
   * that sits inside a group rather than over the transcript.
   */
  readonly fallback?: "elevated" | "surface";
  /** Glass that deforms under a touch. Only for chrome a finger acts on. */
  readonly interactive?: boolean;
  readonly radius?: number;
  readonly shape?: GlassShape;
  readonly style?: StyleProp<ViewStyle>;
  readonly tint?: string;
}): ReactNode {
  const shape = props.shape ?? "rounded";
  // A capsule's radius is whatever exceeds half its height; the platform
  // clamps it, so one number serves every bar height this shape is used at.
  const corner = props.radius ?? (shape === "capsule" ? radius.full : radius.lg);

  if (useLiquidGlass()) {
    return (
      <GlassView
        // Dark only — there is no light palette for the material to follow, so
        // it is told the scheme rather than reading a system appearance this
        // app never honours.
        colorScheme="dark"
        // `regular` is the material that stays legible over arbitrary content;
        // `clear` is for glass over imagery the person is meant to keep seeing.
        glassEffectStyle="regular"
        isInteractive={props.interactive ?? false}
        style={[{ borderRadius: corner }, props.style]}
        {...(props.tint === undefined ? {} : { tintColor: props.tint })}
      >
        {props.children}
      </GlassView>
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        props.fallback === "surface" ? styles.fallbackSurface : styles.fallbackElevated,
        { borderRadius: corner },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

/** Asked once per process and kept: see `useLiquidGlass`. */
let liquidGlass: boolean | null = null;

/**
 * Whether this build draws real glass.
 *
 * The answer cannot change while the process lives — it is the SDK the binary
 * was linked against and the system it was launched on — so it crosses the
 * native bridge once instead of on every render of every capsule. The Android
 * and web builds of `expo-glass-effect` answer `false` outright, which is why
 * there is no `Platform` branch here to keep in step with them.
 *
 * `isGlassEffectAPIAvailable` joins the answer because some iOS 26 betas ship
 * the design without the view API, and constructing a `GlassView` on one of
 * them crashes (expo/expo#40911).
 */
export function useLiquidGlass(): boolean {
  liquidGlass ??= isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  return liquidGlass;
}

const styles = StyleSheet.create({
  fallback: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  fallbackElevated: { backgroundColor: color.surfaceElevated, borderColor: color.lineStrong },
  fallbackSurface: { backgroundColor: color.surface, borderColor: color.line },
});
