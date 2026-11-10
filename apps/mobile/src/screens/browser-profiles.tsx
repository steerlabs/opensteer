import {
  browserProfileAccessSummary,
  browserProfileDeleteConsequence,
  browserProfileDeletionRows,
  browserProfileSettingsRows,
  browserProfileProjects,
  canRespondToRequests,
  mutationIdempotencyKey,
  profileHomeChoice,
  type BrowserProfileSettingsRow,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { HomeMenu } from "./profile-home-menu.js";
import { color, material, space, touchTarget } from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import { computerSymbols } from "./settings-model.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Field, Notice, RowGroup, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";

export type BrowserProfilesDestination = { readonly deploymentId: string };

export function BrowserProfilesScreen({
  route,
}: StaticScreenProps<BrowserProfilesDestination>): ReactNode {
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
              : `Open ${row.name} to manage its browser profiles.`}
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
  return (
    <SignedInBrowserProfiles
      key={deploymentId}
      hostClient={hostClient}
      deploymentId={deploymentId}
    />
  );
}

/** Keyed by who is signed in, so a changed account never sees the last one's browser profiles. */
function SignedInBrowserProfiles(props: {
  readonly hostClient: HostClient;
  readonly deploymentId: string;
}): ReactNode {
  const userId = useHostSelector(props.hostClient, selectUserId);
  if (userId === null) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            Sign in to this deployment to manage its browser profiles.
          </AppText>
        </View>
      </Screen>
    );
  }
  return <BrowserProfilesSettings key={userId} {...props} />;
}

function BrowserProfilesSettings({
  hostClient,
  deploymentId,
}: {
  readonly hostClient: HostClient;
  readonly deploymentId: string;
}): ReactNode {
  const navigation = useNavigation();
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  const online = canRespondToRequests(snapshot);
  const hereId = useHereDeviceId(deploymentId);
  const rows = browserProfileSettingsRows(snapshot, hereId);
  const homes = profileHomeChoice(snapshot, hereId);
  const deletions = browserProfileDeletionRows(snapshot);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const [draft, setDraft] = useState<string | null>(null);
  const [chosenHome, setHome] = useState<string | null>(null);
  // The person's pick stands while it is still on offer; the default follows the list.
  const home = homes
    ? (homes.options.find(({ id }) => id === chosenHome)?.id ?? homes.initial)
    : null;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const create = () => {
    const name = draft?.trim() ?? "";
    if (!online || busy || name === "") return;
    setBusy(true);
    setFailure(null);
    void hostClient
      .dispatch({
        type: "browser.profile.create",
        idempotencyKey: mutationIdempotencyKey("browser-profile"),
        input: { name, ...(home ? { homeRunnerId: home } : {}) },
      })
      .then(() => setDraft(null))
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "The profile could not be created.")),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {online ? null : (
          <Notice
            title="Not connected"
            detail="Reconnect to manage browser profiles."
            tone="neutral"
          />
        )}
        {rows.length === 0 && deletions.length === 0 ? (
          <AppText role="secondary" tone="muted">
            No profiles yet.
          </AppText>
        ) : (
          <RowGroup>
            {rows.map((row) => (
              <ProfileRow
                key={row.profile.id}
                row={row}
                snapshot={snapshot}
                hostClient={hostClient}
                online={online}
                onHistory={() =>
                  navigation.navigate("BrowserHistory", { deploymentId, profileId: row.profile.id })
                }
              />
            ))}
          </RowGroup>
        )}
        {deletions.map((deletion) => (
          <Notice
            key={deletion.profileId}
            title="Deleted profile"
            detail={deletion.status}
            tone="neutral"
          />
        ))}
        {draft === null ? (
          <SecondaryButton
            label="New profile"
            disabled={!online}
            onPress={() => {
              setDraft("");
              setFailure(null);
            }}
          />
        ) : (
          <>
            <Field
              label="Name"
              input={{
                autoFocus: true,
                maxLength: 120,
                value: draft,
                onChangeText: setDraft,
                onSubmitEditing: create,
                returnKeyType: "done",
              }}
              {...(homes && home
                ? {
                    trailing: (
                      <HomeMenu disabled={busy} home={home} homes={homes} onChoose={setHome} />
                    ),
                  }
                : {})}
            />
            <View style={styles.actions}>
              <SecondaryButton
                label="Create profile"
                busy={busy}
                disabled={!online || draft.trim() === ""}
                onPress={create}
              />
              <SecondaryButton label="Cancel" disabled={busy} onPress={() => setDraft(null)} />
            </View>
          </>
        )}
        {failure === null ? null : (
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        )}
        <AppText role="caption" tone="muted">
          Opensteer can use every profile. A project can only use the profiles you choose for it.
        </AppText>
      </ScrollView>
    </Screen>
  );
}

