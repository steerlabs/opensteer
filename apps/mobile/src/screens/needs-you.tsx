import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouTeamAskEntry } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView } from "react-native";
import { TeamAskReview } from "../team/team-ask-review.js";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { space } from "../theme.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export function NeedsYouScreen(props: StaticScreenProps<{ readonly deploymentId: string }>) {
  const { deploymentId } = props.route.params;
  const client = useAttachedHost(deploymentId);
  if (!client) return <DeploymentGate deploymentId={deploymentId} />;
  return <NeedsYouList client={client} deploymentId={deploymentId} />;
}

function NeedsYouList({ client, deploymentId }: { client: HostClient; deploymentId: string }) {
  const page = useHostSelector(client, (snapshot) => snapshot.needsYou);
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loadMore = async () => {
    setLoading(true);
    setFailure(null);
    try {
      await client.loadEarlierNeedsYou();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not load earlier requests.");
    } finally {
      setLoading(false);
    }
  };
  const [review, setReview] = useState<NeedsYouTeamAskEntry | null>(null);
  const current =
    review &&
    page?.entries.find(
      (entry) => entry.kind === "team-ask" && needsYouEntryKey(entry) === needsYouEntryKey(review),
    );
  return (
    <Screen>
      {current?.kind === "team-ask" ? (
        <TeamAskReview entry={current} client={client} onClose={() => setReview(null)} />
      ) : null}
      <ScrollView contentContainerStyle={{ padding: space[16], gap: space[16] }}>
        {page?.entries.length === 0 ? <AppText tone="muted">Nothing needs you.</AppText> : null}
        {page?.entries.map((entry) => (
          <Pressable
            accessibilityRole="button"
            key={
              entry.kind === "team-ask" ? `${entry.teamId}:${entry.requestId}` : entry.request.id
            }
            onPress={() => {
              if (entry.kind === "team-ask") setReview(entry);
              else
                navigation.navigate("Thread", {
                  deploymentId,
                  threadId: entry.navigationThreadId,
                  requestId: entry.request.id,
                });
            }}
            style={{ padding: space[16], gap: space[8] }}
          >
            <AppText>
              {entry.kind === "team-ask"
                ? `${entry.presentation.asker.displayName}${entry.presentation.asker.actor === "agent" ? "'s agent" : ""}`
                : entry.title}
            </AppText>
            {entry.kind === "team-ask" ? (
              <AppText tone="muted">{entry.presentation.bodyMarkdown}</AppText>
            ) : null}
          </Pressable>
        ))}
        {failure ? <AppText tone="danger">{failure}</AppText> : null}
        {page?.window.hasMore ? (
          <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={() => void loadMore()}
            style={{ padding: space[16] }}
          >
            <AppText>{loading ? "Loading…" : "Earlier requests"}</AppText>
          </Pressable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
