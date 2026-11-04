import type { VoiceLevels, VoicePhase, VoiceSnapshot } from "@opensteer/client/voice";
import { useIsFocused } from "@react-navigation/native";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  ZoomIn,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, material, radius, space } from "../theme.js";
import { ComposerGlyph } from "../thread/composer-bar.js";
import { activitySymbol } from "../ui/activity-symbol.js";
import { appear, enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { usePaneInView } from "../ui/pane.js";
import { Symbol } from "../ui/symbol.js";

/** What the voice UI drives: the runtime's one `VoiceController`. */
export interface VoiceControls {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSnapshot;
  subscribeLevel(listener: (levels: VoiceLevels) => void): () => void;
  /** Fires when the call's agent changed the screen. */
  subscribeShown?(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): unknown;
  setMuted(muted: boolean): void;
  dismissNotice(): void;
  openMicrophoneSettings?(): void;
}

export const VoiceContext = createContext<VoiceControls | null>(null);

const idle: VoiceSnapshot = {
  available: false,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: null,
  activity: null,
  notice: null,
};
const noSubscribe = () => () => {};
const idleSnapshot = () => idle;

export function useVoice(): { controller: VoiceControls | null; snapshot: VoiceSnapshot } {
  const controller = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? idleSnapshot,
  );
  return { controller, snapshot };
}

/** What a screen reader hears; the orb says the same thing to the eye. */
const status: Record<VoicePhase, string> = {
  idle: "",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Working",
  speaking: "Speaking",
};

/** Whether a call can be started or is under way, for a bar choosing its controls. */
export function useVoiceAvailable(): boolean {
  const { controller, snapshot } = useVoice();
  return controller !== null && (snapshot.available || snapshot.phase !== "idle");
}

/**
 * Chat composer's way in: starts voice, or ends the call. `disc` is the bar's
 * trailing circle when there is nothing to send; `glyph` sits among the
 * other toolbar glyphs.
 */
export function VoiceMic(props: {
  readonly disabled: boolean;
  readonly face?: "disc" | "glyph";
}): ReactNode {
  const { controller, snapshot } = useVoice();
  if (!controller || (!snapshot.available && snapshot.phase === "idle")) return null;
  const on = snapshot.phase !== "idle";
  return (
    <Pressable
      accessibilityLabel={on ? "End voice" : "Talk to Opensteer"}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: on }}
      disabled={props.disabled && !on}
      onPress={() => (on ? void controller.stop() : void controller.start())}
      style={props.disabled && !on ? styles.quiet : null}
    >
      {({ pressed }) =>
        snapshot.phase === "connecting" ? (
          <View style={styles.micBox}>
            <ActivityIndicator color={color.ember} />
          </View>
        ) : on || props.face === "disc" ? (
          <View style={styles.micBox}>
            <View
              style={[
                on ? styles.micOn : styles.micDisc,
                pressed && (on ? material.accentPressed : styles.micDiscPressed),
              ]}
            >
              <Symbol
                name="waveform"
                size={17}
                tint={on ? color.inkOnEmber : color.background}
                weight="semibold"
              />
            </View>
          </View>
        ) : (
          <ComposerGlyph icon="waveform" />
        )
      }
    </Pressable>
  );
}

/**
 * A screen with a composer docks the bar above it while it is on top, never
 * over it; elsewhere the bar floats near the bottom. React Navigation keeps a
 * pushed screen's parent mounted, and a page keeps its side thread mounted but
 * hidden when the pair narrows, so a dock counts only while focused and in view.
 */
let focusedDocks = 0;
const dockListeners = new Set<() => void>();
const dockStore = {
  subscribe(listener: () => void) {
    dockListeners.add(listener);
    return () => dockListeners.delete(listener);
  },
  docked: () => focusedDocks > 0,
};
function changeDocks(delta: number) {
  focusedDocks += delta;
  for (const listener of dockListeners) listener();
}

