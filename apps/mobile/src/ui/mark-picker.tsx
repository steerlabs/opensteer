import {
  mutationIdempotencyKey,
  threadMark,
  type HostClient,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import type { MarkColor, WorkspaceIconName } from "@opensteer/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { ColorChoices, IconChoices } from "./mark-choices.js";
import { AppText, SecondaryButton } from "./primitives.js";

function PickerSheet(props: {
  readonly children: ReactNode;
  readonly closing?: boolean;
  readonly error: string | null;
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
          {props.error === null ? null : (
            <View accessibilityRole="alert">
              <AppText tone="danger">{props.error}</AppText>
            </View>
          )}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const choose = async (icon: WorkspaceIconName | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await props.hostClient.dispatch({
        type: "thread.icon.set",
        threadId: props.threadId,
        icon,
        idempotencyKey: mutationIdempotencyKey("thread-icon"),
      });
      setClosing(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The icon could not be changed.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <PickerSheet
      title="Change icon"
      closing={closing}
      error={error}
      onClose={props.onClose}
      onDismiss={props.onDismiss}
    >
      <IconChoices
        task
        color={mark.color}
        value={mark.pending ? null : mark.icon}
        disabled={saving}
        onChange={(icon) => void choose(icon)}
      />
    </PickerSheet>
  );
}

export function SpecialistMarkPicker(props: {
  readonly hostClient: HostClient;
  readonly workspace: WorkspaceSummary;
  readonly editable: boolean;
  readonly onClose: () => void;
  readonly onDismiss: () => void;
  readonly onRefused: () => void;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const workspace =
    snapshot.workspaces.find(({ id }) => id === props.workspace.id) ?? props.workspace;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const choose = async (
    change: { readonly icon: WorkspaceIconName | null } | { readonly color: MarkColor },
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await props.hostClient.dispatch(
        "icon" in change
          ? {
              type: "workspace.icon.set",
              workspaceId: workspace.id,
              icon: change.icon,
              idempotencyKey: mutationIdempotencyKey("workspace-icon"),
            }
          : {
              type: "workspace.color.set",
              workspaceId: workspace.id,
              color: change.color,
              idempotencyKey: mutationIdempotencyKey("workspace-color"),
            },
      );
    } catch (failure) {
      props.onRefused();
      setError(failure instanceof Error ? failure.message : "The specialist could not be changed.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <PickerSheet
      title="Specialist appearance"
      closing={!props.editable}
      error={error}
      onClose={props.onClose}
      onDismiss={props.onDismiss}
    >
      <AppText role="secondaryMedium" tone="soft">
        Colour
      </AppText>
      <ColorChoices
        value={workspace.color}
        disabled={saving || !props.editable}
        onChange={(color) => void choose({ color })}
      />
      <IconChoices
        color={workspace.color}
        name={workspace.name}
        value={workspace.icon}
        disabled={saving || !props.editable}
        onChange={(icon) => void choose({ icon })}
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
