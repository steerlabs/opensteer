import { compactionLabel, compactionDisclosure } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import { useTeamsSnapshot } from "../team/team-context.js";
import type { TeamSource } from "@opensteer/core";
import {
  incomingMessageAction,
  teamDeliveryLabel,
  activityStepHead,
  conversationActivities,
  conversationTurn,
  formatClockTime,
  hasRunOutcome,
  silentRunLabel,
  incomingMessagePreview,
  justSent,
  messageAuthorName,
  messageFoldLines,
  turnFolds,
  turnOpen,
  turnState,
  turnWords,
  workRows,
  traceWindow,
  workSummary,
  type ActivityStepHead,
  type ActivityTone,
  type AgentCard,
  type AgentGroup,
  type MessageEntry,
  type ReasoningEntry,
  type RunEntry,
  type SubagentDetailEntry,
  type ToolEntry,
  type ThreadActivityIndicator,
  type TranscriptGroup,
  type TranscriptVoice,
  type Turn,
  type TurnAgents,
  type WorkEntry,
  type WorkRow,
  type WorkSummary,
} from "@opensteer/client/host";
import { placeIdentityKey, voiceCallSeed } from "@opensteer/core";
import { replyParts, type ReplyPart } from "@opensteer/shared/markdown";
import { memo, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { CodeLines, Markdown, PlainProse } from "../markdown/markdown.js";
import { color, material, radius, space, touchTarget, type } from "../theme.js";
import { CopyMark } from "../ui/copy-mark.js";
import { appear, bubblePop, bubbleRise, exit } from "../ui/motion.js";
import { AppText, StatusDot, TypingDots, monoFontFamily } from "../ui/primitives.js";
import { activitySymbol } from "../ui/activity-symbol.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import {
  AgentGroupRow,
  AgentNews,
  AgentRow,
  AgentScopeProvider,
  AgentsLive,
  WorkflowRow,
  type AgentScope,
} from "./subagent-rows.js";
import {
  DelegationLine,
  TaskCards,
  TaskScopeContext,
  ThreadMark,
  useAgentScope,
  useTurnAgents,
  type TaskScope,
} from "./task-line.js";
import { AppCard } from "./app-card.js";
import { MessageAttachments } from "./attachment-views.js";
import { Bubble, bubble } from "./bubble.js";
import { ComputerUseLine, KeptComputerStopLine, useComputerLine } from "./computer-use-line.js";
import { MessageHold, MessageMore } from "./message-hold.js";
import { MessagePages, ReplySurfaces, TracePlace } from "./surface-chips.js";
import { trace as traceStyle } from "./trace-styles.js";

/**
 * The transcript, one row per group.
 *
 * The reader's messages are bubbles. In a conversation, what another agent or
 * an automation sends its agent reads as one line that opens in place.
 *
 * Prose and compact tool rows share the reading stream. Status is a separate
 * line, and command/output details open in a sheet, because a phone's reading
 * column is no place for a terminal.
 */

export const TranscriptGroupRow = memo(function TranscriptGroupRow(props: {
  /**
   * Reads as a conversation: each turn shows its reply as Opensteer's message
   * and keeps everything else it did in its Activity, opened from that
   * message's menu.
   */
  readonly deliveryChannelName?: string;
  readonly conversation?: boolean;
  /**
   * In a conversation, the Activity this turn's reply opens: the key from
   * `replyActivityKeys`, or null when the reply did nothing on the way.
   */
  readonly activityKey?: string | null;
  /** Opens a reply's Activity by its key. */
  readonly onOpenActivity?: ((activityKey: string) => void) | undefined;
  /** Given, the reply under way in a conversation opens its Activity. */
  readonly onOpenReplyUnderWay?: (() => void) | undefined;
  /** Given, each reply in a conversation offers to be quoted into the composer. */
  readonly onReply?: ((message: MessageEntry) => void) | undefined;
  /** The next row carries on from this one, so the tail belongs to that row. */
  readonly continued?: boolean;
  readonly group: TranscriptGroup;
  readonly live?: boolean;
  /**
   * The reader's choice for this row, or null for its default. The pane holds
   * it across rows leaving the list's mounted window.
   */
  readonly open: boolean | null;
  readonly onToggleOpen: (rowKey: string, open: boolean) => void;
  readonly reveal?: string | null;
  readonly highlightRequestId: string | null;
  /** Opens one step's detail. */
  readonly onOpenStep: (entryId: string) => void;
  /** Opens another Thread this one points at: a delegation, or an agent's message. */
  readonly onOpenThread: (threadId: string) => void;
  /** The air above this row: a turn's own rows sit closer than two turns do. */
  readonly spacingTop: number;
  /** When this row was said, where a pause has passed in a conversation. */
  readonly time?: string | null;
  readonly viewerUserId: string | null;
  /** The Voice Thread, where the words that open a call stand for the call. */
  readonly voiceThread?: boolean;
}): ReactNode {
  const { group } = props;
  const deliveryLine =
    group.kind === "turn" && !group.turn.continued && group.turn.run?.delivery ? (
      <AppText role="caption" tone="muted">
        {teamDeliveryLabel(group.turn.run.delivery, props.deliveryChannelName ?? "channel")}
      </AppText>
    ) : null;
  return (
    <View style={{ marginTop: props.spacingTop }}>
      {props.time ? (
        <AppText role="caption" style={styles.time} tone="muted">
          {props.time}
        </AppText>
      ) : null}
      {group.kind === "app" ? (
        <AppCard entry={group.entry} />
      ) : group.kind === "turn" ? (
        props.conversation === true ? (
          <ConversationTurn
            deliveryLine={deliveryLine}
            activityKey={props.activityKey ?? null}
            continued={props.continued === true}
            live={props.live ?? true}
            onOpenActivity={props.onOpenActivity}
            onOpenReplyUnderWay={props.onOpenReplyUnderWay}
            onReply={props.onReply}
            onOpenThread={props.onOpenThread}
            turn={group.turn}
            turnKey={group.key}
          />
        ) : (
          <TurnView
            deliveryLine={deliveryLine}
            reveal={props.reveal ?? null}
            highlightRequestId={props.highlightRequestId}
            onOpenStep={props.onOpenStep}
            onToggle={props.onToggleOpen}
            open={props.open}
            turn={group.turn}
            turnKey={group.key}
            live={props.live ?? true}
          />
        )
      ) : group.kind === "assignment" ? (
        <TaskCards entries={[group.entry]} live={props.live ?? true} />
      ) : group.kind === "delegation" ? (
        <DelegationLine delegation={group.entry} onOpenThread={props.onOpenThread} />
      ) : props.voiceThread === true &&
        group.entry.messageKind !== "assistant" &&
        group.entry.body === voiceCallSeed ? (
        <CallDivider createdAt={group.entry.createdAt} />
      ) : (
        <Message
          continued={props.continued === true}
          conversation={props.conversation === true}
          joinedRun={props.conversation !== true && group.joinedRun === true}
          onReply={props.onReply}
          onToggle={() => props.onToggleOpen(group.key, props.open === true)}
          open={props.open === true}
          message={group.entry}
          onOpenThread={props.onOpenThread}
          viewerUserId={props.viewerUserId}
        />
      )}
    </View>
  );
});

/**
 * The air above a row, given what spoke before it: the gap between two rows is
 * the cheapest way to say whether they belong to one turn or to two.
 */
export function transcriptSpacing(previous: TranscriptVoice | null, next: TranscriptVoice): number {
  if (previous === null) return 0;
  return previous === next ? space[6] : space[16];
}

/* ---- A turn ---- */

