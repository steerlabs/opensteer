import {
  idleCompactionTitle,
  idleCompactionChoices,
  idleCompactionHelp,
} from "@opensteer/client/host";
import { Button, HStack, Menu, Picker, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityAddTraits,
  buttonStyle,
  disabled,
  frame,
  labelStyle,
  font,
  foregroundStyle,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  backgroundModelRows,
  backgroundModelsFileError,
  backgroundModelsNote,
  backgroundModelsTitle,
  notUsedForBackgroundWork,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { color, touchTarget } from "../theme.js";
import { ErrorText, Lines } from "./settings-form-primitives.ios.js";
import type {
  AiAccountRow,
  AiAccountsForm,
  BackgroundModelsForm,
  SettingsFormProps,
} from "./settings-form.types.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    | "idleCompaction"
    | "aiAccounts"
    | "page"
    | "engineUpdates"
    | "onEngineUpdate"
    | "onChooseModel"
    | "backgroundModels"
  >,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <Button label="Choose account and model" onPress={() => props.onChooseModel?.()} />
      {props.aiAccounts ? (
        <Accounts
          form={props.aiAccounts}
          notUsedForBackground={props.backgroundModels?.view?.excludedAccounts ?? []}
        />
      ) : null}
      {props.backgroundModels ? <BackgroundModels form={props.backgroundModels} /> : null}
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
      {props.idleCompaction ? (
        <Section title={idleCompactionTitle}>
          {idleCompactionChoices.map((choice) => (
            <VStack key={choice.value} alignment="leading" spacing={2}>
              <Button
                label={`${props.idleCompaction?.policy.mode === choice.value ? "✓ " : ""}${choice.label}`}
                modifiers={[
                  disabled(props.idleCompaction!.pending),
                  ...(props.idleCompaction?.policy.mode === choice.value
                    ? [accessibilityAddTraits(["isSelected"])]
                    : []),
                ]}
                onPress={() => props.idleCompaction?.save({ mode: choice.value })}
              />
              <Text modifiers={[secondary, footnote]}>{choice.description}</Text>
            </VStack>
          ))}
          <Text modifiers={[secondary, footnote]}>{idleCompactionHelp}</Text>
          {props.idleCompaction.error ? <ErrorText detail={props.idleCompaction.error} /> : null}
        </Section>
      ) : null}
    </>
  );
}

function Accounts({
  form,
  notUsedForBackground,
}: {
  readonly form: AiAccountsForm;
  readonly notUsedForBackground: readonly string[];
}): ReactNode {
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
            <AccountRowView
              form={form}
              key={row.id}
              notUsedForBackground={notUsedForBackground.includes(row.id)}
              row={row}
            />
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
  readonly notUsedForBackground: boolean;
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
          {props.notUsedForBackground ? (
            <Text modifiers={[secondary, footnote]}>{notUsedForBackgroundWork}</Text>
          ) : null}
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

function BackgroundModels({ form }: { readonly form: BackgroundModelsForm }): ReactNode {
  const view = form.view;
  const fileError = view ? backgroundModelsFileError(view) : null;
  return (
    <Section title={backgroundModelsTitle}>
      {view ? (
        backgroundModelRows(view).map((row) => (
          <Lines detail={row.detail} key={row.role} title={row.title} />
        ))
      ) : (
        <Text>{form.error ? "Background models could not be loaded." : "Loading…"}</Text>
      )}
      {fileError ? <ErrorText detail={fileError} /> : null}
      <Text modifiers={[secondary, footnote]}>{backgroundModelsNote}</Text>
    </Section>
  );
}
