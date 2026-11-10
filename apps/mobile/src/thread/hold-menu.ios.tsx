import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ContextMenu } from "../../modules/context-menu/index.js";
import {
  LinkHoldContext,
  useConversationLinks,
  type LinkAction,
  type LinkHold,
} from "./link-context.js";
import type { HoldMenuProps } from "./hold-menu.js";

/**
 * Held, a bubble lifts into iOS's own menu. The system draws all of it, so
 * JavaScript does nothing until an action is picked. VoiceOver can't hold, so
 * the same actions stand on an element of their own after the bubble: on the
 * bubble they would hide its links and Show more, and iOS reads a Text through
 * elements that can't carry them.
 *
 * A hold that began on a link offers the link's places instead, as Messages
 * does: the press names the link long before iOS asks for the menu.
 */
export function HoldMenu(props: HoldMenuProps): ReactNode {
  const { onAction } = props;
  const links = useConversationLinks();
  const [pressed, setPressed] = useState<{ readonly url: string; readonly at: number } | null>(
    null,
  );
  const hold = useMemo(
    (): LinkHold => ({ press: (url, at) => setPressed({ url, at }), hold: noop }),
    [],
  );
  const linkActions = useMemo(
    () => (pressed && links ? links.menu(pressed.url) : []),
    [links, pressed],
  );
  const actions: readonly LinkAction[] = linkActions.length > 0 ? linkActions : props.actions;
  const native = useMemo(
    () => actions.map(({ group, id, image, title }) => ({ group, id, systemImage: image, title })),
    [actions],
  );
  const act = (id: string): void => {
    if (pressed && links && linkActions.length > 0) links.act(pressed.url, id);
    else onAction(id);
  };
  return (
    <ContextMenu
      actions={native}
      onAction={(event) => act(event.nativeEvent.id)}
      previewBottomEndRadius={props.previewBottomEndRadius}
      previewRadius={props.previewRadius}
      style={props.style}
    >
      <View
        collapsable={false}
        // A touch and the link press it makes carry one time; an older press is over.
        onTouchStart={(event) => {
          const at = event.nativeEvent.timestamp;
          setPressed((held) => (held === null || held.at >= at ? held : null));
        }}
      >
        <LinkHoldContext.Provider value={links ? hold : null}>
          {props.children}
        </LinkHoldContext.Provider>
      </View>
      {props.actions.length === 0 ? null : (
        <View
          accessibilityActions={props.actions.map(({ id, title }) => ({ name: id, label: title }))}
          accessibilityLabel="Message actions"
          accessible
          onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
          style={styles.actions}
        />
      )}
    </ContextMenu>
  );
}

function noop(): void {}

const styles = StyleSheet.create({
  actions: { bottom: 0, height: 1, position: "absolute", right: 0, width: 1 },
});
