import { useNavigation } from "@react-navigation/native";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { HostInstance } from "react-native";
import {
  attentionBadge,
  menuHint,
  menuLabel,
  useIsTopLevel,
  useIsPresented,
  useMenuAttention,
} from "../navigation-header.js";
import { useSidebarControl, useSidebarDocked } from "../sidebar/sidebar-context.js";
import { ToolbarButton } from "./toolbar.js";

interface PlaceBar {
  /** Ask and who is here, as the screen around the place built it. */
  readonly ask: ReactNode;
  /** What the conversation the place was opened from is doing, while there is anything to say. */
  readonly status: ReactNode;
  /** The system's vertical bar holds the native Back and Ask, so the place's bar leaves them out. */
  readonly verticalBar: boolean;
}

const PlaceBarContext = createContext<PlaceBar>({ ask: null, status: null, verticalBar: false });

export function PlaceBarProvider(props: PlaceBar & { readonly children: ReactNode }): ReactNode {
  const { ask, children, status, verticalBar } = props;
  const value = useMemo(() => ({ ask, status, verticalBar }), [ask, status, verticalBar]);
  return <PlaceBarContext.Provider value={value}>{children}</PlaceBarContext.Provider>;
}

/**
 * Puts the native bar away while a place draws its own. A streamed page cannot
 * run under a bar, so the bar's row would cost the page its height, and the
 * place's own bar already names it. Only what draws its own bar asks, so a
 * state without one (ended, or still finding its tab) keeps the native Back.
 * The vertical bar stays: it holds Back and Ask beside the page, over nothing.
 */
export function useNativeBarAway(away = true): void {
  const navigation = useNavigation();
  const { verticalBar } = useContext(PlaceBarContext);
  const hide = away && !verticalBar;
  useLayoutEffect(() => {
    if (!hide) return;
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [hide, navigation]);
}

/**
 * The way out, standing for the leading control the native bar would have had:
 * the Menu where the page is top-level (opened from the sidebar), else Back.
 * The vertical bar holds it instead, unless the native bar is put away even
 * there (`ownRow`).
 */
export function ToolbarLeave(props: { readonly ownRow?: boolean }): ReactNode {
  const navigation = useNavigation();
  const verticalBar = useContext(PlaceBarContext).verticalBar;
  const topLevel = useIsTopLevel();
  if (verticalBar && props.ownRow !== true) return null;
  if (topLevel) return <ToolbarMenuButton />;
  return (
    <>
      <ToolbarButton
        accessibilityHint="Returns to the previous screen"
        label="Back"
        onPress={() => navigation.goBack()}
        symbol="chevron.left"
      />
      <ToolbarMenuButton />
    </>
  );
}

/** The Menu, only where a drawer sidebar can open from this screen. */
function ToolbarMenuButton(): ReactNode {
  const sidebar = useSidebarControl();
  const docked = useSidebarDocked();
  const presented = useIsPresented();
  if (sidebar === null || docked || presented) return null;
  return <ToolbarMenu sidebar={sidebar} />;
}

function ToolbarMenu({
  sidebar,
}: {
  readonly sidebar: NonNullable<ReturnType<typeof useSidebarControl>>;
}): ReactNode {
  const attention = useMenuAttention();
  const button = useRef<HostInstance>(null);
  return (
    <ToolbarButton
      accessibilityHint={menuHint}
      {...(attention === 0 ? {} : { badge: attentionBadge(attention) })}
      label={menuLabel(attention)}
      onPress={() => sidebar.open(button.current)}
      ref={button}
      symbol="line.3.horizontal"
    />
  );
}

/** Where a place's bar shows Ask. A bar outside a place shows nothing. */
export function ToolbarAsk(): ReactNode {
  const { ask, verticalBar } = useContext(PlaceBarContext);
  return verticalBar ? null : ask;
}

/** The status row the screen around the place built, or null. */
export function usePlaceBarStatus(): ReactNode {
  return useContext(PlaceBarContext).status;
}
