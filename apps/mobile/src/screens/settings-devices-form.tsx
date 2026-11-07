import type { ReactNode } from "react";
import { RowGroup, SecondaryButton } from "../ui/primitives.js";
import { LinkRow, Section, Tile } from "./settings-form-primitives.js";
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
        <SecondaryButton label="Add device" onPress={props.onAddDevice} />
      ) : null}
      {props.computers.length === 0 ? null : (
        <Section footer={computersSettingsFooter} label="Computers">
          <RowGroup>
            {props.computers.map((computer) => {
              const opens = computer.opens;
              return (
                <LinkRow
                  detail={computer.detail}
                  key={computer.key}
                  lead={<Tile symbol={computer.symbol} />}
                  onPress={opens === null ? null : () => props.onComputerAction(opens)}
                  title={computer.name}
                />
              );
            })}
          </RowGroup>
        </Section>
      )}
      {!props.otherDevices?.length ? null : (
        <Section label="Other devices">
          <RowGroup>
            {props.otherDevices.map((device) => (
              <LinkRow
                detail={device.detail}
                key={device.key}
                lead={<Tile symbol={device.symbol} />}
                onPress={() => props.onOtherDevice?.(device.opens)}
                title={device.name}
              />
            ))}
          </RowGroup>
        </Section>
      )}
    </>
  );
}