export function VoiceDock(): ReactNode {
  const onScreen = useIsFocused();
  const inView = usePaneInView();
  const focused = onScreen && inView;
  const { controller, snapshot } = useVoice();
  useEffect(() => {
    if (!focused) return;
    changeDocks(1);
    return () => changeDocks(-1);
  }, [focused]);
  if (!focused || !controller || (snapshot.phase === "idle" && !snapshot.notice)) return null;
  return (
    <Animated.View entering={enter} exiting={exit} style={styles.dock}>
      <VoiceBar controller={controller} snapshot={snapshot} />
    </Animated.View>
  );
}

/** The bar for screens without any composer. Mount once, above the navigator. */
export function VoiceOverlay(): ReactNode {
  const { controller, snapshot } = useVoice();
  const docked = useSyncExternalStore(dockStore.subscribe, dockStore.docked);
  const insets = useSafeAreaInsets();
  if (docked || !controller || (snapshot.phase === "idle" && !snapshot.notice)) return null;
  return (
    <Animated.View
      entering={enter}
      exiting={exit}
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: insets.bottom + 76 }]}
    >
      <VoiceBar controller={controller} snapshot={snapshot} floating />
    </Animated.View>
  );
}

function VoiceBar(props: {
  readonly controller: VoiceControls;
  readonly snapshot: VoiceSnapshot;
  readonly floating?: boolean;
}): ReactNode {
  const { controller, snapshot } = props;
  const { phase, muted, notice } = snapshot;
  const shell = [styles.bar, props.floating === true && styles.floating];
  if (phase === "idle" && notice)
    return (
      <View accessibilityRole="alert" style={[shell, styles.notice]}>
        <Symbol name="exclamationmark.circle" size={17} tint={color.amber} weight="medium" />
        <AppText role="caption" tone="soft" style={styles.noticeText}>
          {notice.message}
        </AppText>
        {notice.action === "open-settings" && controller.openMicrophoneSettings ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => controller.openMicrophoneSettings?.()}
            style={styles.settings}
          >
            <AppText role="caption" tone="default">
              Settings
            </AppText>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={space[8]}
          onPress={() => controller.dismissNotice()}
          style={styles.button}
        >
          <Symbol name="xmark" size={14} tint={color.muted} weight="semibold" />
        </Pressable>
      </View>
    );
  // Live words only; with none, the one word a first-time caller needs to start talking.
  const caption =
    phase === "hearing" || phase === "thinking"
      ? snapshot.heard
      : phase === "speaking"
        ? snapshot.spoken
        : null;
  const quiet =
    caption ??
    (muted ? "Muted" : phase === "listening" || phase === "connecting" ? status[phase] : null);
  return (
    <View
      accessibilityLabel={`Voice: ${muted ? "Microphone muted" : status[phase]}`}
      accessibilityLiveRegion="polite"
      style={[shell, (phase === "hearing" || phase === "speaking") && styles.barLive]}
    >
      <Glow controller={controller} />
      <Orb controller={controller} phase={phase} muted={muted} activity={snapshot.activity} />
      <View style={styles.text}>
        {quiet ? (
          <Animated.View entering={appear} key={caption === null ? "quiet" : "live"}>
            <AppText
              ellipsizeMode="head"
              numberOfLines={1}
              role="secondary"
              tone={
                caption === null
                  ? "muted"
                  : phase === "hearing"
                    ? "default"
                    : phase === "speaking"
                      ? "soft"
                      : "muted"
              }
            >
              {quiet}
            </AppText>
          </Animated.View>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
        accessibilityRole="button"
        accessibilityState={{ selected: muted, disabled: phase === "connecting" }}
        disabled={phase === "connecting"}
        onPress={() => controller.setMuted(!muted)}
        style={[styles.button, muted && styles.buttonOn, phase === "connecting" && styles.dim]}
      >
        <Symbol
          name={muted ? "mic.slash" : "mic"}
          size={16}
          tint={muted ? color.red : color.textSoft}
          weight="medium"
        />
      </Pressable>
      <Pressable
        accessibilityLabel="End voice"
        accessibilityRole="button"
        onPress={() => void controller.stop()}
        style={styles.end}
      >
        <AppText role="secondaryMedium" style={styles.endText}>
          End
        </AppText>
      </Pressable>
    </View>
  );
}

/**
 * When the agent opens something, the screen changing is the answer; the bar
 * only glints once to say it was the call. It runs on the UI thread.
 */
function Glow(props: { readonly controller: VoiceControls }): ReactNode {
  const glow = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  useEffect(
    () =>
      props.controller.subscribeShown?.(() => {
        glow.value = withSequence(
          withTiming(1, { duration: reduceMotion ? 150 : 220, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: reduceMotion ? 350 : 680, easing: Easing.inOut(Easing.quad) }),
        );
      }),
    [props.controller, glow, reduceMotion],
  );
  const style = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: reduceMotion ? 1 : 0.985 + glow.value * 0.02 }],
  }));
  return <Animated.View pointerEvents="none" style={[styles.glow, style]} />;
}

