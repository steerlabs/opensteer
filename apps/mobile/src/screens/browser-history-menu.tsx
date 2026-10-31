import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { View } from "react-native";
import { color, touchTarget } from "../theme.js";
import { Symbol } from "../ui/symbol.js";

export interface BrowserHistoryMenuProps {
  readonly title: string;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}

export function BrowserHistoryMenu({
  title,
  disabled,
  onRemove,
}: BrowserHistoryMenuProps): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  return (
    <MenuView
      ref={menu}
      colorScheme="dark"
      actions={[
        { id: "remove", title: "Remove from history", attributes: { destructive: true, disabled } },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (!disabled && nativeEvent.event === "remove") onRemove();
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`History actions for ${title}`}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: "activate", label: "History actions" }]}
        onAccessibilityAction={() => {
          if (!disabled) menu.current?.show();
        }}
        style={{
          minHeight: touchTarget,
          width: touchTarget,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Symbol name="ellipsis" size={17} tint={color.mutedDim} />
      </View>
    </MenuView>
  );
}
