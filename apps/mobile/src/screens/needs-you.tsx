import { presentClientIssue } from "@opensteer/client/feedback";
import { teamAskerLabel } from "@opensteer/client/team";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry, NeedsYouTeamAskEntry } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { notDone, useScreenAction } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
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

const earlierFailed = presentClientIssue({ code: "read-failed", resource: "earlier requests" });

/**
 * Everything waiting on the person. A teammate's ask is answered in the task
 * it waits in, where its words can be read and edited first. A failed ask
 * says why and can be dismissed, which declines it, and still opens any task
 * it left behind; one that never became a task can only be dismissed.
 */
function NeedsYouList({ client, deploymentId }: { client: HostClient; deploymentId: string }) {
  const page = useHostSelector(client, (snapshot) => snapshot.needsYou);
  const [loading, setLoading] = useState(false);
  const [earlier, setEarlier] = useState<ActionLineValue | null>(null);
  const loadMore = async () => {
    setLoading(true);
    setEarlier(null);
    try {
      await client.loadEarlierNeedsYou();
    } catch {
      setEarlier({
        key: "earlier",
        text: earlierFailed.title,
        tone: "muted",
        link: { label: "Try again", onPress: () => void loadMore() },
      });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space[16], gap: space[16] }}>
        {page === null || page === undefined ? <PlaceholderRows /> : null}
        {page?.entries.length === 0 ? <AppText tone="muted">Nothing needs you.</AppText> : null}
        {page?.entries.map((entry) => (
          <NeedsYouRow
            client={client}
            deploymentId={deploymentId}
            entry={entry}
            key={needsYouEntryKey(entry)}
          />
        ))}
        {earlier === null ? null : <ActionLine line={earlier} />}
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

const dismissSpec = {
  label: "dismiss this ask",
  done: "dismissed",
  happened: "this ask was dismissed",
} as const;

function NeedsYouRow(props: {
  readonly client: HostClient;
  readonly deploymentId: string;
  readonly entry: NeedsYouEntry;
}): ReactNode {
  const { client, deploymentId, entry } = props;
  const navigation = useNavigation();
  const key = needsYouEntryKey(entry);
  const destination = entryDestination(entry);
  const ask = entry.kind === "team-ask" ? entry : null;
  const dismissal = useScreenAction<NeedsYouTeamAskEntry, void>(client, `needs-you:${key}`, {
    ...dismissSpec,
    execute: async (target) => {
      await client.decideTeamAsk({
        decision: "decline",
        requestId: target.requestId,
        teamId: target.teamId,
      });
    },
    // Needs-you is part of the Host's own state, reread on every reconnection.
    reconcile: async () =>
      client
        .getSnapshot()
        .needsYou?.entries.some((candidate) => needsYouEntryKey(candidate) === key)
        ? notDone(dismissSpec)
        : { kind: "confirmed", value: undefined },
    retry: () => {
      if (ask) void dismissal.run(ask);
    },
  });
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
    <View style={{ gap: space[8] }}>
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
        <View style={{ paddingHorizontal: space[16] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: dismissal.running }}
            disabled={dismissal.running}
            onPress={() => void dismissal.run(ask)}
            style={{ alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget }}
          >
            <AppText role="secondaryMedium" tone="ember">
              Dismiss
            </AppText>
          </Pressable>
          {dismissal.line === null ? null : (
            <ActionLine line={dismissal.line} numberOfLines={2} onDismiss={dismissal.dismiss} />
          )}
        </View>
      ) : null}
    </View>
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
