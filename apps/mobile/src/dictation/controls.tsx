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
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { ComposerCircleFace, composerControlStyle } from "../thread/composer-bar.js";

export function DictationMic(props: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  disabled: boolean;
  onStart(): void;
}): ReactNode {
  const c = props.controller;
  const s = dictationView(props.snapshot, props.owner);
  if (!s.visible) return null;
  const stopping = s.phase === "listening" || s.phase === "finishing";
  const disabled = props.disabled || s.blocked || (s.phase !== "idle" && !stopping);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        stopping ? dictationLabels.stop : dictationStartLabel(s.languageName ?? "")
      }
      accessibilityState={{ disabled, busy: s.phase === "finishing" }}
      disabled={disabled}
      style={[composerControlStyle, disabled && { opacity: 0.45 }]}
      onPress={stopping ? () => void c.stop(props.owner) : props.onStart}
    >
      {s.phase === "finishing" ? (
        <View style={styles.control}>
          <ActivityIndicator color={color.ember} />
        </View>
      ) : (
        <ComposerCircleFace icon={stopping ? "stop.fill" : "mic"} />
      )}
    </Pressable>
  );
}

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
  const status =
    s.phase === "downloading"
      ? dictationDownloadStatus(s.languageName ?? "", s.progress)
      : s.phase === "starting"
        ? dictationLabels.starting
        : s.phase === "finishing"
          ? dictationLabels.finishing
          : null;
  return (
    <>
      {s.phase !== "idle" ? (
        <View style={styles.row}>
          {s.phase === "listening" ? (
            <>
              <Level controller={c} />
              <Elapsed since={s.listeningSince} />
            </>
          ) : (
            <AppText role="secondary" tone="muted" style={styles.words}>
              {status}
            </AppText>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              s.phase === "downloading" ? dictationLabels.cancelDownload : dictationLabels.cancel
            }
            onPress={() => c.cancel(owner)}
            style={styles.control}
          >
            <AppText role="secondary" tone="muted">
              {s.phase === "downloading"
                ? dictationLabels.cancelDownload
                : s.phase === "starting"
                  ? dictationLabels.cancelStarting
                  : "✕"}
            </AppText>
          </Pressable>
        </View>
      ) : null}
      {notice ? (
        <View style={styles.row}>
          <AppText role="secondary" tone="muted" style={styles.words}>
            {notice.message}
          </AppText>
          {notice.action ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => c.openMicrophoneSettings()}
              style={styles.control}
            >
              <AppText role="secondaryMedium" tone="ember">
                {dictationLabels.openSettings}
              </AppText>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dictationLabels.dismissNotice}
            onPress={() => c.dismissNotice()}
            style={styles.control}
          >
            <AppText role="secondary" tone="muted">
              ✕
            </AppText>
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
    <AppText role="secondary" tone="muted" style={styles.words}>
      {dictationElapsed(now - (since ?? now))}
    </AppText>
  );
}
function Level({ controller }: { controller: DictationController }): ReactNode {
  const reduced = useReducedMotion();
  const [level, setLevel] = useState(0);
  useEffect(
    () => (reduced ? undefined : controller.subscribeLevel(setLevel)),
    [controller, reduced],
  );
  return (
    <View accessible={false} style={styles.meter}>
      {[0.3, 0.6, 1, 0.6, 0.3].map((scale, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            backgroundColor: color.ember,
            height: reduced ? 8 : 3 + level * scale * 17,
          }}
        />
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[12],
    flexWrap: "wrap",
  },
  words: { flex: 1 },
  control: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  meter: { height: 24, flexDirection: "row", alignItems: "center", gap: 3 },
});
