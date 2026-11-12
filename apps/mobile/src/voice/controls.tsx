import { VoiceContext } from "@opensteer/client/react";
import {
  voiceBar,
  type VoiceBarView,
  type VoiceControls,
  type VoicePhase,
  type VoiceSnapshot,
} from "@opensteer/client/voice";
import { useIsFocused } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  color,
  controlFontScaleLimit,
  floatShadowInset,
  material,
  pillHeight,
  plateFill,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { ComposerGlyph } from "../thread/composer-bar.js";
import { activitySymbol } from "../ui/activity-symbol.js";
import { appear, duration, enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { usePaneInView } from "../ui/pane.js";
import { Symbol } from "../ui/symbol.js";
import { VoiceAsk } from "./ask.js";
import { CallTimer } from "./call-timer.js";
import { PillMic, VoiceCursor } from "./cursor-mark.js";
import { floatLift, floatRest } from "./float-lift.js";
import { useKeyboardHeight } from "./keyboard-height.js";
import { usePillFit } from "./pill-fit.js";
import { useVoiceAvailable, useVoiceValue } from "./use-voice-value.js";

const selectShowing = ({ notice, phase }: VoiceSnapshot) => phase !== "idle" || notice !== null;
const selectPhase = ({ phase }: VoiceSnapshot) => phase;
const selectMuted = ({ muted }: VoiceSnapshot) => muted;
const selectActivity = ({ activity }: VoiceSnapshot) => activity;
const selectTasks = ({ tasks }: VoiceSnapshot) => tasks;
const selectNotice = ({ notice }: VoiceSnapshot) => notice;
const selectStatus = (snapshot: VoiceSnapshot) => voiceBar(snapshot).status;
const selectSpeaker = (snapshot: VoiceSnapshot) => voiceBar(snapshot).speaker;
const selectWords = (snapshot: VoiceSnapshot) => voiceBar(snapshot).words;
const selectLive = (snapshot: VoiceSnapshot) => voiceBar(snapshot).live;
const selectTone = (snapshot: VoiceSnapshot) => voiceBar(snapshot).tone;

/**
 * Home composer's way in: starts voice, or ends the call. `disc` is the bar's
 * trailing circle when there is nothing to send; `glyph` sits among the
 * other toolbar glyphs.
 */
export function VoiceMic(props: {
  readonly disabled: boolean;
  readonly face?: "disc" | "glyph";
}): ReactNode {
  const controller = useContext(VoiceContext);
  const offered = useVoiceAvailable();
  const phase = useVoiceValue(selectPhase);
  if (!controller || !offered) return null;
  const on = phase !== "idle";
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
        phase === "connecting" ? (
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

/**
 * `slot` is the Voice Thread's: the bar takes the start bar's exact place, so
 * it cross-fades in where it stands and brings no air of its own.
 */
export function VoiceDock(props: { readonly slot?: boolean }): ReactNode {
  const onScreen = useIsFocused();
  const inView = usePaneInView();
  const focused = onScreen && inView;
  const controller = useContext(VoiceContext);
  const showing = useVoiceValue(selectShowing);
  useEffect(() => {
    if (!focused) return;
    changeDocks(1);
    return () => changeDocks(-1);
  }, [focused]);
  if (!focused || !controller || !showing) return null;
  return (
    <Animated.View
      entering={props.slot === true ? appear : enter}
      exiting={exit}
      pointerEvents="box-none"
      style={props.slot === true ? styles.stack : [styles.stack, styles.dock]}
    >
      <VoiceAsk />
      <VoiceBar controller={controller} />
    </Animated.View>
  );
}

/**
 * The bar for screens without any composer. Mount once, above the navigator.
 *
 * It stays under iOS sheets by choice. In a `FullWindowOverlay` it would stay on
 * top, but a Request card's `Modal` review needs a view controller to present
 * from, and that window-level view has none: Review would silently do nothing.
 */
export function VoiceOverlay(): ReactNode {
  const controller = useContext(VoiceContext);
  const showing = useVoiceValue(selectShowing);
  const docked = useSyncExternalStore(dockStore.subscribe, dockStore.docked);
  if (docked || !controller || !showing) return null;
  return <FloatingBar controller={controller} />;
}

/** Mounted only while it shows, so the keyboard is watched only during a call. */
function FloatingBar(props: { readonly controller: VoiceControls }): ReactNode {
  const insets = useSafeAreaInsets();
  const rest = insets.bottom + floatRest;
  const keyboard = useKeyboardHeight();
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: -floatLift(keyboard.value, rest) }],
  }));
  return (
    <Animated.View
      entering={enter}
      exiting={exit}
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: rest }]}
    >
      <Animated.View pointerEvents="box-none" style={[styles.stack, lift]}>
        <VoiceAsk />
        <VoiceBar controller={props.controller} floating />
      </Animated.View>
    </Animated.View>
  );
}

