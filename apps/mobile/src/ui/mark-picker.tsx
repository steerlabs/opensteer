import {
  mutationIdempotencyKey,
  threadInDirectory,
  threadMark,
  type HostClient,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import type { IconName } from "@opensteer/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { ActionLineSlot, type ActionLineValue } from "./action-line.js";
import { notDone, useScreenAction } from "./client-feedback.js";
import { IconChoices } from "./mark-choices.js";
import { AppText, SecondaryButton } from "./primitives.js";

function PickerSheet(props: {
  readonly children: ReactNode;
  readonly closing?: boolean;
  readonly line: ActionLineValue | null;
  readonly onDismissLine: () => void;
  readonly onClose: () => void;
  readonly title: string;
  readonly onDismiss?: (() => void) | undefined;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const visible = open && !props.closing;
  const { onClose, onDismiss } = props;
  const finish = useCallback(() => {
    onDismiss?.();
    onClose();
  }, [onClose, onDismiss]);
  // iOS reports the native dismissal. Android has no onDismiss, so return
  // focus on the frame after hiding; both keep the opener and Modal mounted.
  useEffect(() => {
    if (visible || Platform.OS !== "android") return;
    const frame = requestAnimationFrame(finish);
    return () => cancelAnimationFrame(frame);
  }, [finish, visible]);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setOpen(false)}
      onDismiss={visible ? undefined : finish}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboard}
      >
        <View accessibilityViewIsModal style={styles.sheet}>
          <View style={styles.bar}>
            <AppText role="title" style={styles.title}>
              {props.title}
            </AppText>
            <SecondaryButton compact label="Close" onPress={() => setOpen(false)} />
          </View>
          <ActionLineSlot line={props.line} onDismiss={props.onDismissLine} />
          {props.children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TaskIconPicker(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly onClose: () => void;
  readonly onDismiss?: (() => void) | undefined;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const mark = threadMark(props.threadId, snapshot);
  const [closing, setClosing] = useState(false);
  const chosen = useRef<IconName | null>(null);
  const spec = { label: "change the icon", done: "changed", happened: "the icon changed" } as const;
  const change = useScreenAction<IconName | null, void>(
    props.hostClient,
    `thread-icon:${props.threadId}`,
    {
      ...spec,
      execute: (icon) =>
        props.hostClient
          .dispatch({
            type: "thread.icon.set",
            threadId: props.threadId,
            icon,
            idempotencyKey: mutationIdempotencyKey("thread-icon"),
          })
          .then(() => undefined),
      // The task's own mark says whether a lost answer changed it.
      reconcile: async (icon) =>
        (threadInDirectory(props.threadId, props.hostClient.getSnapshot())?.icon ?? null) === icon
          ? { kind: "confirmed", value: undefined }
          : notDone(spec),
      retry: () => void choose(chosen.current),
    },
  );
  const choose = async (icon: IconName | null) => {
    if (change.running) return;
    chosen.current = icon;
    if ((await change.run(icon)).kind === "confirmed") setClosing(true);
  };
  return (
    <PickerSheet
      title="Change icon"
      closing={closing}
      line={change.line}
      onDismissLine={change.dismiss}
      onClose={props.onClose}
      onDismiss={props.onDismiss}
    >
      <IconChoices
        task
        color={mark.color}
        value={mark.icon}
        disabled={change.running}
        onChange={(icon) => void choose(icon)}
      />
    </PickerSheet>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  sheet: {
    flex: 1,
    backgroundColor: color.surfaceElevated,
    padding: space[20],
    paddingTop: space[32],
    paddingBottom: space[32],
    gap: space[16],
  },
  bar: { alignItems: "center", flexDirection: "row", gap: space[12] },
  title: { flex: 1 },
});
