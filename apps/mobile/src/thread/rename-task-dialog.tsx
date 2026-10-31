import type { HostClient } from "@opensteer/client/host";
import { threadTitleMaxLength } from "@opensteer/core";
import { useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from "react-native";
import { material, space } from "../theme.js";
import { AppText, Field, PrimaryButton, SecondaryButton } from "../ui/primitives.js";

export function RenameTaskDialog(props: {
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly threadId: string;
  readonly title: string;
}): ReactNode {
  const [value, setValue] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (saving) return;
    const title = value.trim();
    if (!title || title === props.title) {
      props.onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.hostClient.renameThread(props.threadId, title);
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The task could not be renamed.");
      setSaving(false);
    }
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.backdrop}
      >
        <View accessibilityViewIsModal style={styles.dialog}>
          <AppText role="title">Rename task</AppText>
          <Field
            label="Task title"
            input={{
              autoFocus: true,
              selectTextOnFocus: true,
              value,
              onChangeText: setValue,
              maxLength: threadTitleMaxLength,
              editable: !saving,
              returnKeyType: "done",
              onSubmitEditing: () => {
                void save();
              },
            }}
          />
          {error ? (
            <View accessibilityRole="alert">
              <AppText tone="danger">{error}</AppText>
            </View>
          ) : null}
          <View style={styles.actions}>
            <SecondaryButton compact label="Cancel" onPress={props.onClose} />
            <PrimaryButton
              compact
              disabled={saving}
              label={saving ? "Saving…" : "Save"}
              onPress={() => {
                void save();
              }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: space[24],
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  dialog: {
    ...material.float,
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    padding: space[20],
    gap: space[16],
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: space[12] },
});
