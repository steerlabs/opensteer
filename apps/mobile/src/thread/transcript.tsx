import {
  type AskAbout,
  incomingMessageAction,
  activityStepHead,
  conversationActivities,
  conversationTurn,
  formatClockTime,
  formatElapsed,
  hasRunOutcome,
  silentRunLabel,
  incomingMessagePreview,
  messageAuthorName,
  messageFoldLines,
  turnFolds,
  turnState,
  workRows,
  workSummary,
  type ActivityIcon,
  type ActivityStepHead,
  type ActivityTone,
  type MessageEntry,
  type ReasoningEntry,
  type RunEntry,
  type SelectionEntry,
  type ThreadActivityIndicator,
  type TranscriptGroup,
  type Turn,
  type WorkEntry,
  type WorkRow,
  type WorkSummary,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { Markdown, PlainProse } from "../markdown/markdown.js";
import { color, radius, space, touchTarget, type } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { AppText, StatusDot, TypingDots, monoFontFamily } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { AssignmentLines, DelegationLine } from "./task-line.js";
import { MessageAttachments } from "./attachment-views.js";
import { ComputerUseLine, KeptComputerStopLine, useComputerLine } from "./computer-use-line.js";
import { MessageMenu } from "./message-menu.js";
import { MessagePages, ReplySurfaces } from "./surface-chips.js";

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
  readonly group: TranscriptGroup;
  readonly live?: boolean;
  /**
   * Whether the reader opened this row: a turn's folded steps, or a message's
   * folded words. The pane holds it, because the list unmounts rows scrolled
   * far away and brings them back.
   */
  readonly open: boolean;
  readonly onToggleOpen: (rowKey: string) => void;
  readonly highlightRequestId: string | null;
  /** Opens one step's detail. */
  readonly onOpenStep: (entryId: string) => void;
  /** Opens another Thread this one points at: a delegation, or an agent's message. */
  readonly onOpenThread: (threadId: string) => void;
  /** Given, every update another agent published offers it. */
  readonly askAbout?: AskAbout | undefined;
  /** Names the engine behind a recorded selection; without it the model alone. */
  readonly engineName?: ((harnessInstanceId: string) => string | null) | undefined;
  /** The air above this row: a turn's own rows sit closer than two turns do. */
  readonly spacingTop: number;
  /** True for the first row holding something published since the reader's last visit. */
  readonly unreadBoundary?: boolean;
  /** The reader's own Home, which its messages name as Home rather than as whose it is. */
  readonly homeThreadId: string | null;
  readonly viewerUserId: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}): ReactNode {
  const { group } = props;
  return (
    <View style={{ marginTop: props.spacingTop }}>
      {props.unreadBoundary === true && props.conversation !== true ? <UnreadDivider /> : null}
      {group.kind === "turn" ? (
        props.conversation === true ? (
          <ConversationTurn
            activityKey={props.activityKey ?? null}
            live={props.live ?? true}
            onOpenActivity={props.onOpenActivity}
            onOpenReplyUnderWay={props.onOpenReplyUnderWay}
            onReply={props.onReply}
            onOpenThread={props.onOpenThread}
            workspaces={props.workspaces}
            homeThreadId={props.homeThreadId}
            turn={group.turn}
            turnKey={group.key}
          />
        ) : (
          <TurnView
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
        <AssignmentLines entries={[group.entry]} />
      ) : group.kind === "delegation" ? (
        <DelegationLine delegation={group.entry} onOpenThread={props.onOpenThread} />
      ) : group.kind === "selection" ? (
        <SelectionMarker
          engineName={props.engineName?.(group.entry.harnessInstanceId) ?? null}
          entry={group.entry}
        />
      ) : (
        <Message
          conversation={props.conversation === true}
          homeThreadId={props.homeThreadId}
          onReply={props.onReply}
          onToggle={() => props.onToggleOpen(group.key)}
          open={props.open}
          message={group.entry}
          askAbout={props.askAbout}
          onOpenThread={props.onOpenThread}
          viewerUserId={props.viewerUserId}
          workspaces={props.workspaces}
        />
      )}
    </View>
  );
});

