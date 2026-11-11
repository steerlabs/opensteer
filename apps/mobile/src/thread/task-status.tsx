import type { AssignmentSummary } from "@opensteer/core";
import {
  assignmentPresentation,
  assignmentReturnText,
  assignmentRequester,
  blockingDetail,
  formatDuration,
  workerAssignment,
  type AssignmentTone,
  type HostSnapshot,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { color, headerFontScaleLimit, space } from "../theme.js";
import { appear } from "../ui/motion.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * What a task's own Thread says about the work another conversation handed
 * it, and where: its state under the title, what can be done about it in the
 * title's menu, and how it ended in the transcript, after the work that ended
 * it. The words are the shared `assignmentPresentation`'s, so the card in the
 * conversation that asked, the web and this screen say the same thing.
 *
 * Nothing here sits above the composer. That space is for what the reader
 * acts on next: a question, the queue, the message they are writing.
 */

/** The heading's part, in primitives, so an unchanged task never rebuilds the bar. */
export interface TaskHeading {
  readonly announcement: string;
  readonly assignmentId: string;
  /** What the word cannot say: why it cannot go on, or that its result went nowhere. */
  readonly detail: string | null;
  readonly moving: boolean;
  readonly open: boolean;
  /** The conversation it reports to, in the reader's words. */
  readonly requester: string;
  /** That conversation, when this reader can open it. */
  readonly requesterThreadId: string | null;
  readonly stopBlocked: string | null;
  readonly tone: AssignmentTone;
  readonly word: string;
}

/** The task this Thread is doing for someone, or null for a Thread nobody handed work to. */
export function taskHeading(snapshot: HostSnapshot, threadId: string): TaskHeading | null {
  const assignment = workerAssignment(snapshot.assignments, threadId);
  if (assignment === null) return null;
  const presentation = assignmentPresentation(assignment, snapshot);
  return {
    announcement: presentation.announcement,
    assignmentId: assignment.id,
    detail: blockingDetail(presentation)?.text ?? null,
    moving: presentation.moving,
    open: presentation.open,
    requester: assignmentRequester(assignment, snapshot),
    requesterThreadId: openableRequester(assignment, snapshot),
    stopBlocked: presentation.stopBlocked,
    tone: presentation.tone,
    word: presentation.word,
  };
}

export function sameTaskHeading(left: TaskHeading | null, right: TaskHeading | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.announcement === right.announcement &&
    left.assignmentId === right.assignmentId &&
    left.detail === right.detail &&
    left.moving === right.moving &&
    left.open === right.open &&
    left.requester === right.requester &&
    left.requesterThreadId === right.requesterThreadId &&
    left.stopBlocked === right.stopBlocked &&
    left.tone === right.tone &&
    left.word === right.word
  );
}

function openableRequester(assignment: AssignmentSummary, snapshot: HostSnapshot): string | null {
  const parent = assignment.parentThreadId;
  return snapshot.threads.some(({ id }) => id === parent) ? parent : null;
}

/**
 * The task's state beside its word under the title: a dot while it is under
 * way, which breathes only while a Run is working now, and the system's own
 * glyph once it has ended.
 */
export function TaskStateIndicator(props: {
  readonly moving: boolean;
  readonly tone: AssignmentTone;
}): ReactNode {
  return <View style={styles.mark}>{stateGlyph(props)}</View>;
}

function stateGlyph({ moving, tone }: { readonly moving: boolean; readonly tone: AssignmentTone }) {
  switch (tone) {
    case "completed":
      return <Symbol name="checkmark" size={11} tint={color.green} weight="bold" />;
    case "failed":
      return <Symbol name="exclamationmark.circle" size={12} tint={color.red} weight="semibold" />;
    case "stopped":
      return <Symbol name="stop.circle" size={12} tint={color.muted} weight="semibold" />;
    case "working":
      return <StatusDot live={moving} tone="green" />;
    case "waiting":
      return <StatusDot tone="amber" />;
    case "paused":
    case "queued":
      return <StatusDot tone="muted" />;
  }
}

/** The word in its tone: only what asks for the reader, or went wrong, takes a colour. */
function taskWordColor(tone: AssignmentTone): string {
  switch (tone) {
    case "waiting":
      return color.amber;
    case "failed":
      return color.red;
    default:
      return color.muted;
  }
}

/**
 * Under the title: the mark and the word, arriving together when the task
 * moves on. Opening the task shows where it stands at once; only a change
 * while it is in view fades in.
 */
