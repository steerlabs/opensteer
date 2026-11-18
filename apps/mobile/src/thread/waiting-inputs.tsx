import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import {
  waitingMessageRows,
  type HostClient,
  type MessageEntry,
  type TranscriptEntry,
  type WaitingInput,
} from "@opensteer/client/host";
import type { ContentPart } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import {
  color,
  controlBorderWidth,
  controlFontScaleLimit,
  material,
  pillHeight,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { ComposerEditor } from "../ui/composer-editor.js";
import { duration, enter, exit } from "../ui/motion.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { EditedMark } from "./edited-mark.js";
import type { LinkAction } from "./link-context.js";
import { Message } from "./transcript.js";
import type { WaitingEdit, WaitingEditController } from "./waiting-edit.js";
import { failureWords } from "../ui/client-feedback.js";

/**
 * Everything waiting to reach the agent, at the foot of a task, in the order it
 * will go: the person's own messages, dashed until a Run takes them, and
 * teammates' asks waiting for their answer. A tap opens one to edit in place;
 * a hold, or its ellipsis, offers the rest. An ask is answered from the dock
 * above the composer, which stays in reach however far this list scrolls, so
 * a long line folds only messages: every ask the dock answers stays drawn.
 */
export const WaitingInputs = memo(function WaitingInputs(props: {
  readonly canRespond: boolean;
  readonly editing: WaitingEditController;
  readonly hostClient: HostClient;
  readonly items: readonly WaitingInput[];
  readonly local: readonly MessageEntry[];
  readonly transcript: readonly TranscriptEntry[];
  readonly onOpenThread: React.ComponentProps<typeof Message>["onOpenThread"];
  readonly paused: boolean;
  /** The Host runs this task's queue again on Resume: not while it is archived. */
  readonly resumable: boolean;
  readonly threadId: string;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { editing, hostClient, items, threadId } = props;
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const edit = editing.edit;
  // An edit outlives its message leaving the list, so the words are never lost.
  const orphan = edit?.gone === true;
  const rows = useMemo(
    () => waitingMessageRows(items, props.local, props.transcript),
    [items, props.local, props.transcript],
  );
  const localKeys = useRef(new Set<string>());
  localKeys.current = new Set(
    rows.flatMap((row) => (row.input === null || localKeys.current.has(row.key) ? [row.key] : [])),
  );
  if (!props.paused && rows.length === 0 && !orphan) return null;

  const act = async (id: string, run: () => Promise<void>, fallback: string): Promise<void> => {
    if (busy.current || !props.canRespond) return;
    busy.current = true;
    setBusyId(id);
    setFailure(null);
    try {
      await run();
      void Haptics.selectionAsync();
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFailure(failureWords(error, { label: "finish that" }, fallback));
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  };
  const blocked = busyId !== null || !props.canRespond;
  const editable = (item: WaitingInput): boolean =>
    props.canRespond && item.canEdit && item.lease.kind !== "other";
  const choose = (item: WaitingInput, id: string): void => {
    if (id === "edit" && editable(item)) editing.open(item);
    else if (id === "steer" && item.kind === "message" && item.canSteer)
      void act(
        item.messageId,
        () => hostClient.steerThreadInput(threadId, item.messageId),
        "That message could not be steered into the current run.",
      );
    else if (id === "remove" && item.kind === "message" && item.canCancel)
      void act(
        item.messageId,
        () => hostClient.cancelThreadInput(threadId, item.messageId),
        "That message could not be removed from the queue.",
      );
  };
  const release = (item: WaitingInput): void =>
    void act(
      item.messageId,
      () => hostClient.releaseWaitingMessage(threadId, item.messageId),
      "That edit could not be stopped.",
    );

  // Asks wait behind every message, so the fold sits between the two. A
  // message being edited stays drawn however the list is folded.
  const foldable = (row: (typeof rows)[number]): boolean =>
    items.length > 3 &&
    row.input?.kind === "message" &&
    items.indexOf(row.input) >= 2 &&
    row.input.messageId !== edit?.messageId &&
    !localKeys.current.has(row.key);
  const hidden = rows.filter(foldable).length;
  const shown = hidden > 0 && !expanded ? rows.filter((row) => !foldable(row)) : rows;
  const fold =
    hidden > 0 ? (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        hitSlop={8}
        key="fold"
        style={[styles.action, styles.expand]}
        onPress={() => setExpanded(!expanded)}
      >
        <AppText role="caption" tone="muted">
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </AppText>
      </Pressable>
    ) : null;
  const firstAsk = shown.findIndex(({ input }) => input?.kind === "ask");
  return (
    <View accessibilityLabel="Queued messages" style={styles.section}>
      {props.paused ? (
        <View style={styles.controls}>
          <View style={styles.pausedDot} />
          {busyId === "resume" ? (
            <ActivityIndicator size="small" color={color.muted} />
          ) : (
            <AppText role="caption" tone="muted">
              Paused
            </AppText>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              disabled: blocked || !props.resumable,
              busy: busyId === "resume",
            }}
            disabled={blocked || !props.resumable}
            hitSlop={8}
            style={styles.action}
            onPress={() =>
              void act(
                "resume",
                () => hostClient.resumeThreadInputQueue(threadId),
                "The queue could not be resumed.",
              )
            }
          >
            <AppText role="secondaryMedium" tone="ember">
              Resume
            </AppText>
          </Pressable>
        </View>
      ) : null}
      {shown.flatMap(({ input: item, entry, key }, at) => {
        const index = item ? items.indexOf(item) : -1;
        const actions = item ? menuActions(item, editable(item)) : [];
        const row = (
          <Animated.View
            key={key}
            entering={enter}
            exiting={exit}
            layout={LinearTransition.duration(duration.enter)}
          >
            {edit && edit.messageId === item?.messageId ? (
              <WaitingEditor edit={edit} editing={editing} />
            ) : (
              <>
                <WaitingBubble
                  actions={actions}
                  message={entry}
                  queued={item !== null}
                  onAction={item ? (id) => choose(item, id) : undefined}
                  onEdit={item && editable(item) ? () => editing.open(item) : undefined}
                  onOpenThread={props.onOpenThread}
                  viewerUserId={props.viewerUserId}
                />
                {item ? (
                  <View style={styles.controls}>
                    {busyId === item.messageId ? (
                      <ActivityIndicator size="small" color={color.muted} />
                    ) : (
                      <WaitingStatus count={items.length} index={index} item={item} />
                    )}
                    {item.edit === null ? null : <EditedMark messageId={item.messageId} />}
                    {item.lease.kind === "other" ? (
                      <TextAction
                        blocked={blocked}
                        label="Release"
                        hint={`Stops the edit on ${item.lease.deviceLabel}, so this message can go on`}
                        onPress={() => release(item)}
                      />
                    ) : null}
                    {item.kind === "message" && item.canSteer && item.lease.kind !== "other" ? (
                      <TextAction
                        blocked={blocked}
                        label="Steer"
                        onPress={() => choose(item, "steer")}
                      />
                    ) : null}
                    {actions.length > 0 ? (
                      <MenuView
                        actions={actions.map((action): MenuAction => ({
                          attributes: {
                            destructive: action.id === "remove",
                            disabled: blocked,
                          },
                          id: action.id,
                          image: action.image,
                          title: action.title,
                        }))}
                        colorScheme="dark"
                        onPressAction={({ nativeEvent }) => choose(item, nativeEvent.event)}
                      >
                        <View
                          accessibilityLabel="Message actions"
                          accessibilityRole="button"
                          style={styles.menu}
                        >
                          <Symbol name="ellipsis" size={17} tint={color.muted} />
                        </View>
                      </MenuView>
                    ) : null}
                  </View>
                ) : null}
              </>
            )}
          </Animated.View>
        );
        return at === firstAsk && fold !== null ? [fold, row] : [row];
      })}
      {firstAsk === -1 ? fold : null}
      {orphan && edit !== null ? (
        <Animated.View entering={enter} exiting={exit}>
          <WaitingEditor edit={edit} editing={editing} />
        </Animated.View>
      ) : null}
      {failure === null ? null : (
        <View accessibilityRole="alert">
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        </View>
      )}
    </View>
  );
});

type WaitingAction = LinkAction & { readonly image: "pencil" | "arrow.turn.down.right" | "trash" };

/** What a hold or the ellipsis offers: only what the Host will take from this reader. */
function menuActions(item: WaitingInput, editable: boolean): WaitingAction[] {
  return [
    ...(editable ? [{ group: 0, id: "edit", image: "pencil" as const, title: "Edit" }] : []),
    ...(item.kind === "message" && item.canSteer && item.lease.kind !== "other"
      ? [{ group: 0, id: "steer", image: "arrow.turn.down.right" as const, title: "Steer" }]
      : []),
    ...(item.kind === "message" && item.canCancel
      ? [{ group: 1, id: "remove", image: "trash" as const, title: "Remove" }]
      : []),
  ];
}

function WaitingBubble(props: {
  readonly actions: readonly LinkAction[];
  readonly message: MessageEntry;
  readonly queued: boolean;
  readonly onAction: ((id: string) => void) | undefined;
  readonly onEdit: (() => void) | undefined;
  readonly onOpenThread: React.ComponentProps<typeof Message>["onOpenThread"];
  readonly viewerUserId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(!props.queued);
  return (
    <Message
      queued={props.queued}
      conversation={false}
      hold={{
        actions: props.actions,
        onAction: props.onAction ?? ignoreAction,
        onPress: props.onEdit ?? ignoreAction,
      }}
      onReply={undefined}
      message={props.message}
      open={open}
      onToggle={() => setOpen(!open)}
      onOpenThread={props.onOpenThread}
      viewerUserId={props.viewerUserId}
    />
  );
}

const ignoreAction = () => {};

/** Where the item stands: next, queued, held on another device, or waiting for an answer. */
function WaitingStatus(props: {
  readonly count: number;
  readonly index: number;
  readonly item: WaitingInput;
}): ReactNode {
  const { item } = props;
  if (item.lease.kind === "other")
    return (
      <AppText role="caption" style={styles.status} tone="muted">
        Being edited on {item.lease.deviceLabel}
      </AppText>
    );
  if (item.kind === "ask")
    return (
      <View style={styles.askStatus}>
        {item.approving ? (
          <ActivityIndicator size="small" color={color.muted} />
        ) : (
          <StatusDot size={6} tone="amber" />
        )}
        <AppText role="caption" style={styles.status} tone="muted">
          {item.approving ? "Approving…" : "Waiting for your answer"}
        </AppText>
      </View>
    );
  return (
    // The message and its files stay reachable on their own; this says which
    // waiting message they were.
    <AppText
      accessibilityLabel={`Queued message ${props.index + 1} of ${props.count}${
        item.next ? ", up next" : ""
      }`}
      role="caption"
      tone="muted"
    >
      {item.next ? "Up next" : "Queued"}
    </AppText>
  );
}

/**
 * The bubble, opened in place: the same shape, drawn solid in the accent while
 * it holds the keyboard. Its files and places sit above it, each removable.
 * Under it, what it is waiting on, or why it can't be saved where it is.
 */
function WaitingEditor(props: {
  readonly edit: WaitingEdit;
  readonly editing: WaitingEditController;
}): ReactNode {
  const { edit, editing } = props;
  const { draft } = edit;
  const input = editing.field;
  const locked = edit.phase === "saving";
  const notice = editNotice(edit);
  // Android drops a keyboard asked for while the menu that opened this still
  // holds the window, and focusing a field that already has focus does
  // nothing, so there the field takes focus only once the menu has gone.
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus(), duration.enter);
    return () => clearTimeout(focus);
  }, [input]);
  return (
    <View style={styles.editColumn}>
      {edit.asker === null ? null : (
        <AppText numberOfLines={1} role="caption" tone="muted">
          {edit.asker}
        </AppText>
      )}
      {draft.parts.length === 0 ? null : (
        <View style={styles.parts}>
          {draft.parts.map((part, index) => (
            <PartChip
              disabled={locked}
              key={`${index}:${partName(part)}`}
              onRemove={() => editing.removePart(index)}
              part={part}
            />
          ))}
        </View>
      )}
      <View style={[styles.editBubble, locked && styles.editBubbleLocked]}>
        {/* No image paste: a waiting message can lose parts in an edit, never gain them. */}
        <ComposerEditor
          accessibilityLabel={edit.asker === null ? "Edit message" : `Edit ${edit.asker}’s ask`}
          autoFocus={Platform.OS === "ios"}
          editable={!locked}
          maxHeight={editMaxHeight}
          onChangeText={editing.change}
          paddingVertical={editPadding}
          style={styles.editInput}
          placeholder={draft.parts.length > 0 ? "No words, just what’s attached" : "Message"}
          ref={input}
          scope="personal"
          value={draft.text}
        />
      </View>
      <View style={styles.editFoot}>
        {notice === null ? (
          <AppText role="caption" tone="muted">
            {edit.phase === "opening" || edit.phase === "away"
              ? "Opening…"
              : "Waits while you edit"}
          </AppText>
        ) : (
          <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.notice}>
            <AppText role="caption" style={styles.status} tone={notice.tone}>
              {notice.text}
            </AppText>
          </View>
        )}
        {notice?.action === "reload" ? (
          <TextAction
            blocked={false}
            hint="Replaces your words with the version saved elsewhere"
            label="Reload"
            onPress={editing.reload}
          />
        ) : notice?.action === "retry" ? (
          <TextAction blocked={false} label="Try again" onPress={editing.retry} />
        ) : null}
      </View>
    </View>
  );
}

