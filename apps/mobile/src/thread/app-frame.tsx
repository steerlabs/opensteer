import type { HostClient } from "@opensteer/client/host";
import { useAppView } from "@opensteer/client/react";
import { appContentHeight, appFrameReady, isAppNavigation } from "@opensteer/shared/appFrame";
import { isRecord } from "@opensteer/shared/isRecord";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { EdgeInsets } from "../layout.js";
import { color, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** An app filling a tab, under chrome that is the tab's rather than the app's. */
export interface AppTabFrame {
  /**
   * What the tab's chrome covers at each edge. The app scrolls under it on
   * iOS, as a page under Safari's bars does, and keeps clear of it elsewhere.
   */
  readonly chrome: EdgeInsets;
  /** Set while the app is showing, to load it again. */
  readonly reloadRef: RefObject<(() => void) | null>;
}

/**
 * One live copy of an app: in a transcript card, sized to what it reports, or
 * filling a tab's page, where the page gives it its size.
 */
export function AppFrame(props: {
  readonly appId: string;
  readonly client: HostClient | null;
  readonly onTitle?: (title: string) => void;
  readonly tab?: AppTabFrame;
}): ReactNode {
  const { onTitle, tab } = props;
  const { view, failed, retry } = useAppView(props.client, props.appId, "dark");
  useEffect(() => {
    if (view) onTitle?.(view.app.title);
  }, [view, onTitle]);
  if (tab !== undefined)
    return <TabFrame failed={failed} retry={retry} tab={tab} url={view?.url ?? null} />;
  if (failed) return <AppFailure retry={retry} />;
  if (!view) return <ActivityIndicator accessibilityLabel="Loading app" style={styles.notice} />;
  return <CardDocument key={view.url} url={view.url} retry={retry} />;
}

function AppFailure(props: {
  readonly retry: () => void;
  readonly style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.retry}
      style={props.style ?? styles.notice}
    >
      <AppText>Could not load this app. Tap to retry.</AppText>
    </Pressable>
  );
}

function openExternal(url: string): void {
  if (/^https?:\/\//iu.test(url)) void Linking.openURL(url).catch(() => undefined);
}

/** What every copy of an app is held to: no shared storage, and only its own pages inside. */
function isolation(url: string): WebViewProps {
  return {
    source: { uri: url },
    // Route every scheme through our policy; WebView otherwise opens non-whitelisted URLs itself.
    originWhitelist: ["*"],
    // A link preview offers Copy and Share of a URL that can carry the private view token.
    allowsLinkPreview: false,
    sharedCookiesEnabled: false,
    thirdPartyCookiesEnabled: false,
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    mixedContentMode: "never",
    geolocationEnabled: false,
    mediaCapturePermissionGrantType: "deny",
    allowsInlineMediaPlayback: false,
    javaScriptCanOpenWindowsAutomatically: false,
    setSupportMultipleWindows: true,
    onShouldStartLoadWithRequest: (request): boolean => {
      if (request.url === "about:blank" || isAppNavigation(request.url, url)) return true;
      if (
        request.isTopFrame !== false &&
        (request.navigationType === "click" || request.navigationType === undefined)
      )
        openExternal(request.url);
      return false;
    },
    onOpenWindow: (event) => openExternal(event.nativeEvent.targetUrl),
  };
}

/**
 * Whether the app has said it is ready, and the load events that decide it
 * failed when it never does. A page's messages carry no native authority, so
 * each is parsed for exactly what it may say.
 */
function useAppLoad(onMessage: (message: unknown) => void) {
  const [loadFailed, setLoadFailed] = useState(false);
  const ready = useRef(false);
  const settle = () => {
    if (!ready.current) setLoadFailed(true);
  };
  const events: WebViewProps = {
    onMessage: (event: WebViewMessageEvent) => {
      let message: unknown;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (appFrameReady(message)) {
        ready.current = true;
        setLoadFailed(false);
      }
      onMessage(message);
    },
    onLoadStart: () => {
      ready.current = false;
    },
    onLoad: settle,
    onError: settle,
    onHttpError: () => {
      /* A prepared error document can still send ready before onLoadEnd. */
    },
    onLoadEnd: settle,
  };
  return { events, loadFailed };
}

function CardDocument(props: { readonly url: string; readonly retry: () => void }) {
  const [height, setHeight] = useState(280);
  const { events, loadFailed } = useAppLoad((message) => {
    const reported = appContentHeight(message);
    if (reported !== null) setHeight(reported);
  });
  if (loadFailed) return <AppFailure retry={props.retry} />;
  const frameStyle = {
    height: Math.max(160, Math.min(640, height)),
    flex: 0,
    backgroundColor: "transparent",
  };
  return (
    <WebView
      {...isolation(props.url)}
      {...events}
      style={frameStyle}
      containerStyle={frameStyle}
      startInLoadingState
      renderLoading={() => <ActivityIndicator accessibilityLabel="Loading app" />}
    />
  );
}

/** How long a tab waits on its app before it says it is still loading. */
const waitShown = 400;

/**
 * An app as a tab's page: on the app's own ground from the first frame, shown
 * once it says it is ready rather than painting in pieces, and saying it is
 * loading only when that takes long enough to notice.
 */
function TabFrame(props: {
  readonly failed: boolean;
  readonly retry: () => void;
  readonly tab: AppTabFrame;
  readonly url: string | null;
}): ReactNode {
  const { chrome } = props.tab;
  const [ground, setGround] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), waitShown);
    return () => clearTimeout(timer);
  }, []);
  // On iOS the app itself runs under the chrome, so only what stands over it
  // in place of the app keeps clear here.
  const under = Platform.OS === "ios";
  const statusStyle = [
    styles.status,
    under ? { paddingBottom: chrome.bottom, paddingTop: chrome.top } : null,
  ];
  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: ground ?? color.background },
        under
          ? { paddingLeft: chrome.left, paddingRight: chrome.right }
          : {
              paddingBottom: chrome.bottom,
              paddingLeft: chrome.left,
              paddingRight: chrome.right,
              paddingTop: chrome.top,
            },
      ]}
    >
      {props.failed ? (
        <AppFailure retry={props.retry} style={statusStyle} />
      ) : (
        <>
          {slow && !ready ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, statusStyle]}>
              <ActivityIndicator accessibilityLabel="Loading app" color={color.muted} />
            </View>
          ) : null}
          {props.url === null ? null : (
            <TabDocument
              chrome={chrome}
              failureStyle={statusStyle}
              key={props.url}
              onGround={setGround}
              onReady={() => setReady(true)}
              reloadRef={props.tab.reloadRef}
              retry={props.retry}
              url={props.url}
            />
          )}
        </>
      )}
    </View>
  );
}

