import {
  canRespondToRequests,
  mutationIdempotencyKey,
  sameStableHostSnapshot,
  type HostClient,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { type MarkColor, type WorkspaceIconName } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { material, radius, space, touchTarget } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Field, Notice, PrimaryButton } from "../ui/primitives.js";
import { useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { ColorChoices, IconChoices } from "../ui/mark-choices.js";

export type NewProjectScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

export function NewProjectScreen(props: NewProjectScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId } = props.route.params;
  const { selection } = useMobileState();
  // A sheet belongs to one Host; it never subscribes to a replacement.
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return (
      <Sheet onClose={() => navigation.goBack()}>
        <Notice
          detail="This deployment is no longer open."
          title="A project can’t be created right now"
          tone="neutral"
        />
      </Sheet>
    );
  }
  return (
    <NewProjectForm
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      key={deploymentId}
    />
  );
}

function NewProjectForm(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(props.hostClient, sameStableHostSnapshot);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<WorkspaceIconName | null>(null);
  const [markColor, setMarkColor] = useState<MarkColor | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per exact request: an answer that never arrives is retried as the
  // same command, and any change to what is asked for makes a new one.
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);

  const connected = canRespondToRequests(snapshot);
  const submittable = name.trim().length > 0 && !creating && connected;
  // While a create is in flight nothing here changes, so the form never shows
  // a name or icon other than the ones the Host was asked for.
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      if (inFlight.current) return;
      attempt.current = null;
      set(value);
    };

  const create = (): void => {
    if (!submittable || inFlight.current) return;
    inFlight.current = true;
    attempt.current ??= mutationIdempotencyKey("workspace");
    setCreating(true);
    setFailure(null);
    void props.hostClient
      .dispatch({
        ...(icon === null ? {} : { icon }),
        ...(snapshot.taskMarksAvailable && markColor !== null ? { color: markColor } : {}),
        idempotencyKey: attempt.current,
        name: name.trim(),
        type: "workspace.create",
      })
      .then((result) => {
        if (result.type !== "workspace.create") throw new Error("Workspace command mismatch.");
        // Cancel closes the sheet but cannot recall a command already sent: if
        // it lands, the project is simply in the list, and nothing moves the
        // reader somewhere they just chose to leave.
        if (!navigation.isFocused()) return;
        navigation.goBack();
        navigation.navigate("Project", {
          deploymentId: props.deploymentId,
          workspaceId: result.workspace.id,
        });
      })
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "The project could not be created."));
      })
      .finally(() => {
        inFlight.current = false;
        setCreating(false);
      });
  };

  return (
    <Sheet onClose={() => navigation.goBack()}>
      <AppText role="secondary" tone="muted">
        An agent with its own files, browsers and sign-ins. Opensteer can hand it work, and you can
        start tasks in it yourself.
      </AppText>
      <Field
        input={{
          autoCapitalize: "words",
          autoFocus: true,
          editable: !creating,
          maxLength: 160,
          onChangeText: change(setName),
          // Done puts the keyboard away so the icon and create button are in view.
          placeholder: "Research",
          returnKeyType: "done",
          value: name,
        }}
        label="Name"
      />
      <View style={styles.group}>
        <AppText role="secondaryMedium" tone="soft">
          Icon
        </AppText>
        <IconChoices
          horizontal
          color={markColor}
          disabled={creating}
          name={name}
          onChange={change(setIcon)}
          value={icon}
        />
      </View>

      {snapshot.taskMarksAvailable ? (
        <View style={styles.group}>
          <AppText role="secondaryMedium" tone="soft">
            Colour
          </AppText>
          <ColorChoices disabled={creating} value={markColor} onChange={change(setMarkColor)} />
        </View>
      ) : null}
      {failure === null ? null : <Notice detail={failure} title="The project was not created" />}
      {connected ? null : (
        <AppText role="caption" tone="muted">
          Reconnect to create a project.
        </AppText>
      )}
      <PrimaryButton
        busy={creating}
        disabled={!submittable}
        label="Create project"
        onPress={create}
      />
    </Sheet>
  );
}

/** The sheet's own bar and scrolling body; Android's form sheet has no native header. */
function Sheet(props: { readonly children: ReactNode; readonly onClose: () => void }): ReactNode {
  const column = useReadingColumn();
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.content, column]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.bar}>
        <View style={styles.barSide} />
        <AppText accessibilityLabel="New project" role="title" style={styles.barTitle}>
          New project
        </AppText>
        <Pressable
          accessibilityLabel="Cancel"
          accessibilityRole="button"
          hitSlop={space[4]}
          onPress={props.onClose}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Symbol name="xmark" size={17} weight="semibold" />
        </Pressable>
      </View>
      {props.children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: "center", flexDirection: "row", minHeight: touchTarget },
  barSide: { width: touchTarget },
  barTitle: { flex: 1, textAlign: "center" },
  close: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  content: { gap: space[16], padding: space[16], paddingTop: space[20] },
  group: { gap: space[8] },
  pressed: { ...material.quiet },
});
