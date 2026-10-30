import {
  canRespondToRequests,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import {
  authorizationConnection,
  integrationAccountTitle,
  integrationAuthorizationError,
  type IntegrationOAuthApplicationSource,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, space, touchTarget } from "../theme.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, RowGroup, SecondaryButton, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import {
  connectedAppsModel,
  type ConnectedAccountRow,
  type ConnectedAppModel,
} from "./connected-apps-model.js";

export type ConnectedAppsDestination = { readonly deploymentId: string };

/**
 * The accounts agents use, from the phone: each one's state, a sign-in that
 * repairs or adds one, and the way to remove one. A sign-in that returns to the
 * Account service finishes in the phone's own browser sheet.
 */
export function ConnectedAppsScreen({
  route,
}: StaticScreenProps<ConnectedAppsDestination>): ReactNode {
  const { deploymentId } = route.params;
  const { rows, selection } = useMobileState();
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const hostClient =
    selection.deploymentId === deploymentId && row?.signIn === null ? selection.hostClient : null;
  if (hostClient === null || row === undefined) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            {row === undefined
              ? "This deployment is no longer on this phone."
              : `Open ${row.name} to manage its connected apps.`}
          </AppText>
        </View>
      </Screen>
    );
  }
  return <SignedInConnectedApps hostClient={hostClient} hostName={row.name} />;
}

/** Keyed by who is signed in, so a changed account never sees the last one's apps. */
function SignedInConnectedApps(props: {
  readonly hostClient: HostClient;
  readonly hostName: string;
}): ReactNode {
  const userId = useHostSelector(props.hostClient, selectUserId);
  if (userId === null) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            Sign in to this deployment to manage its connected apps.
          </AppText>
        </View>
      </Screen>
    );
  }
  return <ConnectedApps key={userId} {...props} />;
}