/** Draws `voiceBar()`; each fact is read alone, so a caption's tokens redraw only its words. */
function VoiceBar(props: {
  readonly controller: VoiceControls;
  readonly floating?: boolean;
}): ReactNode {
  const { controller } = props;
  const phase = useVoiceValue(selectPhase);
  const notice = useVoiceValue(selectNotice);
  if (phase === "idle" && notice)
    return (
      <Animated.View
        accessibilityRole="alert"
        entering={appear}
        style={[styles.notice, props.floating === true && material.float]}
      >
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
          onPress={() => controller.dismissNotice()}
          style={styles.control}
        >
          <Symbol name="xmark" size={14} tint={color.muted} weight="semibold" />
        </Pressable>
      </Animated.View>
    );
  return <Pill controller={controller} floating={props.floating === true} />;
}

function useRide(cut: SharedValue<number>) {
  return useAnimatedStyle(() => ({ transform: [{ translateX: cut.value }] }));
}

/**
 * The lane is fixed and only `cut` moves, so the pill changes size without one
 * layout pass: a plate slides under a static clip, and what stands on its left
 * edge slides with it. The clip's rounding is the pill's right end, whose rim
 * the moving plate has left behind, so that half of the rim is drawn on its own.
 * The words hold still in a window that slides over them.
 */
