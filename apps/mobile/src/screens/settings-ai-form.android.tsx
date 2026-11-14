import {
  idleCompactionTitle,
  idleCompactionChoices,
  idleCompactionHelp,
} from "@opensteer/client/host";
import { RadioButton, Text, TextButton } from "@expo/ui/jetpack-compose";
import {
  automaticModelChoices,
  automaticModelsExplanation,
  automaticModelsTitle,
  automaticPreviewLines,
  automaticRoleEntries,
  automaticRoleTitles,
  parseAutomaticModelConfig,
} from "@opensteer/client/host";
import { useEffect, useState, type ReactNode } from "react";
import { color } from "../theme.js";
import {
  ActionRow,
  ChoiceRow,
  ErrorText,
  InputRow,
  LinkRow,
  MenuRow,
  NoteRow,
  Section,
  SectionHeader,
  ToggleRow,
} from "./settings-form-primitives.android.js";
import type {
  AiAccountRow,
  AiAccountsForm,
  AutomaticModelsForm,
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
    | "automatic"
  >,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <Section>
        <LinkRow onPress={() => props.onChooseModel?.()} title="Choose account and model" />
      </Section>
      {props.aiAccounts ? <Accounts form={props.aiAccounts} /> : null}
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
      {props.automatic ? <AutomaticModels form={props.automatic} /> : null}
    </>
  );
}

function Accounts({ form }: { readonly form: AiAccountsForm }): ReactNode {
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
            <AccountRowView form={form} key={row.id} row={row} />
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
  readonly row: AiAccountRow;
}): ReactNode {
  const { form, row } = props;
  const blocked = form.busyId !== null;
  const title = row.isDefault ? `${row.name} · Default` : row.name;
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
        detail={row.line ?? undefined}
        disabled={blocked}
        title={title}
      />
    );
  return (
    <LinkRow
      detail={row.line}
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

function AutomaticModels({ form }: { readonly form: AutomaticModelsForm }): ReactNode {
  const configJson = JSON.stringify(form.view?.config ?? {}, null, 2);
  const [json, setJson] = useState(configJson);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => setJson(configJson), [configJson]);
  if (!form.supported) return null;
  const view = form.view;
  return (
    <>
      <SectionHeader title={automaticModelsTitle} />
      {form.explanation ? (
        <>
          <NoteRow text={automaticModelsExplanation} />
          <ActionRow label="Dismiss" onPress={form.dismiss} />
        </>
      ) : null}
      {view === null ? <NoteRow text="Loading…" /> : null}
      {view
        ? (["light", "deep"] as const).map((role) => (
            <Section
              footer={[
                ...automaticPreviewLines(view, role),
                ...(view[role].candidates.length === 0 ? ["No usable model right now."] : []),
              ].join("\n")}
              key={role}
              title={automaticRoleTitles[role]}
            >
              {role === "light" ? <NoteRow text="General preference" /> : null}
              {automaticRoleEntries(view, role).map((entry, index, entries) => (
                <MenuRow
                  actions={[
                    ...(index === 0
                      ? []
                      : [
                          {
                            label: "Move up",
                            onPress: () => form.edit(role, { type: "move", index, offset: -1 }),
                          },
                        ]),
                    ...(index === entries.length - 1
                      ? []
                      : [
                          {
                            label: "Move down",
                            onPress: () => form.edit(role, { type: "move", index, offset: 1 }),
                          },
                        ]),
                    {
                      label: "Remove",
                      destructive: true,
                      onPress: () => form.edit(role, { type: "remove", index }),
                    },
                  ]}
                  disabled={form.pending}
                  key={index}
                  menuLabel={`More actions for ${automaticRoleTitles[role]} ${index + 1}`}
                  title={`${index + 1}. ${entry.label}`}
                />
              ))}
              <ChoiceRow
                choices={automaticModelChoices(view).map((choice, index) => ({
                  value: String(index),
                  label: choice.label,
                }))}
                onChange={(value) => {
                  const choice = automaticModelChoices(view)[Number(value)];
                  if (choice) form.edit(role, { type: "add", want: choice.want });
                }}
                title={`Add ${automaticRoleTitles[role]}`}
                value=""
              />
              <ActionRow
                disabled={form.pending}
                label={`Reset ${role} to default`}
                onPress={() => form.edit(role, { type: "reset" })}
              />
            </Section>
          ))
        : null}
      {view ? (
        <Section title="Accounts">
          {view.accounts.map((account) => (
            <ToggleRow
              disabled={form.pending}
              key={account.harnessInstanceId}
              onChange={() => form.toggle(account.harnessInstanceId)}
              title={`${account.accountDisplayName} · ${account.computerDisplayName}`}
              value={!view.config.excludedAccounts.includes(account.harnessInstanceId)}
            />
          ))}
        </Section>
      ) : null}
      {view ? (
        <>
          <SectionHeader
            expanded={advanced}
            onPress={() => setAdvanced((open) => !open)}
            title="Advanced"
          />
          {advanced ? (
            <>
              <InputRow label="Settings JSON" multiline onChange={setJson} value={json} />
              <ActionRow
                disabled={form.pending}
                label="Save JSON"
                onPress={() => form.save(() => parseAutomaticModelConfig(JSON.parse(json)))}
              />
            </>
          ) : null}
        </>
      ) : null}
      <ErrorText detail={form.error} />
    </>
  );
}
