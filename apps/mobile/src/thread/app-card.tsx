import {
  isAppTabOpen,
  type AppEntry,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { memo, useCallback, useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { opensteerAppGlyph } from "../browser/agent-surface.js";
import { color, radius, space } from "../theme.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AppFrame } from "./app-frame.js";
import { TranscriptHostClientContext } from "./attachment-views.js";
import { TranscriptAppTabsContext } from "./surface-chips.js";

/**
 * A published app in its conversation. It runs here until it is opened as a
 * tab; while the tab is open the tab is its one live copy, and this says where
 * it went. Closing the tab brings it back.
 */
export const AppCard = memo(function AppCard({ entry }: { readonly entry: AppEntry }): ReactNode {
  const client = useContext(TranscriptHostClientContext);
  return client === null ? null : <Card client={client} entry={entry} />;
});

function Card(props: { readonly client: HostClient; readonly entry: AppEntry }): ReactNode {
  const { client, entry } = props;
  const { appId } = entry;
  const tabs = useContext(TranscriptAppTabsContext);
  const [title, setTitle] = useState(entry.title);
  const [failure, setFailure] = useState<string | null>(null);
  const tabOpen = useHostSelector(
    client,
    useCallback((snapshot: HostSnapshot) => isAppTabOpen(snapshot, appId), [appId]),
  );
  const open = () => {
    setFailure(null);
    // Its first step is local, so the tab exists before the page below looks for it.
    const opening = client.openAppTab(appId);
    tabs?.open(appId);
    void opening.catch((error: unknown) => {
      tabs?.leave(appId);
      setFailure(error instanceof Error ? error.message : "Try again in a moment.");
    });
  };
  if (tabOpen)
    return (
      <Pressable
        accessibilityHint="Goes to this app’s tab"
        accessibilityLabel={`${title}, open in Tabs`}
        accessibilityRole="button"
        onPress={() => tabs?.open(appId)}
        style={({ pressed }) => [styles.card, styles.tabRow, pressed && styles.pressed]}
      >
        <View style={styles.glyph}>
          <Symbol name={opensteerAppGlyph} size={17} tint={color.muted} />
        </View>
        <View style={styles.words}>
          <AppText numberOfLines={1} role="bodyMedium">
            {title}
          </AppText>
          <AppText numberOfLines={1} role="caption" tone="muted">
            Open in Tabs
          </AppText>
        </View>
        <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
      </Pressable>
    );
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <AppText style={styles.title}>{title}</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          onPress={open}
          hitSlop={8}
        >
          <AppText>Open</AppText>
        </Pressable>
      </View>
      {failure === null ? null : (
        <View style={styles.failure}>
          <Notice
            action={{ label: "Try again", onPress: open }}
            detail={failure}
            title="This app could not open as a tab"
          />
        </View>
      )}
      <AppFrame appId={appId} client={client} onTitle={setTitle} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: color.line, borderRadius: radius.md, overflow: "hidden" },
  failure: { paddingBottom: space[12], paddingHorizontal: space[12] },
  // The same mark a tab's row wears in Tabs.
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[12],
    padding: space[12],
  },
  pressed: { backgroundColor: color.surfacePressed },
  tabRow: { alignItems: "center", flexDirection: "row", gap: space[12], padding: space[12] },
  title: { flex: 1 },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
