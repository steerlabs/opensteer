import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame, labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, touchTarget } from "../theme.js";
import {
  deploymentMenuItems,
  runDeploymentMenuAction,
  type DeploymentMenuProps,
} from "./deployment-menu-model.js";

/** A native SwiftUI menu with one native, labelled ellipsis trigger. */
export function DeploymentMenu(props: DeploymentMenuProps): ReactNode {
  return (
    <Host colorScheme="dark" ignoreSafeArea="all" matchContents seedColor={color.ember}>
      <Menu
        label="More"
        modifiers={[
          labelStyle("iconOnly"),
          frame({ minHeight: touchTarget, minWidth: touchTarget }),
          tint(color.muted),
          accessibilityLabel(`More for ${props.name}`),
        ]}
        systemImage="ellipsis"
      >
        {deploymentMenuItems(props).map((item) => (
          <Button
            key={item.id}
            label={item.title}
            onPress={() => runDeploymentMenuAction(item.id, props)}
            role={item.destructive ? "destructive" : "default"}
            systemImage={item.systemImage}
          />
        ))}
      </Menu>
    </Host>
  );
}
