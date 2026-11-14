import { useTeamPartnerSettings } from "@opensteer/client/react";
import {
  partnerActionError,
  partnerInviteStatus,
  partnerLinkDetail,
  partnerLinkStatus,
  sharingPolicyOptions,
  type TeamSessionClient,
} from "@opensteer/client/team";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space, touchTarget } from "../theme.js";
import { useCopy } from "../ui/copy-mark.js";
import {
  AppText,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
} from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { GroupNote } from "./settings-rows.js";
import { useTeamSession } from "./team-context.js";

export function TeamPartnerSettingsScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { session, failure } = useTeamSession(props.route.params.teamId);
  if (!session)
    return (
      <Screen>
        <View style={styles.page}>
          {failure ? (
            <Notice title="This team didn’t answer" detail={failure} />
          ) : (
            <ActivityIndicator color={color.muted} />
          )}
        </View>
      </Screen>
    );
  return <PartnerSettings session={session} />;
}

function PartnerSettings({ session }: { readonly session: TeamSessionClient }): ReactNode {
  const focused = useIsFocused();
  const { model, state, links, invites } = useTeamPartnerSettings(session, focused);
  const insets = useSafeAreaInsets();
  const { copied, copy } = useCopy();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (focused && next === "active") void model.refresh();
    });
    return () => subscription.remove();
  }, [focused, model]);
  const error = (key: string) =>
    state.errors[key] ? (
      <AppText role="caption" tone="danger">
        {state.errors[key]}
      </AppText>
    ) : null;
  const policy = state.policy;
  const created = state.created;
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + space[24] }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => void model.refresh()}
            refreshing={state.refreshing}
            tintColor={color.muted}
          />
        }
      >
        <AppText role="secondary" tone="muted">
          Connect another team, then choose which channels to share with it.
        </AppText>
        {state.error ? (
          <Notice
            action={{ label: "Try again", onPress: () => void model.refresh() }}
            detail={state.error}
            title="Partner teams didn’t load"
          />
        ) : null}
        {policy && policy.canPropose === undefined ? (
          <GroupNote>Update this team’s Opensteer server to manage partner teams.</GroupNote>
        ) : null}
        <View style={styles.group}>
          <SectionLabel>Sharing policy</SectionLabel>
          {policy ? (
            <RowGroup>
              {sharingPolicyOptions
                .filter((option) => policy.canSet || option.value === policy.policy)
                .map((option) => (
                  <Pressable
                    accessibilityLabel={`${option.label}. ${option.detail}`}
                    accessibilityRole={policy.canSet ? "radio" : "text"}
                    accessibilityState={{
                      checked: policy.policy === option.value,
                      disabled: !policy.canSet || state.pending.has("policy"),
                    }}
                    disabled={!policy.canSet || state.pending.has("policy")}
                    key={option.value}
                    onPress={() => {
                      if (policy.policy !== option.value)
                        void model.command("policy", {
                          type: "team.sharing.policy.set",
                          policy: option.value,
                        });
                    }}
                    style={styles.row}
                  >
                    <AppText
                      role="body"
                      tone={policy.policy === option.value ? "ember" : "default"}
                    >
                      {option.label}
                      {policy.policy === option.value && policy.canSet ? " ✓" : ""}
                    </AppText>
                    <AppText role="caption" tone="muted">
                      {option.detail}
                    </AppText>
                  </Pressable>
                ))}
            </RowGroup>
          ) : (
            <ActivityIndicator color={color.muted} />
          )}
          {error("policy")}
        </View>
        <View style={styles.group}>
          <SectionLabel>Linked teams</SectionLabel>
          {links.first === null && !links.error ? <ActivityIndicator color={color.muted} /> : null}
          {links.first !== null && links.items.length === 0 ? (
            <GroupNote>No partner teams yet.</GroupNote>
          ) : null}
          <RowGroup>
            {links.items.map((link) => (
              <View key={link.id} style={styles.row}>
                <AppText role="body">{link.partnerName}</AppText>
                <AppText role="caption" selectable tone="muted">
                  {link.partnerOrigin}
                </AppText>
                <AppText role="secondary">{partnerLinkStatus(link)}</AppText>
                <AppText role="caption" tone="muted">
                  {link.lastSeenAt
                    ? `Last seen ${new Date(link.lastSeenAt).toLocaleString()}`
                    : "Not seen yet"}
                </AppText>
                {partnerLinkDetail(link) ? (
                  <AppText role="caption" tone="muted">
                    {partnerLinkDetail(link)}
                  </AppText>
                ) : null}
                <View style={styles.actions}>
                  {link.canApprove ? (
                    <PrimaryButton
                      busy={state.pending.has(link.id)}
                      compact
                      label="Approve"
                      onPress={() =>
                        void model.command(link.id, {
                          type: "team.partner.approve",
                          linkId: link.id,
                        })
                      }
                    />
                  ) : null}
                  {link.canRevoke ? (
                    <SecondaryButton
                      compact
                      disabled={state.pending.has(link.id)}
                      label="Disconnect"
                      onPress={() =>
                        Alert.alert(
                          `Disconnect ${link.partnerName}?`,
                          "Channels shared with this team stop syncing. Their history stays on both teams.",
                          [
                            { style: "cancel", text: "Cancel" },
                            {
                              style: "destructive",
                              text: "Disconnect",
                              onPress: () =>
                                void model.command(link.id, {
                                  type: "team.partner.revoke",
                                  linkId: link.id,
                                }),
                            },
                          ],
                        )
                      }
                      tone="danger"
                    />
                  ) : null}
                </View>
                {error(link.id)}
              </View>
            ))}
          </RowGroup>
          {links.error ? (
            <Notice
              action={{ label: "Try again", onPress: () => void model.refresh() }}
              detail={partnerActionError(links.error)}
              title="Partner teams didn’t load"
            />
          ) : null}
          {links.nextCursor ? (
            <SecondaryButton
              busy={links.loadingMore}
              label="Show more teams"
              onPress={() => void model.links.more()}
            />
          ) : null}
        </View>
        <View style={styles.group}>
          <SectionLabel>Invite a team</SectionLabel>
          <GroupNote>
            Send the link to an admin of the other team. Each invite works once. Keep a copy if
            you’ll need it later.
          </GroupNote>
          {policy?.canPropose ? (
            <PrimaryButton
              busy={state.pending.has("create")}
              label="Create invite"
              onPress={() => void model.createInvite()}
            />
          ) : (
            <GroupNote>
              {policy?.policy === "off"
                ? "Sharing is turned off."
                : "Ask an admin to invite a partner team."}
            </GroupNote>
          )}
          {error("create")}
          <RowGroup>
            {[
              created ? (
                <View key={created.invite.id} style={styles.row}>
                  <AppText numberOfLines={2} role="secondary" selectable>
                    {created.offer}
                  </AppText>
                  <AppText role="caption" tone="muted">
                    {partnerInviteStatus(created.invite)} · Expires{" "}
                    {new Date(created.invite.expiresAt).toLocaleString()}
                  </AppText>
                  <View style={styles.actions}>
                    <SecondaryButton
                      compact
                      label={copied ? "Copied" : "Copy"}
                      onPress={() => void copy(created.offer)}
                    />
                    <SecondaryButton
                      compact
                      label="Share"
                      onPress={() => {
                        if (session.signal.aborted) return;
                        void Share.share({ message: created.offer }).catch(() => {
                          if (!session.signal.aborted)
                            Alert.alert("Sharing didn’t open", "Copy the link instead.");
                        });
                      }}
                    />
                    {created.invite.canRevoke ? (
                      <SecondaryButton
                        busy={state.pending.has(created.invite.id)}
                        compact
                        label="Revoke"
                        onPress={() =>
                          void model.command(created.invite.id, {
                            type: "team.partner.invite.revoke",
                            inviteId: created.invite.id,
                          })
                        }
                        tone="danger"
                      />
                    ) : null}
                  </View>
                  {error(created.invite.id)}
                </View>
              ) : null,
              ...invites.items
                .filter((invite) => invite.id !== created?.invite.id)
                .map((invite) => (
                  <View key={invite.id} style={styles.row}>
                    <AppText role="body">{partnerInviteStatus(invite)}</AppText>
                    <AppText role="caption" tone="muted">
                      Created {new Date(invite.createdAt).toLocaleString()} · Expires{" "}
                      {new Date(invite.expiresAt).toLocaleString()}
                    </AppText>
                    {invite.canRevoke ? (
                      <SecondaryButton
                        busy={state.pending.has(invite.id)}
                        compact
                        label="Revoke"
                        onPress={() =>
                          void model.command(invite.id, {
                            type: "team.partner.invite.revoke",
                            inviteId: invite.id,
                          })
                        }
                        tone="danger"
                      />
                    ) : null}
                    {error(invite.id)}
                  </View>
                )),
            ]}
          </RowGroup>
          {invites.error ? (
            <Notice
              action={{ label: "Try again", onPress: () => void model.refresh() }}
              detail={partnerActionError(invites.error)}
              title="Invites didn’t load"
            />
          ) : null}
          {invites.nextCursor ? (
            <SecondaryButton
              busy={invites.loadingMore}
              label="Show more invites"
              onPress={() => void model.invites.more()}
            />
          ) : null}
        </View>
        {policy?.canPropose ? (
          <View style={styles.group}>
            <SectionLabel>Use an invite</SectionLabel>
            <Field
              input={{
                autoCapitalize: "none",
                autoCorrect: false,
                editable: !state.pending.has("redeem"),
                maxLength: 4096,
                onChangeText: model.setOfferText,
                placeholder: "Paste the other team’s invite",
                value: state.offerText,
              }}
              label="Partner invite link"
            />
            <SecondaryButton
              busy={state.pending.has("preview")}
              disabled={!state.offerText.trim() || state.pending.has("redeem")}
              label="Check invite"
              onPress={() => void model.previewInvite()}
            />
            {error("preview")}
            {state.preview ? (
              <View style={styles.group}>
                <AppText role="body">{`Connect to ${state.preview.name}?`}</AppText>
                <AppText role="secondary" selectable tone="muted">
                  {state.preview.origin}
                </AppText>
                <AppText role="caption" tone="muted">
                  Expires {new Date(state.preview.expiresAt).toLocaleString()}. Only channels you
                  share with this team will sync.
                </AppText>
                <PrimaryButton
                  busy={state.pending.has("redeem")}
                  label="Connect team"
                  onPress={() => void model.redeemInvite()}
                />
                <SecondaryButton
                  disabled={state.pending.has("redeem")}
                  label="Cancel"
                  onPress={() => model.setOfferText("")}
                />
              </View>
            ) : null}
            {error("redeem")}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  group: { gap: space[8] },
  page: { alignSelf: "center", gap: space[24], maxWidth: 640, padding: space[16], width: "100%" },
  row: {
    gap: space[6],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
});
