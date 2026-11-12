import type { ReactNode } from "react";
import { ActionRow, LinkRow, Section } from "./settings-form-primitives.android.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import { computersSettingsFooter, type OtherDeviceSettingsRow } from "./settings-model.js";
export function DevicesSettingsForm(
  props: Pick<SettingsFormProps, "page" | "computers" | "onComputerAction"> & {
    readonly onAddDevice?: () => void;
    readonly onOtherDevice?: (opens: OtherDeviceSettingsRow["opens"]) => void;
    readonly otherDevices?: readonly OtherDeviceSettingsRow[];
  },
): ReactNode {
  return (
    <>
      {props.onAddDevice ? (
        <Section>
          <ActionRow label="Add device" onPress={props.onAddDevice} />
        </Section>
      ) : null}
      {props.computers.length === 0 ? null : (
        <Section footer={computersSettingsFooter} title="Computers">
          {props.computers.map((computer) => {
            const opens = computer.opens;
            return (
              <LinkRow
                detail={computer.detail}
                key={computer.key}
                onPress={opens === null ? null : () => props.onComputerAction(opens)}
                title={computer.name}
              />
            );
          })}
        </Section>
      )}
      {!props.otherDevices?.length ? null : (
        <Section title="Other devices">
          {props.otherDevices.map((device) => (
            <LinkRow
              detail={device.detail}
              key={device.key}
              onPress={() => props.onOtherDevice?.(device.opens)}
              title={device.name}
            />
          ))}
        </Section>
      )}
    </>
  );
}
