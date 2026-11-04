import type { NativeSettingsSection, NativeSettingsRow } from "./native-settings-page.types.js";
import {
  canRespondToRequests,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import {
  authorizationConnection,
  canSetUpOwnApp,
  connectProviderManifest,
  connectSavedSource,
  type IntegrationDashboard,
  integrationAccountTitle,
  integrationAuthorizationError,
  type IntegrationOAuthApplicationSource,
  type IntegrationPlatformDashboardView,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText, Notice, RowGroup, SecondaryButton, StatusDot } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IntegrationOAuthAppForm } from "../thread/integration-oauth-app-form.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import {
  connectedAppsModel,
  type ConnectedAccountRow,
  type ConnectedAppModel,
} from "./connected-apps-model.js";

/** Keyed by who is signed in, so a changed account never sees the last one's apps. */
export function PluginAccounts(props: {
  readonly hostClient: HostClient;
  readonly hostName: string;
  readonly definitionId?: string | undefined;
  readonly render?: (sections: NativeSettingsSection[]) => ReactNode;
  readonly onConnected?: (connectionId: string) => Promise<void>;
}): ReactNode {
  const userId = useHostSelector(props.hostClient, selectUserId);
  if (userId === null) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            Sign in to this deployment to manage its connections.
          </AppText>
        </View>
      </Screen>
    );
  }
  return <ConnectedApps key={userId} {...props} />;
}

