import { MenuView } from "@expo/ui/community/menu";
import { noteSubagentStop, type AgentCard, type HostClient } from "@opensteer/client/host";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import { ActionReviewSheet } from "../ui/action-review.js";
import { Symbol } from "../ui/symbol.js";
import { color, material, radius, touchTarget } from "../theme.js";
import { AnswerPill } from "./answer-pill.js";
import type { ActionLineValue } from "../ui/action-line.js";
import { subagentStopTarget, useReviewedStop, useStopLine } from "./reviewed-stop.js";

/** What this subagent's last Stop came to, for its row or its screen to say. */
export function useSubagentStopLine(
  hostClient: HostClient | null | undefined,
  card: AgentCard,
): ActionLineValue | null {
  return useStopLine(
    hostClient ?? null,
    card.stop ? subagentStopTarget(card) : null,
    card.stopping || !card.stop,
  );
}

/**
 * Stopping one subagent, after asking: a long press on its row (`children`),
 * the round button of Running now (`look: "icon"`), or the labelled one in
 * its opened view (`look: "button"`). While the Host stops it, the button
 * says so instead; nothing is offered where its engine can't stop it. How
 * the Stop went is said where the subagent is shown: `useSubagentStopLine`.
 */
export function SubagentStop(props: {
  readonly card: AgentCard;
  readonly hostClient: HostClient;
  readonly children?: (onStop: () => void) => ReactNode;
  readonly look?: "icon" | "button";
}) {
  const { card, hostClient, children } = props;
  const noun = card.kind === "workflow" ? "workflow" : "subagent";
  const { review, request, dismiss, confirm } = useReviewedStop(
    hostClient,
    subagentStopTarget(card),
    card.stop ? { kind: "stop-node", ...card.stop } : null,
    () => {
      if (card.nodeId !== null) noteSubagentStop(card.nodeId);
    },
  );
  if (children === undefined && card.stopping)
    return props.look === "button" ? (
      <AnswerPill busy label="Stopping…" onPress={() => undefined} tone="secondary" />
    ) : (
      <View
        accessibilityLabel={`Stopping ${card.title}`}
        accessibilityRole="progressbar"
        accessible
        style={styles.hit}
      >
        <ActivityIndicator color={color.muted} size="small" />
      </View>
    );
  if (!card.stop) return children === undefined ? null : children(request);
  return (
    <>
      {children !== undefined ? (
        <MenuView
          colorScheme="dark"
          actions={[
            {
              id: "stop",
              image: "stop",
              title: `Stop ${noun}`,
              attributes: { destructive: true },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "stop") request();
          }}
          shouldOpenOnLongPress
        >
          {children(request)}
        </MenuView>
      ) : props.look === "button" ? (
        <AnswerPill
          accessibilityLabel={`Stop ${card.title}`}
          icon={<Symbol name="stop.fill" size={10} tint={color.textSoft} />}
          label="Stop"
          onPress={request}
          tone="secondary"
        />
      ) : (
        <Pressable
          accessibilityLabel={`Stop ${card.title}`}
          accessibilityRole="button"
          onPress={request}
          style={styles.hit}
        >
          {({ pressed }) => (
            <View style={[styles.disc, pressed && styles.pressed]}>
              <Symbol name="stop.fill" size={11} tint={color.textSoft} />
            </View>
          )}
        </Pressable>
      )}
      <ActionReviewSheet
        review={review}
        title={`Stop ${card.title}?`}
        detail="Nothing it already did is undone."
        confirmLabel={`Stop ${noun}`}
        cancelLabel="Keep working"
        onClose={dismiss}
        onConfirm={confirm}
      />
    </>
  );
}

const styles = StyleSheet.create({
  disc: {
    ...material.quiet,
    alignItems: "center",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  hit: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  pressed: { backgroundColor: material.selected.backgroundColor },
});
