import type { PlaceAgents } from "@opensteer/client/host";
import { memo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AgentPill } from "./agent-marks.js";

/** Where Ask starts work about the page. */
export type AskTarget = "chat" | "task";

/**
 * The one bar under a page, Mac app or phone: who is here on the leading
 * side, Ask on the trailing side. Nothing else.
 *
 * It is drawn from what it is given and memoised, so a streamed token, a new
 * picture or a page title changing elsewhere never redraws it; only who is
 * here, or which of them is beside the page, does.
 */
export const PageBar = memo(function PageBar(props: {
  readonly agents: PlaceAgents;
  /** The Thread drawn beside the page, when one is. */
  readonly beside: string | null;
  /** Chat exists to ask in; before its first message, only a task can be started. */
  readonly chat: boolean;
  readonly intent: "open" | "beside";
  readonly onAsk: (target: AskTarget) => void;
  readonly onOpenAgent: (threadId: string) => void;
}): ReactNode {
  const { onAsk } = props;
  const options: NativeMenuOption[] = [
    ...(props.chat ? [{ id: "chat", label: "Ask in Chat", onPress: () => onAsk("chat") }] : []),
    { id: "task", label: "New task", onPress: () => onAsk("task") },
  ];
  return (
    <View style={styles.bar} testID="page-bar">
      <AgentPill
        agents={props.agents}
        beside={props.beside}
        intent={props.intent}
        onOpen={props.onOpenAgent}
      />
      <NativeMenu
        accessibilityHint="Starts work about this page in Chat or a new task"
        accessibilityLabel="Ask"
        onPresent={noop}
        onSettle={noop}
        options={options}
        style={styles.ask}
        title="Ask about this page"
      >
        <View style={styles.askFace}>
          <Symbol name="sparkles" size={14} tint={color.inkOnEmber} />
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="secondaryMedium"
            style={styles.askLabel}
          >
            Ask
          </AppText>
        </View>
      </NativeMenu>
    </View>
  );
});

function noop(): void {}

const styles = StyleSheet.create({
  ask: { flexShrink: 0, marginStart: "auto" },
  askFace: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space[16],
  },
  askLabel: { color: color.inkOnEmber },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
});
