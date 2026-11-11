import {
  canRespondToRequests,
  samePlaceAgents,
  threadMark,
  threadWatch,
  type HostClient,
  type HostSnapshot,
  type PlaceAgent,
  type PlaceAgents,
  type ThreadWatch,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space } from "../theme.js";
import { AnswerPill } from "../thread/answer-pill.js";
import { taskHeading } from "../thread/task-status.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { AgentMarks } from "./agent-marks.js";

/**
 * What a place says of the conversation it was opened from, under the page:
 * that conversation's mark and live line with the composer's own Stop, or
 * that it needs the person with the Request's own Answer, which goes back to
 * that conversation to answer it there. Each control is the bar's 44 points
 * on the row's far side, and the row is no taller than they are.
 */
export const PlaceStatusRow = memo(function PlaceStatusRow(props: {
  /** The conversation's mark; null while this reader cannot name it. */
  readonly agent: PlaceAgent | null;
  readonly canRespond: boolean;
  readonly onAnswer: () => void;
  readonly onStop: () => Promise<void>;
  /** What Stop ends here, as the composer says it. */
  readonly stopLabel: string;
  readonly watch: ThreadWatch;
}): ReactNode {
  const { watch } = props;
  const [stop, setStop] = useState<{ readonly runId: string; readonly failed: boolean } | null>(
    null,
  );
  const runId = watch.kind === "working" ? watch.runId : null;
  // A Stop belongs to the Run it was pressed for.
  const pressed = stop !== null && stop.runId === runId ? stop : null;
  const busy =
    (pressed !== null && !pressed.failed) || (watch.kind === "working" && watch.stopping);
  const onStop = () => {
    if (runId === null || busy || !props.canRespond) return;
    setStop({ failed: false, runId });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    props
      .onStop()
      .then(() => setStop((current) => (current?.runId === runId ? null : current)))
      .catch(() =>
        setStop((current) => (current?.runId === runId ? { failed: true, runId } : current)),
      );
  };
  const needsYou = watch.kind === "needs-you";
  const failed = pressed?.failed === true;
  const words = needsYou ? "Needs you" : failed ? "Couldn’t stop" : watch.words;
  const who = props.agent?.title ?? null;
  return (
    <View style={styles.row} testID="place-status">
      <View
        accessibilityLabel={who === null ? words : `${who}: ${words}`}
        accessibilityLiveRegion="polite"
        accessible
        style={styles.said}
      >
        {props.agent === null ? null : <AgentMarks agents={[props.agent]} size={16} />}
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role={needsYou ? "secondaryMedium" : "secondary"}
          style={[styles.words, needsYou && styles.needsYou]}
          tone={failed ? "danger" : "soft"}
        >
          {words}
        </AppText>
      </View>
      {needsYou ? (
        <AnswerPill
          accessibilityHint="Returns to the conversation, where you answer it"
          label="Answer"
          onPress={props.onAnswer}
          tone="primary"
        />
      ) : (
        <ComposerAction
          busy={busy}
          disabled={!props.canRespond}
          kind="stop"
          label={props.stopLabel}
          onPress={onStop}
        />
      )}
    </View>
  );
});

/**
 * The composer's Stop, in its words: in a conversation it ends only the reply
 * under way; an open task it leaves paused; anything else, its run.
 */
export function stopLabel(stops: "reply" | "task" | "run"): string {
  return stops === "reply"
    ? "Stop the reply"
    : stops === "task"
      ? "Pause this task"
      : "Stop this run";
}

const styles = StyleSheet.create({
  needsYou: { color: color.amber },
  // The bar's own inset, so the row's control stands over the bar's last one.
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    flex: 1,
    paddingHorizontal: space[12],
  },
  said: { alignItems: "center", flex: 1, flexDirection: "row", gap: space[8], minWidth: 0 },
  words: { flexShrink: 1 },
});

/** The two watches say the same thing: the row need not draw again. */
function sameWatch(left: ThreadWatch | null, right: ThreadWatch | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "needs-you" || right.kind === "needs-you") return left.kind === right.kind;
  return (
    left.runId === right.runId && left.stopping === right.stopping && left.words === right.words
  );
}

/**
 * The status row for the conversation a place was opened from, or null while
 * that conversation has nothing to say: it speaks for that conversation alone,
 * never for whichever agent ranks first in the place. A place opened from
 * Tabs, with no conversation, has none; nor does one whose conversation is
 * already on screen beside it.
 */
export function usePlaceStatusRow(props: {
  /** The place's agents, whose mark the conversation wears while it is one of them. */
  readonly agents: PlaceAgents;
  readonly hostClient: HostClient;
  readonly onAnswer: (threadId: string) => void;
  /** The conversation the route carries, unless it is already on screen. */
  readonly threadId: string | null;
}): ReactNode {
  const { agents, hostClient, onAnswer, threadId } = props;
  const selectWatch = useCallback(
    (snapshot: HostSnapshot): ThreadWatch | null => {
      const thread =
        threadId === null ? undefined : snapshot.threads.find(({ id }) => id === threadId);
      return thread === undefined
        ? null
        : threadWatch({
            entries: snapshot.transcripts[thread.id] ?? noEntries,
            runQueue: snapshot.runQueue,
            thread,
            waitingRequests: snapshot.waitingRequests,
          });
    },
    [threadId],
  );
  const watch = useHostSelector(hostClient, selectWatch, sameWatch);
  const selectStops = useCallback(
    (snapshot: HostSnapshot): string => {
      const thread = snapshot.threads.find(({ id }) => id === threadId);
      if (thread === undefined) return stopLabel("reply");
      return stopLabel(
        threadId !== null && taskHeading(snapshot, threadId)?.open === true ? "task" : "run",
      );
    },
    [threadId],
  );
  const stops = useHostSelector(hostClient, selectStops);
  const canRespond = useHostSelector(hostClient, canRespondToRequests);
  const selectAgent = useCallback(
    (snapshot: HostSnapshot): PlaceAgent | null => {
      const here = agents.agents.find((agent) => agent.threadId === threadId);
      if (here !== undefined || threadId === null) return here ?? null;
      // Away from this place, it still wears its own mark, never acting here.
      const title = snapshot.threads.find(({ id }) => id === threadId)?.title.trim() ?? "";
      return {
        acting: false,
        lastActiveAt: "",
        mark: threadMark(threadId, snapshot),
        threadId,
        title: title || "Task",
      };
    },
    [agents, threadId],
  );
  const agent = useHostSelector(hostClient, selectAgent, samePlaceAgent);
  const stop = useCallback(async () => {
    if (threadId !== null) await hostClient.stopRun(threadId);
  }, [hostClient, threadId]);
  const answer = useCallback(() => {
    if (threadId !== null) onAnswer(threadId);
  }, [onAnswer, threadId]);
  return useMemo(
    () =>
      watch === null ? null : (
        <PlaceStatusRow
          agent={agent}
          canRespond={canRespond}
          onAnswer={answer}
          onStop={stop}
          stopLabel={stops}
          watch={watch}
        />
      ),
    [agent, answer, canRespond, stop, stops, watch],
  );
}

const noEntries: readonly TranscriptEntry[] = [];

function samePlaceAgent(left: PlaceAgent | null, right: PlaceAgent | null): boolean {
  return samePlaceAgents(
    { agents: left === null ? [] : [left], unnamedActing: false },
    { agents: right === null ? [] : [right], unnamedActing: false },
  );
}