function ConnectedApps(props: {
  readonly hostClient: HostClient;
  readonly hostName: string;
  readonly definitionId?: string | undefined;
  readonly render?: (sections: NativeSettingsSection[]) => ReactNode;
  readonly onConnected?: (connectionId: string) => Promise<void>;
}) {
  const { hostClient, hostName } = props;
  const mobile = useMobileClient();
  const active = useRef(true);
  const viewer = useRef(hostClient.getSnapshot().user?.id);
  const current = useCallback(
    () =>
      active.current &&
      hostClient.getSnapshot().user?.id === viewer.current &&
      canRespondToRequests(hostClient.getSnapshot()),
    [hostClient],
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [hostClient]);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const focused = useIsFocused();
  const online = useHostSelector(hostClient, canRespondToRequests);
  const [dashboard, setDashboard] = useState<IntegrationDashboard | null>(null);
  const [ownApp, setOwnApp] = useState(false);
  const [savedSource, setSavedSource] = useState<{
    readonly definitionId: string;
    readonly source: IntegrationOAuthApplicationSource;
  } | null>(null);
  const [platform, setPlatform] = useState<IntegrationPlatformDashboardView | null>(null);
  const [keyValues, setKeyValues] = useState<Record<string, string>>({});
  const keyAttempt = useRef<{
    command: Extract<
      import("@opensteer/protocol").HostApiCommandInput,
      { type: "integration.apiKey.connect" }
    >;
    known: Set<string>;
  } | null>(null);
  const [apps, setApps] = useState<readonly ConnectedAppModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The row whose action is under way; every other action waits for it. */
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<AbortController | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  /** The GitHub account sent to choose repositories, checked again when the person is back. */
  const awaitingRepositories = useRef<{ readonly id: string; readonly title: string } | null>(null);
  const returned = useRef<() => void>(() => undefined);

  const load = useCallback(async () => {
    try {
      const [dashboard, platform] = await Promise.all([
        hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]);
      if (!current()) return null;
      setDashboard(dashboard);
      setPlatform(platform);
      setApps(connectedAppsModel({ dashboard, hostName, platform }));
      setLoadError(null);
      return dashboard;
    } catch (reason) {
      if (current()) setLoadError(operationDetail(reason, "Connections could not be loaded."));
      return null;
    }
  }, [hostClient, hostName, current]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setForeground(next === "active");
      if (next === "active") returned.current();
    });
    return () => subscription.remove();
  }, []);

  // Read when shown and when the person comes back, as from GitHub in the browser.
  useEffect(() => {
    if (focused && foreground && online) void load();
  }, [focused, foreground, load, online]);

  /** One action at a time, its failure said once, and the list read again after it. */
  const run = async (key: string, action: () => Promise<string | null>) => {
    if (busy !== null || !current()) return;
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const message = await action();
      if (current() && message !== null) {
        setDone(message);
        void AccessibilityInfo.announceForAccessibility(message);
      }
    } catch (reason) {
      if (current()) setError(operationDetail(reason, "That did not finish. Try again."));
    } finally {
      if (current()) setBusy(null);
    }
  };

  /**
   * GitHub's repository step: the Host counts a GitHub account connected only
   * once a check finds a repository it can reach. Until then GitHub is where
   * repositories are chosen, and coming back checks again.
   */
  const finishRepositories = async (
    account: { readonly id: string; readonly title: string },
    openGitHub: boolean,
  ): Promise<string | null> => {
    const access = unwrapRpcResult(
      await hostClient.rpc["integration.repositoryAccess.check"]({ connectionId: account.id }),
    );
    await load();
    if (access.ready) {
      awaitingRepositories.current = null;
      return `${account.title} is connected.`;
    }
    awaitingRepositories.current = account;
    if (!openGitHub) return null;
    const url = access.installationUrl ?? access.installations[0]?.configureUrl ?? null;
    if (url === null) {
      throw new Error(
        "This sign-in app has no GitHub App installation link. Choose repositories from Opensteer on a computer.",
      );
    }
    await Linking.openURL(url);
    return null;
  };

  useEffect(() => {
    returned.current = () => {
      const account = awaitingRepositories.current;
      if (account !== null) void run(account.id, () => finishRepositories(account, false));
    };
  });

  const signIn = (app: ConnectedAppModel, key: string) => {
    const start = (source: IntegrationOAuthApplicationSource) =>
      void run(key, async () => {
        const controller = new AbortController();
        setSigningIn(controller);
        const status = await mobile
          .beginIntegrationAuthorization({
            applicationSource: source,
            definitionId: app.definitionId,
            signal: controller.signal,
          })
          .finally(() => setSigningIn(null));
        if (!current()) return null;
        const outcome = integrationAuthorizationError(status.status, status.failureCode);
        if (outcome !== null) throw new Error(outcome);
        const dashboard = await load();
        const connection =
          dashboard === null ? null : authorizationConnection(dashboard, status.connectionId);
        if (connection === null) {
          throw new Error(
            `${app.name} reported success, but no connected account is recorded here. Try again.`,
          );
        }
        setPendingConnection(connection.id);
        await props.onConnected?.(connection.id);
        setPendingConnection(null);
        if (!current()) return null;
        const account = { id: connection.id, title: integrationAccountTitle(connection) };
        return connection.status === "connected"
          ? `${account.title} is connected.`
          : finishRepositories(account, true);
      });
    if (savedSource && app.definitionId === savedSource.definitionId) {
      start(savedSource.source);
      return;
    }
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
    void run(account.id, () => finishRepositories(account, true));

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

  const definition = platform?.catalog.find(
    (entry) => entry.definition.id === props.definitionId,
  )?.definition;
  const provider = definition?.provider ?? null;
  const manifest = dashboard && provider ? connectProviderManifest(dashboard, provider) : null;
  const canSetUp = dashboard && provider ? canSetUpOwnApp(dashboard, provider) : false;
  const appEditor =
    ownApp && manifest && provider && dashboard ? (
      <Sheet open={ownApp} onClose={() => setOwnApp(false)} title="Your own app">
        <View style={{ padding: space[16], gap: space[16] }}>
          {error ? <Notice title="App could not be saved" detail={error} /> : null}
          <IntegrationOAuthAppForm
            busy={busy !== null}
            callbackUrl={dashboard.callbackUrls[provider] ?? ""}
            manifest={manifest}
            onSave={(draft) =>
              void run("own-app", async () => {
                const saved = await hostClient.dispatch({
                  idempotencyKey: mutationIdempotencyKey(`integration-app:${provider}`),
                  input: {
                    availability: "personal",
                    clientId: draft.clientId,
                    displayName: draft.displayName,
                    expectedRevision: null,
                    ...(draft.installationUrl ? { installationUrl: draft.installationUrl } : {}),
                    provider,
                    secrets: draft.secrets,
                  },
                  type: "integration.providerApplication.save",
                });
                if (saved.type !== "integration.providerApplication.save")
                  throw new Error("Integration application command mismatch.");
                if (!current()) return null;
                const fresh = await load();
                if (!fresh || !current()) return null;
                const source = connectSavedSource(fresh, saved.application);
                setSavedSource(
                  source && definition ? { definitionId: definition.id, source } : null,
                );
                setOwnApp(false);
                return "App saved. No account is connected yet.";
              })
            }
          />
        </View>
      </Sheet>
    ) : null;
  if (props.render) {
    const button = (
      key: string,
      label: string,
      onPress: () => void,
    ): Extract<NativeSettingsRow, { kind: "button" }> => ({
      key,
      kind: "button",
      label,
      onPress,
      disabled: busy !== null || !online,
    });
    const sections: NativeSettingsSection[] = [];
    if (busy)
      sections.push({
        key: "pending",
        title: "Connecting",
        rows: [
          { key: "pending", kind: "text", label: "Waiting for sign-in and saving placement…" },
          ...(signingIn
            ? [{ ...button("cancel", "Cancel sign-in", () => signingIn.abort()), disabled: false }]
            : []),
        ],
      });
    if (error || loadError || done)
      sections.push({
        key: "account-status",
        title: error || loadError ? "Needs you" : "Sign-in",
        rows: [
          { key: "status", kind: "text", label: error ?? loadError ?? done ?? "" },
          ...(loadError ? [button("retry", "Try again", () => void load())] : []),
        ],
      });
    if (pendingConnection && props.onConnected)
      sections.push({
        key: "placement-retry",
        title: "Finish adding",
        rows: [
          button(
            "retry-placement",
            "Retry placement",
            () =>
              void run("placement", async () => {
                await props.onConnected?.(pendingConnection);
                setPendingConnection(null);
                return "Connected and turned on in your chosen places.";
              }),
          ),
        ],
      });
    for (const method of definition?.authMethods ?? []) {
      if (method.kind !== "api-key") continue;
      sections.push({
        key: `key:${method.id}`,
        title: method.label,
        rows: [
          ...method.inputs.map((input): NativeSettingsRow => ({
            key: input.variable,
            kind: "input",
            label: input.label,
            secure: input.secret,
            value: keyValues[input.variable] ?? "",
            onChange: (value) => setKeyValues((prior) => ({ ...prior, [input.variable]: value })),
          })),
          button(
            `connect-key:${method.id}`,
            keyAttempt.current ? "Retry connection" : "Connect account",
            () =>
              void run("api-key", async () => {
                if (!keyAttempt.current) {
                  const before = await load();
                  if (!before || !current()) throw new Error("Reconnect before adding an account.");
                  keyAttempt.current = {
                    known: new Set(before.connections.map((connection) => connection.id)),
                    command: {
                      type: "integration.apiKey.connect",
                      idempotencyKey: mutationIdempotencyKey("plugin-api-key"),
                      input: {
                        definitionId: definition!.id,
                        authMethodId: method.id,
                        values: { ...keyValues },
                      },
                    },
                  };
                }
                const attempt = keyAttempt.current;
                await hostClient.dispatch(attempt.command);
                const after = await load();
                if (!after || !current()) return null;
                const matches = after.connections.filter(
                  (connection) =>
                    connection.definitionId === definition!.id && !attempt.known.has(connection.id),
                );
                if (matches.length !== 1)
                  throw new Error(
                    "The connected account could not be identified. Review it in Plugins.",
                  );
                const connection = matches[0]!;
                setKeyValues({});
                setPendingConnection(connection.id);
                keyAttempt.current = null;
                await props.onConnected?.(connection.id);
                setPendingConnection(null);
                return "Connected and turned on in your chosen places.";
              }),
          ),
        ],
      });
    }
    for (const app of apps ?? []) {
      if (props.definitionId && app.definitionId !== props.definitionId) continue;
      const rows: NativeSettingsRow[] = [];
      for (const account of app.accounts) {
        rows.push({
          key: account.id,
          kind: "text",
          label: `${account.title} · ${account.status.text}`,
        });
        if (account.repair === "sign-in")
          rows.push(button(`${account.id}:repair`, "Reconnect", () => signIn(app, account.id)));
        if (account.repair === "choose-repositories")
          rows.push(
            button(`${account.id}:repos`, "Choose repositories", () => chooseRepositories(account)),
          );
        rows.push({
          ...button(`${account.id}:remove`, `Disconnect ${account.title}`, () =>
            disconnect(account),
          ),
          destructive: true,
        });
      }
      if (app.signIn?.kind === "direct" || app.signIn?.kind === "choose")
        rows.push(
          button(
            `add:${app.definitionId}`,
            app.accounts.length ? "Add another account" : `Connect your ${app.name} account`,
            () => signIn(app, `add:${app.definitionId}`),
          ),
        );
      else if (app.signIn?.kind === "elsewhere" || app.signIn?.kind === "unavailable")
        rows.push({
          key: "unavailable",
          kind: "text",
          label: app.signIn.kind === "elsewhere" ? app.signIn.note : app.signIn.detail,
        });
      sections.push({ key: `accounts:${app.definitionId}`, title: "Sign in", rows });
    }
    if (canSetUp)
      sections.push({
        key: "own-app",
        title: "Sign-in app",
        rows: [
          button("own-app", "Use my own OAuth app", () => {
            setError(null);
            setOwnApp(true);
          }),
        ],
      });
    return (
      <>
        {props.render(sections)}
        {appEditor}
      </>
    );
  }
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {online ? null : (
          <Notice
            detail="Reconnect to see your apps or make changes."
            title={`${hostName} is not connected`}
            tone="neutral"
          />
        )}
        {signingIn ? (
          <SecondaryButton label="Cancel sign-in" onPress={() => signingIn.abort()} />
        ) : null}
        {done === null ? null : <Notice detail={done} title="Done" tone="neutral" />}
        {error === null ? null : <Notice detail={error} title="That did not finish" />}
        {loadError === null ? null : (
          <Notice
            action={{ label: "Try again", onPress: () => void load() }}
            detail={loadError}
            title="Connections could not be loaded"
          />
        )}
        {apps !== null && apps.length === 0 ? (
          <AppText role="secondary" tone="muted">
            No apps yet. Add one from Opensteer on a computer, or when an agent asks for it.
          </AppText>
        ) : null}
        {canSetUp ? (
          <SecondaryButton
            label="Use my own OAuth app"
            disabled={busy !== null || !online}
            onPress={() => {
              setError(null);
              setOwnApp(true);
            }}
          />
        ) : null}
        {appEditor}
        {(apps ?? [])
          .filter((app) => !props.definitionId || app.definitionId === props.definitionId)
          .map((app) => (
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
              accessibilityLabel={`Add a ${app.name} account`}
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