function Pill(props: {
  readonly controller: VoiceControls;
  readonly floating: boolean;
}): ReactNode {
  const { controller, floating } = props;
  const phase = useVoiceValue(selectPhase);
  const muted = useVoiceValue(selectMuted);
  const activity = useVoiceValue(selectActivity);
  const tasks = useVoiceValue(selectTasks);
  const status = useVoiceValue(selectStatus);
  const speaker = useVoiceValue(selectSpeaker);
  const lead = activity === null ? leadRoom : leadRoom + activityRoom;
  const dialing = phase === "connecting";
  const { clipped, cut, lane, onLane, onTrailing, onWords, tail } = usePillFit(lead, speaker);
  // A clipped plate can cast no shadow, so a bare view squeezed to the pill's span casts it.
  const shadowSpan = useAnimatedStyle(() => ({
    transform: [
      { translateX: cut.value / 2 },
      { scaleX: lane.value === 0 ? 0 : Math.max(0, 1 - cut.value / lane.value) },
    ],
  }));
  const plateRide = useRide(cut);
  const leadRide = useRide(cut);
  const windowRide = useRide(cut);
  const hold = useAnimatedStyle(() => ({ transform: [{ translateX: -cut.value - tail.value }] }));
  const softEdge = useAnimatedStyle(() => ({ opacity: clipped.value }));
  return (
    <View onLayout={onLane} pointerEvents="box-none" style={styles.lane}>
      {floating ? <Animated.View pointerEvents="none" style={[styles.shadow, shadowSpan]} /> : null}
      <View pointerEvents="box-none" style={styles.clip}>
        <Animated.View style={[styles.plate, floating && styles.plateFloating, plateRide]}>
          <Glow controller={controller} />
        </Animated.View>
      </View>
      <View pointerEvents="none" style={styles.rimEnd}>
        <View style={styles.rim} />
      </View>
      <Animated.View
        accessibilityLabel={`Voice: ${status}`}
        accessibilityLiveRegion="polite"
        accessible
        pointerEvents="none"
        style={[styles.lead, leadRide]}
      >
        <VoiceCursorMark controller={controller} muted={muted} phase={phase} speaker={speaker} />
        {activity === null ? null : (
          <Animated.View entering={appear} exiting={exit} key={activity}>
            <Symbol
              name={activitySymbol[activity]}
              size={activitySize}
              tint={color.textSoft}
              weight="medium"
            />
          </Animated.View>
        )}
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.window, { left: lead }, windowRide]}>
        <Animated.View style={[styles.words, hold]}>
          <View onLayout={onWords}>
            <BarWords />
          </View>
        </Animated.View>
        <Animated.View style={[styles.softEdge, floating && styles.softEdgeFloating, softEdge]} />
      </Animated.View>
      <View onLayout={onTrailing} pointerEvents="box-none" style={styles.trailing}>
        {tasks > 0 ? (
          <Animated.View entering={appear} exiting={exit} style={styles.tasks}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              tone="soft"
            >
              {tasks === 1 ? "1 task" : `${tasks} tasks`}
            </AppText>
          </Animated.View>
        ) : null}
        <CallTimer tone="muted" />
        <Pressable
          accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
          accessibilityRole="button"
          accessibilityState={{ selected: muted, disabled: dialing }}
          disabled={dialing}
          onPress={() => {
            void Haptics.selectionAsync();
            controller.setMuted(!muted);
          }}
          style={styles.control}
        >
          {({ pressed }) => (
            <View
              style={[
                styles.disc,
                muted && styles.discMuted,
                pressed && styles.discPressed,
                dialing && styles.dim,
              ]}
            >
              <PillMic muted={muted} size={15} tint={muted ? color.red : color.textSoft} />
            </View>
          )}
        </Pressable>
        <Pressable
          accessibilityLabel="End"
          accessibilityRole="button"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void controller.stop();
          }}
          style={styles.control}
        >
          {({ pressed }) => (
            <View style={[styles.disc, pressed && styles.discPressed]}>
              <Symbol name="xmark" size={13} tint={color.red} weight="semibold" />
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

/** The one line of the bar that changes with every token, alone in its own leaf. */
function BarWords(): ReactNode {
  const words = useVoiceValue(selectWords);
  const live = useVoiceValue(selectLive);
  const tone = useVoiceValue(selectTone);
  if (words === null) return null;
  return (
    <Animated.View entering={appear} exiting={exit} key={live ? "live" : "quiet"}>
      <AppText
        ellipsizeMode="head"
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        tone={tone}
      >
        {words}
      </AppText>
    </Animated.View>
  );
}

/**
 * When the agent opens something, the screen changing is the answer; the pill
 * only warms once to say it was the call. It runs on the UI thread.
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
  const style = useAnimatedStyle(() => ({ opacity: glow.value }));
  return <Animated.View pointerEvents="none" style={[styles.glow, style]} />;
}

/**
 * The call's face. Its color says who is talking, its size how loudly, and a
 * slow pulse that the call is getting somewhere on its own. Levels go straight
 * into a shared value, so all of it runs on the UI thread without a render.
 */
function VoiceCursorMark(props: {
  readonly controller: VoiceControls;
  readonly muted: boolean;
  readonly phase: VoicePhase;
  readonly speaker: VoiceBarView["speaker"];
}): ReactNode {
  const { controller, muted, phase, speaker } = props;
  const reduceMotion = useReducedMotion();
  const level = useSharedValue(0);
  const pop = useSharedValue(1);
  const pulse = useSharedValue(1);
  const person = useSharedValue(0);
  const opensteer = useSharedValue(0);
  const latest = useRef({ phase, muted });
  latest.current = { phase, muted };
  useEffect(() => {
    if (reduceMotion) return;
    return controller.subscribeLevel(({ input, output }) => {
      const { phase, muted } = latest.current;
      const next = phase === "speaking" ? output : muted || phase === "thinking" ? 0 : input;
      level.value = withTiming(Math.min(1, Math.max(0, next)), { duration: 110 });
    });
  }, [controller, level, reduceMotion]);
  useEffect(() => {
    if (reduceMotion) return;
    return controller.subscribeShown?.(() => {
      pop.value = withSequence(
        withTiming(1.24, { duration: 130, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 260, easing: Easing.inOut(Easing.quad) }),
      );
    });
  }, [controller, pop, reduceMotion]);
  const pulsing = (phase === "connecting" || phase === "thinking") && !muted && !reduceMotion;
  useEffect(() => {
    pulse.value = pulsing
      ? withRepeat(withTiming(0.4, { duration: 850, easing: Easing.inOut(Easing.sin) }), -1, true)
      : withTiming(1, { duration: duration.exit });
  }, [pulse, pulsing]);
  useEffect(() => {
    person.value = withTiming(speaker === "person" ? 1 : 0, { duration: duration.enter });
    opensteer.value = withTiming(speaker === "opensteer" ? 1 : 0, { duration: duration.enter });
  }, [opensteer, person, speaker]);
  const mark = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: (1 + level.value * 0.18) * pop.value }],
  }));
  const personInk = useAnimatedStyle(() => ({ opacity: person.value }));
  const opensteerInk = useAnimatedStyle(() => ({ opacity: opensteer.value }));
  return (
    <Animated.View style={[styles.mark, mark]}>
      <VoiceCursor size={markSize} tint={color.muted} />
      <Animated.View style={[styles.ink, personInk]}>
        <VoiceCursor size={markSize} tint={color.text} />
      </Animated.View>
      <Animated.View style={[styles.ink, opensteerInk]}>
        <VoiceCursor size={markSize} tint={color.ember} />
      </Animated.View>
    </Animated.View>
  );
}