export function TaskStatus(props: {
  readonly moving: boolean;
  readonly tone: AssignmentTone;
  readonly word: string;
}): ReactNode {
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View entering={appear} key={`${props.tone}:${props.word}`} style={styles.status}>
        <TaskStateIndicator moving={props.moving} tone={props.tone} />
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="caption"
          style={[styles.word, { color: taskWordColor(props.tone) }]}
        >
          {props.word}
        </AppText>
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

/** How one task this Thread did ended, for the line after the Run that ended it. */
export interface TaskOutcome {
  readonly assignmentId: string;
  /** Why the result never reached whoever asked, when it did not. */
  readonly detail: string | null;
  readonly line: string;
  readonly requester: string;
  readonly requesterThreadId: string | null;
  /** The Run it ended with; the line goes after that Run's turn. */
  readonly runId: string;
  readonly tone: AssignmentTone;
}

/**
 * Every task this Thread finished that this client holds, by the Run each
 * ended with. A Thread can be handed several tasks over its life; each ending
 * stands where it happened, and what was said to the Thread after it stays
 * below it.
 */
export function taskOutcomes(
  snapshot: HostSnapshot,
  threadId: string,
): ReadonlyMap<string, TaskOutcome> {
  const outcomes = new Map<string, TaskOutcome>();
  for (const assignment of Object.values(snapshot.assignments)) {
    if (assignment.workerThread.id !== threadId || assignment.status === "open") continue;
    if (assignment.currentRunId === null) continue;
    const presentation = assignmentPresentation(assignment, snapshot);
    const requester = assignmentRequester(assignment, snapshot);
    const took =
      assignment.finishedAt === null
        ? null
        : formatDuration(Date.parse(assignment.finishedAt) - Date.parse(assignment.createdAt));
    const returned = assignmentReturnText(assignment, requester);
    outcomes.set(assignment.currentRunId, {
      assignmentId: assignment.id,
      detail: presentation.detail?.text ?? null,
      line: [presentation.word, took, returned].filter((part) => part !== null).join(" · "),
      requester,
      requesterThreadId: openableRequester(assignment, snapshot),
      runId: assignment.currentRunId,
      tone: presentation.tone,
    });
  }
  return outcomes;
}

export function sameTaskOutcomes(
  left: ReadonlyMap<string, TaskOutcome>,
  right: ReadonlyMap<string, TaskOutcome>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [runId, outcome] of right) {
    const held = left.get(runId);
    if (
      held === undefined ||
      held.assignmentId !== outcome.assignmentId ||
      held.detail !== outcome.detail ||
      held.line !== outcome.line ||
      held.requester !== outcome.requester ||
      held.requesterThreadId !== outcome.requesterThreadId ||
      held.tone !== outcome.tone
    )
      return false;
  }
  return true;
}

/**
 * A finished task's one quiet line, on the transcript's own ground: it scrolls
 * away with the work rather than standing over it. A tap opens the
 * conversation it went back to.
 */
export function TaskOutcomeLine(props: {
  readonly onOpenThread: (threadId: string) => void;
  readonly outcome: TaskOutcome;
}): ReactNode {
  const { outcome } = props;
  const target = outcome.requesterThreadId;
  const body = (
    <>
      <View style={styles.outcomeLine}>
        <TaskStateIndicator moving={false} tone={outcome.tone} />
        <AppText role="caption" style={styles.outcomeText} tone="muted">
          {outcome.line}
        </AppText>
      </View>
      {outcome.detail === null ? null : (
        <AppText role="caption" style={styles.outcomeText} tone="danger">
          {outcome.detail}
        </AppText>
      )}
    </>
  );
  return (
    <View style={styles.outcome}>
      {target === null ? (
        <View accessible style={styles.outcomeBody}>
          {body}
        </View>
      ) : (
        <Pressable
          accessibilityHint={`Opens ${outcome.requester}`}
          accessibilityRole="link"
          hitSlop={space[8]}
          onPress={() => props.onOpenThread(target)}
          style={({ pressed }) => [styles.outcomeBody, pressed && styles.pressed]}
        >
          {body}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", height: 12, justifyContent: "center", width: 12 },
  outcome: { alignItems: "center", paddingVertical: space[8] },
  outcomeBody: { alignItems: "center", gap: space[2], maxWidth: 320 },
  outcomeLine: { alignItems: "center", flexDirection: "row", gap: space[6] },
  outcomeText: { flexShrink: 1, textAlign: "center" },
  pressed: { opacity: 0.6 },
  status: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[6] },
  word: { flexShrink: 1 },
});
