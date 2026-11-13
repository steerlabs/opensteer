import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, controlFontScaleLimit, material, pillHeight, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { statusFace, type StatusFace } from "./status-words.js";
import type { AgentCardView } from "./team-models.js";

/** The fewest milliseconds between two draws of one card, whatever the Host sends. */
export const cardRedrawInterval = 1000;

/**
 * An agent's live status in a thread: one plate, two fixed lines, the same
 * height in every state, so nothing under the reader moves as it changes.
 *
 * It redraws on a change of state or step, at most once a second, and its
 * elapsed time counts whole minutes. Only its owner gets a control (Stop,
 * Cancel or Answer) and a card that opens their private task.
 */
export const AgentStatusCard = memo(
  function AgentStatusCard(props: {
    readonly card: AgentCardView;
    readonly onAction: (
      requestId: string,
      action: NonNullable<StatusFace["action"]>["kind"],
    ) => void;
    readonly onOpenTask: (requestId: string) => void;
  }): ReactNode {
    const card = useSteadyValue(props.card, cardRedrawInterval);
    const minute = useMinute(card.status.state === "working");
    const face = statusFace(card, minute * 60_000);
    const { onAction, onOpenTask } = props;
    const plate = (
      <>
        <Lead lead={face.lead} mine={card.agent.mine} />
        <View style={styles.lines}>
          <View style={styles.titleLine}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="secondaryMedium"
              style={styles.title}
            >
              {face.title}
            </AppText>
            {face.meta === null ? null : (
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                style={styles.meta}
              >
                {face.meta}
              </AppText>
            )}
          </View>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            style={lineTone[face.lineTone]}
          >
            {face.line}
          </AppText>
        </View>
        {face.action !== null ? (
          <CardAction action={face.action} onPress={() => onAction(card.id, face.action!.kind)} />
        ) : face.opensTask ? (
          <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
        ) : null}
      </>
    );
    const plateStyle = [
      styles.plate,
      face.dashed && styles.dashed,
      face.lead === "attention" && card.agent.mine && styles.attention,
    ];
    if (!face.opensTask) {
      return (
        <View accessibilityLabel={`${face.title}. ${face.line}`} accessible style={plateStyle}>
          {plate}
        </View>
      );
    }
    return (
      <Pressable
        accessibilityHint="Opens your task"
        accessibilityLabel={`${face.title}. ${face.line}`}
        accessibilityRole="button"
        onPress={() => onOpenTask(card.id)}
        style={({ pressed }) => [...plateStyle, pressed && styles.pressed]}
      >
        {plate}
      </Pressable>
    );
  },
  (left, right) =>
    left.card.id === right.card.id &&
    left.card.version === right.card.version &&
    left.onAction === right.onAction &&
    left.onOpenTask === right.onOpenTask,
);

function Lead(props: { readonly lead: StatusFace["lead"]; readonly mine: boolean }): ReactNode {
  const reducedMotion = useReducedMotion();
  switch (props.lead) {
    case "working":
      return (
        <View style={styles.lead}>
          {reducedMotion ? (
            <Symbol name="circle.dotted" size={18} tint={color.ember} />
          ) : (
            <ActivityIndicator color={color.ember} size="small" />
          )}
        </View>
      );
    case "attention":
      return (
        <View style={[styles.lead, styles.leadAttention]}>
          <AppText role="caption" style={styles.bang}>
            !
          </AppText>
        </View>
      );
    case "failed":
      return (
        <View style={[styles.lead, props.mine ? styles.leadFailed : styles.leadQuiet]}>
          <Symbol
            name="xmark"
            size={12}
            tint={props.mine ? color.red : color.muted}
            weight="bold"
          />
        </View>
      );
    case "waiting":
      return (
        <View style={[styles.lead, styles.leadQuiet]}>
          <Symbol name="clock" size={15} tint={color.muted} />
        </View>
      );
    case "stopped":
      return (
        <View style={[styles.lead, styles.leadQuiet]}>
          <Symbol name="stop.fill" size={11} tint={color.muted} />
        </View>
      );
    case "blocked":
      return (
        <View style={[styles.lead, styles.leadQuiet]}>
          <Symbol name="lock" size={13} tint={color.muted} />
        </View>
      );
  }
}

function CardAction(props: {
  readonly action: NonNullable<StatusFace["action"]>;
  readonly onPress: () => void;
}): ReactNode {
  const answer = props.action.kind === "answer";
  return (
    <Pressable
      accessibilityLabel={props.action.label}
      accessibilityRole="button"
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.action,
        answer && styles.actionAnswer,
        pressed && (answer ? styles.actionAnswerPressed : styles.actionPressed),
      ]}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={answer ? styles.actionAnswerLabel : styles.actionLabel}
      >
        {props.action.label}
      </AppText>
    </Pressable>
  );
}

/**
 * The value as it was last drawn, moving to the newest at most once per
 * `interval`: a burst of step updates lands as one redraw, and the last one
 * always arrives.
 */
export function useSteadyValue<T>(value: T, interval: number): T {
  const [shown, setShown] = useState(value);
  const drawnAt = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = drawnAt.current + interval - Date.now();
    if (wait <= 0) {
      drawnAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      drawnAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [interval, shown, value]);
  return shown;
}

/**
 * The current minute, from one timer shared by every card that counts time,
 * and only while one does.
 */
function useMinute(counting: boolean): number {
  return useSyncExternalStore(counting ? subscribeMinute : subscribeNever, readMinute, readMinute);
}

const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;

function readMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener);
  minuteTimer ??= setInterval(() => {
    for (const notify of minuteListeners) notify();
  }, 60_000);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

function subscribeNever(): () => void {
  return () => undefined;
}

const lineTone = StyleSheet.create({
  amber: { color: color.amber },
  danger: { color: color.red },
  muted: { color: color.muted },
});

/** Two lines of text and the plate's padding: the same in every state at one text size. */
const plateHeight = 58;

const styles = StyleSheet.create({
  action: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    height: pillHeight - 4,
    justifyContent: "center",
    paddingHorizontal: space[12] - 1,
  },
  actionAnswer: { ...material.accent },
  actionAnswerLabel: { color: color.inkOnEmber, fontWeight: "700" },
  actionAnswerPressed: { ...material.accentPressed },
  actionLabel: { color: color.text, fontWeight: "600" },
  actionPressed: { ...material.platePressed },
  attention: { borderColor: color.amberLine },
  bang: { color: color.inkOnAmber, fontWeight: "800" },
  dashed: { borderStyle: "dashed", borderColor: color.lineHover },
  lead: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  leadAttention: { backgroundColor: color.amber },
  leadFailed: { backgroundColor: color.redWash },
  leadQuiet: { backgroundColor: color.surfaceRaised },
  lines: { flex: 1, gap: 2, minWidth: 0 },
  meta: { color: color.mutedDim, flexShrink: 0, fontVariant: ["tabular-nums"] },
  plate: {
    ...material.plate,
    alignItems: "center",
    alignSelf: "stretch",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    marginTop: space[4],
    maxWidth: 420,
    minHeight: plateHeight,
    paddingHorizontal: space[12] - 1,
    paddingVertical: space[8] - 1,
  },
  pressed: { ...material.platePressed },
  title: { color: color.text, flexShrink: 1 },
  titleLine: { alignItems: "baseline", flexDirection: "row", gap: space[8] },
});
