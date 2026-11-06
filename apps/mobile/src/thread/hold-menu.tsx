import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { MessageAction } from "./message-actions.js";

export interface HoldMenuProps {
  readonly actions: readonly MessageAction[];
  readonly children: ReactNode;
  readonly onAction: (id: string) => void;
  /** The corner the lifted view is cut to, on a platform that lifts it. */
  readonly previewRadius: number;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Held, a bubble opens the platform's menu. The menu's native host mounts only
 * while it is open: one per row would be paid for by every bubble in a long
 * Thread, for a menu almost none of them will open.
 */
export function HoldMenu(props: HoldMenuProps): ReactNode {
  const { actions, onAction } = props;
  const menu = useRef<MenuComponentRef>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) menu.current?.show();
  }, [held]);
  return (
    <Pressable
      accessibilityActions={actions.map(({ id, title }) => ({ name: id, label: title }))}
      android_disableSound
      delayLongPress={300}
      onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
      onLongPress={() => {
        if (actions.length === 0) return;
        void Haptics.selectionAsync();
        setHeld(true);
      }}
      style={({ pressed }) => [props.style, pressed && styles.pressed]}
    >
      {props.children}
      {held ? (
        <MenuView
          actions={actions.map(({ id, title }) => ({ id, title }))}
          colorScheme="dark"
          onCloseMenu={() => setHeld(false)}
          onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
          ref={menu}
          style={styles.anchor}
        >
          <View />
        </MenuView>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  anchor: { bottom: 0, left: 0, position: "absolute" },
  pressed: { opacity: 0.86 },
});
