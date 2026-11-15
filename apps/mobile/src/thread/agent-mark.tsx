import { agentDot, type AgentCard, type HostSnapshot } from "@opensteer/client/host";
import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";
import { StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { EngineMark } from "./settings/engine-mark.js";

/** The engine the conversation runs on, whose mark every subagent in it wears. */
export const AgentEngine = createContext<string | null>(null);

/** The engine a conversation runs on, by the account its Thread is placed on. */
export function threadEngine(
  snapshot: Pick<HostSnapshot, "harnesses" | "threads">,
  threadId: string,
): string | null {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  return snapshot.harnesses.find(({ id }) => id === thread?.harnessInstanceId)?.driverKind ?? null;
}
/** The ground under a mark, which its status dot is cut out of. */
export const AgentGround = createContext<string>(color.background);

/* ---- The mark: the engine's glyph, quiet like every trace icon, with one status dot ---- */

export function AgentMark(props: { readonly card: AgentCard }): ReactNode {
  const { card } = props;
  const engine = useContext(AgentEngine);
  return (
    <View style={styles.mark}>
      {card.task ? (
        <TaskMark mark={card.task.mark} size={16} />
      ) : card.workflow ? (
        <Symbol name="list.bullet" size={13} tint={color.mutedDim} />
      ) : (
        <EngineGlyph engine={engine} working={card.moving} />
      )}
      <MarkDot card={card} />
    </View>
  );
}

/** The conversation engine's mark with the amber dot, for a subagent known only by name. */
export function AskerMark(): ReactNode {
  const engine = useContext(AgentEngine);
  return (
    <View style={styles.mark}>
      <EngineGlyph engine={engine} working={false} />
      <Dot>
        <StatusDot size={6} tone="amber" />
      </Dot>
    </View>
  );
}

function EngineGlyph(props: { readonly engine: string | null; readonly working: boolean }) {
  const tint = props.working ? color.emberDim : color.mutedDim;
  return props.engine === null ? (
    <Symbol name="sparkles" size={13} tint={tint} />
  ) : (
    <EngineMark driverKind={props.engine} tint={tint} />
  );
}

function MarkDot(props: { readonly card: AgentCard }): ReactNode {
  const dot = agentDot(props.card);
  switch (dot) {
    case null:
      return null;
    case "working":
      return (
        <Dot>
          <StatusDot live={props.card.moving} size={6} tone="ember" />
        </Dot>
      );
    case "needs":
      return (
        <Dot>
          <StatusDot size={6} tone="amber" />
        </Dot>
      );
    case "waiting":
      return (
        <Dot>
          <StatusDot ring size={6} tone="muted" />
        </Dot>
      );
    case "failed":
      return (
        <Dot>
          <StatusDot size={6} tone="red" />
        </Dot>
      );
    case "stopped":
      return (
        <Dot>
          <View style={styles.square} />
        </Dot>
      );
    case "last-known":
      return (
        <Dot>
          <StatusDot opacity={0.7} ring size={6} tone="ember" />
        </Dot>
      );
  }
}

/** The dot sits on the mark's corner, cut out of the ground around it. */
function Dot(props: { readonly children: ReactNode }): ReactNode {
  const ground = useContext(AgentGround);
  return <View style={[styles.dot, { backgroundColor: ground }]}>{props.children}</View>;
}

const styles = StyleSheet.create({
  dot: {
    alignItems: "center",
    borderRadius: radius.full,
    bottom: -3,
    height: 10,
    justifyContent: "center",
    position: "absolute",
    right: -4,
    width: 10,
  },
  mark: { alignItems: "center", height: 18, justifyContent: "center", width: 18 },
  square: { backgroundColor: color.muted, borderRadius: 1.5, height: 5, width: 5 },
});
