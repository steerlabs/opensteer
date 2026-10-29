import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame, labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, touchTarget } from "../theme.js";
import {
  messageActions,
  performMessageAction,
  type MessageMenuOptions,
} from "./message-menu-actions.js";

/**
 * What to do with a message the agent wrote, one step out of the reading
 * column. The glyph is bare rather than circled and takes the dimmest ink the
 * palette has: the prose above it is the row, and a control that can be found
 * when looked for has already done its whole job.
 */
export function MessageMenu(props: MessageMenuOptions): ReactNode {
  return (
    <Host colorScheme="dark" ignoreSafeArea="all" matchContents style={{ alignSelf: "flex-start" }}>
      <Menu
        label="Message actions"
        systemImage="ellipsis"
        modifiers={[
          labelStyle("iconOnly"),
          frame({ minHeight: touchTarget, minWidth: touchTarget }),
          tint(color.mutedDim),
          accessibilityLabel("Message actions"),
        ]}
      >
        {messageActions(props).map((action) => (
          <Button
            key={action.id}
            label={action.title}
            systemImage={action.image}
            onPress={() => performMessageAction(action.id, props)}
          />
        ))}
      </Menu>
    </Host>
  );
}
