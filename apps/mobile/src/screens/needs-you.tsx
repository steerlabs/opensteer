import { presentActionFailure } from "@opensteer/client/feedback";
import { teamAskerLabel } from "@opensteer/client/team";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry, NeedsYouTeamAskEntry } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { space, touchTarget } from "../theme.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export function NeedsYouScreen(props: StaticScreenProps<{ readonly deploymentId: string }>) {
  const { deploymentId } = props.route.params;
  const client = useAttachedHost(deploymentId);
  if (!client) return <DeploymentGate deploymentId={deploymentId} />;
  return <NeedsYouList client={client} deploymentId={deploymentId} />;
}

/**
 * Everything waiting on the person. A teammate's ask is answered in the task
 * it waits in, where its words can be read and edited first. A failed ask
 * says why and can be dismissed, which declines it, and still opens any task
 * it left behind; one that never became a task can only be dismissed.
 */
function NeedsYouList({ client, deploymentId }: { client: HostClient; deploymentId: string }) {
  const page = useHostSelector(client, (snapshot) => snapshot.needsYou);
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
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
  const dismiss = async (entry: NeedsYouTeamAskEntry) => {
    const key = needsYouEntryKey(entry);
    setDismissing(key);
    setFailure(null);
    try {
      await client.decideTeamAsk({
        decision: "decline",
        requestId: entry.requestId,
        teamId: entry.teamId,
      });
    } catch (error) {
      setFailure(presentActionFailure(error, "That ask could not be dismissed."));
    } finally {
      setDismissing(null);
    }
  };
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space[16], gap: space[16] }}>
        {page?.entries.length === 0 ? <AppText tone="muted">Nothing needs you.</AppText> : null}
        {page?.entries.map((entry) => {
          const key = needsYouEntryKey(entry);
          const destination = entryDestination(entry);
          const ask = entry.kind === "team-ask" ? entry : null;
          const label = (
            <>
              <AppText>
                {entry.kind === "team-ask" ? teamAskerLabel(entry.presentation.asker) : entry.title}
              </AppText>
              {ask ? (
                <AppText numberOfLines={3} tone="muted">
                  {plainTextExcerpt(ask.presentation.bodyMarkdown, 280) ?? ""}
                </AppText>
              ) : null}
            </>
          );
          return (
            <View key={key} style={{ gap: space[8] }}>
              {destination === null ? (
                <View style={{ gap: space[8], padding: space[16] }}>{label}</View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => navigation.navigate("Thread", { deploymentId, ...destination })}
                  style={{ gap: space[8], padding: space[16] }}
                >
                  {label}
                </Pressable>
              )}
              {ask?.failureReason === undefined ? null : (
                <AppText style={{ paddingHorizontal: space[16] }} tone="danger">
                  {ask.failureReason}
                </AppText>
              )}
              {ask !== null && (ask.failureReason !== undefined || destination === null) ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: dismissing === key }}
                  disabled={dismissing !== null}
                  onPress={() => void dismiss(ask)}
                  style={{
                    alignSelf: "flex-start",
                    justifyContent: "center",
                    minHeight: touchTarget,
                    paddingHorizontal: space[16],
                  }}
                >
                  <AppText role="secondaryMedium" tone="ember">
                    Dismiss
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          );
        })}
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

/** The task an entry opens at, or null for an ask whose task is gone. */
function entryDestination(
  entry: NeedsYouEntry,
): { readonly threadId: string; readonly requestId?: string } | null {
  if (entry.kind === "request")
    return { requestId: entry.request.id, threadId: entry.navigationThreadId };
  return entry.task ? { threadId: entry.task.threadId } : null;
}
