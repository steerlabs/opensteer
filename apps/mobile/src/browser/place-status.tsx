import { useThreadTranscript } from "@opensteer/client/react";
import {
  canRespondToRequests,
  requestsWaitingOn,
  samePlaceAgents,
  threadMark,
  threadWatch,
  workWords,
  type HostClient,
  type HostSnapshot,
  type PlaceAgent,
  type PlaceAgents,
  type ThreadWatch,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { AnswerPill } from "../thread/answer-pill.js";
import { taskHeading } from "../thread/task-status.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { AgentMarks } from "./agent-marks.js";
import { ExternalAgentMark } from "../screens/external-agent-mark.js";
import { useAgentSessionStop } from "../thread/agent-session-hooks.js";
import { placeSessionLine, sessionTaskOf } from "../thread/agent-session-model.js";

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
  /** Other agents hold the place too: the row says which task it speaks for. */
  readonly named?: boolean;
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
  // Waiting on the person is still work under way: its Run keeps its Stop beside Answer.
  const runId = watch.runId;
  // A Stop belongs to the Run it was pressed for.
  const pressed = stop !== null && stop.runId === runId ? stop : null;
  const busy = (pressed !== null && !pressed.failed) || watch.stopping;
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
  const said = needsYou ? "Needs you" : failed ? "Couldn’t stop" : watch.words;
  const who = props.agent?.title ?? null;
  const words = props.named === true && who !== null ? `${who} · ${said}` : said;
  return (
    <View style={styles.row} testID="place-status">
      <View
        accessibilityLabel={who === null ? said : `${who}: ${said}`}
        accessibilityLiveRegion="polite"
        accessible
        style={styles.said}
      >
        {props.agent === null ? null : <AgentMarks agents={[props.agent]} size={16} />}
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          role={needsYou ? "secondaryMedium" : "secondary"}
          style={[styles.words, needsYou && styles.needsYou]}
          tone={failed ? "danger" : "soft"}
        >
          {words}
        </AppText>
      </View>
      {needsYou || runId !== null ? (
        <View style={styles.controls}>
          {needsYou ? (
            <AnswerPill
              accessibilityHint="Returns to the conversation, where you answer it"
              label="Answer"
              onPress={props.onAnswer}
              tone="primary"
            />
          ) : null}
          {runId === null ? null : (
            <ComposerAction
              busy={busy}
              disabled={!props.canRespond}
              kind="stop"
              label={props.stopLabel}
              onPress={onStop}
            />
          )}
        </View>
      ) : null}
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

/**
 * The least room the words keep beside the controls. Narrower than this, as when Answer joins
 * Stop on a small phone or at a large text size, the controls go under the words instead, so
 * who is using the tab and for what is never cut to fit them.
 */
const wordsBesideControls = 176;

const styles = StyleSheet.create({
  // At the row's end, on its own line once the words need that room.
  controls: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    marginLeft: "auto",
  },
  needsYou: { color: color.amber },
  // The bar's own inset, so the row's control stands over the bar's last one. It grows with
  // its words: the room it takes is measured, never assumed to be one line.
  row: {
    alignItems: "center",
    columnGap: space[8],
    flexDirection: "row",
    flexGrow: 1,
    flexWrap: "wrap",
    paddingHorizontal: space[12],
    paddingVertical: space[2],
    rowGap: space[2],
  },
  said: {
    alignItems: "center",
    flexBasis: wordsBesideControls,
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
    gap: space[8],
    minHeight: touchTarget,
    minWidth: 0,
  },
  words: { flexShrink: 1 },
});

/** The two watches say the same thing: the row need not draw again. */
function sameWatch(left: ThreadWatch | null, right: ThreadWatch | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.runId !== right.runId || left.stopping !== right.stopping) return false;
  return left.kind === "needs-you" || right.kind === "needs-you" || left.words === right.words;
}

/**
 * The status row for one agent in a place, or null while it has nothing to say. Opened from
 * a conversation, it speaks for that conversation alone. Opened from Tabs (`fromTabs`), it
 * speaks for the first agent in the place's own ranking (acting first, then the most recent)
 * that is using the place: a connected agent whose session is live, or one of your own
 * agents at work or waiting on the person. Whichever kind it is, its Stop is the one its task
 * has, and when several agents hold the place the row names the one it speaks for. One whose
 * conversation is already on screen beside it has none.
 */
