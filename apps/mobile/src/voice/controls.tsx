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
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, material, radius, space } from "../theme.js";
import { ComposerGlyph } from "../thread/composer-bar.js";
import { enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/** What the voice UI drives: the runtime's one `VoiceController`. */
export interface VoiceControls {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSnapshot;
  subscribeLevel(listener: (levels: VoiceLevels) => void): () => void;
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

/** Chat is whom a call talks to, whatever is on screen; each phase says it once. */
const labels: Record<VoicePhase, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Talking to Chat",
  hearing: "Listening",
  thinking: "Chat is working",
  speaking: "Chat",
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
      accessibilityLabel={on ? "End voice" : "Talk to Chat"}
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
 * pushed screen's parent mounted, so a dock counts only while focused.
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
  const focused = useIsFocused();
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
  const caption =
    phase === "hearing" || phase === "thinking"
      ? snapshot.heard
      : phase === "speaking"
        ? snapshot.spoken
        : null;
  const label = muted && phase !== "connecting" ? "Muted" : labels[phase];
  return (
    <View
      accessibilityLabel={`Voice: ${label}`}
      accessibilityLiveRegion="polite"
      style={[shell, (phase === "hearing" || phase === "speaking") && styles.barLive]}
    >
      <Orb controller={controller} phase={phase} muted={muted} />
      <View style={styles.text}>
        <AppText
          role="caption"
          tone={caption ? "muted" : "soft"}
          style={caption ? styles.label : styles.labelAlone}
        >
          {label}
        </AppText>
        {caption ? (
          <AppText
            ellipsizeMode="head"
            numberOfLines={1}
            role="secondary"
            tone={phase === "hearing" ? "default" : phase === "speaking" ? "soft" : "muted"}
          >
            {caption}
          </AppText>
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
 * The orb swells with whoever is talking and breathes while it waits. Levels
 * go straight into shared values, so meters animate on the UI thread without
 * re-rendering React.
 */
function Orb(props: {
  readonly controller: VoiceControls;
  readonly phase: VoicePhase;
  readonly muted: boolean;
}): ReactNode {
  const level = useSharedValue(0);
  const breath = useSharedValue(1);
  const turn = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const latest = useRef({ phase: props.phase, muted: props.muted });
  latest.current = { phase: props.phase, muted: props.muted };
  useEffect(
    () =>
      props.controller.subscribeLevel(({ input, output }) => {
        const { phase, muted } = latest.current;
        const next = phase === "speaking" ? output : muted ? 0 : input;
        level.value = withTiming(Math.min(1, Math.max(0, next)), { duration: 110 });
      }),
    [props.controller, level],
  );
  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(turn);
    breath.value = 1;
    turn.value = 0;
    if (reduceMotion || props.muted) return;
    if (props.phase === "listening" || props.phase === "connecting")
      breath.value = withRepeat(
        withTiming(0.94, {
          duration: props.phase === "connecting" ? 600 : 1300,
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true,
      );
    if (props.phase === "thinking")
      turn.value = withRepeat(withTiming(360, { duration: 1600, easing: Easing.linear }), -1);
  }, [props.phase, props.muted, reduceMotion, breath, turn]);
  const core = useAnimatedStyle(() => ({
    transform: [
      { scale: (0.88 + level.value * 0.32) * breath.value },
      { rotate: `${turn.value}deg` },
    ],
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: 0.25 + level.value * 0.75,
    transform: [{ scale: 0.85 + level.value * 0.45 }],
  }));
  const quiet = props.muted || props.phase === "connecting";
  return (
    <View style={styles.orb}>
      <Animated.View style={[styles.halo, halo, quiet && styles.quiet]} />
      <Animated.View style={[styles.core, core, quiet && styles.quiet]}>
        <View style={styles.shine} />
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
  label: { fontSize: 11, lineHeight: 14 },
  labelAlone: { fontSize: 15, lineHeight: 21 },
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