/** The call bar and the Voice Thread's start bar, so one takes the other's place exactly. */
export const voiceBarHeight = 56;

const plateHeight = touchTarget;
const plateInset = (voiceBarHeight - plateHeight) / 2;
const markSize = 18;
const markWidth = (markSize * 16) / 18;
const activitySize = 14;
const activityRoom = activitySize + space[6];
const leadRoom = space[14] + markWidth + space[8];

const styles = StyleSheet.create({
  clip: {
    borderRadius: radius.full,
    bottom: plateInset,
    left: 0,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: plateInset,
  },
  control: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  dim: { opacity: 0.45 },
  disc: {
    ...material.quiet,
    alignItems: "center",
    borderRadius: radius.full,
    height: pillHeight,
    justifyContent: "center",
    width: pillHeight,
  },
  discMuted: { backgroundColor: color.redWash },
  discPressed: { opacity: 0.6 },
  dock: { paddingBottom: space[2] },
  glow: {
    ...StyleSheet.absoluteFill,
    backgroundColor: color.emberWash,
    borderRadius: radius.full,
  },
  ink: { left: 0, position: "absolute", top: 0 },
  lane: { height: voiceBarHeight },
  lead: {
    alignItems: "center",
    bottom: plateInset,
    flexDirection: "row",
    gap: space[6],
    left: space[14],
    position: "absolute",
    top: plateInset,
  },
  mark: { height: markSize, width: markWidth },
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
  notice: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[8],
    minHeight: voiceBarHeight,
    paddingLeft: space[16],
    paddingRight: space[6],
    paddingVertical: space[6],
  },
  noticeText: { flex: 1 },
  overlay: { left: space[12], position: "absolute", right: space[12] },
  // Flat, without the plate's sheen, so the soft edge can match it exactly.
  plate: {
    ...material.plate,
    ...StyleSheet.absoluteFill,
    backgroundImage: undefined,
    borderRadius: radius.full,
  },
  plateFloating: { backgroundColor: color.surfaceElevated },
  quiet: { opacity: 0.45 },
  rim: {
    ...material.plate,
    backgroundColor: "transparent",
    backgroundImage: undefined,
    borderRadius: radius.full,
    bottom: 0,
    position: "absolute",
    right: 0,
    top: 0,
    width: plateHeight,
  },
  rimEnd: {
    bottom: plateInset,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: plateInset,
    width: plateHeight / 2,
  },
  settings: {
    ...material.control,
    borderRadius: radius.full,
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  shadow: {
    ...material.floatShadow,
    borderRadius: radius.full,
    bottom: plateInset + floatShadowInset,
    left: space[16],
    position: "absolute",
    right: space[16],
    top: plateInset + floatShadowInset,
  },
  // Short of the plate's rim and top light, which it would otherwise wipe away.
  softEdge: {
    backgroundImage: `linear-gradient(to right, ${plateFill}, ${plateFill}00)`,
    bottom: space[2],
    left: 0,
    position: "absolute",
    top: space[2],
    width: space[24],
  },
  softEdgeFloating: {
    backgroundImage: `linear-gradient(to right, ${color.surfaceElevated}, ${color.surfaceElevated}00)`,
  },
  stack: { gap: space[6] },
  tasks: {
    ...material.quiet,
    borderRadius: radius.full,
    marginRight: space[8],
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
  trailing: {
    alignItems: "center",
    bottom: plateInset,
    flexDirection: "row",
    position: "absolute",
    right: 0,
    top: plateInset,
  },
  window: {
    bottom: plateInset,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: plateInset,
  },
  // Wider than any screen, so a long line is never fitted to the window: it runs off to the left.
  words: {
    alignItems: "center",
    bottom: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
    position: "absolute",
    right: 0,
    top: 0,
    width: 4000,
  },
});
