import { Button, HStack, Section, Spacer } from "@expo/ui/swift-ui";
import { accessibilityLabel, contentShape, shapes } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { Chevron, Footer, Lines, LinkRow, Tile } from "./settings-form-primitives.ios.js";
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
          <Button label="Add device" onPress={props.onAddDevice} />
        </Section>
      ) : null}
      {props.computers.length === 0 ? null : (
        <Section footer={<Footer text={computersSettingsFooter} />} title="Computers">
          {props.computers.map((computer) => {
            const opens = computer.opens;
            const label = accessibilityLabel(`${computer.name}, ${computer.detail}`);
            const row = (
              <HStack
                alignment="center"
                modifiers={[contentShape(shapes.rectangle())]}
                spacing={12}
              >
                <Tile symbol={computer.symbol} />
                <Lines detail={computer.detail} title={computer.name} />
                <Spacer />
                {opens === null ? null : <Chevron />}
              </HStack>
            );
            return opens === null ? (
              <HStack key={computer.key} modifiers={[label]}>
                {row}
              </HStack>
            ) : (
              <Button
                key={computer.key}
                modifiers={[label]}
                onPress={() => props.onComputerAction(opens)}
              >
                {row}
              </Button>
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
              symbol={device.symbol}
              title={device.name}
            />
          ))}
        </Section>
      )}
    </>
  );
}
