import { useAppView } from "@opensteer/client/react";
import type { AppEntry } from "@opensteer/client/host";
import { appContentHeight } from "@opensteer/shared/appFrame";
import { useContext, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { color, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { AttachmentReader } from "./attachment-views.js";

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
  const client = useContext(AttachmentReader);
  const { view, failed, retry } = useAppView(client, appId, "dark");
  useEffect(() => {
    if (view) onTitle(view.app.title);
  }, [view, onTitle]);
  const [height, setHeight] = useState(280);
  const [loadFailed, setLoadFailed] = useState(false);
  if (failed || loadFailed)
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setLoadFailed(false);
          retry();
        }}
        style={styles.notice}
      >
        <AppText>Could not load this app. Tap to retry.</AppText>
      </Pressable>
    );
  if (!view) return <ActivityIndicator accessibilityLabel="Loading app" style={styles.notice} />;
  const frameStyle = fullScreen
    ? styles.webFullScreen
    : { height: Math.max(160, Math.min(640, height)), flex: 0, backgroundColor: "transparent" };
  return (
    <WebView
      key={view.url}
      source={{ uri: view.url }}
      style={frameStyle}
      containerStyle={frameStyle}
      originWhitelist={["https://*", "http://*"]}
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
      onShouldStartLoadWithRequest={(request): boolean =>
        request.url === view.url || request.url === "about:blank"
      }
      onOpenWindow={(): void => {}}
      onMessage={(event) => {
        try {
          const height = appContentHeight(JSON.parse(event.nativeEvent.data));
          if (height !== null) setHeight(height);
        } catch {
          /* A page's messages carry no native authority. */
        }
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
