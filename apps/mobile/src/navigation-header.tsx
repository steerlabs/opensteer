import { attentionCount, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type HostInstance } from "react-native";
import { agentWorkingLabel } from "./browser/acting-dot.js";
import type { SurfaceGlyph } from "./browser/agent-surface.js";
import { useSidebarControl, useSidebarDocked } from "./sidebar/sidebar-context.js";
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
    | "checklist"
    | "gearshape"
    | SurfaceGlyph
    | "line.3.horizontal"
    | "plus"
    | "rectangle.on.rectangle"
    | "square.and.pencil"
    | "xmark";
  readonly label: string;
  readonly onPress: () => void;
  readonly tintColor?: string;
  readonly variant?: "done" | "plain" | "prominent";
};

/**
 * What every screen in the stack starts from. The bar has one ground,
 * `headerStyle`. At rest against the scroll edge iOS draws the same bar unless
 * a large style gives it another ground, which would also land under a
 * conversation's transparent bar, glass or blur, and hide what scrolls under
 * it. Where the status bar sits in iPhone Duo's vertical bar, that ground
 * starts below the top of the screen and leaves a strip of conversation
 * showing above it.
 */
export const stackScreenOptions: NativeStackNavigationOptions = {
  contentStyle: { backgroundColor: color.background },
  headerBackButtonDisplayMode: "minimal",
  headerLargeTitleStyle: { color: color.text, fontWeight: "700" },
  headerShadowVisible: false,
  headerStyle: { backgroundColor: color.background },
  headerTintColor: color.ember,
  headerTitleStyle: { color: color.text, fontSize: 17, fontWeight: "600" },
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
            style: {
              backgroundColor: action.tintColor ?? color.amber,
              color:
                action.tintColor === undefined || action.tintColor === color.amber
                  ? color.inkOnAmber
                  : color.surfaceElevated,
              fontWeight: "700",
            },
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
 * What a conversation's agent is using, as a control in its bar: a globe for
 * a page, a laptop for a Mac app, a phone for a phone. It is there only while
 * the agent uses one, green while it acts, and opens exactly that page or app.
 *
 * On iOS it is a native bar item, so UIKit can move it into a vertical bar,
 * keep it in its overflow and give it its own pointer and keyboard focus; a
 * custom view would be left behind. Its name says what the colour does.
 */
export function browserHeaderActions(
  surface: {
    readonly acting: boolean;
    readonly glyph: SurfaceGlyph;
    readonly onPress: () => void;
  } | null,
  family?: { readonly action: HeaderActionSpec; readonly content: ReactNode },
): NativeStackNavigationOptions {
  const watch: HeaderActionSpec | null =
    surface === null
      ? null
      : {
          accessibilityHint: `Shows the ${surfaceNoun[surface.glyph]} the agent is using`,
          accessibilityLabel: surface.acting
            ? `${surfaceName[surface.glyph]}, ${agentWorkingLabel.toLowerCase()}`
            : surfaceName[surface.glyph],
          icon: surface.glyph,
          label: surfaceName[surface.glyph],
          onPress: surface.onPress,
          ...(surface.acting ? { tintColor: color.green } : {}),
        };
  return {
    headerRight: () => (
      <View style={styles.trailing}>
        {family?.content}
        {watch === null || surface === null ? null : (
          <Pressable
            accessibilityHint={watch.accessibilityHint}
            accessibilityLabel={watch.accessibilityLabel}
            accessibilityRole="button"
            onPress={watch.onPress}
            style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
          >
            <Symbol
              name={surface.glyph}
              size={22}
              tint={surface.acting ? color.green : color.text}
            />
          </Pressable>
        )}
      </View>
    ),
    unstable_headerRightItems: () => [
      ...(family ? [nativeHeaderItem(family.action)] : []),
      ...(watch === null ? [] : [nativeHeaderItem(watch)]),
    ],
  };
}

const surfaceName: Readonly<Record<SurfaceGlyph, string>> = {
  globe: "Page",
  laptopcomputer: "Mac app",
  smartphone: "Phone",
};
const surfaceNoun: Readonly<Record<SurfaceGlyph, string>> = {
  globe: "page",
  laptopcomputer: "Mac app",
  smartphone: "phone",
};

const selectAttention = (snapshot: HostSnapshot): number =>
  attentionCount(snapshot.waitingRequests);

/**
 * Puts the Menu in the leading slot of a sidebar destination's bar, where the
 * sidebar is a drawer.
 *
 * iOS draws it as a native bar item; Android draws the same symbol as a
 * 48-point React control, which is also a view the sidebar can hand
 * TalkBack's focus back to when it closes.
 *
 * It carries the number of questions waiting on the reader, in the amber the
 * sidebar marks each of their tasks with: a question asked in some task is
 * otherwise invisible from Chat until the sidebar happens to be opened.
 * Docked, the sidebar is in view with those marks on its rows, so the slot is
 * empty: there is nothing to open, and the destination has no Back.
 */
export function useSidebarMenu(hostClient: HostClient | null): void {
  const navigation = useNavigation();
  const sidebar = useSidebarControl();
  const docked = useSidebarDocked();
  const attention = useHostValue(hostClient, selectAttention, 0);
  useLayoutEffect(() => {
    if (sidebar === null) return;
    if (docked) {
      navigation.setOptions({
        headerBackVisible: false,
        headerLeft: () => null,
        unstable_headerLeftItems: () => [],
      });
      return;
    }
    const menu: HeaderActionSpec = {
      accessibilityHint: "Shows Chat, your tasks, Specialists, Tabs and Settings",
      accessibilityLabel: attention === 0 ? "Menu" : `Menu, ${attentionPhrase(attention)}`,
      ...(attention === 0 ? {} : { badge: attentionBadge(attention) }),
      icon: "line.3.horizontal",
      label: "Menu",
      onPress: () => sidebar.open(),
    };
    navigation.setOptions({
      headerBackVisible: false,
      headerLeft: () => <MenuHeaderButton {...menu} onOpen={sidebar.open} />,
      unstable_headerLeftItems: () => [nativeHeaderItem(menu)],
    });
  }, [attention, docked, navigation, sidebar]);
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
      <Symbol name="line.3.horizontal" size={22} tint={color.text} />
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
  icon: { alignItems: "center", height: 48, justifyContent: "center", width: 48 },
  pressed: { opacity: 0.6 },
  trailing: { alignItems: "center", flexDirection: "row", gap: space[8] },
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
