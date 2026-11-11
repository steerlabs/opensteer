import { requestAsker, type HostClient, type RequestAsker } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { Request } from "@opensteer/core";
import { useCallback, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space, touchTarget, type } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { AgentEngine, AskerMark, threadEngine } from "./agent-mark.js";

/** The subagent that asked a Request, or null when the Run's own agent did. */
export function useRequestAsker(hostClient: HostClient, request: Request): RequestAsker | null {
  return useHostSelector(
    hostClient,
    useCallback((snapshot) => requestAsker(snapshot, request), [request]),
    sameAsker,
  );
}

function sameAsker(left: RequestAsker | null, right: RequestAsker | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.nodeId === right.nodeId &&
      left.title === right.title &&
      left.byline === right.byline)
  );
}

/**
 * Who asked, for a question a subagent asked: its mark and name, and the
 * subagent it runs inside when it is nested. It opens the asker, whose own
 * view holds the same question. `trailing` stands at its end: where this
 * question sits among the others waiting.
 */
export function AskerByline(props: {
  readonly asker: RequestAsker;
  readonly hostClient: HostClient;
  readonly onOpen: () => void;
  readonly trailing?: ReactNode;
}): ReactNode {
  const { asker } = props;
  const engine = useHostSelector(
    props.hostClient,
    useCallback((snapshot) => threadEngine(snapshot, asker.threadId), [asker.threadId]),
  );
  return (
    <View style={styles.by}>
      <Pressable
        accessibilityHint="Opens the subagent that asked"
        accessibilityLabel={`Asked by subagent ${asker.title}, ${asker.byline}. Open it`}
        accessibilityRole="link"
        onPress={props.onOpen}
        style={({ pressed }) => [styles.who, pressed && styles.pressed]}
      >
        <AgentEngine value={engine}>
          <AskerMark />
        </AgentEngine>
        <AppText numberOfLines={1} role="caption" style={styles.words} tone="muted">
          <AppText role="caption" style={styles.title} tone="soft">
            {asker.title}
          </AppText>
          {` · ${asker.byline}`}
        </AppText>
      </Pressable>
      {props.trailing ?? null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Its 44 points of touch reach past the line it sits on, without moving that line.
  by: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    marginVertical: (type.caption.lineHeight - touchTarget) / 2,
  },
  pressed: { opacity: 0.6 },
  title: { fontWeight: "600" },
  who: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    minWidth: 0,
  },
  words: { color: color.muted, flexShrink: 1 },
});
