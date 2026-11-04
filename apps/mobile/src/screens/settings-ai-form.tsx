import {
  backgroundModelsLead,
  backgroundModelsTitle,
  backgroundProvidersNote,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { View } from "react-native";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { ErrorText, Section, styles } from "./settings-form-primitives.js";
import type { BackgroundModelsForm, SettingsFormProps } from "./settings-form.types.js";
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "background"
  >,
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
      {props.background ? <BackgroundModels form={props.background} /> : null}
    </>
  );
}

function BackgroundModels({ form }: { readonly form: BackgroundModelsForm }): ReactNode {
  const settings = form.settings;
  const notice = settings?.notice ?? null;
  return (
    <>
      <Section footer={backgroundModelsLead} label={backgroundModelsTitle}>
        {settings === null ? (
          <AppText role="secondary" tone="muted">
            {form.error === null ? "Loading…" : "Background models could not be loaded."}
          </AppText>
        ) : (
          <RowGroup>
            {[
              notice === null ? null : (
                <View key="notice" style={styles.row}>
                  <AppText role="body">{notice.text}</AppText>
                  <View style={styles.identity}>
                    <SecondaryButton
                      compact
                      disabled={form.pending}
                      label="Allow"
                      onPress={() => form.onConsent(notice.providerId, true)}
                    />
                    <SecondaryButton
                      compact
                      label="Not now"
                      onPress={() => form.onNotNow(notice.providerId)}
                    />
                  </View>
                </View>
              ),
              ...settings.roles.map((role) => (
                <NativeMenu
                  accessibilityLabel={`${role.title}, ${role.detail}`}
                  disabledReason={form.pending ? "Saving your last change." : null}
                  key={role.role}
                  onPresent={noop}
                  onSettle={noop}
                  options={role.choices.map((choice, index) => ({
                    id: `${role.role}:${index}`,
                    label: choice.label,
                    onPress: () => form.onRole(role.role, choice.value),
                    selected: choice.value === role.value,
                  }))}
                  title={role.title}
                >
                  <View style={styles.row}>
                    <AppText role="body">{role.title}</AppText>
                    <AppText role="secondary" tone="muted">
                      {role.detail}
                    </AppText>
                  </View>
                </NativeMenu>
              )),
            ]}
          </RowGroup>
        )}
        <ErrorText detail={settings === null ? null : form.error} />
      </Section>
      {settings === null || settings.providers.length === 0 ? null : (
        <Section footer={backgroundProvidersNote} label="Providers for background work">
          <RowGroup>
            {settings.providers.map((provider) => (
              <View key={provider.providerId} style={styles.rowInline}>
                <View style={styles.text}>
                  <AppText role="bodyMedium">{provider.name}</AppText>
                  <AppText role="secondary" tone="soft">
                    {provider.allowed ? "Allowed" : "Not allowed"}
                  </AppText>
                </View>
                <SecondaryButton
                  accessibilityLabel={`${provider.allowed ? "Revoke" : "Allow"} ${provider.name}`}
                  compact
                  disabled={form.pending}
                  label={provider.allowed ? "Revoke" : "Allow"}
                  onPress={() => form.onConsent(provider.providerId, !provider.allowed)}
                  tone={provider.allowed ? "danger" : "default"}
                />
              </View>
            ))}
          </RowGroup>
        </Section>
      )}
    </>
  );
}

function noop(): void {}
