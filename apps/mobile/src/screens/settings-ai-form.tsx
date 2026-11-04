import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { Section, styles } from "./settings-form-primitives.js";
import type { SettingsFormProps } from "./settings-form.types.js";
export function AiSettingsForm(
  props: Pick<SettingsFormProps, "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel">,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <SecondaryButton label="Choose account and model" onPress={() => props.onChooseModel?.()} />
      {engineUpdates.length === 0 ? null : (
        <Section label="AI">
          <RowGroup>
            {engineUpdates.map((engine) => (
              <View key={engine.key} style={styles.rowInline}>
                <View style={styles.text}>
                  <AppText role="bodyMedium">{engine.name}</AppText>
                  <AppText role="secondary" tone="soft">
                    {engine.detail}
                  </AppText>
                </View>
                {engine.updateEnabled || engine.updating ? (
                  <SecondaryButton
                    busy={engine.updating}
                    compact
                    disabled={!engine.updateEnabled}
                    label="Update"
                    onPress={() => props.onEngineUpdate?.(engine.environmentId, engine.driverKind)}
                  />
                ) : null}
              </View>
            ))}
          </RowGroup>
        </Section>
      )}
    </>
  );
}
