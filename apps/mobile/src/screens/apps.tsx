import {
  appNoticeTitle,
  threadInDirectory,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import type { AppAction, AppsList } from "@opensteer/client/host";
import { presentClientIssue } from "@opensteer/client/feedback";
import { useAppsList, useHostSelector } from "@opensteer/client/react";
import type { App } from "@opensteer/core";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { tabRoute } from "../browser/surface-route.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { useAppForeground } from "../ui/foreground.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText, Field, SecondaryButton } from "../ui/primitives.js";
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
        <PlaceholderRows />
      </Screen>
    );
  // Nothing one person was shown is ever shown to another.
  return <AppsForReader key={reader} {...props} />;
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
  // Read while in view only: a change elsewhere rereads nothing until the screen is back.
  const { list, state } = useAppsList(hostClient, focused && foreground);
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
  const apps = state.apps;
  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        data={apps ?? []}
        keyExtractor={(app) => app.appId}
        ListEmptyComponent={
          apps === null ? (
            state.error === null ? (
              <PlaceholderRows />
            ) : (
              <ActionLine
                line={{
                  key: "apps-failed",
                  text: presentClientIssue({ code: "read-failed", resource: "apps" }).title,
                  tone: "muted",
                  link: { label: "Try again", onPress: () => void list.reload() },
                }}
              />
            )
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
          state.notices.length === 0 ? undefined : (
            <View style={styles.notices}>
              {/* An app the Host stopped listing still says how its last action went. */}
              {state.notices.map((notice) =>
                notice.message === null ? (
                  <AppText key={notice.appId} role="caption" tone="muted">
                    {appNoticeTitle(notice)}
                  </AppText>
                ) : (
                  <ActionLine
                    key={notice.appId}
                    line={appActionLine(notice.name, notice.action, () => {
                      void list.reload();
                      list.dismissFailure(notice.appId);
                    })}
                  />
                ),
              )}
            </View>
          )
        }
        renderItem={({ item }) => (
          <AppRow
            app={item}
            failed={state.failures.get(item.appId)?.action ?? null}
            hostClient={hostClient}
            list={list}
            onOpenTab={openTab}
            onOpenThread={openThread}
            pending={state.pending.has(item.appId)}
          />
        )}
      />
    </Screen>
  );
}

const doneWords: Record<AppAction, string> = {
  rename: "renamed",
  start: "started",
  stop: "stopped",
  delete: "deleted",
  open: "opened",
};

/**
 * An app action that didn't come back as done. The list keeps no reason that
 * is safe to show, so it says only that it couldn't confirm; Check reads the
 * list again, which shows the app as it really is.
 */
function appActionLine(name: string, action: AppAction, check: () => void): ActionLineValue {
  return {
    key: `${action}:${name}`,
    text: presentClientIssue({
      code: "unconfirmed",
      happened: `“${name}” was ${doneWords[action]}`,
    }).title,
    tone: "muted",
    link: { label: "Check", onPress: check },
    haptic: "warning",
  };
}

const stateWords: Record<App["state"], string> = {
  failed: "Failed",
  offline: "Computer offline",
  running: "Running",
  stopped: "Stopped",
};

const AppRow = memo(function AppRow(props: {
  readonly app: App;
  /** The last action whose answer never came, kept until the next action or Check. */
  readonly failed: AppAction | null;
  readonly hostClient: HostClient;
  readonly list: AppsList;
  readonly onOpenTab: (tabId: Parameters<typeof tabRoute>[1]) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly pending: boolean;
}): ReactNode {
  const { app, hostClient, list } = props;
  const busy = props.pending;
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
    void list.rename(app.appId, trimmed);
  };
  const open = () =>
    void list.track(app.appId, "open", async () => {
      const tab = await hostClient.openTab({ appId: app.appId, kind: "app" });
      props.onOpenTab(tab.tabId);
    });
  const start = () => void list.start(app.appId);
  const stop = () => void list.stop(app.appId);
  const remove = () =>
    confirmDestructive({
      confirm: "Delete app",
      message:
        "Its server stops, its tabs close and its link stops working. Its folder stays on the computer.",
      onConfirm: () => void list.delete(app.appId),
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
          disabledReason={busy ? "Wait for the last change to finish." : null}
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
          busy={busy}
          compact
          disabled={busy}
          label="Open"
          onPress={open}
        />
        {startOffered ? (
          <SecondaryButton
            accessibilityLabel={`Start ${app.name}`}
            compact
            disabled={busy}
            label="Start"
            onPress={start}
          />
        ) : null}
        {stopOffered ? (
          <SecondaryButton
            accessibilityLabel={`Stop ${app.name}`}
            compact
            disabled={busy}
            label="Stop"
            onPress={stop}
          />
        ) : null}
      </View>
      {props.failed === null ? null : (
        <ActionLine
          line={appActionLine(app.name, props.failed, () => {
            void list.reload();
            list.dismissFailure(app.appId);
          })}
        />
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
  notices: { gap: space[8], paddingBottom: space[8] },
  origin: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  row: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
