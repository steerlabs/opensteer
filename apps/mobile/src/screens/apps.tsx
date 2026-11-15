import {
  threadInDirectory,
  type HostClient,
  type LegacyHostSnapshot as HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { App } from "@opensteer/core";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { tabRoute } from "../browser/surface-route.js";
import { selectAppsRevision, tabsClient } from "../tabs/tabs-host.js";
import { useOperation } from "../tabs/use-tabs.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { useAppForeground } from "../ui/foreground.js";
import { AppText, Field, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { confirmDestructive } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type AppsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Apps: what the person has published, whichever chat made it — still listed
 * after that chat is deleted. Each opens as its one tab; a server app starts
 * and stops here, and stays as it was left across reconnects. The list loads
 * when this screen opens, and reloads on a change only while it is in view,
 * so no other screen pays for it.
 */
export function AppsScreen(props: AppsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <AttachedApps deploymentId={deploymentId} hostClient={hostClient} />;
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

function AttachedApps(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const reader = useHostSelector(props.hostClient, selectReader);
  if (reader === null)
    return (
      <Screen>
        <Notice
          title="Connecting…"
          detail="Your apps appear once you are signed in."
          tone="neutral"
        />
      </Screen>
    );
  // Nothing one person was shown is ever shown to another.
  return <AppsForReader key={reader} {...props} />;
}

/** The loaded list and the invalidation it answers; a read older than a newer change is dropped. */
interface Loaded {
  readonly apps: readonly App[] | null;
  readonly failure: string | null;
  readonly loading: boolean;
}

/**
 * The person's apps, read when the screen is in view and again on each apps
 * change while it stays in view. A change seen during a read makes that
 * read's answer stale: it is dropped and the newer read stands.
 */
export function useAppsList(hostClient: HostClient, active: boolean) {
  const revision = useHostSelector(hostClient, selectAppsRevision);
  const [loaded, setLoaded] = useState<Loaded>({ apps: null, failure: null, loading: false });
  const latest = useRef({ read: 0, revision });
  latest.current.revision = revision;
  const read = useCallback(() => {
    const ticket = ++latest.current.read;
    const asOf = latest.current.revision;
    setLoaded((current) => ({ ...current, failure: null, loading: true }));
    tabsClient(hostClient)
      .listApps()
      .then(
        (apps) => {
          if (ticket !== latest.current.read || asOf !== latest.current.revision) return;
          setLoaded({ apps, failure: null, loading: false });
        },
        (error: unknown) => {
          if (ticket !== latest.current.read) return;
          setLoaded((current) => ({
            ...current,
            failure: error instanceof Error ? error.message : "Your apps could not be loaded.",
            loading: false,
          }));
        },
      );
  }, [hostClient]);
  useEffect(() => {
    if (active) read();
  }, [active, read, revision]);
  /**
   * One app as a command returned it, ahead of the reread its change notice
   * brings; a read already in flight began before the change and is dropped.
   */
  const settle = useCallback((app: App) => {
    latest.current.read += 1;
    setLoaded((current) => ({
      ...current,
      apps: current.apps?.map((row) => (row.appId === app.appId ? app : row)) ?? null,
    }));
  }, []);
  const remove = useCallback((appId: App["appId"]) => {
    latest.current.read += 1;
    setLoaded((current) => ({
      ...current,
      apps: current.apps?.filter((row) => row.appId !== appId) ?? null,
    }));
  }, []);
  return { ...loaded, read, remove, settle };
}

function AppsForReader(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const list = useAppsList(hostClient, focused && foreground);
  const navigation = useNavigation();
  const openThread = useCallback(
    (threadId: string) =>
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId })),
    [deploymentId, navigation],
  );
  const openTab = useCallback(
    (tabId: Parameters<typeof tabRoute>[1]) =>
      navigation.dispatch(StackActions.push("WorkspaceBrowser", tabRoute(deploymentId, tabId))),
    [deploymentId, navigation],
  );
  const apps = list.apps;
  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        data={apps ?? []}
        keyExtractor={(app) => app.appId}
        ListEmptyComponent={
          apps === null ? (
            list.failure === null ? (
              <View style={styles.empty}>
                <AppText role="bodyMedium" tone="muted">
                  Finding apps…
                </AppText>
              </View>
            ) : undefined
          ) : (
            <View style={styles.empty}>
              <AppText role="bodyMedium">No apps yet</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                Apps your agent publishes appear here.
              </AppText>
            </View>
          )
        }
        ListHeaderComponent={
          list.failure === null ? undefined : (
            <View style={styles.notices}>
              <Notice
                action={{ label: "Try again", onPress: list.read }}
                detail={list.failure}
                title="Apps could not be loaded"
              />
            </View>
          )
        }
        renderItem={({ item }) => (
          <AppRow
            app={item}
            hostClient={hostClient}
            onDeleted={list.remove}
            onOpenTab={openTab}
            onOpenThread={openThread}
            onSettled={list.settle}
          />
        )}
      />
    </Screen>
  );
}

const stateWords: Record<App["state"], string> = {
  failed: "Failed",
  offline: "Computer offline",
  running: "Running",
  stopped: "Stopped",
};

