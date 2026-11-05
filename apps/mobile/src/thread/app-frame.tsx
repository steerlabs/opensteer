import type { HostClient } from "@opensteer/client/host";
import { useAppView } from "@opensteer/client/react";
import { appContentHeight, appFrameReady, isAppNavigation } from "@opensteer/shared/appFrame";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/**
 * One live copy of an app: in a transcript card, sized to what it reports, or
 * filling a tab's page, where the page gives it its size.
 */
export function AppFrame(props: {
  readonly appId: string;
  readonly client: HostClient | null;
  readonly fill?: boolean;
  readonly onTitle?: (title: string) => void;
}): ReactNode {
  const { onTitle } = props;
  const { view, failed, retry } = useAppView(props.client, props.appId, "dark");
  useEffect(() => {
    if (view) onTitle?.(view.app.title);
  }, [view, onTitle]);
  if (failed) return <AppFailure retry={retry} />;
  if (!view) return <ActivityIndicator accessibilityLabel="Loading app" style={styles.notice} />;
  return <AppDocument key={view.url} url={view.url} fill={props.fill === true} retry={retry} />;
}

function AppFailure({ retry }: { readonly retry: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={retry} style={styles.notice}>
      <AppText>Could not load this app. Tap to retry.</AppText>
    </Pressable>
  );
}

function openExternal(url: string): void {
  if (/^https?:\/\//iu.test(url)) void Linking.openURL(url).catch(() => undefined);
}

function AppDocument({
  url,
  fill,
  retry,
}: {
  readonly url: string;
  readonly fill: boolean;
  readonly retry: () => void;
}) {
  const [height, setHeight] = useState(280);
  const [loadFailed, setLoadFailed] = useState(false);
  const ready = useRef(false);
  if (loadFailed) return <AppFailure retry={retry} />;
  const frameStyle = fill
    ? styles.fill
    : { height: Math.max(160, Math.min(640, height)), flex: 0, backgroundColor: "transparent" };
  return (
    <WebView
      source={{ uri: url }}
      style={frameStyle}
      containerStyle={frameStyle}
      // Route every scheme through our policy; WebView otherwise opens non-whitelisted URLs itself.
      originWhitelist={["*"]}
      incognito
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      allowsInlineMediaPlayback={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows
      onShouldStartLoadWithRequest={(request): boolean => {
        if (request.url === "about:blank" || isAppNavigation(request.url, url)) return true;
        if (
          request.isTopFrame !== false &&
          (request.navigationType === "click" || request.navigationType === undefined)
        )
          openExternal(request.url);
        return false;
      }}
      onOpenWindow={(event) => openExternal(event.nativeEvent.targetUrl)}
      onMessage={(event) => {
        try {
          const message: unknown = JSON.parse(event.nativeEvent.data);
          if (appFrameReady(message)) {
            ready.current = true;
            setLoadFailed(false);
          }
          const height = appContentHeight(message);
          if (height !== null && !fill) setHeight(height);
        } catch {
          /* A page's messages carry no native authority. */
        }
      }}
      onLoadStart={() => {
        ready.current = false;
      }}
      onLoad={() => {
        if (!ready.current) setLoadFailed(true);
      }}
      onError={() => {
        if (!ready.current) setLoadFailed(true);
      }}
      onHttpError={() => {
        /* A prepared error document can still send ready before onLoadEnd. */
      }}
      onLoadEnd={() => {
        if (!ready.current) setLoadFailed(true);
      }}
      startInLoadingState
      renderLoading={() => <ActivityIndicator accessibilityLabel="Loading app" />}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "transparent" },
  notice: { padding: space[12] },
});
