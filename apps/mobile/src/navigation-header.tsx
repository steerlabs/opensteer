import { attentionCount, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type HostInstance } from "react-native";
import { BrowserButton } from "./browser/browser-button.js";
import { agentWorkingLabel } from "./browser/acting-dot.js";
import { useSidebarControl, useSidebarDock } from "./sidebar/sidebar-context.js";
import { color, headerFontScaleLimit, radius, space, touchTarget } from "./theme.js";
import { useHostValue } from "./ui/mobile-client-context.js";
import { AppText } from "./ui/primitives.js";
import { Symbol } from "./ui/symbol.js";

/**
 * The controls a screen puts in its navigation bar.
 *
 * They live apart from the route table so a screen can set its own bar
 * without importing the table that imports it.
 */

export type HeaderActionSpec = {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  /** A count drawn on the item; the accessibility label must say it too. */
  readonly badge?: string;
  readonly disabled?: boolean;
  readonly icon?:
    | "gearshape"
    | "line.3.horizontal"
    | "plus"
    | "rectangle.on.rectangle"
    | "sidebar.left"
    | "square.and.pencil"
    | "xmark";
  readonly label: string;
  readonly onPress: () => void;
  readonly tintColor?: string;
  readonly variant?: "done" | "plain" | "prominent";
};

/**
 * A header's own actions. iOS receives native bar button descriptions so UIKit
 * owns their appearance and accessibility; Android receives the equivalent
 * React header controls from the stable slots.
 */
export function headerActions(props: {
  readonly left?: HeaderActionSpec;
  readonly right?: HeaderActionSpec;
}): NativeStackNavigationOptions {
  const left = props.left === undefined ? null : <HeaderAction {...props.left} />;
  const right = props.right === undefined ? null : <HeaderAction {...props.right} />;
  return {
    ...(left === null
      ? {}
      : {
          headerLeft: () => left,
          unstable_headerLeftItems: () => [nativeHeaderItem(props.left!)],
        }),
    ...(right === null
      ? {}
      : {
          headerRight: () => right,
          unstable_headerRightItems: () => [nativeHeaderItem(props.right!)],
        }),
  };
}

function nativeHeaderItem(action: HeaderActionSpec): NativeStackHeaderItem {
  return {
    ...(action.accessibilityHint === undefined
      ? {}
      : { accessibilityHint: action.accessibilityHint }),
    accessibilityLabel: action.accessibilityLabel ?? action.label,
    ...(action.badge === undefined
      ? {}
      : {
          badge: {
            style: { backgroundColor: color.amber, color: color.inkOnAmber, fontWeight: "700" },
            value: action.badge,
          },
        }),
    ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
    ...(action.icon === undefined
      ? {}
      : { icon: { name: action.icon, type: "sfSymbol" as const } }),
    label: action.label,
    onPress: action.onPress,
    ...(action.tintColor === undefined ? {} : { tintColor: action.tintColor }),
    type: "button",
    variant: action.variant ?? "plain",
  };
}

/**
 * A conversation's Tabs control in its bar. On iOS it is a native bar item,
 * so UIKit can move it into a vertical bar, keep it in its overflow and give it
 * its own pointer and keyboard focus; a custom view would be left behind. It
 * is green while an agent is acting, and says so in its name, so the state
 * does not rest on colour. Android draws the word with the green dot.
 */
export function browserHeaderActions(
  acting: boolean,
  visible: boolean,
  onPress: () => void,
): NativeStackNavigationOptions {
  const tabs: HeaderActionSpec = {
    accessibilityHint: "Opens this conversation's tabs and apps",
    accessibilityLabel: acting ? `Tabs, ${agentWorkingLabel.toLowerCase()}` : "Tabs",
    icon: "rectangle.on.rectangle",
    label: "Tabs",
    onPress,
    ...(acting ? { tintColor: color.green } : {}),
  };
  return {
    headerRight: () => (visible ? <BrowserButton acting={acting} onPress={onPress} /> : null),
    unstable_headerRightItems: () => (visible ? [nativeHeaderItem(tabs)] : []),
  };
}

const selectAttention = (snapshot: HostSnapshot): number =>
  attentionCount(snapshot.waitingRequests);

/**
 * Puts the Menu in the leading slot of a sidebar destination's bar.
 *
 * iOS draws it as a native bar item; Android draws the same symbol as a
 * 48-point React control, which is also a view the sidebar can hand
 * TalkBack's focus back to when it closes.
 *
 * It carries the number of questions waiting on the reader, in the amber the
 * sidebar marks each of their tasks with: a question asked in some task is
 * otherwise invisible from Chat until the sidebar happens to be opened.
 */
