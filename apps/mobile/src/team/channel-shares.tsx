import { useTeamChannelShares } from "@opensteer/client/react";
import {
  channelShareStatus,
  shareHistoryWarning,
  shareOfferUnavailable,
  type ChannelShare,
  type TeamSessionClient,
} from "@opensteer/client/team";
import type { TeamChannelSummary } from "@opensteer/protocol";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState, type ReactNode } from "react";
import { Alert, StyleSheet, View } from "react-native";
import type { RootParamList } from "../navigation.js";
import { space } from "../theme.js";
import { AppText, Field, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { GroupNote } from "./settings-rows.js";

export function ChannelShares({
  session,
  channel,
}: {
  readonly session: TeamSessionClient;
  readonly channel?: TeamChannelSummary;
}): ReactNode {
  const focused = useIsFocused();
  const { model, state } = useTeamChannelShares(session, channel?.id, focused);
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const [offering, setOffering] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<ChannelShare | null>(null);
  const teamId = session.scope.teamDeploymentId;
  const blocked = channel
    ? shareOfferUnavailable(channel, session.getSnapshot().bootstrap?.generalChannelId)
    : null;
  const partner = state.links.find((link) => link.id === partnerId);
  const shares = state.shares.filter((share) => channel || share.state === "offered");
  const error = (key: string) =>
    state.errors[key] ? (
      <AppText role="caption" tone="danger">
        {state.errors[key]}
      </AppText>
    ) : null;
  return (
    <View style={styles.group}>
      <SectionLabel>{channel ? "Partner team" : "Channel share offers"}</SectionLabel>
      {state.error ? (
        <AppText role="secondary" tone="danger">
          {state.error}
        </AppText>
      ) : null}
      <SecondaryButton
        compact
        busy={state.loading}
        label="Refresh offers"
        onPress={() => void model.refresh()}
      />
      {state.loaded && shares.length === 0 && !state.nextCursor && !channel ? (
        <GroupNote>No pending channel shares.</GroupNote>
      ) : null}
      {shares.map((share) => (
        <View key={share.id} style={styles.group}>
          <AppText role="body">
            #{share.name} · {share.partnerName}
          </AppText>
          <AppText role="caption" tone="muted">
            {channelShareStatus(share)}
          </AppText>
          {share.canApprove === undefined && share.state !== "ended" ? (
            <GroupNote>Update this team's Opensteer server to manage channel shares.</GroupNote>
          ) : null}
          <View style={styles.actions}>
            {share.canApprove ? (
              <PrimaryButton
                compact
                busy={state.pending.has(share.id)}
                label="Approve share"
                onPress={() =>
                  void model.command(share.id, { type: "team.share.approve", shareId: share.id })
                }
              />
            ) : null}
            {share.canAccept ? (
              <PrimaryButton
                compact
                disabled={state.pending.has(share.id)}
                label="Review share"
                onPress={() => setAccepting(share)}
              />
            ) : null}
            {share.canEnd ? (
              <SecondaryButton
                compact
                disabled={state.pending.has(share.id)}
                tone="danger"
                label={
                  share.state === "offered"
                    ? share.role === "follower"
                      ? "Decline"
                      : "Cancel offer"
                    : "Disconnect channel"
                }
                onPress={() =>
                  Alert.alert(
                    `${share.state === "offered" ? "End offer from" : "Disconnect from"} ${share.partnerName}?`,
                    share.role === "follower"
                      ? "Your copy becomes a read-only archive. You can still read its history."
                      : "Your channel continues with your team. The other team keeps its received history.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Confirm",
                        style: "destructive",
                        onPress: () =>
                          void model.command(share.id, {
                            type: "team.share.end",
                            shareId: share.id,
                          }),
                      },
                    ],
                  )
                }
              />
            ) : null}
          </View>
          {error(share.id)}
        </View>
      ))}
      {state.nextCursor ? (
        <SecondaryButton
          compact
          busy={state.loadingMore}
          disabled={state.loading}
          label="Show more shares"
          onPress={() => void model.more()}
        />
      ) : null}
      {state.loaded &&
      channel?.can.manage &&
      !blocked &&
      !shares.some((share) => share.state !== "ended") ? (
        <SecondaryButton
          label="Share with a partner team"
          onPress={() => {
            setOffering(true);
            void model.loadPartners();
          }}
        />
      ) : null}
      {channel?.can.manage && blocked ? <GroupNote>{blocked}</GroupNote> : null}
      {offering && channel ? (
        <Sheet
          open
          title={`Share #${channel.name}`}
          onClose={() => setOffering(false)}
          footer={
            <View style={styles.form}>
              <PrimaryButton
                busy={state.pending.has("offer")}
                disabled={!partner || state.policy?.canPropose !== true}
                label="Share channel"
                onPress={() => {
                  if (partner)
                    void model
                      .command("offer", {
                        type: "team.share.offer",
                        channelId: channel.id,
                        linkId: partner.id,
                        historyVisibleConfirmed: true,
                      })
                      .then((done) => {
                        if (done) setOffering(false);
                      });
                }}
              />
            </View>
          }
        >
          <View style={styles.form}>
            <SectionLabel>Choose a partner team</SectionLabel>
            {state.links.map((link) => (
              <SecondaryButton
                key={link.id}
                label={`${partnerId === link.id ? "✓ " : ""}${link.partnerName}`}
                onPress={() => setPartnerId(link.id)}
              />
            ))}
            {state.policy && state.links.length === 0 ? (
              <SecondaryButton
                label="Open Partner teams settings"
                onPress={() => {
                  setOffering(false);
                  navigation.navigate("TeamPartners", { teamId });
                }}
              />
            ) : null}
            {state.policy && !state.policy.canPropose ? (
              <GroupNote>Sharing is turned off or requires an admin.</GroupNote>
            ) : null}
            {partner ? (
              <AppText role="secondary">
                {shareHistoryWarning(channel.name, partner.partnerName)}
              </AppText>
            ) : null}
            {state.error ? <AppText tone="danger">{state.error}</AppText> : null}
            {error("offer")}
          </View>
        </Sheet>
      ) : null}
      {accepting ? (
        <AcceptShare
          share={accepting}
          busy={state.pending.has(accepting.id)}
          error={state.errors[accepting.id] ?? null}
          onClose={() => setAccepting(null)}
          onAccept={(name, kind) => {
            void model.accept(accepting, name, kind).then((id) => {
              if (id) {
                setAccepting(null);
                navigation.navigate("TeamChannel", { teamId, channelId: id });
              }
            });
          }}
        />
      ) : null}
    </View>
  );
}

