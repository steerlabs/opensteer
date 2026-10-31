import {
  browserSiteLabel,
  canRespondToRequests,
  formatRelativeTime,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type {
  BrowserSiteGrant,
  BrowserSourceSummary,
  BrowserSourcesState,
} from "@opensteer/protocol/browser-sources";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, AppState, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import {
  AppText,
  Field,
  Notice,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  StatusDot,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { WorkspaceDot } from "../ui/workspace-mark.js";

export type ChromeDestination = { readonly deploymentId: string };

/** Whether each Chrome is online changes without anyone touching this screen. */
const refreshEveryMs = 15_000;

/**
 * Chrome for one Deployment, from the phone: which Chrome profiles are
 * connected and which sites each Workspace's agents may sign in to. Connecting
 * Chrome happens in Chrome itself, so the phone manages and never connects.
 */
export function ChromeScreen({ route }: StaticScreenProps<ChromeDestination>): ReactNode {
  const { deploymentId } = route.params;
  const client = useMobileClient();
  const { rows, selection } = useMobileState();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
              : `Open ${row.name} to manage its Chrome.`}
          </AppText>
          {failure === null ? null : <Notice detail={failure} title="That did not open" />}
          {row === undefined ? null : (
            <SecondaryButton
              busy={opening}
              label={`Open ${row.name}`}
              onPress={() => {
                setOpening(true);
                setFailure(null);
                void client
                  .openDeployment(deploymentId)
                  .catch((error: unknown) =>
                    setFailure(
                      operationDetail(error, "That deployment still could not be opened."),
                    ),
                  )
                  .finally(() => setOpening(false));
              }}
            />
          )}
        </View>
      </Screen>
    );
  }
  return <SignedInChrome deploymentName={row.name} hostClient={hostClient} />;
}

/** Keyed by who is signed in, so a changed account never sees the last one's Chrome. */
function SignedInChrome(props: {
  readonly deploymentName: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const userId = useHostSelector(props.hostClient, selectUserId);
  if (userId === null) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            Sign in to this deployment to manage its Chrome.
          </AppText>
        </View>
      </Screen>
    );
  }
  return <ChromeSettings key={userId} {...props} />;
}

function ChromeSettings(props: {
  readonly deploymentName: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentName, hostClient } = props;
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const focused = useIsFocused();
  const online = useHostSelector(hostClient, canRespondToRequests);
  const workspaces = useHostSelector(hostClient, selectWorkspaces);
  const [state, setState] = useState<BrowserSourcesState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(unwrapRpcResult(await hostClient.rpc["browser.sources.get"]({})));
      setLoadError(null);
    } catch (error) {
      setLoadError(operationDetail(error, "Chrome could not be loaded."));
    }
  }, [hostClient]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!focused || !foreground || !online) return;
    void load();
    const timer = setInterval(() => void load(), refreshEveryMs);
    return () => clearInterval(timer);
  }, [focused, foreground, load, online]);

  const announce = (message: string) => {
    setNotice(message);
    void AccessibilityInfo.announceForAccessibility(message);
  };

  const sources = state?.sources ?? [];
  const sites = groupBySite(state?.sites ?? []);
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <AppText role="secondary" tone="soft">
          Let agents use websites you’re already signed in to in Chrome. You approve each site once.
        </AppText>
        {online ? null : (
          <Notice
            detail="Reconnect to see your Chrome or make changes."
            title={`${deploymentName} is not connected`}
            tone="neutral"
          />
        )}
        {notice === null ? null : <Notice detail={notice} title="Done" tone="neutral" />}
        {loadError === null ? null : (
          <Notice
            action={{ label: "Try again", onPress: () => void load() }}
            detail={loadError}
            title="Chrome could not be loaded"
          />
        )}

        <View style={styles.section}>
          <SectionLabel>Connected Chrome</SectionLabel>
          {state === null ? (
            <AppText role="secondary" tone="muted">
              {online ? "Loading…" : "Not loaded yet."}
            </AppText>
          ) : sources.length === 0 ? (
            <ConnectOnComputer deploymentName={deploymentName} />
          ) : (
            <>
              <RowGroup>
                {sources.map((source) => (
                  <SourceRow
                    hostClient={hostClient}
                    key={source.id}
                    onChanged={(message) => {
                      announce(message);
                      void load();
                    }}
                    online={online}
                    source={source}
                  />
                ))}
              </RowGroup>
              <AppText role="caption" tone="muted">
                To connect another Chrome, use Opensteer on that computer.
              </AppText>
            </>
          )}
        </View>

        {state === null ? null : (
          <View style={styles.section}>
            <SectionLabel>Allowed sites</SectionLabel>
            {sites.length === 0 ? (
              <AppText role="secondary" tone="muted">
                None yet. When an agent needs a site, you’re asked once.
              </AppText>
            ) : (
              sites.map(([site, grants]) => (
                <SiteGroup
                  grants={grants}
                  hostClient={hostClient}
                  key={site}
                  onRemoved={(message) => {
                    announce(message);
                    void load();
                  }}
                  online={online}
                  site={site}
                  workspaces={workspaces}
                />
              ))
            )}
            <AppText role="caption" tone="muted">
              Removing a site stops new sign-ins. Browsers already signed in stay signed in.
            </AppText>
          </View>
        )}

        <AppText role="caption" tone="muted">
          Sign-ins are shared as cookies, so an agent can act as you on an allowed site. Opensteer’s
          browser can’t use passkeys, so a site that asks for one, or ties a sign-in to one device,
          may still ask you to sign in.
        </AppText>
      </ScrollView>
    </Screen>
  );
}

