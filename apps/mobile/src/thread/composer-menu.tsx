import { MenuView, type MenuAction, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { Alert, Platform, Pressable, View, type StyleProp, type ViewStyle } from "react-native";

/**
 * A short list of choices, drawn by the operating system, hung off a control
 * this app drew.
 *
 * `MenuView` is the one menu API that takes a React Native view as its trigger:
 * on iOS it presents a SwiftUI `Menu` and on Android a Compose `DropdownMenu`,
 * so both platforms get the system's own menu while the pill under it stays a
 * single React Native component. The alternative — a SwiftUI `Host` holding the
 * control as well as the menu — cannot hold React Native children, so it would
 * mean drawing the composer's pills twice, and hanging a hosting controller
 * inside the glass bar that grows and shrinks beneath it.
 *
 * A disabled menu is not a dead control. The reason it cannot be used is worth
 * more at the moment of the tap than as a sentence living permanently under the
 * field, so the trigger stays tappable and answers with the reason.
 */

/** SF Symbol names this app's menus draw. Each is also a Material symbol. */
export type NativeMenuIcon =
  "checkmark" | "gearshape" | "link" | "magnifyingglass" | "paperclip" | "photo" | "stop.fill";

export interface NativeMenuOption {
  readonly destructive?: boolean;
  /** Drawn dimmed and unselectable: the choice exists but cannot be made. */
  readonly disabled?: boolean;
  readonly icon?: NativeMenuIcon;
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
  /** Drawn with a checkmark: this is the choice currently in force. */
  readonly selected?: boolean;
}

export function NativeMenu(props: {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
  /** Stated when the control is tapped while it cannot be used. */
  readonly disabledReason?: string | null;
  /** The menu is about to take over: hold the row this trigger stands in. */
  readonly onPresent: () => void;
  /** The menu is gone, by a choice or by a dismissal. */
  readonly onSettle: () => void;
  readonly options: readonly NativeMenuOption[];
  readonly style?: StyleProp<ViewStyle>;
  readonly title?: string;
}): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  const reason = props.disabledReason ?? null;

  if (reason !== null) {
    return (
      <Pressable
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        onPress={() => Alert.alert(props.accessibilityLabel, reason)}
        style={props.style}
      >
        {props.children}
      </Pressable>
    );
  }

  return (
    <MenuView
      actions={props.options.map(menuAction)}
      colorScheme="dark"
      onCloseMenu={props.onSettle}
      onPressAction={({ nativeEvent }) => {
        props.onSettle();
        props.options.find((option) => option.id === nativeEvent.event)?.onPress();
      }}
      // Android's menu is a controlled Compose dropdown, and this is the only
      // handle that opens it without a touch.
      ref={menu}
      style={props.style}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      {/* A plain view, not a Pressable: the tap belongs to the native menu, and
          a second responder competing for it is a tap that sometimes does
          nothing. `onTouchStart` observes the touch without claiming it, which
          is the whole of what the bar needs — the field is about to lose focus
          to the menu, and the row holding this trigger has to stay put while
          the menu is anchored to it. */}
      <View
        accessible
        // Android anchors its dropdown to a trigger that declares itself
        // inaccessible and leaves the node to this view, so TalkBack's
        // activation has to open the menu here. iOS hosts this view *as* the
        // SwiftUI menu's own label: that trigger answers VoiceOver itself, and
        // the installed implementation makes `show()` a no-op, so naming an
        // action here would advertise an activation that never happens.
        {...(Platform.OS === "android"
          ? {
              accessibilityActions: [{ name: "activate", label: props.accessibilityLabel }],
              onAccessibilityAction: () => {
                // No touch reaches the trigger this way, so the bar is told to
                // hold its row here instead of from `onTouchStart`.
                props.onPresent();
                menu.current?.show();
              },
            }
          : {})}
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        onTouchStart={props.onPresent}
      >
        {props.children}
      </View>
    </MenuView>
  );
}

function menuAction(option: NativeMenuOption): MenuAction {
  const attributes = {
    ...(option.destructive === true ? { destructive: true } : {}),
    ...(option.disabled === true ? { disabled: true } : {}),
  };
  return {
    id: option.id,
    title: option.label,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(option.icon === undefined ? {} : { image: option.icon }),
    ...(option.selected === undefined ? {} : { state: option.selected ? "on" : "off" }),
  };
}
