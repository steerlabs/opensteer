import { presentClientIssue } from "@opensteer/client/feedback";
import type { TeamAskOwnerControl } from "@opensteer/client/team";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  pillHeight,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { MessageDelivery } from "../thread/message-delivery.js";
import { AppText } from "../ui/primitives.js";
import { MessageAttachments } from "./attachments.js";
import { MessageBody } from "./message-body.js";
import { AgentStatusCard } from "./status-card.js";
import type { StatusFace } from "./status-words.js";
import { AgentOrb, Avatar, FaceStack } from "./team-marks.js";
import type {
  AgentCardView,
  AskStatusView,
  MessageView,
  ThreadSummaryView,
} from "./team-models.js";

type AskDecision = Extract<TeamAskOwnerControl, { readonly kind: "decide" }>;

/** The face column every row shares, so names and words line up down the timeline. */
export const faceColumn = 36;
const faceGap = space[10];
/** Where a row's words start: rows without a face (continued, cards) indent to here. */
export const wordsInset = faceColumn + faceGap;

export interface MessageRowActions {
  readonly onHold: (messageId: string) => void;
  readonly onOpenAttachment: (messageId: string, attachmentId: string) => void;
  readonly onOpenThread: (rootId: string) => void;
  /** The owner's own agent reply: its private task. */
  readonly onOpenTask: (messageId: string) => void;
  readonly onUnsent: (messageId: string, choice: "edit" | "delete" | "retry") => void;
  /** The reader answers an ask of their own agent, as the teammate wrote it. */
  readonly onDecideAsk: (control: AskDecision, decision: "approve" | "decline") => Promise<void>;
  /** Opens the reader's task an ask waits in. */
  readonly onOpenAskTask: (threadId: string) => void;
}

/**
 * One message in a channel, a DM or a thread: a left-aligned row with its
 * author's face and name, its Markdown, its files and, under a root, the
 * thread's summary. Your own messages are rows too; a bubble is only for your
 * words inside your own task.
 *
 * Rows are rebuilt from the timeline on every change, so each redraws only
 * when its own id, version or send state does.
 */
