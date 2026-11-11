import { placeAgentState, placeAgentsWords, type PlaceAgents } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackHeaderItemMenuAction } from "@react-navigation/native-stack";
import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { barOverContentOptions } from "../thread/around-button.js";
import {
  NativeMenu,
  type NativeMenuOption,
  type NativeMenuSection,
} from "../thread/composer-menu.js";
import { barItemWidth, useBarTitleWidth } from "../ui/bar-title.js";
import { AgentOrb } from "../team/team-marks.js";
import { GlassSurface, useLiquidGlass } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { ActingDot } from "./acting-dot.js";
import { AgentMarks } from "./agent-marks.js";
import { opensteerAppGlyph } from "./agent-surface.js";
import { ToolbarMenu } from "./toolbar.js";

/** Where Ask starts work about the page. */
export type AskTarget = "chat" | "task" | "thread";

/**
 * The product's orb at a bar item's size, in its own colours: UIKit would
 * otherwise draw an image item as a template in the bar's tint.
 */
const askOrb = require("../../assets/ask-orb.png") as number;

/**
 * An Opensteer App's own actions, offered from its name. There is no Share or
 * Copy link: an app's address is a private credential.
 */
export interface AppMenu {
  /** Close can be chosen now: connected, still open, and not already closing. */
  readonly closable: boolean;
  /** The app is showing, so Reload has a page to reload. */
  readonly live: boolean;
  readonly onClose: () => void;
  /** The conversation that made the app, as its own screen; null while it is not known. */
  readonly onOpenThread: (() => void) | null;
  readonly onReload: () => void;
  readonly onReport: () => void;
}

/**
 * The native bar, for a place with no bar of its own to stand in for it: a tab
 * with no page to drive, under its name, and an Opensteer App. Where iOS has a
 * vertical bar it is also every other place's Back and Ask, with no row and no
 * title: UIKit stands the items in the vertical bar, clear of the page.
 *
 * An app's name is the title and carries the app's menu; on iOS the app runs
 * under the bar, as a conversation does. Android keeps Material's opaque bar,
 * the menu behind its overflow button. Ask is the bar's one action, a native
 * menu: Ask in Chat, once Chat exists, and New task. A place a Thread made is
 * asked about in that Thread, so there Ask is one button rather than a menu.
 *
 * The bar is set again only when what it shows changes; its handlers are
 * read when they are used, so a page that re-renders on every picture never
 * rebuilds a native bar.
 */