export function useSidebarMenu(hostClient: HostClient | null): void {
  const navigation = useNavigation();
  const sidebar = useSidebarControl();
  const dock = useSidebarDock();
  const attention = useHostValue(hostClient, selectAttention, 0);
  useLayoutEffect(() => {
    if (sidebar === null) return;
    // Where the sidebar docks, the same control shows or hides the column, and
    // its name says which; the questions waiting are in the column's rows then.
    const label = dock === "shown" ? "Hide sidebar" : dock === "hidden" ? "Show sidebar" : "Menu";
    const menu: HeaderActionSpec = {
      ...(dock === "unavailable"
        ? { accessibilityHint: "Shows Chat, your tasks, Specialists, Tabs and Settings" }
        : {}),
      accessibilityLabel: attention === 0 ? label : `${label}, ${attentionPhrase(attention)}`,
      ...(attention === 0 ? {} : { badge: attentionBadge(attention) }),
      icon: dock === "unavailable" ? "line.3.horizontal" : "sidebar.left",
      label,
      onPress: () => sidebar.open(),
    };
    navigation.setOptions({
      headerBackVisible: false,
      headerLeft: () => <MenuHeaderButton {...menu} onOpen={sidebar.open} />,
      unstable_headerLeftItems: () => [nativeHeaderItem(menu)],
    });
  }, [attention, dock, navigation, sidebar]);
}

/**
 * The docked sidebar's control over a task, search or specialist: Show or Hide
 * sidebar beside Back, where the window has room to dock it.
 *
 * Back stays: the control supplements it rather than replacing it, so the
 * screen is left the platform's way. On iOS it is a native bar item, so UIKit
 * can move it into the vertical bar with a label VoiceOver reads and a target
 * a keyboard reaches; Android draws the same symbol as a 48-point control.
 * Where the sidebar cannot dock there is nothing for it to do, and only Back
 * remains.
 */
export function useSidebarToggle(): void {
  const navigation = useNavigation();
  const sidebar = useSidebarControl();
  const dock = useSidebarDock();
  useLayoutEffect(() => {
    if (sidebar === null || dock === "unavailable") {
      navigation.setOptions({
        headerBackVisible: true,
        headerLeft: undefined,
        unstable_headerLeftItems: undefined,
      });
      return;
    }
    const label = dock === "shown" ? "Hide sidebar" : "Show sidebar";
    const toggle: HeaderActionSpec = {
      accessibilityLabel: label,
      icon: "sidebar.left",
      label,
      onPress: () => sidebar.open(),
    };
    navigation.setOptions({
      headerBackVisible: true,
      headerLeft: () => <MenuHeaderButton {...toggle} onOpen={sidebar.open} />,
      unstable_headerLeftItems: () => [nativeHeaderItem(toggle)],
    });
  }, [dock, navigation, sidebar]);
}

/** The count in words, for a screen reader: what the badge says by its number. */
function attentionPhrase(count: number): string {
  return count === 1 ? "1 question needs you" : `${count} questions need you`;
}

/** The count as the badge draws it: past two digits the exact number stops helping. */
function attentionBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function MenuHeaderButton(
  props: HeaderActionSpec & { readonly onOpen: (trigger: HostInstance | null) => void },
): ReactNode {
  const button = useRef<HostInstance>(null);
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={() => props.onOpen(button.current)}
      ref={button}
      style={styles.menu}
    >
      <Symbol
        name={props.icon === "sidebar.left" ? "sidebar.left" : "line.3.horizontal"}
        size={22}
        tint={color.text}
      />
      {props.badge === undefined ? null : (
        <View style={styles.menuBadge}>
          <Text allowFontScaling={false} style={styles.menuBadgeText}>
            {props.badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function HeaderAction(props: HeaderActionSpec): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={space[8]}
      onPress={props.onPress}
      style={styles.headerAction}
    >
      {/* The native header is a fixed height and its side slots a fixed width,
          so its labels are the one place text stops growing before the control
          it sits in would clip it. */}
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="bodyMedium"
        tone={props.disabled === true ? "muted" : "ember"}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerAction: { justifyContent: "center", minHeight: touchTarget },
  // Material's own icon button: a 48-point target around a 24-point glyph.
  menu: {
    alignItems: "center",
    height: 48,
    justifyContent: "center",
    marginLeft: Platform.OS === "android" ? -space[12] : 0,
    width: 48,
  },
  // Material's small badge, over the glyph's trailing corner.
  menuBadge: {
    alignItems: "center",
    backgroundColor: color.amber,
    borderRadius: radius.full,
    height: 16,
    justifyContent: "center",
    minWidth: 16,
    paddingHorizontal: space[4],
    position: "absolute",
    right: space[4],
    top: space[6],
  },
  menuBadgeText: { color: color.inkOnAmber, fontSize: 11, fontWeight: "700" },
});
