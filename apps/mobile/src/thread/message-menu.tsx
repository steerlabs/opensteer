import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, touchTarget } from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import type { MessageAction } from "./message-actions.js";

export interface MessageMenuProps {
  readonly actions: readonly MessageAction[];
  readonly onAction: (id: string) => void;
}

/** A small native menu keeps a task's message actions out of the reading column. */
export function MessageMenu(props: MessageMenuProps): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  return (
    <MenuView
      actions={props.actions.map(({ id, image, title }) => ({ id, image, title }))}
      colorScheme="dark"
      onPressAction={({ nativeEvent }) => {
        props.onAction(nativeEvent.event);
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
  // The glyph is small; the region a thumb lands on is not.
  trigger: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    width: touchTarget,
  },
});
