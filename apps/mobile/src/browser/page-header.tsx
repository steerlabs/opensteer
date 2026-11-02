import { placeAgentsWords, type PlaceAgents } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackHeaderItemMenuAction } from "@react-navigation/native-stack";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, headerFontScaleLimit, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AgentPill } from "./agent-marks.js";

/** Where Ask starts work about the page. */
export type AskTarget = "chat" | "task";

/**
 * The bar over a tab, Mac app or phone, the same however it was reached: the
 * native Back, who is here as the title, and Ask.
 *
 * Who is here is the title because they are what the place is about once it
 * is open — the page names itself in its own bar below. With nobody here the
 * title is the place's own name. Ask is the bar's one action, a native menu:
 * Ask in Chat, once Chat exists, and New task.
 *
 * The bar is set again only when what it shows changes; its handlers are
 * read when they are used, so a page that re-renders on every picture never
 * rebuilds a native bar.
 */
export function usePageHeader(props: {
  readonly agents: PlaceAgents;
  /** The Thread drawn beside the page, when one is. */
  readonly beside: string | null;
  /** Chat exists to ask in; before its first message, only a task can be started. */
  readonly chat: boolean;
  readonly intent: "open" | "beside";
  readonly onAsk: (target: AskTarget) => void;
  readonly onOpenAgent: (threadId: string) => void;
  /** The place's own name, the title when nobody is here. */
  readonly title: string;
}): void {
  const navigation = useNavigation();
  const latest = useRef(props);
  latest.current = props;
  const { agents, beside, chat, intent, title } = props;

  useLayoutEffect(() => {
    const ask = (target: AskTarget) => latest.current.onAsk(target);
    const open = (threadId: string) => latest.current.onOpenAgent(threadId);
    const inChat: NativeMenuOption = {
      icon: "bubble.left",
      id: "chat",
      label: "Ask in Chat",
      onPress: () => ask("chat"),
    };
    const newTask: NativeMenuOption = {
      icon: "square.and.pencil",
      id: "task",
      label: "New task",
      onPress: () => ask("task"),
    };
    const choices = chat ? [inChat, newTask] : [newTask];
    navigation.setOptions({
      headerRight: () => (
        <NativeMenu
          accessibilityHint="Starts work about this page in Chat or a new task"
          accessibilityLabel="Ask"
          onPresent={noop}
          onSettle={noop}
          options={choices}
          style={styles.ask}
          title="Ask about this page"
        >
          <Symbol name="sparkles" size={20} tint={color.ember} />
        </NativeMenu>
      ),
      headerTitle: () => (
        <PageTitle agents={agents} beside={beside} intent={intent} onOpen={open} title={title} />
      ),
      title,
      unstable_headerRightItems: () => [
        {
          accessibilityHint: "Starts work about this page in Chat or a new task",
          accessibilityLabel: "Ask",
          icon: { name: "sparkles", type: "sfSymbol" },
          label: "Ask",
          menu: {
            items: choices.map(({ icon, label, onPress }): NativeStackHeaderItemMenuAction => ({
              ...(icon === undefined ? {} : { icon: { name: icon, type: "sfSymbol" as const } }),
              label,
              onPress,
              type: "action",
            })),
            title: "Ask about this page",
          },
          tintColor: color.ember,
          type: "menu",
        },
      ],
    });
  }, [agents, beside, chat, intent, navigation, title]);
}

function noop(): void {}

function PageTitle(props: {
  readonly agents: PlaceAgents;
  readonly beside: string | null;
  readonly intent: "open" | "beside";
  readonly onOpen: (threadId: string) => void;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.title}>
      {placeAgentsWords(props.agents) === null ? (
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
        >
          {props.title}
        </AppText>
      ) : (
        <AgentPill
          agents={props.agents}
          beside={props.beside}
          intent={props.intent}
          onOpen={props.onOpen}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ask: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  // Wide enough for a task's name, never reaching the bar's own controls: the
  // native title slot is centred between them.
  title: { alignItems: "center", justifyContent: "center", maxWidth: 260, minHeight: touchTarget },
});