export function usePageHeader(props: {
  readonly agents: PlaceAgents;
  /** The app open as this tab, with what its menu can do now; null for any other place. */
  readonly app: AppMenu | null;
  /** Ask goes to the Thread that made this place, with no choice to offer. */
  readonly asksThread: boolean;
  /** Chat exists to ask in; before its first message, only a task can be started. */
  readonly chat: boolean;
  /** The page's own bar has Ask in its More, beside a Thread, so the native bar offers none. */
  readonly noAsk: boolean;
  readonly onAsk: (target: AskTarget) => void;
  readonly onOpenAgent: (threadId: string) => void;
  /** The place's own name. */
  readonly title: string;
  /** The screen has iOS's vertical bar. */
  readonly verticalBar: boolean;
}): void {
  const navigation = useNavigation();
  const glass = useLiquidGlass();
  const latest = useRef(props);
  latest.current = props;
  const { agents, asksThread, chat, noAsk, title, verticalBar } = props;
  const isApp = props.app !== null;
  const appClosable = props.app?.closable === true;
  const appLive = props.app?.live === true;
  const appOpensThread = props.app?.onOpenThread != null;
  // Android's app bar holds More beside Ask.
  const titleWidth = useBarTitleWidth(
    isApp && Platform.OS === "android" ? 2 * barItemWidth : barItemWidth,
  );

  useLayoutEffect(() => {
    const ask = (target: AskTarget) => latest.current.onAsk(target);
    const open = (threadId: string) => latest.current.onOpenAgent(threadId);
    const choices = askChoices({ asksThread: false, chat, onAsk: ask });
    const here = isApp ? [] : agentChoices(agents, open);
    // Over nothing, in the vertical bar: no row, so no title and no ground over the page.
    const noRow = verticalBar && !isApp;
    const appSections = isApp
      ? appMenuSections(
          {
            closable: appClosable,
            live: appLive,
            onClose: () => latest.current.app?.onClose(),
            onOpenThread: appOpensThread ? () => latest.current.app?.onOpenThread?.() : null,
            onReload: () => latest.current.app?.onReload(),
            onReport: () => latest.current.app?.onReport(),
          },
          askChoices({ asksThread, chat, onAsk: ask }),
        )
      : null;
    const askControl = asksThread ? (
      <Pressable
        accessibilityHint={threadHint}
        accessibilityLabel="Ask"
        accessibilityRole="button"
        onPress={() => ask("thread")}
        style={styles.ask}
      >
        <AgentOrb size={22} />
      </Pressable>
    ) : (
      <NativeMenu
        accessibilityHint="Starts work about this page in Chat or a new task"
        accessibilityLabel="Ask"
        onPresent={noop}
        onSettle={noop}
        options={[here, choices]}
        style={styles.ask}
        title="Ask about this page"
      >
        <AgentOrb size={22} />
      </NativeMenu>
    );
    navigation.setOptions({
      ...(isApp && Platform.OS === "ios" ? barOverContentOptions(glass) : {}),
      headerTransparent: noRow || (isApp && Platform.OS === "ios"),
      headerRight: () =>
        appSections !== null && Platform.OS === "android" ? (
          <View style={styles.actions}>
            {askControl}
            <NativeMenu
              accessibilityHint="Shows what you can do with this app"
              accessibilityLabel="More"
              onPresent={noop}
              onSettle={noop}
              options={appSections}
              style={styles.ask}
            >
              <Symbol name="ellipsis" size={20} tint={color.text} />
            </NativeMenu>
          </View>
        ) : (
          askControl
        ),
      headerTitle: () =>
        noRow ? null : appSections !== null ? (
          <AppPill
            maxWidth={titleWidth}
            sections={Platform.OS === "android" ? null : appSections}
            title={title}
          />
        ) : (
          <PageTitle maxWidth={titleWidth} title={title} />
        ),
      title: noRow ? "" : title,
      unstable_headerRightItems: () =>
        noRow && noAsk
          ? []
          : [
              asksThread
                ? {
                    accessibilityHint: threadHint,
                    accessibilityLabel: "Ask",
                    icon: { source: askOrb, tinted: false, type: "image" },
                    label: "Ask",
                    onPress: () => ask("thread"),
                    type: "button",
                  }
                : {
                    accessibilityHint: "Starts work about this page in Chat or a new task",
                    accessibilityLabel: "Ask",
                    // Marks can't stand in a native item, so a working agent is the green glint.
                    ...(agents.unnamedActing || agents.agents.some(({ acting }) => acting)
                      ? {
                          icon: { name: "sparkles" as const, type: "sfSymbol" as const },
                          tintColor: color.green,
                        }
                      : { icon: { source: askOrb, tinted: false, type: "image" as const } }),
                    label: "Ask",
                    menu: {
                      items: [...here, ...choices].map(
                        ({ icon, label, onPress }): NativeStackHeaderItemMenuAction => ({
                          ...(icon === undefined
                            ? {}
                            : { icon: { name: icon, type: "sfSymbol" as const } }),
                          label,
                          onPress,
                          type: "action",
                        }),
                      ),
                      title: "Ask about this page",
                    },
                    type: "menu",
                  },
            ],
    });
  }, [
    agents,
    appClosable,
    appLive,
    appOpensThread,
    asksThread,
    chat,
    glass,
    isApp,
    navigation,
    noAsk,
    title,
    titleWidth,
    verticalBar,
  ]);
}

const threadHint = "Opens the conversation that made this app";

/**
 * Ask's choices as a menu draws them: in the Thread that made the place, or
 * in Chat, once it exists, and a new task. The bar draws them, and so does the
 * page's own More while its bar is put away beside a Thread.
 */
export function askChoices(props: {
  readonly asksThread: boolean;
  readonly chat: boolean;
  readonly onAsk: (target: AskTarget) => void;
}): readonly NativeMenuOption[] {
  const { onAsk } = props;
  if (props.asksThread)
    return [{ icon: "bubble.left", id: "thread", label: "Ask", onPress: () => onAsk("thread") }];
  const newTask: NativeMenuOption = {
    icon: "square.and.pencil",
    id: "task",
    label: "New task",
    onPress: () => onAsk("task"),
  };
  return props.chat
    ? [
        { icon: "bubble.left", id: "chat", label: "Ask in Chat", onPress: () => onAsk("chat") },
        newTask,
      ]
    : [newTask];
}

/** Who is here, as menu rows that open their Threads. */
function agentChoices(
  agents: PlaceAgents,
  onOpenAgent: (threadId: string) => void,
): readonly NativeMenuOption[] {
  return agents.agents.map((agent) => ({
    id: `agent:${agent.threadId}`,
    // Android's menu has no second line, so the state is in the words.
    label: `${agent.title} · ${placeAgentState(agent)}`,
    onPress: () => onOpenAgent(agent.threadId),
  }));
}

