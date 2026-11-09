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
import { CHAT_THREAD_TITLE } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { taskHeading } from "../thread/task-status.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { AgentMarks } from "./agent-marks.js";
import { statusPillHeight, statusRowHeight } from "./place-foot.js";

/**
 * What a place says of the conversation it was opened from, under the page:
 * that conversation's mark and live line with Stop, or that it needs the
 * person with Answer, which goes back to it. Stop is the composer's own, a
 * single press with the same target; it stands on the row's far side, clear of
 * the bar under it, and its touch never reaches past its own pill toward the bar.
 */
export const PlaceStatusRow = memo(function PlaceStatusRow(props: {
  /** The conversation's mark; null while this reader cannot name it. */
  readonly agent: PlaceAgent | null;
  readonly canRespond: boolean;
  readonly onAnswer: () => void;
  readonly onStop: () => Promise<void>;
  /** What Stop ends here, as the composer says it. */
  readonly stops: StopWords;
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
  const words = needsYou
    ? "Needs you"
    : pressed?.failed === true
      ? "Couldn’t stop. Try again."
      : watch.words;
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
          tone={pressed?.failed === true ? "danger" : "soft"}
        >
          {words}
        </AppText>
      </View>
      {needsYou ? (
        <Pressable
          accessibilityHint="Returns to the conversation, where you answer it"
          accessibilityLabel="Answer"
          accessibilityRole="button"
          hitSlop={pillSlop}
          onPress={props.onAnswer}
          style={({ pressed: down }) => [styles.pill, styles.answer, down && styles.answerDown]}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.answerText}
          >
            Answer
          </AppText>
        </Pressable>
      ) : (
        <Pressable
          accessibilityLabel={props.stops.label}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy || !props.canRespond }}
          disabled={busy || !props.canRespond}
          hitSlop={pillSlop}
          onPress={onStop}
          style={({ pressed: down }) => [down && styles.down]}
        >
          <GlassSurface
            interactive
            shape="capsule"
            style={[styles.pill, !props.canRespond && styles.unavailable]}
          >
            {busy ? (
              <ActivityIndicator color={color.muted} size="small" />
            ) : (
              <View style={styles.square} />
            )}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="secondaryMedium"
            >
              {props.stops.word}
            </AppText>
          </GlassSurface>
        </Pressable>
      )}
    </View>
  );
});

export interface StopWords {
  readonly label: string;
  /** The label's verb, all the pill has room for. */
  readonly word: string;
}

/**
 * The composer's Stop, in its words: in a conversation it ends only the reply
 * under way; an open task it leaves paused; anything else, its run.
 */
export function stopWords(stops: "reply" | "task" | "run"): StopWords {
  return stops === "reply"
    ? { label: "Stop the reply", word: "Stop" }
    : stops === "task"
      ? { label: "Pause this task", word: "Pause" }
      : { label: "Stop this run", word: "Stop" };
}

/** A pill's touch reaches its sides and up into the row's air, never down toward the bar. */
const pillSlop = { bottom: 0, left: space[6], right: space[6], top: space[4] };

const styles = StyleSheet.create({
  answer: { ...material.accent, paddingHorizontal: space[16] },
  answerDown: { ...material.accentPressed },
  answerText: { color: color.inkOnEmber },
  down: { opacity: 0.7 },
  needsYou: { color: color.amber },
  pill: {
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    height: statusPillHeight,
    justifyContent: "center",
    paddingEnd: space[14],
    paddingStart: space[12],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    height: statusRowHeight,
    paddingHorizontal: space[12],
  },
  said: { alignItems: "center", flex: 1, flexDirection: "row", gap: space[8], minWidth: 0 },
  // The composer's Stop, drawn small: its red square.
  square: { backgroundColor: color.red, borderRadius: 2, height: 10, width: 10 },
  unavailable: { opacity: 0.4 },
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
    (snapshot: HostSnapshot): StopWords => {
      const thread = snapshot.threads.find(({ id }) => id === threadId);
      if (thread === undefined || thread.role === "conversation") return stopWords("reply");
      return stopWords(
        threadId !== null && taskHeading(snapshot, threadId)?.open === true ? "task" : "run",
      );
    },
    [threadId],
  );
  const stops = useHostSelector(hostClient, selectStops, sameStopWords);
  const canRespond = useHostSelector(hostClient, canRespondToRequests);
  const selectAgent = useCallback(
    (snapshot: HostSnapshot): PlaceAgent | null => {
      const here = agents.agents.find((agent) => agent.threadId === threadId);
      if (here !== undefined || threadId === null) return here ?? null;
      // Away from this place, it still wears its own mark, never acting here.
      const home = threadId === snapshot.homeThreadId;
      const title = snapshot.threads.find(({ id }) => id === threadId)?.title.trim() ?? "";
      return {
        acting: false,
        home,
        lastActiveAt: "",
        mark: home ? null : threadMark(threadId, snapshot),
        threadId,
        title: title || (home ? CHAT_THREAD_TITLE : "Task"),
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
          stops={stops}
          watch={watch}
        />
      ),
    [agent, answer, canRespond, stop, stops, watch],
  );
}

const noEntries: readonly TranscriptEntry[] = [];

function sameStopWords(left: StopWords, right: StopWords): boolean {
  return left.label === right.label;
}

function samePlaceAgent(left: PlaceAgent | null, right: PlaceAgent | null): boolean {
  return samePlaceAgents(
    { agents: left === null ? [] : [left], unnamedActing: false },
    { agents: right === null ? [] : [right], unnamedActing: false },
  );
}
