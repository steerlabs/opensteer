import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { randomUUID } from "expo-crypto";
import { useNavigation } from "@react-navigation/native";
import type { ViewProps } from "react-native";
import Animated from "react-native-reanimated";
import { PhoneBrowserHost } from "../../modules/phone-browser/index.js";
import { edgeSwipe } from "../browser/floating-bar.js";
import { usePageChrome } from "../browser/floating-page.js";
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
  useLayoutEffect(() => {
    if (edgeSwipe({ canGoBack }) === "leave") return;
    navigation.setOptions({ gestureEnabled: false });
    return () => navigation.setOptions({ gestureEnabled: true });
  }, [canGoBack, navigation]);
  return (
    <AnimatedHost
      {...viewProps}
      barInsets={chrome?.barInsets ?? null}
      hostId={hostId}
      key={admission.surfaceId}
      onReady={ready}
      pageGestures
      pageScroll={chrome?.onPageScroll != null}
      {...(chrome?.onPageScroll ? { onPageScroll: chrome.onPageScroll } : {})}
    />
  );
}
