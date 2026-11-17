import { contactSupport } from "../report-mail.js";
import type { AppEntry, HostClient } from "@opensteer/client/host";
import { AppIdSchema, type TabId } from "@opensteer/core";
import {
  memo,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { opensteerAppGlyph } from "../browser/agent-surface.js";
import { color, radius, space } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { notDone, useScreenAction } from "../ui/client-feedback.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AppFrame } from "./app-frame.js";
import { TranscriptHostClientContext } from "./attachment-views.js";
import { TranscriptAppTabsContext } from "./surface-chips.js";

/**
 * A published app in its conversation. It runs here until it is opened as a
 * tab; while its tab is open the tab is its one live copy, and this says
 * where it went. Closing the tab brings it back. Publishing never opens a
 * tab: only Open does.
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
  const model = client.getSnapshot().tabs;
  // The app's one tab, while it is in the list: only the list's membership changes it.
  const readTab = useCallback((): TabId | null => {
    for (const tab of model.rows.values())
      if (tab.kind === "app" && tab.appId === appId) return tab.tabId;
    return null;
  }, [appId, model]);
  const subscribe = useCallback(
    (listener: () => void) => model.subscribeStructure(listener),
    [model],
  );
  const tabId = useSyncExternalStore(subscribe, readTab, readTab);
  const opening = useScreenAction<null, TabId>(client, `open-app:${appId}`, {
    label: "open this app",
    done: "opened",
    happened: "this app opened",
    execute: async () => {
      const parsed = AppIdSchema.parse(appId);
      return (await client.openTab({ appId: parsed, kind: "app" })).tabId;
    },
    // The tab list says whether the lost answer opened it.
    reconcile: async () => {
      const opened = readTab();
      return opened === null ? notDone("opened") : { kind: "confirmed", value: opened };
    },
    retry: () => open(),
  });
  const open = () =>
    void opening.run(null).then((outcome) => {
      if (outcome.kind === "confirmed") tabs?.show(outcome.value);
    });
  if (tabId !== null)
    return (
      <Pressable
        accessibilityHint="Goes to this app’s tab"
        accessibilityLabel={`${title}, open in Tabs`}
        accessibilityRole="button"
        onPress={() => tabs?.show(tabId)}
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
          onPress={() => contactSupport({ kind: "app", id: appId })}
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <AppText>Report…</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          accessibilityState={{ busy: opening.running, disabled: opening.running }}
          disabled={opening.running}
          onPress={open}
          hitSlop={8}
        >
          <AppText tone={opening.running ? "muted" : "default"}>
            {opening.running ? "Opening…" : "Open"}
          </AppText>
        </Pressable>
      </View>
      {opening.line === null ? null : (
        <View style={styles.failure}>
          <ActionLine line={opening.line} numberOfLines={2} onDismiss={opening.dismiss} />
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
