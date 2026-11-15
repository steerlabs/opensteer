import type { MachineSummary } from "@opensteer/protocol";
import {
  addPhoneSteps,
  computerAppPermissionNotice,
  computerAppPlatformTargetLabel,
  computerAppRunsOnPhone,
  computerAppSetupElsewhere,
  computerAppStateLabel,
  computerAppTargets,
  type ComputerAppTarget,
  type IntegrationAccess,
  type IntegrationConnectionSummary,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { AppText, ChoiceRow, Notice, RowGroup, SectionLabel, SwitchRow } from "../ui/primitives.js";

/**
 * Turning an app on for one computer, from the mobile app.
 *
 * It is the same decision the browser makes — one computer, one access level —
 * so it reads the same two facts: the computers that are online and reporting
 * this exact app, and this person's connections. The device in hand is never
 * the computer the app runs on — an agent phone runs only the Agent Phone app,
 * never this one — so what it shows never depends on the device in hand.
 */
export function computerAppChoices(input: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly machines: readonly MachineSummary[];
}): {
  readonly available: readonly ComputerAppTarget[];
  readonly targets: readonly ComputerAppTarget[];
} {
  const targets = computerAppTargets(input);
  return { available: targets.filter(({ connection }) => connection === null), targets };
}

export function ComputerAppPicker(props: {
  readonly access: IntegrationAccess;
  readonly busy: boolean;
  readonly chosenId: string | null;
  readonly definition: IntegrationDefinitionSummaryView;
  readonly onAccess: (access: IntegrationAccess) => void;
  readonly onChoose: (runnerId: string) => void;
  readonly targets: {
    readonly available: readonly ComputerAppTarget[];
    readonly targets: readonly ComputerAppTarget[];
  };
}): ReactNode {
  const presentation = props.definition.computerApp;
  const { available, targets } = props.targets;
  if (targets.length === 0) {
    return (
      <Notice
        detail={`${addTargetSteps(presentation)} Return here when it appears.`}
        title={`No computer is offering ${props.definition.name} yet`}
        tone="neutral"
      />
    );
  }
  const chosen = targets.find(({ machine }) => machine.id === props.chosenId) ?? null;
  const permissionNotice =
    chosen === null
      ? null
      : computerAppPermissionNotice({
          appName: props.definition.name,
          machineName: chosen.machine.name,
          platform: chosen.machine.device?.platform,
          state: chosen.state,
        });
  return (
    <>
      <SectionLabel>Computer</SectionLabel>
      <RowGroup>
        {targets.map((target) => (
          <ChoiceRow
            description={
              target.connection !== null
                ? computerAppRunsOnPhone(presentation)
                  ? `${props.definition.name} is already on. Change access in Settings → Computers → ${target.machine.name}.`
                  : `${props.definition.name} is already on. To change access, open Opensteer on ${target.machine.name}, then Settings → Computers → ${target.machine.name}. Return here when you are done.`
                : target.machine.id === props.chosenId
                  ? `${computerAppStateLabel(target.state, target.machine.device?.platform)} · chosen`
                  : computerAppStateLabel(target.state, target.machine.device?.platform)
            }
            disabled={props.busy || target.connection !== null}
            key={target.machine.id}
            onPress={() => props.onChoose(target.machine.id)}
            title={target.machine.name}
          />
        ))}
      </RowGroup>
      {permissionNotice === null || chosen === null ? null : (
        <Notice
          detail={`${permissionNotice.detail} ${computerAppSetupElsewhere(chosen.machine.name)}`}
          title={permissionNotice.title}
          tone="neutral"
        />
      )}
      {available.length === 0 ? (
        <AppText role="secondary" tone="muted">
          {`${props.definition.name} is on for every computer that offers it.`}
        </AppText>
      ) : null}
      {available.length > 0 && presentation && presentation.accessLevels.length === 2 ? (
        <>
          <SectionLabel>Agent access</SectionLabel>
          {/* The safe level is what a switch starts at; sending is the move a
              person makes on purpose. */}
          <SwitchRow
            disabled={props.busy}
            label={presentation.accessLabels.readWrite}
            onChange={(value) => props.onAccess(value ? "read-write" : "read")}
            value={props.access === "read-write"}
          />
          <AppText role="secondary" tone="muted">
            {props.access === "read-write"
              ? presentation.accessSummaries.readWrite
              : presentation.accessSummaries.read}
          </AppText>
        </>
      ) : null}
    </>
  );
}

/**
 * How a computer that can run the app joins this deployment. A Mac adds
 * itself from the desktop app and an Android phone from a computer it is
 * plugged into; an iPhone adds itself from Opensteer on it, which has no
 * desktop app or Add computer to point to.
 */
function addTargetSteps(presentation: IntegrationDefinitionSummaryView["computerApp"]): string {
  const platforms = presentation?.platforms ?? [];
  if (computerAppRunsOnPhone(presentation)) return addPhoneSteps("an Android phone");
  const target = computerAppPlatformTargetLabel(platforms);
  return platforms.includes("ios")
    ? `Open Opensteer on ${target}, open this deployment, then add it in Settings → Computers.`
    : `Open Opensteer on ${target} in the desktop app. Open this deployment, then Settings → Computers → Add computer and follow the steps.`;
}
