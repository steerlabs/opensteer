import {
  placeAgentState,
  placeAgentsWords,
  type PlaceAgent,
  type PlaceAgents,
} from "@opensteer/client/host";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { ActingDot } from "./acting-dot.js";

/** Marks drawn side by side before the rest are only counted in words. */
const shownMarks = 3;

/**
 * Who is in a place, as overlapping marks: each task's mark, Chat's orb, a
 * green ring on whoever is acting now. Marks are pictures of the words beside
 * them, so they are silent to a screen reader.
 */
export const AgentMarks = memo(function AgentMarks(props: {
  readonly agents: readonly PlaceAgent[];
  readonly size?: 16 | 20;
}): ReactNode {
  const size = props.size ?? 20;
  if (props.agents.length === 0) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.marks}
    >
      {props.agents.slice(0, shownMarks).map((agent, index) => (
        <View
          key={agent.threadId}
          style={[
            styles.mark,
            index > 0 && { marginStart: -size / 3 },
            agent.acting && {
              borderColor: color.green,
              borderRadius: agent.home ? radius.full : radius.sm,
            },
          ]}
        >
          {agent.home || agent.mark === null ? (
            <ChatOrb size={size} />
          ) : (
            <TaskMark mark={agent.mark} size={size} />
          )}
        </View>
      ))}
    </View>
  );
});

/**
 * The agent pill on a page's bar: who is in this tab, app or phone, and
 * whether they are working.
 *
 * One agent is a button that opens its Thread. Several are a native menu —
 * working first, then most recently active — and choosing one opens it; the
 * one shown beside the page carries the check. An agent acting with no name
 * the reader can open is said, never offered. Nobody here draws nothing.
 */
export const AgentPill = memo(function AgentPill(props: {
  readonly agents: PlaceAgents;
  /** The Thread drawn beside the page, when one is. */
  readonly beside: string | null;
  /** What choosing an agent does, said by the menu's title and the button's hint. */
  readonly intent: "open" | "beside";
  readonly onOpen: (threadId: string) => void;
}): ReactNode {
  const { agents, beside, intent, onOpen } = props;
  const words = placeAgentsWords(agents);
  if (words === null) return null;
  const list = agents.agents;
  const working = list.some(({ acting }) => acting) || agents.unnamedActing;
  const face = (chevron: "chevron.down" | "chevron.right" | null) => (
    <View style={styles.pill}>
      {list.length === 0 ? <ActingDot grouped size={8} /> : <AgentMarks agents={list} />}
      <View style={styles.words}>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
        >
          {words.title}
        </AppText>
        {words.detail === null ? null : (
          <View style={styles.detail}>
            {working ? <ActingDot grouped size={6} /> : null}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              tone="muted"
            >
              {words.detail}
            </AppText>
          </View>
        )}
      </View>
      {chevron === null ? null : <Symbol name={chevron} size={12} tint={color.muted} />}
    </View>
  );
  if (list.length === 0)
    return (
      <View accessibilityLabel={words.label} accessible style={styles.slot}>
        {face(null)}
      </View>
    );
  if (list.length === 1) {
    const agent = list[0]!;
    return (
      <Pressable
        accessibilityHint={
          intent === "beside" ? "Shows its thread beside the page" : "Opens its thread"
        }
        accessibilityLabel={words.label}
        accessibilityRole="button"
        onPress={() => onOpen(agent.threadId)}
        style={({ pressed }) => [styles.slot, pressed && styles.pressed]}
      >
        {face(intent === "beside" ? null : "chevron.right")}
      </Pressable>
    );
  }
  return (
    <NativeMenu
      accessibilityHint={
        intent === "beside"
          ? "Chooses whose thread is shown beside the page"
          : "Chooses an agent's thread to open"
      }
      accessibilityLabel={words.label}
      onPresent={noop}
      onSettle={noop}
      options={list.map((agent) => ({
        id: agent.threadId,
        // Android's menu has no second line, so the state is in the words.
        label: `${agent.title} · ${placeAgentState(agent)}`,
        onPress: () => onOpen(agent.threadId),
        ...(intent === "beside" ? { selected: agent.threadId === beside } : {}),
      }))}
      style={styles.slot}
      title={intent === "beside" ? "Show beside the page" : "Open a thread"}
    >
      {face("chevron.down")}
    </NativeMenu>
  );
});

function noop(): void {}

const styles = StyleSheet.create({
  detail: { alignItems: "center", flexDirection: "row", gap: space[4] },
  mark: { borderColor: "transparent", borderWidth: 1.5, padding: 1 },
  marks: { alignItems: "center", flexDirection: "row" },
  pill: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingEnd: space[14],
    paddingStart: space[6],
    paddingVertical: space[4],
  },
  pressed: { opacity: 0.7 },
  // The pill takes what Ask leaves, and no more than its words need.
  slot: { flexShrink: 1, minWidth: 0 },
  words: { flexShrink: 1, minWidth: 0 },
});