/** An app's menu: Ask first, then what the app itself offers, and Close last. */
export function appMenuSections(
  app: AppMenu,
  ask: readonly NativeMenuOption[],
): NativeMenuSection[] {
  return [
    ask.map((option) =>
      option.id === "thread" ? { ...option, label: "Ask about this app" } : option,
    ),
    [
      ...(app.onOpenThread === null
        ? []
        : [
            {
              icon: "bubble.left.and.bubble.right",
              id: "open-thread",
              label: "Open its conversation",
              onPress: app.onOpenThread,
            } satisfies NativeMenuOption,
          ]),
      {
        disabled: !app.live,
        icon: "arrow.clockwise",
        id: "reload",
        label: "Reload",
        onPress: app.onReload,
      },
      {
        icon: "exclamationmark.bubble",
        id: "report",
        label: "Report a problem",
        onPress: app.onReport,
      },
    ],
    [
      {
        destructive: true,
        disabled: !app.closable,
        icon: "xmark.circle",
        id: "close",
        label: "Close tab",
        onPress: app.onClose,
      },
    ],
  ];
}

/**
 * An app's glyph and name, one line, and its menu. Liquid Glass draws it as
 * a capsule beside the bar's own buttons, as it does a conversation's name; a
 * pill floating over the app with no bar under it is always the capsule.
 * Elsewhere it is the bar's plain title, and with no sections it is only the
 * name, as Material's bar keeps its menu behind the overflow button.
 */
export function AppPill(props: {
  readonly floating?: boolean;
  readonly maxWidth: number;
  readonly sections: readonly NativeMenuSection[] | null;
  readonly title: string;
}): ReactNode {
  const glass = useLiquidGlass();
  const words = (
    <>
      <Symbol name={opensteerAppGlyph} size={15} tint={color.muted} />
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="secondaryMedium"
        style={styles.appName}
      >
        {props.title}
      </AppText>
      {props.sections === null ? null : (
        <Symbol name="chevron.down" size={11} tint={color.muted} weight="bold" />
      )}
    </>
  );
  const named =
    props.sections === null ? (
      <View accessibilityRole="header" accessible style={styles.appTrigger}>
        {words}
      </View>
    ) : (
      <NativeMenu
        accessibilityHint="Shows what you can do with this app"
        accessibilityLabel={`${props.title}. Actions`}
        options={props.sections}
        title={props.title}
        triggerStyle={styles.appTrigger}
      >
        {words}
      </NativeMenu>
    );
  if (!glass && props.floating !== true)
    return <View style={[styles.appPlain, { maxWidth: props.maxWidth }]}>{named}</View>;
  return (
    <GlassSurface
      interactive
      shape="capsule"
      style={[styles.appCapsule, { maxWidth: props.maxWidth }]}
    >
      {named}
    </GlassSurface>
  );
}

function noop(): void {}

function PageTitle(props: { readonly maxWidth: number; readonly title: string }): ReactNode {
  return (
    <View style={[styles.title, { maxWidth: props.maxWidth }]}>
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="secondaryMedium"
      >
        {props.title}
      </AppText>
    </View>
  );
}

/** At most this many marks fit the round control, overlapping. */
const askMarks = 2;

/**
 * Ask, and who is here, in one round control on the place's own bar. Its face
 * is the product's orb, or the marks of whoever is here, with the green ring on
 * whoever is acting; its menu opens their Threads and starts work about the page.
 */
export const PageAsk = memo(function PageAsk(props: {
  readonly agents: PlaceAgents;
  /** Chat exists to ask in; before its first message, only a task can be started. */
  readonly chat: boolean;
  readonly onAsk: (target: AskTarget) => void;
  readonly onOpenAgent: (threadId: string) => void;
}): ReactNode {
  const { agents, chat, onAsk, onOpenAgent } = props;
  const words = placeAgentsWords(agents);
  return (
    <ToolbarMenu
      accessibilityHint="Opens who is here, or starts work about this page in Chat or a new task"
      face={
        agents.agents.length > 0 ? (
          <AgentMarks agents={agents.agents.slice(0, askMarks)} />
        ) : agents.unnamedActing ? (
          <ActingDot grouped size={8} />
        ) : (
          <AgentOrb size={22} />
        )
      }
      label={words === null ? "Ask" : `${words.label}. Ask`}
      sections={[agentChoices(agents, onOpenAgent), askChoices({ asksThread: false, chat, onAsk })]}
      title="Ask about this page"
    />
  );
});

const styles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row" },
  appCapsule: { paddingHorizontal: space[12] },
  appName: { flexShrink: 1, fontWeight: "600" },
  appPlain: { alignItems: "center", flexDirection: "row" },
  appTrigger: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space[6],
    minHeight: touchTarget,
  },
  ask: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  title: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
  },
});
