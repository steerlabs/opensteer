import { parseAutomaticModelConfig } from "@opensteer/client/host";
import {
  useNativeState,
  Button,
  DisclosureGroup,
  TextField,
  Toggle,
  HStack,
  Menu,
  Picker,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  disabled,
  frame,
  labelStyle,
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
import { color, touchTarget } from "../theme.js";
import { ErrorText, Lines } from "./settings-form-primitives.ios.js";
import type {
  AiAccountRow,
  AiAccountsForm,
  AutomaticModelsForm,
  SettingsFormProps,
} from "./settings-form.types.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "aiAccounts" | "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "automatic"
  >,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <Button label="Choose account and model" onPress={() => props.onChooseModel?.()} />
      {props.aiAccounts ? <Accounts form={props.aiAccounts} /> : null}
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

function Accounts({ form }: { readonly form: AiAccountsForm }): ReactNode {
  return (
    <>
      {form.confirmation === null ? null : (
        <Section>
          <Lines detail={form.confirmation} title="Done" />
        </Section>
      )}
      {form.error === null ? null : (
        <Section>
          <ErrorText detail={form.error} />
        </Section>
      )}
      {form.locations.length === 0 ? null : (
        <Section>
          <Picker
            label="Computer"
            modifiers={[pickerStyle("menu")]}
            onSelectionChange={(id: string) => form.onChooseLocation(id)}
            selection={form.locationId ?? ""}
          >
            {form.locations.map((location) => (
              <Text key={location.id} modifiers={[tag(location.id)]}>
                {location.title}
              </Text>
            ))}
          </Picker>
        </Section>
      )}
      {form.groups.map((group) => (
        <Section key={group.driverKind} title={group.name}>
          {group.rows.map((row) => (
            <AccountRowView form={form} key={row.id} row={row} />
          ))}
          {group.addable ? (
            <Button
              label="Add account"
              modifiers={[disabled(form.busyId !== null)]}
              onPress={() => form.onAdd(group.driverKind)}
            />
          ) : null}
        </Section>
      ))}
    </>
  );
}

function AccountRowView(props: {
  readonly form: AiAccountsForm;
  readonly row: AiAccountRow;
}): ReactNode {
  const { form, row } = props;
  const blocked = form.busyId !== null;
  const lineTone =
    row.attention === "bad"
      ? foregroundStyle(color.red)
      : row.attention === "warn"
        ? foregroundStyle(color.amber)
        : secondary;
  return (
    <HStack alignment="center" spacing={12}>
      <VStack alignment="leading" spacing={2}>
        <HStack alignment="firstTextBaseline" spacing={8}>
          <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
            {row.name}
          </Text>
          {row.isDefault ? <Text modifiers={[secondary, footnote]}>Default</Text> : null}
        </HStack>
        {row.line === null ? null : <Text modifiers={[lineTone, footnote]}>{row.line}</Text>}
      </VStack>
      <Spacer />
      {row.primary ? (
        <Button
          label={
            form.busyId === row.id && row.primary.id === "refresh-models"
              ? "Checking…"
              : row.primary.label
          }
          modifiers={[buttonStyle("borderless"), disabled(blocked)]}
          onPress={() => row.primary && form.onAction(row.id, row.primary)}
        />
      ) : null}
      {row.menu.length === 0 ? null : (
        <Menu
          label="More"
          modifiers={[
            buttonStyle("borderless"),
            labelStyle("iconOnly"),
            frame({ minHeight: touchTarget, minWidth: touchTarget }),
            accessibilityLabel(`More for ${row.name}`),
            disabled(blocked),
          ]}
          systemImage="ellipsis"
        >
          {row.menu.map((action) => (
            <Button
              key={action.id}
              label={action.label}
              onPress={() => form.onAction(row.id, action)}
              role={action.id === "remove" ? "destructive" : "default"}
            />
          ))}
        </Menu>
      )}
    </HStack>
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