/**
 * Which of the transcript's three voices a group speaks in.
 *
 * The reader's own messages, an input arriving from elsewhere, and the agent's
 * own work are the three things a thread interleaves, and the gap between two
 * rows is the cheapest way to say whether they belong to one turn or to two.
 */
export type TranscriptVoice = "agent" | "input" | "mine";

export function transcriptVoice(
  group: TranscriptGroup,
  viewerUserId: string | null,
): TranscriptVoice {
  if (group.kind !== "message") return "agent";
  const message = group.entry;
  if (message.messageKind === "assistant") return "agent";
  return message.author.kind === "human" && message.author.userId === viewerUserId
    ? "mine"
    : "input";
}

/** The air above a row, given what spoke before it. */
export function transcriptSpacing(previous: TranscriptVoice | null, next: TranscriptVoice): number {
  if (previous === null) return 0;
  return previous === next ? space[6] : space[16];
}

/* ---- A turn ---- */

function TurnView(props: {
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly onToggle: (turnKey: string) => void;
  readonly open: boolean;
  readonly turn: Turn;
  readonly turnKey: string;
  readonly live?: boolean;
}): ReactNode {
  const { onToggle, turn, turnKey } = props;
  const folds = useMemo(() => turnFolds(turn), [turn]);
  return (
    <View style={styles.turn}>
      <TurnContent
        {...(folds ? { fold: { onToggle: () => onToggle(turnKey), open: props.open } } : {})}
        highlightRequestId={props.highlightRequestId}
        onOpenStep={props.onOpenStep}
        turn={turn}
        live={props.live ?? true}
      />
      {/* A Run split by a message that joined it shows its pages once, on its latest stretch. */}
      {turn.continued === true ? null : <ReplySurfaces turn={turn} turnKey={props.turnKey} />}
      <AssignmentLines entries={turn.assignments} />
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
  if (line?.kind === "now")
    return <ComputerUseLine key={line.now.session.sessionId} now={line.now} />;
  if (line?.kind === "kept")
    return <KeptComputerStopLine key={line.stop.sessionId} stop={line.stop} />;
  const content = (
    <>
      {unsettled ? (
        <StatusDot live={live} tone={summary.state === "waiting" ? "amber" : "muted"} />
      ) : null}
      <View style={styles.headText}>
        <AppText
          {...(live ? { accessibilityLabel: `${label}, in progress` } : {})}
          numberOfLines={1}
          role="secondaryMedium"
          tone="soft"
        >
          {label}
        </AppText>
        {unsettled || summary.meta === "" ? null : (
          <AppText numberOfLines={1} role="caption" style={styles.headMeta} tone="muted">
            {summary.meta}
          </AppText>
        )}
      </View>
      {summary.errors > 0 && !unsettled ? <ErrorCount count={summary.errors} /> : null}
      {live && summary.startedAt !== null ? <LiveClock startedAt={summary.startedAt} /> : null}
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
  readonly onOpenThread: (threadId: string) => void;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly homeThreadId: string | null;
  readonly activityKey: string | null;
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
  const onActivity =
    activityKey === null || onOpenActivity === undefined
      ? undefined
      : () => onOpenActivity(activityKey);
  const outcome =
    turn.personWaiting !== false &&
    turn.run !== null &&
    (hasRunOutcome(turn.run) || restarted(turn.run)) ? (
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
      {line?.kind === "now" ? (
        <ComputerUseLine key={line.now.session.sessionId} now={line.now} />
      ) : line?.kind === "kept" ? (
        <KeptComputerStopLine key={line.stop.sessionId} stop={line.stop} />
      ) : null}
      {view.reply !== null && turn.source ? (
        <TurnSource
          source={turn.source}
          onOpenThread={props.onOpenThread}
          workspaces={props.workspaces}
          homeThreadId={props.homeThreadId}
        />
      ) : null}
      {view.reply !== null ? (
        <ReplyBubble
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
      {/* The pages and apps the reply under way is using; a reply carries its own.
          Under a Mac line, its app's chip is the way to the app. */}
      {view.reply === null && (composing || line !== null) ? (
        <ReplySurfaces turn={turn} turnKey={props.turnKey} />
      ) : null}
      {/* Typing alone would not say the reader's steered message is why it began again. */}
      {composing && restarting(turn.run) ? (
        <Animated.View accessibilityLiveRegion="polite" entering={appear}>
          <AppText role="caption" tone="muted">
            {restartingLabel}
          </AppText>
        </Animated.View>
      ) : null}
      <AssignmentLines entries={turn.assignments} />
      {/* A turn that ended without a reply says how, and its Activity opens
          from that line's menu as a reply's would. */}
      {outcome !== null && view.reply === null && onActivity !== undefined ? (
        <View style={styles.outcomeRow}>
          <View style={styles.outcome}>{outcome}</View>
          <MessageMenu onActivity={onActivity} text="" />
        </View>
      ) : (
        outcome
      )}
    </View>
  );
}

/**
 * Opensteer's reply: a message, with what can be done with it in its menu,
 * and under it the pages and apps its Run used.
 */
function ReplyBubble(props: {
  readonly turn?: Turn;
  readonly turnKey: string | null;
  readonly message: MessageEntry;
  readonly onActivity?: (() => void) | undefined;
  readonly onReply: ((message: MessageEntry) => void) | undefined;
}): ReactNode {
  const { message } = props;
  return (
    <View style={styles.replyColumn}>
      <View style={styles.replyRow}>
        <View style={styles.reply}>
          {message.body ? <Markdown text={message.body} /> : null}
          <MessageAttachments attachments={message.attachments ?? []} />
        </View>
        {message.body || props.onActivity !== undefined ? (
          <MessageMenu
            onActivity={props.onActivity}
            onReply={props.onReply ? () => props.onReply?.(message) : undefined}
            text={message.body}
          />
        ) : null}
      </View>
      <ReplySurfaces
        turn={props.turn ?? { runId: message.runId, work: [], subagentWork: {} }}
        turnKey={props.turnKey}
      />
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
      entering={appear}
      style={styles.typingRow}
    >
      {props.onPress === undefined ? (
        <View style={styles.typing}>
          <TypingDots />
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
          <TypingDots />
        </Pressable>
      )}
    </Animated.View>
  );
}

/**
 * Everything a reply did on the way to it, in the order it happened, drawn
 * with the rows a task's transcript uses: the body of its Activity.
 */
export function ConversationSteps(props: {
  readonly entries: readonly WorkEntry[];
  readonly highlightRequestId: string | null;
  readonly live: boolean;
  readonly onOpenStep: (entryId: string) => void;
  readonly turn: Turn;
}): ReactNode {
  return (
    <View style={styles.steps}>
      <TurnContent
        entries={props.entries}
        highlightRequestId={props.highlightRequestId}
        live={props.live}
        onOpenStep={props.onOpenStep}
        status={false}
        turn={props.turn}
      />
    </View>
  );
}

function TurnContent(props: {
  /** What of the turn to draw; all of its work unless a conversation keeps its reply apart. */
  readonly entries?: readonly WorkEntry[];
  /** Given, the turn's steps fold behind its status line, which opens and closes them (`turnFolds`). */
  readonly fold?: { readonly onToggle: () => void; readonly open: boolean };
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  /** Whether the stream ends with its status line; a conversation's steps have none. */
  readonly status?: boolean;
  readonly turn: Turn;
  readonly live: boolean;
}): ReactNode {
  const active = turnState(props.turn) !== "settled";
  const status = props.status !== false;
  const work = props.entries ?? props.turn.work;
  const { reply } = props.turn;
  const summary = useMemo(() => (status ? workSummary(props.turn) : null), [status, props.turn]);
  // Closed, the reply is the turn's one row and its steps are not mounted at
  // all, which is what keeps a long night of turns light to scroll.
  const closed = props.fold?.open === false && reply !== null;
  const rows = useMemo(
    () => [
      ...workRows(closed ? [reply] : work),
      ...(summary === null ? [] : [{ kind: "status" as const, key: "status", summary }]),
    ],
    [work, closed, reply, summary],
  );
  const { fold } = props;
  return rows.map((row) => {
    if (row.kind === "status") {
      return (
        <WorkStatus
          key={row.key}
          summary={row.summary}
          turn={props.turn}
          live={props.live}
          {...(fold === undefined ? {} : fold)}
        />
      );
    }
    const view = (
      <WorkRowView
        active={active}
        highlightRequestId={props.highlightRequestId}
        key={row.key}
        onOpenStep={props.onOpenStep}
        row={row}
        subagentWork={props.turn.subagentWork}
      />
    );
    // A folding turn's steps come and go as any opened row's do; its reply stays put.
    return fold === undefined || (row.kind === "note" && row.entry === reply) ? (
      view
    ) : (
      <Animated.View entering={appear} exiting={exit} key={row.key}>
        {view}
      </Animated.View>
    );
  });
}

/** One row of a turn's work, or of a subagent's inside it. */
function WorkRowView(props: {
  readonly active: boolean;
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly row: WorkRow;
  readonly subagentWork: Turn["subagentWork"];
}): ReactNode {
  const { row } = props;
  switch (row.kind) {
    case "note":
      return <AssistantMessage message={row.entry} />;
    case "reasoning":
      return <ReasoningRow active={props.active} reasoning={row.entry} />;
    case "subagent":
      return (
        <SubagentRow
          highlightRequestId={props.highlightRequestId}
          onOpenStep={props.onOpenStep}
          row={row}
          subagentWork={props.subagentWork}
        />
      );
    case "steps":
      return (
        <StepsRow
          highlightRequestId={props.highlightRequestId}
          onOpenStep={props.onOpenStep}
          row={row}
        />
      );
  }
}

const noWork: readonly WorkEntry[] = [];

/**
 * A subagent the agent started, standing where it started. Its head reads as a
 * step's does; opened, it says what it was asked, draws its own steps with the
 * turn's rows — a subagent it started in turn included — and what it returned.
 */
function SubagentRow(props: {
  readonly highlightRequestId: string | null;
  readonly onOpenStep: (entryId: string) => void;
  readonly row: Extract<WorkRow, { kind: "subagent" }>;
  readonly subagentWork: Turn["subagentWork"];
}): ReactNode {
  const { entry: node, head } = props.row;
  const [open, setOpen] = useState(false);
  const work = props.subagentWork[node.nodeId] ?? noWork;
  const rows = useMemo(() => workRows(work), [work]);
  return (
    <View>
      <StepHead expanded={open} head={head} highlighted={false} onPress={() => setOpen(!open)} />
      {open ? (
        <Animated.View entering={appear} exiting={exit} style={styles.subagent}>
          {node.prompt ? (
            <AppText numberOfLines={3} role="secondary" tone="muted">
              {node.prompt}
            </AppText>
          ) : null}
          {rows.map((row) => (
            <WorkRowView
              active={node.status === "running"}
              highlightRequestId={props.highlightRequestId}
              key={row.key}
              onOpenStep={props.onOpenStep}
              row={row}
              subagentWork={props.subagentWork}
            />
          ))}
          {node.result ? (
            <View style={styles.subagentResult}>
              <AppText role="caption" tone="muted">
                Result
              </AppText>
              <Markdown text={node.result} />
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

function StepsRow(props: {
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
        highlighted={false}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <Animated.View entering={appear} exiting={exit} style={styles.lines}>
          {row.entries.map((entry) => (
            <StepHead
              compact
              head={activityStepHead(entry)}
              highlighted={entry.kind === "request" && entry.requestId === props.highlightRequestId}
              key={entry.id}
              {...(entry.kind === "request" ? {} : { onPress: () => props.onOpenStep(entry.id) })}
            />
          ))}
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
  readonly expanded?: boolean;
  readonly head: ActivityStepHead;
  readonly highlighted: boolean;
  readonly onPress?: () => void;
}): ReactNode {
  const { head } = props;
  const content = (
    <>
      <View style={styles.icon}>
        <Symbol
          name={props.compact === true ? toneSymbol(head) : iconSymbol[head.icon]}
          size={props.compact === true ? 12 : 14}
          tint={toneColor(head.tone)}
          weight="medium"
        />
      </View>
      <View style={styles.stepText}>
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
        <AppText role="caption" style={styles.figures} tone="muted">
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
    styles.step,
    props.compact === true && styles.stepCompact,
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
      style={({ pressed }) => [...style, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function ErrorCount(props: { readonly count: number }): ReactNode {
  return (
    <AppText role="caption" style={styles.errors}>
      {props.count === 1 ? "1 error" : `${props.count} errors`}
    </AppText>
  );
}

/** Seconds since the turn began, redrawn once a second and nothing else with it. */
function LiveClock(props: { readonly startedAt: string }): ReactNode {
  const started = Date.parse(props.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(started)) return null;
  return (
    <AppText role="caption" style={styles.figures} tone="muted">
      {formatElapsed(now - started)}
    </AppText>
  );
}

const iconSymbol: Record<ActivityIcon, SFSymbolName> = {
  "alert-circle": "exclamationmark.circle",
  asterisk: "lightbulb",
  browser: "safari",
  "check-circle": "checkmark.circle",
  file: "doc.text",
  folder: "folder",
  globe: "globe",
  laptop: "laptopcomputer",
  list: "list.bullet",
  pencil: "pencil",
  puzzle: "puzzlepiece.extension",
  search: "magnifyingglass",
  share: "arrow.triangle.branch",
  sparkles: "sparkles",
  stop: "stop.circle",
  terminal: "terminal",
};

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

function AssistantMessage(props: { readonly message: MessageEntry }): ReactNode {
  return (
    // No bubble, and the full measure: an agent's turn is long markdown with
    // headings, lists and code in it, and a bubble around that is a column
    // narrowed for nothing. The side it sits on is what says who wrote it.
    <View style={styles.assistant}>
      {props.message.body ? <Markdown text={props.message.body} /> : null}
      <MessageAttachments attachments={props.message.attachments ?? []} />
      {props.message.streaming === true || !props.message.body ? null : (
        <MessageMenu text={props.message.body} />
      )}
    </View>
  );
}

/**
 * Where the reader's last visit ended. Its position comes from the sequence the
 * Host recorded, not a count of rows, which lands on the wrong row as soon as
 * own messages or a mid-conversation window are in play.
 */
function UnreadDivider(): ReactNode {
  return (
    <View accessibilityRole="text" style={styles.unread}>
      <View style={styles.unreadRule} />
      <AppText role="caption" tone="ember">
        New
      </AppText>
      <View style={styles.unreadRule} />
    </View>
  );
}

/** The first group holding a message published past the reader's saved position. */
export function firstUnreadGroupKey(
  groups: readonly TranscriptGroup[],
  boundarySequence: string | null,
): string | null {
  if (boundarySequence === null) return null;
  const boundary = BigInt(boundarySequence);
  const unread = (entry: { kind: string; sequence?: string | undefined }): boolean =>
    entry.kind === "message" && entry.sequence !== undefined && BigInt(entry.sequence) > boundary;
  for (const group of groups) {
    const found = group.kind === "turn" ? group.turn.work.some(unread) : unread(group.entry);
    if (found) return group.key;
  }
  return null;
}

/**
 * A recorded change of the AI running this conversation.
 *
 * A platform event, not a message: it claims no startup, no catching up and
 * nothing carried over, and it never rewrites what came before it.
 */
function SelectionMarker(props: {
  readonly engineName: string | null;
  readonly entry: SelectionEntry;
}): ReactNode {
  const { entry } = props;
  return (
    <View accessibilityRole="text" style={styles.selectionMarker}>
      <AppText role="caption" tone="muted">
        {props.engineName === null
          ? `Switched to ${entry.modelSelection.modelId}`
          : `Switched to ${entry.modelSelection.modelId} on ${props.engineName}`}
      </AppText>
      <AppText role="caption" tone="muted">
        {formatClockTime(entry.createdAt)}
      </AppText>
    </View>
  );
}

function Message(props: {
  readonly conversation: boolean;
  readonly homeThreadId: string | null;
  readonly onReply: ((message: MessageEntry) => void) | undefined;
  readonly message: MessageEntry;
  readonly askAbout?: AskAbout | undefined;
  /** Whether the reader opened the folded words, which the pane keeps across scrolling. */
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly viewerUserId: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}): ReactNode {
  const { message, open } = props;
  const preview = useMemo(() => incomingMessagePreview(message), [message]);
  const body = preview.truncated && !open ? preview.text : message.body;
  if (message.messageKind === "assistant") {
    return props.conversation ? (
      <ReplyBubble message={message} onReply={props.onReply} turnKey={null} />
    ) : (
      <AssistantMessage message={message} />
    );
  }

  const author = message.author;
  if (
    (props.conversation && author.kind !== "human") ||
    (author.kind === "platform" && author.cause === "run-recovery")
  ) {
    return (
      <UpdateLine
        author={author}
        homeThreadId={props.homeThreadId}
        message={message}
        askAbout={props.askAbout}
        onOpenThread={props.onOpenThread}
        onToggle={props.onToggle}
        open={props.open}
        workspaces={props.workspaces}
      />
    );
  }
  const mine = author.kind === "human" && author.userId === props.viewerUserId;
  const update = props.conversation && !mine;
  const workspace =
    author.kind === "agent"
      ? (props.workspaces.find(({ id }) => id === author.workspaceId) ?? null)
      : null;

  return (
    <View style={update ? styles.updateColumn : styles.inputColumn}>
      {mine ? null : (
        <Attribution
          createdAt={message.createdAt}
          name={messageAuthorName(author, message.messageKind, props.homeThreadId)}
          // Only a Thread the reader can open is a way there: someone else's
          // Chat, behind a Workspace they are not in, is named and left at that.
          {...(author.kind === "agent" && workspace !== null
            ? { onOpen: () => props.onOpenThread(author.threadId) }
            : {})}
          {...(workspace === null ? {} : { workspace })}
        />
      )}
      <MessagePages pages={message.pages ?? []} />
      <MessageAttachments attachments={message.attachments ?? []} />
      {message.body ? (
        <View
          style={
            update
              ? styles.updateBody
              : [styles.bubble, mine ? styles.bubbleMine : styles.bubbleInput]
          }
        >
          <MessageFold
            lines={messageFoldLines(message, props.viewerUserId)}
            mine={mine}
            more={preview.truncated}
            onToggle={props.onToggle}
            open={open}
          >
            {/* Only an agent or a trigger writes Markdown into a Thread; a person
                typed exactly what is shown, so it is shown exactly. */}
            {author.kind === "human" ? (
              <PlainProse text={message.body} tone={mine ? "bubble" : "default"} />
            ) : (
              <Markdown text={body} />
            )}
          </MessageFold>
        </View>
      ) : null}
      {message.delivery ? (
        <View accessibilityRole="alert" style={styles.failure}>
          <AppText role="secondaryMedium" tone="danger">
            {message.delivery.reason}
          </AppText>
        </View>
      ) : null}
      {props.askAbout !== undefined &&
      author.kind === "agent" &&
      message.body !== "" &&
      (!update || open || !preview.truncated) ? (
        <Pressable
          accessibilityHint="Quotes this update into Chat without sending"
          accessibilityRole="button"
          onPress={() => props.askAbout?.quote(message)}
          style={styles.askAbout}
        >
          <AppText role="secondaryMedium" tone="ember">
            {props.askAbout.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
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
          style={styles.askAbout}
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

type UpdateAuthor = Exclude<MessageEntry["author"], { readonly kind: "human" }>;

/** Why Opensteer spoke unprompted: what woke the turn, above its reply. */
function TurnSource(props: {
  readonly source: NonNullable<Turn["source"]>;
  readonly onOpenThread: (threadId: string) => void;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly homeThreadId: string | null;
}): ReactNode {
  const { author, task, createdAt } = props.source;
  const name = task?.workerThread.title ?? messageAuthorName(author, "input", props.homeThreadId);
  const threadId =
    task?.workerThread.id ??
    (author.kind === "agent" && props.workspaces.some(({ id }) => id === author.workspaceId)
      ? author.threadId
      : null);
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

/**
 * In a conversation, what another agent or an automation sent its agent: one
 * line saying who, and whether it was left for later or is work now, opening
 * in place to what was said. The conversation stays between the reader and the
 * agent they are talking to.
 */
function UpdateLine(props: {
  readonly author: UpdateAuthor;
  readonly homeThreadId: string | null;
  readonly message: MessageEntry;
  readonly askAbout?: AskAbout | undefined;
  readonly onOpenThread: (threadId: string) => void;
  /** Whether the reader opened it, which the pane keeps across scrolling. */
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly workspaces: readonly WorkspaceSummary[];
}): ReactNode {
  const { author, message, open } = props;
  const said = incomingMessageAction(message);
  const name = messageAuthorName(author, message.messageKind, props.homeThreadId);
  // Only a Thread the reader can open is a way there. A trigger's own page is a
  // computer-sized screen this app does not have, so a trigger is named only.
  const onOpen =
    author.kind === "agent" && props.workspaces.some(({ id }) => id === author.workspaceId)
      ? () => props.onOpenThread(author.threadId)
      : undefined;
  return (
    <View style={styles.updateLine}>
      <View style={styles.updateLineHead}>
        <Symbol
          name={author.kind === "trigger" || author.kind === "watch" ? "bolt" : "bubble.left"}
          size={13}
          tint={color.muted}
        />
        {onOpen === undefined ? (
          <AppText numberOfLines={1} role="caption" style={styles.updateLineSource} tone="soft">
            {name}
          </AppText>
        ) : (
          <Pressable
            accessibilityHint="Opens the thread this came from"
            accessibilityRole="link"
            onPress={onOpen}
            style={styles.updateLineSourcePress}
          >
            <AppText numberOfLines={1} role="caption" tone="soft">
              {name}
            </AppText>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={props.onToggle}
          style={styles.updateLineToggle}
        >
          <AppText role="caption" tone="muted">
            {said}
          </AppText>
          <AppText role="caption" style={styles.figures} tone="muted">
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
          {props.askAbout !== undefined && author.kind === "agent" && message.body !== "" ? (
            <Pressable
              accessibilityHint="Quotes this update into Chat without sending"
              accessibilityRole="button"
              onPress={() => props.askAbout?.quote(message)}
              style={styles.askAbout}
            >
              <AppText role="secondaryMedium" tone="ember">
                {props.askAbout.label}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Who sent an input this reader did not, and — when it was another Thread's
 * agent — the way to that Thread. A trigger's own page is a computer-sized
 * screen this app does not have, so a trigger is named and not linked.
 */
function Attribution(props: {
  readonly createdAt: string;
  readonly name: string;
  readonly onOpen?: () => void;
  readonly workspace?: {
    readonly kind: WorkspaceSummary["kind"];
    readonly icon: WorkspaceSummary["icon"];
    readonly name: string;
    readonly color: WorkspaceSummary["color"];
  };
}): ReactNode {
  const content = (
    <>
      {props.workspace === undefined ? null : props.workspace.kind === "main" ? (
        <ChatOrb size={16} />
      ) : (
        <WorkspaceMark
          icon={props.workspace.icon}
          name={props.workspace.name}
          size="small"
          color={props.workspace.color}
        />
      )}
      <AppText
        role="caption"
        style={{ flexShrink: 1 }}
        tone={props.onOpen === undefined ? "muted" : "emberDim"}
      >
        {props.name}
      </AppText>
      <AppText role="caption" tone="muted">
        {formatClockTime(props.createdAt)}
      </AppText>
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
  askAbout: { justifyContent: "center", minHeight: touchTarget, paddingTop: space[4] },
  unread: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingBottom: space[8],
    paddingTop: space[4],
  },
  unreadRule: { backgroundColor: color.emberLine, flex: 1, height: 1 },
  selectionMarker: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    paddingVertical: space[8],
  },
  assistant: { gap: space[2] },
  /** Opensteer's side of a conversation: the same bubble as the reader's, from the other side. */
  reply: {
    backgroundColor: color.surfaceElevated,
    borderBottomStartRadius: radius.xs,
    borderColor: color.line,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    gap: space[4],
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  replyColumn: { gap: space[6] },
  replyRow: {
    alignItems: "flex-end",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[2],
    maxWidth: "92%",
  },
  steps: { gap: space[4] },
  /** A turn's outcome and the menu that opens its Activity, on one line. */
  outcomeRow: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[2],
  },
  outcome: { flexShrink: 1, gap: space[4] },
  typing: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.surfaceElevated,
    borderBottomStartRadius: radius.xs,
    borderColor: color.line,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    height: 40,
    justifyContent: "center",
    paddingHorizontal: space[16],
  },
  typingPressed: { backgroundColor: color.surfacePressed },
  typingRow: { alignSelf: "flex-start", flexDirection: "row" },

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
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  /**
   * The reader's own words, in the accent. It is the one filled shape in the
   * transcript, because the one thing a person scanning a long thread looks for
   * is what they asked — and here, where an agent's message, a trigger and
   * another thread all arrive on the same side, a neutral fill would leave
   * nothing that finds itself.
   */
  bubbleMine: { backgroundColor: color.bubble },
  bubbleInk: { color: color.bubbleInk },
  bubbleInput: { backgroundColor: color.surfaceElevated },
  /** Another Thread's result is the one framed thing among the agent's rows: it came from elsewhere. */
  card: {
    backgroundColor: color.assistantSurface,
    borderRadius: radius.md,
    paddingHorizontal: space[8],
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
  figures: { fontVariant: ["tabular-nums"] },
  // `scroll`, not `hidden`: layout leaves a scrolling box's words their whole
  // height, so they measure all they hold, and the box still clips them.
  fold: { overflow: "scroll" },
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
  headMeta: { flexShrink: 1 },
  headText: { alignItems: "baseline", flexDirection: "row", flexShrink: 1, gap: space[8] },
  highlighted: { backgroundColor: color.emberWash },
  icon: { alignItems: "center", width: space[20] },
  inputColumn: { alignItems: "flex-end", alignSelf: "flex-end", gap: space[4], maxWidth: "82%" },
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
  updateLineSourcePress: { flexShrink: 1, justifyContent: "center", minHeight: touchTarget },
  updateLineToggle: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 0,
    gap: space[6],
    minHeight: touchTarget,
  },
  inputFrom: { alignItems: "center", flexDirection: "row", gap: space[6], minHeight: touchTarget },
  /** A row's own steps hang off a hairline under its glyph. */
  lines: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: StyleSheet.hairlineWidth,
    marginLeft: space[10],
    paddingLeft: space[4],
  },
  openThread: { justifyContent: "center", minHeight: touchTarget, paddingLeft: space[28] },
  pressed: { backgroundColor: color.surface },
  step: {
    alignItems: "center",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    marginHorizontal: -space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[8],
    paddingVertical: space[4],
  },
  stepCompact: { marginHorizontal: 0 },
  stepText: { flex: 1, gap: space[2] },
  /** A subagent's work hangs off a hairline under its glyph, as a row's steps do. */
  subagent: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    marginLeft: space[10],
    paddingBottom: space[8],
    paddingLeft: space[12],
  },
  subagentResult: { gap: space[2] },
  thought: { paddingBottom: space[8], paddingLeft: space[28], paddingRight: space[8] },
  turn: { gap: space[4] },
  working: { alignItems: "center", flexDirection: "row", gap: space[8], minHeight: touchTarget },
});
