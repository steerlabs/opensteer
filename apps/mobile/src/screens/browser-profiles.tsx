import {
  browserProfileAccessSummary,
  browserProfileDeleteConsequence,
  browserProfileSettingsRows,
  browserProfileSpecialists,
  canRespondToRequests,
  mutationIdempotencyKey,
  type BrowserProfileSettingsRow,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { space, touchTarget } from "../theme.js";
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
  return <SignedInBrowserProfiles hostClient={hostClient} />;
}

/** Keyed by who is signed in, so a changed account never sees the last one's browser profiles. */
function SignedInBrowserProfiles(props: { readonly hostClient: HostClient }): ReactNode {
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

function BrowserProfilesSettings({ hostClient }: { readonly hostClient: HostClient }): ReactNode {
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  const online = canRespondToRequests(snapshot);
  const rows = browserProfileSettingsRows(snapshot);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const [draft, setDraft] = useState<string | null>(null);
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
        input: { name },
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
        {rows.length === 0 ? (
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
              />
            ))}
          </RowGroup>
        )}
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
          Opensteer can use every profile. A specialist can only use the profiles you choose for it.
        </AppText>
      </ScrollView>
    </Screen>
  );
}

function ProfileRow({
  row,
  snapshot,
  hostClient,
  online,
}: {
  readonly row: BrowserProfileSettingsRow;
  readonly snapshot: HostSnapshot;
  readonly hostClient: HostClient;
  readonly online: boolean;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [specialistsShown, setSpecialistsShown] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const specialists = browserProfileSpecialists(snapshot);
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
        accessibilityLabel={`${row.profile.name}, ${browserProfileAccessSummary(row)}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.rowHead}
      >
        {row.identity.kind === "profile" ? (
          <View style={[styles.identity, { backgroundColor: row.identity.tint }]}>
            <AppText role="bodyMedium">{row.identity.initial}</AppText>
          </View>
        ) : null}
        <View style={styles.rowText}>
          <AppText role="bodyMedium">{row.profile.name}</AppText>
          <AppText role="caption" tone="muted">
            {browserProfileAccessSummary(row)}
          </AppText>
        </View>
      </Pressable>
      {!expanded ? null : (
        <>
          <View style={styles.actions}>
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
              label="Specialists"
              compact
              onPress={() => setSpecialistsShown(!specialistsShown)}
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
          {!specialistsShown ? null : specialists.length === 0 ? (
            <AppText role="secondary" tone="muted">
              No specialists yet.
            </AppText>
          ) : (
            specialists.map((workspace) => {
              const grant = row.specialists.find((entry) => entry.workspace.id === workspace.id);
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
  identity: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