/** The phone cannot run Chrome's connect page, so it names where that happens. */
function ConnectOnComputer(props: { readonly deploymentName: string }): ReactNode {
  return (
    <View accessibilityRole="summary" accessible style={styles.connect}>
      <Symbol name="laptopcomputer" size={22} tint={color.ember} />
      <View style={styles.connectText}>
        <AppText role="bodyMedium">Connect Chrome from Opensteer on your computer</AppText>
        <AppText role="secondary" tone="soft">
          {`On the computer where you use Chrome, open ${props.deploymentName} and go to Settings, then Chrome. Once it’s connected, you can manage it here.`}
        </AppText>
      </View>
    </View>
  );
}

function SourceRow(props: {
  readonly hostClient: HostClient;
  readonly onChanged: (message: string) => void;
  readonly online: boolean;
  readonly source: BrowserSourceSummary;
}): ReactNode {
  const { source } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "disconnect" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const status = source.connected
    ? "Online"
    : source.lastSeenAt === null
      ? "Offline"
      : `Offline · seen ${formatRelativeTime(source.lastSeenAt)}`;

  const rename = () => {
    const name = draft?.trim() ?? "";
    if (name === "" || busy !== null) return;
    if (name === source.name) {
      setDraft(null);
      return;
    }
    setBusy("rename");
    setFailure(null);
    void props.hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-source-rename:${source.id}`),
        name,
        sourceId: source.id,
        type: "browser.source.rename",
      })
      .then(() => {
        setDraft(null);
        props.onChanged(`Renamed to ${name}.`);
      })
      .catch((error: unknown) => setFailure(operationDetail(error, "The name did not change.")))
      .finally(() => setBusy(null));
  };

  const disconnect = () => {
    Alert.alert(
      `Disconnect ${source.name}?`,
      "Agents stop getting new sign-ins from this Chrome. Browsers already signed in stay signed in. To connect it again, use Opensteer on that computer.",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () => {
            setBusy("disconnect");
            setFailure(null);
            void props.hostClient
              .dispatch({
                idempotencyKey: mutationIdempotencyKey(`browser-source-revoke:${source.id}`),
                sourceId: source.id,
                type: "browser.source.revoke",
              })
              .then(() => props.onChanged(`${source.name} disconnected.`))
              .catch((error: unknown) =>
                setFailure(operationDetail(error, `${source.name} is still connected. Try again.`)),
              )
              .finally(() => setBusy(null));
          },
          style: "destructive",
          text: "Disconnect",
        },
      ],
    );
  };

  return (
    <View style={styles.row}>
      <View accessible accessibilityLabel={`${source.name}, ${status}`} style={styles.rowHead}>
        <StatusDot tone={source.connected ? "green" : "muted"} />
        <View style={styles.rowText}>
          <AppText role="bodyMedium">{source.name}</AppText>
          <AppText role="caption" tone="muted">
            {status}
          </AppText>
        </View>
      </View>
      {draft === null ? (
        <View style={styles.actions}>
          <SecondaryButton
            accessibilityLabel={`Rename ${source.name}`}
            compact
            disabled={!props.online || busy !== null}
            label="Rename"
            onPress={() => {
              setDraft(source.name);
              setFailure(null);
            }}
          />
          <SecondaryButton
            accessibilityLabel={`Disconnect ${source.name}`}
            busy={busy === "disconnect"}
            compact
            disabled={!props.online || busy !== null}
            label="Disconnect"
            onPress={disconnect}
            tone="danger"
          />
        </View>
      ) : (
        <>
          <Field
            input={{
              autoFocus: true,
              maxLength: 120,
              onChangeText: setDraft,
              onSubmitEditing: rename,
              returnKeyType: "done",
              value: draft,
            }}
            label="Name"
          />
          <View style={styles.actions}>
            <SecondaryButton
              busy={busy === "rename"}
              compact
              disabled={!props.online || draft.trim() === ""}
              label="Save"
              onPress={rename}
            />
            <SecondaryButton
              compact
              disabled={busy !== null}
              label="Cancel"
              onPress={() => setDraft(null)}
            />
          </View>
        </>
      )}
      {failure === null ? null : (
        <AppText role="caption" tone="danger">
          {failure}
        </AppText>
      )}
    </View>
  );
}

/** One site, and each Workspace whose agents may sign in to it. */
function SiteGroup(props: {
  readonly grants: readonly BrowserSiteGrant[];
  readonly hostClient: HostClient;
  readonly onRemoved: (message: string) => void;
  readonly online: boolean;
  readonly site: string;
  readonly workspaces: HostSnapshot["workspaces"];
}): ReactNode {
  const domain = browserSiteLabel(props.site);
  return (
    <RowGroup>
      {[
        <View accessibilityRole="header" key="site" style={styles.siteHead}>
          <Symbol name="globe" size={17} tint={color.textSoft} />
          <AppText role="bodyMedium" selectable style={styles.rowText}>
            {domain}
          </AppText>
        </View>,
        ...props.grants.map((grant) => (
          <SiteWorkspaceRow
            domain={domain}
            grant={grant}
            hostClient={props.hostClient}
            key={grant.workspaceId}
            onRemoved={props.onRemoved}
            online={props.online}
            workspace={props.workspaces.find((candidate) => candidate.id === grant.workspaceId)}
          />
        )),
      ]}
    </RowGroup>
  );
}

function SiteWorkspaceRow(props: {
  readonly domain: string;
  readonly grant: BrowserSiteGrant;
  readonly hostClient: HostClient;
  readonly onRemoved: (message: string) => void;
  readonly online: boolean;
  readonly workspace: HostSnapshot["workspaces"][number] | undefined;
}): ReactNode {
  const { domain, grant } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const workspaceName = props.workspace?.name ?? "Another Workspace";
  return (
    <View style={styles.siteRow}>
      {props.workspace === undefined ? null : <WorkspaceDot color={props.workspace.color} />}
      <View style={styles.rowText}>
        <AppText role="body">{workspaceName}</AppText>
        <AppText role="caption" tone="muted">
          {grant.lastSignedInAt === null
            ? "Not used yet"
            : `Last signed in ${formatRelativeTime(grant.lastSignedInAt)}`}
        </AppText>
        {failure === null ? null : (
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        )}
      </View>
      <SecondaryButton
        accessibilityLabel={`Remove ${domain} from ${workspaceName}`}
        busy={busy}
        compact
        disabled={!props.online}
        label="Remove"
        onPress={() => {
          setBusy(true);
          setFailure(null);
          void props.hostClient
            .dispatch({
              idempotencyKey: mutationIdempotencyKey(
                `browser-site-remove:${grant.workspaceId}:${grant.site}`,
              ),
              site: grant.site,
              type: "browser.site.remove",
              workspaceId: grant.workspaceId,
            })
            .then(() =>
              props.onRemoved(
                `${domain} removed from ${workspaceName}. Agents there ask before using it again.`,
              ),
            )
            .catch((error: unknown) =>
              setFailure(operationDetail(error, `${domain} is still allowed. Try again.`)),
            )
            .finally(() => setBusy(false));
        }}
        tone="danger"
      />
    </View>
  );
}

function groupBySite(
  grants: readonly BrowserSiteGrant[],
): (readonly [string, readonly BrowserSiteGrant[]])[] {
  const bySite = new Map<string, BrowserSiteGrant[]>();
  for (const grant of grants) bySite.set(grant.site, [...(bySite.get(grant.site) ?? []), grant]);
  return [...bySite.entries()].sort(([left], [right]) =>
    browserSiteLabel(left).localeCompare(browserSiteLabel(right)),
  );
}

const selectUserId = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;
const selectWorkspaces = (snapshot: HostSnapshot) => snapshot.workspaces;

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  away: { gap: space[12], paddingTop: space[24] },
  connect: {
    ...material.attention,
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: space[12],
    padding: space[16] - (1 - StyleSheet.hairlineWidth),
  },
  connectText: { flex: 1, gap: space[4] },
  content: { gap: space[24], paddingTop: space[12] },
  row: { gap: space[10], paddingHorizontal: space[16], paddingVertical: space[12] },
  rowHead: { alignItems: "center", flexDirection: "row", gap: space[10] },
  rowText: { flex: 1, gap: space[2] },
  section: { gap: space[10] },
  siteHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  siteRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
});