export function usePlaceStatusRow(props: {
  /** The place's agents, ranked, whose mark the conversation wears while it is one of them. */
  readonly agents: PlaceAgents;
  readonly hostClient: HostClient;
  readonly onAnswer: (threadId: string) => void;
  /** The conversation the route carries, unless it is already on screen. */
  readonly threadId: string | null;
  /** Opened from Tabs, with nothing on screen beside it: the place's own agent speaks. */
  readonly fromTabs?: boolean;
  /** The tab shown, so a connected agent using it can be named with its task. */
  readonly tabId?: string | null;
}): ReactNode {
  const { agents, hostClient, onAnswer } = props;
  const fromTabs = props.fromTabs === true && props.threadId === null;
  const tabId = props.tabId ?? null;
  const threads = useHostSelector(hostClient, selectThreads);
  const sharedFromChrome = useHostSelector(
    hostClient,
    (snapshot) => tabId !== null && snapshot.tabs.get(tabId)?.sharedByPerson !== undefined,
  );
  // One ranking: the place's own list, whatever kind of agent each one is.
  const selectPlaceThread = useCallback(
    (snapshot: HostSnapshot): string | null => {
      if (!fromTabs) return null;
      const using = agents.agents.find(({ threadId, title }) => {
        if (
          placeSessionLine(snapshot, {
            tabId,
            sharedFromChrome,
            occupants: [{ threadId, title }],
          })?.stop
        )
          return true;
        if (sessionTaskOf(snapshot, threadId) !== null) return false;
        const status = snapshot.threads.find(({ id }) => id === threadId)?.status;
        return (
          status === "running" ||
          status === "waiting" ||
          requestsWaitingOn(snapshot.waitingRequests, threadId).length > 0
        );
      });
      return using?.threadId ?? null;
    },
    [agents, fromTabs, sharedFromChrome, tabId],
  );
  const placeThread = useHostSelector(hostClient, selectPlaceThread);
  const threadId = props.threadId ?? placeThread;
  // Several agents here: the row says whose it is.
  const named = agents.agents.length > 1;
  const session = useMemo(() => {
    const subject = agents.agents.find((agent) => agent.threadId === threadId);
    return subject === undefined
      ? null
      : placeSessionLine(
          { threads },
          {
            tabId,
            sharedFromChrome,
            occupants: [{ threadId: subject.threadId, title: subject.title }],
          },
        );
  }, [threads, agents, tabId, sharedFromChrome, threadId]);
  const sessionStop = useAgentSessionStop(hostClient, session?.threadId ?? "");
  const sessionThreadId = session?.threadId ?? null;
  const selectSessionNeedsYou = useCallback(
    (snapshot: HostSnapshot): boolean =>
      sessionThreadId !== null &&
      requestsWaitingOn(snapshot.waitingRequests, sessionThreadId).length > 0,
    [sessionThreadId],
  );
  const sessionNeedsYou = useHostSelector(hostClient, selectSessionNeedsYou);
  const transcript = useThreadTranscript(hostClient, threadId);
  const selectWatch = useCallback(
    (snapshot: HostSnapshot): ThreadWatch | null => {
      const thread =
        threadId === null ? undefined : snapshot.threads.find(({ id }) => id === threadId);
      return thread === undefined
        ? null
        : threadWatch({
            entries: transcript.entries,
            runQueue: transcript.runQueue,
            thread,
            waitingRequests: snapshot.waitingRequests,
          });
    },
    [threadId, transcript],
  );
  const watch = useHostSelector(hostClient, selectWatch, sameWatch);
  const selectStops = useCallback(
    (snapshot: HostSnapshot): string => {
      const thread = snapshot.threads.find(({ id }) => id === threadId);
      if (thread === undefined || thread.purpose === "voice") return stopLabel("reply");
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
  const sessionRow = useMemo(
    () =>
      session === null ? null : (
        <SessionStatusRow
          busy={sessionStop.running}
          onAnswer={
            sessionNeedsYou && session.stop !== null ? () => onAnswer(session.threadId) : null
          }
          onStop={
            session.stop === null
              ? null
              : () => {
                  if (session.stop) void sessionStop.run(session.stop.sessionId);
                }
          }
          session={session}
        />
      ),
    [onAnswer, session, sessionNeedsYou, sessionStop],
  );
  const runRow = useMemo(
    () =>
      watch === null ? null : (
        <PlaceStatusRow
          agent={agent}
          canRespond={canRespond}
          named={named}
          onAnswer={answer}
          onStop={stop}
          stopLabel={stops}
          watch={watch}
        />
      ),
    [agent, answer, canRespond, named, stop, stops, watch],
  );
  // The one agent the row speaks for: a connected agent's own work has no Run to stop, so
  // its row ends its session instead.
  return session !== null ? sessionRow : runRow;
}

const selectThreads = (snapshot: HostSnapshot) => snapshot.threads;

/**
 * A connected agent using this tab, for which task, and the Stop that ends its session; while
 * it waits on the person, Answer back to the task's question beside that Stop.
 */
export function SessionStatusRow(props: {
  readonly busy: boolean;
  /** Returns to the task, where its question is answered; null while nothing waits. */
  readonly onAnswer: (() => void) | null;
  readonly onStop: (() => void) | null;
  readonly session: NonNullable<ReturnType<typeof placeSessionLine>>;
}): ReactNode {
  const { session } = props;
  return (
    <View style={styles.row} testID="place-status">
      <View accessibilityLiveRegion="polite" accessible style={styles.said}>
        <ExternalAgentMark
          initial={session.agent.initial}
          providerId={session.agent.providerId}
          size={16}
        />
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          role="secondary"
          style={styles.words}
          tone={props.onStop === null ? "muted" : "soft"}
        >
          {session.line}
        </AppText>
      </View>
      {props.onAnswer === null && props.onStop === null ? null : (
        <View style={styles.controls}>
          {props.onAnswer !== null ? (
            <AnswerPill
              accessibilityHint={`${workWords("tab.needsYou", { agent: session.agent.name })}. Returns to the task, where you answer it`}
              label={workWords("tab.answer")}
              onPress={props.onAnswer}
              tone="primary"
            />
          ) : null}
          {props.onStop === null ? null : (
            <ComposerAction
              busy={props.busy}
              disabled={false}
              kind="stop"
              label={workWords("work.stop", { agent: session.agent.name })}
              onPress={props.onStop}
            />
          )}
        </View>
      )}
    </View>
  );
}

function samePlaceAgent(left: PlaceAgent | null, right: PlaceAgent | null): boolean {
  return samePlaceAgents(
    { agents: left === null ? [] : [left], unnamedActing: false },
    { agents: right === null ? [] : [right], unnamedActing: false },
  );
}
