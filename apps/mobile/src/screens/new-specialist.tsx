import {
  canRespondToRequests,
  machineChoiceLabel,
  mutationIdempotencyKey,
  noWorkspaceStorageExplanation,
  sameStableHostSnapshot,
  workspaceStorageMachines,
  type HostClient,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { type MarkColor, type WorkspaceIconName } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Field, Notice, PrimaryButton, RowGroup } from "../ui/primitives.js";
import { useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { ColorChoices, IconChoices } from "../ui/mark-choices.js";

export type NewSpecialistScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

type Backing = "local-directory" | "portablefs";

/**
 * A new specialist: a name, an optional icon, and where its files live.
 *
 * It is the web's new-specialist dialog on a phone, against the same command.
 * A name is only a name — what the specialist is for is written into its
 * instructions by working with it, not invented from here. Where its files go
 * is asked only when there is more than one real answer, and a computer that
 * is off cannot be chosen, because the Host needs it on to make the folder.
 */
export function NewSpecialistScreen(props: NewSpecialistScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId } = props.route.params;
  const { selection } = useMobileState();
  // A sheet belongs to one Host; it never subscribes to a replacement.
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return (
      <Sheet onClose={() => navigation.goBack()}>
        <Notice
          detail="This deployment is no longer open."
          title="A specialist can’t be created right now"
          tone="neutral"
        />
      </Sheet>
    );
  }
  return (
    <NewSpecialistForm
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      key={deploymentId}
    />
  );
}

function NewSpecialistForm(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(props.hostClient, sameStableHostSnapshot);
  const machines = useMemo(
    () => workspaceStorageMachines(snapshot.environments),
    [snapshot.environments],
  );
  const availableMachines = useMemo(
    () => machines.filter(({ connected }) => connected),
    [machines],
  );
  const sharedStorageAvailable = snapshot.deploymentShape?.defaultWorkspaceBacking === "portablefs";
  const defaultBacking = snapshot.deploymentShape?.defaultWorkspaceBacking ?? "local-directory";
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<WorkspaceIconName | null>(null);
  const [markColor, setMarkColor] = useState<MarkColor | null>(null);
  const [backing, setBacking] = useState<Backing>(() =>
    sharedStorageAvailable && (defaultBacking === "portablefs" || availableMachines.length === 0)
      ? "portablefs"
      : "local-directory",
  );
  const [environmentId, setEnvironmentId] = useState(availableMachines[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per exact request: an answer that never arrives is retried as the
  // same command, and any change to what is asked for makes a new one.
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);

  const connected = canRespondToRequests(snapshot);
  const chosenMachine = availableMachines.find(({ id }) => id === environmentId);
  const offersBackingChoice =
    sharedStorageAvailable && (machines.length > 0 || backing === "local-directory");
  const offersMachineChoice =
    backing === "local-directory" && (machines.length > 1 || chosenMachine === undefined);
  const submittable =
    name.trim().length > 0 &&
    !creating &&
    connected &&
    (backing === "portablefs" ? sharedStorageAvailable : chosenMachine !== undefined);

  // While a create is in flight nothing here changes, so the form never shows
  // a name, icon or place other than the ones the Host was asked for.
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
        storage:
          backing === "local-directory"
            ? { backing: "local-directory", environmentId: chosenMachine?.id ?? "" }
            : { backing: "portablefs" },
        type: "workspace.create",
      })
      .then((result) => {
        if (result.type !== "workspace.create") throw new Error("Workspace command mismatch.");
        // Cancel closes the sheet but cannot recall a command already sent: if
        // it lands, the specialist is simply in the list, and nothing moves the
        // reader somewhere they just chose to leave.
        if (!navigation.isFocused()) return;
        navigation.goBack();
        navigation.navigate("Specialist", {
          deploymentId: props.deploymentId,
          workspaceId: result.workspace.id,
        });
      })
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "The specialist could not be created."));
      })
      .finally(() => {
        inFlight.current = false;
        setCreating(false);
      });
  };

  if (!sharedStorageAvailable && availableMachines.length === 0) {
    return (
      <Sheet onClose={() => navigation.goBack()}>
        <Notice
          detail={noWorkspaceStorageExplanation(machines.length)}
          title="There is nowhere to keep its files yet"
          tone="neutral"
        />
      </Sheet>
    );
  }

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
          // Done puts the keyboard away so the icon and the place its files
          // live are in view; creating is the button's, after they are seen.
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
      {offersBackingChoice ? (
        <View accessibilityRole="radiogroup" style={styles.group}>
          <AppText role="secondaryMedium" tone="soft">
            Where its files live
          </AppText>
          <RowGroup>
            {[
              <Choice
                detail="A folder on that machine’s own disk. Agents run there."
                disabled={creating}
                key="local"
                label="On one computer"
                onPress={() => change(setBacking)("local-directory")}
                selected={backing === "local-directory"}
              />,
              <Choice
                detail="Computers with shared storage enabled can mount it."
                disabled={creating}
                key="shared"
                label="Shared storage"
                onPress={() => change(setBacking)("portablefs")}
                selected={backing === "portablefs"}
              />,
            ]}
          </RowGroup>
        </View>
      ) : null}

      {offersMachineChoice ? (
        <View accessibilityRole="radiogroup" style={styles.group}>
          <AppText role="secondaryMedium" tone="soft">
            Computer
          </AppText>
          <RowGroup>
            {machines.map((machine) => (
              <Choice
                disabled={creating || !machine.connected}
                key={machine.id}
                label={machineChoiceLabel(machine, machines)}
                onPress={() => change(setEnvironmentId)(machine.id)}
                selected={machine.id === environmentId && machine.connected}
              />
            ))}
          </RowGroup>
        </View>
      ) : null}

      {backing === "local-directory" && machines.length > availableMachines.length ? (
        <AppText role="caption" tone="muted">
          An offline computer cannot be chosen: it has to be on to make the folder.
        </AppText>
      ) : null}
      {failure === null ? null : <Notice detail={failure} title="The specialist was not created" />}
      {connected ? null : (
        <AppText role="caption" tone="muted">
          Reconnect to create a specialist.
        </AppText>
      )}
      <PrimaryButton
        busy={creating}
        disabled={!submittable}
        label="Create specialist"
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
        <AppText accessibilityLabel="New specialist" role="title" style={styles.barTitle}>
          New specialist
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

function Choice(props: {
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly selected: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.choice,
        pressed && styles.pressed,
        props.disabled === true && styles.dimmed,
      ]}
    >
      <View style={styles.choiceText}>
        <AppText role="body">{props.label}</AppText>
        {props.detail === undefined ? null : (
          <AppText role="caption" tone="muted">
            {props.detail}
          </AppText>
        )}
      </View>
      {props.selected ? <Symbol name="checkmark" tint={color.ember} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: "center", flexDirection: "row", minHeight: touchTarget },
  barSide: { width: touchTarget },
  barTitle: { flex: 1, textAlign: "center" },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 52,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  choiceText: { flex: 1, gap: space[2] },
  close: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  content: { gap: space[16], padding: space[16], paddingTop: space[20] },
  dimmed: { opacity: 0.45 },
  group: { gap: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
});
