import { parseAutomaticModelConfig } from "@opensteer/client/host";
import {
  automaticModelChoices,
  automaticModelsExplanation,
  automaticModelsTitle,
  automaticRoleTitles,
  automaticRoleEntries,
  automaticPreviewLines,
} from "@opensteer/client/host";
import { useState } from "react";
import type { ReactNode } from "react";
import { Switch, TextInput, View } from "react-native";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { ErrorText, Section, styles } from "./settings-form-primitives.js";
import type { AutomaticModelsForm, SettingsFormProps } from "./settings-form.types.js";
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "automatic"
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
      {props.automatic ? <AutomaticModels form={props.automatic} /> : null}
    </>
  );
}

function AutomaticModels({ form }: { readonly form: AutomaticModelsForm }): ReactNode {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  if (!form.supported) return null;
  const view = form.view;
  return (
    <Section label={automaticModelsTitle}>
      {form.explanation ? (
        <>
          <AppText>{automaticModelsExplanation}</AppText>
          <SecondaryButton label="Dismiss" onPress={form.dismiss} />
        </>
      ) : null}
      {view ? (
        <>
          {(["light", "deep"] as const).map((role) => (
            <View key={role}>
              <AppText>{automaticRoleTitles[role]}</AppText>
              {role === "light" ? <AppText>General preference</AppText> : null}
              {automaticRoleEntries(view, role).map((entry, index, entries) => (
                <View key={index}>
                  <AppText>{entry.label}</AppText>
                  <SecondaryButton
                    label={`Move ${role} ${index + 1} up`}
                    disabled={form.pending || index === 0}
                    onPress={() => form.edit(role, { type: "move", index, offset: -1 })}
                  />
                  <SecondaryButton
                    label={`Move ${role} ${index + 1} down`}
                    disabled={form.pending || index === entries.length - 1}
                    onPress={() => form.edit(role, { type: "move", index, offset: 1 })}
                  />
                  <SecondaryButton
                    label={`Remove ${role} ${index + 1}`}
                    disabled={form.pending}
                    onPress={() => form.edit(role, { type: "remove", index })}
                  />
                </View>
              ))}
              <NativeMenu
                title="Add model"
                accessibilityLabel={`Add ${automaticRoleTitles[role]}`}
                disabledReason={form.pending ? "Saving…" : null}
                onPresent={noop}
                onSettle={noop}
                options={automaticModelChoices(view).map((c, index) => ({
                  id: String(index),
                  label: c.label,
                  onPress: () => form.edit(role, { type: "add", want: c.want }),
                }))}
              >
                <AppText>Add model and account</AppText>
              </NativeMenu>
              <SecondaryButton
                label={`Reset ${role} to default`}
                disabled={form.pending}
                onPress={() => form.edit(role, { type: "reset" })}
              />
              {automaticPreviewLines(view, role).map((line, i) => (
                <AppText key={i}>{line}</AppText>
              ))}
              {view[role].candidates.length === 0 ? (
                <AppText>No usable model right now.</AppText>
              ) : null}
            </View>
          ))}
          <AppText>Accounts</AppText>
          {view.accounts.map((a) => (
            <View key={a.harnessInstanceId}>
              <AppText>
                {a.accountDisplayName} · {a.computerDisplayName}
              </AppText>
              <Switch
                accessibilityLabel={a.accountDisplayName}
                disabled={form.pending}
                value={!view.config.excludedAccounts.includes(a.harnessInstanceId)}
                onValueChange={() => form.toggle(a.harnessInstanceId)}
              />
            </View>
          ))}
          <SecondaryButton label="Advanced" onPress={() => setAdvanced(!advanced)} />
          {advanced ? (
            <>
              <TextInput
                accessibilityLabel="Automatic models JSON"
                multiline
                value={json ?? JSON.stringify(view.config, null, 2)}
                onChangeText={setJson}
              />
              <SecondaryButton
                label="Save JSON"
                disabled={form.pending}
                onPress={() =>
                  form.save(() =>
                    parseAutomaticModelConfig(JSON.parse(json ?? JSON.stringify(view.config))),
                  )
                }
              />
            </>
          ) : null}
        </>
      ) : (
        <AppText>Loading…</AppText>
      )}
      <ErrorText detail={form.error} />
    </Section>
  );
}
function noop(): void {}
