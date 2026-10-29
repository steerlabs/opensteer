import { MenuView, type MenuAction, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import {
  deploymentMenuItems,
  runDeploymentMenuAction,
  type DeploymentMenuProps,
} from "./deployment-menu-model.js";

/** Android's Compose menu, anchored to one labelled React Native visual. */
export function DeploymentMenu(props: DeploymentMenuProps): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  const actions: MenuAction[] = deploymentMenuItems(props).map((item) => ({
    ...(item.destructive ? { attributes: { destructive: true } } : {}),
    id: item.id,
    title: item.title,
  }));
  return (
    <MenuView
      actions={actions}
      colorScheme="dark"
      onPressAction={({ nativeEvent }) => {
        runDeploymentMenuAction(nativeEvent.event, props);
      }}
      ref={menu}
    >
      <View
        accessibilityActions={[{ label: `More options for ${props.name}`, name: "activate" }]}
        accessibilityLabel={`More for ${props.name}`}
        accessibilityRole="button"
        accessible
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "activate") menu.current?.show();
        }}
        style={styles.trigger}
      >
        <View style={styles.dots}>
          <View style={styles.dot} />
          <View style={styles.dot} />
          <View style={styles.dot} />
        </View>
      </View>
    </MenuView>
  );
}

const styles = StyleSheet.create({
  dot: { backgroundColor: color.muted, borderRadius: radius.full, height: 4, width: 4 },
  dots: { flexDirection: "row", gap: space[4] },
  trigger: {
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
});
