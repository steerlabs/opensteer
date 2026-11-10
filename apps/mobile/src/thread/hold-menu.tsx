import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import * as Haptics from "expo-haptics";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  LinkHoldContext,
  useConversationLinks,
  type LinkAction,
  type LinkHold,
} from "./link-context.js";

export interface HoldMenuProps {
  readonly actions: readonly LinkAction[];
  readonly children: ReactNode;
  readonly onAction: (id: string) => void;
  /** The corner the lifted view is cut to, on a platform that lifts it. */
  readonly previewRadius: number;
  readonly previewBottomEndRadius?: number | undefined;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Held, a bubble opens the platform's menu. The menu's native host mounts only
 * while it is open: one per row would be paid for by every bubble in a long
 * Thread, for a menu almost none of them will open. A link answers its own
 * hold, so holding one opens the link's places in the same menu.
 */
export function HoldMenu(props: HoldMenuProps): ReactNode {
  const { onAction } = props;
  const links = useConversationLinks();
  const menu = useRef<MenuComponentRef>(null);
  const [held, setHeld] = useState<{ readonly url: string | null } | null>(null);
  // Android selects the word under a held link in selectable words, and keeps its bar after
  // the link's menu closes; drawn again, the words drop that selection.
  const [linkHolds, setLinkHolds] = useState(0);
  useEffect(() => {
    if (held) menu.current?.show();
  }, [held]);
  const linkHold = useMemo(
    (): LinkHold => ({
      press: noop,
      hold: (url) => {
        if (links === null || links.menu(url).length === 0) return;
        void Haptics.selectionAsync();
        setHeld({ url });
        setLinkHolds((count) => count + 1);
      },
    }),
    [links],
  );
  const url = held?.url ?? null;
  const actions = url !== null && links ? links.menu(url) : props.actions;
  return (
    <Pressable
      accessibilityActions={props.actions.map(({ id, title }) => ({ name: id, label: title }))}
      android_disableSound
      delayLongPress={300}
      onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
      onLongPress={() => {
        if (props.actions.length === 0) return;
        void Haptics.selectionAsync();
        setHeld({ url: null });
      }}
      style={({ pressed }) => [props.style, pressed && props.actions.length > 0 && styles.pressed]}
    >
      <LinkHoldContext.Provider value={links ? linkHold : null}>
        <Fragment key={linkHolds}>{props.children}</Fragment>
      </LinkHoldContext.Provider>
      {held ? (
        <MenuView
          actions={actions.map(({ id, title }) => ({ id, title }))}
          colorScheme="dark"
          onCloseMenu={() => setHeld(null)}
          onPressAction={({ nativeEvent }) => {
            if (url !== null && links) links.act(url, nativeEvent.event);
            else onAction(nativeEvent.event);
          }}
          ref={menu}
          style={styles.anchor}
        >
          <View />
        </MenuView>
      ) : null}
    </Pressable>
  );
}

function noop(): void {}

const styles = StyleSheet.create({
  anchor: { bottom: 0, left: 0, position: "absolute" },
  pressed: { opacity: 0.86 },
});