const AppRow = memo(function AppRow(props: {
  readonly app: App;
  readonly hostClient: HostClient;
  readonly onDeleted: (appId: App["appId"]) => void;
  readonly onOpenTab: (tabId: Parameters<typeof tabRoute>[1]) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onSettled: (app: App) => void;
}): ReactNode {
  const { app, hostClient } = props;
  const client = tabsClient(hostClient);
  const operation = useOperation();
  const [naming, setNaming] = useState<string | null>(null);
  const selectComputer = useCallback(
    (snapshot: HostSnapshot) =>
      snapshot.machines.find((machine) => machine.id === app.computerId)?.name ?? null,
    [app.computerId],
  );
  const computer = useHostSelector(hostClient, selectComputer) ?? "Removed computer";
  const selectOrigin = useCallback(
    (snapshot: HostSnapshot) =>
      app.taskId === null ? null : (threadInDirectory(app.taskId, snapshot)?.title.trim() ?? ""),
    [app.taskId],
  );
  const origin = useHostSelector(hostClient, selectOrigin);
  const server = app.kind === "server";
  const detail = [
    server ? "Server" : "HTML",
    server ? stateWords[app.state] : null,
    computer,
  ].filter((part): part is string => part !== null);
  const rename = (name: string) => {
    const trimmed = name.trim();
    setNaming(null);
    if (trimmed === "" || trimmed === app.name) return;
    void operation.run(
      () => client.renameApp(app.appId, trimmed),
      "The app could not be renamed.",
      props.onSettled,
    );
  };
  const open = () =>
    void operation.run(
      async () => {
        const tab = await client.openTab({ appId: app.appId, kind: "app" });
        return tab.tabId;
      },
      "The app could not be opened.",
      props.onOpenTab,
    );
  const start = () =>
    void operation.run(
      () => client.startApp(app.appId),
      "The app could not be started.",
      props.onSettled,
    );
  const stop = () =>
    void operation.run(
      () => client.stopApp(app.appId),
      "The app could not be stopped.",
      props.onSettled,
    );
  const remove = () =>
    confirmDestructive({
      confirm: "Delete app",
      message:
        "Its server stops, its tabs close and its link stops working. Its folder stays on the computer.",
      onConfirm: () =>
        void operation.run(
          () => client.deleteApp(app.appId),
          "The app could not be deleted.",
          () => props.onDeleted(app.appId),
        ),
      title: `Delete “${app.name}”?`,
    });
  // Wanted running: Stop records stopped, even offline. Failed: Start tries again.
  const wanted = app.server?.desiredState === "running";
  const startOffered = server && (!wanted || app.state === "failed");
  const stopOffered = server && wanted;
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <View style={styles.glyph}>
          <Symbol name="square.grid.2x2" size={17} tint={color.muted} />
        </View>
        <View style={styles.words}>
          <AppText numberOfLines={1} role="bodyMedium">
            {app.name}
          </AppText>
          <AppText numberOfLines={1} role="caption" tone="muted">
            {detail.join(" · ")}
          </AppText>
        </View>
        <NativeMenu
          accessibilityLabel={`${app.name} actions`}
          disabledReason={operation.busy ? "Wait for the last change to finish." : null}
          options={[
            [{ icon: "pencil", id: "rename", label: "Rename", onPress: () => setNaming(app.name) }],
            [
              {
                destructive: true,
                icon: "xmark.circle",
                id: "delete",
                label: "Delete app",
                onPress: remove,
              },
            ],
          ]}
          style={styles.menu}
        >
          <Symbol name="ellipsis" size={17} tint={color.muted} />
        </NativeMenu>
      </View>
      {app.taskId === null ? (
        <AppText role="caption" tone="muted">
          Chat deleted
        </AppText>
      ) : (
        <Pressable
          accessibilityHint="Opens the chat that made this app"
          accessibilityRole="link"
          onPress={() => props.onOpenThread(app.taskId!)}
          style={styles.origin}
        >
          <AppText numberOfLines={1} role="caption" tone="ember">
            {origin ? `From “${origin}”` : "Open its chat"}
          </AppText>
        </Pressable>
      )}
      {app.state === "failed" && app.server?.lastError ? (
        <AppText role="caption" tone="danger">
          {app.server.lastError}
        </AppText>
      ) : null}
      {naming === null ? null : (
        <View style={styles.naming}>
          <Field
            input={{
              autoFocus: true,
              maxLength: 160,
              onChangeText: setNaming,
              onSubmitEditing: () => rename(naming),
              returnKeyType: "done",
              value: naming,
            }}
            label="Name"
          />
          <View style={styles.actions}>
            <SecondaryButton
              compact
              disabled={naming.trim() === ""}
              label="Save"
              onPress={() => rename(naming)}
            />
            <SecondaryButton compact label="Cancel" onPress={() => setNaming(null)} />
          </View>
        </View>
      )}
      <View style={styles.actions}>
        <SecondaryButton
          accessibilityLabel={`Open ${app.name}`}
          busy={operation.busy}
          compact
          disabled={operation.busy}
          label="Open"
          onPress={open}
        />
        {startOffered ? (
          <SecondaryButton
            accessibilityLabel={`Start ${app.name}`}
            compact
            disabled={operation.busy}
            label="Start"
            onPress={start}
          />
        ) : null}
        {stopOffered ? (
          <SecondaryButton
            accessibilityLabel={`Stop ${app.name}`}
            compact
            disabled={operation.busy}
            label="Stop"
            onPress={stop}
          />
        ) : null}
      </View>
      {operation.failure === null ? null : (
        <Pressable accessibilityRole="button" onPress={operation.dismiss}>
          <AppText role="caption" tone="danger">
            {operation.failure}
          </AppText>
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space[8] },
  centred: { textAlign: "center" },
  content: { gap: space[8], paddingTop: space[8] },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  head: { alignItems: "center", flexDirection: "row", gap: space[12] },
  menu: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  naming: { gap: space[8] },
  notices: { paddingBottom: space[8] },
  origin: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  row: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
