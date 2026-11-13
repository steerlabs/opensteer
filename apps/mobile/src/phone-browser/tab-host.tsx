import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { randomUUID } from "expo-crypto";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { BackHandler, type ViewProps } from "react-native";
import Animated from "react-native-reanimated";
import { PhoneBrowserHost } from "../../modules/phone-browser/index.js";
import { edgeSwipe } from "../browser/floating-bar.js";
import { usePageChrome } from "../browser/floating-page.js";
import { useIsTopLevel } from "../navigation-header.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import { usePhoneTabPresentation } from "./presentation.js";

const AnimatedHost = Animated.createAnimatedComponent(PhoneBrowserHost);

export function PhoneBrowserTabHost(
  props: ViewProps & {
    readonly manager: PhoneBrowserManager;
    readonly admission: PhonePresentationAdmission;
    readonly onError: (error: unknown) => void;
  },
) {
  const { manager, admission, onError, ...viewProps } = props;
  const [hostId] = useState(randomUUID);
  const ready = useCallback(() => {
    void manager.presentTab(admission, hostId).catch(onError);
  }, [manager, admission, hostId, onError]);
  useEffect(
    () => () => {
      void manager.hideTab(admission.surfaceId, hostId).catch(onError);
    },
    [manager, admission.surfaceId, hostId, onError],
  );
  const chrome = usePageChrome();
  // The page's own swipe goes back through its history; the screen's leaves once it has none.
  const canGoBack = usePhoneTabPresentation(manager, admission.surfaceId)?.canGoBack === true;
  const navigation = useNavigation();
  // A screen over this one takes Back and the pull; the page's gestures wait until it is shown again.
  const focused = useIsFocused();
  // A top-level page has no swipe back to lend the page: its stack options keep it off.
  const topLevel = useIsTopLevel();
  useLayoutEffect(() => {
    if (topLevel || edgeSwipe({ canGoBack }) === "leave") return;
    navigation.setOptions({ gestureEnabled: false });
    return () => navigation.setOptions({ gestureEnabled: true });
  }, [canGoBack, navigation, topLevel]);
  // Android's Back reaches JavaScript before any native handler, on every version, so the page's
  // history claims it here, ahead of the screen's.
  useEffect(() => {
    if (!focused || edgeSwipe({ canGoBack }) === "leave") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      void manager.goBack(admission.surfaceId).catch(() => undefined);
      return true;
    });
    return () => subscription.remove();
  }, [admission.surfaceId, canGoBack, focused, manager]);
  return (
    <AnimatedHost
      {...viewProps}
      barInsets={chrome?.barInsets ?? null}
      hostId={hostId}
      key={admission.surfaceId}
      onReady={ready}
      pageGestures={focused}
      pageScroll={chrome?.onPageScroll != null}
      {...(chrome?.onPageScroll ? { onPageScroll: chrome.onPageScroll } : {})}
    />
  );
}
