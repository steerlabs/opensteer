import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ContextMenu } from "../../modules/context-menu/index.js";
import type { HoldMenuProps } from "./hold-menu.js";

/**
 * Held, a bubble lifts into iOS's own menu. The system draws all of it, so
 * JavaScript does nothing until an action is picked. VoiceOver can't hold, so
 * the same actions stand on an element of their own after the bubble: on the
 * bubble they would hide its links and Show more, and iOS reads a Text through
 * elements that can't carry them.
 */
export function HoldMenu(props: HoldMenuProps): ReactNode {
  const { actions, onAction } = props;
  const native = useMemo(
    () => actions.map(({ group, id, image, title }) => ({ group, id, systemImage: image, title })),
    [actions],
  );
  return (
    <ContextMenu
      actions={native}
      onAction={(event) => onAction(event.nativeEvent.id)}
      previewRadius={props.previewRadius}
      style={props.style}
    >
      <View collapsable={false}>{props.children}</View>
      {actions.length === 0 ? null : (
        <View
          accessibilityActions={actions.map(({ id, title }) => ({ name: id, label: title }))}
          accessibilityLabel="Message actions"
          accessible
          onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
          style={styles.actions}
        />
      )}
    </ContextMenu>
  );
}

const styles = StyleSheet.create({
  actions: { bottom: 0, height: 1, position: "absolute", right: 0, width: 1 },
});
