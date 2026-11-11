import { memo, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import type { NeedsYouCardView } from "./home-models.js";
import { TaskSourceLabel } from "./task-source.js";

export interface NeedsYouActions {
  readonly onApprove: (requestId: string) => void;
  readonly onDeny: (requestId: string) => void;
  readonly onOpen: (taskId: string, requestId: string) => void;
}

/**
 * One question an agent is waiting on. An approval is answered right here;
 * anything that needs more (a choice, a sign-in, words) opens its task, where
 * the request card already knows how to ask.
 */
export const NeedsYouCard = memo(function NeedsYouCard(props: {
  readonly actions: NeedsYouActions;
  readonly card: NeedsYouCardView;
}): ReactNode {
  const { actions, card } = props;
  const approve = card.answer.kind === "approve" ? card.answer : null;
  const body = (
    <View style={styles.top}>
      <View style={styles.mark}>
        <TaskMark mark={card.mark} />
      </View>
      <View style={styles.words}>
        <View style={styles.where}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            style={styles.whereText}
            tone="muted"
          >
            {card.source === null ? `${card.taskTitle} · ${card.where}` : `${card.taskTitle} ·`}
          </AppText>
          {card.source === null ? null : <TaskSourceLabel source={card.source} />}
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.age}>
            {card.age}
          </AppText>
        </View>
        <AppText role="secondaryMedium" style={styles.ask}>
          {card.ask}
        </AppText>
        {card.detail === null ? null : (
          <AppText role="caption" tone="muted">
            {card.detail}
          </AppText>
        )}
        {card.channelSees === null ? null : (
          <AppText role="caption" tone="muted">
            {card.channelSees}
          </AppText>
        )}
      </View>
      {approve === null ? (
        <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
      ) : null}
    </View>
  );
  if (approve === null) {
    return (
      <Pressable
        accessibilityHint="Opens the task to answer"
        accessibilityLabel={`${card.taskTitle}. ${card.ask}`}
        accessibilityRole="button"
        onPress={() => actions.onOpen(card.taskId, card.id)}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityHint="Opens the task"
        accessibilityLabel={`${card.taskTitle}. ${card.ask}`}
        accessibilityRole="button"
        onPress={() => actions.onOpen(card.taskId, card.id)}
      >
        {body}
      </Pressable>
      <View style={styles.answers}>
        <Pressable
          accessibilityRole="button"
          onPress={() => actions.onDeny(card.id)}
          style={({ pressed }) => [styles.answer, styles.deny, pressed && styles.denyPressed]}
        >
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
            {approve.deny}
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => actions.onApprove(card.id)}
          style={({ pressed }) => [styles.answer, styles.approve, pressed && styles.approvePressed]}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="secondaryMedium"
            style={styles.approveLabel}
          >
            {approve.approve}
          </AppText>
        </Pressable>
      </View>
    </View>
  );
});

/**
 * Every question waiting on the reader, newest first. Requests only: mentions
 * and messages are counted where they live, not here.
 */
export function NeedsYouBody(props: {
  readonly actions: NeedsYouActions;
  readonly cards: readonly NeedsYouCardView[];
  readonly paddingBottom: number;
}): ReactNode {
  if (props.cards.length === 0) {
    return (
      <View style={styles.empty}>
        <Symbol name="checkmark.circle" size={28} tint={color.muted} />
        <AppText role="title">Nothing needs you</AppText>
        <AppText role="secondary" style={styles.emptyText} tone="muted">
          When your agent has a question or needs an approval, it waits here.
        </AppText>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={[styles.list, { paddingBottom: props.paddingBottom }]}>
      {props.cards.map((card) => (
        <NeedsYouCard actions={props.actions} card={card} key={card.id} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  age: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  answer: {
    alignItems: "center",
    borderRadius: radius.sm,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget - 4,
  },
  answers: { flexDirection: "row", gap: space[8], marginTop: space[12] },
  approve: { ...material.accent },
  approveLabel: { color: color.inkOnEmber, fontWeight: "600" },
  approvePressed: { ...material.accentPressed },
  ask: { color: color.text, fontWeight: "600" },
  card: { ...material.attention, borderRadius: radius.lg, padding: space[12] },
  cardPressed: { ...material.attentionPressed },
  deny: { ...material.control },
  denyPressed: { ...material.platePressed },
  empty: {
    alignItems: "center",
    flex: 1,
    gap: space[8],
    justifyContent: "center",
    padding: space[32],
  },
  emptyText: { textAlign: "center" },
  list: { gap: space[8], paddingHorizontal: space[16], paddingTop: space[8] },
  mark: { paddingTop: 2 },
  top: { alignItems: "flex-start", flexDirection: "row", gap: space[12] },
  where: { alignItems: "center", flexDirection: "row", gap: space[6] },
  whereText: { flexShrink: 1 },
  words: { flex: 1, gap: 2, minWidth: 0 },
});
