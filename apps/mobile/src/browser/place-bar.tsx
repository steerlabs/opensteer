import { useNavigation } from "@react-navigation/native";
import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ToolbarButton } from "./toolbar.js";

interface PlaceBar {
  /** Ask and who is here, as the screen around the place built it. */
  readonly ask: ReactNode;
  /** The system's vertical bar holds the native Back and Ask, so the place's bar leaves them out. */
  readonly verticalBar: boolean;
}

const PlaceBarContext = createContext<PlaceBar>({ ask: null, verticalBar: false });

export function PlaceBarProvider(props: PlaceBar & { readonly children: ReactNode }): ReactNode {
  const { ask, children, verticalBar } = props;
  const value = useMemo(() => ({ ask, verticalBar }), [ask, verticalBar]);
  return <PlaceBarContext.Provider value={value}>{children}</PlaceBarContext.Provider>;
}

/**
 * Whether this screen has iOS's vertical bar, measured where the screen is: it
 * is the one thing that insets a single side, as a notch insets both. UIKit
 * moves native bar items into it, and only then is a native bar free of a row
 * over the page. Ask at a screen's root: a pane beside another has one-sided
 * insets of its own.
 */
export function useVerticalBar(): boolean {
  const { left, right } = useSafeAreaInsets();
  return Platform.OS === "ios" && left !== right;
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

/** The way out of a place, standing for the native Back its bar replaced. */
export function ToolbarLeave(): ReactNode {
  const navigation = useNavigation();
  if (useContext(PlaceBarContext).verticalBar) return null;
  return (
    <ToolbarButton
      accessibilityHint="Returns to the previous screen"
      label="Back"
      onPress={() => navigation.goBack()}
      symbol="chevron.left"
    />
  );
}

/** Where a place's bar shows Ask. A bar outside a place shows nothing. */
export function ToolbarAsk(): ReactNode {
  const { ask, verticalBar } = useContext(PlaceBarContext);
  return verticalBar ? null : ask;
}
