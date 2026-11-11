import {
  agentCardLabel,
  runningNow,
  sameRunningNow,
  SubagentCache,
  type HostClient,
  type HostSnapshot,
  type RunningNow,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { memo, useMemo, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { color, controlFontScaleLimit, pillHeight, space, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { enter, exit } from "../ui/motion.js";
import { AppText, monoFontFamily } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { heldSelector } from "./agent-select.js";
import { AgentGround, AgentMark } from "./agent-mark.js";
import { AgentPhrases, Elapsed } from "./subagent-rows.js";
import { SubagentStop } from "./subagent-stop.js";
import { trace } from "./trace-styles.js";

/**
 * What runs in one conversation now, read once per change through one cache,
 * so a row that did not change is the same object as before. Out of reach of
 * the conversation's computer, everything is what was last known.
 */
export function useRunningNow(
  hostClient: HostClient,
  threadId: string,
  reachable: boolean,
): RunningNow | null {
  const select = useMemo(() => {
    const cache = new SubagentCache();
    return heldSelector((snapshot: HostSnapshot) =>
      runningNow(reachable ? snapshot : { ...snapshot, connection: "offline" }, threadId, cache),
    );
  }, [reachable, threadId]);
  return useHostSelector(hostClient, select, sameRunningNow);
}

/** Below this height the keyboard leaves the conversation too little room for the capsule too. */
const shortWindow = 560;

/**
 * Running now, as a capsule leading the composer dock while anything runs:
 * how many, and whether one needs the reader. It opens the list in a sheet,
 * and leaves when the last one settles. It stands in the dock, so the
 * transcript's clearance and the jump button make room for it.
 */
export const RunningNowCapsule = memo(function RunningNowCapsule(props: {
  readonly hostClient: HostClient;
  readonly onOpen: () => void;
  readonly reachable: boolean;
  readonly threadId: string;
}): ReactNode {
  const model = useRunningNow(props.hostClient, props.threadId, props.reachable);
  const keyboard = useKeyboardVisible();
  const { height } = useWindowDimensions();
  if (model === null || (keyboard && height < shortWindow)) return null;
  return (
    <Animated.View entering={enter} exiting={exit} style={styles.place}>
      <Pressable
        accessibilityLabel={`${model.name}. Show the list`}
        accessibilityRole="button"
        onPress={() => {
          Keyboard.dismiss();
          props.onOpen();
        }}
        style={({ pressed }) => [styles.target, pressed && styles.pressed]}
      >
        <GlassSurface interactive shape="capsule" style={styles.capsule} tint={color.floatTint}>
          <View style={trace.icon}>
            {model.lead === null ? (
              <Symbol name="terminal" size={13} tint={color.mutedDim} />
            ) : (
              <AgentGround value={color.surfaceElevated}>
                <AgentMark card={model.lead} />
              </AgentGround>
            )}
          </View>
          <View style={styles.words}>
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="caption">
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                role="caption"
                style={styles.count}
                tone="soft"
              >
                {model.count}
              </AppText>
              {model.detail.length === 0 ? null : " "}
              <AgentPhrasesInline model={model} />
            </AppText>
          </View>
          <Symbol name="chevron.up" size={11} tint={color.mutedDim} />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
});

function AgentPhrasesInline(props: { readonly model: RunningNow }): ReactNode {
  return props.model.detail.map((phrase, index) => (
    <AppText
      key={index}
      maxFontSizeMultiplier={controlFontScaleLimit}
      role="caption"
      style={phrase.tone === "attention" ? styles.attention : undefined}
      tone="muted"
    >
      {index > 0 ? " · " : ""}
      {phrase.text}
    </AppText>
  ));
}

/**
 * One row of the open list: the subagent or task with its live line and
 * time, opening it; Stop beside it where its engine allows one. A nested one
 * hangs under the one that started it and says which.
 */
export const RunningRowView = memo(function RunningRowView(props: {
  readonly hostClient: HostClient;
  readonly onOpen: () => void;
  readonly row: RunningNow["rows"][number];
}): ReactNode {
  const { card, depth, within } = props.row;
  return (
    <View style={[styles.row, { paddingLeft: depth * space[16] }]}>
      <Pressable
        accessibilityLabel={agentCardLabel(card, Date.now())}
        accessibilityRole="button"
        onPress={props.onOpen}
        style={({ pressed }) => [styles.open, pressed && trace.pressed]}
      >
        <View style={[trace.icon, styles.iconTop]}>
          <AgentMark card={card} />
        </View>
        <View style={trace.stepText}>
          <AppText numberOfLines={1} role="secondaryMedium" tone="soft">
            {card.title}
            {within === null ? null : (
              <AppText role="caption" tone="muted">{`  in ${within}`}</AppText>
            )}
          </AppText>
          <AgentPhrases phrases={card.detail} />
        </View>
        <Elapsed endedAt={card.endedAt} startedAt={card.startedAt} />
      </Pressable>
      <View style={styles.stop}>
        <SubagentStop card={card} hostClient={props.hostClient} look="icon" />
      </View>
    </View>
  );
});

/** A command the agent left running: named as a command, never as a subagent. */
export function RunningCommandView(props: {
  readonly command: RunningNow["commands"][number];
}): ReactNode {
  return (
    <View
      accessibilityLabel={`Command ${props.command.command}, running in the background`}
      accessible
      style={styles.row}
    >
      <View style={styles.open}>
        <View style={[trace.icon, styles.iconTop]}>
          <Symbol name="terminal" size={13} tint={color.mutedDim} />
        </View>
        <View style={trace.stepText}>
          <AppText numberOfLines={1} role="secondaryMedium" tone="soft">
            Command{"  "}
            <AppText role="caption" style={styles.code} tone="muted">
              {props.command.command}
            </AppText>
          </AppText>
          <AppText numberOfLines={1} role="caption" tone="muted">
            Running in the background
          </AppText>
        </View>
        <Elapsed endedAt={null} startedAt={props.command.startedAt} />
      </View>
      <View style={styles.stop} />
    </View>
  );
}

const styles = StyleSheet.create({
  attention: { color: color.amber },
  capsule: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    maxWidth: "100%",
    minHeight: pillHeight,
    paddingLeft: space[8],
    paddingRight: space[12],
  },
  code: { fontFamily: monoFontFamily, fontSize: 12 },
  count: { fontWeight: "600" },
  iconTop: { alignSelf: "flex-start", paddingTop: space[2] },
  open: {
    alignItems: "center",
    borderRadius: 9,
    flex: 1,
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingVertical: space[8],
  },
  place: { alignSelf: "flex-start", maxWidth: "100%" },
  pressed: { opacity: 0.7 },
  row: {
    alignItems: "center",
    borderBottomColor: color.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[4],
  },
  stop: { alignItems: "center", justifyContent: "center", width: touchTarget },
  target: { justifyContent: "center", maxWidth: "100%", minHeight: touchTarget },
  words: { flexShrink: 1 },
});
