import { memo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { MessageAttachments } from "./attachments.js";
import { MessageBody } from "./message-body.js";
import { AgentStatusCard } from "./status-card.js";
import type { StatusFace } from "./status-words.js";
import { Avatar, FaceStack } from "./team-marks.js";
import type { AgentCardView, MessageView, ThreadSummaryView } from "./team-models.js";

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
  readonly onUnsent: (messageId: string, choice: "edit" | "delete") => void;
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
    const unsent = message.send.kind === "failed";
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
              <SendStateLabel message={message} />
            </View>
          )}
          <View style={unsent ? styles.unsentBody : undefined}>
            <MessageBody mentions={message.mentions} text={message.text} />
          </View>
          {message.edited ? (
            <AppText role="caption" tone="muted">
              (edited)
            </AppText>
          ) : null}
          <MessageAttachments
            attachments={message.attachments}
            onOpen={(attachmentId) => actions.onOpenAttachment(message.id, attachmentId)}
          />
          {message.continued && message.send.kind !== "sent" ? (
            <SendStateLabel message={message} />
          ) : null}
          {message.send.kind === "failed" ? (
            <View style={styles.unsent}>
              <AppText role="caption" style={styles.unsentReason} tone="danger">
                Not sent: {message.send.reason}
              </AppText>
              <TextAction label="Edit" onPress={() => actions.onUnsent(message.id, "edit")} />
              <TextAction label="Delete" onPress={() => actions.onUnsent(message.id, "delete")} />
            </View>
          ) : null}
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
    left.message.continued === right.message.continued &&
    left.message.send === right.message.send,
);

/** The time, or what is keeping the message from being sent. */
function SendStateLabel(props: { readonly message: MessageView }): ReactNode {
  const { send, time } = props.message;
  const words =
    send.kind === "sending"
      ? "Sending…"
      : send.kind === "queued"
        ? "Waiting for connection · sends when you're back"
        : time;
  return (
    <AppText
      maxFontSizeMultiplier={controlFontScaleLimit}
      numberOfLines={1}
      role="caption"
      style={send.kind === "queued" ? styles.queued : styles.time}
    >
      {words}
    </AppText>
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
  queued: { color: color.amber, flexShrink: 1 },
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
  unsentBody: { opacity: 0.6 },
  unsentReason: { flexBasis: "100%" },
});
