import { Button, HStack, Section, Spacer } from "@expo/ui/swift-ui";
import { accessibilityLabel, contentShape, shapes } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { Chevron, Footer, Lines, Tile } from "./settings-form-primitives.ios.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import { computersSettingsFooter } from "./settings-model.js";
export function DevicesSettingsForm(
  props: Pick<SettingsFormProps, "page" | "computers" | "onComputerAction"> & {
    readonly onAddDevice?: () => void;
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
    </>
  );
}
