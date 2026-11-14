import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import type { HostClient, WaitingInput } from "@opensteer/client/host";
import type { ContentPart } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { operationDetail } from "../client/mobile-client.js";
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
import { duration, enter, exit } from "../ui/motion.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { EditedMark } from "./edited-mark.js";
import type { LinkAction } from "./link-context.js";
import { Message } from "./transcript.js";
import type { WaitingEdit, WaitingEditController } from "./waiting-edit.js";

/**
 * Everything waiting to reach the agent, at the foot of a task, in the order it
 * will go: the person's own messages, dashed until a Run takes them, and
 * teammates' asks waiting for their answer. A tap opens one to edit in place;
 * a hold, or its ellipsis, offers the rest. An ask is answered from the dock
 * above the composer, which stays in reach however far this list scrolls.
 */
export const WaitingInputs = memo(function WaitingInputs(props: {
  readonly canRespond: boolean;
  readonly editing: WaitingEditController;
  readonly hostClient: HostClient;
  readonly items: readonly WaitingInput[];
  readonly paused: boolean;
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
  const orphan = edit !== null && !items.some((item) => item.messageId === edit.messageId);
  if (!props.paused && items.length === 0 && !orphan) return null;

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
      setFailure(operationDetail(error, fallback));
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

  // A message being edited stays drawn however the list is folded.
  const folded = items.length > 3 && !expanded;
  const shown = folded
    ? items.filter((item, index) => index < 2 || item.messageId === edit?.messageId)
    : items;
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
            accessibilityState={{ disabled: blocked, busy: busyId === "resume" }}
            disabled={blocked}
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
      {shown.map((item) => {
        const index = items.indexOf(item);
        const actions = menuActions(item, editable(item));
        return (
          <Animated.View
            key={item.messageId}
            entering={enter}
            exiting={exit}
            layout={LinearTransition.duration(duration.enter)}
          >
            {edit?.messageId === item.messageId ? (
              <WaitingEditor
                asker={item.kind === "ask" ? item.asker : null}
                edit={edit}
                editing={editing}
              />
            ) : (
              <>
                <WaitingBubble
                  actions={actions}
                  item={item}
                  onAction={(id) => choose(item, id)}
                  onEdit={editable(item) ? () => editing.open(item) : undefined}
                  viewerUserId={props.viewerUserId}
                />
                <View style={styles.controls}>
                  {busyId === item.messageId ? (
                    <ActivityIndicator size="small" color={color.muted} />
                  ) : (
                    <WaitingStatus
                      count={items.length}
                      index={index}
                      item={item}
                      refused={
                        editing.refused?.messageId === item.messageId
                          ? editing.refused.detail
                          : null
                      }
                    />
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
              </>
            )}
          </Animated.View>
        );
      })}
      {orphan && edit !== null ? (
        <Animated.View entering={enter} exiting={exit}>
          <WaitingEditor asker={null} edit={edit} editing={editing} />
        </Animated.View>
      ) : null}
      {items.length > 3 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          style={[styles.action, styles.expand]}
          onPress={() => setExpanded(!expanded)}
        >
          <AppText role="caption" tone="muted">
            {expanded ? "Show fewer" : `Show ${items.length - 2} more`}
          </AppText>
        </Pressable>
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
  readonly item: WaitingInput;
  readonly onAction: (id: string) => void;
  readonly onEdit: (() => void) | undefined;
  readonly viewerUserId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Message
      queued
      conversation={false}
      hold={{ actions: props.actions, onAction: props.onAction, onPress: props.onEdit }}
      onReply={undefined}
      message={props.item.entry}
      open={open}
      onToggle={() => setOpen(!open)}
      onOpenThread={ignoreThread}
      viewerUserId={props.viewerUserId}
    />
  );
}
const ignoreThread = (): void => undefined;

/** Where the item stands: next, queued, held on another device, or waiting for an answer. */
function WaitingStatus(props: {
  readonly count: number;
  readonly index: number;
  readonly item: WaitingInput;
  readonly refused: string | null;
}): ReactNode {
  const { item } = props;
  if (props.refused !== null)
    return (
      <AppText role="caption" style={styles.status} tone="danger">
        {props.refused}
      </AppText>
    );
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
 */
function WaitingEditor(props: {
  /** Whose ask this is, named above the words being changed. */
  readonly asker: string | null;
  readonly edit: WaitingEdit;
  readonly editing: WaitingEditController;
}): ReactNode {
  const { edit, editing } = props;
  const input = useRef<TextInputInstance>(null);
  const locked = edit.phase === "saving" || edit.phase === "taken";
  useEffect(() => {
    // `autoFocus` alone can lose the keyboard to a list still laying out on Android.
    const focus = setTimeout(() => input.current?.focus(), duration.enter);
    return () => clearTimeout(focus);
  }, []);
  return (
    <View style={styles.editColumn}>
      {props.asker === null ? null : (
        <AppText numberOfLines={1} role="caption" tone="muted">
          {props.asker}
        </AppText>
      )}
      {edit.parts.length === 0 ? null : (
        <View style={styles.parts}>
          {edit.parts.map((part, index) => (
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
        <TextInput
          accessibilityHint="Save or cancel below"
          accessibilityLabel={props.asker === null ? "Edit message" : `Edit ${props.asker}’s ask`}
          autoFocus
          cursorColor={color.ember}
          editable={!locked}
          maxFontSizeMultiplier={controlFontScaleLimit}
          multiline
          onChangeText={editing.change}
          placeholder={edit.parts.length > 0 ? "No words, just what’s attached" : "Message"}
          placeholderTextColor={color.muted}
          ref={input}
          scrollEnabled
          selectionColor={color.ember}
          style={styles.editInput}
          value={edit.text}
        />
      </View>
      <View style={styles.editFoot}>
        {edit.failure !== null ? (
          <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.notice}>
            <AppText
              role="caption"
              style={styles.status}
              tone={edit.phase === "taken" ? "soft" : "danger"}
            >
              {edit.failure}
            </AppText>
          </View>
        ) : (
          <AppText role="caption" tone="muted">
            {edit.phase === "opening" ? "Opening…" : "Waits while you edit"}
          </AppText>
        )}
      </View>
    </View>
  );
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
  editInput: {
    color: color.text,
    fontSize: type.body.fontSize,
    fontWeight: type.body.fontWeight,
    includeFontPadding: false,
    maxHeight: type.body.lineHeight * 8,
    minHeight: type.body.lineHeight + (space[12] - 1) * 2,
    paddingHorizontal: space[16] - 1.5,
    paddingTop: space[12] - 1.5,
    paddingBottom: space[12] - 1.5,
    textAlignVertical: "top",
  },
  editFoot: { alignItems: "center", flexDirection: "row", minHeight: touchTarget },
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
