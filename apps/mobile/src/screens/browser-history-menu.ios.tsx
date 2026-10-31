import { Button, Host, Menu } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  disabled as disabledModifier,
  frame,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, touchTarget } from "../theme.js";
import type { BrowserHistoryMenuProps } from "./browser-history-menu.js";

export function BrowserHistoryMenu({
  title,
  disabled,
  onRemove,
}: BrowserHistoryMenuProps): ReactNode {
  return (
    <Host colorScheme="dark" ignoreSafeArea="all" matchContents>
      <Menu
        label="History actions"
        systemImage="ellipsis"
        modifiers={[
          labelStyle("iconOnly"),
          frame({ minHeight: touchTarget, minWidth: touchTarget }),
          tint(color.mutedDim),
          accessibilityLabel(`History actions for ${title}`),
          disabledModifier(disabled),
        ]}
      >
        <Button
          label="Remove from history"
          systemImage="trash"
          role="destructive"
          onPress={() => {
            if (!disabled) onRemove();
          }}
        />
      </Menu>
    </Host>
  );
}