/**
 * The orb is the call's face, readable without words: a pale core with a
 * dialing ring while connecting, a slow breath while listening, swelling with
 * whoever talks, and, while the agent works, a ring circling a settled core
 * that holds the glyph of the step it is taking. Levels go straight into
 * shared values, so meters animate on the UI thread without re-rendering React.
 */
function Orb(props: {
  readonly controller: VoiceControls;
  readonly phase: VoicePhase;
  readonly muted: boolean;
  readonly activity: VoiceSnapshot["activity"];
}): ReactNode {
  const level = useSharedValue(0);
  const breath = useSharedValue(1);
  const turn = useSharedValue(0);
  const settle = useSharedValue(1);
  const ring = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const latest = useRef({ phase: props.phase, muted: props.muted });
  latest.current = { phase: props.phase, muted: props.muted };
  useEffect(
    () =>
      props.controller.subscribeLevel(({ input, output }) => {
        const { phase, muted } = latest.current;
        const next = phase === "speaking" ? output : muted || phase === "thinking" ? 0 : input;
        level.value = withTiming(Math.min(1, Math.max(0, next)), { duration: 110 });
      }),
    [props.controller, level],
  );
  useEffect(
    () =>
      props.controller.subscribeShown?.(() => {
        if (reduceMotion) return;
        settle.value = withSequence(
          withTiming(1.16, { duration: 160 }),
          withSpring(props.phase === "thinking" ? 0.84 : 1),
        );
      }),
    [props.controller, props.phase, reduceMotion, settle],
  );
  const working = props.phase === "thinking";
  const dialing = props.phase === "connecting";
  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(turn);
    breath.value = 1;
    turn.value = 0;
    settle.value = withTiming(working ? 0.84 : dialing ? 0.86 : 1, { duration: 220 });
    ring.value = withTiming(working ? 1 : dialing ? 0.55 : 0, { duration: 220 });
    if (reduceMotion || props.muted) return;
    if (props.phase === "listening")
      breath.value = withRepeat(
        withTiming(0.94, { duration: 1300, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      );
    if (working || dialing)
      turn.value = withRepeat(
        withTiming(360, { duration: working ? 1400 : 1100, easing: Easing.linear }),
        -1,
      );
  }, [props.phase, props.muted, reduceMotion, working, dialing, breath, turn, settle, ring]);
  const speaking = props.phase === "speaking";
  const core = useAnimatedStyle(() => ({
    transform: [{ scale: (0.88 + level.value * 0.32) * breath.value * settle.value }],
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: 0.22 + level.value * 0.78,
    transform: [
      { scale: reduceMotion ? 1 : (speaking ? 0.9 : 0.84) + level.value * (speaking ? 0.6 : 0.46) },
    ],
  }));
  const arc = useAnimatedStyle(() => ({
    opacity: ring.value,
    transform: [{ rotate: `${turn.value}deg` }],
  }));
  const quiet = props.muted || dialing;
  return (
    <View style={styles.orb}>
      <Animated.View
        style={[styles.halo, speaking && styles.haloSpeaking, halo, quiet && styles.quiet]}
      />
      <Animated.View
        style={[styles.ring, reduceMotion && styles.ringStill, dialing && styles.ringDialing, arc]}
      />
      <Animated.View style={[styles.core, core, quiet && styles.quiet]}>
        <View style={styles.shine} />
        {props.activity ? (
          <Animated.View entering={ZoomIn.springify()} key={props.activity} style={styles.glyph}>
            <Symbol
              name={activitySymbol[props.activity]}
              size={12}
              tint={color.inkOnEmber}
              weight="bold"
            />
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[10],
    minHeight: 56,
    paddingLeft: space[14],
    paddingRight: space[8],
    paddingVertical: space[8],
  },
  barLive: { borderColor: color.emberLine },
  button: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  buttonOn: { backgroundColor: color.redWash },
  core: {
    backgroundColor: color.ember,
    borderRadius: radius.full,
    bottom: 3,
    left: 3,
    overflow: "hidden",
    position: "absolute",
    right: 3,
    top: 3,
  },
  dim: { opacity: 0.45 },
  glow: {
    borderColor: color.emberLine,
    borderRadius: radius.full,
    borderWidth: 1,
    bottom: -1,
    left: -1,
    position: "absolute",
    right: -1,
    shadowColor: color.ember,
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 12,
    top: -1,
  },
  glyph: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  dock: { paddingBottom: space[8], paddingHorizontal: space[4] },
  end: {
    alignItems: "center",
    backgroundColor: color.redWash,
    borderColor: color.redLine,
    borderRadius: radius.full,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    paddingHorizontal: space[16],
  },
  endText: { color: color.red },
  floating: {
    ...material.float,
  },
  haloSpeaking: { backgroundColor: "rgba(241, 202, 190, 0.2)" },
  halo: {
    backgroundColor: color.emberWash,
    borderColor: color.emberLine,
    borderRadius: radius.full,
    borderWidth: 6,
    bottom: -6,
    left: -6,
    position: "absolute",
    right: -6,
    top: -6,
  },
  micBox: { alignItems: "center", height: 44, justifyContent: "center", width: 44 },
  micOn: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.full,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  // The light disc: the page's own ink inverted, the way Stop reads on desktop.
  micDisc: {
    ...material.mark,
    alignItems: "center",
    backgroundColor: color.text,
    borderRadius: radius.full,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  micDiscPressed: { backgroundColor: color.textSoft, transform: [{ scale: 0.95 }] },
  notice: { gap: space[8], paddingLeft: space[16] },
  noticeText: { flex: 1 },
  orb: { height: 32, width: 32 },
  overlay: { left: space[12], position: "absolute", right: space[12] },
  quiet: { opacity: 0.45 },
  // An arc a third of the way round: rotating, it reads as working, never as loading a page.
  ring: {
    borderBottomColor: "transparent",
    borderColor: color.emberBright,
    borderLeftColor: "transparent",
    borderRadius: radius.full,
    borderWidth: 2,
    bottom: -1,
    left: -1,
    position: "absolute",
    right: -1,
    top: -1,
  },
  ringDialing: {
    borderColor: color.muted,
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
  },
  // Held still, a full ring says the same thing.
  ringStill: { borderBottomColor: color.emberBright, borderLeftColor: color.emberBright },
  settings: {
    ...material.control,
    borderRadius: radius.full,
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  shine: {
    backgroundColor: "rgba(255, 244, 239, 0.85)",
    borderRadius: radius.full,
    height: 9,
    left: 6,
    position: "absolute",
    top: 5,
    width: 9,
  },
  text: { flex: 1, justifyContent: "center", minWidth: 0 },
});
