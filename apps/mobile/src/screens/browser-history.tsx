import { canRespondToRequests, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { BrowserHistoryEntry } from "@opensteer/protocol";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, FlatList, Image, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, space } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
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
        <Notice
          title="Not connected"
          detail="Open this deployment to view its browsing history."
          tone="neutral"
        />
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
      online={canRespondToRequests(snapshot)}
    />
  );
}

function HistoryList({
  hostClient,
  profileId,
  name,
  online,
}: {
  readonly hostClient: HostClient;
  readonly profileId: string;
  readonly name: string;
  readonly online: boolean;
}): ReactNode {
  const history = hostClient.browserHistory;
  const revision = useSyncExternalStore(
    history.subscribe,
    history.getRevision,
    history.getRevision,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online) return;
    let active = true;
    setLoading(true);
    void history.load(profileId).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [attempt, history, profileId, online]);
  const mutate = (operation: () => Promise<void>) => {
    const current = hostClient.getSnapshot();
    if (
      !online ||
      busy ||
      !canRespondToRequests(current) ||
      current.session !== "authenticated" ||
      !current.browserProfiles.some((profile) => profile.id === profileId)
    )
      return;
    setBusy(true);
    setFailure(null);
    void operation()
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "Browsing history could not be changed.")),
      )
      .finally(() => setBusy(false));
  };
  const entries = history.entries(profileId);
  // Shown over rows too: a refresh that failed leaves what was last read on screen.
  const readFailed = online && !loading && history.failed(profileId);
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
            {online ? null : (
              <Notice
                title="Not connected"
                detail="Reconnect to view and manage browsing history."
                tone="neutral"
              />
            )}
            {failure === null ? null : (
              <Notice title="History could not be changed" detail={failure} />
            )}
            {readFailed ? (
              <Notice
                action={{ label: "Try again", onPress: () => setAttempt((count) => count + 1) }}
                detail="Check the connection to this computer, then try again."
                title="Browsing history couldn’t be loaded"
              />
            ) : null}
            <SecondaryButton
              label="Clear browsing history"
              tone="danger"
              disabled={!online || busy || entries.length === 0}
              onPress={() =>
                Alert.alert(
                  "Clear browsing history?",
                  `All browsing history for “${name}” will be erased. This can’t be undone.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clear browsing history",
                      style: "destructive",
                      onPress: () => mutate(() => history.clear(profileId)),
                    },
                  ],
                )
              }
            />
          </View>
        }
        ListEmptyComponent={
          readFailed ? undefined : (
            <AppText role="secondary" tone="muted">
              {!online
                ? "Browsing history is unavailable while disconnected."
                : loading
                  ? "Loading browsing history…"
                  : "No browsing history yet."}
            </AppText>
          )
        }
        renderItem={({ item }) => (
          <HistoryRow
            entry={item}
            hostClient={hostClient}
            profileId={profileId}
            disabled={!online || busy}
            onRemove={() => mutate(() => history.remove(profileId, item.url))}
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
  const address = `${host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  const title = entry.title.trim() || host;
  const history = hostClient.browserHistory;
  const icon = disabled ? null : history.icon(profileId, history.iconRef(profileId, entry.url));
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
const selectSnapshot = (snapshot: HostSnapshot) => snapshot;
const styles = StyleSheet.create({
  content: { gap: space[12], paddingTop: space[12] },
  header: { gap: space[16], paddingBottom: space[12] },
  row: { flexDirection: "row", alignItems: "center", gap: space[12], paddingVertical: space[8] },
  text: { flex: 1, gap: space[2] },
  icon: { width: 20, height: 20 },
});
