import { mutationIdempotencyKey, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import {
  computerAppSetupRequested,
  type ComputerAppTarget,
  type IntegrationAccess,
  type IntegrationConnectionSummary,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { RunnerIdSchema } from "@opensteer/core";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useHereDeviceId } from "../computers/here-device.js";
import { ComputerAppPicker, computerAppChoices } from "../thread/computer-app-picker.js";
import { space } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { AppText, Notice, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";

const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;

/**
 * Turning on an app built into Opensteer from the plugin catalog: one device,
 * one access level. The device it runs on approves it.
 */
export function DeviceAppSetupSheet(props: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly deploymentId: string;
  readonly host: HostClient;
  readonly onClose: () => void;
}): ReactNode {
  const { definition, host } = props;
  const machines = useHostSelector(host, selectMachines);
  const hereId = useHereDeviceId(props.deploymentId);
  const targets = computerAppChoices({ connections: props.connections, definition, machines });
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [access, setAccess] = useState<IntegrationAccess>("read");
  const [requested, setRequested] = useState<string | null>(null);
  const action = useScreenAction(host, `device-app:${definition.id}`, {
    label: `request ${definition.name}`,
    done: "requested",
    execute: async (target: ComputerAppTarget) => {
      const result = await host.dispatch({
        idempotencyKey: mutationIdempotencyKey(`computer-app-setup:${definition.id}`),
        input: {
          access,
          app: null,
          definitionId: definition.id,
          kind: "app",
          runnerId: RunnerIdSchema.parse(target.machine.id),
        },
        type: "integration.computer.setup.request",
      });
      if (result.type !== "integration.computer.setup.request")
        throw new Error("The setup request did not complete.");
      return target.machine;
    },
  });
  const chosen =
    targets.available.find(({ machine }) => machine.id === chosenId) ??
    targets.available[0] ??
    null;
  const request = (target: ComputerAppTarget) =>
    void action.run(target).then((outcome) => {
      if (outcome.kind !== "confirmed") return;
      // This iPhone asks in its own prompt, which shows once this sheet is gone.
      if (outcome.value.id === hereId) props.onClose();
      else setRequested(computerAppSetupRequested(definition.name, outcome.value.name));
    });
  return (
    <Sheet
      footer={
        <View style={styles.footer}>
          {chosen && !requested ? (
            <PrimaryButton
              busy={action.running}
              label={`Request setup on ${chosen.machine.name}`}
              onPress={() => request(chosen)}
            />
          ) : null}
          <SecondaryButton label={requested ? "Done" : "Not now"} onPress={props.onClose} />
        </View>
      }
      onClose={props.onClose}
      open
      title={`Set up ${definition.name}`}
    >
      <View style={styles.body}>
        <AppText role="secondary" tone="soft">
          {definition.description}
        </AppText>
        {action.line ? <ActionLine line={action.line} onDismiss={action.dismiss} /> : null}
        {requested ? (
          <Notice detail={requested} title="Requested" tone="neutral" />
        ) : (
          <ComputerAppPicker
            access={access}
            busy={action.running}
            chosenId={chosen?.machine.id ?? null}
            definition={definition}
            onAccess={setAccess}
            onChoose={setChosenId}
            targets={targets}
          />
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[12], padding: space[16] },
  footer: { gap: space[8] },
});