/**
 * Where a profile lives, said only when that is not this phone. At the
 * accessibility text sizes it stands under the name, as a system list's value
 * does, rather than squeeze it.
 */
function ProfileHome({
  row,
  stacked,
}: {
  readonly row: BrowserProfileSettingsRow;
  readonly stacked: boolean;
}): ReactNode {
  if (row.device)
    return (
      <View style={[styles.home, stacked && styles.homeStacked]}>
        <Symbol name={computerSymbols[row.device.glyph]} size={13} tint={color.muted} />
        <AppText numberOfLines={1} role="caption" style={styles.homeName} tone="muted">
          {row.device.name}
        </AppText>
        {row.device.online ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            · Offline
          </AppText>
        )}
      </View>
    );
  if (row.unopened)
    return (
      <AppText numberOfLines={1} role="caption" style={!stacked && styles.home} tone="muted">
        Not opened yet
      </AppText>
    );
  return null;
}

function ProfileRow({
  row,
  snapshot,
  hostClient,
  online,
  onHistory,
}: {
  readonly row: BrowserProfileSettingsRow;
  readonly snapshot: HostSnapshot;
  readonly hostClient: HostClient;
  readonly online: boolean;
  readonly onHistory: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const stacked = useWindowDimensions().fontScale > accessibilityTextScale;
  const [projectsShown, setProjectsShown] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const projects = browserProfileProjects(snapshot);
  const mutate = (command: Parameters<HostClient["dispatch"]>[0], done?: () => void) => {
    if (!online || busy) return;
    setBusy(true);
    setFailure(null);
    void hostClient
      .dispatch(command)
      .then(() => done?.())
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "The profile could not be changed.")),
      )
      .finally(() => setBusy(false));
  };
  const rename = () => {
    const name = draft?.trim() ?? "";
    if (!snapshot.browserProfileManageAvailable || name === "") return;
    mutate(
      {
        type: "browser.profile.rename",
        profileId: row.profile.id,
        name,
        idempotencyKey: mutationIdempotencyKey(`browser-profile-rename:${row.profile.id}`),
      },
      () => setDraft(null),
    );
  };
  const remove = () =>
    Alert.alert(`Delete “${row.profile.name}”?`, browserProfileDeleteConsequence(row), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete profile",
        style: "destructive",
        onPress: () => {
          if (!snapshot.browserProfileManageAvailable) return;
          mutate({
            type: "browser.profile.delete",
            profileId: row.profile.id,
            idempotencyKey: mutationIdempotencyKey(`browser-profile-delete:${row.profile.id}`),
          });
        },
      },
    ]);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          row.profile.name,
          row.device
            ? `on ${row.device.name}${row.device.online ? "" : ", offline"}`
            : row.unopened
              ? "not opened yet"
              : null,
          browserProfileAccessSummary(row),
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.rowHead}
      >
        {row.identity.kind === "profile" ? (
          <View style={[styles.identity, material.mark, { backgroundColor: row.identity.tint }]}>
            <AppText maxFontSizeMultiplier={1} role="bodyMedium">
              {row.identity.initial}
            </AppText>
          </View>
        ) : null}
        <View style={styles.rowText}>
          <AppText role="bodyMedium">{row.profile.name}</AppText>
          <AppText role="caption" tone="muted">
            {browserProfileAccessSummary(row)}
          </AppText>
          {stacked ? <ProfileHome row={row} stacked /> : null}
        </View>
        {stacked ? null : <ProfileHome row={row} stacked={false} />}
      </Pressable>
      {!expanded ? null : (
        <>
          <View style={styles.actions}>
            <SecondaryButton
              label="Browsing history"
              accessibilityLabel={`Browsing history for ${row.profile.name}`}
              compact
              onPress={onHistory}
            />
            {snapshot.browserProfileManageAvailable ? (
              <>
                <SecondaryButton
                  label="Rename"
                  accessibilityLabel={`Rename ${row.profile.name}`}
                  compact
                  disabled={!online || busy}
                  onPress={() => {
                    setDraft(row.profile.name);
                    setFailure(null);
                  }}
                />
                <SecondaryButton
                  label="Delete"
                  accessibilityLabel={`Delete ${row.profile.name}`}
                  compact
                  disabled={!online || busy}
                  tone="danger"
                  onPress={remove}
                />
              </>
            ) : null}
            <SecondaryButton
              label="Projects"
              compact
              onPress={() => setProjectsShown(!projectsShown)}
            />
          </View>
          {draft === null || !snapshot.browserProfileManageAvailable ? null : (
            <>
              <Field
                label="Name"
                input={{
                  autoFocus: true,
                  maxLength: 120,
                  value: draft,
                  onChangeText: setDraft,
                  onSubmitEditing: rename,
                  returnKeyType: "done",
                }}
              />
              <View style={styles.actions}>
                <SecondaryButton
                  label="Save"
                  busy={busy}
                  compact
                  disabled={!online || draft.trim() === ""}
                  onPress={rename}
                />
                <SecondaryButton
                  label="Cancel"
                  compact
                  disabled={busy}
                  onPress={() => setDraft(null)}
                />
              </View>
            </>
          )}
          {!projectsShown ? null : projects.length === 0 ? (
            <AppText role="secondary" tone="muted">
              No projects yet.
            </AppText>
          ) : (
            projects.map((workspace) => {
              const grant = row.projects.find((entry) => entry.workspace.id === workspace.id);
              return (
                <SwitchRow
                  key={workspace.id}
                  label={workspace.name}
                  value={grant !== undefined}
                  disabled={!online || busy}
                  onChange={(allowed) => {
                    if (allowed)
                      mutate({
                        type: "browser.profile.grant",
                        profileId: row.profile.id,
                        workspaceId: workspace.id,
                        idempotencyKey: mutationIdempotencyKey(
                          `browser-profile-grant:${row.profile.id}:${workspace.id}`,
                        ),
                      });
                    else if (grant)
                      mutate({
                        type: "browser.profileGrant.revoke",
                        grantId: grant.grantId,
                        idempotencyKey: mutationIdempotencyKey(
                          `browser-profile-revoke:${grant.grantId}`,
                        ),
                      });
                  }}
                />
              );
            })
          )}
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

/** Past the largest standard size, iOS's accessibility sizes begin. */
const accessibilityTextScale = 1.35;
const selectSnapshot = (snapshot: HostSnapshot) => snapshot;
const selectUserId = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;
const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  away: { gap: space[12], paddingTop: space[24] },
  content: { gap: space[24], paddingTop: space[12] },
  row: { gap: space[10], paddingHorizontal: space[16], paddingVertical: space[12] },
  rowHead: { alignItems: "center", flexDirection: "row", gap: space[10], minHeight: touchTarget },
  rowText: { flex: 1, gap: space[2] },
  disabled: { opacity: 0.5 },
  home: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space[4],
    maxWidth: "55%",
  },
  homeStacked: { maxWidth: "100%" },
  homeName: { color: color.muted, flexShrink: 1 },
  identity: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
