import { useAppView } from "@opensteer/client/react";
import type { AppEntry } from "@opensteer/client/host";
import { appContentHeight, appFrameReady } from "@opensteer/shared/appFrame";
import { useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { color, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { TranscriptHostClientContext } from "./attachment-views.js";

export function AppCard({ entry }: { readonly entry: AppEntry }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(entry.title);
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <AppText style={styles.title}>{title}</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          onPress={() => setOpen(true)}
          hitSlop={8}
        >
          <AppText>Open</AppText>
        </Pressable>
      </View>
      <AppFrame appId={entry.appId} onTitle={setTitle} />
      {open ? (
        <Modal visible onRequestClose={() => setOpen(false)} animationType="slide">
          <SafeAreaView style={styles.fullScreen}>
            <View style={styles.header}>
              <AppText style={styles.title}>{title}</AppText>
              <Pressable accessibilityRole="button" onPress={() => setOpen(false)} hitSlop={8}>
                <AppText>Close</AppText>
              </Pressable>
            </View>
            <AppFrame appId={entry.appId} onTitle={setTitle} fullScreen />
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

function AppFrame({
  appId,
  onTitle,
  fullScreen = false,
}: {
  readonly appId: string;
  readonly onTitle: (title: string) => void;
  readonly fullScreen?: boolean;
}) {
  const client = useContext(TranscriptHostClientContext);
  const { view, failed, retry } = useAppView(client, appId, "dark");
  useEffect(() => {
    if (view) onTitle(view.app.title);
  }, [view, onTitle]);
  if (failed) return <AppFailure retry={retry} />;
  if (!view) return <ActivityIndicator accessibilityLabel="Loading app" style={styles.notice} />;
  return <AppDocument key={view.url} url={view.url} fullScreen={fullScreen} retry={retry} />;
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
  fullScreen,
  retry,
}: {
  readonly url: string;
  readonly fullScreen: boolean;
  readonly retry: () => void;
}) {
  const [height, setHeight] = useState(280);
  const [loadFailed, setLoadFailed] = useState(false);
  const ready = useRef(false);
  if (loadFailed) return <AppFailure retry={retry} />;
  const frameStyle = fullScreen
    ? styles.webFullScreen
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
        if (request.url === "about:blank" || request.url.split("#")[0] === url.split("#")[0])
          return true;
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
          if (appFrameReady(message)) ready.current = true;
          const height = appContentHeight(message);
          if (height !== null) setHeight(height);
        } catch {
          /* A page's messages carry no native authority. */
        }
      }}
      onLoad={() => {
        if (!ready.current) setLoadFailed(true);
      }}
      onError={() => setLoadFailed(true)}
      onHttpError={() => setLoadFailed(true)}
      startInLoadingState
      renderLoading={() => <ActivityIndicator accessibilityLabel="Loading app" />}
    />
  );
}
const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: color.line, borderRadius: radius.md, overflow: "hidden" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[12],
    padding: space[12],
  },
  title: { flex: 1 },
  notice: { padding: space[12] },
  fullScreen: { flex: 1, backgroundColor: color.background },
  webFullScreen: { flex: 1, backgroundColor: "transparent" },
});
