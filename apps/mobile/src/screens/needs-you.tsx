import { presentClientIssue } from "@opensteer/client/feedback";
import { useHostSelector } from "@opensteer/client/react";
import {
  needsYouEntryKey,
  phoneSentence,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { space } from "../theme.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { ExternalAgentMark } from "./external-agent-mark.js";
import { needsYouOperation } from "../thread/agent-session-model.js";

const selectThreads = (snapshot: HostSnapshot) => snapshot.threads;

export function NeedsYouScreen(props: StaticScreenProps<{ readonly deploymentId: string }>) {
  const { deploymentId } = props.route.params;
  const client = useAttachedHost(deploymentId);
  if (!client) return <DeploymentGate deploymentId={deploymentId} />;
  return <NeedsYouList client={client} deploymentId={deploymentId} />;
}

const earlierFailed = presentClientIssue({ code: "read-failed", resource: "earlier requests" });

/**
 * Everything waiting on the person, each opened in the task it waits in.
 */
function NeedsYouList({ client, deploymentId }: { client: HostClient; deploymentId: string }) {
  const page = useHostSelector(client, (snapshot) => snapshot.needsYou);
  const summaries = useHostSelector(client, (snapshot) => snapshot.attentionSummaries);
  const count = useHostSelector(client, (snapshot) => snapshot.needsYouCount);
  const ready = useHostSelector(client, (snapshot) => snapshot.connection === "connected");
  useEffect(() => {
    if (ready && count && page == null) void client.loadEarlierNeedsYou().catch(() => undefined);
  }, [client, count, page, ready, summaries]);
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
        {page == null && count === undefined ? <PlaceholderRows /> : null}
        {count === 0 || page?.entries.length === 0 ? (
          <AppText tone="muted">Nothing needs you.</AppText>
        ) : null}
        {page == null &&
          summaries?.map((entry) => (
            <View key={entry.id} style={{ gap: space[8], padding: space[16] }}>
              <AppText>{entry.title}</AppText>
              {entry.preview ? <AppText tone="muted">{entry.preview}</AppText> : null}
            </View>
          ))}
        {page?.entries.map((entry) => (
          <NeedsYouRow
            key={needsYouEntryKey(entry)}
            client={client}
            deploymentId={deploymentId}
            entry={entry}
          />
        ))}
        {earlier ? <ActionLine line={earlier} /> : null}
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

function NeedsYouRow(props: {
  readonly client: HostClient;
  readonly deploymentId: string;
  readonly entry: NeedsYouEntry;
}): ReactNode {
  const { client, deploymentId, entry } = props;
  const navigation = useNavigation();
  // A connected agent's direct operation: named by its agent and the Home's question.
  const threads = useHostSelector(client, selectThreads);
  const operation = needsYouOperation(
    { threads },
    { request: entry.request, threadId: entry.navigationThreadId },
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        navigation.navigate("Thread", {
          deploymentId,
          requestId: entry.request.id,
          threadId: entry.navigationThreadId,
        })
      }
      style={{ gap: space[8], padding: space[16] }}
    >
      {operation === null ? (
        <AppText>{entry.title}</AppText>
      ) : (
        <View style={{ alignItems: "center", flexDirection: "row", gap: space[8] }}>
          <ExternalAgentMark
            initial={operation.agent.initial}
            providerId={operation.agent.providerId}
            size={20}
          />
          <AppText style={{ flex: 1 }}>{phoneSentence(operation.listTitleParts)}</AppText>
        </View>
      )}
    </Pressable>
  );
}
