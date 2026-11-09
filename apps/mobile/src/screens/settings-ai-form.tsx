import { parseAutomaticModelConfig } from "@opensteer/client/host";
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
import { StyleSheet, Switch, TextInput, View } from "react-native";
import { color, space } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import { AppText, Notice, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { ErrorText, Section, styles } from "./settings-form-primitives.js";
import type {
  AiAccountRow,
  AiAccountsForm,
  AutomaticModelsForm,
  SettingsFormProps,
} from "./settings-form.types.js";
export function AiSettingsForm(
  props: Pick<
    SettingsFormProps,
    "aiAccounts" | "page" | "engineUpdates" | "onEngineUpdate" | "onChooseModel" | "automatic"
  >,
): ReactNode {
  const engineUpdates = props.engineUpdates ?? [];
  return (
    <>
      <SecondaryButton label="Choose account and model" onPress={() => props.onChooseModel?.()} />
      {props.aiAccounts ? <Accounts form={props.aiAccounts} /> : null}
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

function Accounts({ form }: { readonly form: AiAccountsForm }): ReactNode {
  const location = form.locations.find(({ id }) => id === form.locationId);
  return (
    <>
      {form.confirmation === null ? null : (
        <Notice detail={form.confirmation} title="Done" tone="neutral" />
      )}
      <ErrorText detail={form.error} />
      {form.locations.length === 0 ? null : (
        <Section label="Computer">
          <View style={accountStyles.location}>
            <ChoiceMenu
              accessibilityLabel="Computer"
              choices={form.locations}
              label={location?.title ?? "Choose"}
              onChoose={form.onChooseLocation}
            />
          </View>
        </Section>
      )}
      {form.groups.map((group) => (
        <Section key={group.driverKind} label={group.name}>
          <RowGroup>
            {[
              ...group.rows.map((row) => <AccountRowView form={form} key={row.id} row={row} />),
              group.addable ? (
                <View key="add" style={styles.actionRow}>
                  <SecondaryButton
                    disabled={form.busyId !== null}
                    label="Add account"
                    onPress={() => form.onAdd(group.driverKind)}
                  />
                </View>
              ) : null,
            ]}
          </RowGroup>
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
  return (
    <View style={accountStyles.row}>
      <View style={[styles.text, styles.grow]}>
        <View style={accountStyles.name}>
          <AppText role="bodyMedium" style={styles.text}>
            {row.name}
          </AppText>
          {row.isDefault ? (
            <AppText role="caption" tone="muted">
              Default
            </AppText>
          ) : null}
        </View>
        {row.line === null ? null : (
          <AppText
            role="secondary"
            {...(row.attention === null ? { tone: "muted" as const } : {})}
            {...(row.attention === null
              ? {}
              : { style: row.attention === "bad" ? accountStyles.bad : accountStyles.warn })}
          >
            {row.line}
          </AppText>
        )}
      </View>
      {row.primary ? (
        <SecondaryButton
          busy={form.busyId === row.id}
          compact
          disabled={blocked}
          label={row.primary.label}
          onPress={() => row.primary && form.onAction(row.id, row.primary)}
        />
      ) : null}
      {row.menu.length === 0 ? null : (
        <ChoiceMenu
          accessibilityLabel={`More for ${row.name}`}
          choices={row.menu.map((action) => ({
            destructive: action.id === "remove",
            id: action.id,
            title: action.label,
          }))}
          disabled={blocked}
          label="More"
          onChoose={(id) => {
            const action = row.menu.find((candidate) => candidate.id === id);
            if (action) form.onAction(row.id, action);
          }}
        />
      )}
    </View>
  );
}

function AutomaticModels({ form }: { readonly form: AutomaticModelsForm }): ReactNode {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const configJson = JSON.stringify(form.view?.config ?? {});
  useEffect(() => setJson(null), [configJson]);
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

const accountStyles = StyleSheet.create({
  bad: { color: color.red },
  location: { alignItems: "flex-start" },
  name: { alignItems: "baseline", flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  warn: { color: color.amber },
});