function TurnView(props: {
  readonly reveal?: string | null;
  readonly deliveryLine?: ReactNode;
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly onToggle: (turnKey: string, open: boolean) => void;
  readonly open: boolean | null;
  readonly turn: Turn;
  readonly turnKey: string;
  readonly live?: boolean;
}): ReactNode {
  const { onToggle, turn, turnKey } = props;
  const folds = turnFolds(turn);
  const open = turnOpen(turn, props.open);
  if (
    turn.run?.compaction &&
    (turn.run.compaction.reason === "idle" || turn.run.compaction.reason === "before-send")
  )
    return <CompactionDivider run={turn.run} />;
  return (
    <View style={styles.turn}>
      {turn.run?.compaction ? <CompactionDivider run={turn.run} /> : null}
      <TurnContent
        {...(folds ? { fold: { onToggle: () => onToggle(turnKey, open), open } } : {})}
        reveal={props.reveal ?? null}
        highlightRequestId={props.highlightRequestId}
        onOpenStep={props.onOpenStep}
        turn={turn}
        live={props.live ?? true}
      />
      {props.deliveryLine}
      {/* A Run split by a message that joined it shows its pages once, on its latest
          stretch, and only once it is done: while it works, its stops are in the trace. */}
      {turn.continued === true || turnState(turn) !== "settled" ? null : (
        <ReplySurfaces turn={turn} turnKey={props.turnKey} />
      )}
      <TaskCards entries={turn.assignments} live={props.live ?? true} />
      {turn.run !== null && (hasRunOutcome(turn.run) || restarted(turn.run)) ? (
        <RunOutcome run={turn.run} />
      ) : null}
    </View>
  );
}

