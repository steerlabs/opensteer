import { Button, HStack, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { disabled, font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import type { SettingsFormProps } from "./settings-form.types.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function AiSettingsForm(
  props: Pick<SettingsFormProps, "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel">,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <Button label="Choose account and model" onPress={() => props.onChooseModel?.()} />
      {engineUpdates.length === 0 ? null : (
        <Section title="AI">
          {engineUpdates.map((engine) => (
            <HStack key={engine.key} alignment="center" spacing={12}>
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
                  {engine.name}
                </Text>
                <Text modifiers={[secondary, footnote]}>{engine.detail}</Text>
              </VStack>
              <Spacer />
              {engine.updateEnabled || engine.updating ? (
                <Button
                  label={engine.updating ? "Updating…" : "Update"}
                  modifiers={[disabled(!engine.updateEnabled || engine.updating)]}
                  onPress={() => props.onEngineUpdate?.(engine.environmentId, engine.driverKind)}
                />
              ) : null}
            </HStack>
          ))}
        </Section>
      )}
    </>
  );
}
