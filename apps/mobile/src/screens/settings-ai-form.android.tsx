import {
  idleCompactionTitle,
  idleCompactionChoices,
  idleCompactionHelp,
} from "@opensteer/client/host";
import { RadioButton, Text, TextButton } from "@expo/ui/jetpack-compose";
import {
  backgroundModelRows,
  backgroundModelsFileError,
  backgroundModelsNote,
  backgroundModelsTitle,
  notUsedForBackgroundWork,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import {
  ActionRow,
  ChoiceRow,
  ErrorText,
  LinkRow,
  MenuRow,
  NoteRow,
  Section,
} from "./settings-form-primitives.android.js";
import type {
  AiAccountRow,
  AiAccountsForm,
  BackgroundModelsForm,
  SettingsFormProps,
} from "./settings-form.types.js";

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
      <Section>
        <LinkRow onPress={() => props.onChooseModel?.()} title="Choose account and model" />
      </Section>
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
            <LinkRow
              detail={engine.detail}
              key={engine.key}
              title={engine.name}
              trailing={
                engine.updateEnabled || engine.updating ? (
                  <TextButton
                    enabled={engine.updateEnabled && !engine.updating}
                    onClick={() => props.onEngineUpdate?.(engine.environmentId, engine.driverKind)}
                  >
                    <Text>{engine.updating ? "Updating…" : "Update"}</Text>
                  </TextButton>
                ) : null
              }
            />
          ))}
        </Section>
      )}
      {props.idleCompaction ? (
        <Section title={idleCompactionTitle} footer={idleCompactionHelp}>
          {idleCompactionChoices.map((choice) => (
            <LinkRow
              key={choice.value}
              title={choice.label}
              disabled={props.idleCompaction?.pending}
              trailing={
                <RadioButton
                  selected={props.idleCompaction?.policy.mode === choice.value}
                  enabled={!props.idleCompaction?.pending}
                  onClick={() => props.idleCompaction?.save({ mode: choice.value })}
                />
              }
              detail={choice.description}
              onPress={
                props.idleCompaction!.pending
                  ? undefined
                  : () => props.idleCompaction?.save({ mode: choice.value })
              }
            />
          ))}
          <ErrorText detail={props.idleCompaction.error} />
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
          <LinkRow detail={form.confirmation} title="Done" />
        </Section>
      )}
      <ErrorText detail={form.error} />
      {form.locations.length === 0 ? null : (
        <Section>
          <ChoiceRow
            choices={form.locations.map((location) => ({
              value: location.id,
              label: location.title,
            }))}
            onChange={form.onChooseLocation}
            title="Computer"
            value={form.locationId ?? ""}
          />
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
            <ActionRow
              disabled={form.busyId !== null}
              label="Add account"
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
  const title = row.isDefault ? `${row.name} · Default` : row.name;
  const detail =
    [row.line, props.notUsedForBackground ? notUsedForBackgroundWork : null]
      .filter((line) => line !== null)
      .join("\n") || null;
  const primary = row.primary;
  const onPrimary = () => primary && form.onAction(row.id, primary);
  if (row.menu.length > 0)
    return (
      <MenuRow
        actions={[
          ...(primary ? [{ label: primary.label, onPress: onPrimary }] : []),
          ...row.menu.map((action) => ({
            label: action.label,
            destructive: action.id === "remove",
            onPress: () => form.onAction(row.id, action),
          })),
        ]}
        detail={detail ?? undefined}
        disabled={blocked}
        title={title}
      />
    );
  return (
    <LinkRow
      detail={detail}
      title={title}
      trailing={
        primary ? (
          <TextButton enabled={!blocked} onClick={onPrimary}>
            <Text
              color={
                row.attention === "bad"
                  ? color.red
                  : row.attention === "warn"
                    ? color.amber
                    : color.ember
              }
            >
              {form.busyId === row.id && primary.id === "refresh-models"
                ? "Checking…"
                : primary.label}
            </Text>
          </TextButton>
        ) : null
      }
    />
  );
}

function BackgroundModels({ form }: { readonly form: BackgroundModelsForm }): ReactNode {
  const view = form.view;
  const fileError = view ? backgroundModelsFileError(view) : null;
  return (
    <Section footer={backgroundModelsNote} title={backgroundModelsTitle}>
      {view ? (
        backgroundModelRows(view).map((row) => (
          <LinkRow detail={row.detail} key={row.role} title={row.title} />
        ))
      ) : (
        <NoteRow text={form.error ? "Background models could not be loaded." : "Loading…"} />
      )}
      <ErrorText detail={fileError} />
    </Section>
  );
}