function WorkStatus(props: {
  readonly summary: WorkSummary;
  readonly turn: Turn;
  readonly live?: boolean;
  /** Given, the line is the disclosure for the turn's folded trace. */
  readonly onToggle?: () => void;
  readonly open?: boolean;
}): ReactNode {
  const { summary, turn } = props;
  const line = useComputerLine(turn, props.live !== false);
  const unsettled = summary.state !== "settled";
  const live = props.live !== false && unsettled;
  const label = summary.state === "live" && restarting(turn.run) ? restartingLabel : summary.label;
  // On the reader's Mac the line says where the agent is, and still opens its steps.
  const toggle =
    props.onToggle === undefined ? null : { onToggle: props.onToggle, open: props.open === true };
  if (line?.kind === "now")
    return <ComputerUseLine key={line.now.session.sessionId} now={line.now} toggle={toggle} />;
  if (line?.kind === "kept")
    return <KeptComputerStopLine key={line.stop.sessionId} stop={line.stop} toggle={toggle} />;
  const content = (
    <>
      {unsettled ? (
        <StatusDot live={live} tone={summary.state === "waiting" ? "amber" : "muted"} />
      ) : null}
      <AppText
        {...(live ? { accessibilityLabel: `${label}, in progress` } : {})}
        numberOfLines={1}
        role="secondaryMedium"
        style={styles.headLabel}
        tone="soft"
      >
        {label}
      </AppText>
      {props.onToggle === undefined ? null : (
        <Symbol
          name={props.open === true ? "chevron.down" : "chevron.right"}
          size={11}
          tint={color.muted}
        />
      )}
    </>
  );
  if (props.onToggle === undefined) {
    return (
      <View>
        <View accessibilityLabel="Agent status" style={styles.head}>
          {content}
        </View>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityHint={
        props.open === true ? "Hides this reply's steps" : "Shows this reply's steps"
      }
      accessibilityRole="button"
      accessibilityState={{ expanded: props.open === true }}
      onPress={props.onToggle}
      style={({ pressed }) => [styles.head, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

/**
 * Which Activity each turn of a conversation opens, by the turn's key. A
 * message that joins a Run splits it into turns, and only the last carries the
 * reply; every one of them opens that reply's Activity. A reply that did
 * nothing on the way has no Activity to open, and no turn of it is listed.
 */
export function replyActivityKeys(groups: readonly TranscriptGroup[]): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  for (const activity of conversationActivities(groups)) {
    if (
      activity.steps.length === 0 &&
      !(activity.turn.run?.status === "completed" && activity.turn.run.replyMessageId === null)
    )
      continue;
    for (const key of activity.keys) keys.set(key, activity.key);
  }
  return keys;
}

/**
 * One turn of a conversation. Opensteer's reply is its message, and until
 * there is one something holds its place: Opensteer typing, or its work on the
 * reader's Mac with the Stop for it. Everything else the turn did is its
 * Activity, opened from the typing or the reply's menu, so the conversation
 * reads as what was said.
 */
function ConversationTurn(props: {
  readonly deliveryLine?: ReactNode;
  readonly onOpenThread: (threadId: string) => void;
  readonly activityKey: string | null;
  readonly continued: boolean;
  readonly live: boolean;
  readonly onOpenActivity: ((activityKey: string) => void) | undefined;
  readonly onOpenReplyUnderWay: (() => void) | undefined;
  readonly onReply: ((message: MessageEntry) => void) | undefined;
  readonly turn: Turn;
  readonly turnKey: string;
}): ReactNode {
  const { activityKey, onOpenActivity, turn } = props;
  const view = useMemo(() => conversationTurn(turn), [turn]);
  // The line the pane drew this row for: a quiet stretch has nothing else to show.
  const line = useComputerLine(turn, props.live);
  const composing = view.composing && props.live && line === null;
  // A reply arrives only if its typing was on screen: one already there when
  // the Thread opened, or that scrolling brought back, just stands there.
  const typed = useRef(false);
  if (composing) typed.current = true;
  if (
    turn.run?.compaction &&
    (turn.run.compaction.reason === "idle" || turn.run.compaction.reason === "before-send")
  )
    return <CompactionDivider run={turn.run} />;
  const onActivity =
    activityKey === null || onOpenActivity === undefined
      ? undefined
      : () => onOpenActivity(activityKey);
  const outcome =
    turn.run !== null &&
    (view.unprompted
      ? turn.run.status === "failed"
      : hasRunOutcome(turn.run) || restarted(turn.run)) ? (
      turn.run.status === "completed" && turn.run.replyMessageId === null ? (
        <Pressable accessibilityRole="button" onPress={onActivity}>
          <AppText role="caption" tone="muted" style={{ fontSize: 12.5 }}>
            {silentRunLabel(turn.run)}
          </AppText>
        </Pressable>
      ) : (
        <RunOutcome conversation run={turn.run} />
      )
    ) : null;
  return (
    <View style={styles.turn}>
      {turn.run?.compaction ? <CompactionDivider run={turn.run} /> : null}
      {line?.kind === "now" ? (
        <ComputerUseLine key={line.now.session.sessionId} now={line.now} />
      ) : line?.kind === "kept" ? (
        <KeptComputerStopLine key={line.stop.sessionId} stop={line.stop} />
      ) : null}
      {turn.source ? <TurnSource source={turn.source} onOpenThread={props.onOpenThread} /> : null}
      <ConversationAgents live={props.live} turn={turn} />
      {view.reply !== null ? (
        <ReplyBubble
          arrived={typed.current}
          continued={props.continued}
          turn={turn}
          turnKey={props.turnKey}
          message={view.reply}
          onActivity={onActivity}
          onReply={props.onReply}
        />
      ) : composing ? (
        <Typing
          // Until it has done anything on the way there is nothing to open.
          onPress={activityKey === null ? undefined : props.onOpenReplyUnderWay}
        />
      ) : view.startHold !== null ? (
        <WorkingIndicator indicator={{ kind: "status", label: view.startHold }} live={props.live} />
      ) : null}
      {props.deliveryLine}
      {/* Typing alone would not say the reader's steered message is why it began again. */}
      {composing && restarting(turn.run) ? (
        <Animated.View accessibilityLiveRegion="polite" entering={appear}>
          <AppText role="caption" tone="muted">
            {restartingLabel}
          </AppText>
        </Animated.View>
      ) : null}
      <TaskCards entries={turn.assignments} live={props.live} />
      {/* A turn that ended without a reply says how, and its Activity opens
          from that line, as a reply's opens from holding it. */}
      {outcome !== null && view.reply === null && onActivity !== undefined ? (
        <View style={styles.outcomeRow}>
          <View style={styles.outcome}>{outcome}</View>
          <Pressable
            accessibilityLabel="Run details"
            accessibilityRole="button"
            hitSlop={space[12]}
            onPress={onActivity}
            style={styles.outcomeOpen}
          >
            <Symbol name="chevron.right" size={11} tint={color.muted} />
          </Pressable>
        </View>
      ) : (
        outcome
      )}
    </View>
  );
}

/**
 * Opensteer's reply, as the stack of bubbles it reads as: its words, and each
 * block of code or draft on its own. Nothing sits on a bubble; holding one is
 * what offers what can be done with it. Under them, the pages and apps its Run used.
 */
function ReplyBubble(props: {
  readonly arrived?: boolean;
  readonly continued: boolean;
  readonly turn?: Turn;
  readonly turnKey: string | null;
  readonly message: MessageEntry;
  readonly onActivity?: (() => void) | undefined;
  readonly onReply: ((message: MessageEntry) => void) | undefined;
}): ReactNode {
  const { message, onReply } = props;
  const parts = useMemo(() => replyParts(message.body), [message.body]);
  const reply = useMemo(
    () => (onReply === undefined ? undefined : () => onReply(message)),
    [message, onReply],
  );
  return (
    <Animated.View
      {...(props.arrived === true ? { entering: bubblePop } : {})}
      style={styles.replyColumn}
    >
      {parts.map((part, index) => (
        <ReplyPartRow
          key={index}
          onActivity={props.onActivity}
          onReply={reply}
          part={part}
          reportId={message.id}
          tail={!props.continued && index === parts.length - 1}
          whole={parts.length > 1 ? message.body : undefined}
        />
      ))}
      {parts.length === 0 ? (
        // With no words to hold, the files are what offers Reply, Run Details and Report.
        <MessageHold
          onActivity={props.onActivity}
          onReply={reply}
          previewRadius={radius.md}
          reportId={message.id}
          text=""
        >
          <MessageAttachments attachments={message.attachments ?? []} />
        </MessageHold>
      ) : (
        <MessageAttachments attachments={message.attachments ?? []} />
      )}
      {/* The record of a finished reply; while its Run works, the conversation's header follows it. */}
      {props.turn === undefined || turnState(props.turn) === "settled" ? (
        <ReplySurfaces
          turn={props.turn ?? { runId: message.runId, work: [] }}
          turnKey={props.turnKey}
        />
      ) : null}
    </Animated.View>
  );
}

/** Words that lay out as lines of a paragraph, so a bubble can size itself by the longest. */
const notOnlyParagraphs = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>|\|)/mu;

function ReplyPartRow(props: {
  readonly onActivity: (() => void) | undefined;
  readonly onReply: (() => void) | undefined;
  readonly part: ReplyPart;
  readonly reportId: string;
  readonly tail: boolean;
  readonly whole: string | undefined;
}): ReactNode {
  const { part } = props;
  const wide = part.kind === "code" || (part.kind === "prose" && part.wide);
  const fits = !wide && !notOnlyParagraphs.test(part.text);
  return (
    <View style={styles.partRow}>
      <MessageHold
        code={part.kind === "code"}
        onActivity={props.onActivity}
        onReply={props.onReply}
        previewRadius={bubble.radius}
        reportId={props.reportId}
        style={wide ? styles.wideHold : styles.bubbleHold}
        text={part.text}
        whole={props.whole}
      >
        <Bubble
          fill={part.kind === "code" ? color.surfaceElevated : color.bubbleTheirs}
          fit={fits ? part.text : null}
          side="theirs"
          style={part.kind === "code" ? styles.codeBubble : undefined}
          tail={props.tail}
        >
          {part.kind === "code" ? (
            <CodeLines selectable={false} text={part.text} />
          ) : part.kind === "draft" ? (
            <PlainProse text={part.text} tone="reply" />
          ) : (
            <Markdown look="bubble" text={part.text} />
          )}
        </Bubble>
      </MessageHold>
      {part.kind === "prose" ? null : (
        <CopyMark
          accessibilityLabel={part.kind === "code" ? "Copy code" : "Copy draft"}
          style={styles.partCopy}
          text={part.text}
        />
      )}
    </View>
  );
}

/**
 * Opensteer composing, in the shape its reply will take. Given `onPress`, it
 * opens that reply's Activity, where the reader is already looking; until the
 * reply has done anything on the way there is nothing to open.
 */
function Typing(props: { readonly onPress?: (() => void) | undefined }): ReactNode {
  return (
    <Animated.View
      accessibilityLabel="Opensteer is replying"
      accessibilityLiveRegion="polite"
      entering={bubblePop}
      style={styles.typingRow}
    >
      {props.onPress === undefined ? (
        <View style={styles.typing}>
          <TypingShape />
        </View>
      ) : (
        <Pressable
          accessibilityHint="Opens Run details"
          accessibilityLabel="Show what Opensteer is doing"
          accessibilityRole="button"
          hitSlop={4}
          onPress={props.onPress}
          style={({ pressed }) => [styles.typing, pressed && styles.typingPressed]}
        >
          <TypingShape />
        </Pressable>
      )}
    </Animated.View>
  );
}

/** Its dots, and the two small circles Messages trails from a bubble still being written. */
function TypingShape(): ReactNode {
  return (
    <>
      <TypingDots />
      <View style={[styles.typingTrail, styles.typingTrailNear]} />
      <View style={[styles.typingTrail, styles.typingTrailFar]} />
    </>
  );
}

/**
 * Everything a reply did on the way to it, in the order it happened, drawn
 * with the rows a task's transcript uses: the body of its Activity.
 */
export function ConversationSteps(props: {
  readonly entries: readonly WorkEntry[];
  readonly reveal?: string | null;
  readonly highlightRequestId: string | null;
  readonly live: boolean;
  readonly onOpenStep: (entryId: string) => void;
  readonly turn: Turn;
}): ReactNode {
  return (
    <View style={styles.steps}>
      <TurnContent
        entries={props.entries}
        reveal={props.reveal ?? null}
        highlightRequestId={props.highlightRequestId}
        live={props.live}
        onOpenStep={props.onOpenStep}
        status={false}
        turn={props.turn}
      />
    </View>
  );
}

interface TurnContentProps {
  /** What of the turn to draw; all of its work unless a conversation keeps its reply apart. */
  readonly entries?: readonly WorkEntry[];
  /** Given, the turn's steps fold behind its status line, which opens and closes them (`turnFolds`). */
  readonly fold?: { readonly onToggle: () => void; readonly open: boolean };
  readonly reveal?: string | null;
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  /**
   * Whether the turn leads with its status line, which stays put while the
   * turn runs and when it ends; a conversation's steps have none.
   */
  readonly status?: boolean;
  readonly turn: Turn;
  readonly live: boolean;
}

/** A turn's rows, its helpers among them, where the pane holds the Host they are read from. */
function TurnContent(props: TurnContentProps): ReactNode {
  const scope = useContext(TaskScopeContext);
  const agentScope = useAgentScope();
  return scope === null || agentScope === null ? (
    <TurnRows {...props} agents={null} agentScope={null} focused={false} />
  ) : (
    <TurnContentWithAgents {...props} agentScope={agentScope} scope={scope} />
  );
}

function TurnContentWithAgents(
  props: TurnContentProps & { readonly agentScope: AgentScope; readonly scope: TaskScope },
): ReactNode {
  const { entries, turn } = props;
  const drawn = useMemo(
    () => (entries === undefined ? turn : { ...turn, work: entries }),
    [entries, turn],
  );
  const agents = useTurnAgents(props.scope, drawn, props.fold?.open === false);
  return <TurnRows {...props} agents={agents} focused={props.scope.focused} />;
}

/** A helper's card or group, standing in the trace where its first card started. */
type AgentTraceRow =
  | { readonly kind: "agents"; readonly key: string; readonly group: AgentGroup }
  | { readonly kind: "workflow"; readonly key: string; readonly card: AgentCard };

function TurnRows(
  props: TurnContentProps & {
    readonly agents: TurnAgents | null;
    readonly agentScope: AgentScope | null;
    readonly focused: boolean;
  },
): ReactNode {
  const { agents, agentScope, fold, turn } = props;
  const [showAll, setShowAll] = useState(false);
  const active = turnState(turn) !== "settled";
  const status = props.status !== false;
  const summary = useMemo(() => (status ? workSummary(turn) : null), [status, turn]);
  // Closed, only the last word stays mounted, keeping long transcripts light to scroll;
  // helpers still at work stand outside the fold instead.
  const closed = fold?.open === false;
  // Rebuilt whenever the turn changes, which a helper's progress does each
  // second; a row standing on the same entries is handed back as the same
  // object, so only what changed draws again.
  const held = useRef<ReadonlyMap<string, WorkRow>>(new Map());
  const rows = useMemo(() => {
    const next = workRows(
      closed
        ? turnWords(turn).filter((entry) => entry.kind !== "node" || entry.nodeKind === "task")
        : (props.entries ?? turn.work),
    ).map((row) => {
      const prior = held.current.get(row.key);
      return prior !== undefined && sameWorkRow(prior, row) ? prior : row;
    });
    held.current = new Map(next.map((row) => [row.key, row]));
    return next;
  }, [closed, props.entries, turn]);
  const trace = traceWindow(rows, { showAll: closed || showAll, keep: props.reveal ?? null });
  const drawnRows = useMemo(() => withAgents(trace.rows, agents), [agents, trace.rows]);
  const cards = useMemo(
    () =>
      agents?.rows.flatMap((row) =>
        row.kind === "agents"
          ? row.group.cards
          : row.kind === "workflow"
            ? [row.card, ...(row.card.workflow?.phases.flatMap(({ members }) => members) ?? [])]
            : [],
      ) ?? [],
    [agents],
  );
  const latestPlaceId = active
    ? (turn.work.findLast((entry) => entry.kind === "place")?.id ?? null)
    : null;
  const lastWord = active ? null : drawnRows.findLast((row): row is WorkRow => row.kind === "note");
  return (
    <AgentRowsScope live={props.live} scope={agentScope}>
      {summary === null ? null : (
        <WorkStatus
          summary={summary}
          turn={turn}
          live={props.live}
          {...(fold === undefined ? {} : fold)}
        />
      )}
      {agentScope === null ? null : <AgentNews cards={cards} focused={props.focused} />}
      {closed && agents?.keptOutside && agentScope !== null ? (
        <AgentGroupRow group={agents.keptOutside} />
      ) : null}
      {trace.hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll(true)}
          style={styles.earlierSteps}
        >
          <AppText role="secondaryMedium" tone="muted">
            Show {trace.hidden} earlier {trace.hidden === 1 ? "step" : "steps"}
          </AppText>
        </Pressable>
      ) : null}
      {/* Steps ease in and out after the turn is first drawn. Notes stay
          unanimated when a streamed message receives its durable id. */}
      <LayoutAnimationConfig skipEntering>
        {drawnRows.map((row) => {
          if (row.kind === "agents" || row.kind === "workflow") {
            if (agentScope === null) return null;
            return row.kind === "agents" ? (
              <AgentGroupRow group={row.group} key={row.key} />
            ) : (
              <WorkflowRow card={row.card} key={row.key} />
            );
          }
          const content = (
            <WorkRowView
              active={active}
              answer={row === lastWord}
              highlightRequestId={props.highlightRequestId}
              latestPlaceId={latestPlaceId}
              onOpenStep={props.onOpenStep}
              row={row}
              key={row.key}
            />
          );
          return row.kind === "note" ? (
            content
          ) : (
            <Animated.View entering={appear} exiting={exit} key={row.key}>
              {content}
            </Animated.View>
          );
        })}
      </LayoutAnimationConfig>
    </AgentRowsScope>
  );
}

/** Where helper rows open and whether their time still moves, for the rows inside. */
function AgentRowsScope(props: {
  readonly children: ReactNode;
  readonly live: boolean;
  readonly scope: AgentScope | null;
}): ReactNode {
  if (props.scope === null) return props.children;
  return (
    <AgentsLive value={props.live}>
      <AgentScopeProvider value={props.scope}>{props.children}</AgentScopeProvider>
    </AgentsLive>
  );
}

function sameWorkRow(left: WorkRow, right: WorkRow): boolean {
  if (left.kind === "steps" || right.kind === "steps")
    return (
      left.kind === "steps" &&
      right.kind === "steps" &&
      left.currentPlace === right.currentPlace &&
      sameItems(left.entries, right.entries) &&
      sameItems(left.places, right.places)
    );
  return left.kind === right.kind && left.entry === right.entry;
}

function sameItems(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The trace's rows with each run of helpers drawn as the model groups them,
 * at the place its first visible card started. Without the model, helpers are
 * left out rather than drawn as steps.
 */
function withAgents(
  rows: readonly WorkRow[],
  agents: TurnAgents | null,
): readonly (WorkRow | AgentTraceRow)[] {
  const homes = new Map<string, AgentTraceRow>();
  for (const row of agents?.rows ?? []) {
    if (row.kind === "agents")
      for (const card of row.group.cards)
        homes.set(card.key, { group: row.group, key: `agents:${row.group.key}`, kind: "agents" });
    else if (row.kind === "workflow")
      homes.set(row.card.key, {
        card: row.card,
        key: `workflow:${row.card.key}`,
        kind: "workflow",
      });
  }
  const drawn = new Set<string>();
  return rows.flatMap((row): (WorkRow | AgentTraceRow)[] => {
    if (row.kind !== "subagent") return [row];
    const home = homes.get(`node:${row.entry.nodeId}`);
    if (home === undefined || drawn.has(home.key)) return [];
    drawn.add(home.key);
    return [home];
  });
}

/**
 * A conversation draws no trace, so a turn's subagents stand above its typing or its
 * reply, where they would otherwise never be seen. Settled, a group folds to
 * its one line; the reply is the summary.
 */
function ConversationAgents(props: { readonly live: boolean; readonly turn: Turn }): ReactNode {
  const scope = useContext(TaskScopeContext);
  const agentScope = useAgentScope();
  if (scope === null || agentScope === null) return null;
  return (
    <HeldConversationAgents
      agentScope={agentScope}
      live={props.live}
      scope={scope}
      turn={props.turn}
    />
  );
}

function HeldConversationAgents(props: {
  readonly agentScope: AgentScope;
  readonly live: boolean;
  readonly scope: TaskScope;
  readonly turn: Turn;
}): ReactNode {
  const agents = useTurnAgents(props.scope, props.turn, false);
  if (agents === null) return null;
  return (
    <View style={styles.chatAgents}>
      <AgentNews
        cards={agents.rows.flatMap((row) =>
          row.kind === "agents" ? row.group.cards : row.kind === "workflow" ? [row.card] : [],
        )}
        focused={props.scope.focused}
      />
      <AgentRowsScope live={props.live} scope={props.agentScope}>
        {agents.rows.map((row) =>
          row.kind === "agents" ? (
            <AgentGroupRow group={row.group} key={row.group.key} />
          ) : row.kind === "workflow" ? (
            <WorkflowRow card={row.card} key={row.card.key} />
          ) : null,
        )}
      </AgentRowsScope>
    </View>
  );
}

/**
 * A subagent's own steps, drawn with the transcript's rows: what it said as
 * prose, what it thought, the tools it called (a run of them as one row, as
 * in a turn), and the subagents it started as their rows.
 */
export function SubagentSteps(props: {
  readonly active: boolean;
  readonly agentScope: AgentScope;
  readonly live: boolean;
  readonly entries: readonly SubagentDetailEntry[];
  readonly onOpenStep: (entryId: string) => void;
}): ReactNode {
  const rows = useMemo(() => {
    const drawn: (
      | { readonly kind: "entry"; readonly entry: Exclude<SubagentDetailEntry, ToolEntry> }
      | { readonly kind: "work"; readonly row: WorkRow }
    )[] = [];
    let tools: ToolEntry[] = [];
    const flush = () => {
      for (const row of workRows(tools)) drawn.push({ kind: "work", row });
      tools = [];
    };
    for (const entry of props.entries) {
      if (entry.kind === "tool") tools.push(entry);
      else {
        flush();
        drawn.push({ entry, kind: "entry" });
      }
    }
    flush();
    return drawn;
  }, [props.entries]);
  return (
    <AgentRowsScope live={props.live} scope={props.agentScope}>
      <LayoutAnimationConfig skipEntering>
        {rows.map((item) => {
          if (item.kind === "work")
            return (
              <Animated.View entering={appear} exiting={exit} key={item.row.key}>
                <WorkRowView
                  active={props.active}
                  highlightRequestId={null}
                  latestPlaceId={null}
                  onOpenStep={props.onOpenStep}
                  row={item.row}
                />
              </Animated.View>
            );
          const { entry } = item;
          switch (entry.kind) {
            case "message":
              return (
                <View key={entry.id} style={styles.assistant}>
                  <Markdown text={entry.text} />
                </View>
              );
            case "reasoning":
              return (
                <ReasoningRow
                  active={false}
                  key={entry.id}
                  reasoning={{
                    createdAt: "",
                    id: entry.id,
                    kind: "reasoning",
                    runId: null,
                    state: "done",
                    text: entry.text,
                  }}
                />
              );
            case "agent":
              return entry.card.workflow ? (
                <WorkflowRow card={entry.card} key={entry.card.key} />
              ) : (
                <AgentRow card={entry.card} key={entry.card.key} noun />
              );
          }
        })}
      </LayoutAnimationConfig>
    </AgentRowsScope>
  );
}

/** One row of a turn's work; a helper's progress redraws its own row, never these. */
const WorkRowView = memo(function WorkRowView(props: {
  readonly active: boolean;
  readonly answer?: boolean;
  readonly highlightRequestId: string | null;
  /** The turn's newest stop in a tab, the only one its agent can be acting at now. */
  readonly latestPlaceId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly row: WorkRow;
}): ReactNode {
  const { row } = props;
  switch (row.kind) {
    case "note":
      return <AssistantMessage answer={props.answer === true} message={row.entry} />;
    case "reasoning":
      return <ReasoningRow active={props.active} reasoning={row.entry} />;
    // A subagent is drawn as its row, by the turn; a background task is one step.
    case "subagent":
      return null;
    case "task":
      return <StepHead head={row.head} highlighted={false} />;
    case "steps":
      return (
        <StepsRow
          latestPlaceId={props.latestPlaceId}
          highlightRequestId={props.highlightRequestId}
          onOpenStep={props.onOpenStep}
          row={row}
        />
      );
    case "place":
      return <TracePlace entry={row.entry} latest={row.entry.id === props.latestPlaceId} />;
  }
});

function StepsRow(props: {
  readonly latestPlaceId: string | null;
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly row: Extract<WorkRow, { kind: "steps" }>;
}): ReactNode {
  const { row } = props;
  const [only] = row.entries;
  const single = row.entries.length === 1 ? only : undefined;
  const highlighted = row.entries.some(
    (entry) => entry.kind === "request" && entry.requestId === props.highlightRequestId,
  );
  const [open, setOpen] = useState(false);

  if (single !== undefined) {
    return (
      <StepHead
        head={row.head}
        highlighted={highlighted}
        {...(single.kind === "request" ? {} : { onPress: () => props.onOpenStep(single.id) })}
      />
    );
  }
  return (
    <View>
      <StepHead
        expanded={open}
        head={row.head}
        places={
          row.places.length > 0 ? (
            <View style={{ flexDirection: "row" }}>
              {row.places.slice(0, 3).map((entry) => {
                const place =
                  row.currentPlace &&
                  placeIdentityKey(row.currentPlace.place) === placeIdentityKey(entry.place)
                    ? row.currentPlace
                    : entry;
                return (
                  <TracePlace
                    entry={place}
                    latest={place.id === props.latestPlaceId}
                    markOnly
                    key={entry.id}
                  />
                );
              })}
            </View>
          ) : null
        }
        highlighted={false}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <Animated.View entering={appear} exiting={exit} style={traceStyle.lines}>
          {row.entries.map((entry) =>
            entry.kind === "place" ? (
              <TracePlace entry={entry} latest={entry.id === props.latestPlaceId} key={entry.id} />
            ) : (
              <StepHead
                compact
                head={activityStepHead(entry)}
                highlighted={
                  entry.kind === "request" && entry.requestId === props.highlightRequestId
                }
                key={entry.id}
                {...(entry.kind === "request" ? {} : { onPress: () => props.onOpenStep(entry.id) })}
              />
            ),
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * Reasoning is prose, so the live text belongs in the conversation rather
 * than in a sheet that would cover it. A thought first seen in an active turn stays
 * open when it completes; historical thoughts remain one-line disclosures.
 */
function ReasoningRow(props: {
  readonly active: boolean;
  readonly reasoning: ReasoningEntry;
}): ReactNode {
  const [open, setOpen] = useState(props.active || props.reasoning.state === "streaming");
  return (
    <View>
      <StepHead
        expanded={open}
        head={activityStepHead(props.reasoning)}
        highlighted={false}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <Animated.View entering={appear} exiting={exit} style={styles.thought}>
          <AppText selectable role="secondary" tone="muted">
            {props.reasoning.text}
          </AppText>
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * The one row shape a row and each step inside it share: what kind of step,
 * what happened, what it happened to. `expanded` marks a row that opens in
 * place; a row without it opens its step's sheet.
 */
function StepHead(props: {
  readonly compact?: boolean;
  readonly places?: ReactNode;
  readonly expanded?: boolean;
  readonly head: ActivityStepHead;
  readonly highlighted: boolean;
  readonly onPress?: () => void;
}): ReactNode {
  const { head } = props;
  const content = (
    <>
      {props.places ? (
        props.places
      ) : (
        <View style={traceStyle.icon}>
          <Symbol
            name={props.compact === true ? toneSymbol(head) : activitySymbol[head.icon]}
            size={props.compact === true ? 12 : 14}
            tint={toneColor(head.tone)}
            weight="medium"
          />
        </View>
      )}
      <View style={traceStyle.stepText}>
        {/* A label with nothing under it — a computer-use headline is the whole
            step — says its outcome last, so it may take a second line; so may
            one with nothing to open, such as a Request's receipt, which has
            nowhere else to say all of itself. */}
        <AppText
          numberOfLines={head.detail && props.onPress !== undefined ? 1 : 2}
          role="secondary"
          tone="soft"
        >
          {head.label}
        </AppText>
        {head.detail ? (
          <AppText
            numberOfLines={1}
            role="caption"
            style={head.detailKind === "code" ? styles.code : undefined}
            tone="muted"
          >
            {head.detail}
          </AppText>
        ) : null}
      </View>
      {head.errors > 0 && props.compact !== true ? <ErrorCount count={head.errors} /> : null}
      {head.duration === null ? null : (
        <AppText role="caption" style={traceStyle.figures} tone="muted">
          {head.duration}
        </AppText>
      )}
      {props.onPress === undefined ? null : (
        <Symbol
          name={props.expanded === true ? "chevron.down" : "chevron.right"}
          size={11}
          tint={color.muted}
        />
      )}
    </>
  );
  const style = [
    traceStyle.step,
    props.compact === true && traceStyle.stepCompact,
    props.highlighted && styles.highlighted,
  ];
  if (props.onPress === undefined) return <View style={style}>{content}</View>;
  return (
    <Pressable
      accessibilityHint={
        props.expanded === undefined
          ? "Shows this step's detail"
          : props.expanded
            ? "Hides these steps"
            : "Shows these steps"
      }
      accessibilityRole="button"
      {...(props.expanded === undefined
        ? {}
        : { accessibilityState: { expanded: props.expanded } })}
      onPress={props.onPress}
      style={({ pressed }) => [...style, pressed && traceStyle.pressed]}
    >
      {content}
    </Pressable>
  );
}

function ErrorCount(props: { readonly count: number }): ReactNode {
  return (
    <AppText role="caption" style={styles.errors}>
      {`· ${props.count} failed`}
    </AppText>
  );
}

/** A step inside a row already sits under its kind's glyph; its own mark says how it went. */
function toneSymbol(head: ActivityStepHead): SFSymbolName {
  switch (head.tone) {
    case "error":
      return "exclamationmark.circle";
    case "stopped":
      return "stop.circle";
    case "running":
      return "circle.dotted";
    case "decided":
      return "checkmark.circle";
    case "done":
      return head.icon === "asterisk" ? "lightbulb" : "checkmark";
  }
}

function toneColor(tone: ActivityTone): string {
  switch (tone) {
    case "running":
      return color.ember;
    case "error":
      return color.amber;
    case "decided":
      return color.green;
    case "done":
    case "stopped":
      return color.muted;
  }
}

/* ---- Messages ---- */

function AssistantMessage(props: {
  /** The turn's finished last word, which is what a person came to copy. */
  readonly answer: boolean;
  readonly message: MessageEntry;
}): ReactNode {
  const { body } = props.message;
  return (
    // No bubble, and the full measure: an agent's turn is long markdown with
    // headings, lists and code in it, and a bubble around that is a column
    // narrowed for nothing. The side it sits on is what says who wrote it. Its
    // words stay selectable, so holding them selects and its marks sit under it.
    <View style={styles.assistant}>
      {body ? <Markdown streaming={props.message.streaming === true} text={body} /> : null}
      <MessageAttachments attachments={props.message.attachments ?? []} />
      {props.message.streaming === true ? null : (
        <View style={styles.marks}>
          {props.answer && body ? (
            <CopyMark accessibilityLabel="Copy reply" style={styles.mark} text={body} />
          ) : null}
          <MessageMore reportId={props.message.id} text={body} />
        </View>
      )}
    </View>
  );
}

/** Where a call began on the Voice Thread. It marks time; there is nothing here to read. */
function CallDivider(props: { readonly createdAt: string }): ReactNode {
  const time = formatClockTime(props.createdAt);
  return (
    <View
      accessibilityLabel={`${voiceCallSeed} at ${time}`}
      accessibilityRole="text"
      accessible
      style={styles.call}
    >
      <View style={styles.callRule} />
      <AppText role="caption" tone="muted">
        {voiceCallSeed} · {time}
      </AppText>
      <View style={styles.callRule} />
    </View>
  );
}

export function Message(props: {
  readonly continued?: boolean;
  readonly queued?: boolean;
  readonly joinedRun?: boolean;
  readonly conversation: boolean;
  readonly onReply: ((message: MessageEntry) => void) | undefined;
  readonly message: MessageEntry;
  /** Whether the reader opened the folded words, which the pane keeps across scrolling. */
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { message, open } = props;
  const preview = useMemo(() => incomingMessagePreview(message), [message]);
  const body = preview.truncated && !open ? preview.text : message.body;
  const [arrived] = useState(
    () => props.queued !== true && justSent(message.createdAt, Date.now()),
  );
  if (message.messageKind === "assistant") {
    return props.conversation ? (
      <ReplyBubble
        continued={props.continued === true}
        message={message}
        onReply={props.onReply}
        turnKey={null}
      />
    ) : (
      <AssistantMessage answer={message.streaming !== true} message={message} />
    );
  }

  const author = message.author;
  if (author.kind === "platform" && author.cause === "run-recovery") {
    return (
      <RecoveryNote author={author} message={message} onToggle={props.onToggle} open={props.open} />
    );
  }
  const mine = author.kind === "human" && author.userId === props.viewerUserId;
  const update = props.conversation && !mine;

  const fold = (
    <MessageFold
      lines={messageFoldLines(message, props.viewerUserId)}
      mine={mine && !props.queued}
      more={preview.truncated}
      onToggle={props.onToggle}
      open={open}
    >
      {/* Only an agent or a trigger writes Markdown into a Thread; a person
          typed exactly what is shown, so it is shown exactly. */}
      {author.kind === "human" ? (
        <PlainProse text={message.body} tone={mine && !props.queued ? "bubble" : "default"} />
      ) : (
        <Markdown text={body} />
      )}
    </MessageFold>
  );

  return (
    <Animated.View
      {...(mine && arrived ? { entering: bubbleRise } : {})}
      style={update ? styles.updateColumn : mine ? styles.mineColumn : styles.inputColumn}
    >
      {props.joinedRun ? (
        <View
          accessible
          accessibilityLabel="Steered into the running turn"
          style={styles.steerMarker}
        >
          <Symbol name="arrow.turn.down.right" size={12} tint={color.muted} />
          <AppText role="caption" tone="muted">
            Steer
          </AppText>
        </View>
      ) : null}
      {mine ? null : (
        <Attribution
          action={incomingMessageAction(message)}
          mark={
            author.kind === "agent" ? (
              <ThreadMark threadId={author.threadId} />
            ) : author.kind === "trigger" || author.kind === "watch" ? (
              <Symbol name="bolt" size={13} tint={color.muted} />
            ) : null
          }
          name={messageAuthorName(author)}
          {...(author.kind === "agent"
            ? { onOpen: () => props.onOpenThread(author.threadId) }
            : {})}
        />
      )}
      <MessagePages pages={message.pages ?? []} />
      <MessageAttachments attachments={message.attachments ?? []} />
      {!message.body ? null : mine && !props.queued ? (
        <MessageHold
          previewBottomEndRadius={props.conversation ? undefined : radius.xs}
          previewRadius={bubble.radius}
          text={message.body}
        >
          <Bubble
            fill={color.bubble}
            fit={message.body}
            side="mine"
            // Messages' tail is a conversation's; a task keeps the bubble's corner instead.
            style={props.conversation ? undefined : styles.bubbleCorner}
            tail={props.conversation && props.continued !== true}
          >
            {fold}
          </Bubble>
        </MessageHold>
      ) : (
        <View
          style={
            update
              ? styles.updateBody
              : [
                  styles.bubble,
                  props.queued
                    ? [
                        styles.bubbleQueued,
                        mine ? styles.bubbleQueuedMine : styles.bubbleQueuedOther,
                      ]
                    : styles.bubbleInput,
                ]
          }
        >
          {fold}
        </View>
      )}
      {message.teamSource ? <TeamInputSource source={message.teamSource} /> : null}
      {message.delivery ? (
        <View accessibilityRole="alert" style={styles.failure}>
          <AppText role="secondaryMedium" tone="danger">
            {message.delivery.reason}
          </AppText>
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * A sent message's words, folded to `lines` of body text until the reader
 * opens them. Show more stands inside the message, and only when the words run
 * past the fold or `more` says what is drawn is an excerpt of something longer.
 */
function MessageFold(props: {
  readonly children: ReactNode;
  readonly lines: number;
  /** The reader's own bubble is the accent, so its toggle takes the bubble's ink. */
  readonly mine: boolean;
  readonly more: boolean;
  readonly onToggle: () => void;
  readonly open: boolean;
}): ReactNode {
  // Lines of body text, which grow with the reader's text size.
  const { fontScale } = useWindowDimensions();
  const fold = props.lines * type.body.lineHeight * fontScale;
  const [height, setHeight] = useState<number | null>(null);
  const overflowing = height !== null && height > fold + 1;
  return (
    <>
      <View style={props.open ? undefined : [styles.fold, { maxHeight: fold }]}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          {props.children}
        </View>
      </View>
      {overflowing || props.more ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.open }}
          onPress={props.onToggle}
          style={styles.foldToggle}
        >
          <AppText
            role="secondaryMedium"
            style={props.mine ? styles.bubbleInk : undefined}
            tone="ember"
          >
            {props.open ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
    </>
  );
}

/** Why Opensteer spoke unprompted: what woke the turn, above its reply. */
function TurnSource(props: {
  readonly source: NonNullable<Turn["source"]>;
  readonly onOpenThread: (threadId: string) => void;
}): ReactNode {
  const { author, task, createdAt } = props.source;
  const name = task?.workerThread.title ?? messageAuthorName(author);
  const threadId = task?.workerThread.id ?? (author.kind === "agent" ? author.threadId : null);
  const content = (
    <View style={styles.updateLineHead}>
      <Symbol
        name={author.kind === "trigger" || author.kind === "watch" ? "bolt" : "bubble.left"}
        size={14}
        tint={color.muted}
      />
      <AppText role="caption" tone="muted" style={{ fontSize: 12 }}>
        {name} · {formatClockTime(createdAt)}
        {threadId ? " ›" : ""}
      </AppText>
    </View>
  );
  // Automations have no page on mobile, so they are named and left at that.
  return threadId ? (
    <Pressable accessibilityRole="link" onPress={() => props.onOpenThread(threadId)}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

/** What Opensteer noted when it recovered a Run: one line naming it, opening in place to what was said. */
function RecoveryNote(props: {
  readonly author: Extract<MessageEntry["author"], { readonly kind: "platform" }>;
  readonly message: MessageEntry;
  /** Whether the reader opened it, which the pane keeps across scrolling. */
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { author, message, open } = props;
  const said = incomingMessageAction(message);
  const name = messageAuthorName(author);
  return (
    <View style={styles.updateLine}>
      <View style={styles.updateLineHead}>
        <Symbol name="bubble.left" size={13} tint={color.muted} />
        <AppText numberOfLines={1} role="caption" style={styles.updateLineSource} tone="soft">
          {name}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={props.onToggle}
          style={styles.updateLineToggle}
        >
          <AppText role="caption" tone="muted">
            {said}
          </AppText>
          <AppText role="caption" style={traceStyle.figures} tone="muted">
            {formatClockTime(message.createdAt)}
          </AppText>
          <Symbol name={open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
        </Pressable>
      </View>
      {message.delivery ? (
        <View accessibilityRole="alert" style={styles.failure}>
          <AppText role="secondaryMedium" tone="danger">
            {message.delivery.reason}
          </AppText>
        </View>
      ) : null}
      {open ? (
        <View style={styles.updateLineBody}>
          <MessageAttachments attachments={message.attachments ?? []} />
          {message.body ? <Markdown text={message.body} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Who sent an input this reader did not, by the mark and name the task list
 * gives it, and — when it was another Thread's agent — the way to that
 * Thread. A trigger's own page is a computer-sized screen this app does not
 * have, so a trigger is named and not linked.
 */
function Attribution(props: {
  readonly action: string | null;
  readonly mark: ReactNode;
  readonly name: string;
  readonly onOpen?: () => void;
}): ReactNode {
  const content = (
    <>
      {props.mark}
      <AppText
        numberOfLines={1}
        role="caption"
        style={{ flexShrink: 1 }}
        tone={props.onOpen === undefined ? "muted" : "emberDim"}
      >
        {props.name}
      </AppText>
      {props.action === null ? null : (
        <AppText role="caption" style={{ flexShrink: 0 }} tone="muted">
          {props.action}
        </AppText>
      )}
    </>
  );
  if (props.onOpen === undefined) return <View style={styles.attribution}>{content}</View>;
  return (
    <Pressable
      accessibilityHint="Opens the thread this came from"
      accessibilityRole="button"
      hitSlop={space[8]}
      onPress={props.onOpen}
      style={styles.inputFrom}
    >
      {content}
    </Pressable>
  );
}

/* ---- Run outcomes ---- */

const restartingLabel = "Restarting with your message";

/**
 * A Run a steered message restarted, until the attempt that takes the message
 * starts. It keeps its identity; only its execution began again.
 */
function restarting(run: RunEntry | null): boolean {
  return (
    run !== null &&
    (run.attempt ?? 1) >= 2 &&
    (run.status === "queued" || run.status === "starting")
  );
}

/** A Run whose first attempt a restart replaced, once the attempt that took the message began. */
function restarted(run: RunEntry): boolean {
  return (run.attempt ?? 1) >= 2 && !restarting(run);
}

function RunOutcome(props: {
  /** A conversation says what happened to the reply, not to a run. */
  readonly conversation?: boolean;
  readonly run: RunEntry;
}): ReactNode {
  const { run } = props;
  const footer = restarted(run) ? (
    <AppText role="caption" tone="muted">
      Restarted to include your message
    </AppText>
  ) : null;
  if (run.status === "failed") {
    return (
      <>
        <View accessibilityRole="alert" style={styles.failure}>
          <AppText role="secondaryMedium" tone="danger">
            {props.conversation === true ? "Opensteer couldn’t finish" : "This run failed"}
          </AppText>
          {run.error === null ? null : (
            <AppText role="secondary" selectable tone="soft">
              {run.error.message}
            </AppText>
          )}
          {run.error?.retryable === true ? (
            <AppText role="caption" tone="muted">
              This looks temporary. Sending again may work.
            </AppText>
          ) : null}
        </View>
        {footer}
      </>
    );
  }
  if (run.status === "interrupted") {
    return (
      <>
        <AppText role="secondary" tone="muted">
          {props.conversation === true ? "Stopped." : "This run stopped."}
        </AppText>
        {footer}
      </>
    );
  }
  if (run.status === "completed" && run.replyMessageId === null) {
    if (props.conversation !== true) return footer;
    return (
      <>
        <AppText role="secondary" tone="muted">
          {silentRunLabel(run)}
        </AppText>
        {footer}
      </>
    );
  }
  return footer;
}

/**
 * A Thread at work before its Run has said anything: the message was taken,
 * and the Run that answers it has not reported in yet.
 */
export function WorkingIndicator({
  indicator,
  live = true,
}: {
  readonly indicator: ThreadActivityIndicator;
  readonly live?: boolean;
}): ReactNode {
  if (!live) return null;
  // No turn has begun, so there is no Activity to open yet.
  if (indicator.kind === "typing") return <Typing />;
  return (
    <Animated.View accessibilityLiveRegion="polite" entering={appear} style={styles.working}>
      <StatusDot live tone="muted" />
      <AppText role="secondaryMedium" tone="soft">
        {indicator.label}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  earlierSteps: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  call: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingVertical: space[8],
  },
  callRule: { backgroundColor: color.line, flex: 1, height: 1 },
  assistant: { gap: space[2] },
  /** Under a task's words, level with them: a thumb's reach, no ground of their own. */
  marks: { alignItems: "center", flexDirection: "row", marginBottom: -space[8] },
  mark: { alignItems: "center", height: 24, justifyContent: "center", width: 24 },
  replyColumn: { gap: bubble.gap },
  partRow: { alignItems: "flex-end", flexDirection: "row", gap: space[8] },
  /** Words take Messages' share of the column; what needs its width takes it, less the mark. */
  bubbleHold: { flexShrink: 1, maxWidth: bubble.maxWidth },
  wideHold: { flex: 1 },
  codeBubble: { paddingHorizontal: 0, paddingVertical: 0 },
  partCopy: {
    alignItems: "center",
    height: 24,
    justifyContent: "center",
    marginBottom: 8,
    width: 22,
  },
  steps: { gap: space[4] },
  chatAgents: { alignSelf: "stretch" },
  /** A turn's outcome and the way to its Activity, on one line. */
  outcomeRow: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[6],
  },
  outcome: { flexShrink: 1, gap: space[4] },
  outcomeOpen: { alignItems: "center", height: 24, justifyContent: "center", width: 20 },
  typing: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.bubbleTheirs,
    borderCurve: "continuous",
    borderRadius: bubble.radius,
    height: 40,
    justifyContent: "center",
    paddingHorizontal: space[16],
  },
  typingPressed: { backgroundColor: color.surfaceRaised },
  typingRow: { alignSelf: "flex-start", flexDirection: "row", transformOrigin: "left bottom" },
  typingTrail: { backgroundColor: color.bubbleTheirs, borderRadius: 7, position: "absolute" },
  typingTrailNear: { bottom: -1, height: 13, left: -1, width: 13 },
  typingTrailFar: { bottom: -6, height: 6, left: -6, width: 6 },
  time: { paddingBottom: bubble.groupGap - space[4], paddingTop: space[6], textAlign: "center" },

  attribution: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  bubble: {
    alignSelf: "flex-end",
    // The web's asymmetric corner: the one square-ish corner points back at
    // the sender, which is what makes a right-hand bubble read as "from me"
    // rather than as a box that happens to be right-aligned. It is an end
    // corner rather than a right one, so a right-to-left layout flips it.
    borderRadius: radius.xl,
    borderBottomEndRadius: radius.xs,
    maxWidth: "100%",
    paddingHorizontal: space[16] - 1,
    paddingVertical: space[12] - 1,
  },
  bubbleCorner: { borderBottomEndRadius: radius.xs },
  bubbleQueued: { backgroundColor: "transparent", borderWidth: 1.5, borderStyle: "dashed" },
  bubbleQueuedMine: { borderColor: color.emberLine },
  bubbleQueuedOther: { borderColor: color.lineStrong },
  steerMarker: { flexDirection: "row", alignItems: "center", gap: space[4] },
  bubbleInk: { color: color.bubbleInk },
  bubbleInput: { ...material.plate },
  /** Another Thread's result is the one framed thing among the agent's rows: it came from elsewhere. */
  card: {
    ...material.plate,
    borderRadius: radius.md,
    paddingHorizontal: space[8] - 1,
  },
  cardBody: { gap: space[4], paddingBottom: space[4], paddingLeft: space[32] },
  code: { fontFamily: monoFontFamily, fontSize: 12 },
  errors: { color: color.amber },
  failure: {
    backgroundColor: color.redWash,
    borderColor: color.redLine,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    padding: space[12],
  },
  // `scroll`, not `hidden`: layout leaves a scrolling box's words their whole
  // height, so they measure all they hold, and the box still clips them.
  fold: { overflow: "scroll" },
  foldToggle: { justifyContent: "center", minHeight: touchTarget, paddingTop: space[4] },
  /** The work's one line: no ground of its own, so the reply below stays the loudest thing in the turn. */
  head: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    marginHorizontal: -space[8],
    maxWidth: "100%",
    minHeight: touchTarget,
    paddingHorizontal: space[8],
  },
  headLabel: { flexShrink: 1 },
  highlighted: { backgroundColor: color.emberWash },
  inputColumn: { alignItems: "flex-end", alignSelf: "flex-end", gap: space[4], maxWidth: "82%" },
  mineColumn: {
    alignItems: "flex-end",
    alignSelf: "flex-end",
    gap: space[4],
    maxWidth: bubble.maxWidth,
  },
  updateColumn: {
    alignItems: "flex-start",
    alignSelf: "stretch",
    borderLeftColor: color.emberLine,
    borderLeftWidth: 2,
    gap: space[4],
    paddingLeft: space[12],
  },
  updateBody: { alignSelf: "stretch" },
  updateLine: { alignSelf: "stretch", gap: space[2] },
  updateLineBody: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: 1,
    gap: space[4],
    marginLeft: space[6],
    paddingLeft: space[14],
  },
  updateLineHead: { alignItems: "center", flexDirection: "row", gap: space[6] },
  updateLineSource: { flexShrink: 1 },
  updateLineToggle: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 0,
    gap: space[6],
    minHeight: touchTarget,
  },
  inputFrom: { alignItems: "center", flexDirection: "row", gap: space[6], minHeight: touchTarget },
  openThread: { justifyContent: "center", minHeight: touchTarget, paddingLeft: space[28] },
  pressed: { ...material.quiet },
  thought: { paddingBottom: space[8], paddingLeft: space[28], paddingRight: space[8] },
  turn: { gap: space[4] },
  working: { alignItems: "center", flexDirection: "row", gap: space[8], minHeight: touchTarget },
});

function TeamInputSource({ source }: { readonly source: TeamSource }): ReactNode {
  const navigation = useNavigation();
  const team = useTeamsSnapshot().teams.find((row) => row.teamId === source.teamId);
  const label = (
    <AppText role="caption" tone="muted">{`#${source.audience.channelName} ↗`}</AppText>
  );
  const rootId = source.threadRootId ?? source.messageId;
  if (!team || team.state === "removed" || !rootId) return label;
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        navigation.navigate("TeamThread", {
          teamId: source.teamId,
          channelId: source.channelId,
          rootId,
          ...(source.messageId && source.messageId !== rootId ? { replyId: source.messageId } : {}),
        })
      }
    >
      {label}
    </Pressable>
  );
}

function CompactionDivider({ run }: { readonly run: RunEntry }): ReactNode {
  const scope = useContext(TaskScopeContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!run.compaction) return null;
  return (
    <View
      style={{
        paddingVertical: space[10],
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: color.lineStrong,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={compactionDisclosure}
        onPress={() => setOpen(!open)}
        style={{ minHeight: touchTarget, justifyContent: "center" }}
      >
        <AppText role="caption" tone="muted">
          {compactionLabel(run.compaction)}
        </AppText>
      </Pressable>
      {open ? (
        <AppText role="caption" tone="muted">
          {compactionDisclosure}
        </AppText>
      ) : null}
      {run.compaction.status === "running" && scope ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop summarizing conversation"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void scope.hostClient
              .stopRun(scope.threadId)
              .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Could not stop summary."),
              )
              .finally(() => setBusy(false));
          }}
          style={{ minHeight: touchTarget, justifyContent: "center" }}
        >
          <AppText role="caption">Stop</AppText>
        </Pressable>
      ) : null}
      {error ? <AppText role="caption">{error}</AppText> : null}
    </View>
  );
}