export const MessageRow = memo(
  function MessageRow(props: {
    readonly actions: MessageRowActions;
    readonly message: MessageView;
  }): ReactNode {
    const { actions, message } = props;
    const agent = message.author.kind === "agent" ? message.author.agent : null;
    const person = message.author.kind === "person" ? message.author.person : agent!.owner;
    const name = agent?.byline ?? person.name;
    return (
      <Pressable
        accessibilityHint="Hold for actions"
        onLongPress={() => actions.onHold(message.id)}
        style={({ pressed }) => [
          styles.row,
          message.continued && styles.rowContinued,
          message.pinned && styles.pinned,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.gutter}>
          {message.continued ? null : <Avatar agent={agent !== null} person={person} size={36} />}
        </View>
        <View style={styles.main}>
          {message.continued ? null : (
            <View style={styles.head}>
              <AppText numberOfLines={1} role="secondaryMedium" style={styles.name}>
                {name}
              </AppText>
              {person.externalTeam ? (
                <AppText role="caption" tone="muted">
                  External · {person.externalTeam}
                </AppText>
              ) : null}
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                style={styles.time}
              >
                {message.time}
              </AppText>
            </View>
          )}
          <Delivery actions={actions} message={message}>
            <MessageBody mentions={message.mentions} text={message.text} />
          </Delivery>
          {message.edited ? (
            <AppText role="caption" tone="muted">
              (edited)
            </AppText>
          ) : null}
          <MessageAttachments
            attachments={message.attachments}
            onOpen={(attachmentId) => actions.onOpenAttachment(message.id, attachmentId)}
          />
          {message.send.kind === "retryable" ? (
            <View style={styles.unsent}>
              <TextAction label="Try again" onPress={() => actions.onUnsent(message.id, "retry")} />
            </View>
          ) : null}
          {message.askStatuses?.map((status) => (
            <AskStatus actions={actions} key={status.id} status={status} />
          ))}
          {message.agentRun === null ? null : (
            <View style={styles.runFoot}>
              <AppText role="caption" tone="muted">
                {message.agentRun.summary}
              </AppText>
              {agent?.mine === true ? (
                <TextAction label="Open task" onPress={() => actions.onOpenTask(message.id)} />
              ) : null}
            </View>
          )}
          {message.thread === null ? null : (
            <ThreadSummaryLine
              onPress={() => actions.onOpenThread(message.id)}
              summary={message.thread}
            />
          )}
        </View>
      </Pressable>
    );
  },
  (left, right) =>
    left.actions === right.actions &&
    left.message.id === right.message.id &&
    left.message.version === right.message.version &&
    JSON.stringify(left.message.askStatuses) === JSON.stringify(right.message.askStatuses) &&
    left.message.continued === right.message.continued &&
    left.message.send === right.message.send,
);

/**
 * Where an ask of someone's agent stands. Its owner answers here instead,
 * unless they already changed the task's copy, which only the task can show.
 */
function AskStatus(props: {
  readonly actions: MessageRowActions;
  readonly status: AskStatusView;
}): ReactNode {
  const { actions, status } = props;
  const { control } = status;
  if (control.kind === "decide")
    return <AskDecisionControl control={control} onDecide={actions.onDecideAsk} />;
  if (control.kind === "review-edited")
    return (
      <View style={styles.askLine}>
        <AppText role="caption" tone="muted">
          Edited
        </AppText>
        <TextAction label="Review" onPress={() => actions.onOpenAskTask(control.threadId)} />
      </View>
    );
  return (
    <AppText role="caption" tone="muted">
      {status.label}
    </AppText>
  );
}

/**
 * One plate split in two, the agent's orb on the side that sends it to work.
 * The faces are compact, as everything under a chat message is; each half
 * still takes a full touch.
 */
function AskDecisionControl(props: {
  readonly control: AskDecision;
  readonly onDecide: MessageRowActions["onDecideAsk"];
}): ReactNode {
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const decide = (decision: "approve" | "decline"): void => {
    if (pending !== null) return;
    setPending(decision);
    void props.onDecide(props.control, decision).finally(() => {
      if (mounted.current) setPending(null);
    });
  };
  return (
    <View style={styles.split}>
      <Pressable
        accessibilityHint="Your agent works on it on your computer and replies here"
        accessibilityRole="button"
        accessibilityState={{ busy: pending === "approve", disabled: pending !== null }}
        disabled={pending !== null}
        onPress={() => decide("approve")}
        style={styles.splitHit}
      >
        {({ pressed }) => (
          <View style={[styles.splitFace, styles.splitLead, pressed && styles.splitPressed]}>
            {pending === "approve" ? (
              <ActivityIndicator color={color.ember} size="small" style={styles.splitSpinner} />
            ) : (
              <AgentOrb size={14} />
            )}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={styles.splitGo}
            >
              Let my agent answer
            </AppText>
          </View>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: pending === "decline", disabled: pending !== null }}
        disabled={pending !== null}
        onPress={() => decide("decline")}
        style={styles.splitHit}
      >
        {({ pressed }) => (
          <View style={[styles.splitFace, styles.splitTrail, pressed && styles.splitPressed]}>
            {pending === "decline" ? (
              <ActivityIndicator color={color.muted} size="small" style={styles.splitSpinner} />
            ) : null}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={styles.splitNo}
            >
              Decline
            </AppText>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const unconfirmedMessage = presentClientIssue({
  code: "unconfirmed",
  happened: "your message was sent",
}).title;

/**
 * A message this phone still holds, drawn where the delivered one will stand,
 * through the team's own ordered delivery: waiting, sending, refused, or sent
 * with its answer lost.
 */
function Delivery(props: {
  readonly actions: MessageRowActions;
  readonly message: MessageView;
  readonly children: ReactNode;
}): ReactNode {
  const { actions, message } = props;
  const send = message.send;
  if (send.kind === "sent") return props.children;
  return (
    <MessageDelivery
      // The team's owner takes back only refused messages: a waiting one offers nothing.
      attempted
      copy={send.kind === "retryable" ? { waiting: unconfirmedMessage } : {}}
      onAction={(action) => actions.onUnsent(message.id, action === "edit" ? "edit" : "delete")}
      phase={send.kind === "failed" ? "rejected" : send.kind === "sending" ? "sending" : "waiting"}
      rejection={send.kind === "failed" ? `Not sent. ${send.reason}` : null}
      showStatus
      since={send.since}
    >
      {props.children}
    </MessageDelivery>
  );
}

function TextAction(props: { readonly label: string; readonly onPress: () => void }): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      hitSlop={{ bottom: 12, left: 8, right: 8, top: 12 }}
      onPress={props.onPress}
    >
      {({ pressed }) => (
        <AppText role="caption" style={[styles.textAction, pressed && styles.textActionPressed]}>
          {props.label}
        </AppText>
      )}
    </Pressable>
  );
}

/** Under a root: faces, the count, and the one live fact. Tapping opens the thread. */
export function ThreadSummaryLine(props: {
  readonly onPress: () => void;
  readonly summary: ThreadSummaryView;
}): ReactNode {
  const { summary } = props;
  const replies = summary.replyCount === 1 ? "1 reply" : `${summary.replyCount} replies`;
  return (
    <Pressable
      accessibilityHint="Opens the thread"
      accessibilityLabel={`${replies}. ${summary.fact}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.summary, pressed && styles.summaryPressed]}
    >
      <FaceStack faces={summary.faces} ground={color.background} size={18} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.replies}
      >
        {replies}
      </AppText>
      {summary.live ? (
        <ActivityIndicator color={color.ember} size="small" style={styles.spinner} />
      ) : null}
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={[styles.fact, factTone[summary.factTone]]}
      >
        {summary.fact}
      </AppText>
    </Pressable>
  );
}

/** An agent's live card, as a row by the agent: its owner's face with the orb, its byline, the card. */
export const AgentCardRow = memo(function AgentCardRow(props: {
  readonly card: AgentCardView;
  readonly onAction: (requestId: string, action: NonNullable<StatusFace["action"]>["kind"]) => void;
  readonly onOpenTask: (requestId: string) => void;
}): ReactNode {
  const { card } = props;
  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <Avatar agent person={card.agent.owner} size={36} />
      </View>
      <View style={styles.main}>
        <AppText numberOfLines={1} role="secondaryMedium" style={styles.name}>
          {card.agent.byline}
        </AppText>
        <AgentStatusCard card={card} onAction={props.onAction} onOpenTask={props.onOpenTask} />
      </View>
    </View>
  );
});

export function DayPill(props: { readonly label: string }): ReactNode {
  return (
    <View accessibilityRole="header" style={styles.day}>
      <View style={styles.dayRule} />
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.dayLabel}>
        {props.label}
      </AppText>
      <View style={styles.dayRule} />
    </View>
  );
}

/** Where the reader's unread messages start. It stays until they leave. */
export function NewLine(): ReactNode {
  return (
    <View accessibilityLabel="New messages" accessible style={styles.newLine}>
      <View style={styles.newRule} />
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.newLabel}>
        NEW
      </AppText>
    </View>
  );
}

export function SystemLine(props: { readonly text: string }): ReactNode {
  return (
    <AppText role="caption" style={styles.system} tone="muted">
      {props.text}
    </AppText>
  );
}

/**
 * What a long press on a message offers, in order. There is no Mark unread:
 * a channel's read point only moves forward.
 */
export function messageActions(input: {
  readonly canAskAgent: boolean;
  readonly canModerate: boolean;
  /** Edits are written in the composer, which is closed where the reader can't post. */
  readonly canPost: boolean;
  readonly inThread: boolean;
  readonly message: MessageView;
}): readonly {
  readonly id: MessageActionId;
  readonly title: string;
  readonly destructive?: true;
}[] {
  const { message } = input;
  const own = message.author.kind === "person" && message.author.mine;
  return [
    ...(input.inThread ? [] : [{ id: "reply" as const, title: "Reply in thread" }]),
    ...(input.canAskAgent ? [{ id: "ask" as const, title: "Ask my agent" }] : []),
    {
      id: message.pinned ? ("unpin" as const) : ("pin" as const),
      title: message.pinned ? "Unpin" : "Pin",
    },
    { id: "copy-link" as const, title: "Copy link" },
    ...(own && input.canPost ? [{ id: "edit" as const, title: "Edit" }] : []),
    ...(own || input.canModerate
      ? [{ destructive: true as const, id: "delete" as const, title: "Delete" }]
      : []),
  ];
}

export type MessageActionId = "reply" | "ask" | "pin" | "unpin" | "copy-link" | "edit" | "delete";

const factTone = StyleSheet.create({
  amber: { color: color.amber },
  ember: { color: color.ember },
  muted: { color: color.muted },
});

const styles = StyleSheet.create({
  askLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget - 8,
  },
  // Under the words, at the touch's full height; the faces are drawn inside it.
  split: { alignSelf: "flex-start", flexDirection: "row", marginTop: 2 },
  splitFace: {
    ...material.plate,
    alignItems: "center",
    borderColor: color.lineStrong,
    flexDirection: "row",
    gap: space[6],
    minHeight: pillHeight,
    paddingHorizontal: space[10] + 1,
  },
  splitGo: { color: color.text, fontWeight: "600" },
  splitHit: { justifyContent: "center", minHeight: touchTarget },
  // The two halves meet in one rule, the plate's own edge.
  splitLead: {
    borderBottomLeftRadius: radius.sm,
    borderRightWidth: 0,
    borderTopLeftRadius: radius.sm,
  },
  splitNo: { color: color.textSoft, fontWeight: "500" },
  splitPressed: { backgroundColor: material.selected.backgroundColor },
  splitSpinner: { height: 14, transform: [{ scale: 0.7 }], width: 14 },
  splitTrail: {
    borderBottomRightRadius: radius.sm,
    borderTopRightRadius: radius.sm,
  },
  day: { alignItems: "center", flexDirection: "row", gap: space[10], paddingVertical: space[12] },
  dayLabel: { color: color.muted, fontWeight: "600" },
  dayRule: { backgroundColor: color.line, flex: 1, height: StyleSheet.hairlineWidth },
  fact: { flexShrink: 1 },
  gutter: { width: faceColumn },
  head: { alignItems: "baseline", flexDirection: "row", gap: space[8] },
  main: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: color.text, flexShrink: 1, fontWeight: "600" },
  newLabel: { color: color.ember, fontWeight: "700", letterSpacing: 0.6 },
  newLine: { alignItems: "center", flexDirection: "row", gap: space[8], paddingVertical: space[6] },
  newRule: { backgroundColor: color.emberLine, flex: 1, height: 1 },
  // The edge takes two points of the row's own inset, so the words stay put.
  pinned: { borderLeftColor: color.amber, borderLeftWidth: 2, paddingLeft: space[12] },
  pressed: { backgroundColor: "rgba(255, 255, 255, 0.03)" },
  // The count reads whole; the fact beside it gives way.
  replies: { color: color.ember, flexShrink: 0, fontWeight: "700" },
  row: {
    flexDirection: "row",
    gap: faceGap,
    paddingHorizontal: space[14],
    paddingTop: space[10],
  },
  rowContinued: { paddingTop: 2 },
  runFoot: { alignItems: "center", flexDirection: "row", gap: space[12], marginTop: space[4] },
  spinner: { transform: [{ scale: 0.7 }] },
  summary: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    marginLeft: -space[6],
    marginTop: space[4],
    maxWidth: "100%",
    minHeight: touchTarget - 8,
    paddingHorizontal: space[6],
  },
  summaryPressed: { ...material.quiet },
  system: { paddingVertical: space[8], textAlign: "center" },
  textAction: { color: color.ember, fontWeight: "600" },
  textActionPressed: { opacity: 0.6 },
  time: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  unsent: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[12],
    marginTop: 2,
  },
});
