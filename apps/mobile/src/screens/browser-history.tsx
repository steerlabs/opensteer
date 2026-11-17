import { presentClientIssue } from "@opensteer/client/feedback";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { BrowserHistoryEntry } from "@opensteer/protocol";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, FlatList, Image, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { ActionLine } from "../ui/action-line.js";
import { notDone, useScreenAction } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { BrowserHistoryMenu } from "./browser-history-menu.js";

export type BrowserHistoryDestination = {
  readonly deploymentId: string;
  readonly profileId: string;
};

export function BrowserHistoryScreen({
  route,
}: StaticScreenProps<BrowserHistoryDestination>): ReactNode {
  const { deploymentId, profileId } = route.params;
  const { rows, selection } = useMobileState();
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const hostClient =
    selection.deploymentId === deploymentId && row?.signIn === null ? selection.hostClient : null;
  if (!hostClient)
    return (
      <Screen>
        {row === undefined || selection.deploymentId === deploymentId ? (
          <PlaceholderRows />
        ) : (
          <AppText role="secondary" tone="muted">
            {`Open ${row.name} to view its browsing history.`}
          </AppText>
        )}
      </Screen>
    );
  return <OwnedHistory key={deploymentId} hostClient={hostClient} profileId={profileId} />;
}

function OwnedHistory({
  hostClient,
  profileId,
}: {
  readonly hostClient: HostClient;
  readonly profileId: string;
}): ReactNode {
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  // Bootstrap profiles are owner-filtered by the Host; granted and Guest profiles are absent.
  const profile =
    snapshot.session === "authenticated" && snapshot.user
      ? snapshot.browserProfiles.find((candidate) => candidate.id === profileId)
      : undefined;
  if (!profile)
    return (
      <Screen>
        <Notice
          title="History unavailable"
          detail="Only the profile’s owner can view its browsing history."
          tone="neutral"
        />
      </Screen>
    );
  return (
    <HistoryList
      key={`${snapshot.user?.id}:${profileId}`}
      hostClient={hostClient}
      profileId={profileId}
      name={profile.name}
    />
  );
}

function HistoryList({
  hostClient,
  profileId,
  name,
}: {
  readonly hostClient: HostClient;
  readonly profileId: string;
  readonly name: string;
}): ReactNode {
  const history = hostClient.browserHistory;
  const revision = useSyncExternalStore(
    history.subscribe,
    history.getRevision,
    history.getRevision,
  );
  const [loading, setLoading] = useState(true);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const [attempt, setAttempt] = useState(0);
  // The history owner rereads by itself when the connection comes back.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void history.load(profileId).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [attempt, history, profileId]);
  const change = useScreenAction<HistoryChange, void>(hostClient, `browser-history:${profileId}`, {
    label: "change browsing history",
    execute: (input) => input.work(),
    reconcile: async (input) => {
      await history.load(profileId);
      if (history.failed(profileId)) return null;
      return input.settled(history.entries(profileId))
        ? { kind: "confirmed", value: undefined }
        : notDone({ label: "change browsing history" });
    },
  });
  const busy = change.running;
  const mutate = (input: HistoryChange) => {
    if (busy) return;
    void change.run(input);
  };
  const entries = history.entries(profileId);
  // Only when nothing was ever read: a failed reread keeps what was last read, silently.
  const readFailed = !loading && entries.length === 0 && history.failed(profileId);
  return (
    <Screen edgeToEdge>
      <FlatList
        data={entries}
        extraData={revision}
        keyExtractor={(entry) => entry.url}
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        initialNumToRender={12}
        ListHeaderComponent={
          <View style={styles.header}>
            <AppText role="bodyMedium">{name}</AppText>
            <SecondaryButton
              label="Clear browsing history"
              tone="danger"
              disabled={busy || entries.length === 0}
              onPress={() =>
                Alert.alert(
                  "Clear browsing history?",
                  `All browsing history for “${name}” will be erased. This can’t be undone.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clear browsing history",
                      style: "destructive",
                      onPress: () =>
                        mutate({
                          work: () => history.clear(profileId),
                          settled: (now) => now.length === 0,
                        }),
                    },
                  ],
                )
              }
            />
            {change.line === null ? null : (
              <ActionLine line={change.line} numberOfLines={2} onDismiss={change.dismiss} />
            )}
          </View>
        }
        ListEmptyComponent={
          readFailed ? (
            <ActionLine
              line={{
                key: "history-failed",
                text: presentClientIssue({ code: "read-failed", resource: "browsing history" })
                  .title,
                tone: "muted",
                link: { label: "Try again", onPress: () => setAttempt((count) => count + 1) },
              }}
            />
          ) : loading ? (
            <PlaceholderRows />
          ) : (
            <AppText role="secondary" tone="muted">
              No browsing history yet.
            </AppText>
          )
        }
        renderItem={({ item }) => (
          <HistoryRow
            entry={item}
            hostClient={hostClient}
            profileId={profileId}
            disabled={busy}
            onRemove={() =>
              mutate({
                work: () => history.remove(profileId, item.url),
                settled: (now) => !now.some((entry) => entry.url === item.url),
              })
            }
          />
        )}
      />
    </Screen>
  );
}

function HistoryRow({
  entry,
  hostClient,
  profileId,
  disabled,
  onRemove,
}: {
  readonly entry: BrowserHistoryEntry;
  readonly hostClient: HostClient;
  readonly profileId: string;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}): ReactNode {
  const url = new URL(entry.url);
  const host = url.host;
  // The address without its scheme tells apart pages that share a title.
  const address = `${host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  const title = entry.title.trim() || host;
  const history = hostClient.browserHistory;
  const icon = history.icon(profileId, history.iconRef(profileId, entry.url));
  return (
    <View style={styles.row}>
      {icon ? (
        <Image source={{ uri: icon }} style={styles.icon} />
      ) : (
        <Symbol name="globe" size={20} tint={color.textSoft} />
      )}
      <View style={styles.text}>
        <AppText role="bodyMedium" numberOfLines={1}>
          {title}
        </AppText>
        <AppText role="caption" tone="muted" numberOfLines={1}>
          {address}
        </AppText>
      </View>
      <BrowserHistoryMenu
        title={title === address ? title : `${title}, ${address}`}
        disabled={disabled}
        onRemove={onRemove}
      />
    </View>
  );
}
interface HistoryChange {
  readonly work: () => Promise<void>;
  /** Whether history as read again shows the change, for a check after a lost answer. */
  readonly settled: (entries: readonly BrowserHistoryEntry[]) => boolean;
}

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;
const styles = StyleSheet.create({
  content: { gap: space[12], paddingTop: space[12] },
  header: { gap: space[16], paddingBottom: space[12] },
  row: { flexDirection: "row", alignItems: "center", gap: space[12], paddingVertical: space[8] },
  text: { flex: 1, gap: space[2] },
  icon: { width: 20, height: 20 },
});
