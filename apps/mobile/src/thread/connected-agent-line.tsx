import {
  connectedAgentNamePart,
  phoneSentence,
  workSentence,
  workWords,
  type HostClient,
  type SessionAgent,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ExternalAgentMark } from "../screens/external-agent-mark.js";
import { color, space, touchTarget } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { AppText } from "../ui/primitives.js";
import { useAgentSessionStop } from "./agent-session-hooks.js";

export function ConnectedAgentLine({
  agent,
  host,
  threadId,
  sessionId,
  title,
  detail,
  needsYou,
  onOpen,
}: {
  readonly agent: SessionAgent;
  readonly host: HostClient;
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly detail?: string | null;
  readonly needsYou?: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const stop = useAgentSessionStop(host, threadId);
  const stopLabel = phoneSentence(
    workSentence("work.stop", { agent: connectedAgentNamePart(agent) }),
  );
  return (
    <View style={styles.group}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.open}>
          <ExternalAgentMark initial={agent.initial} providerId={agent.providerId} size={20} />
          <View style={styles.words}>
            <AppText role="secondaryMedium">{title}</AppText>
            {detail ? (
              <AppText role="caption" style={needsYou ? styles.attention : undefined} tone="muted">
                {detail}
              </AppText>
            ) : null}
          </View>
        </Pressable>
        {sessionId === null ? null : (
          <Pressable
            accessibilityLabel={stopLabel}
            accessibilityRole="button"
            accessibilityState={{ busy: stop.running, disabled: stop.running }}
            disabled={stop.running}
            onPress={() => void stop.run(sessionId)}
            style={styles.stop}
          >
            <AppText role="action" tone="ember">
              {workWords("tab.stop")}
            </AppText>
          </Pressable>
        )}
      </View>
      {stop.line ? <ActionLine line={stop.line} onDismiss={stop.dismiss} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { paddingHorizontal: space[12] },
  row: { alignItems: "center", flexDirection: "row", gap: space[8] },
  open: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingVertical: space[4],
  },
  words: { flex: 1 },
  stop: { minHeight: touchTarget, justifyContent: "center", paddingHorizontal: space[8] },
  attention: { color: color.amber },
});
