import { Button, HStack, Picker, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { disabled, font, foregroundStyle, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import {
  backgroundModelsLead,
  backgroundModelsTitle,
  backgroundProvidersNote,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { ErrorText, Footer, Lines } from "./settings-form-primitives.ios.js";
import type { BackgroundModelsForm, SettingsFormProps } from "./settings-form.types.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "background"
  >,
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
      {props.background ? <BackgroundModels form={props.background} /> : null}
    </>
  );
}

function BackgroundModels({ form }: { readonly form: BackgroundModelsForm }): ReactNode {
  const settings = form.settings;
  const notice = settings?.notice ?? null;
  return (
    <>
      {notice === null ? null : (
        <Section>
          <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
            {notice.text}
          </Text>
          <HStack spacing={12}>
            <Button
              label="Allow"
              modifiers={[disabled(form.pending)]}
              onPress={() => form.onConsent(notice.providerId, true)}
            />
            <Spacer />
            <Button label="Not now" onPress={() => form.onNotNow(notice.providerId)} />
          </HStack>
        </Section>
      )}
      <Section footer={<Footer text={backgroundModelsLead} />} title={backgroundModelsTitle}>
        {settings === null ? (
          <Text modifiers={[secondary, footnote]}>
            {form.error === null ? "Loading…" : "Background models could not be loaded."}
          </Text>
        ) : (
          settings.roles.map((role) => (
            <VStack alignment="leading" key={role.role} spacing={2}>
              <Picker
                label={role.title}
                modifiers={[pickerStyle("menu"), disabled(form.pending)]}
                onSelectionChange={(value: string) => form.onRole(role.role, value)}
                selection={role.value}
              >
                {role.choices.map((choice) => (
                  <Text key={choice.value} modifiers={[tag(choice.value)]}>
                    {choice.label}
                  </Text>
                ))}
              </Picker>
              <Text modifiers={[secondary, footnote]}>{role.detail}</Text>
            </VStack>
          ))
        )}
        <ErrorText detail={settings === null ? null : form.error} />
      </Section>
      {settings === null || settings.providers.length === 0 ? null : (
        <Section
          footer={<Footer text={backgroundProvidersNote} />}
          title="Providers for background work"
        >
          {settings.providers.map((provider) => (
            <HStack alignment="center" key={provider.providerId} spacing={12}>
              <Lines detail={provider.allowed ? "Allowed" : "Not allowed"} title={provider.name} />
              <Spacer />
              <Button
                label={provider.allowed ? "Revoke" : "Allow"}
                modifiers={[disabled(form.pending)]}
                onPress={() => form.onConsent(provider.providerId, !provider.allowed)}
                role={provider.allowed ? "destructive" : "default"}
              />
            </HStack>
          ))}
        </Section>
      )}
    </>
  );
}