const revealDuration = 150;

function TabDocument(props: {
  readonly chrome: EdgeInsets;
  readonly failureStyle: StyleProp<ViewStyle>;
  readonly onGround: (ground: string) => void;
  readonly onReady: () => void;
  readonly reloadRef: RefObject<(() => void) | null>;
  readonly retry: () => void;
  readonly url: string;
}): ReactNode {
  const { chrome, onGround, onReady, reloadRef, retry } = props;
  const webView = useRef<WebView<object>>(null);
  useEffect(() => {
    reloadRef.current = () => {
      if (webView.current) webView.current.reload();
      else retry();
    };
    return () => {
      reloadRef.current = null;
    };
  }, [reloadRef, retry]);
  // `withTiming` honours Reduce Motion, which shows the app at once.
  const opacity = useSharedValue(0);
  const reveal = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const { events, loadFailed } = useAppLoad((message) => {
    if (appFrameReady(message)) {
      opacity.value = withTiming(1, { duration: revealDuration });
      onReady();
    }
    const ground = appGround(message);
    if (ground !== null) onGround(ground);
  });
  if (loadFailed) return <AppFailure retry={props.retry} style={props.failureStyle} />;
  return (
    <Animated.View style={[styles.fill, reveal]}>
      <WebView
        {...isolation(props.url)}
        {...events}
        automaticallyAdjustContentInsets={false}
        containerStyle={styles.fill}
        contentInset={{ bottom: chrome.bottom, left: 0, right: 0, top: chrome.top }}
        contentInsetAdjustmentBehavior="never"
        injectedJavaScript={groundScript}
        pullToRefreshEnabled
        ref={webView}
        refreshControlLightMode
        style={styles.fill}
      />
    </Animated.View>
  );
}

/**
 * Posts the colour the app paints behind itself, once it has loaded: its
 * `theme-color`, else its page's own background. Bouncing past either end
 * then shows the app's ground rather than ours.
 */
const groundScript = `(()=>{try{
const meta=[...document.querySelectorAll('meta[name="theme-color"]')].find(m=>!m.media||matchMedia(m.media).matches);
let value=meta?meta.content.trim():'';
if(!value)for(const node of [document.body,document.documentElement]){const painted=node?getComputedStyle(node).backgroundColor:'';if(/^rgb\\(/.test(painted)){value=painted;break}}
if(value)window.ReactNativeWebView.postMessage(JSON.stringify({type:'opensteer-app:theme-color',color:value}));
}catch(_){}})();true;`;

const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const rgbColor = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/u;

/** An opaque colour the app says it is painted with, or null for anything else. */
function appGround(value: unknown): string | null {
  if (!isRecord(value) || value["type"] !== "opensteer-app:theme-color") return null;
  const painted = value["color"];
  if (typeof painted !== "string") return null;
  const trimmed = painted.trim();
  if (hexColor.test(trimmed)) return trimmed;
  const rgb = rgbColor.exec(trimmed);
  return rgb !== null && rgb.slice(1).every((part) => Number(part) <= 255) ? trimmed : null;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "transparent" },
  notice: { padding: space[12] },
  status: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[24] },
});
