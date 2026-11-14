import { teamAskAudienceLabel } from "@opensteer/client/team";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { NeedsYouTeamAskEntry } from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import { Sheet } from "../ui/sheet.js";
import { AppText } from "../ui/primitives.js";
import { space } from "../theme.js";

export function TeamAskReview({
  entry,
  client,
  onClose,
}: {
  entry: NeedsYouTeamAskEntry;
  client: HostClient;
  onClose: () => void;
}) {
  const navigation = useNavigation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { presentation: ask } = entry;
  const name = ask.asker.displayName + (ask.asker.actor === "agent" ? "'s agent" : "");
  const decide = async (decision: "approve" | "decline") => {
    setPending(true);
    setError(null);
    try {
      await client.dispatch({
        type: "teams.ask.decide",
        teamId: entry.teamId,
        requestId: entry.requestId,
        decision,
      });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send your decision.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title={name}
      onClose={onClose}
      footer={
        <View style={{ padding: space[16], gap: space[16] }}>
          {error ? (
            <View accessibilityRole="alert">
              <AppText tone="danger">{error}</AppText>
            </View>
          ) : null}
          {(entry.failureReason ? (["decline"] as const) : (["approve", "decline"] as const)).map(
            (decision) => (
              <Pressable
                key={decision}
                accessibilityRole="button"
                accessibilityState={{ disabled: pending, busy: pending }}
                disabled={pending}
                onPress={() => void decide(decision)}
                style={{ padding: space[16] }}
              >
                <AppText>
                  {entry.failureReason ? "Dismiss" : decision === "approve" ? "Approve" : "Decline"}
                </AppText>
              </Pressable>
            ),
          )}
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ padding: space[16], gap: space[16] }}>
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            onClose();
            navigation.navigate("TeamThread", {
              teamId: entry.teamId,
              channelId: ask.destination.channelId,
              rootId: ask.destination.threadRootId,
            });
          }}
        >
          <AppText tone="muted">
            {ask.audience.teamName} · #{ask.audience.channelName} ↗
          </AppText>
        </Pressable>
        <AppText role="caption" tone="muted">
          {teamAskAudienceLabel(ask.audience)}
        </AppText>
        <AppText selectable>{ask.bodyMarkdown}</AppText>
        {ask.attachments.map((file) => (
          <AppText key={file.id}>
            {file.filename} · {file.sizeBytes.toLocaleString()} bytes
          </AppText>
        ))}
        {entry.failureReason ? (
          <View accessibilityRole="alert">
            <AppText tone="danger">{entry.failureReason}</AppText>
          </View>
        ) : (
          <>
            <AppText role="caption" tone="muted">
              Expires {new Date(entry.consentExpiresAt).toLocaleString()}
            </AppText>
            <AppText>
              Approving lets your agent use your things and post its answer in #
              {ask.audience.channelName}.
            </AppText>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
