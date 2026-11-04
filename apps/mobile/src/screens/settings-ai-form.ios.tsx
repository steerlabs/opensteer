import { parseAutomaticModelConfig } from "@opensteer/client/host";
import {
  useNativeState,
  Button,
  DisclosureGroup,
  TextField,
  Toggle,
  HStack,
  Picker,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  disabled,
  lineLimit,
  font,
  foregroundStyle,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  automaticModelChoices,
  automaticModelsExplanation,
  automaticModelsTitle,
  automaticRoleTitles,
  automaticRoleEntries,
  automaticPreviewLines,
} from "@opensteer/client/host";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { ErrorText } from "./settings-form-primitives.ios.js";
import type { AutomaticModelsForm, SettingsFormProps } from "./settings-form.types.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "automatic"
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
      {props.automatic ? <AutomaticModels form={props.automatic} /> : null}
    </>
  );
}

function AutomaticModels({ form }: { readonly form: AutomaticModelsForm }): ReactNode {
  const [json, setJson] = useState<string | null>(null);
  const nativeJson = useNativeState(JSON.stringify(form.view?.config ?? {}, null, 2));
  const configJson = JSON.stringify(form.view?.config ?? {}, null, 2);
  useEffect(() => {
    nativeJson.set(configJson);
    setJson(null);
  }, [configJson, nativeJson]);
  if (!form.supported) return null;
  const view = form.view;
  return (
    <Section title={automaticModelsTitle}>
      {form.explanation ? (
        <>
          <Text>{automaticModelsExplanation}</Text>
          <Button label="Dismiss" onPress={form.dismiss} />
        </>
      ) : null}
      {view ? (
        <>
          {(["light", "deep"] as const).map((role) => (
            <VStack key={role} alignment="leading">
              <Text>{automaticRoleTitles[role]}</Text>
              {role === "light" ? <Text>General preference</Text> : null}
              {automaticRoleEntries(view, role).map((entry, index, entries) => (
                <VStack key={index} alignment="leading">
                  <Text>{entry.label}</Text>
                  <HStack>
                    <Button
                      label={`Move ${role} ${index + 1} up`}
                      modifiers={[disabled(form.pending || index === 0)]}
                      onPress={() => form.edit(role, { type: "move", index, offset: -1 })}
                    />
                    <Button
                      label={`Move ${role} ${index + 1} down`}
                      modifiers={[disabled(form.pending || index === entries.length - 1)]}
                      onPress={() => form.edit(role, { type: "move", index, offset: 1 })}
                    />
                    <Button
                      label={`Remove ${role} ${index + 1}`}
                      modifiers={[disabled(form.pending)]}
                      onPress={() => form.edit(role, { type: "remove", index })}
                    />
                  </HStack>
                </VStack>
              ))}
              <Picker
                label={`Add ${automaticRoleTitles[role]}`}
                selection=""
                modifiers={[pickerStyle("menu"), disabled(form.pending)]}
                onSelectionChange={(value: string) => {
                  const choice = automaticModelChoices(view)[Number(value)];
                  if (value && choice) form.edit(role, { type: "add", want: choice.want });
                }}
              >
                <Text modifiers={[tag("")]}>Choose model and account</Text>
                {automaticModelChoices(view).map((choice, index) => (
                  <Text key={index} modifiers={[tag(String(index))]}>
                    {choice.label}
                  </Text>
                ))}
              </Picker>
              <Button
                label={`Reset ${role} to default`}
                modifiers={[disabled(form.pending)]}
                onPress={() => form.edit(role, { type: "reset" })}
              />
              {automaticPreviewLines(view, role).map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
              {view[role].candidates.length === 0 ? <Text>No usable model right now.</Text> : null}
            </VStack>
          ))}
          <Text>Accounts</Text>
          {view.accounts.map((a) => (
            <Toggle
              key={a.harnessInstanceId}
              label={`${a.accountDisplayName} · ${a.computerDisplayName}`}
              isOn={!view.config.excludedAccounts.includes(a.harnessInstanceId)}
              modifiers={[disabled(form.pending)]}
              onIsOnChange={() => form.toggle(a.harnessInstanceId)}
            />
          ))}
          <DisclosureGroup label="Advanced">
            <TextField
              axis="vertical"
              modifiers={[lineLimit(8)]}
              text={nativeJson}
              onTextChange={setJson}
            />
            <Button
              label="Save JSON"
              modifiers={[disabled(form.pending)]}
              onPress={() =>
                form.save(() =>
                  parseAutomaticModelConfig(JSON.parse(json ?? JSON.stringify(view.config))),
                )
              }
            />
          </DisclosureGroup>
        </>
      ) : (
        <Text>Loading…</Text>
      )}
      <ErrorText detail={form.error} />
    </Section>
  );
}