/** Why the words can't simply be saved where they are, and what this editor offers for it. */
function editNotice(edit: WaitingEdit): {
  readonly action: "reload" | "retry" | null;
  readonly text: string;
  readonly tone: "danger" | "soft";
} | null {
  const ask = edit.kind === "ask";
  if (edit.gone)
    return {
      action: null,
      text: ask
        ? "This ask was answered or withdrawn before your edit was saved."
        : "Your agent already took this message, so your edit wasn’t saved.",
      tone: "soft",
    };
  if (edit.draft.conflict !== null)
    return {
      action: "reload",
      text: `This ${ask ? "ask" : "message"} changed elsewhere before you saved.`,
      tone: "soft",
    };
  if (edit.failure !== null)
    return {
      action: edit.phase === "refused" ? "retry" : null,
      text: edit.failure,
      tone: "danger",
    };
  return null;
}

function PartChip(props: {
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly part: ContentPart;
}): ReactNode {
  const name = partName(props.part);
  return (
    <View style={styles.chip}>
      <Symbol name={partIcon(props.part)} size={13} tint={color.muted} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.chipName}
        tone="soft"
      >
        {name}
      </AppText>
      <Pressable
        accessibilityLabel={`Remove ${name}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        hitSlop={10}
        onPress={props.onRemove}
        style={styles.chipRemove}
      >
        <Symbol name="xmark" size={11} tint={color.textSoft} weight="semibold" />
      </Pressable>
    </View>
  );
}

function partName(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "browser-page":
      return part.title.trim() || part.url;
    case "artifact":
    case "computer-app":
    case "phone":
      return part.name;
  }
}

function partIcon(part: ContentPart): SFSymbolName {
  switch (part.type) {
    case "browser-page":
      return "safari";
    case "computer-app":
      return "desktopcomputer";
    case "phone":
      return "smartphone";
    default:
      return "paperclip";
  }
}

function TextAction(props: {
  readonly blocked: boolean;
  readonly hint?: string;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.hint}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.blocked }}
      disabled={props.blocked}
      hitSlop={8}
      style={styles.action}
      onPress={props.onPress}
    >
      <AppText role="secondaryMedium" tone="ember">
        {props.label}
      </AppText>
    </Pressable>
  );
}

/** Inside the bubble's 1.5-point rim, the words sit where the transcript's bubble puts them. */
const editPadding = space[12] - 1.5;
const editMaxHeight = type.body.lineHeight * 8 + editPadding * 2;

const styles = StyleSheet.create({
  section: { gap: space[12], paddingTop: space[16] },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[12],
  },
  action: { minHeight: touchTarget, justifyContent: "center" },
  askStatus: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[6] },
  menu: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  expand: { alignSelf: "flex-end" },
  pausedDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.amber },
  status: { flexShrink: 1, textAlign: "right" },
  // Wider than the bubble it opened from, so the line being typed isn't
  // rewrapped under the cursor with every word.
  editColumn: { alignItems: "flex-end", alignSelf: "flex-end", gap: space[4], width: "88%" },
  editBubble: {
    alignSelf: "stretch",
    backgroundColor: color.emberWash,
    borderBottomEndRadius: radius.xs,
    borderColor: color.ember,
    borderRadius: radius.xl,
    borderWidth: 1.5,
  },
  editBubbleLocked: { borderColor: color.emberLine },
  editInput: { marginHorizontal: space[16] - 1.5 },
  editFoot: { alignItems: "center", flexDirection: "row", gap: space[12], minHeight: touchTarget },
  notice: { flexShrink: 1 },
  parts: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[6],
    justifyContent: "flex-end",
  },
  chip: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: 240,
    minHeight: pillHeight,
    paddingLeft: space[10] - controlBorderWidth,
    paddingRight: space[4],
  },
  chipName: { flexShrink: 1 },
  chipRemove: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
});