function AcceptShare({
  share,
  busy,
  error,
  onClose,
  onAccept,
}: {
  readonly share: ChannelShare;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onAccept: (name: string, kind: "public" | "private") => void;
}): ReactNode {
  const [name, setName] = useState(share.name);
  const [kind, setKind] = useState<"public" | "private">("private");
  return (
    <Sheet
      open
      title={`Accept from ${share.partnerName}?`}
      onClose={onClose}
      footer={
        <View style={styles.form}>
          <PrimaryButton
            label="Accept share"
            busy={busy}
            disabled={!name.trim()}
            onPress={() => onAccept(name, kind)}
          />
        </View>
      }
    >
      <View style={styles.form}>
        <AppText role="secondary">
          Both teams see this channel's history, members' names and photos. Each team manages its
          own people.
        </AppText>
        {share.historyFromShareId ? (
          <AppText role="secondary">
            This creates a new channel. Your previous archive stays separate.
          </AppText>
        ) : null}
        <Field
          label="Channel name on your team"
          input={{ value: name, onChangeText: setName, maxLength: 160, autoCapitalize: "none" }}
        />
        <SecondaryButton
          label={`${kind === "private" ? "✓ " : ""}Private · only you to start`}
          onPress={() => setKind("private")}
        />
        <SecondaryButton
          label={`${kind === "public" ? "✓ " : ""}Public · anyone on your team can join`}
          onPress={() => setKind("public")}
        />
        {error ? (
          <AppText role="secondary" tone="danger">
            {error}
          </AppText>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { gap: space[8] },
  form: { gap: space[16], padding: space[16] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
});