function ConnectedApps(props: { readonly hostClient: HostClient; readonly hostName: string }) {
  const { hostClient, hostName } = props;
  const mobile = useMobileClient();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const focused = useIsFocused();
  const online = useHostSelector(hostClient, canRespondToRequests);
  const [apps, setApps] = useState<readonly ConnectedAppModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The row whose action is under way; every other action waits for it. */
  const [busy, setBusy] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");

  const load = useCallback(async () => {
    try {
      const [dashboard, platform] = await Promise.all([
        hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]);
      setApps(connectedAppsModel({ dashboard, hostName, platform }));
      setLoadError(null);
      return dashboard;
    } catch (reason) {
      setLoadError(operationDetail(reason, "Connected apps could not be loaded."));
      return null;
    }
  }, [hostClient, hostName]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);

  // Read when shown and when the person comes back, as from GitHub in the browser.
  useEffect(() => {
    if (focused && foreground && online) void load();
  }, [focused, foreground, load, online]);

  /** One action at a time, its failure said once, and the list read again after it. */
  const run = async (key: string, action: () => Promise<string | null>) => {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const message = await action();
      if (message !== null) {
        setDone(message);
        void AccessibilityInfo.announceForAccessibility(message);
      }
    } catch (reason) {
      setError(operationDetail(reason, "That did not finish. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const signIn = (app: ConnectedAppModel, key: string) => {
    const start = (source: IntegrationOAuthApplicationSource) =>
      void run(key, async () => {
        const status = await mobile.beginIntegrationAuthorization({
          applicationSource: source,
          definitionId: app.definitionId,
        });
        const outcome = integrationAuthorizationError(status.status, status.failureCode);
        if (outcome !== null) throw new Error(outcome);
        const dashboard = await load();
        const connection =
          dashboard === null ? null : authorizationConnection(dashboard, status.connectionId);
        return connection === null
          ? `${app.name} is connected.`
          : `${integrationAccountTitle(connection)} is connected.`;
      });
    if (app.signIn?.kind === "direct") {
      start(app.signIn.source);
      return;
    }
    if (app.signIn?.kind !== "choose") return;
    Alert.alert(`Sign in to ${app.name}`, "Choose the app this account signs in through.", [
      ...app.signIn.options.map((option) => ({
        onPress: () => start(option.source),
        text: option.label,
      })),
      { style: "cancel" as const, text: "Cancel" },
    ]);
  };

  const chooseRepositories = (account: ConnectedAccountRow) =>
    void run(account.id, async () => {
      const access = unwrapRpcResult(
        await hostClient.rpc["integration.repositoryAccess.check"]({ connectionId: account.id }),
      );
      if (access.ready) {
        await load();
        return `${account.title} is connected.`;
      }
      // GitHub is where repositories are chosen; coming back reads the list again.
      const url = access.installationUrl ?? access.installations[0]?.configureUrl ?? null;
      if (url === null) {
        throw new Error(
          "This sign-in app has no GitHub App installation link. Choose repositories from Opensteer on a computer.",
        );
      }
      await Linking.openURL(url);
      return null;
    });

  const disconnect = (account: ConnectedAccountRow) =>
    Alert.alert(account.title, "Agents stop using this account. You can connect it again.", [
      {
        onPress: () =>
          void run(account.id, async () => {
            const result = await hostClient.dispatch({
              connectionId: account.id,
              idempotencyKey: mutationIdempotencyKey(`integration-disconnect:${account.id}`),
              type: "integration.disconnect",
            });
            await load();
            return result.type === "integration.disconnect" && result.notice !== null
              ? result.notice
              : `${account.title} is disconnected.`;
          }),
        style: "destructive",
        text: "Disconnect",
      },
      { style: "cancel", text: "Cancel" },
    ]);

  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <AppText role="secondary" tone="soft">
          The accounts agents use. Which Workspaces can use each one is set from Opensteer on a
          computer.
        </AppText>
        {online ? null : (
          <Notice
            detail="Reconnect to see your apps or make changes."
            title={`${hostName} is not connected`}
            tone="neutral"
          />
        )}
        {done === null ? null : <Notice detail={done} title="Done" tone="neutral" />}
        {error === null ? null : <Notice detail={error} title="That did not finish" />}
        {loadError === null ? null : (
          <Notice
            action={{ label: "Try again", onPress: () => void load() }}
            detail={loadError}
            title="Connected apps could not be loaded"
          />
        )}
        {apps !== null && apps.length === 0 ? (
          <AppText role="secondary" tone="muted">
            No apps yet. Add one from Opensteer on a computer, or when an agent asks for it.
          </AppText>
        ) : null}
        {(apps ?? []).map((app) => (
          <AppGroup
            app={app}
            busy={busy}
            key={app.definitionId}
            onChooseRepositories={chooseRepositories}
            onDisconnect={disconnect}
            onSignIn={(key) => signIn(app, key)}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}

function AppGroup(props: {
  readonly app: ConnectedAppModel;
  readonly busy: string | null;
  readonly onChooseRepositories: (account: ConnectedAccountRow) => void;
  readonly onDisconnect: (account: ConnectedAccountRow) => void;
  readonly onSignIn: (key: string) => void;
}): ReactNode {
  const { app, busy } = props;
  const signsIn = app.signIn?.kind === "direct" || app.signIn?.kind === "choose";
  const addKey = `add:${app.definitionId}`;
  const keyRepair = app.accounts.some(({ repair }) => repair === "replace-key");
  const note =
    app.signIn?.kind === "elsewhere"
      ? app.signIn.note
      : app.signIn?.kind === "unavailable"
        ? app.signIn.detail
        : keyRepair
          ? "Replace a key from Opensteer on a computer."
          : null;
  return (
    <View style={styles.group}>
      <View style={styles.groupHead}>
        <IntegrationIcon definitionId={app.definitionId} name={app.name} />
        <View style={styles.groupText}>
          <AppText role="bodyMedium">{app.name}</AppText>
          <AppText numberOfLines={2} role="secondary" tone="muted">
            {app.description}
          </AppText>
        </View>
      </View>
      <RowGroup>
        {[
          ...app.accounts.map((account) => (
            <Pressable
              accessibilityHint="Shows the way to disconnect it"
              accessibilityLabel={`${account.title}, ${account.status.text}`}
              accessibilityRole="button"
              disabled={busy !== null}
              key={account.id}
              onPress={() => props.onDisconnect(account)}
              style={({ pressed }) => [styles.account, pressed && styles.pressed]}
            >
              <View style={styles.mark}>
                <AppText role="secondaryMedium" tone="ember">
                  {account.title.trim().charAt(0).toLocaleUpperCase() || "?"}
                </AppText>
              </View>
              <View style={styles.accountText}>
                <AppText numberOfLines={1} role="body">
                  {account.title}
                </AppText>
                <View style={styles.status}>
                  <StatusDot size={6} tone={dotTone[account.status.tone]} />
                  <AppText
                    numberOfLines={1}
                    role="secondary"
                    style={account.status.tone === "attention" ? styles.attention : undefined}
                    tone="muted"
                  >
                    {account.status.text}
                  </AppText>
                </View>
              </View>
              {account.repair === "sign-in" && signsIn ? (
                <SecondaryButton
                  busy={busy === account.id}
                  compact
                  disabled={busy !== null}
                  label="Reconnect"
                  onPress={() => props.onSignIn(account.id)}
                />
              ) : account.repair === "choose-repositories" ? (
                <SecondaryButton
                  busy={busy === account.id}
                  compact
                  disabled={busy !== null}
                  label="Choose repositories"
                  onPress={() => props.onChooseRepositories(account)}
                />
              ) : null}
            </Pressable>
          )),
          signsIn ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: busy === addKey, disabled: busy !== null }}
              disabled={busy !== null}
              key={addKey}
              onPress={() => props.onSignIn(addKey)}
              style={({ pressed }) => [styles.account, pressed && styles.pressed]}
            >
              <View style={[styles.mark, styles.markAdd]}>
                <AppText role="body" tone="ember">
                  +
                </AppText>
              </View>
              <AppText role="body" tone="ember">
                {busy === addKey
                  ? "Waiting for sign-in…"
                  : app.accounts.length > 0
                    ? "Add another account"
                    : `Connect your ${app.name} account`}
              </AppText>
            </Pressable>
          ) : null,
        ]}
      </RowGroup>
      {note === null ? null : (
        <AppText role="caption" tone="muted">
          {note}
        </AppText>
      )}
    </View>
  );
}

const dotTone = { attention: "amber", off: "muted", ok: "green" } as const;

const selectUserId = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

const styles = StyleSheet.create({
  account: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  accountText: { flex: 1, gap: space[2], minWidth: 0 },
  attention: { color: color.amber },
  away: { gap: space[12], paddingTop: space[24] },
  content: { gap: space[24], paddingTop: space[12] },
  group: { gap: space[10] },
  groupHead: { alignItems: "center", flexDirection: "row", gap: space[12] },
  groupText: { flex: 1, gap: space[2] },
  mark: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  markAdd: {
    backgroundColor: "transparent",
    borderColor: color.emberLine,
    borderStyle: "dashed",
    borderWidth: 1,
  },
  pressed: { backgroundColor: color.surfacePressed },
  status: { alignItems: "center", flexDirection: "row", gap: space[6] },
});
