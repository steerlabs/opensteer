import {
  browserSiteLabel,
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, AppState, ScrollView, StyleSheet, View } from "react-native";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { notDone, readLine, useScreenAction, useScreenRead } from "../ui/client-feedback.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import {
  AppText,
  Field,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  StatusDot,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";

export type ChromeDestination = { readonly deploymentId: string };

/** Whether each Chrome is online changes without anyone touching this screen. */
const refreshEveryMs = 15_000;

/**
 * Chrome for one Deployment, from the phone: which Chrome profiles are
 * connected and which sites your agents may sign in to. Connecting
 * Chrome happens in Chrome itself, so the phone manages and never connects.
 */
export function ChromeScreen({ route }: StaticScreenProps<ChromeDestination>): ReactNode {
  const { deploymentId } = route.params;
  const client = useMobileClient();
  const { rows, selection } = useMobileState();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<ActionLineValue | null>(null);
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
          {failure === null ? null : <ActionLine line={failure} />}
          {row === undefined ? null : (
            <SecondaryButton
              busy={opening}
              label={`Open ${row.name}`}
              onPress={() => {
                setOpening(true);
                setFailure(null);
                void client
                  .openDeployment(deploymentId)
                  .catch(() =>
                    setFailure({ key: "open", text: `Couldn't open ${row.name}.`, tone: "muted" }),
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
        <PlaceholderRows />
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
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const watching = useRef(false);
  watching.current = focused && foreground;
  const read = useScreenRead(hostClient, {
    key: "browser-sources",
    label: "Chrome",
    read: async () => unwrapRpcResult(await hostClient.rpc["browser.sources.get"]({})),
    // Whether each Chrome is online changes on its own; reread while this is in front.
    subscribeInvalidation: (invalidate) => {
      const timer = setInterval(() => {
        if (watching.current) invalidate();
      }, refreshEveryMs);
      return () => clearInterval(timer);
    },
  });
  const state: BrowserSourcesState | null = read.data;
  const reload = read.refresh;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);

  const announce = (message: string) => {
    void AccessibilityInfo.announceForAccessibility(message);
  };
  const missing = state === null ? readLine(read, reload) : null;

  const sources = state?.sources ?? [];
  const sites = [...(state?.sites ?? [])].sort((left, right) =>
    browserSiteLabel(left.site).localeCompare(browserSiteLabel(right.site)),
  );
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

        <View style={styles.section}>
          <SectionLabel>Connected Chrome</SectionLabel>
          {state === null ? (
            missing === null ? (
              <PlaceholderRows count={1} />
            ) : (
              <ActionLine line={missing} />
            )
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
                      reload();
                    }}
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
              <RowGroup>
                {sites.map((grant) => (
                  <SiteRow
                    grant={grant}
                    hostClient={hostClient}
                    key={grant.site}
                    onRemoved={(message) => {
                      announce(message);
                      reload();
                    }}
                  />
                ))}
              </RowGroup>
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

async function readSources(hostClient: HostClient): Promise<BrowserSourcesState> {
  return unwrapRpcResult(await hostClient.rpc["browser.sources.get"]({}));
}

function SourceRow(props: {
  readonly hostClient: HostClient;
  readonly onChanged: (message: string) => void;
  readonly source: BrowserSourceSummary;
}): ReactNode {
  const { hostClient, source } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const status = source.connected
    ? "Online"
    : source.lastSeenAt === null
      ? "Offline"
      : `Offline · seen ${formatRelativeTime(source.lastSeenAt)}`;
  const renameSpec = {
    label: `rename ${source.name}`,
    done: "renamed",
    happened: `${source.name} was renamed`,
  } as const;
  const renaming = useScreenAction<string, void>(hostClient, `chrome-rename:${source.id}`, {
    ...renameSpec,
    execute: async (name) => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-source-rename:${source.id}`),
        name,
        sourceId: source.id,
        type: "browser.source.rename",
      });
      setDraft(null);
      props.onChanged(`Renamed to ${name}.`);
    },
    reconcile: async (name) => {
      const found = (await readSources(hostClient)).sources.find(({ id }) => id === source.id);
      return found?.name === name
        ? { kind: "confirmed", value: undefined }
        : notDone(renameSpec.done);
    },
    retry: () => rename(),
  });
  const revokeSpec = {
    label: `disconnect ${source.name}`,
    done: "disconnected",
    happened: `${source.name} was disconnected`,
  } as const;
  const revoking = useScreenAction<void, void>(hostClient, `chrome-revoke:${source.id}`, {
    ...revokeSpec,
    execute: async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-source-revoke:${source.id}`),
        sourceId: source.id,
        type: "browser.source.revoke",
      });
      props.onChanged(`${source.name} disconnected.`);
    },
    reconcile: async () =>
      (await readSources(hostClient)).sources.some(({ id }) => id === source.id)
        ? notDone(revokeSpec.done)
        : { kind: "confirmed", value: undefined },
    retry: () => void revoking.run(),
  });
  const busy = renaming.running ? "rename" : revoking.running ? "disconnect" : null;
  const line = renaming.line ?? revoking.line;

  const rename = () => {
    const name = draft?.trim() ?? "";
    if (name === "" || busy !== null) return;
    if (name === source.name) {
      setDraft(null);
      return;
    }
    void renaming.run(name);
  };

  const disconnect = () => {
    Alert.alert(
      `Disconnect ${source.name}?`,
      "Agents stop getting new sign-ins from this Chrome. Browsers already signed in stay signed in. To connect it again, use Opensteer on that computer.",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () => void revoking.run(),
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
            disabled={busy !== null}
            label="Rename"
            onPress={() => {
              setDraft(source.name);
              renaming.dismiss();
            }}
          />
          <SecondaryButton
            accessibilityLabel={`Disconnect ${source.name}`}
            busy={busy === "disconnect"}
            compact
            disabled={busy !== null}
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
              disabled={draft.trim() === ""}
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
      {line === null ? null : (
        <ActionLine line={line} onDismiss={renaming.line ? renaming.dismiss : revoking.dismiss} />
      )}
    </View>
  );
}

/** One site your agent may sign in to, and when it last did. */
function SiteRow(props: {
  readonly grant: BrowserSiteGrant;
  readonly hostClient: HostClient;
  readonly onRemoved: (message: string) => void;
}): ReactNode {
  const { grant, hostClient } = props;
  const domain = browserSiteLabel(grant.site);
  const removeSpec = {
    label: `remove ${domain}`,
    done: "removed",
    happened: `${domain} was removed`,
  } as const;
  const removal = useScreenAction<void, void>(hostClient, `chrome-site-remove:${grant.site}`, {
    ...removeSpec,
    execute: async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-site-remove:${grant.site}`),
        site: grant.site,
        type: "browser.site.remove",
      });
      props.onRemoved(`${domain} removed. Your agent asks before using it again.`);
    },
    reconcile: async () =>
      (await readSources(hostClient)).sites.some(({ site }) => site === grant.site)
        ? notDone(removeSpec.done)
        : { kind: "confirmed", value: undefined },
    retry: () => void removal.run(),
  });
  return (
    <View style={styles.siteRow}>
      <Symbol name="globe" size={17} tint={color.textSoft} />
      <View style={styles.rowText}>
        <AppText role="body" selectable>
          {domain}
        </AppText>
        <AppText role="caption" tone="muted">
          {grant.lastSignedInAt === null
            ? "Not used yet"
            : `Last signed in ${formatRelativeTime(grant.lastSignedInAt)}`}
        </AppText>
        {removal.line === null ? null : (
          <ActionLine line={removal.line} onDismiss={removal.dismiss} />
        )}
      </View>
      <SecondaryButton
        accessibilityLabel={`Remove ${domain}`}
        busy={removal.running}
        compact
        label="Remove"
        onPress={() => void removal.run()}
        tone="danger"
      />
    </View>
  );
}

const selectUserId = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

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
