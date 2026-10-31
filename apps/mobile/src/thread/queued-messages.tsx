import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import {
  messageDraftParts,
  queuedMessages,
  type HostClient,
  type QueuedMessage,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import type { ArtifactContentPart, ThreadInputQueue } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { memo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { operationDetail } from "../client/mobile-client.js";
import { color, space, touchTarget } from "../theme.js";
import { duration, enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { Message } from "./transcript.js";

export const QueuedMessages = memo(function QueuedMessages(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly onEdit: (message: {
    readonly attachments: readonly ArtifactContentPart[];
    readonly text: string;
  }) => void;
  readonly queue: ThreadInputQueue;
  readonly viewerUserId: string | null;
}): ReactNode {
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = queuedMessages(props.queue);
  if (!props.queue.paused && shown.length === 0) return null;

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
  const action = (message: QueuedMessage, name: string) => {
    const id = message.item.message.id;
    if (name === "steer" && message.item.canSteer) {
      void act(
        id,
        () => props.hostClient.steerThreadInput(props.queue.threadId, id),
        "That message could not be steered into the current run.",
      );
    } else if (name === "edit" && message.item.canCancel) {
      void act(
        id,
        async () => {
          await props.hostClient.cancelThreadInput(props.queue.threadId, id);
          const parts = messageDraftParts(message.item.message.content);
          props.onEdit({ attachments: parts.attachments, text: parts.body.trim() });
        },
        "That message could not be taken back to edit.",
      );
    } else if (name === "remove" && message.item.canCancel) {
      void act(
        id,
        () => props.hostClient.cancelThreadInput(props.queue.threadId, id),
        "That message could not be removed from the queue.",
      );
    }
  };
  const blocked = busyId !== null || !props.canRespond;
  return (
    <View accessibilityLabel="Queued messages" style={styles.section}>
      {props.queue.paused ? (
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
                () => props.hostClient.resumeThreadInputQueue(props.queue.threadId),
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
      {(shown.length > 3 && !expanded ? shown.slice(0, 2) : shown).map((message, index) => {
        const actions: MenuAction[] = message.item.canCancel
          ? [
              { id: "edit", image: "pencil", title: "Edit" },
              { id: "remove", image: "trash", title: "Remove", attributes: { destructive: true } },
            ]
          : [];
        return (
          <Animated.View
            key={message.item.message.id}
            entering={enter}
            exiting={exit}
            layout={LinearTransition.duration(duration.enter)}
          >
            <QueuedBubble
              blocked={blocked}
              count={shown.length}
              index={index}
              message={message}
              onAction={(name) => action(message, name)}
              viewerUserId={props.viewerUserId}
            />
            <View style={styles.controls}>
              {busyId === message.item.message.id ? (
                <ActivityIndicator size="small" color={color.muted} />
              ) : (
                <AppText role="caption" tone="muted">
                  {message.next ? "Up next" : "Queued"}
                </AppText>
              )}
              {message.item.canSteer ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: blocked }}
                  disabled={blocked}
                  hitSlop={8}
                  style={styles.action}
                  onPress={() => action(message, "steer")}
                >
                  <AppText role="secondaryMedium" tone="ember">
                    Steer
                  </AppText>
                </Pressable>
              ) : null}
              {actions.length > 0 ? (
                <MenuView
                  actions={actions.map((item) => ({
                    ...item,
                    attributes: { ...item.attributes, disabled: blocked },
                  }))}
                  colorScheme="dark"
                  onPressAction={({ nativeEvent }) => action(message, nativeEvent.event)}
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
          </Animated.View>
        );
      })}
      {shown.length > 3 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          style={[styles.action, styles.expand]}
          onPress={() => setExpanded(!expanded)}
        >
          <AppText role="caption" tone="muted">
            {expanded ? "Show fewer" : `Show ${shown.length - 2} more`}
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

function QueuedBubble(props: {
  readonly blocked: boolean;
  readonly count: number;
  readonly index: number;
  readonly message: QueuedMessage;
  readonly onAction: (name: string) => void;
  readonly viewerUserId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const files = props.message.entry.attachments?.length ?? 0;
  return (
    <View
      accessible
      accessibilityLabel={`Queued message ${props.index + 1} of ${props.count}: ${props.message.text}${files > 0 ? `, ${files} files` : ""}`}
      accessibilityActions={
        props.blocked
          ? []
          : [
              ...(props.message.item.canSteer ? [{ name: "steer", label: "Steer" }] : []),
              ...(props.message.item.canCancel
                ? [
                    { name: "edit", label: "Edit" },
                    { name: "remove", label: "Remove" },
                  ]
                : []),
            ]
      }
      onAccessibilityAction={({ nativeEvent }) => props.onAction(nativeEvent.actionName)}
    >
      <Message
        queued
        conversation={false}
        homeThreadId={null}
        onReply={undefined}
        message={props.message.entry}
        open={open}
        onToggle={() => setOpen(!open)}
        onOpenThread={ignoreThread}
        viewerUserId={props.viewerUserId}
        workspaces={noWorkspaces}
      />
    </View>
  );
}
const noWorkspaces: readonly WorkspaceSummary[] = [];
const ignoreThread = (): void => undefined;
const styles = StyleSheet.create({
  section: { gap: space[12], paddingTop: space[16] },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[12],
  },
  action: { minHeight: touchTarget, justifyContent: "center" },
  menu: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  expand: { alignSelf: "flex-end" },
  pausedDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.amber },
});
