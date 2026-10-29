import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, touchTarget } from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import {
  messageActions,
  performMessageAction,
  type MessageMenuOptions,
} from "./message-menu-actions.js";

/** A small native menu keeps message actions out of the reading column. */
export function MessageMenu(props: MessageMenuOptions): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  return (
    <MenuView
      actions={[...messageActions(props)]}
      colorScheme="dark"
      onPressAction={({ nativeEvent }) => {
        performMessageAction(nativeEvent.event, props);
      }}
      ref={menu}
      style={styles.menu}
    >
      <View
        accessible
        accessibilityActions={[{ name: "activate", label: "Message actions" }]}
        accessibilityLabel="Message actions"
        accessibilityRole="button"
        onAccessibilityAction={() => menu.current?.show()}
        style={styles.trigger}
      >
        <Symbol name="ellipsis" size={17} tint={color.mutedDim} />
      </View>
    </MenuView>
  );
}

const styles = StyleSheet.create({
  menu: { alignSelf: "flex-start" },
  // The glyph is small; the region a thumb lands on is not. The row it sits in
  // is the message's own trailing edge, so the extra height costs the
  // transcript nothing.
  trigger: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    width: touchTarget,
  },
});
