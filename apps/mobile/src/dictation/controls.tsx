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

export function DictationStatus({
  controller: c,
  snapshot,
  owner,
  onSend,
  canSend,
}: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  onSend?: () => void;
  canSend?: boolean;
}): ReactNode {
  const s = dictationView(snapshot, owner);
  const notice = s.notice;
  const status =
    s.phase === "downloading" ? dictationDownloadStatus(s.languageName ?? "", s.progress) : null;
  return (
    <>
      {s.phase !== "idle" ? (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              s.phase === "downloading" ? dictationLabels.cancelDownload : dictationLabels.cancel
            }
            onPress={() => c.cancel(owner)}
            style={styles.control}
          >
            <AppText tone="muted">×</AppText>
          </Pressable>
          {s.phase === "downloading" ? (
            <AppText role="secondary" tone="muted" style={styles.words}>
              {status}
            </AppText>
          ) : (
            <>
              <Level controller={c} active={s.phase === "listening"} />
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <AppText style={{ color: color.red }}>●</AppText>
                <Elapsed since={s.startedAt} />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={dictationLabels.stop}
                accessibilityState={{
                  busy: s.phase === "finishing",
                  disabled: s.phase === "finishing",
                }}
                disabled={s.phase === "finishing"}
                onPress={() => void c.stop(owner)}
                style={[styles.control, { opacity: s.phase === "finishing" ? 0.4 : 1 }]}
              >
                <AppText>✓</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                disabled={!canSend}
                accessibilityState={{ disabled: !canSend }}
                onPress={onSend}
                style={styles.control}
              >
                <AppText>↑</AppText>
              </Pressable>
            </>
          )}
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
    <AppText role="secondary" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
      {dictationElapsed(now - (since ?? now))}
    </AppText>
  );
}
function Level({
  controller,
  active,
}: {
  controller: DictationController;
  active: boolean;
}): ReactNode {
  const reduced = useReducedMotion();
  const [levels, setLevels] = useState<number[]>(Array(12).fill(0));
  useEffect(
    () =>
      reduced || !active
        ? undefined
        : controller.subscribeLevel((level) =>
            setLevels((previous) => [...previous.slice(1), level]),
          ),
    [controller, reduced, active],
  );
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.meter}
    >
      {levels.map((level, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            backgroundColor: color.ember,
            height: reduced ? 8 : 3 + (active ? level : 0) * 17,
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
  },
  words: { flex: 1 },
  control: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  meter: {
    overflow: "hidden",
    minWidth: 0,
    flex: 1,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
});
