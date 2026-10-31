import {
  dictationView,
  dictationDownloadStatus,
  dictationElapsed,
  dictationLabels,
  dictationStartLabel,
  type DictationSnapshot,
  type DictationController,
} from "@opensteer/client/dictation";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, radius, space, touchTarget } from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { ComposerCircleFace, composerControlStyle } from "../thread/composer-bar.js";

export function DictationMic(props: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  disabled: boolean;
  onStart(): void;
}): ReactNode {
  const s = dictationView(props.snapshot, props.owner);
  if (!s.visible) return null;
  const disabled = props.disabled || s.blocked || s.phase !== "idle";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dictationStartLabel(s.languageName ?? "")}
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={[composerControlStyle, disabled && { opacity: 0.45 }]}
      onPress={props.onStart}
    >
      <ComposerCircleFace icon="mic" />
    </Pressable>
  );
}

/**
 * The composer's control row while dictating: cancel, the live waveform, the
 * time since the press, keep the words, and send. It replaces the row the
 * moment the mic is pressed, before capture reports that it is listening.
 */
export function DictationBar({
  controller: c,
  snapshot,
  owner,
  onSend,
  canSend,
}: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  onSend: () => void;
  canSend: boolean;
}): ReactNode {
  const s = dictationView(snapshot, owner);
  if (s.phase !== "starting" && s.phase !== "listening" && s.phase !== "finishing") return null;
  const finishing = s.phase === "finishing";
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={dictationLabels.cancel}
        accessibilityRole="button"
        onPress={() => c.cancel(owner)}
      >
        <ComposerCircleFace icon="xmark" />
      </Pressable>
      <Waveform controller={c} live={s.phase === "listening"} />
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.elapsed}
      >
        <View style={styles.dot} />
        <Elapsed since={s.startedAt} />
      </View>
      <Pressable
        accessibilityLabel={dictationLabels.stop}
        accessibilityRole="button"
        accessibilityState={{ busy: finishing, disabled: finishing }}
        disabled={finishing}
        onPress={() => void c.stop(owner)}
        style={styles.target}
      >
        <View style={[styles.keep, finishing && styles.busy]}>
          <Symbol name="checkmark" size={15} tint={color.inkOnEmber} weight="bold" />
        </View>
      </Pressable>
      <ComposerAction
        busy={false}
        disabled={!canSend}
        kind="send"
        label="Send message"
        onPress={onSend}
      />
    </View>
  );
}

/** What dictation says outside the bar: a language download and its notices. */
export function DictationStatus({
  controller: c,
  snapshot,
  owner,
}: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
}): ReactNode {
  const s = dictationView(snapshot, owner);
  const notice = s.notice;
  return (
    <>
      {s.phase === "downloading" ? (
        <View style={styles.line}>
          <AppText role="secondary" tone="muted" style={styles.words}>
            {dictationDownloadStatus(s.languageName ?? "", s.progress)}
          </AppText>
          <Pressable
            accessibilityLabel={dictationLabels.cancelDownload}
            accessibilityRole="button"
            onPress={() => c.cancel(owner)}
            style={styles.target}
          >
            <Symbol name="xmark" size={13} tint={color.muted} />
          </Pressable>
        </View>
      ) : null}
      {notice ? (
        <View style={styles.line}>
          <AppText role="secondary" tone="muted" style={styles.words}>
            {notice.message}
          </AppText>
          {notice.action ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => c.openMicrophoneSettings()}
              style={styles.target}
            >
              <AppText role="secondaryMedium" tone="ember">
                {dictationLabels.openSettings}
              </AppText>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={dictationLabels.dismissNotice}
            accessibilityRole="button"
            onPress={() => c.dismissNotice()}
            style={styles.target}
          >
            <Symbol name="xmark" size={13} tint={color.muted} />
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

function Elapsed({ since }: { since: number | null }): ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <AppText role="secondary" tone="muted" style={styles.time}>
      {dictationElapsed(now - (since ?? now))}
    </AppText>
  );
}

const bars = 40;

/**
 * The newest level enters at the right and older ones drift left. Levels
 * arrive about ten times a second and only this view re-renders for them.
 * Until capture is listening it is a flat line; Reduce Motion keeps it still.
 */
function Waveform({
  controller,
  live,
}: {
  controller: DictationController;
  live: boolean;
}): ReactNode {
  const reduced = useReducedMotion();
  const [levels, setLevels] = useState<readonly number[]>(() => Array<number>(bars).fill(0));
  useEffect(
    () =>
      reduced || !live
        ? undefined
        : controller.subscribeLevel((level) =>
            setLevels((previous) => [...previous.slice(1), level]),
          ),
    [controller, reduced, live],
  );
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.wave}
    >
      {levels.map((level, index) => (
        <View
          key={index}
          style={[
            styles.waveBar,
            { height: reduced || !live ? 3 : 3 + Math.min(1, level) * 19 },
            index < bars / 4 && { opacity: 0.35 + (0.65 * index) / (bars / 4) },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  busy: { opacity: 0.45 },
  dot: { backgroundColor: color.red, borderRadius: radius.full, height: 7, width: 7 },
  elapsed: { alignItems: "center", flexDirection: "row", gap: space[6] },
  keep: {
    alignItems: "center",
    backgroundColor: color.text,
    borderRadius: radius.full,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  line: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
  },
  row: { alignItems: "center", flexDirection: "row", gap: space[2] },
  target: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  time: { fontVariant: ["tabular-nums"] },
  wave: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 2,
    height: 24,
    justifyContent: "flex-end",
    minWidth: 0,
    overflow: "hidden",
  },
  waveBar: { backgroundColor: color.textSoft, borderRadius: 1.5, width: 2.5 },
  words: { flex: 1 },
});
